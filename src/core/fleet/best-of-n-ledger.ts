/**
 * best-of-n-ledger.ts — M333: append-only per-candidate record stream for
 * multi-model best-of-N dispatches (~/.ashlr/best-of-n/YYYY-MM-DD.jsonl).
 *
 * Mirrors decisions-ledger conventions:
 *  - append-only (never truncate/rewrite);
 *  - never throws (telemetry must never fail a dispatch);
 *  - readBestOfNRecords skips malformed lines.
 *
 * Feeds the M335 Models tab (per-model best-of-N win rates) and future
 * learned-routing refinements.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';

export interface BestOfNCandidateRecord {
  index: number;
  runId?: string;
  engine: string;
  model: string | null;
  score: number;
  testsPassed?: boolean;
  costUsd?: number;
  latencyMs?: number;
  error?: string;
  proposalOutcome?: string;
  proposalOutcomeReason?: string;
  proposalId: string | null;
  won: boolean;
}

export interface BestOfNRecord {
  ts: string;
  attemptId?: string;
  workItemId?: string;
  source: string;
  repo: string | null;
  n: number;
  winnerIndex: number;
  winnerProposalId: string | null;
  totalCostUsd: number;
  candidates: BestOfNCandidateRecord[];
}

export function bestOfNDir(): string {
  return join(homedir(), '.ashlr', 'best-of-n');
}

/** Append one record. Never throws. */
export function recordBestOfN(record: BestOfNRecord): void {
  try {
    const dir = bestOfNDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const day = record.ts.slice(0, 10) || new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // telemetry is best-effort — never fails the dispatch
  }
}

/** Read records newest-file-first, skipping malformed lines. Never throws. */
export function readBestOfNRecords(opts?: { sinceMs?: number; limit?: number }): BestOfNRecord[] {
  try {
    const dir = bestOfNDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const out: BestOfNRecord[] = [];
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    for (const file of files) {
      if (out.length >= cap) break;
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n').reverse()) {
        if (out.length >= cap) break;
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (
            typeof parsed['ts'] !== 'string' ||
            typeof parsed['n'] !== 'number' ||
            !Array.isArray(parsed['candidates'])
          ) {
            continue;
          }
          if (opts?.sinceMs !== undefined && Date.parse(parsed['ts']) < opts.sinceMs) continue;
          out.push(parsed as unknown as BestOfNRecord);
        } catch {
          // skip malformed line
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
