/**
 * app.js — ashlr-hub local web dashboard SPA
 *
 * Vanilla JS, no framework, no CDN, no external deps.
 * Runs entirely in the browser against the local API served by startServer().
 *
 * Views (hash-routed):
 *   #overview  — DashboardSnapshot cards
 *   #runs      — RunState table
 *   #swarms    — SwarmRun list + DAG graph + live burndown
 *   #pulse     — ActivityRollup SVG bar charts
 *   #genome    — GenomeEntry search + list
 *
 * Live updates via EventSource('/api/events') — patches runs + swarms views.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIEWS = ['overview', 'runs', 'swarms', 'pulse', 'genome'];
const DEFAULT_VIEW = 'overview';
const API_BASE = '';  // same origin

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
  loading: {},   // viewName -> boolean
  error: {},     // viewName -> string | null
  activeView: DEFAULT_VIEW,
  eventSource: null,
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
    es.addEventListener('error', () => {
      // Silently tolerate — browser will auto-reconnect or server is stopping
    });
  } catch {
    // EventSource not available or server not yet up — silent
  }
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
  if (view === 'overview') renderOverview();
  else if (view === 'runs') renderRuns();
  else if (view === 'swarms') renderSwarms();
  else if (view === 'pulse') renderPulse();
  else if (view === 'genome') renderGenome();
}

async function loadView(view) {
  if (view === 'overview') await loadOverview();
  else if (view === 'runs') await loadRuns();
  else if (view === 'swarms') await loadSwarms();
  else if (view === 'pulse') await loadPulse();
  else if (view === 'genome') await loadGenome();
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

  // Top nav
  const nav = el('nav', { cls: 'topnav' },
    el('div', { cls: 'nav-brand' },
      el('span', { cls: 'brand-icon' }, '⬡'),
      el('span', { cls: 'brand-name' }, 'ashlr hub')
    ),
    el('div', { cls: 'nav-links' },
      ...VIEWS.map((v) => {
        const a = el('a', { cls: 'nav-link', href: `#${v}`, 'data-view': v }, v);
        return a;
      })
    ),
    el('div', { cls: 'nav-status' },
      el('span', { cls: 'sse-dot', id: 'sse-dot', title: 'Live stream' })
    )
  );

  const main = el('main', { cls: 'main', id: 'main' });
  document.body.appendChild(nav);
  document.body.appendChild(main);
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

  if (state.runs.length === 0) {
    section.appendChild(el('div', { cls: 'empty-state' },
      el('p', {}, 'No runs recorded yet.'),
      el('p', { cls: 'hint' }, 'Run `ashlr run "your goal"` to start one.')
    ));
  } else {
    section.appendChild(buildRunsTable(state.runs, true));
  }

  main.appendChild(section);
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
});
