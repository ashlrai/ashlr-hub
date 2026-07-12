/**
 * M138/M139: Comms resolution handlers — registers handlers for each comms kind.
 *
 * Call registerCommsHandlers(cfg) once before running a comms cycle so that
 * resolved requests are routed to the correct action:
 *
 *   'elon-vision'  — Elon strategic Q&A:
 *     index 0 (Approve & create goals) → adoptBriefing(cfg, latestBriefing)
 *     index 1 (Hold)                   → no-op, recorded via resolution
 *     index 2 (Show full briefing)     → sendIMessage(full briefing text, cfg)
 *
 *   'manager-approval' — M139: text-based merge approval path.
 *     index 0 (Approve & merge) → setStatus approved + applyProposal (human-authorized path)
 *     index 1 (Reject)          → setStatus rejected + text confirmation
 *     index 2 (Show diff)       → sendIMessage scrubbed diff + re-post the question
 *
 * Never throws — all handlers are wrapped best-effort.
 */

import type { AshlrConfig } from '../types.js';
import { registerResolutionHandler } from './dispatch.js';
import type { CommsRequest } from './requests.js';
import { sendIMessage } from '../integrations/imessage.js';
import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import { loadLatestBriefing, adoptBriefing } from '../vision/strategist.js';
import { scrubSecrets } from '../util/scrub.js';
import { savePauseState } from './pause.js';

// ---------------------------------------------------------------------------
// Internal: transport helper
// ---------------------------------------------------------------------------

/** Send a message via Telegram if configured, else iMessage. Best-effort. */
async function sendReply(text: string, cfg: AshlrConfig): Promise<void> {
  if (telegramEnabled(cfg)) {
    await sendTelegramMessage(text, undefined, cfg);
  } else {
    await sendIMessage(text, cfg);
  }
}

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
    // Show full briefing — send via appropriate transport.
    const briefing = loadLatestBriefing();
    if (!briefing) {
      await sendReply('[ashlr] No briefing on file.', cfg);
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

    await sendReply(lines.join('\n'), cfg);
    return;
  }
}

// ---------------------------------------------------------------------------
// Internal: manager-approval handler (M139)
// ---------------------------------------------------------------------------

/** Max characters to send for a diff preview via iMessage. */
const MAX_DIFF_SMS = 1500;

// scrubDiffSecrets replaced by shared scrubSecrets from src/core/util/scrub.ts.
// That function covers all 8 secret-pattern categories (sk-, GitHub tokens,
// Bearer, generic key=value, Slack, AWS, JWT, hex-64) — a strict superset of
// what scrubDiffSecrets previously caught.

async function handleManagerApproval(req: CommsRequest, cfg: AshlrConfig): Promise<void> {
  const idx = req.answerIndex;
  if (typeof idx !== 'number') return;

  const proposalId = req.meta?.proposalId;
  if (typeof proposalId !== 'string' || !proposalId) return;

  if (idx === 0) {
    // Approve & merge — a Telegram/iMessage tap from the authenticated owner
    // IS a human approval. Use applyProposal (the human-authorized path), NOT
    // autoMergeProposal (which is the autonomous frontier-only path). This lets
    // local and mid-tier work merge when Mason explicitly approves via text.
    try {
      const { setStatus, loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      if (!proposal) return; // already gone — no-op

      setStatus(proposalId, 'approved', 'mason:telegram');

      const { applyProposal } = await import('../inbox/apply.js');
      const result = await applyProposal(proposalId, { confirmed: true });

      if (result.ok) {
        await sendReply(`✅ Merged "${proposal.title}"`, cfg);
      } else {
        const reason = scrubSecrets(result.detail ?? 'unknown reason');
        await sendReply(
          `Approved but apply failed: ${reason} — needs manual review`,
          cfg,
        );
      }
    } catch {
      // Best-effort — handler errors must never crash the cycle.
    }
    return;
  }

  if (idx === 1) {
    // Reject.
    try {
      const { setStatus, loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      if (!proposal) return;
      if (setStatus(proposalId, 'rejected', 'mason:telegram') !== false) {
        await sendReply(`Rejected "${proposal.title}"`, cfg);
      } else {
        await sendReply(`Could not reject "${proposal.title}" because recovery revocation is unavailable`, cfg);
      }
    } catch {
      // Best-effort.
    }
    return;
  }

  if (idx === 2) {
    // Show diff — send scrubbed truncated diff, then re-post the same question.
    try {
      const { loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      if (!proposal) return;

      const rawDiff = proposal.diff ?? '(no diff available)';
      const scrubbed = scrubSecrets(rawDiff);
      const truncated =
        rawDiff.length > MAX_DIFF_SMS || scrubbed.length > MAX_DIFF_SMS
          ? scrubbed.slice(0, MAX_DIFF_SMS) + '\n…[truncated]'
          : scrubbed;

      await sendReply(`Diff for "${proposal.title}":\n${truncated}`, cfg);

      // Re-post the approval question so Mason can still decide.
      const { postRequest } = await import('./requests.js');
      postRequest({
        kind: 'manager-approval',
        type: 'approval',
        text: req.text,
        options: req.options,
        meta: req.meta,
      });
    } catch {
      // Best-effort.
    }
    return;
  }

  // M212 quick-actions — additive, Telegram only, no merge/push/destructive ops.

  if (idx === 3) {
    // Prioritize — bump the proposal to the top of the pending queue by
    // updating its priority field (direction only — does not merge or apply).
    try {
      const { loadProposal, setStatus } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      if (!proposal) return;
      // Mark as prioritized via a status annotation; the daemon re-queues on next pass.
      setStatus(proposalId, 'pending', 'mason:prioritized');
      await sendReply(`Prioritized "${proposal.title}" — will be picked up next pass`, cfg);
    } catch {
      // Best-effort.
    }
    return;
  }

  if (idx === 4) {
    // Pause-fleet — sets the soft-pause flag (additive, direction-only).
    // SAFETY: the flag is honored by the comms dispatch cycle (runCommsCycle
    // short-circuits while paused); it sets DIRECTION only and triggers no
    // merge/push/destructive op. Resolved via "resume" text or setPause(false).
    try {
      savePauseState({ paused: true, since: Date.now() });
      const { loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      await sendReply(`Fleet paused${proposal ? ` — "${proposal.title}" stays pending` : ''}. Text "resume" to restart.`, cfg);
    } catch {
      // Best-effort.
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Public: registerCommsHandlers
// ---------------------------------------------------------------------------

/**
 * Register all M138/M139 resolution handlers. Must be called before runCommsCycle()
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

  // M212: decision-needed is resolved via button tap (option index already in req.answerIndex).
  // The Elon dialogue or notifyFleetEvent('decision-needed', ...) posted this request.
  // Resolution is recorded in the requests store; no further action needed here beyond
  // re-posting the answer as a goal action if warranted (handled by elon-dialogue on next cycle).
  registerResolutionHandler('decision-needed', (_req: CommsRequest) => {
    return Promise.resolve();
  });
}
