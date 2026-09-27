/**
 * core/verse/terminal-blocks.ts — a terminal tab's output, cut into command
 * blocks (3.15). Fed by TerminalManager with every output frame; the marks
 * come from shell-integration.ts.
 *
 *   A (prompt)   ─ B (input)  typed command  C (executed)  OUTPUT  D;<exit>
 *
 * A block opens at C and closes at D. Its command line is the nonce-checked
 * OSC 633;E the shell sent just before C; without one it is read back from
 * the echoed input between B and C (best effort). A prompt (A) while a block
 * is open closes it with no exit code: the shell never said.
 *
 * MEMORY. Blocks live in memory only, like the scrollback: at most
 * VERSE_TERMINAL_MAX_BLOCKS per tab, each keeping the LAST
 * VERSE_TERMINAL_BLOCK_OUTPUT_BYTES of its output (an error is at the end),
 * and all of a tab's output together within VERSE_TERMINAL_BLOCKS_TOTAL_BYTES
 * — the oldest blocks lose their output first (`evicted`), keeping their
 * command, time and exit code.
 */
import { createShellMarkParser, sanitizeCommandLine, type LocatedShellMark } from './shell-integration.js';
import {
  VERSE_TERMINAL_BLOCK_OUTPUT_BYTES,
  VERSE_TERMINAL_BLOCKS_TOTAL_BYTES,
  VERSE_TERMINAL_MAX_BLOCKS,
  type VerseTerminalBlock,
} from './workbench-types.js';

export interface BlockTrackerOptions {
  tabId: string;
  /** The tab's shell nonce; null = no integration was injected (marks from a program the operator runs still count). */
  nonce: string | null;
  now?: () => number;
  maxBlocks?: number;
  blockOutputBytes?: number;
  totalOutputBytes?: number;
  onBlock?: (block: VerseTerminalBlock) => void;
  onCwd?: (cwd: string) => void;
  /** The first mark from the shell: integration is live. */
  onActive?: () => void;
}

export interface BlockTracker {
  /** One output frame (in order). */
  feed(chunk: Uint8Array, seq: number): void;
  list(): VerseTerminalBlock[];
  get(id: string): VerseTerminalBlock | null;
  /** The kept output bytes of a block (a copy); null for an unknown block. */
  output(id: string): { bytes: Buffer; truncated: boolean; evicted: boolean } | null;
  /** The shell exited or the tab closed: an open block ends with no exit code. */
  close(): void;
  readonly cwd: string | null;
}

interface BlockRecord {
  block: VerseTerminalBlock;
  chunks: Buffer[];
  keptBytes: number;
  startedMs: number;
}

/** Input echo kept to recover a command line when the shell sent no E. */
const INPUT_ECHO_MAX_BYTES = 8 * 1024;

const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)h/; // eslint-disable-line no-control-regex

/**
 * zsh's PROMPT_SP: when output does not end in a newline it prints the
 * PROMPT_EOL_MARK (`%` in reverse video by default), pads the line, and
 * returns with `\r \r` — all BEFORE the precmd hook sends D, so it lands at
 * the end of the block. Removed here; a block view is not a terminal and
 * would print it literally.
 */
// eslint-disable-next-line no-control-regex
const PROMPT_SP_TAIL_RE = /(?:\x1b\[[0-9;]*m)*[%#](?:\x1b\[[0-9;]*m)* +\r \r$/;

export function trimPromptSp(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes;
  // Only the tail can hold it: a line's worth of padding plus the mark's SGRs.
  const tailStart = Math.max(0, bytes.length - 1024);
  const tail = bytes.subarray(tailStart).toString('latin1');
  const m = PROMPT_SP_TAIL_RE.exec(tail);
  if (!m) return bytes;
  return bytes.subarray(0, tailStart + m.index);
}

/** `\r` returns to the line's start and what follows overwrites it — as a terminal would draw it. */
export function overwriteCarriageReturns(text: string): string {
  return text.split('\n').map((line) => {
    const parts = line.replace(/\r+$/, '').split('\r');
    return parts.reduce((acc, part) => (part.length >= acc.length ? part : part + acc.slice(part.length)), '');
  }).join('\n');
}

/**
 * A block's bytes as plain text ("Copy output", and — scrubbed — "Send to
 * chat"): escape sequences removed, CR redraws (progress bars) collapsed to
 * what the screen showed, backspaces applied, trailing blank lines dropped.
 */
export function terminalBytesToText(bytes: Buffer): string {
  const decoded = bytes.toString('utf8')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[\]P_^][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b./g, '')
    .replace(/\r\n/g, '\n');
  let out = '';
  for (const ch of overwriteCarriageReturns(decoded)) {
    if (ch === '\b') out = out.slice(0, -1);
    // eslint-disable-next-line no-control-regex
    else if (!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ch)) out += ch;
  }
  return out.replace(/\s+$/, '');
}

/** The echoed input between B and C as a command line: escape sequences out, backspaces applied. */
export function commandFromEcho(echo: Buffer): string {
  // eslint-disable-next-line no-control-regex
  let text = echo.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/\x1b./g, '');
  // A line editor redraws with CR: keep the last redraw of each line.
  text = overwriteCarriageReturns(text);
  // Backspace erases.
  let out = '';
  for (const ch of text) {
    if (ch === '\b') out = out.slice(0, -1);
    else out += ch;
  }
  return sanitizeCommandLine(out);
}

export function createBlockTracker(opts: BlockTrackerOptions): BlockTracker {
  const now = opts.now ?? Date.now;
  const maxBlocks = opts.maxBlocks ?? VERSE_TERMINAL_MAX_BLOCKS;
  const blockBytes = opts.blockOutputBytes ?? VERSE_TERMINAL_BLOCK_OUTPUT_BYTES;
  const totalBytes = opts.totalOutputBytes ?? VERSE_TERMINAL_BLOCKS_TOTAL_BYTES;
  const parser = createShellMarkParser(opts.nonce);

  const records: BlockRecord[] = [];
  const byId = new Map<string, BlockRecord>();
  let nextId = 1;
  let open: BlockRecord | null = null;
  let totalKept = 0;
  let cwd: string | null = null;
  let active = false;
  /** Between B and C: the echo of what is being typed. */
  let inInput = false;
  let echo: Buffer[] = [];
  let echoBytes = 0;
  let pendingCommand: string | null = null;

  const iso = (ms: number) => new Date(ms).toISOString();
  const snapshot = (rec: BlockRecord): VerseTerminalBlock => ({ ...rec.block });
  const emit = (rec: BlockRecord) => {
    try { opts.onBlock?.(snapshot(rec)); } catch { /* a listener never breaks the tracker */ }
  };

  function markActive(): void {
    if (active) return;
    active = true;
    try { opts.onActive?.(); } catch { /* ignore */ }
  }

  function capture(rec: BlockRecord, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const buf = Buffer.from(bytes);
    rec.block.outputBytes += buf.length;
    if (!rec.block.fullscreen && ALT_SCREEN_RE.test(buf.toString('latin1'))) {
      // vim/less/htop: a screen, not a transcript. Keep none of it.
      rec.block.fullscreen = true;
      totalKept -= rec.keptBytes;
      rec.chunks = [];
      rec.keptBytes = 0;
    }
    if (rec.block.fullscreen) return;
    rec.chunks.push(buf);
    rec.keptBytes += buf.length;
    totalKept += buf.length;
    // Per block: keep the tail.
    while (rec.keptBytes > blockBytes && rec.chunks.length > 0) {
      const over = rec.keptBytes - blockBytes;
      const first = rec.chunks[0]!;
      if (first.length <= over) {
        rec.chunks.shift();
        rec.keptBytes -= first.length;
        totalKept -= first.length;
      } else {
        rec.chunks[0] = first.subarray(over);
        rec.keptBytes -= over;
        totalKept -= over;
      }
      rec.block.truncated = true;
    }
    enforceTotal(rec);
  }

  /** Across blocks: the oldest lose their output first (never the one being written). */
  function enforceTotal(current: BlockRecord | null): void {
    for (const rec of records) {
      if (totalKept <= totalBytes) return;
      if (rec === current || rec.keptBytes === 0) continue;
      totalKept -= rec.keptBytes;
      rec.chunks = [];
      rec.keptBytes = 0;
      rec.block.evicted = true;
    }
  }

  function dropOldest(): void {
    while (records.length > maxBlocks) {
      const idx = records.findIndex((r) => r !== open);
      if (idx < 0) return;
      const [gone] = records.splice(idx, 1);
      totalKept -= gone!.keptBytes;
      byId.delete(gone!.block.id);
    }
  }

  function startBlock(seq: number, ordinal: number): BlockRecord {
    const at = now();
    let command = pendingCommand;
    if (command === null) command = echoBytes > 0 ? commandFromEcho(Buffer.concat(echo, echoBytes)) : '';
    pendingCommand = null;
    inInput = false;
    echo = [];
    echoBytes = 0;
    const rec: BlockRecord = {
      block: {
        id: `b-${nextId++}`,
        tabId: opts.tabId,
        command,
        cwd,
        startedAt: iso(at),
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        state: 'running',
        startSeq: seq,
        ordinal,
        outputBytes: 0,
        truncated: false,
        evicted: false,
        fullscreen: false,
      },
      chunks: [],
      keptBytes: 0,
      startedMs: at,
    };
    records.push(rec);
    byId.set(rec.block.id, rec);
    dropOldest();
    return rec;
  }

  function finishBlock(rec: BlockRecord, exitCode: number | null): void {
    const at = now();
    // PROMPT_SP lands at the very end, just before D.
    if (rec.chunks.length > 0) {
      const all = Buffer.concat(rec.chunks, rec.keptBytes);
      const trimmed = trimPromptSp(all);
      if (trimmed.length !== all.length) {
        totalKept -= all.length - trimmed.length;
        rec.chunks = trimmed.length > 0 ? [trimmed] : [];
        rec.keptBytes = trimmed.length;
      }
    }
    rec.block.state = 'done';
    rec.block.exitCode = exitCode;
    rec.block.finishedAt = iso(at);
    rec.block.durationMs = Math.max(0, at - rec.startedMs);
    emit(rec);
  }

  function addEcho(bytes: Uint8Array): void {
    if (!inInput || bytes.length === 0 || echoBytes >= INPUT_ECHO_MAX_BYTES) return;
    const room = INPUT_ECHO_MAX_BYTES - echoBytes;
    const buf = Buffer.from(bytes.subarray(0, room));
    echo.push(buf);
    echoBytes += buf.length;
  }

  /** Trim bytes of a mark's sequence that were captured from an EARLIER chunk. */
  function uncapture(rec: BlockRecord, n: number): void {
    let left = n;
    while (left > 0 && rec.chunks.length > 0) {
      const last = rec.chunks[rec.chunks.length - 1]!;
      const cut = Math.min(left, last.length);
      rec.chunks[rec.chunks.length - 1] = last.subarray(0, last.length - cut);
      if (rec.chunks[rec.chunks.length - 1]!.length === 0) rec.chunks.pop();
      rec.keptBytes -= cut;
      totalKept -= cut;
      rec.block.outputBytes = Math.max(0, rec.block.outputBytes - cut);
      left -= cut;
    }
  }

  function apply(m: LocatedShellMark, seq: number, ordinal: () => number): void {
    const mark = m.mark;
    switch (mark.kind) {
      case 'prompt-start':
        markActive();
        if (open) {
          finishBlock(open, null);
          open = null;
        }
        inInput = false;
        pendingCommand = null;
        return;
      case 'command-start':
        markActive();
        inInput = true;
        echo = [];
        echoBytes = 0;
        return;
      case 'command-line':
        if (!mark.trusted) return;
        markActive();
        pendingCommand = mark.command;
        return;
      case 'command-executed':
        markActive();
        if (open) finishBlock(open, null);
        open = startBlock(seq, ordinal());
        emit(open);
        return;
      case 'command-finished':
        if (!open) return;
        finishBlock(open, mark.exitCode);
        open = null;
        return;
      case 'cwd':
        markActive();
        if (mark.cwd !== cwd) {
          cwd = mark.cwd;
          try { opts.onCwd?.(cwd); } catch { /* ignore */ }
        }
        return;
    }
  }

  return {
    get cwd() {
      return cwd;
    },

    feed(chunk, seq) {
      const marks = parser.feed(chunk);
      let cursor = 0;
      let executedInFrame = 0;
      for (const m of marks) {
        const start = Math.max(0, m.start);
        // Bytes before this mark belong to whatever was open.
        if (start > cursor) {
          const slice = chunk.subarray(cursor, start);
          if (open) capture(open, slice);
          else addEcho(slice);
        }
        // Part of the sequence arrived with an earlier chunk: take it back out.
        if (m.start < 0 && open) uncapture(open, -m.start);
        apply(m, seq, () => executedInFrame++);
        cursor = Math.max(cursor, m.end);
      }
      if (cursor < chunk.length) {
        const rest = chunk.subarray(cursor);
        if (open) capture(open, rest);
        else addEcho(rest);
      }
    },

    list() {
      return records.map(snapshot);
    },

    get(id) {
      const rec = byId.get(id);
      return rec ? snapshot(rec) : null;
    },

    output(id) {
      const rec = byId.get(id);
      if (!rec) return null;
      return { bytes: Buffer.concat(rec.chunks, rec.keptBytes), truncated: rec.block.truncated, evicted: rec.block.evicted };
    },

    close() {
      if (open) {
        finishBlock(open, null);
        open = null;
      }
    },
  };
}
