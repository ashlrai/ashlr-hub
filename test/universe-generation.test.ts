import { describe, expect, it } from 'vitest';
import { generationResources, newGenerationReceipt, validateGenerationConfig, validGenerationReceipt, validGenerationUsage } from '../src/core/universe/generation.js';
import { validateUniverseManifest } from '../src/core/universe/store.js';
import type { UniverseGenerationConfig, UniverseGenerationReceipt, UniverseManifest, UniverseTrial } from '../src/core/universe/types.js';

const config: UniverseGenerationConfig = { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434',
  model: 'fixture-model', files: ['src/candidate.mjs'], maxOutputTokens: 1024 };
const manifest: UniverseManifest = { schemaVersion: 1, id: 'generation', name: 'Generation contract', objective: 'Improve the fixture',
  seed: { repo: '/fictional/seed', revision: '1'.repeat(40) }, metric: { name: 'score', direction: 'maximize', minImprovement: 0 },
  budget: { maxTrials: 2, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 500 },
  evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 100 },
  variants: [{ id: 'one', niche: 'one', hypothesis: 'Improve it', generation: config }] };
function receipt(input = 5, output = 2): UniverseGenerationReceipt {
  return { ...newGenerationReceipt(config), requestStarted: true, promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64),
    usage: { state: 'reported', inputTokens: input, outputTokens: output } };
}
function trial(generation?: UniverseGenerationReceipt): UniverseTrial {
  return { id: 'one', variantId: 'one', niche: 'one', parentTrialId: null, status: 'failed', score: null, metrics: {},
    artifact: null, durationMs: 1, delta: null, selected: false, ...(generation ? { generation } : {}) };
}

describe('Universe generation contracts and resource coverage', () => {
  it('normalizes the broker endpoint without mutating the immutable manifest input', () => {
    expect(validateGenerationConfig(config).endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(validateUniverseManifest(manifest).variants[0]!.generation?.endpoint).toBe(config.endpoint);
    expect(config.endpoint).toBe('http://127.0.0.1:11434');
    expect(validGenerationReceipt(newGenerationReceipt(config))).toBe(true);
  });

  it.each(['https://127.0.0.1:11434', 'http://localhost:11434', 'http://192.0.2.1',
    'http://user:password@127.0.0.1', 'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/private'])(
    'rejects undeclared remote, credentialed or ambiguous endpoint %s', (endpoint) => {
    expect(() => validateGenerationConfig({ ...config, endpoint })).toThrow();
  });

  it('rejects conflicting variant modes and accepts legacy command labels without inventing usage', () => {
    const variant = manifest.variants[0]!;
    expect(() => validateUniverseManifest({ ...manifest, variants: [{ ...variant, command: ['node', 'worker.mjs'] }] })).toThrow();
    expect(() => validateUniverseManifest({ ...manifest, variants: [{ ...variant, model: 'label' }] })).toThrow();
    expect(validateUniverseManifest({ ...manifest, variants: [{ id: 'legacy', niche: 'one', hypothesis: 'old',
      command: ['node', 'worker.mjs'], model: 'label-only' }] }).variants[0]?.model).toBe('label-only');
  });

  it('validates portable unique paths and bounded protocol fields', () => {
    for (const files of [[], ['../x'], ['/x'], ['a/../x'], ['.git/config'], ['a\\x'], ['a//x'], ['C:x'], ['a\0x'], ['a', 'a']]) {
      expect(() => validateGenerationConfig({ ...config, files })).toThrow();
    }
    for (const maxOutputTokens of [0, -1, 0.5, 16385, Infinity]) {
      expect(() => validateGenerationConfig({ ...config, maxOutputTokens })).toThrow();
    }
    expect(() => validateGenerationConfig({ ...config, tools: true })).toThrow();
  });

  it('keeps no-model legacy trials and no-request model preflights unmeasured', () => {
    expect(generationResources([trial()])).toEqual({ tokensUsed: null, costUsd: null });
    expect(generationResources([trial(newGenerationReceipt(config))])).toEqual({ tokensUsed: null, costUsd: null,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 0, reportedRequests: 0, inputTokens: null, outputTokens: null } });
  });

  it('counts failed requests, excludes non-request preflights, and distinguishes observed zero', () => {
    expect(generationResources([trial(receipt()), trial(receipt(0, 0)), trial(newGenerationReceipt(config)), trial()]))
      .toEqual({ tokensUsed: 7, costUsd: null, generationUsage: { scope: 'model-generation', trials: 3,
        requestsStarted: 2, reportedRequests: 2, inputTokens: 5, outputTokens: 2 } });
    expect(generationResources([trial(receipt(0, 0))]).tokensUsed).toBe(0);
  });

  it('does not present incomplete or overflowed aggregate usage as a complete total', () => {
    const unknown: UniverseGenerationReceipt = { ...receipt(), usage: { state: 'unavailable', inputTokens: null, outputTokens: null } };
    expect(generationResources([trial(receipt()), trial(unknown)]))
      .toMatchObject({ tokensUsed: null, generationUsage: { requestsStarted: 2, reportedRequests: 1, inputTokens: null, outputTokens: null } });
    const overflow = generationResources([trial(receipt(Number.MAX_SAFE_INTEGER, 0)), trial(receipt(1, 0))]);
    expect(overflow.tokensUsed).toBeNull();
    expect(validGenerationUsage(overflow.generationUsage)).toBe(true);
    expect(generationResources([trial(receipt())], false)).toEqual({ tokensUsed: null, costUsd: null,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: null, outputTokens: null } });
  });

  it('rejects internally inconsistent receipts and fabricated usage states', () => {
    expect(validGenerationReceipt(receipt())).toBe(true);
    const invalid: unknown[] = [
      { ...receipt(), requestStarted: false }, { ...receipt(), promptDigest: null },
      { ...receipt(), usage: { state: 'unavailable', inputTokens: 0, outputTokens: 0 } },
      { ...receipt(), usage: { state: 'reported', inputTokens: -1, outputTokens: 2 } },
      { ...receipt(), usage: { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } },
      { ...receipt(), usage: { state: 'estimated', inputTokens: 5, outputTokens: 2 } },
      { ...receipt(), changedFiles: ['src/candidate.mjs'] },
      { ...receipt(), endpoint: config.endpoint },
      { ...receipt(), status: 'succeeded', responseDigest: null },
    ];
    for (const value of invalid) expect(validGenerationReceipt(value)).toBe(false);
  });
});
