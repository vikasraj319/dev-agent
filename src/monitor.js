import fs from 'node:fs';
import os from 'node:os';

/**
 * Lightweight real resource sampler. Keeps a bounded ring buffer IN MEMORY (since server start) — there is no
 * persisted history. Values describe the host as seen by the agent process (inside a container this may be the host).
 */
export class ResourceMonitor {
  constructor({ dataDir, intervalMs = 15_000, max = 240 }) { this.dataDir = dataDir; this.intervalMs = intervalMs; this.max = max; this.samples = []; this.prev = this.cpuTimes(); this.timer = null; this.startedAt = Date.now(); }
  cpuTimes() { return os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); a.total += t; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 }); }
  sample() {
    const cur = this.cpuTimes(); const dt = cur.total - this.prev.total; const di = cur.idle - this.prev.idle; this.prev = cur;
    const total = os.totalmem(); const free = os.freemem();
    let disk = null; try { const s = fs.statfsSync(this.dataDir); disk = { totalBytes: s.blocks * s.bsize, usedPct: Number((100 * (1 - s.bavail / s.blocks)).toFixed(1)) }; } catch { /* unsupported */ }
    const smp = { t: new Date().toISOString(), cpuPct: dt > 0 ? Number((100 * (1 - di / dt)).toFixed(1)) : null, memUsedPct: Number((100 * (1 - free / total)).toFixed(1)), memUsedBytes: total - free, memTotalBytes: total, disk, agentRssBytes: process.memoryUsage().rss };
    this.samples.push(smp); if (this.samples.length > this.max) this.samples.shift(); return smp;
  }
  start() { this.sample(); this.first = setTimeout(() => this.sample(), 1500); this.first.unref(); this.timer = setInterval(() => this.sample(), this.intervalMs); this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); clearTimeout(this.first); }
  snapshot() { return { cores: os.cpus().length, load1: os.loadavg()[0], current: this.samples.at(-1) ?? this.sample(), history: this.samples, historyNote: `in-memory samples since server start (${Math.round((Date.now() - this.startedAt) / 1000)}s); not persisted` }; }
}
