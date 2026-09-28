/**
 * run-cancel.ts — stop ONE fleet run, from any process (3.15, the Fleet
 * control surface).
 *
 * Fleet runs live in the daemon process; the Verse server that Mason clicks
 * in is a different process. The only cross-process stop that existed was
 * Stop (`~/.ashlr/KILL`), which halts EVERY run. This module is the narrow
 * one: Verse writes a request file naming a run id, and the run's execution
 * lease probe (run/sandboxed-engine.ts `executionLeaseStopProbe`, polled every
 * 2 s in the daemon) aborts that one run when it sees it.
 *
 * LOWERING ONLY. A request can only make a run stop sooner; it grants nothing,
 * and a forged or stale file at worst stops a run early — the same effect Stop
 * has on every run. So the file carries no signature, just the run id's hash,
 * a reason and a time.
 *
 * STORE: `~/.ashlr/fleet/run-cancel/<sha256(runId)[:32]>.json` (dir 0700, file
 * 0600). Requests older than RUN_CANCEL_TTL_MS are ignored and swept, so a run
 * id that is reused days later is never stopped by an old click.
 *
 * The probe side (`runCancelRequested`) is called every 2 s per live run, so it
 * is a single lstat on the miss path and never throws.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

/** A request older than this is ignored (and swept). */
export const RUN_CANCEL_TTL_MS = 6 * 60 * 60_000;
const MAX_REASON_CHARS = 300;
const MAX_FILE_BYTES = 4 * 1024;
/** Run ids are generated identifiers; anything else is refused before hashing. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;

export function runCancelDir(home: string = homedir()): string {
  return join(home, '.ashlr', 'fleet', 'run-cancel');
}

function fileFor(runId: string, home?: string): string {
  const digest = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32);
  return join(runCancelDir(home), `${digest}.json`);
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

export interface RunCancelRequest {
  v: 1;
  runId: string;
  reason: string;
  requestedAt: string;
  by: 'mason';
}

export type RequestRunCancelResult = { ok: true; request: RunCancelRequest; already: boolean } | { ok: false; reason: string };

/** Ask the run to stop. Idempotent: a second request for the same run keeps the first. */
export function requestRunCancel(runId: string, reason: string, opts: { nowMs?: number; home?: string } = {}): RequestRunCancelResult {
  if (!isRunId(runId)) return { ok: false, reason: 'runId is not a run id.' };
  const nowMs = opts.nowMs ?? Date.now();
  const existing = runCancelRequested(runId, { nowMs, ...(opts.home ? { home: opts.home } : {}) });
  if (existing) return { ok: true, request: existing, already: true };
  const request: RunCancelRequest = {
    v: 1,
    runId,
    // eslint-disable-next-line no-control-regex -- strips control characters from free text
    reason: scrubSecrets(String(reason ?? '')).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MAX_REASON_CHARS) || 'stopped from the Fleet tab',
    requestedAt: new Date(nowMs).toISOString(),
    by: 'mason',
  };
  try {
    ensurePrivateDirectory(runCancelDir(opts.home));
    writePrivateFileAtomic(fileFor(runId, opts.home), `${JSON.stringify(request)}\n`);
  } catch (error) {
    return { ok: false, reason: `The stop request could not be written (${scrubSecrets((error as Error).message).slice(0, 160)}).` };
  }
  return { ok: true, request, already: false };
}

/**
 * The probe: the live request for `runId`, or null. One lstat on the miss
 * path. Never throws (a probe that throws counts as "keep running", and the
 * fence re-check stays the real gate).
 */
export function runCancelRequested(runId: string, opts: { nowMs?: number; home?: string } = {}): RunCancelRequest | null {
  try {
    if (!isRunId(runId)) return null;
    const path = fileFor(runId, opts.home);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return null;
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs - stat.mtimeMs > RUN_CANCEL_TTL_MS) return null;
    const read = readPrivateFileCapped(path, MAX_FILE_BYTES);
    if (!read) return null;
    const parsed = JSON.parse(read.text) as Partial<RunCancelRequest>;
    if (parsed.v !== 1 || parsed.runId !== runId || typeof parsed.reason !== 'string' || typeof parsed.requestedAt !== 'string') return null;
    return { v: 1, runId, reason: parsed.reason, requestedAt: parsed.requestedAt, by: 'mason' };
  } catch {
    return null;
  }
}

/** Remove requests past their TTL. Returns how many were removed; never throws. */
export function sweepRunCancelRequests(opts: { nowMs?: number; home?: string } = {}): number {
  const nowMs = opts.nowMs ?? Date.now();
  const dir = runCancelDir(opts.home);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) continue;
    try {
      const stat = lstatSync(join(dir, name));
      if (stat.isFile() && nowMs - stat.mtimeMs > RUN_CANCEL_TTL_MS) {
        unlinkSync(join(dir, name));
        removed += 1;
      }
    } catch {
      // raced with another sweep
    }
  }
  return removed;
}
