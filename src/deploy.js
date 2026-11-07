import { splitCommand } from './util.js';

export async function healthCheck(url, { retries = 5, intervalMs = 3000, fetchImpl = globalThis.fetch, timeoutMs = 10_000, expectStatus = (s) => s >= 200 && s < 400 } = {}) {
  let last = 'no attempt';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (expectStatus(res.status)) return { ok: true, status: res.status, detail: `HTTP ${res.status}`, url, attempts: i + 1 };
      last = `HTTP ${res.status}`;
    } catch (e) { last = e.message; }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, detail: `${last} after ${retries} attempt(s)`, url, attempts: retries };
}

/** Preview deployment: runs the configured command, extracts the URL from its output, then really probes it. */
export async function runPreviewDeploy({ task, cfg, wt, exec, log, fetchImpl }) {
  const d = cfg.deploy; const result = { startedAt: new Date().toISOString(), previewUrl: null, health: null, smoke: [], production: null };
  const env = Object.fromEntries(d.envPassthrough.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  const redactExtra = Object.values(env);
  let argv;
  try { argv = splitCommand(d.previewCommand); } catch (e) { result.health = { ok: false, detail: e.message }; return result; }
  if (argv.some((a) => /(^|[=\s])--prod(uction)?\b/.test(a))) { result.health = { ok: false, detail: 'preview command contains a production flag; refused' }; return result; }
  let r;
  try { r = await exec(argv, { cwd: wt, source: 'deploy', env, redactExtra, extraExecutables: d.extraExecutables, approved: false }); }
  catch (e) { result.health = { ok: false, detail: `preview command blocked/failed: ${e.message}` }; return result; }
  if (r.exitCode !== 0) { result.health = { ok: false, detail: `preview command exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(-200)}` }; return result; }
  const m = `${r.stdout}\n${r.stderr}`.match(new RegExp(d.previewUrlRegex));
  if (!m) { result.health = { ok: false, detail: 'could not find a preview URL in deploy command output' }; return result; }
  result.previewUrl = m[0].replace(/[).,;]+$/, '');
  const base = result.previewUrl.replace(/\/$/, '');
  result.health = await healthCheck(base + d.healthPath, { retries: d.healthRetries, intervalMs: d.healthIntervalMs, fetchImpl });
  log('deploy_health', { url: result.previewUrl, ok: result.health.ok, detail: result.health.detail });
  if (result.health.ok) {
    for (const p of d.smokePaths) { const s = await healthCheck(base + p, { retries: 2, intervalMs: d.healthIntervalMs, fetchImpl }); result.smoke.push({ path: p, ok: s.ok, detail: s.detail }); }
    if (result.smoke.some((s) => !s.ok)) result.health = { ok: false, detail: `smoke test failed: ${result.smoke.filter((s) => !s.ok).map((s) => `${s.path} (${s.detail})`).join(', ')}`, url: result.previewUrl };
  }
  return result;
}

/**
 * Production promotion is gated 5 ways: task passed, preview healthy, config switch on,
 * explicit per-task human approval, and a configured command/hook. Missing any of them blocks it.
 */
export async function promoteToProduction({ task, cfg, wt, exec, approved, fetchImpl = globalThis.fetch }) {
  const d = cfg.deploy;
  const refuse = (why) => ({ ok: false, blocked: true, reason: why });
  if (task.status !== 'passed') return refuse(`task status is "${task.status}", not "passed"`);
  if (!task.deploy?.health?.ok) return refuse('no healthy preview deployment recorded for this task');
  if (!d.productionEnabled) return refuse('production deployment is disabled in configuration (deploy.productionEnabled=false)');
  if (approved !== true) return refuse('explicit approval was not given for this task');
  if (d.renderDeployHookEnv && process.env[d.renderDeployHookEnv]) {
    const res = await fetchImpl(process.env[d.renderDeployHookEnv], { method: 'POST', signal: AbortSignal.timeout(30_000) });
    return { ok: res.ok, blocked: false, reason: `deploy hook responded HTTP ${res.status}`, note: 'Hook accepted does not prove the deploy succeeded; verify the production URL.' };
  }
  if (!d.productionCommand) return refuse('no productionCommand configured');
  const env = Object.fromEntries(d.envPassthrough.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  const r = await exec(splitCommand(d.productionCommand), { cwd: wt, source: 'deploy', env, redactExtra: Object.values(env), extraExecutables: d.extraExecutables, approved: true });
  return { ok: r.exitCode === 0, blocked: false, reason: `production command exited ${r.exitCode}` };
}
