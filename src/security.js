import fs from 'node:fs';
import path from 'node:path';

// ---------- secret redaction ----------
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[=:]\s*["']?)[^\s"',;]{8,}/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
];
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Returns a function that masks known secret shapes and the literal values of secret-looking env vars. */
export function createRedactor(extraValues = [], env = process.env) {
  const literals = new Set(extraValues.filter((v) => typeof v === 'string' && v.length >= 8));
  for (const [k, v] of Object.entries(env)) if (SECRET_ENV_NAME.test(k) && typeof v === 'string' && v.length >= 8) literals.add(v);
  const lits = [...literals].sort((a, b) => b.length - a.length);
  return function redact(text) {
    let s = String(text ?? '');
    for (const l of lits) s = s.split(l).join('[REDACTED]');
    for (const re of SECRET_PATTERNS) {
      s = s.replace(re, (...a) => {
        const offsetIdx = a.findIndex((x, i) => i > 0 && typeof x === 'number'); // args: match, ...groups, offset, input
        const groups = a.slice(1, offsetIdx).filter((g) => typeof g === 'string');
        return groups.length ? `${groups[0]}[REDACTED]${groups[1] ?? ''}` : '[REDACTED]';
      });
    }
    return s;
  };
}

// ---------- path safety ----------
export class SecurityError extends Error {
  constructor(msg, code = 'SECURITY') { super(msg); this.code = code; }
}

/** Resolve `rel` inside `root`; reject absolute paths, traversal and symlink escapes. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new SecurityError(`Invalid path: ${JSON.stringify(rel)}`, 'PATH');
  if (path.isAbsolute(rel)) throw new SecurityError(`Absolute paths are not allowed: ${rel}`, 'PATH');
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(rootReal, rel);
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) throw new SecurityError(`Path escapes the project: ${rel}`, 'PATH');
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new SecurityError(`Symlink escapes the project: ${rel}`, 'PATH');
  return abs;
}

export function isInsideAny(dir, allowed) {
  let real; try { real = fs.realpathSync(dir); } catch { return false; }
  return allowed.some((a) => { let ar; try { ar = fs.realpathSync(a); } catch { return false; } return real === ar || real.startsWith(ar + path.sep); });
}

const posix = (p) => p.split(path.sep).join('/');
/** Files the agent must never write. */
export function isWriteProtected(rel) {
  const p = posix(path.normalize(rel));
  return /(^|\/)\.git(\/|$)/.test(p) || /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/.test(p) ||
    /(^|\/)node_modules(\/|$)/.test(p) || /(^|\/)devagent\.config\.json$/.test(p) ||
    /\.(pem|key|p12|pfx)$/.test(p) || /(^|\/)id_(rsa|ed25519)(\.pub)?$/.test(p);
}
/** Files whose modification requires human approval before commit. */
export function isSensitivePath(rel) {
  const p = posix(path.normalize(rel));
  return /^\.github\/workflows\//.test(p) || /(^|\/)(auth|authz|authentication|permissions?|middleware\/auth)[^/]*\.(js|ts|jsx|tsx|py)$/i.test(p) ||
    /(^|\/)migrations?\//.test(p) || /\.rules$/.test(p) || /(^|\/)(firestore|storage)\.rules$/.test(p) ||
    /(^|\/)(vercel\.json|render\.yaml|Dockerfile|docker-compose\.ya?ml)$/.test(p) || /(^|\/)prisma\/schema\.prisma$/.test(p) ||
    /(^|\/)supabase\/(migrations|policies)/.test(p);
}

// ---------- command policy ----------
const SAFE_EXES = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pip', 'pip3', 'pytest', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'ruff', 'mypy', 'bandit', 'git']);
const GIT_OK = new Set(['status', 'diff', 'add', 'commit', 'checkout', 'switch', 'branch', 'worktree', 'rev-parse', 'log', 'show', 'ls-files', 'rev-list', 'merge-base', 'symbolic-ref', 'cat-file', 'check-ignore', 'apply', 'restore']);
const NPM_OK = new Set(['ci', 'install', 'i', 'test', 't', 'run', 'run-script', 'ls', 'audit', 'rebuild']);
const PY_MODULES = new Set(['pytest', 'unittest', 'ruff', 'mypy', 'pip', 'compileall', 'bandit', 'black', 'flake8']);

function firstPositional(args) { return args.find((a) => !a.startsWith('-')); }

/**
 * Policy check for argv-style commands. No shell is ever used, so injection is structurally prevented;
 * this adds allowlisting and blocks destructive / privileged / exfiltrating operations.
 */
export function checkCommand(argv, { extraExecutables = [], approved = false } = {}) {
  const deny = (reason) => ({ allowed: false, needsApproval: false, reason });
  const ask = (reason) => (approved ? { allowed: true, needsApproval: false, reason: `approved: ${reason}` } : { allowed: false, needsApproval: true, reason });
  const ok = () => ({ allowed: true, needsApproval: false, reason: 'ok' });
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) return deny('command must be a non-empty argv array of strings');
  const exeRaw = argv[0];
  if (exeRaw.includes('/') || exeRaw.includes('\\')) return deny(`executables must be bare names, not paths: ${exeRaw}`);
  const exe = exeRaw.toLowerCase();
  const args = argv.slice(1);
  if (!SAFE_EXES.has(exe) && !extraExecutables.includes(exeRaw)) return deny(`executable "${exeRaw}" is not on the allowlist`);
  if (extraExecutables.includes(exeRaw)) return ok(); // explicit operator configuration (deploy commands)

  switch (exe) {
    case 'git': {
      const a = [...args];
      while (a[0] === '-c' || a[0] === '-C') a.splice(0, 2);
      const sub = a[0];
      if (!GIT_OK.has(sub)) return deny(`git ${sub ?? ''} is not permitted (push, reset, clean, rebase, config and others are blocked)`);
      const joined = a.join(' ');
      if (/(^|\s)(-f|--force|--force-with-lease|--hard)(\s|$)/.test(joined)) return deny('forced / hard git operations are blocked');
      if (sub === 'branch' && /(^|\s)(-D|-d|--delete|-m|-M)(\s|$)/.test(joined)) return deny('deleting or renaming branches is blocked');
      if (sub === 'checkout' && /(^|\s)(--|\.)(\s|$)/.test(joined) && /\./.test(a.at(-1))) return deny('discarding working-tree changes is blocked');
      if (sub === 'restore') return deny('git restore (discards work) is blocked');
      if (sub === 'worktree' && !['add', 'list', 'remove', 'prune'].includes(a[1])) return deny('unsupported git worktree operation');
      return ok();
    }
    case 'npm': case 'pnpm': case 'yarn': {
      const sub = firstPositional(args) ?? (exe === 'yarn' ? 'install' : undefined);
      if (!sub) return deny('missing subcommand');
      if (exe === 'npm' && !NPM_OK.has(sub)) return deny(`npm ${sub} is not permitted`);
      if (exe !== 'npm' && !['install', 'i', 'test', 'run', 'ls', 'audit'].includes(sub)) return (['add'].includes(sub) ? ask(`${exe} ${sub} adds dependencies`) : deny(`${exe} ${sub} is not permitted`));
      if (sub === 'run' || sub === 'run-script') {
        const script = args.slice(args.indexOf(sub) + 1).find((x) => !x.startsWith('-'));
        if (!script || !/^[\w:.-]+$/.test(script)) return deny('invalid npm script name');
      }
      if (['install', 'i'].includes(sub) && args.slice(args.indexOf(sub) + 1).some((x) => !x.startsWith('-'))) return ask('installing a named package adds a dependency');
      if (args.some((x) => /^--(registry|userconfig|globalconfig|prefix)(=|$)/.test(x))) return deny('overriding npm registry / config is blocked');
      return ok();
    }
    case 'npx': {
      if (!args.includes('--no-install') && !args.includes('--no')) return ask('npx may download and execute remote packages (use --no-install)');
      return ok();
    }
    case 'node': {
      if (args.some((x) => ['-e', '--eval', '-p', '--print', '-', '--input-type'].includes(x) || x.startsWith('--eval=') || x.startsWith('--print='))) return deny('inline code execution is blocked');
      return ok();
    }
    case 'python': case 'python3': {
      if (args.includes('-c')) return deny('inline code execution is blocked');
      const mi = args.indexOf('-m');
      if (mi >= 0) {
        const mod = args[mi + 1];
        if (!PY_MODULES.has(mod)) return deny(`python -m ${mod} is not permitted`);
        if (mod === 'pip' && args.slice(mi + 2).includes('install')) return ask('pip install adds dependencies');
      }
      return ok();
    }
    case 'pip': case 'pip3':
      return args.includes('install') ? ask('pip install adds dependencies') : ok();
    default: return ok();
  }
}

// ---------- test-weakening detection ----------
const isTestFile = (p) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.py$/.test(p);
const ASSERT_RE = /\b(assert\w*|expect|should)\b/g;
/** changes: [{path, before, after}] (before/after null when absent). Returns human-readable findings. */
export function findWeakening(changes) {
  const out = [];
  for (const { path: p, before, after } of changes) {
    if (!isTestFile(p)) {
      if (/(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?js|tsconfig[^/]*\.json)$/.test(p) && before != null && after != null) {
        if (/"strict"\s*:\s*true/.test(before) && !/"strict"\s*:\s*true/.test(after)) out.push(`${p}: disables TypeScript strict mode`);
      }
      continue;
    }
    if (before != null && after == null) { out.push(`${p}: test file deleted`); continue; }
    if (after == null) continue;
    const added = after.split('\n').filter((l) => !before?.includes(l));
    for (const l of added) {
      if (/\b(it|test|describe)\.(skip|todo)\b|\bx(it|describe|test)\(|@pytest\.mark\.(skip|xfail)|pytest\.skip\(|\bt\.skip\(|\.only\(/.test(l)) out.push(`${p}: skips/focuses tests -> ${l.trim().slice(0, 80)}`);
      if (/assert\.ok\(\s*true\s*\)|expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|assert\s+True\s*$/.test(l)) out.push(`${p}: tautological assertion -> ${l.trim().slice(0, 80)}`);
    }
    if (before != null) {
      const count = (s) => (s.match(ASSERT_RE) || []).length;
      if (count(after) < count(before)) out.push(`${p}: number of assertions decreased (${count(before)} -> ${count(after)})`);
    }
  }
  return out;
}

/** Heuristic scan for security-weakening changes in a unified diff. Returns findings requiring approval. */
export function findSecurityWeakening(diffText) {
  const out = [];
  const removed = []; const added = [];
  for (const l of String(diffText).split('\n')) { if (l.startsWith('-') && !l.startsWith('---')) removed.push(l.slice(1)); else if (l.startsWith('+') && !l.startsWith('+++')) added.push(l.slice(1)); }
  const authRe = /\b(authenticate|requireAuth|isAuthenticated|authorize|verifyToken|jwt\.verify|checkPermission|csrf|helmet|rateLimit)\b/i;
  const rm = removed.filter((l) => authRe.test(l)).length; const ad = added.filter((l) => authRe.test(l)).length;
  if (rm > ad) out.push(`auth/security-related lines removed (${rm} removed vs ${ad} added)`);
  if (added.some((l) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|cors\(\s*\{\s*origin\s*:\s*['"]\*['"]|ENABLE ROW LEVEL SECURITY.*DISABLE|DISABLE ROW LEVEL SECURITY|allow\s+(read|write)\s*:\s*if\s+true/i.test(l))) out.push('TLS/CORS/row-level-security protections appear to be disabled');
  return out;
}

const SECRET_KINDS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{16,}/], ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/], ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/], ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['credentials in URL', /[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:(?!\*+@)[^@\s/]{6,}@/i],
  ['hardcoded secret assignment', /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[=:]\s*["'][^"'\s]{16,}["']/i],
];
const PLACEHOLDER = /(replace[-_ ]?me|your[-_ ]|example|placeholder|changeme|xxxx|\*{4}|<[^>]+>|process\.env|\$\{)/i;
/** Scans only ADDED lines of a unified diff. Returns [{file,line,kind}] — never the secret value itself. */
export function findSecretsInDiff(diffText) {
  const out = []; let file = null; let line = 0;
  for (const l of String(diffText).split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l); if (h) { line = Number(h[1]) - 1; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      line++;
      if (/(^|\/)(\.env\.(example|sample|template))$/.test(file || '') || PLACEHOLDER.test(l)) continue;
      for (const [kind, re] of SECRET_KINDS) if (re.test(l)) { out.push({ file, line, kind }); break; }
    } else if (!l.startsWith('-')) line++;
  }
  return out;
}
