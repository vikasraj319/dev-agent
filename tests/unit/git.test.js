import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GitManager } from '../../src/git.js';
import { createSampleApp, git, testConfig, tmp } from '../helpers/sample-app.js';

const setup = () => { const repo = createSampleApp(); const cfg = testConfig(tmp()); return { repo, cfg, gm: new GitManager(cfg) }; };

test('worktree isolation: main branch and its working tree are untouched', async () => {
  const { repo, gm } = setup(); const head = git(repo, 'rev-parse', 'HEAD'); const wt = path.join(tmp(), 'wt');
  await gm.createWorktree(repo, 'agent/x-1', wt, head); fs.writeFileSync(path.join(wt, 'src/new.js'), 'x');
  const sha = await gm.commit(wt, 'feat: x'); assert.ok(sha);
  assert.equal(git(repo, 'rev-parse', 'main'), head); assert.ok(!fs.existsSync(path.join(repo, 'src/new.js'))); assert.equal(git(repo, 'branch', '--show-current'), 'main');
});
test('uncommitted user changes are preserved and never visible in the worktree', async () => {
  const { repo, gm } = setup(); fs.writeFileSync(path.join(repo, 'README.md'), 'MY UNCOMMITTED EDIT'); fs.writeFileSync(path.join(repo, 'wip.txt'), 'wip');
  const st = await gm.status(repo); assert.ok(st.dirty); const wt = path.join(tmp(), 'wt'); await gm.createWorktree(repo, 'agent/y-2', wt, st.head);
  assert.ok(!fs.existsSync(path.join(wt, 'wip.txt'))); assert.notEqual(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'MY UNCOMMITTED EDIT');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'MY UNCOMMITTED EDIT'); assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'wip');
});
test('refuses protected branch names and commits on protected branches', async () => {
  const { repo, gm } = setup(); await assert.rejects(gm.createWorktree(repo, 'main', path.join(tmp(), 'wt')), /protected/);
  fs.writeFileSync(path.join(repo, 'z.txt'), 'z'); await assert.rejects(gm.commit(repo, 'oops'), /protected branch/);
  assert.equal(git(repo, 'log', '--oneline').split('\n').length, 1);
});
test('diff and changed files reflect real changes, commit with nothing staged returns null', async () => {
  const { repo, gm } = setup(); const head = git(repo, 'rev-parse', 'HEAD'); const wt = path.join(tmp(), 'wt'); await gm.createWorktree(repo, 'agent/z-3', wt, head);
  assert.equal(await gm.commit(wt, 'noop'), null);
  fs.writeFileSync(path.join(wt, 'src/math.js'), 'export const a = 1;\n'); fs.writeFileSync(path.join(wt, 'added.js'), 'x');
  const files = await gm.changedFiles(wt, head); assert.deepEqual(files.map((f) => `${f.status}:${f.path}`).sort(), ['A:added.js', 'M:src/math.js']);
  assert.match(await gm.diff(wt, head), /\+export const a = 1;/);
});
test('non-repositories are detected', async () => { const { gm } = setup(); assert.equal(await gm.isRepo(tmp()), false); });
