/**
 * 3.10 d0 (rollout side) — `sandbox:evidence-unknown`.
 *
 * An autonomous run whose kernel violation evidence was unavailable or
 * incomplete proves nothing either way. The ledger records it as evidence and
 * the rollout HOLDS the stage on it: never advances (it is not a clean run),
 * never regresses (it is not a violation), for EVIDENCE_UNKNOWN_HOLD_MS. A
 * real breach in the same window still regresses.
 *
 * Also pins the two producers of the row (sandboxed-engine, the fleet judge
 * spawn) to `finishAutonomousSpawn().violationsKnown`.
 *
 * Everything runs in a temp HOME; the real ~/.ashlr is never touched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  standing: null as null | { grantId: string },
}));

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

import {
  appendLedger,
  ledgerSnapshot,
  resetLedgerCachesForTest,
  withLedgerTransaction,
  type LedgerEvidenceRow,
} from '../src/core/authority/ledger.js';
import {
  EVIDENCE_UNKNOWN_HOLD_MS,
  evaluateRollout,
  recordSandboxEvidenceUnknown,
  stepRolloutUnderLock,
  type RolloutPositionInternal,
} from '../src/core/authority/rollout.js';
import { LEDGER_EVENT_KINDS } from '../src/core/authority/types.js';
import { makeGrant, withTempHome } from './helpers/authority-310b.js';

/** The standing grant the writer sees (effective-config is covered by its own suites). */
const standingDeps = { standingGrantId: () => hoisted.standing?.grantId ?? null };

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const grant = makeGrant({}, NOW);

let seq = 100;
const row = (kind: LedgerEvidenceRow['kind'], hoursAgo = 1, extra: Partial<LedgerEvidenceRow> = {}): LedgerEvidenceRow =>
  ({ seq: (seq += 1), at: new Date(NOW - hoursAgo * HOUR).toISOString(), kind, repo: 'ashlrai/ashlrcode', landingId: null, verdict: null, ...extra });

function position(stageIndex: number, enteredHoursAgo = 30): RolloutPositionInternal {
  return { stageIndex, stageId: grant.rollout.stages[stageIndex]!.id, enteredAt: new Date(NOW - enteredHoursAgo * HOUR).toISOString(), entrySeq: 100 };
}

describe('evaluateRollout: unknown sandbox evidence holds the stage', () => {
  const metShadow = () => [row('gate:would-merge'), row('gate:would-merge')];

  it('is a real evidence kind of the ledger', () => {
    expect(LEDGER_EVENT_KINDS).toContain('sandbox:evidence-unknown');
  });

  it('a stage whose criteria are met does NOT advance while a run had unknown evidence', () => {
    expect(evaluateRollout({ grant, position: position(0), evidence: metShadow(), nowMs: NOW }).decision).toBe('advance');
    const ev = evaluateRollout({ grant, position: position(0), evidence: [...metShadow(), row('sandbox:evidence-unknown', 2)], nowMs: NOW });
    expect(ev.decision).toBe('hold');
    expect(ev.breach).toBeNull();
    expect(ev.progress.met).toBe(false);
    expect(ev.progress.unmet).toEqual(['1 run with unknown sandbox evidence in the last 24 h']);
    // Not counted as a violation either.
    expect(ev.progress.sandboxViolations).toBe(0);
  });

  it('never regresses on unknown evidence alone, however much of it', () => {
    const many = Array.from({ length: 20 }, () => row('sandbox:evidence-unknown'));
    const ev = evaluateRollout({ grant, position: position(1), evidence: many, nowMs: NOW });
    expect(ev.decision).toBe('hold');
    expect(ev.breach).toBeNull();
    expect(ev.progress.unmet).toContain('20 runs with unknown sandbox evidence in the last 24 h');
  });

  it('the hold lapses EVIDENCE_UNKNOWN_HOLD_MS after the last unknown run', () => {
    const justOutside = (EVIDENCE_UNKNOWN_HOLD_MS + HOUR) / HOUR;
    const ev = evaluateRollout({ grant, position: position(0, 48), evidence: [row('sandbox:evidence-unknown', justOutside), ...metShadow()], nowMs: NOW });
    expect(ev.decision).toBe('advance');
    const inside = evaluateRollout({ grant, position: position(0, 48), evidence: [row('sandbox:evidence-unknown', justOutside), row('sandbox:evidence-unknown', 23), ...metShadow()], nowMs: NOW });
    expect(inside.decision).toBe('hold');
  });

  it('a real breach in the same window still regresses', () => {
    const ev = evaluateRollout({ grant, position: position(1), evidence: [row('sandbox:evidence-unknown'), row('sandbox:violation')], nowMs: NOW });
    expect(ev.decision).toBe('regress');
    expect(ev.breach).toMatch(/sandbox violation/);
  });

  it('unknown evidence from before the stage was entered does not hold it', () => {
    const old = { ...row('sandbox:evidence-unknown'), seq: 50 };
    expect(evaluateRollout({ grant, position: position(0), evidence: [old, ...metShadow()], nowMs: NOW }).decision).toBe('advance');
  });
});

describe('ledger + stepRolloutUnderLock with a written sandbox:evidence-unknown row', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withTempHome('d0-evidence-unknown-').restore;
    resetLedgerCachesForTest();
    hoisted.standing = null;
  });
  afterEach(() => {
    resetLedgerCachesForTest();
    restore();
    hoisted.standing = null;
  });

  function accept(): void {
    expect(appendLedger({
      kind: 'grant:accepted',
      actor: 'mason',
      grantId: grant.grantId,
      repo: null,
      data: {
        grantId: grant.grantId,
        grantSeq: grant.grantSeq,
        keyId: grant.keyId,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        authoritySurfaceDigest: grant.authoritySurfaceDigest,
        stageIds: grant.rollout.stages.map((s) => s.id),
        envelopeDigest: 'e'.repeat(64),
      },
    }).ok).toBe(true);
  }

  function wouldMerge(): void {
    expect(appendLedger({
      kind: 'gate:would-merge',
      actor: 'daemon',
      grantId: grant.grantId,
      repo: 'ashlrai/ashlrcode',
      data: { v: 1, proposalId: 'p', repo: 'ashlrai/ashlrcode', headSha: 'f'.repeat(40), gatesDigest: 'd'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, at: new Date().toISOString() },
    }).ok).toBe(true);
  }

  const step = () => {
    const result = withLedgerTransaction((tx) => stepRolloutUnderLock(tx, grant, Date.now()));
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };

  it('recordSandboxEvidenceUnknown writes a row that the rollout reads as a hold, never a move', async () => {
    accept();
    wouldMerge();
    wouldMerge();
    hoisted.standing = { grantId: grant.grantId };
    await expect(recordSandboxEvidenceUnknown({
      engine: 'grok-cli',
      sourceRepo: null,
      runId: 'run-1',
      evidence: { state: 'incomplete', reason: 'the end barrier never arrived' },
    }, standingDeps)).resolves.toBe(true);

    const evidence = ledgerSnapshot().index.evidence;
    expect(evidence.map((r) => r.kind)).toContain('sandbox:evidence-unknown');

    const held = step();
    expect(held).toMatchObject({ decision: 'hold', fromStageId: 'shadow', toStageId: 'shadow' });
    expect(held?.evaluation.progress.unmet).toEqual(['1 run with unknown sandbox evidence in the last 24 h']);
    // And no rollout row was written for it.
    expect(ledgerSnapshot().index.rollout.get(grant.grantId)).toBeUndefined();
  });

  it('writes nothing for complete evidence', async () => {
    accept();
    hoisted.standing = { grantId: grant.grantId };
    await expect(recordSandboxEvidenceUnknown({ engine: 'claude', sourceRepo: null, runId: null, evidence: { state: 'complete', reason: null } }, standingDeps))
      .resolves.toBe(false);
    expect(ledgerSnapshot().index.evidence).toEqual([]);
  });

  it('treats missing evidence as unknown (fail closed)', async () => {
    accept();
    hoisted.standing = { grantId: grant.grantId };
    await expect(recordSandboxEvidenceUnknown({ engine: 'claude', sourceRepo: null, runId: null, evidence: undefined }, standingDeps)).resolves.toBe(true);
    expect(ledgerSnapshot().index.evidence.map((r) => r.kind)).toEqual(['sandbox:evidence-unknown']);
  });

  it('writes nothing without a standing grant (there is no rollout to hold)', async () => {
    await expect(recordSandboxEvidenceUnknown({ engine: 'claude', sourceRepo: null, runId: null, evidence: { state: 'unavailable', reason: 'not macOS' } }, standingDeps))
      .resolves.toBe(false);
    expect(ledgerSnapshot().chain).toBe('empty');
  });
});

describe('producers pass finishAutonomousSpawn().violationsKnown into the ledger', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  /** Every finishAutonomousSpawn(...) call is followed, before the next one, by the unknown-evidence write. */
  function eachFinishRecordsUnknown(text: string): number {
    const sites = [...text.matchAll(/finishAutonomousSpawn\(/g)].map((m) => m.index!);
    for (let k = 0; k < sites.length; k += 1) {
      const window = text.slice(sites[k]!, sites[k + 1] ?? sites[k]! + 1500).slice(0, 1500);
      expect(window, `finishAutonomousSpawn call #${k + 1}`).toMatch(/violationsKnown !== true\)\s*\{\s*await recordSandboxEvidenceUnknown\(\{[^}]*evidence: finished\.kernelEvidence/);
    }
    return sites.length;
  }

  it('sandboxed-engine: the normal finish and the throw-path finish both record it', () => {
    expect(eachFinishRecordsUnknown(source('src/core/run/sandboxed-engine.ts'))).toBe(2);
  });

  it('fleet manager: the confined judge spawn records it', () => {
    expect(eachFinishRecordsUnknown(source('src/core/fleet/manager.ts'))).toBe(1);
  });
});
