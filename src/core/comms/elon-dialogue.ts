/**
 * M180 → 3.14: free-form Telegram text reaches the ONE Leader brain.
 *
 * handleStrategicMessage(text, cfg) — called when Mason sends a FREE-FORM text
 * to the Telegram bot (not a numbered/button reply to an outstanding request).
 *
 * Until 3.14 this module was a second, stateless brain: an "Elon mode"
 * founder prompt, a stale June Strategist briefing as its only context, the
 * Claude CLI first with no budget gate, and model-chosen side effects
 * (create_goal, update_goal_priority, pause/resume) that bypassed the
 * Leader's action pipeline. All of that is gone. The message now goes into
 * the Leader thread (vision/leader-thread.ts), which records it, turns
 * standing guidance into an operator directive, and replies through the
 * Leader's own seat routing and budget gate. The Leader changes nothing from
 * a conversation: it acts only through memo actions under the standing grant.
 *
 * Kept: the deterministic `status` fast path (read-only, no model).
 * Pause / resume are deterministic commands in comms/dispatch.ts.
 *
 * DELIVERY: the caller (dispatch.ts) sends the returned text itself, so the
 * thread's queued Telegram copy of the reply is marked delivered here — the
 * outbound drain never sends it twice.
 *
 * SAFETY: callers MUST authenticate chatId before calling here (telegram.ts
 * drops foreign chats). Replies are secret-scrubbed. Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Fleet snapshot (status fast-path)
// ---------------------------------------------------------------------------

async function buildFleetSnapshot(cfg: AshlrConfig): Promise<string> {
  try {
    const lines: string[] = ['Fleet status:'];

    // Kill switch
    try {
      const { killSwitchOn } = await import('../sandbox/policy.js');
      lines.push(`• Kill switch: ${killSwitchOn() ? 'ON' : 'OFF'}`);
    } catch {
      lines.push('• Kill switch: unknown');
    }

    // Soft pause
    let paused = false;
    try {
      const { isPaused } = await import('./pause.js');
      paused = isPaused();
    } catch { /* ignore */ }
    lines.push(`• Soft pause: ${paused ? 'ON' : 'OFF'}`);

    // Pending proposals
    try {
      const { listProposals } = await import('../inbox/store.js');
      const pending = listProposals({ status: 'pending' });
      lines.push(`• Pending proposals: ${pending.length}`);
    } catch {
      lines.push('• Pending proposals: unknown');
    }

    // Active goals
    try {
      const { listGoals } = await import('../goals/store.js');
      const active = listGoals({ status: 'active' });
      lines.push(`• Active goals: ${active.length}`);
      for (const g of active.slice(0, 10)) {
        lines.push(`  - ${g.id}: ${g.objective}`);
      }
    } catch {
      lines.push('• Active goals: unknown');
    }

    void cfg; // cfg reserved for future use (e.g. remote fleet query)
    return lines.join('\n');
  } catch {
    return 'Fleet status unavailable.';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a free-form message from Mason on Telegram: the status fast path,
 * or the Leader thread. Returns the text to send back ('' = nothing).
 * Never throws.
 */
export async function handleStrategicMessage(
  text: string,
  cfg: AshlrConfig,
): Promise<string> {
  try {
    // Fast-path: status query → skip the model, return a live fleet snapshot.
    const statusRe = /^\s*(status|what'?s\s+running|fleet\s+status)\s*\??$/i;
    if (statusRe.test(text)) {
      return scrubSecrets(await buildFleetSnapshot(cfg));
    }

    const thread = await import('../vision/leader-thread.js');
    const { reply } = await thread.appendMasonMessage(text, { channel: 'telegram', cfg });
    if (!reply) return '';
    // The caller sends this text; the thread's queued copy must not go out again.
    try { thread.markDelivered(reply.id, 'telegram', true); } catch { /* worst case: one duplicate */ }
    return scrubSecrets(reply.text);
  } catch {
    return 'The Leader could not take your message right now. Try again in a minute.';
  }
}
