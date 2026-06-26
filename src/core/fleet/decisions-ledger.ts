/**
 * M119: Append-only decisions ledger for the fleet oversight layer.
 *
 * Writes to ~/.ashlr/decisions/<YYYY-MM-DD>.jsonl — one DecisionEntry per line.
 *
 * Rules (mirror audit.ts):
 *   - Append-only: never truncate, never rewrite, never delete a prior line.
 *   - Never write secrets: detail field is stripped of secret-shaped tokens.
 *   - recordDecision() never throws.
 *   - readDecisions() skips malformed lines, never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
  readFileSync,
} from 'node:fs';
import type { DecisionEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the decisions directory: ~/.ashlr/decisions. */
export function decisionsDir(): string {
  return join(homedir(), '.ashlr', 'decisions');
}

/** Current date as YYYY-MM-DD (UTC) for the daily file name. */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Secret scrubbing (mirror audit.ts's stripSecrets)
// ---------------------------------------------------------------------------

function stripSecrets(s: string): string {
  return (
    s
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
      .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]')
  );
}

// ---------------------------------------------------------------------------
// Public: recordDecision()
// ---------------------------------------------------------------------------

/**
 * Append one DecisionEntry to today's JSONL file under ~/.ashlr/decisions/.
 * Sets `ts` to the current ISO timestamp when not provided.
 *
 * Append-only. Never throws.
 */
export function recordDecision(entry: DecisionEntry): void {
  try {
    const dir = decisionsDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const record: DecisionEntry = {
      ...entry,
      ts: entry.ts || new Date().toISOString(),
      ...(entry.detail !== undefined ? { detail: stripSecrets(entry.detail) } : {}),
    };

    const line = JSON.stringify(record) + '\n';
    const filePath = join(dir, `${todayDateString()}.jsonl`);
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // Intentionally swallowed: ledger must never disrupt the caller's flow.
  }
}

// ---------------------------------------------------------------------------
// Public: readDecisions()
// ---------------------------------------------------------------------------

/**
 * Read decision entries, newest-first.
 *
 * Options:
 *   sinceMs   — exclude entries older than this epoch ms
 *   proposalId — filter to a specific proposal id
 *   limit     — cap total returned (0 or undefined = all)
 *
 * Malformed JSONL lines are silently skipped. Never throws.
 */
export function readDecisions(opts?: {
  sinceMs?: number;
  proposalId?: string;
  limit?: number;
}): DecisionEntry[] {
  try {
    const dir = decisionsDir();
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

    const entries: DecisionEntry[] = [];
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    const sinceMs = opts?.sinceMs;
    const pid = opts?.proposalId;

    for (const file of files) {
      if (entries.length >= cap) break;

      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = raw.split('\n').filter((l) => l.trim() !== '').reverse();

      for (const line of lines) {
        if (entries.length >= cap) break;

        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (
              typeof obj['ts'] === 'string' &&
              typeof obj['proposalId'] === 'string' &&
              typeof obj['action'] === 'string'
            ) {
              // Window filter
              if (sinceMs !== undefined) {
                const entryMs = Date.parse(obj['ts'] as string);
                if (!isNaN(entryMs) && entryMs < sinceMs) continue;
              }
              // Proposal filter
              if (pid !== undefined && obj['proposalId'] !== pid) continue;

              entries.push(obj as unknown as DecisionEntry);
            }
          }
        } catch {
          // Malformed line — skip silently.
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}
