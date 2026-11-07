/* Application shell: sidebar, top bar, router, global (de-duplicated) polling, connection status. */
(function () {
  'use strict';
  const DA = window.DA; const { h, api, fmt, icon, badge, btn } = DA; const st = DA.state;
  const NAV = [['overview', 'Overview', 'overview', ''], ['new', 'New Task', 'plus', 'new'], ['tasks', 'Tasks', 'tasks', 'tasks'], ['projects', 'Projects', 'folder', 'projects'], ['performance', 'Performance', 'chart', 'performance'], ['security', 'Security', 'shield', 'security'], ['settings', 'Settings', 'settings', 'settings']];
  const VIEW = { '': 'overview', new: 'newTask', tasks: 'tasks', projects: 'projects', performance: 'performance', security: 'security', settings: 'settings' };
  const TITLE = { '': 'Overview', new: 'New task', tasks: 'Tasks', projects: 'Projects', performance: 'Performance', security: 'Security', settings: 'Settings' };

  st.project = (() => { try { return localStorage.getItem('da.project') || ''; } catch { return ''; } })();
  DA.setProject = (p) => { st.project = p || ''; try { localStorage.setItem('da.project', st.project); } catch { /* storage unavailable */ } DA.emit('project', st.project); renderProjectSelect(); };
  let silent = null; DA.setHashSilently = (hash) => { silent = hash; location.hash = hash; };

  // ---------- shell ----------
  const navEls = new Map(); const sidebarHealth = h('div', { class: 'sb-health' }); const version = h('span', { class: 'muted sm' });
  const nav = h('nav', { 'aria-label': 'Primary' }, h('ul', {}, NAV.map(([key, label, ic, seg]) => { const a = h('a', { href: seg ? `#/${seg}` : '#/', class: 'nav-a' }, icon(ic, 17), h('span', {}, label)); navEls.set(seg, a); return h('li', {}, a); })));
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, h('div', { class: 'brand' }, h('svg:svg', { viewBox: '0 0 32 32', width: 30, height: 30, 'aria-hidden': 'true' }, h('svg:path', { d: 'M16 2l12 7v14l-12 7L4 23V9z', fill: 'none', stroke: '#3B82F6', 'stroke-width': 2 }), h('svg:path', { d: 'M11 16l3 3 7-7', fill: 'none', stroke: '#8B5CF6', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })), h('div', {}, h('div', { class: 'brand-n' }, 'DevAgent'), h('div', { class: 'muted sm' }, 'AI Coding Agent'))), nav, h('div', { class: 'sb-foot' }, sidebarHealth, version));

  const searchIn = h('input', { type: 'search', id: 'gsearch', class: 'in', placeholder: 'Search tasks and projects…  ( / )', 'aria-label': 'Search tasks and projects', autocomplete: 'off', 'aria-controls': 'gresults' }); const results = h('div', { class: 'dd', id: 'gresults', hidden: true, role: 'listbox' });
  const projectSel = h('select', { class: 'in', id: 'gproject', 'aria-label': 'Current project' }); const bellBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Notifications', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, icon('bell', 18)); const bellCount = h('span', { class: 'bell-n', hidden: true }); bellBtn.append(bellCount); const bellMenu = h('div', { class: 'dd right', hidden: true, role: 'menu' });
  const connChip = h('div', { class: 'conn', role: 'status', 'aria-live': 'polite' }); const hamburger = h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Toggle navigation', 'aria-controls': 'sidebar', 'aria-expanded': 'false' }, icon('menu', 20));
  const topbar = h('header', { class: 'topbar' }, hamburger, h('div', { class: 'search' }, icon('search', 15), searchIn, results), projectSel, connChip, h('div', { class: 'bell' }, bellBtn, bellMenu));
  const banner = h('div', { class: 'banner', hidden: true, role: 'alert' }); const main = h('main', { id: 'main', class: 'content' }); const scrim = h('div', { class: 'scrim', hidden: true });
  const shell = h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, topbar, banner, main), scrim);
  const closeNav = () => { sidebar.classList.remove('open'); scrim.hidden = true; hamburger.setAttribute('aria-expanded', 'false'); };
  hamburger.onclick = () => { const o = sidebar.classList.toggle('open'); scrim.hidden = !o; hamburger.setAttribute('aria-expanded', String(o)); }; scrim.onclick = closeNav; sidebar.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });

  // ---------- project selector ----------
  function renderProjectSelect() { DA.replace(projectSel, h('option', { value: '' }, 'All projects'), st.projects.map((p) => h('option', { value: p.path }, p.name)), st.project && !st.projects.some((p) => p.path === st.project) ? h('option', { value: st.project }, st.project.split('/').pop()) : null); projectSel.value = st.project; }
  projectSel.onchange = () => DA.setProject(projectSel.value);

  // ---------- connection status ----------
  function renderConn() {
    const c = st.conn; const stale = c.backend === 'ok' && c.lastOk && Date.now() - c.lastOk > 20000; const down = c.backend === 'down';
    DA.replace(connChip, h('span', { class: `cdot ${down ? 'err' : stale ? 'warn' : c.backend === 'ok' ? 'ok' : 'mute'}` }), h('span', { class: 'conn-t' }, down ? 'Backend disconnected' : stale ? 'Data may be stale' : c.backend === 'ok' ? 'Backend connected' : 'Connecting…'), c.stream !== 'idle' && h('span', { class: 'conn-s' }, `events ${c.stream}`));
    banner.hidden = !(down || c.auth === 'bad' || stale);
    DA.replace(banner, c.auth === 'bad' ? 'Unauthorized: the API token is issued per server start. Reload the page.' : down ? 'Cannot reach the DevAgent backend. Retrying automatically — what you see may be out of date.' : stale ? `No successful update for ${Math.round((Date.now() - c.lastOk) / 1000)}s — the data shown may be stale.` : '');
    const ok = c.backend === 'ok' && !down; DA.replace(sidebarHealth, h('span', { class: `cdot ${ok ? 'ok' : 'err'}` }), h('span', {}, ok ? 'Agent online' : 'Agent unreachable'), st.overview && ok ? h('span', { class: 'muted sm' }, ` · ${st.overview.running.length}/${st.overview.concurrency.max} running`) : null);
  }
  DA.on('conn', renderConn); setInterval(renderConn, 5000);

  // ---------- notifications (real attention items) ----------
  function renderBell() {
    const items = (st.overview && st.overview.attention) || []; bellCount.hidden = !items.length; bellCount.textContent = String(items.length); bellBtn.setAttribute('aria-label', `Notifications: ${items.length} item(s) need attention`);
    DA.replace(bellMenu, h('div', { class: 'dd-h' }, 'Needs attention'), items.length ? items.map((t) => h('a', { class: 'dd-i', href: `#/tasks/${t.id}`, role: 'menuitem', onClick: () => toggleBell(false) }, badge(t.status), h('span', {}, t.request.slice(0, 60)))) : h('div', { class: 'dd-e muted' }, 'Nothing needs your attention.'));
  }
  function toggleBell(open) { bellMenu.hidden = !open; bellBtn.setAttribute('aria-expanded', String(open)); }
  bellBtn.onclick = (e) => { e.stopPropagation(); toggleBell(bellMenu.hidden); };

  // ---------- global search ----------
  let sTimer = null, sSeq = 0;
  searchIn.addEventListener('input', () => { clearTimeout(sTimer); const q = searchIn.value.trim(); if (!q) { results.hidden = true; return; } sTimer = setTimeout(async () => { const my = ++sSeq; try { const d = await api(`/tasks?limit=5&q=${encodeURIComponent(q)}`); if (my !== sSeq) return; const pm = st.projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || p.path.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
    DA.replace(results, h('div', { class: 'dd-h' }, 'Tasks'), d.items.length ? d.items.map((t) => h('a', { class: 'dd-i', href: `#/tasks/${t.id}`, role: 'option', onClick: () => { results.hidden = true; } }, badge(t.status), h('span', {}, t.request.slice(0, 60)))) : h('div', { class: 'dd-e muted' }, 'No matching tasks'), h('div', { class: 'dd-h' }, 'Projects'), pm.length ? pm.map((p) => h('a', { class: 'dd-i', href: `#/projects?p=${encodeURIComponent(p.path)}`, role: 'option', onClick: () => { results.hidden = true; } }, icon('folder', 14), h('span', {}, p.name))) : h('div', { class: 'dd-e muted' }, 'No matching projects')); results.hidden = false; } catch { /* connection banner covers errors */ } }, 250); });
  searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && searchIn.value.trim()) { results.hidden = true; location.hash = `#/tasks?q=${encodeURIComponent(searchIn.value.trim())}`; } else if (e.key === 'Escape') { results.hidden = true; searchIn.blur(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; if (!e.target.closest('.bell')) toggleBell(false); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement && document.activeElement.tagName)) { e.preventDefault(); searchIn.focus(); } else if (e.key === 'Escape') toggleBell(false); });

  // ---------- global polling (single source for overview/health/projects: views subscribe, no duplicate requests) ----------
  const pOverview = DA.poll(async () => { try { st.overview = DA.expect(await api('/overview'), { running: 'array', attention: 'array', recent: 'array', concurrency: 'object' }, 'overview'); DA.emit('overview', st.overview); renderBell(); renderConn(); } catch (e) { /* conn state shows it */ } }, 5000);
  const pHealth = DA.poll(async () => { try { st.health = DA.expect(await api('/health'), { version: 'string', resources: 'object', sandbox: 'object', concurrency: 'object' }, 'health'); version.textContent = `v${st.health.version}`; DA.emit('health', st.health); } catch (e) { /* conn state shows it */ } }, 15000);
  const pProjects = DA.poll(async () => { try { st.projects = DA.expect(await api('/projects'), { projects: 'array' }, 'projects').projects; renderProjectSelect(); } catch (e) { /* ignore */ } }, 60000);
  DA.refreshGlobal = () => { pOverview.refresh(); pHealth.refresh(); };

  // ---------- router ----------
  let current = null; const mountView = () => {
    const raw = location.hash.replace(/^#/, '') || '/'; const [pathPart, qs] = raw.split('?'); const segs = pathPart.split('/').filter(Boolean); const key = segs[0] || ''; const query = new URLSearchParams(qs || '');
    for (const [seg, a] of navEls) { const on = seg === key; a.classList.toggle('active', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); }
    if (current && current.dispose) { try { current.dispose(); } catch (e) { console.error(e); } }
    const name = key === 'tasks' && segs[1] ? 'task' : VIEW[key]; document.title = `${key === 'tasks' && segs[1] ? 'Task' : TITLE[key] || 'Not found'} · DevAgent`;
    if (!name || !DA.views[name]) { current = null; DA.replace(main, DA.empty('Page not found', 'That page does not exist.', h('a', { href: '#/' }, 'Go to overview'))); return; }
    try { current = DA.views[name]({ params: segs.slice(1), query, nav: (x) => (location.hash = x) }); } catch (e) { console.error(e); current = null; DA.replace(main, DA.errorBox(e)); return; }
    DA.replace(main, current.el); const hd = main.querySelector('h1'); if (hd) hd.focus({ preventScroll: true }); main.scrollTop = 0; window.scrollTo && window.scrollTo(0, 0);
  };
  window.addEventListener('hashchange', () => { if (silent && location.hash === silent) { silent = null; return; } silent = null; mountView(); });

  DA.boot = () => { DA.replace(document.getElementById('app'), shell); renderProjectSelect(); renderConn(); renderBell(); mountView(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', DA.boot); else DA.boot();
})();
