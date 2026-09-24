import { describe, expect, it } from 'vitest';
import { extractTurnFeatures, type TraceAction, type TurnFeaturesV1 } from '../src/core/reasoning/extractors.js';
import { DigestBuilder, buildDigest, localDay } from '../src/core/reasoning/insights.js';
import type { ReasoningStepV1 } from '../src/core/reasoning/types.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const window = { fromMs: NOW - 7 * DAY, toMs: NOW };
const iso = (ms: number): string => new Date(ms).toISOString();

let n = 0;
function feature(actions: TraceAction[], opts: {
  repo?: string | null; engine?: string; atMs?: number; outcome?: TurnFeaturesV1['outcome']; errorClass?: string | null;
} = {}): TurnFeaturesV1 {
  n += 1;
  const atMs = opts.atMs ?? NOW - DAY;
  return extractTurnFeatures({
    id: `verse:s${n}:t${n}`,
    source: 'verse',
    sessionId: `s${n}`,
    runId: null,
    repo: opts.repo === undefined ? '~/src/app' : opts.repo,
    engine: opts.engine ?? 'claude',
    model: null,
    turnId: `t${n}`,
    startedAt: iso(atMs),
    endedAt: iso(atMs + 60_000),
    outcome: opts.outcome === undefined ? 'ok' : opts.outcome,
    errorClass: opts.errorClass ?? null,
    actions: actions.map((a) => ({ ...a, at: iso(atMs + 1_000) })),
  });
}

const tool = (name: string, input: unknown, ok: boolean | null): TraceAction =>
  ({ kind: 'tool', ref: `session:x#${++n}`, at: '', name, input, ok });
const bash = (command: string, ok: boolean | null): TraceAction => tool('Bash', { command }, ok);
const edit = (file: string): TraceAction => tool('Edit', { file_path: file }, true);
const think = (text: string): TraceAction => ({ kind: 'thinking', ref: `verse:x:${++n}`, at: '', text });
const say = (text: string): TraceAction => ({ kind: 'message', ref: `session:x#${++n}`, at: '', text });

function step(atMs: number, engine = 'claude', sessionId = 'sA'): ReasoningStepV1 {
  n += 1;
  return {
    v: 1, id: `verse:${sessionId}:${n}`, source: 'verse', sessionId, runId: null, repo: null, engine, model: null,
    at: iso(atMs), turnId: 't', kind: 'thinking', text: 'x', tokens: null, toolAfter: null, outcome: null,
  };
}

describe('DigestBuilder', () => {
  it('totals steps by engine and counts distinct conversations across steps and features', () => {
    const digest = buildDigest(window, [
      step(NOW - DAY, 'claude', 'a'), step(NOW - DAY, 'claude', 'a'), step(NOW - 2 * DAY, 'grok', 'b'),
      step(NOW - 30 * DAY, 'grok', 'old'), // outside window
    ], [feature([], { atMs: NOW - DAY })], NOW);
    expect(digest.totals.steps).toBe(3);
    expect(digest.totals.byEngine).toEqual({ claude: 2, grok: 1 });
    expect(digest.totals.sessions).toBe(3); // a, b, + the feature's session
    expect(digest.generatedAt).toBe(iso(NOW));
    expect(digest.window).toEqual({ from: iso(window.fromMs), to: iso(window.toMs) });
  });

  it('zero-fills one trend row per local day of the window', () => {
    const digest = buildDigest(window, [step(NOW - DAY)], [
      feature([edit('a.ts'), bash('npm test', true)], { atMs: NOW - DAY }),
      feature([bash('npm test', false), bash('npm test', false)], { atMs: NOW - 2 * DAY }),
    ], NOW);
    expect(digest.trends.length).toBeGreaterThanOrEqual(8);
    expect(digest.trends[0]?.day).toBe(localDay(window.fromMs));
    expect(digest.trends[digest.trends.length - 1]?.day).toBe(localDay(NOW));
    const days = digest.trends.map((t) => t.day);
    expect(new Set(days).size).toBe(days.length);
    expect(digest.trends.reduce((s, t) => s + t.steps, 0)).toBe(1);
    expect(digest.trends.reduce((s, t) => s + t.wins, 0)).toBe(1);
    expect(digest.trends.reduce((s, t) => s + t.struggles, 0)).toBe(1);
  });

  it('clusters a failing signature across turns into one high-severity struggle', () => {
    const turns = [1, 2, 3].map((d) => feature([bash('npx vitest run a.test.ts', false), bash('npx vitest run b.test.ts', false)], { atMs: NOW - d * DAY }));
    const digest = buildDigest(window, [], turns, NOW);
    const struggle = digest.insights.find((i) => i.kind === 'struggle');
    expect(struggle).toMatchObject({ kind: 'struggle', severity: 'high', count: 6, repo: '~/src/app', engine: 'claude' });
    expect(struggle?.title).toBe('"npx vitest run" failed 6× across 3 turns in app (claude)');
    expect(struggle?.evidence.length).toBeGreaterThan(0);
    expect(struggle?.evidence.length).toBeLessThanOrEqual(5);
    expect(struggle?.firstAt).toBe(iso(NOW - 3 * DAY));
    expect(struggle?.id).toMatch(/^ri-[0-9a-f]{16}$/);
  });

  it('ignores a single one-off failure', () => {
    const digest = buildDigest(window, [], [feature([bash('git push', false)])], NOW);
    expect(digest.insights.filter((i) => i.kind === 'struggle')).toEqual([]);
  });

  it('keeps insight ids stable across digests', () => {
    const make = () => buildDigest(window, [], [feature([bash('npm test', false), bash('npm test', false)], { atMs: NOW - DAY })], NOW);
    expect(make().insights[0]?.id).toBe(make().insights[0]?.id);
  });

  it('separates insights by repo and engine', () => {
    const digest = buildDigest(window, [], [
      feature([bash('npm test', false), bash('npm test', false)], { repo: '~/a', engine: 'claude' }),
      feature([bash('npm test', false), bash('npm test', false)], { repo: '~/b', engine: 'claude' }),
      feature([bash('npm test', false), bash('npm test', false)], { repo: '~/a', engine: 'codex' }),
    ], NOW);
    expect(digest.insights.filter((i) => i.kind === 'struggle')).toHaveLength(3);
  });

  it('reports error outcomes by error class', () => {
    const digest = buildDigest(window, [], [
      feature([], { outcome: 'error', errorClass: 'rate-limit', engine: 'codex', repo: null }),
      feature([], { outcome: 'error', errorClass: 'rate-limit', engine: 'codex', repo: null }),
      feature([], { outcome: 'error', errorClass: 'rate-limit', engine: 'codex', repo: null }),
    ], NOW);
    const insight = digest.insights.find((i) => i.kind === 'struggle');
    expect(insight?.title).toBe('3 turns ended in rate-limit errors (codex)');
    expect(insight?.severity).toBe('high');
  });

  it('builds loop, uncertainty, backtrack, verification-gap and win insights', () => {
    const loops = [1, 2].map(() => feature([tool('Read', { file_path: 'x.ts' }, true), tool('Read', { file_path: 'x.ts' }, true), tool('Read', { file_path: 'x.ts' }, true)]));
    const unsure = [1, 2, 3].map(() => feature([think("I'm not sure. This is unclear.")]));
    const back = [1, 2].map(() => feature([think('Actually, wait. Let me revert the change.')]));
    const claims = [1, 2].map(() => feature([edit('a.ts'), say('All tests pass.')]));
    const wins = [feature([edit('a.ts'), bash('npm test', true)])];
    const digest = buildDigest(window, [], [...loops, ...unsure, ...back, ...claims, ...wins], NOW);
    const kinds = new Set(digest.insights.map((i) => i.kind));
    expect(kinds).toEqual(new Set(['loop', 'uncertainty', 'backtrack', 'verification-gap', 'win']));
    const claim = digest.insights.find((i) => i.title.startsWith('Claimed success'));
    expect(claim?.severity).toBe('high');
    const gap = digest.insights.find((i) => i.title.startsWith('Edited without testing'));
    expect(gap?.title).toBe('Edited without testing afterwards in 2 of 3 editing turns in app (claude)');
    const uncertain = digest.insights.find((i) => i.kind === 'uncertainty');
    expect(uncertain?.title).toBe('Uncertain reasoning in 3 of 10 turns in app (claude)');
    // wins sort after every problem of the same severity
    const last = digest.insights[digest.insights.length - 1];
    expect(last?.kind).toBe('win');
    // titles are derived — no reasoning text leaks into them
    expect(digest.insights.some((i) => i.title.includes('not sure'))).toBe(false);
  });

  it('orders by severity first', () => {
    const digest = buildDigest(window, [], [
      feature([edit('a.ts'), bash('npm test', true)]),
      ...[1, 2, 3].map(() => feature([bash('npm test', false), bash('npm test', false)])),
    ], NOW);
    const rank = { high: 3, warn: 2, info: 1 } as const;
    const severities = digest.insights.map((i) => rank[i.severity]);
    expect([...severities].sort((a, b) => b - a)).toEqual(severities);
  });

  it('drops features outside the window and caps insight count', () => {
    const builder = new DigestBuilder(window);
    builder.addFeature(feature([bash('npm test', false), bash('npm test', false)], { atMs: NOW - 30 * DAY }));
    expect(builder.build(NOW).insights).toEqual([]);
    const many = new DigestBuilder(window);
    for (let i = 0; i < 80; i += 1) {
      many.addFeature(feature([bash(`tool${i} run`, false), bash(`tool${i} run`, false)]));
    }
    expect(many.build(NOW, 50).insights).toHaveLength(50);
  });
});
