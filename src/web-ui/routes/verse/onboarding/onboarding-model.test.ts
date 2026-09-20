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
import type { Account, AccountsSnapshot, LocalModel, LocalModelsSnapshot } from '../usage/usage-contract.js';
import {
  ONBOARDING_STEPS,
  STOP_CONTROLS,
  buildAccountsFindings,
  buildLocalFinding,
  clampStep,
} from './onboarding-model.js';

function account(patch: Partial<Account>): Account {
  return {
    id: 'claude',
    label: 'Claude Max',
    provider: 'claude',
    state: 'observed',
    authentication: 'signed-in',
    health: null,
    planType: 'max',
    observedAt: null,
    windows: [],
    binding: null,
    credits: null,
    reason: null,
    unsupported: null,
    reconnectCommand: null,
    notes: [],
    ...patch,
  };
}

function snapshot(accounts: Account[]): AccountsSnapshot {
  return { sampledAt: null, refreshing: false, accounts, collectorNote: null };
}

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

describe('accounts findings', () => {
  it('flags a signed-out seat and carries a concrete fix', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([
        account({ id: 'grok', label: 'Grok', provider: 'grok', state: 'signed-out', authentication: 'signed-out' }),
      ]),
      loading: false,
      unavailableReason: null,
    });
    expect(result.signedOutCount).toBe(1);
    const finding = result.findings![0]!;
    expect(finding.tone).toBe('attention');
    expect(finding.state).toBe('signed out');
    expect(finding.fix).toBe('Reconnect the Grok seat through `ashlr resources`.');
  });

  it('prefers the server’s own sanitized reconnect command over the generic one', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([account({ state: 'signed-out', authentication: 'signed-out', reconnectCommand: 'ashlr resources' })]),
      loading: false,
      unavailableReason: null,
    });
    expect(result.findings![0]!.fix).toBe('ashlr resources');
  });

  it('never calls a used-up window "blocked" when credits are spendable', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([
        account({
          id: 'codex-a',
          label: 'Personal Codex',
          provider: 'codex',
          binding: { id: 'codex', label: null, usedPercent: 100, resetsAt: null, resetDescription: null, limitReached: true, measured: false },
          credits: { hasCredits: true, unlimited: false, balance: '2048.41', balanceValue: 2048.41 },
        }),
      ]),
      loading: false,
      unavailableReason: null,
    });
    const finding = result.findings![0]!;
    expect(finding.tone).toBe('ok');
    expect(finding.state).toBe('usable on credits');
    expect(finding.detail).toMatch(/still has a spendable balance/);
  });

  it('says "limit reached", never "100% used", when the sentinel was a flag', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([
        account({
          binding: { id: 'w', label: null, usedPercent: 100, resetsAt: null, resetDescription: null, limitReached: true, measured: false },
        }),
      ]),
      loading: false,
      unavailableReason: null,
    });
    expect(result.findings![0]!.state).toBe('limit reached');
    expect(result.findings![0]!.detail).not.toMatch(/100%/);
  });

  it('renders an unmeasured percentage as no signal rather than a number', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([
        account({
          binding: { id: 'w', label: null, usedPercent: 47, resetsAt: null, resetDescription: null, limitReached: false, measured: false },
        }),
      ]),
      loading: false,
      unavailableReason: null,
    });
    expect(result.findings![0]!.detail).toMatch(/No local utilization signal/);
    expect(result.findings![0]!.detail).not.toMatch(/47/);
  });

  it('turns an absent roster into "cannot say", not into an empty all-clear', () => {
    const result = buildAccountsFindings({
      snapshot: null,
      loading: false,
      unavailableReason: 'This server does not expose /api/verse/accounts yet, so this panel has no source.',
    });
    expect(result.findings).toBeNull();
    expect(result.summary).toMatch(/did not report a per-account roster/);
    expect(result.caveat).toMatch(/does not expose/);
  });

  it('distinguishes an empty roster from a roster it could not read', () => {
    const result = buildAccountsFindings({ snapshot: snapshot([]), loading: false, unavailableReason: null });
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatch(/No provider accounts are connected/);
  });

  it('names the version pin when a probe failed closed, and does not call the seat broken', () => {
    const result = buildAccountsFindings({
      snapshot: snapshot([account({ unsupported: { code: 'claude-usage-unsupported', pinnedVersion: '2.0.14' } })]),
      loading: false,
      unavailableReason: null,
    });
    const finding = result.findings![0]!;
    expect(finding.state).toBe('probe blocked');
    expect(finding.detail).toMatch(/2\.0\.14/);
    expect(finding.detail).toMatch(/seat itself still works/);
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
    expect(finding.summary).toMatch(/retained reading, not a fresh probe/);
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
