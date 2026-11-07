import { runCommand } from './runner.js';
import { shortHash, truncate } from './util.js';

const ERR_LINE = /(error|failed|failure|fail\b|✖|✗|AssertionError|Traceback|Exception|not ok|FAIL |Cannot find|SyntaxError|TypeError|ReferenceError|expected|ENOENT|ELIFECYCLE)/i;
const FILE_REF = /(?:\(|\s|^|")(?:file:\/\/)?((?:\.{0,2}\/)?[\w@.\-/]+\.(?:m?[jt]sx?|py|css|json|html)):(\d+)(?::(\d+))?/g;
const PY_REF = /File "([^"]+)", line (\d+)/g;

export function parseFailure(result, checkName) {
  const text = `${result.stdout}\n${result.stderr}`;
  const lines = text.split('\n');
  const errorLines = []; for (const l of lines) { if (ERR_LINE.test(l) && l.trim()) errorLines.push(l.trim().slice(0, 300)); if (errorLines.length >= 40) break; }
  const refs = new Map();
  for (const m of text.matchAll(FILE_REF)) { const f = m[1].replace(/^file:\/\//, ''); if (!/node_modules|node:internal/.test(f)) refs.set(f, Number(m[2])); }
  for (const m of text.matchAll(PY_REF)) if (!/site-packages|\/usr\/lib/.test(m[1])) refs.set(m[1], Number(m[2]));
  return { check: checkName, summary: errorLines.slice(0, 8).join('\n') || truncate(lines.filter(Boolean).slice(-8).join('\n'), 800), errorLines, files: [...refs].map(([file, line]) => ({ file, line })).slice(0, 12) };
}

/** Stable fingerprint of a failure that ignores line numbers, durations, temp paths and ids. */
export function fingerprint(checkName, parsed) {
  const norm = parsed.errorLines.slice(0, 10).map((l) => l.replace(/\d+(\.\d+)?(ms|s)?/g, '#').replace(/\/(?:tmp|var|home|private)[^\s:)]*/g, '<path>').replace(/\b[0-9a-f]{7,}\b/g, '<hex>')).join('|');
  return shortHash(`${checkName}:${norm}`);
}

/** Distinguish defects the code can fix from environment, dependency and external-service problems. */
export function classifyFailure(result, parsed) {
  const t = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) return 'timeout';
  if (result.spawnError || result.exitCode === 127 || /command not found|ENOENT.*spawn|is not recognized/i.test(t)) return 'environment';
  if (/Cannot find (package|module) '(?![./])[^']+'|ModuleNotFoundError: No module named|ERR_MODULE_NOT_FOUND.*node_modules|Could not resolve ".+" \(imported by|Missing script/i.test(t)) return 'dependency';
  if (/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET)\b|getaddrinfo|socket hang up|503 Service|502 Bad Gateway|rate limit/i.test(t)) return 'external-service';
  if (/EACCES|EPERM|permission denied|ENOSPC|out of memory|heap out of memory/i.test(t)) return 'environment';
  return /(AssertionError|not ok|expected|FAIL |assert)/i.test(t) && /test/i.test(parsed.check) ? 'test-or-code' : 'code';
}

export async function runCheck(check, { cwd, cfg, signal, onData, onCommand }) {
  const res = await runCommand(check.argv, { cwd, cfg, signal, onData, source: 'detected' }).catch((e) => { if (e.code === 'SANDBOX_UNAVAILABLE') throw e; return ({ argv: check.argv, exitCode: 126, stdout: '', stderr: String(e.message), timedOut: false, durationMs: 0, denied: e.code, spawnError: e.message }); });
  const passed = res.exitCode === 0 && !res.timedOut && !res.aborted;
  const parsed = passed ? null : parseFailure(res, check.name);
  const rec = { name: check.name, category: check.category, argv: check.argv, exitCode: res.exitCode, timedOut: Boolean(res.timedOut), aborted: Boolean(res.aborted), durationMs: res.durationMs, passed, denied: res.denied, stdoutTail: truncate(res.stdout.slice(-3000), 3000), stderrTail: truncate(res.stderr.slice(-3000), 3000) };
  if (parsed) { rec.failure = parsed; rec.fingerprint = fingerprint(check.name, parsed); rec.classification = classifyFailure(res, parsed); }
  onCommand?.(rec);
  return { rec, raw: res };
}

/** Runs checks in order, stopping at the first failing required check. */
export async function runChecks(checks, ctx) {
  const results = [];
  for (const c of checks) {
    if (ctx.signal?.aborted) break;
    ctx.onStart?.(c);
    const { rec } = await runCheck(c, ctx);
    results.push(rec);
    if (!rec.passed && c.required) return { results, failed: rec, allPassed: false };
    if (!rec.passed && !c.required) continue;
  }
  const optionalFailed = results.filter((r) => !r.passed);
  return { results, failed: null, allPassed: true, optionalFailed };
}
