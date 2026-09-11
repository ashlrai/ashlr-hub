import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ check: vi.fn(), apply: vi.fn(), read: vi.fn(),
  Failure: class extends Error { constructor(readonly code: string) { super('private detail'); } } }));
vi.mock('../src/core/resources/pool-evolution.js', () => ({ checkResourcePoolEvolution: mocks.check,
  applyResourcePoolEvolution: mocks.apply, ResourcePoolEvolutionError: mocks.Failure }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: mocks.read }));
import { cmdResourcePoolEvolution } from '../src/cli/resource-pool-evolution.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';
const args = ['--root', '/private/ledger', '--workspace', '/private/project', '--pool', '/private/old-pool.json',
  '--bindings', '/private/old-bindings.json', '--next-pool', '/private/new-pool.json', '--next-bindings', '/private/new-bindings.json'];
const hash = 'a'.repeat(64);
const report = { schemaVersion: 1, status: 'planned', planDigest: hash, fromPoolDigest: 'b'.repeat(64), toPoolDigest: 'c'.repeat(64),
  preservedReceiptCount: 3, preservedJobCount: 2, addedWorkerIds: ['spark'], annotatedWorkerIds: ['general'], historyCount: 2, heldQueuedIds: ['old-queued'] };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); mocks.read.mockImplementation(file => ({ fixture: file })); mocks.check.mockReturnValue(report);
  mocks.apply.mockReturnValue({ ...report, status: 'applied', disposition: 'created' });
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('explicit offline pool evolution CLI', () => {
  it('routes read-only check without applying or creating signal handlers', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResourcePool(['evolve', 'check', ...args, '--json'])).toBe(0);
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith({ root: '/private/ledger', workspace: '/private/project',
      pool: { fixture: '/private/old-pool.json' }, bindings: { fixture: '/private/old-bindings.json' },
      nextPool: { fixture: '/private/new-pool.json' }, nextBindings: { fixture: '/private/new-bindings.json' } });
    expect(mocks.apply).not.toHaveBeenCalled(); expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('applies only the explicit original digest without silently replacing its plan', async () => {
    expect(await cmdResourcePoolEvolution(['apply', ...args, '--expected-plan-digest', hash, '--json'])).toBe(0);
    expect(mocks.check).not.toHaveBeenCalled(); expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.apply.mock.calls[0]![0]).toMatchObject({ expectedPlanDigest: hash });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ status: 'applied' });
  });
  it.each(['--help', '-h'])('help %s does not read config or mutate storage', async help => {
    expect(await cmdResourcePool(['evolve', help])).toBe(0); expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('Account pauses and allocation revisions are preserved');
  });
  it.each([
    [], ['run', ...args], ['apply', ...args], ['apply', ...args, '--expected-plan-digest', 'bad'],
    ['check', ...args, '--expected-plan-digest', hash], ['check', ...args, '--json', '--json'],
    ['check', ...args, '--execute'], ['check', ...args, '--pool', '/another'],
    ...['/', 'relative', '/private/../other', '/private/\u0001', 'x'.repeat(4097)].map(value =>
      ['check', ...args.map(arg => arg === '/private/ledger' ? value : arg)]),
    ...['--root', '--workspace', '--pool', '--bindings', '--next-pool', '--next-bindings'].map(flag => {
      const at = args.indexOf(flag); return ['check', ...args.filter((_, i) => i !== at && i !== at + 1)];
    }),
  ].map(input => ({ input })))('refuses malformed input before file reads %#', async ({ input }) => {
    expect(await cmdResourcePoolEvolution(input)).toBe(2);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each(['read', 'check', 'apply'] as const)('redacts %s failure and does not retry uncertain mutation', async stage => {
    mocks[stage].mockImplementation(() => { throw new Error('/private/secret-provider-token'); });
    const input = stage === 'apply' ? ['apply', ...args, '--expected-plan-digest', hash, '--json'] : ['check', ...args, '--json'];
    expect(await cmdResourcePoolEvolution(input)).toBe(1); expect(mocks[stage]).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledOnce(); expect(output.mock.calls[0]![0]).not.toContain('secret-provider-token');
  });
  it('describes configuration upgrade without implying provider or engineering acceptance', async () => {
    expect(await cmdResourcePoolEvolution(['check', ...args])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Preserved receipts: 3 · console jobs: 2');
    expect(output.mock.calls[0]![0]).toContain('Check only: no state or ownership changed');
    expect(output.mock.calls[0]![0]).toContain('Queued tasks held for re-enrollment: old-queued');
    expect(output.mock.calls[0]![0]).toContain('not account commissioning or engineering acceptance');
  });
  it.each(['ownership-present', 'uncertain-work', 'incomplete-journal', 'state-conflict'])('exposes fixed %s code without raw errors', async code => {
    mocks.check.mockImplementation(() => { throw new mocks.Failure(code); });
    expect(await cmdResourcePoolEvolution(['check', ...args, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ code });
    expect(output.mock.calls[0]![0]).not.toContain('private detail');
  });
});
