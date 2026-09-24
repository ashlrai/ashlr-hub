/**
 * 3.10 review fixes for the harness registry store (review 310 d6 / d7):
 *   - d6: the 2 MiB whole-file cap used to REFUSE every mutation once history
 *     filled the file — rollback and canary evidence included. A write that
 *     would cross the cap now compacts (old outcomes, finished experiments,
 *     stale version history) and proceeds; what the canary and the next
 *     adoption need is kept.
 *   - d7: a store file that EXISTS but cannot be read (EACCES / EMFILE, a
 *     garbled or hand-edited file) used to be rebuilt from the empty registry
 *     and written over the real one. Mutations now refuse and leave it alone.
 *
 * The authority ledger is mocked; HOME is isolated by test/setup/home.ts.
 */
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ rows: [] as { kind: string; data: Record<string, unknown>; actor: string }[] }));
vi.mock('../src/core/authority/ledger.js', () => ({
  appendLedger: (input: { kind: string; data: Record<string, unknown>; actor: string }) => {
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
  activeHarness,
  applyHarnessPatch,
  emptyHarnessState,
  harnessConfigDigest,
  harnessDir,
  harnessStatePath,
  loadHarnessState,
  recordHarnessOutcome,
  recordHypotheses,
  rollbackHarness,
} from '../src/core/learn/harness-registry.js';
import type { HarnessStateV1 } from '../src/core/learn/harness-registry.js';
import type { HarnessVersion } from '../src/core/learn/harness-types.js';
import { ensurePrivateDirectory } from '../src/core/verse/preferences.js';

const CAP = 2 * 1024 * 1024;
const AT = '2026-09-20T00:00:00.000Z';

beforeEach(() => {
  rmSync(harnessDir(), { recursive: true, force: true });
  ledger.rows.length = 0;
});

function encode(state: HarnessStateV1): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** A kept (adopted / rolled-back) version with four near-cap prompt overlays. */
function heavyVersion(seq: number, status: 'adopted' | 'rolled-back'): HarnessVersion {
  const prompt = (role: string): string => `${role} ${seq}: ${'verify before you report; '.repeat(160)}`.slice(0, 4000);
  const config = applyHarnessPatch(BASELINE_HARNESS_CONFIG, {
    prompts: { producer: prompt('producer'), judge: prompt('judge'), leader: prompt('leader'), planner: prompt('planner') },
  });
  return {
    v: 1,
    id: `h-${String(seq).padStart(4, '0')}`,
    seq,
    parentId: null,
    createdAt: AT,
    status,
    config,
    configDigest: harnessConfigDigest(config),
    source: { kind: 'manual', hypothesisId: null },
    experimentId: null,
    adoptedAt: AT,
    canaryUntil: null,
    rolledBackAt: status === 'rolled-back' ? AT : null,
    rollbackReason: status === 'rolled-back' ? 'regressed' : null,
  };
}

/** A registry whose serialized form sits just under the 2 MiB cap, with an adopted harness active. */
function writeNearCapState(): HarnessStateV1 {
  const state = emptyHarnessState();
  const size = (): number => Buffer.byteLength(encode(state), 'utf8');
  // Sized arithmetically (a handful of serializations, not one per item).
  const base = size();
  state.versions.push(heavyVersion(1, 'adopted'));
  const perVersion = size() - base;
  const versions = Math.floor((CAP - 150_000 - base) / perVersion);
  for (let seq = 2; seq <= versions; seq += 1) state.versions.push(heavyVersion(seq, seq % 3 === 0 ? 'rolled-back' : 'adopted'));
  const active = state.versions[state.versions.length - 1]!;
  active.status = 'adopted';
  active.rolledBackAt = null;
  active.rollbackReason = null;
  state.activeId = active.id;
  state.versionSeq = versions;
  // Live outcomes close the gap to a few hundred bytes short of the cap (≤ 2000, the ring size).
  const outcome = (i: number): HarnessStateV1['outcomes'][number] =>
    ({ versionId: i % 2 === 0 ? active.id : BASELINE_VERSION_ID, passed: i % 5 !== 0, at: new Date(Date.parse(AT) + i * 1000).toISOString() });
  state.outcomes.push(outcome(0), outcome(1));
  const withTwo = size();
  state.outcomes.push(outcome(2), outcome(3));
  const perOutcome = (size() - withTwo) / 2;
  const want = Math.min(2000, 2 + Math.floor((CAP - 350 - withTwo) / perOutcome));
  for (let i = 4; i < want; i += 1) state.outcomes.push(outcome(i));
  while (size() > CAP - 300) state.outcomes.shift();
  // The point of the fixture: within a few hundred bytes of the cap.
  expect(size()).toBeGreaterThan(CAP - 500);
  ensurePrivateDirectory(harnessDir());
  writeFileSync(harnessStatePath(), encode(state), { mode: 0o600 });
  return state;
}

describe('harness store byte cap never blocks lowering (review 310 d6)', () => {
  it('a rollback that grows a near-cap file compacts and proceeds; what matters is kept', () => {
    const seeded = writeNearCapState();
    expect(statSync(harnessStatePath()).size).toBeLessThanOrEqual(CAP);
    const activeId = seeded.activeId!;
    expect(activeHarness()?.id).toBe(activeId);

    // Before the fix: 'the harness store would exceed its size cap' and the
    // failing harness stayed active.
    const r = rollbackHarness({ toVersionId: null, reason: `harness regressed: ${'x'.repeat(480)}`, actor: 'mason' });
    expect(r.ok).toBe(true);
    expect(activeHarness()).toBeNull();

    const size = statSync(harnessStatePath()).size;
    expect(size).toBeLessThanOrEqual(CAP);
    const after = loadHarnessState();
    const ids = new Set(after.versions.map((v) => v.id));
    expect(ids.has(BASELINE_VERSION_ID)).toBe(true);
    // The version just rolled back and the newest adopted history survive.
    expect(ids.has(activeId)).toBe(true);
    const history = seeded.versions.filter((v) => v.status === 'adopted' || v.status === 'rolled-back').map((v) => v.id);
    for (const id of history.slice(-20)) expect(ids.has(id)).toBe(true);
    expect(after.versions.find((v) => v.id === activeId)).toMatchObject({ status: 'rolled-back' });
  }, 30_000);

  it('canary evidence keeps being recorded at the cap', () => {
    writeNearCapState();
    // ~105 B each: the 5th crosses the cap (before the fix every one after that failed).
    for (let i = 0; i < 12; i += 1) {
      expect(recordHarnessOutcome({ passed: true, versionId: BASELINE_VERSION_ID }).ok).toBe(true);
    }
    expect(statSync(harnessStatePath()).size).toBeLessThanOrEqual(CAP);
    expect(loadHarnessState().outcomes.slice(-12).every((o) => o.versionId === BASELINE_VERSION_ID && o.passed)).toBe(true);
  }, 30_000);
});

describe('an unreadable harness store is never rebuilt from the baseline (review 310 d7)', () => {
  function seedAdopted(): string {
    const state = emptyHarnessState();
    const v = heavyVersion(1, 'adopted');
    state.versions.push(v);
    state.activeId = v.id;
    state.versionSeq = 1;
    ensurePrivateDirectory(harnessDir());
    const text = encode(state);
    writeFileSync(harnessStatePath(), text, { mode: 0o600 });
    return text;
  }

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a file that cannot be opened (EACCES) refuses the mutation and is left intact', () => {
    const text = seedAdopted();
    chmodSync(harnessStatePath(), 0o000);
    try {
      const r = recordHarnessOutcome({ passed: true, versionId: BASELINE_VERSION_ID });
      expect(r.ok).toBe(false);
      const hyp = recordHypotheses([]);
      expect(hyp.accepted).toEqual([]);
    } finally {
      chmodSync(harnessStatePath(), 0o600);
    }
    expect(readFileSync(harnessStatePath(), 'utf8')).toBe(text);
    expect(activeHarness()?.id).toBe('h-0001');
  });

  it('a garbled file refuses a mutation (reads stay the baseline) and is not overwritten', () => {
    ensurePrivateDirectory(harnessDir());
    writeFileSync(harnessStatePath(), '{not json', { mode: 0o600 });
    expect(activeHarness()).toBeNull();
    const r = rollbackHarness({ toVersionId: null, reason: 'stop', actor: 'mason' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not a state this build wrote.*nothing was written/);
    expect(recordHarnessOutcome({ passed: true, versionId: BASELINE_VERSION_ID }).ok).toBe(false);
    expect(readFileSync(harnessStatePath(), 'utf8')).toBe('{not json');
  });

  it('a missing file is still the empty registry, and mutations create it', () => {
    expect(recordHarnessOutcome({ passed: true }).ok).toBe(true);
    expect(loadHarnessState().outcomes).toHaveLength(1);
  });
});
