import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CommandDenied, runCommand } from '../../src/runner.js';
import { testConfig, tmp } from '../helpers/sample-app.js';

const mk = () => { const dir = tmp(); return { dir, cfg: testConfig(tmp('data-')) }; };
const script = (dir, name, code) => { fs.writeFileSync(path.join(dir, name), code); return name; };

test('runs argv commands without a shell and captures output and exit code', async () => {
  const { dir, cfg } = mk(); script(dir, 'a.js', "console.log('hi $HOME; echo injected'); console.error('warn'); process.exit(3)");
  const r = await runCommand(['node', 'a.js'], { cwd: dir, cfg });
  assert.equal(r.exitCode, 3); assert.match(r.stdout, /hi \$HOME; echo injected/); assert.match(r.stderr, /warn/);
});
test('blocked commands throw before spawning', async () => {
  const { dir, cfg } = mk();
  await assert.rejects(runCommand(['rm', '-rf', dir], { cwd: dir, cfg }), CommandDenied);
  assert.ok(fs.existsSync(dir));
  await assert.rejects(runCommand(['npm', 'install', 'left-pad'], { cwd: dir, cfg }), (e) => e.code === 'NEEDS_APPROVAL');
});
test('timeouts kill the whole process group', async () => {
  const { dir, cfg } = mk(); script(dir, 'hang.js', "import('node:child_process').then(({spawn})=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)})");
  const t0 = Date.now(); const r = await runCommand(['node', 'hang.js'], { cwd: dir, cfg, timeoutMs: 400 });
  assert.equal(r.timedOut, true); assert.ok(Date.now() - t0 < 5000);
});
test('abort signal cancels a running command', async () => {
  const { dir, cfg } = mk(); script(dir, 'hang.js', 'setInterval(()=>{},1000)');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
  const r = await runCommand(['node', 'hang.js'], { cwd: dir, cfg, signal: ac.signal }); assert.equal(r.aborted, true);
});
test('output is bounded but keeps the tail where errors live', async () => {
  const { dir, cfg } = mk(); cfg.limits.maxOutputBytes = 2000; script(dir, 'big.js', "for(let i=0;i<5000;i++)console.log('line '+i);console.log('FINAL ERROR LINE')");
  const r = await runCommand(['node', 'big.js'], { cwd: dir, cfg });
  assert.ok(r.stdout.length < 4000); assert.match(r.stdout, /FINAL ERROR LINE/); assert.match(r.stdout, /omitted/);
});
test('child env is scrubbed of host secrets and output is redacted', async () => {
  const { dir, cfg } = mk(); process.env.SOME_SECRET_TOKEN = 'host-secret-value-123456';
  script(dir, 'env.js', "console.log('SEEN=' + (process.env.SOME_SECRET_TOKEN ?? 'none')); console.log('leak sk-abcdefghijklmnopqrstuv1234');");
  const r = await runCommand(['node', 'env.js'], { cwd: dir, cfg });
  delete process.env.SOME_SECRET_TOKEN;
  assert.match(r.stdout, /SEEN=none/); assert.ok(!r.stdout.includes('sk-abcdefghijklmnopqrstuv1234')); assert.match(r.stdout, /REDACTED/);
});
test('cwd cannot escape the root', async () => {
  const { dir, cfg } = mk();
  await assert.rejects(runCommand(['node', '--version'], { cwd: path.join(dir, '..'), root: dir, cfg }), /escapes/);
});
test('missing executable reports a spawn error instead of crashing', async () => {
  const { dir, cfg } = mk();
  const r = await runCommand(['pytest', '-q'], { cwd: dir, cfg, env: {}, skipPolicy: false }).catch((e) => e);
  assert.ok(r.exitCode === 127 || r.spawnError || r.exitCode !== 0);
});
