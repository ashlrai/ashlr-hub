/**
 * m334.gateway-shadow.test.ts — M334 stage 1: observe-only gateway shadow.
 *
 * Covers:
 *  - compareDecisions classification matrix (incl. the safety-relevant class:
 *    gateway-would-dispatch where legacy blocked);
 *  - record/read round-trip with malformed-line tolerance;
 *  - divergenceStats and the CONTRACT-M334 stage-2 exit criteria
 *    (≥200 decisions, <2% divergence, ZERO safety-relevant).
 *
 * homedir() is redirected to a temp dir so the ledger never touches the real
 * ~/.ashlr.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const FAKE_HOME = await vi.hoisted(async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m334-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { rmSync } from 'node:fs';
import {
  compareDecisions,
  recordGatewayShadow,
  readGatewayShadow,
  divergenceStats,
  gatewayShadowDir,
  type GatewayShadowRecord,
} from '../src/core/fabric/gateway-shadow.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function rec(over: Partial<GatewayShadowRecord> = {}): GatewayShadowRecord {
  const legacy = over.legacy ?? { backend: 'claude', tier: 'frontier', model: 'claude-sonnet-5', dispatched: true };
  const gateway = over.gateway ?? { backend: 'claude', tier: 'frontier', model: 'claude-sonnet-5', wouldDispatch: true };
  return {
    ts: new Date().toISOString(),
    workItemId: 'w1',
    source: 'issue',
    legacy,
    gateway,
    ...compareDecisions(legacy, gateway),
    ...over,
  };
}

beforeEach(() => {
  rmSync(gatewayShadowDir(), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compareDecisions
// ---------------------------------------------------------------------------

describe('M334 compareDecisions', () => {
  const L = (d: boolean, model: string | null = 'm') => ({ backend: 'claude', tier: 'frontier', model, dispatched: d });
  const G = (d: boolean, model: string | null = 'm') => ({ backend: 'claude', tier: 'frontier', model, wouldDispatch: d });

  it('identical decisions → no divergence', () => {
    expect(compareDecisions(L(true), G(true))).toEqual({ diverged: false, safetyRelevant: false });
  });

  it('model difference → diverged, not safety-relevant', () => {
    expect(compareDecisions(L(true, 'a'), G(true, 'b'))).toEqual({ diverged: true, safetyRelevant: false });
  });

  it('backend difference → diverged', () => {
    const g = { backend: 'codex', tier: 'frontier', model: 'm', wouldDispatch: true };
    expect(compareDecisions(L(true), g).diverged).toBe(true);
  });

  it('gateway would dispatch where legacy BLOCKED → SAFETY-RELEVANT', () => {
    expect(compareDecisions(L(false), G(true))).toEqual({ diverged: true, safetyRelevant: true });
  });

  it('gateway blocks where legacy dispatched → diverged but NOT safety-relevant', () => {
    expect(compareDecisions(L(true), G(false))).toEqual({ diverged: true, safetyRelevant: false });
  });
});

// ---------------------------------------------------------------------------
// Ledger round-trip
// ---------------------------------------------------------------------------

describe('M334 shadow ledger', () => {
  it('record → read round-trip, newest first, malformed lines skipped', () => {
    recordGatewayShadow(rec());
    recordGatewayShadow(rec({ gateway: { backend: 'codex', tier: 'frontier', model: null, wouldDispatch: true } }));
    // Inject garbage into the day file — readers must tolerate it.
    mkdirSync(gatewayShadowDir(), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(gatewayShadowDir(), `gateway-shadow-${day}.jsonl`), 'not-json\n{"half":\n', 'utf8');

    const out = readGatewayShadow();
    expect(out).toHaveLength(2);
    expect(out.some((r) => r.diverged)).toBe(true);
  });

  it('empty dir → [] and neutral stats', () => {
    expect(readGatewayShadow()).toEqual([]);
    const stats = divergenceStats();
    expect(stats.decisions).toBe(0);
    expect(stats.readyToFlip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exit criteria
// ---------------------------------------------------------------------------

describe('M334 divergenceStats — CONTRACT exit criteria', () => {
  it('under 200 decisions → never ready', () => {
    for (let i = 0; i < 50; i++) recordGatewayShadow(rec());
    expect(divergenceStats().readyToFlip).toBe(false);
  });

  it('≥200 decisions, <2% divergence, zero safety-relevant → ready', () => {
    for (let i = 0; i < 199; i++) recordGatewayShadow(rec());
    recordGatewayShadow(
      rec({ gateway: { backend: 'codex', tier: 'frontier', model: null, wouldDispatch: true } }),
    );
    const stats = divergenceStats();
    expect(stats.decisions).toBe(200);
    expect(stats.divergences).toBe(1);
    expect(stats.divergenceRate).toBeLessThan(0.02);
    expect(stats.safetyRelevant).toBe(0);
    expect(stats.readyToFlip).toBe(true);
  });

  it('a single safety-relevant divergence blocks the flip regardless of rate', () => {
    for (let i = 0; i < 300; i++) recordGatewayShadow(rec());
    recordGatewayShadow(
      rec({
        legacy: { backend: 'claude', tier: 'frontier', model: 'm', dispatched: false },
        gateway: { backend: 'claude', tier: 'frontier', model: 'm', wouldDispatch: true },
      }),
    );
    const stats = divergenceStats();
    expect(stats.safetyRelevant).toBe(1);
    expect(stats.readyToFlip).toBe(false);
  });

  it('≥2% divergence blocks the flip', () => {
    for (let i = 0; i < 190; i++) recordGatewayShadow(rec());
    for (let i = 0; i < 10; i++) {
      recordGatewayShadow(
        rec({ gateway: { backend: 'codex', tier: 'frontier', model: null, wouldDispatch: true } }),
      );
    }
    const stats = divergenceStats();
    expect(stats.decisions).toBe(200);
    expect(stats.divergenceRate).toBeGreaterThanOrEqual(0.02);
    expect(stats.readyToFlip).toBe(false);
  });
});
