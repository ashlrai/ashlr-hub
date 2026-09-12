/** Fixed evaluator seam with inert subprocess/activity mocks; no native process is launched. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';
import { assertComparatorUnchanged } from '../src/core/universe/store.js';
import type { ManifestRecord } from '../src/core/universe/store.js';
import type { VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import { initializeBuiltinActivity, inspectBuiltinActivity } from '../scripts/evaluators/preparation-verification-activity.mjs';

const pins = vi.hoisted(() => ({ id: 'preparation-measurement-v1', digest: 'a'.repeat(64),
  executableDigest: 'b'.repeat(64), command: ['/fixed/node', '/fixed/evaluator.mjs'],
  files: [], tools: [], git: { path: '/fixed/git', digest: 'c'.repeat(64) } }));
vi.mock('node:fs', async original => ({ ...await original<object>(), mkdtempSync: vi.fn(() => '/scratch/builtin-activity-owned') }));
vi.mock('../src/core/universe/artifacts.js', async original => ({ ...await original<object>(), artifactDigest: vi.fn(() => 'd'.repeat(64)) }));
vi.mock('../src/core/universe/store.js', () => ({ assertComparatorUnchanged: vi.fn() }));
vi.mock('../src/core/universe/builtin-evaluator-registry.js', () => ({ resolveBuiltinEvaluator: vi.fn(() => structuredClone(pins)) }));
vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
vi.mock('../scripts/evaluators/preparation-verification-activity.mjs', () => ({ initializeBuiltinActivity: vi.fn(), inspectBuiltinActivity: vi.fn(() => true) }));

const record = { manifest: { evaluation: { builtin: 'preparation-measurement-v1' } },
  evaluationBuiltinDigest: pins.digest, evaluationCommand: pins.command } as ManifestRecord;
const response = (patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({
  stdout: '{"passed":true,"score":999}', stderr: '', exitCode: 0, signal: null,
  timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed', ...patch,
});
function run(beforeStart: () => void = vi.fn(), signal = new AbortController().signal) {
  return runFixedUniverseEvaluator(record, '/root', '/archive', 'd'.repeat(64), '/scratch', 30_000, signal,
    { ASHLR_UNIVERSE_BUILTIN_ACTIVITY: '/untrusted', PATH: '/untrusted' }, false, beforeStart);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(artifactDigest).mockReset().mockReturnValue('d'.repeat(64));
  vi.mocked(assertComparatorUnchanged).mockReset();
  vi.mocked(inspectBuiltinActivity).mockReset().mockReturnValue(true);
  vi.mocked(runVerifySubprocessAsync).mockReset().mockResolvedValue(response());
});
describe('fixed builtin evaluator custody contract', () => {
  it('publishes activity before the caller dispatch guard and forces group exit even for ordinary trials', async () => {
    const guard = vi.fn(() => {
      expect(initializeBuiltinActivity).toHaveBeenCalledOnce();
      expect(runVerifySubprocessAsync).not.toHaveBeenCalled();
    });
    expect((await run(guard)).processGroupSettlement).toBe('group-exit-confirmed');
    expect(guard).toHaveBeenCalledOnce();
    expect(runVerifySubprocessAsync).toHaveBeenCalledWith(pins.command, expect.objectContaining({
      requireProcessGroupExit: true, env: expect.objectContaining({
        ASHLR_UNIVERSE_BUILTIN_ACTIVITY: '/scratch/builtin-activity-owned', ASHLR_UNIVERSE_CANDIDATE: '/archive',
      }),
    }));
    const env = vi.mocked(runVerifySubprocessAsync).mock.calls[0]![1]!.env!;
    expect(env.PATH).not.toContain('untrusted');
    expect(inspectBuiltinActivity).toHaveBeenCalledOnce();
  });
  it.each(['unconfirmed', undefined] as const)('preserves uncertain outer settlement %s despite passing-looking output', async settlement => {
    vi.mocked(runVerifySubprocessAsync).mockResolvedValue(response({ processGroupSettlement: settlement }));
    expect((await run()).processGroupSettlement).toBe(settlement);
    expect(inspectBuiltinActivity).not.toHaveBeenCalled();
    expect(artifactDigest).toHaveBeenCalledTimes(1);
  });
  it('turns a settled outer group with unresolved inner activity into explicit uncertainty', async () => {
    vi.mocked(inspectBuiltinActivity).mockReturnValue(false);
    expect(await run()).toMatchObject({ processGroupSettlement: 'unconfirmed', error: 'Built-in evaluator process settlement unconfirmed' });
    expect(artifactDigest).toHaveBeenCalledTimes(1);
  });
  it('returns explicit not-started without pretending an activity ledger proved group absence', async () => {
    vi.mocked(runVerifySubprocessAsync).mockResolvedValue(response({ exitCode: -1, processGroupSettlement: 'not-started' }));
    expect((await run()).processGroupSettlement).toBe('not-started');
    expect(inspectBuiltinActivity).not.toHaveBeenCalled();
  });
  it('does not dispatch when durable intent publication refuses', async () => {
    await expect(run(() => { throw new Error('Intent publication refused'); })).rejects.toThrow('Intent publication refused');
    expect(runVerifySubprocessAsync).not.toHaveBeenCalled();
  });
  it('returns not-started when cancellation arrives in the dispatch guard', async () => {
    const abort = new AbortController();
    expect(await run(() => abort.abort(), abort.signal)).toMatchObject({ cancelled: true, processGroupSettlement: 'not-started' });
    expect(runVerifySubprocessAsync).not.toHaveBeenCalled();
  });
  it('propagates transport throw after intent rather than manufacturing settlement', async () => {
    vi.mocked(runVerifySubprocessAsync).mockRejectedValue(new Error('Transport unavailable'));
    const guard = vi.fn();
    await expect(run(guard)).rejects.toThrow('Transport unavailable');
    expect(guard).toHaveBeenCalledOnce(); expect(inspectBuiltinActivity).not.toHaveBeenCalled();
  });
  it('propagates final pin drift even after a confirmed group; caller must retain unresolved custody', async () => {
    vi.mocked(artifactDigest).mockReturnValueOnce('d'.repeat(64)).mockReturnValueOnce('e'.repeat(64));
    const guard = vi.fn();
    await expect(run(guard)).rejects.toThrow('Scored artifact changed during evaluation');
    expect(guard).toHaveBeenCalledOnce(); expect(inspectBuiltinActivity).toHaveBeenCalledOnce();
  });
  it('never grants dispatch authority to a changed artifact', async () => {
    vi.mocked(artifactDigest).mockReturnValue('e'.repeat(64));
    const guard = vi.fn();
    await expect(run(guard)).rejects.toThrow('Scored artifact changed before evaluation');
    expect(guard).not.toHaveBeenCalled(); expect(runVerifySubprocessAsync).not.toHaveBeenCalled();
  });
});
