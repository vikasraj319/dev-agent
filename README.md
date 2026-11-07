# DevAgent — autonomous software development agent for existing repositories

Give it a feature request or bug report and a local Git repository. It analyzes the repo, plans, edits code in an
**isolated Git worktree**, runs your project's own lint / type-check / tests / build, diagnoses failures from the real
command output, repairs them in a **bounded loop** (default 5), and only then commits to an agent branch and writes a
report. It never pushes, never touches your protected branches or uncommitted work, and never reports success it did not observe.

Zero runtime dependencies (Node ≥ 20.10, Git). Python/pytest support is detected when present.

## Quick start
```bash
cp .env.example .env            # fill in model + key (names/placeholders only are committed)
export $(grep -v '^#' .env | xargs)
npm run check-config            # validates configuration and explains problems
npm start                       # dashboard at http://127.0.0.1:4317 (loopback only)
```
Open the dashboard → enter a repo path (must be under `AGENT_ALLOWED_DIRS`) → **Analyze** → describe the task → **Start**.
Local models work: set `AGENT_LLM_BASE_URL=http://localhost:11434/v1`, `AGENT_LLM_MODEL=<name>` (no key needed).
Inference from cloud providers is **not free**; set `AGENT_MAX_USD_PER_TASK` (requires `pricing` in config) or a token budget.

## How a task runs
analysis (git status, worktree, stack/command detection, code index) → install deps → **baseline checks** → plan →
implement (edits are validated, atomic, path-confined) → checks in order lint, typecheck, test, build, (e2e) →
on failure: capture exit code/stdout/stderr, classify (code / test / dependency / environment / external-service / timeout),
fingerprint, repair, re-run the failed check, then the **whole** suite → review gates → commit on `agent/<slug>-<id>` →
optional preview deploy + health check. Outputs: `report.md`, `changes.patch`, `pr-description.md`, `events.jsonl`, `task.json` under `data/tasks/<id>/`.

Final status is evidence-based: `passed` (all detected checks exited 0 **and** at least one automated test ran),
`unverified` (checks passed but no tests exist — nothing is committed), `failed`, `needs_approval`, `needs_input`, `cancelled`, `interrupted`.

## Configuration
`devagent.config.json` (see `devagent.config.example.json`) + environment variables (`.env.example`). Everything in the
spec's list is configurable: allowed dirs, provider/model per role (planning/implementation/debugging), limits (repairs ≤ 20, task time,
command time, output size), commands, exclusions, sandbox, branch prefix, auto-commit, deploy settings, budgets, retention.
API keys are referenced by **env-var name**; values are never stored in config, task history, logs, or prompts.

## Safety model (and its limits — read this)
* Commands are argv arrays, **never a shell**; an allowlist blocks `rm`, `curl`, `sudo`, `git push/reset/clean/rebase`, `node -e`, etc.
  Dependency installs and `npx` downloads need explicit approval. Model-requested commands go through the same policy.
* Child processes get a scrubbed environment (no host secrets, private `HOME`), time/output limits, process-group kill.
* Edits cannot escape the worktree (traversal + symlink checks), cannot write `.env`, `.git`, keys, `node_modules`; edits that delete/skip tests
  or reduce assertions are rejected. Sensitive files (CI workflows, auth, migrations, Prisma schema, Docker/Vercel config) and
  detected security-weakening diffs → `needs_approval` before commit.
* Secrets are redacted from output, logs, history, reports, and model prompts; `.env`-type files are never sent to the model.
* Repo content/logs are wrapped as untrusted data in prompts. **This is a mitigation, not a guarantee** — a real LLM can still be
  manipulated; the hard guarantees come from the policy layer above, which does not depend on the model behaving.
* **Without Docker, project scripts (`npm test`, build) run with your user privileges.** Use `AGENT_SANDBOX_MODE=docker`
  (per-command container, no capabilities, mounted worktree only) or the provided Dockerfile for untrusted repositories.
  The Docker mode is implemented but could **not** be exercised in the build environment (no Docker available).
* The HTTP API binds to loopback, requires a per-process token, checks the Host header (DNS-rebinding), sends no CORS headers.

## Git behaviour
Works from the repo's last commit in a separate worktree, so your uncommitted changes are untouched (and not visible to the agent — reported).
Protected branches (`main`, `master`, `production`, … configurable) are never committed to. No push, force-push or history rewriting exists in the code path.

## Deployment
Optional and off by default. `deploy.previewCommand` (e.g. `vercel deploy --yes` with `"extraExecutables":["vercel"]`,
`envPassthrough:["VERCEL_TOKEN"]`) runs after verification; the URL is parsed from output and **really probed** (`healthPath`, `smokePaths`).
Failure → task `failed`, promotion blocked. Production requires all of: task passed, healthy preview, `productionEnabled`, per-task
approval (`POST /api/tasks/:id/promote {approved:true}`), and a configured `productionCommand` or Render deploy hook. See `docs/DEPLOYMENT.md`.

## Dashboard
`npm start`, open the printed URL. Pages: Overview, New Task, Tasks, task detail (live events, terminal, diff, tests, report), Projects (file explorer), Performance, Security, Settings. Built with plain JavaScript (no framework, no build step). See `docs/UPGRADE_REPORT.md`.

## Testing
`npm run lint && npm test && npm run test:e2e` — syntax lint, unit tests and acceptance scenarios. `npm run test:browser` (optional dev deps) drives the dashboard in headless Chromium. See `docs/ACCEPTANCE.md` and `docs/UPGRADE_REPORT.md` for what is and is not proven.

## Known limitations
* No built-in browser automation for *target* projects: their own `test:e2e`/`e2e` scripts are run as a (non-blocking-by-default) check. (The dashboard itself has real-browser tests.)
* Static security scanners (bandit, npm audit) are not run automatically; they can be set as `commands.lint`.
* GitHub PR creation is not implemented (a `pr-description.md` is produced; push and open the PR yourself). Vercel/Render rely on your CLI/hook, not bespoke API clients.
* Python dependency installation is not automated. Windows is untested (process-group kill and paths assume POSIX).
* Code retrieval is a keyword/import-graph index, not embeddings; very large monorepos may need `exclusions` tuning.
* Pause takes effect at the next checkpoint, not mid-command. Edits use whole-file / exact-match replace operations.
