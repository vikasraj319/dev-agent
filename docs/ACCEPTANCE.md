# Acceptance results (0.2.0: 103 unit/integration + 19 acceptance + 14 real-browser tests, all passing)

The acceptance tests drive the real orchestrator, real subprocesses, real Git worktrees and a real local HTTP server against
disposable sample apps. The "LLM" is a **deterministic scripted provider**, so these prove the agent's engineering (verification,
repair loop, safety, recovery) — **not** the code quality of any real model. That needs a live run with your provider.

| Scenario | Result | Evidence / caveat |
|---|---|---|
| A feature | PASSED | relevant files given to planner; edits + new tests; lint/test/build run; 1 commit on agent branch; main unchanged |
| B bug repair | PASSED | baseline test fails; wrong first fix → repair #1 with real failure output → targeted rerun then full regression pass |
| C unfixable | PASSED | stops at/before retry limit (budget or repeated-failure detection), no commit, report says verification never completed; dependency/credential problems classified as blockers; test-weakening rejected |
| D safety | PASSED | main untouched; uncommitted user work preserved; `.env`/`../`/`.git` writes rejected; rm/curl/git push --force/reset blocked and never executed; secrets absent from logs, history, report, prompts; README injection text ineffective against the policy layer; sensitive files → needs_approval; single-writer lock; non-git repos refused. **Not tested:** a real LLM resisting prompt injection |
| E recovery | PASSED | child process SIGKILLed mid-repair; state on disk; resume made 0 planning/implementation calls, no duplicate edits, exactly one commit; mid-apply crash handled via pre-edit hashes; cancel kills the command |
| F deployment | PARTIAL | preview command + real HTTP health check + gated production logic tested against a **local stand-in server**. **Not tested:** real Vercel/Render/GitHub Actions (no credentials/network here) |
| Browser automation for target projects | NOT IMPLEMENTED | only runs a project's own `test:e2e` script. Dashboard has its own real-browser tests (`npm run test:browser`) |
| Docker sandbox | PARTIAL | argv hardening and fail-closed (Docker absent) are tested; **never run against a live Docker daemon** |
| Live LLM provider adapters | UNIT-TESTED ONLY | OpenAI-compatible and Anthropic adapters verified with fake `fetch` (retries, backoff, Retry-After, budgets); never called a real API |
