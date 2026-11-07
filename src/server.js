import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { publicConfig } from './config.js';
import { ATTENTION, computeMetrics, pipelineView, taskSummary } from './metrics.js';
import { ResourceMonitor } from './monitor.js';
import { Orchestrator, TaskControl } from './orchestrator.js';
import { analyzeRepo } from './repo.js';
import { GitManager } from './git.js';
import { discoverProjects, listDir, readFilePreview, resolveProject } from './projects.js';
import { preflight } from './sandbox.js';
import { Store } from './store.js';
import { promoteToProduction } from './deploy.js';
import { buildModels } from './providers.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ARTIFACTS = { 'report.md': 'text/markdown', 'changes.patch': 'text/x-diff', 'pr-description.md': 'text/markdown', 'events.jsonl': 'application/x-ndjson', 'task.json': 'application/json' };
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
const bad = (message, code = 400) => Object.assign(new Error(message), { code });

export function createServer({ cfg, models, token = crypto.randomBytes(24).toString('hex'), uiDir = path.resolve(import.meta.dirname, '../ui') }) {
  const store = new Store(cfg.dataDir, { maxEventsPerTask: cfg.limits.maxEventsPerTask });
  const monitor = new ResourceMonitor({ dataDir: cfg.dataDir }).start();
  const live = new Map(); // taskId -> TaskControl
  const subscribers = new Map(); // taskId -> Set<res>
  const ops = new Map(); // taskId -> { current: {argv, at}|null, message }
  const startedAt = Date.now();
  const maxConcurrent = cfg.limits.maxConcurrentTasks ?? 1;

  const track = (id, ev) => {
    const o = ops.get(id) ?? { current: null, message: null }; ops.set(id, o);
    if (ev.type === 'command_start') o.current = { argv: ev.argv, at: ev.t, source: ev.source };
    else if (ev.type === 'command_end' || ev.type === 'command_denied') o.current = null;
    if (ev.type === 'stage') o.message = `Entered stage: ${ev.stage}`;
    else if (ev.type === 'check') o.message = `${ev.name} ${ev.passed ? 'passed' : 'FAILED'} (${ev.phase})`;
    else if (ev.type === 'repair_start') o.message = `Repair attempt ${ev.n}/${ev.max} for ${ev.check}`;
    else if (ev.type === 'git' || ev.type === 'sandbox') o.message = ev.message;
    else if (ev.type === 'status') o.message = `Status: ${ev.status}${ev.outcome ? ` — ${ev.outcome}` : ''}`;
  };
  const emit = (id, ev) => { track(id, ev); for (const res of subscribers.get(id) ?? []) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`); };
  const makeOrch = () => new Orchestrator({ cfg, store, models: models ?? buildModels(cfg), emit });
  const git = new GitManager(cfg);
  store.recoverInterrupted((id) => live.has(id));

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); } }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(bad('invalid JSON')); } }); });
  const allTasks = () => store.listSummaries();
  const withLive = (t) => ({ ...taskSummary(t), pipeline: pipelineView(t), currentOperation: live.has(t.id) ? ops.get(t.id)?.current ?? null : null, latestMessage: ops.get(t.id)?.message ?? t.outcomeReason ?? null, running: live.has(t.id) });

  const start = (taskId) => {
    const ctl = new TaskControl(); live.set(taskId, ctl);
    makeOrch().execute(taskId, ctl).catch((e) => { const t = store.loadTask(taskId); if (t) { store.appendEvent(taskId, { type: 'error', message: e.message }); if (t.status === 'queued' || t.status === 'running') { t.status = 'failed'; t.outcomeReason = e.message; store.saveTask(t); } } }).finally(() => { live.delete(taskId); const o = ops.get(taskId); if (o) o.current = null; });
  };

  const sandboxState = async () => {
    const sb = cfg.sandbox;
    if (sb.mode !== 'docker') return { configured: 'none', required: sb.required, isolated: false, verified: false, detail: 'Project commands run directly on this host with the agent user\'s privileges. No container isolation is configured.' };
    const pf = await preflight(cfg);
    return { configured: 'docker', required: sb.required, image: sb.image, network: sb.network, memory: sb.memory, cpus: sb.cpus, pidsLimit: sb.pidsLimit, daemonReachable: pf.ok || !/not installed|not reachable/.test(pf.reason ?? ''), imagePresent: pf.ok, isolated: pf.ok, verified: false, detail: pf.ok ? `Docker daemon ${pf.dockerVersion} reachable and image present. Container flags are unit-tested; end-to-end isolation has not been independently verified at runtime.` : `Sandbox is configured but UNAVAILABLE: ${pf.reason}. Tasks will fail closed rather than run unsandboxed.` };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const host = (req.headers.host || '').split(':')[0];
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { error: 'bad host header' }); // DNS-rebinding guard
      if (!url.pathname.startsWith('/api/')) { // static UI (token injected; same-origin only, no CORS headers are ever sent)
        const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const abs = path.resolve(uiDir, f);
        if (!abs.startsWith(uiDir + path.sep) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
        let body = fs.readFileSync(abs, 'utf8'); if (f === 'index.html') body = body.replace('__AGENT_TOKEN__', token);
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'text/plain', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(body);
      }
      const given = req.headers['x-agent-token']; // header only: tokens in URLs leak into logs and history
      const okTok = typeof given === 'string' && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!okTok) return json(res, 401, { error: 'missing or invalid API token' });
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'application/json required' });
      const seg = url.pathname.split('/').filter(Boolean).slice(1);
      const q = url.searchParams;

      if (req.method === 'GET' && seg[0] === 'config') return json(res, 200, publicConfig(cfg));
      if (req.method === 'GET' && seg[0] === 'health') {
        const tasks = allTasks();
        return json(res, 200, { status: 'ok', version: VERSION, uptimeMs: Date.now() - startedAt, node: process.version, sandbox: await sandboxState(), workspace: { allowedProjectDirs: cfg.allowedProjectDirs, protectedBranches: cfg.protectedBranches },
          concurrency: { running: live.size, max: maxConcurrent }, pendingApprovals: tasks.filter((t) => t.status === 'needs_approval').length, resources: monitor.snapshot(), provider: Object.fromEntries(['planning', 'implementation', 'debugging'].map((r) => [r, { provider: cfg.models[r], model: cfg.providers[cfg.models[r]].model || null, type: cfg.providers[cfg.models[r]].type }])) });
      }
      if (req.method === 'GET' && seg[0] === 'overview') {
        const tasks = allTasks(); const day = Date.now() - 86_400_000;
        const attention = tasks.filter((t) => ATTENTION.includes(t.status) || (t.status === 'failed' && Date.parse(t.finishedAt || t.updatedAt) > day));
        return json(res, 200, { running: tasks.filter((t) => live.has(t.id)).map(withLive), queued: tasks.filter((t) => t.status === 'queued' && !live.has(t.id)).length, attention: attention.slice(0, 20).map(withLive), recent: tasks.slice(0, 8).map(withLive), concurrency: { running: live.size, max: maxConcurrent } });
      }
      if (req.method === 'GET' && seg[0] === 'metrics') {
        const days = Math.min(365, Math.max(1, Number(q.get('days')) || 30)); const project = q.get('project') || null;
        return json(res, 200, computeMetrics(allTasks(), { sinceMs: Date.now() - days * 86_400_000, project, readEvents: (id) => store.readEvents(id) }));
      }
      if (req.method === 'GET' && seg[0] === 'security') {
        const tasks = allTasks().slice(0, 200); const denied = []; const timeouts = []; const approvals = [];
        for (const t of tasks) {
          for (const d of t.deniedCommands || []) denied.push({ taskId: t.id, project: path.basename(t.repoPath), argv: d.argv, reason: d.reason, needsApproval: d.needsApproval, source: d.source });
          for (const r of t.checkRuns || []) if (r.timedOut) timeouts.push({ taskId: t.id, check: r.name, at: r.at });
          if (t.status === 'needs_approval') approvals.push({ taskId: t.id, project: path.basename(t.repoPath), reasons: t.approvalRequired || [] });
        }
        return json(res, 200, { sandbox: await sandboxState(), pendingApprovals: approvals, deniedCommands: denied.slice(0, 50), timedOutChecks: timeouts.slice(0, 50), failedTasks: tasks.filter((t) => t.status === 'failed').length, protections: [
          { name: 'API token + loopback Host check', state: 'enforced', verified: true, evidence: 'unit tests: unauthorized and rebinding requests rejected' },
          { name: 'Command allowlist / no shell', state: 'enforced', verified: true, evidence: 'unit + acceptance tests' },
          { name: 'Path traversal & symlink checks', state: 'enforced', verified: true, evidence: 'unit tests (editor, file explorer)' },
          { name: 'Secret redaction', state: 'enforced', verified: true, evidence: 'unit + acceptance tests' },
          { name: 'Docker sandbox', state: cfg.sandbox.mode === 'docker' ? 'configured' : 'not configured', verified: false, evidence: 'argv/fail-closed logic unit-tested; no live container isolation test has been run in CI' }] });
      }
      if (req.method === 'GET' && seg[0] === 'projects' && !seg[1]) {
        const tasks = allTasks(); const byPath = new Map();
        for (const p of discoverProjects(cfg)) byPath.set(p, []);
        for (const t of tasks) { try { const real = resolveProject(cfg, t.repoPath); if (!byPath.has(real)) byPath.set(real, []); byPath.get(real).push(t); } catch { /* moved or outside */ } }
        return json(res, 200, { projects: [...byPath].map(([p, ts]) => ({ path: p, name: path.basename(p), taskCount: ts.length, lastTaskAt: ts[0]?.createdAt ?? null, recentOutcomes: ts.slice(0, 5).map((t) => ({ id: t.id, status: t.status })) })).sort((a, b) => (b.lastTaskAt || '').localeCompare(a.lastTaskAt || '') || a.name.localeCompare(b.name)) });
      }
      if (req.method === 'POST' && seg[0] === 'projects' && seg[1] === 'analyze') {
        const { path: p } = await readBody(req); const repo = resolveProject(cfg, p);
        const isRepo = await git.isRepo(repo); const st = isRepo ? await git.status(repo) : null;
        const a = await analyzeRepo(repo, cfg, { index: false });
        return json(res, 200, { path: repo, isGitRepo: isRepo, git: st, stack: a.stack, packageManager: a.packageManager, commands: a.commands, checks: a.checks.map((c) => ({ name: c.name, argv: c.argv })), envVarNames: a.envVarNames, hasTests: a.hasTests, fileCount: a.files.length, deployConfig: a.deployConfig, protectedBranches: cfg.protectedBranches });
      }
      if (req.method === 'POST' && seg[0] === 'projects' && seg[1] === 'tree') { const b = await readBody(req); return json(res, 200, listDir(cfg, b.path, b.dir)); }
      if (req.method === 'POST' && seg[0] === 'projects' && seg[1] === 'file') { const b = await readBody(req); return json(res, 200, readFilePreview(cfg, b.path, b.file)); }

      if (req.method === 'GET' && seg[0] === 'tasks' && !seg[1]) {
        const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 25)); const offset = Math.max(0, Number(q.get('offset')) || 0);
        const status = q.get('status'); const project = q.get('project'); const needle = (q.get('q') || '').toLowerCase().slice(0, 200);
        const items = allTasks().filter((t) => (!status || t.status === status) && (!project || t.repoPath === project) && (!needle || `${t.request} ${t.id} ${t.repoPath} ${t.branch ?? ''}`.toLowerCase().includes(needle)));
        return json(res, 200, { total: items.length, limit, offset, items: items.slice(offset, offset + limit).map(withLive) });
      }
      if (req.method === 'POST' && seg[0] === 'tasks' && !seg[1]) {
        const b = await readBody(req); const repo = resolveProject(cfg, b.repoPath);
        if (typeof b.request !== 'string' || b.request.trim().length < 5) return json(res, 400, { error: 'request must be at least 5 characters' });
        const type = ['feature', 'bugfix', 'refactor', 'tests'].includes(b.type) ? b.type : 'feature';
        const maxRepairs = b.maxRepairs == null ? cfg.limits.maxRepairs : Number(b.maxRepairs);
        if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 20) return json(res, 400, { error: 'maxRepairs must be an integer 0-20' });
        if (live.size >= maxConcurrent) return json(res, 429, { error: `the agent is at its concurrency limit (${live.size}/${maxConcurrent} running); wait for it to finish or cancel it` });
        const holder = store.lockHolder(repo); if (holder) { const t = store.loadTask(holder.taskId); if (t && ['running', 'paused'].includes(t.status) && live.has(t.id)) return json(res, 409, { error: `repository is busy with task ${holder.taskId}` }); }
        const task = store.createTask({ repoPath: repo, request: b.request.trim(), acceptance: String(b.acceptance || ''), type, maxRepairs });
        start(task.id); return json(res, 202, { id: task.id });
      }
      if (seg[0] === 'tasks' && seg[1]) {
        const id = seg[1]; const task = store.loadTask(id);
        if (!task) return json(res, 404, { error: 'unknown task' });
        const act = seg[2];
        if (req.method === 'GET' && !act) return json(res, 200, { ...task, ...withLive(task), report: store.readArtifact(id, 'report.md') });
        if (req.method === 'GET' && act === 'diff') return json(res, 200, { diff: store.readArtifact(id, 'changes.patch') ?? '' });
        if (req.method === 'GET' && act === 'artifact') { const name = q.get('name'); if (!Object.hasOwn(ARTIFACTS, name)) return json(res, 400, { error: `artifact must be one of ${Object.keys(ARTIFACTS).join(', ')}` }); const body = name === 'task.json' ? JSON.stringify(task, null, 2) : store.readArtifact(id, name); if (body == null) return json(res, 404, { error: 'artifact not generated yet' }); res.writeHead(200, { 'content-type': `${ARTIFACTS[name]}; charset=utf-8`, 'content-disposition': `attachment; filename="${id}-${name}"`, 'cache-control': 'no-store' }); return res.end(body); }
        if (req.method === 'GET' && act === 'events.json') { const from = Math.max(0, Number(q.get('from')) || 0); const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || 500)); const total = store.eventCount(id); return json(res, 200, { events: store.readEvents(id, from, limit), from, next: Math.min(total, from + limit), total }); }
        if (req.method === 'GET' && act === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const from = Number(req.headers['last-event-id']) >= 0 && req.headers['last-event-id'] !== undefined ? Number(req.headers['last-event-id']) + 1 : Math.max(0, Number(q.get('from')) || 0);
          for (const e of store.readEvents(id, from)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          if (!subscribers.has(id)) subscribers.set(id, new Set()); subscribers.get(id).add(res);
          const hb = setInterval(() => res.write(': hb\n\n'), 20_000); hb.unref?.();
          req.on('close', () => { clearInterval(hb); subscribers.get(id)?.delete(res); }); return;
        }
        if (req.method === 'POST' && act === 'cancel') { live.get(id)?.cancel(); return json(res, 200, { ok: true, wasRunning: live.has(id) }); }
        if (req.method === 'POST' && act === 'pause') { live.get(id)?.pause(); return json(res, 200, { ok: live.has(id) }); }
        if (req.method === 'POST' && act === 'continue') { live.get(id)?.resume(); return json(res, 200, { ok: live.has(id) }); }
        if (req.method === 'POST' && act === 'resume') { if (live.has(id)) return json(res, 409, { error: 'already running' }); if (!['interrupted', 'needs_input'].includes(task.status)) return json(res, 409, { error: `cannot resume a ${task.status} task` }); if (live.size >= maxConcurrent) return json(res, 429, { error: 'concurrency limit reached' }); start(id); return json(res, 202, { ok: true }); }
        if (req.method === 'POST' && act === 'approve') { if (task.status !== 'needs_approval') return json(res, 409, { error: `task is ${task.status}, not awaiting approval` }); const t = await makeOrch().approve(id); return json(res, 200, { status: t.status, commitSha: t.commitSha }); }
        if (req.method === 'POST' && act === 'promote') {
          const b = await readBody(req); const orch = makeOrch();
          const r = await promoteToProduction({ task, cfg, wt: task.worktree, approved: b.approved === true, exec: (argv, o) => orch.exec(task, new TaskControl(), argv, o) });
          task.deploy = { ...(task.deploy || {}), production: r.ok ? 'promoted' : `blocked: ${r.reason}` }; store.saveTask(task); return json(res, r.blocked ? 403 : 200, r);
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { json(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: String(e.message).slice(0, 300) }); }
  });
  server.on('close', () => monitor.stop());
  return { server, store, token, live, monitor, listen: () => new Promise((r) => server.listen(cfg.port, cfg.host, () => r(server.address()))) };
}
