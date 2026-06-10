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
  return (
    summary
      // bearer / auth headers
      .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
      // key=value credential patterns  (api_key=xxx, secret=xxx, token=xxx, password=xxx)
      .replace(
        /\b(api[_-]?key|secret|token|password|passwd|auth|credential)[=:\s]+[^\s,;'"]{8,}/gi,
        '$1=[REDACTED]',
      )
      // Known-prefix provider tokens (anchored on the prefix so we don't redact
      // ordinary identifiers). Covers OpenAI/Anthropic-style sk-, GitHub PAT/OAuth
      // ghp_/gho_/ghu_/ghs_/ghr_, Slack xox[baprs]-, and AWS access key ids.
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/\bgh[poursa]_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '[REDACTED]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
      // JWTs: three base64url segments separated by dots, header starts with eyJ.
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      // Long hex strings ≥ 40 hex chars (private keys, raw API keys). Threshold
      // raised above 32 so git SHA-1 (40) is borderline — but git short SHAs and
      // path components are <40, and we WANT full forensic SHAs preserved, so we
      // anchor on a length that real secrets exceed while commit/file metadata
      // generally does not. Conservative: over-redaction would harm forensics.
      .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]')
  );
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
