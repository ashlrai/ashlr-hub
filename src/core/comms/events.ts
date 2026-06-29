/**
 * M212: Proactive fleet event notifications via Telegram.
 *
 * notifyFleetEvent(kind, payload, cfg) — fire-and-forget best-effort push to
 * Mason's Telegram chat when interesting fleet events occur.
 *
 * Event kinds:
 *   'merge'           — an autonomous merge shipped
 *   'wave-shipped'    — an improvement wave shipped
 *   'decision-needed' — fleet needs Mason's call (inline buttons)
 *   'anomaly'         — daemon failure / regression detected
 *   'daily-standup'   — daily summary of what the fleet did in 24h
 *
 * Throttle / dedup:
 *   In-memory per-kind cooldown (Map<string, number>).
 *   merge, wave-shipped, decision-needed, anomaly: 5 min (300_000 ms)
 *   daily-standup: 22 h (79_200_000 ms)
 *
 * Guards:
 *   - cfg.comms.proactive must be true
 *   - Telegram must be configured (telegramEnabled)
 *   - Per-kind cooldown must have elapsed
 *
 * Never throws — all errors are swallowed (fire-and-forget by design).
 *
 * SAFETY: this module contains NO merge/push/apply/destructive primitive.
 * It only calls sendTelegramMessage. The merge-gate and daemon control-flow
 * are NEVER touched from here.
 */

import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Event kinds + payload
// ---------------------------------------------------------------------------

export type FleetEventKind =
  | 'merge'
  | 'wave-shipped'
  | 'decision-needed'
  | 'anomaly'
  | 'daily-standup';

export type FleetEventPayload = {
  // merge
  repo?: string;
  engine?: string;
  title?: string;
  // wave-shipped
  count?: number;
  summary?: string;
  // decision-needed
  proposalId?: string;
  question?: string;
  options?: string[];
  // daily-standup
  merged?: number;
  proposals?: number;
  // anomaly
  detail?: string;
};

// ---------------------------------------------------------------------------
// In-memory cooldown map
// ---------------------------------------------------------------------------

const _cooldowns = new Map<string, number>();

const COOLDOWN_MS: Record<FleetEventKind, number> = {
  'merge':           300_000,    //  5 min
  'wave-shipped':    300_000,    //  5 min
  'decision-needed': 300_000,    //  5 min
  'anomaly':         300_000,    //  5 min
  'daily-standup':   79_200_000, // 22 h
};

/** For testing: reset all in-memory cooldowns. */
export function _resetCooldowns(): void {
  _cooldowns.clear();
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

function formatMerge(p: FleetEventPayload): string {
  return `🚀 Merged: "${p.title ?? '(untitled)'}" → ${p.repo ?? 'unknown'} [${p.engine ?? 'unknown'}]`;
}

function formatWaveShipped(p: FleetEventPayload): string {
  return `✅ Wave shipped: ${p.count ?? 0} improvement(s) in ${p.repo ?? 'unknown'} — ${p.summary ?? ''}`;
}

function formatDecisionNeeded(p: FleetEventPayload): string {
  return `🤔 Decision needed: ${p.question ?? ''}`;
}

function formatAnomaly(p: FleetEventPayload): string {
  return `⚠️ Fleet anomaly: ${(p.detail ?? '').slice(0, 300)}`;
}

function formatDailyStandup(p: FleetEventPayload): string {
  return `📊 Daily standup: ${p.merged ?? 0} merged, ${p.proposals ?? 0} pending — ${p.summary ?? ''}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget fleet event notification.
 * No-op when proactive flag is off, Telegram not configured, or cooldown active.
 * Never throws.
 */
export async function notifyFleetEvent(
  kind: FleetEventKind,
  payload: FleetEventPayload,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    // Guard: proactive flag
    if (cfg.comms?.proactive !== true) return;

    // Guard: Telegram must be configured
    if (!telegramEnabled(cfg)) return;

    // Guard: cooldown
    const now = Date.now();
    const last = _cooldowns.get(kind) ?? 0;
    const cooldown = COOLDOWN_MS[kind];
    if (now - last < cooldown) return;

    // Format message + opts
    let text: string;
    let tgOpts: Parameters<typeof sendTelegramMessage>[1] = undefined;

    switch (kind) {
      case 'merge':
        text = formatMerge(payload);
        break;
      case 'wave-shipped':
        text = formatWaveShipped(payload);
        break;
      case 'decision-needed': {
        text = formatDecisionNeeded(payload);
        if (payload.options && payload.options.length > 0) {
          tgOpts = {
            buttons: payload.options,
            requestId: payload.proposalId,
          };
        }
        break;
      }
      case 'anomaly':
        text = formatAnomaly(payload);
        break;
      case 'daily-standup':
        text = formatDailyStandup(payload);
        break;
      default:
        return;
    }

    const { ok } = await sendTelegramMessage(text, tgOpts, cfg);
    if (ok) {
      _cooldowns.set(kind, now);
    }
  } catch {
    // Fire-and-forget — errors must never propagate
  }
}
