/**
 * wiki/citations.ts — find, VERIFY and canonicalise file:line citations.
 *
 * Every citation that survives into a stored page or an Ask answer points at a
 * file that exists in the repo and a line inside it. Model output is treated as
 * a claim: `src/a.ts:40` is kept only when `src/a.ts` is a listed repo file
 * with at least 40 lines; otherwise the line reference is dropped (the path
 * stays as plain code text) and counted, so the UI can say how many were
 * removed. A bare basename (`a.ts:40`) is resolved when exactly one repo file
 * has that name.
 *
 * Canonical form in stored markdown:  [src/a.ts:40-52](#cite:src/a.ts:40-52)
 * A fragment link, deliberately: the Verse renderer sanitises hrefs with
 * DOMPurify, which drops unknown schemes like `cite:`, but keeps fragments; the
 * wiki view intercepts `#cite:` clicks and opens the editor or GitHub.
 */

import type { WikiCitation } from './types.js';

export const CITE_PREFIX = '#cite:';

/** Returns the line count of a repo file, or null when it is not a known file. */
export type LineCounter = (rel: string) => number | null | Promise<number | null>;

export interface VerifyResult {
  markdown: string;
  citations: WikiCitation[];
  dropped: number;
}

function encodePath(rel: string): string {
  return encodeURI(rel).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function citationLabel(c: WikiCitation): string {
  return c.endLine && c.endLine > c.line ? `${c.file}:${c.line}-${c.endLine}` : `${c.file}:${c.line}`;
}

/** The canonical markdown link for a verified citation. */
export function citationLink(c: WikiCitation): string {
  const span = c.endLine && c.endLine > c.line ? `${c.line}-${c.endLine}` : `${c.line}`;
  return `[${citationLabel(c)}](${CITE_PREFIX}${encodePath(c.file)}:${span})`;
}

/** Parse the href of a canonical citation link (used by the UI and tests). */
export function parseCitationHref(href: string): WikiCitation | null {
  if (!href.startsWith(CITE_PREFIX)) return null;
  const body = href.slice(CITE_PREFIX.length);
  const m = /^(.+):(\d{1,7})(?:-(\d{1,7}))?$/.exec(body);
  if (!m) return null;
  let file: string;
  try {
    file = decodeURI(m[1]!).replace(/%28/g, '(').replace(/%29/g, ')');
  } catch {
    return null;
  }
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return null;
  const line = Number(m[2]);
  const endLine = m[3] ? Number(m[3]) : undefined;
  if (line < 1) return null;
  return { file, line, ...(endLine && endLine > line ? { endLine } : {}) };
}

// A path with an extension, then `:12`, `:12-20`, `#L12`, `#L12-L20`.
const PATH = String.raw`((?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z0-9]{1,10})`;
const SPAN = String.raw`(?::|#L)(\d{1,7})(?:\s?(?:-|–|:|-L)\s?L?(\d{1,7}))?`;
/** An already-linked citation from a previous pass (kept as-is on re-verify). */
const CANONICAL_RE = /\[([^\]\n]{1,300})\]\(#cite:([^)\s]{1,400})\)/g;
/** A model-made markdown link whose label or target is a citation. */
const MD_LINK_RE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,400})\)/g;
/** Bare, bracketed or inline-code citations. */
const BARE_RE = new RegExp(String.raw`(?<![\w/:.@-])(\[|\x60)?${PATH}${SPAN}(\]|\x60)?(?![\w/])`, 'g');

interface Parsed {
  file: string;
  line: number;
  endLine?: number;
}

function parseLoose(text: string): Parsed | null {
  const m = new RegExp(String.raw`^\x60?${PATH}${SPAN}\x60?$`).exec(text.trim());
  if (!m) return null;
  const line = Number(m[2]);
  const end = m[3] ? Number(m[3]) : undefined;
  return { file: m[1]!.replace(/^\.\//, ''), line, ...(end !== undefined && end > line ? { endLine: end } : {}) };
}

/** Split markdown into fenced-code and prose segments; citations are only rewritten in prose. */
function segments(md: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
  let last = 0;
  for (const m of md.matchAll(re)) {
    if (m.index! > last) out.push({ code: false, text: md.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

export interface CitationResolver {
  /** All listed repo files (for basename resolution). */
  files: readonly string[];
  lines: LineCounter;
}

async function verifyOne(p: Parsed, resolver: CitationResolver, byBase: Map<string, string[]>): Promise<WikiCitation | null> {
  let file = p.file;
  let count = await resolver.lines(file);
  if (count === null && !file.includes('/')) {
    const matches = byBase.get(file) ?? [];
    if (matches.length === 1) {
      file = matches[0]!;
      count = await resolver.lines(file);
    }
  }
  if (count === null || p.line < 1 || p.line > count) return null;
  const endLine = p.endLine !== undefined ? Math.min(p.endLine, count) : undefined;
  return { file, line: p.line, ...(endLine !== undefined && endLine > p.line ? { endLine } : {}) };
}

async function replaceAsync(text: string, re: RegExp, fn: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return text;
  const reps = await Promise.all(matches.map(fn));
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    out += text.slice(last, m.index) + reps[i];
    last = m.index! + m[0].length;
  });
  return out + text.slice(last);
}

/**
 * Verify and canonicalise every citation in `markdown`. Unverifiable citations
 * lose their line reference (the path stays as `code`) and are counted in
 * `dropped`. Idempotent over its own output.
 */
export async function verifyCitations(markdown: string, resolver: CitationResolver): Promise<VerifyResult> {
  const byBase = new Map<string, string[]>();
  for (const f of resolver.files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const list = byBase.get(base) ?? [];
    list.push(f);
    byBase.set(base, list);
  }
  const citations: WikiCitation[] = [];
  let dropped = 0;
  // Placeholders keep rewritten links from being matched again by later passes.
  const held: string[] = [];
  const hold = (s: string): string => {
    held.push(s);
    return `\u0000${held.length - 1}\u0000`;
  };
  const keep = (c: WikiCitation): string => {
    citations.push(c);
    return hold(citationLink(c));
  };

  const parts = await Promise.all(
    segments(markdown).map(async (seg) => {
      if (seg.code) return seg.text;
      let text = seg.text;
      text = await replaceAsync(text, CANONICAL_RE, async (m) => {
        const parsed = parseCitationHref(`${CITE_PREFIX}${m[2]}`);
        const ok = parsed ? await verifyOne(parsed, resolver, byBase) : null;
        if (ok) return keep(ok);
        dropped++;
        return hold(`\`${parsed?.file ?? m[1]}\``);
      });
      text = await replaceAsync(text, MD_LINK_RE, async (m) => {
        const parsed = parseLoose(m[2]!) ?? parseLoose(m[1]!);
        if (!parsed) return m[0];
        const ok = await verifyOne(parsed, resolver, byBase);
        if (ok) return keep(ok);
        dropped++;
        return hold(`\`${parsed.file}\``);
      });
      text = await replaceAsync(text, BARE_RE, async (m) => {
        const [, open, file, line, end, close] = m;
        const parsed: Parsed = { file: file!.replace(/^\.\//, ''), line: Number(line), ...(end && Number(end) > Number(line) ? { endLine: Number(end) } : {}) };
        const ok = await verifyOne(parsed, resolver, byBase);
        // Unbalanced wrappers (`[a.ts:1` / `a.ts:1]`) are not ours to eat.
        const lead = open && !close ? open : '';
        const trail = close && !open ? close : '';
        if (ok) return lead + keep(ok) + trail;
        dropped++;
        return `${lead}${hold(`\`${parsed.file}\``)}${trail}`;
      });
      return text;
    }),
  );
  // eslint-disable-next-line no-control-regex
  const markdownOut = parts.join('').replace(/\u0000(\d+)\u0000/g, (_s, i: string) => held[Number(i)] ?? '');
  return { markdown: markdownOut, citations, dropped };
}

/** Collect canonical citations already present in stored markdown (no verification). */
export function collectCitations(markdown: string): WikiCitation[] {
  const out: WikiCitation[] = [];
  for (const m of markdown.matchAll(CANONICAL_RE)) {
    const c = parseCitationHref(`${CITE_PREFIX}${m[2]}`);
    if (c) out.push(c);
  }
  return out;
}
