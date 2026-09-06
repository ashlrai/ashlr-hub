/**
 * core/web/api.ts — M14 JSON API handler.
 *
 * Handles all /api/* routes for the local web dashboard. Returns true if it
 * handled the request (so server.ts does NOT fall through to static serving),
 * false otherwise.
 *
 * Read-only routes (the server boundary authenticates these before dispatch;
 * direct handleApi callers are responsible for establishing read authority):
 *   GET /api/snapshot          -> buildSnapshot(cfg)
 *   GET /api/config/effective  -> effective autonomy/daemon/foundry/backend config
 *   GET /api/portfolio         -> buildSnapshot(cfg).portfolio | null (read-only; M29)
 *   GET /api/runs              -> listRuns()
 *   GET /api/run/:id           -> loadRun(id) | 404
 *   GET /api/run/:id/events    -> per-run SSE tail (run-stream.ts) | 400/404
 *   GET /api/swarms            -> listSwarms()
 *   GET /api/swarm/:id         -> loadSwarm(id) | 404
 *   GET /api/pulse?window=7d   -> buildRollup(window, cfg)
 *   GET /api/genome[?q=...]    -> recall(q, cfg) | loadGenome(cfg)
 *   GET /api/inbox             -> listProposals({status:'pending'}) (read-only; M23)
 *   GET /api/autonomy/evidence -> list autonomy evidence packs (metadata only)
 *   GET /api/daemon            -> strict provenance-bearing daemon observation
 *   GET /api/agent-os          -> authenticated observation-only Agent OS snapshot
 *   GET /api/events            -> Server-Sent Events stream
 *
 * Mutating routes (ONLY when ctx.allowDispatch === true + token header):
 *   POST /api/run              -> runGoal (budget-capped, local-first)
 *   POST /api/open             -> openInEditor/openInFinder for an enrolled repo path (M100)
 *   POST /api/fleet/pause      -> engage the fleet kill switch
 *   POST /api/fleet/resume     -> clear the fleet kill switch
 *   POST /api/daemon/service/repair -> fail closed pending signed repair authority
 *
 * SECURITY:
 *  - Never throws (500 on internal error).
 *  - Metadata only — no secret values ever serialised.
 *  - No outward/SSRF calls.
 *  - POST /api/run: 404 when !allowDispatch; constant-time token compare;
 *    requires Content-Type: application/json (415 otherwise); budget clamped,
 *    allowCloud:false always.
 *  - SSE: bounded poll, capped concurrent connections, timers cleared on
 *    client disconnect AND on server close() via the returned cleanup registry
 *    (tracked by server.ts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { basename, resolve as resolvePath, sep as pathSep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * M341c (win32): canonicalize a path for COMPARISON only. Windows paths can
 * differ by 8.3 short names (RUNNER~1 vs runneradmin) and case while naming
 * the same directory — exact string equality 403'd every /api/open there.
 * POSIX is untouched (identity) so existing behavior stays byte-identical.
 */
function canonForCompare(p: string): string {
  if (process.platform !== 'win32') return p;
  let out = p;
  try {
    out = realpathSync.native(p);
  } catch {
    // nonexistent path — compare the resolved spelling
  }
  return out.toLowerCase();
}

import type { AshlrConfig, DaemonState, ProposalStatus } from '../types.js';
import { buildSnapshot, type DashboardSnapshotWithSourceQuality } from '../dashboard.js';
import { loadEffectiveConfigSnapshot } from '../effective-config.js';
import { listRuns, loadRun, runGoal } from '../run/orchestrator.js';
import { listSwarms, loadSwarm } from '../swarm/store.js';
import { buildRollup } from '../observability/rollup.js';
import { loadGenome } from '../genome/store.js';
import { recall } from '../genome/recall.js';
import { listProposals, loadProposal, setStatus } from '../inbox/store.js';
import {
  readPublicDaemonObservation,
  type PublicDaemonObservation,
} from '../daemon/public-observation.js';
import { serviceStatus } from '../daemon/service.js';
import { daemonServiceInstallOptions } from '../daemon/service-config.js';
import { buildFleetStatus, readFleetDaemonStatus } from '../fleet/status.js';
import { getCachedFleetStatus, primeFleetStatusCache } from './fleet-status-cache.js';
// M61: Mission Control aggregator.
import { buildControlSnapshot } from './control.js';
// M90: Fleet-Activity panel.
import { buildFleetActivity } from './control.js';
// M100: desktop-open actions — reuse CLI launchers (read-only import; no mutation).
import { openInEditor, openInFinder } from '../../cli/open.js';
import { listEnrolled, setKill } from '../sandbox/policy.js';
import { listGoals } from '../goals/store.js';
import { progressOf } from '../goals/advance.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { ReadProjectionError, type ReadProjectionReader } from './read-projections.js';
import type { MissionShadowObservation } from '../vision/mission-shadow-observer.js';
import { readAgentOsRuntimeSnapshotV1 } from '../vision/agent-os-runtime-read.js';
import { readUniverseOverview } from '../universe/index.js';
import type { ProposalsReadResult } from '../inbox/store.js';
import { handleRunEventsSse, RUN_EVENTS_PATH_RE } from './run-stream.js';

// ---------------------------------------------------------------------------
// SSE registry — shared across all open SSE connections so server.ts can
// drain them on close(). Module-level so the close() callback in server.ts
// can import and call drainSseConnections().
// ---------------------------------------------------------------------------

/** Active SSE cleanup functions, keyed by a random connection id. */
const _sseCleanups = new Map<string, { cleanup: () => void; sessionId: string }>();

/**
 * Register a cleanup callback for an SSE connection.
 * Returns the id so it can be deregistered on close.
 *
 * Exported so src/core/web/run-stream.ts (the per-run SSE tail) shares the
 * exact same connection registry/cap as the general /api/events stream —
 * one pool of "how many live SSE sockets does this process hold open",
 * not two independently-capped pools.
 */
export function registerSse(cleanup: () => void, sessionId: string): string {
  const id = randomBytes(8).toString('hex');
  _sseCleanups.set(id, { cleanup, sessionId });
  return id;
}

/** Remove a registered SSE cleanup. */
export function deregisterSse(id: string): void {
  _sseCleanups.delete(id);
}

/** True once the shared SSE connection pool is at capacity. */
export function sseConnectionCapReached(): boolean {
  return _sseCleanups.size >= SSE_MAX_CONNECTIONS;
}

/**
 * Drain all open SSE connections (called by server.ts close()).
 * Each cleanup clears the interval and ends the response.
 */
export function drainSseConnections(): void {
  for (const { cleanup } of _sseCleanups.values()) {
    try {
      cleanup();
    } catch {
      // Best-effort.
    }
  }
  _sseCleanups.clear();
  sseHistoryProjection = null;
}

/** Revoke only streams authenticated by one exact browser session. */
export function drainSseSession(sessionId: string): void {
  for (const [id, entry] of _sseCleanups) {
    if (entry.sessionId !== sessionId) continue;
    try { entry.cleanup(); } catch { /* best effort */ }
    _sseCleanups.delete(id);
  }
}

// ---------------------------------------------------------------------------
// SSE poll interval — bounded, not configurable by callers.
// ---------------------------------------------------------------------------

const SSE_POLL_MS = 1500;
const SSE_HISTORY_CACHE_MS = 1000;

/**
 * Maximum concurrent SSE connections. Each connection holds a socket + a
 * bounded poll timer; cap the total so a scripted local client (or non-browser
 * process on the loopback interface) cannot open an unbounded number of
 * EventSource connections for a local resource-exhaustion DoS. Browsers
 * self-limit to ~6 per origin, but the server must not rely on that.
 */
const SSE_MAX_CONNECTIONS = 64;

interface SseHistoryProjection {
  runs: unknown;
  swarms: unknown;
  expiresAt: number;
}

let sseHistoryProjection: SseHistoryProjection | null = null;

const SNAPSHOT_CACHE_MS = 5_000;

interface SnapshotCacheEntry {
  value: DashboardSnapshotWithSourceQuality | null;
  expiresAt: number;
  inFlight: Promise<DashboardSnapshotWithSourceQuality> | null;
}

const snapshotCache = new WeakMap<AshlrConfig, SnapshotCacheEntry>();

function buildCachedSnapshot(
  cfg: AshlrConfig,
  projections?: ReadProjectionReader,
): Promise<DashboardSnapshotWithSourceQuality> {
  const now = Date.now();
  let entry = snapshotCache.get(cfg);
  if (!entry) {
    entry = { value: null, expiresAt: 0, inFlight: null };
    snapshotCache.set(cfg, entry);
  }
  if (entry.value && now < entry.expiresAt) return Promise.resolve(entry.value);
  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = (projections ? projections.read('snapshot') : buildSnapshot(cfg)).then((value) => {
    entry!.value = value;
    entry!.expiresAt = Date.now() + SNAPSHOT_CACHE_MS;
    return value;
  }).finally(() => {
    entry!.inFlight = null;
  });
  return entry.inFlight;
}

/** Discard read projections after an authenticated mutation attempt. */
export function invalidateWebReadCaches(cfg: AshlrConfig): void {
  snapshotCache.delete(cfg);
  sseHistoryProjection = null;
}

function legacyDaemonProjection(
  observation: PublicDaemonObservation,
): DaemonState {
  return {
    running: observation.running === true,
    pid: observation.pid,
    startedAt: observation.startedAt,
    lastTickAt: observation.lastTickAt,
    todayDate: observation.todayDate,
    todaySpentUsd: observation.todaySpentUsd ?? 0,
    itemsProcessed: observation.itemsProcessed ?? 0,
    ticks: observation.ticks ?? [],
    ...(observation.automaticDrainOrdinaryTurnDue !== undefined
      ? { automaticDrainOrdinaryTurnDue: observation.automaticDrainOrdinaryTurnDue }
      : {}),
    ...(observation.lastPulseExportAt !== undefined
      ? { lastPulseExportAt: observation.lastPulseExportAt }
      : {}),
  };
}

async function readFreshDaemonObservation(projections?: ReadProjectionReader): Promise<PublicDaemonObservation> {
  // Await this only after the enclosing snapshot so authority is observed last.
  if (projections) {
    try { return await projections.read('daemon-observation'); }
    catch { return readPublicDaemonObservation(undefined); }
  }
  try {
    const read = await readFleetDaemonStatus();
    return readPublicDaemonObservation(read.daemon);
  } catch {
    return readPublicDaemonObservation(undefined);
  }
}

function withFreshDaemonObservation(
  snapshot: DashboardSnapshotWithSourceQuality,
  observation: PublicDaemonObservation,
): DashboardSnapshotWithSourceQuality {
  const pendingProposals = snapshot.inbox?.pending ?? 0;
  return {
    ...snapshot,
    daemon: {
      running: observation.running === true,
      todaySpentUsd: observation.todaySpentUsd ?? 0,
      pendingProposals,
    },
    daemonObservation: {
      ...observation,
      pendingProposals,
    },
  };
}

type VisionMissionSourceState = 'missing' | 'healthy' | 'degraded';

interface VisionMissionSourceStatus {
  sourceState: VisionMissionSourceState;
  sourcePresent: boolean;
  complete: boolean;
  reason: string;
}

const PUBLIC_MISSION_SHADOW_EFFECTS = Object.freeze({
  goals: false,
  milestones: false,
  repositories: false,
  agents: false,
  proposals: false,
  merges: false,
  releases: false,
  deployments: false,
  publications: false,
  externalMutations: false,
  policy: false,
  budgets: false,
});
const PUBLIC_MISSION_SHADOW_STATES = new Set(['would-create', 'held', 'missing', 'withheld']);
const PUBLIC_MISSION_NODE_KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;

function publicMissionShadowUnavailable(
  reason: string,
  state: 'unavailable' | 'withheld' = 'unavailable',
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'shadow',
    authority: 'observation-only',
    state,
    reason: publicMissionText(reason, 80),
    decision: null,
    effects: PUBLIC_MISSION_SHADOW_EFFECTS,
  };
}

function publicMissionProposalSource(proposals: ProposalsReadResult): Record<string, unknown> {
  return {
    sourceState: proposals.sourceState,
    sourcePresent: proposals.sourcePresent,
    complete: proposals.complete,
    filesRead: proposals.filesRead,
    unreadableFiles: proposals.unreadableFiles,
    invalidFiles: proposals.invalidFiles,
    stopReasons: proposals.stopReasons.slice(0, 8),
    limitExceeded: proposals.stopReasons.some((reason) =>
      reason === 'file-limit' || reason === 'byte-limit' || reason === 'per-file-byte-limit'),
  };
}

function publicMissionShadow(
  observation: MissionShadowObservation,
  nodeKinds: ReadonlyMap<string, 'work' | 'human-gate'>,
): Record<string, unknown> {
  const rawDecision = observation.suggestion?.decision;
  const rawNodeKey = rawDecision?.nodeKey;
  const nodeKey = typeof rawNodeKey === 'string' && PUBLIC_MISSION_NODE_KEY_RE.test(rawNodeKey)
    ? rawNodeKey
    : null;
  const disposition = rawDecision?.disposition === 'would-create' || rawDecision?.disposition === 'hold'
    ? rawDecision.disposition
    : null;
  const decision = disposition === null
    ? null
    : {
        disposition,
        reason: publicMissionText(rawDecision?.reason, 80),
        nodeKey,
        kind: nodeKey === null ? null : nodeKinds.get(nodeKey) ?? null,
      };
  const state = PUBLIC_MISSION_SHADOW_STATES.has(observation.state)
    ? observation.state
    : 'withheld';
  return {
    schemaVersion: 1,
    mode: 'shadow',
    authority: 'observation-only',
    state,
    reason: publicMissionText(observation.reason, 80),
    decision,
    effects: PUBLIC_MISSION_SHADOW_EFFECTS,
  };
}

function publicMissionRepo(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = value.trim().replace(/\\/g, '/');
  return basename(normalized).slice(0, 128) || null;
}

function publicMissionText(value: unknown, max = 1_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function publicMissionTextList(value: unknown, maxItems = 8, maxText = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = publicMissionText(entry, maxText);
    return text === null ? [] : [text];
  }).slice(0, maxItems);
}

const PUBLIC_MISSION_GRAPH_STATUSES = new Set([
  'blocked', 'ready', 'in-progress', 'awaiting-human', 'complete', 'failed',
]);
const PUBLIC_MISSION_NODE_STATUSES = new Set([
  'blocked', 'ready', 'active', 'proposed', 'awaiting-human', 'complete', 'failed',
]);

function publicMissionGraph(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const graph = value as Record<string, unknown>;
  if (graph['state'] !== 'valid' && graph['state'] !== 'invalid') return null;
  const rawNodes = Array.isArray(graph['nodes']) ? graph['nodes'] : [];
  const nodes = rawNodes.slice(0, 24).flatMap((rawNode) => {
    if (typeof rawNode !== 'object' || rawNode === null || Array.isArray(rawNode)) return [];
    const node = rawNode as Record<string, unknown>;
    const key = publicMissionText(node['key'], 80);
    const status = typeof node['status'] === 'string' && PUBLIC_MISSION_NODE_STATUSES.has(node['status'])
      ? node['status']
      : null;
    if (key === null || status === null) return [];
    return [{
      key,
      status,
      blockedBy: publicMissionTextList(node['blockedBy'], 8, 80),
    }];
  });
  const status = typeof graph['status'] === 'string' && PUBLIC_MISSION_GRAPH_STATUSES.has(graph['status'])
    ? graph['status']
    : null;
  const digest = typeof graph['digest'] === 'string' && /^[a-f0-9]{64}$/.test(graph['digest'])
    ? graph['digest']
    : null;
  return {
    state: graph['state'],
    digest,
    issues: publicMissionTextList(graph['issues'], 12, 160),
    ...(status === null ? {} : { status }),
    nodes,
  };
}

function publicMissionBriefing(briefing: Record<string, unknown>): Record<string, unknown> {
  const rawGoals = Array.isArray(briefing['proposedGoals']) ? briefing['proposedGoals'] : [];
  return {
    generatedAt: publicMissionText(briefing['generatedAt'], 40),
    project: publicMissionRepo(briefing['project']),
    currentState: publicMissionText(briefing['currentState'], 4_000),
    gapToVision: publicMissionText(briefing['gapToVision'], 4_000),
    recommendedDirection: publicMissionTextList(briefing['recommendedDirection'], 8, 1_000),
    newProblems: publicMissionTextList(briefing['newProblems'], 8, 1_000),
    questionsForMason: publicMissionTextList(briefing['questionsForMason'], 8, 1_000),
    proposedGoals: rawGoals.slice(0, 3).map((goal) => {
      const entry = typeof goal === 'object' && goal !== null
        ? goal as Record<string, unknown>
        : {};
      return {
        key: publicMissionText(entry['key'], 80),
        objective: publicMissionText(entry['objective'], 4_000),
        rationale: publicMissionText(entry['rationale'], 4_000),
        specPriority: publicMissionText(entry['specPriority'], 200),
        targetRepo: publicMissionRepo(entry['targetRepo']),
        dependsOn: publicMissionTextList(entry['dependsOn'], 8, 80),
        deliverable: publicMissionText(entry['deliverable'], 1_000),
        acceptanceEvidence: publicMissionTextList(entry['acceptanceEvidence'], 8, 500),
        riskClass: entry['riskClass'] === 'low' || entry['riskClass'] === 'medium' || entry['riskClass'] === 'high'
          ? entry['riskClass']
          : null,
        humanGate: typeof entry['humanGate'] === 'boolean' ? entry['humanGate'] : null,
        outcome: typeof entry['outcome'] === 'object' && entry['outcome'] !== null && !Array.isArray(entry['outcome'])
          ? {
              desiredOutcome: publicMissionText((entry['outcome'] as Record<string, unknown>)['desiredOutcome'], 1_000),
              successSignals: publicMissionTextList((entry['outcome'] as Record<string, unknown>)['successSignals'], 8, 500),
              guardrails: publicMissionTextList((entry['outcome'] as Record<string, unknown>)['guardrails'], 8, 500),
            }
          : null,
      };
    }),
  };
}

async function buildVisionMissionSnapshot(cfg: AshlrConfig): Promise<Record<string, unknown>> {
  let briefing: Record<string, unknown> | null = null;
  let briefingSource: VisionMissionSourceStatus;
  let strategistModule: typeof import('../vision/strategist.js') | null = null;
  try {
    strategistModule = await import('../vision/strategist.js');
    const read = strategistModule.readLatestBriefingDetailed();
    briefing = read.briefing as unknown as Record<string, unknown> | null;
    briefingSource = {
      sourceState: read.sourceState,
      sourcePresent: read.sourcePresent,
      complete: read.complete,
      reason: read.reason,
    };
  } catch {
    briefingSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      reason: 'briefing-reader-unavailable',
    };
  }

  if (briefing === null) {
    return {
      schemaVersion: 1,
      state: briefingSource.sourceState,
      authority: 'planning-only',
      briefing: null,
      preview: null,
      shadow: publicMissionShadowUnavailable('briefing-missing'),
      sources: {
        briefing: briefingSource,
        goals: null,
        enrollment: null,
        proposals: null,
      },
    };
  }

  try {
    const [strategist, goals, completion, focus, policy, inbox, shadowObserver] = await Promise.all([
      strategistModule ?? import('../vision/strategist.js'),
      import('../goals/store.js'),
      import('../goals/completion.js'),
      import('../goals/focus.js'),
      import('../sandbox/policy.js'),
      import('../inbox/store.js'),
      import('../vision/mission-shadow-observer.js'),
    ]);
    const inventory = goals.listGoalsDetailed();
    const proposals = inbox.listProposalsDetailed({ requireComplete: true });
    const enrollment = policy.readEnrollmentRegistry();
    if (enrollment.state === 'degraded') {
      return {
        schemaVersion: 1,
        state: 'degraded',
        authority: 'planning-only',
        briefing: publicMissionBriefing(briefing),
        preview: null,
        shadow: publicMissionShadowUnavailable('enrollment-source-incomplete', 'withheld'),
        sources: {
          briefing: briefingSource,
          goals: {
            sourceState: inventory.sourceState,
            sourcePresent: inventory.sourcePresent,
            complete: inventory.complete,
            scannedFiles: inventory.scannedFiles,
            unreadableFiles: inventory.unreadableFiles,
            limitExceeded: inventory.limitExceeded,
          },
          enrollment: {
            sourceState: 'degraded', sourcePresent: true, complete: false,
            reason: enrollment.reason,
          },
          proposals: publicMissionProposalSource(proposals),
        },
      };
    }
    const enrolledRepos = enrollment.repos;
    const proposalById = new Map(proposals.proposals.map((proposal) => [proposal.id, proposal]));
    const preview = strategist.previewBriefingAdoption(
      briefing as unknown as Parameters<typeof strategist.previewBriefingAdoption>[0],
      {
        enrolledRepos,
        existingGoals: inventory.goals,
        goalSourceState: inventory.sourceState,
        activeThreshold: focus.goalFocusActiveThreshold(cfg),
        goalRealized: (goal) => {
          const required = goal.milestones.filter((milestone) => milestone.status !== 'skipped');
          return required.length > 0 && required.every((milestone) =>
            milestone.proposalId !== null &&
            completion.proposalCompletesGoalMilestone(proposalById.get(milestone.proposalId)),
          );
        },
      },
    );
    const graphResult = strategist.compileBriefingMissionGraph(
      briefing as unknown as Parameters<typeof strategist.compileBriefingMissionGraph>[0],
      enrolledRepos,
    );
    let shadow = publicMissionShadowUnavailable('mission-graph-invalid', 'withheld');
    if (graphResult?.ok) {
      try {
        shadow = publicMissionShadow(shadowObserver.observeMissionReconcileShadow({
          recordedAt: new Date().toISOString(),
          graph: graphResult.graph,
          briefing: briefing as unknown as Parameters<typeof strategist.compileBriefingMissionGraph>[0],
          briefingQuality: {
            sourceState: briefingSource.sourceState,
            sourcePresent: briefingSource.sourcePresent,
            complete: briefingSource.complete,
          },
          enrollment,
          goals: inventory,
          proposals,
          preview,
        }), new Map(graphResult.graph.nodes.map((node) => [node.key, node.kind])));
      } catch {
        shadow = publicMissionShadowUnavailable('shadow-observer-unavailable');
      }
    }
    const goalSource = {
      sourceState: inventory.sourceState,
      sourcePresent: inventory.sourcePresent,
      complete: inventory.complete,
      scannedFiles: inventory.scannedFiles,
      unreadableFiles: inventory.unreadableFiles,
      limitExceeded: inventory.limitExceeded,
    };
    const state = briefingSource.sourceState === 'healthy' && inventory.sourceState !== 'degraded' &&
      proposals.sourceState !== 'degraded' && proposals.complete === true &&
      preview.missionGraph?.state !== 'invalid'
      ? 'healthy'
      : 'degraded';
    return {
      schemaVersion: 1,
      state,
      authority: 'planning-only',
      briefing: publicMissionBriefing(briefing),
      shadow,
      preview: {
        briefingGeneratedAt: publicMissionText(preview.briefingGeneratedAt, 40),
        goalSourceState: preview.goalSourceState,
        activeThreshold: preview.activeThreshold,
        openGoalCount: preview.openGoalCount,
        availableSlots: preview.availableSlots,
        proposedCount: preview.proposedCount,
        createCount: preview.createCount,
        skippedCount: preview.skippedCount,
        entries: preview.entries.map((entry) => ({
          index: entry.index,
          objective: entry.objective,
          targetRepo: publicMissionRepo(entry.targetRepo),
          disposition: entry.disposition,
          reason: entry.reason,
        })),
        ...(preview.missionGraph ? { missionGraph: publicMissionGraph(preview.missionGraph) } : {}),
      },
      sources: {
        briefing: briefingSource,
        goals: goalSource,
        enrollment: {
          sourceState: 'healthy',
          sourcePresent: enrolledRepos.length > 0,
          complete: true,
          enrolledRepos: enrolledRepos.length,
          reason: enrollment.reason,
        },
        proposals: publicMissionProposalSource(proposals),
      },
    };
  } catch {
    return {
      schemaVersion: 1,
      state: 'degraded',
      authority: 'planning-only',
      briefing: publicMissionBriefing(briefing),
      preview: null,
      shadow: publicMissionShadowUnavailable('shadow-observer-unavailable'),
      sources: {
        briefing: briefingSource,
        goals: {
          sourceState: 'degraded', sourcePresent: true, complete: false,
          reason: 'mission-preview-unavailable',
        },
        enrollment: null,
        proposals: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON response. Never throws. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const boundedBody = body && typeof body === 'object' && 'error' in body
      ? { ...body, error: String((body as { error: unknown }).error).slice(0, 512) }
      : body;
    const payload = JSON.stringify(sanitizePublicJson(boundedBody) ?? null);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end('{"error":"internal error"}');
    } catch {
      // Socket already closed — swallow.
    }
  }
}

/** Write a 500 JSON error. Never throws. */
function send500(res: ServerResponse, msg = 'internal error'): void {
  void msg; // retained at call sites for private diagnostics; never disclose it.
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
}

/**
 * Constant-time string comparison to defend against timing attacks.
 * Returns true iff a === b (both strings, same bytes).
 */
function safeEqual(a: string, b: string): boolean {
  try {
    // Both must be the same byte length for timingSafeEqual.
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Parse and validate the `window` query param for /api/pulse.
 * Allowed: '1d' | '7d' | '30d'; default '7d'.
 */
function parseWindow(raw: string | undefined): '1d' | '7d' | '30d' {
  if (raw === '1d' || raw === '7d' || raw === '30d') return raw;
  return '7d';
}

/**
 * Safely read the full request body as a string (bounded to 64 KB).
 * Rejects on oversized or errored requests.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const MAX_BYTES = 65_536;
    let buf = '';
    let total = 0;

    req.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      total += Buffer.byteLength(s, 'utf8');
      if (total > MAX_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      buf += s;
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * Extract the value of a query parameter from a URL (or URL path string).
 * Returns undefined if not present.
 */
function getQueryParam(url: string, name: string): string | undefined {
  try {
    // URL may be just a path+query — prepend a dummy base so URL() can parse.
    const parsed = new URL(url, 'http://localhost');
    const v = parsed.searchParams.get(name);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * Read a single request header value (collapsing the string[] form Node uses
 * for repeated headers down to its first entry). Returns '' when absent.
 */
function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * The shared gate for the two mutating routes (POST /api/run and the web inbox
 * approve/reject). Enforces, in order:
 *   1. constant-time x-ashlr-token match  -> 401 on mismatch
 *   2. Content-Type: application/json     -> 415 otherwise (CSRF defence in
 *      depth; the token is the real control)
 * Writes the failure response itself and returns false when the request should
 * NOT proceed; returns true when both checks pass.
 */
function passesMutationGate(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return false;
  }
  const contentType = headerValue(req, 'content-type');
  if (!contentType.toLowerCase().trim().startsWith('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

/**
 * Extract the path from the request URL, without query string.
 * Never throws; falls back to '/'.
 */
function reqPath(req: IncomingMessage): string {
  try {
    const raw = req.url ?? '/';
    const parsed = new URL(raw, 'http://localhost');
    return parsed.pathname;
  } catch {
    return '/';
  }
}

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

/** Build the current runs slice payload for SSE. */
function buildSseRunsPayload(runs = listRuns({ limit: 20 })): unknown {
  return runs.slice(0, 20).map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    tokens: (r.usage?.tokensIn ?? 0) + (r.usage?.tokensOut ?? 0),
    updatedAt: r.updatedAt,
  }));
}

/** Build the current swarms slice payload for SSE. */
function buildSseSwarmsPayload(swarms = listSwarms({ limit: 20 })): unknown {
  return swarms.slice(0, 20).map((s) => ({
    id: s.id,
    goal: s.goal,
    status: s.status,
    tasksDone: s.tasks.filter(
      (t) => t.status === 'done' || t.status === 'skipped',
    ).length,
    tasksTotal: s.tasks.length,
    updatedAt: s.updatedAt,
  }));
}

/** Share one bounded history projection across every SSE client in a poll window. */
async function cachedSseHistoryProjection(projections?: ReadProjectionReader): Promise<SseHistoryProjection> {
  const now = Date.now();
  if (sseHistoryProjection && now < sseHistoryProjection.expiresAt) {
    return sseHistoryProjection;
  }
  const history = projections
    ? await Promise.all([projections.read('runs'), projections.read('swarms')])
    : undefined;
  sseHistoryProjection = {
    runs: buildSseRunsPayload(history?.[0]),
    swarms: buildSseSwarmsPayload(history?.[1]),
    expiresAt: Date.now() + SSE_HISTORY_CACHE_MS,
  };
  return sseHistoryProjection;
}

/**
 * Handle GET /api/events: stream run/swarm/snapshot updates as Server-Sent Events (M213).
 *
 * On each poll tick, re-reads listRuns() + listSwarms() and emits NAMED SSE
 * events — `event: runs` and `event: swarms` — each carrying its own JSON
 * payload. The named events match the client's EventSource listeners
 * (es.addEventListener('runs'|'swarms', ...)) so live burndown patches the
 * views without a full reload. (An unnamed `data:` frame would dispatch only
 * to es.onmessage, which the client does not register.)
 *
 * The poll timer is bounded (SSE_POLL_MS) and cleared on:
 *   (a) client disconnect (req 'close' event)
 *   (b) server shutdown (drainSseConnections())
 *
 * Concurrent connections are capped (SSE_MAX_CONNECTIONS) to bound timer/
 * socket growth; excess connections get a 503.
 */
function handleSseEvents(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  allowDispatch: boolean,
  readSession: { id: string; expiresAt: number },
  projections?: ReadProjectionReader,
): void {
  // Cap concurrent SSE connections to bound timer/socket growth.
  if (_sseCleanups.size >= SSE_MAX_CONNECTIONS) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  // Install the response error listener before the first header/body write.
  // The indirection observes the fully wired cleanup once registration is
  // complete, while also preventing an early EventEmitter 'error' crash.
  let cleanup: () => void = () => {};
  if (typeof res.on === 'function') res.on('error', () => cleanup());

  // SSE headers — no buffering, keep-alive.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  // Write an initial comment to flush headers to client.
  try {
    res.write(': connected\n\n');
  } catch {
    return; // Socket already gone.
  }

  // Helper: send one NAMED SSE event so the client's per-name listeners fire.
  let backpressured = false;
  let backpressureTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  function sendNamed(event: string, payload: unknown): void {
    if (cleaned || backpressured) return;
    try {
      const line = `event: ${event}\ndata: ${JSON.stringify(sanitizePublicJson(payload))}\n\n`;
      if (!res.write(line)) {
        backpressured = true;
        // Resolve cleanup when the timer fires; the initial snapshot can
        // backpressure before the fully-wired cleanup closure is assigned.
        backpressureTimer = setTimeout(() => cleanup(), 10_000);
        res.once('drain', () => {
          backpressured = false;
          if (backpressureTimer) clearTimeout(backpressureTimer);
          backpressureTimer = undefined;
        });
      }
    } catch {
      // Socket closed; cleanup will be triggered by 'close' event.
    }
  }

  // A slow snapshot must not let the interval accumulate concurrent full
  // fleet reads. One connection gets at most one in-flight update.
  let updateInFlight = false;

  // Emit one full update (runs, swarms, inbox, daemon slices).
  async function emitUpdate(): Promise<void> {
    if (updateInFlight || backpressured) return;
    updateInFlight = true;
    try {
      try {
        const history = await cachedSseHistoryProjection(projections);
        if (cleaned) return;
        sendNamed('runs', history.runs);
        sendNamed('swarms', history.swarms);
      } catch { /* Keep sending explicit daemon provenance if history is unavailable. */ }
      // M32: live inbox + daemon state for the web command center. Metadata
      // only — the inbox event carries id/title/kind, never diffs.
      try {
        const pending = projections
          ? (await projections.read('proposals')).filter((proposal) => proposal.status === 'pending')
          : listProposals({ status: 'pending' });
        if (cleaned) return;
        sendNamed('inbox', {
          pending: pending.length,
          proposals: pending.slice(0, 20).map((p) => ({
            id: p.id,
            title: p.title,
            kind: p.kind,
            repo: p.repo,
            origin: p.origin,
            createdAt: p.createdAt,
          })),
        });
      } catch { /* inbox slice is best-effort */ }
      let snap: DashboardSnapshotWithSourceQuality | null = null;
      try {
        snap = await buildCachedSnapshot(cfg, projections);
      } catch {
        // Keep the event stream alive with explicit unavailable provenance.
      }
      if (cleaned) return;
      const daemon = await readFreshDaemonObservation(projections);
      if (cleaned) return;
      sendNamed('daemon', legacyDaemonProjection(daemon));
      sendNamed('daemon-observation', daemon);
      // M90: fleet-activity liveness pulse — carry daemon tick count so the
      // Fleet Activity tab can update its "last tick" indicator in real-time
      // without a full /api/fleet-activity poll.
      sendNamed('fleet-activity-ping', {
        running: daemon.running === true,
        lastTickAt: daemon.lastTickAt,
        tickCount: Array.isArray(daemon.ticks) ? daemon.ticks.length : 0,
      });
      sendNamed('fleet-activity-observation', {
        runtimeState: daemon.runtimeState,
        sourceQuality: daemon.sourceQuality,
        running: daemon.running,
        lastTickAt: daemon.lastTickAt,
        tickCount: Array.isArray(daemon.ticks) ? daemon.ticks.length : null,
      });
      // M213: dashboard snapshot push — lets fleet-dashboard update without polling.
      if (snap) {
        sendNamed('snapshot', {
          ...withFreshDaemonObservation(snap, daemon),
          dispatchEnabled: allowDispatch,
        });
      }
    } finally {
      updateInFlight = false;
    }
  }

  // Send an initial snapshot immediately.
  try {
    void emitUpdate().catch(() => { /* A failed read must not reject outside the stream. */ });
  } catch {
    // If the initial read fails, the client gets no data until the next tick.
  }

  // Poll on a bounded interval.
  const intervalId = setInterval(() => {
    try {
      void emitUpdate().catch(() => { /* Retry a failed read on the next bounded tick. */ });
    } catch {
      // Socket may be gone; 'close' event will clean up.
    }
  }, SSE_POLL_MS);

  // Cleanup: clear the interval and end the response.
  cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(intervalId);
    if (backpressureTimer) clearTimeout(backpressureTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    deregisterSse(sseId);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  };

  const sseId = registerSse(cleanup, readSession.id);

  const expiryDelay = readSession.expiresAt - Date.now();
  const expiryTimer = setTimeout(() => {
    sendNamed('session-expired', { expired: true });
    cleanup();
  }, Math.max(0, expiryDelay));

  // Clear on client disconnect.
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Dispatch route (token-guarded, ONLY when allowDispatch === true)
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/run — launch `runGoal` with budget-capped, local-first opts.
 *
 * Security:
 *  - Route does not exist (404) when ctx.allowDispatch is false.
 *  - Requires `x-ashlr-token` header equal to ctx.token (constant-time compare).
 *    Missing/wrong token -> 401.
 *  - Requires `Content-Type: application/json` -> 415 otherwise (defence in
 *    depth against simple-request form-POST CSRF; the token check is the
 *    actual control).
 *  - Body is JSON { goal, budget?, maxSteps?, parallel? }.
 *  - allowCloud is always false; maxTokens and maxSteps are clamped to sane
 *    local-first ceilings (never higher than the CLI defaults).
 */
async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  ctx: { token: string },
): Promise<void> {
  // Token (constant-time) + JSON Content-Type gate — blocks simple-request
  // form-POST CSRF before body parsing (the token is the real control).
  if (!passesMutationGate(req, res, ctx.token)) {
    return;
  }

  // Parse body.
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return;
  }

  const obj = body as Record<string, unknown>;
  const goal = typeof obj['goal'] === 'string' ? obj['goal'].trim() : '';
  if (!goal) {
    sendJson(res, 400, { error: '"goal" (string) is required' });
    return;
  }

  // Local-first budget ceilings — never elevated by caller input.
  const MAX_TOKENS_CEILING = 200_000;
  const MAX_STEPS_CEILING = 40;
  const MAX_PARALLEL_CEILING = 4;

  const rawMaxTokens =
    typeof obj['maxTokens'] === 'number' ? obj['maxTokens'] : MAX_TOKENS_CEILING;
  const rawMaxSteps =
    typeof obj['maxSteps'] === 'number' ? obj['maxSteps'] : MAX_STEPS_CEILING;
  const rawParallel =
    typeof obj['parallel'] === 'number' ? obj['parallel'] : 2;

  const maxTokens = Math.min(Math.max(1, Math.floor(rawMaxTokens)), MAX_TOKENS_CEILING);
  const maxSteps = Math.min(Math.max(1, Math.floor(rawMaxSteps)), MAX_STEPS_CEILING);
  const parallel = Math.min(Math.max(1, Math.floor(rawParallel)), MAX_PARALLEL_CEILING);

  // Run goal (local-first, never cloud).
  try {
    const runState = await runGoal(goal, cfg, {
      budget: {
        maxTokens,
        maxSteps,
        allowCloud: false, // NEVER allow cloud via the dispatch endpoint
      },
      parallel,
      allowCloud: false,
      json: true,
    });

    sendJson(res, 200, {
      id: runState.id,
      status: runState.status,
      goal: runState.goal,
      usage: runState.usage,
      result: runState.result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send500(res, `run failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main handleApi export
// ---------------------------------------------------------------------------

/**
 * Handle a single request if its URL matches an /api/* route.
 *
 * @returns true if the request was an /api/* route and a response was written;
 *          false otherwise (server.ts falls through to static serving).
 *
 * Never throws — all errors are caught and returned as JSON 500 responses.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  ctx: {
    token: string;
    allowDispatch: boolean;
    readSession?: { id: string; expiresAt: number };
    readProjections?: ReadProjectionReader;
  },
): Promise<boolean> {
  const path = reqPath(req);

  // Only handle /api/* paths.
  if (!path.startsWith('/api/') && path !== '/api') {
    return false;
  }

  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // ── GET /api/snapshot ───────────────────────────────────────────────────
    if (path === '/api/snapshot' && method === 'GET') {
      const snapshot = await buildCachedSnapshot(cfg, ctx.readProjections);
      // Read authority after the potentially slow snapshot build so the
      // serialized daemon verdict is the final observation in this response.
      const daemonObservation = await readFreshDaemonObservation(ctx.readProjections);
      // M32: additive field so the frontend can show (not guess) whether the
      // dispatch/approve surfaces exist on this server instance.
      sendJson(res, 200, {
        ...withFreshDaemonObservation(snapshot, daemonObservation),
        dispatchEnabled: ctx.allowDispatch,
      });
      return true;
    }

    // ── GET /api/config/effective ───────────────────────────────────────────
    // Read-only operator config visibility. Re-reads raw config metadata so
    // source labels can distinguish configured values from defaults.
    if (path === '/api/config/effective' && method === 'GET') {
      sendJson(res, 200, loadEffectiveConfigSnapshot());
      return true;
    }

    // ── GET /api/portfolio ────────────────────────────────────────────────────
    // M29: read-only org-level portfolio projection. Reuses buildSnapshot (the
    // same enrollment/index-scoped read as /api/snapshot) and surfaces ONLY the
    // optional `.portfolio` section, or null when it was not populated (older
    // producer / empty enrollment). NO mutation endpoint — there is no apply/
    // approve/dispatch here; aggregation only. Never throws (caught below).
    if (path === '/api/portfolio' && method === 'GET') {
      const snapshot = await buildCachedSnapshot(cfg, ctx.readProjections);
      sendJson(res, 200, snapshot.portfolio ?? null);
      return true;
    }

    // Read-only Mission Outcome Room. This compiles the latest persisted
    // strategist briefing against current goal-focus and enrollment snapshots;
    // it never runs the strategist, adopts a briefing, creates a goal, or grants
    // execution authority.
    if (path === '/api/vision/mission' && method === 'GET') {
      sendJson(res, 200, await buildVisionMissionSnapshot(cfg));
      return true;
    }

    // The server authenticates this persisted experiment projection before
    // dispatch. Reading the population never starts a run or mutates its store.
    if (path === '/api/universe' && method === 'GET') {
      sendJson(res, 200, readUniverseOverview());
      return true;
    }

    // Authenticated by server.ts before dispatch. This route is deliberately
    // read-only and independent from the control snapshot and daemon. The
    // public projection withholds private envelopes and all snapshot values
    // unless the append-only source is complete and authenticated.
    if (path === '/api/agent-os' && method === 'GET') {
      sendJson(res, 200, readAgentOsRuntimeSnapshotV1());
      return true;
    }

    // ── GET /api/runs ────────────────────────────────────────────────────────
    if (path === '/api/runs' && method === 'GET') {
      const runs = ctx.readProjections
        ? await ctx.readProjections.read('runs')
        : listRuns({ limit: 200 });
      sendJson(res, 200, runs);
      return true;
    }

    // ── GET /api/run/:id/events ──────────────────────────────────────────────
    // Per-run SSE tail — genuine live streaming for one run, distinct from
    // /api/events' fleet-wide fanout. Must be matched BEFORE
    // the /api/run/:id prefix check below, which would otherwise treat
    // "<id>/events" as a (nonexistent) run id. See src/core/web/run-stream.ts.
    {
      const eventsMatch = RUN_EVENTS_PATH_RE.exec(path);
      if (eventsMatch && method === 'GET') {
        if (!ctx.readSession || ctx.readSession.expiresAt <= Date.now()) {
          sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
          return true;
        }
        handleRunEventsSse(req, res, eventsMatch[1] ?? '', ctx.readSession);
        return true;
      }
    }

    // ── GET /api/run/:id ─────────────────────────────────────────────────────
    if (path.startsWith('/api/run/') && method === 'GET') {
      const id = path.slice('/api/run/'.length);
      if (!id) {
        sendJson(res, 400, { error: 'run id required' });
        return true;
      }
      const run = loadRun(id);
      if (!run) {
        sendJson(res, 404, { error: `run not found: ${id}` });
        return true;
      }
      sendJson(res, 200, run);
      return true;
    }

    // ── GET /api/swarms ──────────────────────────────────────────────────────
    if (path === '/api/swarms' && method === 'GET') {
      const swarms = ctx.readProjections
        ? await ctx.readProjections.read('swarms')
        : listSwarms({ limit: 200 });
      sendJson(res, 200, swarms);
      return true;
    }

    // ── GET /api/swarm/:id ───────────────────────────────────────────────────
    if (path.startsWith('/api/swarm/') && method === 'GET') {
      const id = path.slice('/api/swarm/'.length);
      if (!id) {
        sendJson(res, 400, { error: 'swarm id required' });
        return true;
      }
      const swarm = loadSwarm(id);
      if (!swarm) {
        sendJson(res, 404, { error: `swarm not found: ${id}` });
        return true;
      }
      sendJson(res, 200, swarm);
      return true;
    }

    // ── GET /api/pulse ───────────────────────────────────────────────────────
    if (path === '/api/pulse' && method === 'GET') {
      const rawWindow = getQueryParam(req.url ?? '', 'window');
      const window = parseWindow(rawWindow);
      const rollup = ctx.readProjections
        ? await ctx.readProjections.read('pulse', { window })
        : buildRollup(window, cfg);
      sendJson(res, 200, rollup);
      return true;
    }

    // ── GET /api/models ──────────────────────────────────────────
    // M335: joined per-model economics — ROI (M322) + real-world outcomes
    // (M332) + best-of-N win rates (M333). Read-only. ?window=7d|30d|all
    // (default 30d).
    if (path === '/api/models' && method === 'GET') {
      const rawW = getQueryParam(req.url ?? '', 'window');
      const statsWindow = rawW === '7d' ? '7d' : rawW === 'all' ? 'all' : '30d';
      const { computeModelStatsDetailed } = await import('../fleet/model-stats.js');
      const stats = computeModelStatsDetailed(statsWindow);
      sendJson(res, 200, { window: statsWindow, ...stats });
      return true;
    }

    // ── GET /api/scorecard ────────────────────────────────────────────────────
    // M356: fleet self-evaluation scorecard — velocity/quality/capability,
    // computed strictly from evidence stores (proposal store + decisions
    // ledger + persisted eval reports). Read-only, additive route mirroring
    // the /api/models pattern above. ?window=7d|30d (default 7d).
    if (path === '/api/scorecard' && method === 'GET') {
      const rawWindow = getQueryParam(req.url ?? '', 'window');
      const scWindow = rawWindow === '30d' ? '30d' : '7d';
      const { computeFleetScorecard } = await import('../fleet/scorecard.js');
      const scorecard = computeFleetScorecard(scWindow);
      sendJson(res, 200, scorecard);
      return true;
    }

    // ── GET /api/genome ──────────────────────────────────────────────────────
    if (path === '/api/genome' && method === 'GET') {
      const q = getQueryParam(req.url ?? '', 'q');
      if (q && q.trim()) {
        // Query mode: use recall.
        const hits = await recall(q, cfg);
        sendJson(res, 200, hits);
      } else {
        // List mode: load all genome entries.
        const entries = loadGenome(cfg);
        sendJson(res, 200, entries);
      }
      return true;
    }

    // ── GET /api/autonomy/evidence[/:id] ────────────────────────────────────
    // Read-only, metadata-only autonomy evidence. Evidence packs intentionally
    // do not contain raw diffs or command output; this endpoint mirrors that.
    if (path === '/api/autonomy/evidence' && method === 'GET') {
      const rawLimit = Number(getQueryParam(req.url ?? '', 'limit') ?? '20');
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;
      const { listAutonomyEvidencePacks } = await import('../autonomy/evidence-pack.js');
      const packs = listAutonomyEvidencePacks(limit);
      sendJson(res, 200, {
        total: packs.length,
        evidence: packs,
      });
      return true;
    }

    if (path.startsWith('/api/autonomy/evidence/') && method === 'GET') {
      const id = path.slice('/api/autonomy/evidence/'.length);
      if (!id || id.includes('/') || !/^[\w.-]+$/.test(id)) {
        sendJson(res, 400, { error: 'valid evidence proposal id required' });
        return true;
      }
      const { readAutonomyEvidencePack } = await import('../autonomy/evidence-pack.js');
      const pack = readAutonomyEvidencePack(id);
      if (!pack) {
        sendJson(res, 404, { error: `evidence pack not found: ${id}` });
        return true;
      }
      sendJson(res, 200, pack);
      return true;
    }

    // Valid `?status=` values for GET /api/inbox — mirrors INBOX_STATUS_FILTERS
    // in src/cli/inbox.ts exactly. `?limit=` beyond the default is capped at
    // INBOX_LIST_HARD_MAX_LIMIT regardless of what the caller asks for.
    const INBOX_STATUS_QUERY_VALUES = new Set<string>([
      'pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed', 'all',
    ]);
    const INBOX_LIST_DEFAULT_LIMIT = 200;
    const INBOX_LIST_HARD_MAX_LIMIT = 1000;

    // ── GET /api/inbox ───────────────────────────────────────────────────────
    // M23: read-only proposals view. Defaults to pending-only, byte-identical
    // to the original response, unless an explicit status/since/limit opts
    // into the "history" view — mirrors `ashlr inbox --status/--since/--limit`
    // (src/cli/inbox.ts) so the web surface can finally browse rejected/
    // approved/etc, not just pending. listProposals never throws; every param
    // is validated against a fixed set / parsed strictly, and the history
    // response is capped (INBOX_LIST_DEFAULT_LIMIT / hard max) so opting into
    // filtering can never hand the browser an unbounded JSON payload.
    if (path === '/api/inbox' && method === 'GET') {
      const statusParam = getQueryParam(req.url ?? '/', 'status');
      const sinceParam = getQueryParam(req.url ?? '/', 'since');
      const limitParam = getQueryParam(req.url ?? '/', 'limit');

      if (statusParam !== undefined && !INBOX_STATUS_QUERY_VALUES.has(statusParam)) {
        sendJson(res, 400, {
          error: `status must be one of: ${[...INBOX_STATUS_QUERY_VALUES].join(', ')}; got: ${statusParam}`,
        });
        return true;
      }
      let sinceMs: number | undefined;
      if (sinceParam !== undefined) {
        const parsed = Date.parse(sinceParam);
        if (Number.isNaN(parsed)) {
          sendJson(res, 400, { error: `since must be an ISO timestamp or YYYY-MM-DD, got: ${sinceParam}` });
          return true;
        }
        sinceMs = parsed;
      }
      let limit: number | undefined;
      if (limitParam !== undefined) {
        const n = /^[0-9]+$/.test(limitParam) ? Number.parseInt(limitParam, 10) : NaN;
        if (!Number.isFinite(n) || n <= 0) {
          sendJson(res, 400, { error: `limit must be a positive integer, got: ${limitParam}` });
          return true;
        }
        limit = Math.min(n, INBOX_LIST_HARD_MAX_LIMIT);
      }

      // No query params at all -> the exact original call/shape (pending
      // only, unbounded). Any explicit status/since/limit opts into history.
      const filtering = statusParam !== undefined || sinceMs !== undefined || limit !== undefined;
      const effectiveStatus: ProposalStatus | 'all' =
        (statusParam as ProposalStatus | 'all' | undefined) ?? (sinceMs !== undefined ? 'all' : 'pending');

      // Offload the full-directory read; filtering/response shape stay identical.
      const all = ctx.readProjections
        ? await ctx.readProjections.read('proposals')
        : listProposals();
      let matched = effectiveStatus === 'all' ? all : all.filter((p) => p.status === effectiveStatus);
      if (sinceMs !== undefined) {
        const floor = sinceMs;
        matched = matched.filter((p) => {
          const t = Date.parse(p.createdAt);
          return !Number.isNaN(t) && t >= floor;
        });
      }

      const shown = filtering ? matched.slice(0, limit ?? INBOX_LIST_DEFAULT_LIMIT) : matched;

      sendJson(res, 200, {
        pending: filtering ? all.filter((p) => p.status === 'pending').length : shown.length,
        total: all.length,
        proposals: shown,
        truncated: matched.length > shown.length,
        filters: { status: effectiveStatus, since: sinceParam ?? null, limit: limit ?? null },
      });
      return true;
    }

    // ── GET /api/inbox/:id — full proposal detail incl. diff (read-only; M32).
    if (path.startsWith('/api/inbox/') && method === 'GET') {
      const id = path.slice('/api/inbox/'.length);
      if (!id || id.includes('/')) {
        sendJson(res, 400, { error: 'proposal id required' });
        return true;
      }
      const proposal = loadProposal(id);
      if (!proposal) {
        sendJson(res, 404, { error: `proposal not found: ${id}` });
        return true;
      }

      // Join the decisions ledger (read-only, additive) so the operator can
      // see the judge's actual verdict/reasonCode for this proposal — a
      // judge-parse-failure/judge-network-failure is an infra failure, NOT a
      // considered judgment, and the ledger is the only place that
      // distinction lives (Proposal itself never carries judgeReasonCode).
      // Never invents a verdict: when the ledger read is degraded or no
      // decision row matches this id, sourceQuality says exactly that so the
      // UI's Epistemic primitive renders "unknown" instead of guessing.
      let decisionEvidence: {
        sourceQuality: { sourceState: 'healthy' | 'degraded' | 'missing'; complete: boolean; reason?: string };
        decisions: unknown[];
      };
      try {
        const { readDecisionsDetailed } = await import('../fleet/decisions-ledger.js');
        const read = readDecisionsDetailed({ proposalId: id, limit: 25 });
        decisionEvidence = {
          sourceQuality: {
            sourceState: read.sourceState,
            complete: read.complete,
            ...(read.stopReasons.length > 0 ? { reason: read.stopReasons.join(', ') } : {}),
          },
          decisions: read.decisions,
        };
      } catch {
        decisionEvidence = {
          sourceQuality: { sourceState: 'degraded', complete: false, reason: 'ledger read failed' },
          decisions: [],
        };
      }

      sendJson(res, 200, { ...proposal, decisionEvidence });
      return true;
    }

    // ── POST /api/inbox/:id/approve|reject (M32) ─────────────────────────
    // The web approval surface. Gated IDENTICALLY to POST /api/run — the
    // routes do not exist (404) unless `ashlr serve --allow-dispatch`, and
    // every request needs the constant-time-compared x-ashlr-token + JSON
    // Content-Type. Approve mirrors the CLI flow (src/cli/inbox.ts):
    // setStatus('approved') → applyProposal(id, {confirmed:true}); apply
    // failure is reported in the ApplyResult (apply.ts owns failed-state).
    if (path.startsWith('/api/inbox/') && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const sub = path.slice('/api/inbox/'.length); // "<id>/approve" | "<id>/reject"
      const parts = sub.split('/');
      const id = parts[0] ?? '';
      const action = parts[1] ?? '';
      if (!id || (action !== 'approve' && action !== 'reject') || parts.length > 2) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }

      // Same token + Content-Type gate as handleDispatch.
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      const proposal = loadProposal(id);
      if (!proposal) {
        sendJson(res, 404, { error: `proposal not found: ${id}` });
        return true;
      }
      if (proposal.status !== 'pending') {
        sendJson(res, 409, { error: `proposal is ${proposal.status}, not pending` });
        return true;
      }

      if (action === 'reject') {
        if (!setStatus(id, 'rejected')) {
          sendJson(res, 503, { error: 'proposal rejection unavailable; queued recovery could not be revoked' });
          return true;
        }
        sendJson(res, 200, { ok: true, id, status: 'rejected' });
        return true;
      }

      // approve → apply (the ONLY outward path; applyProposal owns its gates:
      // enrollment, kill switch, confirm — all still enforced inside).
      setStatus(id, 'approved');
      const { applyProposal } = await import('../inbox/apply.js');
      const result = await applyProposal(id, { confirmed: true });
      sendJson(res, result.ok ? 200 : 500, result);
      return true;
    }

    // ── GET /api/daemon ─────────────────────────────────────────────────────
    // M24: legacy read-only daemon state. Keep the established response shape;
    // first-party and autonomous consumers use /api/daemon-observation.
    if (path === '/api/daemon' && method === 'GET') {
      sendJson(res, 200, legacyDaemonProjection(await readFreshDaemonObservation(ctx.readProjections)));
      return true;
    }

    if (path === '/api/daemon-observation' && method === 'GET') {
      sendJson(res, 200, await readFreshDaemonObservation(ctx.readProjections));
      return true;
    }

    // ── GET /api/daemon/service ────────────────────────────────────────────
    // Read-only OS service health: installed/running/platform/path. This does
    // not start, stop, install, or mutate anything.
    if (path === '/api/daemon/service' && method === 'GET') {
      const service = serviceStatus(daemonServiceInstallOptions(cfg));
      sendJson(res, 200, service);
      return true;
    }

    // ── POST /api/daemon/service/repair ────────────────────────────────────
    // The web mutation token is not daemon install/repair authority. Keep the
    // legacy route fail-closed until a distinct signed, scoped repair contract
    // exists, while returning read-only state to help the operator diagnose it.
    if (path === '/api/daemon/service/repair' && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      const fleet = await buildFleetStatus(cfg);
      const service = serviceStatus(daemonServiceInstallOptions(cfg));
      sendJson(res, 409, {
        ok: false,
        action: 'repair',
        error: 'daemon service repair requires distinct signed repair authority',
        service,
        activation: fleet.daemon.activation,
      });
      return true;
    }

    // ── POST /api/fleet/pause|resume ─────────────────────────────────────────
    // Local operator controls: hidden unless the server was explicitly started
    // with --allow-dispatch, then guarded by the same token + JSON gate as the
    // other mutation routes.
    if ((path === '/api/fleet/pause' || path === '/api/fleet/resume') && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      const paused = path.endsWith('/pause');
      const mutation = setKill(paused);
      // `undefined` preserves compatibility with older test doubles. Production
      // policy mutators always return a structured result.
      if (mutation !== undefined && (!mutation.ok || !mutation.quiesced)) {
        const unsafeStorage = /unsafe/i.test(mutation.reason);
        const retryable = !unsafeStorage && !mutation.quiesced && (mutation.ok ||
          /fence unavailable|has not quiesced|outward mutation.*active|\bbusy\b/i.test(mutation.reason));
        const fleet = await buildFleetStatus(cfg);
        // Prime the shared cache with this freshly-computed value so a
        // GET /api/fleet right after this mutation observes it immediately
        // instead of a pre-mutation cached value (see fleet-status-cache.ts).
        primeFleetStatusCache(cfg, fleet);
        sendJson(res, retryable ? 409 : 500, {
          ok: false,
          action: paused ? 'pause' : 'resume',
          error: unsafeStorage
            ? `unsafe policy storage: ${mutation.reason}`
            : retryable
              ? `policy mutation busy: ${mutation.reason}`
              : `policy storage degraded: ${mutation.reason}`,
          retryable,
          mutation,
          fleet,
        });
        return true;
      }
      const fleet = await buildFleetStatus(cfg);
      // See comment above — keep the shared cache in sync with the mutation.
      primeFleetStatusCache(cfg, fleet);
      const service = serviceStatus(daemonServiceInstallOptions(cfg));
      sendJson(res, 200, {
        ok: true,
        action: paused ? 'pause' : 'resume',
        ...(mutation ? { mutation } : {}),
        service,
        activation: fleet.daemon.activation,
        fleet,
      });
      return true;
    }

    // ── GET /api/fleet ───────────────────────────────────────────────────────
    // M49: fleet snapshot (daemon + per-backend dispatches/quota + queue +
    // proposals + merges + paused state). buildFleetStatus never throws; same
    // no-auth read class as /api/daemon and /api/pulse.
    if (path === '/api/fleet' && method === 'GET') {
      // M516: serve the cached FleetStatus VERBATIM. Freshness is deliberately
      // NOT spread in here: test/build-identity.test.ts pins that this route
      // performs no API-side recomposition, because a caller verifying
      // buildIdentity must be able to trust that what it received is exactly
      // what buildFleetStatus produced. Freshness is still reported on the
      // snapshot and control payloads, where their builders attach it.
      const cached = ctx.readProjections
        ? await ctx.readProjections.read('fleet')
        : await getCachedFleetStatus(cfg);
      sendJson(res, 200, cached.status);
      return true;
    }

    // ── GET /api/estimate ───────────────────────────────────────────────────
    // M32: read-only pre-flight cost estimate (pure local computation over
    // persisted history — no token needed; same class as /api/pulse).
    if (path === '/api/estimate' && method === 'GET') {
      const kind = getQueryParam(req.url ?? '', 'kind') ?? 'run';
      const goal = getQueryParam(req.url ?? '', 'goal') ?? '';
      const rawMax = getQueryParam(req.url ?? '', 'maxTokens');
      const maxTokens = rawMax !== undefined && /^\d+$/.test(rawMax) ? Number(rawMax) : undefined;
      if (!goal.trim()) {
        sendJson(res, 400, { error: 'goal query parameter required' });
        return true;
      }
      const { estimateRun, estimateSwarm } = await import('../observability/estimate.js');
      const est = kind === 'swarm'
        ? await estimateSwarm(goal, { maxTokens }, cfg)
        : await estimateRun(goal, { maxTokens }, cfg);
      sendJson(res, 200, est);
      return true;
    }

    // ── GET /api/orient ─────────────────────────────────────────────────────
    // M31: read-only composite session-start context (genome + health +
    // backlog + inbox + attention). Same no-auth read class as /api/snapshot.
    if (path === '/api/orient' && method === 'GET') {
      const { buildOrientation } = await import('../orient.js');
      const repo = getQueryParam(req.url ?? '', 'repo');
      const result = await buildOrientation(cfg, repo);
      sendJson(res, 200, result);
      return true;
    }

    // ── GET /api/health ─────────────────────────────────────────────────────
    // M31: read-only — the latest PERSISTED health report (never re-scans).
    if (path === '/api/health' && method === 'GET') {
      const { loadPreviousReport } = await import('../quality/store.js');
      const report = loadPreviousReport();
      sendJson(res, 200, report ?? null);
      return true;
    }

    // ── GET /api/backlog ────────────────────────────────────────────────────
    // M31: read-only — the persisted backlog (never triggers a scan).
    if (path === '/api/backlog' && method === 'GET') {
      const { loadBacklog } = await import('../portfolio/backlog.js');
      const backlog = loadBacklog();
      sendJson(res, 200, backlog ?? null);
      return true;
    }

    // ── GET /api/impact ─────────────────────────────────────────────────────
    // M31: read-only knowledge-graph impact for ?target=<file|symbol>.
    if (path === '/api/impact' && method === 'GET') {
      const target = getQueryParam(req.url ?? '', 'target');
      if (!target || !target.trim()) {
        sendJson(res, 400, { error: 'target query parameter required' });
        return true;
      }
      const { impact } = await import('../knowledge/graph.js');
      sendJson(res, 200, impact(target));
      return true;
    }

    // ── GET /api/events (SSE) ────────────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      if (!ctx.readSession || ctx.readSession.expiresAt <= Date.now()) {
        sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
        return true;
      }
      handleSseEvents(req, res, cfg, ctx.allowDispatch, ctx.readSession, ctx.readProjections);
      return true;
    }

    // ── POST /api/run ────────────────────────────────────────────────────────
    if (path === '/api/run' && method === 'POST') {
      if (!ctx.allowDispatch) {
        // Route does not exist when dispatch is disabled.
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      await handleDispatch(req, res, cfg, ctx);
      return true;
    }

    // ── GET /api/control ────────────────────────────────────────────────────
    // M61: unified Mission Control snapshot. No auth — same read class as
    // /api/fleet and /api/daemon. Never throws; each section degrades independently.
    if (path === '/api/control' && method === 'GET') {
      const snapshot = ctx.readProjections
        ? await ctx.readProjections.read('control')
        : await buildControlSnapshot(cfg);
      sendJson(res, 200, snapshot);
      return true;
    }

    // ── GET /api/fleet-activity ──────────────────────────────────────────────
    // M90: Fleet Activity panel — per-repo digest, recent merges, engine
    // readiness (throttled 10s), subscription burn-down, cooldown count, recent
    // ticks. No auth — same read class as /api/control.
    if (path === '/api/fleet-activity' && method === 'GET') {
      const activity = ctx.readProjections
        ? await ctx.readProjections.read('fleet-activity')
        : await buildFleetActivity(cfg);
      sendJson(res, 200, activity);
      return true;
    }

    // ── GET /api/models ──────────────────────────────────────────────────────
    // M61: live local-model provider probe (Ollama/LM Studio). Returns the
    // `models` section of the control snapshot only.
    if (path === '/api/models' && method === 'GET') {
      const snapshot = ctx.readProjections
        ? await ctx.readProjections.read('control')
        : await buildControlSnapshot(cfg);
      sendJson(res, 200, snapshot.models);
      return true;
    }

    // ── GET /api/logs ────────────────────────────────────────────────────────
    // M61: most-recent-first daemon tick/merge log. ?tail=N (default 50, cap 200).
    if (path === '/api/logs' && method === 'GET') {
      const rawTail = getQueryParam(req.url ?? '', 'tail');
      const tail = rawTail !== undefined && /^\d+$/.test(rawTail)
        ? Math.min(Number(rawTail), 200)
        : 50;
      const snapshot = ctx.readProjections
        ? await ctx.readProjections.read('control')
        : await buildControlSnapshot(cfg);
      sendJson(res, 200, (snapshot.logs ?? []).slice(0, tail));
      return true;
    }

    // Additive provenance-bearing log contract. The legacy /api/logs route
    // remains an array for existing clients.
    if (path === '/api/logs-observation' && method === 'GET') {
      const rawTail = getQueryParam(req.url ?? '', 'tail');
      const tail = rawTail !== undefined && /^\d+$/.test(rawTail)
        ? Math.min(Number(rawTail), 200)
        : 50;
      const snapshot = ctx.readProjections
        ? await ctx.readProjections.read('control')
        : await buildControlSnapshot(cfg);
      sendJson(res, 200, {
        entries: snapshot.logsSourceQuality.sourceState === 'healthy' &&
          snapshot.logsSourceQuality.complete
          ? snapshot.logs.slice(0, tail)
          : null,
        sourceQuality: snapshot.logsSourceQuality,
      });
      return true;
    }

    // ── POST /api/open ────────────────────────────────────────────────────────
    // M100: open a repo or file on the local desktop (editor / Finder).
    //
    // Security model:
    //  - Route does not exist (404) unless allowDispatch is true.
    //  - Requires x-ashlr-token + Content-Type: application/json (same gate as
    //    approve/reject inbox routes).
    //  - Body: { repo: string, file?: string, action: 'editor' | 'finder' }
    //  - `repo` MUST exactly match one of listEnrolled() (absolute, resolved).
    //    Unknown or non-enrolled paths → 403 (not arbitrary open).
    //  - If `file` is provided, resolve(repo, file) must be WITHIN the repo
    //    (path-traversal check). Opens the file; otherwise opens the repo dir.
    //  - Only 'editor' and 'finder' actions are accepted — no shell exec.
    //  - Never opens paths from untrusted input outside enrolled repos.
    if (path === '/api/open' && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }

      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return true;
      }

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendJson(res, 400, { error: 'body must be a JSON object' });
        return true;
      }

      const obj = body as Record<string, unknown>;
      const rawRepo = typeof obj['repo'] === 'string' ? obj['repo'].trim() : '';
      const rawFile = typeof obj['file'] === 'string' ? obj['file'].trim() : '';
      const action = typeof obj['action'] === 'string' ? obj['action'] : 'editor';

      if (!rawRepo) {
        sendJson(res, 400, { error: '"repo" (string) is required' });
        return true;
      }

      if (action !== 'editor' && action !== 'finder') {
        sendJson(res, 400, { error: '"action" must be "editor" or "finder"' });
        return true;
      }

      // Resolve the requested repo path and verify it is enrolled.
      const resolvedRepo = resolvePath(rawRepo);
      const enrolled = listEnrolled();
      const repoCanon = canonForCompare(resolvedRepo);
      if (!enrolled.some((e) => canonForCompare(e) === repoCanon)) {
        sendJson(res, 403, { error: 'path not in an enrolled repo' });
        return true;
      }

      // If a file path was provided, ensure it resolves WITHIN the repo root.
      let targetPath = resolvedRepo;
      if (rawFile) {
        const resolvedFile = resolvePath(resolvedRepo, rawFile);
        // Path-traversal guard: the resolved file must be under the repo root.
        // M341c: native separator (a hardcoded '/' rejected every win32 file)
        // + canonical comparison for 8.3/case variance.
        const fileCanon = canonForCompare(resolvedFile);
        const repoWithSep = repoCanon.endsWith(pathSep) ? repoCanon : repoCanon + pathSep;
        if (fileCanon !== repoCanon && !fileCanon.startsWith(repoWithSep)) {
          sendJson(res, 403, { error: 'file path escapes the repo root' });
          return true;
        }
        targetPath = resolvedFile;
      }

      try {
        if (action === 'finder') {
          openInFinder(targetPath);
        } else {
          openInEditor(targetPath, cfg);
        }
        sendJson(res, 200, { ok: true, action, path: targetPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send500(res, `open failed: ${msg}`);
      }
      return true;
    }

    // ── GET /api/goals ────────────────────────────────────────────────────────
    // M104: read-only goal list with progress roll-up. listGoals + progressOf
    // are both read-only and never throw — wrapped defensively anyway so a
    // corrupt goal file cannot bring down the whole endpoint.
    if (path === '/api/goals' && method === 'GET') {
      try {
        const goals = listGoals();
        const result = goals.map((g) => {
          try {
            const progress = progressOf(g);
            return {
              id: g.id,
              objective: g.objective,
              status: g.status,
              milestones: g.milestones.map((m) => ({ title: m.title, status: m.status, order: m.order })),
              progress: {
                fractionDone: progress.fractionDone,
                counts: progress.byStatus,
                nextActionableId: progress.nextActionableId,
              },
            };
          } catch {
            return {
              id: g.id,
              objective: g.objective,
              status: g.status,
              milestones: [],
              progress: { fractionDone: 0, counts: {}, nextActionableId: null },
            };
          }
        });
        sendJson(res, 200, result);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    // ── GET /api/usage ───────────────────────────────────────────────────────
    // M194: per-engine frontier usage (calls/tokens/cost/window-state).
    // Read-only; same no-auth class as /api/daemon and /api/fleet.
    // Never throws; degrades to empty engines array on any source failure.
    if (path === '/api/usage' && method === 'GET') {
      const { getFrontierUsage } = await import('../usage/frontier-usage.js') as {
        getFrontierUsage: (cfg: AshlrConfig) => Promise<unknown>;
      };
      const usage = await getFrontierUsage(cfg);
      sendJson(res, 200, usage);
      return true;
    }

    // ── GET /api/fleet-state ────────────────────────────────────────────────
    // M129: agent-readable combined fleet surface — daemon status + quality
    // scorecard + full oversight snapshot + recent routing decisions.
    // Read-only; same no-auth class as /api/daemon and /api/fleet.
    // Never throws; each section degrades independently.
    if (path === '/api/fleet-state' && method === 'GET') {
      const { buildFleetDigest } = await import('../fleet/digest.js');
      const { computeQualityMetrics } = await import('../fleet/quality-metrics.js');
      const { buildOversightSnapshot } = await import('../fleet/oversight-export.js');

      // daemon + digest (parallel)
      const daemon = await readFreshDaemonObservation(ctx.readProjections);
      let daemonSection: unknown = {
        runtimeState: daemon.runtimeState,
        sourceQuality: daemon.sourceQuality,
        running: daemon.running,
        pid: daemon.pid,
        startedAt: daemon.startedAt,
        lastTickAt: daemon.lastTickAt,
        todaySpentUsd: daemon.todaySpentUsd,
        itemsProcessed: daemon.itemsProcessed,
        recentTicks: daemon.ticks === null ? null : daemon.ticks.slice(-20),
        pendingProposals: null,
        digest: null,
      };
      try {
        const digest = await buildFleetDigest('7d');
        daemonSection = {
          runtimeState: daemon.runtimeState,
          sourceQuality: daemon.sourceQuality,
          running: daemon.running,
          pid: daemon.pid,
          startedAt: daemon.startedAt,
          lastTickAt: daemon.lastTickAt,
          todaySpentUsd: daemon.todaySpentUsd,
          itemsProcessed: daemon.itemsProcessed,
          recentTicks: daemon.ticks === null ? null : daemon.ticks.slice(-20),
          pendingProposals: digest.totalPending,
          digest: {
            totalProposed: digest.totalProposed,
            totalAutoMerged: digest.totalAutoMerged,
            totalDeclined: digest.totalDeclined,
            repos: digest.repos.slice(0, 10),
          },
        };
      } catch { /* degrade gracefully */ }

      let scorecardSection: unknown = null;
      try {
        scorecardSection = computeQualityMetrics('7d');
      } catch { /* degrade gracefully */ }

      let oversightSection: unknown = null;
      try {
        oversightSection = buildOversightSnapshot(cfg as { pulse?: { enabled?: boolean; endpoint?: string } });
      } catch { /* degrade gracefully */ }

      let routingSection: { recent: unknown[]; modelSplit: Record<string, number> } = { recent: [], modelSplit: {} };
      try {
        const { deriveRoutingData } = await import('../mcp-native.js');
        routingSection = deriveRoutingData(50);
      } catch { /* degrade gracefully */ }

      let workspaceSection: unknown = null;
      try {
        const { readAgentWorkspace } = await import('../fleet/agent-action-ledger.js');
        workspaceSection = readAgentWorkspace({ limit: 500, recentLimit: 20 });
      } catch { /* degrade gracefully */ }

      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        daemon: daemonSection,
        scorecard: scorecardSection,
        oversight: oversightSection,
        routing: routingSection,
        workspace: workspaceSection,
      });
      return true;
    }

    // ── Method not allowed on known /api/ routes ─────────────────────────────
    // If path starts with /api/ but matched none of the above, it's either
    // a wrong method or an unknown sub-path. Return 404.
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    if (err instanceof ReadProjectionError) {
      sendJson(res, 503, { code: 'READ_PROJECTION_UNAVAILABLE', error: 'read projection temporarily unavailable' });
      return true;
    }
    // Catch-all: never let an unhandled error escape.
    const msg = err instanceof Error ? err.message : String(err);
    send500(res, msg);
    return true;
  }
}
