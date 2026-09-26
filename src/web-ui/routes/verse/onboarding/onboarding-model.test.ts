/**
 * The first-run tour's honesty rules, tested without a DOM.
 *
 * Every assertion here is about the same failure mode: the tour is the
 * operator's first calibration of how much this app's claims can be trusted,
 * so an absent read must never come back as a green check, and a used-up
 * window on an account with a spendable balance must never come back as
 * "blocked".
 */
import { describe, expect, it } from 'vitest';
import type { LocalModel, LocalModelsSnapshot } from '../usage/usage-contract.js';
import {
  ONBOARDING_STEPS,
  STOP_CONTROLS,
  buildLocalFinding,
  clampStep,
} from './onboarding-model.js';

function localSnapshot(patch: Partial<LocalModelsSnapshot>): LocalModelsSnapshot {
  return {
    reachable: true,
    models: [],
    memoryBudgetBytes: null,
    freeMemoryBytes: null,
    reason: null,
    runtimes: [],
    notes: [],
    sampledAt: null,
    ...patch,
  };
}

function model(patch: Partial<LocalModel>): LocalModel {
  return {
    name: 'qwen3:8b',
    runtime: 'ollama',
    loaded: true,
    sizeBytes: null,
    sizeVramBytes: null,
    placement: 'gpu',
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
    supportsTools: true,
    ...patch,
  } as LocalModel;
}

describe('onboarding steps', () => {
  it('clamps a stored step into the real range', () => {
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(99)).toBe(ONBOARDING_STEPS.length - 1);
    expect(clampStep(Number.NaN)).toBe(0);
  });

  it('covers the five things a first-time operator is blocked on', () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(['welcome', 'accounts', 'local', 'stops', 'finish']);
  });
});

describe('local runtime finding', () => {
  it('does not claim a runtime is absent when the probe merely got no answer', () => {
    const finding = buildLocalFinding({
      snapshot: localSnapshot({ reachable: false, reason: 'ollama-unreachable' }),
      loading: false,
      unavailableReason: null,
    });
    expect(finding.tone).toBe('attention');
    expect(finding.summary).toMatch(/cannot tell whether one is not running or not installed/);
    expect(finding.fix).toMatch(/Refresh in Usage/);
  });

  it('reports availability with the tool-capable count, because that is what gates an agentic turn', () => {
    const finding = buildLocalFinding({
      snapshot: localSnapshot({ models: [model({}), model({ name: 'x', supportsTools: false })] }),
      loading: false,
      unavailableReason: null,
    });
    expect(finding.tone).toBe('ok');
    expect(finding.modelCount).toBe(2);
    expect(finding.toolCapableCount).toBe(1);
    expect(finding.summary).toMatch(/1 of them tool-capable/);
  });

  it('says so when every local model is tool-incapable', () => {
    const finding = buildLocalFinding({
      snapshot: localSnapshot({ models: [model({ supportsTools: false })] }),
      loading: false,
      unavailableReason: null,
    });
    expect(finding.meaning).toMatch(/cannot run an agentic turn/);
  });

  it('marks a retained reading as retained instead of presenting it as fresh', () => {
    const finding = buildLocalFinding({
      snapshot: localSnapshot({
        models: [model({})],
        runtimes: [{ runtime: 'ollama', reachable: true, reason: null, stale: true, staleForMs: 4_000, modelCount: 1 }],
      }),
      loading: false,
      unavailableReason: null,
    });
    expect(finding.stale).toBe(true);
    expect(finding.state).toMatch(/retained/);
    expect(finding.summary).toMatch(/Last known reading\./);
  });

  it('an absent route is unknown, never ok and never attention-with-a-fix-it-invented', () => {
    const finding = buildLocalFinding({
      snapshot: null,
      loading: false,
      unavailableReason: 'This server does not expose /api/verse/local-models yet, so this panel has no source.',
    });
    expect(finding.tone).toBe('unknown');
    expect(finding.state).toBe('not reported');
    expect(finding.fix).toMatch(/does not expose/);
  });

  it('a reachable runtime with no models is not presented as ready', () => {
    const finding = buildLocalFinding({ snapshot: localSnapshot({ models: [] }), loading: false, unavailableReason: null });
    expect(finding.tone).toBe('attention');
    expect(finding.state).toBe('no models');
  });
});

describe('the three stops', () => {
  it('never calls the kill switch a pause, and says Stop loop engages it too', () => {
    const joined = STOP_CONTROLS.map((c) => `${c.name} ${c.scope} ${c.limit}`).join(' ');
    expect(STOP_CONTROLS.map((c) => c.name)).toEqual(['Pause', 'Stop loop', 'Emergency stop']);

    const emergency = STOP_CONTROLS.find((c) => c.name === 'Emergency stop')!;
    expect(emergency.scope.toLowerCase()).not.toMatch(/pause/);

    const stop = STOP_CONTROLS.find((c) => c.name === 'Stop loop')!;
    expect(stop.scope).toMatch(/GLOBAL kill switch/);
    expect(stop.reversible).toMatch(/use Pause/);

    const pause = STOP_CONTROLS.find((c) => c.name === 'Pause')!;
    expect(pause.limit).toMatch(/write tools keep working/);
    expect(pause.tone).toBe('ok');

    // And the blast radius of the global sentinel is stated, not implied.
    expect(joined).toMatch(/agent’s own write tools/);
  });
});
