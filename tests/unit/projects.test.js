import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjects, listDir, readFilePreview } from '../../src/projects.js';
import { createSampleApp, inOwnParent, testConfig, tmp } from '../helpers/sample-app.js';

const setup = (extra = {}) => { const { repo, parent } = inOwnParent(createSampleApp({ extraFiles: { '.env': 'SECRET=abc12345678', 'bin/blob.dat': 'x', 'src/cfg.js': 'const k = "sk-abcdefghijklmnopqrstuvwxyz";\n', ...extra } })); fs.writeFileSync(path.join(repo, 'bin/blob.dat'), Buffer.from([1, 2, 0, 3])); const cfg = testConfig(tmp('d-')); cfg.allowedProjectDirs = [parent]; return { repo, cfg }; };

test('tree lists dirs first, hides secrets/build output/symlinks and never lists outside the project', () => {
  const { repo, cfg } = setup(); const outside = tmp('outside-'); fs.symlinkSync(outside, path.join(repo, 'link-out'));
  const r = listDir(cfg, repo, '.'); const names = r.items.map((i) => i.name);
  assert.ok(names.includes('src') && names.includes('package.json')); assert.ok(!names.includes('.env') && !names.includes('.git') && !names.includes('link-out') && !names.includes('node_modules'));
  assert.equal(r.items[0].type, 'dir'); assert.deepEqual(listDir(cfg, repo, 'src').items.map((i) => i.path).sort(), ['src/cfg.js', 'src/index.js', 'src/math.js']);
});
test('BOUNDARY: traversal, absolute paths, symlink dirs and projects outside allowed dirs are rejected server-side', () => {
  const { repo, cfg } = setup(); const outside = tmp('outside-'); fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret'); fs.symlinkSync(outside, path.join(repo, 'link-out'));
  const code = (fn) => { try { fn(); return 200; } catch (e) { return e.code; } };
  assert.equal(code(() => listDir(cfg, repo, '../')), 403); assert.equal(code(() => listDir(cfg, repo, '/etc')), 403); assert.equal(code(() => listDir(cfg, repo, 'link-out')), 403);
  assert.equal(code(() => readFilePreview(cfg, repo, '../secret.txt')), 403); assert.equal(code(() => readFilePreview(cfg, repo, 'link-out/secret.txt')), 403); assert.equal(code(() => readFilePreview(cfg, repo, '/etc/passwd')), 403);
  assert.equal(code(() => listDir(cfg, '/etc', '.')), 403); assert.equal(code(() => listDir(cfg, os.homedir(), '.')), 403); assert.equal(code(() => listDir(cfg, '/does/not/exist', '.')), 404);
});
test('preview refuses secrets files, binaries and directories, and redacts secret-shaped content', () => {
  const { repo, cfg } = setup(); const code = (fn) => { try { fn(); return 200; } catch (e) { return e.code; } };
  assert.equal(code(() => readFilePreview(cfg, repo, '.env')), 403); assert.equal(code(() => readFilePreview(cfg, repo, '.git/config')), 403); assert.equal(code(() => readFilePreview(cfg, repo, 'bin/blob.dat')), 415); assert.equal(code(() => readFilePreview(cfg, repo, 'src')), 400);
  const p = readFilePreview(cfg, repo, 'src/cfg.js'); assert.equal(p.language, 'javascript'); assert.ok(!p.content.includes('sk-abcdefghij')); assert.match(p.content, /REDACTED/);
  assert.equal(readFilePreview(cfg, repo, 'src/math.js').language, 'javascript');
});
test('large files are truncated, project discovery is limited to allowed directories', () => {
  const { repo, cfg } = setup({ 'big.txt': 'a'.repeat(300_000) }); const p = readFilePreview(cfg, repo, 'big.txt'); assert.equal(p.truncated, true); assert.equal(p.content.length, 200_000);
  assert.ok(discoverProjects(cfg).includes(fs.realpathSync(repo))); cfg.allowedProjectDirs = [tmp('empty-')]; assert.deepEqual(discoverProjects(cfg), []);
});
