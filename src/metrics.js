// Pure functions that turn persisted task records into dashboard data. Nothing here invents numbers:
// every value is derived from task.json / events.jsonl, and unknowns are returned as null with an explanation.
import path from 'node:path';

export const STAGE_ORDER = ['analysis', 'planning', 'implementation', 'testing', 'debugging', 'build', 'browser', 'git', 'deployment'];
export const ACTIVE = ['queued', 'running', 'paused'];
export const ATTENTION = ['needs_approval', 'needs_input', 'interrupted'];
const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);

export const durationMs = (t, now = Date.now()) => (t.startedAt ? (t.finishedAt ? ms(t.startedAt, t.finishedAt) : ACTIVE.includes(t.status) ? now - Date.parse(t.startedAt) : null) : null);

/** Real test evidence: tasks' check runs in the "tests" category (counts runs, including baseline and repair re-runs). */
export function testStats(t) {
  const runs = (t.checkRuns || []).filter((r) => r.category === 'tests');
  const last = runs.at(-1);
  return { runs: runs.length, passedRuns: runs.filter((r) => r.passed).length, failedRuns: runs.filter((r) => !r.passed).length, lastPassed: last ? last.passed : null, verified: Boolean(t.finalVerification?.allPassed && t.finalVerification.results.some((r) => r.category === 'tests')) };
}

export function taskSummary(t, now = Date.now()) {
  const u = t.usage || {};
  return {
    id: t.id, status: t.status, stage: t.stage, request: t.request, type: t.type, repoPath: t.repoPath, project: path.basename(t.repoPath || ''), branch: t.branch ?? null,
    createdAt: t.createdAt, startedAt: t.startedAt ?? null, finishedAt: t.finishedAt ?? null, durationMs: durationMs(t, now), repairCount: t.repairCount || 0, maxRepairs: t.maxRepairs ?? null,
    tests: testStats(t), tokens: u.calls ? (u.inputTokens || 0) + (u.outputTokens || 0) : null, costUsd: u.estimatedUsd ?? null, commitSha: t.commitSha ?? null,
    needsAttention: ATTENTION.includes(t.status), outcome: t.outcomeReason ?? null,
  };
}

/** The real workflow, derived from the orchestrator's own progress flags. state: completed|running|pending|failed|blocked|warning|skipped */
export function pipelineView(t) {
  const P = t.progress || {}; const st = t.status; const stage = st && ['passed', 'failed', 'unverified', 'cancelled', 'needs_approval', 'needs_input'].includes(st) ? (t.endedInStage || t.stage) : t.stage;
  const failed = st === 'failed' || st === 'cancelled'; const running = ACTIVE.includes(st) && st !== 'queued';
  const steps = [];
  const mk = (key, label, done, runningNow, failedHere) => steps.push({ key, label, state: done ? 'completed' : failedHere ? 'failed' : runningNow ? 'running' : 'pending' });
  mk('analysis', 'Analysis', P.baseline, running && (stage === 'analysis' || (!P.baseline && ['testing', 'build', 'browser'].includes(stage))), failed && !P.baseline);
  mk('planning', 'Planning', P.planning, running && stage === 'planning', failed && P.baseline && !P.planning);
  mk('implementation', 'Implementation', P.implementation, running && stage === 'implementation', failed && P.planning && !P.implementation);
  const verifying = running && ['testing', 'build', 'browser', 'debugging'].includes(stage) && P.implementation;
  const verifiedOk = P.verification === 'passed';
  mk('verification', 'Verification', verifiedOk, verifying, failed && P.implementation && !verifiedOk);
  if (t.repairCount > 0) steps.push({ key: 'repair', label: `Repair (${t.repairCount}/${t.maxRepairs ?? '?'})`, state: verifiedOk ? 'completed' : (running && stage === 'debugging') ? 'running' : failed ? 'failed' : 'pending' });
  const reviewDone = verifiedOk && (['passed', 'unverified', 'needs_approval'].includes(st) || stage === 'deployment');
  mk('review', 'Review', reviewDone, running && stage === 'git', failed && verifiedOk && !reviewDone);
  if (t.approvalRequired?.length || st === 'needs_approval') steps.push({ key: 'approval', label: 'Approval', state: t.approvedAt ? 'completed' : st === 'needs_approval' ? 'blocked' : 'pending' });
  steps.push({ key: 'completion', label: 'Completion', state: st === 'passed' ? 'completed' : st === 'unverified' ? 'warning' : failed ? 'failed' : 'pending' });
  const completed = steps.filter((s) => s.state === 'completed').length;
  return { steps, completed, total: steps.length, percent: Math.round((completed / steps.length) * 100) };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const day = (iso) => iso.slice(0, 10);

/** stageDurations: per-stage time derived from consecutive `stage` events of recent finished tasks. */
export function stageDurations(tasks, readEvents, limit = 50) {
  const acc = {}; let sampled = 0;
  for (const t of tasks.filter((x) => x.finishedAt).slice(0, limit)) {
    const ev = readEvents(t.id).filter((e) => e.type === 'stage'); if (!ev.length) continue; sampled++;
    for (let i = 0; i < ev.length; i++) { const end = ev[i + 1]?.t ?? t.finishedAt; const d = Date.parse(end) - Date.parse(ev[i].t); if (d >= 0) (acc[ev[i].stage] ||= []).push(d); }
  }
  return { sampledTasks: sampled, stages: Object.entries(acc).map(([stage, a]) => ({ stage, avgMs: avg(a), medianMs: median(a), samples: a.length })).sort((x, y) => STAGE_ORDER.indexOf(x.stage) - STAGE_ORDER.indexOf(y.stage)) };
}

export function computeMetrics(tasks, { sinceMs = null, project = null, now = Date.now(), readEvents = () => [] } = {}) {
  let list = tasks.filter((t) => (!sinceMs || Date.parse(t.createdAt) >= sinceMs) && (!project || t.repoPath === project));
  const count = (s) => list.filter((t) => t.status === s).length;
  const passed = count('passed'), failed = count('failed'), unverified = count('unverified');
  const decided = passed + failed + unverified;
  const fin = list.filter((t) => t.finishedAt && t.startedAt && ['passed', 'failed', 'unverified'].includes(t.status)); const durs = fin.map((t) => ms(t.startedAt, t.finishedAt)).filter((d) => d != null && d >= 0);
  const tokens = list.reduce((a, t) => a + (t.usage?.calls ? (t.usage.inputTokens || 0) + (t.usage.outputTokens || 0) : 0), 0);
  const costKnown = list.filter((t) => t.usage?.estimatedUsd != null); const costUnknown = list.filter((t) => t.usage?.calls && t.usage.estimatedUsd == null).length;
  const tr = list.reduce((a, t) => { const s = testStats(t); a.runs += s.runs; a.passed += s.passedRuns; a.failed += s.failedRuns; return a; }, { runs: 0, passed: 0, failed: 0 });
  const dist = { 0: 0, 1: 0, 2: 0, '3+': 0 }; for (const t of list) dist[t.repairCount >= 3 ? '3+' : t.repairCount || 0]++;
  const byRole = {}; for (const t of list) for (const [r, v] of Object.entries(t.usage?.byRole || {})) { const b = (byRole[r] ||= { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, usdKnown: true }); b.calls += v.calls; b.inputTokens += v.inputTokens; b.outputTokens += v.outputTokens; if (v.usd == null) b.usdKnown = false; else b.usd += v.usd; }
  const series = {}; for (const t of list) { const d = day(t.createdAt); const s = (series[d] ||= { date: d, created: 0, passed: 0, failed: 0, unverified: 0, tokens: 0, costUsd: 0, costKnown: true }); s.created++; if (['passed', 'failed', 'unverified'].includes(t.status)) s[t.status]++; if (t.usage?.calls) { s.tokens += (t.usage.inputTokens || 0) + (t.usage.outputTokens || 0); if (t.usage.estimatedUsd == null) s.costKnown = false; else s.costUsd += t.usage.estimatedUsd; } }
  const stages = stageDurations(list, readEvents);
  return {
    window: { sinceMs, project, tasks: list.length },
    totals: { active: list.filter((t) => ACTIVE.includes(t.status)).length, passed, failed, unverified, cancelled: count('cancelled'), needsAttention: list.filter((t) => ATTENTION.includes(t.status)).length },
    successRate: { value: decided ? passed / decided : null, decided, lowConfidence: decided < 5, definition: 'passed ÷ (passed + failed + unverified); cancelled, interrupted, in-progress and awaiting-approval tasks are excluded' },
    duration: { avgMs: avg(durs), medianMs: median(durs), samples: durs.length },
    tests: { ...tr, note: 'counts verification check runs in the "tests" category (includes baseline and repair re-runs), not individual test cases' },
    tokens: { total: tokens }, cost: { totalUsd: Number(costKnown.reduce((a, t) => a + t.usage.estimatedUsd, 0).toFixed(6)), tasksWithKnownCost: costKnown.length, tasksWithUnknownCost: costUnknown },
    repairs: { avgPerTask: list.length ? Number((list.reduce((a, t) => a + (t.repairCount || 0), 0) / list.length).toFixed(2)) : null, distribution: dist },
    reliability: { timedOutCheckRuns: list.reduce((a, t) => a + (t.checkRuns || []).filter((r) => r.timedOut).length, 0), tasksWithRepeatedFailure: list.filter((t) => Object.values(t.fingerprints || {}).some((n) => n >= 3)).length },
    byRole: { roles: Object.entries(byRole).map(([role, v]) => ({ role, ...v, usd: v.usdKnown ? Number(v.usd.toFixed(6)) : null })), note: 'only tasks run after per-role accounting was added contribute' },
    stageDurations: stages, series: Object.values(series).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
