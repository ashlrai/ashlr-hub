import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseIntegrationDefinition, UniverseIntegrationPlan } from '../src/core/universe/index.js';

const core = vi.hoisted(() => ({ readUniverseIntegrationPlan: vi.fn() }));
const files = vi.hoisted(() => ({ readResourceJson: vi.fn() }));
vi.mock('../src/core/universe/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/universe/index.js')>(), ...core,
}));
vi.mock('../src/core/resources/pool-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>(), readResourceJson: files.readResourceJson,
}));
import { cmdUniverseIntegration } from '../src/cli/universe-integration.js';

function definition(): UniverseIntegrationDefinition {
  return {
    schemaVersion: 1, id: 'combined',
    target: { repo: '/private/source-repo', baseCommit: 'a'.repeat(40), allowedPaths: ['src/one.ts', 'src/two.ts'] },
    sources: [
      { universeId: 'one', deliveryId: '1'.repeat(64), commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
      { universeId: 'two', deliveryId: '2'.repeat(64), commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
    ],
  };
}

function plan(overrides: Partial<UniverseIntegrationPlan> = {}): UniverseIntegrationPlan {
  const value = definition();
  return {
    schemaVersion: 1, scope: 'same-repository-pinned-base-overlay', authority: 'observation-only', definition: value,
    sourceState: 'healthy', reasons: [],
    sources: value.sources.map((source, index) => ({ ...source, receiptDigest: `${index + 1}`.repeat(64), state: 'verified' as const, changedPathCount: 1 })),
    entries: [{ path: 'src/one.ts', oid: 'f'.repeat(40), executable: false, sourceDeliveryIds: [value.sources[0]!.deliveryId] }],
    conflicts: [], compositionDigest: '9'.repeat(64), compositionReady: true,
    ...overrides,
  };
}

describe('Universe integration planning CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  const manifest = '/private/integration.json';
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    files.readResourceJson.mockReturnValue(definition());
    core.readUniverseIntegrationPlan.mockReturnValue(plan());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['unknown'], ['plan'], ['plan', 'extra'], ['plan', '--manifest'], ['plan', '--manifest', 'relative.json'],
    ['plan', '--manifest', '/'], ['plan', '--manifest', '/private/one/../two'], ['plan', '--manifest=private.json'],
    ['plan', '--manifest', manifest, '--manifest', '/private/other.json'], ['plan', '--manifest', manifest, '--json', '--json'],
    ['plan', '--manifest', manifest, '--root'], ['plan', '--manifest', manifest, '--root', 'relative'],
    ['plan', '--manifest', manifest, '--root', '/private/store/'], ['plan', '--manifest', manifest, '--root', '/', '--json'],
    ['plan', '--manifest', manifest, '--unknown'], ['plan', '--manifest', '/private/a\n.json'], ['plan', '--manifest', '/private/a\u0085.json'],
  ])('rejects invalid invocation before reading or planning %j', async (...args) => {
    expect(await cmdUniverseIntegration([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
  });

  it('rejects malformed manifests as usage errors without invoking the planner', async () => {
    files.readResourceJson.mockReturnValue({ schemaVersion: 1, id: 'bad' });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration manifest is invalid or unavailable' });
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
  });

  it('reads exactly one bounded private manifest and forwards the selected root', async () => {
    const value = definition();
    files.readResourceJson.mockReturnValue(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--root', '/private/store', '--json'])).toBe(0);
    expect(files.readResourceJson).toHaveBeenCalledExactlyOnceWith(manifest, 256 * 1024);
    expect(core.readUniverseIntegrationPlan).toHaveBeenCalledExactlyOnceWith(value, { root: '/private/store' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
  });

  it('preserves the exact planner DTO in JSON and labels text as structural only', async () => {
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[1]![0] as string;
    expect(text).toContain('Scope: same-repository-pinned-base-overlay · authority: observation-only');
    expect(text).toContain('Composition: ready · digest');
    expect(text).toContain('Sources: 2');
    expect(text).toContain('one · verified · delivery');
    expect(text).toContain('Entries: 1 deterministic overlay entries');
    expect(text).toContain('src/one.ts ·');
    expect(text).toContain('Composition digest is a recipe identity only');
    expect(text).toContain('No Git tree, ref, artifact, delivery, evaluator, provider, or deployment action was performed');
  });

  it('returns incomplete for unavailable or conflicting composition evidence', async () => {
    const value = plan({ sourceState: 'healthy', compositionReady: false, compositionDigest: null,
      reasons: ['composition-conflicts'], conflicts: [{ code: 'path-conflict', paths: ['src/one.ts'], sourceDeliveryIds: ['1'.repeat(64), '2'.repeat(64)] }] });
    core.readUniverseIntegrationPlan.mockReturnValue(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(1);
    expect(output.mock.calls[1]![0]).toContain('Composition: blocked');
    expect(output.mock.calls[1]![0]).toContain('digest unavailable');
    expect(output.mock.calls[1]![0]).toContain('Conflict: path-conflict · src/one.ts');
  });

  it('redacts planner failures and keeps the invalid manifest path out of output', async () => {
    core.readUniverseIntegrationPlan.mockImplementation(() => { throw new Error(`EACCES ${manifest}`); });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration plan unavailable' });
    expect(output.mock.calls[0]![0]).not.toContain(manifest);
    expect(files.readResourceJson).toHaveBeenCalledOnce();
  });

  it('routes integration planning through the Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['integration', 'plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.readUniverseIntegrationPlan).toHaveBeenCalledOnce();
  });

  it('prints help without reading the manifest', async () => {
    expect(await cmdUniverseIntegration(['--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('combined-artifact composition plan');
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
  });

  it.each(['bash', 'zsh'])('includes integration in %s completions', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([value]) => value).join('')).toMatch(/universe\).*integration/);
  });

  it('reports non-JSON planner errors on stderr without leaking private paths', async () => {
    core.readUniverseIntegrationPlan.mockImplementation(() => { throw new Error('source unavailable'); });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(1);
    expect(errors).toHaveBeenCalledWith('universe integration: Integration plan unavailable');
    expect(errors.mock.calls[0]![0]).not.toContain(manifest);
  });
});
