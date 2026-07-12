/**
 * test/m115.pulse-sync.test.ts — pulse-sync.ts (Phase H fleet round-trip).
 *
 * Focused unit coverage of the LOCAL orchestrator that makes
 * "cloud orchestrates, local executes" live. We mock BOTH the exporter
 * (network boundary) AND the four local executors so the test is fully
 * hermetic — NO real server, NO real disk writes, NO real git.
 *
 * Coverage:
 *  (a) ENV GATE — runPulseSync / pollAndApplyCommands / shipEnrolledRepoDeps /
 *      emitTick are a complete NO-OP when PULSE_URL/PAT are unset. The exporter
 *      (network) is never touched.
 *  (b) DISPATCH — given a mocked pending command list, each kind routes to the
 *      right LOCAL handler:
 *        assign_goal      → createGoal (goals/store)
 *        approve_proposal → setStatus 'approved' (inbox/store)
 *        reject_proposal  → setStatus 'rejected' (inbox/store)
 *        enroll_repo      → enroll (sandbox/policy)
 *      …and each applied command PATCHes its status back (done / failed).
 *  (c) NEVER THROWS — a simulated Pulse HTTP failure (poll rejects, claim
 *      rejects, patch rejects) is swallowed; every public fn resolves.
 *
 * The network is mocked at the exporter surface (pulse-exporter.js), so no
 * fetch / real endpoint is ever hit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { FleetCommand } from '../src/core/integrations/pulse-exporter.js';

// ---------------------------------------------------------------------------
// Module mocks — exporter (network) + four local executors + side modules.
// Declared BEFORE importing the SUT so vitest hoists them into place.
// ---------------------------------------------------------------------------

vi.mock('../src/core/integrations/pulse-exporter.js', () => ({
  exportFleetEvents: vi.fn(async () => ({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' })),
  shipDepEdges: vi.fn(async () => ({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' })),
  pollFleetCommands: vi.fn(async () => ({ ok: true, skipped: false, commands: [], status: 200, detail: 'ok' })),
  patchFleetCommand: vi.fn(async () => ({ ok: true, skipped: false, status: 200, detail: 'ok' })),
  claimFleetCommand: vi.fn(async () => ({ ok: true, skipped: false, status: 200, detail: 'ok' })),
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: vi.fn((objective: string) => ({ id: `goal-${objective.slice(0, 4)}`, objective })),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  setStatus: vi.fn(),
  loadProposal: vi.fn((id: string) => ({ id, status: 'pending' })),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  enroll: vi.fn(),
  listEnrolled: vi.fn(() => []),
}));

vi.mock('../src/core/integrations/github.js', () => ({
  githubStatus: vi.fn(() => ({ repo: null })),
}));

vi.mock('../src/core/sandbox/audit.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../src/core/integrations/dep-parser.js', () => ({
  parseRepoDeps: vi.fn(() => ({ repoRef: 'x/y', edges: [] })),
}));

// Typed handles on the mocked dependencies (after the mocks above).
import * as exporter from '../src/core/integrations/pulse-exporter.js';
import * as goals from '../src/core/goals/store.js';
import * as inbox from '../src/core/inbox/store.js';
import * as policy from '../src/core/sandbox/policy.js';

// System under test.
import {
  pulseSyncEnabled,
  runPulseSync,
  pollAndApplyCommands,
  shipEnrolledRepoDeps,
  emitTick,
} from '../src/core/integrations/pulse-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cfg: AshlrConfig = { user: { id: 'mason', name: 'Mason' } } as AshlrConfig;

/** Build a fully-shaped FleetCommand for dispatch tests. */
function cmd(over: Partial<FleetCommand>): FleetCommand {
  return {
    id: 'cmd-1',
    orgId: 'org-1',
    kind: 'assign_goal',
    target: null,
    payload: {},
    status: 'pending',
    createdBy: null,
    claimedBy: null,
    result: null,
    error: null,
    createdAt: '2026-06-25T00:00:00.000Z',
    claimedAt: null,
    completedAt: null,
    ...over,
  };
}

const PULSE_ENV = ['PULSE_URL', 'PULSE_FLEET_PAT', 'ASHLR_PULSE_PAT', 'ASHLR_PULSE_READ_PAT'] as const;

/** Configure the env so pulseSyncEnabled(cfg) is TRUE. */
function enablePulse(): void {
  process.env['PULSE_URL'] = 'http://localhost:9999';
  process.env['PULSE_FLEET_PAT'] = 'test-pat';
}

/** Have the poller return the given commands (each claim succeeds). */
function queueCommands(commands: FleetCommand[]): void {
  vi.mocked(exporter.pollFleetCommands).mockResolvedValue({
    ok: true, skipped: false, commands, status: 200, detail: `fetched ${commands.length}`,
  });
  vi.mocked(exporter.claimFleetCommand).mockResolvedValue({
    ok: true, skipped: false, status: 200, detail: 'claimed',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of PULSE_ENV) delete process.env[k];
  // Restore default mock return values cleared by clearAllMocks().
  vi.mocked(exporter.pollFleetCommands).mockResolvedValue({ ok: true, skipped: false, commands: [], status: 200, detail: 'ok' });
  vi.mocked(exporter.claimFleetCommand).mockResolvedValue({ ok: true, skipped: false, status: 200, detail: 'ok' });
  vi.mocked(exporter.patchFleetCommand).mockResolvedValue({ ok: true, skipped: false, status: 200, detail: 'ok' });
  vi.mocked(exporter.exportFleetEvents).mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' });
  vi.mocked(exporter.shipDepEdges).mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' });
  vi.mocked(inbox.loadProposal).mockReturnValue({ id: 'p', status: 'pending' } as ReturnType<typeof inbox.loadProposal>);
  vi.mocked(policy.listEnrolled).mockReturnValue([]);
});

afterEach(() => {
  for (const k of PULSE_ENV) delete process.env[k];
});

// ---------------------------------------------------------------------------
// (a) ENV GATE — complete no-op when PULSE_URL / PAT unset
// ---------------------------------------------------------------------------

describe('pulse-sync — env gate (no-op when unconfigured)', () => {
  it('pulseSyncEnabled is false when neither endpoint nor PAT is set', () => {
    expect(pulseSyncEnabled(cfg)).toBe(false);
  });

  it('pulseSyncEnabled is false when only the endpoint is set (no PAT)', () => {
    process.env['PULSE_URL'] = 'http://localhost:9999';
    expect(pulseSyncEnabled(cfg)).toBe(false);
  });

  it('pulseSyncEnabled is false when only a PAT is set (no endpoint / opt-in)', () => {
    process.env['PULSE_FLEET_PAT'] = 'test-pat';
    expect(pulseSyncEnabled(cfg)).toBe(false);
  });

  it('pulseSyncEnabled is true once both PULSE_URL and a PAT are present', () => {
    enablePulse();
    expect(pulseSyncEnabled(cfg)).toBe(true);
  });

  it('runPulseSync returns { enabled:false } and touches NOTHING when unset', async () => {
    const res = await runPulseSync(cfg);
    expect(res.enabled).toBe(false);
    expect(res.tickEmitted).toBe(false);
    expect(res.commands).toEqual([]);
    expect(res.depEdgesShipped).toBe(0);
    // The exporter (network) is never invoked when the gate is closed.
    expect(exporter.exportFleetEvents).not.toHaveBeenCalled();
    expect(exporter.pollFleetCommands).not.toHaveBeenCalled();
    expect(exporter.shipDepEdges).not.toHaveBeenCalled();
  });

  it('pollAndApplyCommands / shipEnrolledRepoDeps / emitTick are no-ops when unset', async () => {
    expect(await pollAndApplyCommands(cfg)).toEqual([]);
    expect(await shipEnrolledRepoDeps(cfg)).toBe(0);
    expect(await emitTick(cfg, '2026-06-25T00:00:00.000Z')).toBe(false);
    expect(exporter.pollFleetCommands).not.toHaveBeenCalled();
    expect(exporter.shipDepEdges).not.toHaveBeenCalled();
    expect(exporter.exportFleetEvents).not.toHaveBeenCalled();
    // No local executor runs either.
    expect(goals.createGoal).not.toHaveBeenCalled();
    expect(inbox.setStatus).not.toHaveBeenCalled();
    expect(policy.enroll).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) DISPATCH — each command kind → right handler + status writeback
// ---------------------------------------------------------------------------

describe('pulse-sync — command dispatch (cloud queues → local executes)', () => {
  beforeEach(enablePulse);

  it('assign_goal → createGoal (goals/store) + PATCH status=done', async () => {
    queueCommands([cmd({ id: 'g1', kind: 'assign_goal', payload: { objective: 'ship the map', project: '/repo/x' } })]);

    const out = await pollAndApplyCommands(cfg);

    expect(goals.createGoal).toHaveBeenCalledTimes(1);
    expect(goals.createGoal).toHaveBeenCalledWith('ship the map', expect.objectContaining({ project: '/repo/x' }));
    expect(inbox.setStatus).not.toHaveBeenCalled();
    expect(policy.enroll).not.toHaveBeenCalled();

    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('done');
    expect(out[0]!.kind).toBe('assign_goal');

    // Claimed first, then PATCHed done.
    expect(exporter.claimFleetCommand).toHaveBeenCalledWith(expect.anything(), 'g1', expect.any(String), expect.anything());
    expect(exporter.patchFleetCommand).toHaveBeenCalledWith(
      expect.anything(),
      'g1',
      expect.objectContaining({ status: 'done' }),
      expect.anything(),
    );
  });

  it('approve_proposal → setStatus(approved) (inbox/store) + PATCH done', async () => {
    queueCommands([cmd({ id: 'a1', kind: 'approve_proposal', target: 'prop-42' })]);

    const out = await pollAndApplyCommands(cfg);

    expect(inbox.loadProposal).toHaveBeenCalledWith('prop-42');
    expect(inbox.setStatus).toHaveBeenCalledWith('prop-42', 'approved', expect.any(String));
    expect(goals.createGoal).not.toHaveBeenCalled();
    expect(policy.enroll).not.toHaveBeenCalled();
    expect(out[0]!.outcome).toBe('done');
    expect(exporter.patchFleetCommand).toHaveBeenCalledWith(
      expect.anything(), 'a1', expect.objectContaining({ status: 'done' }), expect.anything(),
    );
  });

  it('reject_proposal → setStatus(rejected) (inbox/store) + PATCH done', async () => {
    queueCommands([cmd({ id: 'r1', kind: 'reject_proposal', payload: { proposalId: 'prop-99' } })]);

    const out = await pollAndApplyCommands(cfg);

    expect(inbox.setStatus).toHaveBeenCalledWith('prop-99', 'rejected', expect.any(String));
    expect(out[0]!.outcome).toBe('done');
  });

  it('reject_proposal reports failed when recovery revocation blocks the status transition', async () => {
    queueCommands([cmd({ id: 'r-blocked', kind: 'reject_proposal', target: 'prop-blocked' })]);
    vi.mocked(inbox.setStatus).mockReturnValueOnce(false);

    const out = await pollAndApplyCommands(cfg);

    expect(out[0]).toMatchObject({ outcome: 'failed' });
    expect(exporter.patchFleetCommand).toHaveBeenCalledWith(
      expect.anything(),
      'r-blocked',
      expect.objectContaining({ status: 'failed' }),
      expect.anything(),
    );
  });

  it('enroll_repo → enroll (sandbox/policy) + PATCH done', async () => {
    queueCommands([cmd({ id: 'e1', kind: 'enroll_repo', payload: { path: '/repo/new' } })]);

    const out = await pollAndApplyCommands(cfg);

    expect(policy.enroll).toHaveBeenCalledWith('/repo/new');
    expect(goals.createGoal).not.toHaveBeenCalled();
    expect(inbox.setStatus).not.toHaveBeenCalled();
    expect(out[0]!.outcome).toBe('done');
    expect(exporter.patchFleetCommand).toHaveBeenCalledWith(
      expect.anything(), 'e1', expect.objectContaining({ status: 'done' }), expect.anything(),
    );
  });

  it('a missing proposal (loadProposal → null) fails and PATCHes status=failed', async () => {
    vi.mocked(inbox.loadProposal).mockReturnValue(null);
    queueCommands([cmd({ id: 'a2', kind: 'approve_proposal', target: 'gone' })]);

    const out = await pollAndApplyCommands(cfg);

    expect(inbox.setStatus).not.toHaveBeenCalled();
    expect(out[0]!.outcome).toBe('failed');
    expect(exporter.patchFleetCommand).toHaveBeenCalledWith(
      expect.anything(), 'a2', expect.objectContaining({ status: 'failed' }), expect.anything(),
    );
  });

  it('a command claimed by another machine (claim !ok) is skipped — not executed', async () => {
    queueCommands([cmd({ id: 'sk', kind: 'enroll_repo', payload: { path: '/repo/raced' } })]);
    vi.mocked(exporter.claimFleetCommand).mockResolvedValue({ ok: false, skipped: false, status: 409, detail: 'claimed elsewhere' });

    const out = await pollAndApplyCommands(cfg);

    expect(policy.enroll).not.toHaveBeenCalled();
    expect(out[0]!.outcome).toBe('skipped');
    // No writeback for a command we never executed.
    expect(exporter.patchFleetCommand).not.toHaveBeenCalled();
  });

  it('dispatches a MIXED batch — one of each kind — to the right handlers', async () => {
    queueCommands([
      cmd({ id: 'm-g', kind: 'assign_goal', payload: { objective: 'do X' } }),
      cmd({ id: 'm-a', kind: 'approve_proposal', target: 'p-a' }),
      cmd({ id: 'm-r', kind: 'reject_proposal', target: 'p-r' }),
      cmd({ id: 'm-e', kind: 'enroll_repo', payload: { path: '/r' } }),
    ]);

    const out = await pollAndApplyCommands(cfg);

    expect(goals.createGoal).toHaveBeenCalledTimes(1);
    expect(inbox.setStatus).toHaveBeenCalledTimes(2);
    expect(inbox.setStatus).toHaveBeenCalledWith('p-a', 'approved', expect.any(String));
    expect(inbox.setStatus).toHaveBeenCalledWith('p-r', 'rejected', expect.any(String));
    expect(policy.enroll).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.outcome)).toEqual(['done', 'done', 'done', 'done']);
    expect(exporter.patchFleetCommand).toHaveBeenCalledTimes(4);
  });

  it('runPulseSync wires the full round-trip: tick + commands + deps', async () => {
    queueCommands([cmd({ id: 'rt', kind: 'enroll_repo', payload: { path: '/r' } })]);

    const res = await runPulseSync(cfg, { tickTs: '2026-06-25T01:00:00.000Z' });

    expect(res.enabled).toBe(true);
    expect(res.tickEmitted).toBe(true);
    expect(exporter.exportFleetEvents).toHaveBeenCalled(); // tick heartbeat
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]!.outcome).toBe('done');
    expect(policy.enroll).toHaveBeenCalledWith('/r');
  });
});

// ---------------------------------------------------------------------------
// (c) NEVER THROWS on a simulated Pulse HTTP failure (best-effort)
// ---------------------------------------------------------------------------

describe('pulse-sync — never throws on Pulse failure (best-effort)', () => {
  beforeEach(enablePulse);

  it('runPulseSync resolves even when the poller throws (simulated HTTP error)', async () => {
    vi.mocked(exporter.exportFleetEvents).mockRejectedValue(new Error('ECONNREFUSED'));
    vi.mocked(exporter.pollFleetCommands).mockRejectedValue(new Error('500 from Pulse'));
    vi.mocked(exporter.shipDepEdges).mockRejectedValue(new Error('boom'));

    const res = await runPulseSync(cfg);
    // Still enabled, still returns a typed result — no throw.
    expect(res.enabled).toBe(true);
    expect(res.tickEmitted).toBe(false);
    expect(res.commands).toEqual([]);
    expect(res.depEdgesShipped).toBe(0);
  });

  it('pollAndApplyCommands resolves [] when poll rejects', async () => {
    vi.mocked(exporter.pollFleetCommands).mockRejectedValue(new Error('network down'));
    await expect(pollAndApplyCommands(cfg)).resolves.toEqual([]);
  });

  it('a writeback (PATCH) failure does NOT lose the local outcome', async () => {
    queueCommands([cmd({ id: 'wb', kind: 'enroll_repo', payload: { path: '/r' } })]);
    vi.mocked(exporter.patchFleetCommand).mockRejectedValue(new Error('PATCH 503'));

    const out = await pollAndApplyCommands(cfg);

    // The local action already ran; the outcome is still reported despite the
    // failed writeback (the cloud re-derives state from the next tick's spans).
    expect(policy.enroll).toHaveBeenCalledWith('/r');
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('done');
  });

  it('a claim rejection (thrown) is swallowed per-command, not fatal', async () => {
    queueCommands([cmd({ id: 'c1', kind: 'enroll_repo', payload: { path: '/r' } })]);
    vi.mocked(exporter.claimFleetCommand).mockRejectedValue(new Error('claim 500'));

    // Whole pass is wrapped — a thrown claim aborts the pass safely, no throw.
    await expect(pollAndApplyCommands(cfg)).resolves.toBeDefined();
  });

  it('emitTick resolves false (never throws) when the export rejects', async () => {
    vi.mocked(exporter.exportFleetEvents).mockRejectedValue(new Error('timeout'));
    await expect(emitTick(cfg, '2026-06-25T00:00:00.000Z')).resolves.toBe(false);
  });

  it('shipEnrolledRepoDeps resolves 0 (never throws) when shipDepEdges rejects', async () => {
    vi.mocked(policy.listEnrolled).mockReturnValue(['/repo/a']);
    const dep = await import('../src/core/integrations/dep-parser.js');
    vi.mocked(dep.parseRepoDeps).mockReturnValue({
      repoRef: 'a/a',
      edges: [{ src: 's', dst: 'd', kind: 'depends_on', ecosystem: 'npm', name: 'd', depKind: 'prod', range: '^1' }],
    } as ReturnType<typeof dep.parseRepoDeps>);
    vi.mocked(exporter.shipDepEdges).mockRejectedValue(new Error('ingest 500'));

    await expect(shipEnrolledRepoDeps(cfg)).resolves.toBe(0);
  });
});
