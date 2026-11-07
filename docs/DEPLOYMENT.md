# Deployment guide

## Running the agent
* **Local (recommended):** `npm start`. Loopback only; token embedded in the served page.
* **Docker:** `docker compose up --build` (mount only the repos you want modified at `/projects`; `.env` supplies the model key). Container runs read-only, non-root, no capabilities.
* **Per-command sandbox:** on a host with Docker set `AGENT_SANDBOX_MODE=docker` (+ `sandbox.image`, `network`, `memory`, `cpus`). Use an image containing the toolchains your projects need.

## Preview deployments for the projects it works on
1. Install and authenticate the platform CLI on the host (e.g. `npm i -g vercel`).
2. In `devagent.config.json`:
```json
"deploy": { "previewCommand": "vercel deploy --yes", "extraExecutables": ["vercel"], "envPassthrough": ["VERCEL_TOKEN"],
            "healthPath": "/", "smokePaths": ["/api/health"], "productionEnabled": false }
```
3. Tokens named in `envPassthrough` reach only the deploy command and are redacted from all logs; the model never sees them.
4. Render: set `renderDeployHookEnv` to the env-var name holding your deploy-hook URL (production promotion only).
5. GitHub Actions: the agent commits to `agent/*` branches; push one yourself to run your workflows, then review the PR using `pr-description.md`.

Production promotion: see README. Never enable `productionEnabled` until preview + health-check flows have been validated on your project.
