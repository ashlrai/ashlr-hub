/**
 * M138: Comms resolution handlers — registers handlers for each comms kind.
 *
 * Call registerCommsHandlers(cfg) once before running a comms cycle so that
 * resolved requests are routed to the correct action:
 *
 *   'elon-vision'  — Elon strategic Q&A:
 *     index 0 (Approve & create goals) → adoptBriefing(cfg, latestBriefing)
 *     index 1 (Hold)                   → no-op, recorded via resolution
 *     index 2 (Show full briefing)     → sendIMessage(full briefing text, cfg)
 *
 *   'manager-approval' — stub for autonomous-merge gate (not yet active).
 *     index 0 (Approve) → note approval (no-op until merge pipeline is wired)
 *     index 1 (Reject)  → note rejection (no-op until merge pipeline is wired)
 *
 * Never throws — all handlers are wrapped best-effort.
 */

import type { AshlrConfig } from '../types.js';
import { registerResolutionHandler } from './dispatch.js';
import type { CommsRequest } from './requests.js';
import { sendIMessage } from '../integrations/imessage.js';
import { loadLatestBriefing, adoptBriefing } from '../vision/strategist.js';

// ---------------------------------------------------------------------------
// Internal: elon-vision handler
// ---------------------------------------------------------------------------

async function handleElonVision(req: CommsRequest, cfg: AshlrConfig): Promise<void> {
  const idx = req.answerIndex;
  if (typeof idx !== 'number') return;

  if (idx === 0) {
    // Approve & create goals — evolve spec + post goals to conductor
    const briefing = loadLatestBriefing();
    if (!briefing) return;
    await adoptBriefing(cfg, briefing, { by: 'mason' });
    return;
  }

  if (idx === 1) {
    // Hold — recorded via resolution; no further action needed.
    return;
  }

  if (idx === 2) {
    // Show full briefing — send the complete briefing text as an iMessage.
    const briefing = loadLatestBriefing();
    if (!briefing) {
      await sendIMessage('[ashlr] No briefing on file.', cfg);
      return;
    }

    const lines: string[] = [
      `Strategic Briefing — ${briefing.generatedAt}`,
      '',
      `STATE: ${briefing.currentState}`,
      '',
      `GAP: ${briefing.gapToVision}`,
    ];

    if (briefing.recommendedDirection.length > 0) {
      lines.push('', 'DIRECTIONS:');
      briefing.recommendedDirection.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
    }

    if (briefing.questionsForMason.length > 0) {
      lines.push('', 'OPEN QUESTIONS:');
      briefing.questionsForMason.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
    }

    if (briefing.proposedGoals.length > 0) {
      lines.push('', 'PROPOSED GOALS:');
      briefing.proposedGoals.forEach((g, i) => lines.push(`  ${i + 1}. ${g.objective}`));
    }

    await sendIMessage(lines.join('\n'), cfg);
    return;
  }
}

// ---------------------------------------------------------------------------
// Internal: manager-approval handler stub
// ---------------------------------------------------------------------------

// Stub — autonomous-merge is not yet active. Wire real status mutations here
// when the merge pipeline is live (search for 'manager-approval' to locate call
// sites in the manager layer).
async function handleManagerApproval(req: CommsRequest, _cfg: AshlrConfig): Promise<void> {
  const idx = req.answerIndex;
  if (typeof idx !== 'number') return;

  if (idx === 0) {
    // Approve — record approval intent (pipeline not yet active)
    return;
  }

  if (idx === 1) {
    // Reject — record rejection intent (pipeline not yet active)
    return;
  }
}

// ---------------------------------------------------------------------------
// Public: registerCommsHandlers
// ---------------------------------------------------------------------------

/**
 * Register all M138 resolution handlers. Must be called before runCommsCycle()
 * so that resolved requests fire the correct action. Idempotent (re-registration
 * overwrites the prior handler — safe to call on every cycle entrypoint).
 *
 * Never throws.
 */
export function registerCommsHandlers(cfg: AshlrConfig): void {
  registerResolutionHandler('elon-vision', (req: CommsRequest) => {
    return handleElonVision(req, cfg).catch(() => {
      // best-effort — handler errors must never crash the cycle
    });
  });

  registerResolutionHandler('manager-approval', (req: CommsRequest) => {
    return handleManagerApproval(req, cfg).catch(() => {
      // best-effort
    });
  });
}
