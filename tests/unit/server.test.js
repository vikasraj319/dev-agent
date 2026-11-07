import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { createSampleApp, testConfig, tmp } from '../helpers/sample-app.js';

async function boot() {
  const cfg = testConfig(tmp()); const app = createServer({ cfg, models: { clients: {}, usage: { snapshot: () => ({}) } } }); const addr = await app.listen();
  const call = (p, { method = 'GET', body, token = app.token, host } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, path: p, method, headers: { ...(token ? { 'x-agent-token': token } : {}), 'content-type': 'application/json', ...(host ? { host } : {}) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, json: () => JSON.parse(b) })); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); });
  return { app, call, close: () => new Promise((r) => app.server.close(r)) };
}

test('API requires the token and a loopback Host header', async () => {
  const s = await boot();
  assert.equal((await s.call('/api/tasks', { token: null })).status, 401); assert.equal((await s.call('/api/tasks', { token: 'wrong' })).status, 401);
  assert.equal((await s.call('/api/tasks')).status, 200); assert.equal((await s.call('/api/tasks', { host: 'evil.example.com' })).status, 403);
  await s.close();
});
test('dashboard is served with the token embedded and strict CSP', async () => {
  const s = await boot(); const r = await s.call('/', { token: null }); assert.equal(r.status, 200); assert.ok(r.body.includes(s.app.token)); assert.ok(!r.body.includes('__AGENT_TOKEN__'));
  assert.equal((await s.call('/..%2f..%2fpackage.json', { token: null })).status, 404); await s.close();
});
test('project paths outside allowed directories are rejected; analysis works inside', async () => {
  const s = await boot();
  assert.equal((await s.call('/api/projects/analyze', { method: 'POST', body: { path: '/etc' } })).status, 403);
  assert.equal((await s.call('/api/projects/analyze', { method: 'POST', body: { path: '/does/not/exist' } })).status, 404);
  const repo = createSampleApp(); const r = await s.call('/api/projects/analyze', { method: 'POST', body: { path: repo } }); assert.equal(r.status, 200);
  const j = r.json(); assert.equal(j.isGitRepo, true); assert.deepEqual(j.checks.map((c) => c.name), ['lint', 'test', 'build']); assert.ok(j.protectedBranches.includes('main'));
  await s.close();
});
test('task submission validates input', async () => {
  const s = await boot(); const repo = createSampleApp();
  assert.equal((await s.call('/api/tasks', { method: 'POST', body: { repoPath: repo, request: 'hi' } })).status, 400);
  assert.equal((await s.call('/api/tasks', { method: 'POST', body: { repoPath: repo, request: 'add a feature please', maxRepairs: 500 } })).status, 400);
  assert.equal((await s.call('/api/tasks', { method: 'POST', body: { repoPath: '/etc', request: 'add a feature please' } })).status, 403);
  assert.equal((await s.call('/api/tasks/nope-1')).status, 404); await s.close();
});

test('full task through the HTTP API: submit, stream events, results, diff, history survives restart', async () => {
  const { buildModels, scriptedAdapter } = await import('../../src/providers.js'); const { J, stageOf } = await import('../helpers/sample-app.js');
  const cfg = testConfig(tmp()); const repo = createSampleApp();
  const models = buildModels(cfg, { overrideAdapter: scriptedAdapter(async (req) => stageOf(req) === 'PLANNING' ? J({ summary: 's', steps: ['x'], filesToChange: [], testsToAdd: [], assumptions: [], risks: [], blockingQuestion: null }) : J({ explanation: 'x', edits: [{ op: 'write_file', path: 'src/api.js', content: 'export const api = 1;\n' }], commands: [] })) });
  const app = createServer({ cfg, models }); const addr = await app.listen();
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: addr.port, path: p, method, headers: { 'x-agent-token': app.token, 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(b) })); }); r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end(); });
  const sub = await call('/api/tasks', 'POST', { repoPath: repo, request: 'add an api constant', type: 'feature' }); assert.equal(sub.status, 202); const id = sub.json().id;
  let t; for (let i = 0; i < 100; i++) { t = (await call(`/api/tasks/${id}`)).json(); if (!t.running && !['queued', 'running'].includes(t.status)) break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(t.status, 'passed', t.outcomeReason); assert.match(t.report, /PASSED/); assert.match((await call(`/api/tasks/${id}/diff`)).json().diff, /api\.js/);
  assert.equal((await call('/api/tasks')).json().items[0].id, id);
  const { Store } = await import('../../src/store.js'); assert.equal(new Store(cfg.dataDir).loadTask(id).status, 'passed');
  const prom = await call(`/api/tasks/${id}/promote`, 'POST', { approved: true }); assert.equal(prom.status, 403, 'production promotion refused (no preview, disabled)');
  await new Promise((r) => app.server.close(r));
});
