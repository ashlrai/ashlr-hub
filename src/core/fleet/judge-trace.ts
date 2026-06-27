/**
 * M141: Judge trace store — append-only JSONL sink for the full CoT reasoning
 * produced by the manager judge on every proposal.
 *
 * Writes to ~/.ashlr/judge-traces/YYYY-MM-DD.jsonl — one JudgeTrace per line.
 * Mirrors decisions-ledger.ts conventions:
 *   - Append-only; never truncate/rewrite/delete.
 *   - Secret-scrubbed before write.
 *   - recordJudgeTrace() never throws.
 *   - readJudgeTraces() skips malformed lines, never throws.
 *   - linkOutcome() patches the matching trace's `outcome` field in-place
 *     by rewriting only the trace's own JSONL file line — or appends a
 *     synthetic patch record when the trace is in a prior day's file
 *     (immutable-append-safe fallback).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JudgeOutcome = 'merged' | 'reverted' | 'rejected';

export interface JudgeTrace {
  /** Proposal id this trace belongs to. */
  proposalId: string;
  /** Model/engine that produced the verdict (e.g. 'claude-sonnet-4-5'). */
  judgeEngine: string;
  /** Parsed verdict: ship | review | noise | harmful. */
  verdict: 'ship' | 'review' | 'noise' | 'harmful';
  /** Dimension scores (clamped 1-5). */
  scores: {
    value: number;
    correctness: number;
    scope: number;
    alignment: number;
  };
  /**
   * Full chain-of-thought reasoning text extracted from the judge response
   * (the prose that precedes the verdict JSON). May be empty string when
   * the judge emitted no prose before the JSON block.
   */
  fullReasoning: string;
  /**
   * Snapshot of the prompt context sent to the judge (title, summary, kind,
   * engine, optional vision section — NOT the full diff to keep the file lean).
   */
  promptContext: string;
  /** ISO timestamp of when the trace was recorded. */
  ts: string;
  /**
   * Real-world outcome, populated later via linkOutcome().
   * undefined until the proposal is merged/reverted/rejected.
   */
  outcome?: JudgeOutcome;
  /** ISO timestamp when linkOutcome() was called. */
  outcomeAt?: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the judge-traces directory: ~/.ashlr/judge-traces. */
export function judgeTracesDir(): string {
  return join(homedir(), '.ashlr', 'judge-traces');
}

/** Current date as YYYY-MM-DD (UTC) for the daily file name. */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Secret scrubbing (mirror decisions-ledger.ts)
// ---------------------------------------------------------------------------

function stripSecrets(s: string): string {
  return s
    .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|secret|token|password|passwd|auth|credential)[=:\s]+[^\s,;'"]{8,}/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bgh[poursa]_[A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]');
}

function scrubTrace(trace: JudgeTrace): JudgeTrace {
  return {
    ...trace,
    fullReasoning: stripSecrets(trace.fullReasoning),
    promptContext: stripSecrets(trace.promptContext),
  };
}

// ---------------------------------------------------------------------------
// Public: recordJudgeTrace()
// ---------------------------------------------------------------------------

/**
 * Append one JudgeTrace to today's JSONL file under ~/.ashlr/judge-traces/.
 * Sets `ts` to current ISO timestamp when not provided.
 *
 * Append-only. Never throws.
 */
export function recordJudgeTrace(trace: Omit<JudgeTrace, 'ts'> & { ts?: string }): void {
  try {
    const dir = judgeTracesDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const record: JudgeTrace = scrubTrace({
      ...trace,
      ts: trace.ts ?? new Date().toISOString(),
    } as JudgeTrace);

    const line = JSON.stringify(record) + '\n';
    const filePath = join(dir, `${todayDateString()}.jsonl`);
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // Intentionally swallowed: trace store must never disrupt the caller's flow.
  }
}

// ---------------------------------------------------------------------------
// Public: readJudgeTraces()
// ---------------------------------------------------------------------------

/**
 * Read judge traces, newest-first.
 *
 * Options:
 *   proposalId — filter to a specific proposal id
 *   verdict    — filter to a specific verdict
 *   sinceMs    — exclude entries older than this epoch ms
 *   limit      — cap total returned (0 or undefined = all)
 *   outcomeOnly — when true, only return traces that have an outcome set
 *
 * Malformed JSONL lines are silently skipped. Never throws.
 */
export function readJudgeTraces(filter?: {
  proposalId?: string;
  verdict?: JudgeTrace['verdict'];
  sinceMs?: number;
  limit?: number;
  outcomeOnly?: boolean;
}): JudgeTrace[] {
  try {
    const dir = judgeTracesDir();
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse(); // newest date first
    } catch {
      return [];
    }

    const traces: JudgeTrace[] = [];
    const cap =
      filter?.limit !== undefined && filter.limit > 0 ? filter.limit : Infinity;
    const sinceMs = filter?.sinceMs;
    const pid = filter?.proposalId;
    const verd = filter?.verdict;
    const outcomeOnly = filter?.outcomeOnly ?? false;

    for (const file of files) {
      if (traces.length >= cap) break;

      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = raw
        .split('\n')
        .filter((l) => l.trim() !== '')
        .reverse(); // newest lines first within file

      for (const line of lines) {
        if (traces.length >= cap) break;

        try {
          const parsed: unknown = JSON.parse(line);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)
          ) {
            const obj = parsed as Record<string, unknown>;
            // Validate required fields
            if (
              typeof obj['proposalId'] === 'string' &&
              typeof obj['judgeEngine'] === 'string' &&
              typeof obj['verdict'] === 'string' &&
              typeof obj['ts'] === 'string'
            ) {
              // Window filter
              if (sinceMs !== undefined) {
                const entryMs = Date.parse(obj['ts'] as string);
                if (!isNaN(entryMs) && entryMs < sinceMs) continue;
              }
              // Proposal filter
              if (pid !== undefined && obj['proposalId'] !== pid) continue;
              // Verdict filter
              if (verd !== undefined && obj['verdict'] !== verd) continue;
              // Outcome-only filter
              if (outcomeOnly && !obj['outcome']) continue;

              traces.push(obj as unknown as JudgeTrace);
            }
          }
        } catch {
          // Malformed line — skip silently.
        }
      }
    }

    return traces;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public: linkOutcome()
// ---------------------------------------------------------------------------

/**
 * Attach a real-world outcome to a previously recorded trace.
 *
 * Strategy:
 *   1. Scan all JSONL files newest-first for a trace with `proposalId`.
 *   2. When found in today's file: rewrite that file with the outcome patched
 *      in-place (still append-only semantics for other tools reading the file,
 *      but we need to mutate the one line — acceptable for today's mutable file).
 *   3. When found in a prior day's file (immutable by convention): append a
 *      synthetic "outcome patch" record to today's file instead, so the
 *      outcome is queryable without rewriting immutable history.
 *   4. When not found: no-op (trace may not have been recorded — rare).
 *
 * Never throws.
 */
export function linkOutcome(
  proposalId: string,
  outcome: JudgeOutcome,
): void {
  try {
    const dir = judgeTracesDir();
    if (!existsSync(dir)) return;

    const today = todayDateString();
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse(); // newest first
    } catch {
      return;
    }

    const outcomeAt = new Date().toISOString();

    for (const file of files) {
      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = raw.split('\n');
      let foundIdx = -1;

      // Find the LAST occurrence of this proposalId (most recent trace).
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['proposalId'] === proposalId && typeof obj['verdict'] === 'string') {
            foundIdx = i;
            break;
          }
        } catch {
          // skip
        }
      }

      if (foundIdx === -1) continue; // not in this file

      const fileDate = file.replace('.jsonl', '');

      if (fileDate === today) {
        // Rewrite today's file with the outcome patched in-place.
        try {
          const updatedLines = lines.map((line, i) => {
            if (i !== foundIdx || !line.trim()) return line;
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              obj['outcome'] = outcome;
              obj['outcomeAt'] = outcomeAt;
              return JSON.stringify(obj);
            } catch {
              return line;
            }
          });
          writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
        } catch {
          // fall through to synthetic append
        }
      } else {
        // Prior day — immutable. Append a patch record to today's file.
        try {
          const todayPath = join(dir, `${today}.jsonl`);
          // Read the original trace to include its key fields in the patch.
          const origLine = lines[foundIdx]!.trim();
          let origTrace: Record<string, unknown> = {};
          try { origTrace = JSON.parse(origLine) as Record<string, unknown>; } catch { /* ok */ }

          const patch: Record<string, unknown> = {
            proposalId,
            judgeEngine: origTrace['judgeEngine'] ?? 'unknown',
            verdict: origTrace['verdict'] ?? 'review',
            scores: origTrace['scores'] ?? {},
            fullReasoning: '',       // omit body in patch record
            promptContext: '',
            ts: origTrace['ts'] ?? outcomeAt,
            outcome,
            outcomeAt,
            _patchFor: file,         // provenance: which file holds the original
          };
          appendFileSync(todayPath, JSON.stringify(patch) + '\n', 'utf8');
        } catch {
          // swallow
        }
      }

      return; // done — only patch the most recent trace for this proposalId
    }
  } catch {
    // Never throws.
  }
}

// ---------------------------------------------------------------------------
// Public: outcomeStats()
// ---------------------------------------------------------------------------

/**
 * Compute outcome-link coverage across all traces.
 * Returns { total, withOutcome, outcomeRate, byVerdict, byOutcome }.
 * Never throws.
 */
export function outcomeStats(): {
  total: number;
  withOutcome: number;
  outcomeRate: number;
  byVerdict: Record<string, { total: number; withOutcome: number }>;
  byOutcome: Record<string, number>;
} {
  const zero = () => ({ total: 0, withOutcome: 0 });
  try {
    const traces = readJudgeTraces();
    const byVerdict: Record<string, { total: number; withOutcome: number }> = {};
    const byOutcome: Record<string, number> = {};

    for (const t of traces) {
      if (!byVerdict[t.verdict]) byVerdict[t.verdict] = zero();
      byVerdict[t.verdict]!.total++;
      if (t.outcome) {
        byVerdict[t.verdict]!.withOutcome++;
        byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
      }
    }

    const total = traces.length;
    const withOutcome = traces.filter((t) => t.outcome).length;
    return {
      total,
      withOutcome,
      outcomeRate: total > 0 ? withOutcome / total : 0,
      byVerdict,
      byOutcome,
    };
  } catch {
    return { total: 0, withOutcome: 0, outcomeRate: 0, byVerdict: {}, byOutcome: {} };
  }
}
