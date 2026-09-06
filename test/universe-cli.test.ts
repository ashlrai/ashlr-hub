import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseOverview, UniverseRun } from '../src/core/universe/types.js';

const core = vi.hoisted(() => ({
  initUniverse: vi.fn(), readUniverseOverview: vi.fn(), runUniverse: vi.fn(),
}));
const demo = vi.hoisted(() => ({ runUniverseDemo: vi.fn() }));
const files = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
vi.mock('../src/cli/universe-demo.js', () => demo);
vi.mock('node:fs', () => files);
import { cmdUniverse } from '../src/cli/universe.js';

function overview(): UniverseOverview {
  return { schemaVersion: 1, sampledAt: '2026-09-06T00:00:00Z', sourceState: 'missing',
    reasons: [], universes: [], measurementScope: 'local-experiment' };
}

function run(status: UniverseRun['status'] = 'completed'): UniverseRun {
  return { id: 'r1', universeId: 'demo', generation: 1, manifestDigest: 'a'.repeat(64),
    comparatorDigest: 'b'.repeat(64), startedAt: '2026-09-06T00:00:00Z',
    finishedAt: '2026-09-06T00:00:01Z', status, trials: [], durationMs: 1000,
    tokensUsed: null, costUsd: null };
}

describe('Universe CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.readUniverseOverview.mockReturnValue(overview());
    core.runUniverse.mockResolvedValue(run());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['run'], ['run', '../escape'], ['run', 'one', 'two'], ['unknown'],
    ['status', '--wat'], ['status', '--root'], ['init'],
    ['status', '--manifest', 'a.json'], ['demo', '--root', '/a', '--root', '/b'],
  ])('rejects invalid invocation %j before executing', async (...args) => {
    expect(await cmdUniverse([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.initUniverse).not.toHaveBeenCalled();
    expect(core.runUniverse).not.toHaveBeenCalled();
    expect(demo.runUniverseDemo).not.toHaveBeenCalled();
  });

  it('defaults to a read-only status with machine-readable output', async () => {
    expect(await cmdUniverse(['--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(overview());
    expect(core.runUniverse).not.toHaveBeenCalled();
  });

  it('reports missing requested experiments, rather than a misleading empty success', async () => {
    expect(await cmdUniverse(['archive', 'missing', '--json'])).toBe(1);
    expect(output).toHaveBeenCalledWith(JSON.stringify({ error: 'Universe not found: missing' }));
  });

  it('returns a failure exit code for degraded records while preserving observations', async () => {
    core.readUniverseOverview.mockReturnValue({ ...overview(), sourceState: 'degraded', reasons: ['Invalid ledger'] });
    expect(await cmdUniverse(['status', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).reasons).toEqual(['Invalid ledger']);
  });

  it('does not equate unknown usage with zero', async () => {
    expect(await cmdUniverse(['run', 'demo'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('tokens: unmeasured · cost: unmeasured');
  });

  it('shows provider-reported generation tokens with their coverage and scope', async () => {
    core.runUniverse.mockResolvedValue({ ...run(), tokensUsed: 1350,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: 1200, outputTokens: 150 },
      trials: [{ id: 'trial-model', variantId: 'local-coder', niche: 'efficient', parentTrialId: null,
        status: 'passed', score: 10, metrics: {}, artifact: null, durationMs: 900, delta: null, selected: true,
        generation: { schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-coder',
          status: 'succeeded', requestStarted: true, promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64), durationMs: 700,
          usage: { state: 'reported', inputTokens: 1200, outputTokens: 150 }, changedFiles: ['candidate.mjs'] } }],
    });
    expect(await cmdUniverse(['run', 'demo'])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Trials: 1/1 passed · 1 admitted to niche archive');
    expect(text).toContain('local-openai-compatible · local-coder');
    expect(text).toContain('http://127.0.0.1:11434/v1 · request started');
    expect(text).toContain('Provider-reported tokens: input=1200 output=150');
    expect(text).toContain('tokens: 1350 (model generation only) · cost: unmeasured');
    expect(text).toContain('Generation usage coverage: 1/1 recorded started requests reported tokens');
  });

  it('keeps incomplete generation accounting unknown instead of summing partial coverage', async () => {
    core.runUniverse.mockResolvedValue({ ...run(), generationUsage: {
      scope: 'model-generation', trials: 2, requestsStarted: 2, reportedRequests: 1,
      inputTokens: null, outputTokens: null,
    } });
    expect(await cmdUniverse(['run', 'demo'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('tokens: unmeasured · cost: unmeasured');
    expect(output.mock.calls[0]![0]).toContain('Generation usage coverage: 1/2 recorded started requests reported tokens');
  });

  it('preserves a reported zero token total without inventing a dollar cost', async () => {
    core.runUniverse.mockResolvedValue({ ...run(), tokensUsed: 0, generationUsage: {
      scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1,
      inputTokens: 0, outputTokens: 0,
    } });
    expect(await cmdUniverse(['run', 'demo'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('tokens: 0 (model generation only) · cost: unmeasured');
  });

  it('passes the chosen root and abort signal to execution and removes signal handlers', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    expect(await cmdUniverse(['run', 'demo', '--root', '/private/experiment', '--json'])).toBe(0);
    expect(core.runUniverse).toHaveBeenCalledWith('demo', {
      root: '/private/experiment', signal: expect.any(AbortSignal),
    });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('returns interrupted execution as non-success', async () => {
    core.runUniverse.mockResolvedValue(run('interrupted'));
    expect(await cmdUniverse(['run', 'demo', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).status).toBe('interrupted');
  });

  it('does not report a one-generation demo as completed', async () => {
    demo.runUniverseDemo.mockResolvedValue({ universeId: 'demo', runs: [run()], verified: false });
    expect(await cmdUniverse(['demo', '--json'])).toBe(1);
    demo.runUniverseDemo.mockResolvedValue({ universeId: 'demo', runs: [run(), { ...run(), generation: 2 }], verified: true });
    expect(await cmdUniverse(['demo', '--json'])).toBe(0);
  });

  it('fails the demo when two completed generations did not prove the learning loop', async () => {
    demo.runUniverseDemo.mockResolvedValue({ universeId: 'demo', runs: [run(), run()], verified: false });
    expect(await cmdUniverse(['demo', '--json'])).toBe(1);
  });

  it('registers the parsed manifest through core validation', async () => {
    const manifest = { id: 'example', name: 'Example' };
    files.readFileSync.mockReturnValue(JSON.stringify(manifest));
    core.initUniverse.mockReturnValue(manifest);
    expect(await cmdUniverse(['init', '--manifest', '/private/manifest.json', '--json'])).toBe(0);
    expect(core.initUniverse).toHaveBeenCalledWith(manifest, { root: undefined });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(manifest);
  });

  it('never runs when registration cannot parse the manifest', async () => {
    files.readFileSync.mockReturnValue('{broken');
    expect(await cmdUniverse(['init', '--manifest', '/private/manifest.json', '--json'])).toBe(1);
    expect(core.initUniverse).not.toHaveBeenCalled();
  });

  it('prints help without reading a store', async () => {
    expect(await cmdUniverse(['help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('init --manifest');
    expect(output.mock.calls[0]![0]).toContain('explicitly configured loopback model');
    expect(output.mock.calls[0]![0]).toContain('without auth or tools');
    expect(core.readUniverseOverview).not.toHaveBeenCalled();
  });
});
