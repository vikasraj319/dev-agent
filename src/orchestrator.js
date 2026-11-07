import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, fileSha, readFileSafe } from './editor.js';
import { GitManager } from './git.js';
import { implementationPrompt, parseJsonResponse, planningPrompt, repairPrompt } from './prompts.js';
import { BudgetExceeded, ContextLimitError, ProviderError } from './providers.js';
import { analyzeRepo, relevantFiles, treeSummary } from './repo.js';
import { buildPrDescription, buildReport } from './report.js';
import { CommandDenied, runCommand, SandboxUnavailable } from './runner.js';
import { createRedactor, findSecretsInDiff, findSecurityWeakening, isSensitivePath, isWriteProtected, SecurityError } from './security.js';
import { runChecks } from './testing.js';
import { nowIso, sha256, shortHash, slug, truncate } from './util.js';
import { runPreviewDeploy } from './deploy.js';
import { preflight } from './sandbox.js';

export class Cancelled extends Error {}
export class Stop extends Error { constructor(reason, { status = 'failed', blockers = [], nextSteps = [] } = {}) { super(reason); this.status = status; this.blockers = blockers; this.nextSteps = nextSteps; } }

/** Per-run controls: cancel + pause gate. */
export class TaskControl {
  constructor() { this.controller = new AbortController(); this.signal = this.controller.signal; this.paused = false; this._gate = null; }
  cancel() { this.controller.abort(new Cancelled('cancelled by user')); this.resume(); }
  pause() { this.paused = true; }
  resume() { this.paused = false; this._gate?.(); this._gate = null; }
  async waitIfPaused(onPause) { if (!this.paused) return; onPause?.(); await new Promise((r) => { this._gate = r; }); }
}

const STAGE_FOR_CHECK = { lint: 'testing', typecheck: 'testing', test: 'testing', build: 'build', e2e: 'browser' };

export class Orchestrator {
  constructor({ cfg, store, models, emit = () => {} }) { this.cfg = cfg; this.store = store; this.models = models; this.emit = emit; this.git = new GitManager(cfg); this.redact = createRedactor(); }

  // ---------- infrastructure ----------
  log(task, type, data = {}) { const e = this.store.appendEvent(task.id, { type, stage: task.stage, ...data }); this.emit(task.id, e); return e; }
  save(task) { this.store.saveTask(task); }
  setStage(task, stage) { if (task.stage !== stage) { task.stage = stage; this.save(task); this.log(task, 'stage', { stage }); } }
  async checkpoint(task, ctl) {
    if (ctl.signal.aborted) throw ctl.signal.reason instanceof Cancelled ? ctl.signal.reason : new Stop(`Task time limit of ${Math.round(this.cfg.limits.maxTaskMs / 60000)} min reached`, { blockers: ['Maximum task duration exceeded'] });
    await ctl.waitIfPaused(() => { task.status = 'paused'; this.save(task); this.log(task, 'status', { status: 'paused' }); });
    if (task.status === 'paused') { task.status = 'running'; this.save(task); this.log(task, 'status', { status: 'running' }); }
  }

  /** Every subprocess goes through here: policy-checked, logged, recorded. */
  async exec(task, ctl, argv, { cwd, source = 'detected', approved = false, env, extraExecutables, redactExtra, network } = {}) {
    this.log(task, 'command_start', { argv, source, cwd });
    let res;
    try {
      res = await runCommand(argv, { cwd, cfg: this.cfg, signal: ctl.signal, approved, env, extraExecutables, redactExtra, network, hostExec: source === 'deploy', onData: (stream, chunk) => this.log(task, 'output', { stream, chunk: truncate(chunk, 2000) }) });
    } catch (e) {
      if (e instanceof SandboxUnavailable) throw new Stop(e.message, { blockers: [e.message], nextSteps: ['Install/start Docker and pull the sandbox image, or switch sandbox.mode deliberately. The agent will not run project code unsandboxed on its own.'] });
      if (e instanceof CommandDenied) { (task.deniedCommands ??= []).push({ argv, reason: e.policy.reason, needsApproval: e.policy.needsApproval, source }); this.log(task, 'command_denied', { argv, reason: e.policy.reason }); this.save(task); }
      throw e;
    }
    task.commands.push({ argv, source, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, at: nowIso() });
    if (task.commands.length > 400) task.commands.splice(0, task.commands.length - 400);
    this.log(task, 'command_end', { argv, exitCode: res.exitCode, durationMs: res.durationMs, timedOut: res.timedOut });
    return res;
  }

  async ask(task, ctl, role, build) {
    let maxChars = this.cfg.limits.maxContextChars; let parseErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.checkpoint(task, ctl);
      const prompt = build(maxChars, parseErr);
      let r;
      try { r = await this.models.clients[role].complete({ system: prompt.system, messages: prompt.messages, signal: ctl.signal }); }
      catch (e) {
        if (e instanceof ContextLimitError) { maxChars = Math.floor(maxChars / 2); this.log(task, 'context_shrink', { maxChars }); if (maxChars < 2000) throw new Stop('model context limit exceeded even with minimal context', { blockers: [e.message] }); continue; }
        if (e instanceof BudgetExceeded) throw new Stop(`budget limit: ${e.message}`, { blockers: [e.message], nextSteps: ['Raise the budget in configuration and resume the task.'] });
        if (e instanceof ProviderError) { if (e.kind === 'cancelled') throw new Cancelled(); throw new Stop(`model provider error: ${e.message}`, { status: 'failed', blockers: [`Model provider unavailable or rejected the request: ${e.message}`], nextSteps: ['Check provider configuration, credentials and availability, then resume the task.'] }); }
        throw e;
      } finally { task.usage = this.models.usage.snapshot(); this.save(task); }
      try { const j = parseJsonResponse(r.text); this.log(task, 'model_response', { role, chars: r.text.length }); return j; }
      catch (e) { parseErr = e.message; this.log(task, 'model_parse_error', { role, error: e.message }); if (attempt >= 1) throw new Stop('model did not return valid JSON after a retry', { blockers: ['Model output could not be parsed'] }); }
    }
    throw new Stop('model request failed');
  }

  /** Records pre-edit hashes before touching files so an interrupted apply can be resumed exactly once. */
  applyTracked(task, wt, edits, kind) {
    const paths = [...new Set(edits.map((e) => e?.path).filter((p) => typeof p === 'string'))];
    const before = {}; for (const p of paths) { try { before[p] = fileSha(wt, p); } catch { before[p] = null; } }
    task.pendingEdits = edits; task.pendingBefore = before; task.pendingKind = kind; this.save(task);
    const r = applyEdits(wt, edits, this.cfg);
    task.pendingEdits = null; task.pendingBefore = null; task.pendingKind = null; this.save(task);
    return r;
  }

  /** After a crash: apply only the edits whose target files still match their recorded pre-edit hash. */
  recoverPending(task, wt) {
    if (!task.pendingEdits) return;
    const todo = task.pendingEdits.filter((e) => { try { return fileSha(wt, e.path) === (task.pendingBefore?.[e.path] ?? null); } catch { return false; } });
    const skipped = task.pendingEdits.length - todo.length;
    const r = todo.length ? applyEdits(wt, todo, this.cfg) : { ok: true, changes: [], errors: [] };
    this.log(task, 'edits_recovered', { kind: task.pendingKind, applied: todo.length, alreadyApplied: skipped, ok: r.ok, errors: r.errors });
    if (r.ok) { task.edits.push({ attempt: `recovered-${task.pendingKind}`, changes: r.changes }); (task.appliedHashes ??= []).push(shortHash(JSON.stringify(task.pendingEdits))); if (task.pendingKind === 'implementation') task.progress.implementation = true; }
    task.pendingEdits = null; task.pendingBefore = null; task.pendingKind = null; this.save(task);
  }

  loadContext(wt, files, redact = this.redact) {
    const out = [];
    for (const f of files) {
      if (isWriteProtected(f.file)) continue; // never show secrets files to the model
      try { out.push({ ...f, content: redact(readFileSafe(wt, f.file, 30_000)) }); } catch { /* unreadable */ }
    }
    return out;
  }

  // ---------- public entry points ----------
  async execute(taskId, ctl = new TaskControl()) {
    const task = this.store.loadTask(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (!['queued', 'interrupted', 'needs_input'].includes(task.status)) throw new Error(`task ${taskId} is ${task.status}; cannot (re)start`);
    if (!this.store.acquireRepoLock(task.repoPath, task.id)) throw new Error(`another task is currently modifying ${task.repoPath} (${JSON.stringify(this.store.lockHolder(task.repoPath))})`);
    ctl.signal = AbortSignal.any([ctl.controller.signal, AbortSignal.timeout(this.cfg.limits.maxTaskMs)]);
    task.status = 'running'; task.maxRepairs = task.maxRepairs ?? this.cfg.limits.maxRepairs; task.progress ??= {}; task.startedAt ??= nowIso(); this.save(task);
    this.log(task, 'status', { status: 'running', resumed: Boolean(task.interruptedAtStage) });
    try { await this.pipeline(task, ctl); }
    catch (e) {
      const timedOut = ctl.signal.aborted && ctl.signal.reason?.name === 'TimeoutError';
      if (timedOut) { task.status = 'failed'; task.outcomeReason = `Task time limit of ${Math.round(this.cfg.limits.maxTaskMs / 60000)} min reached.`; task.blockers.push('Maximum task duration exceeded'); }
      else if (e instanceof Cancelled) { task.status = 'cancelled'; task.outcomeReason = 'Cancelled by user. Worktree and partial changes are preserved.'; }
      else if (e instanceof SandboxUnavailable) { task.status = 'failed'; task.outcomeReason = e.message; task.blockers.push(e.message); task.nextSteps = [...(task.nextSteps || []), 'Install/start Docker and pull the sandbox image (docker pull <image>), then resume. The agent never falls back to unsandboxed execution on its own.']; }
      else if (e instanceof Stop) { task.status = e.status; task.outcomeReason = e.message; task.blockers.push(...e.blockers); task.nextSteps = [...(task.nextSteps || []), ...e.nextSteps]; }
      else if (e instanceof SecurityError) { task.status = 'failed'; task.outcomeReason = `Security policy violation: ${e.message}`; task.blockers.push(e.message); }
      else { task.status = 'failed'; task.outcomeReason = `Internal agent error: ${this.redact(e.message)}`; task.blockers.push(this.redact(e.stack || e.message)); }
    } finally { await this.finalize(task); this.store.releaseRepoLock(task.repoPath, task.id); }
    return this.store.loadTask(task.id);
  }

  async finalize(task) {
    try {
      if (task.worktree && fs.existsSync(task.worktree) && task.baseSha) {
        task.filesChanged = await this.git.changedFiles(task.worktree, task.baseSha).catch(() => task.filesChanged || []);
        const diff = await this.git.diff(task.worktree, task.baseSha).catch(() => '');
        this.store.writeArtifact(task.id, 'changes.patch', this.redact(diff));
      }
      task.usage = this.models.usage.snapshot();
      task.finishedAt = nowIso(); if (task.stage !== 'done') task.endedInStage = task.stage; task.stage = ['passed', 'failed', 'unverified', 'cancelled', 'needs_approval', 'needs_input'].includes(task.status) ? 'done' : task.stage;
      const report = buildReport(task); this.store.writeArtifact(task.id, 'report.md', report); this.store.writeArtifact(task.id, 'pr-description.md', buildPrDescription(task));
    } catch (e) { task.blockers.push(`report generation problem: ${e.message}`); }
    this.save(task); this.log(task, 'status', { status: task.status, outcome: task.outcomeReason });
  }

  // ---------- pipeline ----------
  async pipeline(task, ctl) {
    const P = task.progress; const cfg = this.cfg; const repo = task.repoPath;
    // 1. analysis + isolation
    this.setStage(task, 'analysis'); await this.checkpoint(task, ctl);
    if (!(await this.git.isRepo(repo))) throw new Stop('The project is not a Git repository; refusing to modify it without version control.', { blockers: ['Not a Git repository'], nextSteps: ['Run `git init` and make an initial commit, then resubmit.'] });
    if (!P.worktree) {
      const st = await this.git.status(repo);
      if (!st.head) throw new Stop('Repository has no commits yet.', { blockers: ['No commits'], nextSteps: ['Create an initial commit.'] });
      task.repoStatus = { branch: st.branch, dirty: st.dirty, changes: st.changes.length, head: st.head };
      task.baseSha = st.head; task.baseBranch = st.branch;
      task.branch = `${cfg.branchPrefix}${slug(task.request)}-${task.id.slice(-6)}`;
      task.worktree = path.join(cfg.dataDir, 'worktrees', task.id);
      this.save(task);
      await this.git.createWorktree(repo, task.branch, task.worktree, st.head);
      P.worktree = true; this.save(task);
      this.log(task, 'git', { message: `Created isolated worktree on branch ${task.branch} from ${st.head.slice(0, 8)}${st.dirty ? ` (your ${st.changes.length} uncommitted change(s) are untouched and not visible to the agent)` : ''}` });
    } else if (!(await this.git.worktreeValid(task.worktree, task.branch))) throw new Stop('Recorded worktree is missing or on the wrong branch; refusing to continue on an unknown state.', { blockers: ['Worktree state mismatch'] });
    const wt = task.worktree;
    if (cfg.sandbox.mode === 'docker') { const pf = await preflight(cfg); if (!pf.ok) throw new SandboxUnavailable(pf.reason); this.log(task, 'sandbox', { message: `Docker sandbox verified (server ${pf.dockerVersion}, image ${pf.image})` }); }
    this.recoverPending(task, wt);
    let analysis = await analyzeRepo(wt, cfg);
    task.stack = analysis.stack; task.detectedCommands = analysis.commands; task.packageManager = analysis.packageManager; task.envVarNames = analysis.envVarNames; this.save(task);
    this.log(task, 'analysis', { stack: analysis.stack, files: analysis.files.length, checks: analysis.checks.map((c) => c.name) });

    // 2. dependency installation (policy-checked; may use the network)
    if (!P.install) {
      const pkgPath = path.join(wt, 'package.json');
      const hasDeps = fs.existsSync(pkgPath) && (() => { try { const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); return Object.keys({ ...p.dependencies, ...p.devDependencies }).length > 0; } catch { return false; } })();
      if (cfg.autoInstall && analysis.commands.install && hasDeps && !fs.existsSync(path.join(wt, 'node_modules'))) {
        this.setStage(task, 'testing');
        const r = await this.exec(task, ctl, analysis.commands.install, { cwd: wt, network: cfg.sandbox.allowNetworkForInstall ? 'bridge' : undefined });
        if (r.exitCode !== 0) throw new Stop(`Dependency installation failed: ${truncate(r.stderr || r.stdout, 300)}`, { blockers: [`install failed (${analysis.commands.install.join(' ')})`], nextSteps: ['Check network access / registry credentials / lockfile validity, then resume.'] });
      }
      P.install = true; this.save(task);
    }

    // 3. baseline verification (evidence of the starting state; for bug reports it captures the failure)
    if (!P.baseline) {
      if (analysis.checks.length) {
        const b = await runChecks(analysis.checks, this.checkCtx(task, ctl, wt, 'baseline'));
        task.baseline = { allPassed: b.allPassed, failedCheck: b.failed?.name ?? null, summary: b.failed?.failure?.summary ?? null };
        if (b.failed) task.baselineFailure = truncate(`${b.failed.name}: ${b.failed.failure?.summary}\n${b.failed.stderrTail}`, 3000);
      } else task.baseline = { allPassed: null, failedCheck: null, summary: 'no verification commands detected' };
      P.baseline = true; this.save(task); await this.checkpoint(task, ctl);
    }

    // 4. planning
    if (!P.planning) {
      this.setStage(task, 'planning');
      const files = this.loadContext(wt, relevantFiles(analysis, `${task.request} ${task.acceptance || ''}`));
      const plan = await this.ask(task, ctl, 'planning', (mc) => planningPrompt({ task, analysis, tree: treeSummary(analysis), files, maxChars: mc }));
      if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) throw new Stop('planning response was malformed', { blockers: ['Invalid plan from model'] });
      task.plan = { summary: String(plan.summary || ''), steps: plan.steps.map(String), filesToChange: (plan.filesToChange || []).map(String), testsToAdd: (plan.testsToAdd || []).map(String), risks: (plan.risks || []).map(String) };
      task.assumptions = (plan.assumptions || []).map(String);
      if (plan.blockingQuestion) { task.question = String(plan.blockingQuestion); throw new Stop(`Needs your input: ${task.question}`, { status: 'needs_input', nextSteps: ['Answer the question by re-submitting the task with the missing detail in the request.'] }); }
      P.planning = true; this.save(task); this.log(task, 'plan', { plan: task.plan });
    }

    // 5. implementation (idempotent, crash-safe)
    if (!P.implementation) this.setStage(task, 'implementation');
    if (!P.implementation) {
      const files = this.loadContext(wt, relevantFiles(analysis, `${task.request} ${(task.plan.filesToChange || []).join(' ')}`));
      let errors = [];
      for (let attempt = 1; attempt <= cfg.limits.maxImplementationAttempts; attempt++) {
        const out = await this.ask(task, ctl, 'implementation', (mc) => implementationPrompt({ task, plan: task.plan, analysis, files, maxChars: mc, previousErrors: errors }));
        const edits = Array.isArray(out.edits) ? out.edits : [];
        if (!edits.length) { errors = ['No edits were returned. Implement the request.']; continue; }
        const r = this.applyTracked(task, wt, edits, 'implementation');
        if (!r.ok) { errors = r.errors; this.log(task, 'edits_rejected', { errors }); continue; }
        task.edits.push({ attempt, hash: shortHash(JSON.stringify(edits)), explanation: out.explanation, changes: r.changes }); (task.appliedHashes ??= []).push(shortHash(JSON.stringify(edits)));
        this.log(task, 'edits_applied', { changes: r.changes });
        await this.runModelCommands(task, ctl, out.commands, wt);
        P.implementation = true; this.save(task); errors = []; break;
      }
      if (!P.implementation) throw new Stop('The model could not produce an applicable set of edits.', { blockers: errors.length ? errors : ['No usable edits'], nextSteps: ['Refine the request or acceptance criteria and retry.'] });
    }
    await this.checkpoint(task, ctl);
    analysis = await analyzeRepo(wt, cfg); // re-detect: the edits may have added tests/scripts
    task.detectedCommands = analysis.commands;

    // 6. verification + bounded repair loop
    if (P.verification !== 'passed') await this.verifyAndRepair(task, ctl, analysis, wt);

    // 7. review gates, git preparation
    await this.checkpoint(task, ctl);
    this.setStage(task, 'git');
    const files = await this.git.changedFiles(wt, task.baseSha); task.filesChanged = files;
    const diff = await this.git.diff(wt, task.baseSha);
    const approval = [...files.filter((f) => isSensitivePath(f.path)).map((f) => `sensitive file changed: ${f.path}`), ...findSecurityWeakening(diff).map((f) => `possible security weakening: ${f}`), ...findSecretsInDiff(diff).map((f) => `possible secret added: ${f.file}:${f.line} (${f.kind}) — value not shown`)];
    task.approvalRequired = approval;
    const hasTests = task.finalVerification.results.some((r) => r.category === 'tests');
    if (approval.length) { task.status = 'needs_approval'; task.outcomeReason = 'Verification passed but the change touches security-sensitive areas; approve explicitly to commit.'; return; }
    if (!hasTests) { task.status = 'unverified'; task.outcomeReason = `Checks that ran passed, but no automated tests exist/ran, so the change is NOT verified. Missing: ${task.finalVerification.missing.join(', ')}.`; task.nextSteps = [...(task.nextSteps || []), 'Add a test command (e.g. an npm "test" script) and rerun.']; return; }
    await this.commitIfEnabled(task, wt);
    task.status = 'passed'; task.outcomeReason = `All ${task.finalVerification.results.length} verification check(s) passed${task.repairCount ? ` after ${task.repairCount} repair attempt(s)` : ''}.`;

    // 8. optional preview deployment + smoke tests (never production)
    if (cfg.deploy.previewCommand && !P.deploy) {
      this.setStage(task, 'deployment'); await this.checkpoint(task, ctl);
      task.deploy = await runPreviewDeploy({ task, cfg, wt, exec: (argv, o) => this.exec(task, ctl, argv, o), log: (t, d) => this.log(task, t, d) });
      P.deploy = true; this.save(task);
      if (!task.deploy.health?.ok) { task.status = 'failed'; task.outcomeReason = `Checks passed, but the preview deployment failed verification: ${task.deploy.health?.detail}. Production promotion is blocked.`; task.blockers.push('Preview deployment health check failed'); }
    }
  }

  /** Hooks that stream every verification command (start, live output, end) as real events, then record the result. */
  checkCtx(task, ctl, wt, phase, stageFn) {
    return {
      cwd: wt, cfg: this.cfg, signal: ctl.signal,
      onStart: (c) => { this.setStage(task, stageFn ? stageFn(c) : STAGE_FOR_CHECK[c.name] || 'testing'); this.log(task, 'command_start', { argv: c.argv, source: 'detected', check: c.name, phase }); },
      onData: (stream, chunk) => this.log(task, 'output', { stream, chunk: truncate(chunk, 2000) }),
      onCommand: (rec) => { this.log(task, 'command_end', { argv: rec.argv, exitCode: rec.exitCode, durationMs: rec.durationMs, timedOut: rec.timedOut, check: rec.name }); this.recordCheck(task, rec, phase); },
    };
  }

  recordCheck(task, rec, phase) {
    const slim = { ...rec, phase, at: nowIso() }; delete slim.stdoutTail; delete slim.stderrTail;
    task.checkRuns.push(slim); if (task.checkRuns.length > 200) task.checkRuns.splice(0, 50);
    task.commands.push({ argv: rec.argv, source: 'detected', exitCode: rec.exitCode, timedOut: rec.timedOut, durationMs: rec.durationMs, at: nowIso() });
    this.log(task, 'check', { name: rec.name, passed: rec.passed, exitCode: rec.exitCode, phase, summary: rec.failure?.summary, classification: rec.classification });
    this.save(task);
  }

  async runModelCommands(task, ctl, commands, wt) {
    if (!Array.isArray(commands)) return;
    for (const argv of commands.slice(0, 5)) {
      try { await this.exec(task, ctl, argv, { cwd: wt, source: 'llm' }); }
      catch (e) { if (e instanceof CommandDenied) { if (e.policy.needsApproval) task.blockers.push(`Model requested "${argv.join(' ')}" which needs your approval: ${e.policy.reason}`); } else throw e; }
    }
  }

  async runAll(task, ctl, analysis, wt, phase) {
    const r = await runChecks(analysis.checks, this.checkCtx(task, ctl, wt, phase));
    await this.checkpoint(task, ctl);
    return r;
  }

  async verifyAndRepair(task, ctl, analysis, wt) {
    const max = task.maxRepairs; const seen = new Map(Object.entries(task.fingerprints || {}));
    let state = await this.runAll(task, ctl, analysis, wt, 'verify');
    while (!state.allPassed) {
      const f = state.failed; const fp = f.fingerprint; seen.set(fp, (seen.get(fp) || 0) + 1); task.fingerprints = Object.fromEntries(seen); this.save(task);
      const failFiles = { failedCheck: f.name, summary: f.failure?.summary };
      if (f.classification === 'external-service') throw new Stop(`Check "${f.name}" failed because an external service is unreachable; code changes cannot fix this.`, { blockers: [`${f.name}: external service/network problem — ${truncate(f.failure?.summary || '', 200)}`], nextSteps: ['Verify network access / service status, then resume the task.'] });
      if (f.classification === 'environment') throw new Stop(`Check "${f.name}" failed due to an environment problem (${truncate(f.failure?.summary || f.stderrTail, 200)}).`, { blockers: [`${f.name}: environment problem`], nextSteps: ['Fix the local environment (missing tool, permissions or resources) and resume.'] });
      if (task.repairCount >= max) throw new Stop(`Retry budget exhausted: ${task.repairCount}/${max} repair attempts used; "${f.name}" still fails.`, { blockers: [`${f.name} still failing: ${truncate(f.failure?.summary || '', 300)}`], nextSteps: ['Review the report and diff, fix manually or raise AGENT_MAX_REPAIRS and resume with more guidance.'] });
      if (seen.get(fp) >= 3) throw new Stop(`Stopped: the same failure (fingerprint ${fp}) persisted through ${seen.get(fp) - 1} different fix attempts — repeating would be ineffective.`, { blockers: [`${f.name} failure unchanged by fixes: ${truncate(f.failure?.summary || '', 300)}`], nextSteps: ['A human should inspect the root cause; the agent kept failing the same way.'] });
      task.repairCount++; this.setStage(task, 'debugging'); this.save(task);
      const rep = { n: task.repairCount, check: f.name, fingerprint: fp, classification: f.classification, editPaths: [], outcome: 'in progress' }; task.repairs.push(rep);
      this.log(task, 'repair_start', { n: rep.n, max, check: f.name, fingerprint: fp, classification: f.classification });
      const refs = [...(f.failure?.files || []).map((x) => ({ file: x.file.replace(/^\.\//, ''), why: `referenced in ${f.name} failure at line ${x.line}` })), ...relevantFiles(analysis, `${task.request} ${f.failure?.summary || ''}`, 6)];
      const seenF = new Set(); const ctxFiles = this.loadContext(wt, refs.filter((x) => !seenF.has(x.file) && seenF.add(x.file) && fs.existsSync(path.join(wt, x.file))));
      const diff = this.redact(await this.git.diff(wt, task.baseSha));
      const out = await this.ask(task, ctl, 'debugging', (mc) => repairPrompt({ task, failure: f, classification: f.classification, files: ctxFiles, maxChars: mc, history: task.repairs.slice(0, -1).map((r) => ({ n: r.n, diagnosis: r.diagnosis, editPaths: r.editPaths, outcome: r.outcome })), diff, attempt: rep.n, max }));
      rep.diagnosis = String(out.diagnosis || ''); rep.category = String(out.category || '');
      const edits = Array.isArray(out.edits) ? out.edits : [];
      rep.editPaths = [...new Set(edits.map((e) => e?.path).filter(Boolean))];
      if (!edits.length) {
        rep.outcome = 'model proposed no code change';
        if (['environment', 'dependency', 'external-service'].includes(rep.category) || f.classification === 'dependency') { await this.runModelCommands(task, ctl, out.commands, wt); this.save(task); throw new Stop(`Cannot fix by editing code (${rep.category || f.classification}): ${rep.diagnosis}`, { blockers: [`${f.name}: ${rep.diagnosis}`], nextSteps: ['Resolve the dependency/credential/environment issue described above, then resume.'] }); }
        state = { allPassed: false, failed: f }; this.save(task); continue;
      }
      const h = shortHash(JSON.stringify(edits));
      if ((task.appliedHashes || []).includes(h)) { rep.outcome = 'rejected: identical to a previously applied fix'; this.log(task, 'repair_duplicate', { n: rep.n }); state = { allPassed: false, failed: f }; this.save(task); continue; }
      const r = this.applyTracked(task, wt, edits, 'repair');
      if (!r.ok) { rep.outcome = `rejected: ${r.errors.join('; ')}`; this.log(task, 'edits_rejected', { errors: r.errors }); state = { allPassed: false, failed: f }; this.save(task); continue; }
      (task.appliedHashes ??= []).push(h); task.edits.push({ attempt: `repair-${rep.n}`, hash: h, explanation: out.diagnosis, changes: r.changes });
      this.log(task, 'edits_applied', { repair: rep.n, changes: r.changes });
      await this.runModelCommands(task, ctl, out.commands, wt);
      analysis = await analyzeRepo(wt, this.cfg);
      // re-run only the failed check first, then the complete relevant suite to catch regressions
      const target = analysis.checks.find((c) => c.name === f.name) ?? { name: f.name, category: f.category, argv: f.argv, required: true };
      const quick = await runChecks([target], this.checkCtx(task, ctl, wt, `repair-${rep.n}-targeted`, () => 'debugging'));
      await this.checkpoint(task, ctl);
      if (quick.allPassed) { rep.outcome = 'targeted check passed; running full regression'; this.save(task); state = await this.runAll(task, ctl, analysis, wt, `repair-${rep.n}-full`); rep.outcome = state.allPassed ? 'fixed; full suite passes' : `targeted check fixed, but "${state.failed.name}" now fails`; }
      else { rep.outcome = 'applied but check still failing'; state = { allPassed: false, failed: quick.failed }; }
      this.save(task);
    }
    const missing = ['lint', 'typecheck', 'test', 'build'].filter((n) => !analysis.checks.some((c) => c.name === n));
    task.finalVerification = { allPassed: true, results: state.results.map((r) => ({ name: r.name, category: r.category, argv: r.argv, exitCode: r.exitCode, passed: r.passed })), missing, at: nowIso() };
    task.progress.verification = 'passed'; this.save(task);
  }

  /** Human approval for security-sensitive changes: commits the verified work. */
  async approve(taskId) {
    const task = this.store.loadTask(taskId);
    if (!task || task.status !== 'needs_approval') throw new Error('task is not awaiting approval');
    if (!this.store.acquireRepoLock(task.repoPath, task.id)) throw new Error('repository is busy');
    try {
      await this.commitIfEnabled(task, task.worktree, true);
      task.status = 'passed'; task.outcomeReason = 'Approved by user and committed after passing verification.'; task.approvedAt = nowIso();
    } finally { await this.finalize(task); this.store.releaseRepoLock(task.repoPath, task.id); }
    return this.store.loadTask(taskId);
  }

  async commitIfEnabled(task, wt, force = false) {
    if (!this.cfg.git.autoCommit && !force) { this.log(task, 'git', { message: 'autoCommit disabled; changes left uncommitted in the worktree' }); return; }
    const head = await this.git.head(wt);
    if (head !== task.baseSha) { task.commitSha = head; return; } // already committed (e.g. before a crash)
    const msg = `${task.type === 'bugfix' ? 'fix' : 'feat'}: ${task.request.split('\n')[0].slice(0, 68)}\n\nAutomated by DevAgent task ${task.id}.\nVerified: ${task.finalVerification?.results.map((r) => `${r.name}=${r.passed ? 'pass' : 'fail'}`).join(', ')}`;
    task.commitSha = await this.git.commit(wt, msg); this.save(task);
    this.log(task, 'git', { message: `Committed ${task.commitSha?.slice(0, 8)} on ${task.branch}` });
  }
}
