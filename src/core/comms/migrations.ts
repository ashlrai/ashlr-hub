/**
 * 3.14: one-time comms queue migration — unblock the Telegram line.
 *
 * The live queue (~/.ashlr/comms/requests.jsonl) was held shut by a June
 * legacy Strategist briefing (`elon-vision`, status `sent`) and backed up with
 * hundreds of stale 6-hourly fleet digests, while the two Leader memos behind
 * them were never delivered. On the first cycle after upgrade this:
 *
 *   1. expires stale LEGACY `elon-vision` requests (any meta.source other
 *      than 'leader'): every `sent` one (it holds the question slot) and
 *      pending ones older than 24 h — the Strategist path no longer posts;
 *   2. expires pending `fleet-digest` reports older than 24 h — a digest about
 *      last week is noise, not news;
 *   3. re-posts only the NEWEST undelivered Leader memo as an informational
 *      `leader-memo` report (it never blocks, and carries Approve / Veto /
 *      Details buttons), expiring the older Leader-memo questions.
 *
 * Expiry is fail-closed (an expired question is never treated as a yes).
 * Everything expired is returned for logging and recorded in
 * ~/.ashlr/comms/migrations.json, which also marks the migration done so it
 * runs once. Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expireRequestsWhere, listRequests, postRequest, type CommsRequest } from './requests.js';

/** Persisted wire kind of the legacy Strategist briefing AND the pre-3.14 Leader memo question. */
export const LEGACY_BRIEFING_KIND = 'elon-vision';
/** 3.14 wire kind: a Leader memo delivered as an informational (non-blocking) message. */
export const LEADER_MEMO_KIND = 'leader-memo';

const MIGRATION_ID = 'telegram-leader-line-v1';
const DIGEST_STALE_MS = 24 * 3_600_000;

export interface CommsMigrationSummary {
  id: string;
  ranAt: string;
  expiredLegacyBriefings: number;
  expiredStaleDigests: number;
  expiredLeaderMemoQuestions: number;
  /** memoId re-posted as an informational leader-memo report, if any. */
  repostedMemoId: string | null;
  /** Human-readable lines for the cycle log. */
  log: string[];
}

interface MigrationsFile {
  v: 1;
  done: Record<string, CommsMigrationSummary>;
}

function migrationsPath(): string {
  return join(homedir(), '.ashlr', 'comms', 'migrations.json');
}

function loadMigrations(): MigrationsFile {
  try {
    if (!existsSync(migrationsPath())) return { v: 1, done: {} };
    const parsed = JSON.parse(readFileSync(migrationsPath(), 'utf8')) as Partial<MigrationsFile>;
    return { v: 1, done: parsed.done && typeof parsed.done === 'object' ? parsed.done : {} };
  } catch {
    return { v: 1, done: {} };
  }
}

function saveMigrations(file: MigrationsFile): void {
  try {
    mkdirSync(join(homedir(), '.ashlr', 'comms'), { recursive: true });
    writeFileSync(migrationsPath(), JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // best-effort — worst case the (idempotent) migration runs again
  }
}

function isLeaderMemoRequest(r: CommsRequest): boolean {
  return r.kind === LEGACY_BRIEFING_KIND && r.meta?.['source'] === 'leader' && typeof r.meta?.['memoId'] === 'string';
}

function describe(r: CommsRequest): string {
  const flat = r.text.replace(/\s+/g, ' ').trim();
  const text = flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
  return `${r.kind} ${r.status} ${r.id.slice(0, 8)} (created ${r.createdAt.slice(0, 10)}): "${text}"`;
}

/**
 * Run the migration if it has not run yet. Returns its summary on the run
 * that performed it, null when it already ran. Idempotent either way.
 */
export function runCommsMigrationsOnce(nowMs: number = Date.now()): CommsMigrationSummary | null {
  try {
    const file = loadMigrations();
    if (file.done[MIGRATION_ID]) return null;

    const log: string[] = [];
    const legacy = expireRequestsWhere(
      (r) => {
        if (r.kind !== LEGACY_BRIEFING_KIND || r.meta?.['source'] === 'leader') return false;
        // A sent one is holding the question slot: expire it whatever its age.
        if (r.status === 'sent') return true;
        const created = Date.parse(r.createdAt);
        return Number.isFinite(created) && nowMs - created > DIGEST_STALE_MS;
      },
      nowMs,
      'migration: legacy Strategist briefing retired (3.14)',
    );

    const staleDigests = expireRequestsWhere(
      (r) => {
        if (r.kind !== 'fleet-digest' || r.status !== 'pending') return false;
        const created = Date.parse(r.createdAt);
        return Number.isFinite(created) && nowMs - created > DIGEST_STALE_MS;
      },
      nowMs,
      'migration: pending digest older than 24h (3.14)',
    );

    // Leader memos queued as blocking questions: keep the newest one's content
    // (re-posted below as a non-blocking memo message), expire the rest.
    const openMemoQs = listRequests({ kind: LEGACY_BRIEFING_KIND, status: ['pending', 'sent'] }).filter(isLeaderMemoRequest);
    const newest = [...openMemoQs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const memoQs = expireRequestsWhere(
      isLeaderMemoRequest,
      nowMs,
      'migration: Leader memo moved to a non-blocking memo message (3.14)',
    );
    let repostedMemoId: string | null = null;
    if (newest && newest.status === 'pending') {
      const memoId = newest.meta!['memoId'] as string;
      const already = listRequests({ kind: LEADER_MEMO_KIND }).some((r) => r.meta?.['memoId'] === memoId);
      if (!already) {
        postRequest({
          kind: LEADER_MEMO_KIND,
          type: 'report',
          text: newest.text,
          options: [],
          meta: { source: 'leader', memoId, migratedFrom: newest.id },
        });
        repostedMemoId = memoId;
      }
    }

    for (const r of legacy) log.push(`expired legacy briefing: ${describe(r)}`);
    if (staleDigests.length > 0) {
      const oldest = staleDigests.map((r) => r.createdAt).sort()[0]!.slice(0, 10);
      log.push(`expired ${staleDigests.length} pending fleet digest(s) older than 24h (oldest ${oldest})`);
    }
    for (const r of memoQs) log.push(`expired Leader memo question: ${describe(r)}`);
    if (repostedMemoId) log.push(`re-queued Leader memo ${repostedMemoId} as a non-blocking message`);
    if (log.length === 0) log.push('nothing to migrate');

    const summary: CommsMigrationSummary = {
      id: MIGRATION_ID,
      ranAt: new Date(nowMs).toISOString(),
      expiredLegacyBriefings: legacy.length,
      expiredStaleDigests: staleDigests.length,
      expiredLeaderMemoQuestions: memoQs.length,
      repostedMemoId,
      log,
    };
    file.done[MIGRATION_ID] = summary;
    saveMigrations(file);
    return summary;
  } catch {
    return null;
  }
}
