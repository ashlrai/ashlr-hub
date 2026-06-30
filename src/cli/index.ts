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
 *   recall "<query>"           Search shared genome memory; return top relevant entries.
 *   learn "<text>" [opts]      Append a note to shared genome memory.
 *   genome                     Genome status/health: entry count, projects, staleness.
 *   update [--check] [--json]  Safe self-update: git pull --ff-only + rebuild; --check reports only.
 *   spec new "<goal>" [opts]   Author a versioned end-state spec artifact.
 *   spec list/show/refine      Manage spec artifacts.
 *   swarm "<goal>"|<specId>    Decompose a spec into a contracts-first agent swarm and run it.
 *   swarms [--json]            List past swarm runs.
 *   tui [--once]               Interactive terminal dashboard (alias: dash).
 *   serve [--port N] [--open]  Local web dashboard + JSON API on 127.0.0.1 (default port 7777).
 *   gh <pr|issue|ci>           Read GitHub PRs / issues / CI status (read-only via gh CLI).
 *   gh pr create               Create a PR (explicit + confirm-gated mutation).
 *   vercel <ls|logs>           Read Vercel deployments / latest logs (read-only via vercel CLI).
 *   wire [claude|codex|cursor|all]  Wire ashlr MCP gateway into editor config(s).
 *   notify test                Send a test ping to the configured webhook (no-op if unconfigured).
 *   help                       Show this help.
 *
 * Exit codes: 0 success, 1 error/not-found, 2 bad usage.
 */

import { existsSync } from 'node:fs';
import { loadConfig, saveConfig, CONFIG_PATH } from '../core/config.js';
import { buildIndex, loadIndex, writeIndex } from '../core/index-engine.js';
import { planTidy, applyTidy } from '../core/tidy.js';
import { openInEditor } from './open.js';
import { pick } from './picker.js';
import { cmdDoctor, cmdInit } from './doctor-init.js';
import { cmdSetup } from './setup.js';
import { pad, makeColors } from './ui.js';
import type { AshlrConfig, AshlrIndex, IndexedItem, GitStatus, ToolsRegistry, McpRegistry } from '../core/types.js';

// ─── Lazy command loaders ───────────────────────────────────────────
//
// Each command module is imported on demand so the CLI degrades gracefully when
// a not-yet-built module is missing. lazyCmd() captures the uniform pattern:
// cache the resolved export (undefined = not attempted, null = import failed),
// and on failure return a stub that prints a "module not yet built" error and
// exits 1. The fallback message format is identical across every command.

type Cmd = (args: string[]) => Promise<number>;
type GetToolsRegistryFn = () => ToolsRegistry;
type DiscoverMcpServersFn = () => McpRegistry;

/**
 * Build a lazy loader for a CLI command export.
 * @param importer  dynamic import of the command module
 * @param pick      selects the command function from the loaded module
 * @param label     human command name + source path for the fallback message
 *                  (e.g. "mcp command requires src/cli/mcp.ts (M3 module not yet built).")
 */
function lazyCmd(
  importer: () => Promise<unknown>,
  pick: (mod: Record<string, unknown>) => Cmd,
  label: string,
): () => Promise<Cmd> {
  let cached: Cmd | null | undefined;
  return async (): Promise<Cmd> => {
    if (cached === undefined) {
      try {
        cached = pick((await importer()) as Record<string, unknown>);
      } catch {
        cached = null;
      }
    }
    if (cached === null) {
      return async (_args: string[]) => {
        console.error(red('error: ') + label);
        return 1;
      };
    }
    return cached;
  };
}

const loadMcpCmd = lazyCmd(
  () => import('./mcp.js'),
  (m) => m.cmdMcp as Cmd,
  'mcp command requires src/cli/mcp.ts (M3 module not yet built).',
);

// Cache slots — undefined = not yet attempted; null = attempted & failed
let _getToolsRegistry: GetToolsRegistryFn | null | undefined = undefined;
let _discoverMcpServers: DiscoverMcpServersFn | null | undefined = undefined;

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

// ─── M4 command loaders ────────────────────────────────────────────

const loadRunCmd = lazyCmd(
  () => import('./run.js' as unknown as string),
  (m) => m.cmdRun as Cmd,
  'run command requires src/cli/run.ts (M4 module not yet built).',
);

const loadRunsCmd = lazyCmd(
  () => import('./run.js' as unknown as string),
  (m) => m.cmdRuns as Cmd,
  'runs command requires src/cli/run.ts (M4 module not yet built).',
);

// ─── M44 local-agent eval harness ─────────────────────────────────────────────

const loadEvalCmd = lazyCmd(
  () => import('./eval.js' as unknown as string),
  (m) => m.cmdEval as Cmd,
  'eval command requires src/cli/eval.ts (M44 module not yet built).',
);

// ─── M49 fleet control plane + observability ──────────────────────────────────

const loadFleetCmd = lazyCmd(
  () => import('./fleet.js' as unknown as string),
  (m) => m.cmdFleet as Cmd,
  'fleet command requires src/cli/fleet.ts (M49 module not yet built).',
);

// ─── M55 the conductor: `ashlr goal` + `ashlr loop` ──────────────────────────

const loadGoalCmd = lazyCmd(
  () => import('./goal.js' as unknown as string),
  (m) => m.cmdGoal as Cmd,
  'goal command requires src/cli/goal.ts (M55 module not yet built).',
);

const loadLoopCmd = lazyCmd(
  () => import('./loop.js' as unknown as string),
  (m) => m.cmdLoop as Cmd,
  'loop command requires src/cli/loop.ts (M55 module not yet built).',
);

// ─── M120 fleet manager / CEO agent ──────────────────────────────────────────

const loadManagerCmd = lazyCmd(
  () => import('./manager.js' as unknown as string),
  (m) => m.cmdManager as Cmd,
  'manager command requires src/cli/manager.ts (M120 module not yet built).',
);

// ─── M121: vision / strategist — north-star spec + Elon agent ────────────────
const loadVisionCmd = lazyCmd(
  () => import('./vision.js' as unknown as string),
  (m) => m.cmdVision as Cmd,
  'vision command requires src/cli/vision.ts (M121 module not yet built).',
);

// ─── M73: surface the ecosystem `stack` tool from the hub ──────────────────
const loadStackCmd = lazyCmd(
  () => import('./stack.js' as unknown as string),
  (m) => m.cmdStack as Cmd,
  'stack command requires src/cli/stack.ts (M73 module not yet built).',
);

// ─── M5 lazy imports (graceful degradation if modules not yet built) ──────────

import type { ActivityRollup } from '../core/types.js';
type BuildRollupFn = (window: '1d' | '7d' | '30d', cfg: AshlrConfig, opts?: { project?: string }) => ActivityRollup;

let _buildRollup: BuildRollupFn | null | undefined = undefined;

const loadPulseCmd = lazyCmd(
  () => import('./pulse.js' as unknown as string),
  (m) => m.cmdPulse as Cmd,
  'pulse command requires src/cli/pulse.ts (M5 module not yet built).',
);

const loadPulseTestCmd = lazyCmd(
  () => import('./pulse.js' as unknown as string),
  (m) => ((_args: string[]) => (m.cmdPulseTest as () => Promise<number>)()) as Cmd,
  'pulse-test command requires src/cli/pulse.ts (M91 module not yet built).',
);

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

// ─── M6 command loaders ────────────────────────────────────────────

const loadNewCmd = lazyCmd(
  () => import('./new.js' as unknown as string),
  (m) => m.cmdNew as Cmd,
  'new command requires src/cli/new.ts (M6 module not yet built).',
);

const loadShipCmd = lazyCmd(
  () => import('./ship.js' as unknown as string),
  (m) => m.cmdShip as Cmd,
  'ship command requires src/cli/ship.ts (M6 module not yet built).',
);

// ─── M7 command loaders ────────────────────────────────────────────

const loadRecallCmd = lazyCmd(
  () => import('./genome.js' as unknown as string),
  (m) => m.cmdRecall as Cmd,
  'recall command requires src/cli/genome.ts (M7 module not yet built).',
);

const loadLearnCmd = lazyCmd(
  () => import('./genome.js' as unknown as string),
  (m) => m.cmdLearn as Cmd,
  'learn command requires src/cli/genome.ts (M7 module not yet built).',
);

const loadGenomeCmd = lazyCmd(
  () => import('./genome.js' as unknown as string),
  (m) => m.cmdGenome as Cmd,
  'genome command requires src/cli/genome.ts (M7 module not yet built).',
);

// ─── M9 command loader ───────────────────────────────────────────

const loadUpdateCmd = lazyCmd(
  () => import('./update.js' as unknown as string),
  (m) => m.cmdUpdate as Cmd,
  'update command requires src/cli/update.ts (M9 module not yet built).',
);

// ─── M12 command loaders ────────────────────────────────────────────

const loadSpecCmd = lazyCmd(
  () => import('./spec.js' as unknown as string),
  (m) => m.cmdSpec as Cmd,
  'spec command requires src/cli/spec.ts (M12 module not yet built).',
);

const loadSwarmCmd = lazyCmd(
  () => import('./swarm.js' as unknown as string),
  (m) => m.cmdSwarm as Cmd,
  'swarm command requires src/cli/swarm.ts (M12 module not yet built).',
);

const loadSwarmsCmd = lazyCmd(
  () => import('./swarm.js' as unknown as string),
  (m) => m.cmdSwarms as Cmd,
  'swarms command requires src/cli/swarm.ts (M12 module not yet built).',
);

// ─── M13 command loader ────────────────────────────────────────────

const loadTuiCmd = lazyCmd(
  () => import('./tui.js' as unknown as string),
  (m) => m.cmdTui as Cmd,
  'tui command requires src/cli/tui.ts (M13 module not yet built).',
);

// ─── M253 resources command loader ───────────────────────────────────────────

const loadResourcesCmd = lazyCmd(
  () => import('./resources.js' as unknown as string),
  (m) => m.cmdResources as Cmd,
  'resources command requires src/cli/resources.ts (M253 module not yet built).',
);

// ─── M194 frontier-usage command loader ──────────────────────────────────────

const loadUsageCmd = lazyCmd(
  () => import('./usage.js' as unknown as string),
  (m) => m.cmdUsage as Cmd,
  'usage command requires src/cli/usage.ts (M194 module not yet built).',
);

// ─── M211 dashboard command loader ──────────────────────────────────────────

const loadDashboardCmd = lazyCmd(
  () => import('./dashboard.js' as unknown as string),
  (m) => m.cmdDashboard as Cmd,
  'dashboard command requires src/cli/dashboard.ts (M211 module not yet built).',
);

// ─── M14 command loader ────────────────────────────────────────────

const loadServeCmd = lazyCmd(
  () => import('./serve.js' as unknown as string),
  (m) => m.cmdServe as Cmd,
  'serve command requires src/cli/serve.ts (M14 module not yet built).',
);

const loadModelsCmd = lazyCmd(
  () => import('./models.js' as unknown as string),
  (m) => m.cmdModels as Cmd,
  'models command requires src/cli/models.ts (M15 module not yet built).',
);

// ─── M18 command loaders ───────────────────────────────────────────

const loadGhCmd = lazyCmd(
  () => import('./gh.js' as unknown as string),
  (m) => m.cmdGh as Cmd,
  'gh command requires src/cli/gh.ts (M18 module not yet built).',
);

const loadVercelCmd = lazyCmd(
  () => import('./vercel.js' as unknown as string),
  (m) => m.cmdVercel as Cmd,
  'vercel command requires src/cli/vercel.ts (M18 module not yet built).',
);

const loadWireCmd = lazyCmd(
  () => import('./wire.js' as unknown as string),
  (m) => m.cmdWire as Cmd,
  'wire command requires src/cli/wire.ts (M18 module not yet built).',
);

const loadNotifyCmd = lazyCmd(
  () => import('./notify.js' as unknown as string),
  (m) => m.cmdNotify as Cmd,
  'notify command requires src/cli/notify.ts (M18 module not yet built).',
);

// ─── M19 command loader ────────────────────────────────────────────

const loadTelemetryCmd = lazyCmd(
  () => import('./telemetry.js' as unknown as string),
  (m) => m.cmdTelemetry as Cmd,
  'telemetry command requires src/cli/telemetry.ts (M19 module not yet built).',
);


// ─── M21 command loaders ────────────────────────────────────────────

const loadSandboxCmd = lazyCmd(
  () => import('./sandbox.js'),
  (m) => m.cmdSandbox as Cmd,
  'sandbox command requires src/cli/sandbox.ts (M21 module not yet built).',
);

// H6 (PART A): the `ashlr audit` viewer moved to its own ./audit.ts module
// (read-only; adds --action/--result/--since filters). Re-pointed here from the
// old sandbox.ts#cmdAudit, matching the reflect/health/seams/verify-safety
// loaders — see docs/contracts/CONTRACT-H6.md §A.3.
const loadAuditCmd = lazyCmd(
  () => import('./audit.js'),
  (m) => m.cmdAudit as Cmd,
  'audit command requires src/cli/audit.ts (H6 module not yet built).',
);

const loadEnrollCmd = lazyCmd(
  () => import('./sandbox.js'),
  (m) => m.cmdEnroll as Cmd,
  'enroll command requires src/cli/sandbox.ts (M21 module not yet built).',
);

// ─── M22 command loaders ────────────────────────────────────────────

const loadBacklogCmd = lazyCmd(
  () => import('./backlog.js'),
  (m) => m.cmdBacklog as Cmd,
  'backlog command requires src/cli/backlog.ts (M22 module not yet built).',
);

// ─── M23 command loaders ────────────────────────────────────────────

const loadInboxCmd = lazyCmd(
  () => import('./inbox.js'),
  (m) => m.cmdInbox as Cmd,
  'inbox command requires src/cli/inbox.ts (M23 module not yet built).',
);

// ─── M24 command loaders ────────────────────────────────────────────

const loadDaemonCmd = lazyCmd(
  () => import('./daemon.js'),
  (m) => m.cmdDaemon as Cmd,
  'daemon command requires src/cli/daemon.ts (M24 module not yet built).',
);

// ─── M25 command loaders ────────────────────────────────────────────

const loadAskCmd = lazyCmd(
  () => import('./ask.js'),
  (m) => m.cmdAsk as Cmd,
  'ask command requires src/cli/ask.ts (M25 module not yet built).',
);

const loadKnowledgeCmd = lazyCmd(
  () => import('./knowledge.js'),
  (m) => m.cmdKnowledge as Cmd,
  'knowledge command requires src/cli/knowledge.ts (M25 module not yet built).',
);

// ─── M26 command loaders ────────────────────────────────────────────

const loadReflectCmd = lazyCmd(
  () => import('./reflect.js'),
  (m) => m.cmdReflect as Cmd,
  'reflect command requires src/cli/reflect.ts (M26 module not yet built).',
);

// ─── M27 command loaders ────────────────────────────────────────────

const loadHealthCmd = lazyCmd(
  () => import('./health.js'),
  (m) => m.cmdHealth as Cmd,
  'health command requires src/cli/health.ts (M27 module not yet built).',
);

// ─── M28 command loaders ────────────────────────────────────────────

const loadGoalsCmd = lazyCmd(
  () => import('./goals.js'),
  (m) => m.cmdGoals as Cmd,
  'goals command requires src/cli/goals.ts (M28 module not yet built).',
);

// ─── M29 command loaders ────────────────────────────────────────────

const loadDigestCmd = lazyCmd(
  () => import('./digest.js'),
  (m) => m.cmdDigest as Cmd,
  'digest command requires src/cli/digest.ts (M29 module not yet built).',
);

// ─── M30 command loaders ────────────────────────────────────────────

const loadSeamsCmd = lazyCmd(
  () => import('./seams.js'),
  (m) => m.cmdSeams as Cmd,
  'seams command requires src/cli/seams.ts (M30 module not yet built).',
);

// ─── M31 command loaders ──────────────────────────────────────────────────────────────

const loadOrientCmd = lazyCmd(
  () => import('./orient.js'),
  (m) => m.cmdOrient as Cmd,
  'orient command requires src/cli/orient.ts (M31 module not yet built).',
);

const loadDocsCmd = lazyCmd(
  () => import('./help.js'),
  (m) => m.cmdDocs as Cmd,
  'docs command requires src/cli/help.ts (M31 module not yet built).',
);

const loadCompletionsCmd = lazyCmd(
  () => import('./completions.js'),
  (m) => m.cmdCompletions as Cmd,
  'completions command requires src/cli/completions.ts (M31 module not yet built).',
);

// ─── M33 command loaders ──────────────────────────────────────────────────────────────

const loadPluginsCmd = lazyCmd(
  () => import('./plugins.js'),
  (m) => m.cmdPlugins as Cmd,
  'plugins command requires src/cli/plugins.ts (M33 module not yet built).',
);

const loadXCmd = lazyCmd(
  () => import('./plugins.js'),
  (m) => m.cmdX as Cmd,
  'x command requires src/cli/plugins.ts (M33 module not yet built).',
);

// ─── H4 command loaders ─────────────────────────────────────────────

const loadVerifySafetyCmd = lazyCmd(
  () => import('./verify-safety.js'),
  (m) => m.cmdVerifySafety as Cmd,
  'verify-safety command requires src/cli/verify-safety.ts (H4 module not yet built).',
);

// ─── H7 command loaders ─────────────────────────────────────────────
// preflight + onboard, matching the reflect/health/seams/verify-safety/audit
// loaders — see docs/contracts/CONTRACT-H7.md.

const loadPreflightCmd = lazyCmd(
  () => import('./preflight.js'),
  (m) => m.cmdPreflight as Cmd,
  'preflight command requires src/cli/preflight.ts (H7 module not yet built).',
);

const loadOnboardCmd = lazyCmd(
  () => import('./onboard.js'),
  (m) => m.cmdOnboard as Cmd,
  'onboard command requires src/cli/onboard.ts (H7 module not yet built).',
);

// ─── H8 command loader ──────────────────────────────────────────────
// `ashlr demo` — a watchable, reproducible run of the FULL autonomous chain on a
// DISPOSABLE repo in an ISOLATED tmp context; proposal-only; auto-cleans. The
// ONE new runtime surface in v2.1 (see docs/contracts/CONTRACT-H8.md).

const loadDemoCmd = lazyCmd(
  () => import('./demo.js'),
  (m) => m.cmdDemo as Cmd,
  'demo command requires src/cli/demo.ts (H8 module not yet built).',
);

// ─── M112 command loader ────────────────────────────────────────────
// `ashlr worker setup` / `ashlr worker status`
// One-command spare-Mac provisioning with caffeinate keep-awake daemon.

const loadWorkerCmd = lazyCmd(
  () => import('./worker.js'),
  (m) => m.cmdWorker as Cmd,
  'worker command requires src/cli/worker.ts (M112 module not yet built).',
);

// ─── M137 command loader ────────────────────────────────────────────

const loadCommsCmd = lazyCmd(
  () => import('./comms.js'),
  (m) => m.cmdComms as Cmd,
  'comms command requires src/cli/comms.ts (M137 module not yet built).',
);

// ─── M257 director command loader ────────────────────────────────────────────

const loadDirectorCmd = lazyCmd(
  () => import('./director.js'),
  (m) => m.cmdDirector as Cmd,
  'director command requires src/cli/director.ts (M257 module not yet built).',
);

// ─── M142 command loader ────────────────────────────────────────────

const loadBestOfNCmd = lazyCmd(
  () => import('./best-of-n.js'),
  (m) => m.cmdBestOfN as Cmd,
  'best-of-n command requires src/cli/best-of-n.ts (M142 module not yet built).',
);

// ─── M181 command loaders ─────────────────────────────────────────────────────

const loadInventCmd = lazyCmd(
  () => import('./invent.js'),
  (m) => m.cmdInvent as Cmd,
  'invent command requires src/cli/invent.ts (M181 generative engine).',
);

// ─── M18 integration reads (best-effort, never throw, used in cmdStatus) ──────

import type { GithubStatus, VercelStatus, Identity } from '../core/types.js';

type GithubStatusFn = (cwd: string) => GithubStatus;
type VercelStatusFn = (cwd: string) => VercelStatus;
type GetIdentityFn  = () => Identity;

let _githubStatus: GithubStatusFn | null | undefined = undefined;
let _vercelStatus: VercelStatusFn | null | undefined = undefined;
let _getIdentity:  GetIdentityFn  | null | undefined = undefined;

async function tryGithubStatus(): Promise<GithubStatusFn | null> {
  if (_githubStatus === undefined) {
    try {
      const mod = (await import('../core/integrations/github.js' as unknown as string)) as { githubStatus: GithubStatusFn };
      _githubStatus = mod.githubStatus;
    } catch {
      _githubStatus = null;
    }
  }
  return _githubStatus ?? null;
}

async function tryVercelStatus(): Promise<VercelStatusFn | null> {
  if (_vercelStatus === undefined) {
    try {
      const mod = (await import('../core/integrations/vercel.js' as unknown as string)) as { vercelStatus: VercelStatusFn };
      _vercelStatus = mod.vercelStatus;
    } catch {
      _vercelStatus = null;
    }
  }
  return _vercelStatus ?? null;
}

async function tryGetIdentity(): Promise<GetIdentityFn | null> {
  if (_getIdentity === undefined) {
    try {
      const mod = (await import('../core/integrations/identity.js' as unknown as string)) as { getIdentity: GetIdentityFn };
      _getIdentity = mod.getIdentity;
    } catch {
      _getIdentity = null;
    }
  }
  return _getIdentity ?? null;
}

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

// index.ts colorizes unconditionally (output is always color-coded regardless
// of TTY), so we bind the shared colorizers with tty=true.
const { bold, dim, red, green, yellow, cyan, gray, magenta } = makeColors(true);

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

/**
 * Config key segments that would let `config set` walk into an object's
 * prototype chain (prototype pollution). Any dot-path containing one of these
 * is rejected before we walk/assign, since the result is persisted to
 * ~/.ashlr/config.json and re-applied via deepMerge on the next load.
 */
const DANGEROUS_KEY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Reject a config dot-path whose any segment is a prototype-polluting prop. */
function assertSafeConfigKey(key: string): void {
  for (const segment of key.split('.')) {
    if (DANGEROUS_KEY_SEGMENTS.has(segment)) {
      die(`Illegal config key segment: "${segment}"`, 2);
    }
  }
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

/**
 * Assign `value` to a dot-path leaf in `cfg`, creating intermediate objects as
 * needed. Caller MUST run assertSafeConfigKey(key) first (prototype-pollution
 * guard) — setByPath itself does not re-check.
 */
function setByPath(cfg: AshlrConfig, key: string, value: unknown): void {
  const parts = key.split('.');
  let obj: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const hasOwn = Object.prototype.hasOwnProperty.call(obj, parts[i]);
    const next = hasOwn ? obj[parts[i]] : undefined;
    if (!hasOwn || next === null || typeof next !== 'object') {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]] = value;
}

/** Set a nested config value by dot-path key (mutates cfg). */
function setConfigValue(cfg: AshlrConfig, key: string, rawValue: string): void {
  assertSafeConfigKey(key);
  // Coerce to number or boolean when applicable
  let value: unknown = rawValue;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else {
    const num = Number(rawValue);
    if (!isNaN(num) && rawValue.trim() !== '') value = num;
  }
  setByPath(cfg, key, value);
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

  // No repos found → roots are almost certainly misconfigured. Point the user
  // at the full setup guidance (printed in detail by `ashlr status`).
  if (repos.length === 0) {
    printNoReposHelp(cfg);
  }
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

/**
 * Printed when the index contains zero git repos. The overwhelmingly common
 * cause is that `roots` doesn't point at where the user's code lives — e.g. a
 * default config carried over from another machine (the defaults assume
 * ~/Desktop/github). Rather than a bare "0 repos tracked", show which roots
 * were scanned, whether each one exists, and the exact commands to fix it.
 */
function printNoReposHelp(cfg: AshlrConfig): void {
  console.log(yellow('  No git repos are being tracked yet.'));
  console.log('');
  console.log(`  ashlr scanned these ${bold('roots')} ${dim('— folders expected to CONTAIN your repos:')}`);
  console.log('');
  if (cfg.roots.length === 0) {
    console.log(`    ${red('✗')} ${dim('(no roots configured)')}`);
  } else {
    for (const root of cfg.roots) {
      const exists = existsSync(root);
      const mark = exists ? yellow('•') : red('✗');
      const tag  = exists ? gray('exists, no repos found inside') : red('missing');
      console.log(`    ${mark} ${root}  ${dim('—')} ${tag}`);
    }
  }
  console.log('');
  console.log(`  ${bold('Fix it')} ${dim('— point ashlr at the folder that holds your repos')}`);
  console.log(`  ${dim('(repos must be direct children, e.g.')} ${cyan('<root>/my-app/.git')}${dim('):')}`);
  console.log('');
  console.log(`    ${cyan('1.')} Set your roots:`);
  console.log(`       ${dim('Windows PowerShell — note the doubled')} ${bold('""')} ${dim('quotes:')}`);
  console.log(`       ${cyan('ashlr config set roots --json \'[""C:/Users/you/code""]\'')}`);
  console.log(`       ${dim('macOS / Linux:')}`);
  console.log(`       ${cyan('ashlr config set roots --json \'["/Users/you/code"]\'')}`);
  console.log(`       ${dim('…or edit')} ${cyan(CONFIG_PATH)} ${dim('directly.')}`);
  console.log('');
  console.log(`    ${cyan('2.')} Rebuild the index:  ${cyan('ashlr index --refresh')}`);
  console.log('');
  console.log(`  ${dim('Then re-run')} ${cyan('ashlr status')}${dim('.')}`);
  console.log('');
}

async function cmdStatus(_args: string[]): Promise<void> {
  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  const repos = idx.items.filter(i => i.kind === 'repo' && i.git);

  // Zero repos → the index is empty or roots are misconfigured. Show actionable
  // setup guidance instead of an empty attention board, then stop.
  if (repos.length === 0) {
    console.log('');
    console.log(bold('  ashlr status') + gray(' — 0 repos tracked'));
    console.log('');
    printNoReposHelp(cfg);
    return;
  }

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
      const BUDGET_SUFFIX: Record<string, string> = {
        over: `  ${red('● over budget')}`,
        warn: `  ${yellow('● near cap')}`,
      };
      const budgetSuffix = BUDGET_SUFFIX[rollup.budget.level] ?? '';
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

  // ── M7 Genome summary (best-effort; silently omitted on error) ────────────
  try {
    const genomeMod = await import('../core/genome/store.js' as unknown as string) as {
      genomeHealth: (cfg: AshlrConfig) => import('../core/types.js').GenomeHealth;
    };
    const health = genomeMod.genomeHealth(cfg);
    console.log(
      `  ${bold('Memory:')} ${cyan(`${health.totalEntries} genome entries`)} across ` +
      `${cyan(`${health.projects} project${health.projects !== 1 ? 's' : ''}`)}` +
      (health.embeddingsAvailable ? `  ${dim('·')}  ${gray('embeddings available')}` : '')
    );
    console.log('');
  } catch {
    // silently omit — genome may not be built yet; never break status
  }

  // ── M18 GitHub / Vercel / Identity one-liners (best-effort; never break status) ──
  // All reads are bounded (reuse installed CLIs; they own auth) and silently
  // omitted when not applicable (not a gh repo, no vercel link, not logged in).
  const cwd = process.cwd();

  // GitHub: only surface when cwd is a gh repo
  try {
    const ghStatusFn = await tryGithubStatus();
    if (ghStatusFn) {
      const gs = ghStatusFn(cwd);
      if (gs.isRepo) {
        const ciStr = gs.ci === 'passing'
          ? green('CI passing')
          : gs.ci === 'failing'
            ? red('CI failing')
            : gs.ci === 'pending'
              ? yellow('CI pending')
              : dim('no CI');
        const repoLabel = gs.repo ? gray(` (${gs.repo})`) : '';
        console.log(
          `  ${bold('GitHub:')} ${cyan(`${gs.openPrs} open PR${gs.openPrs !== 1 ? 's' : ''}`)}` +
          `  ${dim('·')}  ${cyan(`${gs.openIssues} open issue${gs.openIssues !== 1 ? 's' : ''}`)}` +
          `  ${dim('·')}  ${ciStr}${repoLabel}`
        );
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // Vercel: only surface when a project is linked
  try {
    const vcStatusFn = await tryVercelStatus();
    if (vcStatusFn) {
      const vs = vcStatusFn(cwd);
      if (vs.linked) {
        const stateStr = vs.latestState
          ? (vs.latestState === 'READY' ? green(vs.latestState) : yellow(vs.latestState))
          : dim('unknown');
        const urlStr = vs.url ? `  ${dim('·')}  ${cyan(vs.url)}` : '';
        console.log(`  ${bold('Vercel:')} ${stateStr}${urlStr}`);
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // Identity: only surface when phantom is logged in
  try {
    const identityFn = await tryGetIdentity();
    if (identityFn) {
      const id = identityFn();
      if (id.loggedIn && id.user) {
        const tierStr = id.tier ? `  ${dim('·')}  tier ${cyan(id.tier)}` : '';
        const teamStr = id.team ? `  ${dim('·')}  team ${cyan(id.team)}` : '';
        console.log(`  ${bold('You:')} ${cyan(id.user)}${tierStr}${teamStr}`);
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // ── M253 Resource Control Plane summary (best-effort; never break status) ──
  try {
    const resourcesMod = await import('./resources.js' as unknown as string) as {
      resourceStatusLine: (cfg: unknown) => Promise<string | null>;
    };
    const line = await resourcesMod.resourceStatusLine(cfg);
    if (line) {
      console.log(`  ${line}`);
      console.log('');
    }
  } catch {
    // silently omit — resource sensing never breaks the status command
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
    assertSafeConfigKey(key);

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
      setByPath(cfg, key, parsed);
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
      setByPath(cfg, key, parsed);
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

/**
 * M32: help moved to src/cli/help.ts (topic-grouped, searchable, --all).
 * This thin wrapper keeps `ashlr help` working even if the module is missing.
 */
async function cmdHelp(rest: string[] = []): Promise<void> {
  try {
    const mod = await import('./help.js');
    await mod.cmdHelp(rest);
  } catch {
    console.log('ashlr — local-first command center. Run a command or see the README.');
  }
}

// ─── Top-level dispatch ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // ── Internal background-worker entry point ──────────────────────────────
  // When `cmdSwarm --background` spawns a detached worker it re-invokes the
  // CLI as: `ashlr --_worker swarm --resume <id> [...]`
  // Strip the flag and route as if the user typed `ashlr swarm --resume <id>`.
  const workerFlagIdx = argv.indexOf('--_worker');
  if (workerFlagIdx !== -1) {
    argv.splice(workerFlagIdx, 1); // remove --_worker in-place
  }

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

      case 'setup':
        process.exitCode = await cmdSetup(rest);
        break;

      case 'mcp': {
        const cmdMcp = await loadMcpCmd();
        process.exitCode = await cmdMcp(rest);
        break;
      }

      case 'run': {
        // --no-memory is passed through to cmdRun as-is; run.ts parses it
        // into RunOptions.noMemory for the orchestrator's genome injection gate.
        const cmdRun = await loadRunCmd();
        process.exitCode = await cmdRun(rest);
        break;
      }

      case 'runs': {
        const cmdRuns = await loadRunsCmd();
        process.exitCode = await cmdRuns(rest);
        break;
      }

      case 'eval': {
        // M44: local-agent eval harness — runs fixtures with adaptive
        // prompts OFF vs ON and reports steps/done/tokens.
        const cmdEval = await loadEvalCmd();
        process.exitCode = await cmdEval(rest);
        break;
      }

      case 'pulse': {
        const cmdPulse = await loadPulseCmd();
        process.exitCode = await cmdPulse(rest);
        break;
      }

      case 'pulse-export': {
        // M89: fleet→pulse OTLP backfill/manual export
        const cmdPulse = await loadPulseCmd();
        process.exitCode = await cmdPulse(['export', ...rest]);
        break;
      }

      case 'pulse-test': {
        // M91: fleet→pulse connectivity + auth probe
        const cmdPulseTest = await loadPulseTestCmd();
        process.exitCode = await cmdPulseTest(rest);
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

      case 'recall': {
        const cmdRecall = await loadRecallCmd();
        process.exitCode = await cmdRecall(rest);
        break;
      }

      case 'learn': {
        const cmdLearn = await loadLearnCmd();
        process.exitCode = await cmdLearn(rest);
        break;
      }

      case 'genome': {
        const cmdGenome = await loadGenomeCmd();
        process.exitCode = await cmdGenome(rest);
        break;
      }

      case 'update': {
        const cmdUpdate = await loadUpdateCmd();
        process.exitCode = await cmdUpdate(rest);
        break;
      }

      case 'spec': {
        const cmdSpec = await loadSpecCmd();
        process.exitCode = await cmdSpec(rest);
        break;
      }

      case 'swarm': {
        // Internal --_worker flag: a detached background process spawned by
        // cmdSwarm --background re-invokes the CLI with this flag to resume
        // and drive the swarm without a TTY. Route directly to cmdSwarm which
        // handles the --resume path (the worker argv is passed through as-is).
        const cmdSwarm = await loadSwarmCmd();
        process.exitCode = await cmdSwarm(rest);
        break;
      }

      case 'swarms': {
        const cmdSwarms = await loadSwarmsCmd();
        process.exitCode = await cmdSwarms(rest);
        break;
      }

      case 'tui':
      case 'dash': {
        const cmdTui = await loadTuiCmd();
        process.exitCode = await cmdTui(rest);
        break;
      }

      case 'dashboard': {
        // M211: persistent fleet dashboard — installs launchd LaunchAgent +
        // opens browser. `--stop` / `--status` subcommands also supported.
        const cmdDashboard = await loadDashboardCmd();
        process.exitCode = await cmdDashboard(rest);
        break;
      }

      case 'serve': {
        const cmdServe = await loadServeCmd();
        process.exitCode = await cmdServe(rest);
        break;
      }

      case 'models': {
        const cmdModels = await loadModelsCmd();
        process.exitCode = await cmdModels(rest);
        break;
      }

      case 'gh': {
        const cmdGh = await loadGhCmd();
        process.exitCode = await cmdGh(rest);
        break;
      }

      case 'vercel': {
        const cmdVercel = await loadVercelCmd();
        process.exitCode = await cmdVercel(rest);
        break;
      }

      case 'wire': {
        const cmdWire = await loadWireCmd();
        process.exitCode = await cmdWire(rest);
        break;
      }

      case 'notify': {
        const cmdNotify = await loadNotifyCmd();
        process.exitCode = await cmdNotify(rest);
        break;
      }

      case 'telemetry': {
        const cmdTelemetry = await loadTelemetryCmd();
        process.exitCode = await cmdTelemetry(rest);
        break;
      }

      case 'sandbox': {
        const cmdSandbox = await loadSandboxCmd();
        process.exitCode = await cmdSandbox(rest);
        break;
      }

      case 'audit': {
        const cmdAudit = await loadAuditCmd();
        process.exitCode = await cmdAudit(rest);
        break;
      }

      case 'enroll': {
        const cmdEnroll = await loadEnrollCmd();
        process.exitCode = await cmdEnroll(rest);
        break;
      }

      case 'backlog': {
        const cmdBacklog = await loadBacklogCmd();
        process.exitCode = await cmdBacklog(rest);
        break;
      }

      case 'inbox': {
        const cmdInbox = await loadInboxCmd();
        process.exitCode = await cmdInbox(rest);
        break;
      }

      case 'daemon': {
        const cmdDaemon = await loadDaemonCmd();
        process.exitCode = await cmdDaemon(rest);
        break;
      }

      case 'worker': {
        // M112: one-command spare-Mac worker provisioning (keepAwake daemon + identity)
        const cmdWorker = await loadWorkerCmd();
        process.exitCode = await cmdWorker(rest);
        break;
      }

      case 'fleet': {
        // M49: fleet control plane + observability — read-only `status`,
        // plus `pause`/`resume` (kill-switch only).
        const cmdFleet = await loadFleetCmd();
        process.exitCode = await cmdFleet(rest);
        break;
      }

      case 'manager': {
        // M120: fleet CEO / oversight agent — frontier-model judge + scorecard.
        // Shadow mode by default: records judgements, never merges.
        const cmdManager = await loadManagerCmd();
        process.exitCode = await cmdManager(rest);
        break;
      }

      case 'vision': {
        // M121: vision / strategist — north-star spec + Elon agent.
        // Mason's touchpoint: show/review/approve/set on the EndStateSpec.
        const cmdVision = await loadVisionCmd();
        process.exitCode = await cmdVision(rest);
        break;
      }

      case 'goal': {
        // M55: the conductor — objective → milestones → sandboxed, proposal-only run.
        const cmdGoal = await loadGoalCmd();
        process.exitCode = await cmdGoal(rest);
        break;
      }

      case 'loop': {
        // M55: the conductor — run the proposal-first fleet over the portfolio.
        const cmdLoop = await loadLoopCmd();
        process.exitCode = await cmdLoop(rest);
        break;
      }

      case 'stack': {
        // M73: surface the ecosystem `stack` tool — read-only status/list/recommend,
        // confirm-gated add/apply (real provisioning).
        const cmdStack = await loadStackCmd();
        process.exitCode = await cmdStack(rest);
        break;
      }

      case 'ask': {
        const cmdAsk = await loadAskCmd();
        process.exitCode = await cmdAsk(rest);
        break;
      }

      case 'knowledge': {
        const cmdKnowledge = await loadKnowledgeCmd();
        process.exitCode = await cmdKnowledge(rest);
        break;
      }

      case 'reflect': {
        const cmdReflect = await loadReflectCmd();
        process.exitCode = await cmdReflect(rest);
        break;
      }

      case 'health': {
        const cmdHealth = await loadHealthCmd();
        process.exitCode = await cmdHealth(rest);
        break;
      }

      case 'goals': {
        const cmdGoals = await loadGoalsCmd();
        process.exitCode = await cmdGoals(rest);
        break;
      }

      case 'digest': {
        const cmdDigest = await loadDigestCmd();
        process.exitCode = await cmdDigest(rest);
        break;
      }

      case 'seams': {
        const cmdSeams = await loadSeamsCmd();
        process.exitCode = await cmdSeams(rest);
        break;
      }

      case 'verify-safety': {
        const cmdVerifySafety = await loadVerifySafetyCmd();
        process.exitCode = await cmdVerifySafety(rest);
        break;
      }

      case 'preflight': {
        const cmdPreflight = await loadPreflightCmd();
        process.exitCode = await cmdPreflight(rest);
        break;
      }

      case 'onboard': {
        const cmdOnboard = await loadOnboardCmd();
        process.exitCode = await cmdOnboard(rest);
        break;
      }

      case 'demo': {
        const cmdDemo = await loadDemoCmd();
        process.exitCode = await cmdDemo(rest);
        break;
      }

      case 'orient': {
        const cmdOrient = await loadOrientCmd();
        process.exitCode = await cmdOrient(rest);
        break;
      }

      case 'docs': {
        const cmdDocs = await loadDocsCmd();
        process.exitCode = await cmdDocs(rest);
        break;
      }

      case 'completions': {
        const cmdCompletions = await loadCompletionsCmd();
        process.exitCode = await cmdCompletions(rest);
        break;
      }

      case 'plugins': {
        const cmdPlugins = await loadPluginsCmd();
        process.exitCode = await cmdPlugins(rest);
        break;
      }

      case 'x': {
        const cmdX = await loadXCmd();
        process.exitCode = await cmdX(rest);
        break;
      }

      case 'comms': {
        const cmdComms = await loadCommsCmd();
        process.exitCode = await cmdComms(rest);
        break;
      }

      case 'director': {
        // M257: Elon Director — strategic reasoning cycle (read+reason+communicate).
        const cmdDirector = await loadDirectorCmd();
        process.exitCode = await cmdDirector(rest);
        break;
      }

      case 'best-of-n': {
        const cmdBestOfN = await loadBestOfNCmd();
        process.exitCode = await cmdBestOfN(rest);
        break;
      }

      case 'invent': {
        // M181: generative engine — invent bold, net-new features for a repo.
        const cmdInvent = await loadInventCmd();
        process.exitCode = await cmdInvent(rest);
        break;
      }

      case 'resources': {
        // M253: Resource Control Plane god-view — per-backend availability/used%/cap/resets.
        const cmdResources = await loadResourcesCmd();
        process.exitCode = await cmdResources(rest);
        break;
      }

      case 'usage': {
        // M194: frontier usage table — per-engine calls/tokens/cost + window state.
        const cmdUsage = await loadUsageCmd();
        process.exitCode = await cmdUsage(rest);
        break;
      }

      case 'version':
      case '--version':
      case '-v': {
        // ASHLR_VERSION is set by the Bun SEA shim (build-sea.mjs) because
        // createRequire(import.meta.url) cannot resolve package.json from
        // inside Bun's virtual FS (/$bunfs/root/…) at runtime.
        let version = process.env.ASHLR_VERSION;
        if (!version) {
          try {
            const { createRequire } = await import('node:module');
            const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
            version = pkg.version;
          } catch {
            version = 'unknown';
          }
        }
        console.log(version);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
        await cmdHelp(rest);
        break;

      default: {
        console.error(red(`Unknown command: ${cmd}`));
        // M31: "did you mean" — best-effort, never blocks the error path.
        try {
          const { didYouMean } = await import('./completions.js');
          const suggestion = didYouMean(cmd);
          if (suggestion) console.error(`Did you mean ${cyan(`ashlr ${suggestion}`)}?`);
        } catch { /* suggestion is best-effort */ }
        console.error(dim('Run `ashlr help` for usage.'));
        process.exit(2);
      }
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
