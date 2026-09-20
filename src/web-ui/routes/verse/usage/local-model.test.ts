/**
 * local-model.test.ts — local availability, with the emphasis on the two
 * places where a convenient default would be a lie: an unreported capability
 * list is not "no tools", and an unreported resident size makes the TOTAL
 * unknown rather than smaller.
 */
import { describe, expect, it } from 'vitest';
import type { LocalModel } from './usage-contract.js';
import { projectLocalModels } from './usage-contract.js';
import {
  buildLocalModelRow,
  buildLocalModelsView,
  formatBytes,
  formatContext,
  formatCountdown,
  toolSupport,
} from './local-model.js';

const NOW = Date.parse('2026-09-20T10:00:00.000Z');

function model(over: Partial<LocalModel> & { name: string }): LocalModel {
  return {
    runtime: 'ollama',
    supportsTools: null,
    loaded: false,
    sizeBytes: null,
    sizeVramBytes: null,
    expiresAt: null,
    parameterSize: null,
    quantization: null,
    nativeContext: null,
    configuredContext: null,
    capabilities: null,
    ...over,
  };
}

describe('toolSupport — refusing to answer is not answering "no"', () => {
  it('reports an unlisted capability set as unknown', () => {
    expect(toolSupport(null)).toBe('unknown');
  });

  it('reports a listed set honestly in both directions', () => {
    expect(toolSupport(['completion', 'tools'])).toBe('supported');
    expect(toolSupport(['completion'])).toBe('unsupported');
  });
});

describe('buildLocalModelRow', () => {
  it('derives the GPU share from size_vram against size', () => {
    const row = buildLocalModelRow(
      model({ name: 'a', loaded: true, sizeBytes: 100, sizeVramBytes: 80 }),
      NOW,
    );
    expect(row.gpuPct).toBe(80);
  });

  it('leaves the GPU share null rather than assuming an unreported split is all GPU', () => {
    const row = buildLocalModelRow(model({ name: 'a', loaded: true, sizeBytes: 100 }), NOW);
    expect(row.gpuPct).toBeNull();
  });

  it('turns expires_at into a keep-alive countdown only while resident', () => {
    const resident = buildLocalModelRow(
      model({ name: 'a', loaded: true, expiresAt: '2026-09-20T10:04:00.000Z' }),
      NOW,
    );
    expect(resident.expiresInMs).toBe(240_000);

    const installed = buildLocalModelRow(
      model({ name: 'a', loaded: false, expiresAt: '2026-09-20T10:04:00.000Z' }),
      NOW,
    );
    expect(installed.expiresInMs).toBeNull();
  });

  it('flags a seat configured below the model’s native context', () => {
    const row = buildLocalModelRow(
      model({ name: 'a', nativeContext: 262_144, configuredContext: 65_536 }),
      NOW,
    );
    expect(row.contextTruncated).toBe(true);
  });
});

describe('buildLocalModelsView', () => {
  it('puts resident models first, because they are the answer to "right now"', () => {
    const view = buildLocalModelsView(
      {
        reachable: true,
        memoryBudgetBytes: 100,
        reason: null,
        models: [model({ name: 'zeta' }), model({ name: 'alpha', loaded: true, sizeBytes: 40 })],
      },
      NOW,
    );
    expect(view?.rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
    expect(view?.memoryUsedPct).toBe(40);
  });

  it('withholds the resident total when one resident model reported no size', () => {
    const view = buildLocalModelsView(
      {
        reachable: true,
        memoryBudgetBytes: 100,
        reason: null,
        models: [model({ name: 'a', loaded: true, sizeBytes: 40 }), model({ name: 'b', loaded: true })],
      },
      NOW,
    );
    // Summing only the known one would understate memory pressure.
    expect(view?.residentBytes).toBeNull();
    expect(view?.memoryUsedPct).toBeNull();
  });

  it('is null when no local source answered, so the panel says so instead of showing an empty machine', () => {
    expect(buildLocalModelsView(null, NOW)).toBeNull();
  });
});

describe('projectLocalModels — tolerant of Ollama-native spellings', () => {
  it('accepts size_vram / expires_at / parameter_size as they come off the runtime', () => {
    const snapshot = projectLocalModels({
      reachable: true,
      memoryBudgetBytes: 137_438_953_472,
      models: [
        {
          name: 'qwen3-coder',
          loaded: true,
          size: 100,
          size_vram: 90,
          expires_at: '2026-09-20T10:05:00.000Z',
          parameter_size: '79.7B',
          quantization_level: 'Q4_K_M',
          capabilities: ['completion', 'tools'],
        },
      ],
    });
    expect(snapshot?.models[0]?.sizeVramBytes).toBe(90);
    expect(snapshot?.models[0]?.parameterSize).toBe('79.7B');
    expect(snapshot?.models[0]?.quantization).toBe('Q4_K_M');
  });

  it('is null for a body with no models array, rather than an empty list', () => {
    expect(projectLocalModels({ reachable: true })).toBeNull();
  });
});

describe('formatters', () => {
  it('formats bytes at model scale', () => {
    expect(formatBytes(64 * 1024 ** 3)).toBe('64 GB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(null)).toBe('—');
  });

  it('never renders a past-due keep-alive as a negative countdown', () => {
    expect(formatCountdown(-5_000)).toBe('expired');
    expect(formatCountdown(240_000)).toBe('4m 0s');
    expect(formatCountdown(null)).toBe('—');
  });

  it('formats context windows compactly', () => {
    expect(formatContext(262_144)).toBe('256k');
    expect(formatContext(65_536)).toBe('64k');
    expect(formatContext(null)).toBe('—');
  });
});
