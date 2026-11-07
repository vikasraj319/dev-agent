import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { buildModels, scriptedAdapter } from '../../src/providers.js';
import { J, createSampleApp, inOwnParent, stageOf, testConfig, tmp } from '../helpers/sample-app.js';

const PLAN = J({ summary: 's', steps: ['x'], filesToChange: [], testsToAdd: [], assumptions: [], risks: [], blockingQuestion: null });
const EDIT = J({ explanation: 'x', edits: [{ op: 'write_file', path: 'src/a.js', content: 'export const a = 1;\n' }], commands: [] });
const open = new Set(); after(async () => { for (const s of open) await s.close().catch(() => {}); });
async function boot(cfgOver = {}, dirs) {
  const cfg = testConfig(tmp('data-'), cfgOver); if (dirs) cfg.allowedProjectDirs = dirs;
  const models = buildModels(cfg, { overrideAdapter: scriptedAdapter(async (req) => (stageOf(req) === 'PLANNING' ? PLAN : EDIT)) });
  const app = createServer({ cfg, models }); const addr = await app.listen();
  const raw = (p, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: addr.port, path: p, method, headers: { 'x-agent-token': app.token, 'content-type': 'application/json', ...headers } }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const text = Buffer.concat(ch).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); }); }); r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end(); });
  const handle = { app, cfg, call: raw, close: () => { open.delete(handle); for (const c of app.live.values()) c.cancel(); app.server.closeAllConnections?.(); return new Promise((r) => app.server.close(r)); } };
  open.add(handle); return handle;
}
const slowApp = (ms = 2500) => createSampleApp({ extraFiles: { 'scripts/slow.js': `setTimeout(() => process.exit(0), ${ms});\n`, 'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node scripts/slow.js' } }) } });
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 100)); } };

test('tokens in the URL are not accepted; header auth only', async () => {
  const s = await boot(); const bare = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.app.server.address().port, path: p }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.equal(await bare(`/api/health?token=${s.app.token}`), 401); assert.equal((await s.call('/api/health')).status, 200); await s.close();
});
test('health reports real configuration and never claims an unconfigured sandbox is secure', async () => {
  const s = await boot(); const h = (await s.call('/api/health')).json();
  assert.equal(h.status, 'ok'); assert.match(h.version, /^\d+\.\d+\.\d+/); assert.equal(h.sandbox.configured, 'none'); assert.equal(h.sandbox.isolated, false); assert.equal(h.sandbox.verified, false); assert.match(h.sandbox.detail, /No container isolation/);
  assert.ok(h.resources.cores >= 1); assert.ok(h.resources.current.memUsedPct > 0 && h.resources.current.memUsedPct <= 100); assert.match(h.resources.historyNote, /not persisted/); assert.deepEqual(h.concurrency, { running: 0, max: 1 });
  assert.ok(!JSON.stringify(h).match(/api[_-]?key|secret|token/i) || !JSON.stringify(h).includes(s.app.token), 'API token never exposed'); await s.close();
});
test('docker sandbox configured but unavailable is reported as unavailable (fail closed), not as secure', async () => {
  const { pathWithoutDocker } = await import('../helpers/sample-app.js'); const { resetPreflightCache } = await import('../../src/sandbox.js'); const old = process.env.PATH;
  process.env.PATH = pathWithoutDocker(); resetPreflightCache();
  try { const s = await boot({ sandbox: { mode: 'docker', required: true, image: 'node:22-bookworm', network: 'none', memory: '1g', cpus: '1' } }); const h = (await s.call('/api/health')).json(); assert.equal(h.sandbox.configured, 'docker'); assert.equal(h.sandbox.isolated, false); assert.match(h.sandbox.detail, /UNAVAILABLE.*fail closed/s);
    const sec = (await s.call('/api/security')).json(); assert.equal(sec.protections.find((p) => p.name === 'Docker sandbox').verified, false); await s.close(); } finally { process.env.PATH = old; resetPreflightCache(); }
});
test('task list: bounded pagination, status/project/text filters', async () => {
  const s = await boot(); const mk = (i, status, repo) => { const t = s.app.store.createTask({ repoPath: repo, request: `task number ${i} ${status}` }); t.status = status; s.app.store.saveTask(t); return t; };
  for (let i = 0; i < 7; i++) mk(i, i % 2 ? 'passed' : 'failed', i < 4 ? '/p/a' : '/p/b');
  const all = (await s.call('/api/tasks?limit=3')).json(); assert.equal(all.total, 7); assert.equal(all.items.length, 3); assert.equal((await s.call('/api/tasks?limit=3&offset=6')).json().items.length, 1);
  assert.equal((await s.call('/api/tasks?status=passed')).json().total, 3); assert.equal((await s.call('/api/tasks?project=/p/b')).json().total, 3); assert.equal((await s.call('/api/tasks?q=NUMBER%205')).json().total, 1);
  assert.equal((await s.call('/api/tasks?limit=100000')).json().limit, 100, 'limit is capped'); const it = all.items[0]; assert.ok(it.pipeline.steps.length >= 4 && 'tests' in it && 'costUsd' in it); await s.close();
});
test('artifact downloads are whitelisted; event pages are bounded and gap-free', async () => {
  const s = await boot(); const t = s.app.store.createTask({ repoPath: '/p', request: 'x task' }); for (let i = 0; i < 12; i++) s.app.store.appendEvent(t.id, { type: 'stage', stage: 'analysis' }); s.app.store.writeArtifact(t.id, 'report.md', '# hi');
  assert.equal((await s.call(`/api/tasks/${t.id}/artifact?name=../../etc/passwd`)).status, 400); assert.equal((await s.call(`/api/tasks/${t.id}/artifact?name=changes.patch`)).status, 404);
  const a = await s.call(`/api/tasks/${t.id}/artifact?name=report.md`); assert.equal(a.text, '# hi'); assert.match(a.headers['content-disposition'], /attachment/);
  const p1 = (await s.call(`/api/tasks/${t.id}/events.json?from=0&limit=5`)).json(); const p2 = (await s.call(`/api/tasks/${t.id}/events.json?from=${p1.next}&limit=100`)).json();
  assert.equal(p1.events.length, 5); assert.equal(p1.total, 12); assert.deepEqual([...p1.events, ...p2.events].map((e) => e.seq), [...Array(12).keys()]); await s.close();
});
test('file explorer API enforces the workspace boundary and hides secrets', async () => {
  const { repo, parent } = inOwnParent(createSampleApp({ extraFiles: { '.env': 'K=v12345678' } })); const s = await boot({}, [parent]); const post = (p, body) => s.call(p, { method: 'POST', body });
  assert.equal((await post('/api/projects/tree', { path: repo, dir: '.' })).json().items.some((i) => i.name === '.env'), false); assert.equal((await post('/api/projects/tree', { path: repo, dir: '../..' })).status, 403);
  assert.equal((await post('/api/projects/file', { path: repo, file: '.env' })).status, 403); assert.equal((await post('/api/projects/file', { path: '/etc', file: 'passwd' })).status, 403); assert.equal((await post('/api/projects/file', { path: repo, file: 'src/math.js' })).status, 200);
  const pl = (await s.call('/api/projects')).json().projects; assert.ok(pl.some((p) => p.path === fs.realpathSync(repo))); await s.close();
});
test('LIVE STATE: overview reflects the real running task and its current command; concurrency limit returns 429; SSE resumes without duplicates', async () => {
  const repoA = slowApp(); const repoB = createSampleApp(); const s = await boot({}, [path.dirname(repoA)]);
  const sub = await s.call('/api/tasks', { method: 'POST', body: { repoPath: repoA, request: 'slow task for live test', type: 'feature' } }); assert.equal(sub.status, 202); const id = sub.json().id;
  const op = await waitFor(async () => { const o = (await s.call('/api/overview')).json(); return o.running[0]?.currentOperation && o.running[0]; });
  assert.equal(op.id, id); assert.ok(op.currentOperation.argv.includes('test') || op.currentOperation.argv.includes('scripts/slow.js')); assert.ok(op.pipeline.percent < 100); assert.equal(op.running, true);
  const second = await s.call('/api/tasks', { method: 'POST', body: { repoPath: repoB, request: 'second task while busy', type: 'feature' } }); assert.equal(second.status, 429);
  // SSE with header auth: read a few events, disconnect, resume with Last-Event-ID
  const readSse = (headers, stopWhen) => new Promise((resolve) => { const got = []; const r = http.get({ host: '127.0.0.1', port: s.app.server.address().port, path: `/api/tasks/${id}/events`, headers: { 'x-agent-token': s.app.token, ...headers } }, (res) => { let buf = ''; res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /id: (\d+)\ndata: (.*)/s.exec(blk); if (m) got.push({ id: Number(m[1]), ev: JSON.parse(m[2]) }); if (stopWhen(got)) { r.destroy(); resolve(got); return; } } }); }); });
  const first = await readSse({}, (g) => g.length >= 3); assert.deepEqual(first.map((x) => x.id), [0, 1, 2]);
  const resumed = await readSse({ 'last-event-id': '2' }, (g) => g.some((x) => x.ev.type === 'status' && x.ev.status === 'passed')); assert.equal(resumed[0].id, 3, 'resume starts after the last seen id'); assert.deepEqual(resumed.map((x) => x.id), resumed.map((_, i) => i + 3), 'no gaps or duplicates');
  const done = await waitFor(async () => { const t = (await s.call(`/api/tasks/${id}`)).json(); return !t.running && t.status !== 'running' && t; }); assert.equal(done.status, 'passed', done.outcomeReason); assert.equal(done.pipeline.percent, 100);
  const m = (await s.call('/api/metrics?days=7')).json(); assert.equal(m.totals.passed, 1); assert.equal(m.successRate.decided, 1); assert.ok(m.tokens.total > 0); assert.ok(m.byRole.roles.some((r) => r.role === 'planning')); assert.ok(m.stageDurations.stages.length >= 3);
  assert.equal((await s.call(`/api/tasks/${id}/artifact?name=events.jsonl`)).status, 200);
  assert.equal((await s.call('/api/overview')).json().running.length, 0); await s.close();
});
test('approval endpoint refuses tasks that are not awaiting approval', async () => {
  const s = await boot(); const t = s.app.store.createTask({ repoPath: '/p', request: 'x task' }); assert.equal((await s.call(`/api/tasks/${t.id}/approve`, { method: 'POST', body: {} })).status, 409); await s.close();
});
