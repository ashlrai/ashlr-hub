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

const VIEWS = ['fleet-dashboard', 'control', 'fleet-activity', 'goals', 'overview', 'runs', 'swarms', 'pulse', 'models', 'genome', 'portfolio', 'inbox', 'daemon', 'fleet'];
const DEFAULT_VIEW = 'fleet-dashboard';
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
  goals: null,              // M104: GET /api/goals goal list + progress
  // M210: Fleet Dashboard
  fleetDashboard: null,             // latest DashboardSnapshot
  fleetDashboardInterval: null,     // auto-refresh timer
  fleetDashboardSettings: null,     // persisted settings (loaded lazily)
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

async function toggleFleetPaused(targetPaused) {
  const token = getToken();
  if (!token) {
    showToast('No session token — click the gear icon to set it.');
    return;
  }
  try {
    const action = targetPaused ? 'pause' : 'resume';
    const result = await apiPost(`/api/fleet/${action}`, token);
    if (result.fleet) {
      state.fleet = result.fleet;
      if (state.control) state.control.fleet = result.fleet;
      if (state.fleetDashboard) state.fleetDashboard.fleet = result.fleet;
    }
    showToast(targetPaused ? 'Fleet paused.' : 'Fleet resumed.');
    if (state.activeView === 'fleet') {
      renderFleet();
      await loadFleet();
    } else if (state.activeView === 'control') {
      renderControl();
      await loadControl();
    } else if (state.activeView === 'fleet-dashboard') {
      renderFleetDashboard();
      await loadFleetDashboard();
    }
  } catch (err) {
    showToast(`Fleet control failed: ${err.message}`);
  }
}

async function repairDaemonService() {
  const token = getToken();
  if (!token) {
    showToast('No session token — click the gear icon to set it.');
    return;
  }
  try {
    const result = await apiPost('/api/daemon/service/repair', token);
    if (state.control && result.service) {
      state.control.daemon = Object.assign({}, state.control.daemon ?? {}, { service: result.service });
    }
    showToast(result.service?.running ? 'Daemon service repaired and running.' : 'Daemon service repair completed.');
    if (state.activeView === 'control') {
      renderControl();
      await loadControl();
    }
  } catch (err) {
    showToast(`Service repair failed: ${err.message}`);
  }
}

function fleetPauseResumeButton(isPaused, size = '') {
  const targetPaused = !isPaused;
  const btn = el('button', {
    cls: `btn ${targetPaused ? 'btn-danger' : 'btn-secondary'}${size ? ` ${size}` : ''}`,
    type: 'button',
    title: targetPaused ? 'Engage kill switch' : 'Clear kill switch',
  }, targetPaused ? 'Pause fleet' : 'Resume fleet');
  btn.addEventListener('click', () => { void toggleFleetPaused(targetPaused); });
  return btn;
}

// Show a brief toast notification. Uses #toast-region if present (see index.html).
function showToast(msg) {
  try {
    const region = document.getElementById('toast-region') ?? document.body;
    const t = el('div', { cls: 'toast', 'aria-live': 'polite' }, msg);
    region.appendChild(t);
    setTimeout(() => { try { region.removeChild(t); } catch {} }, 3500);
  } catch {}
}

// Open an enrolled repo (or file within one) on the local desktop.
// action: 'editor' | 'finder'. Requires a session token.
async function apiOpenRepo(repo, action) {
  const token = getToken();
  if (!token) {
    showToast('No session token — click the gear icon to set it.');
    return;
  }
  try {
    const res = await fetch(API_BASE + '/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
      body: JSON.stringify({ repo, action }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(`Open failed: ${j.error ?? res.status}`);
    }
  } catch (err) {
    showToast(`Open failed: ${err.message}`);
  }
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
      try {
        const data = JSON.parse(e.data);
        // M213: snapshot SSE push — update both overview state and fleet-dashboard state.
        state.snapshot = data;
        state.fleetDashboard = data;
        if (state.activeView === 'fleet-dashboard') {
          renderFleetDashboard();
        } else if (state.activeView === 'overview') {
          renderActiveView();
        }
        // SSE is live — suppress the polling fallback interval to avoid redundant fetches.
        if (state.fleetDashboardInterval) {
          clearInterval(state.fleetDashboardInterval);
          state.fleetDashboardInterval = null;
        }
      } catch {}
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
        // M335/M337: verdict/merge activity changes per-model ROI — refresh
        // the tab QUIETLY and at most every 30s (the inbox SSE event fires on
        // every poll tick, and showLoading() would wipe the table each time).
        if (state.activeView === 'models') {
          const nowMs = Date.now();
          if (!state.modelsRefreshedAt || nowMs - state.modelsRefreshedAt > 30_000) {
            loadModels(state.models?.window ?? '30d', { quiet: true });
          }
        }
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
      // M213: SSE dropped — restart polling fallback so fleet-dashboard stays fresh.
      updateSseDot(false);
      if (state.activeView === 'fleet-dashboard' && !state.fleetDashboardInterval) {
        const settings = fdLoadSettings();
        state.fleetDashboardInterval = setInterval(() => {
          if (state.activeView !== 'fleet-dashboard') {
            clearInterval(state.fleetDashboardInterval);
            state.fleetDashboardInterval = null;
            return;
          }
          loadFleetDashboard();
        }, settings.refreshSecs * 1000);
      }
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
  if (view === 'fleet-dashboard') renderFleetDashboard();
  else if (view === 'control') renderControl();
  if (view === 'fleet-activity') renderFleetActivity();
  else if (view === 'goals') renderGoals();
  else if (view === 'overview') renderOverview();
  else if (view === 'runs') renderRuns();
  else if (view === 'swarms') renderSwarms();
  else if (view === 'pulse') renderPulse();
  else if (view === 'models') renderModels();
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
  // Stop fleet-dashboard polling when navigating away (M210)
  if (view !== 'fleet-dashboard' && state.fleetDashboardInterval) {
    clearInterval(state.fleetDashboardInterval);
    state.fleetDashboardInterval = null;
  }
  if (view === 'fleet-dashboard') await loadFleetDashboard();
  else if (view === 'control') await loadControl();
  else if (view === 'fleet-activity') await loadFleetActivity();
  else if (view === 'goals') await loadGoals();
  else if (view === 'overview') await loadOverview();
  else if (view === 'runs') await loadRuns();
  else if (view === 'swarms') await loadSwarms();
  else if (view === 'pulse') await loadPulse();
  else if (view === 'models') await loadModels();
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
    'fleet-dashboard': '<rect x="1" y="1" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="9" y="1" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="1" y="9" width="14" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="4" y1="12" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    control:   '<rect x="1" y="1" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><line x1="4" y1="13" x2="12" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="10" x2="8" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="5" cy="5.5" r="1.3" fill="currentColor" opacity=".9"/><circle cx="8" cy="5.5" r="1.3" fill="currentColor" opacity=".6"/><circle cx="11" cy="5.5" r="1.3" fill="currentColor" opacity=".35"/>',
    overview:  '<rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity=".85"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity=".55"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity=".55"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity=".3"/>',
    runs:      '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><polyline points="5.5,8 7.5,10 10.5,6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    swarms:    '<circle cx="8" cy="3" r="2" fill="currentColor" opacity=".9"/><circle cx="3" cy="13" r="2" fill="currentColor" opacity=".7"/><circle cx="13" cy="13" r="2" fill="currentColor" opacity=".7"/><line x1="8" y1="5" x2="3" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="8" y1="5" x2="13" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="3" y1="13" x2="13" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    pulse:     '<polyline points="1,8 4,8 5.5,3 7,13 8.5,6 10,10 11.5,8 15,8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    genome:    '<path d="M5,1 Q8,4 5,7 Q8,10 5,13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M11,1 Q8,4 11,7 Q8,10 11,13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><line x1="6.5" y1="3.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6" y1="7" x2="10" y2="7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6.5" y1="10.5" x2="9.5" y2="10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    portfolio: '<rect x="1.5" y="9" width="3" height="5.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="6.5" y="5" width="3" height="9.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="11.5" y="2" width="3" height="12.5" rx="0.6" stroke="currentColor" stroke-width="1.2" fill="none"/>',
    inbox:     '<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><polyline points="1.5,5 8,9.5 14.5,5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    daemon:    '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="8" y1="4.5" x2="8" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="8" x2="11" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    goals:     '<polyline points="2,4 7,4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polyline points="2,8 14,8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polyline points="2,12 11,12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polyline points="13,10 15,12 13,14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
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

    const VIEW_LABELS = { 'fleet-dashboard': 'Fleet Dashboard', control: 'Mission Control', 'fleet-activity': 'Fleet Activity', goals: 'Goals' };
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
// Models view (M335) — per-model ship rate, cost-per-merge, outcomes, BoN wins
// ---------------------------------------------------------------------------

// M338: monotonically increasing fetch token — a stale (slower/older)
// response must never overwrite a newer window selection.
let _modelsFetchSeq = 0;
// M339: background (quiet) refreshes are SECOND-CLASS — they must never
// preempt an in-flight load. Without this, a quiet SSE refresh could take a
// newer seq, discard the user fetch's response, and — if the quiet fetch
// then failed with errors suppressed — strand the view on the spinner.
let _modelsFetchBusy = false;

async function loadModels(window = '30d', opts = {}) {
  if (opts.quiet && _modelsFetchBusy) return;
  const seq = ++_modelsFetchSeq;
  _modelsFetchBusy = true;
  // M337: quiet refreshes (SSE-triggered) keep the table on screen — only a
  // user-initiated load shows the spinner.
  if (!opts.quiet) showLoading('models');
  try {
    const data = await apiFetch(`/api/models?window=${window}`);
    if (seq !== _modelsFetchSeq) return; // superseded by a newer request
    state.models = data;
    state.modelsRefreshedAt = Date.now();
    renderModels();
  } catch (err) {
    if (seq !== _modelsFetchSeq) return;
    // M338: failures also arm the 30s throttle (otherwise every 1.5s SSE
    // tick refires the failing fetch), and a QUIET failure keeps the table
    // on screen instead of wiping it with the error panel.
    state.modelsRefreshedAt = Date.now();
    if (!opts.quiet) showError('models', err.message);
  } finally {
    // Only the CURRENT request owns the busy latch — a superseded call must
    // not clear it out from under the newer one.
    if (seq === _modelsFetchSeq) _modelsFetchBusy = false;
  }
}

function renderModels() {
  if (state.activeView !== 'models') return;
  const data = state.models;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });

  const windowPicker = el('div', { cls: 'window-picker' });
  for (const w of ['7d', '30d', 'all']) {
    const btn = el('button', {
      cls: `btn window-btn ${data?.window === w ? 'active' : ''}`,
      onClick: () => loadModels(w)
    }, w);
    windowPicker.appendChild(btn);
  }
  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Models'),
    windowPicker
  ));

  const bestOfNSource = data?.bestOfNSource;
  const bestOfNHealthy = !bestOfNSource ||
    (bestOfNSource.sourceState === 'healthy' && bestOfNSource.complete === true);
  if (bestOfNSource) {
    const sourceText = bestOfNSource.sourceState === 'missing'
      ? 'Best-of-N evidence source is missing; race metrics are unavailable.'
      : bestOfNHealthy
        ? `Best-of-N evidence is complete (${bestOfNSource.rowsScanned ?? 0} rows).`
        : `Best-of-N evidence is partial (${(bestOfNSource.stopReasons ?? []).join(', ') || 'source degraded'}); race metrics are withheld.`;
    section.appendChild(el('p', { cls: 'hint' }, sourceText));
  }

  const models = data?.models ?? [];
  if (models.length === 0) {
    section.appendChild(el('p', {},
      'No model telemetry yet — dispatch some work and the per-model ROI (ship rate, cost per merge, best-of-N win rate) lands here.'));
    main.appendChild(section);
    return;
  }

  const wrap = el('div', { cls: 'table-wrap' });
  const table = el('table', { cls: 'data-table' });
  const thead = el('thead', {});
  const headerRow = el('tr', {});
  for (const h of ['Model', 'Dispatches', 'Ship rate', 'Merged', 'Rev / Fix', 'Spend', '$ / merge', 'Latency', 'BoN wins']) {
    headerRow.appendChild(el('th', {}, h));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody', {});
  for (const m of models) {
    const tr = el('tr', { cls: 'table-row' });
    tr.appendChild(el('td', { title: m.engineModel }, m.engineModel));
    tr.appendChild(el('td', { cls: 'num' }, String(m.dispatches)));
    tr.appendChild(el('td', { cls: 'num' }, m.judged > 0 ? `${Math.round(m.shipRate * 100)}%` : '—'));
    tr.appendChild(el('td', { cls: 'num' }, String(m.merged)));
    tr.appendChild(el('td', { cls: 'num' }, `${m.outcomes?.reverted ?? 0} / ${m.outcomes?.followedUp ?? 0}`));
    tr.appendChild(el('td', { cls: 'num' }, `$${fmt((m.costUsd ?? 0) + (m.judgeCostUsd ?? 0))}`));
    tr.appendChild(el('td', { cls: 'num' }, m.costPerMergedUsd != null ? `$${fmt(m.costPerMergedUsd)}` : '—'));
    tr.appendChild(el('td', { cls: 'num' }, m.avgLatencyMs != null ? `${Math.round(m.avgLatencyMs / 1000)}s` : '—'));
    tr.appendChild(el('td', { cls: 'num' },
      !bestOfNHealthy
        ? 'unavailable'
        : m.bestOfN?.entered > 0
          ? `${m.bestOfN.won}/${m.bestOfN.entered} (${Math.round(m.bestOfN.winRate * 100)}%)`
          : '—'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  main.appendChild(section);
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

// M104: Desktop-action helpers — generic rendering for proposals that carry
// an `action` payload (kind==='desktop-action' or any proposal with action).
// Never special-cases the inbox decision mechanics — reuses the existing path.

/**
 * Return a one-line summary element for the inbox row, or null when the
 * proposal has no action payload.
 */
function buildDesktopActionSummary(p) {
  const action = p.action;
  if (!action && p.kind !== 'desktop-action') return null;
  const type = action?.type ?? p.kind ?? 'action';
  const target = action?.target;
  const label = target
    ? `🖥 ${type}: ${truncate(String(target), 60)}`
    : `🖥 ${type}`;
  return el('div', { cls: 'inbox-row__action-summary' }, label);
}

/**
 * Return a detail card element for a desktop-action proposal, or null when
 * there is no action payload. Shown in the inbox detail pane above the diff.
 */
function buildDesktopActionCard(p) {
  const action = p.action;
  if (!action && p.kind !== 'desktop-action') return null;

  const card = el('div', { cls: 'inbox-action-card card' });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, '🖥 Desktop Action')
  ));
  const body = el('div', { cls: 'card-body' });

  if (action) {
    const pairs = [];
    if (action.type)   pairs.push(['Type',   String(action.type)]);
    if (action.target) pairs.push(['Target', String(action.target)]);
    // Render any additional params generically
    const extra = Object.entries(action).filter(([k]) => k !== 'type' && k !== 'target');
    for (const [k, v] of extra) {
      pairs.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    }
    if (pairs.length > 0) {
      body.appendChild(infoGrid(pairs));
    }
  } else {
    body.appendChild(el('p', { cls: 'hint' }, `Kind: ${p.kind}`));
  }

  card.appendChild(body);
  return card;
}

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
    // Group by repo for scannability; unscoped proposals go last.
    const groups = new Map();
    for (const p of proposals) {
      const key = p.repo ?? '(unscoped)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const [repo, group] of groups) {
      const repoLabel = repo === '(unscoped)' ? '(unscoped)' : (repo.split('/').pop() || repo);
      list.appendChild(el('div', { cls: 'inbox-group-header' }, repoLabel));
      for (const p of group) {
        list.appendChild(buildInboxRow(p));
      }
    }
    section.appendChild(list);
  }

  main.appendChild(section);
}

function buildInboxRow(p) {
  const row = el('div', { cls: 'inbox-row', style: 'cursor:pointer' });
  const repoBase = (p.repo ?? '').split('/').filter(Boolean).pop() ?? p.repo ?? '—';

  const metaChildren = [
    el('span', { cls: 'badge badge-kind' }, p.kind ?? 'proposal'),
    el('span', { cls: 'inbox-row__repo' }, repoBase),
    el('span', { cls: 'ts' }, fmtRelative(p.createdAt)),
  ];
  // Show open-in-editor button when a session token is present.
  if (getToken() && p.repo) {
    metaChildren.push(el('button', {
      cls: 'open-repo-btn',
      type: 'button',
      title: `Open ${p.repo} in editor`,
      onClick: (e) => { e.stopPropagation(); apiOpenRepo(p.repo, 'editor'); },
    }, '↗ Open'));
  }

  // M104: desktop-action summary line — shown when proposal carries an action payload
  const actionSummary = buildDesktopActionSummary(p);

  row.appendChild(el('div', { cls: 'inbox-row__main' },
    el('span', { cls: 'inbox-row__title', title: p.title }, truncate(p.title ?? '(untitled)', 80)),
    actionSummary,
    el('div', { cls: 'inbox-row__meta' }, ...metaChildren)
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
  const risk = p.riskClass ?? p.riskLevel ?? '—';
  const verify =
    p.verifyResult == null
      ? '—'
      : p.verifyResult.passed === true
        ? 'passed'
        : `failed${Array.isArray(p.verifyResult.failed) && p.verifyResult.failed.length > 0 ? ` (${p.verifyResult.failed.length})` : ''}`;
  const taste =
    p.taste == null
      ? '—'
      : `${p.taste.verdict ?? 'scored'}${typeof p.taste.overall === 'number' ? ` (${fmt(p.taste.overall, 1)}/5)` : ''}`;

  // Summary card
  const summary = el('div', { cls: 'inbox-detail__summary card' });
  summary.appendChild(el('h2', { cls: 'card-title' }, p.title ?? '(untitled)'));
  const infoPairs = [
    ['Kind',    p.kind ?? '—'],
    ['Repo',    p.repo ?? '—'],
    ['Engine',  p.engine ?? '—'],
    ['Risk',    risk],
    ['Verify',  verify],
    ['Taste',   taste],
    ['Origin',  p.origin ?? '—'],
    ['Status',  p.status ?? '—'],
    ['Created', fmtDate(p.createdAt)],
  ];
  summary.appendChild(infoGrid(infoPairs));
  detail.appendChild(summary);

  // M104: desktop-action card — rendered when proposal has kind==='desktop-action' or action payload
  const actionCard = buildDesktopActionCard(p);
  if (actionCard) detail.appendChild(actionCard);

  // Diff — per-line color rendering (added/removed/meta)
  if (p.diff) {
    const diffSection = el('div', { cls: 'inbox-detail__diff-wrap' });
    diffSection.appendChild(el('h3', { cls: 'section-heading' }, 'Diff'));
    const pre = el('pre', { cls: 'inbox-diff' });
    for (const line of p.diff.split('\n')) {
      const lineCls =
        (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@'))
          ? 'diff-line--meta'
          : line.startsWith('+') ? 'diff-line--added'
          : line.startsWith('-') ? 'diff-line--removed'
          : '';
      const span = document.createElement('span');
      if (lineCls) span.className = lineCls;
      span.textContent = line + '\n';
      pre.appendChild(span);
    }
    diffSection.appendChild(pre);
    detail.appendChild(diffSection);
  }

  // Approve / Reject buttons + open + result
  const actionsDiv = el('div', { cls: 'inbox-detail__actions' });
  const resultLine = el('div', { cls: 'inbox-detail__result', 'aria-live': 'polite' });

  // "Open in editor" — available whenever a token is set, independent of dispatchEnabled.
  if (getToken() && p.repo) {
    actionsDiv.appendChild(el('button', {
      cls: 'btn open-repo-btn',
      type: 'button',
      title: `Open ${p.repo} in editor`,
      onClick: () => apiOpenRepo(p.repo, 'editor'),
    }, '↗ Open in editor'));
  }

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
    ['Last tick', d.lastTickAt ? fmtRelative(d.lastTickAt) : '—'],
    ['Today spend', d.todaySpentUsd != null ? `$${d.todaySpentUsd.toFixed(4)}` : '—'],
    ['Spend cap', d.spendCapUsd != null ? `$${d.spendCapUsd.toFixed(2)}` : '—'],
    ['Pending proposals', d.pendingProposals ?? state.inboxBadge ?? '—'],
  ];
  card.appendChild(infoGrid(pairs));

  // Spend vs cap mini bar
  if (d.spendCapUsd != null && d.todaySpentUsd != null) {
    const pct = Math.min(100, (d.todaySpentUsd / d.spendCapUsd) * 100);
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

function sharedQueueMetric(shared) {
  if (!shared) return null;
  if (!shared.readable) return 'unreadable';
  const suffix = shared.lock?.stale ? ' · stale lock' : '';
  return `${shared.activeClaims ?? 0} active / ${shared.reclaimableClaims ?? 0} reclaimable${suffix}`;
}

function queueEligibilityMetric(queue) {
  if (!queue || typeof queue.eligibleBacklogItems !== 'number') return null;
  return `${queue.eligibleBacklogItems} eligible / ${queue.cooldownItems ?? 0} cooling / ${queue.pendingItems ?? 0} pending`;
}

function generatedWorkMetric(generatedWork) {
  if (!generatedWork || typeof generatedWork.total !== 'number' || generatedWork.total <= 0) return null;
  const parts = [`${generatedWork.total} generated`];
  if ((generatedWork.captureRepairs ?? 0) > 0) parts.push(formatGeneratedWorkCount(generatedWork.captureRepairs, 'capture repair'));
  if ((generatedWork.diagnosticReslices ?? 0) > 0) parts.push(formatGeneratedWorkCount(generatedWork.diagnosticReslices, 'no-diff reslice'));
  if ((generatedWork.proposalRepair ?? 0) > 0) parts.push(formatGeneratedWorkCount(generatedWork.proposalRepair, 'proposal-repair item'));
  if ((generatedWork.selfHeal ?? 0) > 0) parts.push(formatGeneratedWorkCount(generatedWork.selfHeal, 'self-heal item'));
  if ((generatedWork.invent ?? 0) > 0) parts.push(formatGeneratedWorkCount(generatedWork.invent, 'invent item'));
  return parts.join(' / ');
}

function formatGeneratedWorkCount(count, singularLabel, pluralLabel = `${singularLabel}s`) {
  return `${count} ${count === 1 ? singularLabel : pluralLabel}`;
}

function diagnosticResliceDrainMetric(drain) {
  if (!drain || drain.mode !== 'diagnostic-reslices') return null;
  const limit = typeof drain.limit === 'number' ? `/${drain.limit}` : '';
  const state = [
    drain.automatic ? 'auto' : null,
    drain.capped ? 'capped' : null,
    drain.stalled ? 'stalled' : null,
  ].filter(Boolean);
  return `${drain.selected ?? 0}${limit} selected / ${drain.available ?? 0} available` +
    (state.length ? ` (${state.join(', ')})` : '');
}

function laneLocksMetric(laneLocks) {
  if (!laneLocks) return null;
  return `${laneLocks.active ?? 0} active / ${laneLocks.staleInProgress ?? 0} stale / ${laneLocks.awaitingHostMerge ?? 0} handoff / ${laneLocks.unverifiedApplied ?? 0} unverified`;
}

function autonomyEvidenceMetric(autonomy) {
  if (!autonomy || !autonomy.evidencePacks) return '0 packs';
  return `${autonomy.evidencePacks} packs / ${autonomy.allowed ?? 0} allowed / ${autonomy.denied ?? 0} denied`;
}

function compactFleetReason(reason, max = 88) {
  const clean = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, Math.max(0, max - 3)) + '...' : clean;
}

function backendResourceText(backend) {
  const resource = backend?.resource;
  if (!resource) return '';
  const parts = [resource.availability ?? 'unknown'];
  if (typeof resource.usedPct === 'number') parts.push(`${Math.round(resource.usedPct)}%`);
  if (resource.resetsAt) parts.push(`resets ${new Date(resource.resetsAt * 1000).toLocaleString()}`);
  if (resource.reason) parts.push(compactFleetReason(resource.reason));
  return parts.join(' · ');
}

function strategicTierLabel(tier) {
  const labels = {
    'core-fleet': 'Core fleet',
    'force-multiplier': 'Force multipliers',
    inventory: 'Inventory',
    supporting: 'Supporting',
  };
  return labels[tier] ?? String(tier ?? 'Unknown');
}

function basenameFromPath(path) {
  if (typeof path !== 'string' || path.length === 0) return '?';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function renderStrategicFocusCard(queue, cls = 'ctrl-card card') {
  const coverage = queue?.repos;
  if (!coverage || !Array.isArray(coverage.byTier)) return null;

  const tierRows = coverage.byTier.filter((row) => row && typeof row === 'object');
  const byTier = new Map(tierRows.map((row) => [row.tier, row]));
  const order = ['core-fleet', 'force-multiplier', 'inventory', 'supporting'];
  const rows = order.map((tier) => {
    const row = byTier.get(tier) ?? { tier, repos: 0, items: 0 };
    return [
      strategicTierLabel(tier),
      `${row.items ?? 0} item${row.items === 1 ? '' : 's'} / ${row.repos ?? 0} repo${row.repos === 1 ? '' : 's'}`,
    ];
  });

  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Strategic Ecosystem Focus'),
    el('span', { cls: 'card-subtitle' }, `${coverage.withBacklog ?? 0}/${coverage.existing ?? 0} active enrolled repos`)
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid(rows));

  const top = Array.isArray(coverage.top) ? coverage.top.slice(0, 5) : [];
  if (top.length > 0) {
    const list = el('div', { cls: 'ctrl-backend-list' });
    for (const repo of top) {
      list.appendChild(el('div', { cls: 'ctrl-backend-row' },
        el('span', { cls: 'ctrl-backend-name' }, basenameFromPath(repo.repo)),
        el('span', { cls: 'ctrl-backend-dispatches' }, `${repo.items ?? 0} backlog item${repo.items === 1 ? '' : 's'}`)
      ));
    }
    body.appendChild(list);
  }

  const core = byTier.get('core-fleet');
  if (!core || core.items === 0) {
    body.appendChild(el('p', { cls: 'hint' }, 'No core-fleet backlog items in the cached queue.'));
  }

  card.appendChild(body);
  return card;
}

function formatEffectivenessPhase(phase) {
  const labels = {
    'control-blocked': 'Control Blocked',
    'host-handoff': 'Host Handoff',
    'merge-ready': 'Merge Ready',
    'verification-needed': 'Verification Needed',
    'merge-blocked': 'Merge Blocked',
    'proposal-starved': 'Proposal Starved',
    'cooldown-gated': 'Cooldown Gated',
    idle: 'Idle',
  };
  return labels[phase] ?? String(phase ?? 'Unknown');
}

function effectivenessAccent(phase) {
  const colors = {
    'control-blocked': '#f87171',
    'merge-blocked': '#f97316',
    'verification-needed': '#fbbf24',
    'proposal-starved': '#a78bfa',
    'cooldown-gated': '#60a5fa',
    'host-handoff': '#38bdf8',
    'merge-ready': '#4ade80',
    idle: '#94a3b8',
  };
  return colors[phase] ?? '#94a3b8';
}

function renderAutonomyEffectivenessCard(effectiveness, cls = 'ctrl-card card') {
  if (!effectiveness) return null;
  const counts = effectiveness.counts ?? {};
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Autonomy Effectiveness'),
    el('span', { cls: 'card-subtitle' }, formatEffectivenessPhase(effectiveness.phase))
  ));
  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Phase', formatEffectivenessPhase(effectiveness.phase)],
    ['Bottleneck', effectiveness.bottleneck ?? 'unknown'],
    ['Merge now', effectiveness.canAutoMergeNow ? 'yes' : 'no'],
    ['Backlog', counts.backlogItems ?? 0],
    ['Eligible', counts.eligibleBacklogItems ?? counts.backlogItems ?? 0],
    ['Pending', counts.pendingProposals ?? 0],
    ['Ready', counts.preflightReady ?? 0],
    ['Verify', counts.needsVerification ?? 0],
    ['Blocked', counts.blocked ?? 0],
    ['Host PRs', counts.awaitingHostMerge ?? 0],
    ['Merges 24h', counts.recentMerges ?? 0],
  ]));
  if (effectiveness.summary) {
    body.appendChild(el('p', { cls: 'hint' }, effectiveness.summary));
  }
  card.appendChild(body);
  return card;
}

function proposalProductionWindowLabel(production) {
  const hours = Number(production?.windowHours);
  if (!Number.isFinite(hours) || hours <= 0) return '24h';
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function proposalProductionReasons(production, limit = 3) {
  const reasons = Array.isArray(production?.diagnosticTopReasons)
    ? production.diagnosticTopReasons
    : Array.isArray(production?.topReasons) ? production.topReasons : [];
  return reasons
    .slice(0, limit)
    .map((row) => `${row.count ?? 0}x ${compactFleetReason(row.reason ?? 'unknown')}`);
}

function renderProposalProductionCard(production, cls = 'ctrl-card card') {
  if (!production) return null;
  const noProposal = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches ?? 0;
  const suppressed = production.suppressedDispatches ?? 0;
  const errors = production.errors ?? 0;
  const reasons = proposalProductionReasons(production);
  const examples = Array.isArray(production.recentDiagnosticNoProposalDispatches)
    ? production.recentDiagnosticNoProposalDispatches.slice(0, 4)
    : Array.isArray(production.recentNoProposalDispatches)
      ? production.recentNoProposalDispatches.slice(0, 4)
      : [];

  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Proposal Production'),
    el('span', { cls: 'card-subtitle' },
      errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` :
        noProposal > 0 ? `${noProposal} no-proposal` :
          `${production.proposalsCreated ?? 0} proposal${production.proposalsCreated === 1 ? '' : 's'}`
    )
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Window', proposalProductionWindowLabel(production)],
    ['Selected', production.selected ?? 0],
    ['Claimed', production.claimed ?? 0],
    ['Dispatched', production.dispatched ?? 0],
    ['Skipped', production.skipped ?? 0],
    ['Proposals', production.proposalsCreated ?? 0],
    ['No-proposal', noProposal],
    ['Suppressed', suppressed],
    ['Errors', errors],
  ]));

  if (reasons.length > 0) {
    body.appendChild(el('p', { cls: 'hint' }, `Top reason: ${reasons[0]}`));
  }

  if (examples.length > 0) {
    const list = el('div', { cls: 'ctrl-backend-list' });
    for (const item of examples) {
      list.appendChild(el('div', { cls: 'ctrl-backend-row', title: item.reason ?? '' },
        el('span', { cls: 'ctrl-backend-name' }, `${item.backend ?? 'unknown'} · ${basenameFromPath(item.repo ?? '')}`),
        el('span', { cls: 'ctrl-backend-dispatches' }, compactFleetReason(item.title ?? item.itemId ?? 'dispatch'))
      ));
    }
    body.appendChild(list);
  }

  card.appendChild(body);
  return card;
}

function formatFleetPercent(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

function formatAttemptShape(shape) {
  if (!shape || typeof shape !== 'object') return '';
  const noDiff = Number(shape.backendNoDiff ?? 0);
  const gate = Number(shape.captureOrGateBlocked ?? 0);
  const repairs = Number(shape.repairAttempts ?? 0);
  const policy = Number(shape.policyDisabled ?? 0);
  const safe = (value) => Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  const parts = {
    noDiff: safe(noDiff),
    gate: safe(gate),
    repairs: safe(repairs),
    policy: safe(policy),
  };
  if (parts.noDiff + parts.gate + parts.repairs + parts.policy <= 0) return '';
  return `shape: no-diff ${parts.noDiff}, gate/capture ${parts.gate}, repairs ${parts.repairs}, policy-off ${parts.policy}`;
}

function generatedRepairRecoveryMetric(generated) {
  if (!generated || Number(generated.attempts ?? 0) <= 0) return null;
  const safe = (value) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.trunc(Number(value))
    : 0;
  const attempts = safe(generated.attempts);
  if (attempts <= 0) return null;
  const proposals = safe(generated.proposalsCreated);
  const rate = typeof generated.proposalRate === 'number'
    ? generated.proposalRate
    : proposals / attempts;
  const capture = safe(generated.captureRepairs);
  const noDiff = safe(generated.diagnosticReslices);
  const proposal = safe(generated.proposalRepairs);
  const kinds = [
    capture > 0 ? `${capture} capture` : null,
    noDiff > 0 ? `${noDiff} no-diff` : null,
    proposal > 0 ? `${proposal} proposal` : null,
  ].filter(Boolean);
  const value = `${proposals}/${attempts} converted (${formatFleetPercent(rate)})`;
  return {
    attempts,
    proposals,
    rate,
    value,
    detail: `generated repairs ${value}${kinds.length ? `; ${kinds.join(', ')}` : ''}`,
  };
}

function fleetRepairRecoveryMetric(fleet) {
  const source = fleet?.dispatchProductionSource;
  const dispatchGenerated = (!source || dispatchProductionSourceHealthy(source))
    ? fleet?.dispatchProduction?.generatedRepairAttempts
    : null;
  return generatedRepairRecoveryMetric(
    fleet?.dispatchYieldDiagnostics?.generatedRepairAttempts ??
    dispatchGenerated ??
    fleet?.attemptCoverage?.production?.generatedRepairAttempts
  );
}

function dispatchProductionSourceText(source) {
  if (!source) return 'unknown';
  if (source.sourceState === 'missing') return 'missing';
  if (source.sourceState === 'healthy' && source.complete === true) return 'healthy';
  const reasons = Array.isArray(source.stopReasons) ? source.stopReasons.join(', ') : '';
  return reasons ? `degraded (${reasons})` : 'degraded';
}

function dispatchProductionSourceHealthy(source) {
  return !source || (source.sourceState === 'healthy' && source.complete === true);
}

function workspaceSourceHealthy(workspace) {
  const source = workspace?.sourceQuality;
  return !source || (source.sourceState === 'healthy' && source.complete === true);
}

function workspaceSourceText(workspace) {
  const source = workspace?.sourceQuality;
  if (!source) return 'unknown';
  if (source.sourceState === 'missing') return 'missing';
  const reasons = Array.isArray(source.stopReasons) ? source.stopReasons.join(', ') : '';
  if (source.sourceState === 'healthy' && source.complete === true) return 'healthy';
  return reasons ? `degraded (${reasons})` : 'degraded';
}

function workspaceReadText(workspace) {
  const source = workspace?.sourceQuality;
  if (!source || source.sourceState === 'missing') return '—';
  return `${source.filesRead ?? 0} files · ${source.bytesRead ?? 0} bytes · ${source.rowsScanned ?? 0} rows · ` +
    `${source.invalidRows ?? 0} invalid · ${source.unreadableFiles ?? 0} unreadable`;
}

function workspaceObservedValue(workspace, value, rate = false) {
  if (workspaceSourceHealthy(workspace)) return value;
  if (workspace?.sourceQuality?.sourceState === 'missing') return 'unavailable';
  return rate ? 'partial' : `${value} observed (partial)`;
}

function fleetRepairRecoveryActive(readiness, brief) {
  return (brief?.blocker?.id ?? readiness?.topBlocker?.id) === 'generated-repair-recovery-active';
}

function dispatchProductionBucketLabel(bucket) {
  if (!bucket || typeof bucket !== 'object') return 'unknown';
  if (bucket.backend) return String(bucket.backend);
  if (bucket.source) return String(bucket.source);
  if (bucket.repo) return basenameFromPath(bucket.repo);
  return String(bucket.key ?? 'unknown');
}

function dispatchProductionPolicyDisabledCount(bucket) {
  if (!bucket || typeof bucket !== 'object') return 0;
  const outcomeDisabled = Number(bucket.outcomes?.proposalDisabled ?? 0);
  const shapeDisabled = Number(bucket.attemptShape?.policyDisabled ?? 0);
  const safeOutcome = Number.isFinite(outcomeDisabled) && outcomeDisabled > 0 ? Math.trunc(outcomeDisabled) : 0;
  const safeShape = Number.isFinite(shapeDisabled) && shapeDisabled > 0 ? Math.trunc(shapeDisabled) : 0;
  return Math.max(safeOutcome, safeShape);
}

function dispatchProductionDiagnosticAttempts(bucket) {
  const materialized = Number(bucket?.diagnosticAttempts);
  if (Number.isFinite(materialized) && materialized >= 0) return Math.trunc(materialized);
  const attempts = Number(bucket?.attempts ?? 0);
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0;
  const cancelled = Number(bucket?.outcomes?.cancelled ?? 0);
  const safeCancelled = Number.isFinite(cancelled) && cancelled > 0 ? Math.trunc(cancelled) : 0;
  return Math.max(0, safeAttempts - dispatchProductionPolicyDisabledCount(bucket) - safeCancelled);
}

function dispatchProductionDiagnosticRate(bucket) {
  const materialized = Number(bucket?.diagnosticProposalRate);
  if (Number.isFinite(materialized) && materialized >= 0) return materialized;
  const attempts = dispatchProductionDiagnosticAttempts(bucket);
  return attempts > 0 ? Number(bucket?.proposalsCreated ?? 0) / attempts : 0;
}

function dispatchProductionWeakestBackend(backends) {
  if (!Array.isArray(backends)) return null;
  return backends
    .filter((candidate) => dispatchProductionDiagnosticAttempts(candidate) > 0)
    .sort((left, right) =>
      dispatchProductionDiagnosticRate(left) - dispatchProductionDiagnosticRate(right) ||
      Number(right?.diagnosticNoProposal ?? 0) - Number(left?.diagnosticNoProposal ?? 0) ||
      dispatchProductionDiagnosticAttempts(right) - dispatchProductionDiagnosticAttempts(left) ||
      String(left?.key ?? '').localeCompare(String(right?.key ?? ''))
    )[0] ?? null;
}

function renderDispatchProductionCard(dispatchProduction, sourceQuality, cls = 'ctrl-card card') {
  const card = el('div', { cls });
  if (!dispatchProduction) {
    const sourceText = dispatchProductionSourceText(sourceQuality);
    card.appendChild(el('div', { cls: 'card-header' },
      el('span', { cls: 'card-title' }, 'Dispatch Yield'),
      el('span', { cls: 'card-subtitle' }, sourceText)
    ));
    card.appendChild(el('div', { cls: 'card-body' },
      el('p', { cls: 'hint' }, sourceQuality?.sourceState === 'degraded'
        ? 'Dispatch yield source is degraded; no valid bounded rows were readable.'
        : 'Dispatch yield data unavailable.')
    ));
    return card;
  }

  const sourceHealthy = dispatchProductionSourceHealthy(sourceQuality);
  const diagnosticAttempts = dispatchProductionDiagnosticAttempts(dispatchProduction);
  const diagnosticNoProposal = dispatchProduction.diagnosticNoProposal ??
    Math.max(0, diagnosticAttempts - Number(dispatchProduction.proposalsCreated ?? 0));
  const proposalRate = sourceHealthy ? formatFleetPercent(dispatchProductionDiagnosticRate(dispatchProduction)) : 'partial';
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Dispatch Yield'),
    el('span', { cls: 'card-subtitle' }, sourceHealthy
      ? `${dispatchProduction.proposalsCreated ?? 0}/${diagnosticAttempts} proposals`
      : dispatchProductionSourceText(sourceQuality))
  ));

  const body = el('div', { cls: 'card-body' });
  const repairRecovery = generatedRepairRecoveryMetric(dispatchProduction.generatedRepairAttempts);
  body.appendChild(infoGrid([
    ['Source', dispatchProductionSourceText(sourceQuality)],
    ['Window', proposalProductionWindowLabel(dispatchProduction)],
    ['Attempts', diagnosticAttempts],
    ['Proposals', dispatchProduction.proposalsCreated ?? 0],
    ['Yield', proposalRate],
    ['Repair recovery', repairRecovery?.value ?? '—'],
    ['No-proposal', diagnosticNoProposal],
    ['Cancelled', dispatchProduction.outcomes?.cancelled ?? 0],
    ['Spend', `$${Number(dispatchProduction.spentUsd ?? 0).toFixed(4)}`],
  ]));
  const shape = formatAttemptShape(dispatchProduction.attemptShape);
  if (shape) body.appendChild(el('p', { cls: 'hint' }, shape));
  if (repairRecovery) {
    body.appendChild(el('p', { cls: 'hint' }, `Repair loop: ${repairRecovery.detail}`));
  }

  const backends = Array.isArray(dispatchProduction.byBackend)
    ? dispatchProduction.byBackend.slice(0, 4)
    : [];
  if (backends.length > 0) {
    const list = el('div', { cls: 'ctrl-backend-list' });
    for (const bucket of backends) {
      const bucketReasons = Array.isArray(bucket.diagnosticTopReasons)
        ? bucket.diagnosticTopReasons
        : Array.isArray(bucket.topReasons) ? bucket.topReasons : [];
      list.appendChild(el('div', { cls: 'ctrl-backend-row', title: bucketReasons[0]?.reason ?? '' },
        el('span', { cls: 'ctrl-backend-name' }, dispatchProductionBucketLabel(bucket)),
        el('span', { cls: 'ctrl-backend-dispatches' },
          `${bucket.proposalsCreated ?? 0}/${dispatchProductionDiagnosticAttempts(bucket)} · ` +
          `${formatFleetPercent(dispatchProductionDiagnosticRate(bucket))}`
        )
      ));
    }
    body.appendChild(list);
  }

  const reasons = proposalProductionReasons(dispatchProduction, 2);
  if (reasons.length > 0) {
    body.appendChild(el('p', { cls: 'hint' }, `Top reason: ${reasons.join('; ')}`));
  }

  card.appendChild(body);
  return card;
}

function renderGlobalWorkspaceCard(workspace, cls = 'ctrl-card card') {
  if (!workspace) return null;
  const eventCount = workspace.eventCount ?? 0;
  const diagnosticNoProposal = workspace.diagnosticNoProposalEvents ?? workspace.noProposalEvents ?? 0;
  const policySuppressed = workspace.policySuppressedEvents ?? 0;
  const diagnosticProposalRate = typeof workspace.diagnosticProposalRate === 'number'
    ? workspaceObservedValue(workspace, formatFleetPercent(workspace.diagnosticProposalRate), true)
    : '—';
  const eventLabel = workspaceObservedValue(workspace, `${eventCount} event${eventCount === 1 ? '' : 's'}`);
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Global Workspace'),
    el('span', { cls: 'card-subtitle' }, `${eventLabel} · ${proposalProductionWindowLabel(workspace)}`)
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Source', workspaceSourceText(workspace)],
    ['Read', workspaceReadText(workspace)],
    ['Latest', workspace.latestAt ? fmtRelative(workspace.latestAt) : '—'],
    ['Machines', workspaceObservedValue(workspace, Array.isArray(workspace.activeMachines) ? workspace.activeMachines.length : 0)],
    ['Proposals', workspaceObservedValue(workspace, workspace.proposalEvents ?? 0)],
    ['No-proposal', workspaceObservedValue(workspace, diagnosticNoProposal)],
    ['Policy-suppressed', workspaceObservedValue(workspace, policySuppressed)],
    ['Diagnostic rate', diagnosticProposalRate],
    ['Spend', workspaceObservedValue(workspace, `$${Number(workspace.spendUsd ?? 0).toFixed(4)}`)],
    ['Action entropy', workspaceObservedValue(workspace, workspace.entropy?.action ?? 0)],
  ]));

  const attention = Array.isArray(workspace.attention) ? workspace.attention.slice(0, 5) : [];
  if (attention.length > 0) {
    const list = el('div', { cls: 'ctrl-backend-list' });
    for (const topic of attention) {
      const label = topic.kind === 'repo' ? basenameFromPath(topic.topic ?? '') : String(topic.topic ?? 'unknown');
      list.appendChild(el('div', { cls: 'ctrl-backend-row', title: topic.detail ?? '' },
        el('span', { cls: 'ctrl-backend-name' }, `${topic.kind}:${label}`),
        el('span', { cls: 'ctrl-backend-dispatches' }, String(topic.weight ?? 0))
      ));
    }
    body.appendChild(list);
  }

  const recent = Array.isArray(workspace.recentActions) ? workspace.recentActions[0] : null;
  if (recent) {
    body.appendChild(el('p', { cls: 'hint' },
      `${recent.kind}/${recent.outcome}: ${compactFleetReason(recent.summary ?? recent.action ?? 'recent action')}`
    ));
  }

  card.appendChild(body);
  return card;
}

function formatCoverageMetric(metric) {
  if (!metric || typeof metric !== 'object') return '0 (0%)';
  return `${Number(metric.count ?? 0)} (${formatFleetPercent(metric.rate)})`;
}

function renderAttemptCoverageCard(attemptCoverage, cls = 'ctrl-card card') {
  if (!attemptCoverage) return null;
  const attempts = attemptCoverage.attempts ?? 0;
  const cancelled = attemptCoverage.production?.cancelled ?? 0;
  const causal = attemptCoverage.causalCoverage ?? {};
  const joins = attemptCoverage.coverage ?? {};
  const weak = attemptCoverage.causalWeak ?? {};
  const topWeak = Array.isArray(weak.reasons) ? weak.reasons[0] : null;
  const diagnostics = attemptCoverage.causalGapDiagnostics ?? {};
  const actionSource = attemptCoverage.agentActionSource;
  const actionCoverage = !actionSource || (actionSource.sourceState === 'healthy' && actionSource.complete === true)
    ? formatCoverageMetric(joins.agentAction)
    : actionSource.sourceState === 'missing'
      ? 'unavailable'
      : `${formatCoverageMetric(joins.agentAction)} observed (partial)`;
  const topCause = Array.isArray(diagnostics.causes) ? diagnostics.causes[0] : null;
  const actionableCause = Array.isArray(diagnostics.actionableCauses) ? diagnostics.actionableCauses[0] : null;
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Attempt Coverage'),
    el('span', { cls: 'card-subtitle' }, `${attempts} attempt${attempts === 1 ? '' : 's'} · ${proposalProductionWindowLabel(attemptCoverage)}`)
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Actions', actionCoverage],
    ['Worked', formatCoverageMetric(joins.worked)],
    ['Decisions', formatCoverageMetric(joins.decision)],
    ['Evidence', formatCoverageMetric(joins.evidence)],
    ['Trajectory', formatCoverageMetric(causal.trajectoryId)],
    ['Route', formatCoverageMetric(causal.routeSnapshot)],
    ['Run summary', formatCoverageMetric(causal.runEventSummary)],
    ['Policy', formatCoverageMetric(causal.currentRouterPolicyVersion)],
    ['Epoch', formatCoverageMetric(causal.currentLearningEpoch)],
    ['Labels', formatCoverageMetric(causal.currentAuthoritativeLabel)],
    ['Cancelled', cancelled],
  ]));
  if (topWeak) {
    body.appendChild(el('p', { cls: 'hint' },
      `Weak causal signal: ${topWeak.kind} ${topWeak.count ?? 0}/${topWeak.denominator ?? attempts} (${formatFleetPercent(topWeak.rate)})`
    ));
  }
  if (topCause) {
    body.appendChild(el('p', { cls: 'hint' },
      `Top cause: ${topCause.cause} on ${topCause.count ?? 0} attempt${topCause.count === 1 ? '' : 's'}`
    ));
  }
  if (actionableCause && actionableCause.cause !== topCause?.cause) {
    body.appendChild(el('p', { cls: 'hint' },
      `Actionable: ${actionableCause.cause} on ${actionableCause.count ?? 0} attempt${actionableCause.count === 1 ? '' : 's'}`
    ));
  }
  card.appendChild(body);
  return card;
}

function formatTrajectoryLearningGap(trajectoryLearning) {
  const labels = {
    dispatch: 'Dispatch',
    proposal: 'Proposal',
    evidence: 'Evidence',
    decision: 'Decision',
    agentAction: 'Agent action',
  };
  const gaps = Array.isArray(trajectoryLearning?.gaps) ? trajectoryLearning.gaps : [];
  const top = gaps.find((gap) => labels[gap?.kind] && Number(gap?.count) > 0);
  if (!top) return 'none';
  return `${labels[top.kind]} ${Math.trunc(Number(top.count))} missing`;
}

function formatSkillCorpusValue(value, labels) {
  return typeof value === 'string' && labels[value] ? labels[value] : 'unavailable';
}

function skillCorpusReadinessRows(skillCorpusReadiness) {
  if (!skillCorpusReadiness) return [];
  const corpus = skillCorpusReadiness.corpus ?? {};
  const learning = skillCorpusReadiness.learning ?? {};
  const sourceQuality = typeof corpus.sourceQuality === 'string'
    ? corpus.sourceQuality
    : corpus.sourceQuality?.badge;
  const rows = [
    ['Skill corpus', formatSkillCorpusValue(corpus.state, {
      'no-cards': 'no cards',
      degraded: 'degraded',
      ready: 'ready',
    })],
    ['Corpus source', formatSkillCorpusValue(sourceQuality, {
      'healthy-source': 'healthy',
      'healthy-zero': 'healthy zero',
      'degraded-source': 'degraded',
      'unknown-source': 'unknown',
      'stale-source': 'stale',
      'missing-source': 'missing',
    })],
    ['Eligible cards', formatSkillCorpusValue(skillCorpusReadiness.eligibleSignedCards, {
      none: 'none',
      available: 'available',
    })],
    ['Skill observations', formatSkillCorpusValue(skillCorpusReadiness.selectedObservations, {
      none: 'none',
      present: 'present',
      degraded: 'degraded',
    })],
    ['Learning gate', formatSkillCorpusValue(learning.state, {
      'blocked-no-cards': 'blocked: no cards',
      'blocked-corpus-degraded': 'blocked: corpus degraded',
      'blocked-observation-degraded': 'blocked: observations degraded',
      'awaiting-eligible-cards': 'awaiting eligible cards',
      'awaiting-selection': 'awaiting selection',
      'k-gated': 'sample gated',
      observable: 'observable',
    })],
  ];
  const threshold = Number(learning.minimumObservedTrajectories);
  if (Number.isSafeInteger(threshold) && threshold > 0) {
    rows.push(['Observation threshold', `${threshold} trajectories`]);
  }
  if (learning.sampleState === 'observed' && learning.observedTrajectoryCoverage) {
    rows.push(['Observed coverage', formatCoverageMetric(learning.observedTrajectoryCoverage)]);
  }
  return rows;
}

function trajectoryLearningRows(trajectoryLearning, skillCorpusReadiness = null) {
  const routeSpine = trajectoryLearning?.routeSpine ?? {};
  const terminal = trajectoryLearning?.terminalOutcomes ?? {};
  const skill = trajectoryLearning?.skillObservation ?? {};
  const skillObserved = skill.sampleState === 'observed';
  const skillEventsPresent = skill.eventState === 'present';
  const skillNone = skill.sampleState === 'none' && !skillEventsPresent;
  const skillAwaitingJoin = skill.sampleState === 'none' && skillEventsPresent;
  const threshold = Number(skillCorpusReadiness?.learning?.minimumObservedTrajectories);
  const withheldLabel = Number.isSafeInteger(threshold) && threshold > 0 ? `withheld (<${threshold})` : 'withheld (<3)';
  return [
    ['Trajectories', trajectoryLearning?.trajectories ?? 0],
    ['Dispatch -> decision', formatCoverageMetric(routeSpine.dispatchToDecision)],
    ['Dispatch -> evidence', formatCoverageMetric(routeSpine.dispatchToEvidence)],
    ['Dispatch -> merge', formatCoverageMetric(routeSpine.dispatchToMerge)],
    ['Merged', terminal.merged ?? 0],
    ['No-proposal', terminal['no-proposal'] ?? 0],
    ['Cancelled', terminal.cancelled ?? 0],
    ['Failed', terminal.failed ?? 0],
    ['Skill-observed trajectories', skillObserved ? formatCoverageMetric(skill.observedTrajectoryCoverage) : skillNone ? 'none' : withheldLabel],
    ['Observation sample', skillEventsPresent && skill.sampleState === 'none' ? 'no joined sample' : skill.sampleState ?? 'unavailable'],
    ['Observed selections', skillObserved ? (skill.joined ?? 0) : skillNone ? 'none' : skillAwaitingJoin ? 'present; counts withheld' : 'withheld'],
    ['Observation join gaps', skillObserved ? (skill.unjoined ?? 0) + (skill.conflicting ?? 0) : skillNone ? 'not applicable' : skillAwaitingJoin ? 'present; counts withheld' : 'withheld'],
    ...skillCorpusReadinessRows(skillCorpusReadiness),
    ['Top gap', formatTrajectoryLearningGap(trajectoryLearning)],
  ];
}

function renderTrajectoryLearningCard(trajectoryLearning, skillCorpusReadiness = null, cls = 'ctrl-card card') {
  if (!trajectoryLearning && !skillCorpusReadiness) return null;
  const trajectories = trajectoryLearning?.trajectories ?? 0;
  const rows = trajectoryLearning
    ? trajectoryLearningRows(trajectoryLearning, skillCorpusReadiness)
    : skillCorpusReadinessRows(skillCorpusReadiness);
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, trajectoryLearning ? 'Trajectory Learning' : 'Skill Learning'),
    el('span', { cls: 'card-subtitle' }, trajectoryLearning
      ? `${trajectories} trajector${trajectories === 1 ? 'y' : 'ies'} · ${proposalProductionWindowLabel(trajectoryLearning)}`
      : 'observe-only readiness')
  ));
  card.appendChild(el('div', { cls: 'card-body' }, infoGrid(rows)));
  return card;
}

function formatCountMap(counts) {
  const entries = Object.entries(counts ?? {})
    .filter(([, count]) => Number(count) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 5)
    .map(([key, count]) => `${key}=${Number(count)}`);
  return entries.length > 0 ? entries.join('/') : 'none';
}

function renderPhantomAgentReportCard(phantom, cls = 'ctrl-card card') {
  if (!phantom) return null;
  const report = phantom.agentReport ?? null;
  const delegation = report?.delegationSafety ?? null;
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Phantom'),
    el('span', { cls: 'card-subtitle' }, `${phantom.state ?? 'unknown'} · values hidden`)
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Initialized', phantom.initialized ? 'yes' : 'no'],
    ['Agent command', phantom.commands?.agentAvailable ? 'yes' : 'no'],
    ['Known secrets', `${phantom.knownFleetSecrets?.presentCount ?? 0}/${phantom.knownFleetSecrets?.total ?? 0}`],
    ['Report repos', report?.scannedRepos ?? 0],
    ['Report failures', report?.failedReports ?? 0],
    ['Approvals', report?.requiresApprovalCount ?? 0],
  ]));
  if (report) {
    body.appendChild(el('p', { cls: 'hint' },
      `status ${formatCountMap(report.statusCounts)} · risk ${formatCountMap(report.riskCounts)} · severity ${formatCountMap(report.severityCounts)}`
    ));
  }
  if (delegation) {
    body.appendChild(infoGrid([
      ['Delegation safe', delegation.safetyCounts?.safe ?? 0],
      ['Delegation unsafe', delegation.safetyCounts?.unsafe ?? 0],
      ['Delegation unknown', delegation.safetyCounts?.unknown ?? 0],
      ['Delegation status', formatCountMap(delegation.statusCounts)],
      ['Primary actions', formatCountMap(delegation.primaryActionCounts)],
    ]));
  }
  body.appendChild(el('p', { cls: 'hint' }, 'Aggregate counts only; secret values, prompts, paths, commands, and output are hidden.'));
  card.appendChild(body);
  return card;
}

function contextEfficiencyAccent(posture) {
  const colors = {
    healthy: '#4ade80',
    watch: '#fbbf24',
    strained: '#f97316',
    unknown: '#94a3b8',
  };
  return colors[posture] ?? colors.unknown;
}

function renderContextEfficiencyCard(context, cls = 'ctrl-card card') {
  if (!context) return null;
  const signals = context.signals ?? {};
  const score = Number.isFinite(Number(context.score)) ? Number(context.score) : 0;
  const posture = context.posture ?? 'unknown';
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Context Efficiency'),
    el('span', {
      cls: 'card-subtitle',
      style: `color:${contextEfficiencyAccent(posture)}`,
    }, `${posture} · ${score}/100`)
  ));

  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Window', proposalProductionWindowLabel(context)],
    ['Workspace', signals.workspaceEvents ?? 0],
    ['Memory', signals.memoryEntries ?? 0],
    ['Retrieval', signals.retrievalPosture ?? 'unknown'],
    ['Top repo', signals.topRepoShare == null ? '—' : formatFleetPercent(signals.topRepoShare)],
    ['Bloat risk', signals.contextBloatRisk ?? 'unknown'],
    ['Reflection', signals.reflectionEvents ?? 0],
    ['Proposal yield', signals.proposalRate == null ? '—' : formatFleetPercent(signals.proposalRate)],
  ]));

  const risks = Array.isArray(context.risks) ? context.risks : [];
  if (risks.length > 0) {
    const risk = risks[0];
    body.appendChild(el('p', { cls: 'hint' }, `Top risk: ${risk.severity ?? 'low'} ${risk.id ?? 'unknown'} — ${compactFleetReason(risk.detail ?? '')}`));
  }
  const next = Array.isArray(context.recommendations) ? context.recommendations[0] : null;
  if (next) {
    body.appendChild(el('p', { cls: 'hint' }, compactFleetReason(next)));
  } else if (context.summary) {
    body.appendChild(el('p', { cls: 'hint' }, compactFleetReason(context.summary)));
  }

  card.appendChild(body);
  return card;
}

function renderFleetNextActionsCard(nextActions, cls = 'ctrl-card card') {
  const actions = Array.isArray(nextActions) ? nextActions : [];
  if (actions.length === 0) return null;
  const card = el('div', { cls });
  card.appendChild(el('h2', { cls: 'card-title' }, 'Next Actions'));
  const list = el('div', { cls: 'fleet-backends' });
  for (const action of actions.slice(0, 6)) {
    const title = [action.detail, action.target ? `Target: ${action.target}` : ''].filter(Boolean).join(' | ');
    const command = Array.isArray(action.commands) ? action.commands[0] : null;
    const detail = el('span', { cls: 'fleet-backend-dispatches' },
      el('span', {}, compactFleetReason(action.detail ?? ''))
    );
    if (command) detail.appendChild(renderNextActionCommand(command));
    list.appendChild(el('div', { cls: 'fleet-backend-row', title },
      el('span', { cls: 'fleet-backend-name' }, action.label ?? action.id ?? 'Action'),
      detail,
      el('span', { cls: 'fleet-quota' }, action.priority ?? 'low')
    ));
  }
  card.appendChild(list);
  return card;
}

function renderNextActionCommand(command) {
  const endpoint = command.endpointPath
    ? ` · ${command.endpointMethod ?? 'POST'} ${command.endpointPath}${command.tokenRequired ? ' token' : ''}`
    : '';
  const scope = command.cwd ? ` @ ${basenameFromPath(command.cwd)}` : '';
  const note = command.note ? ` · ${compactFleetReason(command.note)}` : '';
  return el('span', { cls: 'fleet-command-rail', title: command.note ?? '' },
    el('span', { cls: 'fleet-command-shell' }, command.shell ?? ''),
    el('span', { cls: `fleet-command-safety fleet-command-safety--${command.safety ?? 'manual'}` },
      command.safety ?? 'manual'
    ),
    endpoint || scope || note ? el('span', { cls: 'fleet-command-meta' }, `${scope}${endpoint}${note}`) : null
  );
}

function renderMissionBriefCard(brief, cls = 'ctrl-card card') {
  if (!brief) return null;
  const blocker = brief.blocker ?? null;
  const action = brief.action ?? null;
  const evidence = brief.evidence ?? {};
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Mission Brief'),
    el('span', {
      cls: 'card-subtitle',
      style: `color:${shipReadinessAccent(evidence.readinessVerdict)}`,
    }, `${brief.confidence ?? 'unknown'} confidence`)
  ));
  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Directive', brief.directive ?? 'unknown'],
    ['Mode', formatDirectionMode(brief.operatingMode ?? 'unknown')],
    ['Blocker', blocker ? blocker.label ?? blocker.id : 'none'],
    ['Action', action ? action.label ?? action.id : 'none'],
    ['Queue', `${evidence.eligibleBacklogItems ?? 0}/${evidence.queueBacklogItems ?? 0} eligible`],
    ['Ready', evidence.preflightReady ?? 0],
    ['Pending', evidence.pendingProposals ?? 0],
    ['Guard', evidence.guardBlocked ? 'blocked' : 'clear'],
  ]));

  if (brief.whyNow) {
    body.appendChild(el('p', { cls: 'hint' }, compactFleetReason(brief.whyNow)));
  }
  const actionDetail = action?.detail ? String(action.detail).trim() : '';
  const whyNow = brief.whyNow ? String(brief.whyNow).trim() : '';
  if (actionDetail && actionDetail !== whyNow) {
    const target = action?.target ? ` (${basenameFromPath(action.target)})` : '';
    body.appendChild(el('p', { cls: 'hint' }, `Next: ${compactFleetReason(actionDetail)}${target}`));
  }
  card.appendChild(body);
  return card;
}

function formatDirectionMode(mode) {
  const labels = {
    pause: 'Pause',
    'local-only': 'Local Only',
    'verify-only': 'Verify Only',
    'backlog-build': 'Backlog Build',
    'auto-merge-ready': 'Auto-Merge Ready',
    unknown: 'Unknown',
  };
  return labels[mode] ?? String(mode ?? 'Unknown');
}

function directionAccent(mode) {
  const colors = {
    pause: '#f87171',
    'verify-only': '#fbbf24',
    'auto-merge-ready': '#4ade80',
    'local-only': '#38bdf8',
    'backlog-build': '#a78bfa',
  };
  return colors[mode] ?? '#94a3b8';
}

function formatControlMode(mode) {
  const labels = {
    executable: 'Executable',
    advisory: 'Advisory',
    disabled: 'Disabled',
  };
  return labels[mode] ?? (mode ? String(mode) : 'Disabled');
}

function controlModeAccent(mode) {
  const colors = {
    executable: '#4ade80',
    advisory: '#fbbf24',
    disabled: '#94a3b8',
  };
  return colors[mode] ?? '#94a3b8';
}

function formatShipReadinessVerdict(verdict) {
  const labels = {
    ready: 'Ready',
    blocked: 'Blocked',
    degraded: 'Degraded',
    idle: 'Idle',
    unknown: 'Unknown',
  };
  return labels[verdict] ?? String(verdict ?? 'Unknown');
}

function shipReadinessAccent(verdict) {
  const colors = {
    ready: '#4ade80',
    blocked: '#f87171',
    degraded: '#f97316',
    idle: '#94a3b8',
    unknown: '#fbbf24',
  };
  return colors[verdict] ?? '#94a3b8';
}

function sourceStatusAccent(status) {
  const colors = {
    healthy: '#4ade80',
    degraded: '#f97316',
    blocked: '#f87171',
    unavailable: '#f87171',
    unknown: '#fbbf24',
  };
  return colors[status] ?? '#94a3b8';
}

function renderAutonomousShipReadinessCard(readiness, cls = 'ctrl-card card') {
  if (!readiness) return null;
  const topBlocker = readiness.topBlocker ?? null;
  const primaryAction = readiness.primaryAction ?? null;
  const freshness = readiness.freshness ?? {};
  const sources = Array.isArray(readiness.sources) ? readiness.sources : [];
  const operationalSources = sources;
  const evidenceMatrix = readiness.evidenceMatrix ?? {};
  const evidenceSources = Array.isArray(evidenceMatrix.sources) ? evidenceMatrix.sources : [];
  const evidenceSummary = evidenceMatrix.summary ?? {};
  const card = el('div', { cls });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Autonomous Ship Readiness'),
    el('span', {
      cls: 'card-subtitle',
      style: `color:${shipReadinessAccent(readiness.verdict)}`,
    }, `${formatShipReadinessVerdict(readiness.verdict)} · ${readiness.confidence ?? 'unknown'} confidence`)
  ));
  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['Verdict', formatShipReadinessVerdict(readiness.verdict)],
    ['Confidence', readiness.confidence ?? 'unknown'],
    ['Freshness', freshness.overall ?? 'unknown'],
    ['Stale sources', freshness.staleSources ?? 0],
    ['Unknown sources', freshness.unknownSources ?? 0],
    ['Evidence eligible', evidenceSummary.eligible ?? 0],
    ['Evidence withheld', evidenceSummary.withheld ?? 0],
    ['Evidence state', evidenceMatrix.state ?? 'unknown'],
    ['Top blocker', topBlocker ? topBlocker.label ?? topBlocker.id : 'none'],
    ['Primary action', primaryAction ? primaryAction.label ?? primaryAction.id : 'none'],
  ]));

  const detail = topBlocker?.detail ?? primaryAction?.detail ?? null;
  if (detail) {
    body.appendChild(el('p', { cls: 'hint' }, compactFleetReason(detail)));
  }

  if (operationalSources.length > 0) {
    const list = el('div', { cls: cls.includes('fleet-card') ? 'fleet-backends' : 'ctrl-backend-list' });
    for (const source of operationalSources.slice(0, 7)) {
      list.appendChild(el('div', {
        cls: cls.includes('fleet-card') ? 'fleet-backend-row' : 'ctrl-backend-row',
        title: source.detail ?? '',
      },
        el('span', { cls: cls.includes('fleet-card') ? 'fleet-backend-name' : 'ctrl-backend-name' }, source.label ?? source.id),
        el('span', { cls: cls.includes('fleet-card') ? 'fleet-backend-dispatches' : 'ctrl-backend-dispatches' },
          `${source.freshness ?? 'unknown'}${source.ageMs != null ? ` · ${Math.round(source.ageMs / 60000)}m` : ''}`
        ),
        el('span', {
          cls: 'fleet-quota',
          style: `color:${sourceStatusAccent(source.status)}`,
        }, source.sourceQuality?.badge ?? source.badge ?? source.status ?? 'unknown')
      ));
    }
    body.appendChild(list);
  }

  if (evidenceSources.length > 0) {
    body.appendChild(el('div', { cls: 'card-section-label' }, 'Evidence sources'));
    const list = el('div', { cls: cls.includes('fleet-card') ? 'fleet-backends' : 'ctrl-backend-list' });
    for (const source of evidenceSources) {
      list.appendChild(el('div', {
        cls: cls.includes('fleet-card') ? 'fleet-backend-row' : 'ctrl-backend-row',
        title: source.detail ?? '',
      },
        el('span', { cls: cls.includes('fleet-card') ? 'fleet-backend-name' : 'ctrl-backend-name' }, source.label ?? source.id),
        el('span', { cls: cls.includes('fleet-card') ? 'fleet-backend-dispatches' : 'ctrl-backend-dispatches' },
          evidenceSourceSummary(source)),
        el('span', {
          cls: 'fleet-quota',
          style: `color:${sourceStatusAccent(source.status)}`,
        }, source.eligibility ?? 'unknown')
      ));
    }
    body.appendChild(list);
  }

  card.appendChild(body);
  return card;
}

function evidenceSourceSummary(source) {
  const role = source?.evidenceRole ?? 'evidence';
  const quality = source?.evidenceQuality ?? null;
  if (!quality || quality.sourceState === 'missing' || quality.sourcePresent === false) {
    return `${role} · missing`;
  }
  if (quality.sourceState === 'degraded' || quality.complete === false) {
    return `${role} · degraded`;
  }
  return `${role} · ${quality.rowsScanned ?? 0} rows`;
}

function renderCutoffCheckpointCard(status) {
  if (!status) return null;
  const available = status.state === 'available';
  const degraded = status.state === 'degraded';
  const unavailableValue = status.state === 'unsupported' ? 'unsupported' : 'unavailable';
  const card = el('div', { cls: 'ctrl-card card' });
  card.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Cutoff Checkpoints'),
    el('span', { cls: 'card-subtitle' }, 'Observation only')
  ));
  const body = el('div', { cls: 'card-body' });
  body.appendChild(infoGrid([
    ['State', status.state ?? 'unknown'],
    ['Freshness', status.freshness ?? 'unknown'],
    ['Latest capture', status.latestCapturedAt ? fmtRelative(status.latestCapturedAt) : 'never'],
    ['Released', available ? status.releasedCheckpoints ?? 0 : degraded ? `${status.releasedCheckpoints ?? 0} (partial)` : unavailableValue],
    ['Unreleased', available ? status.unreleasedRows ?? 0 : degraded ? `${status.unreleasedRows ?? 0} (partial)` : unavailableValue],
    ['Read', available ? 'complete' : degraded ? 'incomplete' : unavailableValue],
    ['Capture', status.captureScheduler?.state ?? 'unknown'],
    ['Last attempt', status.captureScheduler?.lastAttemptAt ? fmtRelative(status.captureScheduler.lastAttemptAt) : 'never'],
    ['Next attempt', status.captureScheduler?.nextEligibleAt ? fmtRelative(status.captureScheduler.nextEligibleAt) : 'due'],
    ['Cutoff authority', 'disabled'],
    ['Historical authority', 'disabled'],
    ['Rollback protection', 'disabled'],
  ]));
  if (Array.isArray(status.stopReasons) && status.stopReasons.length > 0) {
    body.appendChild(el('p', { cls: 'hint' }, `Source: ${status.stopReasons.join(', ')}`));
  }
  if (status.captureScheduler?.lastReason) {
    body.appendChild(el('p', { cls: 'hint' }, `Capture: ${status.captureScheduler.lastReason}`));
  }
  card.appendChild(body);
  return card;
}

function autonomyRecentRows(autonomy) {
  const rows = [];
  const recent = Array.isArray(autonomy?.recent) ? autonomy.recent : [];
  for (const item of recent.slice(0, 5)) {
    const verdict = item.allowed === true ? 'allowed' : item.allowed === false ? 'denied' : 'unknown';
    rows.push(el('div', { cls: 'fleet-backend-row' },
      el('span', { cls: 'fleet-backend-name', title: item.proposalId ?? '' }, item.tier ?? 'T?'),
      el('span', { cls: 'fleet-backend-dispatches' },
        `${item.action ?? 'unclassified'} · ${item.riskClass ?? '?'} · ${item.changedFiles ?? 0}f/${item.changedLines ?? 0}l`
      ),
      el('span', {
        cls: 'fleet-quota',
        style: `color:${item.allowed === false ? '#f87171' : item.allowed === true ? '#4ade80' : '#94a3b8'}`,
        title: item.reason ?? verdict,
      }, verdict)
    ));
  }
  return rows;
}

function daemonActivityDisplay(daemon) {
  const activity = daemon?.activity;
  if (daemon?.running !== true) return 'not applicable';
  if (!activity || activity.sourceState !== 'healthy') return 'activity unavailable';
  if (activity.freshness !== 'fresh') return `activity ${activity.freshness}`;
  if (!activity.ownerMatches || activity.ownerState !== 'alive') return 'activity owner unavailable';
  if (activity.phase === 'post-tick' && daemon.childActivity) {
    return `${activity.activeChildren} children active`;
  }
  return activity.phase ?? 'activity available';
}

function renderFleet() {
  if (state.activeView !== 'fleet') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  const f = state.fleet;
  section.appendChild(el('div', { cls: 'view-header' },
    el('div', {},
      el('h1', { cls: 'view-title' }, 'Fleet'),
      el('span', { cls: 'view-subtitle' }, 'Control plane & observability')
    ),
    f ? fleetPauseResumeButton(f.killed, 'btn-sm') : null
  ));

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
      el('span', {}, ' — the kill switch is engaged.'),
      fleetPauseResumeButton(true, 'btn-sm')
    ));
  }

  // Daemon + queue + merges summary card
  const summary = el('div', { cls: 'fleet-card card' });
  const sharedQueue = f.queue?.shared;
  const activeWork = f.queue?.activeWork;
  const summaryRows = [
    ['Daemon', f.daemon.running ? 'running' : 'stopped'],
    ['Activity', daemonActivityDisplay(f.daemon)],
    ['Last tick', f.daemon.lastTickAt ? fmtRelative(f.daemon.lastTickAt) : '—'],
    ['Spend today', f.daemon.todaySpentUsd != null ? `$${f.daemon.todaySpentUsd.toFixed(4)}` : '—'],
    ['Backlog queue', f.queue?.backlogItems ?? '—'],
    ['Eligible queue', queueEligibilityMetric(f.queue) ?? '—'],
    ['Generated work', generatedWorkMetric(f.queue?.generatedWork) ?? '—'],
    ['Diagnostic drain', diagnosticResliceDrainMetric(f.queue?.diagnosticResliceDrain) ?? '—'],
    ['Lane locks', laneLocksMetric(f.laneLocks) ?? '—'],
    ['Merges (24h)', f.merges?.recent ?? '—'],
    ['Autonomy evidence', autonomyEvidenceMetric(f.autonomy)],
  ];
  if (sharedQueue) {
    summaryRows.push(['Shared queue', sharedQueueMetric(sharedQueue)]);
    summaryRows.push(['Owned leases', sharedQueue.ownedClaims ?? 0]);
    summaryRows.push(['Cooldown items', sharedQueue.cooldownItems ?? 0]);
  }
  if (activeWork) {
    summaryRows.push(['Active work', fdActiveWorkValue(activeWork)]);
  }
  if (f.autonomousShipReadiness) {
    summaryRows.push(['Ship readiness', formatShipReadinessVerdict(f.autonomousShipReadiness.verdict)]);
  }
  summary.appendChild(infoGrid(summaryRows));
  section.appendChild(summary);

  const missionBriefCard = renderMissionBriefCard(f.missionBrief, 'fleet-card card');
  if (missionBriefCard) section.appendChild(missionBriefCard);

  const phantomCard = renderPhantomAgentReportCard(f.phantom, 'fleet-card card');
  if (phantomCard) section.appendChild(phantomCard);

  const readinessCard = renderAutonomousShipReadinessCard(f.autonomousShipReadiness, 'fleet-card card');
  if (readinessCard) section.appendChild(readinessCard);

  const effectivenessCard = renderAutonomyEffectivenessCard(f.autonomyEffectiveness, 'fleet-card card');
  if (effectivenessCard) section.appendChild(effectivenessCard);

  const productionCard = renderProposalProductionCard(f.proposalProduction, 'fleet-card card');
  if (productionCard) section.appendChild(productionCard);

  const dispatchProductionCard = renderDispatchProductionCard(
    f.dispatchProduction,
    f.dispatchProductionSource,
    'fleet-card card'
  );
  if (dispatchProductionCard) section.appendChild(dispatchProductionCard);

  const workspaceCard = renderGlobalWorkspaceCard(f.workspace, 'fleet-card card');
  if (workspaceCard) section.appendChild(workspaceCard);

  const attemptCoverageCard = renderAttemptCoverageCard(f.attemptCoverage, 'fleet-card card');
  if (attemptCoverageCard) section.appendChild(attemptCoverageCard);

  const contextCard = renderContextEfficiencyCard(f.contextEfficiency, 'fleet-card card');
  if (contextCard) section.appendChild(contextCard);

  const strategicFocusCard = renderStrategicFocusCard(f.queue, 'fleet-card card');
  if (strategicFocusCard) section.appendChild(strategicFocusCard);

  const actionsCard = renderFleetNextActionsCard(f.nextActions, 'fleet-card card');
  if (actionsCard) section.appendChild(actionsCard);

  // Backends table
  const backendsCard = el('div', { cls: 'fleet-card card' });
  backendsCard.appendChild(el('h2', { cls: 'card-title' }, 'Backends'));
  const backends = Array.isArray(f.backends) ? f.backends : [];
  if (backends.length === 0) {
    backendsCard.appendChild(el('p', { cls: 'hint' }, 'No backends configured.'));
  } else {
    const list = el('div', { cls: 'fleet-backends' });
    for (const b of backends) {
      const resourceText = backendResourceText(b);
      const row = el('div', { cls: 'fleet-backend-row' },
        el('span', { cls: 'fleet-backend-name' }, b.backend),
        el('span', { cls: 'fleet-backend-dispatches' },
          `${b.dispatchesRecent} dispatch(es) / 24h${resourceText ? ` · ${resourceText}` : ''}`
        ),
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
    ['Host PRs', f.proposals?.awaitingHostMerge ?? 0],
    ['Applied', f.proposals?.applied ?? 0],
  ]));
  section.appendChild(propsCard);

  // Autonomy evidence card
  const autonomyCard = el('div', { cls: 'fleet-card card' });
  const autonomy = f.autonomy ?? null;
  autonomyCard.appendChild(el('h2', { cls: 'card-title' }, 'Autonomy Evidence'));
  autonomyCard.appendChild(infoGrid([
    ['Evidence packs', autonomy?.evidencePacks ?? 0],
    ['Allowed', autonomy?.allowed ?? 0],
    ['Denied', autonomy?.denied ?? 0],
    ['Latest', autonomy?.latestAt ? fmtRelative(autonomy.latestAt) : '—'],
  ]));
  const evidenceRows = autonomyRecentRows(autonomy);
  if (evidenceRows.length > 0) {
    const list = el('div', { cls: 'fleet-backends' });
    for (const row of evidenceRows) list.appendChild(row);
    autonomyCard.appendChild(list);
  } else {
    autonomyCard.appendChild(el('p', { cls: 'hint' }, 'No autonomy evidence packs yet.'));
  }
  section.appendChild(autonomyCard);

  main.appendChild(section);
}

// ---------------------------------------------------------------------------
// M104: Goals view — /api/goals goal list + progress dashboard
// ---------------------------------------------------------------------------

async function loadGoals() {
  showLoading('goals');
  try {
    state.goals = await apiFetch('/api/goals');
    renderGoals();
  } catch (err) {
    showError('goals', err.message);
  }
}

// Milestone status -> accent color (dark-theme safe)
const MILESTONE_COLOR = {
  done:        '#4ade80',   // green
  proposed:    '#60a5fa',   // blue
  'in-progress': '#a78bfa', // purple
  pending:     '#6b7280',   // gray
  blocked:     '#f87171',   // red
  paused:      '#fbbf24',   // amber
  skipped:     '#374151',   // dark-gray
};

function goalProgressBar(fractionDone) {
  const pct = Math.round(Math.min(1, Math.max(0, fractionDone)) * 100);
  const wrap = el('div', { cls: 'goal-progress-track' });
  const fill = el('div', {
    cls: 'goal-progress-fill',
    style: `width:${pct}%`,
    title: `${pct}% complete`,
  });
  wrap.appendChild(fill);
  return el('div', { cls: 'goal-progress-wrap' },
    wrap,
    el('span', { cls: 'goal-progress-pct' }, `${pct}%`)
  );
}

function buildGoalCard(g) {
  const card = el('div', { cls: 'goal-card card' });

  // Header: objective + status badge
  card.appendChild(el('div', { cls: 'goal-card__header' },
    el('span', { cls: 'goal-card__objective', title: g.objective }, truncate(g.objective, 90)),
    statusBadge(g.status)
  ));

  // Progress bar
  card.appendChild(goalProgressBar(g.progress?.fractionDone ?? 0));

  // Milestone breakdown pills
  const milestones = Array.isArray(g.milestones) ? g.milestones : [];
  if (milestones.length > 0) {
    const counts = g.progress?.counts ?? {};
    const countOrder = ['done', 'proposed', 'in-progress', 'pending', 'blocked', 'paused', 'skipped'];
    const pills = el('div', { cls: 'goal-milestone-pills' });
    for (const status of countOrder) {
      const n = counts[status];
      if (!n) continue;
      const color = MILESTONE_COLOR[status] ?? '#9ca3af';
      pills.appendChild(el('span', {
        cls: 'goal-milestone-pill',
        style: `background:${color}22;color:${color};border:1px solid ${color}44`,
        title: status,
      }, `${status}: ${n}`));
    }
    card.appendChild(pills);
  }

  // Next actionable milestone highlight
  const nextId = g.progress?.nextActionableId;
  if (nextId) {
    const nextM = milestones.find((m) => m.id === nextId) ??
      // nextActionableId is the milestone id; milestones here only carry title/status/order
      // so we fall back to showing the id
      { title: nextId };
    card.appendChild(el('div', { cls: 'goal-next-actionable' },
      el('span', { cls: 'goal-next-label' }, 'Next: '),
      el('span', { cls: 'goal-next-title' }, truncate(nextM.title ?? nextId, 80))
    ));
  }

  // Milestone list (collapsible via details/summary)
  if (milestones.length > 0) {
    const details = el('details', { cls: 'goal-milestones-details' });
    details.appendChild(el('summary', { cls: 'goal-milestones-summary' },
      `${milestones.length} milestone${milestones.length !== 1 ? 's' : ''}`
    ));
    const list = el('ol', { cls: 'goal-milestones-list' });
    const sorted = [...milestones].sort((a, b) => a.order - b.order);
    for (const m of sorted) {
      const color = MILESTONE_COLOR[m.status] ?? '#9ca3af';
      const isNext = m.id === nextId || m.title === nextId;
      list.appendChild(el('li', {
        cls: `goal-milestone-item${isNext ? ' goal-milestone-item--next' : ''}`,
        style: `border-left:3px solid ${color}`,
      },
        el('span', {
          cls: 'goal-milestone-status-dot',
          style: `background:${color}`,
          title: m.status,
        }),
        el('span', { cls: 'goal-milestone-title' }, m.title),
        el('span', {
          cls: 'goal-milestone-status-badge',
          style: `color:${color}`,
        }, m.status)
      ));
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  return card;
}

function renderGoals() {
  if (state.activeView !== 'goals') return;
  const main = getMain();
  if (!main) return;
  main.innerHTML = '';

  const section = el('section', { cls: 'view-section' });
  const goals = Array.isArray(state.goals) ? state.goals : [];

  section.appendChild(el('div', { cls: 'view-header' },
    el('h1', { cls: 'view-title' }, 'Goals'),
    el('span', { cls: 'view-subtitle' }, `${goals.length} goal${goals.length !== 1 ? 's' : ''}`)
  ));

  if (goals.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No goals yet.'),
      el('p', { cls: 'hint' }, 'Use `ashlr goals add "your goal"` to create one.')
    ));
    main.appendChild(section);
    return;
  }

  const grid = el('div', { cls: 'goals-grid' });
  for (const g of goals) {
    grid.appendChild(buildGoalCard(g));
  }
  section.appendChild(grid);
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

  if (!d) {
    section.appendChild(el('div', { cls: 'view-header' },
      el('h1', { cls: 'view-title' }, 'Mission Control'),
      el('span', { cls: 'view-subtitle' }, 'Live fleet overview')
    ));
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Control data unavailable.'),
      el('p', { cls: 'hint' }, 'Ensure the daemon is running and the server serves /api/control.')
    ));
    main.appendChild(section);
    return;
  }

  // ── 1. Fleet Pulse (hero) ──────────────────────────────────────────────
  const fleet = d.fleet ?? d.daemon ?? {};
  const daemon = d.daemon ?? {};
  const fleetDaemon = d.fleet?.daemon ?? fleet.daemon ?? daemon;
  const queue  = d.fleet?.queue ?? fleet.queue ?? {};
  const props  = d.fleet?.proposals ?? fleet.proposals ?? {};
  const merges = d.fleet?.merges ?? fleet.merges ?? {};
  const autonomy = d.fleet?.autonomy ?? fleet.autonomy ?? null;
  const direction = d.fleet?.autonomyDirection ?? fleet.autonomyDirection ?? null;
  const activeDirectionMode = daemon.activeDirectionMode ?? null;
  const isRunning = fleetDaemon.running ?? daemon.running ?? false;
  const isKilled  = d.fleet?.killed ?? false;
  const service = daemon.service ?? {};
  const serviceLabel = service.running ? 'running' : service.installed ? 'installed' : 'missing';

  section.appendChild(el('div', { cls: 'view-header' },
    el('div', {},
      el('h1', { cls: 'view-title' }, 'Mission Control'),
      el('span', { cls: 'view-subtitle' }, `Updated ${fmtRelative(d.ts)}`)
    ),
    fleetPauseResumeButton(isKilled, 'btn-sm')
  ));

  if (isKilled) {
    section.appendChild(el('div', { cls: 'ctrl-banner ctrl-banner--paused' },
      el('strong', {}, 'Fleet paused'),
      el('span', {}, ' — kill switch engaged.'),
      fleetPauseResumeButton(true, 'btn-sm')
    ));
  }

  const heroPulse = el('div', { cls: 'ctrl-hero' });
  const daemonStatusEl = el('div', { cls: 'ctrl-daemon-status' },
    el('span', { cls: `ctrl-live-dot${isRunning ? ' running' : ''}`, title: isRunning ? 'Running' : 'Stopped' }),
    el('span', { cls: `ctrl-daemon-label${isRunning ? ' running' : ''}` },
      isRunning ? `Daemon running · ${daemonActivityDisplay(fleetDaemon)}` : 'Daemon stopped'),
    daemon.pid ? el('span', { cls: 'ctrl-pid' }, `PID ${daemon.pid}`) : null
  );
  heroPulse.appendChild(daemonStatusEl);

  if (fleetDaemon.lastTickAt ?? daemon.lastTickAt) {
    heroPulse.appendChild(el('div', { cls: 'ctrl-last-tick' }, `Last tick ${fmtRelative(fleetDaemon.lastTickAt ?? daemon.lastTickAt)}`));
  }

  const heroMetrics = el('div', { cls: 'ctrl-hero-metrics' });
  const sharedQueue = queue.shared;
  heroMetrics.appendChild(controlMetric('Spend today', daemon.todaySpentUsd != null ? `$${daemon.todaySpentUsd.toFixed(4)}` : '—', '#fbbf24'));
  heroMetrics.appendChild(controlMetric('Queue depth', queue.backlogItems ?? '—', '#60a5fa'));
  heroMetrics.appendChild(controlMetric('Eligible', queue.eligibleBacklogItems ?? queue.backlogItems ?? '—', '#38bdf8'));
  if (queue.generatedWork) {
    heroMetrics.appendChild(controlMetric(
      'Generated',
      queue.generatedWork.total ?? 0,
      ((queue.generatedWork.diagnosticReslices ?? 0) > 0 || (queue.generatedWork.captureRepairs ?? 0) > 0)
        ? '#f97316'
        : '#38bdf8'
    ));
  }
  if (queue.diagnosticResliceDrain) {
    const drainColor = queue.diagnosticResliceDrain.stalled ? '#ef4444' : '#f97316';
    heroMetrics.appendChild(controlMetric('Diag Drain', queue.diagnosticResliceDrain.selected ?? 0, drainColor));
  }
  const laneLocks = d.fleet?.laneLocks ?? fleet.laneLocks ?? null;
  if (laneLocks) {
    const laneLocksWarn = (laneLocks.staleInProgress ?? 0) > 0 || (laneLocks.unverifiedApplied ?? 0) > 0 || (laneLocks.awaitingHostMerge ?? 0) > 0;
    heroMetrics.appendChild(controlMetric('Lane Locks', laneLocks.active ?? 0, laneLocksWarn ? '#f97316' : '#38bdf8'));
  }
  if (sharedQueue) {
    heroMetrics.appendChild(controlMetric('Shared leases', sharedQueue.activeClaims ?? '—', '#38bdf8'));
    heroMetrics.appendChild(controlMetric('Reclaimable', sharedQueue.reclaimableClaims ?? '—', sharedQueue.reclaimableClaims > 0 ? '#f97316' : '#4ade80'));
  }
  const activeWork = d.fleet?.queue?.activeWork ?? fleet.queue?.activeWork ?? null;
  if (activeWork) {
    heroMetrics.appendChild(controlMetric('Active work', activeWork.itemCount ?? '—', activeWork.malformed ? '#f97316' : '#38bdf8'));
  }
  heroMetrics.appendChild(controlMetric('Proposals', props.pending ?? 0, '#a78bfa'));
  heroMetrics.appendChild(controlMetric('Merges (24h)', merges.recent ?? '—', '#4ade80'));
  heroMetrics.appendChild(controlMetric('Evidence', autonomy?.evidencePacks ?? 0, autonomy?.denied > 0 ? '#f87171' : '#38bdf8'));
  const effectiveness = d.fleet?.autonomyEffectiveness ?? fleet.autonomyEffectiveness ?? null;
  const shipReadiness = d.fleet?.autonomousShipReadiness ?? fleet.autonomousShipReadiness ?? null;
  const missionBrief = d.fleet?.missionBrief ?? fleet.missionBrief ?? null;
  const production = d.fleet?.proposalProduction ?? fleet.proposalProduction ?? null;
  const dispatchProduction = d.fleet?.dispatchProduction ?? fleet.dispatchProduction ?? null;
  const dispatchProductionSource = d.fleet?.dispatchProductionSource ?? fleet.dispatchProductionSource ?? null;
  const repairRecovery = fleetRepairRecoveryMetric(d.fleet ?? fleet);
  const isRepairRecoveryActive = fleetRepairRecoveryActive(shipReadiness, missionBrief);
  const workspace = d.fleet?.workspace ?? fleet.workspace ?? null;
  const attemptCoverage = d.fleet?.attemptCoverage ?? fleet.attemptCoverage ?? null;
  const trajectoryLearning = d.fleet?.trajectoryLearning ?? fleet.trajectoryLearning ?? null;
  const skillCorpusReadiness = d.fleet?.skillCorpusReadiness ?? fleet.skillCorpusReadiness ?? null;
  const repairHandoffRollout = d.fleet?.repairHandoffRollout ?? fleet.repairHandoffRollout ?? null;
  if (repairHandoffRollout) {
    const rolloutAccent = repairHandoffRollout.phase === 'degraded'
      ? '#f87171'
      : repairHandoffRollout.phase === 'mixed-healthy' || repairHandoffRollout.phase === 'v2-healthy'
        ? '#4ade80'
        : repairHandoffRollout.phase === 'awaiting-evidence'
          ? '#fbbf24'
          : '#94a3b8';
    const actionAccent = repairHandoffRollout.action === 'rollback-writer' ||
      repairHandoffRollout.action === 'inspect-source' || repairHandoffRollout.action === 'repair-writer-config'
      ? '#f87171'
      : repairHandoffRollout.action === 'wait-ordinary-parent'
        ? '#fbbf24'
        : repairHandoffRollout.action === 'enable-canary'
          ? '#4ade80'
          : rolloutAccent;
    heroMetrics.appendChild(controlMetric('Handoff phase', repairHandoffRollout.phase ?? 'unknown', rolloutAccent));
    heroMetrics.appendChild(controlMetric('Handoff action', repairHandoffRollout.action ?? 'unknown', actionAccent));
    heroMetrics.appendChild(controlMetric(
      'Eligible ordinary parents',
      repairHandoffRollout.eligibleOrdinaryItems ?? 'unknown',
      repairHandoffRollout.eligibleOrdinaryItems > 0 ? '#4ade80' : actionAccent
    ));
    heroMetrics.appendChild(controlMetric(
      'Authorities v1/v2',
      `${repairHandoffRollout.v1Authorities ?? 'unknown'}/${repairHandoffRollout.v2Authorities ?? 'unknown'}`,
      rolloutAccent
    ));
    heroMetrics.appendChild(controlMetric(
      'Writer effective',
      (repairHandoffRollout.writerEffective ?? repairHandoffRollout.writerEnabled) === true ? 'yes' : 'no',
      (repairHandoffRollout.writerEffective ?? repairHandoffRollout.writerEnabled) === true ? '#4ade80' : actionAccent
    ));
    heroMetrics.appendChild(controlMetric(
      'Current activation',
      repairHandoffRollout.currentActivationV2Authorities ?? 'unknown',
      (repairHandoffRollout.currentActivationV2Authorities ?? 0) > 0 ? '#4ade80' : actionAccent
    ));
    if (repairHandoffRollout.writerBlockedReason) {
      heroMetrics.appendChild(controlMetric('Writer blocked', repairHandoffRollout.writerBlockedReason, actionAccent));
    }
    if (repairHandoffRollout.latestCurrentActivationV2At) {
      heroMetrics.appendChild(controlMetric('Canary written', fmtDate(repairHandoffRollout.latestCurrentActivationV2At), rolloutAccent));
    }
    heroMetrics.appendChild(controlMetric(
      'Rows v1/v2',
      `${repairHandoffRollout.v1PhysicalRows ?? 'unknown'}/${repairHandoffRollout.v2PhysicalRows ?? 'unknown'}`,
      rolloutAccent
    ));
  }
  if (shipReadiness) {
    heroMetrics.appendChild(controlMetric(
      'Ship Ready',
      formatShipReadinessVerdict(shipReadiness.verdict),
      shipReadinessAccent(shipReadiness.verdict)
    ));
  }
  if (effectiveness) {
    heroMetrics.appendChild(controlMetric('Loop State', formatEffectivenessPhase(effectiveness.phase), effectivenessAccent(effectiveness.phase)));
  }
  if (production) {
    const noProposal = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches ?? 0;
    heroMetrics.appendChild(controlMetric('No-prop 24h', noProposal, noProposal > 0 ? '#f97316' : '#4ade80'));
  }
  if (dispatchProduction) {
    const sourceHealthy = dispatchProductionSourceHealthy(dispatchProductionSource);
    const diagnosticRate = dispatchProductionDiagnosticRate(dispatchProduction);
    heroMetrics.appendChild(controlMetric(
      'Yield 24h',
      sourceHealthy ? formatFleetPercent(diagnosticRate) : 'degraded',
      sourceHealthy && diagnosticRate > 0 ? '#4ade80' : '#f97316'
    ));
  }
  else if (dispatchProductionSource?.sourceState === 'degraded') {
    heroMetrics.appendChild(controlMetric('Yield 24h', 'degraded', '#f97316'));
  }
  if (repairRecovery) {
    heroMetrics.appendChild(controlMetric(
      'Repair Loop',
      `${repairRecovery.proposals}/${repairRecovery.attempts} ${formatFleetPercent(repairRecovery.rate)}`,
      isRepairRecoveryActive || repairRecovery.rate >= 0.5 ? '#4ade80' : '#f97316'
    ));
  }
  if (workspace) {
    const sourceHealthy = workspaceSourceHealthy(workspace);
    heroMetrics.appendChild(controlMetric(
      'Workspace',
      sourceHealthy ? workspace.eventCount ?? 0 : workspaceSourceText(workspace),
      sourceHealthy ? (workspace.eventCount > 0 ? '#38bdf8' : '#64748b') : '#f97316'
    ));
  }
  heroMetrics.appendChild(controlMetric('Active Mode', formatDirectionMode(activeDirectionMode ?? direction?.mode ?? 'unknown'), directionAccent(activeDirectionMode ?? direction?.mode)));
  heroMetrics.appendChild(controlMetric('Control Mode', formatControlMode(daemon.autonomyControlMode), controlModeAccent(daemon.autonomyControlMode)));
  heroMetrics.appendChild(controlMetric('OS Service', serviceLabel, service.running ? '#4ade80' : service.installed ? '#fbbf24' : '#f87171'));
  heroMetrics.appendChild(controlMetric('Kill switch', isKilled ? 'ENGAGED' : 'off', isKilled ? '#f87171' : '#64748b'));
  heroPulse.appendChild(heroMetrics);
  section.appendChild(heroPulse);

  const serviceCard = el('div', { cls: 'ctrl-card card' });
  serviceCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Daemon Service'),
    el('span', { cls: 'card-subtitle' }, service.platformSpec ?? 'unknown')
  ));
  const serviceBody = el('div', { cls: 'card-body' });
  serviceBody.appendChild(el('div', { cls: 'ctrl-service-row' },
    el('span', { cls: `ctrl-health-dot ${service.running ? 'up' : 'down'}`, title: service.running ? 'Running' : 'Stopped' }),
    el('span', { cls: 'ctrl-service-status' }, `${service.installed ? 'installed' : 'not installed'} · ${service.running ? 'running' : 'stopped'}`),
    service.serviceFilePath ? el('span', { cls: 'ctrl-service-path', title: service.serviceFilePath }, service.serviceFilePath) : null,
    getToken()
      ? el('button', {
          cls: 'btn btn-secondary btn-sm',
          type: 'button',
          title: 'Repair daemon service',
          onClick: () => { void repairDaemonService(); },
        }, 'Repair')
      : null
  ));
  if (service.errorLog) {
    serviceBody.appendChild(el('div', { cls: 'ctrl-service-error' }, service.errorLog));
  }
  serviceCard.appendChild(serviceBody);
  section.appendChild(serviceCard);

  const missionBriefCard = renderMissionBriefCard(missionBrief);
  if (missionBriefCard) section.appendChild(missionBriefCard);

  const missionPhantomCard = renderPhantomAgentReportCard(d.fleet?.phantom ?? fleet.phantom ?? null);
  if (missionPhantomCard) section.appendChild(missionPhantomCard);

  if (direction) {
    const directionCard = el('div', { cls: 'ctrl-card card' });
    directionCard.appendChild(el('div', { cls: 'card-header' },
      el('span', { cls: 'card-title' }, 'Autonomy Direction'),
      el('span', { cls: 'card-subtitle' }, `${formatDirectionMode(direction.mode)} · ${direction.confidence ?? 'unknown'} confidence`)
    ));
    const directionBody = el('div', { cls: 'card-body' });
    directionBody.appendChild(infoGrid([
      ['Active', formatDirectionMode(activeDirectionMode ?? 'unknown')],
      ['Recommended', formatDirectionMode(direction.mode)],
      ['Last applied', daemon.activeDirectionAt ? fmtRelative(daemon.activeDirectionAt) : 'never'],
      ['Control mode', formatControlMode(daemon.autonomyControlMode)],
      ['Resources', direction.resources?.posture ?? 'unknown'],
      ['Constrained', direction.resources?.constrained ?? 0],
      ['Depleted', direction.resources?.depleted ?? 0],
      ['Guards', direction.guardHealth?.blocked ? `${direction.guardHealth.blocks ?? 0} blocking` : 'clear'],
      ['Budget', direction.budgets?.daemonBudgetLevel ?? 'unknown'],
    ]));
    const rawReason = daemon.activeDirectionReason ?? (Array.isArray(direction.reasons) ? direction.reasons[0] : null);
    const rawAction = Array.isArray(direction.recommendedActions) ? direction.recommendedActions[0] : null;
    const reason = typeof rawReason === 'string' ? rawReason : null;
    const action = typeof rawAction === 'string' ? rawAction : null;
    if (reason || action) {
      directionBody.appendChild(el('div', { cls: 'ctrl-direction-copy' },
        reason ? el('p', {}, reason) : null,
        action ? el('p', { cls: 'hint' }, action) : null
      ));
    }
    directionCard.appendChild(directionBody);
    section.appendChild(directionCard);
  }

  const missionReadinessCard = renderAutonomousShipReadinessCard(shipReadiness);
  if (missionReadinessCard) section.appendChild(missionReadinessCard);

  const cutoffCheckpointCard = renderCutoffCheckpointCard(
    d.fleet?.cutoffCheckpoints ?? fleet.cutoffCheckpoints ?? null
  );
  if (cutoffCheckpointCard) section.appendChild(cutoffCheckpointCard);

  const missionEffectivenessCard = renderAutonomyEffectivenessCard(effectiveness);
  if (missionEffectivenessCard) section.appendChild(missionEffectivenessCard);

  const missionProductionCard = renderProposalProductionCard(production);
  if (missionProductionCard) section.appendChild(missionProductionCard);

  const missionWorkspaceCard = renderGlobalWorkspaceCard(workspace);
  if (missionWorkspaceCard) section.appendChild(missionWorkspaceCard);

  const missionAttemptCoverageCard = renderAttemptCoverageCard(attemptCoverage);
  if (missionAttemptCoverageCard) section.appendChild(missionAttemptCoverageCard);

  const missionTrajectoryLearningCard = renderTrajectoryLearningCard(trajectoryLearning, skillCorpusReadiness);
  if (missionTrajectoryLearningCard) section.appendChild(missionTrajectoryLearningCard);

  const missionContextCard = renderContextEfficiencyCard(d.fleet?.contextEfficiency ?? fleet.contextEfficiency ?? null);
  if (missionContextCard) section.appendChild(missionContextCard);

  const missionActionsCard = renderFleetNextActionsCard(d.fleet?.nextActions ?? fleet.nextActions ?? null);
  if (missionActionsCard) section.appendChild(missionActionsCard);

  const strategicFocusCard = renderStrategicFocusCard(queue);
  if (strategicFocusCard) section.appendChild(strategicFocusCard);

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
      const resourceText = backendResourceText(b);
      bList.appendChild(el('div', { cls: 'ctrl-backend-row' },
        el('span', { cls: 'ctrl-backend-name' }, b.id ?? b.backend ?? '?'),
        el('span', { cls: 'ctrl-backend-dispatches' },
          `${b.dispatchesRecent ?? 0} dispatch(es) / 24h${resourceText ? ` · ${resourceText}` : ''}`
        ),
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
      const kindLabel = entry.dryRun === true ? `${kind}:sim` : kind;
      logsBody.appendChild(el('div', { cls: `ctrl-log-row ctrl-log-row--${kind}` },
        el('span', { cls: 'ctrl-log-ts' }, entry.ts ? fmtRelative(entry.ts) : '—'),
        el('span', { cls: `ctrl-log-kind ctrl-log-kind--${kind}` }, kindLabel),
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
    const hasToken = Boolean(getToken());
    tbl.appendChild(el('thead', {},
      el('tr', {},
        el('th', {}, 'Repo'),
        el('th', {}, 'Proposed'),
        el('th', {}, 'Merged'),
        el('th', {}, 'Pending'),
        el('th', {}, 'Declined'),
        hasToken ? el('th', {}) : null,
      )
    ));
    const tbody = el('tbody');
    for (const r of repos) {
      const repoName = (r.repo ?? '(unscoped)').split('/').pop() || r.repo;
      const openCell = (hasToken && r.repo)
        ? el('td', {},
            el('button', {
              cls: 'open-repo-btn',
              type: 'button',
              title: `Open ${r.repo} in editor`,
              onClick: () => apiOpenRepo(r.repo, 'editor'),
            }, '↗')
          )
        : el('td', {});
      tbody.appendChild(el('tr', {},
        el('td', { title: r.repo }, repoName),
        el('td', {}, String(r.proposed ?? 0)),
        el('td', { cls: r.autoMerged > 0 ? 'fa-cell-green' : '' }, String(r.autoMerged ?? 0)),
        el('td', { cls: r.pending > 0 ? 'fa-cell-pending' : '' }, String(r.pending ?? 0)),
        el('td', { cls: r.declined > 0 ? 'fa-cell-red' : '' }, String(r.declined ?? 0)),
        openCell,
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

  // ── 5. Agent action feed ────────────────────────────────────────────────
  const actionsCard = el('div', { cls: 'fa-card card' });
  const actions = Array.isArray(d.recentActions) ? d.recentActions : [];
  const actionsSource = d.recentActionsSource;
  const actionsSourceText = !actionsSource
    ? 'unknown source'
    : actionsSource.sourceState === 'missing'
      ? 'missing source'
      : actionsSource.sourceState === 'healthy' && actionsSource.complete === true
        ? 'complete source'
        : 'partial source';
  actionsCard.appendChild(el('div', { cls: 'card-header' },
    el('span', { cls: 'card-title' }, 'Agent Action Feed'),
    el('span', { cls: 'card-subtitle' }, `${actions.length} recent action${actions.length === 1 ? '' : 's'} · ${actionsSourceText}`)
  ));
  const actionsBody = el('div', { cls: 'fa-feed fa-card-body' });
  if (actions.length === 0) {
    const emptyText = actionsSource?.sourceState === 'missing'
      ? 'Agent action telemetry source is not available.'
      : actionsSource && (actionsSource.sourceState !== 'healthy' || actionsSource.complete !== true)
        ? 'Agent action telemetry is unavailable from the partial source.'
        : 'No agent action telemetry recorded yet.';
    actionsBody.appendChild(el('p', { cls: 'hint' }, emptyText));
  } else {
    for (const action of actions.slice(0, 20)) {
      const repoName = action.repo ? basenameFromPath(action.repo) : action.backend ?? action.actor ?? 'fleet';
      actionsBody.appendChild(el('div', { cls: 'fa-feed-row', title: action.summary ?? '' },
        el('span', { cls: 'fa-feed-dot' }),
        el('span', { cls: 'fa-feed-time' }, fmtRelative(action.ts)),
        el('span', { cls: 'fa-feed-repo' }, repoName),
        el('span', { cls: 'fa-feed-engine badge' }, `${action.kind ?? 'action'}/${action.outcome ?? 'unknown'}`),
        el('span', { cls: 'fa-feed-pid' }, compactFleetReason(action.summary ?? action.action ?? '', 72))
      ));
    }
  }
  actionsCard.appendChild(actionsBody);
  section.appendChild(actionsCard);

  // ── 6. Cooldown count + Live tick stream ───────────────────────────────
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

  // ── 7. Live tick stream ────────────────────────────────────────────────
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
      const dispatches = Array.isArray(t.dispatches) ? t.dispatches : [];
	      const dispatchChips = dispatches.slice(0, 3).map((dispatch) => {
	        const repoName = typeof dispatch.repo === 'string' ? dispatch.repo.split('/').pop() || dispatch.repo : '?';
	        const stateLabel = dispatch.dispatched ? 'ran' : dispatch.skipReason || 'skipped';
	        return `${dispatch.backend ?? 'none'}:${repoName}:${stateLabel}`;
	      }).join(' ');
	      const dispatchMore = dispatches.length > 3 ? ` +${dispatches.length - 3}` : '';
	      const maintenance = t.autoMerge && typeof t.autoMerge === 'object' ? t.autoMerge : null;
	      const maintenanceStr = maintenance
	        ? `judge ${maintenance.judged ?? 0}${maintenance.judgePerPass ? `/${maintenance.judgePerPass}` : ''}` +
	          (maintenance.verifyBeforeJudgeRan || maintenance.verifyBeforeJudgePerPass
	            ? ` verify ${maintenance.verifyBeforeJudgeRan ?? 0}${maintenance.verifyBeforeJudgePerPass !== undefined ? `/${maintenance.verifyBeforeJudgePerPass}` : ''}`
	            : '') +
	          (maintenance.judgeEstimatedSpendUsd ? ` est $${maintenance.judgeEstimatedSpendUsd.toFixed(4)}` : '')
	        : '';
	      const handoff = t.remoteHandoff && typeof t.remoteHandoff === 'object' ? t.remoteHandoff : null;
	      const handoffStr = handoff && handoff.checked > 0
	        ? `handoff ${handoff.checked} checked` +
	          (handoff.merged ? ` ${handoff.merged} merged` : '') +
	          (handoff.closed ? ` ${handoff.closed} closed` : '') +
	          (handoff.unknown ? ` ${handoff.unknown} unknown` : '')
	        : '';
	      const production = t.proposalProduction && typeof t.proposalProduction === 'object' ? t.proposalProduction : null;
	      const productionStr = production
	        ? `prod ${production.dispatched ?? 0}/${production.claimed ?? 0}` +
	          (production.proposalsCreated ? ` props ${production.proposalsCreated}` : '') +
	          (production.noProposalDispatches ? ` no-prop ${production.noProposalDispatches}` : '') +
	          (production.errors ? ` err ${production.errors}` : '')
	        : '';
	      const hasMerge = t.merged > 0;
	      const tickCls = `fa-tick-row${hasMerge ? ' fa-tick-merged' : ''}`;
      ticksBody.appendChild(el('div', { cls: tickCls },
        el('span', { cls: 'fa-tick-dot' }),
        el('span', { cls: 'fa-tick-time' }, fmtRelative(t.ts)),
	        el('span', { cls: 'fa-tick-reason' }, t.dryRun === true ? `${t.reason ?? 'ok'}:sim` : (t.reason ?? 'ok')),
	        backendsStr ? el('span', { cls: 'fa-tick-backends' }, backendsStr) : null,
	        dispatchChips ? el('span', { cls: 'fa-tick-dispatches' }, `${dispatchChips}${dispatchMore}`) : null,
	        productionStr ? el('span', { cls: 'fa-tick-production' }, productionStr) : null,
	        maintenanceStr ? el('span', { cls: 'fa-tick-maintenance' }, maintenanceStr) : null,
	        handoffStr ? el('span', { cls: 'fa-tick-maintenance' }, handoffStr) : null,
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
// M210: Fleet Dashboard — glanceable + customizable 4-panel view
// ---------------------------------------------------------------------------

// ── Settings helpers ────────────────────────────────────────────────────────

const FD_SETTINGS_KEY = 'ashlr-fleet-dashboard-settings';

const FD_DEFAULT_SETTINGS = {
  panels: { status: true, running: true, usage: true, activity: true, production: true, intelligence: true, visibility: true },
  refreshSecs: 15,
  theme: 'dark',
};

function fdLoadSettings() {
  if (state.fleetDashboardSettings) return state.fleetDashboardSettings;
  try {
    const raw = localStorage.getItem(FD_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge with defaults so new keys always exist
      state.fleetDashboardSettings = {
        panels: Object.assign({}, FD_DEFAULT_SETTINGS.panels, parsed.panels ?? {}),
        refreshSecs: typeof parsed.refreshSecs === 'number' ? parsed.refreshSecs : FD_DEFAULT_SETTINGS.refreshSecs,
        theme: parsed.theme === 'light' ? 'light' : 'dark',
      };
    } else {
      state.fleetDashboardSettings = JSON.parse(JSON.stringify(FD_DEFAULT_SETTINGS));
    }
  } catch {
    state.fleetDashboardSettings = JSON.parse(JSON.stringify(FD_DEFAULT_SETTINGS));
  }
  return state.fleetDashboardSettings;
}

function fdSaveSettings(s) {
  state.fleetDashboardSettings = s;
  try { localStorage.setItem(FD_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function fdApplyTheme(theme) {
  if (theme === 'light') {
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
  }
}

// ── Data loader ─────────────────────────────────────────────────────────────

let _fdLoading = false;

async function loadFleetDashboard() {
  if (_fdLoading) return;
  _fdLoading = true;

  // Don't show skeleton flash on poll refreshes
  if (!state.fleetDashboard) showLoading('fleet-dashboard');
  try {
    state.fleetDashboard = await apiFetch('/api/snapshot');
    renderFleetDashboard();
  } catch (err) {
    if (!state.fleetDashboard) showError('fleet-dashboard', err.message);
  } finally {
    _fdLoading = false;
  }

  // Start auto-refresh interval if not already running
  const settings = fdLoadSettings();
  fdApplyTheme(settings.theme);
  if (state.activeView === 'fleet-dashboard' && !state.fleetDashboardInterval) {
    state.fleetDashboardInterval = setInterval(() => {
      if (state.activeView !== 'fleet-dashboard') {
        clearInterval(state.fleetDashboardInterval);
        state.fleetDashboardInterval = null;
        return;
      }
      loadFleetDashboard();
    }, settings.refreshSecs * 1000);
  }
}

// ── Panel renderers ─────────────────────────────────────────────────────────

function fdReadinessDataText(readiness) {
  if (!readiness) return 'unknown';
  const freshness = readiness.freshness?.overall ?? 'unknown';
  const quality = readiness.sourceQualitySummary ?? {};
  const sources = Array.isArray(readiness.sources) ? readiness.sources : [];
  const evidenceState = readiness.evidenceMatrix?.state;
  const evidenceSuffix = evidenceState ? ` · evidence ${evidenceState}` : '';
  const sourceNamesForBadge = (badge) => {
    const names = sources
      .filter((source) => source?.sourceQuality?.badge === badge)
      .map((source) => source.label ?? source.id ?? 'source')
      .filter(Boolean);
    if (names.length === 0) return '';
    const visible = names.slice(0, 2).join(', ');
    return names.length > 2 ? `${visible}, +${names.length - 2}` : visible;
  };
  if (Object.keys(quality).length > 0) {
    const qualityParts = [
      ['degraded-source', 'degraded'],
      ['unknown-source', 'unknown'],
      ['stale-source', 'stale'],
      ['missing-source', 'missing'],
      ['healthy-zero', 'empty'],
    ]
      .map(([key, label]) => [key, label, quality[key] ?? 0])
      .filter(([, , count]) => count > 0)
      .map(([key, label, count]) => {
        const sourceNames = sourceNamesForBadge(key);
        return `${count} ${label}${sourceNames ? ` (${sourceNames})` : ''}`;
      });
    return `${freshness} · ${qualityParts.length > 0 ? qualityParts.join(' / ') : 'healthy sources'}${evidenceSuffix}`;
  }
  const summary = readiness.sourceSummary ?? {};
  const healthy = summary.healthy ?? 0;
  const degraded = summary.degraded ?? 0;
  const blocked = summary.blocked ?? 0;
  return `${freshness} · ${healthy} healthy / ${degraded} degraded / ${blocked} blocked${evidenceSuffix}`;
}

function fdReadinessDataTitle(readiness) {
  if (!readiness) return 'Readiness data unavailable';
  const sources = Array.isArray(readiness.sources) ? readiness.sources : [];
  const evidence = Array.isArray(readiness.evidenceMatrix?.sources) ? readiness.evidenceMatrix.sources : [];
  const allSources = [...sources, ...evidence];
  if (allSources.length === 0) return fdReadinessDataText(readiness);
  return allSources.map((source) => {
    const label = source.label ?? source.id ?? 'source';
    const badge = source.sourceQuality?.badge ?? source.badge ?? source.status ?? 'unknown';
    const detail = source.sourceQuality?.detail ?? source.detail ?? '';
    return detail ? `${label}: ${badge} - ${detail}` : `${label}: ${badge}`;
  }).join('\n');
}

function fdDispatchYieldText(dispatchProduction, sourceQuality) {
  if (!dispatchProduction) return sourceQuality?.sourceState === 'degraded'
    ? dispatchProductionSourceText(sourceQuality)
    : 'unavailable';
  if (!dispatchProductionSourceHealthy(sourceQuality)) return dispatchProductionSourceText(sourceQuality);
  const proposals = dispatchProduction.proposalsCreated ?? 0;
  const attempts = dispatchProductionDiagnosticAttempts(dispatchProduction);
  return `${proposals}/${attempts} proposals (${formatFleetPercent(dispatchProductionDiagnosticRate(dispatchProduction))})`;
}

function fdMetricPill(label, value, title) {
  return el('div', { cls: 'fd-readiness-pill', title: title ?? value },
    el('span', { cls: 'fd-readiness-pill__label' }, label),
    el('span', { cls: 'fd-readiness-pill__value' }, value)
  );
}

function fdFormatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return '<1m';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function fdRenderLeaseMetric(label, value, tone, title) {
  return el('div', { cls: 'fd-lease-metric', title: title ?? value },
    el('span', { cls: 'fd-lease-metric__label' }, label),
    el('span', { cls: tone ? `fd-lease-metric__value fd-lease-metric__value--${tone}` : 'fd-lease-metric__value' }, value)
  );
}

function fdActiveWorkTitle(activeWork) {
  if (!activeWork) return 'No active daemon spend guard';
  const owner = [activeWork.hostname, activeWork.pid != null ? `pid ${activeWork.pid}` : null]
    .filter(Boolean)
    .join(' ');
  const age = fdFormatDurationMs(activeWork.ageMs);
  const armed = activeWork.armedAt ? fmtDate(activeWork.armedAt) : 'unknown';
  return `${activeWork.malformed ? 'Malformed' : 'Armed'} / ${activeWork.itemCount ?? 0} item(s) / age ${age} / ${owner || 'unknown owner'} / armed ${armed}`;
}

function fdActiveWorkValue(activeWork) {
  if (!activeWork) return '—';
  const state = activeWork.malformed ? 'malformed' : 'armed';
  return `${activeWork.itemCount ?? 0} ${state}`;
}

function fdRenderLeaseBoard(sharedQueue, activeWork) {
  if (!sharedQueue && !activeWork) return null;
  const claimsByMachine = Array.isArray(sharedQueue?.claimsByMachine) ? sharedQueue.claimsByMachine : [];
  const claimSamples = Array.isArray(sharedQueue?.claimSamples) ? sharedQueue.claimSamples : [];
  const activeItemIds = Array.isArray(activeWork?.itemIds) ? activeWork.itemIds : [];
  const visibleClaims = claimsByMachine.slice(0, 6);
  const visibleClaimSamples = claimSamples.slice(0, 6);
  const unreadable = sharedQueue?.readable === false;
  const staleLock = sharedQueue?.lock?.stale === true;
  const malformedActiveWork = activeWork?.malformed === true;
  const reclaimable = sharedQueue?.reclaimableClaims ?? 0;
  const active = sharedQueue?.activeClaims ?? 0;
  const owned = sharedQueue?.ownedClaims ?? 0;
  const statusText = unreadable
    ? 'Unreadable'
    : malformedActiveWork
      ? 'Guard malformed'
    : staleLock
      ? 'Stale lock'
      : reclaimable > 0
        ? 'Reclaimable'
        : activeWork && !sharedQueue
          ? 'Active work'
        : 'Healthy';
  const statusTone = unreadable || staleLock || reclaimable > 0 || malformedActiveWork ? 'warn' : 'ok';
  const mode = sharedQueue?.mode ?? (sharedQueue?.enabled ? 'shared' : 'local');
  const machineLabel = sharedQueue?.machineId ?? activeWork?.hostname ?? 'unknown';
  const nextExpiryTitle = sharedQueue?.nextLeaseExpiryAt ? fmtDate(sharedQueue.nextLeaseExpiryAt) : 'No active lease expiry';
  const nextExpiry = sharedQueue?.nextLeaseExpiryAt ? fmtRelative(sharedQueue.nextLeaseExpiryAt) : '—';
  const expiredAge = fdFormatDurationMs(sharedQueue?.oldestExpiredMs);

  const board = el('div', {
    cls: `fd-lease-board${statusTone === 'warn' ? ' fd-lease-board--warn' : ''}`,
  });
  board.appendChild(el('div', { cls: 'fd-lease-board__head' },
    el('div', { cls: 'fd-lease-board__title' },
      el('span', { cls: 'fd-lease-board__eyebrow' }, 'Lease Board'),
      el('span', { cls: 'fd-lease-board__mode' }, mode)
    ),
    el('span', { cls: `fd-lease-board__state fd-lease-board__state--${statusTone}` }, statusText)
  ));

  const metrics = el('div', { cls: 'fd-lease-metrics' },
    fdRenderLeaseMetric('This machine', compactFleetReason(machineLabel, 34), null, machineLabel),
    fdRenderLeaseMetric('Active / owned', `${active} / ${owned}`),
    fdRenderLeaseMetric('Reclaimable', String(reclaimable), reclaimable > 0 ? 'warn' : null),
    fdRenderLeaseMetric('Next expiry', nextExpiry, null, nextExpiryTitle),
    fdRenderLeaseMetric('Expired age', expiredAge, expiredAge !== '—' ? 'warn' : null),
    fdRenderLeaseMetric('Cooldown / worked / usage', `${sharedQueue?.cooldownItems ?? 0} / ${sharedQueue?.workedEvents ?? 0} / ${sharedQueue?.usageEntries ?? 0}`),
    activeWork ? fdRenderLeaseMetric('Active work', fdActiveWorkValue(activeWork), malformedActiveWork ? 'warn' : 'ok', fdActiveWorkTitle(activeWork)) : null
  );
  board.appendChild(metrics);

  const machines = el('div', { cls: 'fd-lease-machines' });
  if (visibleClaims.length === 0) {
    machines.appendChild(el('div', { cls: 'fd-lease-empty' }, unreadable ? 'Machine claims unavailable.' : 'No machine claims.'));
  } else {
    for (const claim of visibleClaims) {
      const machineId = claim?.machineId ?? 'unknown';
      const claimActive = claim?.active ?? 0;
      const claimExpired = claim?.expired ?? 0;
      machines.appendChild(el('div', { cls: 'fd-lease-machine', title: machineId },
        el('span', { cls: 'fd-lease-machine__id' }, machineId),
        el('span', { cls: 'fd-lease-machine__counts' }, `${claimActive} active / ${claimExpired} expired`)
      ));
    }
    if (claimsByMachine.length > visibleClaims.length) {
      machines.appendChild(el('div', { cls: 'fd-lease-more' }, `+${claimsByMachine.length - visibleClaims.length} more machine(s)`));
    }
  }
  board.appendChild(machines);

  if (visibleClaimSamples.length > 0 || activeItemIds.length > 0) {
    const samples = el('div', { cls: 'fd-lease-samples' });
    for (const sample of visibleClaimSamples) {
      const itemId = sample?.itemId ?? 'unknown';
      const owner = sample?.owned ? 'owned' : (sample?.machineId ?? 'unknown');
      const state = sample?.state ?? 'unknown';
      const title = `${itemId} / ${state} / ${owner}${sample?.leaseUntil ? ` / ${fmtDate(sample.leaseUntil)}` : ''}`;
      samples.appendChild(el('div', { cls: `fd-lease-sample fd-lease-sample--${state}`, title },
        el('span', { cls: 'fd-lease-sample__id' }, compactFleetReason(itemId, 48)),
        el('span', { cls: 'fd-lease-sample__meta' }, `${state} / ${compactFleetReason(owner, 28)}`)
      ));
    }
    if (activeItemIds.length > 0) {
      samples.appendChild(el('div', { cls: 'fd-lease-active-ids', title: activeItemIds.join(', ') },
        `active ids: ${activeItemIds.slice(0, 4).map((id) => compactFleetReason(id, 30)).join(', ')}`
      ));
    }
    board.appendChild(samples);
  }
  return board;
}

function fdRenderReadinessRail(snap) {
  const fleet = snap.fleet ?? snap.control?.fleet ?? null;
  const readiness = snap.fleet?.autonomousShipReadiness ?? snap.control?.fleet?.autonomousShipReadiness ?? null;
  if (!readiness) return null;

  const missionBrief = fleet?.missionBrief ?? null;
  const queue = fleet?.queue ?? {};
  const sharedQueue = queue.shared ?? null;
  const dispatchProduction = fleet?.dispatchProduction ?? null;
  const dispatchProductionSource = fleet?.dispatchProductionSource ?? null;
  const effectiveness = fleet?.autonomyEffectiveness ?? null;
  const topBlocker = missionBrief?.blocker ?? readiness.topBlocker ?? null;
  const primaryAction = missionBrief?.action ?? readiness.primaryAction ?? null;
  const directive = missionBrief?.directive ?? null;
  const actionLabel = primaryAction?.label ?? primaryAction?.id ?? 'none';
  const briefLabel = directive ?? actionLabel;
  const briefDetail = missionBrief?.whyNow ?? primaryAction?.detail ?? actionLabel;
  const actionDetail = primaryAction?.detail ?? briefDetail;
  const blockerLabel = topBlocker?.label ?? topBlocker?.id ?? 'none';
  const blockerDetail = topBlocker?.detail ?? blockerLabel;
  const queueMetric = queueEligibilityMetric(queue) ?? `${queue.backlogItems ?? 0} backlog`;
  const generatedMetric = generatedWorkMetric(queue.generatedWork);
  const drainMetric = diagnosticResliceDrainMetric(queue.diagnosticResliceDrain);
  const repairRecovery = fleetRepairRecoveryMetric(fleet);
  const isRepairRecoveryActive = fleetRepairRecoveryActive(readiness, missionBrief);
  const leases = sharedQueue ? sharedQueueMetric(sharedQueue) : 'local only';
  const loop = isRepairRecoveryActive ? 'repair recovery -> learning' : effectiveness?.phase ?? 'unknown';
  const verdict = formatShipReadinessVerdict(readiness.verdict);

  const rail = el('div', {
    cls: `fd-readiness-rail fd-readiness-rail--${readiness.verdict ?? 'unknown'}`,
    style: `--fd-readiness-accent:${shipReadinessAccent(readiness.verdict)}`,
  });
  rail.appendChild(el('div', { cls: 'fd-readiness-rail__head' },
    el('span', { cls: 'fd-readiness-rail__label' }, 'Fleet OS'),
    el('span', { cls: 'fd-readiness-rail__verdict' }, verdict),
    el('span', { cls: 'fd-readiness-rail__loop' }, `Loop: ${loop}`)
  ));
  rail.appendChild(el('div', { cls: 'fd-readiness-strip' },
    fdMetricPill('Brief', compactFleetReason(briefLabel, 54), briefDetail),
    fdMetricPill('Confidence', missionBrief?.confidence ?? readiness.confidence ?? 'unknown'),
    fdMetricPill('Action', compactFleetReason(actionLabel, 54), actionDetail),
    fdMetricPill('Data', fdReadinessDataText(readiness), fdReadinessDataTitle(readiness)),
    fdMetricPill('Blocker', compactFleetReason(blockerLabel, 54), blockerDetail),
    fdMetricPill('Queue', queueMetric),
    generatedMetric ? fdMetricPill('Generated', generatedMetric) : null,
    repairRecovery ? fdMetricPill('Repair Loop', repairRecovery.value, repairRecovery.detail) : null,
    drainMetric ? fdMetricPill('Diag Drain', drainMetric) : null,
    fdMetricPill('Leases', leases ?? 'local only'),
    fdMetricPill('Yield', fdDispatchYieldText(dispatchProduction, dispatchProductionSource))
  ));
  return rail;
}

function fdRenderStatusPanel(snap) {
  const daemon = snap.daemon ?? {};
  const fleetDaemon = snap.fleet?.daemon ?? snap.control?.fleet?.daemon ?? daemon;
  const isRunning = fleetDaemon.running === true;
  const isKilled = snap.fleet?.killed ?? snap.control?.fleet?.killed ?? false;
  const queue = snap.fleet?.queue ?? snap.control?.fleet?.queue ?? {};
  const sharedQueue = queue.shared ?? null;
  const activeWork = queue.activeWork ?? null;
  const autonomy = snap.fleet?.autonomy ?? snap.control?.fleet?.autonomy ?? null;
  const phantom = snap.fleet?.phantom ?? snap.control?.fleet?.phantom ?? null;

  const body = el('div', { cls: 'fd-panel__body' });
  const readinessRail = fdRenderReadinessRail(snap);
  if (readinessRail) body.appendChild(readinessRail);

  // Big running indicator
  const dot = el('span', { cls: isRunning ? 'fd-daemon-dot fd-daemon-dot--running' : 'fd-daemon-dot' });
  const label = el('span', {
    cls: isRunning ? 'fd-daemon-label fd-daemon-label--running' : 'fd-daemon-label fd-daemon-label--stopped',
  }, isRunning ? `Daemon running · ${daemonActivityDisplay(fleetDaemon)}` : 'Daemon stopped');
  body.appendChild(el('div', { cls: 'fd-status-row' }, dot, label));

  // Meta grid
  const lastTick = fleetDaemon.lastTickAt ? fmtRelative(fleetDaemon.lastTickAt) : '—';
  const spend = daemon.todaySpentUsd != null ? `$${daemon.todaySpentUsd.toFixed(4)}` : '—';
  const pendingCount = daemon.pendingProposals ?? snap.inbox?.pending ?? 0;

  const grid = el('div', { cls: 'fd-meta-grid' });

  const mkMeta = (key, val, cls) => {
    const item = el('div', { cls: 'fd-meta-item' },
      el('div', { cls: 'fd-meta-key' }, key),
      el('div', { cls: cls ? `fd-meta-val ${cls}` : 'fd-meta-val' }, val)
    );
    return item;
  };

  grid.appendChild(mkMeta('Last tick', lastTick));
  grid.appendChild(mkMeta('Spend today', spend));
  grid.appendChild(mkMeta('Pending proposals', String(pendingCount),
    pendingCount > 0 ? 'fd-meta-val--warn' : null));
  grid.appendChild(mkMeta('Items processed', String(daemon.itemsProcessed ?? 0)));
  if (sharedQueue) {
    grid.appendChild(mkMeta('Shared queue', sharedQueueMetric(sharedQueue),
      !sharedQueue.readable || sharedQueue.reclaimableClaims > 0 || sharedQueue.lock?.stale ? 'fd-meta-val--warn' : null));
    grid.appendChild(mkMeta('Owned leases', String(sharedQueue.ownedClaims ?? 0)));
  }
  if (activeWork) {
    grid.appendChild(mkMeta('Active work', fdActiveWorkValue(activeWork),
      activeWork.malformed ? 'fd-meta-val--warn' : null));
  }
  if (autonomy) {
    grid.appendChild(mkMeta('Evidence packs', String(autonomy.evidencePacks ?? 0),
      autonomy.denied > 0 ? 'fd-meta-val--warn' : null));
    grid.appendChild(mkMeta('Autonomy latest', autonomy.latestAt ? fmtRelative(autonomy.latestAt) : '—'));
  }
  if (phantom?.agentReport?.delegationSafety) {
    const safety = phantom.agentReport.delegationSafety.safetyCounts ?? {};
    const unsafe = Number(safety.unsafe ?? 0);
    grid.appendChild(mkMeta('Phantom delegation', `safe ${safety.safe ?? 0} / unsafe ${unsafe}`,
      unsafe > 0 ? 'fd-meta-val--warn' : null));
  }
  body.appendChild(grid);
  const leaseBoard = fdRenderLeaseBoard(sharedQueue, activeWork);
  if (leaseBoard) body.appendChild(leaseBoard);

  // Kill-switch banner
  if (isKilled) {
    body.appendChild(el('div', { cls: 'fd-kill-banner' },
      'Kill switch engaged — fleet paused.',
      fleetPauseResumeButton(true, 'btn-sm')
    ));
  }

  return body;
}

function fdRenderRunningPanel(snap) {
  const daemon = snap.daemon ?? {};
  const inbox = snap.inbox ?? {};
  const pendingCount = daemon.pendingProposals ?? inbox.pending ?? 0;
  const recentRuns = Array.isArray(snap.runs) ? snap.runs.slice(0, 5) : [];
  const itemsProcessed = daemon.itemsProcessed ?? 0;

  const body = el('div', { cls: 'fd-panel__body' });

  // Count blocks
  const counts = el('div', { cls: 'fd-running-count' });
  const addCount = (num, lbl, cls) => {
    counts.appendChild(el('div', { cls: 'fd-count-block' },
      el('div', { cls: `fd-count-num ${cls}` }, String(num)),
      el('div', { cls: 'fd-count-lbl' }, lbl)
    ));
  };
  addCount(itemsProcessed, 'items this run', 'fd-count-num--neutral');
  addCount(pendingCount, 'pending proposals', pendingCount > 0 ? 'fd-count-num--warn' : 'fd-count-num--ok');
  addCount(recentRuns.filter(r => r.status === 'running').length, 'runs active', 'fd-count-num--neutral');
  body.appendChild(counts);

  // Recent runs list
  if (recentRuns.length === 0) {
    body.appendChild(el('p', { cls: 'hint' }, 'No recent runs.'));
    return body;
  }

  const list = el('ul', { cls: 'fd-proposals-list' });
  for (const r of recentRuns) {
    const statusColor = r.status === 'done' ? 'var(--status-ok)' :
                        r.status === 'running' ? 'var(--accent)' :
                        r.status === 'failed' ? 'var(--status-fail)' : 'var(--text-muted)';
    const row = el('li', { cls: 'fd-proposal-row' },
      el('span', { cls: 'fd-proposal-title', title: r.goal }, r.goal ?? '—'),
      el('span', { cls: 'fd-proposal-kind', style: `color:${statusColor}` }, r.status ?? '—')
    );
    list.appendChild(row);
  }
  body.appendChild(list);
  return body;
}

function fdRenderUsagePanel(snap) {
  const fu = snap.frontierUsage;
  const body = el('div', { cls: 'fd-panel__body' });

  if (!fu || !Array.isArray(fu.engines) || fu.engines.length === 0) {
    body.appendChild(el('p', { cls: 'hint' },
      'No frontier usage data. Configure engines in foundry.allowedBackends.'));
    return body;
  }

  for (const eng of fu.engines) {
    const win = eng.subscriptionWindow ?? { state: 'unknown', usedPct: 0 };
    const pct = Math.min(100, Math.max(0, win.usedPct ?? 0));
    const stateKey = win.state ?? 'unknown';

    const engRow = el('div', { cls: 'fd-usage-engine' });

    // Header: name + state badge
    const badge = el('span', { cls: `fd-usage-engine-state fd-usage-engine-state--${stateKey}` }, stateKey);
    engRow.appendChild(el('div', { cls: 'fd-usage-engine-header' },
      el('span', { cls: 'fd-usage-engine-name' }, eng.engine),
      badge
    ));

    // Progress bar
    const track = el('div', { cls: 'fd-usage-bar-track' });
    const fill = el('div', {
      cls: `fd-usage-bar-fill fd-usage-bar-fill--${stateKey}`,
      style: `width:${pct.toFixed(1)}%`,
      role: 'progressbar',
      'aria-valuenow': String(Math.round(pct)),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': `${eng.engine} usage ${Math.round(pct)}%`,
    });
    track.appendChild(fill);
    engRow.appendChild(track);

    // Meta row: calls / tokens / cost / window / reset
    const meta = el('div', { cls: 'fd-usage-engine-meta' });

    const addMeta = (label, value) => {
      meta.appendChild(el('span', { cls: 'fd-usage-meta-item' },
        el('strong', {}, value), ` ${label}`
      ));
    };

    // calls today with limit if configured
    if (eng.limit != null) {
      addMeta('calls', `${eng.callsToday}/${eng.limit}`);
      if (eng.remainingEstimate != null) {
        addMeta('remaining', `~${eng.remainingEstimate}`);
      }
    } else {
      addMeta('calls', String(eng.callsToday));
    }

    if (eng.tokensToday != null) {
      addMeta('tokens', fmtK(eng.tokensToday));
    }
    if (eng.costToday != null) {
      addMeta('cost', `$${eng.costToday.toFixed(4)}`);
    }

    // Window reset
    if (win.resetsAt) {
      const resetsIn = Math.max(0, win.resetsAt * 1000 - Date.now());
      const hoursLeft = (resetsIn / 3_600_000).toFixed(1);
      const resetSpan = el('span', { cls: 'fd-usage-meta-item' });
      const inner = el('span', { cls: hoursLeft < 2 ? 'fd-reset-soon' : '' },
        `resets in ${hoursLeft}h`);
      resetSpan.appendChild(inner);
      meta.appendChild(resetSpan);
    } else if (win.windowLabel) {
      addMeta('window', win.windowLabel);
    }

    engRow.appendChild(meta);
    body.appendChild(engRow);
  }

  return body;
}

function fdRenderActivityPanel(snap) {
  const recentRuns = Array.isArray(snap.runs) ? snap.runs.slice(0, 8) : [];
  const body = el('div', { cls: 'fd-panel__body' });

  // Activity summary line
  const act = snap.activity ?? {};
  if (act.commits || act.sessions) {
    body.appendChild(el('div', { cls: 'fd-stat-label', style: 'margin-bottom:10px' },
      `7d: ${act.sessions ?? 0} sessions · ${act.commits ?? 0} commits · $${(act.estCostUsd ?? 0).toFixed(4)}`
    ));
  }

  if (recentRuns.length === 0) {
    body.appendChild(el('p', { cls: 'hint' }, 'No recent activity.'));
    return body;
  }

  const list = el('ul', { cls: 'fd-activity-list' });
  for (const r of recentRuns) {
    const statusColor = r.status === 'done' ? 'var(--status-ok)' :
                        r.status === 'running' ? 'var(--accent)' :
                        r.status === 'failed' ? 'var(--status-fail)' :
                        r.status === 'aborted' ? 'var(--status-warn)' : 'var(--text-muted)';
    const row = el('li', { cls: 'fd-activity-row' },
      el('span', { cls: 'fd-activity-dot', style: `background:${statusColor}` }),
      el('span', { cls: 'fd-activity-goal', title: r.goal }, r.goal ?? '—'),
      el('span', { cls: 'fd-activity-status', style: `color:${statusColor}` }, r.status ?? '—'),
      r.tokens ? el('span', { cls: 'fd-activity-cost' }, fmtK(r.tokens) + ' tok') : null
    );
    list.appendChild(row);
  }
  body.appendChild(list);
  return body;
}

// ── M224: Production panel ──────────────────────────────────────────────────

function fdRenderProductionPanel(snap) {
  const prod = snap.production;
  const production = snap.fleet?.proposalProduction ?? snap.control?.fleet?.proposalProduction ?? null;
  const dispatchProduction = snap.fleet?.dispatchProduction ?? snap.control?.fleet?.dispatchProduction ?? null;
  const dispatchProductionSource = snap.fleet?.dispatchProductionSource ?? snap.control?.fleet?.dispatchProductionSource ?? null;
  const workspace = snap.fleet?.workspace ?? snap.control?.fleet?.workspace ?? null;
  const attemptCoverage = snap.fleet?.attemptCoverage ?? snap.control?.fleet?.attemptCoverage ?? null;
  const trajectoryLearning = snap.fleet?.trajectoryLearning ?? snap.control?.fleet?.trajectoryLearning ?? null;
  const skillCorpusReadiness = snap.fleet?.skillCorpusReadiness ?? snap.control?.fleet?.skillCorpusReadiness ?? null;
  const contextEfficiency = snap.fleet?.contextEfficiency ?? snap.control?.fleet?.contextEfficiency ?? null;
  const hasProductionData = Boolean(prod || production || dispatchProduction || dispatchProductionSource || workspace || attemptCoverage || trajectoryLearning || skillCorpusReadiness);
  const body = el('div', { cls: 'fd-panel__body' });

  if (!hasProductionData) {
    body.appendChild(el('p', { cls: 'hint' }, 'Production data unavailable.'));
    if (!contextEfficiency) return body;
  }

  if (production) {
    const noProposal = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches ?? 0;
    const suppressed = production.suppressedDispatches ?? 0;
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Proposal production'));
    body.appendChild(infoGrid([
      ['Window', proposalProductionWindowLabel(production)],
      ['Selected', production.selected ?? 0],
      ['Dispatched', production.dispatched ?? 0],
      ['Proposals', production.proposalsCreated ?? 0],
      ['No-proposal', noProposal],
      ['Suppressed', suppressed],
      ['Errors', production.errors ?? 0],
    ]));
    const reasons = proposalProductionReasons(production, 2);
    if (reasons.length > 0) {
      body.appendChild(el('p', { cls: 'hint' }, `Top reason: ${reasons.join('; ')}`));
    }
  }

  if (dispatchProduction) {
    const repairRecovery = generatedRepairRecoveryMetric(dispatchProduction.generatedRepairAttempts);
    const diagnosticAttempts = dispatchProductionDiagnosticAttempts(dispatchProduction);
    const diagnosticNoProposal = dispatchProduction.diagnosticNoProposal ??
      Math.max(0, diagnosticAttempts - Number(dispatchProduction.proposalsCreated ?? 0));
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Dispatch yield'));
    body.appendChild(infoGrid([
      ['Source', dispatchProductionSourceText(dispatchProductionSource)],
      ['Window', proposalProductionWindowLabel(dispatchProduction)],
      ['Attempts', diagnosticAttempts],
      ['Proposals', dispatchProduction.proposalsCreated ?? 0],
      ['Yield', dispatchProductionSourceHealthy(dispatchProductionSource)
        ? formatFleetPercent(dispatchProductionDiagnosticRate(dispatchProduction))
        : 'partial'],
      ['Repair recovery', repairRecovery?.value ?? '—'],
      ['No-proposal', diagnosticNoProposal],
      ['Cancelled', dispatchProduction.outcomes?.cancelled ?? 0],
      ['Spend', `$${Number(dispatchProduction.spentUsd ?? 0).toFixed(4)}`],
    ]));
    const shape = formatAttemptShape(dispatchProduction.attemptShape);
    if (shape) body.appendChild(el('p', { cls: 'hint' }, shape));
    if (repairRecovery) {
      body.appendChild(el('p', { cls: 'hint' }, `Repair loop: ${repairRecovery.detail}`));
    }
    const backends = Array.isArray(dispatchProduction.byBackend) ? dispatchProduction.byBackend : [];
    const backend = dispatchProductionWeakestBackend(backends);
    if (backend) {
      const attempts = dispatchProductionDiagnosticAttempts(backend);
      const proposals = backend.proposalsCreated ?? 0;
      body.appendChild(el('p', { cls: 'hint' },
        `Weakest backend: ${dispatchProductionBucketLabel(backend)} ${proposals}/${attempts} ` +
        `(${formatFleetPercent(dispatchProductionDiagnosticRate(backend))})`
      ));
    }
  }
  else if (dispatchProductionSource) {
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Dispatch yield'));
    body.appendChild(infoGrid([
      ['Source', dispatchProductionSourceText(dispatchProductionSource)],
      ['Yield', 'unavailable'],
    ]));
  }

  if (trajectoryLearning) {
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Trajectory learning'));
    body.appendChild(infoGrid(trajectoryLearningRows(trajectoryLearning, skillCorpusReadiness)));
  } else if (skillCorpusReadiness) {
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Skill learning'));
    body.appendChild(infoGrid(skillCorpusReadinessRows(skillCorpusReadiness)));
  }

  if (workspace) {
    const diagnosticNoProposal = workspace.diagnosticNoProposalEvents ?? workspace.noProposalEvents ?? 0;
    const policySuppressed = workspace.policySuppressedEvents ?? 0;
    const diagnosticProposalRate = typeof workspace.diagnosticProposalRate === 'number'
      ? workspaceObservedValue(workspace, formatFleetPercent(workspace.diagnosticProposalRate), true)
      : '—';
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Global workspace'));
    body.appendChild(infoGrid([
      ['Window', proposalProductionWindowLabel(workspace)],
      ['Source', workspaceSourceText(workspace)],
      ['Read', workspaceReadText(workspace)],
      ['Events', workspaceObservedValue(workspace, workspace.eventCount ?? 0)],
      ['Proposals', workspaceObservedValue(workspace, workspace.proposalEvents ?? 0)],
      ['No-proposal', workspaceObservedValue(workspace, diagnosticNoProposal)],
      ['Policy-suppressed', workspaceObservedValue(workspace, policySuppressed)],
      ['Diagnostic rate', diagnosticProposalRate],
      ['Action entropy', workspaceObservedValue(workspace, workspace.entropy?.action ?? 0)],
    ]));
    const attention = Array.isArray(workspace.attention) ? workspace.attention[0] : null;
    if (attention) {
      const topic = attention.kind === 'repo' ? basenameFromPath(attention.topic ?? '') : attention.topic;
      body.appendChild(el('p', { cls: 'hint' }, `Top attention: ${attention.kind}:${topic} (${attention.weight ?? 0})`));
    }
  }

  if (attemptCoverage) {
    const causal = attemptCoverage.causalCoverage ?? {};
    const weak = attemptCoverage.causalWeak ?? {};
    const topWeak = Array.isArray(weak.reasons) ? weak.reasons[0] : null;
    const diagnostics = attemptCoverage.causalGapDiagnostics ?? {};
    const topCause = Array.isArray(diagnostics.causes) ? diagnostics.causes[0] : null;
    const actionableCause = Array.isArray(diagnostics.actionableCauses) ? diagnostics.actionableCauses[0] : null;
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Attempt coverage'));
    body.appendChild(infoGrid([
      ['Attempts', attemptCoverage.attempts ?? 0],
      ['Cancelled', attemptCoverage.production?.cancelled ?? 0],
      ['Trajectory', formatCoverageMetric(causal.trajectoryId)],
      ['Route', formatCoverageMetric(causal.routeSnapshot)],
      ['Run summary', formatCoverageMetric(causal.runEventSummary)],
      ['Current policy', formatCoverageMetric(causal.currentRouterPolicyVersion)],
      ['Current epoch', formatCoverageMetric(causal.currentLearningEpoch)],
      ['Current labels', formatCoverageMetric(causal.currentAuthoritativeLabel)],
    ]));
    if (topWeak) {
      body.appendChild(el('p', { cls: 'hint' },
        `Top causal gap: ${topWeak.kind} ${topWeak.count ?? 0}/${topWeak.denominator ?? attemptCoverage.attempts ?? 0} (${formatFleetPercent(topWeak.rate)})`
      ));
    }
    if (topCause) {
      body.appendChild(el('p', { cls: 'hint' },
        `Top cause: ${topCause.cause} on ${topCause.count ?? 0} attempt${topCause.count === 1 ? '' : 's'}`
      ));
    }
    if (actionableCause && actionableCause.cause !== topCause?.cause) {
      body.appendChild(el('p', { cls: 'hint' },
        `Actionable: ${actionableCause.cause} on ${actionableCause.count ?? 0} attempt${actionableCause.count === 1 ? '' : 's'}`
      ));
    }
  }

  if (contextEfficiency) {
    const signals = contextEfficiency.signals ?? {};
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Context efficiency'));
    body.appendChild(infoGrid([
      ['Posture', `${contextEfficiency.posture ?? 'unknown'} (${contextEfficiency.score ?? 0}/100)`],
      ['Memory', signals.memoryEntries ?? 0],
      ['Retrieval', signals.retrievalPosture ?? 'unknown'],
      ['Top repo', signals.topRepoShare == null ? '—' : formatFleetPercent(signals.topRepoShare)],
      ['Reflection', signals.reflectionEvents ?? 0],
      ['Bloat risk', signals.contextBloatRisk ?? 'unknown'],
    ]));
    const risk = Array.isArray(contextEfficiency.risks) ? contextEfficiency.risks[0] : null;
    if (risk) {
      body.appendChild(el('p', { cls: 'hint' }, `Top risk: ${risk.severity ?? 'low'} ${risk.id ?? 'unknown'}`));
    }
  }

  if (!prod) return body;

  // ── Scorecard row: proposals + judge verdicts ─────────────────────────────
  const scorecard = el('div', { cls: 'fd-prod-scorecard' });

  // Proposals 24h block
  const p24 = prod.proposals24h;
  const propBlock = el('div', { cls: 'fd-prod-block' });
  propBlock.appendChild(el('div', { cls: 'fd-prod-block__title' }, 'Proposals (24h)'));
  const propCounts = el('div', { cls: 'fd-prod-counts' });
  const addPropCount = (n, lbl, cls) => {
    propCounts.appendChild(el('div', { cls: 'fd-prod-count' },
      el('span', { cls: `fd-prod-count__num ${cls}` }, String(n)),
      el('span', { cls: 'fd-prod-count__lbl' }, lbl)
    ));
  };
  addPropCount(p24.applied, 'applied', 'fd-prod-count__num--ok');
  addPropCount(p24.pending, 'pending', p24.pending > 0 ? 'fd-prod-count__num--warn' : '');
  addPropCount(p24.rejected, 'rejected', p24.rejected > 0 ? 'fd-prod-count__num--fail' : '');
  propBlock.appendChild(propCounts);
  scorecard.appendChild(propBlock);

  // Judge verdicts 24h block
  const jv = prod.judgeVerdicts24h;
  const judgeBlock = el('div', { cls: 'fd-prod-block' });
  judgeBlock.appendChild(el('div', { cls: 'fd-prod-block__title' }, 'Judge verdicts (24h)'));
  const judgeCounts = el('div', { cls: 'fd-prod-counts' });
  const addJudgeCount = (n, lbl, cls) => {
    judgeCounts.appendChild(el('div', { cls: 'fd-prod-count' },
      el('span', { cls: `fd-prod-count__num ${cls}` }, String(n)),
      el('span', { cls: 'fd-prod-count__lbl' }, lbl)
    ));
  };
  addJudgeCount(jv.ship,    'ship',    'fd-prod-count__num--ok');
  addJudgeCount(jv.review,  'review',  jv.review > 0  ? 'fd-prod-count__num--warn' : '');
  addJudgeCount(jv.noise,   'noise',   'fd-prod-count__num--muted');
  addJudgeCount(jv.harmful, 'harmful', jv.harmful > 0 ? 'fd-prod-count__num--fail' : '');
  judgeBlock.appendChild(judgeCounts);
  scorecard.appendChild(judgeBlock);

  body.appendChild(scorecard);

  // ── Auto-merges today ─────────────────────────────────────────────────────
  const merges = prod.autoMergesToday;
  const mergeRow = el('div', { cls: 'fd-prod-merges' });
  const mergeCount = el('span', { cls: merges.count > 0 ? 'fd-prod-merge-count fd-prod-merge-count--active' : 'fd-prod-merge-count' },
    String(merges.count));
  mergeRow.appendChild(mergeCount);
  mergeRow.appendChild(el('span', { cls: 'fd-prod-merge-label' }, ' auto-merges today'));
  body.appendChild(mergeRow);

  if (merges.titles.length > 0) {
    const mergeList = el('ul', { cls: 'fd-prod-merge-list' });
    for (const title of merges.titles) {
      mergeList.appendChild(el('li', { cls: 'fd-prod-merge-item' }, title));
    }
    body.appendChild(mergeList);
  }

  // ── Active goals ─────────────────────────────────────────────────────────
  if (prod.activeGoals.length > 0) {
    body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Active goals'));
    const goalList = el('ul', { cls: 'fd-prod-goal-list' });
    for (const g of prod.activeGoals) {
      const pct = g.totalMilestones > 0
        ? Math.round((g.doneMilestones / g.totalMilestones) * 100)
        : 0;
      const msLabel = `${g.doneMilestones}/${g.totalMilestones} milestones`;
      const row = el('li', { cls: 'fd-prod-goal-row' });
      const trackWrap = el('div', { cls: 'fd-prod-goal-track-wrap' });
      trackWrap.appendChild(el('div', { cls: 'fd-prod-goal-track' },
        el('div', { cls: 'fd-prod-goal-fill', style: `width:${pct}%` })
      ));
      row.appendChild(el('div', { cls: 'fd-prod-goal-header' },
        el('span', { cls: 'fd-prod-goal-title', title: g.objective }, g.objective),
        el('span', { cls: 'fd-prod-goal-ms' }, msLabel)
      ));
      row.appendChild(trackWrap);
      goalList.appendChild(row);
    }
    body.appendChild(goalList);
  } else {
    body.appendChild(el('p', { cls: 'hint', style: 'margin-top:8px' }, 'No active goals.'));
  }

  // ── Ships-per-day trend sparkline ─────────────────────────────────────────
  if (prod.shipsPerDayTrend.length > 0) {
    body.appendChild(el('div', { cls: 'fd-prod-section-title', style: 'margin-top:12px' }, 'Ships / day (7d)'));
    const maxCount = Math.max(...prod.shipsPerDayTrend.map(d => d.count), 1);
    const spark = el('div', { cls: 'fd-prod-spark', role: 'img', 'aria-label': 'Ships per day sparkline' });
    for (const day of prod.shipsPerDayTrend) {
      const pct = Math.round((day.count / maxCount) * 100);
      const bar = el('div', { cls: 'fd-prod-spark-col', title: `${day.date}: ${day.count} ships` });
      bar.appendChild(el('div', {
        cls: day.count > 0 ? 'fd-prod-spark-bar fd-prod-spark-bar--active' : 'fd-prod-spark-bar',
        style: `height:${Math.max(pct, day.count > 0 ? 6 : 2)}%`,
      }));
      bar.appendChild(el('div', { cls: 'fd-prod-spark-label' },
        day.date.slice(5) // MM-DD
      ));
      spark.appendChild(bar);
    }
    body.appendChild(spark);
  }

  return body;
}

// ── M242: Intelligence panel ────────────────────────────────────────────────

function fdRenderIntelligencePanel(snap) {
  const intel = snap.intelligence;
  const body = el('div', { cls: 'fd-panel__body' });

  if (!intel) {
    body.appendChild(el('p', { cls: 'hint' }, 'Intelligence data unavailable.'));
    return body;
  }

  // ── Per-engine scorecards ─────────────────────────────────────────────────
  if (intel.engineScorecards && intel.engineScorecards.length > 0) {
    body.appendChild(el('div', { cls: 'fd-intel-section-title' }, 'Engine scorecards (24h)'));
    const table = el('div', { cls: 'fd-intel-engine-table' });
    // Header
    const hdr = el('div', { cls: 'fd-intel-engine-row fd-intel-engine-row--header' });
    for (const col of ['Engine', 'Ship', 'Review', 'Noise', 'Harmful', 'Rate']) {
      hdr.appendChild(el('span', { cls: 'fd-intel-engine-cell' }, col));
    }
    table.appendChild(hdr);
    for (const sc of intel.engineScorecards) {
      const ratePct = (sc.shipRate * 100).toFixed(0) + '%';
      const rateClass = sc.shipRate >= 0.7 ? 'fd-intel-rate--good'
                      : sc.shipRate >= 0.4 ? 'fd-intel-rate--ok'
                      : 'fd-intel-rate--warn';
      const row = el('div', { cls: 'fd-intel-engine-row' });
      row.appendChild(el('span', { cls: 'fd-intel-engine-cell fd-intel-engine-name' }, sc.engine));
      row.appendChild(el('span', { cls: 'fd-intel-engine-cell fd-intel-count--ok' }, String(sc.ship)));
      row.appendChild(el('span', { cls: 'fd-intel-engine-cell fd-intel-count--warn' }, String(sc.review)));
      row.appendChild(el('span', { cls: 'fd-intel-engine-cell fd-intel-count--muted' }, String(sc.noise)));
      row.appendChild(el('span', { cls: 'fd-intel-engine-cell fd-intel-count--fail' }, String(sc.harmful)));
      row.appendChild(el('span', { cls: `fd-intel-engine-cell fd-intel-rate ${rateClass}` }, ratePct));
      table.appendChild(row);
    }
    body.appendChild(table);
  }

  // ── M240: Learned routing scores ─────────────────────────────────────────
  if (intel.routingScores && intel.routingScores.length > 0) {
    body.appendChild(el('div', { cls: 'fd-intel-section-title', style: 'margin-top:14px' }, 'Learned routing (M240)'));
    const routeList = el('ul', { cls: 'fd-intel-route-list' });
    for (const rs of intel.routingScores.slice(0, 10)) {
      const trendColor = rs.trend === 'promoted' ? 'var(--status-done)'
                       : rs.trend === 'demoted'  ? 'var(--status-failed)'
                       : 'var(--text-muted)';
      const trendSymbol = rs.trend === 'promoted' ? '▲' : rs.trend === 'demoted' ? '▼' : '—';
      const scorePct = (rs.score * 100).toFixed(0) + '%';
      const modelPart = rs.model ? `:${rs.model}` : '';
      const label = `${rs.engine}${modelPart} / ${rs.taskClass}`;
      const row = el('li', { cls: 'fd-intel-route-row' },
        el('span', { cls: 'fd-intel-route-engine', title: label }, label),
        el('span', { cls: 'fd-intel-route-score' }, scorePct),
        el('span', { cls: 'fd-intel-route-trend', style: `color:${trendColor}` }, trendSymbol),
        rs.samples > 0
          ? el('span', { cls: 'fd-intel-route-samples' }, `${rs.samples.toFixed(1)}s`)
          : null
      );
      routeList.appendChild(row);
    }
    body.appendChild(routeList);
  } else {
    body.appendChild(el('p', { cls: 'hint', style: 'margin-top:8px' },
      'No routing data yet. Scores appear after 5+ judged decisions per engine.'));
  }

  // ── M235: Anti-playbook lessons ───────────────────────────────────────────
  body.appendChild(el('div', { cls: 'fd-intel-section-title', style: 'margin-top:14px' }, 'Anti-playbooks (M235)'));
  if (intel.antiPlaybooks && intel.antiPlaybooks.length > 0) {
    const apList = el('ul', { cls: 'fd-intel-ap-list' });
    for (const ap of intel.antiPlaybooks) {
      const item = el('li', { cls: 'fd-intel-ap-item' });
      item.appendChild(el('div', { cls: 'fd-intel-ap-title' }, ap.title));
      item.appendChild(el('div', { cls: 'fd-intel-ap-snippet' }, ap.snippet));
      item.appendChild(el('div', { cls: 'fd-intel-ap-ts' }, fmtRelative(ap.ts)));
      apList.appendChild(item);
    }
    body.appendChild(apList);
  } else {
    body.appendChild(el('p', { cls: 'hint' },
      'No anti-playbooks yet. Lessons appear when the judge rejects proposals.'));
  }

  // ── M241: Recent fleet events ─────────────────────────────────────────────
  if (intel.recentEvents && intel.recentEvents.length > 0) {
    body.appendChild(el('div', { cls: 'fd-intel-section-title', style: 'margin-top:14px' }, 'Fleet events (M241)'));
    const evList = el('ul', { cls: 'fd-intel-ev-list' });
    for (const ev of intel.recentEvents.slice(0, 10)) {
      const kindColor = ev.kind.startsWith('regression') ? 'var(--status-failed)'
                      : ev.kind.startsWith('merge')      ? 'var(--status-done)'
                      : ev.kind.startsWith('goal')       ? 'var(--accent)'
                      : 'var(--text-muted)';
      evList.appendChild(el('li', { cls: 'fd-intel-ev-row' },
        el('span', { cls: 'fd-intel-ev-kind', style: `color:${kindColor}` }, ev.kind),
        el('span', { cls: 'fd-intel-ev-detail', title: ev.detail }, ev.detail || '—'),
        el('span', { cls: 'fd-intel-ev-ts' }, fmtRelative(ev.ts))
      ));
    }
    body.appendChild(evList);
  }

  // ── M246: Telemetry truth — cache hit rate + tokens by tier ──────────────
  if (typeof intel.cacheHitRate === 'number' || intel.tokensByTier) {
    body.appendChild(el('div', { cls: 'fd-intel-section-title', style: 'margin-top:14px' }, 'Telemetry (M246)'));
    const telRow = el('div', { cls: 'fd-intel-telemetry-row' });
    if (typeof intel.cacheHitRate === 'number') {
      const ratePct = (intel.cacheHitRate * 100).toFixed(1) + '%';
      const rateClass = intel.cacheHitRate >= 0.5 ? 'fd-intel-rate--good'
                      : intel.cacheHitRate >= 0.2 ? 'fd-intel-rate--ok'
                      : 'fd-intel-rate--warn';
      telRow.appendChild(el('span', { cls: 'fd-intel-telemetry-item' },
        'Cache hit rate: ',
        el('span', { cls: rateClass }, ratePct)
      ));
    }
    if (intel.tokensByTier) {
      const t = intel.tokensByTier;
      const total = (t.frontier || 0) + (t.mid || 0) + (t.local || 0);
      const fmt = (n) => total > 0 ? ((n / total) * 100).toFixed(0) + '%' : '—';
      telRow.appendChild(el('span', { cls: 'fd-intel-telemetry-item', style: 'margin-left:16px' },
        'Tokens by tier: ',
        el('span', { cls: 'fd-intel-count--fail' }, 'frontier ' + fmt(t.frontier || 0)),
        el('span', {}, ' / '),
        el('span', { cls: 'fd-intel-count--warn' }, 'mid ' + fmt(t.mid || 0)),
        el('span', {}, ' / '),
        el('span', { cls: 'fd-intel-count--ok' }, 'local ' + fmt(t.local || 0))
      ));
    }
    body.appendChild(telRow);
  }

  return body;
}

// ── M262: Visibility panel ─────────────────────────────────────────────────

function fdAvailabilityState(availability) {
  if (availability === 'open') return 'active';
  if (availability === 'near' || availability === 'throttled') return 'near';
  if (availability === 'exhausted') return 'exhausted';
  return 'unknown';
}

function fdFmtFuture(iso) {
  if (!iso) return null;
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return 'reset due';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round((mins / 60) * 10) / 10;
    return `${hrs}h`;
  } catch {
    return null;
  }
}

function fdRenderVisibilityPanel(snap) {
  const vis = snap.visibility;
  const body = el('div', { cls: 'fd-panel__body' });

  if (!vis) {
    body.appendChild(el('p', { cls: 'hint' }, 'Visibility data unavailable.'));
    return body;
  }

  const activity = vis.fleetActivity ?? {};
  const savings = vis.costSavings ?? {};

  const scorecard = el('div', { cls: 'fd-prod-scorecard' });
  const activityBlock = el('div', { cls: 'fd-prod-block' });
  activityBlock.appendChild(el('div', { cls: 'fd-prod-block__title' }, 'Activity (24h)'));
  const activityCounts = el('div', { cls: 'fd-prod-counts' });
  const addActivityCount = (n, lbl, cls) => {
    activityCounts.appendChild(el('div', { cls: 'fd-prod-count' },
      el('span', { cls: `fd-prod-count__num ${cls}` }, String(n ?? 0)),
      el('span', { cls: 'fd-prod-count__lbl' }, lbl)
    ));
  };
  addActivityCount(activity.totalDispatches, 'dispatches', 'fd-prod-count__num--muted');
  addActivityCount(activity.mergedToday, 'merged', 'fd-prod-count__num--ok');
  addActivityCount(activity.proposalsPending, 'pending', activity.proposalsPending > 0 ? 'fd-prod-count__num--warn' : '');
  addActivityCount(activity.queueBacklog, 'queued', activity.queueBacklog > 0 ? 'fd-prod-count__num--warn' : '');
  activityBlock.appendChild(activityCounts);
  scorecard.appendChild(activityBlock);

  const savingsBlock = el('div', { cls: 'fd-prod-block' });
  savingsBlock.appendChild(el('div', { cls: 'fd-prod-block__title' }, 'Cost & Savings'));
  const savingsCounts = el('div', { cls: 'fd-prod-counts' });
  const addSavingsCount = (value, lbl, cls) => {
    savingsCounts.appendChild(el('div', { cls: 'fd-prod-count' },
      el('span', { cls: `fd-prod-count__num ${cls}` }, value),
      el('span', { cls: 'fd-prod-count__lbl' }, lbl)
    ));
  };
  addSavingsCount(`$${fmt(savings.todaySpendUsd ?? 0, 2)}`, 'today', 'fd-prod-count__num--warn');
  addSavingsCount(`$${fmt(savings.routingSavedUsd ?? 0, 2)}`, 'routed', 'fd-prod-count__num--ok');
  addSavingsCount(`${Math.round((savings.cacheHitRate ?? 0) * 100)}%`, 'cache', 'fd-prod-count__num--muted');
  savingsBlock.appendChild(savingsCounts);
  scorecard.appendChild(savingsBlock);
  body.appendChild(scorecard);

  const resourceGrid = Array.isArray(vis.resourceGrid) ? vis.resourceGrid : [];
  body.appendChild(el('div', { cls: 'fd-prod-section-title' }, 'Resources'));
  if (resourceGrid.length === 0) {
    body.appendChild(el('p', { cls: 'hint' }, 'No resource data yet.'));
  } else {
    for (const backend of resourceGrid.slice(0, 6)) {
      const stateKey = fdAvailabilityState(backend.availability);
      const pct = typeof backend.usedPct === 'number'
        ? Math.min(100, Math.max(0, backend.usedPct))
        : null;
      const row = el('div', { cls: 'fd-usage-engine' });
      row.appendChild(el('div', { cls: 'fd-usage-engine-header' },
        el('span', { cls: 'fd-usage-engine-name' }, backend.backend ?? 'unknown'),
        el('span', { cls: `fd-usage-engine-state fd-usage-engine-state--${stateKey}` }, backend.availability ?? 'unknown')
      ));
      const track = el('div', { cls: 'fd-usage-bar-track' });
      track.appendChild(el('div', {
        cls: `fd-usage-bar-fill fd-usage-bar-fill--${stateKey}`,
        style: `width:${pct == null ? 2 : pct.toFixed(1)}%`,
        role: 'progressbar',
        'aria-valuenow': pct == null ? '0' : String(Math.round(pct)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': `${backend.backend ?? 'backend'} availability ${backend.availability ?? 'unknown'}`,
      }));
      row.appendChild(track);

      const meta = el('div', { cls: 'fd-usage-engine-meta' });
      const addMeta = (label, value) => {
        if (value == null || value === '') return;
        meta.appendChild(el('span', { cls: 'fd-usage-meta-item' },
          el('strong', {}, String(value)), ` ${label}`
        ));
      };
      addMeta('used', pct == null ? '?%' : `${Math.round(pct)}%`);
      addMeta('latency', backend.p50LatencyMs != null ? `${backend.p50LatencyMs}ms` : null);
      addMeta('cost/M', backend.costPerMTokenOut > 0 ? `$${backend.costPerMTokenOut}` : '$0');
      addMeta('resets', fdFmtFuture(backend.resetsAt));
      row.appendChild(meta);
      body.appendChild(row);
    }
  }

  const director = vis.director ?? {};
  body.appendChild(el('div', { cls: 'fd-prod-section-title', style: 'margin-top:12px' }, 'Director'));
  const directorGrid = el('div', { cls: 'fd-meta-grid' });
  const mkMeta = (key, val, cls) => el('div', { cls: 'fd-meta-item' },
    el('div', { cls: 'fd-meta-key' }, key),
    el('div', { cls: cls ? `fd-meta-val ${cls}` : 'fd-meta-val' }, val ?? '—')
  );
  const escalationCls = (director.escalationCount ?? 0) > 0 ? 'fd-meta-val--warn' : 'fd-meta-val--ok';
  directorGrid.appendChild(mkMeta('Posture', director.resourcePosture ?? 'unknown'));
  directorGrid.appendChild(mkMeta('Escalations', String(director.escalationCount ?? 0), escalationCls));
  directorGrid.appendChild(mkMeta('Focus', director.topGoalObjective ?? '—'));
  directorGrid.appendChild(mkMeta('Last run', director.lastRunAt ? fmtRelative(director.lastRunAt) : '—'));
  body.appendChild(directorGrid);

  return body;
}

// ── Settings modal ──────────────────────────────────────────────────────────

function fdOpenSettings() {
  const settings = fdLoadSettings();
  const draftSettings = {
    panels: Object.assign({}, settings.panels),
    refreshSecs: settings.refreshSecs,
    theme: settings.theme,
  };

  const overlay = el('div', { cls: 'fd-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fleet Dashboard settings' });
  const modal = el('div', { cls: 'fd-modal' });

  // Title
  modal.appendChild(el('div', { cls: 'fd-modal__title' }, 'Fleet Dashboard Settings'));

  // Panel visibility
  const panelSection = el('div', { cls: 'fd-modal__section' });
  panelSection.appendChild(el('div', { cls: 'fd-modal__section-label' }, 'Panels'));
  const PANEL_LABELS = { status: 'Fleet Status', running: "What's Running", usage: 'Frontier Usage/Limits', activity: 'Recent Activity', production: 'Production', intelligence: 'Fleet Intelligence', visibility: 'Visibility' };
  for (const [key, label] of Object.entries(PANEL_LABELS)) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = draftSettings.panels[key] !== false;
    cb.addEventListener('change', () => { draftSettings.panels[key] = cb.checked; });
    panelSection.appendChild(el('label', { cls: 'fd-modal__check-row' }, cb, label));
  }
  modal.appendChild(panelSection);

  // Refresh interval
  const refreshSection = el('div', { cls: 'fd-modal__section' });
  refreshSection.appendChild(el('div', { cls: 'fd-modal__section-label' }, 'Auto-refresh'));
  const refreshGroup = el('div', { cls: 'fd-modal__radio-group' });
  for (const secs of [10, 15, 30, 60]) {
    const btn = el('button', {
      cls: draftSettings.refreshSecs === secs ? 'fd-modal__radio-btn fd-modal__radio-btn--active' : 'fd-modal__radio-btn',
      type: 'button',
    }, `${secs}s`);
    btn.addEventListener('click', () => {
      draftSettings.refreshSecs = secs;
      refreshGroup.querySelectorAll('.fd-modal__radio-btn').forEach(b => b.classList.remove('fd-modal__radio-btn--active'));
      btn.classList.add('fd-modal__radio-btn--active');
    });
    refreshGroup.appendChild(btn);
  }
  refreshSection.appendChild(refreshGroup);
  modal.appendChild(refreshSection);

  // Theme
  const themeSection = el('div', { cls: 'fd-modal__section' });
  themeSection.appendChild(el('div', { cls: 'fd-modal__section-label' }, 'Theme'));
  const themeGroup = el('div', { cls: 'fd-modal__radio-group' });
  for (const t of ['dark', 'light']) {
    const btn = el('button', {
      cls: draftSettings.theme === t ? 'fd-modal__radio-btn fd-modal__radio-btn--active' : 'fd-modal__radio-btn',
      type: 'button',
    }, t.charAt(0).toUpperCase() + t.slice(1));
    btn.addEventListener('click', () => {
      draftSettings.theme = t;
      themeGroup.querySelectorAll('.fd-modal__radio-btn').forEach(b => b.classList.remove('fd-modal__radio-btn--active'));
      btn.classList.add('fd-modal__radio-btn--active');
    });
    themeGroup.appendChild(btn);
  }
  themeSection.appendChild(themeGroup);
  modal.appendChild(themeSection);

  // Footer buttons
  const cancelBtn = el('button', { cls: 'fd-modal__btn', type: 'button' }, 'Cancel');
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = el('button', { cls: 'fd-modal__btn fd-modal__btn--primary', type: 'button' }, 'Save');
  saveBtn.addEventListener('click', () => {
    fdSaveSettings(draftSettings);
    fdApplyTheme(draftSettings.theme);
    overlay.remove();
    // Restart interval with new refresh period
    if (state.fleetDashboardInterval) {
      clearInterval(state.fleetDashboardInterval);
      state.fleetDashboardInterval = null;
    }
    renderFleetDashboard();
    // Trigger new interval via a reload
    loadFleetDashboard();
  });

  modal.appendChild(el('div', { cls: 'fd-modal__footer' }, cancelBtn, saveBtn));
  overlay.appendChild(modal);

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Close on Escape
  const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  saveBtn.focus();
}

// ── Main render ─────────────────────────────────────────────────────────────

function renderFleetDashboard() {
  if (state.activeView !== 'fleet-dashboard') return;
  const main = getMain();
  if (!main) return;
  const _scrollY = window.scrollY;
  main.innerHTML = '';

  const settings = fdLoadSettings();
  fdApplyTheme(settings.theme);

  const snap = state.fleetDashboard;
  const section = el('section', { cls: 'view-section' });
  const isKilled = snap?.fleet?.killed ?? snap?.control?.fleet?.killed ?? false;

  // Header row with title, last-updated, and settings button
  const settingsBtn = el('button', { cls: 'fd-settings-btn', type: 'button', 'aria-label': 'Dashboard settings' });
  settingsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.22 3.22l1.06 1.06M11.72 11.72l1.06 1.06M12.78 3.22l-1.06 1.06M4.28 11.72l-1.06 1.06" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Settings';
  settingsBtn.addEventListener('click', fdOpenSettings);

  const lastUpdated = snap ? `Updated ${fmtRelative(snap.generatedAt)}` : 'Loading…';
  section.appendChild(el('div', { cls: 'fd-header-row' },
    el('div', {},
      el('span', { cls: 'fd-header-title' }, 'Fleet Dashboard'),
      el('span', { cls: 'fd-header-meta', style: 'margin-left:12px' }, lastUpdated)
    ),
    el('div', { cls: 'fd-header-right' },
      el('span', { cls: 'fd-hidden-hint', id: 'fd-hidden-hint', style: 'display:none' }, ''),
      snap ? fleetPauseResumeButton(isKilled, 'btn-sm') : null,
      settingsBtn
    )
  ));

  if (!snap) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'Loading fleet data…')
    ));
    main.appendChild(section);
    return;
  }

  // Count hidden panels for the hint
  const panelDefs = [
    { key: 'status',       title: 'Fleet Status',         render: () => fdRenderStatusPanel(snap) },
    { key: 'running',      title: "What's Running",        render: () => fdRenderRunningPanel(snap) },
    { key: 'usage',        title: 'Frontier Usage/Limits', render: () => fdRenderUsagePanel(snap) },
    { key: 'activity',     title: 'Recent Activity',       render: () => fdRenderActivityPanel(snap) },
    { key: 'production',   title: 'Production',            render: () => fdRenderProductionPanel(snap) },
    { key: 'intelligence', title: 'Fleet Intelligence',    render: () => fdRenderIntelligencePanel(snap) },
    { key: 'visibility',   title: 'Visibility',            render: () => fdRenderVisibilityPanel(snap) },
  ];

  const hiddenCount = panelDefs.filter(p => settings.panels[p.key] === false).length;
  const hintEl = section.querySelector('#fd-hidden-hint');
  if (hintEl) {
    if (hiddenCount > 0) {
      hintEl.textContent = `${hiddenCount} panel${hiddenCount > 1 ? 's' : ''} hidden`;
      hintEl.style.display = '';
    } else {
      hintEl.style.display = 'none';
    }
  }

  const grid = el('div', { cls: 'fleet-dashboard-grid', role: 'region', 'aria-label': 'Fleet panels' });

  for (const pd of panelDefs) {
    const isVisible = settings.panels[pd.key] !== false;
    const panel = el('div', { cls: isVisible ? 'fd-panel' : 'fd-panel fd-panel--hidden', 'aria-label': pd.title });
    if (isVisible) {
      panel.appendChild(el('div', { cls: 'fd-panel__header' },
        el('span', { cls: 'fd-panel__title' }, pd.title)
      ));
      panel.appendChild(pd.render());
    }
    grid.appendChild(panel);
  }

  section.appendChild(grid);
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
