/** Leader roles use task fit and observed account capacity, not provider bans.
 * The router ranks source-discovered model variants on their real account IDs;
 * each account retains one shared allowance. Native completion contacts enter
 * the same account-bound, Stop-aware execution lifecycle as native workers.
 * Missing authority, billing or model evidence remains a specific hold. */
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
import { seatTier, tierRank } from '../routing/tiers.js';
import { tierPreference } from '../routing/router.js';
import type { NativeRoleEngine, RoleCompletionMetrics } from '../run/role-completion.js';
import { subscriptionOnlyCurrent } from '../routing/subscription-only.js';
import { peekDevinCliExecutionBinding, refreshDevinCliExecutionBinding } from '../devin/cli-admission.js';
import type { EffectivePolicy } from '../authority/types.js';
import type { VerseSeat } from '../verse/types.js';
import type { LeaderRunMode, LeaderSeatAttempt } from './leader-types.js';
import { leaderCallBudget, type LeaderCallBudget } from './leader-seat-plan.js';

export type LeaderComplete = (system: string, user: string) => Promise<string>;
export type LeaderSeatEngine = 'claude' | 'codex' | 'grok' | 'devin' | 'local';

export interface LeaderSeatChoice {
  seatId: string;
  engine: LeaderSeatEngine;
  model: string;
  /** Whether this request asks for a deep planning run; independent of provider. */
  deep: boolean;
}

/** Both memo and conversation work use the same account/model admission. */
export type LeaderSeatPurpose = 'memo' | 'reply';

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
  /** Host-issued account-bound dispatcher; absent older builds retain only their qualified legacy transports. */
  native?(seatId: string, engine: NativeRoleEngine, model: string, admitted: () => boolean, opts: LeaderCallOptions): LeaderComplete;
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
  const first = seat.models.find((m) => !(m as { unavailableReason?: unknown }).unavailableReason);
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
  opts: { deep: boolean; promptChars: number; mode: LeaderRunMode; localOnly?: boolean; purpose?: LeaderSeatPurpose },
): Promise<{ ok: true; routing: LeaderRouting } | { ok: false; reason: string; decision: SeatDecision | null; ruledOut: LeaderSeatAttempt[] }> {
  const nowMs = deps.now();
  let candidates: LeaderSeatCandidate[];
  try {
    candidates = await deps.candidates();
  } catch {
    return { ok: false, reason: 'Seat discovery failed.', decision: null, ruledOut: [] };
  }
  const standing = deps.standingPolicy();
  const engines = new Set<string>(opts.localOnly ? ['local'] : ['grok', 'local']);
  if (!opts.localOnly && deps.transports.native) for (const engine of ['claude','codex','devin']) engines.add(engine);
  // Older source-qualified text-only Claude hooks remain usable. Native
  // production uses the official account-bound adapter, never a global login.
  if (!opts.localOnly && deps.claudeCredential) engines.add('claude');
  const ruledOut: LeaderSeatAttempt[] = [];
  const eligible = candidates.filter((c) => {
    if (!engines.has(c.seat.engine)) {
      ruledOut.push(skippedSeat(c, opts.localOnly
        ? 'This run uses local models only.'
        : 'The account-bound role adapter is unavailable.'));
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
        ? 'No granted account/model with an implemented role adapter is available.'
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
  const snapshot = deps.capacitySnapshot();
  const byId = new Map((snapshot?.seats ?? []).map((s) => [s.seatId, s]));
  const request: RoutingRequest = {
    task: 'leader', difficulty: 'high', autonomous: true,
    contextTokens: Math.ceil(opts.promptChars / 4) + 4_096,
  };
  // Inspect every source-discovered option without creating virtual quota
  // seats. Pick one fitting option per real account, then rank accounts.
  const preference=tierPreference(policy.mode,request);
  const rank=(c:SeatCapacity):number => preference.by === 'tier'
    ? preference.order.indexOf(c.tier ?? seatTier(c.engine))
    : preference.order.indexOf(c.free || c.costBasis === 'free' ? 'free' : c.tier ?? seatTier(c.engine));
  const selected:LeaderSeatCandidate[]=[];
  const capacity:SeatCapacity[]=[];
  for(const candidate of eligible){
    const base=candidate.seat.engine === 'local' ? deps.capacityFromSeat(candidate.seat) : byId.get(candidate.seat.id) ?? unknownCapacity(candidate.seat);
    if(deps.transports.native && candidate.seat.engine === 'codex' && !subscriptionOnlyCurrent(base,nowMs)){
      ruledOut.push(skippedSeat(candidate,'A current subscription-only billing boundary is unconfirmed.'));continue;
    }
    const models=candidate.seat.models.filter(model=>!model.unavailableReason);
    const variants=models.map(model => ({
      candidate:{...candidate,seat:{...candidate.seat,models:[model],contextWindow:model.contextWindow}},
      capacity:{...base,contextWindow:model.contextWindow,tier:seatTier(candidate.seat.engine,model.id),
        ...(candidate.seat.engine === 'devin' && candidate.seat.id === 'devin-cli' && peekDevinCliExecutionBinding(model.id)
          ? {free:true,costBasis:'free' as const,contextWindow:peekDevinCliExecutionBinding(model.id)!.contextTokens} : {})},
    })).filter(variant => deps.route(request,[variant.capacity],policy,nowMs).seatId !== null)
      .sort((a,b)=>rank(a.capacity)-rank(b.capacity) || tierRank(a.capacity.tier)-tierRank(b.capacity.tier));
    const variant=variants[0];
    if(variant){selected.push(variant.candidate);capacity.push(variant.capacity);}
    else {capacity.push({...base,contextWindow:models[0]?.contextWindow ?? 0});selected.push({...candidate,seat:{...candidate.seat,models:models.slice(0,1)}});}
  }
  eligible.splice(0,eligible.length,...selected);
  const decision = deps.route(request, capacity, policy, nowMs);
  try { deps.recordDecision(request, decision); } catch { /* shadow log is best-effort */ }
  if (!decision.seatId) return { ok: false, reason: decision.why, decision, ruledOut };
  return { ok: true, routing: { eligible, decision, policy, ruledOut } };
}

type BuiltSeat = { ok: true; choice: LeaderSeatChoice; complete: LeaderComplete; budget: LeaderCallBudget } | { ok: false; reason: string };

/** Build one seat's completion function (the per-engine gates run here). */
function buildSeat(deps: LeaderSeatDeps, chosen: LeaderSeatCandidate, opts: { mode: LeaderRunMode; promptChars: number; deep: boolean }): BuiltSeat {
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
    if (!deps.transports.native && (!chosen.launcher || chosen.launcher.length === 0)) return { ok: false, reason: `Seat ${chosen.seat.id} has no launcher.` };
    const admitted=():boolean => {
      const policy=deps.standingPolicy();
      const seat=policy?.spend.seats[chosen.seat.id];
      if(!seat?.enabled || !seat.roles.includes('leader'))return false;
      const snapshot=deps.capacitySnapshot();
      const capacity=snapshot?.seats.find(row=>row.seatId === chosen.seat.id) ?? (engine === 'devin' ? unknownCapacity(chosen.seat) : null);
      if(!capacity)return false;
      if(engine === 'codex' && !subscriptionOnlyCurrent(capacity,deps.now()))return false;
      if(engine === 'devin' && !peekDevinCliExecutionBinding(model))return false;
      let budgetPolicy=deps.budgetPolicy();
      if(policy)budgetPolicy=deps.clampBudget(budgetPolicy,policy);
      return deps.route({task:'leader',difficulty:'high',autonomous:true,contextTokens:Math.ceil(opts.promptChars/4)+4096},
        [{...capacity,contextWindow:chosen.seat.contextWindow,tier:seatTier(engine,model),
          ...(engine === 'devin' && peekDevinCliExecutionBinding(model) ? {free:true,costBasis:'free' as const} : {})}],budgetPolicy,deps.now()).seatId === chosen.seat.id;
    };
    complete = deps.transports.native
      ? deps.transports.native(chosen.seat.id,engine,model,admitted,budget)
      : engine === 'grok'
      ? deps.transports.grok(chosen.launcher!, model, budget)
      // claudeCredential is non-null here: without it 'claude' never entered `engines`.
      : deps.transports.claude(chosen.launcher!, model, deps.claudeCredential!, budget);
  }
  return { ok: true, choice: { seatId: chosen.seat.id, engine, model, deep: opts.deep }, complete, budget };
}

/**
 * Pick the Leader's seat and build its completion function. Never throws;
 * every refusal is a specific sentence. This is the router's single pick —
 * a run walks the fallback chain from `planLeaderSeats` instead.
 */
export async function resolveLeaderSeat(
  deps: LeaderSeatDeps,
  opts: { deep: boolean; promptChars: number; mode?: LeaderRunMode; purpose?: LeaderSeatPurpose },
): Promise<LeaderSeatResolution> {
  const mode = opts.mode ?? 'full';
  const routed = await routeLeader(deps, { ...opts, mode });
  if (!routed.ok) return { ok: false, reason: routed.reason, decision: routed.decision };
  const { eligible, decision } = routed.routing;
  const chosen = eligible.find((c) => c.seat.id === decision.seatId);
  if (!chosen) return { ok: false, reason: `Seat ${decision.seatId} has no runnable model.`, decision };
  const built = buildSeat(deps, chosen, { mode, promptChars: opts.promptChars, deep: opts.deep });
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

/** Walk the shared router's ranked real accounts. No provider-specific
 * reorder is applied after routing; each step retains its exact chosen model. */
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
  const ordered=pick ? [pick,...approved.filter(c=>c !== pick)] : approved;

  const skippedList: LeaderSeatAttempt[] = [...ruledOut, ...exclusionAttempts(decision, byId)];
  const steps: LeaderSeatPlanStep[] = [];
  for (const c of ordered) {
    const built = buildSeat(deps, c, { mode: opts.mode, promptChars: opts.promptChars, deep: opts.deep });
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
 * Read complete Ollama `/api/chat` NDJSON records, concatenating
 * `message.content`. EOF succeeds only after an explicit `done: true`.
 */
async function readOllamaChatStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let completed = false;
  const take = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: unknown;
    try {
      record = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error('ollama: malformed response stream');
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('ollama: malformed response stream');
    }
    const parsed = record as { message?: { content?: unknown }; error?: unknown; done?: unknown };
    if (typeof parsed.error === 'string') throw new Error(`ollama: ${parsed.error.slice(0, 200)}`);
    if (completed || (parsed.done !== undefined && typeof parsed.done !== 'boolean')) {
      throw new Error('ollama: malformed response stream');
    }
    if (typeof parsed.message?.content === 'string' && text.length < MAX_OUTPUT_BYTES) text += parsed.message.content;
    if (parsed.done === true) completed = true;
  };
  try {
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
    if (!completed) throw new Error('ollama: incomplete response stream');
    return text;
  } catch (error) {
    // Cancellation can reject or never settle; it must not delay or replace
    // the transport failure under the caller's existing attempt deadline.
    try { void reader.cancel().catch(() => {}); } catch { /* preserve the failure */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* cleanup must not replace the result */ }
  }
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
    native: (seatId,engine,model,admitted,opts) => async(system,user) => {
      const {nativeRoleCompletion}=await import('../run/role-completion.js');
      const {readCapacitySnapshot}=await import('../routing/budget-store.js');
      const accountHint=readCapacitySnapshot()?.seats.find(row=>row.seatId === seatId)?.accountHint ?? undefined;
      const sameAccount=()=>admitted() && (engine === 'devin' || accountHint !== undefined &&
        readCapacitySnapshot()?.seats.find(row=>row.seatId === seatId)?.accountHint === accountHint);
      return nativeRoleCompletion({cfg,role:'leader',seatId,engine,model,accountHint,admitted:sameAccount,timeoutMs:opts.timeoutMs ?? LEADER_CLI_TIMEOUT_MS},
        (metrics:RoleCompletionMetrics)=>{
          void import('../fleet/agent-action-ledger.js').then(({recordAgentAction})=>recordAgentAction({schemaVersion:1,ts:new Date().toISOString(),
            actor:'agent',kind:'reflection',outcome:metrics.outcome === 'completed' ? 'ok' : metrics.outcome,action:'role:completion',
            summary:`${metrics.role} completion ${metrics.outcome}.`,runId:metrics.runId,model:metrics.model,
            backend:metrics.engine === 'grok' ? 'grok-cli' : metrics.engine === 'devin' ? 'devin-cli' : metrics.engine,
            durationMs:metrics.elapsedMs,tags:[`role:${metrics.role}`,`seat:${metrics.seatId}`],
            counts:{providerContacted:metrics.providerContacted ? 1 : 0,
              ...(metrics.tokensIn !== null ? {tokensIn:metrics.tokensIn} : {}),...(metrics.tokensOut !== null ? {tokensOut:metrics.tokensOut} : {})}})).catch(()=>{});
        })(system,user);
    },
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
  const [seats, budgetStore, router, headroom, effective] = await Promise.all([
    import('../verse/seats.js'),
    import('../routing/budget-store.js'),
    import('../routing/router.js'),
    import('../routing/headroom.js'),
    import('../authority/effective-config.js'),
  ]);
  return {
    cfg,
    now: () => Date.now(),
    candidates: async () => {
      const discovery = await seats.discoverSeats(cfg, {
        // The Leader needs identity and launchers, not the Claude token scan.
        claudeUsage: () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: Date.now(), filesScanned: 0 }),
      });
      const standing=effective.currentStandingPolicy();
      const devinSeat=discovery.seats.find(seat=>seat.id === 'devin-cli' && seat.engine === 'devin');
      if(devinSeat && cfg.devin?.enabled === true && cfg.devin?.fleet === true && standing?.engines.includes('devin') && standing.spend.seats[devinSeat.id]?.roles.includes('leader')){
        for(const model of devinSeat.models.filter(model=>!model.unavailableReason)){
          await refreshDevinCliExecutionBinding(model.id,{admitted:()=>effective.currentStandingPolicy()?.spend.seats[devinSeat.id]?.roles.includes('leader') === true});
        }
      }
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
    claudeCredential: null,
  };
}
