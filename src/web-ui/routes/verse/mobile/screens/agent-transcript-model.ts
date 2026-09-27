/**
 * routes/verse/mobile/screens/agent-transcript-model.ts — the pure half of
 * the phone's agent screen: one-line tool summaries, fenced-code splitting,
 * clipping long output, the live status line, and unified-diff line kinds.
 *
 * No React, no fetch. The transcript itself is the workbench's own
 * derivation (verse-transcript.ts buildTranscript via useVerseTranscript);
 * this module only decides how a phone shows it compactly.
 */
import type { VerseLiveState } from '../../verse-store.js';
import type { TranscriptItem } from '../../verse-transcript.js';
import { summarizeToolInput } from '../../verse-model.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "12s", "3m", "1h 12m" — short on purpose (a phone line has little room). Null for an unknown span. */
export function shortElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];
const SUMMARY_MAX = 80;

/** `/Users/me/dev/hub/src/a/b.ts` → `…/src/a/b.ts`; a short or relative path stays as it is. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * "Edit …/src/a.ts", "Bash npm test", "Read" — the chip a collapsed tool call
 * shows. Never throws: input is whatever the engine logged (a string, a
 * record, null, something JSON cannot serialize).
 */
export function toolSummary(name: string, input: unknown): string {
  const label = name && name.trim() ? name.trim() : 'Tool';
  let detail = '';
  try {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      const pathKey = PATH_KEYS.find((k) => typeof record[k] === 'string' && (record[k] as string).trim());
      detail = pathKey ? shortPath((record[pathKey] as string).trim()) : summarizeToolInput(input);
    } else {
      detail = summarizeToolInput(input);
    }
  } catch {
    detail = '';
  }
  detail = clip(detail, SUMMARY_MAX);
  return detail ? `${label} ${detail}` : label;
}

export const OUTPUT_MAX_LINES = 40;

/** The first `max` lines of `text`, and how many were left out. */
export function clipLines(text: string, max: number = OUTPUT_MAX_LINES): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max };
}

// ---------------------------------------------------------------------------
// Assistant text
// ---------------------------------------------------------------------------

export type TextSegment = { kind: 'text'; text: string } | { kind: 'code'; text: string; lang: string | null };

/**
 * Split a reply at ``` fences: prose stays prose, code becomes its own block.
 * An unclosed fence (a reply still streaming) runs to the end as code — the
 * same thing a markdown renderer shows mid-stream.
 */
export function splitFences(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const lines = text.split('\n');
  let buffer: string[] = [];
  let inCode = false;
  let lang: string | null = null;
  const flush = () => {
    const joined = buffer.join('\n');
    if (inCode) out.push({ kind: 'code', text: joined, lang });
    else if (joined.trim()) out.push({ kind: 'text', text: joined.replace(/^\n+|\n+$/g, '') });
    buffer = [];
  };
  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      if (inCode) {
        inCode = false;
        lang = null;
      } else {
        inCode = true;
        lang = fence[1] ? fence[1] : null;
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** How many items the phone draws before "Show earlier". */
export const TRANSCRIPT_WINDOW = 60;

/** Items that draw something (a `source` is metadata the phone does not list). */
export function visibleItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.filter((i) => i.kind !== 'source');
}

/** The newest `limit` items, and how many earlier ones are hidden. */
export function windowItems<T>(items: readonly T[], limit: number): { items: T[]; hidden: number } {
  if (items.length <= limit) return { items: [...items], hidden: 0 };
  return { items: items.slice(items.length - limit), hidden: items.length - limit };
}

export function thinkingLabel(item: Extract<TranscriptItem, { kind: 'thinking' }>): string {
  const span = shortElapsed(item.durationMs);
  return span ? `Thought for ${span}` : 'Thought';
}

/** A system line's words (errors, stops, turn ends, compaction, Devin's status). Null = draw nothing. */
export function systemLine(item: TranscriptItem): { text: string; tone: 'danger' | 'muted' | 'info' } | null {
  switch (item.kind) {
    case 'error':
      return { text: item.message ? `Error: ${item.message}` : 'The turn failed.', tone: 'danger' };
    case 'cancelled':
      return { text: 'Stopped', tone: 'muted' };
    case 'turn-done': {
      const span = shortElapsed(item.durationMs);
      if (!item.ok) return { text: span ? `Turn failed after ${span}` : 'Turn failed', tone: 'danger' };
      return { text: span ? `Done in ${span}` : 'Done', tone: 'muted' };
    }
    case 'compaction':
      return { text: item.trigger === 'manual' ? 'Context compacted' : 'Context compacted automatically', tone: 'muted' };
    case 'recovered':
      return { text: item.message || 'Conversation restored', tone: 'info' };
    case 'truncated':
      return { text: 'Earlier messages were trimmed from this chat’s log.', tone: 'muted' };
    case 'remote':
      return { text: item.message || `Devin: ${item.state}`, tone: 'info' };
    default:
      return null;
  }
}

/** Only an https link is drawn as a link (the phone opens it in the browser). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The running turn
// ---------------------------------------------------------------------------

/**
 * "Using Edit · 12s" / "Thinking · 4s" / "Writing" — what the typing line
 * says while a turn runs. `now` is the client clock (ms).
 */
export function liveStatusText(live: VerseLiveState, now: number): string {
  const started = live.progress ? live.progress.receivedAt - live.progress.elapsedMs : live.startedAt;
  const span = started !== null && Number.isFinite(started) ? shortElapsed(now - started) : null;
  let doing = 'Working';
  if (live.notice?.message) doing = live.notice.message;
  else if (live.progress?.phase === 'tool' && live.progress.tool) doing = `Using ${live.progress.tool}`;
  else if (live.thinking) doing = 'Thinking';
  else if (live.progress?.phase === 'thinking') doing = 'Thinking';
  else if (live.progress?.phase === 'writing') doing = 'Writing';
  else if (live.progress?.phase === 'waiting') doing = 'Waiting for the model';
  return span ? `${doing} · ${span}` : doing;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** A unified-diff line's kind, from its first characters. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** Patch text → rows (a trailing newline does not make an empty last row). */
export function diffLines(text: string): Array<{ kind: DiffLineKind; text: string }> {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.map((line) => ({ kind: diffLineKind(line), text: line }));
}

/** "4 files · +120 −8". */
export function diffSummary(t: { files: number; additions: number; deletions: number }): string {
  return `${t.files} ${t.files === 1 ? 'file' : 'files'} · +${t.additions} −${t.deletions}`;
}
