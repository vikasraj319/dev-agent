// Child process used by scenario E: starts a task, then hangs inside the model call so the parent can SIGKILL it.
import fs from 'node:fs';
import { Orchestrator } from '../../src/orchestrator.js';
import { buildModels, scriptedAdapter } from '../../src/providers.js';
import { Store } from '../../src/store.js';
import { J, stageOf } from './sample-app.js';
import { BUGGY_MATH } from './sample-app.js';

const { cfg, taskId, marker } = JSON.parse(process.argv[2]);
const store = new Store(cfg.dataDir);
const adapter = scriptedAdapter(async (req) => {
  const st = stageOf(req);
  if (st === 'PLANNING') return J({ summary: 'fix sum', steps: ['edit sum'], filesToChange: ['src/math.js'], testsToAdd: [], assumptions: [], risks: [], blockingQuestion: null });
  if (st === 'IMPLEMENTATION') return J({ explanation: 'wrong first attempt', edits: [{ op: 'replace', path: 'src/math.js', old: 'return a - b; // BUG', new: 'return a * b; // still wrong' }], commands: [] });
  fs.writeFileSync(marker, 'in-debugging'); setInterval(() => {}, 1000); await new Promise(() => {}); // hang (kept alive) until killed
});
const models = buildModels(cfg, { overrideAdapter: adapter });
await new Orchestrator({ cfg, store, models }).execute(taskId);
