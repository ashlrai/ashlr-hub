/**
 * core/comms/fleet-pulse.ts — M262 concise Telegram fleet summary.
 *
 * Sends a concise, scannable "fleet pulse" message to Telegram with:
 *   - Recorded focus and decisions needing input
 *   - One recorded work line and one status/reset line per resource
 *   - One ledger cost estimate; optional diagnostics stay in the snapshot/UI
 *
 * GATED: cfg.comms?.proactive must be true. When false/absent, no-ops.
 * SAFETY: read-only; never mutates proposals/goals/merges.
 * Never throws — fire-and-forget.
 */

import type { AshlrConfig } from '../types.js';
import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import { escapeTelegramHtml, leaderDisplayText, telegramMetric, telegramUsd, telegramPercent } from '../integrations/telegram-format.js';
import { scrubSecrets } from '../util/scrub.js';
import type { VisibilitySnapshot } from '../web/visibility.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function availabilityLabel(value: string): string {
  switch (value) {
    case 'open': return 'available';
    case 'near': return 'near limit';
    case 'throttled': return 'throttled';
    case 'exhausted': return 'exhausted';
    default: return 'status unknown';
  }
}

function backendName(name: string): string {
  return ({ claude: 'Claude', codex: 'Codex', 'local-coder': 'Local coder', local: 'Local',
    grok: 'Grok', 'grok-cli': 'Grok CLI', devin: 'Devin', nim: 'NVIDIA NIM' } as Record<string, string>)[name] ?? name;
}

/** Dynamic text inside the pulse's Telegram HTML — the shared escaper. */
const html = escapeTelegramHtml;

function postureHeader(posture: string): string {
  switch (posture) {
    case 'full':       return 'Capacity available';
    case 'preserve':   return 'Capacity limited — prefer lower-cost engines';
    case 'local-only': return 'Use local engines — frontier allowance exhausted';
    case 'degraded':   return 'Capacity degraded — some sources unavailable';
    default:           return `Capacity: ${html(posture)}`;
  }
}

function resetsIn(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return '';
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return ' · reset time unknown';
  const ms = at - nowMs;
  if (ms <= 0) return ' · reset due';
  if (ms < 60_000) return ' · resets in under a minute';
  if (ms >= 86_400_000) return ` · resets in ${telegramMetric(ms / 86_400_000)} days`;
  if (ms >= 3_600_000) return ` · resets in ${telegramMetric(ms / 3_600_000)} hours`;
  return ` · resets in ${telegramMetric(ms / 60_000)} min`;
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build the concise fleet Telegram message from a VisibilitySnapshot.
 * Returns Telegram-HTML text because sendTelegramMessage uses parse_mode=HTML.
 */
export function buildFleetPulseMessage(snap: VisibilitySnapshot, timeZone?: string): string {
  const lines: string[] = ['<b>Phantom fleet</b>'];
  const at = Date.parse(snap.generatedAt);
  const focus = snap.director.topGoalObjective;
  if (focus) lines.push(`Focus: ${html(leaderDisplayText(scrubSecrets(focus), at, timeZone).replace(/\s+/g, ' ').trim())}`);
  if (snap.director.escalationCount > 0) {
    lines.push(`${telegramMetric(snap.director.escalationCount)} decision${snap.director.escalationCount === 1 ? '' : 's'} awaiting your input`);
  }
  lines.push(postureHeader(snap.director.resourcePosture));

  const activity = snap.fleetActivity;
  // These are recorded dispatch/outcome counts, not a claim about live agents or deliveries.
  lines.push(`Recorded work (24h): ${telegramMetric(activity.totalDispatches)} dispatches · ${telegramMetric(activity.mergedToday)} merged · ${telegramMetric(activity.rejectedToday)} rejected · ${telegramMetric(activity.proposalsPending)} ${activity.proposalsPending === 1 ? 'proposal' : 'proposals'} pending`);
  for (const resource of snap.resourceGrid) {
    const pct = telegramPercent(resource.usedPct);
    const usage = pct === 'unknown' ? 'usage unknown' : `${pct} used`;
    const reset = resource.resetsAt ? resetsIn(resource.resetsAt, at)
      : resource.capWindow ? ' · reset time unknown' : '';
    const reason = resource.reason.trim();
    // Preserve a concise real blocker; full diagnostics and measurements stay in the snapshot/UI.
    const blocker = reason ? ` · ${leaderDisplayText(scrubSecrets(reason), at, timeZone).replace(/\s+/g, ' ').slice(0, 120)}` : '';
    lines.push(`${html(backendName(resource.backend))}: ${html(availabilityLabel(resource.availability))} · ${html(usage)}${html(reset)}${html(blocker)}`);
  }
  lines.push(`Ledger estimate (24h): ${html(telegramUsd(snap.costSavings.todaySpendUsd))}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Send function (gated)
// ---------------------------------------------------------------------------

/**
 * Send the fleet pulse to Telegram if comms are enabled.
 *
 * GATED: cfg.comms?.proactive must be true and Telegram must be configured.
 * Never throws.
 */
export async function sendFleetPulse(
  snap: VisibilitySnapshot,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    const comms = (cfg as { comms?: { proactive?: boolean } }).comms;
    if (!comms?.proactive) return;
    if (!telegramEnabled(cfg)) return;

    const text = buildFleetPulseMessage(snap, cfg.comms?.timeZone);
    await sendTelegramMessage(text, { html: true }, cfg);
  } catch {
    // Never throws — fire-and-forget
  }
}

/**
 * Build and send the fleet pulse from scratch.
 *
 * Convenience wrapper: builds VisibilitySnapshot then sends.
 * GATED and never-throws same as sendFleetPulse.
 */
export async function dispatchFleetPulse(cfg: AshlrConfig): Promise<void> {
  try {
    const comms = (cfg as { comms?: { proactive?: boolean } }).comms;
    if (!comms?.proactive) return;
    if (!telegramEnabled(cfg)) return;

    const { buildVisibilitySnapshot } = await import('../web/visibility.js');
    const snap = await buildVisibilitySnapshot(cfg);
    await sendFleetPulse(snap, cfg);
  } catch {
    // Never throws
  }
}
