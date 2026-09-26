/**
 * Leader seat — which model the Leader thinks with (V3.10 Track B unit U8).
 *
 * WHY THIS FILE EXISTS. The Strategist the Leader extends picked its model
 * from `managerJudgeModel` (strategist.ts, pre-3.10), which on this machine is
 * `gpt-5.5` — so its "local fallback" asked Ollama for a model Ollama does not
 * have, failed, and returned an unwritten fallback briefing every night since
 * June. The next step then called `getActiveClient({ allowCloud: true })`,
 * which could have spent money on any cloud key it found. The Leader instead
 * routes like every other autonomous task:
 *
 *   routeSeat({ task: 'leader', difficulty: 'high', autonomous: true })
 *     over the A9 budget policy CLAMPED TO THE GRANT, restricted to
 *       - grok (the SuperGrok CLI seat) and local models — always;
 *       - claude ONLY for the weekly deep run, and only when it fits inside
 *         Mason's reserve (the router excludes it at 5-hour > 70% or when the
 *         weekly reserve would be touched);
 *       - never codex.
 *   With no standing grant, paid seats are not candidates at all: the Leader
 *   runs on free local models or not at all.
 *   No eligible seat ⇒ `no-seat` (fails closed). There is no cloud fallback.
 *
 * Unknown usage is not headroom (A9): a paid seat with no fresh reading in the
 * capacity snapshot the Verse server publishes is ineligible.
 *
 * TRANSPORTS (inference only — the Leader never gets tools). The paid ones
 * are the SAME text-only invocations the fleet's judges use (B-U7,
 * run/engine-registry.ts), so there is one audited "no tools" recipe per CLI,
 * not two that can drift apart:
 *   local  — Ollama `/api/chat` on the loopback endpoint the seat was
 *            discovered on, JSON-constrained, behind the local-only gate.
 *   grok   — buildGrokCliHeadlessCommand: the grok-a launcher with
 *            GROK_CLI_HEADLESS_ARGV (no tools, no web, no subagents, no
 *            memory) in a fresh empty 0700 directory; the answer is read with
 *            extractGrokStreamText. The resolved grok-cli seat must BE the seat
 *            the router picked, or the call is refused.
 *   claude — the seat's launcher with `-p --safe-mode --system-prompt …`,
 *            passed through restrictClaudeCommand (CLAUDE_RESTRICTED_ARGS),
 *            prompt on stdin. Its credential comes from the judges' hook
 *            (fleet/manager.ts judgeCredentialEnv): in standing mode that is
 *            the custody-minted claude-a token, attached only because the
 *            command is restricted. With no hook available, Claude is not a
 *            Leader candidate at all (fails closed — never Mason's own login).
 * Every paid transport passes `enginePermitted` first, so local-only mode
 * refuses it outright.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineCommand } from '../types.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../run/model-catalog.js';
import { buildGrokCliHeadlessCommand, extractGrokStreamText, restrictClaudeCommand } from '../run/engine-registry.js';
import { assertPermitted, endpointPermitted, enginePermitted } from '../policy/local-only.js';
import type { BudgetPolicy, RoutingRequest, SeatDecision } from '../routing/types.js';
import type { SeatCapacity } from '../routing/headroom.js';
import type { EffectivePolicy } from '../authority/types.js';
import type { VerseSeat } from '../verse/types.js';
import type { LeaderRunMode, LeaderSeatAttempt } from './leader-types.js';
import { claudeFallbackEnabled, leaderCallBudget, orderLocalModels, type LeaderCallBudget } from './leader-seat-plan.js';

export type LeaderComplete = (system: string, user: string) => Promise<string>;
export type LeaderSeatEngine = 'claude' | 'grok' | 'local';

export interface LeaderSeatChoice {
  seatId: string;
  engine: LeaderSeatEngine;
  model: string;
  /** The weekly Claude deep run. */
  deep: boolean;
}

export type LeaderSeatResolution =
  | { ok: true; choice: LeaderSeatChoice; complete: LeaderComplete; decision: SeatDecision }
  | { ok: false; reason: string; decision: SeatDecision | null };

/** What discovery tells us about one seat — identity, model, launcher. */
export interface LeaderSeatCandidate {
  seat: VerseSeat;
  /** Native-profile launcher argv prefix (claude / grok); null for local seats. */
  launcher: string[] | null;
  /** Ollama base (no /v1) for local seats. */
  ollamaBaseUrl: string | null;
}

/**
 * The spawn env for one restricted Claude Leader command — the judges' hook
 * (fleet/manager.ts `judgeCredentialEnv`): undefined = the default env (no
 * credential source registered in this process), an env carrying the
 * claude-a token, or 'refused' (the source failed, or the command is not
 * restricted). Refused means the call does not happen.
 */
export type LeaderClaudeCredential = (cmd: EngineCommand) => Promise<NodeJS.ProcessEnv | undefined | 'refused'>;

/**
 * 3.14: per-attempt limits. Optional so older fakes keep compiling; absent =
 * the transport's own defaults.
 */
export type LeaderCallOptions = Partial<LeaderCallBudget>;

export interface LeaderTransports {
  local(baseUrl: string, model: string, opts?: LeaderCallOptions): LeaderComplete;
  grok(launcher: readonly string[], model: string, opts?: LeaderCallOptions): LeaderComplete;
  claude(launcher: readonly string[], model: string, credential: LeaderClaudeCredential, opts?: LeaderCallOptions): LeaderComplete;
}

export interface LeaderSeatDeps {
  cfg: AshlrConfig;
  now(): number;
  candidates(): Promise<LeaderSeatCandidate[]>;
  /** The capacity snapshot the Verse server publishes (null = none). */
  capacitySnapshot(): { publishedAt: string; seats: SeatCapacity[] } | null;
  budgetPolicy(): BudgetPolicy;
  standingPolicy(): EffectivePolicy | null;
  clampBudget(policy: BudgetPolicy, standing: Pick<EffectivePolicy, 'spend'>): BudgetPolicy;
  route(req: RoutingRequest, capacity: readonly SeatCapacity[], policy: BudgetPolicy, nowMs: number): SeatDecision;
  capacityFromSeat(seat: VerseSeat): SeatCapacity;
  recordDecision(req: RoutingRequest, decision: SeatDecision): void;
  transports: LeaderTransports;
  /**
   * The judges' restricted-Claude credential hook. Absent / null ⇒ Claude is
   * not a Leader candidate (the weekly deep run falls to grok or local): a
   * Claude call whose credential path cannot be vouched for would otherwise
   * run on whatever login the launcher finds.
   */
  claudeCredential?: LeaderClaudeCredential | null;
}

/**
 * The local model the legacy Strategist falls back to. NEVER
 * `managerJudgeModel` — that key names the manager judge's engine model
 * (`gpt-5.5` on codex here) and is not an Ollama tag.
 */
export function resolveLocalLeaderModel(cfg: AshlrConfig | undefined): string {
  const foundry = cfg?.foundry as Record<string, unknown> | undefined;
  const leader = foundry?.['leader'] as Record<string, unknown> | undefined;
  const configured = leader?.['localModel'];
  if (typeof configured === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(configured)) return configured;
  return DEFAULT_LOCAL_MODEL_TAG;
}

/** A rough token estimate for the fit check (4 chars ≈ 1 token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function runnableModel(seat: VerseSeat): string | null {
  const first = seat.models.find((m) => !(m as { unavailableReason?: unknown }).unavailableReason) ?? seat.models[0];
  return first?.id ?? null;
}

function unknownCapacity(seat: VerseSeat): SeatCapacity {
  // No reading = no headroom: the router marks it ineligible for autonomy.
  return {
    seatId: seat.id,
    engine: seat.engine as SeatCapacity['engine'],
    label: seat.label,
    free: false,
    windows: [],
    signedOut: false,
    reachable: null,
    contextWindow: seat.contextWindow,
    observedAt: null,
    spentTodayUsd: null,
  };
}

interface LeaderRouting {
  eligible: LeaderSeatCandidate[];
  decision: SeatDecision;
  policy: BudgetPolicy;
  /** Seats the Leader's own rules removed before routing (codex, Claude outside its runs, not granted). */
  ruledOut: LeaderSeatAttempt[];
}

function skippedSeat(c: LeaderSeatCandidate, reason: string): LeaderSeatAttempt {
  return { seatId: c.seat.id, engine: c.seat.engine, model: runnableModel(c.seat), outcome: 'skipped', reason, ms: null, timeoutMs: null };
}

/**
 * The shared routing step: the Leader's seat rules, the grant clamp, then the
 * router. Returns the router's decision over the admitted seats, or a refusal.
 */
async function routeLeader(
  deps: LeaderSeatDeps,
  opts: { deep: boolean; promptChars: number; mode: LeaderRunMode; localOnly?: boolean },
): Promise<{ ok: true; routing: LeaderRouting } | { ok: false; reason: string; decision: SeatDecision | null; ruledOut: LeaderSeatAttempt[] }> {
  const nowMs = deps.now();
  let candidates: LeaderSeatCandidate[];
  try {
    candidates = await deps.candidates();
  } catch {
    return { ok: false, reason: 'Seat discovery failed.', decision: null, ruledOut: [] };
  }
  const standing = deps.standingPolicy();
  // Claude: the weekly deep run (3.10), or — opt-in, 3.14 — the last fallback
  // of a full run. A check-in is cheap by definition: grok or local only.
  const claudeRun = opts.mode === 'full' && !opts.localOnly && (opts.deep || claudeFallbackEnabled(deps.cfg));
  const engines = new Set<string>(opts.localOnly ? ['local'] : ['grok', 'local']);
  if (claudeRun && deps.claudeCredential) engines.add('claude');

  const ruledOut: LeaderSeatAttempt[] = [];
  const eligible = candidates.filter((c) => {
    if (!engines.has(c.seat.engine)) {
      ruledOut.push(skippedSeat(c, opts.localOnly && c.seat.engine !== 'codex'
        ? 'Budget mode is reserve: this run uses free local models only.'
        : c.seat.engine !== 'claude'
        ? `The Leader never uses ${c.seat.engine}.`
        : opts.mode === 'checkin'
          ? 'A check-in never uses Claude.'
          : !claudeRun
            ? 'Claude is only for the weekly deep run.'
            : 'The restricted-Claude credential hook is unavailable.'));
      return false;
    }
    if (c.seat.engine === 'local') return true;
    // Paid seats need a standing grant that lists them for the leader role.
    if (!standing) {
      ruledOut.push(skippedSeat(c, 'No standing grant: paid seats are not Leader candidates.'));
      return false;
    }
    const grantSeat = standing.spend.seats[c.seat.id];
    const ok = grantSeat !== undefined && grantSeat.enabled && grantSeat.roles.includes('leader');
    if (!ok) ruledOut.push(skippedSeat(c, 'The grant does not list this seat for the leader role.'));
    return ok;
  });
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: standing
        ? 'No seat is available to the Leader: no local model is running and the grant lists no paid seat for the leader role.'
        : 'No local model is running, and without a standing grant the Leader may not use a paid seat.',
      decision: null,
      ruledOut,
    };
  }

  let policy: BudgetPolicy;
  try {
    policy = deps.budgetPolicy();
    if (standing) policy = deps.clampBudget(policy, standing);
  } catch {
    // Cannot clamp to the grant ⇒ paid seats are out; local still works.
    const localOnly = eligible.filter((c) => c.seat.engine === 'local');
    for (const c of eligible) if (c.seat.engine !== 'local') ruledOut.push(skippedSeat(c, 'The budget could not be clamped to the grant.'));
    if (localOnly.length === 0) return { ok: false, reason: 'The budget could not be clamped to the grant, and no local model is running.', decision: null, ruledOut };
    eligible.splice(0, eligible.length, ...localOnly);
    policy = deps.budgetPolicy();
  }
  // The Claude FALLBACK (not the weekly deep run) is off in reserve mode.
  if (!opts.deep && policy.mode === 'reserve') {
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      const c = eligible[i]!;
      if (c.seat.engine !== 'claude') continue;
      ruledOut.push(skippedSeat(c, 'Budget mode is reserve: no Claude fallback.'));
      eligible.splice(i, 1);
    }
    if (eligible.length === 0) return { ok: false, reason: 'Budget mode is reserve and no other seat is available.', decision: null, ruledOut };
  }

  const snapshot = deps.capacitySnapshot();
  const byId = new Map((snapshot?.seats ?? []).map((s) => [s.seatId, s]));
  const capacity = eligible.map((c) => (c.seat.engine === 'local' ? deps.capacityFromSeat(c.seat) : byId.get(c.seat.id) ?? unknownCapacity(c.seat)));
  const request: RoutingRequest = {
    task: 'leader',
    difficulty: 'high',
    autonomous: true,
    // Prompt plus room for the memo itself — a seat whose window cannot hold both is not used.
    contextTokens: Math.ceil(opts.promptChars / 4) + 4_096,
  };
  const decision = deps.route(request, capacity, policy, nowMs);
  try { deps.recordDecision(request, decision); } catch { /* shadow log is best-effort */ }
  if (!decision.seatId) return { ok: false, reason: decision.why, decision, ruledOut };
  return { ok: true, routing: { eligible, decision, policy, ruledOut } };
}

type BuiltSeat = { ok: true; choice: LeaderSeatChoice; complete: LeaderComplete; budget: LeaderCallBudget } | { ok: false; reason: string };

/** Build one seat's completion function (the per-engine gates run here). */
function buildSeat(deps: LeaderSeatDeps, chosen: LeaderSeatCandidate, opts: { mode: LeaderRunMode; promptChars: number }): BuiltSeat {
  const model = runnableModel(chosen.seat);
  if (!model) return { ok: false, reason: `Seat ${chosen.seat.id} has no runnable model.` };
  const engine = chosen.seat.engine as LeaderSeatEngine;
  const budget = leaderCallBudget(engine, model, opts.mode, opts.promptChars);
  let complete: LeaderComplete;
  if (engine === 'local') {
    if (!chosen.ollamaBaseUrl) return { ok: false, reason: 'The local seat has no endpoint.' };
    complete = deps.transports.local(chosen.ollamaBaseUrl, model, budget);
  } else {
    const verdict = enginePermitted(engine, deps.cfg);
    if (!verdict.permitted) return { ok: false, reason: `Local-only mode refuses ${engine}.` };
    if (!chosen.launcher || chosen.launcher.length === 0) return { ok: false, reason: `Seat ${chosen.seat.id} has no launcher.` };
    complete = engine === 'grok'
      ? deps.transports.grok(chosen.launcher, model, budget)
      // claudeCredential is non-null here: without it 'claude' never entered `engines`.
      : deps.transports.claude(chosen.launcher, model, deps.claudeCredential!, budget);
  }
  return { ok: true, choice: { seatId: chosen.seat.id, engine, model, deep: engine === 'claude' }, complete, budget };
}

/**
 * Pick the Leader's seat and build its completion function. Never throws;
 * every refusal is a specific sentence. This is the router's single pick —
 * a run walks the fallback chain from `planLeaderSeats` instead.
 */
export async function resolveLeaderSeat(
  deps: LeaderSeatDeps,
  opts: { deep: boolean; promptChars: number; mode?: LeaderRunMode },
): Promise<LeaderSeatResolution> {
  const mode = opts.mode ?? 'full';
  const routed = await routeLeader(deps, { ...opts, mode });
  if (!routed.ok) return { ok: false, reason: routed.reason, decision: routed.decision };
  const { eligible, decision } = routed.routing;
  const chosen = eligible.find((c) => c.seat.id === decision.seatId);
  if (!chosen) return { ok: false, reason: `Seat ${decision.seatId} has no runnable model.`, decision };
  const built = buildSeat(deps, chosen, { mode, promptChars: opts.promptChars });
  if (!built.ok) return { ok: false, reason: built.reason, decision };
  return { ok: true, choice: built.choice, complete: built.complete, decision };
}

export interface LeaderSeatPlanStep {
  choice: LeaderSeatChoice;
  complete: LeaderComplete;
  budget: LeaderCallBudget;
}

export type LeaderSeatPlan =
  | { ok: true; steps: LeaderSeatPlanStep[]; skipped: LeaderSeatAttempt[]; decision: SeatDecision }
  | { ok: false; reason: string; skipped: LeaderSeatAttempt[]; decision: SeatDecision | null };

function exclusionAttempts(decision: SeatDecision | null, byId: ReadonlyMap<string, LeaderSeatCandidate>): LeaderSeatAttempt[] {
  return (decision?.exclusions ?? []).map((x) => {
    const c = byId.get(x.seatId);
    return {
      seatId: x.seatId,
      engine: c?.seat.engine ?? 'unknown',
      model: c ? runnableModel(c.seat) : null,
      outcome: 'skipped' as const,
      reason: x.reasons.join(' ') || 'The router excluded this seat.',
      ms: null,
      timeoutMs: null,
    };
  });
}

/**
 * 3.14 — the fallback CHAIN. Every step is a seat the router approved over the
 * seats the Leader's rules admitted (the same gates as `resolveLeaderSeat`),
 * ordered:
 *   1. the router's pick when it is a paid seat (grok; Claude on the deep run);
 *   2. other approved grok seats, in the router's order;
 *   3. approved local models — operator-named first, then FAST before LARGE
 *      (leader-seat-plan.ts: a 27B dense model is the slow last resort);
 *   4. Claude last, when it was admitted as a fallback (opt-in; never on a
 *      check-in, never in reserve mode unless it is the weekly deep run).
 * Codex is never in it; with no grant it holds local models only; there is no
 * cloud fallback outside it. Seats the router excluded or the rules removed
 * come back as `skipped`, with their reasons, for the memo and the health
 * surface.
 */
export async function planLeaderSeats(
  deps: LeaderSeatDeps,
  opts: { deep: boolean; promptChars: number; mode: LeaderRunMode; localOnly?: boolean },
): Promise<LeaderSeatPlan> {
  const routed = await routeLeader(deps, opts);
  if (!routed.ok) {
    return { ok: false, reason: routed.reason, skipped: [...routed.ruledOut, ...exclusionAttempts(routed.decision, new Map())], decision: routed.decision };
  }
  const { eligible, decision, ruledOut } = routed.routing;
  const byId = new Map(eligible.map((c) => [c.seat.id, c]));
  const approved = decision.candidates.map((id) => byId.get(id)).filter((c): c is LeaderSeatCandidate => c !== undefined);
  const pick = decision.seatId ? byId.get(decision.seatId) : undefined;
  // The router ranks Claude first for high-difficulty work; outside the weekly
  // deep run Claude is only ever the LAST fallback.
  const first = pick && pick.seat.engine !== 'local' && (pick.seat.engine !== 'claude' || opts.deep) ? [pick] : [];
  const rest = approved.filter((c) => !first.includes(c));
  const ordered = [
    ...first,
    ...rest.filter((c) => c.seat.engine === 'grok'),
    ...orderLocalModels(rest.filter((c) => c.seat.engine === 'local'), (c) => runnableModel(c.seat) ?? '', deps.cfg),
    ...rest.filter((c) => c.seat.engine === 'claude'),
  ];

  const skippedList: LeaderSeatAttempt[] = [...ruledOut, ...exclusionAttempts(decision, byId)];
  const steps: LeaderSeatPlanStep[] = [];
  for (const c of ordered) {
    const built = buildSeat(deps, c, { mode: opts.mode, promptChars: opts.promptChars });
    if (built.ok) steps.push({ choice: built.choice, complete: built.complete, budget: built.budget });
    else skippedList.push(skippedSeat(c, built.reason));
  }
  if (steps.length === 0) {
    const last = skippedList.map((x) => x.reason).filter((r): r is string => typeof r === 'string' && r.length > 0).at(-1);
    return { ok: false, reason: last ?? decision.why, skipped: skippedList, decision };
  }
  return { ok: true, steps, skipped: skippedList, decision };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Run a CLI to completion with a timeout and an output cap. Resolves stdout; rejects on failure. */
export function runCliCompletion(
  argv: readonly string[],
  opts: {
    stdin: string | null;
    timeoutMs: number;
    /** A private empty directory the CALLER made (and removes); default: a fresh one made and removed here. */
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      reject(new Error('empty command'));
      return;
    }
    // An empty scratch directory: even a read tool sees nothing of the repo.
    const ownCwd = opts.cwd === undefined;
    const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'ashlr-leader-'));
    const child = spawn(cmd, args, { cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ownCwd) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* tmp cleanup */ } }
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`)));
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4_096) err += chunk.toString('utf8');
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => {
      if (code === 0) resolve(out);
      else reject(new Error(`exited ${code ?? 'by signal'}`));
    }));
    child.stdin.end(opts.stdin ?? '');
  });
}

/**
 * Read an Ollama `/api/chat` NDJSON stream to the end, concatenating
 * `message.content`. Rejects on a stream-level `error` line.
 */
async function readOllamaChatStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  const take = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: { message?: { content?: unknown }; error?: unknown };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      return; // a torn / non-JSON line is not content
    }
    if (typeof parsed.error === 'string') throw new Error(`ollama: ${parsed.error.slice(0, 200)}`);
    if (typeof parsed.message?.content === 'string' && text.length < MAX_OUTPUT_BYTES) text += parsed.message.content;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl = buffered.indexOf('\n');
    while (nl !== -1) {
      take(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf('\n');
    }
  }
  take(buffered + decoder.decode());
  return text;
}

/**
 * The local Leader call. STREAMED (3.14): with `stream: false` the server sends
 * no response headers until the whole memo is written, and Node's fetch
 * (undici) abandons a request after 300 s without headers — on 2026-09-26 a
 * 27B decoding at ~3 tok/s hit exactly that ("fetch failed" at 5m2s) while
 * the old 15-minute timer never fired. Streaming makes headers arrive at once;
 * the wall-clock limit is then the per-attempt `timeoutMs` alone.
 *
 * `contextTokens` caps the KV cache the runtime allocates for this request
 * (Ollama `num_ctx`): the Leader needs ~8–16k, not the model tag's 64k or the
 * runtime's 262k.
 */
export function ollamaLeaderTransport(
  baseUrl: string,
  model: string,
  cfg: AshlrConfig | undefined,
  timeoutMs = 15 * 60_000,
  opts: { maxOutputTokens?: number; contextTokens?: number | null } = {},
): LeaderComplete {
  return async (system, user) => {
    const url = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`;
    // LOCAL-ONLY GATE: a remote inference host configured as "ollama" is a cloud endpoint.
    assertPermitted(endpointPermitted(url, cfg));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const options: Record<string, number> = { temperature: 0.2, num_predict: opts.maxOutputTokens ?? 4_096 };
    if (typeof opts.contextTokens === 'number' && opts.contextTokens > 0) options['num_ctx'] = opts.contextTokens;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          stream: true,
          // JSON-constrained decoding: the memo parser fails closed on prose,
          // so asking the runtime for an object is the cheap way to not fail.
          format: 'json',
          think: false,
          options,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('empty response body');
      return await readOllamaChatStream(res.body);
    } catch (err) {
      if (timedOut) throw new LeaderTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A per-attempt wall-clock limit was hit (the chain records it as `timeout`). */
export class LeaderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'LeaderTimeoutError';
  }
}

/**
 * The grok Leader command: B-U7's headless text-only invocation of the
 * grok-cli seat (GROK_CLI_HEADLESS_ARGV — no tools, no web, no subagents, no
 * memory), exactly as the grok judge runs it. System and user text travel as
 * one goal because the headless argv has no separate system slot (the judge
 * does the same).
 *
 * The seat is resolved by buildGrokCliHeadlessCommand from the private
 * roster, independently of the seat the router picked. The two must be the
 * SAME launcher: otherwise the router would have checked one account's
 * headroom and the call would spend another's.
 */
export function grokLeaderCommand(
  launcher: readonly string[],
  model: string,
  system: string,
  user: string,
  cfg: AshlrConfig | undefined,
  cwd: string,
): { ok: true; cmd: EngineCommand } | { ok: false; reason: string } {
  const cmd = buildGrokCliHeadlessCommand(`${system}\n\n${user}`, cfg, { cwd, model });
  if (!cmd) return { ok: false, reason: 'The grok-cli seat does not resolve.' };
  if (launcher.length !== 2 || launcher[0] !== cmd.bin || launcher[1] !== cmd.args[0]) {
    return { ok: false, reason: "The grok-cli seat is not the grok seat the router picked." };
  }
  return { ok: true, cmd };
}

/**
 * The Claude Leader command: `-p` with the system prompt as a flag and the
 * user prompt on stdin, then restrictClaudeCommand (CLAUDE_RESTRICTED_ARGS —
 * no tools, no MCP, no settings files, no session persistence). `--safe-mode`
 * additionally disables every customization. Null when the result is not a
 * restricted command, in which case nothing is spawned.
 */
export function claudeLeaderCommand(launcher: readonly string[], model: string, system: string): EngineCommand | null {
  const [bin, ...prefix] = launcher;
  if (!bin) return null;
  return restrictClaudeCommand({
    bin,
    args: [...prefix, '-p', '--output-format', 'json', '--model', model, '--safe-mode', '--system-prompt', system],
  });
}

const LEADER_CLI_TIMEOUT_MS = 10 * 60_000;
const GROK_CLI_ENGINE = 'grok-cli';

export function defaultLeaderTransports(cfg: AshlrConfig): LeaderTransports {
  return {
    local: (baseUrl, model, opts) => ollamaLeaderTransport(baseUrl, model, cfg, opts?.timeoutMs ?? 15 * 60_000, {
      maxOutputTokens: opts?.maxOutputTokens,
      contextTokens: opts?.contextTokens ?? null,
    }),
    grok: (launcher, model, opts) => async (system, user) => {
      // Re-checked per call (as the grok judge does): local-only may have been
      // latched since the seat was resolved.
      if (!enginePermitted(GROK_CLI_ENGINE, cfg).permitted) throw new Error('Local-only mode refuses grok-cli.');
      // realpath: macOS tmpdir is a /var → /private/var symlink; grok gets the canonical path.
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-leader-')));
      try {
        const built = grokLeaderCommand(launcher, model, system, user, cfg, cwd);
        if (!built.ok) throw new Error(built.reason);
        const out = await runCliCompletion([built.cmd.bin, ...built.cmd.args], { stdin: null, timeoutMs: opts?.timeoutMs ?? LEADER_CLI_TIMEOUT_MS, cwd });
        const parsed = extractGrokStreamText(out);
        if (parsed.error !== null) throw new Error(`grok reported an error: ${parsed.error.slice(0, 200)}`);
        if (!parsed.text) throw new Error('grok returned no text');
        return parsed.text;
      } finally {
        try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
      }
    },
    claude: (launcher, model, credential, opts) => async (system, user) => {
      const cmd = claudeLeaderCommand(launcher, model, system);
      if (!cmd) throw new Error('The Claude Leader command could not be restricted.');
      const env = await credential(cmd);
      if (env === 'refused') throw new Error('The restricted-Claude credential was refused.');
      const raw = await runCliCompletion([cmd.bin, ...cmd.args], { stdin: user, timeoutMs: opts?.timeoutMs ?? LEADER_CLI_TIMEOUT_MS, ...(env ? { env } : {}) });
      try {
        const parsed = JSON.parse(raw) as { result?: unknown };
        return typeof parsed.result === 'string' ? parsed.result : raw;
      } catch {
        return raw;
      }
    },
  };
}

/**
 * The judges' credential hook, if this build exports it. fleet/manager.ts
 * keeps `judgeCredentialEnv` (the one function that decides whether the
 * claude-a token may reach a spawn) module-private today; the Leader must use
 * that same function rather than a second copy of the rule, so it is looked
 * up by name and, when missing, Claude is simply not a Leader candidate.
 */
export async function loadJudgeCredentialHook(cfg: AshlrConfig): Promise<LeaderClaudeCredential | null> {
  try {
    const manager = (await import('../fleet/manager.js')) as unknown as Record<string, unknown>;
    const hook = manager['judgeCredentialEnv'];
    if (typeof hook !== 'function') return null;
    const call = hook as (cmd: EngineCommand, cfg: AshlrConfig) => Promise<NodeJS.ProcessEnv | undefined | 'refused'>;
    return (cmd) => call(cmd, cfg);
  } catch {
    return null;
  }
}

/** Production deps (heavy modules imported lazily so strategist.ts can import this file cheaply). */
export async function loadDefaultLeaderSeatDeps(cfg: AshlrConfig): Promise<LeaderSeatDeps> {
  const [seats, budgetStore, router, headroom, effective, claudeCredential] = await Promise.all([
    import('../verse/seats.js'),
    import('../routing/budget-store.js'),
    import('../routing/router.js'),
    import('../routing/headroom.js'),
    import('../authority/effective-config.js'),
    loadJudgeCredentialHook(cfg),
  ]);
  return {
    cfg,
    now: () => Date.now(),
    candidates: async () => {
      const discovery = await seats.discoverSeats(cfg, {
        // The Leader needs identity and launchers, not the Claude token scan.
        claudeUsage: () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: Date.now(), filesScanned: 0 }),
      });
      return discovery.seats.map((seat) => {
        const launch = discovery.launches.get(seat.id);
        return {
          seat,
          launcher: launch?.launcher ? [...launch.launcher] : null,
          ollamaBaseUrl: seat.engine === 'local' ? launch?.ollamaBaseUrl ?? null : null,
        };
      });
    },
    capacitySnapshot: () => budgetStore.readCapacitySnapshot(),
    budgetPolicy: () => budgetStore.loadBudgetPolicy(),
    standingPolicy: () => effective.currentStandingPolicy(),
    clampBudget: (policy, standing) => effective.clampBudgetPolicy(policy, standing),
    route: (req, capacity, policy, nowMs) => router.routeSeat(req, capacity, policy, { nowMs }),
    capacityFromSeat: (seat) => headroom.capacityFromSeat(seat),
    recordDecision: (req, decision) => budgetStore.recordShadowDecision({ source: 'leader', request: req, decision, actual: null }),
    transports: defaultLeaderTransports(cfg),
    claudeCredential,
  };
}
