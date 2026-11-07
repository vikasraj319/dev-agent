import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, fileSha } from '../../src/editor.js';
import { testConfig, tmp } from '../helpers/sample-app.js';

const setup = (files = {}) => { const root = tmp(); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); } return { root, cfg: testConfig(tmp()) }; };
const rd = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

test('write, replace and delete work and report changes', () => {
  const { root, cfg } = setup({ 'a.js': 'one two', 'b.js': 'x' });
  const r = applyEdits(root, [{ op: 'write_file', path: 'new/c.js', content: 'c' }, { op: 'replace', path: 'a.js', old: 'two', new: '2' }, { op: 'delete_file', path: 'b.js' }], cfg);
  assert.ok(r.ok); assert.equal(rd(root, 'a.js'), 'one 2'); assert.ok(!fs.existsSync(path.join(root, 'b.js'))); assert.equal(rd(root, 'new/c.js'), 'c');
  assert.deepEqual(r.changes.map((c) => c.op).sort(), ['create', 'delete', 'modify']);
});
test('edit sets are atomic: one bad edit applies nothing', () => {
  const { root, cfg } = setup({ 'a.js': 'hello' });
  const r = applyEdits(root, [{ op: 'write_file', path: 'ok.js', content: 'x' }, { op: 'replace', path: 'a.js', old: 'missing', new: 'y' }], cfg);
  assert.ok(!r.ok); assert.ok(!fs.existsSync(path.join(root, 'ok.js'))); assert.equal(rd(root, 'a.js'), 'hello');
});
test('ambiguous replace is rejected', () => {
  const { root, cfg } = setup({ 'a.js': 'x x' }); const r = applyEdits(root, [{ op: 'replace', path: 'a.js', old: 'x', new: 'y' }], cfg);
  assert.ok(!r.ok); assert.match(r.errors[0], /matches 2 places/);
});
test('traversal, absolute, protected and secret paths are rejected', () => {
  const { root, cfg } = setup({ 'a.js': 'a' }); const outside = path.join(path.dirname(root), 'pwn.txt');
  for (const p of ['../pwn.txt', outside, '.env', '.git/hooks/pre-commit', 'node_modules/x.js', 'deploy.pem']) {
    const r = applyEdits(root, [{ op: 'write_file', path: p, content: 'x' }], cfg); assert.ok(!r.ok, p); }
  assert.ok(!fs.existsSync(outside));
});
test('re-applying a replace whose old text is gone is a no-op', () => {
  const { root, cfg } = setup({ 'a.js': 'foo' }); const e = [{ op: 'replace', path: 'a.js', old: 'foo', new: 'bar' }];
  assert.ok(applyEdits(root, e, cfg).ok); const second = applyEdits(root, e, cfg); assert.ok(second.ok); assert.equal(rd(root, 'a.js'), 'bar'); assert.equal(second.changes.length, 0);
});
test('fileSha lets crash-recovery distinguish applied from unapplied edits exactly', () => {
  const { root, cfg } = setup({ 'a.js': 'foo' }); const before = fileSha(root, 'a.js');
  assert.equal(fileSha(root, 'a.js'), before);
  applyEdits(root, [{ op: 'replace', path: 'a.js', old: 'foo', new: 'foobar' }], cfg);
  assert.notEqual(fileSha(root, 'a.js'), before); assert.equal(fileSha(root, 'missing.js'), null);
});
test('edits that weaken tests are rejected', () => {
  const { root, cfg } = setup({ 'test/a.test.js': "assert.equal(1,1);\nassert.ok(x);\n" });
  assert.ok(!applyEdits(root, [{ op: 'delete_file', path: 'test/a.test.js' }], cfg).ok);
  assert.ok(!applyEdits(root, [{ op: 'write_file', path: 'test/a.test.js', content: "assert.equal(1,1);\n" }], cfg).ok);
  assert.equal(rd(root, 'test/a.test.js'), "assert.equal(1,1);\nassert.ok(x);\n");
});
test('size limits and sensitive-file flags', () => {
  const { root, cfg } = setup(); cfg.limits.maxFileBytes = 10;
  assert.ok(!applyEdits(root, [{ op: 'write_file', path: 'big.js', content: 'x'.repeat(11) }], cfg).ok);
  cfg.limits.maxFileBytes = 1000; const r = applyEdits(root, [{ op: 'write_file', path: '.github/workflows/ci.yml', content: 'on: push' }], cfg);
  assert.ok(r.ok); assert.equal(r.changes[0].sensitive, true);
});
