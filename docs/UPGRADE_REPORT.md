# DevAgent 0.2.0 — Upgrade report

Scope of this iteration: (1) the "Advanced Autonomous Software Engineering System" upgrade brief and (2) the "AI Engineering Control Center" dashboard redesign.
Priority was execution security and reliability first, then the dashboard. **Not every item in the upgrade brief was implemented** — see §8 for the explicit list.

## 1. Architecture assessment (before)
Zero-dependency Node service: `server.js` (HTTP+SSE) → `orchestrator.js` (pipeline: analysis → worktree → baseline → plan → implement → verify/repair → review → commit → optional preview deploy) using `repo.js` (stack detection, keyword/import index), `editor.js` (atomic confined edits), `runner.js` (argv-only, policy-checked subprocesses), `testing.js` (check runner, failure parsing/classification/fingerprints), `providers.js` (OpenAI-compatible/Anthropic adapters, retries, budgets), `store.js` (JSON task files, JSONL events, repo locks), `git.js`, `deploy.js`, `report.js`. UI was a single vanilla HTML page.
Existing capabilities were reused, not rebuilt. Baseline: **68 unit + 17 acceptance tests, all passing** (lint clean).

## 2. Defects found by inspection/testing and fixed
| # | Finding | How found | Fix |
|---|---|---|---|
| 1 | Docker mode wrapped host-side `git` calls in the container (worktrees would break); no preflight; missing Docker looked like a generic "environment" failure; no `--read-only`/`--user`; default network on; timeout killed the docker CLI but **not the container** | code review | `src/sandbox.js`: pure `buildDockerArgs`, preflight (daemon + image), fail-closed `SandboxUnavailable`, git exempt, container killed on timeout/abort, network `none` by default |
| 2 | Verification checks (lint/test/build) never emitted start/output/end events, so no live output or "current command" existed for them | live-state API test | checks now stream through the same event hooks |
| 3 | Diff was redacted *before* the secret scanner saw it, so scanning could never match | secret-scan e2e test | trusted host-side git reads skip redaction; diff is redacted before persisting or prompting the model |
| 4 | Persisted `changes.patch` was unredacted | review | redacted on write |
| 5 | Task ordering tie on same-millisecond creation (flaky) | unit test | strictly increasing `createdAt` |
| 6 | Pipeline view dropped a label argument (shifted states) | unit test | fixed |
| 7 | Browser requested `/favicon.ico` → 404 | real-browser test | inline favicon |
| 8 | Earlier iteration: redactor leaked on group-less patterns; classifier mistook `ModuleNotFoundError` for a network error; crash recovery double-applied edits | tests | fixed previously (see ACCEPTANCE.md) |

## 3. Implemented (upgrade brief)
* **§6 Secure execution:** Docker sandbox hardening (`--network none`, `--read-only`, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, non-root `--user`, memory/swap/CPU/PID/ulimit limits, single worktree mount, no Docker socket, no host env), `sandbox.required` (refuse to start without docker), fail-closed preflight, install-only network opt-in (`allowNetworkForInstall`), dependency installs and `npx` downloads still need approval.
* **§7 Security analysis (partial):** secret-leak scan of added lines → forces approval (value never shown); existing sensitive-file and auth/TLS/CORS-weakening checks retained.
* **§10 Persistence/recovery (partial):** task schema validation on load/save, `.bak` fallback for corrupted state, bounded per-task event log (`maxEventsPerTask`), monotonic event `seq`, retention purge retained.
* **§9 Cost (partial):** per-role token/cost accounting (`usage.byRole`); budgets/retries/redaction already existed.
* **§13 Resources:** `maxConcurrentTasks` default **1** (HTTP 429 beyond it); bounded in-memory resource sampler; summary cache by file mtime; UI is ~125 KB unminified JS/CSS/HTML total with zero dependencies.
* **§12 Tests:** see §6 below.

## 4. Implemented (dashboard brief)
Same vanilla stack (no migration, no build step, no runtime dependencies). New files: `ui/{index.html,app.css,core.js,views-a.js,views-b.js,views-c.js,main.js}`.
* Shell: collapsible sidebar (Overview, New Task, Tasks, Projects, Performance, Security, Settings), health + version, global search (tasks/projects), project selector, notification bell (real attention items), backend/stream connection chip, stale/disconnected banner.
* Overview: summary metrics, current task with real elapsed/operation/progress, derived pipeline, needs-attention, searchable/filterable/paginated tasks, live resources, latest activity.
* Task page: Overview, Live events (severity/stage/search filters, bounded rendering), Terminal (stdout/stderr, exit codes, durations, timeouts, search, follow, copy, download), Code changes (real diff, unified/split, per-file counts), Test results (verified vs unverified vs not-run), Report + artifact downloads. Pause/Continue/Cancel/Resume/Approve appear **only** when the backend supports them and the state allows; Cancel/Approve confirm.
* Performance: success rate, durations, repairs, stage durations, tokens/cost per day, per-role usage, test check pass rate, reliability counters; date and project filters; low-sample warnings; unknowns shown as unknown.
* Projects: workspace list, analysis, recent outcomes, lazy file tree + syntax-highlighted preview (backend-enforced boundary, secrets hidden).
* Security & health: connectivity, sandbox **configured vs verified**, protections table with evidence, approvals, blocked commands, timeouts. Settings: read-only effective config (no secrets).
* Real-time: fetch-based SSE with header auth, seq dedupe, resume via `Last-Event-ID`, bounded reconnect backoff, 45 s stall watchdog, heartbeats; polling pauses when the tab is hidden; all timers/listeners disposed on navigation.
* Backend additions (smallest compatible): `/api/health`, `/api/overview`, `/api/metrics`, `/api/security`, `/api/projects` (+`tree`, `file`), paginated `/api/tasks`, `/api/tasks/:id/events.json`, whitelisted `/api/tasks/:id/artifact`. **Breaking:** `GET /api/tasks` now returns `{items,total,limit,offset}`; the API token is accepted in the `x-agent-token` header only (no URL query).
* Accessibility: skip link, landmarks, roles/ARIA on tabs, dialogs, progress bars, focus-visible, keyboard tab navigation, focus managed on route change, reduced-motion.

## 5. Files changed
New: `src/{sandbox,metrics,projects,monitor}.js`; `ui/*` (rewritten); tests `tests/unit/{sandbox,metrics,projects,api}.test.js`, `tests/browser/dashboard.test.js`; docs. Modified: `src/{runner,config,orchestrator,server,store,security,testing,git,providers}.js`, existing tests adapted to the paginated list API.

## 6. Results — baseline vs final
| Suite | Baseline | Final |
|---|---|---|
| Lint (syntax) | 30 files ok | 44 files ok |
| Unit/integration | 68 pass | **103 pass** |
| Acceptance (scenarios A–F + safety/recovery) | 17 pass | **19 pass** (+secret scan, +sandbox fail-closed) |
| Real-browser (headless Chromium) | — | **14 pass** (optional dev dependency) |

Security tests added: docker argv isolation flags; no socket/home mounts; no secret env forwarding; **fail-closed (command never executes on host when Docker is missing, at both the runner and whole-task level)**; `sandbox.required` config validation; secret-in-diff forcing approval and absence from artifacts; path traversal/symlink/secret-file/binary handling in the file explorer API; header-only auth; DNS-rebinding host check; artifact whitelist; XSS rendering of hostile task text in a real browser; approval/cancel dialogs (Escape and "Back" do nothing); unauthorized responses surfaced; backend outage shown; zero console errors / failed requests across all pages; no horizontal overflow at 390 px.
Visual verification: every page screenshotted at 1440×900 and 390×844 in headless Chromium and inspected.

## 7. Resource and cost notes
Server idle RSS ≈ 60–70 MB (observed in the dashboard). Default concurrency 1. Dashboard polling: overview 5 s, health 15 s, projects 60 s, metrics 30 s, only while the tab is visible; aggregation uses an mtime cache. Charts are inline SVG (no library). Model cost is only shown when `providers.*.pricing` is configured; otherwise "unknown". Browser tests need ~100 MB of Chromium via npm and are optional.

## 8. NOT implemented / not verified (honest list)
* **Docker sandbox has never been run against a real Docker daemon** (none available here). Flags are unit-tested; fail-closed is proven only for the "Docker absent" case. Test it on a host with Docker before relying on it. Browser automation inside a constrained container (§8 of the brief) is not implemented; the optional browser tests drive the *dashboard*, not target projects.
* Upgrade brief items **not done**: structured multi-step plan state machine (pending/running/completed/…); incremental indexing and symbol/call-site search; patch-based/stale-edit conflict detection beyond exact-match replace; focused-test selection; vulnerable-dependency/static-analysis/“weak tests” scanners; role-based model **escalation/fallback** and a code-review role; persistent per-project memory (conventions, past fixes); Playwright-style target-project browser testing.
* Dashboard: no user/account concept (backend has none), so no user menu; no file-name search in the explorer; plan steps are listed but not individually tracked; historical CPU/memory is in-memory since server start only; "events" counts reflect the loaded window (last 2000 events).
* Settings page is read-only (editing config from the UI is not supported).
* Real LLM quality and live Vercel/Render/GitHub flows remain untested (scripted provider only).
