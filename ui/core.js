/* DevAgent dashboard core: DOM helpers, API client, event stream, charts, shared components. No dependencies. */
(function () {
  'use strict';
  const DA = (window.DA = { state: { project: '', projects: [], health: null, overview: null, conn: { backend: 'unknown', stream: 'idle', lastOk: 0, auth: 'ok' } }, listeners: {} });

  // ---------- tiny pub/sub ----------
  DA.on = (e, fn) => { (DA.listeners[e] ||= new Set()).add(fn); return () => DA.listeners[e].delete(fn); };
  DA.emit = (e, d) => { for (const fn of [...(DA.listeners[e] || [])]) { try { fn(d); } catch (err) { console.error(err); } } };
  DA.setConn = (patch) => { const c = DA.state.conn; const before = JSON.stringify(c); Object.assign(c, patch); if (JSON.stringify(c) !== before) DA.emit('conn', c); };

  // ---------- DOM builder (never uses innerHTML: all data is inserted as text nodes) ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, props, ...kids) {
    const el = tag.startsWith('svg:') ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    append(el, kids); return el;
  }
  function append(el, kids) { for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); } return el; }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const replace = (el, ...kids) => append(clear(el), kids);
  DA.h = h; DA.clear = clear; DA.replace = replace;

  // ---------- icons ----------
  const ICONS = {
    overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z', plus: 'M12 5v14M5 12h14', tasks: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', pause: 'M8 5v14M16 5v14', play: 'M6 4l14 8-14 8z', x: 'M18 6L6 18M6 6l12 12',
    check: 'M20 6L9 17l-5-5', alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3',
    cpu: 'M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4', dollar: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', zap: 'M13 2L3 14h9l-1 8 10-12h-9z',
    download: 'M12 3v12M7 10l5 5 5-5M5 21h14', copy: 'M9 9h11v11H9zM5 15H4V4h11v1', chevR: 'M9 6l6 6-6 6', chevD: 'M6 9l6 6 6-6', file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', menu: 'M3 6h18M3 12h18M3 18h18', stop: 'M6 6h12v12H6z', terminal: 'M4 17l6-6-6-6M12 19h8', git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3', gauge: 'M12 14l4-4M3.3 17a10 10 0 1 1 17.4 0', circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  };
  DA.icon = (name, size = 16, cls = '') => h('svg:svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `ico ${cls}` }, h('svg:path', { d: ICONS[name] || ICONS.circle }));

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');
  DA.fmt = {
    duration(ms) { if (ms == null || !Number.isFinite(ms)) return '—'; if (ms < 1000) return `${Math.round(ms)}ms`; const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${pad(s % 60)}s`; const hr = Math.floor(m / 60); return `${hr}h ${pad(m % 60)}m`; },
    time(iso) { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(+d) ? '—' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
    clock(iso) { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
    num(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); },
    compact(n) { if (n == null) return '—'; const a = Math.abs(n); return a >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); },
    usd(n) { return n == null ? 'unknown' : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`; },
    pct(v, d = 0) { return v == null ? '—' : `${(v * 100).toFixed(d)}%`; },
    bytes(n) { if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; },
    ago(iso) { if (!iso) return '—'; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; },
  };

  // ---------- API client ----------
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  DA.ApiError = ApiError;
  DA.api = async function api(path, { method = 'GET', body, signal } = {}) {
    let res;
    const headers = { 'x-agent-token': window.DA_TOKEN };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    try { res = await fetch('/api' + path, { method, headers, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined, signal }); }
    catch (e) { if (e && e.name === 'AbortError') throw e; DA.setConn({ backend: 'down' }); throw new ApiError(0, 'Cannot reach the DevAgent backend'); }
    DA.setConn({ backend: 'ok', lastOk: Date.now(), auth: res.status === 401 ? 'bad' : 'ok' });
    let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText || `HTTP ${res.status}`);
    return data;
  };
  /** Lightweight response validation: throws if required fields have the wrong type, so a schema drift is a visible error, not a blank page. */
  DA.expect = (data, spec, what) => {
    for (const [k, t] of Object.entries(spec)) { const v = data && data[k]; const ok = t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' : t === 'any' ? v !== undefined : typeof v === t; if (!ok) throw new ApiError(0, `Unexpected ${what} response: field "${k}" is not ${t}`); }
    return data;
  };
  DA.download = async (path, filename) => {
    const res = await fetch('/api' + path, { headers: { 'x-agent-token': window.DA_TOKEN } });
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error || m; } catch { /* */ } throw new ApiError(res.status, m); }
    DA.saveBlob(await res.blob(), filename);
  };
  DA.saveBlob = (blob, filename) => { const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); };

  // ---------- polling (no overlapping requests, pauses while the tab is hidden) ----------
  DA.poll = (fn, ms) => {
    let timer = null, busy = false, stopped = false;
    const tick = async () => { if (stopped || busy) return; if (document.hidden) return; busy = true; try { await fn(); } catch (e) { /* surfaced by the caller */ } finally { busy = false; } };
    timer = setInterval(tick, ms); const onVis = () => { if (!document.hidden) tick(); }; document.addEventListener('visibilitychange', onVis); tick();
    return { refresh: tick, stop() { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); } };
  };

  // ---------- event stream: fetch-based SSE (supports auth header), dedupe by seq, bounded reconnect backoff ----------
  DA.streamTask = (id, { from = 0, onEvent, onState }) => {
    let last = from - 1, stopped = false, ctrl = null, attempt = 0, timer = null;
    const state = (s) => { DA.setConn({ stream: s }); onState && onState(s); };
    async function run() {
      if (stopped) return; ctrl = new AbortController(); let watchdog = null;
      try {
        state(attempt ? 'reconnecting' : 'connecting');
        const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/events`, { headers: { 'x-agent-token': window.DA_TOKEN, ...(last >= 0 ? { 'last-event-id': String(last) } : {}) }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        attempt = 0; state('live'); const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), 45000); }; arm(); // server heartbeats every 20s
        for (;;) {
          const { value, done } = await reader.read(); if (done) break; arm(); buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2); const m = /(?:^|\n)data: (.*)/s.exec(block); if (!m) continue;
            let ev; try { ev = JSON.parse(m[1]); } catch { continue; }
            if (typeof ev.seq === 'number' && ev.seq >= 0) { if (ev.seq <= last) continue; last = ev.seq; } // drop duplicates
            onEvent(ev);
          }
        }
      } catch (e) { /* fall through to reconnect */ } finally { clearTimeout(watchdog); }
      if (stopped) return; attempt++; state('reconnecting');
      timer = setTimeout(run, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4));
    }
    run();
    return { stop() { stopped = true; clearTimeout(timer); try { ctrl && ctrl.abort(); } catch { /* */ } DA.setConn({ stream: 'idle' }); }, lastSeq: () => last };
  };

  // ---------- components ----------
  const STATUS = { passed: ['Passed', 'ok'], failed: ['Failed', 'err'], running: ['Running', 'info'], queued: ['Queued', 'mute'], paused: ['Paused', 'warn'], unverified: ['Unverified', 'warn'], needs_approval: ['Needs approval', 'warn'], needs_input: ['Needs input', 'warn'], cancelled: ['Cancelled', 'mute'], interrupted: ['Interrupted', 'warn'], completed: ['Completed', 'ok'], pending: ['Pending', 'mute'], blocked: ['Blocked', 'warn'], warning: ['Unverified', 'warn'] };
  DA.badge = (status, label) => { const [t, tone] = STATUS[status] || [status, 'mute']; return h('span', { class: `badge ${tone}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label || t); };
  DA.card = (title, body, { actions, cls = '', id } = {}) => h('section', { class: `card ${cls}`, id, 'aria-label': typeof title === 'string' ? title : undefined }, (title || actions) && h('header', { class: 'card-h' }, h('h2', {}, title), actions && h('div', { class: 'card-a' }, actions)), h('div', { class: 'card-b' }, body));
  DA.metric = ({ label, value, sub, icon, tone = '', tip }) => h('div', { class: `metric ${tone}`, title: tip || '' }, h('div', { class: 'metric-i' }, DA.icon(icon || 'gauge', 18)), h('div', { class: 'metric-t' }, h('div', { class: 'metric-l' }, label), h('div', { class: 'metric-v' }, value), sub && h('div', { class: 'metric-s' }, sub)));
  DA.skeleton = (rows = 3) => h('div', { class: 'skel', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: rows }, (_, i) => h('div', { class: 'skel-r', style: `width:${90 - i * 12}%` })));
  DA.empty = (title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'empty-t' }, title), text && h('p', {}, text), action);
  DA.errorBox = (err, retry) => h('div', { class: 'errbox', role: 'alert' }, DA.icon('alert', 18), h('div', {}, h('strong', {}, err && err.status === 401 ? 'Unauthorized' : 'Could not load data'), h('div', { class: 'muted' }, err && err.message ? err.message : String(err))), retry && h('button', { class: 'btn sm', onClick: retry }, 'Retry'));
  DA.btn = (label, { onClick, kind = '', icon, title, disabled, type = 'button' } = {}) => h('button', { class: `btn ${kind}`, type, onClick, title, disabled }, icon && DA.icon(icon, 15), label && h('span', {}, label));
  DA.toast = (msg, kind = 'info') => { const host = document.getElementById('toasts'); if (!host) return; const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg); host.append(t); setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000); };
  DA.confirm = ({ title, text, confirmLabel = 'Confirm', danger = false, details = [] }) => new Promise((resolve) => {
    const prev = document.activeElement; const ok = DA.btn(confirmLabel, { kind: danger ? 'danger' : 'primary' }); const cancel = DA.btn('Back', {});
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' }, h('h3', { id: 'dlg-t' }, title), h('p', {}, text), details.length ? h('ul', { class: 'dlg-list' }, details.map((d) => h('li', {}, d))) : null, h('div', { class: 'dlg-a' }, cancel, ok));
    const overlay = h('div', { class: 'overlay' }, dlg); const done = (v) => { overlay.remove(); document.removeEventListener('keydown', key, true); prev && prev.focus && prev.focus(); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Tab') { const f = [cancel, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + 2) % 2].focus(); } };
    ok.addEventListener('click', () => done(true)); cancel.addEventListener('click', () => done(false)); overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', key, true); document.body.append(overlay); cancel.focus();
  });
  DA.tabs = (items, { active, onChange, label = 'Sections' }) => {
    const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label });
    const btns = items.map((it) => { const b = h('button', { class: 'tab', role: 'tab', id: `tab-${it.key}`, 'aria-selected': String(it.key === active), 'aria-controls': 'tabpanel', tabindex: it.key === active ? '0' : '-1', type: 'button', onClick: () => onChange(it.key) }, it.icon && DA.icon(it.icon, 14), it.label, it.badge != null && h('span', { class: 'tab-n' }, it.badge)); return b; });
    list.addEventListener('keydown', (e) => { const i = btns.indexOf(document.activeElement); if (i < 0) return; let n = null; if (e.key === 'ArrowRight') n = (i + 1) % btns.length; else if (e.key === 'ArrowLeft') n = (i - 1 + btns.length) % btns.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = btns.length - 1; if (n != null) { e.preventDefault(); btns[n].focus(); onChange(items[n].key, true); } });
    append(list, btns); return list;
  };
  DA.pipeline = (p, { horizontal = false } = {}) => h('ol', { class: `pipeline ${horizontal ? 'h' : ''}`, 'aria-label': 'Task pipeline' }, p.steps.map((s, i) => h('li', { class: `step ${s.state}`, 'aria-label': `${s.label}: ${(STATUS[s.state] || [s.state])[0]}` }, h('span', { class: 'step-i' }, s.state === 'completed' ? DA.icon('check', 12) : s.state === 'failed' ? DA.icon('x', 12) : s.state === 'blocked' || s.state === 'warning' ? DA.icon('alert', 12) : s.state === 'running' ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : String(i + 1)), h('span', { class: 'step-t' }, h('span', { class: 'step-n' }, s.label), h('span', { class: 'step-s' }, (STATUS[s.state] || [s.state])[0])))));
  DA.progressBar = (pct, tone = '') => h('div', { class: `bar ${tone}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
  DA.copyText = async (text) => { try { await navigator.clipboard.writeText(text); DA.toast('Copied to clipboard', 'ok'); } catch { DA.toast('Copy is not available in this browser context', 'err'); } };

  // ---------- charts (inline SVG; no library) ----------
  const COL = { blue: '#3B82F6', green: '#22C55E', amber: '#F59E0B', red: '#EF4444', violet: '#8B5CF6', grid: '#253650', text: '#94A6BF' };
  DA.COL = COL;
  const S = (tag, attrs, ...kids) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  /** Stacked vertical bars. data: [{label, parts:[{key,value}]}], series: [{key,label,color}] */
  DA.stackedBars = ({ data, series, unit = '', height = 190, label, integer = false }) => {
    const W = 560, H = height, L = 40, B = 22, T = 8, R = 6; const totals = data.map((d) => d.parts.reduce((a, p) => a + p.value, 0)); const top = Math.max(...totals, 0); const max = integer ? Math.max(4, Math.ceil(top / 4) * 4) : niceMax(top); const bw = (W - L - R) / Math.max(1, data.length);
    const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': label });
    for (let i = 0; i <= 4; i++) { const y = T + ((H - T - B) * (4 - i)) / 4; svg.append(S('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: COL.grid, 'stroke-width': 1 }), S('text', { x: L - 6, y: y + 3, 'text-anchor': 'end', fill: COL.text, 'font-size': 10 }, DA.fmt.compact((max * i) / 4))); }
    const step = Math.max(1, Math.ceil(data.length / 8));
    data.forEach((d, i) => { let y = H - B; const g = S('g', { class: 'bar-g' }); const tip = `${d.label}: ${d.parts.map((p) => `${p.value}${unit ? ' ' + unit : ''} ${series.find((s) => s.key === p.key)?.label || p.key}`).join(', ')}`; g.append(S('title', {}, tip));
      for (const p of d.parts) { const hgt = ((H - T - B) * p.value) / max; if (hgt <= 0) continue; y -= hgt; g.append(S('rect', { x: L + i * bw + bw * 0.15, y, width: bw * 0.7, height: hgt, fill: series.find((s) => s.key === p.key)?.color || COL.blue, rx: 2 })); }
      svg.append(g); if (i % step === 0) svg.append(S('text', { x: L + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle', fill: COL.text, 'font-size': 10 }, d.label.slice(5)));
    });
    return h('div', { class: 'chart-w' }, svg, h('ul', { class: 'legend' }, series.map((s) => h('li', {}, h('i', { style: `background:${s.color}` }), s.label))));
  };
  /** Horizontal bars. items: [{label, value, text, color}] */
  DA.hbars = (items, { label } = {}) => { const max = Math.max(...items.map((i) => i.value), 1e-9); return h('ul', { class: 'hbars', 'aria-label': label }, items.map((i) => h('li', { title: `${i.label}: ${i.text}` }, h('span', { class: 'hb-l' }, i.label), h('span', { class: 'hb-t' }, h('span', { style: `width:${(100 * i.value) / max}%;background:${i.color || COL.blue}` })), h('span', { class: 'hb-v' }, i.text)))); };
  DA.sparkline = (values, { color = COL.blue, height = 40, max = 100, label } = {}) => {
    const W = 200; const svg = S('svg', { viewBox: `0 0 ${W} ${height}`, class: 'spark', role: 'img', 'aria-label': label || 'trend', preserveAspectRatio: 'none' }); const v = values.filter((x) => x != null);
    if (v.length < 2) return h('div', { class: 'muted sm' }, 'collecting samples…');
    const pts = v.map((y, i) => `${((W * i) / (v.length - 1)).toFixed(1)},${(height - (height - 3) * (Math.min(y, max) / max) - 1).toFixed(1)}`).join(' ');
    svg.append(S('polyline', { points: `0,${height} ${pts} ${W},${height}`, fill: color, 'fill-opacity': 0.15, stroke: 'none' }), S('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' })); return svg;
  };
  DA.lineChart = ({ data, color = COL.blue, unit = '', height = 170, label, fmtY = DA.fmt.compact }) => {
    const W = 560, H = height, L = 44, B = 22, T = 8, R = 26; const max = niceMax(Math.max(...data.map((d) => d.value), 0)); const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': label });
    for (let i = 0; i <= 4; i++) { const y = T + ((H - T - B) * (4 - i)) / 4; svg.append(S('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: COL.grid }), S('text', { x: L - 6, y: y + 3, 'text-anchor': 'end', fill: COL.text, 'font-size': 10 }, fmtY((max * i) / 4))); }
    const px = (i) => L + ((W - L - R) * i) / Math.max(1, data.length - 1); const py = (v) => H - B - ((H - T - B) * v) / max;
    if (data.length > 1) svg.append(S('polyline', { points: data.map((d, i) => `${px(i)},${py(d.value)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2 }));
    data.forEach((d, i) => { const c = S('circle', { cx: px(i), cy: py(d.value), r: 3.5, fill: color, tabindex: '0' }); c.append(S('title', {}, `${d.label}: ${d.value}${unit ? ' ' + unit : ''}`)); svg.append(c); });
    const step = Math.max(1, Math.ceil(data.length / 8)); data.forEach((d, i) => { if (i % step === 0) svg.append(S('text', { x: px(i), y: H - 6, 'text-anchor': 'middle', fill: COL.text, 'font-size': 10 }, d.label.slice(5))); });
    return h('div', { class: 'chart-w' }, svg);
  };

  // ---------- diff parsing (used for the Code Changes tab) ----------
  DA.parseDiff = (text) => {
    const files = []; let f = null, hunk = null, o = 0, n = 0;
    for (const line of String(text || '').split('\n')) {
      if (line.startsWith('diff --git ')) { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line); f = { path: m ? m[2] : line.slice(11), status: 'M', add: 0, del: 0, hunks: [], binary: false }; files.push(f); hunk = null; continue; }
      if (!f) continue;
      if (line.startsWith('new file mode')) f.status = 'A'; else if (line.startsWith('deleted file mode')) f.status = 'D'; else if (line.startsWith('Binary files')) f.binary = true;
      else if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename ')) continue;
      else if (line.startsWith('@@')) { const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line); o = m ? +m[1] : 0; n = m ? +m[2] : 0; hunk = { header: line, lines: [] }; f.hunks.push(hunk); }
      else if (hunk) { if (line.startsWith('+')) { f.add++; hunk.lines.push({ t: 'add', n: n++, text: line.slice(1) }); } else if (line.startsWith('-')) { f.del++; hunk.lines.push({ t: 'del', o: o++, text: line.slice(1) }); } else if (line.startsWith('\\')) continue; else hunk.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) }); }
    }
    return files;
  };
  const KW = /\b(const|let|var|function|return|if|else|for|while|import|export|from|default|class|new|async|await|try|catch|throw|def|in|is|not|and|or|None|True|False|true|false|null|undefined|interface|type|extends)\b/g;
  /** Minimal, safe syntax highlighting: builds spans from text (no innerHTML). */
  DA.highlight = (code, lang) => {
    const frag = document.createDocumentFragment(); const re = lang === 'json' ? /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+\.?\d*)/g : lang === 'markdown' || lang === 'text' ? null : /(\/\/.*|#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|default|class|new|async|await|try|catch|throw|def|in|is|not|and|or|None|True|False|true|false|null|undefined|interface|type|extends)\b|(\b\d+\.?\d*\b)/g;
    if (!re) { frag.append(document.createTextNode(code)); return frag; }
    let last = 0, m; while ((m = re.exec(code))) { if (m.index > last) frag.append(document.createTextNode(code.slice(last, m.index))); const cls = lang === 'json' ? (m[1] ? (m[2] ? 'tk-key' : 'tk-str') : m[3] ? 'tk-kw' : 'tk-num') : m[1] ? 'tk-com' : m[2] ? 'tk-str' : m[3] ? 'tk-kw' : 'tk-num'; frag.append(h('span', { class: cls }, m[0])); last = m.index + m[0].length; if (m[0].length === 0) re.lastIndex++; }
    if (last < code.length) frag.append(document.createTextNode(code.slice(last))); return frag;
  };
  DA.eventSeverity = (e) => (e.type === 'error' || e.type === 'command_denied' || (e.type === 'check' && !e.passed) || (e.type === 'command_end' && (e.exitCode !== 0 || e.timedOut)) || (e.type === 'status' && ['failed', 'cancelled'].includes(e.status)) || e.type === 'edits_rejected' ? 'error' : ['repair_start', 'repair_duplicate', 'provider_retry', 'context_shrink', 'model_parse_error', 'truncated'].includes(e.type) || (e.type === 'status' && ['needs_approval', 'paused', 'interrupted', 'needs_input'].includes(e.status)) ? 'warn' : 'info');
  DA.eventText = (e) => {
    const a = (x) => (Array.isArray(x) ? x.join(' ') : String(x ?? ''));
    switch (e.type) {
      case 'stage': return `Stage: ${e.stage}`; case 'status': return `Status: ${e.status}${e.outcome ? ` — ${e.outcome}` : ''}`; case 'command_start': return `$ ${a(e.argv)}`; case 'command_end': return `exit ${e.exitCode}${e.timedOut ? ' (timed out)' : ''} · ${DA.fmt.duration(e.durationMs)} · ${a(e.argv)}`;
      case 'command_denied': return `Blocked by policy: ${a(e.argv)} — ${e.reason}`; case 'check': return `${e.name} ${e.passed ? 'passed' : 'FAILED'} [${e.phase}]${e.summary ? ` — ${String(e.summary).split('\n')[0]}` : ''}`; case 'repair_start': return `Repair attempt ${e.n}/${e.max} for ${e.check} (${e.classification})`;
      case 'edits_applied': return `Applied edits: ${(e.changes || []).map((c) => `${c.op} ${c.path}`).join(', ') || 'none (already applied)'}`; case 'edits_rejected': return `Edits rejected: ${a(e.errors)}`; case 'plan': return `Plan ready: ${e.plan && e.plan.summary ? e.plan.summary : ''}`;
      case 'analysis': return `Analysed repository: ${a(e.stack)}; checks: ${a(e.checks)}`; case 'git': case 'sandbox': return e.message || e.type; case 'model_response': return `Model response (${e.role}, ${e.chars} chars)`; case 'model_parse_error': return `Model output was not valid JSON (${e.role})`;
      case 'provider_retry': return `Provider retry ${e.attempt} in ${e.delayMs}ms: ${e.reason}`; case 'truncated': return e.message; case 'error': return `Error: ${e.message}`; case 'edits_recovered': return `Recovered interrupted edit (${e.applied} applied, ${e.alreadyApplied} already present)`; default: return e.type;
    }
  };
})();
