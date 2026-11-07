import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCommand, createRedactor, findSecurityWeakening, findWeakening, isSensitivePath, isWriteProtected, resolveInside } from '../../src/security.js';
import { tmp } from '../helpers/sample-app.js';

test('redactor masks common secret shapes and literal env secrets', () => {
  const r = createRedactor([], { MY_API_TOKEN: 'literal-secret-value-1' });
  const out = r('key sk-abcdefghijklmnop12345 ghp_abcdefghijklmnopqrstuvwx Bearer abcdefghijklmnopqrstu literal-secret-value-1 postgres://u:hunter2pass@db/x password=hunter22222');
  for (const s of ['sk-abcdefghijklmnop12345', 'ghp_abcdefghij', 'abcdefghijklmnopqrstu', 'literal-secret-value-1', 'hunter2pass', 'hunter22222']) assert.ok(!out.includes(s), `leaked ${s}`);
  assert.match(out, /\[REDACTED\]/);
});
test('resolveInside blocks traversal, absolute paths and symlink escapes', () => {
  const root = tmp(); const outside = tmp();
  assert.ok(resolveInside(root, 'a/b.txt').startsWith(root));
  assert.throws(() => resolveInside(root, '../x'), /escapes/);
  assert.throws(() => resolveInside(root, 'a/../../x'), /escapes/);
  assert.throws(() => resolveInside(root, '/etc/passwd'), /Absolute/);
  assert.throws(() => resolveInside(root, 'x\0y'), /Invalid/);
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => resolveInside(root, 'link/file.txt'), /Symlink escapes/);
});
test('write-protected and sensitive path rules', () => {
  for (const p of ['.env', '.env.production', 'a/.env.local', '.git/config', 'node_modules/x/index.js', 'keys/server.pem']) assert.ok(isWriteProtected(p), p);
  for (const p of ['.env.example', 'src/app.js']) assert.ok(!isWriteProtected(p), p);
  for (const p of ['.github/workflows/ci.yml', 'src/auth.js', 'db/migrations/001.sql', 'prisma/schema.prisma', 'vercel.json']) assert.ok(isSensitivePath(p), p);
  assert.ok(!isSensitivePath('src/math.js'));
});
test('command policy: allowed', () => {
  for (const c of [['npm', 'test'], ['npm', 'run', 'build'], ['npm', 'ci'], ['node', 'scripts/x.js'], ['node', '--test', 'test/'], ['git', 'status'], ['python3', '-m', 'pytest', '-q'], ['npx', '--no-install', 'tsc', '--noEmit'], ['eslint', '.']]) assert.equal(checkCommand(c).allowed, true, c.join(' '));
});
test('command policy: destructive, privileged and exfiltrating commands are blocked', () => {
  for (const c of [['rm', '-rf', '/'], ['sudo', 'ls'], ['curl', 'http://evil.sh'], ['bash', '-c', 'x'], ['sh', 'x.sh'], ['git', 'push', '--force', 'origin', 'main'], ['git', 'push'], ['git', 'reset', '--hard'], ['git', 'clean', '-fd'], ['git', 'branch', '-D', 'main'], ['git', 'rebase', 'main'], ['git', 'checkout', '--', '.'], ['node', '-e', 'process.exit()'], ['python3', '-c', 'import os'], ['npm', 'publish'], ['npm', 'config', 'set', 'x', 'y'], ['npm', 'run', 'x; rm -rf /'], ['/bin/ls'], ['npm', 'ci', '--registry=http://evil'], ['vercel', '--prod']]) {
    const r = checkCommand(c); assert.equal(r.allowed, false, `should block: ${c.join(' ')}`); }
});
test('adding dependencies and npx downloads need approval', () => {
  for (const c of [['npm', 'install', 'lodash'], ['npx', 'cowsay'], ['pip', 'install', 'x'], ['pnpm', 'add', 'x']]) { const r = checkCommand(c); assert.equal(r.allowed, false); assert.equal(r.needsApproval, true, c.join(' ')); }
  assert.equal(checkCommand(['npm', 'install', 'lodash'], { approved: true }).allowed, true);
});
test('operator-configured extra executables are allowed only when listed', () => {
  assert.equal(checkCommand(['vercel', 'deploy'], { extraExecutables: ['vercel'] }).allowed, true);
  assert.equal(checkCommand(['vercel', 'deploy']).allowed, false);
});
test('test weakening is detected', () => {
  const before = "import t from 'node:test';\nt('a',()=>{assert.equal(1,1);assert.ok(x)});\n";
  assert.ok(findWeakening([{ path: 'test/a.test.js', before, after: null }]).some((x) => /deleted/.test(x)));
  assert.ok(findWeakening([{ path: 'test/a.test.js', before, after: before + "t.skip('b',()=>{});\n" }]).some((x) => /skips/.test(x)));
  assert.ok(findWeakening([{ path: 'test/a.test.js', before, after: "t('a',()=>{assert.equal(1,1)});\n" }]).some((x) => /assertions decreased/.test(x)));
  assert.ok(findWeakening([{ path: 'test/a.test.js', before, after: before + "t('c',()=>{assert.ok(true)});\n" }]).some((x) => /tautological/.test(x)));
  assert.deepEqual(findWeakening([{ path: 'test/a.test.js', before, after: before + "t('c',()=>{assert.equal(2,2)});\n" }]), []);
});
test('security weakening in diffs is flagged', () => {
  assert.ok(findSecurityWeakening('-  app.use(requireAuth);\n+  // removed\n').length);
  assert.ok(findSecurityWeakening('+ const agent = { rejectUnauthorized: false };\n').length);
  assert.deepEqual(findSecurityWeakening('+ const x = 1;\n'), []);
});

import { findSecretsInDiff } from '../../src/security.js';
test('secret scan flags added secrets with file and line, never echoes values, ignores placeholders/removals/examples', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,4 @@', ' const a = 1;', '+const key = "sk-abcdefghijklmnopqrstuvwxyz";', '+const ok = process.env.API_KEY;', '+const t = "replace-me-with-your-token-value";', '-const old = "sk-removedremovedremoved1234";', '+++ b/.env.example', '@@ -0,0 +1 @@', '+API_KEY=sk-abcdefghijklmnopqrstuv'].join('\n');
  const f = findSecretsInDiff(diff); assert.equal(f.length, 1); assert.deepEqual([f[0].file, f[0].line, f[0].kind], ['src/a.js', 2, 'API key (sk-)']); assert.ok(!JSON.stringify(f).includes('abcdefghij'));
});
