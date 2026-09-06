import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { UniverseDeliveryReceipt } from '../src/core/universe/index.js';

const core = vi.hoisted(() => ({ deliverUniverseElite: vi.fn(), readUniverseDeliveries: vi.fn() }));
vi.mock('../src/core/universe/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/universe/index.js')>();
  return { ...core, validUniverseDeliveryBranch: actual.validUniverseDeliveryBranch };
});
import { cmdUniverseDelivery } from '../src/cli/universe-delivery.js';

function receipt(overrides: Partial<UniverseDeliveryReceipt> = {}): UniverseDeliveryReceipt {
  return {
    schemaVersion: 1, id: 'delivery-one', universeId: 'calendar', trialId: 'trial-one',
    runId: 'run-one', niche: 'correctness', manifestDigest: 'a'.repeat(64),
    comparatorDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64),
    repo: '/private/source repository', branch: 'codex/calendar-fix',
    baseCommit: 'd'.repeat(40), commit: 'e'.repeat(40), tree: 'f'.repeat(40),
    changedFiles: ['format.ts'], status: 'delivered',
    createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:00:01.000Z',
    ...overrides,
  };
}

const deliveryArgs = ['deliver', 'calendar', '--trial', 'trial-one', '--branch', 'codex/calendar-fix'];

describe('Universe delivery CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.deliverUniverseElite.mockResolvedValue(receipt());
    core.readUniverseDeliveries.mockReturnValue({ deliveries: [], sourceState: 'healthy', reasons: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['unknown'], ['deliver'], ['deliveries'], ['deliver', '../escape'],
    ['deliver', 'calendar', '--trial', 'trial-one'], ['deliver', 'calendar', '--branch', 'codex/fix'],
    ['deliveries', 'calendar', 'another'], ['deliveries', 'calendar', '--trial', 'trial-one'],
    ['deliveries', 'calendar', '--branch', 'codex/fix'], ['deliveries', 'calendar', '--root'],
    ['deliveries', 'calendar', '--root', '-h'], ['deliveries', 'calendar', '--root', '\0'],
    ['deliveries', 'calendar', '--unknown'], ['deliveries', 'calendar', '--root', '/a', '--root', '/b'],
    [...deliveryArgs, '--trial', 'trial-two'], [...deliveryArgs, '--branch', 'codex/other'],
    [...deliveryArgs, '--json'], [...deliveryArgs, 'extra'],
    ['deliver', 'calendar', '--trial', 'bad/trial', '--branch', 'codex/fix'],
    ['deliver', 'calendar', '--trial', 'a'.repeat(65), '--branch', 'codex/fix'],
    ['deliver', 'calendar', '--trial', '', '--branch', 'codex/fix'],
    ['deliver', 'calendar', '--trial', '--branch', 'codex/fix'],
    ['deliveries', 'CALENDAR'], ['deliveries', 'a'.repeat(65)],
  ])('rejects invalid invocation %j before any core operation', async (...args) => {
    expect(await cmdUniverseDelivery([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
    expect(core.readUniverseDeliveries).not.toHaveBeenCalled();
  });

  it.each([
    'main', 'refs/heads/codex/fix', 'codex/', 'codex//fix', 'codex/../fix', 'codex/a..b',
    'codex/.hidden', 'codex/nested/.hidden', 'codex/fix.lock', 'codex/fix.lock/nested',
    'codex/fix.', 'codex/fix/', 'codex/fix@{one}', 'codex/fix\\other', 'codex/a b',
    'codex/a\nb', 'codex/a\tb', 'codex/a\x7fb', 'codex/a~b', 'codex/a^b',
    'codex/a:b', 'codex/a?b', 'codex/a*b', 'codex/a[b', `codex/${'a'.repeat(187)}`,
  ])('rejects invalid branch %j as an argument error', async (branch) => {
    expect(await cmdUniverseDelivery(['deliver', 'calendar', '--trial', 'trial-one', '--branch', branch, '--json'])).toBe(2);
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });

  it('delivers the explicit trial to the explicit branch with the selected private root', async () => {
    expect(await cmdUniverseDelivery([...deliveryArgs, '--root', 'private store', '--json'])).toBe(0);
    expect(core.deliverUniverseElite).toHaveBeenCalledOnce();
    expect(core.deliverUniverseElite).toHaveBeenCalledWith('calendar', {
      trialId: 'trial-one', branch: 'codex/calendar-fix', root: resolve('private store'),
    });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(receipt());
    expect(core.readUniverseDeliveries).not.toHaveBeenCalled();
  });

  it('accepts existing record IDs and nested branch names without rewriting either', async () => {
    expect(await cmdUniverseDelivery(['deliver', 'calendar', '--trial', 'Trial_1.v2', '--branch', 'codex/feature/Calendar_2'])).toBe(0);
    expect(core.deliverUniverseElite).toHaveBeenCalledWith('calendar', {
      trialId: 'Trial_1.v2', branch: 'codex/feature/Calendar_2', root: undefined,
    });
  });

  it('routes both commands through the existing Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse([...deliveryArgs, '--json'])).toBe(0);
    expect(await cmdUniverse(['deliveries', 'calendar', '--json'])).toBe(0);
    expect(core.deliverUniverseElite).toHaveBeenCalledOnce();
    expect(core.readUniverseDeliveries).toHaveBeenCalledWith('calendar', { root: undefined });
  });

  it('labels successful branch delivery without claiming production acceptance', async () => {
    expect(await cmdUniverseDelivery(deliveryArgs)).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Local branch delivered. Checkout, index, and HEAD were not changed.');
    expect(text).toContain('Not pushed, merged, deployed, or accepted as a production change.');
    expect(text).toContain('Pinned base:');
    expect(text).toContain('files changed: 1');
  });

  it('does not claim a branch was created for an unchanged candidate', async () => {
    core.deliverUniverseElite.mockResolvedValue(receipt({ status: 'unchanged', changedFiles: [], commit: 'd'.repeat(40) }));
    expect(await cmdUniverseDelivery(deliveryArgs)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Candidate matches the pinned base; no branch was created.');
    expect(output.mock.calls[0]![0]).not.toContain('Local branch delivered.');
  });

  it('does not report pending durable intent as successful delivery', async () => {
    core.deliverUniverseElite.mockResolvedValue(receipt({ status: 'pending', completedAt: null }));
    expect(await cmdUniverseDelivery(deliveryArgs)).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('Delivery intent recorded; branch creation is not confirmed.');
    expect(output.mock.calls[0]![0]).not.toContain('Local branch delivered.');
  });

  it('reads receipts without invoking delivery', async () => {
    const result = { deliveries: [receipt()], sourceState: 'healthy', reasons: [] };
    core.readUniverseDeliveries.mockReturnValue(result);
    expect(await cmdUniverseDelivery(['deliveries', 'calendar', '--root', '/private/store', '--json'])).toBe(0);
    expect(core.readUniverseDeliveries).toHaveBeenCalledWith('calendar', { root: '/private/store' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });

  it('keeps delivered, unchanged, and pending receipt counts distinct', async () => {
    core.readUniverseDeliveries.mockReturnValue({ deliveries: [receipt(),
      receipt({ id: 'no-op', status: 'unchanged' }), receipt({ id: 'intent', status: 'pending', completedAt: null })],
    sourceState: 'healthy', reasons: [] });
    expect(await cmdUniverseDelivery(['deliveries', 'calendar'])).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('Branch-delivered: 1 · unchanged: 1 · pending: 1');
    expect(output.mock.calls[0]![0]).toContain('not production acceptance');
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });

  it('keeps degraded evidence unavailable instead of publishing a trusted delivery count', async () => {
    core.readUniverseDeliveries.mockReturnValue({ deliveries: [receipt()], sourceState: 'degraded', reasons: ['Invalid receipt'] });
    expect(await cmdUniverseDelivery(['deliveries', 'calendar'])).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('Branch-delivered count: unavailable (degraded evidence)');
    expect(output.mock.calls[0]![0]).toContain('recorded delivered (unverified)');
    expect(output.mock.calls[0]![0]).toContain('Recorded receipt only; delivery evidence could not be fully verified.');
    expect(output.mock.calls[0]![0]).not.toContain('Local branch delivered.');
    expect(output.mock.calls[0]![0]).toContain('Invalid receipt');
  });

  it('preserves degraded receipt evidence in JSON', async () => {
    const result = { deliveries: [], sourceState: 'degraded', reasons: ['Invalid receipt'] };
    core.readUniverseDeliveries.mockReturnValue(result);
    expect(await cmdUniverseDelivery(['deliveries', 'calendar', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
  });

  it('shows an absent delivery store without creating or dispatching anything', async () => {
    core.readUniverseDeliveries.mockReturnValue({ deliveries: [], sourceState: 'missing', reasons: [] });
    expect(await cmdUniverseDelivery(['deliveries', 'calendar'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('No recorded deliveries.');
    expect(output.mock.calls[0]![0]).toContain('delivery source missing');
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });

  it('reports core refusal as failed execution with its machine-readable reason', async () => {
    core.deliverUniverseElite.mockRejectedValue(new Error('Requested trial is not the current elite'));
    expect(await cmdUniverseDelivery([...deliveryArgs, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Requested trial is not the current elite' });
  });

  it('reports missing experiment as failed lookup, not a healthy empty result', async () => {
    core.readUniverseDeliveries.mockImplementation(() => { throw new Error('Universe not found: calendar'); });
    expect(await cmdUniverseDelivery(['deliveries', 'calendar'])).toBe(1);
    expect(errors).toHaveBeenCalledWith('universe delivery: Universe not found: calendar');
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });

  it.each([['help'], ['deliver', '--help'], ['deliveries', '-h']])('prints help for %j without reading or writing', async (...args) => {
    expect(await cmdUniverseDelivery(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('--trial <elite-trial-id> --branch codex/<new-branch>');
    expect(output.mock.calls[0]![0]).toContain('does not switch HEAD');
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
    expect(core.readUniverseDeliveries).not.toHaveBeenCalled();
  });

  it.each(['bash', 'zsh'])('includes delivery and read-only receipt commands in %s completions', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    const script = stdout.mock.calls.map(([value]) => value).join('');
    expect(script).toMatch(/universe\).*deliver.*deliveries/);
    expect(core.deliverUniverseElite).not.toHaveBeenCalled();
  });
});
