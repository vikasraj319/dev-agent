// Real-browser tests of the dashboard (headless Chromium) against a real DevAgent server running real tasks.
// Optional: needs the dev dependencies `puppeteer-core` and `@sparticuz/chromium` (npm install). Skipped cleanly if absent.
// The model is a deterministic scripted provider, so this verifies the UI + backend integration, not LLM quality.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { buildModels, scriptedAdapter } from '../../src/providers.js';
import { J, createSampleApp, stageOf, testConfig, tmp } from '../helpers/sample-app.js';

let puppeteer, chromium;
try { puppeteer = (await import('puppeteer-core')).default; chromium = (await import('@sparticuz/chromium')).default; } catch { /* optional */ }
const skip = !puppeteer ? 'puppeteer-core / @sparticuz/chromium not installed (optional)' : false;

const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script> Add search box';
const PLAN = J({ summary: 'p', steps: ['one', 'two'], filesToChange: [], testsToAdd: [], assumptions: ['assume A'], risks: [], blockingQuestion: null });
let app, base, ids = {}, browser, parent, problems = [], closed = false; const pages = [];
const mv = (repo, name) => { const d = path.join(parent, name); fs.renameSync(repo, d); return d; };
const api = (p, method = 'GET', body) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: app.server.address().port, path: p, method, headers: { 'x-agent-token': app.token, 'content-type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve(JSON.parse(t))); }); r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end(); });
const finish = async (id, ms = 60000) => { const t0 = Date.now(); for (;;) { const t = await api(`/api/tasks/${id}`); if (!t.running && !['queued', 'running'].includes(t.status)) return t; if (Date.now() - t0 > ms) throw new Error('task did not finish'); await new Promise((r) => setTimeout(r, 200)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  parent = tmp('ui-ws-'); const repos = { pass: mv(createSampleApp(), 'checkout'), fail: mv(createSampleApp({ buggy: true }), 'orders'), appr: mv(createSampleApp({ extraFiles: { '.env': 'TOKEN=abc12345678' } }), 'infra'), slow: mv(createSampleApp({ extraFiles: { 'scripts/slow.js': "console.log('slow suite start'); setTimeout(() => process.exit(0), 30000);\n", 'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node scripts/slow.js' } }) } }), 'slowsvc') };
  const cfg = testConfig(tmp('data-')); cfg.allowedProjectDirs = [parent]; cfg.port = 0; cfg.limits.maxConcurrentTasks = 2;
  const adapter = scriptedAdapter(async (req) => { const st = stageOf(req); const txt = req.messages[0].content;
    if (st === 'PLANNING') return PLAN;
    if (st === 'IMPLEMENTATION') { if (txt.includes('[FAIL]')) return J({ explanation: 'x', edits: [{ op: 'replace', path: 'src/math.js', old: '// BUG', new: '// BUG t0' }], commands: [] }); if (txt.includes('[APPR]')) return J({ explanation: 'x', edits: [{ op: 'write_file', path: '.github/workflows/ci.yml', content: 'on: push\n' }, { op: 'write_file', path: 'src/ok.js', content: 'export const ok = 1;\n' }], commands: [] }); return J({ explanation: 'x', edits: [{ op: 'write_file', path: `src/f${Math.random().toString(36).slice(2, 6)}.js`, content: 'export const f = 1;\nexport const g = 2;\n' }], commands: [] }); }
    return J({ diagnosis: 'cannot fix', category: 'code', edits: [{ op: 'replace', path: 'src/math.js', old: '// BUG t0', new: '// BUG t1' }], commands: [] }); });
  app = createServer({ cfg, models: buildModels(cfg, { overrideAdapter: adapter }) }); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
  const run = async (repo, request, extra = {}) => { const s = await api('/api/tasks', 'POST', { repoPath: repo, request, ...extra }); if (!s.id) throw new Error(`task submission failed: ${JSON.stringify(s)}`); return (await finish(s.id)).id; };
  ids.pass = await run(repos.pass, 'Add a discount code field [PASS]'); ids.xss = await run(repos.pass, XSS); ids.fail = await run(repos.fail, 'Fix rounding bug [FAIL]', { maxRepairs: 1, type: 'bugfix' }); ids.appr = await run(repos.appr, 'Add CI workflow [APPR]');
  ids.slow = (await api('/api/tasks', 'POST', { repoPath: repos.slow, request: 'Long running integration job', type: 'feature' })).id;
  browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--no-sandbox'], headless: 'shell' });
});
after(async () => { if (browser) await browser.close(); if (app) { for (const c of app.live.values()) c.cancel(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); app.monitor.stop(); } });

async function open(hash = '#/', vp = { width: 1360, height: 900 }) {
  const page = await browser.newPage(); await page.setViewport(vp); pages.push(page);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !closed) problems.push(`console.${m.type()}: ${m.text()}`); }); page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !closed) problems.push(`HTTP ${r.status()} ${r.url()}`); }); page.on('requestfailed', (r) => { if (!closed && !/ABORTED/.test(r.failure()?.errorText || '')) problems.push(`requestfailed ${r.url()}`); });
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle2' }); return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
const waitText = (page, re, ms = 15000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout: ms }, re.source);

test('overview shows real aggregates, attention items and the running task', { skip }, async () => {
  const page = await open('#/'); await waitText(page, /Completed \/ failed/);
  await waitText(page, /2 \/ 1/); const body = await text(page, 'body');
  assert.match(body, /67%/, 'success rate = 2 passed of 3 decided'); assert.match(body, /Add CI workflow/); assert.match(body, /Needs approval/); assert.match(body, /Long running integration job/);
  await waitText(page, /Add CI workflow/); await waitText(page, /Running/); assert.match(await text(page, 'main'), /Current task/); assert.equal(await page.$$eval('[role=progressbar]', (n) => n.length > 0), true);
  assert.match(await page.$eval('.bell', (e) => e.innerText), /\d/, 'notification count reflects real attention items');
});

test('untrusted task text is rendered as text, never as HTML (XSS)', { skip }, async () => {
  const page = await open('#/tasks'); await waitText(page, /Add search box/); assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await text(page, '.tbl'), /<img src=x onerror=/, 'markup shown literally'); assert.equal(await page.$$eval('.tbl img, .tbl script', (n) => n.length), 0);
  await page.goto(`${base}/#/tasks/${ids.xss}`, { waitUntil: 'networkidle2' }); await waitText(page, /Add search box/); assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.$$eval('main img, main script', (n) => n.length), 0);
});

test('tasks list: search, status filter and pagination controls work against the API', { skip }, async () => {
  const page = await open('#/tasks'); const rows = (n) => page.waitForFunction((k) => document.querySelectorAll('.tbl tbody tr').length === k, { timeout: 10000 }, n);
  await rows(5); await page.type('.tt input[type=search]', 'rounding'); await rows(1); assert.match(await text(page, '.tbl'), /Fix rounding bug/); assert.doesNotMatch(await text(page, '.tbl'), /discount code/);
  await page.$eval('.tt input[type=search]', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await rows(5);
  await page.select('.tt select', 'failed'); await rows(1); assert.match(await text(page, '.tbl'), /Failed/);
  await page.select('.tt select', 'passed'); await rows(2); await waitText(page, /1–2 of 2/); assert.equal(await page.$eval('.pager button:last-of-type', (b) => b.disabled), true);
  await page.select('.tt select', 'needs_approval'); await rows(1);
});

test('failed task: honest verdict, no run controls, tabs are keyboard accessible, repair history shown', { skip }, async () => {
  const page = await open(`#/tasks/${ids.fail}`); await waitText(page, /Retry budget exhausted|persisted/);
  const btns = await page.$$eval('main .page-h button', (b) => b.map((x) => x.innerText.trim())); assert.ok(!btns.some((t) => /Pause|Cancel|Approve/.test(t)), `unexpected controls: ${btns}`);
  assert.equal(await page.$$eval('[role=tab]', (t) => t.length), 6); await page.focus('#tab-overview'); await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.querySelector('#tab-events').getAttribute('aria-selected') === 'true');
  await page.click('#tab-tests'); await waitText(page, /FAILED/); assert.match(await text(page, '#tabpanel'), /Check runs/); assert.doesNotMatch(await text(page, '#tabpanel'), /VERIFIED/);
  await page.click('#tab-overview'); await waitText(page, /Repair attempts/); assert.match(await text(page, '#tabpanel'), /cannot fix|AI diagnosis/); assert.match(await text(page, '#tabpanel'), /Failed/);
  await page.click('#tab-report'); await waitText(page, /FAILED/); assert.match(await text(page, '#tabpanel'), /No full verification run completed/);
});

test('code changes tab renders the real diff (unified and split) with matching counts', { skip }, async () => {
  const page = await open(`#/tasks/${ids.pass}/changes`); await page.waitForSelector('.files .fbtn'); const real = (await api(`/api/tasks/${ids.pass}/diff`)).diff;
  const adds = real.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length; assert.equal(await page.$$eval('.dl.add', (n) => n.length), adds);
  assert.match(await text(page, '.files'), new RegExp(`\\+${adds}`)); await page.click('.seg button:last-child'); await page.waitForSelector('.hunk.split'); assert.equal(await page.$$eval('.sd.add', (n) => n.length), adds);
  assert.match(await text(page, '#tabpanel'), /real git diff/);
});

test('terminal tab shows recorded command output with exit codes and filtering', { skip }, async () => {
  const page = await open(`#/tasks/${ids.pass}/terminal`); await page.waitForSelector('.tblock'); const t = await text(page, '.term'); assert.match(t, /\$ npm test/); assert.match(t, /exit 0/); assert.match(t, /lint ok|build ok/);
  await page.type('.filters input[type=search]', 'build ok'); await page.waitForFunction(() => [...document.querySelectorAll('.ln')].filter((l) => !l.hidden).every((l) => /build ok/.test(l.textContent)));
  const visible = await page.$$eval('.ln', (n) => n.filter((l) => !l.hidden).length); assert.ok(visible >= 1 && visible <= 6);
});

test('approval flow: confirm dialog, Escape cancels safely, confirming really approves', { skip }, async () => {
  const page = await open(`#/tasks/${ids.appr}`); await waitText(page, /Review & approve/);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Review & approve/.test(b.innerText)).click()); await page.waitForSelector('[role=dialog]'); assert.match(await text(page, '[role=dialog]'), /sensitive file changed: \.github\/workflows\/ci\.yml/);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[role=dialog]')); assert.equal((await api(`/api/tasks/${ids.appr}`)).status, 'needs_approval', 'Escape must not approve');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Review & approve/.test(b.innerText)).click()); await page.waitForSelector('[role=dialog]'); await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /Approve & commit/.test(b.innerText)).click());
  await waitText(page, /Passed/); const t = await api(`/api/tasks/${ids.appr}`); assert.equal(t.status, 'passed'); assert.ok(t.commitSha);
});

test('running task: live output streams in, Cancel needs confirmation and really cancels', { skip }, async () => {
  const page = await open(`#/tasks/${ids.slow}/terminal`); await waitText(page, /slow suite start/, 30000); assert.match(await text(page, '.page-h'), /Running/);
  await page.evaluate(() => [...document.querySelectorAll('.page-h button')].find((b) => /Cancel/.test(b.innerText)).click()); await page.waitForSelector('[role=dialog]');
  await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /Back/.test(b.innerText)).click()); await sleep(300); assert.notEqual((await api(`/api/tasks/${ids.slow}`)).status, 'cancelled', 'declining the dialog must not cancel');
  await page.evaluate(() => [...document.querySelectorAll('.page-h button')].find((b) => /Cancel/.test(b.innerText)).click()); await page.waitForSelector('[role=dialog]'); await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /Cancel task/.test(b.innerText)).click());
  await waitText(page, /Cancelled/, 20000); assert.equal((await finish(ids.slow)).status, 'cancelled'); assert.equal(await page.$$eval('.page-h button', (b) => b.some((x) => /Pause|Cancel/.test(x.innerText))), false, 'controls disappear once cancelled');
});

test('projects explorer lists files, hides secrets and enforces the workspace boundary', { skip }, async () => {
  const page = await open('#/projects'); await page.waitForSelector('.pbtn'); const repo = (await api('/api/projects')).projects.find((p) => p.name === 'infra').path;
  await page.evaluate((p) => { location.hash = `#/projects?p=${encodeURIComponent(p)}`; }, repo); await page.waitForSelector('.tn'); const tree = await text(page, '.tree-w'); assert.match(tree, /package\.json/); assert.doesNotMatch(tree, /\.env/);
  await page.evaluate(() => [...document.querySelectorAll('.tn.file')].find((b) => /package\.json/.test(b.innerText)).click()); await waitText(page, /"scripts"/);
  const probe = (file) => api('/api/projects/file', 'POST', { path: repo, file }); assert.match((await probe('../../etc/passwd')).error, /escapes|outside/i); assert.match((await probe('.env')).error, /not available/i);
});

test('performance and security pages show real, honestly labelled data', { skip }, async () => {
  const page = await open('#/performance'); await waitText(page, /Tasks per day/); assert.match(await text(page, 'main'), /Success rate/); assert.ok((await page.$$('svg.chart')).length >= 2);
  assert.match(await text(page, 'main'), /not persisted|Historical resource usage/);
  await page.goto(`${base}/#/security`, { waitUntil: 'networkidle2' }); await waitText(page, /Execution sandbox/); const t = await text(page, 'main'); assert.match(t, /configured: none/); assert.match(t, /not independently verified/); assert.doesNotMatch(t, /secure\b(?! unless)/i);
});

test('mobile layout: no horizontal overflow and the navigation drawer works', { skip }, async () => {
  const page = await open('#/', { width: 390, height: 844, isMobile: true, hasTouch: true }); await waitText(page, /Completed \/ failed/);
  for (const h of ['#/', '#/tasks', `#/tasks/${ids.pass}`, '#/performance', '#/security']) { await page.evaluate((x) => { location.hash = x; }, h); await sleep(1200); assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 2, `overflow on ${h}`); }
  assert.equal(await page.$eval('.sidebar', (e) => e.getBoundingClientRect().right <= 0), true); await page.click('.menu-btn'); await sleep(350); assert.equal(await page.$eval('.sidebar', (e) => e.getBoundingClientRect().left >= 0), true);
});

test('unauthorized API responses are surfaced clearly', { skip }, async () => {
  const page = await open('#/'); await waitText(page, /Completed \/ failed/); await page.evaluate(() => { window.DA_TOKEN = 'wrong'; DA.refreshGlobal(); }); await page.waitForFunction(() => /Unauthorized/.test(document.querySelector('.banner').innerText), { timeout: 10000 });
  problems = problems.filter((p) => !/HTTP 401|status of 401/.test(p)); // deliberate: this test forces unauthorized responses
});

test('NO console errors or failed requests across all pages visited', { skip }, () => { assert.deepEqual(problems, []); });

test('backend outage is shown as disconnected / stale (run last)', { skip }, async () => {
  const page = await open('#/'); await waitText(page, /Backend connected/); closed = true; app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r));
  await page.waitForFunction(() => /Backend disconnected/.test(document.querySelector('.conn').innerText) && !document.querySelector('.banner').hidden, { timeout: 20000 }); assert.match(await text(page, '.banner'), /Cannot reach the DevAgent backend/); assert.match(await text(page, '#sidebar'), /Agent unreachable/);
});
