import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, durationMs, pipelineView, taskSummary } from '../../src/metrics.js';

const base = { repoPath: '/p/app', request: 'x', edits: [], commands: [], checkRuns: [], repairs: [], assumptions: [], blockers: [], repairCount: 0 };
const T = (o) => ({ ...base, id: o.id ?? Math.random().toString(36).slice(2), createdAt: '2026-10-10T10:00:00.000Z', ...o });
const usage = (i, o, usd, byRole) => ({ calls: 2, inputTokens: i, outputTokens: o, estimatedUsd: usd, byRole });

test('success rate excludes cancelled/active/awaiting tasks and flags low sample size', () => {
  const tasks = [T({ status: 'passed' }), T({ status: 'passed' }), T({ status: 'failed' }), T({ status: 'cancelled' }), T({ status: 'running' }), T({ status: 'needs_approval' })];
  const m = computeMetrics(tasks); assert.equal(m.successRate.decided, 3); assert.ok(Math.abs(m.successRate.value - 2 / 3) < 1e-9); assert.equal(m.successRate.lowConfidence, true);
  assert.equal(m.totals.active, 1); assert.equal(m.totals.cancelled, 1); assert.equal(m.totals.needsAttention, 1);
  assert.equal(computeMetrics([]).successRate.value, null, 'no data -> null, never 0%');
});
test('durations are medians/averages of real finished tasks only', () => {
  const mk = (s) => T({ status: 'passed', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: new Date(Date.parse('2026-10-10T10:00:00.000Z') + s * 1000).toISOString() });
  const m = computeMetrics([mk(10), mk(20), mk(90), T({ status: 'running', startedAt: '2026-10-10T10:00:00.000Z' })]); assert.equal(m.duration.medianMs, 20000); assert.equal(m.duration.avgMs, 40000); assert.equal(m.duration.samples, 3);
  assert.equal(computeMetrics([T({ status: 'passed' })]).duration.avgMs, null);
});
test('cost is never fabricated: unknown cost stays unknown and is counted separately', () => {
  const m = computeMetrics([T({ status: 'passed', usage: usage(1000, 500, 0.25) }), T({ status: 'passed', usage: usage(2000, 1000, null) }), T({ status: 'passed' })]);
  assert.equal(m.tokens.total, 4500); assert.equal(m.cost.totalUsd, 0.25); assert.equal(m.cost.tasksWithKnownCost, 1); assert.equal(m.cost.tasksWithUnknownCost, 1);
  const s = m.series[0]; assert.equal(s.costKnown, false, 'a day containing unknown-cost tasks is marked as having incomplete cost');
});
test('retries are not counted as separate tasks; test stats count check runs, labelled as such', () => {
  const runs = [{ category: 'tests', passed: false }, { category: 'tests', passed: false }, { category: 'tests', passed: true }, { category: 'build', passed: true }];
  const m = computeMetrics([T({ status: 'passed', repairCount: 2, checkRuns: runs })]); assert.equal(m.window.tasks, 1); assert.deepEqual([m.tests.runs, m.tests.passed, m.tests.failed], [3, 1, 2]); assert.match(m.tests.note, /not individual test cases/);
  assert.equal(m.repairs.avgPerTask, 2); assert.deepEqual(m.repairs.distribution, { 0: 0, 1: 0, 2: 1, '3+': 0 });
});
test('window and project filters apply; reliability counts come from recorded evidence', () => {
  const old = T({ status: 'failed', createdAt: '2026-01-01T00:00:00.000Z' }); const other = T({ status: 'passed', repoPath: '/p/other' });
  const stuck = T({ status: 'failed', fingerprints: { a: 3 }, checkRuns: [{ category: 'tests', passed: false, timedOut: true }] });
  const m = computeMetrics([old, other, stuck], { sinceMs: Date.parse('2026-10-01T00:00:00Z'), project: '/p/app' });
  assert.equal(m.window.tasks, 1); assert.equal(m.reliability.timedOutCheckRuns, 1); assert.equal(m.reliability.tasksWithRepeatedFailure, 1);
});
test('per-role usage is aggregated only from tasks that recorded it', () => {
  const r = { planning: { calls: 1, inputTokens: 10, outputTokens: 5, usd: 0.01 }, debugging: { calls: 2, inputTokens: 20, outputTokens: 7, usd: null } };
  const m = computeMetrics([T({ status: 'passed', usage: usage(30, 12, null, r) }), T({ status: 'passed', usage: usage(1, 1, 0.1) })]);
  const by = Object.fromEntries(m.byRole.roles.map((x) => [x.role, x])); assert.equal(by.planning.usd, 0.01); assert.equal(by.debugging.usd, null); assert.equal(by.debugging.calls, 2);
});
test('stage durations come from recorded stage events', () => {
  const t = T({ id: 'a1', status: 'passed', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:01:00.000Z' });
  const ev = [{ type: 'stage', stage: 'analysis', t: '2026-10-10T10:00:00.000Z' }, { type: 'stage', stage: 'planning', t: '2026-10-10T10:00:10.000Z' }, { type: 'stage', stage: 'testing', t: '2026-10-10T10:00:40.000Z' }];
  const m = computeMetrics([t], { readEvents: () => ev }); const by = Object.fromEntries(m.stageDurations.stages.map((s) => [s.stage, s.avgMs])); assert.deepEqual(by, { analysis: 10000, planning: 30000, testing: 20000 });
});
const states = (t) => Object.fromEntries(pipelineView(t).steps.map((s) => [s.key, s.state]));
test('pipeline: running implementation', () => {
  assert.deepEqual(states(T({ status: 'running', stage: 'implementation', progress: { baseline: true, planning: true } })), { analysis: 'completed', planning: 'completed', implementation: 'running', verification: 'pending', review: 'pending', completion: 'pending' });
});
test('pipeline: repair appears only when repairs happened; verification shows running during debugging', () => {
  const s = states(T({ status: 'running', stage: 'debugging', repairCount: 1, maxRepairs: 5, progress: { baseline: true, planning: true, implementation: true } })); assert.equal(s.verification, 'running'); assert.equal(s.repair, 'running');
  assert.equal(states(T({ status: 'running', stage: 'testing', progress: { baseline: true, planning: true, implementation: true } })).repair, undefined);
});
test('pipeline: exhausted repairs mark verification and repair failed, completion failed', () => {
  const s = states(T({ status: 'failed', stage: 'done', endedInStage: 'debugging', repairCount: 3, maxRepairs: 3, progress: { baseline: true, planning: true, implementation: true } })); assert.equal(s.verification, 'failed'); assert.equal(s.repair, 'failed'); assert.equal(s.completion, 'failed'); assert.equal(s.review, 'pending');
});
test('pipeline: approval gate is blocked until approved; unverified is a warning, not success', () => {
  const P = { baseline: true, planning: true, implementation: true, verification: 'passed' };
  const a = states(T({ status: 'needs_approval', stage: 'done', progress: P, approvalRequired: ['x'], filesChanged: [] })); assert.deepEqual([a.verification, a.review, a.approval, a.completion], ['completed', 'completed', 'blocked', 'pending']);
  assert.equal(states(T({ status: 'passed', stage: 'done', progress: P, filesChanged: [], approvalRequired: ['x'], approvedAt: 'z' })).approval, 'completed');
  assert.equal(states(T({ status: 'unverified', stage: 'done', progress: P, filesChanged: [] })).completion, 'warning');
  const p = pipelineView(T({ status: 'passed', stage: 'done', progress: P, filesChanged: [] })); assert.equal(p.percent, 100);
});
test('summaries expose verification honestly and duration of running tasks is live', () => {
  const s = taskSummary(T({ status: 'passed', finalVerification: { allPassed: true, results: [{ category: 'build', passed: true }] } })); assert.equal(s.tests.verified, false, 'no test check ran -> not verified');
  const r = T({ status: 'running', startedAt: new Date(Date.now() - 5000).toISOString() }); assert.ok(durationMs(r) >= 4000 && durationMs(r) < 15000);
});
