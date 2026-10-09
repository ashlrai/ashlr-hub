import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMaintainerVerificationDeps, MAINTAINER_VERIFY_USAGE, runMaintainerVerifyCli } from '../src/cli/maintainer-verify.js';
import type { MaintainerPrPins, MaintainerRunEvidence, MaintainerVerificationDeps } from '../src/core/fleet/maintainer-pr-verification.js';

import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { ExecutionLeaseSpec } from '../src/core/sandbox/execution-leases.js';

// Exercise the default host adapter while replacing only its I/O boundaries.
// No test calls a provider, opens the user's authority store, or starts code.
const io = vi.hoisted(() => ({
  now: 1_800_000_000_000, policy: null as EffectivePolicy | null,
  killed: false, epoch: 'off', owned: true,
  cachedPolicy: vi.fn(), evaluate: vi.fn(), token: vi.fn(),
  acquire: vi.fn(), releaseFence: vi.fn(), register: vi.fn(),
  ensureMirror: vi.fn(), repoLease: vi.fn(), safeGit: vi.fn(), prepare: vi.fn(), runner: vi.fn(),
}));
vi.mock('../src/core/fleet/host-merge.js', () => ({ defaultHostMergeDeps: () => ({
  policy: io.cachedPolicy, nowMs: () => io.now, killActive: () => io.killed,
  killEpoch: () => io.epoch, token: io.token, transport: vi.fn(),
}) }));
vi.mock('../src/core/authority/effective-config.js', () => ({ evaluateStandingAuthority: io.evaluate }));
vi.mock('../src/core/fleet/mirrors.js', () => ({ ensureMirror: io.ensureMirror,
  mirrorPathFor: () => '/isolated-mirror', mirrorLeaseKey: (path: string) => `mirror:${path}` }));
vi.mock('../src/core/fleet/maintainer-pr-runner.js', () => ({ prepareMaintainerRun: io.prepare, runMaintainerPr: io.runner }));
vi.mock('../src/core/config.js', async (original) => ({ ...await original<object>(), loadConfigReadOnlyStrict: () => ({}) }));
vi.mock('../src/core/sandbox/execution-leases.js', async (original) => ({ ...await original<object>(),
  registerExecutionLease: io.register,
  withRepoLease: io.repoLease,
}));
vi.mock('../src/core/sandbox/mutation-fence.js', async (original) => ({ ...await original<object>(),
  acquireOutwardMutationFenceAsync: io.acquire, releaseOutwardMutationFence: io.releaseFence,
  ownsOutwardMutationFence: (fence: unknown) => fence !== null && io.owned,
}));
vi.mock('../src/core/sandbox/safe-git.js', async (original) => ({ ...await original<object>(), runSafeGit: io.safeGit }));

const pins: MaintainerPrPins = { repo: 'owner/repo', pr: 12, baseBranch: 'main',
  baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), treeSha: 'c'.repeat(40), mergeBaseSha: 'b'.repeat(40) };
const result = { ok: true } as MaintainerRunEvidence;

function hostFixture(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const release = vi.fn();
  let spec: ExecutionLeaseSpec | undefined;
  io.register.mockImplementation((_fence: unknown, value: ExecutionLeaseSpec) => {
    spec = value;
    value.parentSignal?.addEventListener('abort', () => controller.abort(), { once: true });
    return { ok: true, lease: { signal: controller.signal, release } };
  });
  return { deps: defaultMaintainerVerificationDeps(parentSignal), controller, release,
    spec: () => { if (!spec) throw new Error('execution was not registered'); return spec; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.now = 1_800_000_000_000; io.killed = false; io.epoch = 'off'; io.owned = true;
  io.policy = { grantId: 'signed', grantSeq: 1, computedAt: new Date(io.now).toISOString(),
    expiresAt: new Date(io.now + 60_000).toISOString(), repos: [{ nameWithOwner: pins.repo }], switch: 'autonomous' } as EffectivePolicy;
  io.evaluate.mockImplementation(() => ({ policy: io.policy, surface: { ok: true } }));
  io.acquire.mockResolvedValue({ capability: 'in-memory-only' });
  io.token.mockResolvedValue({ token: 'in-memory-only', expiresAt: null });
  io.repoLease.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }));
  io.ensureMirror.mockResolvedValue({ ok: true, path: '/isolated-mirror', headSha: pins.baseSha });
  io.safeGit.mockImplementation(async (input: { args: string[] }) => ({ ok: true,
    stdout: input.args[0] === 'rev-parse' ? pins.headSha : '' }));
  io.prepare.mockImplementation(async (input: unknown) => input);
  io.runner.mockResolvedValue(result);
});

describe('maintainer verify CLI intake', () => {
  it.each([
    [], ['owner/repo', '12'], ['owner/repo', '12', '--yes'],
    ['owner/repo', '0', '--confirm-head', 'a'.repeat(40)],
    ['owner/repo', '1e3', '--confirm-head', 'a'.repeat(40)],
    ['owner/repo', '12', '--confirm-head', 'a'.repeat(39)],
    ['owner/repo', '12', '--confirm-head', 'a'.repeat(40), '--receipt', '/tmp/fake.json'],
    ['owner/repo', '12', '--confirm-head', 'a'.repeat(40), '--actor', 'fake-maintainer'],
    ['owner/repo', '12', '--confirm-head', 'a'.repeat(40), '--mirror', '/tmp/agent-tree'],
  ].map((args) => ({ args })))('refuses malformed/forged intake without account reads or execution: $args', async ({ args }) => {
    const print = vi.fn(); const policy = vi.fn();
    const code = await runMaintainerVerifyCli(args, { policy } as unknown as MaintainerVerificationDeps, print);
    expect(code).toBe(2); expect(policy).not.toHaveBeenCalled(); expect(print).toHaveBeenCalledWith(MAINTAINER_VERIFY_USAGE);
  });

  it('reports missing live authority as withheld without dispatching candidate code', async () => {
    const print = vi.fn(); const run = vi.fn(); const transport = vi.fn();
    const deps = { killActive: () => false, policy: () => null, run, transport } as unknown as MaintainerVerificationDeps;
    const code = await runMaintainerVerifyCli(['owner/repo', '12', '--confirm-head', 'a'.repeat(40), '--json'], deps, print);
    expect(code).toBe(1); expect(run).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    expect(JSON.parse(print.mock.calls[0]![0])).toMatchObject({ ok: false, reason: 'no current signed authority for this repository' });
  });
});

describe('default maintainer host authority and execution lifetime', () => {
  it('reads fresh running authority rather than the host display cache on every call', () => {
    const { deps } = hostFixture();
    expect(deps.policy()).toBe(io.policy);
    io.policy = null;
    expect(deps.policy()).toBeNull();
    expect(io.cachedPolicy).not.toHaveBeenCalled();
    expect(io.evaluate).toHaveBeenCalledTimes(2);
    expect(io.evaluate).toHaveBeenNthCalledWith(1, { mode: 'fresh', surface: 'running', nowMs: io.now });
    expect(io.evaluate).toHaveBeenLastCalledWith({ mode: 'fresh', surface: 'running', nowMs: io.now, surfaceHashes: 'unchanged' });
  });

  it('refuses a replacement signed grant that no longer enrolls the requested repository before registration', async () => {
    const f = hostFixture();
    io.policy = { ...io.policy!, repos: [] };
    await expect(f.deps.run(pins)).rejects.toThrow('authority');
    expect(io.register).not.toHaveBeenCalled();
    expect(io.ensureMirror).not.toHaveBeenCalled();
    expect(io.runner).not.toHaveBeenCalled();
  });

  it('registers under the short fence and keeps the real execution signal through runner cleanup', async () => {
    const f = hostFixture();
    let complete!: (value: MaintainerRunEvidence) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    io.runner.mockImplementation(() => { started(); return new Promise<MaintainerRunEvidence>((resolve) => { complete = resolve; }); });
    io.ensureMirror.mockImplementation(async (_repo: unknown, options: { signal: AbortSignal }) => {
      expect(io.register).toHaveBeenCalledOnce();
      expect(io.releaseFence).toHaveBeenCalledOnce();
      expect(f.release).not.toHaveBeenCalled();
      expect(options.signal).toBe(f.controller.signal);
      return { ok: true, path: '/isolated-mirror', headSha: pins.baseSha };
    });
    const running = f.deps.run(pins);
    await ready;
    expect(f.spec()).toMatchObject({ repoKey: 'mirror:/isolated-mirror', engine: 'maintainer-verifier' });
    expect(f.spec().shouldAbort?.()).toBeNull();
    expect(io.repoLease.mock.calls[0]![2]).toEqual({ signal: f.controller.signal });
    for (const [input] of io.safeGit.mock.calls) expect(input.signal).toBe(f.controller.signal);
    expect(io.prepare.mock.calls[0]![0].signal).toBe(f.controller.signal);
    expect(io.runner.mock.calls[0]![0].signal).toBe(f.controller.signal);
    expect(f.release).not.toHaveBeenCalled();
    complete(result);
    await expect(running).resolves.toBe(result);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(['revoked', 'superseded', 'expired', 'Stop', 'epoch'] as const)('exposes %s to the lease poll and refuses execution after mirror awaits', async (change) => {
    const f = hostFixture();
    io.ensureMirror.mockImplementation(async () => {
      if (change === 'revoked') io.policy = null;
      if (change === 'superseded') io.policy = { ...io.policy!, grantSeq: 2 };
      if (change === 'expired') io.now += 60_000;
      if (change === 'Stop') io.killed = true;
      if (change === 'epoch') io.epoch = 'new-stop-epoch';
      expect(f.spec().shouldAbort?.()).toBe('maintainer verification authority changed');
      return { ok: true, path: '/isolated-mirror', headSha: pins.baseSha };
    });
    await expect(f.deps.run(pins)).rejects.toThrow('authority changed');
    expect(io.safeGit).not.toHaveBeenCalled();
    expect(io.runner).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('stops between token minting and fetch without using the newly minted credential', async () => {
    const f = hostFixture();
    io.token.mockImplementation(async () => { io.killed = true; return { token: 'in-memory-only' }; });
    await expect(f.deps.run(pins)).rejects.toThrow('authority changed');
    expect(io.safeGit).not.toHaveBeenCalled();
    expect(io.prepare).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('propagates caller cancellation to the registered execution before candidate preparation', async () => {
    const parent = new AbortController();
    const f = hostFixture(parent.signal);
    io.ensureMirror.mockImplementation(async () => {
      parent.abort();
      expect(f.controller.signal.aborted).toBe(true);
      return { ok: true, path: '/isolated-mirror', headSha: pins.baseSha };
    });
    await expect(f.deps.run(pins)).rejects.toThrow('maintainer execution stopped');
    expect(f.spec().parentSignal).toBe(parent.signal);
    expect(io.runner).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('releases the execution only after rejected runner cleanup completes', async () => {
    const f = hostFixture();
    let fail!: (error: Error) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    io.runner.mockImplementation(() => { started(); return new Promise<MaintainerRunEvidence>((_resolve, reject) => { fail = reject; }); });
    const running = f.deps.run(pins);
    const rejected = expect(running).rejects.toThrow('cleanup failed');
    await ready;
    expect(f.release).not.toHaveBeenCalled();
    fail(new Error('cleanup failed'));
    await rejected;
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('releases the registration fence and starts no work if registration fails', async () => {
    const f = hostFixture();
    io.register.mockReturnValue({ ok: false, reason: 'lease unavailable' });
    await expect(f.deps.run(pins)).rejects.toThrow('lease unavailable');
    expect(io.releaseFence).toHaveBeenCalledOnce();
    expect(io.ensureMirror).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it.each(['lost fence', 'caller abort'] as const)('publication ownership reports %s after an awaited observation', async (change) => {
    const parent = new AbortController();
    const f = hostFixture(parent.signal);
    expect(f.deps.publicationFenceHeld()).toBe(false);
    await f.deps.fenced(async () => {
      expect(f.deps.publicationFenceHeld()).toBe(true);
      await Promise.resolve();
      if (change === 'lost fence') io.owned = false;
      else parent.abort();
      expect(f.deps.publicationFenceHeld()).toBe(false);
    });
    expect(f.deps.publicationFenceHeld()).toBe(false);
    expect(io.releaseFence).toHaveBeenCalledOnce();
  });
});
