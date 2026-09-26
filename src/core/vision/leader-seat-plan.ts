/**
 * Leader seat plan — the PURE half of the 3.14 fallback chain.
 *
 * WHY. On 2026-09-26 the 06:30 memo failed with "The local call failed: fetch
 * failed": the router picked the only seat it ranks first among local models
 * (the 27B dense `qwen3.8:27b-ctx64k`, first by discovery order because it is
 * the preferred `local-coder` tag), which decoded at 17 → 2.7 tok/s while a
 * second copy of the same weights sat in the llama-server runtime; Node's
 * fetch gave up after 300 s without response headers (the request was not
 * streamed), and there was no second option. The memo simply failed.
 *
 * Now a run walks an ordered list of router-approved seats. This module
 * decides the ORDER among local models (fast before slow), the per-attempt
 * TIMEOUT (sized to the model's speed class and the run mode), and the output
 * and context budgets — all from config and the model tag, no I/O.
 *
 * What it can never do: add a seat the router or the Leader's seat rules did
 * not approve. It only orders and bounds what leader-seat.ts admitted.
 */
import type { AshlrConfig } from '../types.js';
import type { LeaderRunMode } from './leader-types.js';

export type LeaderSpeedClass = 'fast' | 'large' | 'unknown';

/**
 * Speed class from an Ollama tag. `fast`: ≤ 20B parameters, or a sparse MoE
 * tag (gpt-oss, `…-a3b`). `large`: > 20B dense — a memo-length answer can take
 * 10+ minutes on one. Unknown sizes are ordered between the two.
 */
export function localSpeedClass(model: string): LeaderSpeedClass {
  const tag = model.toLowerCase();
  if (/(^|[^a-z])gpt-oss([^a-z]|$)/.test(tag) || /[-:_]a\d+(\.\d+)?b\b/.test(tag)) return 'fast';
  const m = /(?:^|[:\-_])(\d+(?:\.\d+)?)b(?:$|[^a-z0-9])/.exec(tag);
  if (!m) return 'unknown';
  const billions = Number(m[1]);
  if (!Number.isFinite(billions)) return 'unknown';
  return billions <= 20 ? 'fast' : 'large';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v));
}

function leaderCfg(cfg: AshlrConfig | undefined): Record<string, unknown> {
  const foundry = cfg?.foundry as Record<string, unknown> | undefined;
  const leader = foundry?.['leader'];
  return leader && typeof leader === 'object' && !Array.isArray(leader) ? (leader as Record<string, unknown>) : {};
}

/**
 * The operator's explicit local order: `foundry.leader.localModel` (one tag)
 * then `foundry.leader.localModels` (a list). Named tags go first, in that
 * order; everything else follows by speed class.
 */
export function preferredLeaderLocalModels(cfg: AshlrConfig | undefined): string[] {
  const leader = leaderCfg(cfg);
  const one = typeof leader['localModel'] === 'string' ? stringList([leader['localModel']]) : [];
  return [...new Set([...one, ...stringList(leader['localModels'])])];
}

/**
 * `foundry.leader.claudeFallback: true` lets a router-approved Claude seat be
 * the LAST fallback of a full (non-deep) run when the budget mode is not
 * `reserve`. Off by default: Claude stays Mason's, used by the Leader only for
 * the weekly deep run (leader-seat.ts), as the 3.10 seat rules say.
 */
export function claudeFallbackEnabled(cfg: AshlrConfig | undefined): boolean {
  return leaderCfg(cfg)['claudeFallback'] === true;
}

const SPEED_RANK: Record<LeaderSpeedClass, number> = { fast: 0, unknown: 1, large: 2 };

/** Stable order for local seats: operator-named first, then fast → unknown → large, then the input order. */
export function orderLocalModels<T>(items: readonly T[], modelOf: (item: T) => string, cfg: AshlrConfig | undefined): T[] {
  const preferred = preferredLeaderLocalModels(cfg);
  const rankOf = (model: string): number => {
    const i = preferred.indexOf(model);
    return i === -1 ? preferred.length + SPEED_RANK[localSpeedClass(model)] : i;
  };
  return items
    .map((item, index) => ({ item, index, rank: rankOf(modelOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

export interface LeaderCallBudget {
  /** Hard wall-clock limit for this one attempt. */
  timeoutMs: number;
  /** Output cap (Ollama `num_predict`). */
  maxOutputTokens: number;
  /** Context to request from a local runtime (Ollama `num_ctx`); null = the runtime's own. */
  contextTokens: number | null;
}

const MIN = 60_000;

/**
 * Per-attempt timeouts. Local `large` is generous (a 27B at ~3 tok/s needs
 * ~15 min for a full memo) but bounded, so the chain still reaches the next
 * seat the same morning. A check-in asks for far less output, so every class
 * gets a shorter leash.
 */
export const LEADER_ATTEMPT_TIMEOUTS_MS: Readonly<Record<LeaderRunMode, Readonly<Record<'cli' | LeaderSpeedClass, number>>>> = Object.freeze({
  full: Object.freeze({ cli: 8 * MIN, fast: 6 * MIN, unknown: 12 * MIN, large: 18 * MIN }),
  checkin: Object.freeze({ cli: 4 * MIN, fast: 3 * MIN, unknown: 5 * MIN, large: 8 * MIN }),
});

export const LEADER_OUTPUT_TOKENS: Readonly<Record<LeaderRunMode, number>> = Object.freeze({ full: 3_072, checkin: 1_024 });

/**
 * The context the Leader asks a local runtime for: prompt + output + slack,
 * rounded up to 4k, between 8k and 32k. The runtimes default to 64k–262k
 * (llama-server's 262,144 total, Ollama's `ctx64k` tag); the Leader's prompt is
 * ~5k tokens, and a smaller KV cache is less memory pressure on a machine
 * that is also serving the fleet.
 */
export function leaderContextTokens(promptChars: number, mode: LeaderRunMode): number {
  const need = Math.ceil(promptChars / 4) + LEADER_OUTPUT_TOKENS[mode] + 1_024;
  return Math.min(32_768, Math.max(8_192, Math.ceil(need / 4_096) * 4_096));
}

export function leaderCallBudget(engine: 'grok' | 'claude' | 'local', model: string, mode: LeaderRunMode, promptChars: number): LeaderCallBudget {
  if (engine !== 'local') {
    return { timeoutMs: LEADER_ATTEMPT_TIMEOUTS_MS[mode].cli, maxOutputTokens: LEADER_OUTPUT_TOKENS[mode], contextTokens: null };
  }
  return {
    timeoutMs: LEADER_ATTEMPT_TIMEOUTS_MS[mode][localSpeedClass(model)],
    maxOutputTokens: LEADER_OUTPUT_TOKENS[mode],
    contextTokens: leaderContextTokens(promptChars, mode),
  };
}
