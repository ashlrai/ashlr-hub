/**
 * M18 — notify.ts
 *
 * Sends a concise completion summary to configured webhook(s).
 *
 * CONTRACT GUARANTEES:
 *  - STRICT NO-OP (returns false, zero network calls) when no webhook is set.
 *  - Never throws — all errors are caught and returned as false.
 *  - Never includes secret values in the posted payload; the `text` arg is a
 *    caller-provided summary string; callers MUST NOT pass secrets in it.
 *  - Bounded timeout (5 s) on every fetch to avoid hanging the CLI.
 *  - Posts to Slack and/or Discord independently; partial success returns true
 *    when at least one webhook succeeds.
 */

import type { AshlrConfig } from '../types.js';

/** Timeout in milliseconds for each webhook POST. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Post `text` to each configured webhook in `cfg.notify`.
 *
 * Returns true when at least one webhook received a 2xx response.
 * Returns false (no network call) when no webhook is configured.
 * Never throws.
 */
export async function notify(text: string, cfg: AshlrConfig): Promise<boolean> {
  const slack = cfg.notify?.slackWebhook;
  const discord = cfg.notify?.discordWebhook;

  // Strict no-op when nothing is configured.
  if (!slack && !discord) {
    return false;
  }

  const results = await Promise.all([
    slack ? postSlack(slack, text) : Promise.resolve(false),
    discord ? postDiscord(discord, text) : Promise.resolve(false),
  ]);

  return results.some(Boolean);
}

// ---------------------------------------------------------------------------
// Internal helpers — one per webhook flavour
// ---------------------------------------------------------------------------

/**
 * POST to a Slack incoming-webhook URL.
 * Slack expects `{ "text": "..." }`.
 * Returns true on HTTP 2xx; false on any error.
 */
async function postSlack(url: string, text: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network error, timeout, or invalid URL — degrade silently.
    return false;
  }
}

/**
 * POST to a Discord webhook URL.
 * Discord expects `{ "content": "..." }`.
 * Returns true on HTTP 2xx (Discord returns 204 No Content on success);
 * false on any error.
 */
async function postDiscord(url: string, text: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });
      // Discord returns 204 on success; treat any 2xx as ok.
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network error, timeout, or invalid URL — degrade silently.
    return false;
  }
}
