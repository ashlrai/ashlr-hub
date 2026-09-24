/**
 * V3.10 Track B unit U9 — harness registry: config-only patches, adoption
 * gate, the 48 h canary with automatic rollback, veto/rollback exactness, the
 * store's integrity rules, the tuning → hypothesis bridge, and the learning
 * API (driven with in-memory requests — no socket is bound, so this file
 * stays in the fast lane).
 *
 * The authority ledger is mocked (observable rows, simulated breakage);
 * experiments are produced through the real queue with a FAKE executor, so
 * no agent or model runs. HOME is isolated by test/setup/home.ts.
 */
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ rows: [] as { kind: string; data: Record<string, unknown>; actor: string }[], fail: false }));
vi.mock('../src/core/authority/ledger.js', () => ({
  appendLedger: (input: { kind: string; data: Record<string, unknown>; actor: string }) => {
    if (ledger.fail) return { ok: false, reason: 'test: ledger broken' };
    ledger.rows.push({ kind: input.kind, data: structuredClone(input.data), actor: input.actor });
    return { ok: true, entry: { ...input, seq: ledger.rows.length - 1 } };
  },
  readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
  currentLedgerHead: () => null,
}));
vi.mock('../src/core/authority/effective-config.js', () => ({ currentStandingPolicy: () => null }));

import {
  BASELINE_HARNESS_CONFIG,
  BASELINE_VERSION_ID,
  CANARY_MIN_RUNS,
  activeHarness,
  activeHarnessConfig,
  adoptHarness,
  applyHarnessPatch,
  buildLearningState,
  checkHarnessCanary,
  findHypothesis,
  harnessConfigDigest,
  harnessDir,
  harnessStatePath,
  loadHarnessState,
  passRateStandardError,
  recordHarnessOutcome,
  recordHypotheses,
  rollbackHarness,
  validateHarnessConfigPatch,
  validateHarnessHypothesis,
} from '../src/core/learn/harness-registry.js';
import { LOCAL_EVAL_EXERCISABLE, runNextExperiment, startExperiment, type ExperimentExecutor } from '../src/core/learn/experiments.js';
import { HARNESS_ADOPTION_GATE, VERSE_LEARNING_PATH, type HarnessHypothesis } from '../src/core/learn/harness-types.js';
import { HELD_OUT_TASKS } from '../src/core/local-eval/tasks-heldout.js';
import { harnessHypothesesFromTuning } from '../src/core/learn/tuning.js';
import { handleLearningApi } from '../src/core/verse/learning-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { TuningProposal } from '../src/core/types.js';

beforeEach(() => {
  rmSync(harnessDir(), { recursive: true, force: true });
  ledger.rows.length = 0;
  ledger.fail = false;
});

const EDIT = HELD_OUT_TASKS.filter((t) => t.expectation === 'edit').map((t) => t.id);
const REFUSE = HELD_OUT_TASKS.filter((t) => t.expectation === 'refuse').map((t) => t.id);

function hyp(id = 'hyp-1', producer = 'Before you report success, run the project checks and read their output.'): HarnessHypothesis {
  return {
    v: 1,
    id,
    source: { kind: 'leader', ref: 'memo-1' },
    target: 'prompt',
    patch: { prompts: { producer } },
    statement: 'Asking for a re-check raises the held-out pass rate.',
    metric: 'local-eval.heldout.pass-rate',
    predictedDelta: 10,
    createdAt: '2026-09-24T00:00:00.000Z',
  };
}

/** Base passes 5 edits + every refuse task; the candidate passes everything → verdict adopt (9 base passes of 14). */
const winningExecutor: ExperimentExecutor = {
  id: 'fake',
  envelope: { executor: 'fake' },
  exercisable: LOCAL_EVAL_EXERCISABLE,
  async run(req) {
    const passed = req.arm === 'candidate' || REFUSE.includes(req.task.id) || EDIT.slice(0, 5).includes(req.task.id);
    return { passed, mode: passed ? 'pass' : 'wrong-edit', wallMs: 1000, verifyExit: passed ? 0 : 1, changedFiles: 1 };
  },
};

/** Queue + run an experiment that passes the gate; returns its ids. */
async function passingExperiment(id = 'hyp-1', producer?: string): Promise<{ versionId: string; experimentId: string }> {
  const started = startExperiment({ hypothesis: hyp(id, producer), requestedBy: 'leader' });
  if (!started.ok) throw new Error(started.reason);
  const ran = await runNextExperiment({ executor: winningExecutor });
  if (!ran.ran || ran.ran.verdict !== 'adopt') throw new Error(`expected an adopt verdict, got ${JSON.stringify(ran)}`);
  return { versionId: ran.ran.candidateVersionId, experimentId: ran.ran.id };
}

const T0 = new Date('2026-09-24T12:00:00.000Z');
const hours = (h: number): Date => new Date(T0.getTime() + h * 3_600_000);

// ---------------------------------------------------------------------------
// Config-only patches
// ---------------------------------------------------------------------------

describe('config-only patches', () => {
  it('accepts every harness field within bounds and sorts / de-duplicates skills', () => {
    const r = validateHarnessConfigPatch({
      prompts: { producer: 'Re-check.', judge: 'Be strict.' },
      effort: { local: 'high', 'grok-cli': 'medium' },
      sampling: { local: { temperature: 0.7, topP: 0.9, maxOutputTokens: 4096 } },
      routing: { lambdaCost: 2, lambdaPressure: 0.5, lambdaLatency: 0, bonThreshold: 'medium' },
      skills: ['tests-first', 'a-skill', 'tests-first'],
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.skills).toEqual(['a-skill', 'tests-first']);
  });

  it('refuses code: diff markers in a prompt, non-harness keys, control characters', () => {
    for (const marker of ['diff --git a/x b/x', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1,3 +1,4 @@', 'index 1234567..89abcde 100644']) {
      const r = validateHarnessConfigPatch({ prompts: { producer: `Please apply:\n${marker}\n` } });
      expect(r.ok, marker).toBe(false);
      expect(!r.ok && r.reason).toMatch(/code diff/);
    }
    for (const key of ['code', 'diff', 'files', 'patch', 'script', '__proto__x']) {
      expect(validateHarnessConfigPatch({ [key]: 'x' }).ok).toBe(false);
    }
    expect(validateHarnessConfigPatch({ prompts: { producer: 'bell\u0007' } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({}).ok).toBe(false);
    expect(validateHarnessConfigPatch([]).ok).toBe(false);
  });

  it('refuses out-of-bounds values instead of clamping them', () => {
    expect(validateHarnessConfigPatch({ prompts: { producer: 'x'.repeat(4097) } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ prompts: { overlord: 'x' } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ effort: { local: 'ultracode' } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ effort: { gpt: 'high' } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ sampling: { local: { temperature: 3 } } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ sampling: { local: { maxOutputTokens: 10.5 } } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ routing: { lambdaCost: 11, lambdaPressure: 1, lambdaLatency: 1, bonThreshold: 'high' } }).ok).toBe(false);
    expect(validateHarnessConfigPatch({ routing: { lambdaCost: 1 } }).ok).toBe(false); // wholesale: all four required
    expect(validateHarnessConfigPatch({ skills: ['Bad Id'] }).ok).toBe(false);
  });

  it('a hypothesis may only change the field its target names', () => {
    expect(validateHarnessConfigPatch({ prompts: { producer: 'x' }, effort: { local: 'high' } }, 'prompt').ok).toBe(false);
    expect(validateHarnessConfigPatch({ effort: { local: 'high' } }, 'effort').ok).toBe(true);
  });

  it('scrubs secrets out of stored prompt text', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const r = validateHarnessConfigPatch({ prompts: { producer: `use ${token} to push` } });
    expect(r.ok && r.value.prompts!.producer).not.toContain(token);
  });

  it('patches replace a field wholesale, and the digest is canonical (key order does not matter)', () => {
    const baseCfg = applyHarnessPatch(BASELINE_HARNESS_CONFIG, { prompts: { judge: 'j', producer: 'p' } });
    const next = applyHarnessPatch(baseCfg, { prompts: { producer: 'q' } });
    expect(next.prompts).toEqual({ producer: 'q' });
    const reordered = { ...baseCfg, prompts: { producer: 'p', judge: 'j' } };
    expect(harnessConfigDigest(reordered)).toBe(harnessConfigDigest(baseCfg));
    expect(harnessConfigDigest(next)).not.toBe(harnessConfigDigest(baseCfg));
  });
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

describe('adoptHarness', () => {
  it('adopts a gate-passing candidate into a 48 h canary and writes harness:adopted first', async () => {
    const { versionId, experimentId } = await passingExperiment();
    ledger.rows.length = 0;
    const r = adoptHarness({ versionId, experimentId, actor: 'leader' }, { now: T0 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.before).toBeNull();
    expect(r.ok && r.after).toMatchObject({ id: versionId, status: 'canary', adoptedAt: T0.toISOString(), canaryUntil: hours(48).toISOString(), experimentId });
    expect(activeHarness()).toMatchObject({ id: versionId, status: 'canary' });
    expect(activeHarnessConfig().prompts.producer).toMatch(/run the project checks/);
    expect(ledger.rows).toEqual([expect.objectContaining({ kind: 'harness:adopted', actor: 'leader' })]);
    expect(ledger.rows[0]!.data).toMatchObject({ versionId, fromVersionId: null, experimentId });
    // No live runs yet: the canary is judged against the experiment's base arm (9 / 14), and says so.
    const canary = loadHarnessState().canary!;
    expect(canary).toMatchObject({ baselineSource: 'experiment', baselineRuns: 14, fromVersionId: null });
    expect(canary.baselinePassRate).toBeCloseTo(9 / 14, 4);
    expect(canary.baselineStandardError).toBeCloseTo(passRateStandardError(9, 14)!, 4);
    // The active version is frozen: a caller cannot mutate it into the cache.
    expect(() => { (activeHarness() as { status: string }).status = 'adopted'; }).toThrow();
  });

  it('fails CLOSED when the ledger cannot record the adoption — nothing changes', async () => {
    const { versionId, experimentId } = await passingExperiment();
    ledger.fail = true;
    const r = adoptHarness({ versionId, experimentId, actor: 'leader' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not adopted: ledger append refused/);
    expect(activeHarness()).toBeNull();
    expect(loadHarnessState().versions.find((v) => v.id === versionId)!.status).toBe('candidate');
  });

  it('refuses the daemon, unknown ids, a mismatched experiment, and a second adoption while a canary runs', async () => {
    const first = await passingExperiment('hyp-1');
    expect(adoptHarness({ ...first, actor: 'daemon' }).ok).toBe(false);
    expect(adoptHarness({ versionId: 'h-0099', experimentId: first.experimentId, actor: 'mason' }).ok).toBe(false);
    expect(adoptHarness({ versionId: first.versionId, experimentId: 'x-0099', actor: 'mason' }).ok).toBe(false);
    const second = await passingExperiment('hyp-2', 'A different overlay: read every failing test before editing.');
    expect(adoptHarness({ ...first, actor: 'mason' }).ok).toBe(true);
    const r = adoptHarness({ ...second, actor: 'mason' });
    expect(!r.ok && r.reason).toMatch(/canary is running|compared against h-0000/);
  });

  it('refuses an experiment that compared against a version no longer active', async () => {
    const first = await passingExperiment('hyp-1');
    const second = await passingExperiment('hyp-2', 'A different overlay: read every failing test before editing.');
    expect(adoptHarness({ ...first, actor: 'mason' }, { now: T0 }).ok).toBe(true);
    // Let the first canary pass, so the only remaining obstacle is the stale base.
    for (let i = 0; i < CANARY_MIN_RUNS; i += 1) recordHarnessOutcome({ passed: true, at: hours(1) });
    expect(checkHarnessCanary(hours(49)).action).toBe('promoted');
    const r = adoptHarness({ ...second, actor: 'mason' });
    expect(!r.ok && r.reason).toMatch(/compared against h-0000, but h-0001 is active now/);
  });
});

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

describe('canary', () => {
  it('rolls back automatically when the live pass rate falls below baseline − 1 SE', async () => {
    const { versionId, experimentId } = await passingExperiment();
    adoptHarness({ versionId, experimentId, actor: 'leader' }, { now: T0 });
    ledger.rows.length = 0;
    // 7 failing runs: not enough evidence yet — no decision.
    for (let i = 0; i < CANARY_MIN_RUNS - 1; i += 1) {
      expect(recordHarnessOutcome({ passed: false, at: hours(1) }).canary.action).toBe('waiting');
    }
    expect(activeHarness()!.id).toBe(versionId);
    // The 8th crosses the minimum: 0% < 64% − 1 SE → rollback.
    const last = recordHarnessOutcome({ passed: false, at: hours(2) });
    expect(last.canary).toMatchObject({ action: 'rolled-back', versionId, toVersionId: null });
    expect(activeHarness()).toBeNull();
    const v = loadHarnessState().versions.find((x) => x.id === versionId)!;
    expect(v).toMatchObject({ status: 'rolled-back', rolledBackAt: hours(2).toISOString(), canaryUntil: null });
    expect(v.rollbackReason).toMatch(/fell below baseline/);
    expect(loadHarnessState().canary).toBeNull();
    expect(ledger.rows).toEqual([expect.objectContaining({ kind: 'harness:rolled-back', actor: 'daemon' })]);
    expect(ledger.rows[0]!.data).toMatchObject({ versionId: BASELINE_VERSION_ID, fromVersionId: versionId, configDigest: harnessConfigDigest(BASELINE_HARNESS_CONFIG) });
  });

  it('holds when the canary is at or above the line, and promotes only after 48 h WITH evidence', async () => {
    const { versionId, experimentId } = await passingExperiment();
    adoptHarness({ versionId, experimentId, actor: 'leader' }, { now: T0 });
    for (let i = 0; i < 3; i += 1) recordHarnessOutcome({ passed: true, at: hours(1) });
    // Window over, but only 3 runs: waits (too few runs is "not measured", not a pass).
    const early = checkHarnessCanary(hours(49));
    expect(early).toMatchObject({ action: 'waiting' });
    expect(early.action === 'waiting' && early.reason).toMatch(/3 of 8 live runs/);
    for (let i = 0; i < 5; i += 1) recordHarnessOutcome({ passed: i !== 0, at: hours(50) });
    // 7/8 = 87.5% ≥ line → promoted at the next check (recordHarnessOutcome already checks).
    const state = loadHarnessState();
    expect(state.canary).toBeNull();
    expect(state.versions.find((v) => v.id === versionId)).toMatchObject({ status: 'adopted', canaryUntil: null });
    expect(activeHarness()!.id).toBe(versionId);
    expect(ledger.rows.at(-1)).toMatchObject({ kind: 'note', data: { topic: 'harness:canary-passed' } });
  });

  it('uses the LIVE pre-adoption pass rate as the baseline when there is enough of it', async () => {
    for (let i = 0; i < 20; i += 1) recordHarnessOutcome({ passed: i % 5 !== 0, at: new Date(T0.getTime() - 3_600_000) });
    const { versionId, experimentId } = await passingExperiment();
    adoptHarness({ versionId, experimentId, actor: 'mason' }, { now: T0 });
    const c = loadHarnessState().canary!;
    expect(c).toMatchObject({ baselineSource: 'live', baselineRuns: 20, baselinePassRate: 0.8 });
    expect(buildLearningState(T0).canary).toMatchObject({ versionId, baselinePassRate: 0.8, runs: 0, currentPassRate: null });
  });

  it('the standard error never collapses at 0% or 100%', () => {
    expect(passRateStandardError(20, 20)).toBeGreaterThan(0);
    expect(passRateStandardError(0, 20)).toBeGreaterThan(0);
    expect(passRateStandardError(3, 0)).toBeNull();
    expect(passRateStandardError(5, 4)).toBeNull();
  });

  it('refuses an outcome for an unknown version', () => {
    expect(recordHarnessOutcome({ passed: true, versionId: 'h-0042' }).ok).toBe(false);
    expect(recordHarnessOutcome({ passed: true }).ok).toBe(true);
    expect(loadHarnessState().outcomes[0]).toMatchObject({ versionId: BASELINE_VERSION_ID, passed: true });
  });
});

// ---------------------------------------------------------------------------
// Rollback / veto
// ---------------------------------------------------------------------------

describe('rollbackHarness', () => {
  it('a veto restores the prior active version exactly and records it', async () => {
    const { versionId, experimentId } = await passingExperiment();
    const adopted = adoptHarness({ versionId, experimentId, actor: 'leader' }, { now: T0 });
    expect(adopted.ok && adopted.before).toBeNull();
    ledger.rows.length = 0;
    const r = rollbackHarness({ toVersionId: null, reason: 'Leader veto', actor: 'mason' }, { now: hours(1) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.before!.id).toBe(versionId);
    expect(r.ok && r.after).toBeNull();
    expect(activeHarness()).toBeNull();
    expect(activeHarnessConfig()).toEqual(applyHarnessPatch(BASELINE_HARNESS_CONFIG, {}));
    expect(loadHarnessState().canary).toBeNull();
    expect(ledger.rows[0]).toMatchObject({ kind: 'harness:rolled-back', actor: 'mason', data: { versionId: BASELINE_VERSION_ID, fromVersionId: versionId } });
  });

  it('can restore a previously adopted version, never a candidate that skipped the gate', async () => {
    const first = await passingExperiment('hyp-1');
    adoptHarness({ ...first, actor: 'mason' }, { now: T0 });
    for (let i = 0; i < CANARY_MIN_RUNS; i += 1) recordHarnessOutcome({ passed: true, at: hours(1) });
    checkHarnessCanary(hours(49));
    const second = await passingExperiment('hyp-2', 'A different overlay: read every failing test before editing.');
    expect(adoptHarness({ ...second, actor: 'mason' }, { now: hours(50) }).ok).toBe(true);
    expect(activeHarness()!.id).toBe(second.versionId);
    // Back to the first (adopted) version.
    const back = rollbackHarness({ toVersionId: first.versionId, reason: 'veto', actor: 'leader' });
    expect(back.ok && back.after!.id).toBe(first.versionId);
    expect(activeHarness()).toMatchObject({ id: first.versionId, status: 'adopted' });
    // A never-adopted candidate cannot be "rolled back" to.
    const third = startExperiment({ hypothesis: hyp('hyp-3', 'Third overlay.'), requestedBy: 'leader' });
    expect(third.ok).toBe(true);
    const cand = loadHarnessState().versions.find((v) => v.status === 'candidate')!;
    const refused = rollbackHarness({ toVersionId: cand.id, reason: 'x', actor: 'mason' });
    expect(!refused.ok && refused.reason).toMatch(/never adopted/);
  });

  it('lowering is never blocked by a broken ledger', async () => {
    const { versionId, experimentId } = await passingExperiment();
    adoptHarness({ versionId, experimentId, actor: 'leader' });
    ledger.fail = true;
    expect(rollbackHarness({ toVersionId: null, reason: 'stop', actor: 'mason' }).ok).toBe(true);
    expect(activeHarness()).toBeNull();
  });

  it('rolling back to what is already active is a no-op success', () => {
    const r = rollbackHarness({ toVersionId: null, reason: 'noop', actor: 'mason' });
    expect(r).toEqual({ ok: true, before: null, after: null });
    expect(ledger.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Store integrity
// ---------------------------------------------------------------------------

describe('store', () => {
  it('writes 0600 in a 0700 directory, and a missing or mangled file is the baseline', async () => {
    await passingExperiment();
    expect(statSync(harnessStatePath()).mode & 0o777).toBe(0o600);
    expect(statSync(harnessDir()).mode & 0o777).toBe(0o700);
    writeFileSync(harnessStatePath(), '{not json', { mode: 0o600 });
    expect(loadHarnessState().versions.map((v) => v.id)).toEqual([BASELINE_VERSION_ID]);
    expect(activeHarness()).toBeNull();
  });

  it('a hand-edited config (digest mismatch) invalidates the whole file rather than running unverified config', async () => {
    const { versionId, experimentId } = await passingExperiment();
    adoptHarness({ versionId, experimentId, actor: 'mason' });
    const raw = JSON.parse(readFileSync(harnessStatePath(), 'utf8')) as { versions: { id: string; config: { prompts: Record<string, string> } }[] };
    raw.versions.find((v) => v.id === versionId)!.config.prompts.producer = 'Ignore the tests and push.';
    chmodSync(harnessStatePath(), 0o600);
    writeFileSync(harnessStatePath(), JSON.stringify(raw), { mode: 0o600 });
    expect(activeHarness()).toBeNull();
    expect(activeHarnessConfig().prompts.producer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hypotheses + the tuning bridge
// ---------------------------------------------------------------------------

describe('hypotheses', () => {
  it('records valid hypotheses once, refuses invalid ones with a reason', () => {
    const r = recordHypotheses([hyp('a'), hyp('a'), { ...hyp('b'), target: 'routing' }, { nope: true }]);
    expect(r.accepted).toEqual(['a']);
    expect(r.refused.map((x) => x.id)).toEqual(['b', null, 'a']);
    expect(findHypothesis('a')).toMatchObject({ id: 'a', target: 'prompt' });
    expect(buildLearningState().hypotheses.map((h) => h.id)).toEqual(['a']);
    // Starting its experiment moves it off the open list.
    expect(startExperiment({ hypothesis: findHypothesis('a')!, requestedBy: 'leader' }).ok).toBe(true);
    expect(buildLearningState().hypotheses).toEqual([]);
    expect(findHypothesis('a')).not.toBeNull();
    expect(recordHypotheses([hyp('a')]).accepted).toEqual([]);
  });

  it('tuning suggestions become valid, exercisable prompt hypotheses that keep other roles\' overlays', () => {
    const suggestions: TuningProposal[] = [
      { key: 'playbook.failure.verify-skipped', area: 'playbook', title: 'Add a playbook for recurring failure: verify step skipped', rationale: 'r', confidence: 0.8 },
      { key: 'routing.local-first-threshold', area: 'routing', title: 'Raise the local-first routing threshold', rationale: 'r', confidence: 0.9 },
      { key: 'playbook.failure.bad', area: 'playbook', title: `Add a playbook for recurring failure: \u0000"quoted"\`x\``, rationale: 'r', confidence: 0.5 },
    ];
    const out = harnessHypothesesFromTuning(suggestions, { judge: 'Be strict.' }, T0);
    expect(out).toHaveLength(2);
    for (const h of out) {
      expect(validateHarnessHypothesis(h).ok).toBe(true);
      expect(h.patch.prompts!.judge).toBe('Be strict.');
      expect(h.patch.prompts!.producer).toMatch(/run the check the task or project provides/);
      expect(h.source).toMatchObject({ kind: 'insight' });
    }
    expect(out[0]!.patch.prompts!.producer).toContain('"verify step skipped"');
    expect(out[1]!.patch.prompts!.producer).not.toContain('\u0000');
    expect(out[1]!.patch.prompts!.producer).not.toContain('`');
    // Deterministic ids: the same suggestion gives the same hypothesis id.
    expect(harnessHypothesesFromTuning(suggestions, {}, T0)[0]!.id).toBe(out[0]!.id);
    // Built from overlays the ACTIVE harness does not have, the candidate would
    // also change prompts.judge — untestable here, so it is refused…
    const stale = startExperiment({ hypothesis: out[0]!, requestedBy: 'daemon' });
    expect(!stale.ok && stale.reason).toMatch(/cannot exercise prompts\.judge/);
    // …while one built from the active harness's own prompts changes only
    // prompts.producer, which the runner can exercise.
    const fresh = harnessHypothesesFromTuning(suggestions, activeHarnessConfig().prompts, T0);
    expect(startExperiment({ hypothesis: fresh[0]!, requestedBy: 'daemon' }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Learning API (real loopback server)
// ---------------------------------------------------------------------------

describe('learning API', () => {
  const ctx = { cfg: {}, token: 'tok', allowDispatch: true } as unknown as VerseApiContext;

  /** One in-memory request through the handler: {status, body} or 'fallthrough' when it declined the path. */
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown } | 'fallthrough'> {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Object.assign(Readable.from(payload), {
      method,
      url,
      headers: body === undefined ? headers : { 'content-type': 'application/json', 'x-ashlr-token': 'tok', ...headers },
    }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = {
      writeHead(code: number) { status = code; return res; },
      end(chunk?: string) { text = chunk ?? ''; return res; },
    } as unknown as ServerResponse;
    const path = new URL(url, 'http://localhost').pathname;
    const handled = await handleLearningApi(ctx, req, res, path, method);
    if (!handled) return 'fallthrough';
    return { status, body: text ? JSON.parse(text) as unknown : null };
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call('POST', path, body, headers);
  const statusOf = (r: Awaited<ReturnType<typeof call>>): number => (r === 'fallthrough' ? -1 : r.status);
  const bodyOf = <T>(r: Awaited<ReturnType<typeof call>>): T => (r === 'fallthrough' ? (null as T) : r.body as T);

  it('GET returns LearningStateV1 with the baseline and nothing else; foreign paths fall through', async () => {
    const res = await call('GET', VERSE_LEARNING_PATH);
    expect(statusOf(res)).toBe(200);
    const body = bodyOf<{ versions: { id: string }[] }>(res);
    expect(body).toMatchObject({ v: 1, active: null, canary: null, experiments: [], hypotheses: [] });
    expect(body.versions.map((v) => v.id)).toEqual([BASELINE_VERSION_ID]);
    expect(statusOf(await call('GET', `${VERSE_LEARNING_PATH}?x=1`))).toBe(400);
    expect(statusOf(await call('GET', `${VERSE_LEARNING_PATH}/nope`))).toBe(404);
    expect(await call('GET', '/api/verse/budget')).toBe('fallthrough');
    expect(await call('GET', '/api/verse/learningx')).toBe('fallthrough');
  });

  it('POSTs are gated: token, JSON content type, dispatch allowed, known keys', async () => {
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments`, { hypothesis: hyp() }, { 'x-ashlr-token': 'wrong' }))).toBe(401);
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments`, { hypothesis: hyp() }, { 'content-type': 'text/plain' }))).toBe(415);
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments`, { hypothesis: hyp(), extra: 1 }))).toBe(400);
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments`, {}))).toBe(400);
    (ctx as { allowDispatch: boolean }).allowDispatch = false;
    try {
      expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments`, { hypothesis: hyp() }))).toBe(404);
    } finally {
      (ctx as { allowDispatch: boolean }).allowDispatch = true;
    }
    expect(statusOf(await call('DELETE', VERSE_LEARNING_PATH))).toBe(404);
    expect(loadHarnessState().experiments).toHaveLength(0);
  });

  it('start → run → adopt → rollback through the API, refusals as 409 with the reason', async () => {
    const started = await post(`${VERSE_LEARNING_PATH}/experiments`, { hypothesis: hyp() });
    expect(statusOf(started)).toBe(200);
    expect(bodyOf(started)).toEqual({ ok: true, experimentId: 'x-0001' });
    const early = await post(`${VERSE_LEARNING_PATH}/adopt`, { versionId: 'h-0001', experimentId: 'x-0001' });
    expect(statusOf(early)).toBe(409);
    expect(bodyOf<{ error: string }>(early).error).toMatch(/is queued, not done/);
    await runNextExperiment({ executor: winningExecutor });
    const adopt = await post(`${VERSE_LEARNING_PATH}/adopt`, { versionId: 'h-0001', experimentId: 'x-0001' });
    expect(statusOf(adopt)).toBe(200);
    expect(ledger.rows.find((r) => r.kind === 'harness:adopted')!.actor).toBe('mason');
    const state = bodyOf<{ active: { id: string }; canary: { versionId: string }; experiments: Record<string, unknown>[] }>(await call('GET', VERSE_LEARNING_PATH));
    expect(state.active.id).toBe('h-0001');
    expect(state.canary.versionId).toBe('h-0001');
    expect(state.experiments[0]).toMatchObject({ id: 'x-0001', verdict: 'adopt' });
    expect(Object.keys(state.experiments[0]!)).not.toContain('armPasses');
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/rollback`, { reason: 'x' }))).toBe(400);
    const rolled = await post(`${VERSE_LEARNING_PATH}/rollback`, { toVersionId: null, reason: 'not now' });
    expect(statusOf(rolled)).toBe(200);
    expect(activeHarness()).toBeNull();
    expect(statusOf(await post(`${VERSE_LEARNING_PATH}/experiments/cancel`, { experimentId: 'x-0001' }))).toBe(409);
  });
});

it('pins the gate numbers this unit implements', () => {
  expect(HARNESS_ADOPTION_GATE.minPairs).toBe(8);
  expect(HARNESS_ADOPTION_GATE.canaryHours).toBe(48);
  expect(CANARY_MIN_RUNS).toBeGreaterThanOrEqual(HARNESS_ADOPTION_GATE.minPairs);
});
