/**
 * routes/verse/approvals/approvals-model.ts — the pure decisions behind the
 * approvals queue: what order rows come in, and exactly what a human is
 * agreeing to when they press Approve.
 *
 * Kept framework-free and unit-tested because both are easy to get subtly
 * wrong: "pending first" must survive a status filter that also returns
 * decided rows, and the approve consequence sentence is the last thing
 * standing between a click and a real pull request against a real remote.
 */
import type { Proposal, ProposalKind } from '../../../data/api-types.js';

/** Pending first, then newest first within each group. Stable and total. */
export function orderProposals(rows: readonly Proposal[]): Proposal[] {
  return [...rows].sort((a, b) => {
    const pendingA = a.status === 'pending' ? 0 : 1;
    const pendingB = b.status === 'pending' ? 0 : 1;
    if (pendingA !== pendingB) return pendingA - pendingB;
    const tsA = Date.parse(a.createdAt);
    const tsB = Date.parse(b.createdAt);
    const safeA = Number.isNaN(tsA) ? 0 : tsA;
    const safeB = Number.isNaN(tsB) ? 0 : tsB;
    if (safeA !== safeB) return safeB - safeA;
    return a.id.localeCompare(b.id);
  });
}

export type RiskClass = NonNullable<Proposal['riskClass']>;

/** high → medium → low → unstated. Used for the risk column's sort affordance. */
export function riskRank(risk: Proposal['riskClass']): number {
  switch (risk) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    case 'low':
      return 2;
    default:
      return 3;
  }
}

/** Client-side narrowing over whatever page the server returned. */
export function filterProposals(rows: readonly Proposal[], search: string, repo: string): Proposal[] {
  const s = search.trim().toLowerCase();
  const r = repo.trim().toLowerCase();
  if (!s && !r) return [...rows];
  return rows.filter((p) => {
    if (s && !p.title.toLowerCase().includes(s) && !(p.summary ?? '').toLowerCase().includes(s)) return false;
    if (r && !(p.repo ?? '').toLowerCase().includes(r)) return false;
    return true;
  });
}

/**
 * What approving this proposal actually does, in one sentence, naming the
 * repo. `pr` is the dangerous one: it pushes a branch to the remote and opens
 * a real pull request, which is visible to other people and cannot be undone
 * from the dialog. The confirm step MUST show this before the click.
 */
export function describeApproveConsequence(kind: ProposalKind | string, repo: string | null): string {
  // The project's NAME, not its absolute path: a sandbox checkout under
  // /private/tmp/claude-501/… is unreadable in a sentence. The confirm dialog
  // still prints the full path once, as the exact place the write lands.
  const where = repoName(repo) ?? 'the target repository';
  switch (kind) {
    case 'pr':
      return `Pushes a branch to ${where}'s remote and opens a real pull request. Other people can see it immediately, and this dialog cannot undo it.`;
    case 'patch':
      return `Writes the diff to ${where} on disk now. Nothing is pushed, but the working tree changes.`;
    default:
      return `Applies this ${String(kind)} proposal to ${where} now.`;
  }
}

/** True when approving reaches a remote — the loudest confirm wording. */
export function reachesRemote(kind: ProposalKind | string): boolean {
  return kind === 'pr';
}

/** The engine that produced the diff, as a short display string. */
export function engineOf(proposal: Pick<Proposal, 'engineModel' | 'engineTier'>): string | null {
  if (proposal.engineModel) return proposal.engineModel;
  if (proposal.engineTier) return proposal.engineTier;
  return null;
}

// ---------------------------------------------------------------------------
// Readable detail
// ---------------------------------------------------------------------------

/** "/Users/m/repos/binshield/" → "binshield"; null for no repo. */
export function repoName(repo: string | null | undefined): string | null {
  if (typeof repo !== 'string') return null;
  const trimmed = repo.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return last.length > 0 ? last : trimmed;
}

const KIND_LABEL: Record<string, string> = {
  patch: 'Patch',
  pr: 'Pull request',
  deploy: 'Deploy',
  note: 'Note',
  'desktop-action': 'Desktop action',
  'browser-action': 'Browser action',
};

/** "patch" → "Patch", "pr" → "Pull request"; an unknown kind is shown as sent. */
export function kindLabel(kind: ProposalKind | string): string {
  return KIND_LABEL[kind] ?? String(kind);
}

/**
 * The server builds a run proposal's title as `${engine} run: ${goal.slice(0, 80)}`
 * — cut at 80 characters, mid-word, sometimes mid-quote. This is the one
 * place that cut is made readable.
 */
export const RUN_TITLE_GOAL_CAP = 80;

export interface ReadableTitle {
  /** "Claude run" when the title carried an `engine run:` prefix; null otherwise. */
  eyebrow: string | null;
  /** The title to print: never ends mid-word; a cut one ends in "…". */
  text: string;
  /** True when the server's title was cut short (the full text we have rides in a tooltip). */
  truncated: boolean;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

/** Close a quote the cut left open, so the title does not read as a stray mark. */
function closeQuotes(text: string): string {
  let out = text;
  if ((out.match(/"/g) ?? []).length % 2 === 1) out += '"';
  if ((out.match(/\u201c/g) ?? []).length > (out.match(/\u201d/g) ?? []).length) out += '\u201d';
  return out;
}

/** Drop a trailing partial word and end on "…". */
function cutAtWord(text: string): string {
  const body = text.replace(/(?:\u2026|\.\.\.)$/, '');
  const space = body.lastIndexOf(' ');
  const whole = space > 0 ? body.slice(0, space) : body;
  return `${whole.replace(/[\s,;:\-\u2013\u2014]+$/, '')}\u2026`;
}

export function readableTitle(title: string): ReadableTitle {
  const raw = typeof title === 'string' ? title.trim() : '';
  // Only the engines the sandboxed runner names — "Dry run: …" is a title, not an engine.
  const run = /^(\[partial\]\s*)?(claude|codex|grok|local|ollama|gemini|api[\w-]*) run:\s*(.*)$/is.exec(raw);
  const eyebrow = run ? `${run[1] ? 'Partial ' : ''}${run[1] ? run[2]!.toLowerCase() : capitalize(run[2]!.toLowerCase())} run` : null;
  let text = run ? run[3]! : raw;
  // A title that already ends in an ellipsis right after a letter was cut mid-word upstream.
  const cutMidWord = /[\p{L}\p{N}](?:\u2026|\.\.\.)$/u.test(text);
  // A run goal at exactly the server's cap that does not end on a sentence boundary was sliced.
  const sliced = run !== null && text.length >= RUN_TITLE_GOAL_CAP && !/[.!?)"'\u201d\u2026]$/.test(text);
  const truncated = cutMidWord || sliced;
  if (truncated) text = cutAtWord(text);
  text = closeQuotes(text);
  return { eyebrow, text: text.length > 0 ? text : raw, truncated };
}

/**
 * What a sandboxed run's summary line says, taken apart. The server writes
 * `[Partial ]<source> <engine:model> run produced N file(s) (+A/-D). <rest>`
 * (core/run/sandboxed-engine.ts); anything else parses to null and is shown
 * verbatim.
 */
export interface RunFacts {
  partial: boolean;
  /** The server's source label, verbatim ("TITRR", "Best-of-N winner"). */
  source: string;
  /** The source in plain words ("Test-and-repair loop"). */
  sourceLabel: string;
  /** What the source means, for a tooltip; null when the label says it already. */
  sourceHint: string | null;
  /** "claude:claude-fable-5". */
  model: string;
  files: number;
  insertions: number;
  deletions: number;
  /** Whatever the summary says after the run facts ("Review before applying."), or null. */
  rest: string | null;
}

const RUN_SUMMARY = /^(Partial )?(.+?) (\S+) run produced (\d+) file\(s\) \(\+(\d+)\/-(\d+)\)\.?\s*([\s\S]*)$/;

/**
 * TITRR is internal shorthand (core/run/orchestrator.ts M78: Test → Iterate →
 * Test → Refine → Repeat). The operator sees the plain name; the acronym and
 * what it did ride in the tooltip.
 */
const TITRR_HINT =
  'TITRR — Test, Iterate, Test, Refine, Repeat: after its change the run re-ran the repository\u2019s tests and repaired the change until they passed or it ran out of attempts.';

function describeSource(source: string): { label: string; hint: string | null } {
  if (/\bTITRR\b/.test(source)) {
    const rest = source.replace(/\bTITRR\b\s*/, '').trim();
    const qualifier = rest === 'api-model' ? ' (API model)'
      : rest === 'api-model required-diff' ? ' (API model, retried for a missing diff)'
        : rest === 'api-model failed producer' ? ' (API model, producer failed)'
          : rest.length > 0 ? ` (${rest})` : '';
    return { label: `Test-and-repair loop${qualifier}`, hint: TITRR_HINT };
  }
  if (/^best-of-n/i.test(source)) {
    return { label: source, hint: 'Several models attempted this change in parallel; a judge compared them.' };
  }
  if (source === 'api-model') return { label: 'API model run', hint: null };
  if (source === 'Sandboxed') return { label: 'Sandboxed run', hint: 'Produced in an isolated sandbox checkout; nothing touched your working tree.' };
  return { label: source, hint: null };
}

export function parseRunSummary(summary: string | null | undefined): RunFacts | null {
  if (typeof summary !== 'string') return null;
  const m = RUN_SUMMARY.exec(summary.trim());
  if (!m) return null;
  const { label, hint } = describeSource(m[2]!);
  const rest = m[7]!.trim();
  return {
    partial: m[1] !== undefined,
    source: m[2]!,
    sourceLabel: label,
    sourceHint: hint,
    model: m[3]!,
    files: Number(m[4]),
    insertions: Number(m[5]),
    deletions: Number(m[6]),
    rest: rest.length > 0 ? rest : null,
  };
}

/** "2 files · +384 −0" (a real minus sign, grouped thousands). */
export function formatDiffStats(facts: Pick<RunFacts, 'files' | 'insertions' | 'deletions'>): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return `${n(facts.files)} ${facts.files === 1 ? 'file' : 'files'} \u00b7 +${n(facts.insertions)} \u2212${n(facts.deletions)}`;
}

/** The same stats as a sentence for assistive tech: "2 files changed, 384 lines added, 0 removed". */
export function describeDiffStats(facts: Pick<RunFacts, 'files' | 'insertions' | 'deletions'>): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return `${n(facts.files)} ${facts.files === 1 ? 'file' : 'files'} changed, ${n(facts.insertions)} ${facts.insertions === 1 ? 'line' : 'lines'} added, ${n(facts.deletions)} removed`;
}

/**
 * "just now", "5 minutes ago", "yesterday", "38 days ago", then "on Aug 17"
 * past two months. Written out in full: the detail view has the room, and
 * "38d" is a sidebar abbreviation.
 */
export function longAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (typeof iso !== 'string') return 'at an unknown time';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days <= 60) return rtf.format(-days, 'day');
  return `on ${new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** A local date and time for a tooltip: "Mon, Aug 17, 3:12 PM". */
export function localStamp(iso: string | null | undefined): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
