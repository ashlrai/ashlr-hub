/**
 * M137: iMessage bidirectional channel adapter — macOS-native.
 *
 * Provides two primitives:
 *   sendIMessage(text, cfg)         — osascript send via execFile (never a shell)
 *   pollInboundReplies(sinceMs, cfg) — chat.db SELECT, read-only, apple-epoch aware
 *
 * Strict no-op unless BOTH hold: cfg.comms.enabled === true AND
 * cfg.comms.imessageHandle is set. Mirrors desktop-notify.ts conventions:
 *   - execFile (never exec/shell)
 *   - never throws
 *   - 5s timeout on osascript
 *   - handle-filtered output only (ignore all other conversations)
 *
 * macOS permissions required:
 *   - Automation → Messages  (to call osascript tell application "Messages")
 *   - Full Disk Access        (to read ~/Library/Messages/chat.db)
 *
 * The text passed to sendIMessage is delivered to the AppleScript engine as a
 * quoted argument with all special characters escaped — the AppleScript
 * interpreter never sees raw user-controlled bytes in an interpolated position.
 *
 * Apple epoch: Messages stores `date` as nanoseconds since 2001-01-01T00:00:00Z.
 *   unixMs = appleNs / 1_000_000 + 978_307_200_000
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEND_TIMEOUT_MS = 5_000;
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000; // ms between Unix epoch and Apple epoch (2001-01-01)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundMsg {
  text: string;
  ts: number;   // unix ms
  handle: string;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True when the comms channel is properly configured and enabled. */
export function commsEnabled(cfg: AshlrConfig): boolean {
  const c = cfg.comms;
  return c?.enabled === true && typeof c.imessageHandle === 'string' && c.imessageHandle.length > 0;
}

// ---------------------------------------------------------------------------
// AppleScript escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion inside an AppleScript double-quoted
 * string literal. We escape backslashes, double-quotes, and collapse newlines.
 * This is the ONLY escaping context — the entire text is passed as a single
 * -e script literal to osascript, not via a shell. execFile guarantees the
 * osascript process receives the literal string; no shell expansion occurs.
 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// sendIMessage
// ---------------------------------------------------------------------------

/**
 * Send an iMessage to cfg.comms.imessageHandle. Uses execFile + osascript
 * (darwin only). Never throws; returns {ok:false} on any failure or when
 * disabled/misconfigured.
 *
 * Injection safety: the message text is embedded inside an AppleScript
 * double-quoted string with escapeAppleScript() applied. execFile passes the
 * entire -e script as a single argv element — no shell tokenisation occurs.
 */
export function sendIMessage(text: string, cfg: AshlrConfig): Promise<{ ok: boolean }> {
  if (!commsEnabled(cfg)) return Promise.resolve({ ok: false });
  if (process.platform !== 'darwin') return Promise.resolve({ ok: false });

  const handle = cfg.comms!.imessageHandle!;
  const service = cfg.comms?.service ?? 'iMessage';

  const safeText = escapeAppleScript(text);
  const safeHandle = escapeAppleScript(handle);
  const safeService = escapeAppleScript(service);

  // Use `1st service whose service type = iMessage` instead of `of service "iMessage"` by name.
  // The by-name form errors -1728 on macOS 13+ when the service name doesn't match exactly.
  // When a custom service name is configured (non-default), fall back to the by-name form.
  const useTypeSelector = service === 'iMessage';
  const serviceClause = useTypeSelector
    ? 'of (1st service whose service type = iMessage)'
    : `of service "${safeService}"`;
  const script =
    `tell application "Messages" to send "${safeText}" to buddy "${safeHandle}" ` +
    serviceClause;

  return new Promise<{ ok: boolean }>((resolve) => {
    try {
      execFile('osascript', ['-e', script], { timeout: SEND_TIMEOUT_MS }, (err) => {
        resolve({ ok: !err });
      });
    } catch {
      resolve({ ok: false });
    }
  });
}

// ---------------------------------------------------------------------------
// pollInboundReplies — chat.db read
// ---------------------------------------------------------------------------

// One-time hint flag — emit to stderr once if Full Disk Access is not granted.
let _hintEmitted = false;

/**
 * Convert an Apple-epoch nanoseconds integer (from chat.db `date` column) to
 * a Unix millisecond timestamp.
 */
export function appleNsToUnixMs(appleNs: number): number {
  return appleNs / 1_000_000 + APPLE_EPOCH_OFFSET_MS;
}

/**
 * Read recent inbound messages from ~/Library/Messages/chat.db using the
 * sqlite3 CLI (READ-ONLY mode). Filters to messages from cfg.comms.imessageHandle
 * only (is_from_me=0). Returns [] on any failure (unreadable db, missing
 * permissions, no sqlite3 binary, wrong platform). Never throws.
 *
 * Returns only messages whose timestamp (Apple epoch ns → unix ms) > sinceMs.
 *
 * Full Disk Access note: if chat.db is locked/unreadable, emits a one-time
 * hint to stderr and returns []. The caller (dispatch) should surface this
 * to the user via `ashlr comms status`.
 */
export function pollInboundReplies(sinceMs: number, cfg: AshlrConfig): Promise<InboundMsg[]> {
  if (!commsEnabled(cfg)) return Promise.resolve([]);
  if (process.platform !== 'darwin') return Promise.resolve([]);

  const handle = cfg.comms!.imessageHandle!;
  const dbPath = join(homedir(), 'Library', 'Messages', 'chat.db');

  if (!existsSync(dbPath)) {
    return Promise.resolve([]);
  }

  // Apple epoch threshold: convert sinceMs back to Apple ns for the SQL WHERE clause.
  // appleNs = (unixMs - APPLE_EPOCH_OFFSET_MS) * 1_000_000
  const appleNsThreshold = (sinceMs - APPLE_EPOCH_OFFSET_MS) * 1_000_000;

  // SQL query: join message + handle, filter is_from_me=0 and matching handle id.
  // We use single-quotes inside the SQL so no shell escaping of the handle is needed —
  // the entire SQL is passed as a single argv element to sqlite3 via execFile.
  // The handle value is embedded with basic SQL-string escaping (single-quote doubling).
  const safeHandle = handle.replace(/'/g, "''");
  const sql =
    `SELECT m.text, m.date FROM message m ` +
    `JOIN handle h ON m.handle_id = h.ROWID ` +
    `WHERE m.is_from_me = 0 ` +
    `AND h.id = '${safeHandle}' ` +
    `AND m.date > ${appleNsThreshold} ` +
    `AND m.text IS NOT NULL ` +
    `ORDER BY m.date ASC;`;

  return new Promise<InboundMsg[]>((resolve) => {
    try {
      // -readonly: open chat.db in WAL read-only mode (no writes, no journal locks)
      // -separator '|': use | to separate columns since text may contain commas
      execFile(
        'sqlite3',
        ['-readonly', '-separator', '|', dbPath, sql],
        { timeout: 5_000 },
        (err, stdout, stderr) => {
          if (err) {
            // Check for permission denial (EPERM / "unable to open" / "authorization denied")
            const errMsg = (stderr ?? '') + (err.message ?? '');
            const isPermErr =
              errMsg.includes('unable to open') ||
              errMsg.includes('authorization denied') ||
              errMsg.includes('EPERM') ||
              errMsg.includes('Operation not permitted');
            if (isPermErr && !_hintEmitted) {
              _hintEmitted = true;
              process.stderr.write(
                '[ashlr comms] Cannot read chat.db — grant Full Disk Access to Terminal ' +
                '(System Settings → Privacy & Security → Full Disk Access).\n',
              );
            }
            return resolve([]);
          }

          const msgs: InboundMsg[] = [];
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Format: text|appleNs  (text may contain | so split from right)
            const lastPipe = trimmed.lastIndexOf('|');
            if (lastPipe < 0) continue;
            // MED-2: strip embedded newlines from the text field so a crafted
            // message body containing \n cannot inject a spurious extra record.
            const text = trimmed.slice(0, lastPipe).replace(/[\r\n]/g, ' ');
            const dateRaw = trimmed.slice(lastPipe + 1);
            const appleNs = parseFloat(dateRaw);
            if (!isFinite(appleNs)) continue;
            const ts = appleNsToUnixMs(appleNs);
            if (ts <= sinceMs) continue; // guard against floating-point drift
            msgs.push({ text, ts, handle });
          }
          resolve(msgs);
        },
      );
    } catch {
      resolve([]);
    }
  });
}
