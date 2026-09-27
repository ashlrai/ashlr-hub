/**
 * terminal/ansi-spans.ts — a block's output, in colour, as DOM text (3.15).
 *
 * The block view is not a terminal: it shows what a command printed, the way
 * the terminal showed it, as selectable text. So SGR (colour, bold, dim,
 * italic, underline, inverse, strike — 16, 256 and 24-bit colour) becomes
 * styled runs; cursor motion and erase codes are dropped; OSC strings
 * (titles, hyperlinks, our own block marks) are removed; and a line redrawn
 * with `\r` (a progress bar) shows its last drawing.
 *
 * The 16 ANSI colours are the terminal's own palette custom properties
 * (`var(--term-red)` …, declared on the panel from design tokens), so a
 * block matches the terminal next to it in both themes. 256-colour and RGB
 * values are computed, never literal.
 */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiRun {
  text: string;
  style: AnsiStyle;
}

const NAMED = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

function named(index: number, bright: boolean): string {
  const name = NAMED[index]!;
  return `var(--term-${bright ? 'bright-' : ''}${name})`;
}

/** xterm's 256-colour cube and grey ramp. */
export function color256(n: number): string {
  if (n < 8) return named(n, false);
  if (n < 16) return named(n - 8, true);
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[Math.floor(i / 36)]}, ${steps[Math.floor(i / 6) % 6]}, ${steps[i % 6]})`;
  }
  const level = 8 + (n - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

function clampByte(v: number | undefined): number {
  return Math.max(0, Math.min(255, Number.isFinite(v) ? Math.round(v!) : 0));
}

/** Apply one SGR parameter list to `style` (mutates a copy; returns it). */
export function applySgr(prev: AnsiStyle, params: number[]): AnsiStyle {
  const style: AnsiStyle = { ...prev };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p === 0) {
      for (const k of Object.keys(style)) delete style[k as keyof AnsiStyle];
    } else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 7) style.inverse = true;
    else if (p === 9) style.strike = true;
    else if (p === 22) { delete style.bold; delete style.dim; }
    else if (p === 23) delete style.italic;
    else if (p === 24) delete style.underline;
    else if (p === 27) delete style.inverse;
    else if (p === 29) delete style.strike;
    else if (p >= 30 && p <= 37) style.fg = named(p - 30, false);
    else if (p === 39) delete style.fg;
    else if (p >= 40 && p <= 47) style.bg = named(p - 40, false);
    else if (p === 49) delete style.bg;
    else if (p >= 90 && p <= 97) style.fg = named(p - 90, true);
    else if (p >= 100 && p <= 107) style.bg = named(p - 100, true);
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg';
      if (list[i + 1] === 5 && list[i + 2] !== undefined) {
        style[key] = color256(clampByte(list[i + 2]));
        i += 2;
      } else if (list[i + 1] === 2) {
        style[key] = `rgb(${clampByte(list[i + 2])}, ${clampByte(list[i + 3])}, ${clampByte(list[i + 4])})`;
        i += 4;
      }
    }
  }
  return style;
}

/**
 * A line redrawn with bare `\r` shows its final drawing. Escape sequences
 * make an exact overlay impossible without a screen model, and a redraw
 * (a progress bar, a spinner) is nearly always the whole line — so the last
 * segment with visible text wins.
 */
export function lastDrawing(line: string): string {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.replace(ESCAPES_FOR_WIDTH, '').trim().length > 0) return parts[i]!;
  }
  return '';
}

// eslint-disable-next-line no-control-regex
const ESCAPES_FOR_WIDTH = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const TOKEN_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[()][A-Za-z0-9]|\x1b[^[\]]/g;

export const ANSI_RENDER_MAX_CHARS = 200_000;

/** Styled runs for `text` (a block's output as the shell wrote it). */
export function parseAnsi(text: string): AnsiRun[] {
  const input = text.length > ANSI_RENDER_MAX_CHARS ? text.slice(-ANSI_RENDER_MAX_CHARS) : text;
  const lines = input.replace(/\r\n/g, '\n').split('\n').map(lastDrawing).join('\n');
  const runs: AnsiRun[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (chunk: string) => {
    // Backspace and other C0 controls (bar \n and \t) are not text.
    // eslint-disable-next-line no-control-regex
    const clean = chunk.replace(/[^\n\t]\x08/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!clean) return;
    const prev = runs[runs.length - 1];
    if (prev && sameStyle(prev.style, style)) prev.text += clean;
    else runs.push({ text: clean, style });
  };
  for (const m of lines.matchAll(TOKEN_RE)) {
    push(lines.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[3] === 'm' && m[2] === '') {
      const params = (m[1] ?? '').split(/[;:]/).filter((s) => s !== '').map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n));
      style = applySgr(style, params);
    }
  }
  push(lines.slice(last));
  // Trailing blank lines are the prompt's business, not the command's.
  const tail = runs[runs.length - 1];
  if (tail) {
    tail.text = tail.text.replace(/\s+$/, '');
    if (!tail.text) runs.pop();
  }
  return runs;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k as keyof AnsiStyle] === b[k as keyof AnsiStyle]);
}

/** Inline CSS for a run (inverse swaps fg/bg against the terminal's own colours). */
export function runCss(style: AnsiStyle): Record<string, string> {
  const css: Record<string, string> = {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)'];
  }
  if (fg) css['color'] = fg;
  if (bg) css['backgroundColor'] = bg;
  if (style.bold) css['fontWeight'] = '600';
  if (style.dim) css['opacity'] = '0.7';
  if (style.italic) css['fontStyle'] = 'italic';
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css['textDecoration'] = deco;
  return css;
}
