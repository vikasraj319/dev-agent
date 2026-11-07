import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDockerArgs } from '../../src/sandbox.js';
import { resetPreflightCache, preflight } from '../../src/sandbox.js';
import { runCommand, SandboxUnavailable } from '../../src/runner.js';
import { loadConfig, ConfigError } from '../../src/config.js';
import { pathWithoutDocker, testConfig, tmp } from '../helpers/sample-app.js';

const dockerCfg = () => { const c = testConfig(tmp('data-')); c.sandbox = { mode: 'docker', required: true, image: 'node:22-bookworm', network: 'none', memory: '1g', cpus: '1', pidsLimit: 128, allowNetworkForInstall: false }; return c; };
const withoutDocker = async (fn) => { const old = process.env.PATH; process.env.PATH = pathWithoutDocker(); resetPreflightCache(); try { return await fn(); } finally { process.env.PATH = old; resetPreflightCache(); } };

test('docker argv enforces isolation: no network, read-only fs, non-root, no caps, limits, single mount', () => {
  const a = buildDockerArgs({ cfg: dockerCfg(), root: '/data/worktrees/t1', workdirRel: 'app', argv: ['npm', 'test'], name: 'devagent-x', uid: 1001, gid: 1001 });
  const j = a.join(' ');
  for (const must of ['--rm', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--network none', '--user 1001:1001', '--memory 1g', '--memory-swap 1g', '--cpus 1', '--pids-limit 128', '--ulimit nofile=1024:1024', '-w /work/app', '--name devagent-x']) assert.ok(j.includes(must), `missing ${must}`);
  assert.ok(j.includes('--tmpfs /tmp:rw,nosuid,nodev'));
  assert.deepEqual(a.slice(-3), ['node:22-bookworm', 'npm', 'test']);
  const mounts = a.filter((x, i) => a[i - 1] === '-v'); assert.deepEqual(mounts, ['/data/worktrees/t1:/work:rw']);
  assert.ok(!j.includes('docker.sock') && !j.includes('--privileged') && !/-v \/(home|root|etc|var)/.test(j) && !j.includes('.ssh') && !j.includes('--network host'));
});
test('network is only enabled when explicitly requested for a command', () => {
  const cfg = dockerCfg(); assert.ok(buildDockerArgs({ cfg, root: '/r', argv: ['x'], name: 'n' }).join(' ').includes('--network none'));
  assert.ok(buildDockerArgs({ cfg, root: '/r', argv: ['x'], name: 'n', network: 'bridge' }).join(' ').includes('--network bridge'));
});
test('host secrets are never forwarded into the container', () => {
  process.env.AGENT_TEST_SECRET_TOKEN = 'host-secret-aaaaaaaaaaaa'; const a = buildDockerArgs({ cfg: dockerCfg(), root: '/r', argv: ['x'], name: 'n' }).join(' ');
  delete process.env.AGENT_TEST_SECRET_TOKEN; assert.ok(!a.includes('host-secret'));
});
test('FAIL CLOSED: sandbox mode without Docker refuses to run project commands and never falls back to the host', async () => {
  const cfg = dockerCfg(); const dir = tmp(); const marker = path.join(tmp(), 'ran');
  fs.writeFileSync(path.join(dir, 'x.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed on host')`);
  await withoutDocker(async () => {
    const pf = await preflight(cfg); assert.equal(pf.ok, false); assert.match(pf.reason, /docker CLI is not installed/);
    await assert.rejects(runCommand(['node', 'x.js'], { cwd: dir, cfg }), (e) => e instanceof SandboxUnavailable && e.code === 'SANDBOX_UNAVAILABLE');
  });
  assert.ok(!fs.existsSync(marker), 'the command must not have executed on the host');
});
test('host-side git is not containerised so worktree operations keep working', async () => {
  const cfg = dockerCfg(); await withoutDocker(async () => { const r = await runCommand(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: tmp(), cfg }); assert.equal(r.exitCode, 128, 'ran on the host (not a repo), did not throw SandboxUnavailable'); });
});
test('sandbox.required without docker mode is a startup configuration error', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { sandbox: { required: true } } }), (e) => e instanceof ConfigError && /sandbox\.required/.test(e.message));
  assert.doesNotThrow(() => loadConfig({ env: {}, overrides: { sandbox: { required: true, mode: 'docker' } } }));
  assert.throws(() => loadConfig({ env: {}, overrides: { sandbox: { network: 'host' } } }), /sandbox\.network/);
});
test('Docker sandbox defaults are restrictive', () => { const c = loadConfig({ env: {} }); assert.equal(c.sandbox.network, 'none'); assert.equal(c.sandbox.allowNetworkForInstall, false); assert.equal(c.limits.maxConcurrentTasks, 1); });
