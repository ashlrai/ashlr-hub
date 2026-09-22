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
  formatAge,
  formatCountdown,
  localStaleness,
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
    placement: 'unknown',
    gpuPercent: null,
    memoryPercent: null,
    family: null,
    arch: null,
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
        freeMemoryBytes: null,
        reason: null,
        runtimes: [],
        notes: [],
        sampledAt: null,
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
        freeMemoryBytes: null,
        reason: null,
        runtimes: [],
        notes: [],
        sampledAt: null,
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

describe('localStaleness — a retained reading says how old it is', () => {
  const runtime = (over: Partial<{ runtime: 'ollama' | 'lmstudio'; stale: boolean; staleForMs: number | null }>) => ({
    runtime: 'ollama' as const,
    reachable: true,
    reason: null,
    stale: false,
    staleForMs: null,
    modelCount: 0,
    ...over,
  });

  it('reports nothing stale when every report is fresh', () => {
    expect(localStaleness([runtime({})]).stale).toBe(false);
  });

  /**
   * A panel is only as fresh as its stalest input: showing the NEWER of two
   * retained readings would understate how old the screen is.
   */
  it('takes the age of the oldest retained reading', () => {
    const verdict = localStaleness([
      runtime({ stale: true, staleForMs: 4_000 }),
      runtime({ runtime: 'lmstudio', stale: true, staleForMs: 19_000 }),
    ]);
    expect(verdict.stale).toBe(true);
    expect(verdict.staleForMs).toBe(19_000);
    expect(verdict.runtimes).toEqual(['ollama', 'lmstudio']);
  });

  it('stays stale with a null age when the server reported no interval', () => {
    const verdict = localStaleness([runtime({ stale: true, staleForMs: null })]);
    expect(verdict.stale).toBe(true);
    expect(verdict.staleForMs).toBeNull();
    expect(formatAge(verdict.staleForMs)).toBe('an unreported interval');
  });
});

describe('formatAge', () => {
  it('reads in seconds under a minute and in minutes above it', () => {
    expect(formatAge(12_400)).toBe('12s');
    expect(formatAge(90_000)).toBe('1m 30s');
    expect(formatAge(120_000)).toBe('2m');
  });
});

describe('agentic counts — "cannot" and "did not say" are counted apart', () => {
  it('never folds an unreported capability list into the cannot-drive count', () => {
    const view = buildLocalModelsView(
      {
        reachable: true,
        memoryBudgetBytes: 100,
        freeMemoryBytes: null,
        reason: null,
        runtimes: [],
        notes: [],
        sampledAt: null,
        models: [
          model({ name: 'tools', supportsTools: true }),
          model({ name: 'no-tools', supportsTools: false }),
          model({ name: 'unsaid', supportsTools: null, capabilities: [] }),
        ],
      },
      NOW,
    );
    expect(view?.agenticCount).toBe(1);
    expect(view?.nonAgenticCount).toBe(1);
    expect(view?.unknownToolCount).toBe(1);
  });
});

describe('placement and machine share', () => {
  it("prefers the runtime's own gpuPercent over recomputing it from sizes", () => {
    const row = buildLocalModelRow(
      model({ name: 'x', loaded: true, sizeBytes: 100, sizeVramBytes: 100, gpuPercent: 62 }),
      NOW,
    );
    expect(row.gpuPct).toBe(62);
  });

  /**
   * `sizeBytes` for an UNLOADED model is its on-disk size. Reporting a share
   * of machine memory from it would claim memory that is not in use — the
   * exact misreading this panel's "can I run this now" question cannot afford.
   */
  it('reports no machine share for a model that is not resident', () => {
    const row = buildLocalModelRow(model({ name: 'x', loaded: false, memoryPercent: 40 }), NOW);
    expect(row.memoryPct).toBeNull();
  });

  it('keeps the machine share for a resident model', () => {
    const row = buildLocalModelRow(model({ name: 'x', loaded: true, memoryPercent: 40 }), NOW);
    expect(row.memoryPct).toBe(40);
  });
});
