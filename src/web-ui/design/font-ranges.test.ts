/**
 * design/font-ranges.test.ts — the full-coverage font faces only claim what
 * they can draw (3.10 first-paint review; SPEC-310A §1 fonts ≤ 150 KB).
 *
 * WHY: an @font-face without a unicode-range claims every code point, so any
 * character outside the Latin subset — ◑ ▮ ⚠ ✗ ⊘ ⌃ ⇥ ▸, UI symbols the console
 * draws as text — made the browser fetch the 230 KB Plex face (and the 49 KB
 * Space Grotesk face) only to find no glyph there. global.css now gives each
 * `-full` face the range of its source TTF's cmap minus the subset range.
 * This test re-derives that range from the TTF sources, so a font or subset
 * change that forgets to regenerate the CSS fails here.
 *
 * Regenerating (fontTools, from src/web-ui/design): for each of
 * fonts/IBMPlexSans.ttf and fonts/SpaceGrotesk.ttf, take
 * `set(TTFont(path).getBestCmap()) - <code points of the AshlrSans-latin
 * unicode-range>`, collapse consecutive code points into `U+XXXX-YYYY` runs,
 * and paste the list as that face's `unicode-range` — or copy the "expected"
 * value this test prints when it fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESIGN = resolve(process.cwd(), 'src/web-ui/design');
const CSS = readFileSync(join(DESIGN, 'global.css'), 'utf8');

type Range = [number, number];

function parseRange(list: string): Range[] {
  return list.split(',').map((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
  });
}

/** The unicode-range of the @font-face whose src is `file`; null when it has none. */
function faceRange(file: string): Range[] | null {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`@font-face\\s*{[^}]*?${escaped}[^}]*}`, 's').exec(CSS)?.[0];
  if (!block) throw new Error(`global.css: no @font-face for ${file}`);
  const m = /unicode-range:\s*([^;]+);/.exec(block);
  return m ? parseRange(m[1]!) : null;
}

const covers = (ranges: readonly Range[], cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * Every code point a TrueType font maps (its 'cmap', Windows Unicode
 * subtable: format 12 when present, else format 4). Small and dependency-free
 * on purpose — the test must not need fontTools.
 */
function cmapCodePoints(ttfPath: string): Set<number> {
  const buf = readFileSync(ttfPath);
  const numTables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = buf.readUInt32BE(rec + 8);
  }
  if (cmap < 0) throw new Error(`${ttfPath}: no cmap table`);
  const subtables = buf.readUInt16BE(cmap + 2);
  let fmt4 = -1;
  let fmt12 = -1;
  for (let i = 0; i < subtables; i += 1) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmap + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(offset);
    if (platform === 3 && encoding === 10 && format === 12) fmt12 = offset;
    if (platform === 3 && encoding === 1 && format === 4) fmt4 = offset;
  }
  const out = new Set<number>();
  if (fmt12 >= 0) {
    const groups = buf.readUInt32BE(fmt12 + 12);
    for (let g = 0; g < groups; g += 1) {
      const at = fmt12 + 16 + g * 12;
      const start = buf.readUInt32BE(at);
      const end = buf.readUInt32BE(at + 4);
      for (let cp = start; cp <= end; cp += 1) out.add(cp);
    }
    return out;
  }
  if (fmt4 < 0) throw new Error(`${ttfPath}: no Windows Unicode cmap subtable`);
  const segX2 = buf.readUInt16BE(fmt4 + 6);
  const ends = fmt4 + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2; s += 2) {
    const end = buf.readUInt16BE(ends + s);
    const start = buf.readUInt16BE(starts + s);
    const delta = buf.readInt16BE(deltas + s);
    const ro = buf.readUInt16BE(rangeOffsets + s);
    for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
      let glyph: number;
      if (ro === 0) glyph = (cp + delta) & 0xffff;
      else {
        const raw = buf.readUInt16BE(rangeOffsets + s + ro + (cp - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(cp);
    }
  }
  return out;
}

function toRanges(points: Iterable<number>): Range[] {
  const sorted = [...points].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const cp of sorted) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

const fmt = (ranges: readonly Range[]) =>
  ranges.map(([a, b]) => (a === b ? `U+${a.toString(16).toUpperCase().padStart(4, '0')}` : `U+${a.toString(16).toUpperCase().padStart(4, '0')}-${b.toString(16).toUpperCase().padStart(4, '0')}`)).join(', ');

const SUBSET = faceRange('AshlrSans-latin.woff2')!;

const FACES = [
  { full: 'IBMPlexSans-full.woff2', ttf: 'IBMPlexSans.ttf' },
  { full: 'SpaceGrotesk-full.woff2', ttf: 'SpaceGrotesk.ttf' },
] as const;

/** UI symbols the console has drawn as text, none of which either font contains. */
const LACKED = '▮◑◔◆⤷⇥⌃⌫▸⚠✗⊘◇✎';

describe('full font faces claim only what they can draw', () => {
  it('both families use one Latin subset range', () => {
    expect(SUBSET.length).toBeGreaterThan(10);
    expect(faceRange('SpaceGrotesk-latin.woff2')).toEqual(SUBSET);
  });

  for (const face of FACES) {
    it(`${face.full} has a unicode-range equal to ${face.ttf}'s cmap minus the subset`, () => {
      const range = faceRange(face.full);
      expect(range, `${face.full} has no unicode-range — it would claim every code point`).not.toBeNull();
      const expected = toRanges([...cmapCodePoints(join(DESIGN, 'fonts', face.ttf))].filter((cp) => !covers(SUBSET, cp)));
      expect(fmt(range!)).toBe(fmt(expected));
    });

    it(`${face.full} never overlaps the subset (the subset face stays the one ordinary text uses)`, () => {
      for (const [a, b] of faceRange(face.full)!) {
        for (let cp = a; cp <= b; cp += 1) expect(covers(SUBSET, cp), `U+${cp.toString(16)}`).toBe(false);
      }
    });
  }

  it('a symbol neither font has fetches neither full face', () => {
    for (const face of FACES) {
      const range = faceRange(face.full)!;
      for (const ch of LACKED) expect(covers(range, ch.codePointAt(0)!), `${ch} in ${face.full}`).toBe(false);
    }
  });

  it('a character only the full face has still reaches it (Latin Extended, Cyrillic, ↩ ↺ ↻)', () => {
    const plex = faceRange('IBMPlexSans-full.woff2')!;
    for (const ch of 'ĀŁжΩ↩↺↻') expect(covers(plex, ch.codePointAt(0)!), ch).toBe(true);
  });

  it('no Verse UI source draws a character only the 230 KB full Plex face has', () => {
    // With the ranges above, the only characters that still fetch the full
    // face are the ones it really has (↩ ↺ ↻, Latin Extended, Greek, …).
    // UI symbols are drawn as SVG instead (verse-icons ReturnKeyIcon,
    // ChapterRail's markers). The one exception is the key-legend STRING
    // formatChord returns for Enter: it is standard macOS notation, lives in
    // titles and the ⌘/ overlay, and never paints on a cold chat load.
    const ALLOWED: Record<string, string> = { 'routes/verse/shell/command-keys.ts': '↩' };
    const plex = faceRange('IBMPlexSans-full.woff2')!;
    const web = resolve(DESIGN, '..');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(tsx?|css)$/.test(name) && !/\.test\.|test-support/.test(name) ? [p] : [];
    });
    const offenders: string[] = [];
    for (const file of [...files(join(web, 'routes/verse')), ...files(join(web, 'app'))]) {
      const rel = relative(web, file).split('\\').join('/');
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const bad = [...new Set([...code].filter((ch) => covers(plex, ch.codePointAt(0)!) && !(ALLOWED[rel] ?? '').includes(ch)))];
      if (bad.length) offenders.push(`${rel}: ${bad.join('')}`);
    }
    expect(offenders).toEqual([]);
  });
});

