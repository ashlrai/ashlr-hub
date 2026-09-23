/**
 * Seat-to-seat handoff: a DETERMINISTIC, ZERO-SPEND note that lets a fresh
 * session (same seat, a larger window, or another vendor) pick up where a long
 * one left off.
 *
 * Not to be confused with `handoff.ts`, which is the typed planner-to-worker
 * contract for the local fan-out. This module reads a session's own event log
 * and writes prose for the next agent to read as its first message.
 *
 * WHY DETERMINISTIC: asking the current seat to summarise itself costs a paid
 * turn (and is refused under local-only). Everything below is assembled from
 * `events.jsonl` plus a bounded `git diff --stat` per root, so the preview is
 * free, instant, reproducible, and allowed in every policy mode. When the
 * operator DOES want the agent's own summary, the UI sends a normal turn to the
 * current session first and re-previews with `includeLastAssistant: true` — the
 * spend is then an ordinary, visible, operator-initiated turn.
 *
 * NOTHING HERE STARTS A MODEL CALL. The new session's first turn is spent only
 * when the operator presses send on the pre-filled composer.
 *
 * SECTIONS, highest priority first. When the note would exceed
 * VERSE_HANDOFF_MAX_CHARS the LOWEST-priority sections are dropped, one whole
 * section at a time, and named in `stats.truncated`:
 *
 *   focus         the operator's focus line for the new session
 *   goal          the first user message (the original ask)
 *   latest-asks   the last three user messages after it
 *   state         the last assistant message, abridged (head + tail) — or
 *                 verbatim (capped) when `includeLastAssistant`
 *   files         files the agent read or edited, from tool inputs (≤ 60)
 *   commands      shell commands it ran (≤ 15, most recent)
 *   errors        failures it hit (≤ 5, most recent)
 *   repositories  the roots, each with a bounded `git diff --stat HEAD`
 *   compactions   how often the CLI compacted (early detail is summaries)
 *
 * Every section is `scrubSecrets`'d before it is measured, so the cap holds on
 * the text that is actually returned. Individual sections carry their own caps
 * too (a 64 KB first message must not evict everything else).
 *
 * The note PREFERS PATHS TO CONTENTS (the rule `handoff.ts` enforces for the
 * local fan-out, for the same reason): the next agent has the filesystem, and
 * a file it reads itself is current where a pasted copy is already stale.
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';

import { estimateTokensFromChars } from './context-math.js';
import { gitArgs } from './context-fit.js';
import { isDirectoryPath } from './path-guard.js';
import { VerseServiceError } from './preferences.js';
import {
  VERSE_HANDOFF_MAX_CHARS,
  verseSessionRoots,
  type VerseEvent,
  type VerseHandoffPreview,
  type VerseSession,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** First line of every handoff note. Also how a handoff OF a handoff is recognised. */
export const VERSE_HANDOFF_HEADER = '# Continuing from an earlier Verse session';
export const VERSE_HANDOFF_FOCUS_MAX_CHARS = 500;

export const HANDOFF_MAX_FILES = 60;
export const HANDOFF_MAX_COMMANDS = 15;
export const HANDOFF_MAX_ERRORS = 5;
export const HANDOFF_LATEST_ASKS = 3;

const GOAL_MAX_CHARS = 2_500;
const ASK_MAX_CHARS = 900;
const STATE_SUMMARY_HEAD_CHARS = 900;
const STATE_SUMMARY_TAIL_CHARS = 700;
const STATE_VERBATIM_MAX_CHARS = 6_000;
const COMMAND_MAX_CHARS = 200;
const ERROR_MAX_CHARS = 240;

/** `git diff --stat` bounds, per root and in total (the preview is a synchronous request). */
export const HANDOFF_GIT_TIMEOUT_MS = 3_000;
export const HANDOFF_GIT_MAX_BYTES = 4 * 1024;
const HANDOFF_GIT_TOTAL_BUDGET_MS = 6_000;

/** Section names, in priority order (index 0 = kept longest). Reported in `stats.truncated`. */
export const HANDOFF_SECTIONS = [
  'focus',
  'goal',
  'latest-asks',
  'state',
  'files',
  'commands',
  'errors',
  'repositories',
  'compactions',
] as const;
export type HandoffSectionName = (typeof HANDOFF_SECTIONS)[number];

export interface HandoffPreviewOptions {
  includeLastAssistant?: boolean;
  focus?: string;
  /** Injectable for tests. Default: bounded `git -C <root> diff --stat HEAD`. */
  gitDiffStat?: (root: string) => string | null;
}

// ---------------------------------------------------------------------------
// Tool classification (claude / local share Claude Code's names; codex and
// grok have their own). Names read off real event logs and the CLIs' string
// tables — see the adapters for where each comes from.
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'read_file', 'hashline_read', 'view']);
const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',                         // Claude Code (claude + local seats)
  'write', 'write_file', 'search_replace', 'hashline_edit', 'edit_file', 'create_file', // grok
]);
const COMMAND_TOOLS = new Set(['Bash', 'command_execution', 'run_terminal_command', 'PowerShell', 'shell']);
const PATH_KEYS = ['file_path', 'notebook_path', 'target_file', 'path', 'filePath', 'filename'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathFromInput(input: unknown): string | null {
  if (!isObject(input)) return null;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')) return value.trim();
  }
  return null;
}

function commandFromInput(input: unknown): string | null {
  if (!isObject(input)) return null;
  const command = input['command'];
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** Cap a multi-line block, cutting at a line boundary when that keeps most of it. */
function capBlock(text: string, max: number): string {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length <= max) return trimmed;
  const marker = '\n[… truncated]';
  let cut = trimmed.slice(0, max - marker.length);
  const newline = cut.lastIndexOf('\n');
  if (newline >= cut.length * 0.7) cut = cut.slice(0, newline);
  return `${cut.trimEnd()}${marker}`;
}

/** Head + tail of a long message: agents put the verdict first or last. */
function abridge(text: string): string {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length <= STATE_SUMMARY_HEAD_CHARS + STATE_SUMMARY_TAIL_CHARS + 40) return trimmed;
  let head = trimmed.slice(0, STATE_SUMMARY_HEAD_CHARS);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak >= head.length * 0.6) head = head.slice(0, headBreak);
  let tail = trimmed.slice(trimmed.length - STATE_SUMMARY_TAIL_CHARS);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak !== -1 && tailBreak <= tail.length * 0.4) tail = tail.slice(tailBreak + 1);
  return `${head.trimEnd()}\n[… middle of the reply omitted …]\n${tail.trimStart()}`;
}

function quoteBlock(text: string): string {
  return text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n');
}

/** A path as the next agent should read it: relative to the primary root when under it. */
function displayPath(raw: string, primary: string): string {
  const absolute = isAbsolute(raw) ? resolvePath(raw) : resolvePath(primary, raw);
  const rel = relative(primary, absolute);
  if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return absolute;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Extracted {
  userMessages: Array<{ seq: number; text: string }>;
  lastAssistant: string | null;
  edited: string[];
  read: string[];
  commands: string[];
  errors: string[];
  compactions: Array<{ preTokens: number | null; postTokens: number | null; trigger: string }>;
}

function extract(session: VerseSession, events: readonly VerseEvent[]): Extracted {
  const primary = session.projectPath;
  const userMessages: Extracted['userMessages'] = [];
  let lastAssistant: string | null = null;
  // Insertion-ordered sets; a file edited after being read counts as edited.
  const edited = new Map<string, true>();
  const read = new Map<string, true>();
  const commands: string[] = [];
  const errors: string[] = [];
  const compactions: Extracted['compactions'] = [];
  const toolNames = new Map<string, string>();

  const noteEdited = (raw: string): void => {
    const path = displayPath(raw, primary);
    read.delete(path);
    edited.delete(path); // re-insert so "most recent" ordering holds
    edited.set(path, true);
  };
  const noteRead = (raw: string): void => {
    const path = displayPath(raw, primary);
    if (edited.has(path)) return;
    read.delete(path);
    read.set(path, true);
  };

  for (const event of events) {
    switch (event.type) {
      case 'user-message':
        if (typeof event.text === 'string' && event.text.trim().length > 0) {
          userMessages.push({ seq: event.seq, text: event.text });
        }
        break;
      case 'assistant-message':
        if (typeof event.text === 'string' && event.text.trim().length > 0) lastAssistant = event.text;
        break;
      case 'tool-use': {
        toolNames.set(event.toolUseId, event.name);
        if (READ_TOOLS.has(event.name)) {
          const path = pathFromInput(event.input);
          if (path) noteRead(path);
        } else if (EDIT_TOOLS.has(event.name)) {
          const path = pathFromInput(event.input);
          if (path) noteEdited(path);
        } else if (event.name === 'file_change' && isObject(event.input) && Array.isArray(event.input['changes'])) {
          // codex: one item can touch several files.
          for (const change of event.input['changes']) {
            if (isObject(change) && typeof change['path'] === 'string' && change['path'].length > 0) noteEdited(change['path']);
          }
        } else if (COMMAND_TOOLS.has(event.name)) {
          const command = commandFromInput(event.input);
          if (command && command.trim().length > 0) {
            const line = oneLine(command, COMMAND_MAX_CHARS);
            // Collapse immediate repeats (the same test run five times is one fact).
            if (commands[commands.length - 1] !== line) commands.push(line);
          }
        }
        break;
      }
      case 'tool-result':
        if (event.isError) {
          const name = toolNames.get(event.toolUseId) ?? 'tool';
          const output = typeof event.output === 'string' ? event.output : '';
          const firstLines = output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 2).join(' — ');
          errors.push(oneLine(`${name}: ${firstLines || 'failed'}`, ERROR_MAX_CHARS));
        }
        break;
      case 'error':
        if (typeof event.message === 'string' && event.message.trim().length > 0) {
          errors.push(oneLine(event.message, ERROR_MAX_CHARS));
        }
        break;
      case 'compaction':
        compactions.push({ preTokens: event.preTokens, postTokens: event.postTokens, trigger: event.trigger });
        break;
      default:
        break;
    }
  }

  // Dedupe errors keeping the most recent occurrence of each.
  const recentErrors: string[] = [];
  for (let i = errors.length - 1; i >= 0 && recentErrors.length < HANDOFF_MAX_ERRORS; i -= 1) {
    if (!recentErrors.includes(errors[i])) recentErrors.unshift(errors[i]);
  }
  const recentCommands: string[] = [];
  for (let i = commands.length - 1; i >= 0 && recentCommands.length < HANDOFF_MAX_COMMANDS; i -= 1) {
    if (!recentCommands.includes(commands[i])) recentCommands.unshift(commands[i]);
  }

  return {
    userMessages,
    lastAssistant,
    edited: [...edited.keys()],
    read: [...read.keys()],
    commands: recentCommands,
    errors: recentErrors,
    compactions,
  };
}

/**
 * A session started from a handoff has the previous note as its first message.
 * Its real goal is the "Original goal" section inside that note, not the note.
 */
function goalFrom(firstUserText: string): string {
  if (!firstUserText.startsWith(VERSE_HANDOFF_HEADER)) return firstUserText;
  const match = /\n## Original goal\n+([\s\S]*?)(?:\n## |\n---\n|$)/.exec(firstUserText);
  if (!match) return firstUserText;
  return match[1].split('\n').map((line) => line.replace(/^> ?/, '')).join('\n').trim() || firstUserText;
}

// ---------------------------------------------------------------------------
// git diff --stat
// ---------------------------------------------------------------------------

/**
 * `git -C <root> diff --stat HEAD`, hardened and bounded: 3 s, 4 KB, no
 * external diff drivers or textconv filters (a repo's .gitattributes can name
 * arbitrary commands), no fsmonitor hook, no index lock. Null when the root is
 * not a repository, has no commits, or git fails.
 */
export function defaultGitDiffStat(root: string): string | null {
  if (!isDirectoryPath(root)) return null;
  try {
    const out = execFileSync('git', gitArgs(root, ['diff', '--stat', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD']), {
      encoding: 'utf8',
      timeout: HANDOFF_GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
    return capGitStat(out);
  } catch {
    return null;
  }
}

function capGitStat(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trimEnd();
  if (text.trim().length === 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= HANDOFF_GIT_MAX_BYTES) return text;
  // Keep the summary line ("N files changed, …"): it is the most informative.
  const lines = text.split('\n');
  const summary = lines[lines.length - 1];
  const kept: string[] = [];
  let bytes = Buffer.byteLength(summary, 'utf8') + 64;
  for (const line of lines.slice(0, -1)) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > HANDOFF_GIT_MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  const omitted = lines.length - 1 - kept.length;
  return [...kept, ` … ${omitted} more file${omitted === 1 ? '' : 's'}`, summary].join('\n');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Section {
  name: HandoffSectionName;
  text: string;
}

function header(session: VerseSession, turns: number, events: readonly VerseEvent[]): string {
  const first = events.length > 0 ? events[0].at.slice(0, 10) : session.createdAt.slice(0, 10);
  const last = events.length > 0 ? events[events.length - 1].at.slice(0, 10) : session.updatedAt.slice(0, 10);
  const span = first === last ? first : `${first} → ${last}`;
  return [
    VERSE_HANDOFF_HEADER,
    '',
    `This chat continues "${oneLine(session.title, 120)}" (${session.engine} · ${session.model}, ${turns} turn${turns === 1 ? '' : 's'}, ${span}).`,
    'The notes below were assembled mechanically from that session\'s log. Treat them as leads, not ground truth: re-read any file before you change it, and check the working tree rather than trusting a summary of it.',
  ].join('\n');
}

const FOOTER = [
  '---',
  'Start by checking the current state of the files and repositories above, then continue with the latest request. If anything here is unclear or contradicts what you find, say so before acting.',
].join('\n');

/**
 * Build the handoff note. Deterministic for a given (session, events, opts,
 * git output): no clock, no randomness, no model.
 */
export function buildHandoffPreview(
  session: VerseSession,
  events: VerseEvent[],
  opts: HandoffPreviewOptions = {},
): VerseHandoffPreview {
  const focusRaw = typeof opts.focus === 'string' ? opts.focus.trim() : '';
  if (focusRaw.length > VERSE_HANDOFF_FOCUS_MAX_CHARS) {
    throw new VerseServiceError('VERSE_INVALID', `focus must be at most ${VERSE_HANDOFF_FOCUS_MAX_CHARS} characters`);
  }
  const gitDiffStat = opts.gitDiffStat ?? defaultGitDiffStat;
  const data = extract(session, events);
  const turns = data.userMessages.length;
  const sections: Section[] = [];

  if (focusRaw.length > 0) {
    sections.push({ name: 'focus', text: `## Focus for this session\n\n${focusRaw}` });
  }

  if (data.userMessages.length > 0) {
    const goal = capBlock(goalFrom(data.userMessages[0].text), GOAL_MAX_CHARS);
    sections.push({ name: 'goal', text: `## Original goal\n\n${quoteBlock(goal)}` });
  }

  const later = data.userMessages.slice(1).slice(-HANDOFF_LATEST_ASKS);
  if (later.length > 0) {
    const skipped = data.userMessages.length - 1 - later.length;
    const lines = [`## Latest requests (oldest first${skipped > 0 ? `; ${skipped} earlier omitted` : ''})`, ''];
    later.forEach((message, index) => {
      // Continuation lines indented under the number so a multi-line ask stays one item.
      lines.push(`${index + 1}. ${capBlock(message.text, ASK_MAX_CHARS).replace(/\n/g, '\n   ')}`);
    });
    sections.push({ name: 'latest-asks', text: lines.join('\n') });
  }

  if (data.lastAssistant !== null) {
    const verbatim = opts.includeLastAssistant === true;
    const body = verbatim ? capBlock(data.lastAssistant, STATE_VERBATIM_MAX_CHARS) : abridge(data.lastAssistant);
    // Say "abridged" only when something was actually left out.
    const shortened = body !== data.lastAssistant.replace(/\r\n?/g, '\n').trim();
    const title = verbatim
      ? `## Where it stood (the previous agent's own summary, verbatim${shortened ? ', capped' : ''})`
      : `## Where it stood (the previous agent's last reply${shortened ? ', abridged' : ''})`;
    sections.push({ name: 'state', text: `${title}\n\n${quoteBlock(body)}` });
  }

  const touched = [...data.edited, ...data.read];
  if (touched.length > 0) {
    const lines = ['## Files touched', ''];
    const editedShown = data.edited.slice(-HANDOFF_MAX_FILES);
    const readShown = data.read.slice(-(HANDOFF_MAX_FILES - editedShown.length));
    if (editedShown.length > 0) {
      lines.push('Edited:');
      for (const path of editedShown) lines.push(`- ${path}`);
    }
    if (readShown.length > 0) {
      if (editedShown.length > 0) lines.push('');
      lines.push('Read:');
      for (const path of readShown) lines.push(`- ${path}`);
    }
    const hidden = touched.length - editedShown.length - readShown.length;
    if (hidden > 0) lines.push('', `(${hidden} more not listed)`);
    lines.push('', `Relative paths are relative to ${session.projectPath}.`);
    sections.push({ name: 'files', text: lines.join('\n') });
  }

  if (data.commands.length > 0) {
    sections.push({
      name: 'commands',
      text: ['## Commands run (most recent last)', '', ...data.commands.map((c) => `- \`${c.replace(/`/g, "'")}\``)].join('\n'),
    });
  }

  if (data.errors.length > 0) {
    sections.push({
      name: 'errors',
      text: ['## Errors seen (most recent last)', '', ...data.errors.map((e) => `- ${e}`)].join('\n'),
    });
  }

  const roots = verseSessionRoots(session);
  {
    const lines = ['## Repositories', ''];
    const started = Date.now();
    roots.forEach((root, index) => {
      lines.push(`- ${root}${index === 0 ? ' (primary)' : ''}`);
      // The default runs git synchronously on the request thread: bound the
      // whole loop, not just each call, so eight slow roots cannot stall it.
      if (opts.gitDiffStat === undefined && Date.now() - started > HANDOFF_GIT_TOTAL_BUDGET_MS) {
        lines.push('  (diff not collected: time budget spent)');
        return;
      }
      let stat: string | null;
      try {
        stat = gitDiffStat(root);
      } catch {
        stat = null;
      }
      if (stat === null) return;
      const capped = capGitStat(stat);
      if (capped === null || capped.length === 0) {
        lines.push('  No uncommitted changes against HEAD.');
      } else {
        lines.push('  Uncommitted changes against HEAD (`git diff --stat HEAD`):', '', '  ```', ...capped.split('\n').map((l) => `  ${l}`), '  ```');
      }
    });
    sections.push({ name: 'repositories', text: lines.join('\n') });
  }

  const compactionCount = Math.max(session.compactionCount ?? 0, data.compactions.length);
  if (compactionCount > 0) {
    const last = data.compactions[data.compactions.length - 1];
    const detail = last && last.preTokens !== null && last.postTokens !== null
      ? ` The last one shrank the context from ~${Math.round(last.preTokens / 1000)}k to ~${Math.round(last.postTokens / 1000)}k tokens.`
      : '';
    sections.push({
      name: 'compactions',
      text: `## Compactions\n\nThe previous session auto-compacted ${compactionCount} time${compactionCount === 1 ? '' : 's'}, so its early turns survived only as summaries.${detail} Details from early in that session may be lost; verify rather than assume.`,
    });
  }

  // Scrub every part BEFORE measuring, so the cap holds on what is returned.
  const head = scrubSecrets(header(session, turns, events));
  const foot = FOOTER;
  const scrubbed = sections.map((s) => ({ name: s.name, text: scrubSecrets(s.text) }));
  const separator = '\n\n';
  const total = (parts: readonly Section[]): number =>
    [head, ...parts.map((p) => p.text), foot].join(separator).length;

  const kept = [...scrubbed];
  const dropped: HandoffSectionName[] = [];
  while (kept.length > 0 && total(kept) > VERSE_HANDOFF_MAX_CHARS) {
    // Drop the lowest-priority section still present.
    let worst = 0;
    for (let i = 1; i < kept.length; i += 1) {
      if (HANDOFF_SECTIONS.indexOf(kept[i].name) > HANDOFF_SECTIONS.indexOf(kept[worst].name)) worst = i;
    }
    dropped.push(kept[worst].name);
    kept.splice(worst, 1);
  }

  let text = [head, ...kept.map((p) => p.text), foot].join(separator);
  // Unreachable with the per-section caps above, but the contract is a hard cap.
  if (text.length > VERSE_HANDOFF_MAX_CHARS) text = text.slice(0, VERSE_HANDOFF_MAX_CHARS);

  return {
    sourceSessionId: session.id,
    sourceTitle: scrubSecrets(session.title),
    text,
    stats: {
      chars: text.length,
      estTokens: estimateTokensFromChars(text.length),
      turnsCovered: turns,
      filesTouched: touched.length,
      truncated: dropped,
    },
  };
}
