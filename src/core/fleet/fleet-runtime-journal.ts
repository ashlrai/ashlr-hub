/**
 * Fleet runtime journal — V3.10 Track B unit U5.
 *
 * What the resident fleet did, in the terms the Fleet surface draws: the
 * lanes of the last standing tick, what backpressure held, which items the
 * router parked and why, and one row per dispatch attempt with the SeatRouter
 * decision behind it ("why this seat"). The daemon writes it (from
 * fleet/tick-hooks-live.ts); the Verse server reads it (verse/fleet-live-api.ts).
 *
 *   ~/.ashlr/fleet/runtime/tick.json   the last standing tick (atomic rewrite)
 *   ~/.ashlr/fleet/runtime/runs.jsonl  append-only dispatch / landing rows,
 *                                      rotated at 2 MB (one previous kept)
 *
 * OBSERVATIONAL ONLY. Nothing here authorizes anything: the authority ledger
 * (authority/ledger.ts) is the record of gates and merges, this is the record
 * of dispatch. Metadata only — titles are scrubbed and capped, never a diff,
 * a prompt or engine output. 0600 files in 0700 directories. Writers never
 * throw (a journal write must never fail a tick); readers are total.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DaemonCapabilityKind } from '../authority/types.js';
import type { SeatDecision } from '../routing/types.js';
import { boundSeatReasons } from '../routing/seat-reasons.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import type { OperatorPresence } from './dispatch-router.js';
import type { FleetEngine, FleetLaneState, RouteHold } from './fleet-types.js';

export const RUNS_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const MAX_TICK_STATE_BYTES = 512 * 1024;
const MAX_TITLE_CHARS = 160;
const MAX_HELD_PER_TICK = 200;

export function fleetRuntimeDir(): string {
  return join(homedir(), '.ashlr', 'fleet', 'runtime');
}

export function tickStatePath(): string {
  return join(fleetRuntimeDir(), 'tick.json');
}

export function runsJournalPath(): string {
  return join(fleetRuntimeDir(), 'runs.jsonl');
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface HeldItemRecord {
  itemId: string;
  /** nameWithOwner when known, else the enrolled directory's name. */
  repo: string;
  title: string;
  hold: RouteHold;
  seatDecision: SeatDecision | null;
  at: string;
}

export interface FleetTickStateV1 {
  v: 1;
  at: string;
  capabilityKind: DaemonCapabilityKind | null;
  dryRun: boolean;
  /** The standing policy this tick ran under; null = none (the hooks held everything). */
  standing: { grantId: string; stageId: string; switch: 'propose' | 'autonomous' } | null;
  lanes: FleetLaneState[];
  presence: OperatorPresence;
  /** Non-null ⇒ no new production this tick, and why. */
  holdProduction: string | null;
  pausedRepos: { repo: string; reason: string }[];
  waitingVerify: number | null;
  openPrsByRepo: Record<string, number> | null;
  ledgerHead: { seq: number; hash: string } | null;
  /** Items the router held this tick (the parked Gantt). Filled in as dispatch outcomes arrive. */
  held: HeldItemRecord[];
  /** Is the post-merge watch (U4) wired into this daemon? */
  watch: { available: boolean; reason: string | null };
}

export interface DispatchJournalRecord {
  v: 1;
  type: 'dispatch';
  at: string;
  itemId: string;
  /** The fleet task this item projects, when it is one. */
  taskId: string | null;
  runId: string | null;
  /** nameWithOwner when known, else the enrolled directory's name. */
  repo: string;
  title: string;
  source: string;
  backend: string | null;
  model: string | null;
  lane: FleetEngine | null;
  seatId: string | null;
  dispatched: boolean;
  skipReason: string | null;
  proposalId: string | null;
  spentUsd: number;
  seatDecision: SeatDecision | null;
  hold: RouteHold | null;
  /**
   * The harness version (learn/harness-registry.ts) this dispatch ran with:
   * a version id, or null for the compiled baseline. Absent on rows written
   * before B-U9 was wired. It is how a later verification verdict is credited
   * to the right version (recordHarnessOutcome) — the canary's evidence.
   */
  harnessVersionId?: string | null;
}

export interface LandingJournalRecord {
  v: 1;
  type: 'landing';
  at: string;
  landingId: string;
  kind: 'merge' | 'revert';
  repo: string;
  prNumber: number;
  proposalId: string | null;
}

export type FleetJournalRecord = DispatchJournalRecord | LandingJournalRecord;

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = scrubSecrets(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}

function scrubDecision(decision: SeatDecision | null): SeatDecision | null {
  if (!decision) return null;
  return {
    seatId: decision.seatId,
    candidates: decision.candidates.slice(0, 16),
    exclusions: decision.exclusions.slice(0, 16).map((e) => {
      // 3.10.1: the structured twin of `reasons` ("why this seat" reads it).
      const details = boundSeatReasons(e.details, scrubSecrets);
      return {
        seatId: e.seatId,
        reasons: e.reasons.slice(0, 6).map((r) => scrubSecrets(r).slice(0, 300)),
        nextEligibleAt: e.nextEligibleAt,
        ...(details ? { details } : {}),
      };
    }),
    why: scrubSecrets(decision.why).slice(0, 600),
    ...(typeof decision.summary === 'string' ? { summary: scrubSecrets(decision.summary).slice(0, 300) } : {}),
    mode: decision.mode,
  };
}

function scrubHold(hold: RouteHold | null): RouteHold | null {
  if (!hold) return null;
  return { kind: hold.kind, reason: scrubSecrets(hold.reason).slice(0, 600), nextEligibleAt: hold.nextEligibleAt };
}

// ---------------------------------------------------------------------------
// Tick state
// ---------------------------------------------------------------------------

/** Rewrite the tick state atomically. Never throws; false when it could not be written. */
export function writeTickState(state: FleetTickStateV1, file: string = tickStatePath()): boolean {
  try {
    const bounded: FleetTickStateV1 = {
      ...state,
      holdProduction: state.holdProduction ? scrubSecrets(state.holdProduction).slice(0, 600) : null,
      pausedRepos: state.pausedRepos.slice(0, 64).map((p) => ({ repo: p.repo, reason: scrubSecrets(p.reason).slice(0, 400) })),
      held: state.held.slice(-MAX_HELD_PER_TICK).map((h) => ({
        ...h,
        title: cleanTitle(h.title),
        hold: scrubHold(h.hold)!,
        seatDecision: scrubDecision(h.seatDecision),
      })),
      presence: { ...state.presence, reason: scrubSecrets(state.presence.reason).slice(0, 300) },
    };
    ensurePrivateDirectory(fleetRuntimeDir());
    writePrivateFileAtomic(file, `${JSON.stringify(bounded)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The last standing tick, or null when none was ever written / it is unreadable. */
export function readTickState(file: string = tickStatePath()): FleetTickStateV1 | null {
  const read = readPrivateFileCapped(file, MAX_TICK_STATE_BYTES);
  if (!read || read.truncated) return null;
  try {
    const raw = JSON.parse(read.text) as FleetTickStateV1;
    if (raw?.v !== 1 || typeof raw.at !== 'string' || !Array.isArray(raw.lanes) || !Array.isArray(raw.held)) return null;
    return raw;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runs journal
// ---------------------------------------------------------------------------

function rotateIfLarge(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < RUNS_JOURNAL_MAX_BYTES) return;
  const previous = file.replace(/\.jsonl$/, '.1.jsonl');
  try { rmSync(previous, { force: true }); } catch { /* best effort */ }
  renameSync(file, previous);
}

/** Normalize a record for storage (scrub, cap). */
export function normalizeJournalRecord(record: FleetJournalRecord): FleetJournalRecord {
  if (record.type === 'landing') {
    return { ...record, repo: cleanTitle(record.repo) };
  }
  return {
    ...record,
    title: cleanTitle(record.title),
    repo: cleanTitle(record.repo),
    skipReason: record.skipReason ? scrubSecrets(record.skipReason).slice(0, 400) : null,
    seatDecision: scrubDecision(record.seatDecision),
    hold: scrubHold(record.hold),
    spentUsd: Number.isFinite(record.spentUsd) ? Math.max(0, record.spentUsd) : 0,
  };
}

/** Append one row (O_APPEND, O_NOFOLLOW, 0600). Never throws; false when not written. */
export function appendJournal(record: FleetJournalRecord, file: string = runsJournalPath()): boolean {
  try {
    const line = `${JSON.stringify(normalizeJournalRecord(record))}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return false;
    ensurePrivateDirectory(fleetRuntimeDir());
    rotateIfLarge(file);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return false;
      const bytes = Buffer.from(line, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) return false;
        offset += written;
      }
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is FleetJournalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['at'] !== 'string' || !Number.isFinite(Date.parse(r['at']))) return false;
  if (r['type'] === 'dispatch') return typeof r['itemId'] === 'string' && typeof r['repo'] === 'string';
  if (r['type'] === 'landing') return typeof r['landingId'] === 'string' && typeof r['repo'] === 'string';
  return false;
}

/**
 * Rows newer than `sinceMs`, oldest first, from the tail of the journal
 * (and its rotated predecessor when the window reaches back into it).
 * Async — the Verse server reads it off the request path. Never throws.
 */
export async function readJournalSince(
  sinceMs: number,
  opts: { file?: string; maxBytes?: number } = {},
): Promise<FleetJournalRecord[]> {
  const file = opts.file ?? runsJournalPath();
  const maxBytes = opts.maxBytes ?? RUNS_JOURNAL_MAX_BYTES;
  const current = await readTail(file, maxBytes);
  let rows = parseRows(current, sinceMs);
  const oldest = rows[0];
  if (current.length > 0 && (!oldest || Date.parse(oldest.at) > sinceMs)) {
    const previous = await readTail(file.replace(/\.jsonl$/, '.1.jsonl'), maxBytes);
    rows = [...parseRows(previous, sinceMs), ...rows];
  }
  return rows;
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof openAsync>> | null = null;
  try {
    handle = await openAsync(file, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseRows(text: string, sinceMs: number): FleetJournalRecord[] {
  const out: FleetJournalRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && Date.parse(parsed.at) > sinceMs) out.push(parsed);
    } catch {
      // The first line of a tail window is usually partial.
    }
  }
  return out;
}

/** Proposal id → the route (engine, work kind) that produced it, from dispatch rows. */
export function proposalRouteIndex(rows: readonly FleetJournalRecord[]): Map<string, { engine: string; kind: string }> {
  const index = new Map<string, { engine: string; kind: string }>();
  for (const row of rows) {
    if (row.type !== 'dispatch' || !row.proposalId || !row.backend) continue;
    index.set(row.proposalId, { engine: row.backend, kind: row.source });
  }
  return index;
}

/**
 * Proposal id → the harness version its dispatch ran with (null = the
 * baseline). Only dispatch rows that recorded a harness are indexed — a row
 * from before the harness was wired proves nothing about which one ran.
 */
export function proposalHarnessIndex(rows: readonly FleetJournalRecord[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const row of rows) {
    if (row.type !== 'dispatch' || !row.proposalId || row.harnessVersionId === undefined) continue;
    index.set(row.proposalId, row.harnessVersionId);
  }
  return index;
}
