/* Views A: shared task actions/table, Overview, New Task, Tasks list. */
(function () {
  'use strict';
  const { h, api, fmt, icon, badge, card, metric, btn, skeleton, empty, errorBox, toast, confirm } = window.DA; const DA = window.DA;
  DA.views = {};
  const proj = () => DA.state.project;
  const projName = (p) => (p ? p.split('/').filter(Boolean).pop() : 'All projects');

  /** Page-level helper: show skeleton, load, render, handle errors with retry. */
  DA.loadInto = async (el, loader, render) => { DA.replace(el, skeleton(4)); try { const d = await loader(); DA.replace(el, render(d)); } catch (e) { if (e.name !== 'AbortError') DA.replace(el, errorBox(e, () => DA.loadInto(el, loader, render))); } };

  /** Task actions: only the controls the backend supports AND that are valid for the task's current state. */
  DA.taskActions = (t, onDone) => {
    const post = async (act, okMsg) => { try { await api(`/tasks/${t.id}/${act}`, { method: 'POST' }); okMsg && toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'err'); } onDone && onDone(); DA.refreshGlobal && DA.refreshGlobal(); };
    const out = [];
    if (t.running && t.status !== 'paused') out.push(btn('Pause', { icon: 'pause', title: 'Takes effect at the next safe checkpoint, not mid-command', onClick: () => post('pause', 'Pause requested; it takes effect at the next safe checkpoint.') }));
    if (t.running && t.status === 'paused') out.push(btn('Continue', { icon: 'play', kind: 'primary', onClick: () => post('continue', 'Resuming task.') }));
    if (t.running) out.push(btn('Cancel', { icon: 'stop', kind: 'danger-o', onClick: async () => { if (await confirm({ title: 'Cancel this task?', text: 'The running command is stopped. The worktree and partial changes are kept; nothing is deleted.', confirmLabel: 'Cancel task', danger: true })) post('cancel', 'Cancellation requested.'); } }));
    if (!t.running && ['interrupted', 'needs_input'].includes(t.status)) out.push(btn('Resume', { icon: 'refresh', kind: 'primary', title: 'Completed steps are not repeated', onClick: () => post('resume', 'Task resumed.') }));
    if (t.status === 'needs_approval') out.push(btn('Review & approve', { icon: 'check', kind: 'primary', onClick: async () => { let full = t; try { full = await api(`/tasks/${t.id}`); } catch { /* use summary */ } if (await confirm({ title: 'Approve and commit?', text: 'Verification passed, but this change needs your explicit approval before it is committed to the agent branch (nothing is pushed).', confirmLabel: 'Approve & commit', details: full.approvalRequired || [] })) post('approve', 'Approved and committed.'); } }));
    return out;
  };

  // ---------- task table (searchable, filterable, paginated) ----------
  DA.taskTable = ({ limit = 15, compact = false, initialQuery = '' }) => {
    const st = { q: initialQuery, status: '', offset: 0, seq: 0 };
    const body = h('div', { class: 'tt-body' }); const pager = h('div', { class: 'pager' });
    const search = h('input', { type: 'search', id: `tt-q-${Math.random().toString(36).slice(2, 6)}`, placeholder: 'Search description, id, branch…', value: initialQuery, 'aria-label': 'Search tasks', class: 'in' });
    const status = h('select', { class: 'in', 'aria-label': 'Filter by status' }, h('option', { value: '' }, 'All statuses'), ['running', 'queued', 'paused', 'passed', 'failed', 'unverified', 'needs_approval', 'needs_input', 'interrupted', 'cancelled'].map((s) => h('option', { value: s }, s.replace('_', ' '))));
    let debounce = null; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { st.q = search.value.trim(); st.offset = 0; load(); }, 300); });
    status.addEventListener('change', () => { st.status = status.value; st.offset = 0; load(); });
    async function load(quiet) {
      const my = ++st.seq; if (!quiet) DA.replace(body, skeleton(4));
      try {
        const qs = new URLSearchParams({ limit, offset: st.offset }); if (st.q) qs.set('q', st.q); if (st.status) qs.set('status', st.status); if (proj()) qs.set('project', proj());
        const d = DA.expect(await api(`/tasks?${qs}`), { items: 'array', total: 'number' }, 'tasks'); if (my !== st.seq) return; // ignore stale responses
        DA.replace(body, d.items.length ? table(d.items) : (st.q || st.status || proj()) ? empty('No tasks match these filters', 'Clear the search, status filter or project selection to see more.') : empty('No tasks yet', 'Submit a feature request or bug report and it will appear here.', btn('New task', { kind: 'primary', icon: 'plus', onClick: () => (location.hash = '#/new') })));
        const from = d.total ? d.offset + 1 : 0; const to = Math.min(d.total, d.offset + d.items.length);
        DA.replace(pager, h('span', { class: 'muted' }, `${from}–${to} of ${d.total}`), btn('Previous', { disabled: d.offset === 0, onClick: () => { st.offset = Math.max(0, st.offset - limit); load(); } }), btn('Next', { disabled: d.offset + limit >= d.total, onClick: () => { st.offset += limit; load(); } }));
      } catch (e) { if (my === st.seq && e.name !== 'AbortError') DA.replace(body, errorBox(e, () => load())); }
    }
    function table(items) {
      const head = ['Task', 'Project', 'Status', 'Duration', 'Repairs'].concat(compact ? [] : ['Tests', 'Tokens / cost', 'Started']);
      return h('div', { class: 'tbl-w' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', { scope: 'col' }, c)))), h('tbody', {}, items.map((t) => h('tr', {},
        h('td', { class: 'td-main' }, h('a', { href: `#/tasks/${encodeURIComponent(t.id)}`, class: 'tl' }, t.request.length > 90 ? `${t.request.slice(0, 90)}…` : t.request), h('div', { class: 'muted mono' }, t.id)),
        h('td', {}, t.project), h('td', {}, badge(t.status), t.running && t.status !== 'paused' && h('div', { class: 'muted sm' }, t.stage)),
        h('td', {}, fmt.duration(t.durationMs)), h('td', {}, `${t.repairCount}${t.maxRepairs != null ? `/${t.maxRepairs}` : ''}`),
        !compact && h('td', {}, t.tests.runs ? h('span', { title: 'verification check runs in the tests category' }, `${t.tests.passedRuns} ✓ / ${t.tests.failedRuns} ✗`, t.tests.verified ? badge('passed', 'verified') : null) : h('span', { class: 'muted' }, 'not run')),
        !compact && h('td', {}, t.tokens == null ? h('span', { class: 'muted' }, '—') : `${fmt.compact(t.tokens)} · ${fmt.usd(t.costUsd)}`), !compact && h('td', { class: 'muted' }, fmt.time(t.startedAt || t.createdAt)))))));
    }
    const el = h('div', { class: 'tt' }, h('div', { class: 'filters' }, h('label', { class: 'srch' }, icon('search', 14), search), h('label', { class: 'sel' }, h('span', { class: 'sr' }, 'Status'), status), btn('', { icon: 'refresh', title: 'Refresh', onClick: () => load() })), body, pager);
    load(); const off = DA.on('overview', () => load(true)); // refresh when global polling sees a change
    return { el, dispose: off, reload: () => load() };
  };

  // ---------- Overview ----------
  DA.views.overview = () => {
    const el = h('div', { class: 'page' }); const disposers = [];
    const metricsEl = h('div', { class: 'metrics m4' }, skeleton(2)); const currentEl = h('div', {}); const pipeEl = h('div', {}); const attnEl = h('div', {}); const resEl = h('div', {}); const actEl = h('div', {});
    const tt = DA.taskTable({ limit: 6, compact: true }); disposers.push(tt.dispose);
    DA.replace(el, h('div', { class: 'page-h' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Overview'), h('p', { class: 'muted' }, `What the agent is doing, whether it is progressing, and what needs you. Scope: ${projName(proj())}.`)), btn('New task', { kind: 'primary', icon: 'plus', onClick: () => (location.hash = '#/new') })),
      metricsEl, h('div', { class: 'grid g-main' }, card('Current task', currentEl, { cls: 'span2' }), card('Task pipeline', pipeEl)),
      h('div', { class: 'grid g-3' }, card('Needs attention', attnEl), card('Recent tasks', tt.el, { actions: h('a', { href: '#/tasks', class: 'lnk' }, 'View all'), cls: 'span2' })),
      h('div', { class: 'grid g-2' }, card('Resources (live)', resEl), card('Latest activity', actEl)));

    // metrics (30-day window) — polled less often than live state
    let metrics = null, metricsErr = null;
    const renderMetrics = () => {
      if (metricsErr && !metrics) return DA.replace(metricsEl, errorBox(metricsErr, loadMetrics));
      const m = metrics, hl = DA.state.health, o = DA.state.overview; if (!m) return;
      const sr = m.successRate; const cur = hl && hl.resources && hl.resources.current;
      DA.replace(metricsEl,
        metric({ label: 'Active tasks', value: o ? `${o.running.length}` : '—', sub: o ? `${o.queued} queued · limit ${o.concurrency.max}` : '', icon: 'zap', tone: o && o.running.length ? 'info' : '' }),
        metric({ label: 'Completed / failed', value: `${m.totals.passed} / ${m.totals.failed}`, sub: `${m.totals.unverified} unverified · ${m.totals.cancelled} cancelled`, icon: 'check', tip: 'Last 30 days' }),
        metric({ label: 'Success rate', value: sr.value == null ? '—' : fmt.pct(sr.value), sub: sr.value == null ? 'no finished tasks yet' : `${sr.decided} finished${sr.lowConfidence ? ' · low sample' : ''}`, icon: 'gauge', tip: sr.definition }),
        metric({ label: 'Avg duration', value: fmt.duration(m.duration.avgMs), sub: m.duration.samples ? `median ${fmt.duration(m.duration.medianMs)} · n=${m.duration.samples}` : 'no finished tasks yet', icon: 'clock' }),
        metric({ label: 'Test check runs', value: m.tests.runs ? `${m.tests.passed} ✓ / ${m.tests.failed} ✗` : '—', sub: m.tests.runs ? 'includes baseline & repair re-runs' : 'none recorded', icon: 'flask', tip: m.tests.note }),
        metric({ label: 'Tokens used', value: m.tokens.total ? fmt.compact(m.tokens.total) : '—', sub: '30 days', icon: 'zap' }),
        metric({ label: 'Est. cost', value: m.cost.tasksWithKnownCost ? fmt.usd(m.cost.totalUsd) : 'unknown', sub: m.cost.tasksWithUnknownCost ? `${m.cost.tasksWithUnknownCost} task(s) without pricing` : m.cost.tasksWithKnownCost ? 'from configured pricing' : 'no pricing configured', icon: 'dollar' }),
        metric({ label: 'CPU · Memory', value: cur ? `${cur.cpuPct == null ? '—' : cur.cpuPct + '%'} · ${cur.memUsedPct}%` : '—', sub: 'live host reading', icon: 'cpu', tip: 'Measured by the agent process on its host; not a historical average' }));
    };
    async function loadMetrics() { try { metrics = DA.expect(await api(`/metrics?days=30${proj() ? `&project=${encodeURIComponent(proj())}` : ''}`), { totals: 'object', successRate: 'object', duration: 'object', tests: 'object', tokens: 'object', cost: 'object' }, 'metrics'); metricsErr = null; } catch (e) { metricsErr = e; } renderMetrics(); }
    const mp = DA.poll(loadMetrics, 30000); disposers.push(mp.stop, DA.on('project', () => mp.refresh()), DA.on('overview', renderMetrics), DA.on('health', renderMetrics));

    // current task + pipeline
    let ticker = null, watching = null, stream = null; const acts = [];
    const pushAct = (ev) => { const keep = ['stage', 'check', 'repair_start', 'git', 'sandbox', 'status', 'command_start', 'command_denied', 'edits_applied', 'edits_rejected', 'plan', 'analysis', 'error']; if (!keep.includes(ev.type)) return; acts.push(ev); while (acts.length > 8) acts.shift(); renderAct(); };
    const renderAct = () => DA.replace(actEl, acts.length ? h('ul', { class: 'act' }, [...acts].reverse().map((e) => h('li', { class: DA.eventSeverity(e) }, h('time', { class: 'mono muted' }, fmt.clock(e.t)), h('span', {}, DA.eventText(e))))) : empty(watching ? 'Waiting for events…' : 'No live task', 'Activity from the running task appears here.'));
    async function watch(id) {
      if (watching === id) return; stream && stream.stop(); stream = null; acts.length = 0; watching = id; renderAct(); if (!id) return;
      try { const meta = await api(`/tasks/${id}/events.json?from=0&limit=1`); const from = Math.max(0, meta.total - 60); const d = await api(`/tasks/${id}/events.json?from=${from}&limit=200`); d.events.forEach(pushAct); stream = DA.streamTask(id, { from: d.next, onEvent: pushAct }); } catch { /* shown as empty */ }
    }
    const renderLive = () => {
      const o = DA.state.overview; if (!o) { DA.replace(currentEl, skeleton(5)); return; }
      const t = o.running[0]; clearInterval(ticker); watch(t ? t.id : null);
      if (!t) { const last = o.recent[0]; DA.replace(pipeEl, last ? DA.pipeline(last.pipeline) : empty('No pipeline', 'The workflow stages of the current task appear here.')); DA.replace(currentEl, empty('The agent is idle', o.attention.length ? `${o.attention.length} item(s) need your attention.` : 'No tasks are running.', last ? h('p', { class: 'muted' }, 'Last task: ', h('a', { href: `#/tasks/${last.id}` }, last.request.slice(0, 80)), ' ', badge(last.status)) : null)); return; }
      const elapsed = h('span', { class: 'mono' }, fmt.duration(Date.now() - Date.parse(t.startedAt || t.createdAt))); ticker = setInterval(() => { elapsed.textContent = fmt.duration(Date.now() - Date.parse(t.startedAt || t.createdAt)); }, 1000); disposers.push(() => clearInterval(ticker));
      DA.replace(pipeEl, DA.pipeline(t.pipeline));
      DA.replace(currentEl, h('div', { class: 'cur' }, h('div', { class: 'cur-h' }, badge(t.status), h('span', { class: 'muted mono' }, t.id)), h('h3', { class: 'cur-t' }, t.request), h('dl', { class: 'kv' }, h('dt', {}, 'Project'), h('dd', {}, t.project), h('dt', {}, 'Stage'), h('dd', {}, t.stage), h('dt', {}, 'Started'), h('dd', {}, fmt.time(t.startedAt)), h('dt', {}, 'Elapsed'), h('dd', {}, elapsed), h('dt', {}, 'Operation'), h('dd', { class: 'mono' }, t.currentOperation ? t.currentOperation.argv.join(' ') : '—'), h('dt', {}, 'Repairs'), h('dd', {}, `${t.repairCount}${t.maxRepairs != null ? ` / ${t.maxRepairs}` : ''}`)), t.latestMessage && h('p', { class: 'latest' }, t.latestMessage), h('div', { class: 'prog' }, DA.progressBar(t.pipeline.percent), h('span', { class: 'muted' }, `${t.pipeline.completed} of ${t.pipeline.total} stages complete`)), h('div', { class: 'row' }, btn('View details', { kind: 'primary', icon: 'file', onClick: () => (location.hash = `#/tasks/${t.id}`) }), DA.taskActions(t, () => DA.refreshGlobal()))));
    };
    const renderAttn = () => { const o = DA.state.overview; if (!o) return DA.replace(attnEl, skeleton(3)); DA.replace(attnEl, o.attention.length ? h('ul', { class: 'attn' }, o.attention.map((t) => h('li', {}, badge(t.status), h('a', { href: `#/tasks/${t.id}` }, t.request.slice(0, 70)), h('div', { class: 'muted sm' }, t.outcome ? t.outcome.slice(0, 120) : fmt.ago(t.finishedAt || t.createdAt))))) : empty('All clear', 'No approvals, failures or interrupted tasks need attention.')); };
    const renderRes = () => { const hl = DA.state.health; if (!hl) return DA.replace(resEl, skeleton(3)); const r = hl.resources, c = r.current; const row = (label, pct, tone) => h('div', { class: 'res-r' }, h('span', {}, label), DA.progressBar(pct || 0, tone), h('span', { class: 'mono' }, pct == null ? '—' : `${pct}%`));
      DA.replace(resEl, row('CPU', c.cpuPct, c.cpuPct > 85 ? 'err' : ''), row('Memory', c.memUsedPct, c.memUsedPct > 90 ? 'err' : ''), c.disk && row('Disk (data dir)', c.disk.usedPct, c.disk.usedPct > 90 ? 'err' : ''), h('div', { class: 'muted sm' }, `Agent process: ${fmt.bytes(c.agentRssBytes)} RSS · ${r.cores} core(s) · load ${r.load1.toFixed(2)}`), DA.sparkline(r.history.map((s) => s.cpuPct), { label: 'CPU history' }), h('div', { class: 'muted sm' }, 'CPU history · ', r.historyNote)); };
    const rerender = () => { renderLive(); renderAttn(); renderRes(); };
    rerender(); disposers.push(DA.on('overview', () => { renderLive(); renderAttn(); }), DA.on('health', renderRes), DA.on('project', () => { loadMetrics(); }));
    return { el, dispose: () => { disposers.forEach((d) => d()); clearInterval(ticker); stream && stream.stop(); } };
  };

  // ---------- New task ----------
  DA.views.newTask = ({ query }) => {
    const el = h('div', { class: 'page narrow' }); const OTHER = '__other__';
    const sel = h('select', { id: 'f-proj', class: 'in', required: true }); const pathIn = h('input', { id: 'f-path', class: 'in', placeholder: '/absolute/path/to/repo (inside an allowed directory)', hidden: true });
    const type = h('select', { id: 'f-type', class: 'in' }, [['feature', 'Feature'], ['bugfix', 'Bug fix'], ['refactor', 'Refactor'], ['tests', 'Add tests']].map(([v, l]) => h('option', { value: v }, l)));
    const req = h('textarea', { id: 'f-req', class: 'in', rows: 5, placeholder: 'Describe the feature or bug. Include expected behaviour.', required: true, 'aria-describedby': 'req-err' }); const acc = h('textarea', { id: 'f-acc', class: 'in', rows: 3, placeholder: 'Optional: how will we know it works?' });
    const maxr = h('input', { id: 'f-max', class: 'in', type: 'number', min: 0, max: 20, placeholder: 'default' }); const errEl = h('div', { id: 'req-err', class: 'ferr', role: 'alert' }); const submit = btn('Start task', { kind: 'primary', icon: 'play', type: 'submit' }); const info = h('div', { class: 'ainfo' });
    const form = h('form', { class: 'form', novalidate: true }, h('div', { class: 'fld' }, h('label', { for: 'f-proj' }, 'Project'), sel, pathIn), info, h('div', { class: 'fld' }, h('label', { for: 'f-type' }, 'Task type'), type), h('div', { class: 'fld' }, h('label', { for: 'f-req' }, 'Request'), req), h('div', { class: 'fld' }, h('label', { for: 'f-acc' }, 'Acceptance criteria'), acc), h('div', { class: 'fld sm' }, h('label', { for: 'f-max' }, 'Max repair attempts'), maxr), errEl, h('div', { class: 'row' }, submit));
    DA.replace(el, h('div', { class: 'page-h' }, h('div', {}, h('h1', { tabindex: '-1' }, 'New task'), h('p', { class: 'muted' }, 'The agent works in an isolated Git worktree. Your branches and uncommitted work are never modified.'))), card(null, form));
    const chosen = () => (sel.value === OTHER ? pathIn.value.trim() : sel.value);
    async function analyze() {
      const p = chosen(); if (!p) return DA.replace(info); DA.replace(info, h('div', { class: 'muted' }, 'Analysing project…'));
      try { const a = await api('/projects/analyze', { method: 'POST', body: { path: p } }); const hl = DA.state.health;
        DA.replace(info, h('div', { class: 'ainfo-b' }, h('div', {}, 'Stack: ', a.stack.length ? a.stack.map((s) => h('span', { class: 'chip' }, s)) : 'unknown'), h('div', {}, 'Git: ', a.isGitRepo ? h('span', {}, `branch ${a.git.branch || '(detached)'}`, a.git.dirty ? h('span', { class: 'warn-t' }, ` · ${a.git.changes.length} uncommitted change(s) — preserved, but invisible to the agent (it works from the last commit)`) : ' · clean') : h('span', { class: 'err-t' }, 'not a Git repository — the agent will refuse')), h('div', {}, 'Verification: ', a.checks.length ? a.checks.map((c) => h('span', { class: 'chip' }, c.name)) : h('span', { class: 'warn-t' }, 'no commands detected — the result can only be “unverified”'), a.checks.some((c) => c.name === 'test') ? '' : a.checks.length ? h('span', { class: 'warn-t' }, ' (no test command)') : ''), hl && h('div', { class: 'muted sm' }, hl.sandbox.configured === 'docker' ? 'Commands run in the configured Docker sandbox.' : 'Sandbox: none — project scripts run directly on the host with the agent’s privileges.')));
      } catch (e) { DA.replace(info, h('div', { class: 'err-t' }, e.message)); }
    }
    api('/projects').then((d) => { const want = query.get('project') || proj(); DA.replace(sel, h('option', { value: '' }, 'Select a project…'), d.projects.map((p) => h('option', { value: p.path }, `${p.name} — ${p.path}`)), h('option', { value: OTHER }, 'Other path…')); if (want && d.projects.some((p) => p.path === want)) { sel.value = want; analyze(); } }).catch((e) => DA.replace(sel, h('option', { value: '' }, `Could not load projects: ${e.message}`), h('option', { value: OTHER }, 'Other path…')));
    sel.addEventListener('change', () => { pathIn.hidden = sel.value !== OTHER; analyze(); }); pathIn.addEventListener('change', analyze);
    let busy = false;
    form.addEventListener('submit', async (e) => { e.preventDefault(); if (busy) return; errEl.textContent = '';
      if (!chosen()) { errEl.textContent = 'Choose a project.'; return; } if (req.value.trim().length < 5) { errEl.textContent = 'The request must be at least 5 characters.'; req.focus(); return; }
      const body = { repoPath: chosen(), request: req.value.trim(), acceptance: acc.value.trim(), type: type.value }; if (maxr.value !== '') body.maxRepairs = Number(maxr.value);
      busy = true; submit.disabled = true; try { const r = await api('/tasks', { method: 'POST', body }); toast('Task started', 'ok'); DA.refreshGlobal(); location.hash = `#/tasks/${r.id}`; } catch (err) { errEl.textContent = err.message; toast(err.message, 'err'); } finally { busy = false; submit.disabled = false; } });
    return { el, dispose() {} };
  };

  // ---------- Tasks list ----------
  DA.views.tasks = ({ query }) => { const tt = DA.taskTable({ limit: 15, initialQuery: query.get('q') || '' }); const el = h('div', { class: 'page' }, h('div', { class: 'page-h' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Tasks'), h('p', { class: 'muted' }, `History for ${projName(proj())}. Results are loaded in pages.`)), btn('New task', { kind: 'primary', icon: 'plus', onClick: () => (location.hash = '#/new') })), card(null, tt.el)); const off = DA.on('project', () => tt.reload()); return { el, dispose() { tt.dispose(); off(); } }; };
})();
