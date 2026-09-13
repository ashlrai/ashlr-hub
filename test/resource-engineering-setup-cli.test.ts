import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ check: vi.fn(), prepare: vi.fn(), read: vi.fn(), start: vi.fn() }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', () => ({
  checkResourceEngineeringAutonomousSetup: backend.check, prepareResourceEngineeringAutonomousSetup: backend.prepare,
}));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: backend.start }));
import { cmdResourceEngineeringSetup } from '../src/cli/resource-engineering-setup.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';

const paths = { output: '/private/setup', resourceRuntime: '/private/runtime.json', workspace: '/private/project', projectsFile: '/private/projects.json' };
const args = ['--recipe', '/private/recipe.json', '--policy', '/private/policy.json', '--output', paths.output,
  '--resource-runtime', paths.resourceRuntime, '--workspace', paths.workspace, '--projects', paths.projectsFile];
const plan = { schemaVersion: 1, status: 'planned', planDigest: 'a'.repeat(64), output: paths.output, holds: ['global-kill-active'] };
const result = { ...plan, status: 'prepared', consoleArguments: ['resources', 'pool', 'console', '--engineering-successors', '/private/setup/successors.json'] };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); backend.check.mockReturnValue(plan); backend.prepare.mockReturnValue(result);
  backend.read.mockImplementation((file: string) => file.endsWith('recipe.json') ? { fixture: 'recipe' } : { fixture: 'policy' });
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(backend.start).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
describe('coherent autonomous engineering setup CLI', () => {
  it('routes exact inputs, pins the checked digest and never starts the returned command', async () => {
    expect(await cmdResourcePool(['engineering', 'setup', ...args, '--json'])).toBe(0);
    const options = { ...paths, recipe: { fixture: 'recipe' }, policy: { fixture: 'policy' } };
    expect(backend.read.mock.calls).toEqual([['/private/recipe.json', 128 * 1024], ['/private/policy.json', 16 * 1024]]);
    expect(backend.check).toHaveBeenCalledExactlyOnceWith(options);
    expect(backend.prepare).toHaveBeenCalledExactlyOnceWith({ ...options, expectedPlanDigest: plan.planDigest });
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(result);
  });
  it('performs check only without registration, signal handlers or setup effects', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResourceEngineeringSetup([...args, '--check', '--json'])).toBe(0);
    expect(backend.prepare).not.toHaveBeenCalled(); expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(plan);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('accepts the pinned plan and refuses changed evidence before preparation', async () => {
    expect(await cmdResourceEngineeringSetup([...args, '--expected-plan-digest', plan.planDigest])).toBe(0);
    backend.prepare.mockClear();
    expect(await cmdResourceEngineeringSetup([...args, '--expected-plan-digest', 'f'.repeat(64), '--json'])).toBe(1);
    expect(backend.prepare).not.toHaveBeenCalled();
  });
  it.each(['--help', '-h'])('help %s performs no reads or writes', async flag => {
    expect(await cmdResourcePool(['engineering', 'setup', flag])).toBe(0);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('Returned console arguments are NOT executed');
  });
  it.each([
    [], [...args, '--execute'], [...args, '--check', '--check'], [...args, '--json', '--json'],
    [...args, '--policy', '/private/duplicate'], [...args, '--expected-plan-digest', 'invalid'], [...args, '--expected-plan-digest'],
    ...['/', 'relative', '/private/../other', '/private/\u0001', 'x'.repeat(4097)].map(value => args.map(arg => arg === paths.output ? value : arg)),
    ...['--recipe', '--policy', '--output', '--resource-runtime', '--workspace', '--projects'].map(flag => {
      const at = args.indexOf(flag); return args.filter((_, index) => index !== at && index !== at + 1);
    }),
  ].map(input => ({ input })))('refuses invalid arguments before local reads %#', async ({ input }) => {
    expect(await cmdResourceEngineeringSetup(input)).toBe(2); expect(backend.read).not.toHaveBeenCalled(); expect(backend.prepare).not.toHaveBeenCalled();
  });
  it.each(['read', 'check', 'prepare'] as const)('sanitizes %s errors without retry', async stage => {
    backend[stage].mockImplementation(() => { throw new Error('/private/SECRET_ACCOUNT_VALUE'); });
    expect(await cmdResourceEngineeringSetup([...args, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledOnce(); expect(String(output.mock.calls[0]![0])).not.toContain('SECRET_ACCOUNT_VALUE');
    expect(backend[stage]).toHaveBeenCalledOnce();
  });
  it('quotes command arguments as text and distinguishes prepared artifacts from activation', async () => {
    backend.prepare.mockReturnValue({ ...result, consoleArguments: [...result.consoleArguments, "/private/O'Brien/$(touch nope)"] });
    expect(await cmdResourceEngineeringSetup(args)).toBe(0);
    const text = String(output.mock.calls[0]![0]); expect(text).toContain("'/private/O'\\''Brien/$(touch nope)'");
    expect(text).toContain('effectful'); expect(text).toContain('not provider commissioning or production activation');
    expect(text).toContain('Known local holds: global-kill-active');
  });
});
