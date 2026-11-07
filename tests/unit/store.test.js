import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../../src/store.js';
import { tmp } from '../helpers/sample-app.js';

test('tasks persist across Store instances and list newest first', () => {
  const dir = tmp(); const s = new Store(dir); const a = s.createTask({ repoPath: '/r', request: 'one' }); const b = s.createTask({ repoPath: '/r', request: 'two' });
  const s2 = new Store(dir); assert.equal(s2.loadTask(a.id).request, 'one'); assert.equal(s2.listTasks().length, 2); assert.equal(s2.listTasks()[0].id, b.id);
});
test('events append and replay from an offset', () => {
  const s = new Store(tmp()); const t = s.createTask({ repoPath: '/r', request: 'x' }); s.appendEvent(t.id, { type: 'a' }); s.appendEvent(t.id, { type: 'b' });
  assert.deepEqual(s.readEvents(t.id).map((e) => e.type), ['a', 'b']); assert.deepEqual(s.readEvents(t.id, 1).map((e) => e.type), ['b']);
});
test('task ids cannot traverse directories', () => { assert.throws(() => new Store(tmp()).taskDir('../../etc'), /bad task id/); });
test('only one task may hold a repository lock; stale locks from dead processes are reclaimed', () => {
  const s = new Store(tmp()); assert.ok(s.acquireRepoLock('/repo', 't1')); assert.ok(s.acquireRepoLock('/repo', 't1'));
  const holder = fs.fork ? null : null; assert.equal(s.lockHolder('/repo').taskId, 't1');
  // a different task in a different live process would be refused; simulate with a foreign task id on a live pid
  assert.equal(s.acquireRepoLock('/repo', 't2'), false);
  s.releaseRepoLock('/repo', 't1'); assert.ok(s.acquireRepoLock('/repo', 't2'));
  fs.writeFileSync(s.lockFile('/repo'), JSON.stringify({ pid: 2 ** 22 + 12345, taskId: 'dead', repo: '/repo' })); // not a live pid
  assert.ok(s.acquireRepoLock('/repo', 't3'));
});
test('running tasks found at startup become interrupted and release their lock', () => {
  const s = new Store(tmp()); const t = s.createTask({ repoPath: '/repo', request: 'x' }); t.status = 'running'; t.stage = 'testing'; s.saveTask(t); s.acquireRepoLock('/repo', t.id);
  assert.deepEqual(s.recoverInterrupted(), [t.id]); const r = s.loadTask(t.id); assert.equal(r.status, 'interrupted'); assert.equal(r.interruptedAtStage, 'testing'); assert.equal(s.lockHolder('/repo'), null);
});
test('retention purge removes only old finished tasks', () => {
  const s = new Store(tmp()); const old = s.createTask({ repoPath: '/r', request: 'old' }); old.status = 'passed'; s.saveTask(old);
  const f = JSON.parse(fs.readFileSync(`${s.taskDir(old.id)}/task.json`, 'utf8')); f.updatedAt = '2020-01-01T00:00:00.000Z'; fs.writeFileSync(`${s.taskDir(old.id)}/task.json`, JSON.stringify(f));
  const live = s.createTask({ repoPath: '/r', request: 'live' }); assert.equal(s.purgeOld(30), 1); assert.ok(s.loadTask(live.id)); assert.equal(s.loadTask(old.id), null);
});

test('corrupted task.json falls back to the last good backup and is flagged; unrecoverable state returns null', () => {
  const s = new Store(tmp()); const t = s.createTask({ repoPath: '/r', request: 'x' }); t.status = 'running'; s.saveTask(t); t.stage = 'testing'; s.saveTask(t);
  const f = `${s.taskDir(t.id)}/task.json`; fs.writeFileSync(f, '{"id": "truncated'); const r = s.loadTask(t.id); assert.ok(r && r.recoveredFromBackup === true);
  fs.writeFileSync(`${f}.bak`, 'garbage'); assert.equal(s.loadTask(t.id), null); assert.ok(!s.listTasks().some((x) => x.id === t.id));
});
test('schema validation rejects tampered state on load and invalid state on save', () => {
  const s = new Store(tmp()); const t = s.createTask({ repoPath: '/r', request: 'x' }); const f = `${s.taskDir(t.id)}/task.json`;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8')); raw.status = 'hacked'; fs.writeFileSync(f, JSON.stringify(raw)); assert.equal(s.loadTask(t.id), null);
  assert.throws(() => s.saveTask({ ...t, status: 'nonsense' }), /invalid task state/); assert.throws(() => s.saveTask({ ...t, edits: 'x' }), /invalid task state/);
});
test('events carry increasing seq numbers and the log is bounded without losing non-output events', () => {
  const s = new Store(tmp(), { maxEventsPerTask: 5 }); const t = s.createTask({ repoPath: '/r', request: 'x' });
  for (let i = 0; i < 10; i++) s.appendEvent(t.id, { type: 'output', chunk: String(i) }); s.appendEvent(t.id, { type: 'status', status: 'done' });
  const ev = s.readEvents(t.id); assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i));
  assert.equal(ev.filter((e) => e.type === 'output').length, 5); assert.equal(ev.filter((e) => e.type === 'truncated').length, 1); assert.equal(ev.at(-1).type, 'status');
  assert.equal(new Store(s.dir, { maxEventsPerTask: 5 }).eventCount(t.id), ev.length, 'seq survives restart');
});
