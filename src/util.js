import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const shortHash = (s) => sha256(s).slice(0, 12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
export const slug = (s, max = 32) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'task';

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Quote-aware command splitter that refuses shell operators. Never invokes a shell. */
export function splitCommand(str) {
  if (Array.isArray(str)) return str.map(String);
  const out = []; let cur = ''; let q = null; let has = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    if ('|&;<>`'.includes(c) || (c === '$' && str[i + 1] === '(')) {
      throw new Error(`Shell operator "${c}" is not allowed in configured commands: ${str}`);
    }
    cur += c; has = true;
  }
  if (q) throw new Error(`Unterminated quote in command: ${str}`);
  if (has || cur) out.push(cur);
  return out;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}
