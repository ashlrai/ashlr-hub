/**
 * 3.15 — elite self-land (Mason, 2026-09-27): elite models land directly on
 * deterministic verification, with no LLM judge, while the signed
 * `elite-direct` stage is current. Pure: no git, no GitHub, no models, no
 * real ~/.ashlr (HOME is isolated by test/setup).
 *
 * Covers the allowlist (exact ids, engine binding, fail-closed cases, config
 * narrowing), G6's elite branch (incl. Devin: no two-judge rule on SWE-2),
 * the merge-time Devin lock, GPT-6 as a frontier judge, the elite-direct
 * grant drafts, and the decisions view's "Landed directly" line.
 */
import { describe, expect, it } from 'vitest';

import {
  ELITE_DIRECT_G6_CODE,
  ELITE_DIRECT_ONE_LINE,
  ELITE_DIRECT_STAGE_ID,
  ELITE_MODELS,
  eliteDirectInForce,
  eliteModelAllowFromConfig,
  grantHasEliteDirect,
  matchEliteModel,
} from '../src/core/authority/elite-models.js';
import {
  buildDefaultGrantPayload,
  buildReapprovalGrantPayload,
  describeGrantScope,
  parseStandingGrantPayload,
} from '../src/core/authority/standing-grant.js';
import { evaluateG6 } from '../src/core/fleet/merge-gates.js';
import {
  isFrontierJudgeId,
  producerMergeWithheld,
  producerModelFamily,
} from '../src/core/fleet/reviewer-independence.js';
import {
  LADDER_ELITE_G6_CODE,
  LADDER_ELITE_STAGE_ID,
  shadowDecisionsFromLedger,
} from '../src/core/verse/autonomy-ladder.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import { TEST_HOST, TEST_KEY_ID, TEST_SURFACE } from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

describe('the elite allowlist — one source of truth, fail closed', () => {
  it.each([
    ['claude:claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-cli:claude-opus-5-5', 'claude-opus-5-5'],
    ['claude:claude-opus-5', 'claude-opus-5'],
    ['claude:claude-opus-5.5', 'claude-opus-5'], // the retired dotted alias ran Opus 5
    ['claude:claude-fable-5-1', 'claude-fable-5-1'],
    ['claude:claude-fable-5', 'claude-fable-5'],
    ['claude:fable-5', 'claude-fable-5'],
    ['claude:claude-sonnet-5', 'claude-sonnet-5'],
    ['claude:sonnet-5', 'claude-sonnet-5'],
    ['claude:claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['codex:gpt-6-astra', 'gpt-6-astra'],
    ['codex:gpt-6-sol', 'gpt-6-sol'],
    ['codex:gpt-6-luna', 'gpt-6-luna'],
    ['devin-cli:gpt-6-sol-high', 'gpt-6-sol'],
    ['devin-cli:gpt-6-astra-max', 'gpt-6-astra'],
    ['grok-cli:grok-4.7', 'grok-4.7'],
    ['grok-cli:grok-4.7-build-fast', 'grok-4.7'],
    ['grok-cli:grok-4.6', 'grok-4.6'],
    ['devin-cli:swe-2', 'swe-2'],
    ['devin-cli:swe-2-high', 'swe-2'],
    ['devin-cli:swe-2-medium', 'swe-2'],
    ['devin-cli:swe-2-max', 'swe-2'],
    ['devin-cli:swe', 'swe-2'],
    ['local-coder:qwen3.8:27b-ctx64k', 'qwen3.8-27b'],
    ['ollama:qwen3.8:27b', 'qwen3.8-27b'],
    ['CODEX:GPT-6-SOL', 'gpt-6-sol'],
  ])('%s is elite (%s)', (engineModel, id) => {
    expect(matchEliteModel(engineModel)?.entry.id).toBe(id);
  });

  it.each([
    'claude-opus-5-5', // bare: no execution identity
    'gpt-6-sol',
    'claude:opus', // alias → Claude Opus 4.8 in the fleet catalog
    'claude:sonnet', // alias → Sonnet 4.6
    'claude:claude-opus-4-8',
    'claude:claude-sonnet-4-6',
    'claude:cloud', // the Claude cloud intake names no model
    'codex:gpt-5.5',
    'codex:gpt-6-sol-mini', // not a listed variant
    'codex:gpt-6', // not a listed id
    'grok:grok-4.7', // the per-token API engine is never elite
    'xai:grok-4.7',
    'grok-cli:grok-4.5',
    'devin:normal', // the cloud intake records a MODE, not a model
    'devin:swe-2', // even a claimed model on cloud intake is not host-verified
    'devin:gpt-6-astra-max',
    'devin-cli:opus', // version-less
    'llama-server:qwen3.8:27b-ctx64k', // serves whatever it loaded
    'local-coder:claude-opus-5-5', // a local runtime serving a vendor-named model
    'local-coder:qwen3-coder-next',
    'codex:grok-4.7', // engine and model disagree
    'mystery:gpt-6-sol',
    '',
    ':gpt-6-sol',
  ])('%s is NOT elite', (engineModel) => {
    expect(matchEliteModel(engineModel)).toBeNull();
  });

  it('non-strings are never elite', () => {
    for (const value of [null, undefined, 42, {}, ['codex:gpt-6-sol']]) expect(matchEliteModel(value)).toBeNull();
  });

  it('config can only NARROW the list', () => {
    expect(eliteModelAllowFromConfig({})).toBeNull();
    expect(eliteModelAllowFromConfig({ foundry: { autoMerge: {} } })).toBeNull();
    expect(eliteModelAllowFromConfig({ foundry: { autoMerge: { eliteModels: false } } })).toEqual([]);
    // A malformed explicit narrowing must fail closed, not restore every model.
    for (const malformed of ['yes', null, true, 0]) {
      expect(eliteModelAllowFromConfig({ foundry: { autoMerge: { eliteModels: malformed } } })).toEqual([]);
    }
    // Unknown ids are dropped — config never adds a model.
    const allow = eliteModelAllowFromConfig({ foundry: { autoMerge: { eliteModels: ['gpt-6-sol', 'gpt-7-omega', 3] } } });
    expect(allow).toEqual(['gpt-6-sol']);
    expect(matchEliteModel('codex:gpt-6-sol', allow)?.entry.id).toBe('gpt-6-sol');
    expect(matchEliteModel('grok-cli:grok-4.7', allow)).toBeNull();
    expect(matchEliteModel('codex:gpt-6-sol', [])).toBeNull();
  });

  it('every entry is well formed and ids are unique across entries', () => {
    const seen = new Set<string>();
    for (const entry of ELITE_MODELS) {
      expect(entry.engines.length).toBeGreaterThan(0);
      expect(entry.engines).not.toContain('llama-server');
      expect(entry.engines).not.toContain('grok');
      for (const id of entry.ids) {
        expect(id).toBe(id.toLowerCase());
        for (const engine of entry.engines) {
          const key = `${engine}:${id}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('elite-direct is in force only while it is the CURRENT stage', () => {
    expect(eliteDirectInForce({ rollout: { stageId: ELITE_DIRECT_STAGE_ID } })).toBe(true);
    expect(eliteDirectInForce({ rollout: { stageId: 'shadow' } })).toBe(false);
    expect(eliteDirectInForce(null)).toBe(false);
    expect(eliteDirectInForce(undefined)).toBe(false);
  });

  it('the decisions view pins the same reserved ids', () => {
    expect(LADDER_ELITE_G6_CODE).toBe(ELITE_DIRECT_G6_CODE);
    expect(LADDER_ELITE_STAGE_ID).toBe(ELITE_DIRECT_STAGE_ID);
  });
});

describe('G6 under elite-direct: tests, not judges', () => {
  const base = { proposalId: 'p-elite-1', diff: 'diff --git a/x b/x\n', nowMs: NOW };
  const elite = { allow: null };

  it('an elite producer passes G6 with no judge, no seat and no verdict on file', () => {
    const g6 = evaluateG6({ ...base, producerModel: 'codex:gpt-6-sol', decisions: [], eliteDirect: elite });
    expect(g6).toMatchObject({ verdict: 'pass', code: ELITE_DIRECT_G6_CODE, judgeId: null, needsJudge: false, judgeIds: [] });
    expect(g6.reason).toMatch(/^elite model GPT-6 Sol \(codex:gpt-6-sol\)/);
    expect(g6.inputs).toMatchObject({ rule: ELITE_DIRECT_G6_CODE, eliteModel: 'gpt-6-sol' });
  });

  it('a degraded decisions ledger does not block an elite pass (no verdict is read)', () => {
    expect(evaluateG6({ ...base, producerModel: 'grok-cli:grok-4.7', decisions: null, eliteDirect: elite }).verdict).toBe('pass');
  });

  it('Devin on SWE-2 needs neither judge — the two-judge rule is for non-elite Devin work', () => {
    const g6 = evaluateG6({ ...base, producerModel: 'devin-cli:swe-2-high', decisions: [], eliteDirect: elite });
    expect(g6).toMatchObject({ verdict: 'pass', code: ELITE_DIRECT_G6_CODE });
    // Without elite-direct the same work waits for two judges of two families.
    const judged = evaluateG6({ ...base, producerModel: 'devin-cli:swe-2-high', decisions: [] });
    expect(judged).toMatchObject({ verdict: 'wait', code: 'awaiting-judge', needsJudge: true });
    expect(judged.reason).toMatch(/two different families/);
  });

  it('non-elite producers keep today\'s judge path, even under elite-direct', () => {
    for (const producerModel of ['codex:gpt-5.5', 'claude:cloud', 'llama-server:qwen3.8:27b-ctx64k', 'devin:normal']) {
      const g6 = evaluateG6({ ...base, producerModel, decisions: [], eliteDirect: elite });
      expect(g6.code).not.toBe(ELITE_DIRECT_G6_CODE);
      expect(g6.verdict).not.toBe('pass');
    }
  });

  it('without the elite-direct stage an elite model is judged like everyone else', () => {
    const g6 = evaluateG6({ ...base, producerModel: 'codex:gpt-6-sol', decisions: [] });
    expect(g6).toMatchObject({ verdict: 'wait', code: 'awaiting-judge' });
    expect(evaluateG6({ ...base, producerModel: 'codex:gpt-6-sol', decisions: [], eliteDirect: null }).code).toBe('awaiting-judge');
  });

  it('a config narrowing that drops the model sends it back to the judge', () => {
    const g6 = evaluateG6({ ...base, producerModel: 'codex:gpt-6-sol', decisions: [], eliteDirect: { allow: ['grok-4.7'] } });
    expect(g6.code).toBe('awaiting-judge');
  });
});

describe('Devin and judges around elite self-land', () => {
  it('Devin hosts other vendors\' models: the family stays devin (never unknown)', () => {
    expect(producerModelFamily('devin-cli:gpt-6-sol')).toBe('devin');
    expect(producerModelFamily('devin:swe-2-max')).toBe('devin');
    expect(producerModelFamily('devin-cli:claude-opus-5-5')).toBe('devin');
  });

  it('the merge-time Devin lock: signed in AND (two judges OR a live elite basis)', () => {
    expect(producerMergeWithheld('devin', { devinGranted: false, eliteDirect: true })).toBe('shadow');
    expect(producerMergeWithheld('devin', { devinGranted: true, eliteDirect: true })).toBeNull();
    expect(producerMergeWithheld('devin', { devinGranted: true, eliteDirect: false, producerModel: 'devin-cli:swe-2', judgeIds: [] })).toBe('shadow');
    expect(producerMergeWithheld('openai', { eliteDirect: false })).toBeNull();
  });

  it('GPT-6 is a frontier judge (Codex\'s current models were refused only because the rule predated them)', () => {
    expect(isFrontierJudgeId('codex:gpt-6-sol')).toBe(true);
    expect(isFrontierJudgeId('gpt-6-astra')).toBe(true);
    expect(isFrontierJudgeId('local-coder:gpt-6-sol')).toBe(false);
  });
});

describe('the elite-direct grant — what Mason signs', () => {
  const draftInput = {
    nowMs: NOW,
    grantId: 'e'.repeat(32),
    grantSeq: 9,
    keyId: TEST_KEY_ID,
    hostBinding: TEST_HOST,
    authoritySurfaceDigest: TEST_SURFACE,
    repos: [
      { nameWithOwner: 'ashlrai/ashlrcode', visibility: null, hasVerify: true, serverEnforcement: 'enforced' as const },
      { nameWithOwner: 'ashlrai/ashlr-pulse', visibility: null, hasVerify: false, serverEnforcement: 'enforced' as const },
      { nameWithOwner: 'ashlrai/fleet-canary', visibility: 'public' as const, hasVerify: true, serverEnforcement: 'enforced' as const },
    ],
    seats: [
      { seatId: 'claude', engine: 'claude' as const },
      { seatId: 'grok', engine: 'grok' as const },
      { seatId: 'codex', engine: 'codex' as const },
    ],
  };

  it('a new elite-direct grant is ONE valid rung: every repo at its signed stage, every engine, no Leader widening', () => {
    const payload = buildDefaultGrantPayload({ ...draftInput, eliteDirect: true });
    expect(parseStandingGrantPayload(payload).ok).toBe(true);
    expect(payload.rollout.stages).toHaveLength(1);
    const [stage] = payload.rollout.stages;
    expect(stage!.id).toBe(ELITE_DIRECT_STAGE_ID);
    expect(stage!.repos).toEqual(payload.repos.map((r) => ({ nameWithOwner: r.nameWithOwner, stage: r.stage })));
    expect(stage!.repos.find((r) => r.nameWithOwner === 'ashlrai/ashlrcode')?.stage).toBe('merge');
    // No verify command ⇒ still propose-only: elite work still needs tests to exist.
    expect(stage!.repos.find((r) => r.nameWithOwner === 'ashlrai/ashlr-pulse')?.stage).toBe('propose');
    expect(stage!.engines).toContain('codex');
    expect(stage!.leaderClasses).toEqual([]);
    expect(grantHasEliteDirect(payload)).toBe(true);
    const lines = describeGrantScope(payload);
    expect(lines).toContain(ELITE_DIRECT_ONE_LINE);
    expect(lines.some((line) => line.includes('elite-direct') && line.includes('no judge'))).toBe(true);
  });

  it('without the opt-in the default ladder is unchanged (starts in shadow)', () => {
    const payload = buildDefaultGrantPayload(draftInput);
    expect(payload.rollout.stages[0]!.id).toBe('shadow');
    expect(grantHasEliteDirect(payload)).toBe(false);
    expect(describeGrantScope(payload)).not.toContain(ELITE_DIRECT_ONE_LINE);
  });

  it('re-approving into elite-direct keeps the Leader classes of the rung it had reached', () => {
    const current = buildDefaultGrantPayload(draftInput);
    const reachedIndex = current.rollout.stages.findIndex((s) => s.id === '2c');
    const next = buildReapprovalGrantPayload(current, reachedIndex, { ...draftInput, nowMs: NOW + 1000, grantId: 'd'.repeat(32), grantSeq: 10, eliteDirect: true });
    expect(parseStandingGrantPayload(next).ok).toBe(true);
    expect(next.rollout.stages.map((s) => s.id)).toEqual([ELITE_DIRECT_STAGE_ID]);
    expect(next.rollout.stages[0]!.leaderClasses).toEqual(current.rollout.stages[reachedIndex]!.leaderClasses);
    expect(next.repos).toEqual(current.repos);
    // …and a plain re-approval of an elite-direct grant continues it.
    const again = buildReapprovalGrantPayload(next, 0, { ...draftInput, nowMs: NOW + 2000, grantId: 'c'.repeat(32), grantSeq: 11 });
    expect(again.rollout.stages.map((s) => s.id)).toEqual([ELITE_DIRECT_STAGE_ID]);
  });
});

describe('the decisions view says so', () => {
  let seq = 0;
  const row = (kind: string, data: Record<string, unknown>, at: string): LedgerEntry =>
    ({ v: 1, seq: seq++, at, actor: 'daemon', grantId: 'g'.repeat(32), repo: 'ashlrai/ashlrcode', prevHash: '0', hash: String(seq), kind, data }) as unknown as LedgerEntry;
  const gate = (gate: string, code: string, reason: string, at: string): LedgerEntry =>
    row('gate:result', { v: 1, gate, proposalId: 'p1', repo: 'ashlrai/ashlrcode', headSha: null, verdict: 'pass', code, reason, at, digest: 'x' }, at);

  it('"Landed directly · elite model <name> · tests green" on an elite landing', () => {
    const at = '2026-09-27T10:00:00.000Z';
    const view = shadowDecisionsFromLedger({
      entries: [
        row('grant:accepted', { grantId: 'g'.repeat(32), stageIds: [ELITE_DIRECT_STAGE_ID] }, at),
        gate('G6', ELITE_DIRECT_G6_CODE, 'elite model GPT-6 Sol (codex:gpt-6-sol) under the elite-direct stage: deterministic verification stands in for a judge', at),
        row('merge:landed', { id: 'l1', kind: 'merge', proposalId: 'p1', repo: 'ashlrai/ashlrcode', prNumber: 12, eliteModel: 'GPT-6 Sol' }, at),
      ],
      chain: 'ok',
      reason: null,
      head: null,
    });
    expect(view.decisions[0]).toMatchObject({ outcome: 'merged', why: 'Landed directly · elite model GPT-6 Sol · tests green.', eliteModel: 'GPT-6 Sol' });
  });

  it('a judged landing reads as before', () => {
    const at = '2026-09-27T10:00:00.000Z';
    const view = shadowDecisionsFromLedger({
      entries: [
        gate('G6', 'judge-ship', 'independent claude judge claude-opus-4-8 shipped it', at),
        row('merge:landed', { id: 'l1', kind: 'merge', proposalId: 'p1', repo: 'ashlrai/ashlrcode', prNumber: 12, eliteModel: null }, at),
      ],
      chain: 'ok',
      reason: null,
      head: null,
    });
    expect(view.decisions[0]!.why).toBe('Every gate passed and it merged.');
    expect(view.decisions[0]!.eliteModel).toBeUndefined();
  });
});
