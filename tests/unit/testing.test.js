import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, fingerprint, parseFailure } from '../../src/testing.js';

const res = (stdout, stderr = '', extra = {}) => ({ stdout, stderr, exitCode: 1, timedOut: false, ...extra });
test('parses node test failures, stack frames and python tracebacks', () => {
  const p = parseFailure(res('not ok 1 - sum adds numbers\n  error: Expected values to be strictly equal\n    at TestContext.<anonymous> (file:///tmp/x/test/math.test.js:7:10)'), 'test');
  assert.match(p.summary, /not ok 1/); assert.ok(p.files.some((f) => f.file.endsWith('test/math.test.js') && f.line === 7));
  const py = parseFailure(res('', 'Traceback (most recent call last):\n  File "/work/app/main.py", line 12, in f\nValueError: bad'), 'test');
  assert.ok(py.files.some((f) => f.file.endsWith('main.py') && f.line === 12));
});
test('fingerprints ignore timings, line numbers and temp paths but differ across errors', () => {
  const a = parseFailure(res('not ok 1 - x\n error: boom at /tmp/abc123/file.js:10 in 12.5ms'), 'test'); const b = parseFailure(res('not ok 1 - x\n error: boom at /tmp/zzz999/file.js:99 in 3.1ms'), 'test'); const c = parseFailure(res('not ok 1 - x\n error: different'), 'test');
  assert.equal(fingerprint('test', a), fingerprint('test', b)); assert.notEqual(fingerprint('test', a), fingerprint('test', c));
});
test('classifies code, dependency, environment, external-service and timeout failures', () => {
  const cls = (r, check = 'test') => classifyFailure(r, parseFailure(r, check));
  assert.equal(cls(res('not ok 1\nAssertionError: expected 5')), 'test-or-code');
  assert.equal(cls(res('', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /x")), 'dependency');
  assert.equal(cls(res('', 'ModuleNotFoundError: No module named requests')), 'dependency');
  assert.equal(cls(res('', 'sh: 1: vite: command not found', { exitCode: 127 })), 'environment');
  assert.equal(cls(res('', 'FetchError: connect ECONNREFUSED 127.0.0.1:5432')), 'external-service');
  assert.equal(cls(res('', '', { timedOut: true })), 'timeout');
  assert.equal(cls(res('', "SyntaxError: Unexpected token '}'"), 'build'), 'code');
});
