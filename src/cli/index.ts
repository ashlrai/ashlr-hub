#!/usr/bin/env node
/**
 * ashlr CLI — main entry point.
 *
 * Commands:
 *   index [--refresh]          Rebuild the desktop index; print counts by category.
 *   go [query] [--open|--cd]   Find an item; open in editor, cd, or just print.
 *   status                     Attention board: dirty/stale repos, aligned table.
 *   ls [category]              List all indexed items, optionally filtered.
 *   open [query]               Open best match in editor; no query → picker.
 *   tidy [--apply] [--json]    Plan (dry-run) or apply tidy moves; --json emits machine output.
 *   config [get|set|path]      Read/write config values.
 *   doctor                     One-glance health check (config, phantom, providers).
 *   init [--yes]               Idempotent onboarding; NON-TTY safe with --yes.
 *   mcp [list|doctor|install]  MCP aggregation gateway and registry management.
 *   run "<goal>" [opts]        Local-first agent orchestrator; decompose & execute a goal.
 *   run show <id>              Print a past run in detail.
 *   runs [--json]              List past runs.
 *   pulse [--json] [--window]  Local observability dashboard: tokens, cost, activity.
 *   new <name> [opts]          Scaffold a new project and register it in the index.
 *   ship [path] [opts]         Run pre-ship gate (lint/test/build/deps) + optional deploy.
 *   help                       Show this help.
 *
 * Exit codes: 0 success, 1 error/not-found, 2 bad usage.
 */

import { loadConfig, saveConfig, CONFIG_PATH } from '../core/config.js';
import { buildIndex, loadIndex, writeIndex } from '../core/index-engine.js';
import { planTidy, applyTidy } from '../core/tidy.js';
import { openInEditor } from './open.js';
import { pick } from './picker.js';
import { cmdDoctor, cmdInit } from './doctor-init.js';
import type { AshlrConfig, AshlrIndex, IndexedItem, GitStatus, ToolsRegistry, McpRegistry } from '../core/types.js';

// ─── M3 lazy imports (graceful degradation if modules not yet built) ──────────

type CmdMcpFn = (args: string[]) => Promise<number>;
type GetToolsRegistryFn = () => ToolsRegistry;
type DiscoverMcpServersFn = () => McpRegistry;

// Cache slots — undefined = not yet attempted; null = attempted & failed
let _cmdMcp: CmdMcpFn | null | undefined = undefined;
let _getToolsRegistry: GetToolsRegistryFn | null | undefined = undefined;
let _discoverMcpServers: DiscoverMcpServersFn | null | undefined = undefined;

async function loadMcpCmd(): Promise<CmdMcpFn> {
  if (_cmdMcp === undefined) {
    try {
      const mod = await import('./mcp.js') as { cmdMcp: CmdMcpFn };
      _cmdMcp = mod.cmdMcp;
    } catch {
      _cmdMcp = null;
    }
  }
  if (_cmdMcp === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'mcp command requires src/cli/mcp.ts (M3 module not yet built).');
      return 1;
    };
  }
  return _cmdMcp;
}

async function tryGetToolsRegistry(): Promise<GetToolsRegistryFn | null> {
  if (_getToolsRegistry === undefined) {
    try {
      const mod = await import('../core/tools-registry.js') as { getToolsRegistry: GetToolsRegistryFn };
      _getToolsRegistry = mod.getToolsRegistry;
    } catch {
      _getToolsRegistry = null;
    }
  }
  return _getToolsRegistry ?? null;
}

async function tryDiscoverMcpServers(): Promise<DiscoverMcpServersFn | null> {
  if (_discoverMcpServers === undefined) {
    try {
      const mod = await import('../core/mcp-registry.js') as { discoverMcpServers: DiscoverMcpServersFn };
      _discoverMcpServers = mod.discoverMcpServers;
    } catch {
      _discoverMcpServers = null;
    }
  }
  return _discoverMcpServers ?? null;
}

// ─── M4 lazy imports (graceful degradation if modules not yet built) ──────────

type CmdRunFn  = (args: string[]) => Promise<number>;
type CmdRunsFn = (args: string[]) => Promise<number>;

let _cmdRun:  CmdRunFn  | null | undefined = undefined;
let _cmdRuns: CmdRunsFn | null | undefined = undefined;

async function loadRunCmd(): Promise<CmdRunFn> {
  if (_cmdRun === undefined) {
    try {
      const mod = (await import('./run.js' as unknown as string)) as { cmdRun: CmdRunFn };
      _cmdRun = mod.cmdRun;
    } catch {
      _cmdRun = null;
    }
  }
  if (_cmdRun === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'run command requires src/cli/run.ts (M4 module not yet built).');
      return 1;
    };
  }
  return _cmdRun;
}

async function loadRunsCmd(): Promise<CmdRunsFn> {
  if (_cmdRuns === undefined) {
    try {
      const mod = (await import('./run.js' as unknown as string)) as { cmdRuns: CmdRunsFn };
      _cmdRuns = mod.cmdRuns;
    } catch {
      _cmdRuns = null;
    }
  }
  if (_cmdRuns === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'runs command requires src/cli/run.ts (M4 module not yet built).');
      return 1;
    };
  }
  return _cmdRuns;
}

// ─── M5 lazy imports (graceful degradation if modules not yet built) ──────────

type CmdPulseFn = (args: string[]) => Promise<number>;
import type { ActivityRollup } from '../core/types.js';
type BuildRollupFn = (window: '1d' | '7d' | '30d', cfg: AshlrConfig, opts?: { project?: string }) => ActivityRollup;

let _cmdPulse: CmdPulseFn | null | undefined = undefined;
let _buildRollup: BuildRollupFn | null | undefined = undefined;

async function loadPulseCmd(): Promise<CmdPulseFn> {
  if (_cmdPulse === undefined) {
    try {
      const mod = (await import('./pulse.js' as unknown as string)) as { cmdPulse: CmdPulseFn };
      _cmdPulse = mod.cmdPulse;
    } catch {
      _cmdPulse = null;
    }
  }
  if (_cmdPulse === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'pulse command requires src/cli/pulse.ts (M5 module not yet built).');
      return 1;
    };
  }
  return _cmdPulse;
}

async function tryBuildRollup(): Promise<BuildRollupFn | null> {
  if (_buildRollup === undefined) {
    try {
      const mod = (await import('../core/observability/rollup.js' as unknown as string)) as { buildRollup: BuildRollupFn };
      _buildRollup = mod.buildRollup;
    } catch {
      _buildRollup = null;
    }
  }
  return _buildRollup ?? null;
}

// ─── M6 lazy imports (graceful degradation if modules not yet built) ──────────

type CmdNewFn  = (args: string[]) => Promise<number>;
type CmdShipFn = (args: string[]) => Promise<number>;

let _cmdNew:  CmdNewFn  | null | undefined = undefined;
let _cmdShip: CmdShipFn | null | undefined = undefined;

async function loadNewCmd(): Promise<CmdNewFn> {
  if (_cmdNew === undefined) {
    try {
      const mod = (await import('./new.js' as unknown as string)) as { cmdNew: CmdNewFn };
      _cmdNew = mod.cmdNew;
    } catch {
      _cmdNew = null;
    }
  }
  if (_cmdNew === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'new command requires src/cli/new.ts (M6 module not yet built).');
      return 1;
    };
  }
  return _cmdNew;
}

async function loadShipCmd(): Promise<CmdShipFn> {
  if (_cmdShip === undefined) {
    try {
      const mod = (await import('./ship.js' as unknown as string)) as { cmdShip: CmdShipFn };
      _cmdShip = mod.cmdShip;
    } catch {
      _cmdShip = null;
    }
  }
  if (_cmdShip === null) {
    return async (_args: string[]) => {
      console.error(red('error: ') + 'ship command requires src/cli/ship.ts (M6 module not yet built).');
      return 1;
    };
  }
  return _cmdShip;
}

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
};

function bold(s: string): string    { return `${C.bold}${s}${C.reset}`; }
function dim(s: string): string     { return `${C.dim}${s}${C.reset}`; }
function red(s: string): string     { return `${C.red}${s}${C.reset}`; }
function yellow(s: string): string  { return `${C.yellow}${s}${C.reset}`; }
function green(s: string): string   { return `${C.green}${s}${C.reset}`; }
function cyan(s: string): string    { return `${C.cyan}${s}${C.reset}`; }
function gray(s: string): string    { return `${C.gray}${s}${C.reset}`; }
function magenta(s: string): string { return `${C.magenta}${s}${C.reset}`; }

/** Strip ANSI escape codes to measure display width. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences legitimately contain the ESC control char.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pad a string (which may contain ANSI codes) to a visible width. */
function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const visible = stripAnsi(s).length;
  const spaces = Math.max(0, width - visible);
  return align === 'left' ? s + ' '.repeat(spaces) : ' '.repeat(spaces) + s;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  console.error(red('error: ') + msg);
  process.exit(code);
}


/** Ensure the index exists; auto-build if missing. Returns the index. */
function requireIndex(cfg: AshlrConfig): AshlrIndex {
  let idx = loadIndex();
  if (!idx) {
    // Informational chatter goes to stderr so stdout stays clean for capture
    // (e.g. `cd $(ashlr go foo --cd)`).
    console.error(dim('No index found — building now…'));
    idx = buildIndex(cfg);
    writeIndex(idx);
  }
  return idx;
}

/** Score an item against a query string (higher = better match). */
function scoreItem(item: IndexedItem, query: string): number {
  const q = query.toLowerCase();
  const name = item.name.toLowerCase();
  const cat = (item.category ?? '').toLowerCase();
  const desc = (item.description ?? '').toLowerCase();
  // Exact name match
  if (name === q) return 100;
  // Name starts with query
  if (name.startsWith(q)) return 80;
  // Name contains query
  if (name.includes(q)) return 60;
  // Category + name
  if (cat.includes(q)) return 40;
  // Description
  if (desc.includes(q)) return 20;
  return 0;
}

/** Filter and rank items by query. Returns sorted descending by score. */
function filterItems(items: IndexedItem[], query: string): IndexedItem[] {
  if (!query.trim()) return items;
  return items
    .map(item => ({ item, score: scoreItem(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

/** Days since a date string. */
function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

/** Format a short relative time. */
function relativeTime(iso: string | null): string {
  if (!iso) return gray('—');
  const days = daysSince(iso);
  if (days < 1) return green('today');
  if (days < 2) return green('yesterday');
  if (days < 7) return green(`${Math.floor(days)}d ago`);
  if (days < 30) return yellow(`${Math.floor(days)}d ago`);
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return red(`${Math.floor(days / 365)}y ago`);
}

/** Get a nested config value by dot-path key. */
function getConfigValue(cfg: AshlrConfig, key: string): unknown {
  const parts = key.split('.');
  let val: unknown = cfg;
  for (const part of parts) {
    if (val === null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[part];
  }
  return val;
}

/**
 * True when a config dot-path leaf looks sensitive (token/key/secret/etc).
 * Used to redact values in `config get`/`config set` output so a manually
 * stashed credential never lands in terminal scrollback or shell history.
 */
const SENSITIVE_KEY_RE = /token|key|secret|password|passwd|auth|credential|api[_-]?key/i;
function isSensitiveKey(key: string): boolean {
  const leaf = key.split('.').pop() ?? key;
  return SENSITIVE_KEY_RE.test(leaf);
}

/** Set a nested config value by dot-path key (mutates cfg). */
function setConfigValue(cfg: AshlrConfig, key: string, rawValue: string): void {
  const parts = key.split('.');
  let obj: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = obj[parts[i]];
    if (next === null || typeof next !== 'object') {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  // Coerce to number or boolean when applicable
  if (rawValue === 'true') { obj[last] = true; return; }
  if (rawValue === 'false') { obj[last] = false; return; }
  const num = Number(rawValue);
  if (!isNaN(num) && rawValue.trim() !== '') { obj[last] = num; return; }
  obj[last] = rawValue;
}

// ─── Command: index ───────────────────────────────────────────────────────────

function cmdIndex(args: string[]): void {
  const refresh = args.includes('--refresh');
  const cfg = loadConfig();

  let idx = loadIndex();
  if (!idx || refresh) {
    if (refresh && idx) {
      console.error(dim('Refreshing index…'));
    } else {
      console.error(dim('Building index…'));
    }
    idx = buildIndex(cfg);
    writeIndex(idx);
  }

  const { items } = idx;

  // Count by category
  const byCat = new Map<string, number>();
  for (const item of items) {
    const cat = item.category ?? '(uncategorized)';
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
  }

  const sortedCats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(...sortedCats.map(([c]) => c.length), 12);

  console.log('');
  console.log(bold('  ashlr index') + gray(` — ${items.length} items, built ${new Date(idx.generatedAt).toLocaleString()}`));
  console.log('');
  console.log(`  ${bold(pad('Category', maxCat))}  ${bold(pad('Items', 6, 'right'))}`);
  console.log(`  ${'─'.repeat(maxCat)}  ${'─'.repeat(6)}`);

  for (const [cat, count] of sortedCats) {
    console.log(`  ${cyan(pad(cat, maxCat))}  ${pad(String(count), 6, 'right')}`);
  }

  console.log('');
  console.log(`  ${bold('Total:')} ${items.length} items across ${byCat.size} categories`);

  const repos = items.filter(i => i.kind === 'repo');
  const active = repos.filter(i => i.active);
  console.log(`  ${dim(`${repos.length} repos (${active.length} active)`)}`);
  console.log('');
}

// ─── Command: go ─────────────────────────────────────────────────────────────

async function cmdGo(args: string[]): Promise<void> {
  const openFlag = args.includes('--open');
  const cdFlag   = args.includes('--cd');
  const queryArgs = args.filter(a => !a.startsWith('--'));
  const query = queryArgs.join(' ');

  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  const candidates = filterItems(idx.items, query);

  let chosen: IndexedItem | null = null;

  if (candidates.length === 0 && query) {
    die(`No items match "${query}".`);
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // Let user pick (fzf or readline)
    chosen = await pick(candidates.length > 0 ? candidates : idx.items);
  }

  if (!chosen) {
    die('Nothing selected.', 1);
  }

  if (openFlag) {
    openInEditor(chosen.path, cfg);
    console.log(green('opened: ') + chosen.path);
  } else if (cdFlag) {
    // Print path only — caller shell function can eval $(ashlr go ... --cd)
    process.stdout.write(chosen.path + '\n');
  } else {
    // Print a summary
    printItemSummary(chosen);
  }
}

function printItemSummary(item: IndexedItem): void {
  console.log('');
  console.log(`  ${bold(item.name)}  ${dim(item.kind)}  ${item.category ? cyan(item.category) : ''}`);
  console.log(`  ${gray(item.path)}`);
  if (item.description) {
    console.log(`  ${item.description}`);
  }
  if (item.git) {
    const g = item.git;
    const dirtyStr = g.dirty > 0 ? red(`${g.dirty} dirty`) : green('clean');
    const syncStr  = g.ahead > 0 || g.behind > 0
      ? yellow(`↑${g.ahead} ↓${g.behind}`)
      : green('in sync');
    console.log(`  git: ${cyan(g.branch)}  ${dirtyStr}  ${syncStr}  last commit: ${relativeTime(g.lastCommit)}`);
  }
  if (item.linkTarget) {
    console.log(`  ${dim('→')} ${item.linkTarget}`);
  }
  console.log(`  last modified: ${relativeTime(item.lastModified)}`);
  console.log('');
}

// ─── Command: status ─────────────────────────────────────────────────────────

async function cmdStatus(_args: string[]): Promise<void> {
  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  const repos = idx.items.filter(i => i.kind === 'repo' && i.git);

  const dirty   = repos.filter(i => (i.git?.dirty ?? 0) > 0);
  const offSync  = repos.filter(i => !dirty.includes(i) && ((i.git?.ahead ?? 0) > 0 || (i.git?.behind ?? 0) > 0));
  const stale   = repos.filter(i =>
    !dirty.includes(i) &&
    !offSync.includes(i) &&
    daysSince(i.lastModified) > cfg.staleDays
  );

  const nameW  = 30;
  const branchW = 18;
  const gitW   = 16;
  const timeW  = 14;

  function printRepoTable(items: IndexedItem[]): void {
    if (items.length === 0) {
      console.log(`  ${dim('(none)')}`);
      return;
    }
    console.log(
      `  ${bold(pad('Repo', nameW))}  ` +
      `${bold(pad('Branch', branchW))}  ` +
      `${bold(pad('Git', gitW))}  ` +
      `${bold(pad('Last commit', timeW))}`
    );
    console.log(
      `  ${'─'.repeat(nameW)}  ${'─'.repeat(branchW)}  ${'─'.repeat(gitW)}  ${'─'.repeat(timeW)}`
    );
    for (const item of items) {
      const g = item.git as GitStatus;
      const dirtyStr = g.dirty > 0
        ? red(`${g.dirty}`)
        : '';
      const syncStr  = g.ahead > 0 || g.behind > 0
        ? yellow(`↑${g.ahead} ↓${g.behind}`)
        : '';
      const gitCol = [dirtyStr, syncStr].filter(Boolean).join('  ') || green('ok');
      console.log(
        `  ${pad(cyan(item.name), nameW)}  ` +
        `${pad(g.branch, branchW)}  ` +
        `${pad(gitCol, gitW)}  ` +
        `${relativeTime(g.lastCommit)}`
      );
    }
  }

  console.log('');
  console.log(bold('  ashlr status') + gray(` — ${repos.length} repos tracked`));
  console.log('');

  if (dirty.length > 0) {
    console.log(bold(red(`  Dirty (${dirty.length})`)));
    printRepoTable(dirty);
    console.log('');
  }

  if (offSync.length > 0) {
    console.log(bold(yellow(`  Off-sync (${offSync.length})`)));
    printRepoTable(offSync);
    console.log('');
  }

  if (stale.length > 0) {
    console.log(bold(gray(`  Stale — >  ${cfg.staleDays}d (${stale.length})`)));
    printRepoTable(stale);
    console.log('');
  }

  const cleanActive = repos.filter(i =>
    !dirty.includes(i) && !offSync.includes(i) && !stale.includes(i)
  );

  console.log(
    `  ${green(`${cleanActive.length} clean`)}  ` +
    `${red(`${dirty.length} dirty`)}  ` +
    `${yellow(`${offSync.length} off-sync`)}  ` +
    `${gray(`${stale.length} stale`)}`
  );
  console.log('');

  // ── M3 Ecosystem summary (graceful degradation if modules not yet built) ──
  const [getToolsRegistryFn, discoverMcpServersFn] = await Promise.all([
    tryGetToolsRegistry(),
    tryDiscoverMcpServers(),
  ]);

  const ecosystemParts: string[] = [];

  if (getToolsRegistryFn) {
    try {
      const reg = getToolsRegistryFn();
      const installedNames = reg.tools
        .filter(t => t.installed)
        .map(t => t.id)
        .slice(0, 5); // show up to 5 names; remainder implied by count
      const moreCount = reg.installedCount - installedNames.length;
      const nameList = installedNames.join(', ') + (moreCount > 0 ? `, +${moreCount}` : '');
      ecosystemParts.push(
        `${bold('Tools:')} ${cyan(`${reg.installedCount}/${reg.tools.length} installed`)}` +
        (installedNames.length > 0 ? ` ${dim('—')} ${gray(nameList)}` : '')
      );
    } catch {
      // silently skip on error
    }
  }

  if (discoverMcpServersFn) {
    try {
      const mcpReg = discoverMcpServersFn();
      ecosystemParts.push(
        `${bold('MCP servers:')} ${cyan(`${mcpReg.servers.length} discovered`)}`
      );
    } catch {
      // silently skip on error
    }
  }

  if (ecosystemParts.length > 0) {
    console.log(`  ${ecosystemParts.join(`  ${dim('·')}  `)}`);
    console.log('');
  }

  // ── M5 Activity summary (best-effort; silently skipped on error) ──────────
  try {
    const buildRollupFn = await tryBuildRollup();
    if (buildRollupFn) {
      const rollup = buildRollupFn('7d', cfg);
      const t = rollup.totals;
      const tokK = ((t.tokensIn + t.tokensOut) / 1000).toFixed(1);
      const cost = t.estCostUsd.toFixed(2);
      const budgetLevel = rollup.budget.level;
      const budgetSuffix = budgetLevel === 'over'
        ? `  ${red('● over budget')}`
        : budgetLevel === 'warn'
          ? `  ${yellow('● near cap')}`
          : '';
      console.log(
        `  ${bold('Activity (7d):')} ${cyan(`${t.sessions} sessions`)}  ${dim('·')}  ` +
        `${cyan(`${tokK}k tokens`)}  ${dim('·')}  ` +
        `${cyan(`$${cost}`)}  ${dim('·')}  ` +
        `${cyan(`${t.commits} commits`)}` +
        budgetSuffix
      );
      console.log('');
    }
  } catch {
    // silently omit — never break status
  }
}

// ─── Command: ls ─────────────────────────────────────────────────────────────

function cmdLs(args: string[]): void {
  const catFilter = args.filter(a => !a.startsWith('--'))[0] ?? null;
  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  let items = idx.items;
  if (catFilter) {
    const q = catFilter.toLowerCase();
    items = items.filter(i => (i.category ?? '').toLowerCase() === q);
    if (items.length === 0) {
      // Partial match fallback
      items = idx.items.filter(i => (i.category ?? '').toLowerCase().includes(q));
    }
    if (items.length === 0) {
      die(`No items found in category "${catFilter}".`);
    }
  }

  const nameW = Math.min(40, Math.max(10, ...items.map(i => i.name.length)));
  const kindW = 10;
  const catW  = 16;

  console.log('');
  console.log(`  ${bold(pad('Name', nameW))}  ${bold(pad('Kind', kindW))}  ${bold(pad('Category', catW))}  ${bold('Description')}`);
  console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(kindW)}  ${'─'.repeat(catW)}  ${'─'.repeat(30)}`);

  // Sort: repos first, then by category, then by name
  const sorted = [...items].sort((a, b) => {
    if (a.kind === 'repo' && b.kind !== 'repo') return -1;
    if (a.kind !== 'repo' && b.kind === 'repo') return 1;
    const catCmp = (a.category ?? '').localeCompare(b.category ?? '');
    if (catCmp !== 0) return catCmp;
    return a.name.localeCompare(b.name);
  });

  for (const item of sorted) {
    const kindColor = item.kind === 'repo' ? cyan : item.kind === 'symlink' ? magenta : gray;
    const activeMarker = item.kind === 'repo' && item.active ? green('●') : dim('○');
    const desc = item.description ? dim(item.description.slice(0, 50)) : '';
    console.log(
      `  ${activeMarker} ${pad(item.name, nameW - 2)}  ` +
      `${pad(kindColor(item.kind), kindW)}  ` +
      `${pad(item.category ?? dim('—'), catW)}  ` +
      desc
    );
  }

  console.log('');
  console.log(`  ${dim(`${sorted.length} items${catFilter ? ` in "${catFilter}"` : ''}`)}`);
  console.log('');
}

// ─── Command: open ────────────────────────────────────────────────────────────

async function cmdOpen(args: string[]): Promise<void> {
  const query = args.filter(a => !a.startsWith('--')).join(' ');
  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  let chosen: IndexedItem | null = null;

  if (query) {
    const candidates = filterItems(idx.items, query);
    if (candidates.length === 0) {
      die(`No items match "${query}".`);
    }
    // Take top match directly if score is unambiguous, else pick
    chosen = candidates[0];
  } else {
    chosen = await pick(idx.items);
  }

  if (!chosen) {
    die('Nothing selected.', 1);
  }

  openInEditor(chosen.path, cfg);
  console.log(green('opened: ') + chosen.path);
}

// ─── Command: tidy ────────────────────────────────────────────────────────────

function cmdTidy(args: string[]): void {
  const apply = args.includes('--apply');
  const json  = args.includes('--json');
  const cfg = loadConfig();
  const plan = planTidy(cfg);

  // ── Machine output ──────────────────────────────────────────────────────
  // With --json, emit ONLY the TidyPlan as JSON on stdout with zero color or
  // log noise. The Raycast "Tidy Desktop" command relies on this contract.
  // Supports `--json --apply` to apply first, then emit the post-apply plan.
  if (json) {
    if (apply) {
      applyTidy(plan);
      // Recompute so the emitted plan reflects the new (tidied) state.
      const after = planTidy(cfg);
      process.stdout.write(JSON.stringify(after));
    } else {
      process.stdout.write(JSON.stringify(plan));
    }
    return;
  }

  const fromW = 50;
  const toW   = 50;

  if (plan.moves.length === 0 && plan.skipped.length === 0) {
    console.log('');
    console.log(`  ${green('Nothing to tidy.')} Desktop is already organized.`);
    console.log('');
    return;
  }

  if (plan.moves.length > 0) {
    console.log('');
    console.log(bold(apply ? '  Applying tidy moves:' : '  Tidy dry-run (use --apply to execute):'));
    console.log('');
    console.log(`  ${bold(pad('From', fromW))}  ${bold(pad('To', toW))}  ${bold('Rule')}`);
    console.log(`  ${'─'.repeat(fromW)}  ${'─'.repeat(toW)}  ${'─'.repeat(20)}`);

    for (const move of plan.moves) {
      // Show relative-ish paths
      const fromShort = move.from.replace(process.env['HOME'] ?? '', '~');
      const toShort   = move.to.replace(process.env['HOME'] ?? '', '~');
      console.log(
        `  ${pad(fromShort, fromW)}  ${cyan(pad(toShort, toW))}  ${dim(move.rule)}`
      );
    }
    console.log('');
  }

  if (plan.skipped.length > 0) {
    console.log(`  ${dim(`Skipped ${plan.skipped.length} path(s):`)}`);
    for (const s of plan.skipped) {
      const shortPath = s.path.replace(process.env['HOME'] ?? '', '~');
      console.log(`  ${dim(pad(shortPath, fromW))}  ${gray(s.reason)}`);
    }
    console.log('');
  }

  if (apply) {
    applyTidy(plan);
    console.log(green(`  Applied ${plan.moves.length} move(s).`));
    console.log('');
  } else if (plan.moves.length > 0) {
    console.log(`  ${yellow(`${plan.moves.length} move(s) planned.`)} Run with ${bold('--apply')} to execute.`);
    console.log('');
  }
}

// ─── Command: config ─────────────────────────────────────────────────────────

function cmdConfig(args: string[]): void {
  const subCmd = args[0];

  const cfg = loadConfig();

  if (!subCmd || subCmd === 'path') {
    console.log(CONFIG_PATH);
    return;
  }

  if (subCmd === 'get') {
    const key = args[1];
    if (!key) die('Usage: ashlr config get <key>', 2);
    const val = getConfigValue(cfg, key);
    if (val === undefined) {
      die(`Key "${key}" not found in config.`);
    }
    if (isSensitiveKey(key)) {
      console.log('<redacted>');
    } else {
      console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    }
    return;
  }

  if (subCmd === 'set') {
    const key         = args[1];
    // --json flag: the token immediately after --json is the JSON value
    const jsonFlagIdx = args.indexOf('--json');
    const hasJsonFlag = jsonFlagIdx !== -1;
    const jsonValue   = hasJsonFlag ? args[jsonFlagIdx + 1] : undefined;
    // Plain scalar value: args[2] when --json is not present
    const rawValue    = hasJsonFlag ? undefined : args[2];

    if (!key) die('Usage: ashlr config set <key> <value>', 2);

    const topKey = key.split('.')[0];
    // Keys that must never be overwritten with a coerced scalar string.
    const STRUCTURED_KEYS = new Set([
      'keepers', 'tidyRules', 'roots', 'categories', 'models', 'telemetry', 'tools', 'phantom',
    ]);
    const existing    = getConfigValue(cfg, key);
    const isStructured =
      Array.isArray(existing) || (existing !== null && typeof existing === 'object');

    if (STRUCTURED_KEYS.has(topKey) && isStructured) {
      // Structured path — require --json with a value
      if (!hasJsonFlag || jsonValue === undefined) {
        die(
          `Key "${key}" holds a structured value (array/object) and cannot be ` +
          `set with a plain scalar.\n` +
          `Use --json to set it:\n` +
          `  ashlr config set ${key} --json '${JSON.stringify(existing)}'`,
          2,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonValue);
      } catch {
        die(`Invalid JSON for "${key}": ${jsonValue}`, 2);
      }
      // Walk to the parent object and set the leaf key
      const parts = key.split('.');
      let obj: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = obj[parts[i]];
        if (next === null || typeof next !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      obj[parts[parts.length - 1]] = parsed;
      saveConfig(cfg);
      const shown = isSensitiveKey(key) ? '<redacted>' : JSON.stringify(parsed);
      console.log(`${green('set')} ${key} = ${shown}`);
      return;
    }

    // Scalar path: --json is allowed but not required
    if (hasJsonFlag && jsonValue !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonValue);
      } catch {
        die(`Invalid JSON for "${key}": ${jsonValue}`, 2);
      }
      const parts = key.split('.');
      let obj: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = obj[parts[i]];
        if (next === null || typeof next !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      obj[parts[parts.length - 1]] = parsed;
      saveConfig(cfg);
      const shown = isSensitiveKey(key) ? '<redacted>' : JSON.stringify(parsed);
      console.log(`${green('set')} ${key} = ${shown}`);
      return;
    }
    if (rawValue === undefined) die(`Usage: ashlr config set <key> <value>`, 2);
    setConfigValue(cfg, key, rawValue);
    saveConfig(cfg);
    const shown = isSensitiveKey(key) ? '<redacted>' : rawValue;
    console.log(`${green('set')} ${key} = ${shown}`);
    return;
  }

  // No sub-command: print a formatted summary
  console.log('');
  console.log(bold('  ashlr config') + gray(` — ${CONFIG_PATH}`));
  console.log('');
  console.log(`  ${bold(pad('editor', 20))}  ${cyan(cfg.editor)}`);
  console.log(`  ${bold(pad('staleDays', 20))}  ${cfg.staleDays}`);
  console.log(`  ${bold(pad('roots', 20))}  ${cfg.roots.map(r => r.replace(process.env['HOME'] ?? '', '~')).join(', ')}`);
  console.log(`  ${bold(pad('categories', 20))}  ${Object.keys(cfg.categories).join(', ')}`);
  console.log(`  ${bold(pad('keepers', 20))}  ${cfg.keepers.length} entries`);
  console.log(`  ${bold(pad('tidyRules', 20))}  ${cfg.tidyRules.length} rules`);
  console.log('');
}

// ─── Command: help ────────────────────────────────────────────────────────────

function cmdHelp(): void {
  console.log('');
  console.log(bold('  ashlr') + dim(' — Desktop command center'));
  console.log('');
  console.log('  ' + bold('Commands:'));
  console.log('');

  const cmds: [string, string][] = [
    ['index [--refresh]',            'Build or refresh the desktop index; show counts by category.'],
    ['go [query] [--open|--cd]',     'Find a repo or item; open in editor (--open) or print path for cd (--cd).'],
    ['status',                       'Attention board: dirty, off-sync, and stale repos; ecosystem summary.'],
    ['ls [category]',                'List all indexed items, optionally filtered by category.'],
    ['open [query]',                 'Open the best match in your editor; no query opens an interactive picker.'],
    ['tidy [--apply]',               'Show (or apply) tidy moves for loose Desktop files.'],
    ['config [get <k>|set <k> <v>]', 'Read/write a config value. No args prints a summary.'],
    ['config set <k> --json <v>',    'Set a structured (array/object) config value as JSON.'],
    ['config path',                  'Print the path to config.json.'],
    ['doctor',                       'One-glance health check: config, phantom, providers, ecosystem.'],
    ['init [--yes]',                 'Idempotent onboarding: ensure config, detect phantom + models, set editor.'],
    ['mcp',                          'Run the MCP aggregation gateway on stdio (point any agent here).'],
    ['mcp list',                     'List discovered MCP servers + per-server tool counts.'],
    ['mcp doctor',                   'Per-server MCP health: does it start? how many tools?'],
    ['mcp install <claude|ashlrcode>', 'Add the ashlr gateway to a target mcpServers config (backs up first).'],
    ['run "<goal>" [opts]',          'Decompose goal into tasks; execute via local model (Ollama/LM Studio).'],
    ['run show <id>',                'Print a past run in detail.'],
    ['runs [--json]',                'List past runs (newest first).'],
    ['pulse [--window 1d|7d|30d]',   'Local observability dashboard: tokens, cost, sessions, commits.'],
    ['pulse --json',                 'Machine-readable ActivityRollup (for Raycast Pulse view).'],
    ['pulse --project <name>',       'Restrict pulse rollup to a single project.'],
    ['help',                         'Show this help.'],
  ];

  const cmdW = Math.max(...cmds.map(([c]) => c.length));
  for (const [cmd, desc] of cmds) {
    console.log(`    ${cyan(pad(cmd, cmdW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Config:') + ` ${dim(CONFIG_PATH)}`);
  console.log('');
  console.log('  ' + bold('Flags apply per-command above.'));
  console.log('');
  console.log('  ' + bold('run flags:') + dim('  --budget N  --max-steps N  --parallel N  --engine builtin|ashlrcode|aw  --allow-cloud  --no-tools  --resume <id>  --json'));
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log(`    ${cyan('ashlr run "list all open GitHub issues in this repo"')}`);
  console.log(`    ${cyan('ashlr run "summarize recent commits" --budget 8000 --max-steps 5')}`);
  console.log(`    ${cyan('ashlr run show <id>')}  ${dim('# inspect a past run')}`);
  console.log(`    ${cyan('ashlr runs')}            ${dim('# list all past runs')}`);
  console.log(`    ${cyan('ashlr pulse')}           ${dim('# cost/token dashboard (7d)')}`);
  console.log(`    ${cyan('ashlr pulse --window 30d --project ashlr-hub')}`);
  console.log('');
  console.log('  ' + bold('new / ship examples:'));
  console.log(`    ${cyan('ashlr new my-app --template next-app')}             ${dim('# scaffold a Next.js starter')}`);
  console.log(`    ${cyan('ashlr new my-tool --template node-cli --category dev-tools')}`);
  console.log(`    ${cyan('ashlr new my-mcp --template mcp-server --stack haskell-mcp')}`);
  console.log(`    ${cyan('ashlr ship')}                                       ${dim('# gate only (dry-run)')}`);
  console.log(`    ${cyan('ashlr ship --gate')}                                ${dim('# explicit gate-only mode')}`);
  console.log(`    ${cyan('ashlr ship --deploy vercel')}                       ${dim('# gate + deploy dry-run')}`);
  console.log(`    ${cyan('ashlr ship --deploy vercel --confirm')}             ${dim('# gate + REAL deploy')}`);
  console.log(`    ${cyan('ashlr ship --strict --deploy gh --confirm')}        ${dim('# fail fast + deploy to gh')}`);
  console.log('');
}

// ─── Top-level dispatch ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd  = argv[0] ?? 'help';
  const rest = argv.slice(1);

  try {
    switch (cmd) {
      case 'index':
        cmdIndex(rest);
        break;

      case 'go':
        await cmdGo(rest);
        break;

      case 'status':
        await cmdStatus(rest);
        break;

      case 'ls':
        cmdLs(rest);
        break;

      case 'open':
        await cmdOpen(rest);
        break;

      case 'tidy':
        cmdTidy(rest);
        break;

      case 'config':
        cmdConfig(rest);
        break;

      case 'doctor':
        process.exitCode = await cmdDoctor(rest);
        break;

      case 'init':
        process.exitCode = await cmdInit(rest);
        break;

      case 'mcp': {
        const cmdMcp = await loadMcpCmd();
        process.exitCode = await cmdMcp(rest);
        break;
      }

      case 'run': {
        const cmdRun = await loadRunCmd();
        process.exitCode = await cmdRun(rest);
        break;
      }

      case 'runs': {
        const cmdRuns = await loadRunsCmd();
        process.exitCode = await cmdRuns(rest);
        break;
      }

      case 'pulse': {
        const cmdPulse = await loadPulseCmd();
        process.exitCode = await cmdPulse(rest);
        break;
      }

      case 'new': {
        const cmdNew = await loadNewCmd();
        process.exitCode = await cmdNew(rest);
        break;
      }

      case 'ship': {
        const cmdShip = await loadShipCmd();
        process.exitCode = await cmdShip(rest);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
        cmdHelp();
        break;

      default:
        console.error(red(`Unknown command: ${cmd}`));
        console.error(dim('Run `ashlr help` for usage.'));
        process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "not implemented" stubs from real errors
    if (msg.includes('not implemented')) {
      die(`Module not yet implemented: ${msg}\nThis command depends on a core module that hasn't been built yet.`);
    }
    die(msg);
  }
}

// Run — top-level await is fine in ESM with Node 22
await main();
