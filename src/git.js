import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './runner.js';
import { SecurityError } from './security.js';

const AGENT_IDENT = ['-c', 'user.name=DevAgent', '-c', 'user.email=devagent@localhost', '-c', 'commit.gpgsign=false'];

async function git(args, cwd, cfg, { allowFail = false, raw = false } = {}) {
  const r = await runCommand(['git', ...args], { cwd, cfg, timeoutMs: 120_000, rawOutput: raw });
  if (r.exitCode !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r;
}

export class GitManager {
  constructor(cfg) { this.cfg = cfg; }

  isProtected(branch) { return this.cfg.protectedBranches.includes(branch); }

  async isRepo(dir) { const r = await git(['rev-parse', '--is-inside-work-tree'], dir, this.cfg, { allowFail: true }); return r.exitCode === 0 && r.stdout.trim() === 'true'; }
  async toplevel(dir) { return (await git(['rev-parse', '--show-toplevel'], dir, this.cfg)).stdout.trim(); }

  async status(dir) {
    const branchR = await git(['symbolic-ref', '--short', '-q', 'HEAD'], dir, this.cfg, { allowFail: true });
    const head = (await git(['rev-parse', 'HEAD'], dir, this.cfg, { allowFail: true })).stdout.trim();
    const por = (await git(['status', '--porcelain=v1', '--untracked-files=normal'], dir, this.cfg)).stdout.split('\n').filter(Boolean);
    return { branch: branchR.exitCode === 0 ? branchR.stdout.trim() : null, head, dirty: por.length > 0, changes: por };
  }

  /** Creates an isolated worktree on a new branch from `baseRef`. The user's working tree is never touched. */
  async createWorktree(repo, branch, dir, baseRef = 'HEAD') {
    if (this.isProtected(branch)) throw new SecurityError(`Refusing to use protected branch name "${branch}"`);
    if (fs.existsSync(dir)) throw new Error(`Worktree directory already exists: ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['worktree', 'add', '-b', branch, dir, baseRef], repo, this.cfg);
    return dir;
  }
  async worktreeValid(dir, branch) {
    if (!fs.existsSync(dir)) return false;
    const s = await this.status(dir).catch(() => null);
    return Boolean(s && s.branch === branch);
  }
  async removeWorktree(repo, dir) { await git(['worktree', 'remove', '--force', dir], repo, this.cfg, { allowFail: true }); }

  async changedFiles(wt, baseSha) {
    await git(['add', '-A'], wt, this.cfg);
    const r = await git(['diff', '--cached', '--name-status', baseSha], wt, this.cfg);
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [status, ...rest] = l.split('\t'); return { status, path: rest.at(-1) }; });
  }
  async diff(wt, baseSha, { maxChars = 200_000 } = {}) {
    await git(['add', '-A'], wt, this.cfg);
    const r = await git(['diff', '--cached', '--no-color', baseSha], wt, this.cfg, { raw: true }); // raw: scanned for secrets by the caller; callers must redact before storing or sending to a model
    return r.stdout.length > maxChars ? r.stdout.slice(0, maxChars) + '\n…[diff truncated]' : r.stdout;
  }

  async commit(wt, message) {
    const s = await this.status(wt);
    if (!s.branch) throw new SecurityError('Refusing to commit on a detached HEAD');
    if (this.isProtected(s.branch)) throw new SecurityError(`Refusing to commit on protected branch "${s.branch}"`);
    await git(['add', '-A'], wt, this.cfg);
    const staged = await git(['diff', '--cached', '--quiet'], wt, this.cfg, { allowFail: true });
    if (staged.exitCode === 0) return null; // nothing to commit
    await git([...AGENT_IDENT, 'commit', '-q', '-m', message], wt, this.cfg);
    return (await git(['rev-parse', 'HEAD'], wt, this.cfg)).stdout.trim();
  }
  async head(wt) { return (await git(['rev-parse', 'HEAD'], wt, this.cfg)).stdout.trim(); }
}
