/**
 * routes/verse/chat/tool-semantics.ts — what a tool call actually DID.
 *
 * An agentic session is mostly tool work, and `{name, input, result}` is too
 * raw to read: the transcript can tell you `Edit` ran with some JSON, not
 * that `src/core/api.ts` gained four lines. Everything downstream — the
 * per-turn file-activity summary, the diff rendering, the command block, the
 * error affordances — needs the same derived facts, so they are derived ONCE
 * here, as pure functions over the event payload.
 *
 * Deliberately conservative. A fact that cannot be read out of the payload
 * (an exit code the tool never printed, the file offset an `Edit` payload
 * does not carry) is reported as unknown rather than guessed — DESIGN §6,
 * and the same discipline VERSE-TELEMETRY-V2 imposes on provider data.
 */
import type { VerseSource } from '../../../../core/verse/types.js';
import {
  baseToolName as coreBaseToolName,
  isWebSearchTool,
  normalizeUrl,
  sourcesFromToolCall,
  toolActionForName,
  toolInputPaths,
  type VerseToolAction,
} from '../../../../core/verse/trace.js';
import { splitLines, unifiedDiffFor } from './line-diff.js';

/** Shared with the server (core/verse/trace.ts) so a Read is a read on both sides. */
export type ToolAction = VerseToolAction;

/** Actions that change the working tree — the blast radius of a turn. */
export const MUTATING_ACTIONS: readonly ToolAction[] = ['edit', 'create', 'delete'];

export interface ToolDiff {
  /** Unified-diff text, ready for `routes/inbox/diff-parser.ts`. */
  text: string;
  /**
   * False when the line numbers are synthetic. An `Edit` payload says what
   * was replaced, never where it sat, so the viewer hides the gutter rather
   * than printing numbers that are not the file's.
   */
  anchored: boolean;
  /** More than one file — the inbox `DiffViewer` file tree earns its place. */
  multiFile: boolean;
  /** Where the diff came from, for the block's caption. */
  origin: 'payload' | 'output';
}

export interface CommandFacts {
  command: string;
  /** Only when the result states one in so many words; otherwise unknown. */
  exitCode: number | null;
}

export interface WrittenContent {
  path: string;
  text: string;
}

export interface ToolFacts {
  /** Normalized name with any MCP prefix removed (`ashlr__edit` → `edit`). */
  base: string;
  action: ToolAction;
  /** Files this call touched, most significant first; may be empty. */
  paths: string[];
  command: CommandFacts | null;
  diff: ToolDiff | null;
  /** A whole file written whose previous contents were never in the payload. */
  written: WrittenContent | null;
  /** The tool reported failure, or stated a non-zero exit. */
  failed: boolean;
  /** Still waiting for its result. */
  pending: boolean;
  /**
   * V3.15: what this call proves the agent saw — files (with the line range
   * the payload or output states), fetched pages, searches. Empty while
   * pending or when the call failed (a Read that errored read nothing).
   */
  sources: VerseSource[];
  /** V3.15: a web call's address or query, for the one-line row. */
  web: WebFacts | null;
  /** V3.15: a subagent call's brief, for the one-line row. */
  task: TaskFacts | null;
}

export interface WebFacts {
  /** `search` = the argument is a query; `fetch` = an address. */
  mode: 'search' | 'fetch';
  query: string | null;
  url: string | null;
  domain: string | null;
}

export interface TaskFacts {
  /** The short description the agent gave the subagent. */
  description: string | null;
  /** The subagent's type/name, when the call names one. */
  agent: string | null;
}

// ---------------------------------------------------------------------------
// Name → action (the table lives in core/verse/trace.ts)
// ---------------------------------------------------------------------------

/**
 * Strip transport prefixes so an MCP-routed edit reads as an edit:
 * `mcp__plugin_ashlr_ashlr__ashlr__edit` → `edit`, codex `mcp:ashlr.edit` → `edit`.
 */
export function baseToolName(name: string): string {
  return coreBaseToolName(name);
}

export function actionForName(name: string): ToolAction {
  return toolActionForName(name);
}

/** Short verb for a file-activity row; also the a11y wording. */
export const ACTION_LABEL: Record<ToolAction, string> = {
  read: 'read',
  edit: 'edited',
  create: 'created',
  delete: 'deleted',
  command: 'ran',
  search: 'searched',
  task: 'delegated',
  web: 'fetched',
  other: 'used',
};

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every path-ish string in the payload, first-seen order, de-duplicated —
 * list forms and codex `file_change` `changes: [{path}]` included.
 */
export function pathsIn(input: unknown): string[] {
  return toolInputPaths(input);
}

/** `src/web-ui/App.tsx` → `App.tsx`. Never the whole path in a dense row. */
export function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The directory part, for the second line of a file-activity row. */
export function fileDirname(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell_command', 'commandLine'];

/**
 * A line that is nothing but a stated exit status. Deliberately anchored to
 * the whole line: `exit 1` appearing inside a shell script in the output is
 * not the command's exit code, and reporting it as one would be a lie in the
 * place the operator is most likely to trust.
 */
const EXIT_LINE = /^[ \t]*(?:exit(?:ed)?[ \t]+(?:with[ \t]+)?(?:code|status)|exit[ \t]*code|exit[ \t]*status|command[ \t]+exited[ \t]+with[ \t]+code)[ \t]*[:=]?[ \t]*(\d{1,3})[ \t]*\.?$/im;

/** The exit code the output states, or null when it states none. */
export function statedExitCode(output: string): number | null {
  const match = EXIT_LINE.exec(output);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

const GIT_HEADER = /^diff --git /m;
const OLD_HEADER = /^--- (?:a\/|\/dev\/null|[^\n]*\t)/m;
const NEW_HEADER = /^\+\+\+ (?:b\/|\/dev\/null|[^\n]*\t)/m;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/**
 * True when this text is itself a unified diff we can hand to the parser.
 *
 * A `@@` hunk is sufficient but NOT necessary. `git diff`/`git show` output
 * consisting only of renames, only of mode changes, or only of
 * "Binary files … differ" carries no hunk header at all; requiring one sent
 * that output down the raw-terminal path, where a rename reads as noise. The
 * parser already degrades a hunkless entry into `unparsedNotice` and a
 * `renamed`/`added`/`deleted` status, both of which `DiffBlock` renders — so a
 * `diff --git` header on its own is enough to treat the text as a diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  if (GIT_HEADER.test(text)) return true;
  // Without the git header the `---`/`+++` pair is only conclusive alongside a
  // hunk; plain prose can contain a line of dashes.
  return HUNK_HEADER.test(text) && OLD_HEADER.test(text) && NEW_HEADER.test(text);
}

function fileCount(diff: string): number {
  const git = diff.match(/^diff --git /gm);
  if (git) return git.length;
  return (diff.match(/^--- /gm) ?? []).length;
}

interface EditPair { old: string; next: string }

/** `{old_string, new_string}` under any of the spellings the tools use. */
function editPair(value: unknown): EditPair | null {
  const rec = record(value);
  if (!rec) return null;
  const old = rec.old_string ?? rec.oldString ?? rec.old_str ?? rec.old ?? rec.search ?? rec.find;
  const next = rec.new_string ?? rec.newString ?? rec.new_str ?? rec.new ?? rec.replace ?? rec.replacement;
  if (typeof old !== 'string' || typeof next !== 'string') return null;
  return { old, next };
}

/**
 * One file header followed by every edit's hunks. Each edit gets its own
 * synthetic offset so the hunks stay distinct for the parser; the numbers
 * are not the file's, which is why the result is `anchored: false`.
 */
function diffForEdits(path: string, edits: readonly EditPair[]): string {
  const bodies: string[] = [];
  let offset = 1;
  edits.forEach((edit, index) => {
    const text = unifiedDiffFor(edit.old, edit.next, {
      path,
      oldStart: offset,
      newStart: offset,
      section: edits.length > 1 ? `edit ${index + 1} of ${edits.length}` : undefined,
    });
    offset += Math.max(splitLines(edit.old).length, splitLines(edit.next).length) + 8;
    if (text) bodies.push(text.split('\n').slice(2).join('\n'));
  });
  if (bodies.length === 0) return '';
  return [`--- a/${path}`, `+++ b/${path}`, ...bodies].join('\n');
}

/** A brand-new file as an all-additions diff; its new-side numbers are real. */
function diffForCreate(path: string, content: string): string {
  const lines = splitLines(content);
  if (lines.length === 0) return '';
  return [
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Ceiling on any agent-supplied text this module carries into a `ToolFacts`.
 *
 * `ToolUseCard` caps the raw output it renders, but the diff and written-file
 * paths bypass that cap entirely: they read `result.output` / `input.content`
 * straight off the payload. A `git diff` over a large tree, or a `Write` of a
 * generated file, then gets fully parsed by `DiffBlock` and fully materialised
 * into the DOM — and `buildTurns` re-parses it for every tool call on every
 * transcript rebuild. This is agent-controlled content with no upstream bound,
 * so the bound belongs here, where the text is first captured.
 *
 * Matches `CommandOutput`'s own ceiling so the two paths truncate alike.
 */
export const MAX_FACT_TEXT_CHARS = 200_000;

/** Truncate with the same sentence `CommandOutput` uses, so the UI reads as one. */
export function capFactText(text: string): string {
  if (text.length <= MAX_FACT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_FACT_TEXT_CHARS)}\n… (${text.length - MAX_FACT_TEXT_CHARS} more characters not shown)`;
}

export interface ToolCallInput {
  name: string;
  input: unknown;
  result: { output: string; isError: boolean } | null;
}

/** Claude Code's Write says which of the two it did; nothing else does. */
const WROTE_EXISTING = /\bhas been updated\b|\bsuccessfully (?:over)?written\b|\bupdated successfully\b/i;
const WROTE_NEW = /\b(?:file )?created successfully\b|\bnew file created\b/i;

export function readToolFacts({ name, input, result }: ToolCallInput): ToolFacts {
  const base = baseToolName(name);
  let action = actionForName(name);
  const rec = record(input);
  const output = result?.output ?? '';
  const pending = result === null;

  // Write is create-or-overwrite and only the RESULT knows which.
  if (action === 'create' && result && WROTE_EXISTING.test(output) && !WROTE_NEW.test(output)) action = 'edit';
  // Codex `file_change` says per file whether it was added, updated or deleted.
  if (base === 'file_change') action = fileChangeAction(rec) ?? action;

  const paths = pathsIn(input);
  const primary = paths[0] ?? null;

  let command: CommandFacts | null = null;
  if (rec) {
    for (const key of COMMAND_KEYS) {
      const value = str(rec[key]);
      if (value) {
        command = { command: value, exitCode: result ? statedExitCode(output) : null };
        if (action === 'other') action = 'command';
        break;
      }
    }
  }

  let diff: ToolDiff | null = null;
  let written: WrittenContent | null = null;

  // 1. The result is itself a diff (`git diff`, a patch tool echoing back).
  if (result && looksLikeUnifiedDiff(output)) {
    diff = { text: capFactText(output), anchored: true, multiFile: fileCount(output) > 1, origin: 'output' };
  }

  // 2. The INPUT is a diff (apply_patch / a patch argument).
  if (!diff && rec) {
    const patch = str(rec.patch) ?? str(rec.diff);
    if (patch && looksLikeUnifiedDiff(patch)) {
      diff = { text: capFactText(patch), anchored: true, multiFile: fileCount(patch) > 1, origin: 'payload' };
    }
  }

  // 3. Edit-shaped payloads: one pair, or MultiEdit's `edits` array.
  if (!diff && rec && primary) {
    const single = editPair(rec);
    const listValue = rec.edits ?? rec.replacements ?? rec.changes;
    const many = Array.isArray(listValue)
      ? listValue.map(editPair).filter((e): e is EditPair => e !== null)
      : [];
    const pairs = many.length > 0 ? many : single ? [single] : [];
    if (pairs.length > 0) {
      const text = diffForEdits(primary, pairs);
      if (text) diff = { text: capFactText(text), anchored: false, multiFile: false, origin: 'payload' };
      if (action === 'other') action = 'edit';
    }
  }

  // 4. A whole file written. A create's line numbers are real; an overwrite's
  //    old side was never in the payload, so it is shown as content, not as a
  //    diff claiming the file had nothing in it before.
  if (!diff && rec && primary) {
    const content = typeof rec.content === 'string' ? rec.content
      : typeof rec.contents === 'string' ? rec.contents
        : typeof rec.text === 'string' && (action === 'create' || action === 'edit') ? rec.text
          : null;
    if (content !== null) {
      if (action === 'create') {
        const text = diffForCreate(primary, content);
        if (text) diff = { text: capFactText(text), anchored: true, multiFile: false, origin: 'payload' };
      } else {
        written = { path: primary, text: capFactText(content) };
      }
    }
  }

  const failed = result !== null && (result.isError || (command?.exitCode ?? 0) > 0);
  const sources = failed ? [] : sourcesFromToolCall({ name, input, output: result ? output : null, isError: result?.isError === true });

  return { base, action, paths, command, diff, written, failed, pending, sources, web: webFacts(name, action, rec), task: taskFacts(action, rec) };
}

/** Codex `changes: [{kind:'add'|'update'|'delete'}]` → one action; mixed → edit. */
function fileChangeAction(rec: Record<string, unknown> | null): ToolAction | null {
  const changes = rec?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const kinds = new Set(changes.map((c) => String(record(c)?.kind ?? '').toLowerCase()));
  if (kinds.size === 1 && kinds.has('add')) return 'create';
  if (kinds.size === 1 && kinds.has('delete')) return 'delete';
  return 'edit';
}

const URL_KEYS = ['url', 'uri', 'href', 'link', 'page_url'];

function webFacts(name: string, action: ToolAction, rec: Record<string, unknown> | null): WebFacts | null {
  if (action !== 'web' || !rec) return null;
  const query = str(rec.query) ?? str(rec.q) ?? str(rec.search_query);
  let url: string | null = null;
  for (const key of URL_KEYS) {
    const value = str(rec[key]);
    if (value) { url = value; break; }
  }
  const norm = url ? normalizeUrl(url) : null;
  const mode = isWebSearchTool(name) && !url ? 'search' : url ? 'fetch' : query ? 'search' : 'fetch';
  return { mode, query, url: norm?.url ?? url, domain: norm?.domain ?? null };
}

function taskFacts(action: ToolAction, rec: Record<string, unknown> | null): TaskFacts | null {
  if (action !== 'task' || !rec) return null;
  const description = str(rec.description) ?? str(rec.task) ?? (str(rec.prompt)?.split('\n')[0]?.slice(0, 120) ?? null);
  return { description, agent: str(rec.subagent_type) ?? str(rec.agent) ?? str(rec.agent_type) };
}

/** DOM id a file-activity row scrolls to. One per tool call. */
export function toolAnchorId(toolUseId: string): string {
  return `verse-tool-${toolUseId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
