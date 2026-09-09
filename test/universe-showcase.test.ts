import { describe, expect, it } from 'vitest';
import { parseShowcaseArguments, projectUniverseShowcase } from '../scripts/generate-universe-showcase.mjs';
import { renderUniverseShowcaseSvg } from '../scripts/render-universe-showcase.mjs';

function fixture() {
  return { universeId: 'PRIVATE_ID', seedRepo: '/PRIVATE_SEED', measurementScope: 'local-experiment', verified: true,
    readToken: 'PRIVATE_TOKEN', checks: { twoCompletedGenerations: true, brokenVariantRejected: true,
      bothNichesRetained: true, priorWinnersReused: true, measuredImprovement: true, private: 'PRIVATE_CHECK' },
    runs: [1, 2].map((generation) => ({ generation, status: 'completed', prompt: 'PRIVATE_PROMPT',
      trials: ['compact', 'readable', 'broken'].map((variantId, index) => ({
        id: `PRIVATE_TRIAL_${generation}_${index}`, variantId, niche: variantId === 'readable' ? 'readable' : 'compact',
        status: variantId === 'broken' ? 'failed' : 'passed', selected: variantId !== 'broken',
        parentTrialId: generation === 1 ? null : `PRIVATE_TRIAL_1_${variantId === 'readable' ? 1 : 0}`,
        metrics: variantId === 'broken' ? {} : { artifactBytes: 200 - generation * 50 + index, casesPassed: 7, private: 'PRIVATE_METRIC' },
        score: variantId === 'broken' ? null : 200 - generation * 50 + index,
        delta: generation === 2 && variantId !== 'broken' ? 50 : null,
        artifact: { path: '/PRIVATE_ARTIFACT' }, diagnostics: [{ message: 'PRIVATE_ERROR' }],
      })) })) };
}

describe('public Universe showcase projection', () => {
  it('exports only measured public fields with relative lineage', () => {
    const input = fixture(); const before = JSON.stringify(input);
    const value = projectUniverseShowcase(input, { sourceRevision: 'a'.repeat(40), generatedAt: '2026-09-09T00:00:00.000Z' });
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(value)).toEqual(['schemaVersion', 'kind', 'measurementScope', 'generatedAt', 'sourceRevision', 'verified', 'checks', 'generations']);
    expect(Object.keys(value.checks)).toHaveLength(5);
    expect(value.generations[1].trials[0]).toEqual({ id: 'g2-t1', variant: 'compact', niche: 'compact', status: 'passed',
      selected: true, parentTrialId: 'g1-t1', artifactBytes: 100, casesPassed: 7, delta: 50 });
    expect(value.generations[1].trials[2]).toEqual({ id: 'g2-t3', variant: 'broken', niche: 'compact', status: 'failed',
      selected: false, parentTrialId: 'g1-t1', artifactBytes: null, casesPassed: null, delta: null });
    expect(value.generations[0].trials.every((trial: { parentTrialId: string | null }) => trial.parentTrialId === null)).toBe(true);
  });

  it('does not invent a source revision when none was supplied', () => {
    expect(projectUniverseShowcase(fixture())).not.toHaveProperty('sourceRevision');
  });

  it('renders deterministic accessible SVG from measured public scalars only', () => {
    const value = projectUniverseShowcase(fixture(), { sourceRevision: 'a'.repeat(40), generatedAt: '2026-09-09T00:00:00.000Z' });
    const svg = renderUniverseShowcaseSvg(value);
    expect(renderUniverseShowcaseSvg(value)).toBe(svg);
    expect(svg).toContain('150 bytes'); expect(svg).toContain('100 bytes');
    expect(svg.match(/7 \/ 7 cases passed/g)).toHaveLength(4);
    expect(svg.match(/Rejected · order preservation failed/g)).toHaveLength(2);
    expect(svg).toContain('not model engineering yield'); expect(svg).toContain('Source ' + 'a'.repeat(40));
    expect(svg).toContain('aria-labelledby="title description"');
    expect(svg).not.toContain('PRIVATE'); expect(svg).not.toMatch(/<script|foreignObject|<image|href=/i);
  });

  it('rejects raw private evidence and extra or injected public fields before rendering', () => {
    expect(() => renderUniverseShowcaseSvg(fixture())).toThrow('Expected validated public');
    const value = projectUniverseShowcase(fixture());
    expect(() => renderUniverseShowcaseSvg({ ...value, readToken: 'PRIVATE_TOKEN' })).toThrow();
    value.generations[0].trials[0].variant = '<script>PRIVATE</script>';
    expect(() => renderUniverseShowcaseSvg(value)).toThrow();
  });

  it.each([
    (value: ReturnType<typeof fixture>) => { value.verified = false; },
    (value: ReturnType<typeof fixture>) => { value.checks.measuredImprovement = false; },
    (value: ReturnType<typeof fixture>) => { value.runs.pop(); },
    (value: ReturnType<typeof fixture>) => { value.runs[1]!.generation = 3; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[0]!.variantId = 'PRIVATE_VARIANT'; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[1]!.variantId = 'compact'; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[2]!.selected = true; },
    (value: ReturnType<typeof fixture>) => { value.runs[1]!.trials[0]!.delta = 100; },
    (value: ReturnType<typeof fixture>) => { value.runs[1]!.trials[0]!.parentTrialId = 'PRIVATE_TRIAL_1_2'; },
    (value: ReturnType<typeof fixture>) => { value.runs[1]!.trials[0]!.parentTrialId = 'PRIVATE_TRIAL_2_0'; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[0]!.metrics.casesPassed = 6; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[0]!.metrics.artifactBytes = Infinity; },
    (value: ReturnType<typeof fixture>) => { value.runs[0]!.trials[0]!.score = 999; },
    (value: ReturnType<typeof fixture>) => { value.runs[1]!.trials[0]!.id = value.runs[0]!.trials[0]!.id; },
  ])('rejects incomplete or contradictory evidence without echoing private input (%#)', (mutate) => {
    const input = fixture(); mutate(input);
    expect(() => projectUniverseShowcase(input)).toThrow('Showcase evidence is invalid or incomplete');
  });

  it('rejects accessor-bearing evidence without invoking it', () => {
    const input = fixture(); let called = false;
    Object.defineProperty(input, 'verified', { get() { called = true; return true; } });
    expect(() => projectUniverseShowcase(input)).toThrow(); expect(called).toBe(false);
  });

  it('rejects sparse and accessor-bearing trial arrays', () => {
    const sparse = fixture(); Reflect.deleteProperty(sparse.runs[0]!.trials, '0');
    expect(() => projectUniverseShowcase(sparse)).toThrow();
    const accessor = fixture(); let called = false;
    Object.defineProperty(accessor.runs[0]!.trials, '0', { get() { called = true; return {}; } });
    expect(() => projectUniverseShowcase(accessor)).toThrow(); expect(called).toBe(false);
  });

  it.each(['PRIVATE_REVISION', 'a'.repeat(39), 'A'.repeat(40)])('rejects invalid revision %s', (sourceRevision) => {
    expect(() => projectUniverseShowcase(fixture(), { sourceRevision })).toThrow();
  });

  it('accepts exactly one source mode and a bounded explicit output', () => {
    expect(parseShowcaseArguments(['--root', '/private/new', '--output', '/private/public.json']))
      .toEqual({ '--root': '/private/new', '--output': '/private/public.json' });
    expect(parseShowcaseArguments(['--input', '/private/input.json', '--output', '/private/public.json', '--source-revision', 'b'.repeat(40)]))
      .toHaveProperty('--source-revision', 'b'.repeat(40));
  });

  it.each([[], ['--root', '/new'], ['--output', '/out'],
    ['--root', '/new', '--input', '/input', '--output', '/out'],
    ['--root', '/new', '--root', '/other', '--output', '/out'],
    ['--root', '/new', '--output', '/out', '--execute', 'true'],
    ['--input', '/in', '--output', '/out', '--source-root', '/source'],
    ['--root', '/new', '--output', '/out', '--source-root', 'relative'],
    ['--root', '/new', '--output', '/out\nprivate']])('rejects invalid command arguments %#', (args) => {
    expect(() => parseShowcaseArguments(args)).toThrow();
  });
});
