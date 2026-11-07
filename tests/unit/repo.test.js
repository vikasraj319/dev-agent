import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRepo, relevantFiles, searchIndex } from '../../src/repo.js';
import { createSampleApp, git, testConfig, tmp } from '../helpers/sample-app.js';
import fs from 'node:fs';
import path from 'node:path';

test('detects stack, package manager, scripts and verification commands', async () => {
  const dir = createSampleApp(); const a = await analyzeRepo(dir, testConfig(tmp()));
  assert.ok(a.stack.includes('node')); assert.equal(a.packageManager, 'npm');
  assert.deepEqual(a.checks.map((c) => c.name), ['lint', 'test', 'build']);
  assert.deepEqual(a.commands.test, ['npm', 'test']); assert.ok(a.hasTests);
});
test('does not invent a test command when none exists and ignores the npm placeholder', async () => {
  const dir = createSampleApp({ noTests: true }); const a = await analyzeRepo(dir, testConfig(tmp()));
  assert.equal(a.commands.test, null); assert.ok(!a.checks.some((c) => c.name === 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal((await analyzeRepo(dir, testConfig(tmp()))).commands.test, null);
});
test('respects .gitignore and exclusions', async () => {
  const dir = createSampleApp({ extraFiles: { 'node_modules/x/index.js': 'x', 'dist/a.js': 'x' } });
  const a = await analyzeRepo(dir, testConfig(tmp())); assert.ok(!a.files.some((f) => f.startsWith('node_modules/') || f.startsWith('dist/')));
});
test('collects env var NAMES only, never values', async () => {
  const dir = createSampleApp({ extraFiles: { 'src/cfg.js': "export const k = process.env.STRIPE_KEY; const v = import.meta.env.VITE_API_URL;", '.env': 'STRIPE_KEY=sk-should-never-appear-1234567' } });
  const a = await analyzeRepo(dir, testConfig(tmp())); assert.deepEqual(a.envVarNames, ['STRIPE_KEY', 'VITE_API_URL']); assert.ok(!JSON.stringify(a).includes('should-never-appear'));
});
test('search ranks relevant files and follows imports and tests', async () => {
  const dir = createSampleApp(); const a = await analyzeRepo(dir, testConfig(tmp()));
  assert.equal(searchIndex(a, 'multiply numbers function')[0].file.includes('math'), true);
  const rel = relevantFiles(a, 'fix sum in index'); const names = rel.map((r) => r.file);
  assert.ok(names.includes('src/index.js') && names.includes('src/math.js') && names.includes('test/math.test.js'));
});
test('detects react/vite/express/python/prisma stacks and deploy configs', async () => {
  const dir = createSampleApp({ extraFiles: { 'package.json': JSON.stringify({ dependencies: { react: '1', express: '4' }, devDependencies: { vite: '5', typescript: '5', '@playwright/test': '1', prisma: '5' }, scripts: { build: 'vite build', 'test:e2e': 'playwright test' } }), 'vercel.json': '{}', 'app.py': 'import flask', 'requirements.txt': 'flask\npytest\n' } });
  git(dir, 'add', '-A'); const a = await analyzeRepo(dir, testConfig(tmp()));
  for (const s of ['react', 'vite', 'express', 'typescript', 'playwright', 'prisma', 'python', 'flask', 'vercel']) assert.ok(a.stack.includes(s), s);
  assert.deepEqual(a.commands.typecheck, ['npx', '--no-install', 'tsc', '--noEmit']); assert.deepEqual(a.commands.e2e, ['npm', 'run', 'test:e2e']);
  assert.ok(a.checks.find((c) => c.name === 'e2e').required === false);
});
