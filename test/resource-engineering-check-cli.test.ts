import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ check: vi.fn(), serverImported: vi.fn(), supervisorImported: vi.fn() }));
vi.mock('../src/core/resources/console-engineering-check.js', () => ({ checkResourceConsoleEngineering: backend.check }));
vi.mock('../src/core/web/resource-console-server.js', () => {
  backend.serverImported(); throw new Error('Commissioning must not import console startup');
});
vi.mock('../src/core/resources/pool-supervisor.js', () => {
  backend.supervisorImported(); throw new Error('Commissioning CLI must not import the supervisor');
});
import { cmdResourceEngineeringCheck } from '../src/cli/resource-engineering-check.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';

const paths = { root: '/private/fixture/ledger', poolFile: '/private/fixture/pool.json',
  bindingsFile: '/private/fixture/bindings.json', observationsFile: '/private/fixture/observations.json',
  workspace: '/private/fixture/workspace', projectsFile: '/private/fixture/projects.json',
  engineeringFile: '/private/fixture/engineering.json' };
const args = ['check', '--root', paths.root, '--pool', paths.poolFile, '--bindings', paths.bindingsFile,
  '--observations', paths.observationsFile, '--workspace', paths.workspace,
  '--projects', paths.projectsFile, '--engineering', paths.engineeringFile];
function report(status = 'configured') {
  return { schemaVersion: 1, scope: 'local-commissioning-check-only', effectsExecuted: false,
    providerContacted: false, admission: 'not-attested', sampledAt: '2026-09-10T00:00:00.000Z', status,
    checks: [{ code: 'inputs', status: 'passed' }], reasons: [], enrollments: [{ id: 'fix', projectId: 'default',
      graphId: 'engineering-run', enrollmentDigest: 'a'.repeat(64), projectRegistration: 'would-register',
      status: 'configured', reasons: [], graph: { sourceState: 'missing', status: 'missing', definitionDigest: null },
      runtime: { status: 'valid', workers: [], warnings: ['execution-and-account-identity-unverified'] } }] };
}
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); backend.check.mockReturnValue(report());
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(backend.serverImported).not.toHaveBeenCalled(); expect(backend.supervisorImported).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('nonexecuting engineering commissioning CLI', () => {
  it('routes the exact explicit options without console startup or signal listeners', async () => {
    const interrupt = process.listeners('SIGINT'); const terminate = process.listeners('SIGTERM');
    expect(await cmdResourcePool(['engineering', ...args, '--quota-config', '/private/fixture/quota.json', '--json'])).toBe(0);
    expect(backend.check).toHaveBeenCalledExactlyOnceWith({ ...paths, quotaConfigFile: '/private/fixture/quota.json' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report());
    expect(output).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(interrupt); expect(process.listeners('SIGTERM')).toEqual(terminate);
  });

  it.each(['held', 'unavailable'])('returns exit1 for %s without changing the report', async (status) => {
    backend.check.mockReturnValue(report(status));
    expect(await cmdResourceEngineeringCheck([...args, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report(status));
  });

  it.each(['--help', '-h'])('help %s does not inspect configuration', async (flag) => {
    expect(await cmdResourcePool(['engineering', flag])).toBe(0);
    expect(backend.check).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('No default configuration is discovered');
  });

  it.each([
    [], ['check'], args.slice(1), [...args, '--execute'], [...args, '--port', '0'],
    [...args, '--connections-config', '/private/fixture/accounts.json'], [...args, '--json', '--json'],
    [...args, '--root', paths.root], [...args, '--quota-config'],
    ...['relative', '/', '/private/fixture/../ledger', '/private/fixture/\u0001', 'x'.repeat(4097)]
      .map((path) => args.map((value) => value === paths.root ? path : value)),
    ...['--pool', '--bindings', '--observations', '--workspace', '--projects', '--engineering'].map((flag) => {
      const index = args.indexOf(flag); return args.filter((_, position) => position !== index && position !== index + 1);
    }),
  ])('refuses malformed or execution options before evidence reads: %j', async (...input) => {
    expect(await cmdResourceEngineeringCheck(input)).toBe(2); expect(backend.check).not.toHaveBeenCalled();
  });

  it('prints honest bounded human summaries without private input paths', async () => {
    expect(await cmdResourceEngineeringCheck(args)).toBe(0);
    expect(backend.check).toHaveBeenCalledExactlyOnceWith(paths);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('admission: not-attested'); expect(text).toContain('Project registration: would-register');
    expect(text).toContain('Configured is structural configuration only'); expect(text).toContain('No keys, locks, storage or policy changed');
    expect(text).toContain('Runtime warning: execution-and-account-identity-unverified');
    expect(text).not.toContain('/private/fixture');
  });

  it('surfaces worker policy and temporary exclusions without inventing an admission verdict', async () => {
    const value = report();
    backend.check.mockReturnValue({ ...value, enrollments: value.enrollments.map((row) => ({ ...row,
      runtime: { ...row.runtime, workers: [
        { workerId: 'personal-general', eligibility: 'excluded', policyHolds: ['owner-paused'],
          exclusionReasons: ['worker-paused'], nextEligibleAt: null },
        { workerId: 'personal-spark', eligibility: 'excluded', policyHolds: [],
          exclusionReasons: ['capacity-uncertain'], nextEligibleAt: '2026-09-10T01:00:00.000Z' },
      ] },
    })) });
    expect(await cmdResourceEngineeringCheck(args)).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('admission: not-attested');
    expect(text).toContain('Worker personal-general · excluded · policy=owner-paused · exclusions=worker-paused');
    expect(text).toContain('Worker personal-spark · excluded · policy=none recorded · exclusions=capacity-uncertain');
    expect(text).toContain('2026-09-10T01:00:00.000Z (not promised capacity)');
    expect(text).toContain('structural configuration only');
  });

  it('sanitizes thrown private errors and reports unavailable once', async () => {
    backend.check.mockImplementation(() => { throw new Error('/private/secret credentials unavailable'); });
    expect(await cmdResourceEngineeringCheck([...args, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ error: 'Engineering commissioning check unavailable' }));
  });

  it('refuses an oversized report without printing partial JSON', async () => {
    backend.check.mockReturnValue({ ...report(), reasons: ['x'.repeat(8 * 1024 * 1024)] });
    expect(await cmdResourceEngineeringCheck([...args, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ error: 'Engineering commissioning check unavailable' }));
  });
});
