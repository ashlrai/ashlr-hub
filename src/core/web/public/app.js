/**
 * app.js — ashlr-hub local web dashboard SPA
 *
 * Vanilla JS, no framework, no CDN, no external deps.
 * Runs entirely in the browser against the local API served by startServer().
 *
 * Views (hash-routed):
 *   #overview  — DashboardSnapshot cards
 *   #runs      — RunState table + dispatch panel (M32)
 *   #swarms    — SwarmRun list + DAG graph + live burndown
 *   #pulse     — ActivityRollup SVG bar charts
 *   #genome    — GenomeEntry search + list
 *   #portfolio — PortfolioSummary org-level view (read-only; M29)
 *   #inbox     — Pending proposals list + approve/reject (M32)
 *   #daemon    — Daemon state card (M32)
 *
 * Live updates via EventSource('/api/events') — patches runs + swarms +
 * inbox + daemon views.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIEWS = ['control', 'fleet-activity', 'overview', 'runs', 'swarms', 'pulse', 'genome', 'portfolio', 'inbox', 'daemon', 'fleet'];
const DEFAULT_VIEW = 'control';
const API_BASE = '';  // same origin

// sessionStorage key for the session token (never localStorage, never URL).
const TOKEN_STORAGE_KEY = 'ashlr-token';

// Status -> color map (matches brand palette from styles.css)
const STATUS_COLOR = {
  // Run / Swarm lifecycle
  running:  '#4ade80',   // green
  done:     '#60a5fa',   // blue
  failed:   '#f87171',   // red
  aborted:  '#fbbf24',   // amber
  planning: '#a78bfa',   // purple
  // Task-level
  pending:  '#6b7280',   // gray
  skipped:  '#9ca3af',   // light gray
};

// Swarm phase -> column index for DAG layout
const PHASE_ORDER = { scaffold: 0, build: 1, integrate: 2, verify: 3, review: 4 };

// ---------------------------------------------------------------------------
// Tiny reactive state
// ---------------------------------------------------------------------------

const state = {
  snapshot: null,
  runs: [],
  swarms: [],
  currentSwarm: null,
  pulse: null,
  genome: [],
  genomeQuery: '',
  portfolio: null,   // M29: read-only org-level PortfolioSummary | null
  // M32: inbox + daemon
  inbox: { pending: 0, proposals: [] },
  inboxDetail: null,        // currently-open Proposal (full, with diff)
  daemon: null,             // DaemonState | null
  fleet: null,              // M49: FleetStatus | null
  control: null,            // M61: GET /api/control composite view
  controlInterval: null,    // M61: 4s polling timer
  fleetActivity: null,      // M90: GET /api/fleet-activity
  fleetActivityInterval: null, // M90: polling timer
  fleetActivityLoading: false,
  inboxBadge: 0,            // pending count from SSE, drives nav badge
  loading: {},   // viewName -> boolean
  error: {},     // viewName -> string | null
  activeView: DEFAULT_VIEW,
  eventSource: null,
  // M32: estimate debounce timer
  _estimateTimer: null,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'cls') { e.className = v; }
    else if (k.startsWith('on')) { e.addEventListener(k.slice(2).toLowerCase(), v); }
    else { e.setAttribute(k, v); }
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function svgEl(tag, attrs = {}, ...children) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function fmt(n, decimals = 2) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return n.toFixed(decimals);
}

function fmtK(n) {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function fmtRelative(iso) {
  if (!iso) return '—';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return iso; }
}

function statusBadge(status) {
  const color = STATUS_COLOR[status] ?? '#9ca3af';
  return el('span', { cls: 'badge', style: `background:${color}20;color:${color};border:1px solid ${color}40` }, status ?? '—');
}

function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const wrap = el('div', { cls: 'progress-track' });
  const fill = el('div', { cls: 'progress-fill', style: `width:${pct}%` });
  wrap.appendChild(fill);
  return el('div', { cls: 'progress-wrap' },
    wrap,
    el('span', { cls: 'progress-label' }, `${done}/${total}`)
  );
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function apiFetch(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// Token-authenticated POST. Returns parsed JSON or throws with message.
async function apiPost(path, token) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ashlr-token': token,
    },
    body: '{}',
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

// ---------------------------------------------------------------------------
// Token management (sessionStorage only — never localStorage, never URL)
// ---------------------------------------------------------------------------

function getToken() {
  try { return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ''; } catch { return ''; }
}

function setToken(t) {
  try { sessionStorage.setItem(TOKEN_STORAGE_KEY, t); } catch {}
}

function clearToken() {
  try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
}

// Prompt user for token and store it; returns the entered value (may be empty).
function promptToken() {
  const current = getToken();
  const entered = window.prompt(
    'Enter the ashlr session token printed by the server at startup.\n' +
    'It is stored in sessionStorage only (cleared when the tab closes).\n\n' +
    (current ? 'Current token is set. Leave blank to clear it.' : 'No token is set yet.'),
    current
  );
  if (entered === null) return current; // cancelled
  const trimmed = entered.trim();
  if (trimmed) { setToken(trimmed); } else { clearToken(); }
  updateTokenIndicator();
  return trimmed;
}

// Update the subtle token indicator in the nav bar.
function updateTokenIndicator() {
  const el_ = document.getElementById('token-indicator');
  if (!el_) return;
  const hasToken = Boolean(getToken());
  el_.title = hasToken ? 'Session token is set (click to change)' : 'No session token — click to enter';
  el_.classList.toggle('token-indicator--set', hasToken);
}

// ---------------------------------------------------------------------------
// HTML escaping (for untrusted diff text rendered in <pre>)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// EventSource — live updates
// ---------------------------------------------------------------------------

function connectSSE() {
  if (state.eventSource) return;
  try {
    const es = new EventSource('/api/events');
    state.eventSource = es;

    es.addEventListener('snapshot', (e) => {
      try { state.snapshot = JSON.parse(e.data); renderActiveView(); } catch {}
    });
    es.addEventListener('runs', (e) => {
      try { state.runs = JSON.parse(e.data); if (state.activeView === 'runs') renderRuns(); } catch {}
    });
    es.addEventListener('swarms', (e) => {
      try {
        state.swarms = JSON.parse(e.data);
        if (state.activeView === 'swarms') renderSwarms();
        // Also refresh overview swarm cards
        if (state.activeView === 'overview' && state.snapshot) renderOverview();
      } catch {}
    });
    // M32: live inbox state — update badge and, if viewing inbox, re-render
    es.addEventListener('inbox', (e) => {
      try {
        const data = JSON.parse(e.data);
        state.inbox = data;
        state.inboxBadge = data.pending ?? 0;
        updateInboxBadge();
        if (state.activeView === 'inbox') renderInbox();
      } catch {}
    });
    // M32: live daemon state
    es.addEventListener('daemon', (e) => {
      try {
        state.daemon = JSON.parse(e.data);
        if (state.activeView === 'daemon') renderDaemon();
        // M61: control view picks up daemon events
        if (state.activeView === 'control') loadControl();
      } catch {}
    });
    // M90: fleet-activity liveness ping — update tick indicator + refresh if on view
    es.addEventListener('fleet-activity-ping', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (state.fleetActivity) {
          state.fleetActivity._ping = data;
        }
        if (state.activeView === 'fleet-activity') renderFleetActivity();
      } catch {}
    });
    es.addEventListener('error', () => {
      // Silently tolerate — browser will auto-reconnect or server is stopping
    });
  } catch {
    // EventSource not available or server not yet up — silent
  }
}

// Update the pending-count badge on the Inbox nav link.
function updateInboxBadge() {
  const badge = document.getElementById('inbox-nav-badge');
  if (!badge) return;
  const n = state.inboxBadge;
  badge.textContent = n > 0 ? String(n > 99 ? '99+' : n) : '';
  badge.hidden = n === 0;
}

function disconnectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

// Close the live stream cleanly when the page is unloaded so the server's
// SSE connection (and its poll timer) is released promptly.
window.addEventListener('beforeunload', disconnectSSE);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function getView() {
  const h = location.hash.replace('#', '').trim();
  return VIEWS.includes(h) ? h : DEFAULT_VIEW;
}

function navigate(view) {
  location.hash = view;
}

async function onHashChange() {
  const view = getView();
  state.activeView = view;
  setActiveNav(view);
  renderActiveView();
  await loadView(view);
}

function renderActiveView() {
  const view = state.activeView;
  if (view === 'control') renderControl();
  if (view === 'fleet-activity') renderFleetActivity();
  else if (view === 'overview') renderOverview();
  else if (view === 'runs') renderRuns();
  else if (view === 'swarms') renderSwarms();
  else if (view === 'pulse') renderPulse();
  else if (view === 'genome') renderGenome();
  else if (view === 'portfolio') renderPortfolio();
  else if (view === 'inbox') renderInbox();
  else if (view === 'daemon') renderDaemon();
  else if (view === 'fleet') renderFleet();
}

async function loadView(view) {
  // Stop control polling when navigating away
  if (view !== 'control' && state.controlInterval) {
    clearInterval(state.controlInterval);
    state.controlInterval = null;
  }
  // Stop fleet-activity polling when navigating away
  if (view !== 'fleet-activity' && state.fleetActivityInterval) {
    clearInterval(state.fleetActivityInterval);
    state.fleetActivityInterval = null;
  }
  if (view === 'control') await loadControl();
  else if (view === 'fleet-activity') await loadFleetActivity();
  else if (view === 'overview') await loadOverview();
  else if (view === 'runs') await loadRuns();
  else if (view === 'swarms') await loadSwarms();
  else if (view === 'pulse') await loadPulse();
  else if (view === 'genome') await loadGenome();
  else if (view === 'portfolio') await loadPortfolio();
  else if (view === 'inbox') await loadInbox();
  else if (view === 'daemon') await loadDaemon();
  else if (view === 'fleet') await loadFleet();
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function setActiveNav(view) {
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === view);
  });
}

// ---------------------------------------------------------------------------
// Shell: render the skeleton (called once on DOMContentLoaded)
// ---------------------------------------------------------------------------

function renderShell() {
  document.body.innerHTML = '';

  // Nav icons per view (inline SVG path data)
  const VIEW_ICONS = {
    control:   '<rect x="1" y="1" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><line x1="4" y1="13" x2="12" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="10" x2="8" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="5" cy="5.5" r="1.3" fill="currentColor" opacity=".9"/><circle cx="8" cy="5.5" r="1.3" fill="currentColor" opacity=".6"/><circle cx="11" cy="5.5" r="1.3" fill="currentColor" opacity=".35"/>',
    overview:  '<rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity=".85"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity=".55"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity=".55"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity=".3"/>',
    runs:      '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><polyline points="5.5,8 7.5,10 10.5,6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    swarms:    '<circle cx="8" cy="3" r="2" fill="currentColor" opacity=".9"/><circle cx="3" cy="13" r="2" fill="currentColor" opacity=".7"/><circle cx="13" cy="13" r="2" fill="currentColor" opacity=".7"/><line x1="8" y1="5" x2="3" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="8" y1="5" x2="13" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="3" y1="13" x2="13" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    pulse:     '<polyline points="1,8 4,8 5.5,3 7,13 8.5,6 10,10 11.5,8 15,8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    genome:    '<path d="M5,1 Q8,4 5,7 Q8,10 5,13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M11,1 Q8,4 11,7 Q8,10 11,13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><line x1="6.5" y1="3.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6" y1="7" x2="10" y2="7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6.5" y1="10.5" x2="9.5" y2="10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    portfolio: '<rect x="1.5" y="9" width="3" height="5.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="6.5" y="5" width="3" height="9.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="11.5" y="2" width="3" height="12.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/>',
    inbox:     '<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><polyline points="1.5,5 8,9.5 14.5,5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    daemon:    '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="8" y1="4.5" x2="8" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="8" x2="11" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  };

  // Build nav links, including inbox badge
  const navLinks = VIEWS.map((v) => {
    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('width', '14');
    iconSvg.setAttribute('height', '14');
    iconSvg.setAttribute('viewBox', '0 0 16 16');
    iconSvg.setAttribute('fill', 'none');
    iconSvg.setAttribute('aria-hidden', 'true');
    iconSvg.innerHTML = VIEW_ICONS[v] ?? '';

    const VIEW_LABELS = { control: 'Mission Control', 'fleet-activity': 'Fleet Activity' };
    const labelText = VIEW_LABELS[v] ?? (v.charAt(0).toUpperCase() + v.slice(1));
    const label = document.createTextNode(labelText);
    const a = el('a', { cls: `nav-link${v === 'control' ? ' nav-link--control' : ''}`, href: `#${v}`, 'data-view': v });
    a.appendChild(iconSvg);
    a.appendChild(label);

    // Inbox pending badge
    if (v === 'inbox') {
      const badge = el('span', { cls: 'nav-inbox-badge', id: 'inbox-nav-badge', 'aria-label': 'pending proposals' });
      badge.hidden = true;
      a.appendChild(badge);
    }
    return a;
  });

  // Token button (gear icon in nav footer)
  const tokenBtn = el('button', {
    cls: 'token-btn',
    id: 'token-indicator',
    title: 'No session token — click to enter',
    type: 'button',
    onClick: () => { promptToken(); },
  });
  // gear SVG
  const gearSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  gearSvg.setAttribute('width', '14'); gearSvg.setAttribute('height', '14');
  gearSvg.setAttribute('viewBox', '0 0 16 16'); gearSvg.setAttribute('fill', 'none');
  gearSvg.setAttribute('aria-hidden', 'true');
  gearSvg.innerHTML = '<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.22 3.22l1.06 1.06M11.72 11.72l1.06 1.06M12.78 3.22l-1.06 1.06M4.28 11.72l-1.06 1.06" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
  tokenBtn.appendChild(gearSvg);
  tokenBtn.appendChild(document.createTextNode(' Token'));

  // Top nav
  const nav = el('nav', { cls: 'topnav' },
    el('div', { cls: 'nav-brand' },
      el('span', { cls: 'brand-icon' }, '⬡'),
      el('span', { cls: 'brand-name' }, 'ashlr hub')
    ),
    el('div', { cls: 'nav-links' }, ...navLinks),
    el('div', { cls: 'nav-status' },
      el('span', { cls: 'sse-dot', id: 'sse-dot', title: 'Live stream' }),
      tokenBtn
    )
  );

  const main = el('main', { cls: 'main', id: 'main' });
  document.body.appendChild(nav);
  document.body.appendChild(main);
  updateTokenIndicator();
}

function getMain() {
  return document.getElementById('main');
}

// ---------------------------------------------------------------------------
// Loading / error helpers
// ---------------------------------------------------------------------------

function showLoading(view) {
  if (state.activeView !== view) return;
  const main = getMain();
  if (main) main.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><p>Loading…</p></div>';
}

function showError(view, msg) {
  if (state.activeView !== view) return;
  const main = getMain();
  if (main) {
    main.innerHTML = '';
    main.appendChild(el('div', { cls: 'error-wrap' },
      el('p', { cls: 'error-msg' }, `⚠ ${msg}`),
      el('button', { cls: 'btn', onClick: () => loadView(view) }, 'Retry')
    ));
  }
}

// ---------------------------------------------------------------------------
// Overview view
// ---------------------------------------------------------------------------

async function loadOverview() {
  showLoading('overview');
  try {
    state.snapshot = await apiFetch('/api/snapshot');
    renderOverview();
  } catch (err) {
    showError('overview', err.message);
  }
}

function renderOverview() {
  if (state.activeView !== 'overview') return;
  const s = state.snapshot;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  if (!s) {
    main.appendChild(el('div', { cls: 'loading-wrap' }, el('p', {}, 'No data yet.')));
    return;
  }

  const section = el('section', { cls: 'view-section' });

  // Header
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Overview'),
    el('span', { cls: 'view-subtitle' }, `Updated ${fmtRelative(s.generatedAt)}`)
  ));

  // Metric cards row
  const cards = el('div', { cls: 'cards-row' });
  cards.appendChild(metricCard('Repos', s.repos.total, `${s.repos.dirty} dirty · ${s.repos.stale} stale`, '#60a5fa'));
  cards.appendChild(metricCard('Sessions (7d)', s.activity.sessions, `${fmtK(s.activity.tokens)} tokens`, '#4ade80'));
  cards.appendChild(metricCard('Cost (7d)', `$${fmt(s.activity.estCostUsd)}`, `${s.activity.commits} commits`, '#fbbf24'));
  cards.appendChild(metricCard('Tools', s.tools.installed, `of ${s.tools.total} detected`, '#a78bfa'));
  cards.appendChild(metricCard('Genome', s.genome.entries, `${s.genome.projects} projects`, '#34d399'));
  section.appendChild(cards);

  // Recent Runs
  if (s.runs && s.runs.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Recent Runs'));
    const table = buildRunsTable(s.runs);
    section.appendChild(table);
  }

  // Active Swarms
  if (s.swarms && s.swarms.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Active Swarms'));
    const grid = el('div', { cls: 'swarms-grid' });
    for (const sw of s.swarms) {
      grid.appendChild(swarmCard(sw));
    }
    section.appendChild(grid);
  }

  // MCP servers
  if (s.mcp && s.mcp.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'MCP Servers'));
    const pills = el('div', { cls: 'mcp-pills' });
    for (const m of s.mcp) {
      pills.appendChild(el('span', {
        cls: `mcp-pill ${m.ok ? 'ok' : 'fail'}`,
        title: `${m.tools} tools`
      }, m.name));
    }
    section.appendChild(pills);
  }

  main.appendChild(section);
}

function metricCard(label, value, sub, accent = '#60a5fa') {
  return el('div', { cls: 'metric-card', style: `--accent:${accent}` },
    el('div', { cls: 'metric-value' }, String(value)),
    el('div', { cls: 'metric-label' }, label),
    el('div', { cls: 'metric-sub' }, sub)
  );
}

function swarmCard(sw) {
  const card = el('div', { cls: 'swarm-card' });
  card.appendChild(el('div', { cls: 'swarm-card-header' },
    el('span', { cls: 'swarm-goal', title: sw.goal }, sw.goal),
    statusBadge(sw.status)
  ));
  if (sw.phase) card.appendChild(el('div', { cls: 'swarm-phase' }, `Phase: ${sw.phase}`));
  card.appendChild(progressBar(sw.tasksDone, sw.tasksTotal));
  // Click to navigate to swarm detail
  if (sw.id) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      navigate('swarms');
      // store pending swarm to open
      state._pendingSwarmId = sw.id;
    });
  }
  return card;
}

// ---------------------------------------------------------------------------
// Runs view
// ---------------------------------------------------------------------------

async function loadRuns() {
  showLoading('runs');
  try {
    state.runs = await apiFetch('/api/runs');
    renderRuns();
  } catch (err) {
    showError('runs', err.message);
  }
}

function renderRuns() {
  if (state.activeView !== 'runs') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Runs'),
    el('span', { cls: 'view-subtitle' }, `${state.runs.length} run${state.runs.length !== 1 ? 's' : ''}`)
  ));

  // M32: dispatch panel
  section.appendChild(buildDispatchPanel());

  if (state.runs.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No runs recorded yet.'),
      el('p', { cls: 'hint' }, 'Use the dispatch panel above or run `ashlr run "your goal"` in your terminal.')
    ));
  } else {
    section.appendChild(buildRunsTable(state.runs, true));
  }

  main.appendChild(section);
}

// ---------------------------------------------------------------------------
// M32: Dispatch panel (inside Runs view)
// ---------------------------------------------------------------------------

function buildDispatchPanel() {
  const snap = state.snapshot;
  const dispatchEnabled = snap ? snap.dispatchEnabled === true : false;
  const token = getToken();
  const canDispatch = dispatchEnabled && Boolean(token);

  // Disable reason shown as a note under the button
  let disabledReason = '';
  if (!dispatchEnabled) disabledReason = 'Start the server with --allow-dispatch to enable dispatch.';
  else if (!token) disabledReason = 'Enter your session token (gear icon) to enable dispatch.';

  const panel = el('div', { cls: 'dispatch-panel' });
  panel.appendChild(el('h2', { cls: 'dispatch-panel__title' }, 'Dispatch a run'));

  // Goal textarea
  const goalInput = el('textarea', {
    cls: 'input dispatch-panel__goal',
    placeholder: 'Goal — what should the agent do?',
    rows: '2',
    'aria-label': 'Goal',
  });

  // Budget input
  const budgetInput = el('input', {
    type: 'number',
    cls: 'input dispatch-panel__budget',
    placeholder: 'Max tokens (optional)',
    min: '1000',
    max: '200000',
    step: '1000',
    'aria-label': 'Max tokens budget',
  });

  // Estimate line
  const estimateLine = el('div', { cls: 'dispatch-panel__estimate', id: 'dispatch-estimate', 'aria-live': 'polite' });

  // Dispatch button
  const dispatchBtn = el('button', {
    cls: 'btn btn-primary dispatch-panel__btn',
    type: 'button',
    ...(canDispatch ? {} : { disabled: 'disabled' }),
  }, 'Dispatch');
  if (!canDispatch && disabledReason) {
    dispatchBtn.title = disabledReason;
  }

  // Result line
  const resultLine = el('div', { cls: 'dispatch-panel__result', 'aria-live': 'polite' });

  // Debounced estimate fetch on input
  function scheduleEstimate() {
    if (state._estimateTimer) clearTimeout(state._estimateTimer);
    state._estimateTimer = setTimeout(async () => {
      const goal = goalInput.value.trim();
      if (!goal) { estimateLine.textContent = ''; return; }
      estimateLine.textContent = 'Estimating…';
      try {
        const params = new URLSearchParams({ kind: 'run', goal });
        const maxTok = parseInt(budgetInput.value, 10);
        if (!isNaN(maxTok) && maxTok > 0) params.set('maxTokens', String(maxTok));
        const est = await apiFetch(`/api/estimate?${params}`);
        const med = est.tokens?.median ?? '—';
        const costMed = est.estCostUsd?.median != null ? `$${est.estCostUsd.median.toFixed(4)}` : '—';
        const conf = est.confidence ?? '—';
        estimateLine.textContent = `Est: ~${fmtK(med)} tokens · ${costMed} (${conf} confidence, n=${est.sampleSize ?? 0})`;
      } catch (err) {
        estimateLine.textContent = `Estimate unavailable: ${err.message}`;
      }
    }, 400);
  }

  goalInput.addEventListener('input', scheduleEstimate);
  budgetInput.addEventListener('input', scheduleEstimate);

  dispatchBtn.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) { resultLine.textContent = 'Goal is required.'; return; }
    if (!canDispatch) { resultLine.textContent = disabledReason || 'Dispatch not available.'; return; }
    dispatchBtn.disabled = true;
    resultLine.textContent = 'Dispatching…';
    try {
      const body = { goal };
      const maxTok = parseInt(budgetInput.value, 10);
      if (!isNaN(maxTok) && maxTok > 0) body.maxTokens = maxTok;
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      resultLine.textContent = `Dispatched: run ${json.id ?? ''} (${json.status ?? 'queued'})`;
      resultLine.className = 'dispatch-panel__result dispatch-panel__result--ok';
      goalInput.value = '';
      estimateLine.textContent = '';
      // Refresh runs list
      await loadRuns();
    } catch (err) {
      resultLine.textContent = `Error: ${err.message}`;
      resultLine.className = 'dispatch-panel__result dispatch-panel__result--err';
    } finally {
      dispatchBtn.disabled = !canDispatch;
    }
  });

  const row = el('div', { cls: 'dispatch-panel__row' });
  row.appendChild(goalInput);
  row.appendChild(budgetInput);

  const actions = el('div', { cls: 'dispatch-panel__actions' });
  actions.appendChild(estimateLine);
  actions.appendChild(dispatchBtn);

  if (!canDispatch && disabledReason) {
    actions.appendChild(el('span', { cls: 'dispatch-panel__note' }, disabledReason));
  }

  panel.appendChild(row);
  panel.appendChild(actions);
  panel.appendChild(resultLine);
  return panel;
}

function buildRunsTable(runs, full = false) {
  const wrap = el('div', { cls: 'table-wrap' });
  const table = el('table', { cls: 'data-table' });

  const thead = el('thead', {});
  const headerRow = el('tr', {});
  for (const h of ['Goal', 'Status', 'Engine', 'Tokens', 'Cost', 'Updated']) {
    headerRow.appendChild(el('th', {}, h));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody', {});
  for (const run of runs) {
    const tokens = (run.usage?.tokensIn ?? 0) + (run.usage?.tokensOut ?? 0);
    const cost = run.usage?.estCostUsd ?? 0;
    const tr = el('tr', { cls: 'table-row', style: 'cursor:pointer' });
    tr.appendChild(el('td', { cls: 'goal-cell', title: run.goal }, truncate(run.goal, 60)));
    tr.appendChild(el('td', {}, statusBadge(run.status)));
    tr.appendChild(el('td', {}, run.engine ?? '—'));
    tr.appendChild(el('td', { cls: 'num' }, fmtK(tokens)));
    tr.appendChild(el('td', { cls: 'num' }, `$${fmt(cost)}`));
    tr.appendChild(el('td', { cls: 'ts' }, fmtRelative(run.updatedAt)));
    if (full) {
      tr.addEventListener('click', () => showRunDetail(run));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function showRunDetail(run) {
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('button', { cls: 'btn back-btn', onClick: () => { state.activeView = 'runs'; renderRuns(); } }, '← Back'),
    el('h1', { cls: 'view-title' }, 'Run Detail'),
    statusBadge(run.status)
  ));

  // Meta
  section.appendChild(infoGrid([
    ['ID', run.id],
    ['Goal', run.goal],
    ['Engine', run.engine ?? '—'],
    ['Provider', run.provider ?? '—'],
    ['Created', fmtDate(run.createdAt)],
    ['Updated', fmtDate(run.updatedAt)],
    ['Tokens In', fmtK(run.usage?.tokensIn ?? 0)],
    ['Tokens Out', fmtK(run.usage?.tokensOut ?? 0)],
    ['Cost', `$${fmt(run.usage?.estCostUsd ?? 0)}`],
    ['Steps', run.usage?.steps ?? 0],
  ]));

  // Task list
  if (run.tasks && run.tasks.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Tasks'));
    const taskList = el('div', { cls: 'task-list' });
    for (const t of run.tasks) {
      taskList.appendChild(taskRow(t));
    }
    section.appendChild(taskList);
  }

  // Result
  if (run.result) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Result'));
    section.appendChild(el('pre', { cls: 'result-pre' }, run.result));
  }

  main.appendChild(section);
}

function taskRow(t) {
  const color = STATUS_COLOR[t.status] ?? '#9ca3af';
  const row = el('div', { cls: 'task-row', style: `border-left:3px solid ${color}` });
  row.appendChild(el('div', { cls: 'task-header' },
    el('span', { cls: 'task-id' }, t.id),
    statusBadge(t.status)
  ));
  row.appendChild(el('div', { cls: 'task-goal' }, t.goal));
  if (t.deps && t.deps.length > 0) {
    row.appendChild(el('div', { cls: 'task-deps' }, `Deps: ${t.deps.join(', ')}`));
  }
  if (t.error) {
    row.appendChild(el('div', { cls: 'task-error' }, `Error: ${t.error}`));
  }
  return row;
}

// ---------------------------------------------------------------------------
// Swarms view
// ---------------------------------------------------------------------------

async function loadSwarms() {
  showLoading('swarms');
  try {
    state.swarms = await apiFetch('/api/swarms');
    renderSwarms();
  } catch (err) {
    showError('swarms', err.message);
  }
}

function renderSwarms() {
  if (state.activeView !== 'swarms') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Swarms'),
    el('span', { cls: 'view-subtitle' }, `${state.swarms.length} swarm${state.swarms.length !== 1 ? 's' : ''}`)
  ));

  if (state.swarms.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No swarms recorded yet.'),
      el('p', { cls: 'hint' }, 'Run `ashlr swarm "your goal"` to start one.')
    ));
    main.appendChild(section);
    return;
  }

  // Check if we should auto-open a pending swarm
  const pendingId = state._pendingSwarmId;
  delete state._pendingSwarmId;

  if (pendingId) {
    const sw = state.swarms.find((s) => s.id === pendingId);
    if (sw) { renderSwarmDetail(sw, section, main); return; }
  }

  // List
  const list = el('div', { cls: 'swarm-list' });
  for (const sw of state.swarms) {
    const row = el('div', { cls: 'swarm-list-row', style: 'cursor:pointer' });

    const tasksDone = sw.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
    const tasksTotal = sw.tasks.length;

    row.appendChild(el('div', { cls: 'swarm-list-main' },
      el('div', { cls: 'swarm-goal', title: sw.goal }, truncate(sw.goal, 70)),
      el('div', { cls: 'swarm-meta-row' },
        statusBadge(sw.status),
        el('span', { cls: 'ts' }, fmtRelative(sw.updatedAt)),
        el('span', {}, `${tasksTotal} tasks`)
      )
    ));
    row.appendChild(progressBar(tasksDone, tasksTotal));
    row.addEventListener('click', () => {
      main.innerHTML = '';
      const sec = el('section', { cls: 'view-section' });
      renderSwarmDetail(sw, sec, main);
    });
    list.appendChild(row);
  }
  section.appendChild(list);
  main.appendChild(section);
}

function renderSwarmDetail(sw, section, main) {
  section.appendChild(el('div', { cls: 'view-header' },
    el('button', { cls: 'btn back-btn', onClick: () => loadSwarms() }, '← Back'),
    el('h1', { cls: 'view-title', title: sw.goal }, truncate(sw.goal, 50)),
    statusBadge(sw.status)
  ));

  // Meta
  const tasksDone = sw.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  section.appendChild(infoGrid([
    ['ID', sw.id],
    ['Status', sw.status],
    ['Tasks', `${tasksDone} / ${sw.tasks.length} done`],
    ['Cost', `$${fmt(sw.usage?.estCostUsd ?? 0)}`],
    ['Tokens', fmtK((sw.usage?.tokensIn ?? 0) + (sw.usage?.tokensOut ?? 0))],
    ['Created', fmtDate(sw.createdAt)],
    ['Updated', fmtDate(sw.updatedAt)],
  ]));

  // Burndown bar
  section.appendChild(el('h2', { cls: 'section-heading' }, 'Progress'));
  section.appendChild(progressBar(tasksDone, sw.tasks.length));

  // DAG Graph
  section.appendChild(el('h2', { cls: 'section-heading' }, 'Task DAG'));
  const dagSvg = buildSwarmDag(sw);
  section.appendChild(el('div', { cls: 'dag-wrap' }, dagSvg));

  // Task detail list
  section.appendChild(el('h2', { cls: 'section-heading' }, 'Tasks'));
  const taskList = el('div', { cls: 'task-list' });
  for (const t of sw.tasks) {
    const spec = sw.plan?.tasks?.find((p) => p.id === t.id);
    const taskRun = Object.assign({}, spec ?? {}, t);
    taskList.appendChild(taskRow(taskRun));
  }
  section.appendChild(taskList);

  // Result
  if (sw.result) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Result'));
    section.appendChild(el('pre', { cls: 'result-pre' }, sw.result));
  }

  main.appendChild(section);
}

// ---------------------------------------------------------------------------
// Swarm DAG — SVG node-link diagram
// ---------------------------------------------------------------------------

function buildSwarmDag(sw) {
  // Merge plan tasks (spec) with runtime tasks for status + goal
  const specTasks = sw.plan?.tasks ?? [];
  const runTasks  = sw.tasks ?? [];

  // Build combined task list: spec carries goal+deps+phase, run carries status
  const taskMap = new Map();
  for (const s of specTasks) taskMap.set(s.id, { ...s });
  for (const r of runTasks) {
    const existing = taskMap.get(r.id) ?? {};
    taskMap.set(r.id, { ...existing, ...r });
  }
  const tasks = [...taskMap.values()];

  if (tasks.length === 0) {
    return el('div', { cls: 'dag-empty' }, 'No tasks in this swarm.');
  }

  // Layout: columns by phase, rows within phase
  const phaseGroups = {};
  for (const t of tasks) {
    const ph = t.phase ?? 'build';
    if (!phaseGroups[ph]) phaseGroups[ph] = [];
    phaseGroups[ph].push(t);
  }

  const phases = Object.keys(phaseGroups).sort(
    (a, b) => (PHASE_ORDER[a] ?? 99) - (PHASE_ORDER[b] ?? 99)
  );

  // Dimensions
  const NODE_W = 140;
  const NODE_H = 48;
  const H_GAP = 60;   // gap between columns
  const V_GAP = 20;   // gap between rows within a column
  const PAD   = 20;

  const colX = {};
  let x = PAD;
  for (const ph of phases) {
    colX[ph] = x;
    x += NODE_W + H_GAP;
  }
  const totalW = x + PAD;

  // Compute Y per task
  const nodePos = {};
  for (const ph of phases) {
    const group = phaseGroups[ph];
    let y = PAD;
    for (const t of group) {
      nodePos[t.id] = { x: colX[ph], y, cx: colX[ph] + NODE_W / 2, cy: y + NODE_H / 2 };
      y += NODE_H + V_GAP;
    }
  }

  // Total SVG height
  const totalH = Math.max(...Object.values(nodePos).map((p) => p.y + NODE_H)) + PAD * 2;

  const svg = svgEl('svg', {
    width: totalW,
    height: totalH,
    viewBox: `0 0 ${totalW} ${totalH}`,
    class: 'dag-svg',
    'aria-label': 'Swarm task dependency graph'
  });

  // Phase column labels
  for (const ph of phases) {
    svg.appendChild(svgEl('text', {
      x: colX[ph] + NODE_W / 2,
      y: PAD - 6,
      'text-anchor': 'middle',
      class: 'dag-phase-label'
    }, ph));
  }

  // Draw edges (dep arrows) BELOW nodes
  for (const t of tasks) {
    if (!t.deps || !t.id || !nodePos[t.id]) continue;
    const to = nodePos[t.id];
    for (const depId of t.deps) {
      const from = nodePos[depId];
      if (!from) continue;
      // Draw a bezier from right-center of dep node to left-center of this node
      const x1 = from.x + NODE_W;
      const y1 = from.cy;
      const x2 = to.x;
      const y2 = to.cy;
      const mx = (x1 + x2) / 2;
      svg.appendChild(svgEl('path', {
        d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        class: 'dag-edge',
        fill: 'none',
        'marker-end': 'url(#arrow)'
      }));
    }
  }

  // Arrow marker
  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: 'arrow',
    markerWidth: '8',
    markerHeight: '8',
    refX: '6',
    refY: '3',
    orient: 'auto'
  });
  marker.appendChild(svgEl('path', {
    d: 'M0,0 L0,6 L8,3 z',
    class: 'dag-arrow-head'
  }));
  defs.appendChild(marker);
  svg.insertBefore(defs, svg.firstChild);

  // Draw nodes
  for (const t of tasks) {
    if (!nodePos[t.id]) continue;
    const pos = nodePos[t.id];
    const color = STATUS_COLOR[t.status] ?? '#6b7280';
    const g = svgEl('g', { class: 'dag-node', transform: `translate(${pos.x},${pos.y})` });

    // Node rect
    g.appendChild(svgEl('rect', {
      width: NODE_W,
      height: NODE_H,
      rx: 6,
      ry: 6,
      class: 'dag-node-rect',
      style: `stroke:${color};fill:${color}18`
    }));

    // Status dot
    g.appendChild(svgEl('circle', {
      cx: 10,
      cy: NODE_H / 2,
      r: 4,
      style: `fill:${color}`
    }));

    // Task id
    g.appendChild(svgEl('text', {
      x: 20,
      y: 17,
      class: 'dag-node-id'
    }, truncate(t.id, 18)));

    // Goal text
    g.appendChild(svgEl('text', {
      x: 20,
      y: 33,
      class: 'dag-node-goal'
    }, truncate(t.goal ?? '', 20)));

    svg.appendChild(g);
  }

  return svg;
}

// ---------------------------------------------------------------------------
// Pulse view
// ---------------------------------------------------------------------------

async function loadPulse(window = '7d') {
  showLoading('pulse');
  try {
    state.pulse = await apiFetch(`/api/pulse?window=${window}`);
    renderPulse();
  } catch (err) {
    showError('pulse', err.message);
  }
}

function renderPulse() {
  if (state.activeView !== 'pulse') return;
  const p = state.pulse;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  if (!p) {
    main.appendChild(el('div', { cls: 'loading-wrap' }, el('p', {}, 'No data yet.')));
    return;
  }

  const section = el('section', { cls: 'view-section' });

  // Header + window picker
  const windowPicker = el('div', { cls: 'window-picker' });
  for (const w of ['1d', '7d', '30d']) {
    const btn = el('button', {
      cls: `btn window-btn ${p.window === w ? 'active' : ''}`,
      onClick: () => loadPulse(w)
    }, w);
    windowPicker.appendChild(btn);
  }

  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Pulse'),
    windowPicker
  ));

  // Totals row
  const budget = p.budget ?? {};
  const cards = el('div', { cls: 'cards-row' });
  cards.appendChild(metricCard('Cost', `$${fmt(p.totals?.estCostUsd ?? 0)}`, p.window, '#fbbf24'));
  cards.appendChild(metricCard('Tokens In', fmtK(p.totals?.tokensIn ?? 0), '', '#60a5fa'));
  cards.appendChild(metricCard('Tokens Out', fmtK(p.totals?.tokensOut ?? 0), '', '#a78bfa'));
  cards.appendChild(metricCard('Sessions', p.totals?.sessions ?? 0, `${p.totals?.commits ?? 0} commits`, '#4ade80'));
  section.appendChild(cards);

  // Budget alert
  if (budget.level && budget.level !== 'ok') {
    const levelColor = budget.level === 'over' ? '#f87171' : '#fbbf24';
    section.appendChild(el('div', {
      cls: 'budget-alert',
      style: `border-left:4px solid ${levelColor};background:${levelColor}18`
    }, el('strong', {}, budget.level.toUpperCase() + ': '), budget.message ?? ''));
  }

  // Daily cost chart
  if (p.byDay && p.byDay.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Daily Cost'));
    section.appendChild(buildBarChart(
      p.byDay.map((d) => ({ label: d.day.slice(5), value: d.estCostUsd, sub: `$${fmt(d.estCostUsd)}` })),
      '#fbbf24',
      { height: 160, prefix: '$' }
    ));
  }

  // Daily tokens chart
  if (p.byDay && p.byDay.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'Daily Tokens'));
    section.appendChild(buildBarChart(
      p.byDay.map((d) => ({ label: d.day.slice(5), value: d.tokensIn + d.tokensOut, sub: fmtK(d.tokensIn + d.tokensOut) })),
      '#60a5fa',
      { height: 160 }
    ));
  }

  // By project table
  if (p.byProject && p.byProject.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'By Project'));
    section.appendChild(buildProjectTable(p.byProject));
  }

  // By model chart
  if (p.byModel && p.byModel.length > 0) {
    section.appendChild(el('h2', { cls: 'section-heading' }, 'By Model'));
    section.appendChild(buildBarChart(
      p.byModel.map((m) => ({ label: shortModel(m.model), value: m.estCostUsd, sub: `$${fmt(m.estCostUsd)} · ${m.calls} calls` })),
      '#a78bfa',
      { height: 160, prefix: '$' }
    ));
  }

  main.appendChild(section);
}

function shortModel(model) {
  if (!model) return '—';
  const parts = model.split(/[/-]/);
  return parts[parts.length - 1] ?? model;
}

// SVG bar chart
function buildBarChart(items, color, opts = {}) {
  const { height = 160, prefix = '' } = opts;
  if (!items.length) return el('div', { cls: 'empty-state' }, 'No data.');

  const BAR_W = 36;
  const GAP = 8;
  const LABEL_H = 32;
  const PAD = 16;
  const chartH = height;
  const totalW = items.length * (BAR_W + GAP) + PAD * 2;
  const svgH = chartH + LABEL_H + PAD;

  const maxVal = Math.max(...items.map((i) => i.value), 0.001);

  const svg = svgEl('svg', {
    width: totalW,
    height: svgH,
    viewBox: `0 0 ${totalW} ${svgH}`,
    class: 'bar-chart-svg'
  });

  // Max-value axis label (top-right, clear of the bars) — gives cost charts a
  // currency affordance via `prefix` (e.g. "$12.50" / "1.2K").
  svg.appendChild(svgEl('text', {
    x: totalW - PAD,
    y: PAD - 4,
    'text-anchor': 'end',
    class: 'bar-axis-max',
    style: 'fill:#94a3b8;font-size:10px'
  }, `max ${prefix}${maxVal >= 1000 ? fmtK(maxVal) : fmt(maxVal)}`));

  // Baseline
  svg.appendChild(svgEl('line', {
    x1: PAD,
    y1: chartH + PAD / 2,
    x2: totalW - PAD,
    y2: chartH + PAD / 2,
    class: 'bar-baseline'
  }));

  items.forEach((item, i) => {
    const x = PAD + i * (BAR_W + GAP);
    const barH = Math.max(2, (item.value / maxVal) * chartH);
    const y = chartH + PAD / 2 - barH;

    // Bar rect
    const rect = svgEl('rect', {
      x,
      y,
      width: BAR_W,
      height: barH,
      rx: 3,
      class: 'bar-rect',
      style: `fill:${color}cc`,
      'data-val': item.sub ?? item.value
    });

    // Tooltip via title
    const title = svgEl('title');
    title.textContent = `${item.label}: ${item.sub ?? item.value}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    // X-axis label
    svg.appendChild(svgEl('text', {
      x: x + BAR_W / 2,
      y: chartH + PAD / 2 + 16,
      'text-anchor': 'middle',
      class: 'bar-label'
    }, item.label));
  });

  // Wrap in scrollable div in case many bars
  const wrap = el('div', { cls: 'bar-chart-wrap' });
  wrap.appendChild(svg);
  return wrap;
}

function buildProjectTable(byProject) {
  const wrap = el('div', { cls: 'table-wrap' });
  const table = el('table', { cls: 'data-table' });
  const thead = el('thead', {});
  const hr = el('tr', {});
  for (const h of ['Project', 'Sessions', 'Commits', 'Tokens', 'Cost']) {
    hr.appendChild(el('th', {}, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody', {});
  for (const p of byProject.slice(0, 20)) {
    const tr = el('tr', {});
    const name = p.project?.split('/').slice(-2).join('/') ?? '—';
    tr.appendChild(el('td', { title: p.project }, name));
    tr.appendChild(el('td', { cls: 'num' }, p.sessions));
    tr.appendChild(el('td', { cls: 'num' }, p.commits));
    tr.appendChild(el('td', { cls: 'num' }, fmtK(p.tokensIn + p.tokensOut)));
    tr.appendChild(el('td', { cls: 'num' }, `$${fmt(p.estCostUsd)}`));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ---------------------------------------------------------------------------
// Genome view
// ---------------------------------------------------------------------------

async function loadGenome(query = '') {
  showLoading('genome');
  try {
    const url = query ? `/api/genome?q=${encodeURIComponent(query)}` : '/api/genome';
    state.genome = await apiFetch(url);
    state.genomeQuery = query;
    renderGenome();
  } catch (err) {
    showError('genome', err.message);
  }
}

function renderGenome() {
  if (state.activeView !== 'genome') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Genome'),
    el('span', { cls: 'view-subtitle' }, 'Shared memory / cross-project notes')
  ));

  // Search box
  const searchRow = el('div', { cls: 'search-row' });
  const input = el('input', {
    type: 'text',
    cls: 'search-input',
    placeholder: 'Search genome…',
    value: state.genomeQuery
  });
  const searchBtn = el('button', { cls: 'btn', onClick: () => loadGenome(input.value.trim()) }, 'Search');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadGenome(input.value.trim());
  });
  searchRow.appendChild(input);
  searchRow.appendChild(searchBtn);
  if (state.genomeQuery) {
    const clearBtn = el('button', { cls: 'btn btn-ghost', onClick: () => loadGenome('') }, 'Clear');
    searchRow.appendChild(clearBtn);
  }
  section.appendChild(searchRow);

  // Results
  const entries = state.genome;
  const isRecall = Array.isArray(entries) && entries.length > 0 && 'entry' in entries[0];

  // Normalize: recall hits wrap { entry, score } vs direct GenomeEntry[]
  const items = isRecall
    ? entries.map((h) => ({ ...h.entry, _score: h.score, _method: h.method }))
    : entries;

  if (items.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, state.genomeQuery ? `No results for "${state.genomeQuery}".` : 'No genome entries yet.'),
      el('p', { cls: 'hint' }, 'Use `ashlr learn "text"` to add entries.')
    ));
  } else {
    section.appendChild(el('div', { cls: 'view-subtitle' }, `${items.length} entr${items.length !== 1 ? 'ies' : 'y'}`));
    const list = el('div', { cls: 'genome-list' });
    for (const item of items) {
      list.appendChild(genomeCard(item));
    }
    section.appendChild(list);
  }

  main.appendChild(section);
}

function genomeCard(entry) {
  const card = el('div', { cls: 'genome-card' });

  const header = el('div', { cls: 'genome-card-header' });
  header.appendChild(el('span', { cls: 'genome-title' }, entry.title || '(untitled)'));
  const meta = el('div', { cls: 'genome-meta' });
  if (entry.source) meta.appendChild(el('span', { cls: 'badge badge-source' }, entry.source));
  if (entry.project) meta.appendChild(el('span', { cls: 'genome-project', title: entry.project },
    entry.project.split('/').pop()));
  if (entry._score != null) meta.appendChild(el('span', { cls: 'badge' }, `score: ${entry._score.toFixed(2)}`));
  meta.appendChild(el('span', { cls: 'ts' }, fmtRelative(entry.ts)));
  header.appendChild(meta);
  card.appendChild(header);

  card.appendChild(el('p', { cls: 'genome-text' }, entry.text));

  if (entry.tags && entry.tags.length > 0) {
    const tagRow = el('div', { cls: 'genome-tags' });
    for (const tag of entry.tags) {
      tagRow.appendChild(el('span', { cls: 'badge badge-tag' }, tag));
    }
    card.appendChild(tagRow);
  }

  return card;
}

// ---------------------------------------------------------------------------
// Portfolio view (M29) — READ-ONLY org-level summary.
//
// Reads GET /api/portfolio (a read-only projection of buildSnapshot().portfolio)
// and renders health / in-flight goals / top backlog / cost+forecast /
// effectiveness / today deltas. No mutation controls — there is nothing to
// approve, apply, or dispatch from this view. Degrades to an empty-state card
// when the portfolio section is null (older producer / empty enrollment).
// ---------------------------------------------------------------------------

async function loadPortfolio() {
  showLoading('portfolio');
  try {
    state.portfolio = await apiFetch('/api/portfolio');
    renderPortfolio();
  } catch (err) {
    showError('portfolio', err.message);
  }
}

function renderPortfolio() {
  if (state.activeView !== 'portfolio') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Portfolio'),
    el('span', { cls: 'view-subtitle' }, 'Org-level health, goals, cost — read-only')
  ));

  const p = state.portfolio;
  if (!p) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No portfolio data yet.'),
      el('p', { cls: 'hint' }, 'Enroll repos and run `ashlr health` / `ashlr goals` to populate this view.')
    ));
    main.appendChild(section);
    return;
  }

  // ── Health ────────────────────────────────────────────────────────────
  const h = p.health || { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] };
  const healthCard = el('div', { cls: 'card' });
  healthCard.appendChild(el('h2', { cls: 'card-title' }, 'Health'));
  if (h.reposScored > 0) {
    healthCard.appendChild(infoGrid([
      ['Repos scored', h.reposScored],
      ['Avg score', Math.round(h.averageScore)],
      ['Avg grade', h.averageGrade],
    ]));
    if (Array.isArray(h.worstRepos) && h.worstRepos.length > 0) {
      const ul = el('ul', { cls: 'portfolio-worst' });
      for (const w of h.worstRepos) {
        ul.appendChild(el('li', {},
          el('span', { cls: 'portfolio-repo', title: w.repo }, (w.repo || '').split('/').filter(Boolean).pop() || w.repo),
          el('span', { cls: `badge grade-${w.grade}` }, `${w.grade} (${Math.round(w.score)})`)
        ));
      }
      healthCard.appendChild(el('p', { cls: 'hint' }, 'Needs attention:'));
      healthCard.appendChild(ul);
    }
  } else {
    healthCard.appendChild(el('p', { cls: 'hint' }, 'No enrolled repos scored.'));
  }
  section.appendChild(healthCard);

  // ── Goals in flight ─────────────────────────────────────────────────────
  const goals = Array.isArray(p.goalsInFlight) ? p.goalsInFlight : [];
  const goalsCard = el('div', { cls: 'card' });
  goalsCard.appendChild(el('h2', { cls: 'card-title' }, `Goals in flight (${goals.length})`));
  if (goals.length === 0) {
    goalsCard.appendChild(el('p', { cls: 'hint' }, 'None active.'));
  } else {
    const list = el('div', { cls: 'portfolio-goals' });
    for (const g of goals) {
      const pct = Math.round(Math.max(0, Math.min(1, g.fractionDone || 0)) * 100);
      const row = el('div', { cls: 'portfolio-goal' });
      row.appendChild(el('div', { cls: 'portfolio-goal__obj', title: g.objective },
        truncate(g.objective, 70)));
      row.appendChild(el('div', { cls: 'portfolio-goal__meta' }, `${pct}% · ${g.proposed}/${g.totalMilestones} proposed`));
      if (g.nextActionable) {
        row.appendChild(el('div', { cls: 'hint' }, `next: ${truncate(g.nextActionable, 60)}`));
      }
      list.appendChild(row);
    }
    goalsCard.appendChild(list);
  }
  section.appendChild(goalsCard);

  // ── Top backlog ───────────────────────────────────────────────────────
  const backlog = Array.isArray(p.backlogTop) ? p.backlogTop : [];
  const backlogCard = el('div', { cls: 'card' });
  backlogCard.appendChild(el('h2', { cls: 'card-title' }, 'Top backlog'));
  if (backlog.length === 0) {
    backlogCard.appendChild(el('p', { cls: 'hint' }, 'Empty.'));
  } else {
    const ul = el('ul', { cls: 'portfolio-backlog' });
    for (const item of backlog) {
      ul.appendChild(el('li', {},
        el('span', { cls: 'badge' }, String(Math.round(item.score))),
        el('span', { cls: 'portfolio-backlog__title', title: item.title }, truncate(item.title, 80))
      ));
    }
    backlogCard.appendChild(ul);
  }
  section.appendChild(backlogCard);

  // ── Cost + forecast ─────────────────────────────────────────────────────
  const c = p.cost || { window: '7d', spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 };
  const costCard = el('div', { cls: 'card' });
  costCard.appendChild(el('h2', { cls: 'card-title' }, `Cost (${c.window})`));
  costCard.appendChild(infoGrid([
    ['Spent', `$${(c.spentUsd || 0).toFixed(2)}`],
    ['Saved (local)', `$${(c.localSavingsUsd || 0).toFixed(2)}`],
    ['Projected / mo', `$${(c.projectedMonthlyUsd || 0).toFixed(2)}`],
  ]));
  section.appendChild(costCard);

  // ── Effectiveness ───────────────────────────────────────────────────────
  if (p.effectiveness) {
    const eff = el('div', { cls: 'card' });
    eff.appendChild(el('h2', { cls: 'card-title' }, 'Effectiveness'));
    eff.appendChild(el('p', {}, p.effectiveness.headline || ''));
    section.appendChild(eff);
  }

  // ── Today (day-over-day deltas) ──────────────────────────────────────────
  const t = p.today || { previousAt: null };
  const todayCard = el('div', { cls: 'card' });
  todayCard.appendChild(el('h2', { cls: 'card-title' }, 'Today'));
  if (t.previousAt === null || t.previousAt === undefined) {
    todayCard.appendChild(el('p', { cls: 'hint' }, 'No prior digest to compare against yet.'));
  } else {
    todayCard.appendChild(infoGrid([
      ['Pending Δ', fmtDelta(t.pendingProposalsDelta)],
      ['Dirty Δ', fmtDelta(t.dirtyReposDelta)],
      ['Spend Δ', fmtDelta(t.spendUsdDelta, '$')],
      ['Health Δ', fmtDelta(t.healthScoreDelta)],
      ['Goals Δ', fmtDelta(t.goalsInFlightDelta)],
    ]));
  }
  section.appendChild(todayCard);

  main.appendChild(section);
}

// ---------------------------------------------------------------------------
// M32: Inbox view
// ---------------------------------------------------------------------------

async function loadInbox() {
  showLoading('inbox');
  try {
    const data = await apiFetch('/api/inbox');
    state.inbox = data;
    state.inboxBadge = data.pending ?? 0;
    updateInboxBadge();
    renderInbox();
  } catch (err) {
    showError('inbox', err.message);
  }
}

function renderInbox() {
  if (state.activeView !== 'inbox') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Inbox'),
    el('span', { cls: 'view-subtitle' }, `${state.inbox.pending ?? 0} pending`)
  ));

  const proposals = state.inbox.proposals ?? [];

  if (state.inboxDetail) {
    // Detail pane
    section.appendChild(buildInboxDetail(state.inboxDetail));
    main.appendChild(section);
    return;
  }

  if (proposals.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No pending proposals.'),
      el('p', { cls: 'hint' }, 'Proposals appear here when the daemon queues work for review.')
    ));
  } else {
    const list = el('div', { cls: 'inbox-list' });
    for (const p of proposals) {
      list.appendChild(buildInboxRow(p));
    }
    section.appendChild(list);
  }

  main.appendChild(section);
}

function buildInboxRow(p) {
  const row = el('div', { cls: 'inbox-row', style: 'cursor:pointer' });
  const repoBase = (p.repo ?? '').split('/').filter(Boolean).pop() ?? p.repo ?? '—';

  row.appendChild(el('div', { cls: 'inbox-row__main' },
    el('span', { cls: 'inbox-row__title', title: p.title }, truncate(p.title ?? '(untitled)', 80)),
    el('div', { cls: 'inbox-row__meta' },
      el('span', { cls: 'badge badge-kind' }, p.kind ?? 'proposal'),
      el('span', { cls: 'inbox-row__repo' }, repoBase),
      el('span', { cls: 'ts' }, fmtRelative(p.createdAt))
    )
  ));

  row.addEventListener('click', async () => {
    try {
      const full = await apiFetch(`/api/inbox/${encodeURIComponent(p.id)}`);
      state.inboxDetail = full;
      renderInbox();
    } catch (err) {
      const main_ = getMain();
      if (main_) {
        const errEl = el('div', { cls: 'inline-error' }, `Failed to load proposal: ${err.message}`);
        main_.appendChild(errEl);
      }
    }
  });

  return row;
}

function buildInboxDetail(p) {
  const snap = state.snapshot;
  const dispatchEnabled = snap ? snap.dispatchEnabled === true : false;
  const token = getToken();
  const canAct = dispatchEnabled && Boolean(token);

  let disabledReason = '';
  if (!dispatchEnabled) disabledReason = 'Start the server with --allow-dispatch to approve or reject.';
  else if (!token) disabledReason = 'Enter your session token (gear icon) to approve or reject.';

  const detail = el('div', { cls: 'inbox-detail' });

  // Back button
  detail.appendChild(el('button', {
    cls: 'btn back-btn',
    type: 'button',
    onClick: () => { state.inboxDetail = null; renderInbox(); },
  }, '← Back'));

  const repoBase = (p.repo ?? '').split('/').filter(Boolean).pop() ?? p.repo ?? '—';

  // Summary card
  const summary = el('div', { cls: 'inbox-detail__summary card' });
  summary.appendChild(el('h2', { cls: 'card-title' }, p.title ?? '(untitled)'));
  summary.appendChild(infoGrid([
    ['Kind', p.kind ?? '—'],
    ['Repo', repoBase],
    ['Origin', p.origin ?? '—'],
    ['Status', p.status ?? '—'],
    ['Created', fmtDate(p.createdAt)],
  ]));
  detail.appendChild(summary);

  // Diff
  if (p.diff) {
    const diffSection = el('div', { cls: 'inbox-detail__diff-wrap' });
    diffSection.appendChild(el('h3', { cls: 'section-heading' }, 'Diff'));
    const pre = el('pre', { cls: 'inbox-diff' });
    pre.innerHTML = escapeHtml(p.diff);
    diffSection.appendChild(pre);
    detail.appendChild(diffSection);
  }

  // Approve / Reject buttons + result
  const actionsDiv = el('div', { cls: 'inbox-detail__actions' });
  const resultLine = el('div', { cls: 'inbox-detail__result', 'aria-live': 'polite' });

  const approveBtn = el('button', {
    cls: 'btn btn-primary',
    type: 'button',
    ...(canAct ? {} : { disabled: 'disabled' }),
    title: canAct ? 'Approve and apply this proposal' : disabledReason,
  }, 'Approve');

  const rejectBtn = el('button', {
    cls: 'btn btn-danger',
    type: 'button',
    ...(canAct ? {} : { disabled: 'disabled' }),
    title: canAct ? 'Reject this proposal' : disabledReason,
  }, 'Reject');

  approveBtn.addEventListener('click', async () => {
    if (!canAct) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    resultLine.textContent = 'Approving…';
    try {
      const result = await apiPost(`/api/inbox/${encodeURIComponent(p.id)}/approve`, token);
      resultLine.textContent = result.detail ? `Applied: ${result.detail}` : (result.ok ? 'Approved and applied.' : 'Apply returned ok:false');
      resultLine.className = 'inbox-detail__result inbox-detail__result--ok';
    } catch (err) {
      resultLine.textContent = `Error: ${err.message}`;
      resultLine.className = 'inbox-detail__result inbox-detail__result--err';
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
    // Refresh inbox list after action
    state.inboxDetail = null;
    await loadInbox();
  });

  rejectBtn.addEventListener('click', async () => {
    if (!canAct) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    resultLine.textContent = 'Rejecting…';
    try {
      await apiPost(`/api/inbox/${encodeURIComponent(p.id)}/reject`, token);
      resultLine.textContent = 'Rejected.';
      resultLine.className = 'inbox-detail__result inbox-detail__result--ok';
    } catch (err) {
      resultLine.textContent = `Error: ${err.message}`;
      resultLine.className = 'inbox-detail__result inbox-detail__result--err';
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
    state.inboxDetail = null;
    await loadInbox();
  });

  actionsDiv.appendChild(approveBtn);
  actionsDiv.appendChild(rejectBtn);
  if (!canAct && disabledReason) {
    actionsDiv.appendChild(el('span', { cls: 'dispatch-panel__note' }, disabledReason));
  }
  detail.appendChild(actionsDiv);
  detail.appendChild(resultLine);

  return detail;
}

// ---------------------------------------------------------------------------
// M32: Daemon view
// ---------------------------------------------------------------------------

async function loadDaemon() {
  showLoading('daemon');
  try {
    state.daemon = await apiFetch('/api/daemon');
    renderDaemon();
  } catch (err) {
    showError('daemon', err.message);
  }
}

function renderDaemon() {
  if (state.activeView !== 'daemon') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Daemon'),
    el('span', { cls: 'view-subtitle' }, 'Background automation state')
  ));

  const d = state.daemon;
  if (!d) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Daemon state unavailable.'),
      el('p', { cls: 'hint' }, 'Start the daemon with `ashlr daemon start`.')
    ));
    main.appendChild(section);
    return;
  }

  const card = el('div', { cls: 'daemon-card card' });

  // Running indicator
  const runningDot = el('span', {
    cls: d.running ? 'daemon-dot daemon-dot--running' : 'daemon-dot',
    title: d.running ? 'Running' : 'Stopped',
  });
  const statusRow = el('div', { cls: 'daemon-card__status' },
    runningDot,
    el('span', { cls: d.running ? 'daemon-status--on' : 'daemon-status--off' },
      d.running ? 'Running' : 'Stopped')
  );
  card.appendChild(statusRow);

  // Info grid
  const pairs = [
    ['Last tick', d.lastTick ? fmtRelative(d.lastTick) : '—'],
    ['Today spend', d.todaySpendUsd != null ? `$${d.todaySpendUsd.toFixed(4)}` : '—'],
    ['Spend cap', d.spendCapUsd != null ? `$${d.spendCapUsd.toFixed(2)}` : '—'],
    ['Pending proposals', d.pendingProposals ?? state.inboxBadge ?? '—'],
  ];
  card.appendChild(infoGrid(pairs));

  // Spend vs cap mini bar
  if (d.spendCapUsd != null && d.todaySpendUsd != null) {
    const pct = Math.min(100, (d.todaySpendUsd / d.spendCapUsd) * 100);
    const level = pct >= 90 ? 'var(--status-failed)' : pct >= 70 ? 'var(--status-aborted)' : 'var(--status-done)';
    const track = el('div', { cls: 'daemon-spend-track' });
    track.appendChild(el('div', {
      cls: 'daemon-spend-fill',
      style: `width:${pct.toFixed(1)}%;background:${level}`,
    }));
    const spendWrap = el('div', { cls: 'daemon-spend-wrap' },
      el('span', { cls: 'daemon-spend-label' }, `Spend today: ${pct.toFixed(1)}% of cap`),
      track
    );
    card.appendChild(spendWrap);
  }

  section.appendChild(card);
  main.appendChild(section);
}

// ---------------------------------------------------------------------------
// M49: Fleet view — read-only fleet control plane snapshot
// ---------------------------------------------------------------------------

async function loadFleet() {
  showLoading('fleet');
  try {
    state.fleet = await apiFetch('/api/fleet');
    renderFleet();
  } catch (err) {
    showError('fleet', err.message);
  }
}

function quotaTag(quota) {
  const map = {
    ok: 'var(--status-done)',
    warn: 'var(--status-aborted)',
    over: 'var(--status-failed)',
    unlimited: 'var(--text-dim, #888)',
  };
  return el('span', {
    cls: 'fleet-quota',
    style: `color:${map[quota] || 'inherit'}`,
    title: `quota: ${quota}`,
  }, quota);
}

function renderFleet() {
  if (state.activeView !== 'fleet') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Fleet'),
    el('span', { cls: 'view-subtitle' }, 'Control plane & observability')
  ));

  const f = state.fleet;
  if (!f) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Fleet status unavailable.'),
      el('p', { cls: 'hint' }, 'Try again, or check the daemon with `ashlr fleet status`.')
    ));
    main.appendChild(section);
    return;
  }

  // Paused / killed banner
  if (f.killed) {
    section.appendChild(el('div', { cls: 'fleet-banner fleet-banner--paused' },
      el('strong', {}, 'Fleet paused'),
      el('span', {}, ' — the kill switch is engaged. Resume with `ashlr fleet resume`.')
    ));
  }

  // Daemon + queue + merges summary card
  const summary = el('div', { cls: 'fleet-card card' });
  summary.appendChild(infoGrid([
    ['Daemon', f.daemon.running ? 'running' : 'stopped'],
    ['Last tick', f.daemon.lastTickAt ? fmtRelative(f.daemon.lastTickAt) : '—'],
    ['Spend today', f.daemon.todaySpentUsd != null ? `$${f.daemon.todaySpentUsd.toFixed(4)}` : '—'],
    ['Backlog queue', f.queue?.backlogItems ?? '—'],
    ['Merges (24h)', f.merges?.recent ?? '—'],
  ]));
  section.appendChild(summary);

  // Backends table
  const backendsCard = el('div', { cls: 'fleet-card card' });
  backendsCard.appendChild(el('h2', { cls: 'card-title' }, 'Backends'));
  const backends = Array.isArray(f.backends) ? f.backends : [];
  if (backends.length === 0) {
    backendsCard.appendChild(el('p', { cls: 'hint' }, 'No backends configured.'));
  } else {
    const list = el('div', { cls: 'fleet-backends' });
    for (const b of backends) {
      const row = el('div', { cls: 'fleet-backend-row' },
        el('span', { cls: 'fleet-backend-name' }, b.backend),
        el('span', { cls: 'fleet-backend-dispatches' }, `${b.dispatchesRecent} dispatch(es) / 24h`),
        quotaTag(b.quota)
      );
      list.appendChild(row);
    }
    backendsCard.appendChild(list);
  }
  section.appendChild(backendsCard);

  // Proposals card
  const propsCard = el('div', { cls: 'fleet-card card' });
  propsCard.appendChild(el('h2', { cls: 'card-title' }, 'Proposals'));
  propsCard.appendChild(infoGrid([
    ['Pending', f.proposals?.pending ?? 0],
    ['Frontier pending', f.proposals?.frontierPending ?? 0],
    ['Applied', f.proposals?.applied ?? 0],
  ]));
  section.appendChild(propsCard);

  main.appendChild(section);
}

/** Format a signed delta for the portfolio "today" block. null → em-dash. */
function fmtDelta(n, prefix = '') {
  if (n === null || n === undefined || typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const mag = prefix === '$' ? Math.abs(n).toFixed(2) : String(Math.abs(n));
  return `${sign}${prefix}${mag}`;
}

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

function infoGrid(pairs) {
  const grid = el('dl', { cls: 'info-grid' });
  for (const [label, value] of pairs) {
    grid.appendChild(el('dt', {}, label));
    grid.appendChild(el('dd', { title: String(value) }, String(value ?? '—')));
  }
  return grid;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// SSE dot indicator
// ---------------------------------------------------------------------------

function updateSseDot(connected) {
  const dot = document.getElementById('sse-dot');
  if (!dot) return;
  dot.classList.toggle('connected', connected);
}

// ---------------------------------------------------------------------------
// Mission Control (M61) — /api/control composite live view
// ---------------------------------------------------------------------------

async function loadControl() {
  // Guard against overlapping fetches: /api/control aggregates a usage rollup
  // that can take a beat, and on single-threaded Node a stacked poll would pile
  // up requests (and freeze the tab waiting). Skip if one is already in flight.
  if (state.controlLoading) return;
  state.controlLoading = true;
  // Don't show skeleton loading flash on poll refreshes — only on first load
  if (!state.control) showLoading('control');
  try {
    state.control = await apiFetch('/api/control');
    renderControl();
  } catch (err) {
    if (!state.control) showError('control', err.message);
    // On poll failure keep stale data visible — don't replace with error
  } finally {
    state.controlLoading = false;
  }

  // Start polling (8s) if not already running and we're still on this view.
  if (state.activeView === 'control' && !state.controlInterval) {
    state.controlInterval = setInterval(() => {
      if (state.activeView !== 'control') {
        clearInterval(state.controlInterval);
        state.controlInterval = null;
        return;
      }
      loadControl();
    }, 8000);
  }
}

function renderControl() {
  if (state.activeView !== 'control') return;
  const main = getMain();
  if (!main) return;
  // Preserve scroll position across the 8s poll re-render (otherwise a watched
  // dashboard jumps to the top every refresh).
  const _scrollY = window.scrollY;
  main.innerHTML = '';

  const d = state.control;
  const section = el('section', { cls: 'view-section' });

  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Mission Control'),
    el('span', { cls: 'view-subtitle' }, d ? `Updated ${fmtRelative(d.ts)}` : 'Live fleet overview')
  ));

  if (!d) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Control data unavailable.'),
      el('p', { cls: 'hint' }, 'Ensure the daemon is running and the server serves /api/control.')
    ));
    main.appendChild(section);
    return;
  }

  // ── 1. Fleet Pulse (hero) ──────────────────────────────────────────────
  const fleet = d.fleet ?? d.daemon ?? {};
  const daemon = d.daemon ?? fleet.daemon ?? {};
  const queue  = d.fleet?.queue ?? fleet.queue ?? {};
  const props  = d.fleet?.proposals ?? fleet.proposals ?? {};
  const merges = d.fleet?.merges ?? fleet.merges ?? {};
  const isRunning = daemon.running ?? false;
  const isKilled  = d.fleet?.killed ?? false;

  if (isKilled) {
    section.appendChild(el('div', { cls: 'ctrl-banner ctrl-banner--paused' },
      el('strong', {}, 'Fleet paused'),
      el('span', {}, ' — kill switch engaged. Resume with `ashlr fleet resume`.')
    ));
  }

  const heroPulse = el('div', { cls: 'ctrl-hero' });
  const daemonStatusEl = el('div', { cls: 'ctrl-daemon-status' },
    el('span', { cls: `ctrl-live-dot${isRunning ? ' running' : ''}`, title: isRunning ? 'Running' : 'Stopped' }),
    el('span', { cls: `ctrl-daemon-label${isRunning ? ' running' : ''}` }, isRunning ? 'Daemon running' : 'Daemon stopped'),
    daemon.pid ? el('span', { cls: 'ctrl-pid' }, `PID ${daemon.pid}`) : null
  );
  heroPulse.appendChild(daemonStatusEl);

  if (daemon.lastTickAt) {
    heroPulse.appendChild(el('div', { cls: 'ctrl-last-tick' }, `Last tick ${fmtRelative(daemon.lastTickAt)}`));
  }

  const heroMetrics = el('div', { cls: 'ctrl-hero-metrics' });
  heroMetrics.appendChild(controlMetric('Spend today', daemon.todaySpentUsd != null ? `$${daemon.todaySpentUsd.toFixed(4)}` : '—', '#fbbf24'));
  heroMetrics.appendChild(controlMetric('Queue depth', queue.backlogItems ?? '—', '#60a5fa'));
  heroMetrics.appendChild(controlMetric('Proposals', props.pending ?? 0, '#a78bfa'));
  heroMetrics.appendChild(controlMetric('Merges (24h)', merges.recent ?? '—', '#4ade80'));
  heroMetrics.appendChild(controlMetric('Kill switch', isKilled ? 'ENGAGED' : 'off', isKilled ? '#f87171' : '#64748b'));
  heroPulse.appendChild(heroMetrics);
  section.appendChild(heroPulse);

  // ── 2. Local models ────────────────────────────────────────────────────
  const modelsData = d.models ?? {};
  const providers  = Array.isArray(modelsData.providers) ? modelsData.providers : [];
  const activeProvider = modelsData.activeProvider ?? '';

  const modelsCard = el('div', { cls: 'ctrl-card card' });
  modelsCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Local Models'),
    el('span', { cls: 'card-subtitle' }, activeProvider ? `active: ${activeProvider}` : 'no active provider')
  ));
  const modelsBody = el('div', { cls: 'card-body' });

  if (providers.length === 0) {
    modelsBody.appendChild(el('p', { cls: 'hint' }, 'No local model providers detected.'));
  } else {
    for (const prov of providers) {
      const isActive = prov.id === activeProvider;
      const row = el('div', { cls: `ctrl-provider-row${isActive ? ' active' : ''}` });
      row.appendChild(el('span', { cls: `ctrl-health-dot ${prov.up ? 'up' : 'down'}`, title: prov.up ? 'Up' : 'Down' }));
      row.appendChild(el('span', { cls: 'ctrl-provider-name' }, prov.id));
      if (prov.kind) row.appendChild(el('span', { cls: 'ctrl-provider-kind' }, prov.kind));
      if (prov.baseUrl) row.appendChild(el('span', { cls: 'ctrl-provider-url' }, prov.baseUrl));
      if (isActive) row.appendChild(el('span', { cls: 'ctrl-active-badge' }, 'active'));
      const chips = el('div', { cls: 'ctrl-model-chips' });
      const models = Array.isArray(prov.models) ? prov.models : [];
      if (models.length === 0) {
        chips.appendChild(el('span', { cls: 'ctrl-model-chip muted' }, 'no models'));
      } else {
        models.forEach((m) => chips.appendChild(el('span', { cls: 'ctrl-model-chip' }, typeof m === 'string' ? m : (m.id ?? m.name ?? String(m)))));
      }
      row.appendChild(chips);
      modelsBody.appendChild(row);
    }
  }
  modelsCard.appendChild(modelsBody);
  section.appendChild(modelsCard);

  // ── 3. Backends & limits ───────────────────────────────────────────────
  const backends  = Array.isArray(d.fleet?.backends) ? d.fleet.backends : [];
  const limits    = Array.isArray(d.limits) ? d.limits : [];
  const subLimits = d.subscriptionLimits ?? {};

  const backendsCard = el('div', { cls: 'ctrl-card card' });
  backendsCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Backends & Limits')
  ));
  const backendsBody = el('div', { cls: 'card-body' });

  if (subLimits.note) {
    backendsBody.appendChild(el('div', { cls: 'ctrl-sub-note' },
      el('span', { cls: 'ctrl-sub-icon' }, '⚠'),
      el('span', {}, subLimits.note)
    ));
  }

  // ── M63: rolling-window usage (REAL, from local transcripts) ──────────────
  const subWindows = Array.isArray(subLimits.windows) ? subLimits.windows : [];
  if (subWindows.length > 0) {
    backendsBody.appendChild(el('div', { cls: 'ctrl-limits-heading' }, 'Rolling usage (transcript-sourced)'));
    // Group by window label so we render 5h then 24h sections
    for (const windowLabel of ['5h', '24h']) {
      const rows = subWindows.filter((w) => w.window === windowLabel);
      if (rows.length === 0) continue;
      const section = el('div', { cls: 'ctrl-win-section' });
      section.appendChild(el('div', { cls: 'ctrl-win-label' }, `Last ${windowLabel}`));
      for (const w of rows) {
        const tokStr  = typeof w.tokens  === 'number' ? fmtK(w.tokens)              : '—';
        const costStr = typeof w.costUsd === 'number' ? `$${fmt(w.costUsd, 4)}`     : '—';
        section.appendChild(el('div', { cls: 'ctrl-win-row' },
          el('span', { cls: 'ctrl-win-provider' }, w.provider ?? '?'),
          el('span', { cls: 'ctrl-win-tokens' },   tokStr),
          el('span', { cls: 'ctrl-win-cost' },     costStr)
        ));
      }
      backendsBody.appendChild(section);
    }
  }

  // ── M63/M64: provider subscription/key status ────────────────────────────
  const subProviders = Array.isArray(subLimits.providers) ? subLimits.providers : [];
  if (subProviders.length > 0) {
    backendsBody.appendChild(el('div', { cls: 'ctrl-limits-heading' }, 'Provider status'));
    for (const p of subProviders) {
      const kindBadge = el('span', {
        cls: `ctrl-prov-kind-badge ${p.kind === 'api-key' ? 'api-key' : 'subscription'}`
      }, p.kind === 'api-key' ? 'API key' : 'subscription');

      // M64: for providers with real used% (e.g. Codex), render a usage bar + reset time
      // p.used is used_percent (0-100) when coming from Codex rate-limits
      const hasUsedPct = typeof p.used === 'number' && p.used >= 0 && p.used <= 100;
      const isSubscriptionPct = p.kind === 'subscription' && hasUsedPct;

      const row = el('div', { cls: 'ctrl-prov-status-row' },
        el('span', { cls: 'ctrl-prov-status-name' }, p.provider ?? '?'),
        kindBadge,
        el('span', { cls: 'ctrl-prov-status-detail' }, p.detail ?? ''),
        // API-key providers show raw token counts; subscription providers with used%
        // get a percentage badge (not "tok")
        !isSubscriptionPct && typeof p.used === 'number'
          ? el('span', { cls: 'ctrl-prov-status-used' }, fmtK(p.used) + ' tok')
          : null
      );

      // Rate-limit bar for subscription providers with real used% data (Codex)
      if (isSubscriptionPct) {
        const pct = Math.min(100, Math.round(p.used));
        const barColor = pct >= 90 ? 'var(--status-failed)'
                       : pct >= 70 ? 'var(--status-aborted)'
                       : 'var(--accent)';
        const resetStr = p.resetAt
          ? new Date(p.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : null;
        const barWrap = el('div', { cls: 'ctrl-prov-rl-wrap' },
          el('div', { cls: 'ctrl-prov-rl-bar-track' },
            el('div', { cls: 'ctrl-prov-rl-bar', style: `width:${pct}%;background:${barColor}` })
          ),
          el('span', { cls: 'ctrl-prov-rl-pct' }, `${pct}%`),
          resetStr ? el('span', { cls: 'ctrl-prov-rl-reset' }, `resets ${resetStr}`) : null
        );
        row.appendChild(barWrap);
      }

      backendsBody.appendChild(row);
    }
  }

  if (backends.length === 0 && limits.length === 0) {
    backendsBody.appendChild(el('p', { cls: 'hint' }, 'No backends configured.'));
  }

  if (backends.length > 0) {
    const bList = el('div', { cls: 'ctrl-backend-list' });
    for (const b of backends) {
      bList.appendChild(el('div', { cls: 'ctrl-backend-row' },
        el('span', { cls: 'ctrl-backend-name' }, b.id ?? b.backend ?? '?'),
        el('span', { cls: 'ctrl-backend-dispatches' }, `${b.dispatchesRecent ?? 0} dispatch(es) / 24h`),
        quotaTag(b.quota ?? 'ok')
      ));
    }
    backendsBody.appendChild(bList);
  }

  if (limits.length > 0) {
    backendsBody.appendChild(el('div', { cls: 'ctrl-limits-heading' }, 'Rate windows'));
    for (const lim of limits) {
      const used = lim.used ?? 0;
      const max  = lim.max  ?? 1;
      const pct  = Math.min(100, max > 0 ? Math.round((used / max) * 100) : 0);
      const standing = lim.standing ?? 'ok';
      const barColor = standing === 'over' ? 'var(--status-failed)'
                     : standing === 'warn' ? 'var(--status-aborted)'
                     : 'var(--accent)';
      backendsBody.appendChild(el('div', { cls: 'ctrl-limit-row' },
        el('span', { cls: 'ctrl-limit-backend' }, lim.backend ?? '?'),
        el('span', { cls: 'ctrl-limit-window' }, lim.window ?? ''),
        el('div', { cls: 'ctrl-limit-bar-wrap' },
          el('div', { cls: 'ctrl-limit-bar', style: `width:${pct}%;background:${barColor}` })
        ),
        el('span', { cls: 'ctrl-limit-label' }, `${used}/${max === Infinity ? '∞' : max}`),
        el('span', { cls: `ctrl-standing ${standing}` }, standing)
      ));
    }
  }

  backendsCard.appendChild(backendsBody);
  section.appendChild(backendsCard);

  // ── 4. Usage (7d) ─────────────────────────────────────────────────────
  const usage = d.usage ?? {};
  const byProvider = Array.isArray(usage.byProvider) ? usage.byProvider : [];

  const usageCard = el('div', { cls: 'ctrl-card card' });
  usageCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, `Usage${usage.window ? ` (${usage.window})` : ''}`)
  ));
  const usageBody = el('div', { cls: 'card-body' });

  const usageTotals = el('div', { cls: 'ctrl-usage-totals' });
  usageTotals.appendChild(controlMetric('Total tokens', usage.totalTokens != null ? fmtK(usage.totalTokens) : '—', '#60a5fa'));
  usageTotals.appendChild(controlMetric('Total cost', usage.totalCostUsd != null ? `$${fmt(usage.totalCostUsd)}` : '—', '#fbbf24'));
  usageTotals.appendChild(controlMetric('Local savings', usage.localSavingsUsd != null ? `$${fmt(usage.localSavingsUsd)}` : '—', '#4ade80'));
  usageBody.appendChild(usageTotals);

  if (byProvider.length > 0) {
    usageBody.appendChild(el('div', { cls: 'ctrl-prov-heading' }, 'By provider'));
    for (const p of byProvider) {
      const pct = Math.min(100, Math.round(p.sharePct ?? 0));
      const isLocal = (p.tier === 'local');
      usageBody.appendChild(el('div', { cls: 'ctrl-prov-row' },
        el('span', { cls: `ctrl-prov-label${isLocal ? ' local' : ''}` },
          `${p.provider ?? '?'}${p.tier ? ` (${p.tier})` : ''}`),
        el('div', { cls: 'ctrl-prov-bar-wrap' },
          el('div', { cls: `ctrl-prov-bar${isLocal ? ' local' : ''}`, style: `width:${pct}%` })
        ),
        el('span', { cls: 'ctrl-prov-pct' }, `${pct}%`),
        el('span', { cls: 'ctrl-prov-cost' }, p.costUsd != null ? `$${fmt(p.costUsd)}` : ''),
        el('span', { cls: 'ctrl-prov-tokens' }, p.tokens != null ? fmtK(p.tokens) : '')
      ));
    }
  }
  usageCard.appendChild(usageBody);
  section.appendChild(usageCard);

  // ── 5. Subscription usage (M82) ───────────────────────────────────────
  const subUsageEngines = Array.isArray(d.subscriptionUsage) ? d.subscriptionUsage : [];

  const subUsageCard = el('div', { cls: 'ctrl-card card' });
  subUsageCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Subscription Usage'),
    el('span', { cls: 'card-subtitle' }, 'burn-down per engine')
  ));
  const subUsageBody = el('div', { cls: 'card-body' });

  if (subUsageEngines.length === 0) {
    subUsageBody.appendChild(el('p', { cls: 'hint' }, 'No subscription engine data available.'));
  } else {
    for (const eng of subUsageEngines) {
      const engRow = el('div', { cls: 'ctrl-subusage-engine' });
      const planLabel = eng.plan ? ` · ${eng.plan}` : '';
      engRow.appendChild(el('div', { cls: 'ctrl-subusage-engine-name' },
        el('span', { cls: 'ctrl-subusage-engine-id' }, eng.engine),
        el('span', { cls: 'ctrl-subusage-plan' }, planLabel)
      ));

      if (!eng.hasData || !Array.isArray(eng.windows) || eng.windows.length === 0) {
        engRow.appendChild(el('p', { cls: 'ctrl-subusage-unknown' }, 'No local usage signal — subscription cap not API-exposed.'));
      } else {
        const barsWrap = el('div', { cls: 'ctrl-subusage-bars' });
        for (const win of eng.windows) {
          const pct = Math.min(100, Math.max(0, Math.round(win.usedPercent ?? 0)));
          const barColor = pct > 90 ? 'var(--status-failed)'
                         : pct > 70 ? 'var(--status-aborted)'
                         : 'var(--status-done)';
          const resetStr = win.resetsAt
            ? new Date(win.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : null;
          const winRow = el('div', { cls: 'ctrl-subusage-win-row' },
            el('span', { cls: 'ctrl-subusage-win-label' }, win.label ?? '?'),
            el('div', { cls: 'ctrl-subusage-bar-track' },
              el('div', { cls: 'ctrl-subusage-bar', style: `width:${pct}%;background:${barColor}` })
            ),
            el('span', { cls: 'ctrl-subusage-pct', style: `color:${barColor}` }, `${pct}%`),
            resetStr
              ? el('span', { cls: 'ctrl-subusage-reset' }, `resets ${resetStr}`)
              : el('span', { cls: 'ctrl-subusage-reset muted' }, 'reset unknown')
          );
          barsWrap.appendChild(winRow);
        }
        engRow.appendChild(barsWrap);
      }
      subUsageBody.appendChild(engRow);
    }
  }

  subUsageCard.appendChild(subUsageBody);
  section.appendChild(subUsageCard);

  // ── 7. Security (M67) ─────────────────────────────────────────────────
  const sec = d.security ?? {};
  const secFindings = Array.isArray(sec.findings) ? sec.findings : [];
  const secCounts = sec.counts ?? {};

  const secCard = el('div', { cls: 'ctrl-card card' });
  secCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Security'),
    el('span', { cls: 'card-subtitle' }, sec.available ? `${secFindings.length} finding(s)` : 'no data')
  ));
  const secBody = el('div', { cls: 'card-body' });

  if (!sec.available || secFindings.length === 0) {
    secBody.appendChild(el('p', { cls: 'hint' }, 'No security findings in cached backlog. Run a backlog scan to populate.'));
  } else {
    // Severity count badges
    const countsRow = el('div', { cls: 'ctrl-sec-counts' });
    if (secCounts.critical > 0) {
      countsRow.appendChild(el('span', { cls: 'ctrl-sec-badge ctrl-sec-badge--critical' }, `${secCounts.critical} critical`));
    }
    if (secCounts.high > 0) {
      countsRow.appendChild(el('span', { cls: 'ctrl-sec-badge ctrl-sec-badge--high' }, `${secCounts.high} high`));
    }
    if (secCounts.medium > 0) {
      countsRow.appendChild(el('span', { cls: 'ctrl-sec-badge ctrl-sec-badge--medium' }, `${secCounts.medium} medium`));
    }
    if (secCounts.low > 0) {
      countsRow.appendChild(el('span', { cls: 'ctrl-sec-badge ctrl-sec-badge--low' }, `${secCounts.low} low`));
    }
    secBody.appendChild(countsRow);

    // Findings list (capped at 20 to keep the panel scannable)
    const list = el('div', { cls: 'ctrl-sec-list' });
    for (const f of secFindings.slice(0, 20)) {
      const sev = f.severity ?? 'low';
      list.appendChild(el('div', { cls: 'ctrl-sec-row' },
        el('span', { cls: `ctrl-sec-sev ctrl-sec-sev--${sev}` }, sev),
        el('span', { cls: 'ctrl-sec-repo' }, f.repo ?? '?'),
        el('span', { cls: 'ctrl-sec-title' }, f.title ?? '')
      ));
    }
    if (secFindings.length > 20) {
      list.appendChild(el('p', { cls: 'hint' }, `+${secFindings.length - 20} more — run \`ashlr backlog\` to view all.`));
    }
    secBody.appendChild(list);
  }
  secCard.appendChild(secBody);
  section.appendChild(secCard);

  // ── 8. Activity log ───────────────────────────────────────────────────
  const logs = Array.isArray(d.logs) ? [...d.logs].reverse() : [];

  const logsCard = el('div', { cls: 'ctrl-card card' });
  logsCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Activity Log'),
    el('span', { cls: 'card-subtitle' }, `${logs.length} recent entries`)
  ));
  const logsBody = el('div', { cls: 'ctrl-log-body' });

  if (logs.length === 0) {
    logsBody.appendChild(el('p', { cls: 'hint' }, 'No recent activity.'));
  } else {
    for (const entry of logs.slice(0, 50)) {
      const kind = entry.kind ?? 'info';
      logsBody.appendChild(el('div', { cls: `ctrl-log-row ctrl-log-row--${kind}` },
        el('span', { cls: 'ctrl-log-ts' }, entry.ts ? fmtRelative(entry.ts) : '—'),
        el('span', { cls: `ctrl-log-kind ctrl-log-kind--${kind}` }, kind),
        el('span', { cls: 'ctrl-log-msg' }, entry.msg ?? '')
      ));
    }
  }
  logsCard.appendChild(logsBody);
  section.appendChild(logsCard);

  main.appendChild(section);
  if (_scrollY > 0) window.scrollTo(0, _scrollY);
}

// Small metric block used in the Mission Control hero + usage panel
function controlMetric(label, value, accent) {
  return el('div', { cls: 'ctrl-metric' },
    el('div', { cls: 'ctrl-metric-value', style: `color:${accent}` }, String(value)),
    el('div', { cls: 'ctrl-metric-label' }, label)
  );
}

// ---------------------------------------------------------------------------
// Fleet Activity (M90) — /api/fleet-activity live panel
// ---------------------------------------------------------------------------

async function loadFleetActivity() {
  if (state.fleetActivityLoading) return;
  state.fleetActivityLoading = true;
  if (!state.fleetActivity) showLoading('fleet-activity');
  try {
    state.fleetActivity = await apiFetch('/api/fleet-activity');
    renderFleetActivity();
  } catch (err) {
    if (!state.fleetActivity) showError('fleet-activity', err.message);
  } finally {
    state.fleetActivityLoading = false;
  }

  if (state.activeView === 'fleet-activity' && !state.fleetActivityInterval) {
    state.fleetActivityInterval = setInterval(() => {
      if (state.activeView !== 'fleet-activity') {
        clearInterval(state.fleetActivityInterval);
        state.fleetActivityInterval = null;
        return;
      }
      loadFleetActivity();
    }, 8000);
  }
}

function renderFleetActivity() {
  if (state.activeView !== 'fleet-activity') return;
  const main = getMain();
  if (!main) return;
  const _scrollY = window.scrollY;
  main.innerHTML = '';

  const d = state.fleetActivity;
  const section = el('section', { cls: 'view-section' });

  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Fleet Activity'),
    el('span', { cls: 'view-subtitle' }, d ? `Updated ${fmtRelative(d.ts)}` : 'Live fleet monitoring')
  ));

  if (!d) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Fleet activity unavailable.'),
      el('p', { cls: 'hint' }, 'Ensure the daemon is running.')
    ));
    main.appendChild(section);
    window.scrollTo(0, _scrollY);
    return;
  }

  // ── 1. Repo activity table ──────────────────────────────────────────────
  const reposCard = el('div', { cls: 'fa-card card' });
  reposCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Repo Activity (7d)'),
    el('span', { cls: 'card-subtitle' },
      `${d.totalProposed} proposed · ${d.totalAutoMerged} merged · ${d.totalPending} pending · ${d.totalDeclined} declined`
    )
  ));

  const repos = Array.isArray(d.repos) ? d.repos : [];
  if (repos.length === 0) {
    reposCard.appendChild(el('p', { cls: 'hint fa-card-body' }, 'No repo activity in the last 7 days.'));
  } else {
    const wrap = el('div', { cls: 'table-wrap fa-card-body' });
    const tbl = el('table');
    tbl.appendChild(el('thead', {},
      el('tr', {},
        el('th', {}, 'Repo'),
        el('th', {}, 'Proposed'),
        el('th', {}, 'Merged'),
        el('th', {}, 'Pending'),
        el('th', {}, 'Declined'),
      )
    ));
    const tbody = el('tbody');
    for (const r of repos) {
      const repoName = (r.repo ?? '(unscoped)').split('/').pop() || r.repo;
      tbody.appendChild(el('tr', {},
        el('td', { title: r.repo }, repoName),
        el('td', {}, String(r.proposed ?? 0)),
        el('td', { cls: r.autoMerged > 0 ? 'fa-cell-green' : '' }, String(r.autoMerged ?? 0)),
        el('td', { cls: r.pending > 0 ? 'fa-cell-pending' : '' }, String(r.pending ?? 0)),
        el('td', { cls: r.declined > 0 ? 'fa-cell-red' : '' }, String(r.declined ?? 0)),
      ));
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    reposCard.appendChild(wrap);
  }
  section.appendChild(reposCard);

  // ── 2. Engine readiness badges ─────────────────────────────────────────
  const readinessCard = el('div', { cls: 'fa-card card' });
  readinessCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Engine Readiness'),
    el('span', { cls: 'card-subtitle' }, 'Installed · Authenticated · Ready')
  ));
  const readinessBody = el('div', { cls: 'fa-readiness-body fa-card-body' });
  const engines = Array.isArray(d.engineReadiness) ? d.engineReadiness : [];
  if (engines.length === 0) {
    readinessBody.appendChild(el('p', { cls: 'hint' }, 'No engines configured.'));
  } else {
    for (const eng of engines) {
      const ready = eng.ready;
      const authed = eng.authed;
      const rowCls = `fa-engine-row${ready ? ' fa-engine-ready' : ' fa-engine-notready'}`;
      const statusCls = `fa-engine-dot${ready ? ' ready' : authed === 'unknown' ? ' warn' : ' fail'}`;
      const row = el('div', { cls: rowCls },
        el('span', { cls: statusCls, title: ready ? 'Ready' : eng.fix ?? eng.detail }),
        el('span', { cls: 'fa-engine-id' }, eng.engine),
        el('span', { cls: 'fa-engine-tier badge' }, eng.tier ?? ''),
        el('span', { cls: 'fa-engine-detail' }, eng.detail ?? '')
      );
      if (!ready && eng.fix) {
        row.appendChild(el('span', { cls: 'fa-engine-fix' }, `Fix: ${eng.fix}`));
      }
      readinessBody.appendChild(row);
    }
  }
  readinessCard.appendChild(readinessBody);
  section.appendChild(readinessCard);

  // ── 3. Subscription burn-down bars ─────────────────────────────────────
  const subUsageEngines = Array.isArray(d.subscriptionUsage) ? d.subscriptionUsage : [];
  const subCard = el('div', { cls: 'fa-card card' });
  subCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Subscription Burn-down'),
    el('span', { cls: 'card-subtitle' }, 'Per-engine window usage')
  ));
  const subBody = el('div', { cls: 'fa-card-body' });
  for (const eng of subUsageEngines) {
    const planLabel = eng.plan ? ` (${eng.plan})` : '';
    const engRow = el('div', { cls: 'ctrl-subusage-engine' });
    engRow.appendChild(el('div', { cls: 'ctrl-subusage-engine-name' },
      el('span', { cls: 'ctrl-subusage-engine-id' }, eng.engine),
      el('span', { cls: 'ctrl-subusage-plan' }, planLabel)
    ));
    if (!eng.hasData || !Array.isArray(eng.windows) || eng.windows.length === 0) {
      engRow.appendChild(el('p', { cls: 'ctrl-subusage-unknown' }, 'No local usage signal.'));
    } else {
      const barsWrap = el('div', { cls: 'ctrl-subusage-bars' });
      for (const win of eng.windows) {
        const pct = Math.min(100, Math.max(0, Math.round(win.usedPercent ?? 0)));
        const barColor = pct >= 90 ? 'var(--status-failed)' : pct >= 70 ? 'var(--status-aborted)' : 'var(--status-done)';
        const resetStr = win.resetsAt
          ? new Date(win.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : null;
        barsWrap.appendChild(el('div', { cls: 'ctrl-subusage-win-row' },
          el('span', { cls: 'ctrl-subusage-win-label' }, win.label ?? '?'),
          el('div', { cls: 'ctrl-subusage-bar-track' },
            el('div', { cls: 'ctrl-subusage-bar', style: `width:${pct}%;background:${barColor}` })
          ),
          el('span', { cls: 'ctrl-subusage-pct', style: `color:${barColor}` }, `${pct}%`),
          resetStr
            ? el('span', { cls: 'ctrl-subusage-reset' }, `resets ${resetStr}`)
            : el('span', { cls: 'ctrl-subusage-reset muted' }, 'reset unknown')
        ));
      }
      engRow.appendChild(barsWrap);
    }
    subBody.appendChild(engRow);
  }
  if (subUsageEngines.length === 0) {
    subBody.appendChild(el('p', { cls: 'hint' }, 'No subscription engines detected.'));
  }
  subCard.appendChild(subBody);
  section.appendChild(subCard);

  // ── 4. Recent auto-merge feed ──────────────────────────────────────────
  const mergesCard = el('div', { cls: 'fa-card card' });
  mergesCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Auto-Merge Feed'),
    el('span', { cls: 'card-subtitle' }, `${(d.recentMerges ?? []).length} recent events`)
  ));
  const mergesBody = el('div', { cls: 'fa-feed fa-card-body' });
  const merges = Array.isArray(d.recentMerges) ? d.recentMerges : [];
  if (merges.length === 0) {
    mergesBody.appendChild(el('p', { cls: 'hint' }, 'No auto-merge events recorded.'));
  } else {
    for (const m of merges) {
      const repoName = m.repo ? m.repo.split('/').pop() || m.repo : '?';
      mergesBody.appendChild(el('div', { cls: 'fa-feed-row' },
        el('span', { cls: 'fa-feed-dot' }),
        el('span', { cls: 'fa-feed-time' }, fmtRelative(m.ts)),
        el('span', { cls: 'fa-feed-repo' }, repoName),
        el('span', { cls: 'fa-feed-engine badge' }, m.engine ?? 'fleet'),
        m.proposalId ? el('span', { cls: 'fa-feed-pid' }, m.proposalId.slice(0, 8)) : null
      ));
    }
  }
  mergesCard.appendChild(mergesBody);
  section.appendChild(mergesCard);

  // ── 5. Cooldown count + Live tick stream ───────────────────────────────
  const statsRow = el('div', { cls: 'fa-stats-row' });

  const coolCard = el('div', { cls: 'fa-card card fa-stat-mini' });
  coolCard.appendChild(el('div', { cls: 'fa-stat-val' }, String(d.cooldownCount ?? 0)));
  coolCard.appendChild(el('div', { cls: 'fa-stat-lbl' }, 'On cooldown'));
  statsRow.appendChild(coolCard);

  const pendCard = el('div', { cls: 'fa-card card fa-stat-mini' });
  pendCard.appendChild(el('div', { cls: 'fa-stat-val' }, String(d.totalPending ?? 0)));
  pendCard.appendChild(el('div', { cls: 'fa-stat-lbl' }, 'Pending proposals'));
  statsRow.appendChild(pendCard);

  const mergedCard = el('div', { cls: 'fa-card card fa-stat-mini' });
  mergedCard.appendChild(el('div', { cls: 'fa-stat-val fa-stat-green' }, String(d.totalAutoMerged ?? 0)));
  mergedCard.appendChild(el('div', { cls: 'fa-stat-lbl' }, 'Auto-merged (7d)'));
  statsRow.appendChild(mergedCard);

  section.appendChild(statsRow);

  // ── 6. Live tick stream ────────────────────────────────────────────────
  const ticksCard = el('div', { cls: 'fa-card card' });
  ticksCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Daemon Tick Stream'),
    el('span', { cls: 'card-subtitle' }, 'Newest first')
  ));
  const ticksBody = el('div', { cls: 'fa-ticks fa-card-body' });
  const ticks = Array.isArray(d.recentTicks) ? d.recentTicks : [];
  if (ticks.length === 0) {
    ticksBody.appendChild(el('p', { cls: 'hint' }, 'No daemon ticks yet — is the daemon running?'));
  } else {
    for (const t of ticks) {
      const backendsStr = t.backends && Object.keys(t.backends).length > 0
        ? Object.entries(t.backends).map(([k, v]) => `${k}:${v}`).join(' ')
        : '';
      const hasMerge = t.merged > 0;
      const tickCls = `fa-tick-row${hasMerge ? ' fa-tick-merged' : ''}`;
      ticksBody.appendChild(el('div', { cls: tickCls },
        el('span', { cls: 'fa-tick-dot' }),
        el('span', { cls: 'fa-tick-time' }, fmtRelative(t.ts)),
        el('span', { cls: 'fa-tick-reason' }, t.reason ?? 'ok'),
        backendsStr ? el('span', { cls: 'fa-tick-backends' }, backendsStr) : null,
        t.spentUsd > 0 ? el('span', { cls: 'fa-tick-spend' }, `$${t.spentUsd.toFixed(4)}`) : null,
        hasMerge ? el('span', { cls: 'fa-tick-merge-badge' }, `+${t.merged} merged`) : null
      ));
    }
  }
  ticksCard.appendChild(ticksBody);
  section.appendChild(ticksCard);

  main.appendChild(section);
  window.scrollTo(0, _scrollY);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  renderShell();

  // Connect SSE first so events can patch data while views load
  connectSSE();

  // Wire SSE dot
  if (state.eventSource) {
    state.eventSource.addEventListener('open', () => updateSseDot(true));
    state.eventSource.addEventListener('error', () => updateSseDot(false));
  }

  // Hash routing
  window.addEventListener('hashchange', onHashChange);

  // Initial view
  onHashChange();

  // M32: initialise token indicator after shell is rendered
  updateTokenIndicator();
});
