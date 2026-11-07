// Dependency-free lint: syntax-check every JS file with `node --check`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const skip = new Set(['node_modules', 'data', '.git']);
let failed = 0, count = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(e.name)) {
      count++;
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) { failed++; console.error(`SYNTAX ERROR in ${path.relative(root, p)}\n${r.stderr}`); }
    }
  }
})(root);
console.log(`checked ${count} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
