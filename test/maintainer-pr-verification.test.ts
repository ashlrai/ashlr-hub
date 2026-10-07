import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { GithubCall } from '../src/core/fleet/host-merge.js';
import {
  maintainerRunFailure, verifyMaintainerPr,
  type MaintainerPrPins, type MaintainerRunEvidence, type MaintainerVerificationDeps,
} from '../src/core/fleet/maintainer-pr-verification.js';

const repo = 'owner/project';
const baseSha = 'b'.repeat(40);
const headSha = 'a'.repeat(40);
const treeSha = 'c'.repeat(40);
const pins: MaintainerPrPins = { repo, pr: 12, baseBranch: 'main', baseSha, headSha, treeSha, mergeBaseSha: baseSha };
const now = Date.parse('2026-10-07T03:00:00Z');

function evidence(): MaintainerRunEvidence {
  const command = { id: 'real-check', kind: 'test' as const, cmd: ['node', 'check.cjs'], required: true };
  const output = 'actual command output';
  return {
    ...pins, ok: true, diffSha256: 'd'.repeat(64), contractSha256: 'e'.repeat(64),
    expectedCommands: [command], commands: [{ command, result: { ok: true, exitCode: 0, command: 'node check.cjs', output, timedOut: false },
      startedAt: new Date(now).toISOString(), durationMs: 5, outputSha256: createHash('sha256').update(output).digest('hex') }],
    confinement: 'required', sourceUnchanged: true, worktreeRemoved: true,
  };
}
function cargoEvidence(): MaintainerRunEvidence {
  const run = evidence();
  const command = { id: 'cargo-check', kind: 'test' as const, cmd: ['cargo', 'test', '--locked'], required: true };
  run.expectedCommands = [command]; run.commands[0]!.command = command;
  const payload = { v: 1 as const, recipe: 'cargo-vendor-locked-v1' as const, sourceTree: treeSha,
    inputsSha256: '1'.repeat(64), lockSha256: '2'.repeat(64), toolchainSha256: '3'.repeat(64),
    vendorSha256: '4'.repeat(64), configSha256: '5'.repeat(64), packageCount: 1 };
  run.cargoDependencies = { ...payload, receiptSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  run.dependenciesRemoved = true;
  return run;
}

function fixture() {
  const state = {
    base: baseSha, head: headSha, tree: treeSha, mergeBase: baseSha, appId: 77,
    permission: 'write', actor: 'maintainer', killed: false, killEpoch: 'off',
    grant: 'signed-grant', protected: true, rules: true, open: true, postApp: 77,
    expire: new Date(now + 60_000).toISOString(), rulesRevision: 1,
  };
  const calls: GithubCall[] = [];
  const storedChecks: unknown[] = [];
  const run = vi.fn(async () => evidence());
  let fenced = false;
  const deps: MaintainerVerificationDeps = {
    nowMs: () => now,
    policy: () => ({ grantId: state.grant, grantSeq: 1, computedAt: new Date(now).toISOString(), expiresAt: state.expire,
      repos: [{ nameWithOwner: repo }], switch: 'autonomous' } as EffectivePolicy),
    killActive: () => state.killed, killEpoch: () => state.killEpoch,
    authenticatedActor: async () => state.actor,
    token: async () => ({ token: 'in-memory-only', expiresAt: null }),
    record: vi.fn(), run,
    fenced: async (fn) => { fenced = true; try { return await fn(); } finally { fenced = false; } },
    publicationFenceHeld: () => fenced,
    transport: async (call) => {
      calls.push(call);
      const suffix = call.path.replace(`/repos/${repo}`, '');
      if (call.method === 'POST') {
        expect(fenced).toBe(true);
        expect(suffix).toBe('/check-runs');
        const check = { ...(call.body as object), id: 98, app: { id: state.postApp } };
        storedChecks.push(check);
        return { status: 201, body: check };
      }
      if (suffix === '') return { status: 200, body: { full_name: repo, default_branch: 'main' } };
      if (suffix.includes('/collaborators/')) return { status: 200, body: { user: { login: state.actor }, permission: state.permission } };
      if (suffix === '/pulls/12') return { status: 200, body: { number: 12, state: state.open ? 'open' : 'closed',
        base: { ref: 'main', sha: state.base, repo: { full_name: repo } }, head: { sha: state.head } } };
      if (suffix === '/branches/main') return { status: 200, body: { protected: state.protected, commit: { sha: state.base } } };
      if (suffix.startsWith('/git/commits/')) return { status: 200, body: { sha: state.head, tree: { sha: state.tree }, parents: [{ sha: 'f'.repeat(40) }] } };
      if (suffix.startsWith('/compare/')) return { status: 200, body: { base_commit: { sha: state.base }, merge_base_commit: { sha: state.mergeBase }, status: 'ahead' } };
      if (suffix === '/rules/branches/main') return { status: 200, body: state.rules ? [{ type: 'required_status_checks', ruleset_id: state.rulesRevision,
        parameters: { required_status_checks: [{ context: 'ashlr/verify', integration_id: state.appId }] } }] : [] };
      if (suffix.includes('/check-runs?')) return { status: 200, body: { check_runs: storedChecks } };
      return { status: 404, body: null };
    },
  };
  return { deps, state, run, calls, storedChecks, writes: () => calls.filter((call) => call.method !== 'GET') };
}

const input = { repo, pr: 12, confirmHead: headSha };

describe('host-owned maintainer PR verification', () => {
  it('publishes a version-two Cargo receipt only after exact dependency evidence and cleanup', async () => {
    const f = fixture(); f.run.mockResolvedValueOnce(cargoEvidence());
    const result = await verifyMaintainerPr(input, f.deps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.receipt.v).toBe(2);
    expect(f.writes()[0]!.body).toMatchObject({ external_id: expect.stringMatching(/^maintainer-v2:/) });
  });
  it.each([
    ['missing attachment', (run: MaintainerRunEvidence) => { delete run.cargoDependencies; }],
    ['unfinished cleanup', (run: MaintainerRunEvidence) => { run.dependenciesRemoved = false; }],
    ['wrong source', (run: MaintainerRunEvidence) => { run.cargoDependencies!.sourceTree = 'f'.repeat(40); }],
    ['wrong digest', (run: MaintainerRunEvidence) => { run.cargoDependencies!.receiptSha256 = '0'.repeat(64); }],
    ['empty inventory', (run: MaintainerRunEvidence) => { run.cargoDependencies!.packageCount = 0; }],
    ['unsupported recipe', (run: MaintainerRunEvidence) => { run.cargoDependencies!.recipe = 'untrusted' as never; }],
  ])('does not post Cargo success with %s', async (_label, change) => {
    const run = cargoEvidence(); change(run);
    const f = fixture(); f.run.mockResolvedValueOnce(run);
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false);
    expect(f.writes()).toEqual([]);
  });
  it('keeps the Cargo duplicate key stable across fresh immutable configuration directories', async () => {
    const f = fixture(); f.run.mockImplementation(async () => {
      const run = cargoEvidence();
      run.cargoDependencies!.configSha256 = createHash('sha256').update(String(f.run.mock.calls.length)).digest('hex');
      const { receiptSha256: _digest, ...payload } = run.cargoDependencies!;
      run.cargoDependencies!.receiptSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      return run;
    });
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(true);
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(true);
    expect(f.writes()).toHaveLength(1);
  });
  it('posts the real confined multi-commit head without manufacturing fleet provenance', async () => {
    const f = fixture();
    const result = await verifyMaintainerPr(input, f.deps);
    expect(result.ok).toBe(true);
    expect(f.run).toHaveBeenCalledWith(pins);
    expect(f.writes()).toHaveLength(1);
    expect(JSON.stringify(f.writes()[0]!.body)).not.toMatch(/G3|fleet mirror|frontier/);
    expect(f.deps.record).toHaveBeenCalledOnce();
    expect(result.ok && result.receipt.actor).toBe('maintainer');
  });

  it.each([
    ['head', (f: ReturnType<typeof fixture>) => { f.state.head = 'f'.repeat(40); }],
    ['base', (f: ReturnType<typeof fixture>) => { f.state.base = 'f'.repeat(40); f.state.mergeBase = f.state.base; }],
    ['tree', (f: ReturnType<typeof fixture>) => { f.state.tree = 'f'.repeat(40); }],
    ['rules', (f: ReturnType<typeof fixture>) => { f.state.rulesRevision++; }],
    ['App', (f: ReturnType<typeof fixture>) => { f.state.appId++; }],
    ['grant', (f: ReturnType<typeof fixture>) => { f.state.grant = 'replacement'; }],
    ['Stop epoch', (f: ReturnType<typeof fixture>) => { f.state.killEpoch = 'recreated-off'; }],
    ['Stop', (f: ReturnType<typeof fixture>) => { f.state.killed = true; }],
    ['permission', (f: ReturnType<typeof fixture>) => { f.state.permission = 'read'; }],
    ['authenticated account', (f: ReturnType<typeof fixture>) => { f.state.actor = 'different-maintainer'; }],
  ])('does not post when %s changes while the suite runs', async (_label, change) => {
    const f = fixture();
    f.run.mockImplementationOnce(async () => { change(f); return evidence(); });
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false);
    expect(f.writes()).toEqual([]);
  });

  it.each([
    ['missing caller', (f: ReturnType<typeof fixture>) => { f.state.actor = ''; }],
    ['read-only caller', (f: ReturnType<typeof fixture>) => { f.state.permission = 'read'; }],
    ['unprotected base', (f: ReturnType<typeof fixture>) => { f.state.protected = false; }],
    ['missing App rule', (f: ReturnType<typeof fixture>) => { f.state.rules = false; }],
    ['unbound App rule', (f: ReturnType<typeof fixture>) => { f.state.appId = 0; }],
    ['outdated ancestry', (f: ReturnType<typeof fixture>) => { f.state.mergeBase = 'f'.repeat(40); }],
    ['expired grant', (f: ReturnType<typeof fixture>) => { f.state.expire = new Date(now).toISOString(); }],
    ['closed PR', (f: ReturnType<typeof fixture>) => { f.state.open = false; }],
  ])('refuses %s before running candidate code', async (_label, change) => {
    const f = fixture(); change(f);
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false);
    expect(f.run).not.toHaveBeenCalled(); expect(f.writes()).toEqual([]);
  });

  it('requires exact reviewed head rather than a generic yes flag', async () => {
    const f = fixture();
    expect((await verifyMaintainerPr({ ...input, confirmHead: 'f'.repeat(40) }, f.deps)).ok).toBe(false);
    expect(f.run).not.toHaveBeenCalled(); expect(f.writes()).toEqual([]);
  });

  it.each(['grant', 'Stop epoch'] as const)('refuses a changed %s during intake before candidate execution', async (change) => {
    const f = fixture();
    const transport = f.deps.transport;
    f.deps.transport = async (call) => {
      const reply = await transport(call);
      if (call.path.endsWith('/rules/branches/main')) {
        if (change === 'grant') f.state.grant = 'replacement';
        else f.state.killEpoch = 'recreated-off';
      }
      return reply;
    };
    const result = await verifyMaintainerPr(input, f.deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('changed during PR intake');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.writes()).toEqual([]);
  });

  it('rejects interruptions and storage failures without posting', async () => {
    const f = fixture(); f.run.mockRejectedValueOnce(new Error('interrupted'));
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false);
    expect(f.writes()).toEqual([]);
    f.deps.record = () => { throw new Error('receipt storage unavailable'); };
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false);
    expect(f.writes()).toEqual([]);
  });

  it('never recognizes a same-named check from another App', async () => {
    const f = fixture(); f.state.postApp = 88;
    const result = await verifyMaintainerPr(input, f.deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('ruleset-bound App');
  });

  it('recognizes a duplicate only after actual verification and fresh source checks', async () => {
    const f = fixture();
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(true);
    const newRun = evidence(); newRun.commands[0]!.durationMs = 24;
    newRun.commands[0]!.startedAt = new Date(now + 100).toISOString();
    f.run.mockResolvedValueOnce(newRun);
    const replay = await verifyMaintainerPr(input, f.deps);
    expect(replay.ok && replay.action).toBe('unchanged');
    expect(f.run).toHaveBeenCalledTimes(2); expect(f.writes()).toHaveLength(1);
  });

  it('checks Stop again after the final awaited check-list read', async () => {
    const f = fixture(); const transport = f.deps.transport;
    f.deps.transport = async (call) => { const reply = await transport(call); if (call.path.includes('/check-runs?')) f.state.killed = true; return reply; };
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false); expect(f.writes()).toEqual([]);
  });

  it('rechecks authority after token mint and immediately before dispatch', async () => {
    const f = fixture(); let aboutToPost = false;
    const transport = f.deps.transport;
    f.deps.transport = async (call) => { const reply = await transport(call); if (call.path.includes('/check-runs?')) aboutToPost = true; return reply; };
    f.deps.token = async () => { if (aboutToPost) f.state.killed = true; return { token: 'in-memory-only', expiresAt: null }; };
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false); expect(f.writes()).toEqual([]);
  });

  it('withholds duplicate success if Stop lands during the last read', async () => {
    const f = fixture(); expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(true);
    const transport = f.deps.transport;
    f.deps.transport = async (call) => { const reply = await transport(call); if (call.path.includes('/check-runs?')) f.state.killed = true; return reply; };
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false); expect(f.writes()).toHaveLength(1);
  });

  it('withholds publication if exact fence ownership is lost during reads', async () => {
    const f = fixture(); f.deps.publicationFenceHeld = () => false;
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false); expect(f.writes()).toEqual([]);
  });
});

describe('executed command receipt completeness', () => {
  it.each([
    ['summary failed', (run: MaintainerRunEvidence) => { run.ok = false; }],
    ['tree mismatch', (run: MaintainerRunEvidence) => { run.treeSha = 'f'.repeat(40); }],
    ['cleanup failed', (run: MaintainerRunEvidence) => { run.worktreeRemoved = false; }],
    ['source changed', (run: MaintainerRunEvidence) => { run.sourceUnchanged = false; }],
    ['contract missing', (run: MaintainerRunEvidence) => { run.contractSha256 = ''; }],
    ['empty suite', (run: MaintainerRunEvidence) => { run.commands = []; run.expectedCommands = []; }],
    ['partial suite', (run: MaintainerRunEvidence) => { run.commands = []; }],
    ['wrong command', (run: MaintainerRunEvidence) => { run.commands[0]!.command = { kind: 'test', cmd: ['node', 'different.cjs'] }; }],
    ['command failed', (run: MaintainerRunEvidence) => { run.commands[0]!.result.exitCode = 1; }],
    ['command cancelled', (run: MaintainerRunEvidence) => { run.commands[0]!.result.cancelled = true; }],
    ['command timed out', (run: MaintainerRunEvidence) => { run.commands[0]!.result.timedOut = true; }],
    ['output mismatch', (run: MaintainerRunEvidence) => { run.commands[0]!.result.output += 'altered'; }],
    ['invalid timing', (run: MaintainerRunEvidence) => { run.commands[0]!.durationMs = NaN; }],
  ])('rejects %s and makes no App write', async (_label, change) => {
    const run = evidence(); change(run);
    expect(maintainerRunFailure(pins, run)).not.toBeNull();
    const f = fixture(); f.run.mockResolvedValueOnce(run);
    expect((await verifyMaintainerPr(input, f.deps)).ok).toBe(false); expect(f.writes()).toEqual([]);
  });
});
