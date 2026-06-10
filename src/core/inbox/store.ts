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
import { join } from 'node:path';
import type { Proposal, ProposalStatus } from '../types.js';
import { audit } from '../sandbox/audit.js';

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

/** Absolute path to a specific proposal file. */
function proposalPath(id: string): string {
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new proposal, persist it, audit the creation, and return it.
 *
 * Assigns:
 *  - `id`        — fresh unique slug (stable, filename-safe)
 *  - `status`    — 'pending'
 *  - `createdAt` — current ISO timestamp
 *
 * NEVER applies or mutates any repo.
 * Never throws — on persistence failure the in-memory proposal is still
 * returned (best-effort).
 */
export function createProposal(
  p: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
): Proposal {
  const proposal: Proposal = {
    ...p,
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
 */
export function setStatus(
  id: string,
  status: ProposalStatus,
  result?: string,
): void {
  try {
    const existing = loadProposal(id);
    if (existing === null) return;

    const decidedStatuses: ProposalStatus[] = ['approved', 'rejected'];
    const updated: Proposal = {
      ...existing,
      status,
      ...(result !== undefined ? { result } : {}),
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
