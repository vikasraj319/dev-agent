import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export class SandboxUnavailable extends Error {
  constructor(reason) { super(`Sandbox unavailable: ${reason}. Refusing to run project code unsandboxed (no fallback).`); this.code = 'SANDBOX_UNAVAILABLE'; this.reason = reason; }
}

/**
 * Pure builder for the `docker run` argv. Everything security-relevant is decided here so it can be unit-tested
 * without Docker. Mounts ONLY the worktree; never the Docker socket, home directory or host env.
 */
export function buildDockerArgs({ cfg, root, workdirRel = '.', argv, name, network, env = {}, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000 }) {
  const sb = cfg.sandbox;
  const envFlags = Object.entries({ HOME: '/tmp/home', CI: '1', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const wd = workdirRel === '.' || workdirRel === '' ? '/work' : `/work/${workdirRel.split('\\').join('/')}`;
  return ['run', '--rm', '--init', '--name', name,
    '--network', network ?? sb.network,
    '--memory', sb.memory, '--memory-swap', sb.memory, '--cpus', String(sb.cpus), '--pids-limit', String(sb.pidsLimit ?? 256),
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`, '--ulimit', 'nofile=1024:1024',
    '-v', `${root}:/work:rw`, '-w', wd, ...envFlags, sb.image, ...argv];
}

export const newContainerName = () => `devagent-${crypto.randomBytes(6).toString('hex')}`;

function docker(args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    let p; try { p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: 127, out: '', err: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const fin = (code, e) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out: out.trim(), err: (e || err).trim() }); };
    p.on('error', (e) => fin(127, e.message)); p.on('close', (c) => fin(c));
  });
}
export const killContainer = (name) => { docker(['kill', name], 10_000).then(() => docker(['rm', '-f', name], 10_000)); };

let cache = null;
/** Verifies the Docker daemon is reachable and the sandbox image exists locally. Cached briefly. */
export async function preflight(cfg, { force = false } = {}) {
  const key = `${cfg.sandbox.image}`; const now = Date.now();
  if (!force && cache && cache.key === key && now - cache.at < (cache.result.ok ? 30_000 : 5_000)) return cache.result;
  let result;
  const v = await docker(['version', '--format', '{{.Server.Version}}']);
  if (v.code !== 0) result = { ok: false, reason: v.code === 127 ? 'the docker CLI is not installed or not on PATH' : `docker daemon not reachable (${v.err.slice(0, 160) || 'no response'})` };
  else {
    const i = await docker(['image', 'inspect', '--format', '{{.Id}}', cfg.sandbox.image]);
    result = i.code === 0 ? { ok: true, dockerVersion: v.out, image: cfg.sandbox.image } : { ok: false, reason: `sandbox image "${cfg.sandbox.image}" is not present locally (run: docker pull ${cfg.sandbox.image})` };
  }
  cache = { key, at: now, result }; return result;
}
export const resetPreflightCache = () => { cache = null; };
