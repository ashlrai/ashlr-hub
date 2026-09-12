/** Mocked read-only CLI boundary; no filesystem or execution owners. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ check: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn() }));
vi.mock('../src/core/resources/engineering-predecessor-check.js', () => ({ checkResourceEngineeringPredecessor: backend.check }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', () => ({ prepareResourceEngineeringAutonomousSetup: backend.prepare }));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: backend.start }));
import { cmdResourceEngineeringPredecessor } from '../src/cli/resource-engineering-predecessor.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';

const paths = { output: '/private/setup', resourceRuntime: '/private/runtime.json', workspace: '/private/project', projectsFile: '/private/projects.json' };
const planDigest = 'a'.repeat(64); const deadline = '2025-01-01T00:01:00.000Z';
const args = ['check', '--recipe', '/private/recipe.json', '--policy', '/private/policy.json', '--output', paths.output,
  '--resource-runtime', paths.resourceRuntime, '--workspace', paths.workspace, '--projects', paths.projectsFile,
  '--expected-plan-digest', planDigest, '--expected-deadline-at', deadline];
const report = { schemaVersion: 1, scope: 'predecessor-completion-evidence-only', status: 'verified', reasons: [], sampledAt: deadline,
  executionAuthorized: false, effectsExecuted: false, providerContacted: false, evidenceDigest: 'b'.repeat(64),
  tip: { enrollmentId: 'child', enrollmentDigest: 'c'.repeat(64), projectId: 'default', commit: 'd'.repeat(40) }, continuation: 'eligible' };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); backend.check.mockReturnValue(report);
  backend.read.mockImplementation((file: string) => file.endsWith('recipe.json') ? { fixture: 'recipe' } : { fixture: 'policy' });
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(backend.prepare).not.toHaveBeenCalled(); expect(backend.start).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
describe('read-only engineering predecessor CLI', () => {
  it('routes bounded reads and both original pins without publishing, dispatch or signal handlers', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResourcePool(['engineering', 'predecessor', ...args, '--json'])).toBe(0);
    expect(backend.read.mock.calls).toEqual([['/private/recipe.json', 128 * 1024], ['/private/policy.json', 16 * 1024]]);
    expect(backend.check).toHaveBeenCalledExactlyOnceWith({ setup: { ...paths, recipe: { fixture: 'recipe' }, policy: { fixture: 'policy' } },
      expectedPlanDigest: planDigest, expectedDeadlineAt: deadline });
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(report);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('returns held evidence unchanged with nonzero status', async () => {
    const held = { ...report, status: 'held', reasons: ['custody-evidence-unavailable'], evidenceDigest: null, tip: null, continuation: null };
    backend.check.mockReturnValue(held);
    expect(await cmdResourceEngineeringPredecessor([...args, '--json'])).toBe(1);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(held);
  });
  it('labels human output as observation only, including a recorded stop request', async () => {
    backend.check.mockReturnValue({ ...report, continuation: 'stop-requested' });
    expect(await cmdResourceEngineeringPredecessor(args)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toContain('stop-requested');
    expect(String(output.mock.calls[0]![0])).toContain('not dispatch permission');
  });
  it.each(['--help', '-h'])('help %s performs no reads or checks', async flag => {
    expect(await cmdResourcePool(['engineering', 'predecessor', flag])).toBe(0);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('Observation-only');
  });
  it.each([
    [], args.slice(1), [...args, '--execute'], [...args, '--json', '--json'], [...args, '--help'],
    ...['--recipe', '--policy', '--output', '--resource-runtime', '--workspace', '--projects', '--expected-plan-digest', '--expected-deadline-at'].flatMap(flag => {
      const at = args.indexOf(flag); return [args.filter((_, i) => i !== at && i !== at + 1), [...args, flag, args[at + 1]!]];
    }),
    ...['/', 'relative', '/private/../other', '/private/\u0001', 'x'.repeat(4097)].map(value => args.map(arg => arg === paths.output ? value : arg)),
    ...['bad', 'A'.repeat(64)].map(value => args.map(arg => arg === planDigest ? value : arg)),
    ...['bad', '2025-01-01', '2025-01-01T00:01:00Z', '2025-01-01T00:01:00.000+00:00'].map(value => args.map(arg => arg === deadline ? value : arg)),
  ].map(input => ({ input })))('rejects invalid arguments before backend reads %#', async ({ input }) => {
    expect(await cmdResourceEngineeringPredecessor(input)).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
  });
  it.each(['read', 'check'] as const)('redacts %s failure without retry', async stage => {
    backend[stage].mockImplementation(() => { throw Error('/private/SECRET_VALUE'); });
    expect(await cmdResourceEngineeringPredecessor([...args, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledOnce(); expect(String(output.mock.calls[0]![0])).not.toContain('SECRET_VALUE');
    expect(backend[stage]).toHaveBeenCalledOnce();
  });
  it('refuses oversized backend output without printing it', async () => {
    backend.check.mockReturnValue({ ...report, reasons: ['SECRET_VALUE'.repeat(7000)] });
    expect(await cmdResourceEngineeringPredecessor([...args, '--json'])).toBe(1);
    expect(String(output.mock.calls[0]![0])).not.toContain('SECRET_VALUE');
  });
});
