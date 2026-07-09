/**
 * M21: Append-only audit trail for autonomous/sandbox actions.
 *
 * Writes to ~/.ashlr/audit/<YYYY-MM-DD>.jsonl — one JSON object per line.
 * Rules:
 *   - Append-only: never truncate, never rewrite, never delete a prior line.
 *   - Never write secrets: summary is metadata only; secret-shaped tokens are
 *     stripped defensively before persisting.
 *   - audit() never throws; readAudit() skips malformed lines, never throws.
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
import type { AuditEntry } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Public: auditDir()
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the audit directory: ~/.ashlr/audit.
 * Created lazily by audit() — this function itself does NOT create it.
 */
export function auditDir(): string {
  return join(homedir(), '.ashlr', 'audit');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Current date as YYYY-MM-DD (UTC) for the daily file name. */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Defensively strip secret-shaped tokens from a summary string before
 * persisting. Targets common patterns: long hex strings, bearer tokens,
 * base64-looking blobs, and key=value pairs that look like credentials.
 *
 * This is a best-effort guardrail — the contract says "summary is metadata
 * only, never secrets"; callers are the primary enforcement point.
 */
function stripSecrets(summary: string): string {
  return scrubSecrets(summary);
}

// ---------------------------------------------------------------------------
// Public: audit()
// ---------------------------------------------------------------------------

/**
 * Append one audit entry to today's JSONL file under ~/.ashlr/audit/.
 * Sets `ts` to the current ISO timestamp; the caller supplies everything else.
 *
 * Append-only: never truncates, never rewrites existing lines.
 * Never throws — errors are swallowed silently to keep callers unblocked.
 */
export function audit(entry: Omit<AuditEntry, 'ts'>): void {
  try {
    const dir = auditDir();

    // Ensure audit directory exists (lazy mkdir).
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const record: AuditEntry = {
      ts: new Date().toISOString(),
      action: entry.action,
      repo: entry.repo,
      sandboxId: entry.sandboxId,
      // Strip secret-shaped tokens defensively; summary is metadata only.
      summary: stripSecrets(entry.summary),
      result: entry.result,
    };

    const line = JSON.stringify(record) + '\n';
    const filePath = join(dir, `${todayDateString()}.jsonl`);

    // Append-only — appendFileSync creates the file if missing, never truncates.
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // Intentionally swallowed: audit must never disrupt the caller's flow.
  }
}

// ---------------------------------------------------------------------------
// M52: auditConfinement() — typed confinement audit event
// ---------------------------------------------------------------------------

/**
 * Append a `confinement` audit event for a contained engine run.
 *
 * Fields:
 *   engine       — the EngineId being contained.
 *   mode         — 'off' | 'os' (the resolved profile mode).
 *   networkEgress — whether outbound network was permitted.
 *   readAllowed  — extra read-allowed paths (if any).
 *   platform     — process.platform at the time of the run.
 *   launched     — true when an OS jail launcher was actually built (false = env-only fallback).
 *   fallback     — true when launched:false but mode was 'os' (i.e. unsupported platform, fallback).
 *
 * Delegates to audit() — append-only, never throws.
 */
export function auditConfinement(event: {
  engine: string;
  mode: string;
  networkEgress: boolean;
  readAllowed?: string[];
  platform: string;
  launched: boolean;
  fallback?: boolean;
  /** Worktree path (used as `repo`). */
  worktree: string;
  /** Sandbox id (or null). */
  sandboxId: string | null;
}): void {
  audit({
    action: 'confinement.run',
    repo: event.worktree,
    sandboxId: event.sandboxId,
    summary: [
      `engine=${event.engine}`,
      `mode=${event.mode}`,
      `platform=${event.platform}`,
      `launched=${event.launched}`,
      `networkEgress=${event.networkEgress}`,
      event.fallback ? 'fallback=true' : '',
      event.readAllowed?.length ? `readAllowed=${event.readAllowed.length}` : '',
    ].filter(Boolean).join(' '),
    result: 'ok',
  });
}

// ---------------------------------------------------------------------------
// Public: readAudit()
// ---------------------------------------------------------------------------

/**
 * Read audit entries across all date files, newest-first.
 * `limit` caps the number returned (undefined or 0 => return all).
 *
 * Malformed JSONL lines are silently skipped; never throws.
 */
export function readAudit(limit?: number): AuditEntry[] {
  try {
    const dir = auditDir();

    if (!existsSync(dir)) {
      return [];
    }

    // List all .jsonl files, sort descending (newest date first).
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch {
      return [];
    }

    const entries: AuditEntry[] = [];
    const cap = limit !== undefined && limit > 0 ? limit : Infinity;

    for (const file of files) {
      if (entries.length >= cap) break;

      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue; // unreadable file — skip
      }

      // Collect lines in reverse order so newest entries within the file come first.
      const lines = raw.split('\n').filter((l) => l.trim() !== '').reverse();

      for (const line of lines) {
        if (entries.length >= cap) break;

        try {
          const parsed: unknown = JSON.parse(line);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)
          ) {
            // Light structural validation — skip clearly malformed entries.
            const obj = parsed as Record<string, unknown>;
            if (
              typeof obj['ts'] === 'string' &&
              typeof obj['action'] === 'string' &&
              typeof obj['summary'] === 'string' &&
              (obj['result'] === 'ok' ||
                obj['result'] === 'refused' ||
                obj['result'] === 'error')
            ) {
              entries.push(obj as unknown as AuditEntry);
            }
          }
        } catch {
          // Malformed JSON line — skip silently.
        }
      }
    }

    return entries;
  } catch {
    // Top-level guard: readAudit must never throw.
    return [];
  }
}
