import fs from 'node:fs';
import path from 'node:path';
import { createRedactor, isInsideAny, isWriteProtected, resolveInside, SecurityError } from './security.js';

const HIDE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__', '.DS_Store']);
const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', md: 'markdown', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sh: 'shell', sql: 'sql', prisma: 'prisma', toml: 'toml' };

/** Git repositories one level below each allowed directory (bounded), so the UI can offer a project list. */
export function discoverProjects(cfg, limit = 200) {
  const out = [];
  for (const base of cfg.allowedProjectDirs) {
    let entries = []; try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    if (fs.existsSync(path.join(base, '.git'))) out.push(fs.realpathSync(base));
    for (const e of entries) { if (out.length >= limit) break; if (e.isDirectory() && !HIDE.has(e.name) && !e.name.startsWith('.') && fs.existsSync(path.join(base, e.name, '.git'))) out.push(fs.realpathSync(path.join(base, e.name))); }
  }
  return [...new Set(out)];
}

/** Every filesystem access is re-validated on the backend: allowed dir, project root, traversal and symlink checks. */
export function resolveProject(cfg, projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) throw Object.assign(new Error('project path required'), { code: 400 });
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('project does not exist'), { code: 404 });
  const real = fs.realpathSync(abs);
  if (!isInsideAny(real, cfg.allowedProjectDirs)) throw Object.assign(new Error('project is outside the allowed project directories'), { code: 403 });
  return real;
}
const wrap = (fn) => { try { return fn(); } catch (e) { if (e instanceof SecurityError) throw Object.assign(new Error(e.message), { code: 403 }); throw e; } };

export function listDir(cfg, projectPath, dir = '.', max = 500) {
  const root = resolveProject(cfg, projectPath);
  const abs = wrap(() => resolveInside(root, dir || '.'));
  if (!fs.statSync(abs).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 400 });
  const items = []; let truncated = false;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (HIDE.has(e.name) || e.isSymbolicLink()) continue; // symlinks are never followed or listed
    const rel = path.relative(root, path.join(abs, e.name)).split(path.sep).join('/');
    if (isWriteProtected(rel) && !e.isDirectory()) continue; // secrets (.env, keys) are not even listed
    if (items.length >= max) { truncated = true; break; }
    items.push({ name: e.name, path: rel, type: e.isDirectory() ? 'dir' : 'file' });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { root, dir: path.relative(root, abs).split(path.sep).join('/') || '.', items, truncated };
}

export function readFilePreview(cfg, projectPath, file, maxBytes = 200_000) {
  const root = resolveProject(cfg, projectPath);
  if (typeof file !== 'string' || !file) throw Object.assign(new Error('file required'), { code: 400 });
  const abs = wrap(() => resolveInside(root, file));
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (isWriteProtected(rel) || rel.split('/').some((s) => HIDE.has(s))) throw Object.assign(new Error('this file is not available for preview'), { code: 403 });
  const lst = fs.lstatSync(abs); if (lst.isSymbolicLink() || !lst.isFile()) throw Object.assign(new Error('not a regular file'), { code: 400 });
  const buf = fs.readFileSync(abs); if (buf.subarray(0, 4096).includes(0)) throw Object.assign(new Error('binary file; preview unavailable'), { code: 415 });
  const truncated = buf.length > maxBytes; const text = buf.subarray(0, maxBytes).toString('utf8');
  return { file: rel, size: buf.length, truncated, language: LANG[path.extname(rel).slice(1).toLowerCase()] || 'text', content: createRedactor()(text) };
}
