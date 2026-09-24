/** Shared fixtures for the seat-health UI tests (V3.10, unit A2). */
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';

export function healthReport(seatId: string, over: Partial<SeatHealthReport> = {}): SeatHealthReport {
  return {
    seatId,
    engine: 'claude',
    connection: 'connected',
    checkedAt: '2026-09-23T20:00:00.000Z',
    cliVersion: null,
    newestCliVersion: null,
    credentialExpiresAt: null,
    lastRefreshAt: null,
    resetAt: null,
    reasons: [],
    fix: { kind: 'none' },
    ...over,
  };
}
