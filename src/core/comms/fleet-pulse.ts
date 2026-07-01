/**
 * core/comms/fleet-pulse.ts — M262 rich Telegram fleet pulse.
 *
 * Sends a concise, scannable "fleet pulse" message to Telegram with:
 *   - Resource posture header (availability color-coded via emoji)
 *   - Backend status grid (availability, used%, resets-in)
 *   - Fleet activity summary (merges, dispatches, proposals)
 *   - Cost & savings (today's spend, plugin savings, cache rate)
 *   - Director focus + escalation count (if director enabled)
 *
 * GATED: cfg.comms?.proactive must be true. When false/absent, no-ops.
 * SAFETY: read-only; never mutates proposals/goals/merges.
 * Never throws — fire-and-forget.
 */

import type { AshlrConfig } from '../types.js';
import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import type { VisibilitySnapshot } from '../web/visibility.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function availabilityEmoji(avail: string): string {
  switch (avail) {
    case 'open':      return '🟢';
    case 'near':      return '🟡';
    case 'throttled': return '🟠';
    case 'exhausted': return '🔴';
    default:          return '⚪';
  }
}

function fmtPct(pct: number | null): string {
  if (pct === null) return '?%';
  return `${Math.round(pct)}%`;
}

function fmtUsd(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function html(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function postureHeader(posture: string): string {
  switch (posture) {
    case 'full':       return '🚀 POSTURE: full headroom — use frontier freely';
    case 'preserve':   return '⚡ POSTURE: preserve — favour cheaper backends';
    case 'local-only': return '🔋 POSTURE: local-only — frontier exhausted';
    case 'degraded':   return '⚠️ POSTURE: degraded — multiple sources down';
    default:           return `📊 POSTURE: ${html(posture)}`;
  }
}

function resetsIn(resetsAt: string | null): string {
  if (!resetsAt) return '';
  try {
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (ms <= 0) return ' (reset due)';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return ` resets ${h}h${m > 0 ? `${m}m` : ''}`;
    return ` resets ${m}m`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build the rich fleet-pulse Telegram message from a VisibilitySnapshot.
 * Returns Telegram-HTML text because sendTelegramMessage uses parse_mode=HTML.
 */
export function buildFleetPulseMessage(snap: VisibilitySnapshot): string {
  const lines: string[] = [];
  const ts = new Date(snap.generatedAt);
  const dateStr = ts.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  lines.push(`<b>Fleet Pulse</b> — ${html(dateStr)}`);
  lines.push('');

  // Resource posture
  lines.push(postureHeader(snap.director.resourcePosture));
  lines.push('');

  // Backend grid
  if (snap.resourceGrid.length > 0) {
    lines.push('<b>BACKENDS</b>');
    for (const b of snap.resourceGrid) {
      const pct = fmtPct(b.usedPct);
      const rst = resetsIn(b.resetsAt);
      const cost = b.costPerMTokenOut > 0 ? ` · $${b.costPerMTokenOut}/M` : '';
      const lat = b.p50LatencyMs != null ? ` · p50=${b.p50LatencyMs}ms` : '';
      lines.push(`  ${availabilityEmoji(b.availability)} <b>${html(b.backend)}</b>: ${html(pct)} used${html(rst)}${html(cost)}${html(lat)}`);
    }
    lines.push('');
  }

  // Fleet activity
  const fa = snap.fleetActivity;
  if (fa.totalDispatches > 0 || fa.mergedToday > 0) {
    lines.push('<b>FLEET (24h)</b>');
    lines.push(`  Dispatches: ${fa.totalDispatches}` +
      (fa.byBackend.length > 0
        ? ` (${html(fa.byBackend.slice(0, 3).map(b => `${b.backend}:${b.count}`).join(', '))})`
        : ''));
    if (fa.mergedToday > 0) lines.push(`  ✅ Merged: ${fa.mergedToday}`);
    if (fa.rejectedToday > 0) lines.push(`  ❌ Rejected: ${fa.rejectedToday}`);
    if (fa.proposalsPending > 0) lines.push(`  ⏳ Pending proposals: ${fa.proposalsPending}`);
    if (fa.recentMergeTitles.length > 0) {
      lines.push('  Recent merges:');
      for (const t of fa.recentMergeTitles.slice(0, 3)) {
        lines.push(`    • ${html(t)}`);
      }
    }
    lines.push('');
  }

  // Cost & savings
  const cs = snap.costSavings;
  lines.push('<b>COST &amp; SAVINGS</b>');
  lines.push(`  Today's spend: ${html(fmtUsd(cs.todaySpendUsd))}`);
  if (cs.spendByBackend.length > 0) {
    const byB = cs.spendByBackend.slice(0, 3).map(b => `${b.backend}:${fmtUsd(b.costUsd)}`).join(' · ');
    lines.push(`    By backend: ${html(byB)}`);
  }
  if (cs.pluginSavingsLifetimeTokens > 0) {
    lines.push(
      `  Plugin savings: ${html(fmtTokens(cs.pluginSavingsLifetimeTokens))} tokens (≈${html(fmtUsd(cs.pluginSavingsLifetimeUsd))}) lifetime`,
    );
  }
  if (cs.routingSavedUsd > 0.001) {
    lines.push(`  Routing saved: ${html(fmtUsd(cs.routingSavedUsd))} (local vs. frontier)`);
  }
  if (cs.cacheHitRate > 0) {
    lines.push(`  Cache hit rate: ${Math.round(cs.cacheHitRate * 100)}%`);
  }
  lines.push(`  Claude budget: ${cs.claudeBudgetPreserved ? '✅ preserved' : '⚠️ near limit'}`);
  lines.push('');

  // Director focus
  if (snap.director.directorEnabled || snap.director.topGoalObjective) {
    lines.push('<b>DIRECTOR</b>');
    if (snap.director.topGoalObjective) {
      lines.push(`  Focus: ${html(snap.director.topGoalObjective)}`);
    }
    if (snap.director.escalationCount > 0) {
      lines.push(
        `  ⚠️ ${snap.director.escalationCount} escalation${snap.director.escalationCount > 1 ? 's' : ''} need your call`,
      );
    } else {
      lines.push('  No escalations pending');
    }
    if (snap.director.latestDigest) {
      const excerpt = snap.director.latestDigest.slice(0, 300);
      lines.push('');
      lines.push('<i>' + html(excerpt.replace(/\n/g, ' ')) + '</i>');
    }
    lines.push('');
  }

  return lines.join('\n').trim();
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

    const text = buildFleetPulseMessage(snap);
    await sendTelegramMessage(text, {}, cfg);
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
