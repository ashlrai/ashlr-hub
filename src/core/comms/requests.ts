/**
 * M137: CommsRequest store — the protocol layer.
 *
 * Requests are persisted as newline-delimited JSON (JSONL) at
 * ~/.ashlr/comms/requests.jsonl. Appends are atomic (single writeSync of one
 * line). Mutations (markSent, resolveRequest) rewrite the file after loading
 * all records.
 *
 * Protocol invariant: only ONE request may be 'sent' (awaiting reply) at a
 * time. Requests that outlive their TTL are expired (see expireStaleRequests)
 * so one unanswered question cannot hold the queue shut indefinitely. postRequest always appends as 'pending'; dispatch decides when to
 * promote pending→sent. Answers arrive as numeric indices (1-based) that map
 * to the request's options array.
 *
 * Never throws. All I/O errors are caught and silently degrade.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommsRequest {
  /** Unique request id (UUID v4). */
  id: string;
  /** Semantic kind — used to route resolved answers to handlers. e.g. 'merge-gate', 'test'. */
  kind: string;
  /** Request type — determines send behavior. Reports don't await a reply. */
  type: 'question' | 'approval' | 'report';
  /** Human-readable request text shown in the iMessage. */
  text: string;
  /** Numbered reply options (shown as "1. opt  2. opt  …"). Empty for reports. */
  options: string[];
  /** Optional arbitrary metadata for the handler. */
  meta?: Record<string, unknown>;
  /** Lifecycle status. */
  status: 'pending' | 'sent' | 'answered' | 'expired';
  /** 0-based index into options[]. Set when status='answered'. */
  answerIndex?: number;
  /** Raw text of the matched answer option. Convenience copy. */
  answerText?: string;
  /** ISO timestamp when the request was created. */
  createdAt: string;
  /** ISO timestamp when the iMessage was sent. */
  sentAt?: string;
  /** ISO timestamp when the reply was matched and resolved. */
  answeredAt?: string;
  /** ISO timestamp when the request aged out unsent or unanswered. */
  expiredAt?: string;
}

// ---------------------------------------------------------------------------
// Store path
// ---------------------------------------------------------------------------

function storeDir(): string {
  return join(homedir(), '.ashlr', 'comms');
}

function storePath(): string {
  return join(storeDir(), 'requests.jsonl');
}

function ensureDir(): void {
  try {
    mkdirSync(storeDir(), { recursive: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Low-level JSONL I/O
// ---------------------------------------------------------------------------

function loadAll(): CommsRequest[] {
  try {
    const p = storePath();
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const results: CommsRequest[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        results.push(JSON.parse(t) as CommsRequest);
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

function saveAll(requests: CommsRequest[]): void {
  try {
    ensureDir();
    const content = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(storePath(), content, 'utf8');
  } catch {
    // best-effort
  }
}

function atomicAppend(req: CommsRequest): void {
  try {
    ensureDir();
    appendFileSync(storePath(), JSON.stringify(req) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post a new request. Returns the assigned id. The request is appended
 * atomically as 'pending'. Does not send — dispatch handles sending.
 */
export function postRequest(req: {
  kind: string;
  type: 'question' | 'approval' | 'report';
  text: string;
  options: string[];
  meta?: Record<string, unknown>;
}): string {
  const id = randomUUID();
  const record: CommsRequest = {
    id,
    kind: req.kind,
    type: req.type,
    text: req.text,
    options: req.options,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...(req.meta !== undefined ? { meta: req.meta } : {}),
  };
  atomicAppend(record);
  return id;
}

export type RequestFilter = {
  status?: CommsRequest['status'] | CommsRequest['status'][];
  type?: CommsRequest['type'];
  kind?: string;
};

/** List requests, optionally filtered. */
export function listRequests(filter?: RequestFilter): CommsRequest[] {
  const all = loadAll();
  if (!filter) return all;

  return all.filter((r) => {
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(r.status)) return false;
    }
    if (filter.type !== undefined && r.type !== filter.type) return false;
    if (filter.kind !== undefined && r.kind !== filter.kind) return false;
    return true;
  });
}

/** Mark a request as sent (in-flight, awaiting reply). */
export function markSent(id: string): void {
  try {
    const all = loadAll();
    let found = false;
    const updated = all.map((r) => {
      if (r.id !== id) return r;
      found = true;
      return { ...r, status: 'sent' as const, sentAt: new Date().toISOString() };
    });
    if (found) saveAll(updated);
  } catch {
    // best-effort
  }
}

/**
 * Resolve a request with a 0-based answer index (parsed from Mason's 1-based
 * numbered reply). Sets status='answered'. Best-effort.
 */
export function resolveRequest(id: string, answerIndex: number, answerText?: string): void {
  try {
    const all = loadAll();
    let found = false;
    const updated = all.map((r) => {
      if (r.id !== id) return r;
      found = true;
      return {
        ...r,
        status: 'answered' as const,
        answerIndex,
        answerText: answerText ?? r.options[answerIndex],
        answeredAt: new Date().toISOString(),
      };
    });
    if (found) saveAll(updated);
  } catch {
    // best-effort
  }
}

/**
 * Return the one currently-outstanding request (status='sent', type question
 * or approval). There should be at most one at any time; returns the most
 * recently sent if somehow multiple exist.
 */
export function outstanding(): CommsRequest | undefined {
  const sent = loadAll().filter(
    (r) => r.status === 'sent' && (r.type === 'question' || r.type === 'approval'),
  );
  if (sent.length === 0) return undefined;
  // Return the one most recently sent (last sentAt wins)
  return sent.sort((a, b) =>
    (b.sentAt ?? b.createdAt) > (a.sentAt ?? a.createdAt) ? 1 : -1,
  )[0];
}

/** Default lifetime of a comms request before it is expired (hours). */
export const DEFAULT_REQUEST_TTL_HOURS = 48;

export interface ExpireResult {
  /** Outstanding questions/approvals that were never answered in time. */
  expiredSent: number;
  /** Pending requests that were never sent in time. */
  expiredPending: number;
}

function ageStartMs(r: CommsRequest): number {
  const iso = r.status === 'sent' ? (r.sentAt ?? r.createdAt) : r.createdAt;
  return Date.parse(iso);
}

/**
 * Expire requests older than `ttlMs`: an outstanding (sent) question or
 * approval nobody answered, and a pending request that was never sent.
 *
 * Without this, a single unanswered question blocks every later send forever
 * (only one request may be outstanding), and the pending queue grows without
 * bound — on a live machine one June question held 585 digests and briefings
 * back for three months. Expiry is fail-closed: an expired approval is never
 * treated as a yes, and a late reply or button tap on it resolves nothing
 * because only the current outstanding request can be answered.
 *
 * Records with an unparseable timestamp are left untouched. Best-effort;
 * never throws.
 */
export function expireStaleRequests(nowMs: number, ttlMs: number): ExpireResult {
  const result: ExpireResult = { expiredSent: 0, expiredPending: 0 };
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(nowMs)) return result;
  try {
    const all = loadAll();
    const expiredAt = new Date(nowMs).toISOString();
    const updated = all.map((r) => {
      const awaitingReply = r.status === 'sent' && (r.type === 'question' || r.type === 'approval');
      if (!awaitingReply && r.status !== 'pending') return r;
      const started = ageStartMs(r);
      if (!Number.isFinite(started) || nowMs - started < ttlMs) return r;
      if (awaitingReply) result.expiredSent += 1;
      else result.expiredPending += 1;
      return { ...r, status: 'expired' as const, expiredAt };
    });
    if (result.expiredSent + result.expiredPending > 0) saveAll(updated);
  } catch {
    // best-effort
  }
  return result;
}
