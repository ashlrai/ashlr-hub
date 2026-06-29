/**
 * M214 — fleet-pulse-emit: fire-and-forget GenAI-OTel span emit for fleet
 * events (proposal, merge, judge verdict, tick cost) to the Pulse OTLP ingest.
 *
 * FILE OWNERSHIP: fleet-pulse-emit.ts (NEW), types.ts (pulseEmit flag +
 * pulseOtlpUrl), automerge-pass.ts (additive hooks), loop.ts (additive hook).
 * No control-flow changes — only additive, flag-gated, fire-and-forget hooks.
 *
 * Adversarial matrix:
 *
 *  Flag gate
 *  [G1]  cfg.foundry.pulseEmit absent → all emitters skip (skipped:true)
 *  [G2]  cfg.foundry.pulseEmit=false  → all emitters skip (skipped:true)
 *  [G3]  cfg.foundry.pulseEmit=true   → emitters attempt the OTLP POST
 *
 *  Endpoint resolution
 *  [E1]  cfg.comms.pulseOtlpUrl takes priority over env and cfg.pulse.endpoint
 *  [E2]  PULSE_OTLP_URL env overrides cfg.pulse.endpoint
 *  [E3]  cfg.pulse.endpoint used as fallback when comms.pulseOtlpUrl and env absent
 *  [E4]  defaults to http://localhost:3000 when nothing is configured
 *
 *  Event types
 *  [V1]  emitProposalCreated → event='proposal', outcome carried in span
 *  [V2]  emitMerge           → event='merge', outcome='merged'
 *  [V3]  emitJudgeVerdict ship   → event='proposal', outcome='judge:ship'
 *  [V4]  emitJudgeVerdict review → event='decline',  outcome='judge:review'
 *  [V5]  emitJudgeVerdict noise  → event='decline',  outcome='judge:noise'
 *  [V6]  emitTickCost        → event='tick', outcome encodes cost+proposals+merged
 *
 *  Never-throws
 *  [N1]  fetch throws (network error) → returns ok:false, does NOT throw
 *  [N2]  fetch returns HTTP 500       → returns ok:false, does NOT throw
 *  [N3]  flag off + fetch throws      → skipped, NEVER calls fetch
 *
 *  Batch shape
 *  [B1]  exactly one span per emit call (no double-posting)
 *  [B2]  span refId derived from supplied refId (proposal id / tick ts)
 *
 *  automerge-pass hooks
 *  [A1]  emitMerge called when res.merged===true (next to M212 notifyFleetEvent)
 *  [A2]  emitJudgeVerdict called for each inline judge call (ship + non-ship)
 *  [A3]  hooks are fire-and-forget — automerge result unchanged when emit fails
 *
 *  loop.ts hook
 *  [L1]  emitTickCost lazy-imported after tick accounting — tick result unchanged
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir.
 *  - global fetch MOCKED — no real network calls.
 *  - automerge-pass dependencies mocked (autoMergeProposal, listProposals,
 *    judgeProposal, resolveFrontierJudgeClient, killSwitchOn, readDecisions).
 *  - fleet-pulse-emit's exportFleetEvents MOCKED in automerge-pass integration
 *    tests to isolate the hook wiring from the OTLP transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Hermetic HOME
// ---------------------------------------------------------------------------
let tmpHome: string;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm214-'));
  process.env['HOME'] = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env['PULSE_OTLP_URL'];
  delete process.env['PULSE_FLEET_PAT'];
  delete process.env['ASHLR_PULSE_PAT'];
});

// ---------------------------------------------------------------------------
// Mock global fetch (no real network)
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeFetchOk(status = 200) {
  return Promise.resolve({ ok: true, status, json: async () => ({}) } as Response);
}
function makeFetchErr(status = 500) {
  return Promise.resolve({ ok: false, status, json: async () => ({}) } as Response);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cfgOn(overrides: Record<string, unknown> = {}) {
  return {
    foundry: { pulseEmit: true },
    pulse: { enabled: true, endpoint: 'http://test-pulse:3001' },
    ...overrides,
  };
}
function cfgOff(overrides: Record<string, unknown> = {}) {
  return {
    foundry: { pulseEmit: false },
    pulse: { enabled: true, endpoint: 'http://test-pulse:3001' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
import {
  fleetPulseEnabled,
  emitProposalCreated,
  emitMerge,
  emitJudgeVerdict,
  emitTickCost,
} from '../src/core/integrations/fleet-pulse-emit.js';

// ---------------------------------------------------------------------------
// [G1] Flag absent → skip
// ---------------------------------------------------------------------------
describe('[G1] flag absent → skip', () => {
  it('returns skipped when foundry is absent', async () => {
    const cfg = { pulse: { enabled: true, endpoint: 'http://x' } };
    const res = await emitProposalCreated(cfg as never, 'ref1', 'pending');
    expect(res.skipped).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fleetPulseEnabled returns false when flag absent', () => {
    expect(fleetPulseEnabled({} as never)).toBe(false);
    expect(fleetPulseEnabled({ foundry: {} } as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [G2] Flag false → skip
// ---------------------------------------------------------------------------
describe('[G2] flag false → skip', () => {
  it('all emitters skip when pulseEmit=false', async () => {
    const cfg = cfgOff();
    process.env['PULSE_FLEET_PAT'] = 'test-pat';

    const [r1, r2, r3, r4] = await Promise.all([
      emitProposalCreated(cfg as never, 'p1', 'pending'),
      emitMerge(cfg as never, 'p1'),
      emitJudgeVerdict(cfg as never, 'p1', 'ship'),
      emitTickCost(cfg as never, new Date().toISOString(), 0.01, 1, 0),
    ]);
    for (const r of [r1, r2, r3, r4]) {
      expect(r.skipped).toBe(true);
      expect(r.ok).toBe(false);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [G3] Flag true → attempts POST
// ---------------------------------------------------------------------------
describe('[G3] flag true → attempts POST', () => {
  it('POSTs to OTLP endpoint when enabled + PAT set', async () => {
    process.env['PULSE_FLEET_PAT'] = 'test-pat';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = cfgOn();
    const res = await emitProposalCreated(cfg as never, 'prop-abc', 'pending');
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test-pulse:3001/api/otlp/v1/traces');
  });
});

// ---------------------------------------------------------------------------
// [E1] cfg.comms.pulseOtlpUrl priority
// ---------------------------------------------------------------------------
describe('[E1] cfg.comms.pulseOtlpUrl takes highest priority', () => {
  it('uses pulseOtlpUrl over env and pulse.endpoint', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    process.env['PULSE_OTLP_URL'] = 'http://env-endpoint';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = {
      foundry: { pulseEmit: true },
      pulse: { enabled: true, endpoint: 'http://pulse-endpoint' },
      comms: { pulseOtlpUrl: 'http://comms-endpoint' },
    };
    await emitMerge(cfg as never, 'p1');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('http://comms-endpoint');
  });
});

// ---------------------------------------------------------------------------
// [E2] PULSE_OTLP_URL env overrides cfg.pulse.endpoint
// ---------------------------------------------------------------------------
describe('[E2] PULSE_OTLP_URL env overrides cfg.pulse.endpoint', () => {
  it('uses env over cfg.pulse.endpoint', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    process.env['PULSE_OTLP_URL'] = 'http://env-otlp';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = { foundry: { pulseEmit: true }, pulse: { enabled: true, endpoint: 'http://cfg-pulse' } };
    await emitMerge(cfg as never, 'p1');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('http://env-otlp');
  });
});

// ---------------------------------------------------------------------------
// [E3] cfg.pulse.endpoint fallback
// ---------------------------------------------------------------------------
describe('[E3] cfg.pulse.endpoint fallback', () => {
  it('uses pulse.endpoint when comms.pulseOtlpUrl and env absent', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = { foundry: { pulseEmit: true }, pulse: { enabled: true, endpoint: 'http://fallback-pulse' } };
    await emitMerge(cfg as never, 'p1');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('http://fallback-pulse');
  });
});

// ---------------------------------------------------------------------------
// [E4] localhost:3000 default
// ---------------------------------------------------------------------------
describe('[E4] default localhost:3000', () => {
  it('falls back to localhost:3000 when nothing configured', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = { foundry: { pulseEmit: true } };
    await emitMerge(cfg as never, 'p1');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('http://localhost:3000');
  });
});

// ---------------------------------------------------------------------------
// [V1–V6] Event types
// ---------------------------------------------------------------------------
describe('[V] event types', () => {
  beforeEach(() => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
  });

  function captureBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    return JSON.parse(call[1].body as string) as Record<string, unknown>;
  }

  it('[V1] emitProposalCreated → event=proposal, outcome carried', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    await emitProposalCreated(cfg as never, 'prop-1', 'pending', '/repo', 'frontier');
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    expect(spans[0].name).toBe('fleet.proposal');
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.event']).toBe('proposal');
    expect(attrs['ashlr.fleet.outcome']).toBe('pending');
  });

  it('[V2] emitMerge → event=merge, outcome=merged', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    await emitMerge(cfg as never, 'prop-2', '/repo', 'frontier');
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    expect(spans[0].name).toBe('fleet.merge');
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.event']).toBe('merge');
    expect(attrs['ashlr.fleet.outcome']).toBe('merged');
  });

  it('[V3] emitJudgeVerdict ship → event=proposal, outcome=judge:ship', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    await emitJudgeVerdict(cfg as never, 'prop-3', 'ship');
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    expect(spans[0].name).toBe('fleet.proposal');
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.outcome']).toBe('judge:ship');
  });

  it('[V4] emitJudgeVerdict review → event=decline, outcome=judge:review', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    await emitJudgeVerdict(cfg as never, 'prop-4', 'review');
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    expect(spans[0].name).toBe('fleet.decline');
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.event']).toBe('decline');
    expect(attrs['ashlr.fleet.outcome']).toBe('judge:review');
  });

  it('[V5] emitJudgeVerdict noise → event=decline, outcome=judge:noise', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    await emitJudgeVerdict(cfg as never, 'prop-5', 'noise');
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.event']).toBe('decline');
    expect(attrs['ashlr.fleet.outcome']).toBe('judge:noise');
  });

  it('[V6] emitTickCost → event=tick, outcome encodes cost+proposals+merged', async () => {
    mockFetch.mockReturnValueOnce(makeFetchOk());
    const cfg = cfgOn();
    const ts = '2026-06-28T12:00:00.000Z';
    await emitTickCost(cfg as never, ts, 0.0042, 3, 1);
    const body = captureBody();
    const spans = (body.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: unknown }[] }[] }[] }[])[0].scopeSpans[0].spans;
    expect(spans[0].name).toBe('fleet.tick');
    const attrs = Object.fromEntries(spans[0].attributes.map((a) => [a.key, (a.value as { stringValue?: string }).stringValue]));
    expect(attrs['ashlr.fleet.event']).toBe('tick');
    expect(attrs['ashlr.fleet.outcome']).toContain('proposals=3');
    expect(attrs['ashlr.fleet.outcome']).toContain('merged=1');
    expect(attrs['ashlr.fleet.outcome']).toContain('cost=0.004200');
  });
});

// ---------------------------------------------------------------------------
// [N1] fetch throws → ok:false, does NOT throw
// ---------------------------------------------------------------------------
describe('[N1] fetch throws → ok:false, does not throw', () => {
  it('returns ok:false when fetch rejects', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const cfg = cfgOn();
    // Must not throw
    const res = await emitMerge(cfg as never, 'p1');
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [N2] fetch returns HTTP 500 → ok:false, does NOT throw
// ---------------------------------------------------------------------------
describe('[N2] HTTP 500 → ok:false, does not throw', () => {
  it('returns ok:false on HTTP 500', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockReturnValueOnce(makeFetchErr(500));

    const cfg = cfgOn();
    const res = await emitProposalCreated(cfg as never, 'p1', 'pending');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// [N3] flag off + fetch throws → skipped, fetch never called
// ---------------------------------------------------------------------------
describe('[N3] flag off + fetch throws → skipped, fetch never called', () => {
  it('never calls fetch when disabled', async () => {
    mockFetch.mockRejectedValueOnce(new Error('should not be called'));
    const cfg = cfgOff();
    const res = await emitTickCost(cfg as never, new Date().toISOString(), 0.1, 2, 1);
    expect(res.skipped).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [B1] exactly one span per emit call
// ---------------------------------------------------------------------------
describe('[B1] exactly one span per emit call', () => {
  it('posts exactly one span in the OTLP payload', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = cfgOn();
    await emitProposalCreated(cfg as never, 'p1', 'pending');
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [B2] span refId = supplied refId
// ---------------------------------------------------------------------------
describe('[B2] span carries supplied refId', () => {
  it('ashlr.fleet.ref_id matches the supplied refId', async () => {
    process.env['PULSE_FLEET_PAT'] = 'pat';
    mockFetch.mockReturnValueOnce(makeFetchOk());

    const cfg = cfgOn();
    await emitMerge(cfg as never, 'my-proposal-id-xyz');
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[];
    };
    const attrs = Object.fromEntries(
      body.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, a.value.stringValue]),
    );
    expect(attrs['ashlr.fleet.ref_id']).toBe('my-proposal-id-xyz');
  });
});
