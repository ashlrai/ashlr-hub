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
// M158: destructive-diff pre-judge guard — additive, DEFAULT ON, never-throws.
import { isDestructiveDiff } from '../run/diff-safety.js';
import { causalMetadata, causalMetadataFromProposal } from '../learning/causal.js';
import { scrubSecrets } from '../util/scrub.js';
import { proposalCompletesGoalMilestone } from '../goals/completion.js';
// M228: goal-milestone outcome wiring — additive, best-effort, never-throws.
// Imported here (not goals/advance.ts) because inbox/store does NOT import from
// goals/* anywhere, so this import creates no cycle. goals/advance.ts imports
// inbox/store.ts (one direction only).
import { listGoals, updateMilestoneStatus as _updateMilestoneStatus } from '../goals/store.js';

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

function scrubProposalText(text: string): string {
  try {
    return scrubSecrets(text);
  } catch {
    return text;
  }
}

/**
 * Store-boundary secret scrub for human-readable proposal fields.
 *
 * Diffs are scrubbed in-place so reviewers still see file paths, hunks, and
 * surrounding context. When the diff changes, any trust tuple bound to the old
 * bytes is dropped fail-closed; scrubbing non-diff text does not invalidate it.
 */
function sanitizeProposalForStore<T extends Partial<Proposal> & Pick<Proposal, 'title' | 'summary'>>(
  proposal: T,
): T {
  const next: Partial<Proposal> = { ...proposal };
  let changed = false;

  const scrubTopLevel = (key: 'title' | 'summary' | 'result' | 'decisionReason'): void => {
    const value = next[key];
    if (typeof value !== 'string') return;
    const scrubbed = scrubProposalText(value);
    if (scrubbed !== value) {
      next[key] = scrubbed;
      changed = true;
    }
  };

  scrubTopLevel('title');
  scrubTopLevel('summary');
  scrubTopLevel('result');
  scrubTopLevel('decisionReason');

  if (typeof next.diff === 'string') {
    const scrubbedDiff = scrubProposalText(next.diff);
    if (scrubbedDiff !== next.diff) {
      next.diff = scrubbedDiff;
      delete next.diffHash;
      delete next.provenanceSig;
      changed = true;
    }
  }

  if (next.action?.type === 'browser-task') {
    const action = next.action;
    const scrubbedInstructions = scrubProposalText(action.instructions);
    const scrubbedUrl = typeof action.url === 'string' ? scrubProposalText(action.url) : action.url;
    if (scrubbedInstructions !== action.instructions || scrubbedUrl !== action.url) {
      next.action = {
        ...action,
        instructions: scrubbedInstructions,
        ...(scrubbedUrl !== undefined ? { url: scrubbedUrl } : {}),
      };
      changed = true;
    }
  }

  if (next.verifyResult !== undefined) {
    const verify: NonNullable<Proposal['verifyResult']> = next.verifyResult;
    let updatedVerify: NonNullable<Proposal['verifyResult']> = verify;

    const ensureVerify = (): NonNullable<Proposal['verifyResult']> => {
      if (updatedVerify === verify) updatedVerify = { ...verify };
      return updatedVerify;
    };

    if (typeof verify.detail === 'string') {
      const scrubbed = scrubProposalText(verify.detail);
      if (scrubbed !== verify.detail) {
        ensureVerify().detail = scrubbed;
      }
    }

    if (Array.isArray(verify.failed)) {
      const failed = verify.failed.map((item) => scrubProposalText(item));
      if (failed.some((item, idx) => item !== verify.failed![idx])) {
        ensureVerify().failed = failed;
      }
    }

    if (verify.browser !== undefined) {
      let browser = verify.browser;
      const scrubbedDetail = scrubProposalText(browser.detail);
      if (scrubbedDetail !== browser.detail) {
        browser = { ...browser, detail: scrubbedDetail };
      }
      if (browser.visualGrounding !== undefined) {
        const visual = browser.visualGrounding;
        const scrubbedVisualDetail = scrubProposalText(visual.detail);
        if (scrubbedVisualDetail !== visual.detail) {
          browser = { ...browser, visualGrounding: { ...visual, detail: scrubbedVisualDetail } };
        }
      }
      if (browser !== verify.browser) {
        ensureVerify().browser = browser;
      }
    }

    if (updatedVerify !== verify) {
      next.verifyResult = updatedVerify;
      changed = true;
    }
  }

  if (next.remoteHandoff !== undefined) {
    const handoff = next.remoteHandoff;
    const scrubbedDetail = typeof handoff.detail === 'string' ? scrubProposalText(handoff.detail) : handoff.detail;
    const scrubbedPrUrl = typeof handoff.prUrl === 'string' ? scrubProposalText(handoff.prUrl) : handoff.prUrl;
    if (scrubbedDetail !== handoff.detail || scrubbedPrUrl !== handoff.prUrl) {
      next.remoteHandoff = {
        ...handoff,
        ...(scrubbedDetail !== undefined ? { detail: scrubbedDetail } : {}),
        ...(scrubbedPrUrl !== undefined ? { prUrl: scrubbedPrUrl } : {}),
      };
      changed = true;
    }
  }

  if (next.taste !== undefined) {
    const scrubbedRationale = scrubProposalText(next.taste.rationale);
    if (scrubbedRationale !== next.taste.rationale) {
      next.taste = { ...next.taste, rationale: scrubbedRationale };
      changed = true;
    }
  }

  return changed ? (next as T) : proposal;
}

/** Persist a proposal atomically (tmp-write + rename, POSIX-atomic). */
function persistProposal(proposal: Proposal): void {
  const safeProposal = sanitizeProposalForStore(proposal);
  const dir = inboxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const dest = proposalPath(safeProposal.id);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify(safeProposal, null, 2) + '\n', 'utf8');
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
 *   - awaiting-host-merge          → 'proposal'   (remote handoff, not landed)
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
// M228: Goal-milestone outcome linker — additive, best-effort, never-throws.
// ---------------------------------------------------------------------------

/**
 * When a proposal resolves (verified applied → done; rejected → pending/blocked),
 * find the goal milestone that holds this proposalId and update its status
 * to reflect the terminal outcome.
 *
 * - verified 'applied' → milestone 'done' (the work landed and passed verification)
 * - 'rejected' → milestone 'pending' if it previously had no swarmId hint of
 *                a hard failure; otherwise 'blocked' so a human must steer it.
 *                NOTE: a milestone with proposalId set is currently 'proposed'
 *                (normal path) or 'blocked' (needs-approval branch). In both
 *                cases on reject we reset to 'pending' for retry — the conductor
 *                can re-advance it on the next cycle.  A caller that wants to
 *                permanently block can call updateMilestoneStatus directly.
 *
 * Best-effort: any error is swallowed so a Pulse outage / corrupt goal file
 * NEVER disrupts the proposal lifecycle flow.
 */
function linkMilestoneOutcome(proposalId: string, outcome: 'applied' | 'rejected'): void {
  try {
    const goals = listGoals();
    for (const goal of goals) {
      const milestone = goal.milestones.find((m) => m.proposalId === proposalId);
      if (!milestone) continue;

      const newStatus =
        outcome === 'applied'
          ? ('done' as const)
          : ('pending' as const); // reset to pending for retry on rejection

      try {
        _updateMilestoneStatus(goal.id, milestone.id, newStatus);
      } catch {
        // best-effort — never disrupts the caller
      }
      // Only one goal can own a given proposalId — stop after first match.
      break;
    }
  } catch {
    // Never disrupts the proposal flow.
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
  cfg?: Pick<AshlrConfig, 'user' | 'foundry'>,
): Proposal {
  const input = sanitizeProposalForStore(p);
  // M109: stamp owner from cfg.user when not already set by the caller.
  const owner = input.owner ?? cfg?.user?.id ?? cfg?.user?.name;

  // M158: destructive-diff guard — default ON (cfg.foundry?.diffSafety !== false).
  // Applied before status is set so a destructive proposal never enters 'pending'.
  const diffSafetyEnabled = cfg?.foundry?.diffSafety !== false;
  let initialStatus: Proposal['status'] = 'pending';
  let diffSafetyRejectionReason: string | undefined;
  if (diffSafetyEnabled && input.diff) {
    try {
      const guard = isDestructiveDiff(input.diff);
      if (guard.destructive) {
        initialStatus = 'rejected';
        diffSafetyRejectionReason = `destructive diff auto-rejected: ${guard.reason ?? 'destructive pattern detected'}`;
      }
    } catch {
      // Guard is best-effort — never disrupts proposal creation.
    }
  }

  // M259: diffHash dedup — if an identical diff is already pending, skip filing.
  // This prevents the 10x duplicate flood (same fix re-proposed every tick).
  // Only skips when the incoming proposal has a diffHash AND a pending proposal
  // with the same diffHash already exists. Safe: never rejects distinct diffs.
  // No-op when diffHash is absent (no dedup check).
  if (initialStatus === 'pending' && input.diffHash) {
    try {
      const existingPending = listProposals({ status: 'pending' });
      const duplicate = existingPending.find(
        (ep) => ep.diffHash === input.diffHash,
      );
      if (duplicate) {
        // Return a synthetic rejected record (never persisted) so the caller
        // gets a valid Proposal shape without cluttering the inbox.
        // The real proposal (duplicate.id) is still live — we just skip the new one.
        audit({
          action: 'inbox:proposal-rejected',
          repo: (input.repo as string | null) ?? null,
          sandboxId: (input.sandboxId as string | undefined) ?? null,
          summary: `proposal skipped (diffHash dedup): [${input.kind}] ${input.title} — duplicate of ${duplicate.id}`,
          result: 'ok',
        });
        return {
          ...input,
          ...(owner !== undefined ? { owner } : {}),
          id: duplicate.id, // caller receives the existing proposal's id
          status: 'rejected' as const,
          createdAt: new Date().toISOString(),
          decisionReason: `diffHash dedup: duplicate of ${duplicate.id}`,
          decidedAt: new Date().toISOString(),
        };
      }
    } catch {
      // Dedup is best-effort — never disrupts proposal creation.
    }
  }

  const proposalId = generateId();
  const createdAt = new Date().toISOString();
  const baseProposal: Proposal = {
    ...input,
    ...(owner !== undefined ? { owner } : {}),
    id: proposalId,
    status: initialStatus,
    createdAt,
    ...(diffSafetyRejectionReason !== undefined
      ? { decisionReason: diffSafetyRejectionReason, decidedAt: new Date().toISOString() }
      : {}),
  };
  const proposal: Proposal = {
    ...baseProposal,
    ...causalMetadata({
      proposalId,
      workItemId: baseProposal.workItemId,
      runId: baseProposal.runId,
      trajectoryId: baseProposal.trajectoryId,
      routeSnapshot: baseProposal.routeSnapshot,
      runEventSummary: baseProposal.runEventSummary,
      evidenceOutcome: baseProposal.evidenceOutcome,
      learningSource: baseProposal.learningSource ?? 'proposal',
      labelBasis: baseProposal.labelBasis ?? 'proposal-status',
      routerPolicyVersion: baseProposal.routerPolicyVersion,
      learningEpoch: baseProposal.learningEpoch,
      ts: createdAt,
    }),
  };

  try {
    persistProposal(proposal);
  } catch {
    // Persistence failure: caller still gets the in-memory proposal.
  }

  audit({
    action: initialStatus === 'rejected' ? 'inbox:proposal-rejected' : 'inbox:proposal-created',
    repo: proposal.repo ?? null,
    sandboxId: proposal.sandboxId ?? null,
    summary:
      initialStatus === 'rejected'
        ? `proposal auto-rejected (diff-safety): [${proposal.kind}] ${proposal.title} (id=${proposal.id}) — ${diffSafetyRejectionReason}`
        : `proposal created: [${proposal.kind}] ${proposal.title} (id=${proposal.id})`,
    result: 'ok',
  });

  // M158: emit decisions-ledger entry for auto-rejected proposals.
  if (initialStatus === 'rejected' && diffSafetyRejectionReason !== undefined) {
    try {
      const ts = new Date().toISOString();
      recordDecision({
        ts,
        proposalId: proposal.id,
        ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
        ...(proposal.workSource ? { workSource: proposal.workSource } : {}),
        ...(proposal.runId ? { runId: proposal.runId } : {}),
        ...causalMetadataFromProposal(proposal, {
          ts,
          learningSource: 'decision-ledger',
          labelBasis: 'proposal-status',
        }),
        action: 'rejected',
        verdict: 'rejected',
        reason: diffSafetyRejectionReason,
      });
    } catch {
      // Ledger is best-effort.
    }
  }

  // Pulse Map: a proposal now exists. Outcome = its origin so the cloud can
  // distinguish backlog / swarm / manual / agent provenance. Best-effort.
  emitProposalSpan(
    initialStatus === 'rejected' ? 'decline' : 'proposal',
    proposal,
    initialStatus === 'rejected' ? 'rejected' : proposal.origin,
    cfg,
  );

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
          proposals.push(sanitizeProposalForStore(parsed));
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
    if (isValidProposal(parsed)) return sanitizeProposalForStore(parsed);
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
    const updated: Proposal = sanitizeProposalForStore({
      ...existing,
      status,
      ...(result !== undefined ? { result } : {}),
      // M119: persist decisionReason when provided (additive, backward-compatible).
      ...(reason !== undefined ? { decisionReason: reason } : {}),
      ...(decidedStatuses.includes(status)
        ? { decidedAt: new Date().toISOString() }
        : {}),
    });

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
            : status === 'awaiting-host-merge'
              ? 'handoff'
              : 'judged';
      // Derive the engine id from the model string (segment before ':').
      const engineModel = updated.engineModel;
      const engineId = engineModel ? engineModel.split(':')[0] : undefined;
      const ts = new Date().toISOString();
      recordDecision({
        ts,
        proposalId: id,
        ...(updated.workItemId ? { workItemId: updated.workItemId } : {}),
        ...(updated.workSource ? { workSource: updated.workSource } : {}),
        ...(updated.runId ? { runId: updated.runId } : {}),
        ...causalMetadataFromProposal(updated, {
          ts,
          learningSource: 'decision-ledger',
          labelBasis: 'proposal-status',
        }),
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

    // M228: update any goal milestone linked to this proposal so milestones
    // progress only when applied work also has passing verification evidence.
    if (status === 'applied' && proposalCompletesGoalMilestone(updated)) linkMilestoneOutcome(id, 'applied');
    else if (status === 'rejected') linkMilestoneOutcome(id, 'rejected');

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
 * M259: Patch a single field on an existing proposal (atomic read-modify-write).
 *
 * Used by runAutoMergePass to increment judgeNonShipCount without touching any
 * other field. Pure persistence — NEVER changes status, NEVER applies anything.
 * No-op when the proposal does not exist or cannot be read.
 * Never throws.
 */
export function updateProposalField(
  id: string,
  patch: Partial<Pick<Proposal, 'judgeNonShipCount' | 'verifyResult' | 'stuckPassCount' | 'remoteHandoff'>>,
): void {
  try {
    const existing = loadProposal(id);
    if (existing === null) return;
    const updated: Proposal = sanitizeProposalForStore({ ...existing, ...patch });
    try {
      persistProposal(updated);
      if (patch.verifyResult !== undefined && proposalCompletesGoalMilestone(updated)) {
        linkMilestoneOutcome(id, 'applied');
      }
    } catch {
      // Persistence failure — swallow; best-effort.
    }
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
