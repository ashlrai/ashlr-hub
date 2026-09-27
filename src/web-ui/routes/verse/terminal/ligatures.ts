/**
 * terminal/ligatures.ts — programming ligatures under the WebGL renderer (3.15).
 *
 * xterm draws each cell on its own, so `=>` in a ligature font (Fira Code,
 * JetBrains Mono, Cascadia Code, Monaspace…) shows as two glyphs. A
 * CHARACTER JOINER tells the WebGL renderer which runs to rasterise as one
 * unit; the font's own shaping then draws its ligature across those cells.
 *
 * Why a list and not the font's GSUB table: @xterm/addon-ligatures reads the
 * font file from disk (Node/Electron only) or the Local Font Access API,
 * neither of which WKWebView offers. The sequences below are the ones every
 * common coding font ligates. A font WITHOUT ligatures loses nothing: the run
 * is drawn as the same characters, in the same cells.
 */

/** Longest first, so `===` wins over `==`. */
export const LIGATURE_SEQUENCES: readonly string[] = [
  '<!--', '===', '!==', '<=>', '>>=', '<<=', '||=', '&&=', '??=', '...', '-->', '->>', '<<-', '|||', '::=',
  '=>', '->', '<-', '==', '!=', '<=', '>=', '::', ':=', '&&', '||', '??', '++', '//', '/*', '*/',
  '</', '/>', '<>', '|>', '<|', '..', '=~', '!~', '>>', '<<', '#{', '#[', '0x',
].sort((a, b) => b.length - a.length);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const LIGATURE_RE = new RegExp(LIGATURE_SEQUENCES.map(escapeRe).join('|'), 'g');

/** The joiner: [start, end) ranges of `text` to draw as single units. */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  if (text.length < 2) return ranges;
  for (const m of text.matchAll(LIGATURE_RE)) {
    // `0x` is only a ligature before a hex digit (0xFF), never in prose.
    if (m[0] === '0x' && !/[0-9a-fA-F]/.test(text[m.index! + 2] ?? '')) continue;
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}
