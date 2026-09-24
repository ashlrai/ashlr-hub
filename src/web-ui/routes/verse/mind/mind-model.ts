/**
 * routes/verse/mind/mind-model.ts — the reasoning digest (A7) as Mind's
 * charts and cards, plus the chat-header chip's matching rule (unit C7;
 * SPEC-310B §6 Mind, SPEC-310C §5).
 *
 * The matrix is insight KIND × ENGINE, faceted by repo. A cell is:
 *   - a count of insight occurrences when that engine produced reasoning in
 *     the window (0 is a real zero: it reasoned and nothing was flagged);
 *   - UNKNOWN (null) when that engine recorded no reasoning at all — nothing
 *     was measured, so nothing can be said (hatched, never a pale zero).
 *
 * Framework-free; tested directly.
 */
import type { ReasoningDigest, ReasoningInsight, ReasoningInsightKind } from '../../../../core/reasoning/types.js';
import type { ChartEngine } from '../../../components/charts/colors.js';
import type { MatrixAxisItem } from '../../../components/charts/MatrixHeatmap.js';
import type { AreaTrendSeries } from '../../../components/charts/AreaTrend.js';
import { toneColor } from '../../../components/charts/colors.js';
import { calendarDayStart } from '../growth/calendar-day.js';
import { pathKey } from './project-label.js';

export const INSIGHT_KINDS: readonly ReasoningInsightKind[] = ['loop', 'struggle', 'verification-gap', 'uncertainty', 'backtrack', 'win'];

export const KIND_LABEL: Readonly<Record<ReasoningInsightKind, string>> = {
  loop: 'Loops',
  struggle: 'Repeated failures',
  'verification-gap': 'Edits without tests',
  uncertainty: 'Uncertainty',
  backtrack: 'Backtracking',
  win: 'Wins',
};

const ENGINE_LABEL: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', local: 'Local' };
const KNOWN_ENGINES: readonly ChartEngine[] = ['claude', 'codex', 'grok', 'local'];

function asEngine(name: string): ChartEngine | null {
  return (KNOWN_ENGINES as readonly string[]).includes(name) ? (name as ChartEngine) : null;
}

/**
 * Repos that appear in the digest's insights, most insight occurrences first
 * — ONE per folder: two spellings of the same folder (`/tmp/x` and
 * `/private/tmp/x`, which `pathKey` treats as one) are one Repo facet entry,
 * named by the spelling recorded most often.
 */
export function insightRepos(digest: ReasoningDigest | null): string[] {
  if (!digest) return [];
  const folders = new Map<string, { total: number; spellings: Map<string, number> }>();
  for (const i of digest.insights) {
    if (!i.repo) continue;
    const key = pathKey(i.repo);
    const f = folders.get(key) ?? { total: 0, spellings: new Map<string, number>() };
    f.total += i.count;
    f.spellings.set(i.repo, (f.spellings.get(i.repo) ?? 0) + i.count);
    folders.set(key, f);
  }
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return [...folders.values()]
    .map((f) => [[...f.spellings.entries()].sort(byCount)[0]![0], f.total] as [string, number])
    .sort(byCount)
    .map(([r]) => r);
}

/** Does insight `repo` name the same folder as facet `facet` (any spelling)? */
function sameFolder(repo: string | null | undefined, facet: string): boolean {
  return !!repo && (repo === facet || pathKey(repo) === pathKey(facet));
}

export interface InsightMatrix {
  rows: MatrixAxisItem[];
  columns: MatrixAxisItem[];
  values: (number | null)[][];
}

/** `repo` null = every repo. */
export function insightMatrix(digest: ReasoningDigest | null, repo: string | null): InsightMatrix {
  const rows = INSIGHT_KINDS.map((k) => ({ id: k, label: KIND_LABEL[k] }));
  if (!digest) return { rows, columns: [], values: [] };
  // Columns: every engine that reasoned in the window, plus any engine an
  // insight names (so a count is never dropped), known engines first.
  const names = new Set<string>([...Object.keys(digest.totals.byEngine), ...digest.insights.map((i) => i.engine).filter((e): e is string => !!e)]);
  const ordered = [...names].sort((a, b) => {
    const ia = KNOWN_ENGINES.indexOf(a as ChartEngine);
    const ib = KNOWN_ENGINES.indexOf(b as ChartEngine);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const columns: MatrixAxisItem[] = ordered.map((name) => {
    const engine = asEngine(name);
    return { id: name, label: ENGINE_LABEL[name] ?? name, ...(engine ? { engine } : {}) };
  });
  const insights = digest.insights.filter((i) => repo === null || sameFolder(i.repo, repo));
  const values = INSIGHT_KINDS.map((kind) =>
    ordered.map((engine) => {
      const measured = (digest.totals.byEngine[engine] ?? 0) > 0;
      const count = insights.filter((i) => i.kind === kind && i.engine === engine).reduce((n, i) => n + i.count, 0);
      return measured || count > 0 ? count : null;
    }),
  );
  return { rows, columns, values };
}

/** The three cards: most severe first, then most recent — wins are not problems. */
export function topInsights(digest: ReasoningDigest | null, n = 3): ReasoningInsight[] {
  if (!digest) return [];
  const rank = { high: 0, warn: 1, info: 2 } as const;
  return digest.insights
    .filter((i) => i.kind !== 'win')
    .sort((a, b) => rank[a.severity] - rank[b.severity] || Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .slice(0, n);
}

/**
 * Struggles vs wins per day, for the trends card. Each day is stamped at the
 * viewer's LOCAL midnight (`calendarDayStart`), because the chart labels its
 * x values in the local zone: a UTC-midnight stamp read one day early west of
 * UTC ("2026-09-24" as "Sep 23").
 */
export function reasoningTrendSeries(digest: ReasoningDigest | null): AreaTrendSeries[] {
  if (!digest) return [];
  const pts = (pick: (d: ReasoningDigest['trends'][number]) => number) =>
    digest.trends.map((d) => ({ x: calendarDayStart(d.day), y: d.steps === 0 ? null : pick(d) }));
  return [
    { id: 'struggles', label: 'Struggles', color: toneColor('warning'), points: pts((d) => d.struggles) },
    { id: 'wins', label: 'Wins', color: toneColor('success'), points: pts((d) => d.wins) },
  ];
}

// ---------------------------------------------------------------------------
// SessionInsightChip
// ---------------------------------------------------------------------------

/** The chip shows only the insight kinds that mean "this chat is stuck". */
export const CHIP_KINDS: ReadonlySet<ReasoningInsightKind> = new Set(['loop', 'struggle']);

/**
 * Does `insight` cite chat `sessionId`? Verse evidence refs are
 * `session:<id>#<seq>` (tool / message events) or `verse:<id>:<turn|seq>`
 * (thinking steps) — A7's ingest-verse.ts. The id is matched exactly up to
 * its delimiter, so chat `s1` never matches `s12`.
 */
export function citesSession(insight: Pick<ReasoningInsight, 'evidence'>, sessionId: string): boolean {
  return insight.evidence.some((e) => e.ref.startsWith(`session:${sessionId}#`) || e.ref.startsWith(`verse:${sessionId}:`));
}

export function sessionInsights(digest: ReasoningDigest | null, sessionId: string): ReasoningInsight[] {
  if (!digest || !sessionId) return [];
  return digest.insights
    .filter((i) => CHIP_KINDS.has(i.kind) && citesSession(i, sessionId))
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}
