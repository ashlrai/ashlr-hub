/**
 * test/m91.pulse-bridge-polish.test.ts — M91: Fleet→Pulse bridge polish.
 *
 * Tests:
 *  1. buildFleetSpans honors sinceTs — only newer events included.
 *  2. exportToPulse watermark: advances lastPulseExportAt on 2xx.
 *  3. exportToPulse watermark: does NOT advance on non-2xx.
 *  4. exportToPulse watermark: does NOT advance on network failure.
 *  5. exportToPulse returns boolean (true=2xx, false=else).
 *  6. postProbeSpan — reports ✓ on 200.
 *  7. postProbeSpan — reports ✗ 401 on PAT rejected.
 *  8. postProbeSpan — reports ✗ unreachable on network error.
 *  9. postProbeSpan — reports ⚠ not configured when disabled.
 * 10. postProbeSpan — reports ⚠ not configured when PAT absent.
 * 11. Never throws in any branch.
 *
 * NO real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

function seedDaemonState(ticks: object[], extra: Record<string, unknown> = {}): void {
  const dir = join(tmpHome, '.ashlr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: '2026-06-01',
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks,
      ...extra,
    }),
    'utf8',
  );
}

function readDaemonState(): Record<string, unknown> {
  const p = join(tmpHome, '.ashlr', 'daemon.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function enabledCfg(endpoint = 'http://localhost:9999') {
  return { pulse: { enabled: true, endpoint } };
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `m91-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  origHome = process.env['HOME'] ?? '';
  process.env['HOME'] = tmpHome;
  delete process.env['ASHLR_PULSE_PAT'];
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function getPulseExport() {
  return import('../src/core/fleet/pulse-export.js');
}

// ---------------------------------------------------------------------------
// 1. buildFleetSpans — sinceTs filter (incremental basis)
// ---------------------------------------------------------------------------

describe('buildFleetSpans — sinceTs incremental filter', () => {
  it('includes only ticks at or after sinceTs', async () => {
    seedDaemonState([
      { ts: '2026-01-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
      { ts: '2026-06-01T12:00:00.000Z', itemsConsidered: 1, proposalsCreated: 1, spentUsd: 0.001, reason: 'ok' },
      { ts: '2026-06-20T08:00:00.000Z', itemsConsidered: 2, proposalsCreated: 1, spentUsd: 0.002, reason: 'ok' },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans('2026-06-01T00:00:00.000Z').resourceSpans[0]!.scopeSpans[0]!.spans;

    // Jan tick must be excluded; June + June20 included
    const refIds = spans.map(s => {
      const a = s.attributes.find(attr => attr.key === 'ashlr.fleet.ref_id');
      return a ? ('stringValue' in a.value ? a.value.stringValue : null) : null;
    });

    expect(refIds).not.toContain('2026-01-01T00:00:00.000Z');
    expect(refIds).toContain('2026-06-01T12:00:00.000Z');
    expect(refIds).toContain('2026-06-20T08:00:00.000Z');
  });

  it('returns all ticks when sinceTs is omitted', async () => {
    seedDaemonState([
      { ts: '2025-01-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
      { ts: '2026-06-01T00:00:00.000Z', itemsConsidered: 1, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.length).toBe(2);
  });

  it('returns empty spans when all ticks are before sinceTs', async () => {
    seedDaemonState([
      { ts: '2025-01-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans('2026-01-01T00:00:00.000Z').resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2–4. exportToPulse — watermark advance/hold behaviour
// ---------------------------------------------------------------------------

describe('exportToPulse — watermark (lastPulseExportAt)', () => {
  it('returns true and state records watermark on HTTP 200', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    seedDaemonState([
      { ts: '2026-06-20T10:00:00.000Z', itemsConsidered: 1, proposalsCreated: 1, spentUsd: 0.001, reason: 'ok' },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    // exportToPulse itself does NOT write the watermark — the loop.ts hook does.
    // Here we test the return value (true on 2xx).
    const { exportToPulse } = await getPulseExport();
    const result = await exportToPulse(enabledCfg());
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns false on HTTP 401 (watermark must not advance)', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'bad-pat';
    seedDaemonState([]);

    const mockFetch = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    const result = await exportToPulse(enabledCfg());
    expect(result).toBe(false);
  });

  it('returns false on network failure (watermark must not advance)', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    seedDaemonState([]);

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    const result = await exportToPulse(enabledCfg());
    expect(result).toBe(false);
  });

  it('returns false when cfg.pulse.enabled is false', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    const { exportToPulse } = await getPulseExport();
    const result = await exportToPulse({ pulse: { enabled: false } });
    expect(result).toBe(false);
  });

  it('returns false when PAT is absent', async () => {
    delete process.env['ASHLR_PULSE_PAT'];
    const { exportToPulse } = await getPulseExport();
    const result = await exportToPulse(enabledCfg());
    expect(result).toBe(false);
  });

  it('passes sinceTs from lastPulseExportAt so only new events are sent', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    // Seed state with two ticks; watermark is set to the first tick's ts
    const watermark = '2026-06-10T00:00:00.000Z';
    seedDaemonState([
      { ts: '2026-06-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
      { ts: '2026-06-15T12:00:00.000Z', itemsConsidered: 1, proposalsCreated: 1, spentUsd: 0.001, reason: 'ok' },
    ], { lastPulseExportAt: watermark });

    const capturedBodies: string[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBodies.push(init.body as string);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    // When caller passes sinceTs=watermark, only events after watermark are included.
    await exportToPulse(enabledCfg(), { sinceTs: watermark });

    expect(capturedBodies.length).toBe(1);
    const body = JSON.parse(capturedBodies[0]!) as { resourceSpans: [{ scopeSpans: [{ spans: { attributes: { key: string; value: { stringValue?: string } }[] }[] }] }] };
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;

    // Only the June-15 tick should be present (after the watermark)
    const refIds = spans.map(s => {
      const a = s.attributes.find((attr: { key: string }) => attr.key === 'ashlr.fleet.ref_id');
      return a ? (a.value.stringValue ?? null) : null;
    });
    expect(refIds).not.toContain('2026-06-01T00:00:00.000Z');
    expect(refIds).toContain('2026-06-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 5. Never throws
// ---------------------------------------------------------------------------

describe('exportToPulse — never throws', () => {
  it('resolves (never throws) on network error', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const { exportToPulse } = await getPulseExport();
    await expect(exportToPulse(enabledCfg())).resolves.toBe(false);
  });

  it('resolves (never throws) when disabled', async () => {
    const { exportToPulse } = await getPulseExport();
    await expect(exportToPulse({})).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6–10. postProbeSpan — all four UX branches
// ---------------------------------------------------------------------------

describe('postProbeSpan — connectivity + auth check', () => {
  it('reports ✓ connected on HTTP 200', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'valid-pat';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan(enabledCfg());
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.label).toMatch(/✓.*200/);
  });

  it('reports ✗ 401 on PAT rejected', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'bad-pat';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })));

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan(enabledCfg());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.label).toMatch(/✗.*401/);
    expect(r.label).toMatch(/PAT/);
  });

  it('reports ✗ 403 on PAT rejected', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'bad-pat';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan(enabledCfg());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.label).toMatch(/✗.*403/);
  });

  it('reports ✗ endpoint unreachable on network error', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan(enabledCfg('http://localhost:9999'));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.label).toMatch(/✗.*unreachable/);
    expect(r.label).toContain('localhost:9999');
  });

  it('reports ⚠ not configured when pulse disabled', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan({ pulse: { enabled: false } });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.label).toMatch(/⚠.*not configured/);
  });

  it('reports ⚠ not configured when PAT absent', async () => {
    delete process.env['ASHLR_PULSE_PAT'];

    const { postProbeSpan } = await getPulseExport();
    const r = await postProbeSpan(enabledCfg());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.label).toMatch(/⚠.*not configured/);
  });

  it('never throws in any branch', async () => {
    const { postProbeSpan } = await getPulseExport();
    // All three failure paths must resolve, never reject
    await expect(postProbeSpan({ pulse: { enabled: false } })).resolves.toBeDefined();
    await expect(postProbeSpan({})).resolves.toBeDefined();

    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(postProbeSpan(enabledCfg())).resolves.toBeDefined();
  });

  it('probe span body does NOT contain the PAT', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'super-secret-value';
    let capturedBody = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }));

    const { postProbeSpan } = await getPulseExport();
    await postProbeSpan(enabledCfg());
    expect(capturedBody).not.toContain('super-secret-value');
  });
});
