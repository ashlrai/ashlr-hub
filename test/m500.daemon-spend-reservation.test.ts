import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDaemonSpendReservationLedger,
  DAEMON_MIN_DISPATCH_USD,
  DAEMON_SPEND_USD_PER_MILLION_TOKENS,
  daemonRouteUsdPerMillionTokenCeiling,
} from '../src/core/daemon/spend-reservation.js';

describe('M500 synchronous daemon spend admission', () => {
  it('keeps the reliability contract aligned with preventive admission semantics', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const reliability = readFileSync(join(root, 'docs/RELIABILITY.md'), 'utf8');

    expect(reliability).toMatch(/synchronously reserves each envelope before routing or provider work/);
    expect(reliability).toMatch(/each explicit\s+Best-of-N child is refused when its price is unknown/);
    expect(reliability).toMatch(/hard\s+output-token cap/);
    expect(reliability).toMatch(/provider counters marked `usageKnown`/);
    expect(reliability).toMatch(/not a guarantee about a provider's\s+eventual invoice/);
    expect(reliability).not.toContain('(parallel - 1) × per-item');
  });

  it('admits concurrent workers atomically and never launches refused workers', async () => {
    const ledger = createDaemonSpendReservationLedger(0.15);
    let releaseStart!: () => void;
    let releaseProviders!: () => void;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    const providerBarrier = new Promise<void>((resolve) => { releaseProviders = resolve; });
    const provider = vi.fn(async () => providerBarrier);

    const workers = Array.from({ length: 8 }, (_, index) => (async () => {
      await start;
      const reservation = ledger.tryReserve(`worker-${index}`, 0.06);
      if (!reservation) return { admitted: false, ceilingUsd: 0 };
      await provider(index);
      ledger.reconcile(reservation, 0.01);
      return { admitted: true, ceilingUsd: reservation.ceilingUsd };
    })());

    releaseStart();
    // Every worker resumes from the same barrier before admitted providers are
    // released, so all synchronous reservations contend with the same ledger.
    await Promise.resolve();
    await Promise.resolve();

    expect(provider).toHaveBeenCalledTimes(2);
    expect(ledger.reservedUsd).toBeCloseTo(0.12, 8);
    expect(ledger.availableUsd).toBeCloseTo(0.03, 8);

    releaseProviders();
    const outcomes = await Promise.all(workers);
    const admittedCeilings = outcomes.filter((outcome) => outcome.admitted)
      .map((outcome) => outcome.ceilingUsd);
    expect(admittedCeilings).toHaveLength(2);
    expect(admittedCeilings.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(0.15);
    expect(provider).toHaveBeenCalledTimes(admittedCeilings.length);
    expect(ledger.reservedUsd).toBe(0);
    expect(ledger.chargedUsd).toBeCloseTo(0.02, 8);
    expect(ledger.availableUsd).toBeCloseTo(0.13, 8);
  });

  it('fails closed below the minimum and retains ambiguous launched spend', () => {
    const ledger = createDaemonSpendReservationLedger(0.12);
    expect(ledger.tryReserve('sub-minimum', DAEMON_MIN_DISPATCH_USD - 0.000001)).toBeNull();
    expect(ledger.tryReserve('nan', Number.NaN)).toBeNull();
    expect(ledger.tryReserve('infinite', Number.POSITIVE_INFINITY)).toBeNull();

    const reservation = ledger.tryReserve('ambiguous', 0.06);
    expect(reservation).not.toBeNull();
    expect(ledger.reconcile(reservation!, null)).toBe(true);
    expect(ledger.reconcile(reservation!, 0)).toBe(false);
    expect(ledger.chargedUsd).toBeCloseTo(0.06, 8);
    expect(ledger.availableUsd).toBeCloseTo(0.06, 8);
  });

  it('partitions one outer envelope across every best-of-N child', () => {
    const ledger = createDaemonSpendReservationLedger(0.3);
    const reservation = ledger.tryReserve('best-of-three', 0.3)!;
    const children = ledger.childEnvelope(reservation, 3);

    expect(children).toMatchObject({
      childCount: 3,
      ceilingUsdPerChild: 0.1,
      aggregateCeilingUsd: 0.3,
      maxTokensPerChild: 2_000,
    });
    expect(
      children!.maxTokensPerChild * children!.childCount *
      DAEMON_SPEND_USD_PER_MILLION_TOKENS / 1_000_000,
    ).toBeLessThanOrEqual(reservation.ceilingUsd);
    expect(ledger.childEnvelope(reservation, 7)).toBeNull();
  });

  it('uses the catalog maximum and fails closed for unknown route prices', () => {
    expect(DAEMON_SPEND_USD_PER_MILLION_TOKENS).toBe(50);
    expect(daemonRouteUsdPerMillionTokenCeiling('claude', 'claude-fable-5')).toBe(0);
    expect(daemonRouteUsdPerMillionTokenCeiling('nim', 'meta/llama-3.1-70b-instruct')).toBe(0.97);
    expect(daemonRouteUsdPerMillionTokenCeiling('grok', 'unpriced-future-model')).toBeNull();
  });

  it('accounts actual over-ceiling spend without reopening headroom', () => {
    const ledger = createDaemonSpendReservationLedger(0.1);
    const reservation = ledger.tryReserve('overage', 0.05)!;
    expect(reservation.maxTokens).toBe(1_000);
    expect(ledger.reconcile(reservation, 0.07)).toBe(true);
    expect(ledger.chargedUsd).toBeCloseTo(0.07, 8);
    expect(ledger.availableUsd).toBeCloseTo(0.03, 8);
    expect(ledger.tryReserve('blocked-after-overage', 0.05)).toBeNull();
  });
});
