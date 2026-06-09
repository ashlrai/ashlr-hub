/**
 * core/dashboard.ts — M13 DashboardSnapshot aggregator.
 *
 * Builds a single bounded, read-only DashboardSnapshot by calling the
 * existing data-source modules. Called on every TUI refresh tick (~2s) and
 * by Raycast views; must be fast (<1s) and NEVER throw.
 *
 * MCP health strategy: discoverMcpServers() is synchronous and fast (file
 * reads only). probeServer() is async and spawns child processes — far too
 * slow to call on every tick. We use the discovered spec list as a
 * "last-known configured" proxy: each server is reported ok:true, tools:0
 * (configured but tool count unknown without probing). This keeps the
 * snapshot bounded and sub-second while still surfacing which servers are
 * configured.
 *
 * Genome strategy: we call loadGenome() directly (bounded, never-throws, no
 * child process) and derive entry + distinct-project counts from it. We do
 * NOT call genomeHealth() because it invokes probeEmbeddingsSync(), which
 * runs execFileSync('curl', ...) with a ~2.5s timeout — a synchronous child
 * spawn that would block the event loop (and thus keypress handling) on the
 * ~2s refresh tick. loadGenome keeps the snapshot sub-second and non-blocking.
 *
 * All partial failures degrade to zeroed/empty fields — snapshot is always
 * returned, never null.
 */

import { loadIndex } from './index-engine.js';
import { getToolsRegistry } from './tools-registry.js';
import { buildRollup } from './observability/rollup.js';
import { listRuns } from './run/orchestrator.js';
import { listSwarms } from './swarm/store.js';
import { discoverMcpServers } from './mcp-registry.js';
import { loadGenome } from './genome/store.js';
import type { AshlrConfig, DashboardSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Caps — keep snapshot fast and memory-bounded
// ---------------------------------------------------------------------------

/** Max recent runs to include in the snapshot. */
const MAX_RUNS = 8;

/** Max recent swarms to include in the snapshot. */
const MAX_SWARMS = 8;

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

/**
 * Aggregate a DashboardSnapshot from all hub data sources.
 *
 * Calls: loadIndex, getToolsRegistry, buildRollup('7d'), listRuns,
 * listSwarms, discoverMcpServers, loadGenome.
 *
 * Contract:
 *  - Async (callers can await without blocking the event loop for I/O).
 *  - NEVER throws — any failure degrades its field to zero/empty.
 *  - Fast: all underlying calls are synchronous file reads + no child
 *    process spawns (MCP probing is skipped; genome embedding probe is
 *    skipped). Sub-1s on typical machines.
 */
export async function buildSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot> {
  const generatedAt = new Date().toISOString();

  // ── Repos roll-up (from index) ──────────────────────────────────────────
  let reposTotal = 0;
  let reposDirty = 0;
  let reposStale = 0;

  try {
    const index = loadIndex();
    if (index) {
      for (const item of index.items) {
        if (item.kind !== 'repo') continue;
        reposTotal++;
        if ((item.git?.dirty ?? 0) > 0) reposDirty++;
        if (!item.active) reposStale++;
      }
    }
  } catch {
    // Degrade to zeros.
  }

  // ── Tools roll-up ────────────────────────────────────────────────────────
  let toolsInstalled = 0;
  let toolsTotal = 0;

  try {
    const registry = getToolsRegistry();
    toolsInstalled = registry.installedCount;
    toolsTotal = registry.tools.length;
  } catch {
    // Degrade to zeros.
  }

  // ── Activity roll-up (7d observability) ─────────────────────────────────
  let activitySessions = 0;
  let activityTokens = 0;
  let activityCostUsd = 0;
  let activityCommits = 0;

  try {
    const rollup = buildRollup('7d', cfg);
    activitySessions = rollup.totals.sessions;
    activityTokens = rollup.totals.tokensIn + rollup.totals.tokensOut;
    activityCostUsd = rollup.totals.estCostUsd;
    activityCommits = rollup.totals.commits;
  } catch {
    // Degrade to zeros.
  }

  // ── Recent runs ─────────────────────────────────────────────────────────
  const runs: DashboardSnapshot['runs'] = [];

  try {
    const allRuns = listRuns();
    for (const run of allRuns.slice(0, MAX_RUNS)) {
      runs.push({
        id: run.id,
        goal: run.goal,
        status: run.status,
        tokens: (run.usage?.tokensIn ?? 0) + (run.usage?.tokensOut ?? 0),
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── Recent swarms ────────────────────────────────────────────────────────
  const swarms: DashboardSnapshot['swarms'] = [];

  try {
    const allSwarms = listSwarms();
    for (const swarm of allSwarms.slice(0, MAX_SWARMS)) {
      // Compute burndown from per-task execution state.
      const tasksDone = swarm.tasks.filter(
        (t) => t.status === 'done' || t.status === 'skipped',
      ).length;
      const tasksTotal = swarm.tasks.length;

      // Current phase: the phase of the first running task, or the last
      // non-pending phase seen (i.e. the most advanced phase in progress).
      let currentPhase: string | undefined;
      const runningTask = swarm.tasks.find((t) => t.status === 'running');
      if (runningTask) {
        currentPhase = runningTask.phase;
      } else {
        // Pick the phase of the most recently completed/failed task.
        for (let i = swarm.tasks.length - 1; i >= 0; i--) {
          const t = swarm.tasks[i]!;
          if (t.status === 'done' || t.status === 'failed') {
            currentPhase = t.phase;
            break;
          }
        }
      }

      swarms.push({
        id: swarm.id,
        goal: swarm.goal,
        status: swarm.status,
        tasksDone,
        tasksTotal,
        ...(currentPhase !== undefined ? { phase: currentPhase } : {}),
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── MCP servers (discovered, not probed) ─────────────────────────────────
  // We use the fast synchronous discovery path only. Each configured server
  // is reported ok:true (configured = likely functional), tools:0 (unknown
  // without spawning). This keeps the snapshot sub-second.
  const mcp: DashboardSnapshot['mcp'] = [];

  try {
    const registry = discoverMcpServers();
    for (const server of registry.servers) {
      mcp.push({
        name: server.name,
        ok: true,
        tools: 0,
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── Genome roll-up ───────────────────────────────────────────────────────
  // Use the probe-free loadGenome() (bounded, never-throws, no child
  // process) rather than genomeHealth(), which would synchronously spawn
  // curl to probe Ollama embeddings and block the refresh/keypress loop.
  let genomeEntries = 0;
  let genomeProjects = 0;

  try {
    const entries = loadGenome(cfg);
    genomeEntries = entries.length;
    const projectSet = new Set<string>();
    for (const e of entries) {
      if (e.project) projectSet.add(e.project);
    }
    genomeProjects = projectSet.size;
  } catch {
    // Degrade to zeros.
  }

  return {
    generatedAt,
    repos: {
      total: reposTotal,
      dirty: reposDirty,
      stale: reposStale,
    },
    tools: {
      installed: toolsInstalled,
      total: toolsTotal,
    },
    activity: {
      sessions: activitySessions,
      tokens: activityTokens,
      estCostUsd: activityCostUsd,
      commits: activityCommits,
    },
    runs,
    swarms,
    mcp,
    genome: {
      entries: genomeEntries,
      projects: genomeProjects,
    },
  };
}
