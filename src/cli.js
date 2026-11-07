#!/usr/bin/env node
import fs from 'node:fs';
import { ConfigError, loadConfig, publicConfig } from './config.js';
import { createServer } from './server.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
try {
  if (cmd === 'check-config') {
    const cfg = loadConfig({ file: flag('config'), requireProvider: true });
    console.log('Configuration OK'); console.log(JSON.stringify(publicConfig(cfg), null, 2));
  } else if (cmd === 'serve') {
    const cfg = loadConfig({ file: flag('config'), requireProvider: true });
    if (!cfg.allowedProjectDirs.length) throw new ConfigError(['allowedProjectDirs is empty: set AGENT_ALLOWED_DIRS (path-delimited) or "allowedProjectDirs" in devagent.config.json']);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const app = createServer({ cfg });
    const addr = await app.listen();
    console.log(`DevAgent dashboard: http://${cfg.host}:${addr.port}/\nAllowed project dirs: ${cfg.allowedProjectDirs.join(', ')}\nSandbox mode: ${cfg.sandbox.mode}${cfg.sandbox.mode === 'none' ? '  (WARNING: project scripts run with your user privileges; use docker for untrusted repos)' : ''}`);
    const n = app.store.purgeOld(cfg.logging.retentionDays); if (n) console.log(`Purged ${n} task record(s) older than ${cfg.logging.retentionDays} days`);
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { for (const c of app.live.values()) c.cancel(); setTimeout(() => process.exit(0), 500); });
  } else {
    console.log('Usage: devagent <serve|check-config> [--config file]\nSee README.md');
  }
} catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(2); }
  throw e;
}
