/**
 * Versioned playbooks — the vocabulary (3.15).
 *
 * A PLAYBOOK is a reusable, versioned task template every lane can run under:
 * fleet goals, the cloud lane, the Devin lane, the Leader's work.dispatch and
 * the interactive "Run in cloud / Run in Devin". Modelled on Devin playbooks:
 * a markdown body with fixed sections (Outcome, Procedure, Specifications,
 * Advice, Forbidden actions, Required from user) under a small front-matter
 * (id, name, `!macro`, where it applies, done-when checks, default budget).
 *
 * Versions are IMMUTABLE: an edit writes v<N+1>; v<N> is never rewritten, so
 * a task that ran under `fix-issue@v3` can always be traced to the exact text
 * it was given, and retros attribute outcomes per version.
 *
 * Guidance only: a playbook changes what the brief SAYS, never a route, gate,
 * budget cap or authority. A task with no playbook gets a byte-identical prompt.
 *
 * BROWSER-SAFE: the Playbooks view imports this — type-only imports, plain consts.
 */
import type { TaskKind } from '../learn/retro/types.js';
import type { CommandParam } from './command-template.js';

export type { TaskKind, CommandParam };

export const VERSE_PLAYBOOKS_PATH = '/api/verse/playbooks';

/** The body sections, in render order. Headings are `## <name>` (case-insensitive). */
export const PLAYBOOK_SECTIONS = [
  'Outcome',
  'Procedure',
  'Specifications',
  'Advice',
  'Forbidden actions',
  'Required from user',
] as const;
export type PlaybookSectionName = (typeof PLAYBOOK_SECTIONS)[number];

/** A playbook without these is rejected: an engine needs a goal and a way there. */
export const REQUIRED_PLAYBOOK_SECTIONS: readonly PlaybookSectionName[] = ['Outcome', 'Procedure'];

/**
 * What a playbook is (the `kind` front-matter key):
 *   agent    guidance an engine follows — every playbook before this key
 *            existed, and the default when it is absent.
 *   command  a COMMAND WORKFLOW: a shell command template with
 *            `{{param:default}}` holes (command-template.ts). The operator
 *            fills a form and the command is pasted at a terminal prompt —
 *            never run, never sent to an engine. No lane resolves one: not
 *            by `!macro`, not explicitly, not by auto-match (resolve.ts).
 */
export const PLAYBOOK_KINDS = ['agent', 'command'] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

/** A command workflow's body: the `## Command` code block and its holes. */
export interface PlaybookCommandSpec {
  /** The command template, exactly as in the code block (no trailing newline). */
  template: string;
  /** Distinct `{{name[:default]}}` holes, in first-appearance order. */
  params: CommandParam[];
}

/** The one section of a `kind: command` playbook (its code block is the template). */
export const COMMAND_SECTION = 'Command';

/** Ids are path segments: lowercase, digits, dashes; 2–48 chars. */
export const PLAYBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** Macros are `!` + an id-shaped name. */
export const PLAYBOOK_MACRO_PATTERN = /^![a-z0-9][a-z0-9-]{1,47}$/;

/** A playbook's markdown source never exceeds this (UTF-8 bytes). */
export const PLAYBOOK_MAX_BYTES = 12 * 1024;
/** The rendered block injected into a prompt never exceeds this (Devin's AGENTS.md cap). */
export const PLAYBOOK_INJECT_CAP_BYTES = 16 * 1024;

export interface PlaybookBudget {
  /** Default spend ceiling for one run, in USD; null = the lane's own default. */
  usd: number | null;
  /** Default wall-clock ceiling for one run, in minutes; null = the lane's own default. */
  minutes: number | null;
}

/** Front-matter. */
export interface PlaybookMeta {
  id: string;
  name: string;
  /** `!fix-bug`. Defaults to `!<id>`. */
  macro: string;
  /** One line for lists and the ⌘K palette. */
  description: string;
  /** Where it applies. Empty lists mean "any". */
  appliesTo: {
    /** GitHub `owner/name`, case-insensitive. */
    repos: string[];
    /** Repo-relative globs (`src/**`, `*.md`). */
    globs: string[];
  };
  /** Task kinds it is written for; [] = any. */
  taskKinds: TaskKind[];
  /** Checks the engine must see pass before it calls the task done. */
  doneWhen: string[];
  budget: PlaybookBudget;
  /**
   * Auto-match: attach this playbook to tasks that did not name one when the
   * task's kind (and repo / globs) match. Off by default — a playbook reaches
   * a task only when asked for, until Mason turns this on.
   */
  auto: boolean;
  /**
   * `agent` or `command` (see PLAYBOOK_KINDS). The parser always sets it;
   * absent (a record from an older build, a hand-built meta) means `agent`.
   */
  kind?: PlaybookKind;
  /** kind `command` only: the template and its holes. */
  command?: PlaybookCommandSpec;
}

/** A playbook's kind; absent ⇒ `agent` (every playbook written before 3.15's command workflows). Pure. */
export function playbookKindOf(meta: { kind?: PlaybookKind } | null | undefined): PlaybookKind {
  return meta?.kind === 'command' ? 'command' : 'agent';
}

export type PlaybookSections = Partial<Record<PlaybookSectionName, string>>;

/** A parsed, validated playbook version. */
export interface PlaybookV1 {
  v: 1;
  meta: PlaybookMeta;
  sections: PlaybookSections;
  version: number;
  /** First 12 hex of sha256(source) — pins the exact text a task ran under. */
  sha: string;
  /** The canonical markdown stored on disk. */
  source: string;
  createdAt: string;
  /** Shipped with ashlr and never edited on this machine (v1 lives in code). */
  builtin: boolean;
}

/** What a task / proposal / retro records: the exact playbook version it ran under. */
export interface PlaybookRef {
  id: string;
  version: number;
  sha: string;
}

/** How a playbook reached a task. */
export type PlaybookMatch = 'explicit' | 'macro' | 'auto';

export interface PlaybookVersionInfo {
  version: number;
  sha: string;
  createdAt: string;
  /** Optional change note written with the edit. */
  note: string | null;
  /** Who wrote this version (`mason`, `leader`, `cli`, `ashlr` for a built-in); null = not recorded. */
  author: string | null;
}

/** One row of the playbook list. */
export interface PlaybookSummary {
  id: string;
  name: string;
  macro: string;
  description: string;
  taskKinds: TaskKind[];
  auto: boolean;
  latest: number;
  builtin: boolean;
  updatedAt: string;
  /** `agent` | `command`; absent (an older server) ⇒ `agent`. */
  kind?: PlaybookKind;
  /** kind `command` only: the template and its holes, so a picker fills without a second read. */
  command?: PlaybookCommandSpec;
}

/** Outcomes per version, counted from retros that carry this playbook. */
export interface PlaybookOutcomeCounts {
  merged: number;
  /** gate-refused, owner-laned, closed, vetoed. */
  refused: number;
  reverted: number;
  /** verify-failed, failed, expired. */
  failed: number;
  total: number;
}

export interface PlaybookValidationIssue {
  field: string;
  message: string;
}

export type PlaybookParseResult =
  | { ok: true; meta: PlaybookMeta; sections: PlaybookSections; warnings: PlaybookValidationIssue[] }
  | { ok: false; errors: PlaybookValidationIssue[] };

// ---------------------------------------------------------------------------
// Verse contract
// ---------------------------------------------------------------------------

/** GET /api/verse/playbooks */
export interface PlaybooksListResponse {
  v: 1;
  playbooks: PlaybookSummary[];
}

/** GET /api/verse/playbooks/<id>[?version=N] */
export interface PlaybookDetailResponse {
  v: 1;
  playbook: PlaybookV1;
  /**
   * Rendered as an engine sees it. A command workflow never reaches an
   * engine: for one this is its command block and parameters, for reading.
   */
  rendered: string;
  versions: (PlaybookVersionInfo & { outcomes: PlaybookOutcomeCounts })[];
}

/** POST /api/verse/playbooks — create (id must be new) or edit (id exists ⇒ v<N+1>). */
export interface PlaybookSaveRequest {
  source: string;
  /** Edit guard: the version the editor started from; a newer latest refuses the save. */
  baseVersion?: number;
  note?: string;
}

export type PlaybookSaveResponse =
  | { ok: true; playbook: PlaybookV1 }
  | { ok: false; errors: PlaybookValidationIssue[] };

export function formatPlaybookRef(ref: Pick<PlaybookRef, 'id' | 'version'>): string {
  return `${ref.id}@v${ref.version}`;
}

/** Parse `id@vN` / `id@N` / `id`. null when malformed. Pure. */
export function parsePlaybookRefText(text: string): { id: string; version: number | null } | null {
  const m = /^([a-z0-9][a-z0-9-]{1,47})(?:@v?(\d{1,6}))?$/.exec(text.trim().replace(/^!/, ''));
  if (!m) return null;
  return { id: m[1]!, version: m[2] ? Number(m[2]) : null };
}

/** Is this a well-formed PlaybookRef? (Records are read back from disk.) */
export function isPlaybookRef(value: unknown): value is PlaybookRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r['id'] === 'string' && PLAYBOOK_ID_PATTERN.test(r['id'])
    && typeof r['version'] === 'number' && Number.isInteger(r['version']) && r['version'] >= 1
    && typeof r['sha'] === 'string' && /^[0-9a-f]{12}$/.test(r['sha']);
}
