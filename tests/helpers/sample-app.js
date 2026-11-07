import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
export const tmp = (p = 'devagent-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

export const GOOD_MATH = `export function sum(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n`;
export const BUGGY_MATH = GOOD_MATH.replace('return a + b;', 'return a - b; // BUG');
export const BASE_TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum, multiply } from '../src/math.js';\n\ntest('sum adds numbers', () => {\n  assert.equal(sum(2, 3), 5);\n});\n\ntest('multiply multiplies numbers', () => {\n  assert.equal(multiply(2, 3), 6);\n});\n`;

/** Creates a disposable git repo containing a small zero-dependency web-app-like project. */
export function createSampleApp({ buggy = false, extraFiles = {}, noTests = false, readme = '# Sample\nA tiny app.\n' } = {}) {
  const dir = tmp('sample-app-');
  const files = {
    'package.json': JSON.stringify({ name: 'sample', version: '1.0.0', type: 'module', scripts: { lint: 'node scripts/lint.js', ...(noTests ? {} : { test: 'node --test' }), build: 'node scripts/build.js' } }, null, 2),
    'src/math.js': buggy ? BUGGY_MATH : GOOD_MATH,
    'src/index.js': `import { sum } from './math.js';\nexport const hello = () => 'sum=' + sum(1, 2);\n`,
    ...(noTests ? {} : { 'test/math.test.js': BASE_TEST }),
    'scripts/lint.js': `import fs from 'node:fs';\nfor (const f of fs.readdirSync('src')) { if (/debugger/.test(fs.readFileSync('src/' + f, 'utf8'))) { console.error('lint error: debugger statement in src/' + f); process.exit(1); } }\nconsole.log('lint ok');\n`,
    'scripts/build.js': `import fs from 'node:fs';\nfs.rmSync('dist', { recursive: true, force: true });\nfs.cpSync('src', 'dist', { recursive: true });\nconsole.log('build ok');\n`,
    'README.md': readme,
    '.gitignore': 'node_modules/\ndist/\n',
    ...extraFiles,
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Test config: fast, loopback, scripted provider so no network/API key is needed. */
export function testConfig(dataDir, overrides = {}) {
  return {
    port: 0, host: '127.0.0.1', dataDir, allowedProjectDirs: [os.tmpdir()], protectedBranches: ['main', 'master', 'production'], branchPrefix: 'agent/',
    exclusions: ['node_modules', 'dist', '.git'],
    limits: { maxRepairs: 5, maxTaskMs: 120_000, maxCommandMs: 30_000, maxOutputBytes: 200_000, maxFileBytes: 200_000, maxContextChars: 60_000, maxImplementationAttempts: 3, ...(overrides.limits || {}) },
    models: { planning: 'main', implementation: 'main', debugging: 'main' },
    providers: { main: { type: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'scripted', apiKeyEnv: null, timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, pricing: { inPerMTok: 1, outPerMTok: 2 } } },
    budget: { maxUsdPerTask: null, maxTokensPerTask: 5_000_000, ...(overrides.budget || {}) },
    commands: { install: null, lint: null, typecheck: null, test: null, build: null, e2e: null },
    autoInstall: true, sandbox: { mode: 'none', ...(overrides.sandbox || {}) }, git: { autoCommit: true, createPullRequest: false },
    deploy: { previewCommand: null, previewUrlRegex: 'https?://[^\\s"\']+', healthPath: '/', smokePaths: [], healthRetries: 2, healthIntervalMs: 10, envPassthrough: [], extraExecutables: [], productionCommand: null, productionEnabled: false, renderDeployHookEnv: null, ...(overrides.deploy || {}) },
    logging: { retentionDays: 30 },
  };
}

/** A PATH containing only git and node (no docker), to prove behaviour when the Docker CLI is absent. */
export function pathWithoutDocker() {
  const bin = tmp('limitedbin-');
  for (const exe of ['git', 'node']) { const found = execFileSync('sh', ['-c', `command -v ${exe}`], { encoding: 'utf8' }).trim(); fs.symlinkSync(found, path.join(bin, exe)); }
  return bin;
}
export const stageOf = (req) => (/Current stage: (PLANNING|IMPLEMENTATION|DEBUGGING)/.exec(req.system) || [])[1];
export const J = (o) => '```json\n' + JSON.stringify(o) + '\n```';

/** Moves a repo into its own parent directory so tests that scan allowed dirs are not affected by other temp folders. */
export function inOwnParent(repo) { const parent = tmp('proj-'); const dest = path.join(parent, 'app'); fs.renameSync(repo, dest); return { repo: dest, parent }; }
