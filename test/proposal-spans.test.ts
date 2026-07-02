/**
 * test/proposal-spans.test.ts — proposal-lifecycle fleet spans (Pulse Map).
 *
 * Verifies the ADDITIVE telemetry wired into inbox/store.ts: every proposal
 * lifecycle transition (created / approved|applied → merge / rejected → decline)
 * emits the matching fleet span via emitFleetEvent, with METADATA ONLY payload
 * (proposal id as refId, repo BASENAME, status/origin as outcome) — and that
 * the whole thing is a NO-OP + NON-THROWING when the fleet→pulse round-trip is
 * unconfigured or the network/emit path fails.
 *
 * SAFETY GUARDRAILS asserted:
 *  - emitFleetEvent is mocked at the pulse-sync boundary → NO real network, NO
 *    real fetch, NO real OTLP export. Fully hermetic.
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/inbox is never touched.
 *  - Telemetry is fire-and-forget: a thrown/rejected emit NEVER breaks the
 *    proposal flow (createProposal / setStatus still return / persist normally).
 *  - Proposal SEMANTICS are unchanged: status transitions, decidedAt, and
 *    persistence behave exactly as before regardless of telemetry outcome.
 *
 * Mapping under test (lifecycleEvent in store.ts):
 *   create                       → event 'proposal', outcome = origin
 *   setStatus 'approved'         → event 'merge',    outcome 'approved'
 *   setStatus 'applied'          → event 'merge',    outcome 'applied'
 *   setStatus 'rejected'         → event 'decline',  outcome 'rejected'
 *   setStatus 'pending'/'awaiting-host-merge'/'failed'
 *                                → event 'proposal', outcome = status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Proposal } from '../src/core/types.js';
import type { FleetSpanInput } from '../src/core/integrations/pulse-exporter.js';

// ---------------------------------------------------------------------------
// Mock the fleet-span emit at the pulse-sync boundary. store.ts imports
// emitFleetEvent from here statically, so the spy intercepts every emit.
// Declared BEFORE importing the SUT so vitest hoists it into place.
// Default impl resolves false (simulating a gated / no-op emit) and never
// throws — individual tests override it.
// ---------------------------------------------------------------------------

vi.mock('../src/core/integrations/pulse-sync.js', () => ({
  emitFleetEvent: vi.fn(async () => false),
}));

// audit writes to ~/.ashlr; HOME isolation covers it, but mock to keep the
// test focused on span emission (and avoid any audit-side disk noise).
vi.mock('../src/core/sandbox/audit.js', () => ({
  audit: vi.fn(),
}));

import { emitFleetEvent } from '../src/core/integrations/pulse-sync.js';
import {
  createProposal,
  setStatus,
  loadProposal,
} from '../src/core/inbox/store.js';

const emitMock = vi.mocked(emitFleetEvent);

// ---------------------------------------------------------------------------
// HOME isolation — must wrap every test so the real inbox is never touched.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-prop-spans-home-'));
  process.env.HOME = tmpHome;
  emitMock.mockReset();
  emitMock.mockResolvedValue(false);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProposalInput = Omit<Proposal, 'id' | 'status' | 'createdAt'>;

function makeInput(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    repo: '/Users/dev/code/acme-widgets',
    origin: 'swarm',
    kind: 'patch',
    title: 'tighten input validation',
    summary: 'add a guard so empty payloads are rejected',
    ...over,
  } as ProposalInput;
}

/** The single span input passed to the most recent emitFleetEvent call. */
function lastSpan(): FleetSpanInput {
  expect(emitMock).toHaveBeenCalled();
  const call = emitMock.mock.calls[emitMock.mock.calls.length - 1];
  return call[1] as FleetSpanInput;
}

/** Allow detached fire-and-forget promises (.catch) to settle. */
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// (1) creation → 'proposal' span
// ---------------------------------------------------------------------------

describe('proposal creation emits a fleet span', () => {
  it("emits event 'proposal' with metadata-only payload (id, repo basename, origin)", () => {
    const p = createProposal(makeInput({ origin: 'agent' }));

    expect(emitMock).toHaveBeenCalledTimes(1);
    const span = lastSpan();
    expect(span.event).toBe('proposal');
    expect(span.refId).toBe(p.id);
    // outcome carries the origin so the cloud can show provenance.
    expect(span.outcome).toBe('agent');
    // repo is the BASENAME — never the absolute path (no parent dirs leak).
    expect(span.repo).toBe('acme-widgets');
    expect(span.repo).not.toContain('/');
  });

  it('passes owner through cfg.user so the cloud can attribute the span', () => {
    createProposal(makeInput(), { user: { id: 'mason@evero.com', name: 'Mason' } });
    expect(emitMock).toHaveBeenCalledTimes(1);
    const cfgArg = emitMock.mock.calls[0][0] as { user?: { id?: string } };
    expect(cfgArg.user?.id).toBe('mason@evero.com');
  });

  it('repo is null in the span when the proposal is not repo-scoped', () => {
    createProposal(makeInput({ repo: null }));
    expect(lastSpan().repo).toBeNull();
  });

  it('does NOT change creation semantics: status pending, id + createdAt set, persisted', () => {
    const p = createProposal(makeInput());
    expect(p.status).toBe('pending');
    expect(p.id).toMatch(/^prop-/);
    expect(p.createdAt).toBeTruthy();
    // Persisted to the isolated inbox.
    expect(loadProposal(p.id)?.id).toBe(p.id);
  });
});

// ---------------------------------------------------------------------------
// (2) setStatus → merge / decline / proposal spans
// ---------------------------------------------------------------------------

describe('setStatus emits the matching lifecycle span', () => {
  it("approved → event 'merge', outcome 'approved'", () => {
    const p = createProposal(makeInput());
    emitMock.mockClear();

    setStatus(p.id, 'approved', 'looks good');

    expect(emitMock).toHaveBeenCalledTimes(1);
    const span = lastSpan();
    expect(span.event).toBe('merge');
    expect(span.outcome).toBe('approved');
    expect(span.refId).toBe(p.id);
    expect(span.repo).toBe('acme-widgets');
  });

  it("applied → event 'merge', outcome 'applied'", () => {
    const p = createProposal(makeInput());
    emitMock.mockClear();
    setStatus(p.id, 'applied');
    const span = lastSpan();
    expect(span.event).toBe('merge');
    expect(span.outcome).toBe('applied');
  });

  it("awaiting-host-merge → event 'proposal', not 'merge'", () => {
    const p = createProposal(makeInput());
    emitMock.mockClear();
    setStatus(p.id, 'awaiting-host-merge');
    const span = lastSpan();
    expect(span.event).toBe('proposal');
    expect(span.outcome).toBe('awaiting-host-merge');
  });

  it("rejected → event 'decline', outcome 'rejected'", () => {
    const p = createProposal(makeInput());
    emitMock.mockClear();

    setStatus(p.id, 'rejected', 'not now');

    expect(emitMock).toHaveBeenCalledTimes(1);
    const span = lastSpan();
    expect(span.event).toBe('decline');
    expect(span.outcome).toBe('rejected');
  });

  it("other transitions (failed) → generic 'proposal' span with the status as outcome", () => {
    const p = createProposal(makeInput());
    emitMock.mockClear();
    setStatus(p.id, 'failed', 'apply error');
    const span = lastSpan();
    expect(span.event).toBe('proposal');
    expect(span.outcome).toBe('failed');
  });

  it('carries owner from the persisted proposal into the span cfg', () => {
    const p = createProposal(makeInput(), { user: { id: 'alex@evero.com' } });
    emitMock.mockClear();
    setStatus(p.id, 'approved');
    const cfgArg = emitMock.mock.calls[0][0] as { user?: { id?: string } };
    expect(cfgArg.user?.id).toBe('alex@evero.com');
  });

  it('does NOT change status semantics: persists new status + sets decidedAt', () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'approved', 'ok');
    const reloaded = loadProposal(p.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.decidedAt).toBeTruthy();
    expect(reloaded?.result).toBe('ok');
  });

  it('is a no-op (no span) when the proposal id does not exist', () => {
    setStatus('prop-does-not-exist', 'approved');
    expect(emitMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (3) NO-OP + NON-THROWING when unconfigured / on emit failure
// ---------------------------------------------------------------------------

describe('telemetry is best-effort: never breaks the proposal flow', () => {
  it('createProposal still returns normally when emitFleetEvent THROWS synchronously', () => {
    emitMock.mockImplementation(() => {
      throw new Error('boom (sync)');
    });
    let p: Proposal | undefined;
    expect(() => {
      p = createProposal(makeInput());
    }).not.toThrow();
    expect(p?.status).toBe('pending');
    expect(loadProposal(p!.id)?.id).toBe(p!.id);
  });

  it('createProposal still returns normally when emitFleetEvent REJECTS (network failure)', async () => {
    emitMock.mockRejectedValue(new Error('pulse unreachable'));
    let p: Proposal | undefined;
    expect(() => {
      p = createProposal(makeInput());
    }).not.toThrow();
    // Let the detached .catch settle — must not surface an unhandled rejection.
    await flush();
    expect(p?.status).toBe('pending');
  });

  it('setStatus still persists when emitFleetEvent REJECTS', async () => {
    const p = createProposal(makeInput());
    emitMock.mockRejectedValue(new Error('pulse down'));
    expect(() => setStatus(p.id, 'rejected', 'decline')).not.toThrow();
    await flush();
    expect(loadProposal(p.id)?.status).toBe('rejected');
  });

  it('emit returning false (gated / unconfigured opt-in) is a clean no-op for the flow', () => {
    emitMock.mockResolvedValue(false); // simulates pulseSyncEnabled === false
    const p = createProposal(makeInput());
    // store still attempts the (gated, no-op) emit exactly once...
    expect(emitMock).toHaveBeenCalledTimes(1);
    // ...and the proposal is created + persisted regardless.
    expect(p.status).toBe('pending');
    expect(loadProposal(p.id)?.id).toBe(p.id);
  });
});
