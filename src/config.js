import fs from 'node:fs';
import path from 'node:path';
import { splitCommand } from './util.js';

export class ConfigError extends Error {
  constructor(problems) { super(`Invalid configuration:\n - ${problems.join('\n - ')}`); this.problems = problems; }
}

export const HARD_MAX_REPAIRS = 20;

export const DEFAULTS = Object.freeze({
  port: 4317,
  host: '127.0.0.1',
  dataDir: './data',
  allowedProjectDirs: [],
  protectedBranches: ['main', 'master', 'production', 'prod', 'release'],
  branchPrefix: 'agent/',
  exclusions: ['node_modules', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__', '.git'],
  limits: {
    maxRepairs: 5,
    maxTaskMs: 30 * 60_000,
    maxCommandMs: 5 * 60_000,
    maxOutputBytes: 400_000,
    maxFileBytes: 200_000,
    maxContextChars: 60_000,
    maxImplementationAttempts: 3,
    maxConcurrentTasks: 1,
    maxEventsPerTask: 20000,
  },
  // Each role names a provider below. Providers are generic: add as many as you like.
  models: { planning: 'main', implementation: 'main', debugging: 'main' },
  providers: {
    main: {
      type: 'openai-compatible',      // openai-compatible | anthropic
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      apiKeyEnv: 'AGENT_LLM_API_KEY', // NAME of the env var; the key itself is never stored in config
      timeoutMs: 120_000,
      maxRetries: 4,
      backoffBaseMs: 1000,
      contextWindowTokens: 128_000,
      pricing: null,                  // { inPerMTok: 0, outPerMTok: 0 } in USD; null = cost unknown
    },
  },
  budget: { maxUsdPerTask: null, maxTokensPerTask: 2_000_000 },
  commands: { install: null, lint: null, typecheck: null, test: null, build: null, e2e: null },
  autoInstall: true,
  // mode 'docker' runs every project command in a locked-down container (see src/sandbox.js). 'required' makes the agent refuse to run without it.
  sandbox: { mode: 'none', required: false, image: 'node:22-bookworm', network: 'none', memory: '2g', cpus: '1', pidsLimit: 256, allowNetworkForInstall: false },
  git: { autoCommit: true, createPullRequest: false },
  deploy: {
    previewCommand: null,
    previewUrlRegex: 'https?://[^\\s"\']+',
    healthPath: '/',
    smokePaths: [],
    healthRetries: 5,
    healthIntervalMs: 3000,
    envPassthrough: [],               // env var NAMES passed only to deploy commands, never to the model
    extraExecutables: [],             // e.g. ["vercel"]; applies to deploy commands only
    productionCommand: null,
    productionEnabled: false,         // production stays gated even when true: needs explicit per-task approval
    renderDeployHookEnv: null,
  },
  logging: { retentionDays: 30 },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base?.[k]) && isObj(v) ? merge(base[k], v) : v;
  return out;
}

function fromEnv(env) {
  const o = {};
  const set = (path, v) => { let t = o; const ps = path.split('.'); ps.slice(0, -1).forEach((p) => (t = t[p] ??= {})); t[ps.at(-1)] = v; };
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  if (env.AGENT_PORT) set('port', num(env.AGENT_PORT));
  if (env.AGENT_DATA_DIR) set('dataDir', env.AGENT_DATA_DIR);
  if (env.AGENT_ALLOWED_DIRS) set('allowedProjectDirs', env.AGENT_ALLOWED_DIRS.split(path.delimiter).filter(Boolean));
  if (env.AGENT_MAX_REPAIRS) set('limits.maxRepairs', num(env.AGENT_MAX_REPAIRS));
  if (env.AGENT_MAX_TASK_MINUTES) set('limits.maxTaskMs', num(env.AGENT_MAX_TASK_MINUTES) * 60_000);
  if (env.AGENT_MAX_COMMAND_SECONDS) set('limits.maxCommandMs', num(env.AGENT_MAX_COMMAND_SECONDS) * 1000);
  if (env.AGENT_LLM_TYPE) set('providers.main.type', env.AGENT_LLM_TYPE);
  if (env.AGENT_LLM_BASE_URL) set('providers.main.baseUrl', env.AGENT_LLM_BASE_URL);
  if (env.AGENT_LLM_MODEL) set('providers.main.model', env.AGENT_LLM_MODEL);
  if (env.AGENT_MAX_USD_PER_TASK) set('budget.maxUsdPerTask', num(env.AGENT_MAX_USD_PER_TASK));
  if (env.AGENT_SANDBOX_MODE) set('sandbox.mode', env.AGENT_SANDBOX_MODE);
  if (env.AGENT_REQUIRE_SANDBOX) set('sandbox.required', env.AGENT_REQUIRE_SANDBOX === 'true');
  if (env.AGENT_MAX_CONCURRENT_TASKS) set('limits.maxConcurrentTasks', num(env.AGENT_MAX_CONCURRENT_TASKS));
  if (env.AGENT_AUTO_COMMIT) set('git.autoCommit', env.AGENT_AUTO_COMMIT === 'true');
  if (env.AGENT_PRODUCTION_DEPLOY_ENABLED) set('deploy.productionEnabled', env.AGENT_PRODUCTION_DEPLOY_ENABLED === 'true');
  if (env.AGENT_PREVIEW_COMMAND) set('deploy.previewCommand', env.AGENT_PREVIEW_COMMAND);
  return o;
}

export function validateConfig(c, { requireProvider = false, env = process.env } = {}) {
  const p = [];
  const posInt = (v, name) => { if (!Number.isFinite(v) || v <= 0) p.push(`${name} must be a positive number (got ${v})`); };
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) p.push(`port must be 0-65535 (got ${c.port})`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(c.host)) p.push(`host must be a loopback address (got ${c.host}); this tool executes commands and must not be exposed`);
  if (!Number.isInteger(c.limits.maxRepairs) || c.limits.maxRepairs < 0 || c.limits.maxRepairs > HARD_MAX_REPAIRS) p.push(`limits.maxRepairs must be an integer 0-${HARD_MAX_REPAIRS} (got ${c.limits.maxRepairs})`);
  for (const k of ['maxTaskMs', 'maxCommandMs', 'maxOutputBytes', 'maxFileBytes', 'maxContextChars']) posInt(c.limits[k], `limits.${k}`);
  if (!Array.isArray(c.allowedProjectDirs)) p.push('allowedProjectDirs must be an array');
  if (!['none', 'docker'].includes(c.sandbox.mode)) p.push(`sandbox.mode must be "none" or "docker" (got ${c.sandbox.mode})`);
  if (!['none', 'bridge'].includes(c.sandbox.network)) p.push(`sandbox.network must be "none" or "bridge" (got ${c.sandbox.network})`);
  if (c.sandbox.required && c.sandbox.mode !== 'docker') p.push('sandbox.required is true but sandbox.mode is not "docker"; refusing to start without the required sandbox');
  if (!Number.isInteger(c.limits.maxConcurrentTasks) || c.limits.maxConcurrentTasks < 1 || c.limits.maxConcurrentTasks > 8) p.push(`limits.maxConcurrentTasks must be an integer 1-8 (got ${c.limits.maxConcurrentTasks})`);
  for (const role of ['planning', 'implementation', 'debugging']) {
    if (!c.providers[c.models[role]]) p.push(`models.${role} refers to unknown provider "${c.models[role]}"`);
  }
  for (const [name, pr] of Object.entries(c.providers)) {
    if (!['openai-compatible', 'anthropic'].includes(pr.type)) p.push(`providers.${name}.type must be openai-compatible or anthropic`);
    if (requireProvider) {
      if (!pr.model) p.push(`providers.${name}.model is not set (AGENT_LLM_MODEL)`);
      if (!pr.baseUrl) p.push(`providers.${name}.baseUrl is not set`);
      const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(pr.baseUrl || '');
      if (!local && pr.apiKeyEnv && !env[pr.apiKeyEnv]) p.push(`environment variable ${pr.apiKeyEnv} (API key for provider "${name}") is not set`);
    }
  }
  for (const [k, v] of Object.entries(c.commands)) {
    if (v) { try { splitCommand(v); } catch (e) { p.push(`commands.${k}: ${e.message}`); } }
  }
  if (c.deploy.productionEnabled && !c.deploy.productionCommand && !c.deploy.renderDeployHookEnv) p.push('deploy.productionEnabled is true but no productionCommand / renderDeployHookEnv is configured');
  if (p.length) throw new ConfigError(p);
  return c;
}

export function loadConfig({ file, env = process.env, overrides = {}, requireProvider = false } = {}) {
  let fileCfg = {};
  const f = file ?? (fs.existsSync('devagent.config.json') ? 'devagent.config.json' : null);
  if (f) {
    try { fileCfg = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { throw new ConfigError([`cannot read config file ${f}: ${e.message}`]); }
  }
  let cfg = merge(merge(merge(DEFAULTS, fileCfg), fromEnv(env)), overrides);
  cfg = JSON.parse(JSON.stringify(cfg));
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.allowedProjectDirs = cfg.allowedProjectDirs.map((d) => path.resolve(d));
  return validateConfig(cfg, { requireProvider, env });
}

/** Config safe to show in the UI / logs (no secret values exist in config, but keep it explicit). */
export function publicConfig(c) {
  return { ...c, providers: Object.fromEntries(Object.entries(c.providers).map(([k, v]) => [k, { ...v, apiKeyEnv: v.apiKeyEnv, apiKeyConfigured: Boolean(process.env[v.apiKeyEnv]) }])) };
}
