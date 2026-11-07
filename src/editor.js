import fs from 'node:fs';
import path from 'node:path';
import { findWeakening, isSensitivePath, isWriteProtected, resolveInside, SecurityError } from './security.js';
import { sha256 } from './util.js';

const read = (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);

/**
 * Applies a set of edits atomically (all validated in memory first). A replace whose `old` text is gone but whose
 * `new` text is present is treated as already applied; exact crash-recovery is done by the orchestrator via fileSha().
 * edit = {op:'write_file',path,content} | {op:'replace',path,old,new} | {op:'delete_file',path}
 */
export function applyEdits(root, edits, cfg, { allowWeakening = false } = {}) {
  const errors = []; const pending = new Map(); const notes = [];
  if (!Array.isArray(edits)) return { ok: false, errors: ['edits must be an array'], changes: [] };
  const original = new Map();
  const get = (rel, abs) => (pending.has(rel) ? pending.get(rel) : read(abs));
  for (const [i, e] of edits.entries()) {
    const tag = `edit[${i}] ${e?.op} ${e?.path}`;
    try {
      if (!e || typeof e !== 'object') throw new Error('not an object');
      const abs = resolveInside(root, e.path);
      const rel = path.relative(fs.realpathSync(root), abs).split(path.sep).join('/');
      if (isWriteProtected(rel)) throw new SecurityError(`writing ${rel} is not permitted`, 'PROTECTED');
      if (!original.has(rel)) original.set(rel, read(abs));
      const cur = get(rel, abs);
      if (e.op === 'write_file') {
        if (typeof e.content !== 'string') throw new Error('content must be a string');
        if (Buffer.byteLength(e.content) > cfg.limits.maxFileBytes) throw new Error(`file exceeds maxFileBytes (${cfg.limits.maxFileBytes})`);
        pending.set(rel, e.content);
      } else if (e.op === 'replace') {
        if (typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old) throw new Error('replace needs non-empty string "old" and string "new"');
        if (cur == null) throw new Error('file does not exist');
        const n = cur.split(e.old).length - 1;
        if (n === 0 && cur.includes(e.new)) { notes.push(`${tag}: already applied`); continue; }
        if (n !== 1) throw new Error(n === 0 ? '"old" text not found' : `"old" text matches ${n} places; include more context`);
        pending.set(rel, cur.replace(e.old, () => e.new));
      } else if (e.op === 'delete_file') {
        if (cur == null) { notes.push(`${tag}: already absent`); continue; }
        pending.set(rel, null);
      } else throw new Error(`unknown op "${e.op}"`);
    } catch (err) { errors.push(`${tag}: ${err.message}`); }
  }
  const changes = [...pending].map(([p, after]) => ({ path: p, before: original.get(p) ?? null, after })).filter((c) => c.before !== c.after);
  if (errors.length) return { ok: false, errors, changes: [], notes };
  const weak = allowWeakening ? [] : findWeakening(changes);
  if (weak.length) return { ok: false, errors: weak.map((w) => `rejected: would weaken verification — ${w}`), changes: [], notes, weakening: weak };
  for (const c of changes) {
    const abs = resolveInside(root, c.path);
    if (c.after == null) fs.rmSync(abs, { force: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c.after); }
  }
  return {
    ok: true, errors: [], notes,
    changes: changes.map((c) => ({ path: c.path, op: c.after == null ? 'delete' : c.before == null ? 'create' : 'modify', afterSha: c.after == null ? null : sha256(c.after).slice(0, 12), sensitive: isSensitivePath(c.path) })),
  };
}

/** Hash of a file's current content (null if absent); used to make crash-recovery exact. */
export function fileSha(root, rel) {
  const c = read(resolveInside(root, rel));
  return c == null ? null : sha256(c);
}

export function readFileSafe(root, rel, maxBytes) {
  const abs = resolveInside(root, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const buf = fs.readFileSync(abs);
  return buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') + '\n…[file truncated]' : buf.toString('utf8');
}
