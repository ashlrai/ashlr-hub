import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { UniverseOverview } from '../src/core/universe/types.js';
import type { UniverseGraph } from '../src/core/universe/graph-types.js';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES, serializeUniverseConsoleGraph,
  serializeUniverseConsoleOverview, validateUniverseConsoleResponse } from '../src/core/web/universe-console-public.js';

function overview(): UniverseOverview {
  const run = { id: 'run', trials: [{ id: 'trial', diagnostics: [{ code: 'candidate-failed', message: 'private diagnostic detail' }] }] };
  return { schemaVersion: 1, universes: [{ runs: [run], activeRun: run }],
    sampledAt: '2026-09-07T00:00:00Z', sourceState: 'healthy', reasons: [] } as unknown as UniverseOverview;
}

describe('scoped console public worker serialization', () => {
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
