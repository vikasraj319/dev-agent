import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkCommand, createRedactor, resolveInside, SecurityError } from './security.js';
import { buildDockerArgs, killContainer, newContainerName, preflight, SandboxUnavailable } from './sandbox.js';

/** Keeps the head and tail of a stream so errors at the end are never lost. */
class BoundedBuffer {
  constructor(max) { this.headMax = Math.floor(max * 0.25); this.tailMax = max - this.headMax; this.head = ''; this.tail = ''; this.dropped = 0; }
  push(s) {
    if (this.head.length < this.headMax) { const room = this.headMax - this.head.length; this.head += s.slice(0, room); s = s.slice(room); }
    if (s) { this.tail += s; if (this.tail.length > this.tailMax) { this.dropped += this.tail.length - this.tailMax; this.tail = this.tail.slice(-this.tailMax); } }
  }
  toString() { return this.dropped ? `${this.head}\n…[${this.dropped} chars omitted]…\n${this.tail}` : this.head + this.tail; }
}

export class CommandDenied extends Error {
  constructor(argv, policy) { super(`Command blocked by policy: ${argv.join(' ')} (${policy.reason})`); this.policy = policy; this.argv = argv; this.code = policy.needsApproval ? 'NEEDS_APPROVAL' : 'DENIED'; }
}

/**
 * Safe subprocess execution: argv only (never a shell), policy-checked, cwd confined to `root`,
 * scrubbed environment, wall-clock timeout, bounded output, secret redaction, optional Docker sandbox.
 */
export async function runCommand(argv, opts) {
  const { cwd, root = cwd, cfg, hostExec = false, rawOutput = false, network, timeoutMs = cfg?.limits?.maxCommandMs ?? 300_000, signal, onData, env: extraEnv = {}, approved = false, extraExecutables = [], skipPolicy = false, redactExtra = [] } = opts;
  if (!skipPolicy) {
    const policy = checkCommand(argv, { extraExecutables, approved });
    if (!policy.allowed) throw new CommandDenied(argv, policy);
  }
  const cwdAbs = cwd === root ? fs.realpathSync(root) : resolveInside(root, path.relative(root, cwd) || '.');
  const redact = rawOutput ? (x) => String(x) : createRedactor(redactExtra); // rawOutput only for trusted host-side git reads whose output is scanned, then redacted before persistence/model use
  const dataDir = cfg?.dataDir ?? path.join(root, '.devagent-home');
  const home = path.join(dataDir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: home, LANG: process.env.LANG || 'C.UTF-8', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1',
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', ...extraEnv,
  };
  const maxBytes = cfg?.limits?.maxOutputBytes ?? 400_000;
  const out = new BoundedBuffer(maxBytes); const err = new BoundedBuffer(maxBytes);

  let spawnArgv = argv; let spawnCwd = cwdAbs; let spawnEnv = env; let container = null;
  // Project code runs in the sandbox when configured. Host-side `git` (trusted, argv-validated) and operator deploy commands run on the host.
  const sandboxed = cfg?.sandbox?.mode === 'docker' && !hostExec && argv[0] !== 'git';
  if (sandboxed) {
    const pf = await preflight(cfg);
    if (!pf.ok) throw new SandboxUnavailable(pf.reason); // fail closed: never fall back to host execution
    container = newContainerName();
    spawnArgv = ['docker', ...buildDockerArgs({ cfg, root: fs.realpathSync(root), workdirRel: path.relative(root, cwdAbs), argv, name: container, network, env: extraEnv })];
    spawnCwd = process.cwd(); spawnEnv = { PATH: process.env.PATH, HOME: home };
  }

  const started = Date.now();
  return await new Promise((resolve) => {
    let timedOut = false; let aborted = false; let settled = false;
    let child;
    try { child = spawn(spawnArgv[0], spawnArgv.slice(1), { cwd: spawnCwd, env: spawnEnv, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ argv, exitCode: 127, signal: null, timedOut: false, aborted: false, stdout: '', stderr: redact(String(e.message)), durationMs: 0, spawnError: e.message }); }
    const kill = () => { if (container) killContainer(container); try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const feed = (buf, stream) => (d) => { const s = redact(d.toString('utf8')); buf.push(s); onData?.(stream, s); };
    child.stdout.on('data', feed(out, 'stdout')); child.stderr.on('data', feed(err, 'stderr'));
    const finish = (exitCode, sig, spawnError) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolve({ argv, exitCode: exitCode ?? (sig ? 128 : 1), signal: sig ?? null, timedOut, aborted, stdout: out.toString(), stderr: err.toString(), durationMs: Date.now() - started, spawnError: spawnError ? redact(spawnError) : undefined });
    };
    child.on('error', (e) => finish(127, null, e.message));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

export { SecurityError, SandboxUnavailable };
