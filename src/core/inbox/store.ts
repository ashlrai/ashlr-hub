/**
 * store.ts — Proposal persistence for the M23 approval inbox.
 *
 * Persists one proposal per file at ~/.ashlr/inbox/<id>.json.
 *
 * GUARDRAILS:
 *  - PURE PERSISTENCE: never applies anything, never mutates a repo, never
 *    auto-advances status. Status changes happen ONLY through setStatus().
 *  - Never throws: all exported functions swallow errors and return safe
 *    defaults (null / [] / 0) so callers remain unblocked.
 *  - Atomic write: write to <id>.json.tmp then rename, matching the pattern
 *    in core/portfolio/backlog.ts.
 *  - No secrets stored: diffs contain user-owned code (fine); tokens/keys are
 *    not proposal fields. audit() strips secrets defensively on its side.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AshlrConfig, Proposal, ProposalStatus } from '../types.js';
import { audit } from '../sandbox/audit.js';
import { emitFleetEvent } from '../integrations/pulse-sync.js';
import type { FleetEvent } from '../integrations/pulse-exporter.js';
// M119: decisions ledger hook — additive, never-throws, no behavior change.
import { recordDecision } from '../fleet/decisions-ledger.js';
import { linkOutcome } from '../fleet/judge-trace.js';

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call-time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the inbox directory: ~/.ashlr/inbox.
 * Created lazily by createProposal / setStatus — this function does NOT
 * create it.
 */
export function inboxDir(): string {
  return join(homedir(), '.ashlr', 'inbox');
}

/**
 * Absolute path to a specific proposal file.
 * M32 hardening: ids reach this from the web API (GET/POST /api/inbox/:id),
 * so validate the shape here too — defense in depth against path traversal,
 * matching runFilePath's guard in core/run/orchestrator.ts. Generated ids
 * are always [a-z0-9-], so this never rejects a legitimate proposal.
 */
function proposalPath(id: string): string {
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error(`Invalid proposal id: ${JSON.stringify(id)}`);
  }
  return join(inboxDir(), `${id}.json`);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, readable slug id for a proposal.
 *
 * Format: `prop-<timestamp-ms>-<4-hex-random>`.
 * - Timestamp prefix gives chronological sorting for free.
 * - 4-hex suffix avoids collisions from sub-millisecond bursts.
 * - All lowercase alphanumeric + hyphens → safe as a filename stem.
 */
let _seq = 0;
function generateId(): string {
  const ts = Date.now().toString(36); // base-36 ms timestamp, ~8 chars
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  // Monotonic, zero-padded process counter as the final segment. createdAt has
  // only millisecond resolution, so proposals created in the same ms would
  // otherwise have no defined recency order. The counter gives listProposals a
  // stable "most-recent first" tiebreaker. The counter comes BEFORE the random
  // segment so lexicographic id comparison orders by (timestamp, monotonic counter).
  const seq = (_seq++).toString(36).padStart(6, '0');
  return `prop-${ts}-${seq}-${rand}`;
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

/** Persist a proposal atomically (tmp-write + rename, POSIX-atomic). */
function persistProposal(proposal: Proposal): void {
  const dir = inboxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const dest = proposalPath(proposal.id);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
  renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Light type-guard so we never return garbage from the store. */
function isValidProposal(parsed: unknown): parsed is Proposal {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const p = parsed as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['origin'] === 'string' &&
    typeof p['kind'] === 'string' &&
    typeof p['title'] === 'string' &&
    typeof p['summary'] === 'string' &&
    typeof p['status'] === 'string' &&
    typeof p['createdAt'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Pulse Map telemetry (Phase: proposal-lifecycle spans) — ADDITIVE, no-op
// unless the fleet→pulse round-trip is opted in (PULSE_URL + PAT). This is
// pure TELEMETRY: it never changes proposal semantics and never weakens the
// proposal-only / kill-switch guarantees — it only mirrors lifecycle MOTION
// (created / merged / declined) into the cloud Map so the graph reflects
// proposals advancing, not just ticks. METADATA ONLY: we emit the repo
// basename + the lifecycle outcome — NEVER the diff, title body, or any file
// contents. Every call is wrapped so a Pulse outage can NEVER affect the
// proposal flow (best-effort, fire-and-forget, swallow-then-log).
// ---------------------------------------------------------------------------

/**
 * Map a proposal lifecycle transition to the fleet event the cloud ingest
 * understands:
 *   - creation                     → 'proposal'  (a proposal now exists)
 *   - approved / applied (merged)  → 'merge'      (it moved toward landing)
 *   - rejected (declined)          → 'decline'    (it was turned down)
 * Any other transition (e.g. a 'pending' reset or an apply 'failed' outcome)
 * is surfaced as a generic 'proposal' span so the motion is still visible.
 * Returns the FleetEvent kind; the raw status is carried as the outcome.
 */
function lifecycleEvent(status: ProposalStatus): FleetEvent {
  if (status === 'approved' || status === 'applied') return 'merge';
  if (status === 'rejected') return 'decline';
  return 'proposal';
}

/**
 * Best-effort, NON-THROWING fleet-span emit for a proposal lifecycle moment.
 *
 * - Gated entirely by emitFleetEvent → pulseSyncEnabled: a complete NO-OP
 *   (no network, no fetch) unless BOTH a Pulse endpoint (PULSE_URL / cfg.pulse)
 *   AND a PAT are configured. When unconfigured this returns immediately.
 * - Fire-and-forget: the returned promise is detached with a .catch() so the
 *   proposal call path never awaits the network and a Pulse outage / rejection
 *   can never propagate into the proposal flow.
 * - METADATA ONLY: refId = proposal id; repo = basename of the repo path;
 *   outcome = the lifecycle status/origin. NEVER the diff or any file content.
 *
 * `owner` is threaded through cfg.user so the cloud can attribute the span to a
 * teammate (carried as ashlr.fleet.owner) — matching the createProposal owner
 * stamping. No cfg ⇒ env-driven opt-in still applies.
 */
function emitProposalSpan(
  event: FleetEvent,
  proposal: Pick<Proposal, 'id' | 'repo' | 'owner'>,
  outcome: string,
  cfg?: Pick<AshlrConfig, 'user'>,
): void {
  try {
    // repo is an absolute path on a Proposal; ship only the basename as a
    // metadata hint (the cloud resolves nodes by name). Never a full path's
    // parent dirs — keep it to the bare repo name.
    const repo = proposal.repo ? basename(proposal.repo) : null;
    // Build the minimal AshlrConfig surface emitFleetEvent needs. pulseSyncEnabled
    // reads cfg.pulse + env; exporterConfig reads cfg.user. We never have the
    // full config here, so rely on env-based opt-in (PULSE_URL) + carry owner.
    const fleetCfg = {
      ...(cfg?.user ? { user: cfg.user } : {}),
    } as AshlrConfig;

    // emitFleetEvent is itself gated + no-throw, but we still detach + swallow:
    // store.ts must NEVER throw and must NEVER block on the network.
    void Promise.resolve(
      emitFleetEvent(fleetCfg, {
        event,
        refId: proposal.id,
        outcome,
        repo,
      }),
    ).catch(() => {
      // Pulse outage / rejection — telemetry is best-effort; proposal flow is
      // unaffected. Swallow (emitFleetEvent already logs at its boundary).
    });
  } catch {
    // Constructing the span input must never break a proposal lifecycle call.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new proposal, persist it, audit the creation, and return it.
 *
 * Assigns:
 *  - `id`        — fresh unique slug (stable, filename-safe)
 *  - `status`    — 'pending'
 *  - `createdAt` — current ISO timestamp
 *  - `owner`     — cfg.user?.id ?? cfg.user?.name (M109; undefined when cfg absent)
 *
 * NEVER applies or mutates any repo.
 * Never throws — on persistence failure the in-memory proposal is still
 * returned (best-effort).
 */
export function createProposal(
  p: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
  cfg?: Pick<AshlrConfig, 'user'>,
): Proposal {
  // M109: stamp owner from cfg.user when not already set by the caller.
  const owner = p.owner ?? cfg?.user?.id ?? cfg?.user?.name;
  const proposal: Proposal = {
    ...p,
    ...(owner !== undefined ? { owner } : {}),
    id: generateId(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  try {
    persistProposal(proposal);
  } catch {
    // Persistence failure: caller still gets the in-memory proposal.
  }

  audit({
    action: 'inbox:proposal-created',
    repo: proposal.repo ?? null,
    sandboxId: proposal.sandboxId ?? null,
    summary: `proposal created: [${proposal.kind}] ${proposal.title} (id=${proposal.id})`,
    result: 'ok',
  });

  // Pulse Map: a proposal now exists. Outcome = its origin so the cloud can
  // distinguish backlog / swarm / manual / agent provenance. Best-effort.
  emitProposalSpan('proposal', proposal, proposal.origin, cfg);

  return proposal;
}

/**
 * List all persisted proposals, most-recent first by `createdAt`.
 * Optionally filter by status.
 *
 * Read-only. Unreadable / corrupt files are silently skipped.
 * Never throws.
 */
export function listProposals(filter?: { status?: ProposalStatus }): Proposal[] {
  try {
    const dir = inboxDir();
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    } catch {
      return [];
    }

    const proposals: Proposal[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isValidProposal(parsed)) {
          proposals.push(parsed);
        }
      } catch {
        // Unreadable or malformed — skip silently.
      }
    }

    // Apply optional status filter.
    const filtered =
      filter?.status !== undefined
        ? proposals.filter((p) => p.status === filter.status)
        : proposals;

    // Most-recent first by createdAt (ISO strings sort lexicographically).
    // Tiebreak on id (which embeds a monotonic counter) so proposals created
    // within the same millisecond still order newest-first deterministically.
    filtered.sort((a, b) => {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

    return filtered;
  } catch {
    return [];
  }
}

/**
 * Load a single proposal by id.
 * Returns null if absent, unreadable, or malformed.
 * Never throws.
 */
export function loadProposal(id: string): Proposal | null {
  try {
    const p = proposalPath(id);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isValidProposal(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a new status (and optional result detail) for an existing proposal.
 *
 * - Sets `decidedAt` to now when moving to 'approved' or 'rejected'.
 * - No-op if the proposal does not exist or cannot be read.
 * - NEVER applies anything — pure persistence change only.
 * - Audits the decision.
 * - Never throws.
 *
 * M119 ADDITIVE: optional `reason` param — when supplied, persisted as
 * `decisionReason` on the proposal and emitted to the decisions ledger.
 * When absent → no behavior change whatsoever.
 */
export function setStatus(
  id: string,
  status: ProposalStatus,
  result?: string,
  reason?: string,
): void {
  try {
    const existing = loadProposal(id);
    if (existing === null) return;

    const decidedStatuses: ProposalStatus[] = ['approved', 'rejected'];
    const updated: Proposal = {
      ...existing,
      status,
      ...(result !== undefined ? { result } : {}),
      // M119: persist decisionReason when provided (additive, backward-compatible).
      ...(reason !== undefined ? { decisionReason: reason } : {}),
      ...(decidedStatuses.includes(status)
        ? { decidedAt: new Date().toISOString() }
        : {}),
    };

    try {
      persistProposal(updated);
    } catch {
      // Persistence failure — swallow; audit still fires.
    }

    audit({
      action: `inbox:proposal-${status}`,
      repo: updated.repo ?? null,
      sandboxId: updated.sandboxId ?? null,
      summary: `proposal ${status}: [${updated.kind}] ${updated.title} (id=${id})${result ? ` — ${result}` : ''}`,
      result: 'ok',
    });

    // M119: emit a decisions-ledger entry for every status transition that
    // represents a decision (merged/rejected) or a lifecycle action.
    // Best-effort: recordDecision never throws; no behavior change when absent.
    try {
      const ledgerAction =
        status === 'applied' || status === 'approved'
          ? 'merged'
          : status === 'rejected'
            ? 'rejected'
            : 'judged';
      // Derive the engine id from the model string (segment before ':').
      const engineModel = updated.engineModel;
      const engineId = engineModel ? engineModel.split(':')[0] : undefined;
      recordDecision({
        ts: new Date().toISOString(),
        proposalId: id,
        action: ledgerAction,
        ...(engineId ? { engine: engineId } : {}),
        ...(engineModel ? { model: engineModel } : {}),
        verdict: status,
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch {
      // Ledger is best-effort — never disrupts the proposal flow.
    }

    // M141: link the proposal's terminal outcome back to its judge trace —
    // the credit-assignment signal for judge calibration + distillation. Best-effort.
    try {
      if (status === 'applied' || status === 'approved') linkOutcome(id, 'merged');
      else if (status === 'rejected') linkOutcome(id, 'rejected');
    } catch { /* never disrupts the proposal flow */ }

    // Pulse Map: mirror the lifecycle transition. approved/applied → 'merge',
    // rejected → 'decline', any other → 'proposal'. The raw status is the
    // outcome. This ONLY reports motion — setStatus has already (and only)
    // changed the persisted status; no apply / merge / kill-switch behavior is
    // touched here. Owner is carried from the persisted proposal.
    emitProposalSpan(
      lifecycleEvent(status),
      updated,
      status,
      updated.owner ? { user: { id: updated.owner } } : undefined,
    );
  } catch {
    // Never throws.
  }
}

/**
 * Count proposals with status === 'pending'.
 * Read-only. Returns 0 on any error.
 * Never throws.
 */
export function pendingCount(): number {
  try {
    return listProposals({ status: 'pending' }).length;
  } catch {
    return 0;
  }
}
