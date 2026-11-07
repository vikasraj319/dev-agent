import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, newId, nowIso, sha256 } from './util.js';

export const TASK_STATUSES = ['queued', 'running', 'paused', 'passed', 'failed', 'unverified', 'needs_approval', 'needs_input', 'cancelled', 'interrupted'];
/** Minimal schema check for persisted task state; protects against truncated/corrupted/tampered files. */
export function validateTask(t, id) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'not an object';
  if (t.id !== id) return 'id mismatch';
  if (!TASK_STATUSES.includes(t.status)) return `invalid status ${JSON.stringify(t.status)}`;
  if (typeof t.request !== 'string' || typeof t.repoPath !== 'string') return 'missing request/repoPath';
  for (const k of ['edits', 'commands', 'checkRuns', 'repairs', 'assumptions', 'blockers']) if (!Array.isArray(t[k])) return `${k} must be an array`;
  return null;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** File-backed persistent task records, event logs and per-repository locks. */
export class Store {
  constructor(dataDir, { maxEventsPerTask = 20000 } = {}) { this.maxEvents = maxEventsPerTask; this.seq = new Map(); this.dir = dataDir; fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true }); fs.mkdirSync(path.join(dataDir, 'locks'), { recursive: true }); }
  taskDir(id) { if (!/^[\w-]+$/.test(id)) throw new Error('bad task id'); return path.join(this.dir, 'tasks', id); }
  createTask(fields) {
    const id = newId();
    this.lastTs = Math.max(Date.now(), (this.lastTs ?? 0) + 1); // strictly increasing so "newest first" ordering is deterministic
    const created = new Date(this.lastTs).toISOString();
    const task = { id, status: 'queued', stage: 'queued', createdAt: created, updatedAt: created, repairCount: 0, edits: [], commands: [], checkRuns: [], repairs: [], assumptions: [], blockers: [], ...fields };
    this.saveTask(task); return task;
  }
  saveTask(task) {
    task.updatedAt = nowIso(); const f = path.join(this.taskDir(task.id), 'task.json');
    const bad = validateTask(task, task.id); if (bad) throw new Error(`refusing to persist invalid task state: ${bad}`);
    try { if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak`); } catch { /* best effort */ }
    atomicWrite(f, JSON.stringify(task, null, 2));
  }
  loadTask(id) {
    const f = path.join(this.taskDir(id), 'task.json');
    for (const [file, recovered] of [[f, false], [`${f}.bak`, true]]) {
      try { const t = JSON.parse(fs.readFileSync(file, 'utf8')); const bad = validateTask(t, id); if (!bad) { if (recovered) t.recoveredFromBackup = true; return t; } } catch { /* try next */ }
    }
    return null;
  }
  listTasks() {
    const root = path.join(this.dir, 'tasks');
    return fs.readdirSync(root).map((id) => this.loadTask(id)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  eventCount(id) {
    if (!this.seq.has(id)) { try { this.seq.set(id, fs.readFileSync(path.join(this.taskDir(id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length); } catch { this.seq.set(id, 0); } }
    return this.seq.get(id);
  }
  /** Appends an event with a monotonically increasing `seq` (lets clients dedupe/resume). Bounded: noisy output is dropped past the cap. */
  /** Summaries cached by file mtime+size so frequent dashboard polling does not re-parse every task. */
  listSummaries(summarize) {
    this.cache ??= new Map(); const root = path.join(this.dir, 'tasks'); const out = []; const seen = new Set();
    for (const id of fs.readdirSync(root)) {
      let st; try { st = fs.statSync(path.join(root, id, 'task.json')); } catch { continue; }
      seen.add(id); const c = this.cache.get(id);
      if (c && c.mtime === st.mtimeMs && c.size === st.size) { out.push(c.task); continue; }
      const t = this.loadTask(id); if (!t) continue; this.cache.set(id, { mtime: st.mtimeMs, size: st.size, task: t }); out.push(t);
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => (summarize ? summarize(t) : t));
  }
  appendEvent(id, ev) {
    const n = this.eventCount(id);
    if (n >= this.maxEvents && ev.type === 'output') { if (n === this.maxEvents) { this.seq.set(id, n + 1); return this.appendRaw(id, { t: nowIso(), seq: n, type: 'truncated', message: `event log cap (${this.maxEvents}) reached; further command output is not recorded` }); } return { t: nowIso(), seq: -1, ...ev, dropped: true }; }
    this.seq.set(id, n + 1);
    return this.appendRaw(id, { t: nowIso(), seq: n, ...ev });
  }
  appendRaw(id, e) { fs.mkdirSync(this.taskDir(id), { recursive: true }); fs.appendFileSync(path.join(this.taskDir(id), 'events.jsonl'), JSON.stringify(e) + '\n'); return e; }
  readEvents(id, from = 0, limit = Infinity) {
    try { return fs.readFileSync(path.join(this.taskDir(id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).slice(from, limit === Infinity ? undefined : from + limit).map((l) => JSON.parse(l)); } catch { return []; }
  }
  writeArtifact(id, name, content) { atomicWrite(path.join(this.taskDir(id), name), content); }
  readArtifact(id, name) { try { return fs.readFileSync(path.join(this.taskDir(id), name), 'utf8'); } catch { return null; } }

  /** Tasks left in a running state by a crashed process become `interrupted`; nothing is re-executed automatically. */
  recoverInterrupted(isLive = () => false) {
    const recovered = [];
    for (const t of this.listTasks()) {
      if (['running', 'paused'].includes(t.status) && !isLive(t.id)) {
        t.status = 'interrupted'; t.interruptedAtStage = t.stage; this.saveTask(t);
        this.appendEvent(t.id, { type: 'status', status: 'interrupted', message: `Process stopped while in stage "${t.stage}". Resume to continue; completed steps will not be repeated.` });
        this.releaseRepoLock(t.repoPath, t.id); recovered.push(t.id);
      }
    }
    return recovered;
  }

  lockFile(repo) { return path.join(this.dir, 'locks', sha256(path.resolve(repo)).slice(0, 16) + '.lock'); }
  acquireRepoLock(repo, taskId) {
    const f = this.lockFile(repo);
    for (let i = 0; i < 2; i++) {
      try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, taskId, repo }), { flag: 'wx' }); return true; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let cur; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { cur = null; }
        if (cur && cur.taskId === taskId && cur.pid === process.pid) return true;
        if (!cur || !alive(cur.pid)) { fs.rmSync(f, { force: true }); continue; } // stale lock from a dead process
        return false;
      }
    }
    return false;
  }
  lockHolder(repo) { try { return JSON.parse(fs.readFileSync(this.lockFile(repo), 'utf8')); } catch { return null; } }
  releaseRepoLock(repo, taskId) {
    const f = this.lockFile(repo);
    try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.taskId === taskId) fs.rmSync(f, { force: true }); } catch { /* none */ }
  }

  purgeOld(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86_400_000; let n = 0;
    for (const t of this.listTasks()) if (!['running', 'paused', 'queued'].includes(t.status) && Date.parse(t.updatedAt) < cutoff) { fs.rmSync(this.taskDir(t.id), { recursive: true, force: true }); n++; }
    return n;
  }
}
