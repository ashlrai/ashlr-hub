/** Metadata-only, one current connection. No provider contact occurs in peek(). */
import { DevinApiError, type DevinDailyConsumption } from './client.js';
import type { DevinFailureCode } from './types.js';

export const DEVIN_CONSUMPTION_TTL_MS = 5 * 60_000;
const ERROR_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 5 * 60_000;

export interface DevinConsumptionSnapshot {
  source: 'devin-v3-organization-daily';
  scope: 'organization';
  period: 'all-available-reporting-dates';
  dateUnit: 'provider-unspecified';
  dayBoundaryUtc: '08:00';
  state: 'not-checked' | 'reading' | 'ready' | 'unavailable';
  fetchedAt: string | null;
  checkedAt: string | null;
  expiresAt: string | null;
  retryAt: string | null;
  stale: boolean;
  report: DevinDailyConsumption | null;
  error: { code: DevinFailureCode; reason: string } | null;
}

const empty = (): DevinConsumptionSnapshot => ({
  source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates',
  dateUnit: 'provider-unspecified', dayBoundaryUtc: '08:00', state: 'not-checked',
  fetchedAt: null, checkedAt: null, expiresAt: null, retryAt: null, stale: false, report: null, error: null,
});

function reason(code: DevinFailureCode): string {
  if (code === 'forbidden') return 'This key needs ViewOrgConsumption for the connected organization. Session access is separate.';
  if (code === 'rate-limited') return 'Devin rate-limited this consumption read. The previous reading, if any, is unconfirmed.';
  if (code === 'auth') return 'Devin refused this consumption read’s credentials. No usage was inferred.';
  if (code === 'not-connected') return 'Connect the Devin cloud API account to read organization consumption.';
  if (code === 'unparsed') return 'Devin consumption was not recognized. No usage was inferred.';
  return 'Devin consumption could not be read. The previous reading, if any, is unconfirmed.';
}

export class DevinConsumptionCache {
  private identity: string | null = null;
  private generation = 0;
  private value = empty();
  private flight: { identity: string; generation: number; promise: Promise<DevinConsumptionSnapshot> } | null = null;

  reset(): void { this.identity = null; this.generation += 1; this.value = empty(); this.flight = null; }

  private sync(identity: string | null): void {
    if (identity !== this.identity) { this.reset(); this.identity = identity; }
  }

  peek(identity: string | null, now: Date = new Date()): DevinConsumptionSnapshot {
    this.sync(identity);
    const value = structuredClone(this.value);
    value.stale = value.report !== null && (value.state !== 'ready' || value.expiresAt === null || Date.parse(value.expiresAt) <= now.getTime());
    return value;
  }

  refresh(options: {
    identity: () => string | null;
    read: (stillCurrent: () => boolean) => Promise<DevinDailyConsumption>;
    now?: () => Date;
    force?: boolean;
  }): Promise<DevinConsumptionSnapshot> {
    const clock = options.now ?? (() => new Date());
    const identity = options.identity();
    const prior = this.peek(identity, clock());
    if (identity === null) return Promise.resolve(prior);
    if (this.flight?.identity === identity && this.flight.generation === this.generation) return this.flight.promise;
    // Explicit checks may refresh current data, but never bypass provider rate-limit backoff.
    if (prior.retryAt && Date.parse(prior.retryAt) > clock().getTime() && (prior.error?.code === 'rate-limited' || !options.force)) return Promise.resolve(prior);
    if (!options.force && prior.state === 'ready' && !prior.stale) return Promise.resolve(prior);
    const generation = this.generation;
    const stillCurrent = (): boolean => {
      this.sync(options.identity());
      return this.identity === identity && this.generation === generation;
    };
    this.value = { ...this.value, state: 'reading' };
    const promise = Promise.resolve().then(async () => {
      try {
        if (!stillCurrent()) return this.peek(options.identity(), clock());
        const report = await options.read(stillCurrent);
        if (!stillCurrent()) return this.peek(options.identity(), clock());
        const now = clock();
        this.value = { ...empty(), state: 'ready', report, fetchedAt: now.toISOString(), checkedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + DEVIN_CONSUMPTION_TTL_MS).toISOString() };
      } catch (error) {
        if (!stillCurrent()) return this.peek(options.identity(), clock());
        const code = error instanceof DevinApiError ? error.code : 'unknown';
        const now = clock();
        this.value = { ...this.value, state: 'unavailable', checkedAt: now.toISOString(),
          error: { code, reason: reason(code) }, retryAt: new Date(now.getTime() + (code === 'rate-limited' ? RATE_LIMIT_RETRY_MS : ERROR_RETRY_MS)).toISOString() };
      }
      return this.peek(options.identity(), clock());
    }).finally(() => {
      if (this.flight?.generation === generation && this.flight.identity === identity) this.flight = null;
    });
    this.flight = { identity, generation, promise };
    return promise;
  }
}
