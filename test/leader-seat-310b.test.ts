/** Provider-neutral Leader routing: actual role/allowance/context gates remain,
 * while model quality and router rank replace brand and cadence bans. */
import { describe, expect, it, vi } from 'vitest';

import {
  claudeLeaderCommand,
  resolveLeaderSeat,
  resolveLocalLeaderModel,
  type LeaderSeatCandidate,
  type LeaderSeatDeps,
} from '../src/core/vision/leader-seat.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../src/core/run/model-catalog.js';
import { CLAUDE_RESTRICTED_ARGS, isRestrictedClaudeCommand } from '../src/core/run/engine-registry.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();

function seat(id: string, engine: VerseSeat['engine'], model: string): VerseSeat {
  return {
    id, engine, label: id, accountId: engine === 'local' ? 'local' : id,
    models: [{ id: model, label: model, contextWindow: 200_000 }],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

const LOCAL: LeaderSeatCandidate = { seat: seat('local:qwen3.8:27b-ctx64k', 'local', 'qwen3.8:27b-ctx64k'), launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
const GROK: LeaderSeatCandidate = { seat: seat('grok', 'grok', 'grok-4.6'), launcher: ['node', '/profiles/grok/launcher.js'], ollamaBaseUrl: null };
const CLAUDE: LeaderSeatCandidate = { seat: seat('claude', 'claude', 'claude-opus-5-5'), launcher: ['node', '/profiles/claude/launcher.js'], ollamaBaseUrl: null };
const CODEX: LeaderSeatCandidate = { seat: seat('codex-personal', 'codex', 'gpt-5.5'), launcher: ['node', '/profiles/codex/launcher.js'], ollamaBaseUrl: null };

function paidCapacity(id: string, engine: SeatCapacity['engine'], windows: SeatCapacity['windows']): SeatCapacity {
  return { seatId: id, engine, label: id, free: false, windows, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null };
}

const GROK_OK = paidCapacity('grok', 'grok', [{ id: 'weekly', usedPercent: 20, resetsAt: '2026-09-28T00:00:00.000Z', resetDescription: null, limitReached: false }]);
const claudeAt = (fiveHour: number, week: number): SeatCapacity => paidCapacity('claude', 'claude', [
  { id: 'five_hour', usedPercent: fiveHour, resetsAt: null, resetDescription: null, limitReached: false },
  { id: 'seven_day', usedPercent: week, resetsAt: null, resetDescription: null, limitReached: false },
]);

function deps(opts: {
  candidates: LeaderSeatCandidate[];
  standing?: ReturnType<typeof makePolicy> | null;
  snapshot?: SeatCapacity[] | null;
  cfg?: AshlrConfig;
  clampThrows?: boolean;
  calls?: string[];
  /** false = the judges' credential hook is not available in this build. */
  claudeHook?: boolean;
  native?: boolean;
  llama?: boolean;
}): LeaderSeatDeps {
  const calls = opts.calls ?? [];
  return {
    cfg: opts.cfg ?? ({} as AshlrConfig),
    now: () => NOW,
    candidates: async () => opts.candidates,
    capacitySnapshot: () => (opts.snapshot === null ? null : { publishedAt: OBSERVED, seats: opts.snapshot ?? [] }),
    budgetPolicy: (): BudgetPolicy => defaultBudgetPolicy(),
    standingPolicy: () => (opts.standing === undefined ? makePolicy() : opts.standing),
    clampBudget: (policy) => {
      if (opts.clampThrows) throw new Error('not implemented');
      return policy;
    },
    route: (req, capacity, policy, nowMs) => routeSeat(req, capacity, policy, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      ...(opts.llama ? { llama: (binding: import('../src/core/vision/local-leader-transport.js').LocalLeaderBinding) => async () => { calls.push(`llama ${binding.baseUrl} ${binding.servingModel}`); return '{}'; } } : {}),
      ...(opts.native ? {native:(seatId:string,engine:string,model:string)=>async()=>{calls.push(`${engine} ${seatId} ${model}`);return '{}';}} : {}),
      local: (base, model) => async () => { calls.push(`local ${base} ${model}`); return '{}'; },
      grok: (launcher, model) => async () => { calls.push(`grok ${launcher.join(' ')} ${model}`); return '{}'; },
      claude: (launcher, model) => async () => { calls.push(`claude ${launcher.join(' ')} ${model}`); return '{}'; },
    },
    claudeCredential: opts.claudeHook === false ? null : async () => undefined,
  };
}

describe('resolveLeaderSeat', () => {
  it('without a standing grant only free local seats are candidates', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, CLAUDE, LOCAL], standing: null, snapshot: [GROK_OK, claudeAt(5, 5)] }), { deep: true, promptChars: 20_000 });
    expect(r.ok && r.choice).toMatchObject({ seatId: LOCAL.seat.id, engine: 'local', model: 'qwen3.8:27b-ctx64k', deep: true });
  });

  it('no local seat and no grant ⇒ no-seat (fails closed, no cloud fallback)', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, CLAUDE], standing: null, snapshot: [GROK_OK, claudeAt(5, 5)] }), { deep: true, promptChars: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/without a standing grant/);
  });

  it('keeps the shared router rank instead of preferring Grok over an elite local model', async () => {
    const calls: string[] = [];
    const r = await resolveLeaderSeat(deps({ candidates: [LOCAL, GROK], snapshot: [GROK_OK], calls }), { deep: false, promptChars: 20_000 });
    expect(r.ok && r.choice.seatId).toBe(LOCAL.seat.id);
    if (r.ok) await r.complete('s', 'u');
    expect(calls).toEqual(['local http://127.0.0.1:11434 qwen3.8:27b-ctx64k']);
    // Grok with no fresh reading is ineligible (unknown usage is not headroom) → local.
    const stale = await resolveLeaderSeat(deps({ candidates: [LOCAL, GROK], snapshot: [] }), { deep: false, promptChars: 20_000 });
    expect(stale.ok && stale.choice.seatId).toBe(LOCAL.seat.id);
  });

  it('uses the explicitly bound llama transport instead of the legacy Ollama endpoint', async () => {
    const calls: string[] = [];
    const candidate: LeaderSeatCandidate = { ...LOCAL, localDispatch: { kind: 'llama-server', binding: {
      model: LOCAL.seat.models[0]!.id, servingModel: '/inert/weights', contextWindow: LOCAL.seat.contextWindow!,
      baseUrl: 'http://127.0.0.1:8080/v1', blobPath: '/inert/weights', manifestPath: '/inert/manifest', epoch: 'fixture',
    } } };
    const source = deps({ candidates: [candidate], standing: null, llama: true, calls });
    const original = source.transports.llama!;
    const selected = vi.fn(original); source.transports.llama = selected;
    const result = await resolveLeaderSeat(source, { deep: false, promptChars: 100 });
    expect(selected.mock.calls[0]?.[2]).toEqual({seatId:candidate.seat.id});
    expect(result.ok).toBe(true); if (result.ok) await result.complete('s', 'u');
    expect(calls).toEqual(['llama http://127.0.0.1:8080/v1 /inert/weights']);
    for (const binding of [null, { ...candidate.localDispatch!.binding!, contextWindow: 1 }]) {
      const held = await resolveLeaderSeat(deps({ candidates: [{ ...candidate, localDispatch: { kind: 'llama-server', binding } }], standing: null, llama: true, calls }), { deep: false, promptChars: 100 });
      expect(held.ok).toBe(false); if (!held.ok) expect(held.reason).toMatch(/binding/);
    }
    expect(calls).toHaveLength(1);
  });

  it('permits granted Claude for ordinary memos, check-ins and replies while retaining reserves', async () => {
    for(const mode of ['full','checkin'] as const){
      const r=await resolveLeaderSeat(deps({candidates:[CLAUDE,GROK],snapshot:[claudeAt(10,10),GROK_OK]}),{deep:false,mode,purpose:'reply',promptChars:1000});
      expect(r.ok && r.choice.seatId).toBe('grok');
      const alone=await resolveLeaderSeat(deps({candidates:[CLAUDE],snapshot:[claudeAt(10,10)]}),{deep:false,mode,purpose:'reply',promptChars:1000});
      expect(alone.ok && alone.choice.seatId).toBe('claude');
    }
    for(const capacity of [claudeAt(75,10),claudeAt(10,65)]){
      const r=await resolveLeaderSeat(deps({candidates:[CLAUDE,GROK],snapshot:[capacity,GROK_OK]}),{deep:false,promptChars:1000});
      expect(r.ok && r.choice.seatId).toBe('grok');
    }
  });

  it('without the judges\' credential hook Claude is not a candidate, even for the deep run', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(10, 10), GROK_OK], claudeHook: false }), { deep: true, promptChars: 20_000 });
    expect(r.ok && r.choice.seatId).toBe(LOCAL.seat.id);
    const alone = await resolveLeaderSeat(deps({ candidates: [CLAUDE], snapshot: [claudeAt(10, 10)], claudeHook: false }), { deep: true, promptChars: 20_000 });
    expect(alone.ok).toBe(false);
  });

  it('permits Codex with an account-bound adapter and current subscription-only boundary', async () => {
    const base=makePolicy();
    const policy=makePolicy({engines:[...base.engines,'codex'],spend:{...base.spend,seats:{...base.spend.seats,
      'codex-personal':{seatId:'codex-personal',enabled:true,reserveFloorPercent:0,maxSessionWindowPercent:null,roles:['leader']}}}});
    const capacity={...paidCapacity('codex-personal','codex',[{id:'weekly',usedPercent:10,resetsAt:null,resetDescription:null,limitReached:false}]),
      accountHint:'c'.repeat(64),subscriptionOnlyBoundary:{source:'codex-siwc-app-credit-control' as const,accountHint:'c'.repeat(64),observedAt:OBSERVED,
        expiresAt:new Date(NOW+30_000).toISOString(),creditsEnabled:false as const}};
    const calls:string[]=[];
    const r=await resolveLeaderSeat(deps({candidates:[CODEX],standing:policy,snapshot:[capacity],native:true,calls}),{deep:false,purpose:'reply',promptChars:1000});
    expect(r.ok && r.choice).toMatchObject({seatId:'codex-personal',engine:'codex',model:'gpt-5.5'});
    if(r.ok)await r.complete('s','u');
    expect(calls).toEqual(['codex codex-personal gpt-5.5']);
    const held=await resolveLeaderSeat(deps({candidates:[CODEX],standing:policy,snapshot:[{...capacity,subscriptionOnlyBoundary:null}],native:true}),{deep:false,promptChars:1000});
    expect(held.ok).toBe(false);
  });

  it('never substitutes a producer grant for an absent Leader role', async () => {
    const base=makePolicy();
    const noLeaderRole=makePolicy({spend:{...base.spend,seats:{...base.spend.seats,grok:{...base.spend.seats['grok']!,roles:['producer']}}}});
    const r=await resolveLeaderSeat(deps({candidates:[GROK,LOCAL],standing:noLeaderRole,snapshot:[GROK_OK]}),{deep:false,promptChars:1000});
    expect(r.ok && r.choice.seatId).toBe(LOCAL.seat.id);
  });

  it('selects a fitting model variant without creating another allowance seat', async () => {
    const multi={...CLAUDE,seat:{...CLAUDE.seat,models:[{id:'small',label:'small',contextWindow:8000},
      {id:'claude-opus-5-5',label:'fit',contextWindow:200000}]}};
    const r=await resolveLeaderSeat(deps({candidates:[multi],snapshot:[claudeAt(10,10)]}),{deep:false,promptChars:60000});
    expect(r.ok && r.choice).toMatchObject({seatId:'claude',model:'claude-opus-5-5'});
    const allUnavailable={...multi,seat:{...multi.seat,models:multi.seat.models.map(model=>({...model,unavailableReason:'unsupported pinned binary'}))}};
    expect((await resolveLeaderSeat(deps({candidates:[allUnavailable],snapshot:[claudeAt(10,10)]}),{deep:false,promptChars:1000})).ok).toBe(false);
  });

  it('preserves the configured runnable model order when family labels lack quality evidence', async () => {
    const candidate={...LOCAL,seat:{...LOCAL.seat,models:[{id:'other-local',label:'configured first',contextWindow:200000},
      {id:'qwen3.8:27b-ctx64k',label:'legacy elite family',contextWindow:200000}]}};
    const calls:string[]=[];
    const result=await resolveLeaderSeat(deps({candidates:[candidate],standing:null,calls}),{deep:true,promptChars:1000});
    expect(result.ok && result.choice.model).toBe('other-local');
    if(result.ok)await result.complete('s','u');
    expect(calls).toEqual(['local http://127.0.0.1:11434 other-local']);
    expect(result.decision?.candidates).toEqual([candidate.seat.id]);
  });

  it('when the budget cannot be clamped to the grant, paid seats are dropped', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, LOCAL], snapshot: [GROK_OK], clampThrows: true }), { deep: false, promptChars: 1_000 });
    expect(r.ok && r.choice.seatId).toBe(LOCAL.seat.id);
    const none = await resolveLeaderSeat(deps({ candidates: [GROK], snapshot: [GROK_OK], clampThrows: true }), { deep: false, promptChars: 1_000 });
    expect(none.ok).toBe(false);
  });

  it('local-only mode refuses a paid engine even when routed to it', async () => {
    const cfg = { foundry: { localOnly: true } } as unknown as AshlrConfig;
    const r = await resolveLeaderSeat(deps({ candidates: [GROK], snapshot: [GROK_OK], cfg }), { deep: false, promptChars: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Local-only mode refuses grok/);
  });

  it('a prompt that does not fit the seat window is not sent there', async () => {
    const small = { ...LOCAL, seat: { ...LOCAL.seat, contextWindow: 8_192, models: [{ id: 'tiny', label: 'tiny', contextWindow: 8_192 }] } };
    const r = await resolveLeaderSeat(deps({ candidates: [small], standing: null }), { deep: false, promptChars: 60_000 });
    expect(r.ok).toBe(false);
  });
});

describe('Claude Leader command (inference only)', () => {
  it('is the judges\' restricted command: no tools, no MCP, no settings, prompt on stdin', () => {
    const cmd = claudeLeaderCommand(['node', 'l.js'], 'claude-opus-5-5', 'SYS');
    expect(cmd).toEqual({
      bin: 'node',
      args: ['l.js', '-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--safe-mode', '--system-prompt', 'SYS', ...CLAUDE_RESTRICTED_ARGS],
    });
    // The ONE check that lets the claude-a credential reach a spawn.
    expect(isRestrictedClaudeCommand(cmd!)).toBe(true);
  });

  it('refuses a launcher that would re-open tools', () => {
    expect(claudeLeaderCommand(['node', 'l.js', '--dangerously-skip-permissions'], 'm', 'SYS')).toBeNull();
    expect(claudeLeaderCommand([], 'm', 'SYS')).toBeNull();
  });
});

describe('the Strategist fallback model', () => {
  it('is an Ollama tag, never managerJudgeModel (the gpt-5.5 bug)', () => {
    const cfg = { foundry: { managerJudgeEngine: 'codex', managerJudgeModel: 'gpt-5.5' } } as unknown as AshlrConfig;
    expect(resolveLocalLeaderModel(cfg)).toBe(DEFAULT_LOCAL_MODEL_TAG);
    expect(resolveLocalLeaderModel({ foundry: { leader: { localModel: 'qwen3.8:27b-q8_0' } } } as unknown as AshlrConfig)).toBe('qwen3.8:27b-q8_0');
    expect(resolveLocalLeaderModel({ foundry: { leader: { localModel: '$(rm -rf)' } } } as unknown as AshlrConfig)).toBe(DEFAULT_LOCAL_MODEL_TAG);
  });
});
