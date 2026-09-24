/**
 * routes/verse/composer/composer-text.ts — the pure text rules behind the
 * composer's `@` finder, `/` commands and attachment tokens (unit C3).
 *
 * Kept free of React and the DOM so every rule is a unit test: what counts as
 * an active trigger at the caret, what a completion inserts and where the
 * caret lands, and how an attachment token is added and removed.
 */
import type { VerseFileMatch } from '../../../../core/verse/workbench-types.js';

export type ComposerTrigger =
  | { kind: 'mention'; query: string; start: number; end: number }
  | { kind: 'command'; query: string; start: number; end: number };

/** Longest `@` query the finder is asked for (the route caps at 200). */
const MENTION_QUERY_MAX = 120;

/**
 * The trigger the caret is inside, or null.
 *  - `@query` — an `@` at the start of the text or after whitespace, then
 *    anything but whitespace up to the caret. An e-mail address (`a@b`) is
 *    not a trigger.
 *  - `/query` — only as the FIRST thing in the message (a slash command),
 *    letters and dashes only, caret still inside it.
 */
export function activeTrigger(text: string, caret: number): ComposerTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const command = /^\/([a-z-]*)$/i.exec(before);
  if (command) {
    // The rest of the word after the caret belongs to the token too.
    const after = /^[a-z-]*/i.exec(text.slice(caret))?.[0] ?? '';
    return { kind: 'command', query: command[1]!.toLowerCase(), start: 0, end: caret + after.length };
  }
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const query = mention[2]!;
    if (query.length > MENTION_QUERY_MAX) return null;
    const start = caret - query.length - 1;
    const after = /^[^\s@]*/.exec(text.slice(caret))?.[0] ?? '';
    return { kind: 'mention', query, start, end: caret + after.length };
  }
  return null;
}

/** Replace the trigger's span with `insert` (plus one space) and put the caret after it. */
export function applyCompletion(text: string, trigger: ComposerTrigger, insert: string): { text: string; caret: number } {
  const tail = text.slice(trigger.end);
  const spacer = tail.startsWith(' ') || insert.endsWith(' ') ? '' : ' ';
  const next = `${text.slice(0, trigger.start)}${insert}${spacer}${tail}`;
  return { text: next, caret: trigger.start + insert.length + spacer.length };
}

/**
 * The token a file match inserts. A file in the chat's PRIMARY root is
 * written relative (the CLI's cwd is that root); one in another root is
 * written from its root as the server showed it (`~/…`), which the engine
 * expands to an absolute path before the CLI sees it. Paths with spaces are
 * rare in repos but legal: they are quoted, the form Claude Code accepts.
 */
export function mentionFor(match: VerseFileMatch, primaryRoot: string | null): string {
  const path = primaryRoot !== null && match.root === primaryRoot ? match.path : `${match.root.replace(/\/+$/, '')}/${match.path}`;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export type SlashCommandId = 'handoff' | 'compact' | 'new' | 'plan' | 'effort' | 'model';

export interface SlashCommand {
  id: SlashCommandId;
  title: string;
  description: string;
}

/** SPEC-310C §2: `/` offers exactly these, in this order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'handoff', title: '/handoff', description: 'Continue in a fresh chat with a handoff note' },
  { id: 'compact', title: '/compact', description: 'Summarise earlier turns to free context (sent as a turn)' },
  { id: 'new', title: '/new', description: 'Start a new chat on this seat' },
  { id: 'plan', title: '/plan', description: 'Switch this chat to Plan mode — nothing is edited' },
  { id: 'effort', title: '/effort', description: 'Choose the reasoning effort' },
  { id: 'model', title: '/model', description: 'Choose the model' },
];

/** Commands whose id or title starts with (then contains) the query. */
export function matchSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  const starts = SLASH_COMMANDS.filter((c) => c.id.startsWith(q));
  const contains = SLASH_COMMANDS.filter((c) => !c.id.startsWith(q) && (c.id.includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

// ---------------------------------------------------------------------------
// Attachment tokens
// ---------------------------------------------------------------------------

/** Append an attachment's `@path` token to the draft, on its own if the draft is empty. */
export function insertAttachmentRef(text: string, ref: string, caret: number | null = null): { text: string; caret: number } {
  if (caret === null || caret < 0 || caret > text.length) {
    const sep = text.length === 0 || /\s$/.test(text) ? '' : ' ';
    const next = `${text}${sep}${ref} `;
    return { text: next, caret: next.length };
  }
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const trail = after.startsWith(' ') ? '' : ' ';
  const next = `${before}${lead}${ref}${trail}${after}`;
  return { text: next, caret: before.length + lead.length + ref.length + trail.length };
}

/** Remove every occurrence of an attachment's token (and one space after it). */
export function removeAttachmentRef(text: string, ref: string): string {
  if (!ref) return text;
  return text.split(`${ref} `).join('').split(ref).join('').replace(/ {2,}/g, ' ');
}

/** Bytes as the operator reads them: 812 B, 14 KB, 2.3 MB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A File as base64 without the `data:` prefix (the route accepts either). */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
