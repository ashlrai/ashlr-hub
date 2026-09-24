/**
 * routes/verse/shell/needs-you-model.ts — the Needs-you drawer as data (unit
 * C1): which items a split shows, how many each split has, whether the drawer
 * may say "All clear", and what a key press does to an item.
 *
 * Pure. The items come from GET /api/verse/activity (C1's own producers plus
 * Track B's, R1); each carries its own actions, so nothing here knows what a
 * grant or an owner-lane PR is.
 *
 * How a row READS (needsYouRowView) borrows the approvals detail view's text
 * helpers rather than growing a second copy: an approval item's title and
 * detail are the same proposal title and run summary that view already
 * untangles.
 */
import {
  NEEDS_YOU_KIND_CATEGORY,
  type NeedsYouAction,
  type NeedsYouActionKind,
  type NeedsYouItem,
  type NeedsYouSource,
  type VerseActivitySources,
} from '../../../../core/verse/workbench-types.js';
import {
  describeDiffStats,
  formatDiffStats,
  kindLabel,
  localStamp,
  longAgo,
  parseRunSummary,
  readableTitle,
  repoName,
} from '../approvals/approvals-model.js';
import type { NeedsYouSplit } from '../verse-ui-store.js';

export const SPLIT_LABEL: Readonly<Record<NeedsYouSplit, string>> = {
  all: 'All',
  approvals: 'Approvals',
  fleet: 'Fleet',
  chats: 'Chats',
  accounts: 'Accounts',
};

/**
 * Which producers can put an item in each split. "All clear" is only
 * claimed for a split whose every producer answered: an owner-lane PR is in
 * Approvals but comes from the FLEET producer, so Approvals is only vouched
 * for when the fleet source answered too.
 */
export const SPLIT_SOURCES: Readonly<Record<NeedsYouSplit, readonly NeedsYouSource[]>> = {
  all: ['approvals', 'authority', 'fleet', 'leader', 'chats', 'accounts'],
  approvals: ['approvals', 'fleet', 'leader'],
  fleet: ['authority', 'fleet', 'leader'],
  chats: ['chats'],
  accounts: ['accounts'],
};

const SOURCE_NAME: Readonly<Record<NeedsYouSource, string>> = {
  approvals: 'the approvals inbox',
  authority: 'the autonomy grant',
  fleet: 'the fleet',
  leader: 'the Leader',
  chats: 'chats',
  accounts: 'account health',
};

export function itemsForSplit(items: readonly NeedsYouItem[], split: NeedsYouSplit): NeedsYouItem[] {
  if (split === 'all') return [...items];
  return items.filter((item) => NEEDS_YOU_KIND_CATEGORY[item.kind] === split);
}

export function splitCounts(items: readonly NeedsYouItem[]): Record<NeedsYouSplit, number> {
  const counts: Record<NeedsYouSplit, number> = { all: items.length, approvals: 0, fleet: 0, chats: 0, accounts: 0 };
  for (const item of items) counts[NEEDS_YOU_KIND_CATEGORY[item.kind]] += 1;
  return counts;
}

export interface SplitCoverage {
  /** Every producer feeding this split answered. */
  vouched: boolean;
  /** Operator-language names of the ones that did not, with why. */
  silent: Array<{ source: NeedsYouSource; name: string; state: 'unavailable' | 'error' }>;
}

/** Null sources (activity itself unavailable) vouch for nothing. */
export function splitCoverage(sources: VerseActivitySources | null, split: NeedsYouSplit): SplitCoverage {
  const silent: SplitCoverage['silent'] = [];
  for (const source of SPLIT_SOURCES[split]) {
    const state = sources?.[source] ?? 'unavailable';
    if (state !== 'ok') silent.push({ source, name: SOURCE_NAME[source], state });
  }
  return { vouched: silent.length === 0, silent };
}

/** "the fleet isn't reporting yet and the Leader failed to answer" — for the empty state. */
export function describeSilence(coverage: SplitCoverage): string {
  const phrases = coverage.silent.map((s) => (s.state === 'error' ? `${s.name} failed to answer` : `${s.name} isn't reporting in this build`));
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return capitalise(phrases[0]!);
  return capitalise(`${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Approve / reject / veto ALWAYS confirm (SPEC-310C §1); other kinds only when the item says so. */
export const ALWAYS_CONFIRM: ReadonlySet<NeedsYouActionKind> = new Set(['approve', 'reject', 'veto']);

export function actionOf(item: NeedsYouItem, kind: NeedsYouActionKind): NeedsYouAction | null {
  return item.actions.find((a) => a.kind === kind) ?? null;
}

const GENERIC_CONFIRM: Readonly<Record<'approve' | 'reject' | 'veto', { title: string; confirmLabel: string }>> = {
  approve: { title: 'Approve this?', confirmLabel: 'Approve' },
  reject: { title: 'Reject this?', confirmLabel: 'Reject' },
  veto: { title: 'Veto this action?', confirmLabel: 'Veto' },
};

export interface ConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/** The dialog for `action` on `item`; null when the action runs without one. */
export function confirmCopy(item: NeedsYouItem, action: NeedsYouAction): ConfirmCopy | null {
  if (action.confirm) return action.confirm;
  if (action.kind === 'approve' || action.kind === 'reject' || action.kind === 'veto') {
    const generic = GENERIC_CONFIRM[action.kind];
    return { title: generic.title, body: readableItemTitle(item).text, confirmLabel: generic.confirmLabel };
  }
  return null;
}

// ---------------------------------------------------------------------------
// How a row reads
// ---------------------------------------------------------------------------

/**
 * The approvals producer titles an item `${kind === 'pr' ? 'PR' : kind}: ${proposal.title}`
 * (core/verse/activity.ts approvalItem). Only an `approval` item is taken
 * apart this way — "Failed: Migrate the store" is a chat title, not a kind.
 */
const APPROVAL_KIND_PREFIX = /^(PR|[a-z][a-z-]*):\s+([\s\S]+)$/;

export interface ReadableItemTitle {
  /** "Patch · Claude run": the proposal kind and the engine the title led with; null when neither. */
  kindLabel: string | null;
  /** The title to print. Never ends mid-word — a cut one ends in "…". */
  text: string;
}

export function readableItemTitle(item: Pick<NeedsYouItem, 'kind' | 'title'>): ReadableItemTitle {
  let proposalKind: string | null = null;
  let rest = item.title;
  if (item.kind === 'approval') {
    const m = APPROVAL_KIND_PREFIX.exec(item.title.trim());
    if (m) {
      proposalKind = m[1] === 'PR' ? 'pr' : m[1]!;
      rest = m[2]!;
    }
  }
  const title = readableTitle(rest);
  const parts = [proposalKind === null ? null : kindLabel(proposalKind), title.eyebrow].filter((p): p is string => p !== null);
  return { kindLabel: parts.length > 0 ? parts.join(' · ') : null, text: title.text };
}

/** A sandboxed run's facts, lifted out of the item's detail line. */
export interface NeedsYouRunView {
  /** "2 files · +384 −0". */
  stats: string;
  /** "2 files changed, 384 lines added, 0 removed" — what a screen reader says instead. */
  statsSpoken: string;
  /** "Test-and-repair loop", never "TITRR". */
  source: string;
  /** What the source means, for a tooltip. */
  sourceHint: string | null;
  partial: boolean;
  /** "claude:claude-fable-5". */
  model: string;
}

/** Everything a Needs-you row prints, in operator language. The raw server text survives only in tooltips. */
export interface NeedsYouRowView {
  kindLabel: string | null;
  title: string;
  /** The title exactly as the server sent it — the row's tooltip. */
  fullTitle: string;
  run: NeedsYouRunView | null;
  /** What the detail says beyond the run facts ("Review before applying."), or the detail verbatim; null when nothing. */
  detail: string | null;
  /** "binshield", never a path. */
  repo: string | null;
  /** The repo as sent, as a tooltip, when it was more than the name. */
  repoFull: string | undefined;
  /** "38 days ago". */
  age: string;
  /** The exact local time, for a tooltip. */
  ageStamp: string | undefined;
}

export function needsYouRowView(item: NeedsYouItem, now: number = Date.now()): NeedsYouRowView {
  const title = readableItemTitle(item);
  const facts = parseRunSummary(item.detail);
  const repo = repoName(item.subject.repo);
  return {
    kindLabel: title.kindLabel,
    title: title.text,
    fullTitle: item.title,
    run: facts
      ? {
        stats: formatDiffStats(facts),
        statsSpoken: describeDiffStats(facts),
        source: facts.sourceLabel,
        sourceHint: facts.sourceHint,
        partial: facts.partial,
        model: facts.model,
      }
      : null,
    detail: facts ? facts.rest : item.detail,
    repo,
    repoFull: repo !== null && item.subject.repo !== null && item.subject.repo !== repo ? item.subject.repo : undefined,
    age: longAgo(item.since, now),
    ageStamp: localStamp(item.since),
  };
}

/** "closes in 24m" / "expired" — for veto windows and grants. */
export function until(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'expired';
  if (s < 90) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
