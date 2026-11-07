# DevAgent — Complete Setup & Implementation Instructions

DevAgent takes a feature request or bug report plus a local Git repository, edits the code in an isolated Git worktree,
runs your project's own lint/type-check/tests/build, repairs failures in a bounded loop, then commits to an `agent/*` branch
and writes a report. It never pushes and never touches your protected branches or uncommitted work.

---------------------------------------------------------------------
## 1. Requirements
* Node.js 20.10 or newer (`node -v`)
* Git 2.30+ (`git --version`)
* Linux or macOS (Windows is untested; WSL2 works)
* An LLM endpoint: any OpenAI-compatible API (OpenAI, OpenRouter, Together, Ollama, LM Studio, vLLM...) or Anthropic
* Optional: Python 3 + pytest (for Python projects), Docker (for sandboxing), Playwright in the target project (for its own E2E script)

No `npm install` is needed for DevAgent itself (zero runtime dependencies).

---------------------------------------------------------------------
## 2. Install
```bash
unzip devagent.zip
cd devagent
node -v            # must be >= 20.10
npm run test:all   # optional sanity check: 68 unit + 17 acceptance tests should pass
```
`test:all` needs Git identity available globally only if you use your own commits; the tests set their own identity.

---------------------------------------------------------------------
## 3. Configure
### 3.1 Environment file
```bash
cp .env.example .env
```
Edit `.env`. Minimum for a cloud provider:
```
AGENT_LLM_TYPE=openai-compatible
AGENT_LLM_BASE_URL=https://api.openai.com/v1
AGENT_LLM_MODEL=<your model name>
AGENT_LLM_API_KEY=<your key>
AGENT_ALLOWED_DIRS=/absolute/path/to/your/projects
```
Anthropic: `AGENT_LLM_TYPE=anthropic`, `AGENT_LLM_BASE_URL=https://api.anthropic.com`, `AGENT_LLM_MODEL=<model>`.
Local model (Ollama): `AGENT_LLM_BASE_URL=http://localhost:11434/v1`, `AGENT_LLM_MODEL=<name>`; no key required.

`AGENT_ALLOWED_DIRS` is mandatory: the agent refuses any repository outside these directories (separate several with `:`).

Load the file into your shell (DevAgent reads real environment variables, not `.env` directly):
```bash
set -a; source .env; set +a
```
### 3.2 Optional config file
```bash
cp devagent.config.example.json devagent.config.json
```
Use it for: separate models per role (planning / implementation / debugging), pricing for cost limits, protected branches,
test/build command overrides, exclusions, sandbox, deployment. Environment variables override the file.
Never put API keys in this file; it references the *name* of the environment variable (`apiKeyEnv`).

### 3.3 Cost control (important)
Cloud inference costs money. Set a limit before first use:
* token cap: `budget.maxTokensPerTask` (default 2,000,000)
* dollar cap: `AGENT_MAX_USD_PER_TASK=5` AND `pricing` for your provider in the config file (without pricing, a USD cap refuses to run)

### 3.4 Validate
```bash
npm run check-config
```
It lists every missing or invalid setting in plain language.

---------------------------------------------------------------------
## 4. Run
```bash
npm start
```
Open http://127.0.0.1:4317 (loopback only; do not expose it to a network, it executes commands).

### 4.0 What's new in 0.2.0 (read first)
* New control-center dashboard (Overview, New Task, Tasks, task detail with Live events / Terminal / Code changes / Test results / Report, Projects, Performance, Security, Settings). Full change list and honest gaps: `docs/UPGRADE_REPORT.md`.
* Hardened Docker sandbox with fail-closed behaviour (section 6).
* Breaking API changes if you scripted against it: `GET /api/tasks` returns `{items,total,limit,offset}`; the token must be sent in the `x-agent-token` header (not in the URL).
* Default concurrency is 1 task at a time (`AGENT_MAX_CONCURRENT_TASKS`).

### 4.1 Using the dashboard
1. **Project**: paste the absolute path of an existing Git repo (inside `AGENT_ALLOWED_DIRS`) -> *Analyze*. It shows the detected stack, branch, dirty state and which checks (lint/typecheck/test/build/e2e) it found.
2. **New task**: choose type, describe the feature or bug, add acceptance criteria (optional), optionally set max repair attempts -> *Start task*.
3. **Watch**: the Overview shows what is running, its real current command, progress through the actual pipeline, and what needs attention. Open a task for Live events, Terminal (live stdout/stderr with exit codes), Code changes (real diff, unified/split), Test results (VERIFIED / UNVERIFIED / FAILED, with not-run checks listed) and the Report. Pause/Continue/Cancel/Resume/Approve only appear when valid for the task's state; Cancel and Approve ask for confirmation. Pause takes effect at the next safe checkpoint.
4. **Review**: *View diff*, *View report*. Work is on branch `agent/<slug>-<id>`; the worktree is `data/worktrees/<id>`.
5. **Merge yourself** when satisfied:
```bash
cd /path/to/your/project
git log main..agent/<branch>                # inspect
git merge agent/<branch>                    # or: git cherry-pick <sha>, or push the branch and open a PR
```
`data/tasks/<id>/pr-description.md` contains a ready PR body. Nothing is pushed for you.

### 4.2 Task statuses
| status | meaning |
|---|---|
| passed | all detected checks exited 0 and at least one automated test ran; committed |
| unverified | checks passed but the project has no tests; NOT committed; add a test command |
| failed | retry budget exhausted, repeated failure, blocker, budget/time limit; see report |
| needs_approval | verified, but touched CI/auth/migrations/etc.; click *Approve & commit* after reviewing |
| needs_input | the plan hit a decision it should not guess; resubmit with the answer |
| interrupted | process stopped mid-task; click *Resume* (finished steps are not repeated) |
| cancelled | you cancelled; worktree preserved |

---------------------------------------------------------------------
## 5. Project requirements for good results
* Must be a Git repo with at least one commit. The agent works from the **last commit**; uncommitted changes are untouched and invisible to it (commit or stash first if you want them included).
* Have real `test`, `lint`, `build` scripts in package.json (or pytest/ruff for Python). Without a `test` script the result can only be `unverified`.
* Dependencies: if `node_modules` is missing it runs `npm ci` (or the manager matching your lockfile) in the worktree. Override with `commands.install`.
* Needs env vars? Tests should not depend on production secrets; the child process environment is scrubbed on purpose. Use mocks or a `.env.test` committed with fake values.

---------------------------------------------------------------------
## 5b. Dashboard pages (quick reference)
| Page | Shows |
|---|---|
| Overview | metrics (30 days), current task, pipeline, needs-attention, recent tasks, live CPU/memory/disk, latest activity |
| Tasks | searchable, filterable, paginated history (50-100 per page max) |
| Performance | success rate, durations, repairs, stage durations, tokens/cost per day, usage by role, test check pass rate; 7/30/90-day and project filters. Unknown data is shown as unknown |
| Projects | workspace repos, detected stack/commands, recent outcomes, file explorer (secrets hidden, boundary enforced by the backend) |
| Security | connectivity, sandbox *configured vs verified*, protections with evidence, pending approvals, blocked commands, timeouts |
| Settings | read-only effective configuration (API keys shown only as variable names + set/not set) |
CPU/memory history is kept in memory since server start only; cost is shown only if you configure `pricing` for the provider.

## 6. Safety: what to know before using it
### Docker sandbox setup (recommended for any repository you do not fully trust)
```bash
docker pull node:22-bookworm                 # the image must exist locally; the agent never pulls images itself
export AGENT_SANDBOX_MODE=docker
export AGENT_REQUIRE_SANDBOX=true            # refuse to start / fail tasks closed if Docker is unavailable
npm start
```
Every project command (lint/test/build/install/model-requested) then runs in a container with: no network (install only if `sandbox.allowNetworkForInstall` is true), read-only root filesystem, 256 MB tmpfs `/tmp`, all Linux capabilities dropped, `no-new-privileges`, your non-root uid/gid, CPU/RAM/PID/file limits, and ONLY the task worktree mounted. Host `git` and operator-configured deploy commands run on the host. If Docker is missing or the image is absent, tasks **fail closed** with a clear message; the agent will not silently run project code on the host. Do not mount the Docker socket into the agent's own container. The Security page reports the sandbox as configured but *not independently verified* because this path has not been exercised against a live Docker daemon yet; try it on a throwaway repo first.
* Without Docker, project scripts (`npm test`, build) run **with your user privileges**. Only use on repositories you trust, or enable sandboxing:
  `AGENT_SANDBOX_MODE=docker` (needs Docker; set `sandbox.image` to an image with your toolchain, e.g. node:22). This path is implemented but was not testable in the build environment, so try it on a throwaway repo first.
* Blocked by policy: rm, curl, sudo, shells, git push/reset/clean/rebase/force, `node -e`, `npm publish`, etc. Dependency installs and `npx` downloads need approval, so they are refused and listed as blockers.
* Never written: `.env*`, `.git/`, key files, `node_modules`. Never sent to the model: `.env*` contents. Secrets are redacted from logs, history, reports and prompts.
* Edits that delete/skip tests or reduce assertions are rejected.
* Prompt-injection text inside repo files is treated as data, but a real model can still be fooled; the policy layer is the guarantee, so keep review of diffs as a habit.

---------------------------------------------------------------------
## 7. Docker deployment of the agent itself
```bash
cp .env.example .env            # fill in values
mkdir -p projects data          # put/clone repos you want modified under ./projects
docker compose up --build
```
Open http://127.0.0.1:4317. Inside the container allowed dir is `/projects`, data is `/data`. Mount only repos you want changed.
Pass `PROJECTS_DIR=/abs/path` to use another folder. The container runs non-root, read-only, no capabilities.
Note: the server binds loopback inside the container; if the page is unreachable from the host, set `"host"` is NOT allowed to be 0.0.0.0 by design,
so instead run with `docker run --network host` on Linux, or just run it directly with `npm start` (recommended).

---------------------------------------------------------------------
## 8. Preview deployment & production (optional, off by default)
Add to `devagent.config.json`:
```json
"deploy": {
  "previewCommand": "vercel deploy --yes",
  "extraExecutables": ["vercel"],
  "envPassthrough": ["VERCEL_TOKEN"],
  "healthPath": "/",
  "smokePaths": ["/api/health"],
  "productionEnabled": false
}
```
Export `VERCEL_TOKEN` before `npm start`. After checks pass, the agent runs the command, extracts the preview URL, and really requests it;
a failing health/smoke check marks the task `failed` and blocks promotion. Commands containing `--prod` are refused as preview commands.
Production needs ALL of: passed task, healthy preview, `productionEnabled: true` + `productionCommand` (or `renderDeployHookEnv`), and an explicit
per-task approval:
```bash
curl -X POST -H "x-agent-token: <token>" -H "content-type: application/json" \
  -d '{"approved":true}' http://127.0.0.1:4317/api/tasks/<id>/promote
```
(The token is embedded in the dashboard page source; or print it by adding it to your own startup wrapper.) Keep `productionEnabled` false until
you have validated preview flows on your project. Vercel/Render/GitHub Actions integrations were not tested against real accounts.
GitHub Actions: push the `agent/*` branch yourself to trigger your workflows.

---------------------------------------------------------------------
## 8b. Testing
```bash
npm run lint && npm test && npm run test:e2e      # no extra installs needed
npm install                                       # optional: dev deps for browser tests (puppeteer-core + @sparticuz/chromium, ~100 MB)
npm run test:browser                              # real headless-Chromium tests of the dashboard; skipped automatically if the deps are absent
```
The model in all tests is a deterministic scripted provider; they verify the agent and dashboard, not LLM quality.

## 9. Troubleshooting
| symptom | cause / fix |
|---|---|
| `Invalid configuration` at start | read the listed items; run `npm run check-config` |
| `path is outside the allowed project directories` | add it to `AGENT_ALLOWED_DIRS` and restart |
| status `unverified` | project has no test script; add one |
| `Dependency installation failed` | network/registry/lockfile problem; run the install manually in the repo, or set `commands.install` |
| `Command blocked by policy` in blockers | the model wanted something unsafe/unapproved (e.g. new dependency); install it yourself, commit, resubmit |
| model returns invalid JSON | smaller/weaker models struggle; use a stronger model for implementation/debugging roles |
| `context limit` | use a larger-context model or add folders to `exclusions` |
| `another task is currently modifying...` | one task per repo at a time; wait or cancel |
| task stuck as `interrupted` after crash | click Resume; if the worktree was deleted, start a new task |
| port in use | `AGENT_PORT=4400 npm start` |
| `429 concurrency limit` | only `AGENT_MAX_CONCURRENT_TASKS` tasks run at once; wait or cancel |
| `Sandbox unavailable` | Docker not installed/running or image not pulled; fix, or deliberately change `sandbox.mode` |
| dashboard banner "Unauthorized" | the API token changes on every server start; reload the page |

---------------------------------------------------------------------
## 10. Project layout
```
src/config.js       validated config (file + env)          src/providers.js  model adapters, retries, budgets
src/security.js     redaction, path & command policy       src/prompts.js    prompts + JSON parsing
src/runner.js       safe subprocess execution              src/testing.js    check runner, failure parsing/classification
src/repo.js         stack detection + code index           src/orchestrator.js  the pipeline + repair loop + recovery
src/git.js          worktrees, commits, diffs              src/deploy.js     preview deploy, health checks, prod gate
src/editor.js       atomic, confined file edits            src/report.js     fact-based reports
src/store.js        persistent tasks, events, locks        src/server.js     HTTP API + SSE + static UI    src/cli.js
ui/index.html       dashboard                              tests/            unit + acceptance (scenarios A-F)
docs/               DEPLOYMENT.md, ACCEPTANCE.md           data/             created at runtime (tasks, worktrees) - gitignored
```
Clean up finished work: `git -C <repo> worktree remove --force data/worktrees/<id>` and `git -C <repo> branch -D agent/<branch>` (run by you; the agent never deletes branches).

---------------------------------------------------------------------
## 11. Extending
* New model provider: add an adapter in `src/providers.js` (`createAdapter`) returning `{text, usage}`; add its `type` to config validation.
* New language/tooling: extend `analyzeRepo` in `src/repo.js` to emit `checks` entries; add allowed executables in `src/security.js` (`SAFE_EXES`, plus rules).
* New deployment platform: use `previewCommand` + `extraExecutables`, or add a function in `src/deploy.js`.
* Run tests after any change: `npm run test:all`.

## 12. Honest status
Tested with a scripted model (not a live LLM) on disposable sample apps; scenario F used a local stand-in server; Docker sandbox, real Vercel/Render/GitHub,
Playwright automation and PR creation are not verified/implemented (see docs/ACCEPTANCE.md and README "Known limitations").
Start with a throwaway repo, a low token budget, and review every diff.
