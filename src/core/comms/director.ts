/**
 * M257: Elon Director — reasoning cycle.
 *
 * runDirectorCycle(cfg) — one complete director loop:
 *   1. Build DirectorContext from god-view sources
 *   2. Call the strategist LLM (Opus/frontier, same path as elon-dialogue.ts)
 *   3. Parse DirectorDecision JSON
 *   4. Send telegramDigest via sendTelegramMessage
 *   5. Post each escalation as a 'decision-needed' CommsRequest
 *
 * GATING: only runs when cfg.comms?.director === true (default-false).
 * When gated off, runDirectorCycle is a synchronous no-op — byte-identical
 * to absent.
 *
 * SAFETY (critical):
 *   - READ-ONLY god-view access — no goal mutations, no merge, no push
 *   - Communicates ONLY through sendTelegramMessage + postRequest
 *   - NO new execution path, NO bypass of judge/scope-cap/sandbox/kill-switch
 *   - High-stakes actions (enrollment/releases/spend/arch) → escalate to Mason
 *     via decision-needed, NEVER auto-act
 *   - Never throws — fire-and-forget by design
 */

import type { AshlrConfig } from '../types.js';
import { defaultStrategistModel } from '../run/model-catalog.js';
import { buildDirectorContext } from './director-context.js';
import { DIRECTOR_SYSTEM_PROMPT, renderDirectorPrompt } from './director-prompt.js';
import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import { postRequest } from './requests.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackendHint {
  preferBackends: string[];
  avoidBackends: string[];
  rationale: string;
}

export interface EscalationItem {
  topic: string;
  context: string;
  options: string[];
  stakes: 'high' | 'critical';
}

export interface DirectorDecision {
  reasoning: string;
  resourcePosture: string;
  resourceRationale: string;
  topGoalId: string | null;
  suggestedNewGoal: string | null;
  backendHint: BackendHint | null;
  telegramDigest: string;
  escalations: EscalationItem[];
  confidence: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// LLM caller (mirrors buildComplete from elon-dialogue.ts)
// ---------------------------------------------------------------------------

// M320: strategist default resolves via defaultStrategistModel() in
// run/model-catalog.ts (Fable 5 when claude5.fable is on, else Opus 4.8).

async function buildComplete(
  cfg: AshlrConfig,
): Promise<(system: string, user: string) => Promise<string>> {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine =
    (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const allowedBackends: string[] =
    (foundry?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];
  const configuredModel = foundry?.['strategistModel'] as string | undefined;
  const eliteModel = configuredModel ?? defaultStrategistModel(cfg);

  const wantClaude =
    managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const claudeAllowed = allowedBackends.includes('claude');

  try {
    const { engineInstalled, buildEngineCommand, spawnEngine } =
      await import('../run/engines.js');

    if (wantClaude && claudeAllowed && engineInstalled('claude', cfg)) {
      return async (system: string, user: string): Promise<string> => {
        try {
          const combined = `${system}\n\n${user}`;
          const cmd = buildEngineCommand('claude', combined, cfg, {
            model: eliteModel,
          });
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
    (foundry?.['ollamaBaseUrl'] as string | undefined) ??
    'http://localhost:11434';
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
            temperature: 0.3,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return '';
        const data = (await response.json()) as {
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
// Parse DirectorDecision from LLM output
// ---------------------------------------------------------------------------

function parseDecision(raw: string): DirectorDecision | null {
  if (!raw) return null;
  try {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    // Validate required fields
    if (typeof parsed['telegramDigest'] !== 'string') return null;

    const escalations: EscalationItem[] = [];
    if (Array.isArray(parsed['escalations'])) {
      for (const e of parsed['escalations'] as unknown[]) {
        if (
          typeof e === 'object' &&
          e !== null &&
          typeof (e as Record<string, unknown>)['topic'] === 'string'
        ) {
          const ei = e as Record<string, unknown>;
          escalations.push({
            topic: String(ei['topic'] ?? ''),
            context: String(ei['context'] ?? ''),
            options: Array.isArray(ei['options'])
              ? (ei['options'] as unknown[]).map(String)
              : [],
            stakes:
              ei['stakes'] === 'critical' || ei['stakes'] === 'high'
                ? (ei['stakes'] as 'critical' | 'high')
                : 'high',
          });
        }
      }
    }

    let backendHint: BackendHint | null = null;
    if (
      parsed['backendHint'] !== null &&
      typeof parsed['backendHint'] === 'object'
    ) {
      const bh = parsed['backendHint'] as Record<string, unknown>;
      backendHint = {
        preferBackends: Array.isArray(bh['preferBackends'])
          ? (bh['preferBackends'] as unknown[]).map(String)
          : [],
        avoidBackends: Array.isArray(bh['avoidBackends'])
          ? (bh['avoidBackends'] as unknown[]).map(String)
          : [],
        rationale: String(bh['rationale'] ?? ''),
      };
    }

    return {
      reasoning: String(parsed['reasoning'] ?? ''),
      resourcePosture: String(parsed['resourcePosture'] ?? 'unknown'),
      resourceRationale: String(parsed['resourceRationale'] ?? ''),
      topGoalId:
        typeof parsed['topGoalId'] === 'string' ? parsed['topGoalId'] : null,
      suggestedNewGoal:
        typeof parsed['suggestedNewGoal'] === 'string'
          ? parsed['suggestedNewGoal']
          : null,
      backendHint,
      telegramDigest: String(parsed['telegramDigest']),
      escalations,
      confidence:
        parsed['confidence'] === 'high' ||
        parsed['confidence'] === 'medium' ||
        parsed['confidence'] === 'low'
          ? (parsed['confidence'] as 'high' | 'medium' | 'low')
          : 'low',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dry-run formatter (CLI --dry-run path)
// ---------------------------------------------------------------------------

/**
 * Format a DirectorContext + optional DirectorDecision for dry-run output.
 * Never sends Telegram. Never throws.
 */
export function formatDryRun(
  ctx: import('./director-context.js').DirectorContext,
  decision: DirectorDecision | null,
  raw?: string,
): string {
  const lines: string[] = [];

  lines.push('=== ELON DIRECTOR — DRY RUN ===');
  lines.push(`Generated: ${new Date().toUTCString()}`);
  lines.push('');

  lines.push('--- GOD-VIEW SNAPSHOT ---');
  lines.push(`Resource posture: ${ctx.resourcePosture.toUpperCase()}`);
  for (const b of ctx.resources.backends) {
    const pct = b.usedPct !== null ? ` ${b.usedPct}%` : '';
    lines.push(`  ${b.backend}: ${b.availability}${pct}`);
  }
  lines.push('');

  lines.push(`Fleet: ${ctx.fleet.daemonRunning ? 'RUNNING' : 'STOPPED'}${ctx.fleet.killed ? ' [KILLED]' : ''}`);
  lines.push(`Today spent: $${ctx.fleet.todaySpentUsd.toFixed(4)}`);
  lines.push(
    `Proposals: ${ctx.fleet.pendingProposals} pending, ${ctx.fleet.recentMerges} recent merges`,
  );
  lines.push(`Backlog: ${ctx.fleet.backlogItems} items`);
  lines.push('');

  lines.push(
    `Outcomes (24h): ${ctx.outcomes.mergedCount} merged, ${ctx.outcomes.rejectedCount} rejected, $${ctx.outcomes.costUsdToday.toFixed(4)} spent`,
  );
  lines.push(`Cache hit: ${Math.round(ctx.outcomes.cacheHitRate * 100)}%`);
  lines.push('');

  if (ctx.goals.active.length > 0) {
    lines.push(`Active goals (${ctx.goals.active.length}):`);
    for (const g of ctx.goals.active.slice(0, 4)) {
      const pct = Math.round(g.fractionDone * 100);
      lines.push(
        `  [${g.id}] ${g.objective.slice(0, 60)} — ${pct}% (${g.milestonesDone}/${g.milestonesTotal})`,
      );
    }
    lines.push('');
  }

  if (ctx.learning.lessonsCount > 0) {
    lines.push(
      `Learning (7d): ${ctx.learning.lessonsCount} lessons, ${ctx.learning.skillCount} skills`,
    );
    lines.push('');
  }

  if (!decision) {
    lines.push('--- DIRECTOR DECISION ---');
    lines.push('LLM unavailable or parse failed.');
    if (raw) {
      lines.push('');
      lines.push('Raw LLM output:');
      lines.push(raw.slice(0, 500));
    }
    return lines.join('\n');
  }

  lines.push('--- DIRECTOR DECISION ---');
  lines.push(`Confidence: ${decision.confidence.toUpperCase()}`);
  lines.push(`Resource posture: ${decision.resourcePosture.toUpperCase()}`);
  lines.push(`Rationale: ${decision.resourceRationale}`);
  lines.push('');
  lines.push(`Reasoning: ${decision.reasoning}`);
  lines.push('');

  if (decision.topGoalId) {
    lines.push(`Top goal: ${decision.topGoalId}`);
  }
  if (decision.suggestedNewGoal) {
    lines.push(`Suggested new goal: ${decision.suggestedNewGoal}`);
  }
  if (decision.backendHint) {
    lines.push(
      `Backend hint: prefer [${decision.backendHint.preferBackends.join(', ')}] avoid [${decision.backendHint.avoidBackends.join(', ')}]`,
    );
  }
  lines.push('');

  lines.push('--- TELEGRAM DIGEST (would send) ---');
  lines.push(decision.telegramDigest);

  if (decision.escalations.length > 0) {
    lines.push('');
    lines.push(`--- ESCALATIONS (${decision.escalations.length}) ---`);
    for (const esc of decision.escalations) {
      lines.push(`  [${esc.stakes.toUpperCase()}] ${esc.topic}`);
      lines.push(`    Context: ${esc.context.slice(0, 120)}`);
      if (esc.options.length > 0) {
        lines.push(`    Options: ${esc.options.join(' | ')}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one complete director cycle:
 *   build context → call LLM → parse decision → send digest → post escalations
 *
 * GATED: cfg.comms?.director must be true. When false/absent, returns immediately
 * (no-op, byte-identical to absent). Default-false.
 *
 * SAFETY: read-only god-view access. Communicates only through sendTelegramMessage
 * and postRequest('decision-needed'). No goal mutations, no execution, no merge,
 * no push. Never bypasses any safety gate.
 *
 * Never throws — fire-and-forget by design.
 */
export async function runDirectorCycle(cfg: AshlrConfig): Promise<void> {
  try {
    // Gate: cfg.comms.director must be explicitly true
    const directorEnabled =
      (cfg.comms as Record<string, unknown> | undefined)?.['director'] === true;
    if (!directorEnabled) return;

    // Build god-view snapshot
    const ctx = await buildDirectorContext(cfg);

    // Render user prompt
    const userPrompt = renderDirectorPrompt(ctx);

    // Call strategist LLM
    const complete = await buildComplete(cfg);
    const raw = await complete(DIRECTOR_SYSTEM_PROMPT, userPrompt);

    // Parse decision
    const decision = parseDecision(raw);
    if (!decision) return;

    // Send Telegram digest
    if (telegramEnabled(cfg) && decision.telegramDigest) {
      await sendTelegramMessage(decision.telegramDigest, undefined, cfg);
    }

    // Post escalations as decision-needed requests
    for (const esc of decision.escalations) {
      try {
        postRequest({
          kind: 'decision-needed',
          type: 'question',
          text: `[${esc.stakes.toUpperCase()}] ${esc.topic}\n\n${esc.context}`,
          options: esc.options.length > 0 ? esc.options : ['Acknowledge'],
          meta: {
            source: 'director',
            stakes: esc.stakes,
            topic: esc.topic,
          },
        });
      } catch {
        // best-effort — individual escalation failure must not block others
      }
    }
  } catch {
    // Fire-and-forget — errors must never propagate
  }
}

/**
 * Run one director cycle in dry-run mode: build context + call LLM but do NOT
 * send Telegram or post requests. Returns the formatted output string.
 * Never throws.
 */
export async function runDirectorDryRun(cfg: AshlrConfig): Promise<string> {
  try {
    // Build god-view snapshot (always — dry-run should show real state)
    const ctx = await buildDirectorContext(cfg);
    const userPrompt = renderDirectorPrompt(ctx);

    // Call LLM (uses real engine — shows actual reasoning against live state)
    let raw = '';
    let decision: DirectorDecision | null = null;
    try {
      const complete = await buildComplete(cfg);
      raw = await complete(DIRECTOR_SYSTEM_PROMPT, userPrompt);
      decision = parseDecision(raw);
    } catch {
      // LLM unavailable — still show context
    }

    return formatDryRun(ctx, decision, decision ? undefined : raw);
  } catch {
    return '[director dry-run failed]';
  }
}
