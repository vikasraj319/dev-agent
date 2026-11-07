import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './runner.js';
import { splitCommand } from './util.js';

const TEXT_EXT = /\.(m?[jt]sx?|json|py|md|css|scss|html|ya?ml|toml|prisma|sql|txt|sh|env\.example|cfg|ini)$/i;
const STOP = new Set('the a an and or to of in on for with from is are be this that it as at by add fix make new use using should when then into not can will has have was but if else return const let var function class import export default async await true false null undefined'.split(' '));

const tokenize = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).flatMap((w) => {
  const parts = w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[_\s]+/);
  return [w.toLowerCase(), ...parts];
}).filter((w) => w.length > 2 && !STOP.has(w));

async function listFiles(root, cfg) {
  const excl = new Set(cfg.exclusions);
  let files = null;
  try {
    const r = await runCommand(['git', 'ls-files', '-co', '--exclude-standard'], { cwd: root, cfg, timeoutMs: 30_000 });
    if (r.exitCode === 0) files = r.stdout.split('\n').filter(Boolean);
  } catch { /* not a git repo */ }
  if (!files) {
    files = [];
    (function walk(d, rel = '') {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (excl.has(e.name)) continue;
        const r = path.posix.join(rel, e.name);
        if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r);
      }
    })(root);
  }
  return files.filter((f) => !f.split('/').some((seg) => excl.has(seg)) && fs.existsSync(path.join(root, f)));
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export async function analyzeRepo(root, cfg, { index = true } = {}) {
  root = fs.realpathSync(root);
  const files = await listFiles(root, cfg);
  const has = (f) => files.includes(f);
  const pkg = has('package.json') ? readJson(path.join(root, 'package.json')) : null;
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const reqs = has('requirements.txt') ? fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8').toLowerCase() : '';
  const pyproject = has('pyproject.toml') ? fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8').toLowerCase() : '';
  const pyText = reqs + pyproject;
  const stack = new Set();
  const dep = (n) => n in deps;
  if (pkg) stack.add('node');
  if (dep('react')) stack.add('react'); if (dep('vite')) stack.add('vite'); if (dep('next')) stack.add('next');
  if (dep('express')) stack.add('express'); if (dep('typescript') || has('tsconfig.json')) stack.add('typescript');
  if (dep('prisma') || dep('@prisma/client') || has('prisma/schema.prisma')) stack.add('prisma');
  if (dep('@supabase/supabase-js') || files.some((f) => f.startsWith('supabase/'))) stack.add('supabase');
  if (dep('@playwright/test') || dep('playwright')) stack.add('playwright');
  if (files.some((f) => f.endsWith('.py'))) stack.add('python');
  if (/flask/.test(pyText)) stack.add('flask'); if (/django/.test(pyText)) stack.add('django'); if (/fastapi/.test(pyText)) stack.add('fastapi');
  if (has('vercel.json')) stack.add('vercel'); if (has('render.yaml')) stack.add('render');
  if (has('Dockerfile')) stack.add('docker'); if (files.some((f) => f.startsWith('.github/workflows/'))) stack.add('github-actions');

  const packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : pkg ? 'npm' : null;
  const scripts = pkg?.scripts || {};
  const runner = packageManager || 'npm';
  const runScript = (name) => (runner === 'yarn' ? ['yarn', name] : [runner, 'run', name]);
  const isPlaceholder = (s) => /no test specified/i.test(s || '');
  const detect = (c, fallback) => (cfg.commands[c] ? splitCommand(cfg.commands[c]) : fallback);

  const commands = {};
  if (pkg) {
    commands.install = detect('install', has('package-lock.json') ? ['npm', 'ci'] : packageManager === 'npm' ? ['npm', 'install'] : [packageManager, 'install']);
    commands.lint = detect('lint', scripts.lint ? runScript('lint') : null);
    commands.typecheck = detect('typecheck', scripts.typecheck ? runScript('typecheck') : scripts['type-check'] ? runScript('type-check') : stack.has('typescript') && dep('typescript') ? ['npx', '--no-install', 'tsc', '--noEmit'] : null);
    commands.test = detect('test', scripts.test && !isPlaceholder(scripts.test) ? (runner === 'yarn' ? ['yarn', 'test'] : [runner, 'test']) : null);
    commands.build = detect('build', scripts.build ? runScript('build') : null);
    commands.e2e = detect('e2e', scripts['test:e2e'] ? runScript('test:e2e') : scripts.e2e ? runScript('e2e') : null);
    if (commands.start === undefined) commands.start = scripts.dev ? runScript('dev') : scripts.start ? runScript('start') : null;
  }
  if (stack.has('python')) {
    const hasPytest = /pytest/.test(pyText) || files.some((f) => /(^|\/)(tests?\/|test_[^/]+\.py$)/.test(f));
    commands.test ||= detect('test', hasPytest ? ['python3', '-m', 'pytest', '-q'] : null);
    commands.lint ||= detect('lint', /ruff/.test(pyText) ? ['python3', '-m', 'ruff', 'check', '.'] : null);
  }
  for (const k of Object.keys(cfg.commands)) if (cfg.commands[k] && !commands[k]) commands[k] = splitCommand(cfg.commands[k]);

  const checks = [];
  for (const [name, category] of [['lint', 'static'], ['typecheck', 'static'], ['test', 'tests'], ['build', 'build'], ['e2e', 'e2e']]) {
    if (commands[name]) checks.push({ name, category, argv: commands[name], required: name !== 'e2e' });
  }

  const envNames = new Set();
  const textFiles = files.filter((f) => TEXT_EXT.test(f));
  const idx = { docs: new Map(), imports: new Map() };
  for (const f of textFiles) {
    let content; try { const st = fs.statSync(path.join(root, f)); if (st.size > cfg.limits.maxFileBytes) continue; content = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (/\.(m?[jt]sx?|py)$/.test(f)) {
      for (const m of content.matchAll(/process\.env\.([A-Z0-9_]+)|import\.meta\.env\.([A-Z0-9_]+)|os\.environ(?:\.get)?\[?\(?['"]([A-Z0-9_]+)['"]/g)) envNames.add(m[1] || m[2] || m[3]);
    }
    if (!index) continue;
    const tf = new Map();
    for (const t of tokenize(content)) tf.set(t, (tf.get(t) || 0) + 1);
    idx.docs.set(f, { tf, len: content.length, nameTokens: new Set(tokenize(f)) });
    if (/\.(m?[jt]sx?)$/.test(f)) {
      const deps2 = new Set();
      for (const m of content.matchAll(/(?:from\s+|import\s+|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
        for (const cand of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.mjs`, `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`]) if (files.includes(cand)) { deps2.add(cand); break; }
      }
      idx.imports.set(f, [...deps2]);
    }
  }
  let readme = ''; const rf = files.find((f) => /^readme(\.md)?$/i.test(f)); if (rf) readme = fs.readFileSync(path.join(root, rf), 'utf8').slice(0, 4000);
  return { root, files, stack: [...stack], packageManager, scripts, commands, checks, envVarNames: [...envNames].sort(), readme, index: idx, hasTests: files.some((f) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/.test(f)), deployConfig: { vercel: has('vercel.json'), render: has('render.yaml'), githubActions: stack.has('github-actions'), docker: has('Dockerfile') } };
}

/** TF-scored search over the code index; names matter more than body hits. */
export function searchIndex(analysis, query, limit = 8) {
  const qs = [...new Set(tokenize(query))];
  const scores = [];
  const N = analysis.index.docs.size || 1;
  const df = new Map();
  for (const { tf } of analysis.index.docs.values()) for (const t of qs) if (tf.has(t)) df.set(t, (df.get(t) || 0) + 1);
  for (const [f, d] of analysis.index.docs) {
    let s = 0;
    for (const t of qs) {
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      if (d.tf.has(t)) s += (1 + Math.log(d.tf.get(t))) * idf;
      if (d.nameTokens.has(t)) s += 3 * idf;
    }
    if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(f)) s *= 0.9;
    if (s > 0) scores.push({ file: f, score: s });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Files relevant to a request: search hits + one hop of local imports + their tests. */
export function relevantFiles(analysis, query, limit = 10) {
  const hits = searchIndex(analysis, query, limit);
  const out = new Map(hits.map((h) => [h.file, `search score ${h.score.toFixed(1)}`]));
  for (const h of hits.slice(0, 4)) for (const dep of analysis.index.imports.get(h.file) || []) if (!out.has(dep)) out.set(dep, `imported by ${h.file}`);
  for (const f of [...out.keys()]) {
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
    for (const cand of analysis.files) if (!out.has(cand) && /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(cand) && cand.includes(stem)) out.set(cand, `test for ${f}`);
  }
  return [...out].slice(0, limit + 6).map(([file, why]) => ({ file, why }));
}

/** Compact directory tree for prompts. */
export function treeSummary(analysis, max = 150) {
  const fs_ = analysis.files.filter((f) => !/\.(png|jpe?g|gif|svg|ico|woff2?|lock)$/i.test(f) && !/package-lock\.json$/.test(f));
  return fs_.slice(0, max).join('\n') + (fs_.length > max ? `\n…(${fs_.length - max} more files)` : '');
}
