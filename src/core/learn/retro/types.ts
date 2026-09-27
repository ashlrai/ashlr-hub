/**
 * Retrospectives + suggested knowledge — the vocabulary (3.15).
 *
 * Every task the fleet, the cloud lane or the Leader finishes (merged,
 * reverted, closed with a reason, refused by a gate, failed verification,
 * sent to the owner lane, vetoed) becomes a compact RETRO: what was asked,
 * what happened, the root cause when it went wrong, what to do differently,
 * a better prompt, and CANDIDATE knowledge notes scoped to where they apply.
 *
 * Candidates are never used until Mason approves them in Verse (Growth ⌘3 ›
 * Lessons). Approved notes are injected — trigger-scoped, 16 KiB cap — into
 * future fleet briefs, cloud briefs and the Leader's evidence. A note reaches
 * a repo's AGENTS.md only through an ordinary fleet task (a proposal that
 * passes every gate), never by a direct write.
 *
 * Honesty rule: `null` = unknown, never "none".
 *
 * BROWSER-SAFE: the Lessons view imports this — type-only imports, plain consts.
 */

export const VERSE_LESSONS_PATH = '/api/verse/learning/lessons';
export const VERSE_LESSONS_KNOWLEDGE_PATH = `${VERSE_LESSONS_PATH}/knowledge`;
export const VERSE_LESSONS_AGENTS_MD_PATH = `${VERSE_LESSONS_PATH}/agents-md`;
export const VERSE_LESSONS_SWEEP_PATH = `${VERSE_LESSONS_PATH}/sweep`;

/** Injected knowledge never exceeds this many UTF-8 bytes per prompt (Devin's AGENTS.md cap). */
export const KNOWLEDGE_INJECT_CAP_BYTES = 16 * 1024;

/** One note's text, after scrubbing. */
export const KNOWLEDGE_NOTE_MAX_CHARS = 600;

// ---------------------------------------------------------------------------
// Task ends
// ---------------------------------------------------------------------------

/** Where the finished task ran. */
export type RetroSource = 'fleet' | 'cloud' | 'leader';

/**
 * How it ended.
 *  - merged         landed on the default branch (fleet merge / cloud land).
 *  - reverted       landed, went red after merge, and was reverted.
 *  - closed         PR closed without landing (with the recorded reason).
 *  - gate-refused   a merge gate (G0–G7) refused it.
 *  - owner-laned    a gate sent it to Mason's owner lane (never auto-merged).
 *  - verify-failed  the verification run failed.
 *  - failed         could not run at all (launch failure, apply failure).
 *  - expired        produced nothing in its window.
 *  - vetoed         Mason vetoed a Leader action.
 */
export type RetroEndKind =
  | 'merged'
  | 'reverted'
  | 'closed'
  | 'gate-refused'
  | 'owner-laned'
  | 'verify-failed'
  | 'failed'
  | 'expired'
  | 'vetoed';

export const RETRO_END_KINDS: readonly RetroEndKind[] = [
  'merged', 'reverted', 'closed', 'gate-refused', 'owner-laned', 'verify-failed', 'failed', 'expired', 'vetoed',
];

/** End kinds that are a failure worth a lesson (merged is a success). */
export const RETRO_FAILURE_KINDS: ReadonlySet<RetroEndKind> = new Set<RetroEndKind>([
  'reverted', 'closed', 'gate-refused', 'owner-laned', 'verify-failed', 'failed', 'expired', 'vetoed',
]);

/**
 * Task kinds a note can be scoped to. Coarse on purpose: a note scoped to
 * "tests" should reach every test-writing task, whoever produced it.
 */
export type TaskKind = 'fix' | 'feature' | 'refactor' | 'tests' | 'docs' | 'deps' | 'ci' | 'revert' | 'leader' | 'other';

export const TASK_KINDS: readonly TaskKind[] = ['fix', 'feature', 'refactor', 'tests', 'docs', 'deps', 'ci', 'revert', 'leader', 'other'];

/** Where a knowledge note applies. Empty lists mean "any". A null repo means every repo. */
export interface KnowledgeScope {
  /** GitHub `owner/name`, case-insensitive; null = any repo. */
  repo: string | null;
  /** Repo-relative globs (`src/core/**`, `*.md`); [] = any path. */
  pathGlobs: string[];
  /** [] = any task kind. */
  taskKinds: TaskKind[];
}

/** Why a task failed, as a stable code the Lessons chart groups on plus one sentence. */
export interface RetroRootCause {
  /** Stable machine code, e.g. `gate:protected-path`, `verify:tests-failed`, `revert:ci-red`. */
  code: string;
  /** Short label for the chart legend ("Protected path touched"). */
  label: string;
  /** One specific sentence (scrubbed). */
  detail: string;
  /** Where the cause was read from (a gate memo, verify output, a close reason…). */
  evidence: string;
}

/** A note the retro suggests; becomes a KnowledgeNoteV1 in the review queue. */
export interface KnowledgeCandidate {
  text: string;
  scope: KnowledgeScope;
}

export interface RetroV1 {
  v: 1;
  /** Deterministic from `sourceKey`, so one task end produces one retro. */
  id: string;
  /** Idempotency key, e.g. `fleet:gate:<proposalId>`, `cloud:<taskId>:closed`. */
  sourceKey: string;
  source: RetroSource;
  /** The task / proposal / action id in its own store. */
  taskId: string;
  repo: string | null;
  endKind: RetroEndKind;
  endedAt: string;
  taskKind: TaskKind;
  /** What was asked (title + first lines of the brief, scrubbed). */
  asked: string;
  /** What happened, one or two sentences. */
  happened: string;
  /** null for a success, or when nothing recorded why. */
  rootCause: RetroRootCause | null;
  doDifferently: string[];
  /** A sharper version of the original request; null when there is nothing to improve on. */
  betterPrompt: string | null;
  candidates: KnowledgeCandidate[];
  /** Paths the task touched, when known (repo-relative, ≤ 20). */
  paths: string[];
  /** The optional cheap model pass: null = deterministic only. */
  model: { engine: string; model: string | null; at: string } | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Knowledge notes
// ---------------------------------------------------------------------------

export type KnowledgeStatus = 'pending' | 'approved' | 'rejected';

export interface KnowledgeNoteV1 {
  v: 1;
  id: string;
  text: string;
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  /** The retro that suggested it; null when Mason wrote it himself. */
  retroId: string | null;
  source: RetroSource | 'mason';
  createdAt: string;
  decidedAt: string | null;
  /** True when Mason changed the text or scope before approving. */
  edited: boolean;
  /** Times this note was injected into a prompt. */
  hits: number;
  lastHitAt: string | null;
  /** Retros that suggested the same note again while it was pending/approved. */
  seen: number;
  /** Fleet task that proposes it for AGENTS.md; null until requested. */
  agentsMdTaskId: string | null;
}

// ---------------------------------------------------------------------------
// Verse contract
// ---------------------------------------------------------------------------

/** One retro, as the Lessons list shows it. */
export type RetroSummary = Pick<
  RetroV1,
  'id' | 'source' | 'taskId' | 'repo' | 'endKind' | 'endedAt' | 'taskKind' | 'asked' | 'happened' | 'rootCause' | 'doDifferently' | 'betterPrompt'
> & { candidates: number; modelAssisted: boolean };

/** Recurring failure causes over the window, most frequent first. */
export interface LessonsCauseRow {
  code: string;
  label: string;
  count: number;
  /** Counts per source, for the stacked bar. */
  bySource: Record<RetroSource, number>;
}

export interface LessonsStateV1 {
  v: 1;
  /** Newest first, ≤ 50. */
  retros: RetroSummary[];
  /** Retros in the window, per end kind. */
  endKinds: Partial<Record<RetroEndKind, number>>;
  causes: LessonsCauseRow[];
  windowDays: number;
  knowledge: {
    pending: KnowledgeNoteV1[];
    approved: KnowledgeNoteV1[];
    rejected: number;
    /** Bytes the approved notes would take if every one matched (the cap bounds what is injected). */
    approvedBytes: number;
    capBytes: number;
  };
  /** Veto lessons the Leader and task prompts now read back (playbook deltas). */
  playbook: { text: string; hits: number; addedAt: string }[];
  /** Last completed sweep; null = never. */
  sweptAt: string | null;
}

export type KnowledgeDecision = 'approve' | 'reject';

/** POST /api/verse/learning/lessons/knowledge */
export interface KnowledgeDecisionRequest {
  id: string;
  decision: KnowledgeDecision;
  /** Approve with an edit: replaces the text (scrubbed, ≤ KNOWLEDGE_NOTE_MAX_CHARS). */
  text?: string;
  scope?: KnowledgeScope;
}

/** What a prompt builder asks for: the task the knowledge would be injected into. */
export interface KnowledgeTarget {
  repo: string | null;
  paths: readonly string[];
  kind: TaskKind | null;
  /** Free text used only to infer `kind` when it is null. */
  text?: string;
}
