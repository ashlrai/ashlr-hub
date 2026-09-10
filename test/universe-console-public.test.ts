import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { UniverseOverview } from '../src/core/universe/types.js';
import type { UniverseGraph } from '../src/core/universe/graph-types.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniversePortfolioControllerReport } from '../src/core/universe/portfolio-controller-types.js';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES, serializeUniverseConsoleGraph,
  projectUniverseConsoleCampaignReadiness, serializeUniverseConsoleCampaignReadiness,
  projectUniverseConsoleControllerStatus, serializeUniverseConsoleControllerStatus,
  serializeUniverseConsoleOverview, validateUniverseConsoleResponse } from '../src/core/web/universe-console-public.js';

function overview(): UniverseOverview {
  const run = { id: 'run', trials: [{ id: 'trial', diagnostics: [{ code: 'candidate-failed', message: 'private diagnostic detail' }] }] };
  return { schemaVersion: 1, universes: [{ runs: [run], activeRun: run }],
    sampledAt: '2026-09-07T00:00:00Z', sourceState: 'healthy', reasons: [] } as unknown as UniverseOverview;
}

describe('scoped console public worker serialization', () => {
  it('allowlists controller, outcomes and controls without leaking private or future fields', () => {
    const source = { schemaVersion: 1, controllerId: 'one', sourceState: 'healthy', status: 'drained',
      createdAt: '2026-09-09T00:00:00Z', deadlineAt: '2026-09-09T00:01:00Z', observedAt: '2026-09-09T00:00:03Z',
      definitionDigest: 'private-definition', reasons: [], futurePrivateField: 'private-future',
      outcomes: [{ campaignId: 'a', state: 'held', attempted: false, reasonCode: 'campaign-paused',
        campaignDigest: 'private-campaign', deliveryDigest: 'private-delivery', future: 'private-outcome' }],
      control: { mode: 'drain', sequence: 3, requestedAt: '2026-09-09T00:00:01Z',
        acknowledgedAt: '2026-09-09T00:00:02Z', future: 'private-control' } } as UniversePortfolioControllerReport;
    const before = JSON.stringify(source); const projected = projectUniverseConsoleControllerStatus(source);
    expect(Object.keys(projected).sort()).toEqual(['schemaVersion', 'controllerId', 'sourceState', 'status', 'createdAt',
      'deadlineAt', 'observedAt', 'reasons', 'outcomes', 'control'].sort());
    expect(projected.outcomes).toEqual([{ campaignId: 'a', state: 'held', attempted: false, reasonCode: 'campaign-paused' }]);
    expect(projected.control).toEqual({ mode: 'drain', sequence: 3, requestedAt: '2026-09-09T00:00:01Z',
      acknowledgedAt: '2026-09-09T00:00:02Z' });
    const serialized = serializeUniverseConsoleControllerStatus(source);
    expect(JSON.parse(serialized)).toEqual(projected); expect(serialized).not.toContain('private-');
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(['missing', 'degraded'] as const)('preserves %s controller evidence without inventing control or timestamps', (sourceState) => {
    const source: UniversePortfolioControllerReport = { schemaVersion: 1, controllerId: 'one', sourceState,
      status: 'unavailable', createdAt: null, deadlineAt: null, observedAt: '2026-09-09T00:00:00Z',
      definitionDigest: null, outcomes: [], reasons: ['controller-unavailable'] };
    expect(JSON.parse(serializeUniverseConsoleControllerStatus(source))).toEqual({ schemaVersion: 1, controllerId: 'one', sourceState,
      status: 'unavailable', createdAt: null, deadlineAt: null, observedAt: source.observedAt, outcomes: [], reasons: source.reasons });
  });
  it('projects only independent enrollment topology IDs and arrays', () => {
    const source = { schemaVersion: 1, controllerId: 'one', sourceState: 'healthy', status: 'incomplete',
      createdAt: null, deadlineAt: null, observedAt: '2026-09-09T00:00:00Z', definitionDigest: null, outcomes: [], reasons: [],
      topology: [{ campaignId: 'a', dependsOn: ['b'], prerequisites: ['b', 'c'], privatePath: '/private/repo',
        campaignDigest: 'private-witness', futureAuthority: 'run' }] } as unknown as UniversePortfolioControllerReport;
    const before = JSON.stringify(source); const projected = projectUniverseConsoleControllerStatus(source);
    expect(projected.topology).toEqual([{ campaignId: 'a', dependsOn: ['b'], prerequisites: ['b', 'c'] }]);
    const serialized = serializeUniverseConsoleControllerStatus(source);
    expect(serialized).not.toContain('private'); expect(serialized).not.toContain('futureAuthority');
    projected.topology![0]!.dependsOn.push('mutated'); projected.topology![0]!.prerequisites.push('mutated');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('allowlists readiness observations without exposing private identity or automatic authority', () => {
    const source = { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'one',
      universeId: 'universe-one', observedState: 'ready', sourceState: 'healthy', disposition: 'startable',
      reasonCode: 'never-started', resourceRuntimeRequired: false, sampledAt: '2026-09-08T00:00:00Z',
      automaticAction: 'run', expectedIdentity: { universeId: 'universe-one', definitionDigest: 'private-definition',
        manifestDigest: 'private-manifest', comparatorDigest: 'private-comparator', summaryDigest: 'private-summary' },
      recordsDigest: 'private-records', futurePrivateField: 'private-future' } satisfies UniverseCampaignReadiness & { futurePrivateField: string };
    const before = JSON.stringify(source);
    const projected = projectUniverseConsoleCampaignReadiness(source);
    expect(Object.keys(projected).sort()).toEqual(['schemaVersion', 'readinessScope', 'campaignId', 'universeId',
      'observedState', 'sourceState', 'disposition', 'reasonCode', 'resourceRuntimeRequired', 'sampledAt'].sort());
    const json = serializeUniverseConsoleCampaignReadiness(source);
    expect(JSON.parse(json)).toEqual(projected);
    expect(json).not.toContain('private-'); expect(json).not.toContain('automaticAction');
    expect(projected).toMatchObject({ disposition: 'startable', sampledAt: source.sampledAt });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('omits diagnostic messages in both completed and active runs without mutating evidence', () => {
    const source = overview(); const before = JSON.stringify(source);
    const json = serializeUniverseConsoleOverview(source);
    expect(json).not.toContain('private diagnostic detail');
    const parsed = JSON.parse(json);
    for (const run of [parsed.universes[0].runs[0], parsed.universes[0].activeRun]) {
      expect(run.trials[0].diagnostics).toEqual([{ code: 'candidate-failed', message: '[omitted from web view]' }]);
    }
    expect(JSON.stringify(source)).toBe(before);
    expect(validateUniverseConsoleResponse(json)).toBe(json);
  });

  it('uses the shared recursive public scrub for graph and overview text', () => {
    const graph = { schemaVersion: 1, reasons: [`${homedir()}/private`, 'a'.repeat(64)] } as unknown as UniverseGraph;
    const json = serializeUniverseConsoleGraph(graph);
    expect(json).not.toContain(homedir()); expect(json).not.toContain('a'.repeat(64));
    expect(json).toContain('~/private');
  });

  it('accepts the exact serialized byte ceiling, including multibyte text', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, text: '' }));
    const available = MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES - overhead;
    const text = 'é'.repeat(Math.floor(available / 2)) + (available % 2 ? '!' : '');
    const graph = { schemaVersion: 1, text } as unknown as UniverseGraph;
    const json = serializeUniverseConsoleGraph(graph);
    expect(Buffer.byteLength(json)).toBe(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES);
    expect(validateUniverseConsoleResponse(json)).toBe(json);
  });

  it('rejects UTF-8 overflow even when the character count is under the ceiling', () => {
    const graph = { schemaVersion: 1, text: 'é'.repeat(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES / 2) } as unknown as UniverseGraph;
    const raw = JSON.stringify(graph);
    expect(raw.length).toBeLessThan(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES);
    expect(() => serializeUniverseConsoleGraph(graph)).toThrow('response byte budget');
    expect(() => validateUniverseConsoleResponse(raw)).toThrow('Invalid Universe console response');
  });

  it('rejects an oversized overview rather than exposing a truncated success', () => {
    const source = overview(); source.reasons = ['!'.repeat(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES)];
    expect(() => serializeUniverseConsoleOverview(source)).toThrow('response byte budget');
    expect(source.universes).toHaveLength(1);
  });

  it.each([undefined, null, {}, { schemaVersion: 1 }, '', '{', '[]', 'null', '1', '{}', '{"schemaVersion":2}']) (
    'rejects a non-protocol or malformed worker response %#', (value) => {
      expect(() => validateUniverseConsoleResponse(value)).toThrow('Invalid Universe console response');
    });
});
