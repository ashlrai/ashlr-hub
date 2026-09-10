import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ check: vi.fn(), prepare: vi.fn(), read: vi.fn(), start: vi.fn() }));
vi.mock('../src/core/resources/engineering-preparation.js', () => ({
  checkResourceEngineeringPreparation: backend.check, prepareResourceEngineeringBundle: backend.prepare,
}));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: backend.start }));
import { cmdResourceEngineeringPrepare } from '../src/cli/resource-engineering-prepare.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';

const paths = { output: '/private/bundle', resourceRuntime: '/private/runtime.json', workspace: '/private/project', projectsFile: '/private/projects.json' };
const args = ['--recipe', '/private/recipe.json', '--output', paths.output, '--resource-runtime', paths.resourceRuntime,
  '--workspace', paths.workspace, '--projects', paths.projectsFile];
const plan = () => ({ schemaVersion: 1, status: 'planned', scope: 'local-preparation-only', planDigest: 'a'.repeat(64),
  projectId: 'default', projectRegistration: 'persisted', output: paths.output, enrollmentDigest: null,
  executionStarted: false, providerContacted: false, paths: { receipt: '/private/bundle/receipt.json' },
  seedRevision: 'b'.repeat(40), runtimeDigest: 'c'.repeat(64), poolDigest: 'd'.repeat(64) });
const prepared = () => ({ ...plan(), status: 'prepared', disposition: 'created', enrollmentDigest: 'e'.repeat(64),
  commissioning: { status: 'held', reasons: ['global-kill-active'] },
  consoleArguments: { manual: ['resources', 'pool', 'console'], automatic: ['resources', 'pool', 'console', '--engineering-supervision', '/private/supervision.json'] } });
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); backend.read.mockReturnValue({ fixture: 'reviewed recipe' });
  backend.check.mockReturnValue(plan()); backend.prepare.mockReturnValue(prepared());
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(backend.start).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('explicit engineering recipe preparation CLI', () => {
  it('routes preparation, captures the checked digest and never starts the returned console', async () => {
    expect(await cmdResourcePool(['engineering', 'prepare', ...args, '--json'])).toBe(0);
    expect(backend.read).toHaveBeenCalledExactlyOnceWith('/private/recipe.json', 128 * 1024);
    const options = { ...paths, recipe: { fixture: 'reviewed recipe' } };
    expect(backend.check).toHaveBeenCalledExactlyOnceWith(options);
    expect(backend.prepare).toHaveBeenCalledExactlyOnceWith({ ...options, expectedPlanDigest: 'a'.repeat(64) });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(prepared());
  });
  it('checks without registration, files or signal handlers', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResourceEngineeringPrepare([...args, '--check', '--json'])).toBe(0);
    expect(backend.prepare).not.toHaveBeenCalled(); expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('accepts an explicitly pinned plan and refuses a changed plan before registration', async () => {
    expect(await cmdResourceEngineeringPrepare([...args, '--expected-plan-digest', 'a'.repeat(64)])).toBe(0);
    expect(backend.prepare).toHaveBeenCalledOnce(); backend.prepare.mockClear();
    expect(await cmdResourceEngineeringPrepare([...args, '--expected-plan-digest', 'f'.repeat(64), '--json'])).toBe(1);
    expect(backend.prepare).not.toHaveBeenCalled();
  });
  it.each(['--help', '-h'])('help %s reads no recipe or runtime', async flag => {
    expect(await cmdResourcePool(['engineering', 'prepare', flag])).toBe(0);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('Returned console arguments are not executed');
  });
  it.each([
    [], args.slice(2), [...args, '--execute'], [...args, '--check', '--check'], [...args, '--json', '--json'],
    [...args, '--output', '/private/other'], [...args, '--expected-plan-digest', 'wrong'], [...args, '--expected-plan-digest'],
    ...['/', 'relative', '/private/../other', '/private/\u0001', 'x'.repeat(4097)].map(value => args.map(arg => arg === paths.output ? value : arg)),
    ...['--resource-runtime', '--workspace', '--projects'].map(flag => { const at = args.indexOf(flag); return args.filter((_, i) => i !== at && i !== at + 1); }),
  ].map(input => ({ input })))('refuses invalid arguments before reading or registration %#', async ({ input }) => {
    expect(await cmdResourceEngineeringPrepare(input)).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.prepare).not.toHaveBeenCalled();
  });
  it.each(['read', 'check', 'prepare'] as const)('redacts %s failures and never retries automatically', async stage => {
    backend[stage].mockImplementation(() => { throw new Error('/private/secret-client-token'); });
    expect(await cmdResourceEngineeringPrepare([...args, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledOnce(); expect(output.mock.calls[0]![0]).not.toContain('secret-client-token');
    expect(backend[stage]).toHaveBeenCalledOnce();
  });
  it('renders registration separately from held commissioning and activation', async () => {
    expect(await cmdResourceEngineeringPrepare(args)).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Commissioning: held'); expect(text).toContain('global-kill-active');
    expect(text).toContain('effectful when run'); expect(text).toContain('No workers, evaluators, console or services started');
    expect(text).toContain('not provider commissioning');
  });
  it('quotes shell-significant path characters in displayed commands without executing them', async () => {
    const report = prepared(); report.consoleArguments.manual.push('/private/O\'Brien/$(touch nope)');
    backend.prepare.mockReturnValue(report); expect(await cmdResourceEngineeringPrepare(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain("'/private/O'\\''Brien/$(touch nope)'");
  });
});
