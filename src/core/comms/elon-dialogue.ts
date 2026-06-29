/**
 * M180: Elon-agent strategic dialogue.
 *
 * handleStrategicMessage(text, cfg) — called when Mason sends a FREE-FORM text
 * to the Telegram bot (not a numbered/button reply to an outstanding request).
 *
 * The Opus strategist interprets the message and may:
 *   (a) answer a question,
 *   (b) take direction → create/reprioritize a GOAL (via goals store),
 *   (c) evolve the vision.
 *
 * The reply is returned as a string; the caller sends it back via the transport.
 *
 * SAFETY GUARDRAILS (paramount):
 *   - Authenticated to cfg.comms.telegram.chatId ONLY (Mason). Foreign chatIds
 *     must be rejected by the caller before reaching here.
 *   - This module sets DIRECTION (goals / vision) — it does NOT trigger a merge,
 *     push, applyProposal, or any destructive op. Those remain gated by the
 *     existing execution safety floor (proposal-only, verification gate,
 *     kill-switch).
 *   - Replies are secret-scrubbed before returning.
 *   - Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { loadLatestBriefing } from '../vision/strategist.js';
import { scrubSecrets } from '../util/scrub.js';
import { loadPauseState, savePauseState } from './pause.js';

// ---------------------------------------------------------------------------
// Internal: resolve the Opus complete function (mirrors resolveStrategistClient
// in strategist.ts — duplicated per file-ownership rules).
// ---------------------------------------------------------------------------

const CLAUDE_DEFAULT_STRATEGIST_MODEL = 'claude-opus-4-8';

/** Lazy imports to allow test mocks to intercept. */
async function buildComplete(
  cfg: AshlrConfig,
): Promise<(system: string, user: string) => Promise<string>> {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine = (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const allowedBackends: string[] = (foundry?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];
  const configuredModel = (foundry?.['strategistModel'] as string | undefined);
  const eliteModel = configuredModel ?? CLAUDE_DEFAULT_STRATEGIST_MODEL;

  const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const claudeAllowed = allowedBackends.includes('claude');

  try {
    const { engineInstalled, buildEngineCommand, spawnEngine } =
      await import('../run/engines.js');

    if (wantClaude && claudeAllowed && engineInstalled('claude', cfg)) {
      return async (system: string, user: string): Promise<string> => {
        try {
          const combined = `${system}\n\n${user}`;
          const cmd = buildEngineCommand('claude', combined, cfg, { model: eliteModel });
          if (!cmd) return '';
          const result = await spawnEngine(cmd, cfg, { timeoutMs: 120_000 });
          if (!result.ok || !result.output) return '';
          try {
            const parsed = JSON.parse(result.output) as Record<string, unknown>;
            const text = parsed['result'];
            return typeof text === 'string' ? text : result.output;
          } catch {
            return result.output;
          }
        } catch {
          return '';
        }
      };
    }
  } catch {
    // engines unavailable — fall through to Ollama
  }

  // Ollama fallback
  const baseUrl =
    (foundry?.['ollamaBaseUrl'] as string | undefined) ?? 'http://localhost:11434';
  const localModel =
    (foundry?.['localModel'] as string | undefined) ?? 'mistral';

  return async (system: string, user: string): Promise<string> => {
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: localModel,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            stream: false,
            temperature: 0.5,
            max_tokens: 1024,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return '';
        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? '';
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return '';
    }
  };
}

// ---------------------------------------------------------------------------
// Dialogue system prompt
// ---------------------------------------------------------------------------

const DIALOGUE_SYSTEM = `You are the elite founder-agent (Elon mode) for an autonomous AI software fleet. Mason (the human owner) is sending you a direct message on Telegram.

Your role in this dialogue:
1. ANSWER questions about fleet status, strategy, goals, or vision directly and concisely.
2. ACCEPT direction — when Mason gives you a directive (e.g. "focus on X", "deprioritize Y", "we need a goal to do Z"), interpret it and produce a JSON action to create or update a goal.
3. EVOLVE vision — when Mason shares a new strategic insight, acknowledge it and reflect how it should shape the fleet's direction.

SAFETY (paramount — never violate):
- You set DIRECTION only. You do NOT merge code, push commits, delete branches, run destructive commands, or bypass the proposal/verification safety floor. Those are executed through the fleet's existing gated process, not through this conversation.
- If Mason asks you to directly push/merge/delete something, explain that you've set the goal and the fleet will execute it through the safety gates — you cannot bypass them.

Response format:
Respond with a JSON object in exactly this shape:

{
  "reply": "<conversational reply to send back to Mason — concise, direct, founder-voice>",
  "action": {
    "type": "create_goal" | "update_goal_priority" | "none",
    "objective": "<goal objective string — only when type=create_goal>",
    "rationale": "<why this goal matters — only when type=create_goal>",
    "goalId": "<existing goal id — only when type=update_goal_priority>",
    "newPriority": "<new priority rationale — only when type=update_goal_priority>"
  }
}

action.type MUST be one of: "create_goal", "update_goal_priority", "pause_fleet", "resume_fleet", "fleet_status", "none".
- "pause_fleet": Mason asks to pause/stop the fleet ("pause", "stop work", "hold", etc.)
- "resume_fleet": Mason asks to resume the fleet ("resume", "unpause", "start again", etc.)
- "fleet_status": Mason asks about fleet state ("status", "what's running", "what are you doing", etc.)
When no goal action is warranted, set action.type = "none".
Respond ONLY with valid JSON. No prose, no markdown fences.`;

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

async function buildContext(_cfg: AshlrConfig): Promise<string> {
  const parts: string[] = [];

  // Latest briefing summary
  try {
    const briefing = loadLatestBriefing();
    if (briefing) {
      parts.push(`LATEST STRATEGIC BRIEFING (${briefing.generatedAt}):`);
      parts.push(`Current state: ${briefing.currentState}`);
      parts.push(`Gap to vision: ${briefing.gapToVision}`);
      if (briefing.recommendedDirection.length > 0) {
        parts.push(`Top direction: ${briefing.recommendedDirection[0]}`);
      }
    }
  } catch { /* best-effort */ }

  // Active goals
  try {
    const { listGoals } = await import('../goals/store.js');
    const active = listGoals({ status: 'active' });
    const planning = listGoals({ status: 'planning' });
    const all = [...active, ...planning].slice(0, 10);
    if (all.length > 0) {
      parts.push(`\nACTIVE/PLANNING GOALS (${all.length}):`);
      for (const g of all) {
        parts.push(`  [${g.status}] ${g.id}: ${g.objective}`);
      }
    }
  } catch { /* best-effort */ }

  return parts.join('\n') || 'No context available.';
}

// ---------------------------------------------------------------------------
// Goal action executor
// ---------------------------------------------------------------------------

interface DialogueAction {
  type: 'create_goal' | 'update_goal_priority' | 'pause_fleet' | 'resume_fleet' | 'fleet_status' | 'none';
  objective?: string;
  rationale?: string;
  goalId?: string;
  newPriority?: string;
}

async function executeAction(action: DialogueAction, cfg: AshlrConfig): Promise<string | null> {
  if (action.type === 'none') return null;

  if (action.type === 'create_goal' && action.objective) {
    try {
      const { createGoal } = await import('../goals/store.js');
      const goal = createGoal(action.objective, { cfg });
      return `Goal created: ${goal.id}`;
    } catch {
      return null;
    }
  }

  if (action.type === 'update_goal_priority' && action.goalId && action.newPriority) {
    try {
      const { loadGoal, saveGoal } = await import('../goals/store.js');
      const goal = loadGoal(action.goalId);
      if (goal) {
        // Embed new priority rationale in a notes field (non-destructive update)
        const updated = {
          ...goal,
          notes: action.newPriority,
        };
        saveGoal(updated as typeof goal);
        return `Goal ${action.goalId} priority updated`;
      }
    } catch {
      return null;
    }
  }

  // M212: soft-pause — sets a flag file the daemon checks; no control-flow change here.
  // SAFETY: this is a direction flag only. Execution gating happens in the daemon tick.
  if (action.type === 'pause_fleet') {
    try {
      savePauseState({ paused: true, since: Date.now() });
      return 'Fleet paused';
    } catch {
      return null;
    }
  }

  if (action.type === 'resume_fleet') {
    try {
      savePauseState({ paused: false });
      return 'Fleet resumed';
    } catch {
      return null;
    }
  }

  if (action.type === 'fleet_status') {
    try {
      const parts: string[] = [];
      // Pause state
      const ps = loadPauseState();
      parts.push(ps.paused ? 'Fleet: PAUSED' : 'Fleet: RUNNING');
      // Active goals
      const { listGoals } = await import('../goals/store.js');
      const active = listGoals({ status: 'active' });
      parts.push(`Active goals: ${active.length}`);
      // Pending proposals
      try {
        const { listProposals } = await import('../inbox/store.js');
        const pending = listProposals({ status: 'pending' });
        parts.push(`Pending proposals: ${pending.length}`);
      } catch { /* best-effort */ }
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a free-form strategic message from Mason.
 *
 * Builds ecosystem context, prompts the Opus strategist client, parses the
 * response, executes any goal action, and returns the reply text to send back.
 *
 * SAFETY: callers MUST authenticate chatId before calling here.
 * This function sets direction (goals/vision) only — never triggers
 * merge/push/destructive ops.
 *
 * Never throws.
 */
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

export async function handleStrategicMessage(
  text: string,
  cfg: AshlrConfig,
): Promise<string> {
  try {
    // Fast-path: status query → skip LLM, return live fleet snapshot
    const statusRe = /^\s*(status|what'?s\s+running|fleet\s+status)\s*\??$/i;
    if (statusRe.test(text)) {
      return scrubSecrets(await buildFleetSnapshot(cfg));
    }

    const context = await buildContext(cfg);
    const userPrompt = `ECOSYSTEM CONTEXT:\n${context}\n\nMASON'S MESSAGE:\n${text}`;

    const complete = await buildComplete(cfg);
    const raw = await complete(DIALOGUE_SYSTEM, userPrompt);

    if (!raw) {
      return scrubSecrets(
        'The Elon agent is unavailable right now (no engine configured). Set up the Claude CLI or Ollama to enable dialogue.',
      );
    }

    // Parse JSON response
    let parsed: { reply?: string; action?: DialogueAction } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // If the model returned prose instead of JSON, return it scrubbed
      return scrubSecrets(raw.slice(0, 1000));
    }

    const reply = typeof parsed.reply === 'string' ? parsed.reply : raw.slice(0, 1000);

    // Execute goal action if present
    if (parsed.action && parsed.action.type !== 'none') {
      await executeAction(parsed.action, cfg);
    }

    return scrubSecrets(reply);
  } catch {
    return 'The Elon agent encountered an error processing your message.';
  }
}
