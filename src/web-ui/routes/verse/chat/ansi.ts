/**
 * routes/verse/chat/ansi.ts — turning raw process output into something a
 * human can read.
 *
 * An agentic turn's Bash results arrive exactly as the child process wrote
 * them: SGR colour runs, cursor moves, OSC title sets, and carriage returns
 * from progress bars that expected a terminal to overwrite the line. Dumped
 * into a <pre> those print as `[0;32m` litter and a hundred duplicate
 * progress lines, which is why command output in the transcript is currently
 * the hardest thing in it to read.
 *
 * Pure string functions, no DOM: the colour information is DROPPED rather
 * than translated into spans. DESIGN §1 is monochrome-first — a tool's own
 * palette is not one of the meanings this interface spends colour on.
 */

/* eslint-disable no-control-regex --
   Matching control bytes IS this module's entire purpose: the four patterns
   below are the escape grammar a terminal emits, and there is no way to
   express them without naming the control characters they match. They are
   written as \uXXXX escapes, never as literal bytes in the source. */

/** CSI … final byte @-~ — SGR colour, cursor moves, erase, everything. */
const CSI = /\u001B\[[0-9;:?]*[ -/]*[@-~]/g;
/** OSC … terminated by BEL or ST — window titles, hyperlinks, clipboard. */
const OSC = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
/** Two-byte escapes (ESC 7 / ESC M / charset selects). */
const SHORT = /\u001B[@-Z\\-_]/g;
/** Control bytes that carry no meaning inside a <pre>: tab/newline/CR stay. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/* eslint-enable no-control-regex */

/** True when the text contains at least one escape sequence. */
export function hasAnsi(text: string): boolean {
  return text.includes('\u001B');
}

/** Remove every escape sequence and stray control byte; keep tabs/newlines. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(SHORT, '').replace(CONTROL, '');
}

/**
 * Collapse carriage-return rewrites the way a terminal would: within one
 * line each CR returns the cursor to column 0 and what follows overwrites
 * what was there. A shorter overwrite leaves the tail of the longer line
 * visible, which is why this overlays rather than simply taking the last
 * segment — `100%\rdone` is `done%` on a real terminal, not `done`.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      let out = '';
      for (const segment of line.split('\r')) {
        out = segment.length >= out.length ? segment : segment + out.slice(segment.length);
      }
      return out;
    })
    .join('\n');
}

/**
 * The whole treatment: escapes out, carriage returns applied, trailing blank
 * lines trimmed. Leading whitespace is preserved — indentation is content in
 * compiler output, stack traces and test reports.
 */
export function cleanTerminalOutput(text: string): string {
  return applyCarriageReturns(stripAnsi(text))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

/** Line count without allocating a split array. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * First `limit` lines plus how many were withheld. Backs the collapsed view
 * of a long result — the full text stays one click away, never discarded.
 */
export function headLines(text: string, limit: number): { head: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= limit) return { head: text, hidden: 0 };
  return { head: lines.slice(0, limit).join('\n'), hidden: lines.length - limit };
}
