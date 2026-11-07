/* Views B: dedicated task monitoring page. */
(function () {
  'use strict';
  const DA = window.DA; const { h, api, fmt, icon, badge, card, btn, skeleton, empty, errorBox, toast } = DA;
  const MAX_EVENTS = 5000, MAX_LINES = 4000, RENDER_STEP = 300;

  /** Terminal model: groups command_start / output / command_end events into blocks. Output is already redacted by the backend. */
  class Terminal {
    constructor() { this.blocks = []; this.lines = 0; this.dropped = 0; this.q = ''; this.stream = 'all'; this.follow = true; this.host = null; }
    open() { for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].exit == null && !this.blocks[i].denied) return this.blocks[i]; return null; }
    add(ev) {
      if (ev.type === 'command_start') { const b = { argv: ev.argv, check: ev.check, t: ev.t, lines: [], exit: null, el: null, body: null, partial: {} }; this.blocks.push(b); this.mount(b); }
      else if (ev.type === 'output') { let b = this.open(); if (!b) { b = { argv: ['(output)'], t: ev.t, lines: [], exit: null, partial: {} }; this.blocks.push(b); this.mount(b); } this.out(b, ev.stream, ev.chunk); }
      else if (ev.type === 'command_end') { const b = this.open(); if (b) { b.exit = ev.exitCode; b.ms = ev.durationMs; b.timedOut = ev.timedOut; this.head(b); } }
      else if (ev.type === 'command_denied') { const b = { argv: ev.argv, t: ev.t, lines: [{ s: 'stderr', text: `BLOCKED by policy: ${ev.reason}` }], exit: 126, denied: true, partial: {} }; this.lines++; this.blocks.push(b); this.mount(b); }
    }
    out(b, stream, chunk) {
      const parts = String(chunk).split('\n'); const carry = b.partial[stream] || ''; parts[0] = carry + parts[0]; b.partial[stream] = parts.pop(); // last piece is an unfinished line
      for (const text of parts) this.pushLine(b, stream, text);
      if (b.partial[stream] && b.partial[stream].length > 4000) { this.pushLine(b, stream, b.partial[stream]); b.partial[stream] = ''; }
    }
    pushLine(b, s, text) { const ln = { s, text }; b.lines.push(ln); this.lines++; if (b.body) { const e = this.lineEl(ln); b.body.append(e); ln.el = e; this.scroll(); } if (this.lines > MAX_LINES) this.trim(); }
    trim() { while (this.lines > MAX_LINES && this.blocks.length) { const b = this.blocks[0]; if (b.lines.length) { const l = b.lines.shift(); l.el && l.el.remove(); this.lines--; this.dropped++; } else if (b.exit != null && this.blocks.length > 1) { b.el && b.el.remove(); this.blocks.shift(); } else break; } this.note(); }
    note() { if (this.noteEl) this.noteEl.textContent = this.dropped ? `Showing the most recent ${MAX_LINES} lines (${this.dropped} older lines dropped from the live buffer — download the event log for everything).` : ''; }
    visible(l) { return (this.stream === 'all' || l.s === this.stream) && (!this.q || l.text.toLowerCase().includes(this.q)); }
    lineEl(l) { return h('div', { class: `ln ${l.s === 'stderr' ? 'err' : 'out'}`, hidden: !this.visible(l) || null }, l.text || ' '); }
    head(b) { if (!b.headEl) return; DA.replace(b.headEl, h('span', { class: 'mono cmd' }, `$ ${b.argv.join(' ')}`), b.exit == null ? h('span', { class: 'badge info' }, h('span', { class: 'dot' }), 'running') : h('span', { class: `badge ${b.exit === 0 ? 'ok' : 'err'}` }, h('span', { class: 'dot' }), b.timedOut ? 'timed out' : `exit ${b.exit}`), b.ms != null && h('span', { class: 'muted sm' }, fmt.duration(b.ms)), h('span', { class: 'muted sm' }, fmt.clock(b.t))); }
    mount(b) { if (!this.host) return; b.headEl = h('div', { class: 'tb-h' }); b.body = h('div', { class: 'tb-b' }); b.el = h('div', { class: 'tblock' }, b.headEl, b.body); this.head(b); for (const l of b.lines) { l.el = this.lineEl(l); b.body.append(l.el); } this.host.append(b.el); this.scroll(); }
    attach(host, noteEl) { this.host = host; this.noteEl = noteEl; DA.clear(host); for (const b of this.blocks) this.mount(b); this.note(); }
    detach() { this.host = null; for (const b of this.blocks) { b.el = b.body = b.headEl = null; for (const l of b.lines) l.el = null; } }
    refilter() { for (const b of this.blocks) for (const l of b.lines) if (l.el) l.el.hidden = !this.visible(l); }
    scroll() { if (this.follow && this.host && this.host.parentNode) this.host.parentNode.scrollTop = this.host.parentNode.scrollHeight; }
    text(onlyVisible = true) { return this.blocks.map((b) => [`$ ${b.argv.join(' ')}`, ...b.lines.filter((l) => !onlyVisible || this.visible(l)).map((l) => (l.s === 'stderr' ? '[stderr] ' : '') + l.text), b.exit != null ? `[exit ${b.exit}${b.timedOut ? ', timed out' : ''}]` : ''].join('\n')).join('\n\n'); }
  }

  DA.views.task = ({ params, nav }) => {
    const id = decodeURIComponent(params[0] || ''); let tab = ['overview', 'events', 'terminal', 'changes', 'tests', 'report'].includes(params[1]) ? params[1] : 'overview';
    const root = h('div', { class: 'page' }); const headEl = h('div', {}); const tabsEl = h('div', {}); const panelEl = h('div', { id: 'tabpanel', role: 'tabpanel', tabindex: '0', 'aria-labelledby': `tab-${tab}` });
    DA.replace(root, headEl, tabsEl, panelEl);
    let task = null, events = [], baseSeq = 0, totalAtLoad = 0, stream = null, offOverview = null, panel = null, disposed = false, refreshTimer = null; const seen = new Set(); const term = new Terminal();

    const stageTimeline = () => { const st = events.filter((e) => e.type === 'stage'); return st.map((e, i) => ({ stage: e.stage, t: e.t, ms: Date.parse((st[i + 1] && st[i + 1].t) || task.finishedAt || new Date().toISOString()) - Date.parse(e.t) })); };

    async function refreshTask() { try { const t = DA.expect(await api(`/tasks/${encodeURIComponent(id)}`), { id: 'string', status: 'string', pipeline: 'object' }, 'task'); task = t; renderHead(); panel && panel.onTask && panel.onTask(); } catch (e) { if (!task) DA.replace(panelEl, e.status === 404 ? empty('Task not found', `No task with id “${id}”.`, h('a', { href: '#/tasks' }, 'Back to tasks')) : errorBox(e, init)); } }
    const scheduleRefresh = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; if (!disposed) refreshTask(); }, 500); };

    function renderHead() {
      DA.replace(headEl, h('div', { class: 'page-h' }, h('div', {}, h('a', { href: '#/tasks', class: 'lnk back' }, '← Tasks'), h('h1', { tabindex: '-1', class: 'task-title' }, task.request), h('div', { class: 'row meta' }, badge(task.status), h('span', { class: 'muted mono' }, task.id), h('span', { class: 'muted' }, task.project), task.branch && h('span', { class: 'muted mono' }, task.branch), h('span', { class: 'muted' }, `stage: ${task.stage}`), h('span', { class: 'muted' }, `duration ${fmt.duration(task.durationMs)}`)), task.outcome && h('p', { class: 'outcome' }, task.outcome)), h('div', { class: 'row' }, DA.taskActions(task, refreshTask))));
      const counts = { events: events.filter((e) => e.type !== 'output').length, changes: task.filesChanged ? task.filesChanged.length : null, tests: (task.checkRuns || []).length };
      const items = [{ key: 'overview', label: 'Overview', icon: 'overview' }, { key: 'events', label: 'Live events', icon: 'zap', badge: counts.events }, { key: 'terminal', label: 'Terminal', icon: 'terminal' }, { key: 'changes', label: 'Code changes', icon: 'git', badge: counts.changes }, { key: 'tests', label: 'Test results', icon: 'flask', badge: counts.tests }, { key: 'report', label: 'Report', icon: 'file' }];
      DA.replace(tabsEl, DA.tabs(items, { active: tab, label: 'Task sections', onChange: (k, focusKept) => { if (k === tab) return; tab = k; DA.setHashSilently(`#/tasks/${encodeURIComponent(id)}/${k}`); renderHead(); showTab(); if (focusKept) { const b = document.getElementById(`tab-${k}`); b && b.focus(); } } }));
      panelEl.setAttribute('aria-labelledby', `tab-${tab}`);
    }

    function ingest(ev) {
      if (typeof ev.seq === 'number' && ev.seq >= 0) { if (seen.has(ev.seq)) return; seen.add(ev.seq); }
      events.push(ev); if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      term.add(ev); panel && panel.onEvent && panel.onEvent(ev);
      if (['stage', 'status', 'check', 'repair_start', 'edits_applied', 'plan', 'git', 'command_end'].includes(ev.type)) scheduleRefresh();
    }

    // ---------- tabs ----------
    const sevDot = (e) => h('span', { class: `sev ${DA.eventSeverity(e)}`, title: DA.eventSeverity(e) });
    const tabs = {
      overview() {
        const el = h('div', { class: 'grid g-2' }); const build = () => {
          const t = task; const tl = stageTimeline(); const u = t.usage;
          DA.replace(el,
            card('Pipeline', h('div', {}, DA.pipeline(t.pipeline), h('div', { class: 'prog' }, DA.progressBar(t.pipeline.percent), h('span', { class: 'muted' }, `${t.pipeline.completed}/${t.pipeline.total} stages`)))),
            card('Outcome', h('div', {}, h('div', {}, badge(t.status)), h('p', {}, t.outcome || (t.running ? 'In progress…' : 'No outcome recorded.')), t.blockers.length ? h('div', {}, h('h4', {}, 'Blockers'), h('ul', { class: 'ul' }, t.blockers.map((b) => h('li', {}, String(b).slice(0, 400))))) : null, t.approvalRequired && t.approvalRequired.length ? h('div', {}, h('h4', {}, 'Needs approval'), h('ul', { class: 'ul' }, t.approvalRequired.map((b) => h('li', {}, b)))) : null, t.nextSteps && t.nextSteps.length ? h('div', {}, h('h4', {}, 'Recommended next steps'), h('ul', { class: 'ul' }, t.nextSteps.map((b) => h('li', {}, b)))) : null)),
            card('Plan', t.plan ? h('div', {}, h('p', {}, t.plan.summary), h('ol', { class: 'ul' }, t.plan.steps.map((s) => h('li', {}, s))), t.assumptions.length ? h('div', {}, h('h4', {}, 'Assumptions stated by the model'), h('ul', { class: 'ul' }, t.assumptions.map((a) => h('li', {}, a)))) : null, h('p', { class: 'muted sm' }, 'AI-generated plan. Individual steps are not tracked as separate states by the backend.')) : empty('No plan yet', 'The plan appears after the planning stage.')),
            card('Execution timeline', tl.length ? h('ul', { class: 'tl' }, tl.map((s) => h('li', {}, h('span', {}, s.stage), h('span', { class: 'mono muted' }, fmt.duration(s.ms)), h('span', { class: 'muted sm' }, fmt.clock(s.t))))) : empty('No stage events loaded', 'Stage timings are derived from recorded events.')),
            card('Repair attempts', t.repairs.length ? h('ul', { class: 'ul' }, t.repairs.map((r) => h('li', {}, h('strong', {}, `#${r.n} ${r.check}`), ` [${r.classification || r.category || '?'}] → ${r.outcome}`, r.editPaths && r.editPaths.length ? h('div', { class: 'muted sm mono' }, r.editPaths.join(', ')) : null, r.diagnosis ? h('div', { class: 'muted sm' }, `AI diagnosis: ${r.diagnosis}`) : null))) : empty('No repairs', t.repairCount ? '' : 'Verification did not need any repair attempts.')),
            card('Model usage', u && u.calls ? h('div', {}, h('dl', { class: 'kv' }, h('dt', {}, 'Calls'), h('dd', {}, u.calls), h('dt', {}, 'Tokens in / out'), h('dd', {}, `${fmt.num(u.inputTokens)} / ${fmt.num(u.outputTokens)}`), h('dt', {}, 'Estimated cost'), h('dd', {}, fmt.usd(u.estimatedUsd))), u.byRole && Object.keys(u.byRole).length ? DA.hbars(Object.entries(u.byRole).map(([r, v]) => ({ label: r, value: v.inputTokens + v.outputTokens, text: `${fmt.compact(v.inputTokens + v.outputTokens)} tok`, color: DA.COL.violet }))) : null) : empty('No model calls recorded', 'Usage appears once the agent has called the model.')));
        }; build(); return { el, onTask: build, onEvent: (e) => { if (e.type === 'stage') build(); } };
      },

      events() {
        let sev = 'all', stage = 'all', q = '', shown = RENDER_STEP; const list = h('ol', { class: 'evl', 'aria-live': 'off' }); const more = h('div', { class: 'row c' }); const count = h('span', { class: 'muted sm' });
        const selSev = h('select', { class: 'in', 'aria-label': 'Severity' }, ['all', 'info', 'warn', 'error'].map((s) => h('option', { value: s }, s === 'all' ? 'All severities' : s))); const selStage = h('select', { class: 'in', 'aria-label': 'Stage' });
        const search = h('input', { type: 'search', class: 'in', placeholder: 'Search events…', 'aria-label': 'Search events' });
        const stageOf = (i) => { for (let k = i; k >= 0; k--) { if (events[k].stage) return events[k].stage; } return ''; };
        const match = (e) => e.type !== 'output' && e.type !== 'model_response' && (sev === 'all' || DA.eventSeverity(e) === sev) && (stage === 'all' || e.stage === stage) && (!q || DA.eventText(e).toLowerCase().includes(q));
        const row = (e) => h('li', { class: `ev ${DA.eventSeverity(e)}` }, h('time', { class: 'mono muted' }, fmt.clock(e.t)), sevDot(e), h('span', { class: 'chip sm' }, e.stage || '—'), h('span', { class: 'ev-t' }, DA.eventText(e)));
        const fill = () => { const m = events.filter(match); const slice = m.slice(-shown); DA.replace(list, slice.map(row)); count.textContent = `${slice.length} of ${m.length} matching events${baseSeq ? ` · earlier ${baseSeq} events not loaded` : ''}`; DA.replace(more, m.length > shown ? btn(`Show ${Math.min(RENDER_STEP, m.length - shown)} earlier`, { onClick: () => { shown += RENDER_STEP; fill(); } }) : null); const stages = [...new Set(events.map((e) => e.stage).filter(Boolean))]; if (selStage.options.length !== stages.length + 1) DA.replace(selStage, h('option', { value: 'all' }, 'All stages'), stages.map((s) => h('option', { value: s }, s))); selStage.value = stage; };
        selSev.onchange = () => { sev = selSev.value; shown = RENDER_STEP; fill(); }; selStage.onchange = () => { stage = selStage.value; shown = RENDER_STEP; fill(); }; search.oninput = () => { q = search.value.toLowerCase(); shown = RENDER_STEP; fill(); };
        const el = h('div', {}, h('div', { class: 'filters' }, h('label', { class: 'srch' }, icon('search', 14), search), selSev, selStage, count), card(null, h('div', {}, events.length ? list : empty('No events yet', 'Events appear as the agent works.'), more))); fill();
        return { el, onEvent: (e) => { if (match(e)) { const wasBottom = true; list.append(row(e)); while (list.children.length > shown + 50) list.firstChild.remove(); if (wasBottom && list.parentNode) list.parentNode.scrollTop = list.parentNode.scrollHeight; } } };
      },

      terminal() {
        const host = h('div', { class: 'term-host' }); const scroller = h('div', { class: 'term', tabindex: '0', 'aria-label': 'Command output', role: 'log' }, host); const noteEl = h('div', { class: 'muted sm' });
        const search = h('input', { type: 'search', class: 'in', placeholder: 'Filter output…', 'aria-label': 'Filter output' }); const streamSel = h('select', { class: 'in', 'aria-label': 'Stream' }, [['all', 'stdout + stderr'], ['stdout', 'stdout only'], ['stderr', 'stderr only']].map(([v, l]) => h('option', { value: v }, l)));
        const follow = h('input', { type: 'checkbox', id: 'follow', checked: term.follow }); search.value = term.q;
        search.oninput = () => { term.q = search.value.toLowerCase(); term.refilter(); }; streamSel.onchange = () => { term.stream = streamSel.value; term.refilter(); };
        follow.onchange = () => { term.follow = follow.checked; if (term.follow) term.scroll(); }; scroller.addEventListener('scroll', () => { const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24; if (!atBottom && term.follow) { term.follow = false; follow.checked = false; } });
        const el = h('div', {}, h('div', { class: 'filters' }, h('label', { class: 'srch' }, icon('search', 14), search), streamSel, h('label', { class: 'chk', for: 'follow' }, follow, 'Follow output'), btn('Copy', { icon: 'copy', onClick: () => DA.copyText(term.text()) }), btn('Download log', { icon: 'download', onClick: () => DA.saveBlob(new Blob([term.text(false)], { type: 'text/plain' }), `${id}-terminal.log`) }), btn('Full event log', { icon: 'download', title: 'events.jsonl from the backend (everything, including older events)', onClick: () => DA.download(`/tasks/${encodeURIComponent(id)}/artifact?name=events.jsonl`, `${id}-events.jsonl`).catch((e) => toast(e.message, 'err')) })), noteEl, term.blocks.length ? null : empty('No command output yet', 'Output from lint, tests, builds and other commands appears here with exit codes and durations. Secrets are redacted by the backend.'), scroller);
        term.attach(host, noteEl); const emptyEl = el.querySelector('.empty'); if (emptyEl) { const t0 = term.blocks.length; const iv = setInterval(() => { if (term.blocks.length > t0 && emptyEl.parentNode) emptyEl.remove(); }, 500); return { el, dispose: () => { clearInterval(iv); term.detach(); } }; }
        return { el, dispose: () => term.detach() };
      },

      changes() {
        const el = h('div', {}); let files = [], sel = 0, mode = 'unified', loadedFor = '';
        const origin = () => { const m = new Map(); for (const e of task.edits || []) for (const c of e.changes || []) m.set(c.path, c.op); return m; };
        const isGen = (p) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|dist\/|build\/|.*\.min\.(js|css))/.test(p);
        const render = () => {
          if (!files.length) return DA.replace(el, empty(task.running ? 'No changes yet' : 'No code changes', task.running ? 'Edits appear once the implementation stage applies them.' : 'This task produced no file changes.'));
          const org = origin(); const f = files[Math.min(sel, files.length - 1)];
          const list = h('ul', { class: 'files', 'aria-label': 'Changed files' }, files.map((x, i) => h('li', {}, h('button', { class: `fbtn ${i === sel ? 'on' : ''}`, type: 'button', 'aria-current': i === sel ? 'true' : null, onClick: () => { sel = i; render(); } }, h('span', { class: `fs ${x.status}` }, x.status), h('span', { class: 'fp' }, x.path), h('span', { class: 'fd' }, h('b', { class: 'ad' }, `+${x.add}`), ' ', h('b', { class: 'de' }, `−${x.del}`))))));
          const totals = files.reduce((a, x) => ({ a: a.a + x.add, d: a.d + x.del }), { a: 0, d: 0 });
          DA.replace(el, h('div', { class: 'diffwrap' }, card(`${files.length} file(s) · +${totals.a} −${totals.d}`, list, { cls: 'flist' }), card(null, h('div', {}, h('div', { class: 'row sp' }, h('div', {}, h('strong', { class: 'mono' }, f.path), ' ', org.has(f.path) ? h('span', { class: 'chip sm' }, `agent ${org.get(f.path)}d`.replace('modifyd', 'modified').replace('createdd', 'created')) : null, isGen(f.path) ? h('span', { class: 'chip sm warn' }, 'generated') : null), h('div', { class: 'seg', role: 'group', 'aria-label': 'Diff view' }, ['unified', 'split'].map((m) => h('button', { type: 'button', class: m === mode ? 'on' : '', 'aria-pressed': String(m === mode), onClick: () => { mode = m; render(); } }, m)))), f.binary ? empty('Binary file', 'No text diff available.') : f.hunks.length ? h('div', { class: 'diff', role: 'region', 'aria-label': `Diff of ${f.path}`, tabindex: '0' }, f.hunks.map((hk) => hk.lines.length ? diffHunk(hk, mode) : null)) : empty('No textual changes', 'Mode or rename only.'), h('p', { class: 'muted sm' }, 'This is the real git diff against the base commit; secret-shaped values are redacted.')), { cls: 'fview' })));
        };
        const diffHunk = (hk, m) => { const ln = (cls, o, n, sign, text) => h('div', { class: `dl ${cls}` }, h('span', { class: 'no' }, o ?? ''), h('span', { class: 'no' }, n ?? ''), h('span', { class: 'sg' }, sign), h('span', { class: 'tx' }, text));
          if (m === 'unified') return h('div', { class: 'hunk' }, h('div', { class: 'hh' }, hk.header), hk.lines.map((l) => ln(l.t, l.o, l.n, l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ', l.text)));
          const rows = []; let dels = [], adds = []; const flush = () => { const n = Math.max(dels.length, adds.length); for (let i = 0; i < n; i++) rows.push([dels[i], adds[i]]); dels = []; adds = []; };
          for (const l of hk.lines) { if (l.t === 'del') dels.push(l); else if (l.t === 'add') adds.push(l); else { flush(); rows.push([l, l]); } } flush();
          const side = (l, cls, num) => h('div', { class: `sd ${l ? cls : 'empty-s'}` }, h('span', { class: 'no' }, l ? num : ''), h('span', { class: 'tx' }, l ? l.text : ''));
          return h('div', { class: 'hunk split' }, h('div', { class: 'hh' }, hk.header), rows.map(([a, b]) => h('div', { class: 'srow' }, side(a, a && a.t === 'del' ? 'del' : 'ctx', a && a.o), side(b, b && b.t === 'add' ? 'add' : 'ctx', b && b.n)))); };
        const load = async () => { try { const d = await api(`/tasks/${encodeURIComponent(id)}/diff`); files = DA.parseDiff(d.diff); } catch (e) { return DA.replace(el, errorBox(e, load)); } render(); };
        DA.replace(el, skeleton(5)); load(); return { el, onEvent: (e) => { if (e.type === 'edits_applied') load(); }, onTask: () => { if (task.status !== 'running' && loadedFor !== task.status) { loadedFor = task.status; load(); } } };
      },

      tests() {
        const el = h('div', {}); const build = () => {
          const t = task; const runs = t.checkRuns || []; const dc = t.detectedCommands || {}; const verified = t.status === 'passed' && t.finalVerification && t.finalVerification.allPassed && t.finalVerification.results.some((r) => r.category === 'tests');
          const verdict = verified ? ['ok', 'VERIFIED', 'All detected checks passed and automated tests ran (evidence below).'] : t.status === 'unverified' ? ['warn', 'UNVERIFIED', 'Checks that ran passed, but no automated tests ran, so correctness is not proven.'] : t.status === 'failed' ? ['err', 'FAILED', 'Verification did not succeed. See the failing checks below.'] : t.running ? ['info', 'IN PROGRESS', 'Checks are still running or not yet started.'] : ['mute', t.status.toUpperCase().replace('_', ' '), 'No final verification verdict is available for this state.'];
          const names = [['lint', 'Lint'], ['typecheck', 'Type check'], ['test', 'Tests'], ['build', 'Build'], ['e2e', 'End-to-end']];
          DA.replace(el, h('div', { class: `verdict ${verdict[0]}` }, h('strong', {}, verdict[1]), h('span', {}, verdict[2])),
            h('div', { class: 'grid g-2' }, card('Checks available in this project', h('table', { class: 'tbl sm' }, h('tbody', {}, names.map(([k, l]) => { const ran = runs.some((r) => r.name === k); return h('tr', {}, h('td', {}, l), h('td', { class: 'mono' }, dc[k] ? dc[k].join(' ') : h('span', { class: 'muted' }, 'not detected')), h('td', {}, !dc[k] ? badge('pending', 'not run') : ran ? (() => { const last = [...runs].reverse().find((r) => r.name === k); return badge(last.passed ? 'passed' : 'failed'); })() : badge('pending', t.running ? 'pending' : 'not run'))); })))), card('Baseline (before any change)', t.baseline ? h('p', {}, t.baseline.allPassed === true ? 'All checks passed before the change.' : t.baseline.allPassed === false ? `“${t.baseline.failedCheck}” was already failing before the change.` : 'No verification commands were available.') : empty('Not run yet', ''))),
            card(`Check runs (${runs.length})`, runs.length ? h('div', { class: 'tbl-w' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Check', 'Phase', 'Exit', 'Duration', 'Result', 'Details'].map((c) => h('th', { scope: 'col' }, c)))), h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'muted' }, r.phase), h('td', { class: 'mono' }, r.exitCode), h('td', {}, fmt.duration(r.durationMs)), h('td', {}, badge(r.passed ? 'passed' : 'failed', r.timedOut ? 'timed out' : null)), h('td', {}, r.failure ? h('details', {}, h('summary', {}, `${r.classification || 'failure'} · fingerprint ${r.fingerprint}`), h('pre', { class: 'pre sm' }, r.failure.summary || '(no summary)'), r.failure.files && r.failure.files.length ? h('div', { class: 'muted sm mono' }, r.failure.files.map((f) => `${f.file}:${f.line}`).join('  ')) : null) : h('span', { class: 'muted' }, '—'))))))) : empty('No checks have run', 'Results appear as soon as verification commands finish.')),
            h('p', { class: 'muted sm' }, 'Counts are verification check runs (lint, tests, build…), not individual test cases. Full command output is in the Terminal tab.'));
        }; build(); return { el, onTask: build };
      },

      report() {
        const el = h('div', {}); const ARTS = [['report.md', 'Report'], ['changes.patch', 'Patch'], ['pr-description.md', 'PR description'], ['events.jsonl', 'Event log'], ['task.json', 'Task state']];
        const build = () => DA.replace(el, card('Downloads', h('div', { class: 'row' }, ARTS.map(([n, l]) => btn(l, { icon: 'download', onClick: () => DA.download(`/tasks/${encodeURIComponent(id)}/artifact?name=${n}`, `${id}-${n}`).catch((e) => toast(e.status === 404 ? `${l} is not generated yet` : e.message, e.status === 404 ? 'info' : 'err')) })))), card('Final report', task.report ? h('pre', { class: 'pre report' }, task.report) : empty('Report not generated yet', 'The report is written when the task finishes (or stops).')));
        build(); return { el, onTask: build };
      },
    };

    function showTab() { panel && panel.dispose && panel.dispose(); panel = tabs[tab](); DA.replace(panelEl, panel.el); }

    const isActive = () => task && (task.running || ['queued', 'running', 'paused'].includes(task.status));
    const startStream = () => { if (stream || disposed) return; const last = events.length ? (events[events.length - 1].seq ?? -1) + 1 : 0; stream = DA.streamTask(id, { from: last, onEvent: ingest }); };
    async function init() {
      DA.replace(panelEl, skeleton(6)); await refreshTask(); if (!task) return;
      try { const meta = await api(`/tasks/${encodeURIComponent(id)}/events.json?from=0&limit=1`); totalAtLoad = meta.total; baseSeq = Math.max(0, meta.total - 2000); const d = await api(`/tasks/${encodeURIComponent(id)}/events.json?from=${baseSeq}&limit=2000`); for (const e of d.events) { if (typeof e.seq === 'number') seen.add(e.seq); events.push(e); term.add(e); } if (isActive()) startStream(); } catch (e) { toast(`Could not load events: ${e.message}`, 'err'); }
      offOverview = DA.on('overview', (o) => { if (!stream && o.running.some((t) => t.id === id)) { refreshTask(); startStream(); } else if (stream && task && !isActive() && !o.running.some((t) => t.id === id)) { stream.stop(); stream = null; } });
      renderHead(); showTab();
    }
    init();
    return { el: root, dispose() { disposed = true; offOverview && offOverview(); clearTimeout(refreshTimer); stream && stream.stop(); panel && panel.dispose && panel.dispose(); } };
  };
})();
