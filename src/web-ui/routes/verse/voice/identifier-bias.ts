/**
 * routes/verse/voice/identifier-bias.ts — turn spoken file/identifier names
 * into the real thing, in backticks, when (and only when) the match is
 * confident.
 *
 * Speech engines hear "open the browser pane dot rs file" — never
 * `browser_pane.rs`. The composer knows the chat's files, so a dictated span
 * is rewritten when it is clearly naming one:
 *
 * 1. **Spoken or written extension**: 1–4 words + "dot rs" / ".rs" whose
 *    letters (case and separators ignored) equal a known file's basename.
 * 2. **Cue word**: 2–4 words right before file / component / function / hook
 *    / module / struct / class / type / test / script / crate, equal to a
 *    known basename (without extension). Two words minimum: a single English
 *    word ("composer", "index") is far too often just a word.
 * 3. **Already identifier-shaped**: a token the engine wrote as camelCase,
 *    snake_case or name.ext that equals a known basename gets backticks.
 *
 * "Equal" is exact on the compacted form (`browser_pane.rs` → `browserpane`),
 * and the match must be unique — anything fuzzier is left as spoken. Pure;
 * the caller supplies the known identifiers (composer: the chat's files).
 */

export interface Candidate {
  /** Character span in the text to replace. */
  start: number;
  end: number;
  /** Letters+digits only, lower-case: what must equal a known identifier. */
  compact: string;
  /** The extension it must have (spoken/written), or null. */
  ext: string | null;
  kind: 'extension' | 'cue' | 'token';
  /** Words in the span (longer spans win when several resolve). */
  words: number;
}

const EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'md', 'json', 'css', 'scss', 'html', 'toml', 'yaml', 'yml',
  'py', 'go', 'swift', 'kt', 'java', 'rb', 'sh', 'sql', 'txt', 'lock', 'plist',
]);
const CUES = new Set(['file', 'component', 'function', 'hook', 'module', 'struct', 'class', 'type', 'test', 'script', 'crate', 'enum', 'trait']);
const DOT_WORDS = new Set(['dot', 'period']);

interface Word {
  text: string;
  start: number;
  end: number;
}

export function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitExt(name: string): { stem: string; ext: string | null } {
  const at = name.lastIndexOf('.');
  if (at <= 0 || at === name.length - 1) return { stem: name, ext: null };
  return { stem: name.slice(0, at), ext: name.slice(at + 1).toLowerCase() };
}

function words(text: string): Word[] {
  const out: Word[] = [];
  const re = /[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Only whitespace between two words (no punctuation, no newline). */
function adjacent(text: string, a: Word, b: Word): boolean {
  return /^[ \t]+$/.test(text.slice(a.end, b.start));
}

function insideBackticks(text: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i += 1) if (text[i] === '`') ticks += 1;
  return ticks % 2 === 1;
}

function identifierShaped(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(token) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(token);
}

export function findCandidates(text: string): Candidate[] {
  const ws = words(text);
  const out: Candidate[] = [];
  const run = (from: number, to: number): boolean => {
    for (let i = from; i < to; i += 1) if (!adjacent(text, ws[i]!, ws[i + 1]!)) return false;
    return true;
  };
  for (let k = 0; k < ws.length; k += 1) {
    const w = ws[k]!;
    const lower = w.text.toLowerCase();
    // 1a. "… dot rs"
    if (DOT_WORDS.has(lower) && k + 1 < ws.length && EXTENSIONS.has(ws[k + 1]!.text.toLowerCase()) && adjacent(text, w, ws[k + 1]!)) {
      const ext = ws[k + 1]!.text.toLowerCase();
      for (let n = Math.min(4, k); n >= 1; n -= 1) {
        if (!run(k - n, k)) continue;
        const span = ws.slice(k - n, k);
        out.push({ start: span[0]!.start, end: ws[k + 1]!.end, compact: compact(span.map((s) => s.text).join('')), ext, kind: 'extension', words: n });
      }
    }
    // 1b. "… pane.rs" (the engine wrote the extension onto the last word)
    const { stem, ext } = splitExt(w.text);
    if (ext && EXTENSIONS.has(ext)) {
      for (let n = Math.min(3, k); n >= 0; n -= 1) {
        if (n > 0 && !run(k - n, k)) continue;
        const span = ws.slice(k - n, k);
        const letters = `${span.map((s) => s.text).join('')}${stem}`;
        out.push({ start: (span[0] ?? w).start, end: w.end, compact: compact(letters), ext, kind: 'extension', words: n + 1 });
      }
    }
    // 2. "… browser pane file"
    if (CUES.has(lower)) {
      for (let n = Math.min(4, k); n >= 2; n -= 1) {
        if (!run(k - n, k)) continue;
        const span = ws.slice(k - n, k);
        out.push({ start: span[0]!.start, end: span[span.length - 1]!.end, compact: compact(span.map((s) => s.text).join('')), ext: null, kind: 'cue', words: n });
      }
    }
    // 3. useVoice / browser_pane / VoiceInput.tsx
    if (identifierShaped(w.text)) {
      const parts = splitExt(w.text);
      out.push({ start: w.start, end: w.end, compact: compact(parts.ext && EXTENSIONS.has(parts.ext) ? parts.stem : w.text), ext: parts.ext && EXTENSIONS.has(parts.ext) ? parts.ext : null, kind: 'token', words: 1 });
    }
  }
  return out.filter((c) => c.compact.length >= 3 && !insideBackticks(text, c.start));
}

/** The distinct compacted names worth looking up (for a file search). */
export function lookupQueries(candidates: readonly Candidate[], limit = 6): string[] {
  const seen: string[] = [];
  const sorted = [...candidates].sort((a, b) => b.words - a.words);
  for (const c of sorted) {
    if (!seen.includes(c.compact)) seen.push(c.compact);
    if (seen.length >= limit) break;
  }
  return seen;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** The unique known name a candidate names, or null. */
export function resolveCandidate(candidate: Candidate, known: readonly string[]): string | null {
  const hits = new Set<string>();
  for (const entry of known) {
    const name = basename(entry);
    const { stem, ext } = splitExt(name);
    if (candidate.ext !== null) {
      if (ext === candidate.ext && compact(stem) === candidate.compact) hits.add(name);
    } else if (candidate.kind === 'token') {
      if (compact(stem) === candidate.compact || compact(name) === candidate.compact) hits.add(ext ? name : stem);
    } else if (compact(stem) === candidate.compact && compact(stem).length >= 6) {
      hits.add(name);
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Rewrite the text: longest confident, non-overlapping matches, in backticks. */
export function applyBias(text: string, candidates: readonly Candidate[], known: readonly string[]): string {
  if (known.length === 0 || candidates.length === 0) return text;
  const resolved = candidates
    .map((c) => ({ c, name: resolveCandidate(c, known) }))
    .filter((r): r is { c: Candidate; name: string } => r.name !== null)
    .sort((a, b) => b.c.end - b.c.start - (a.c.end - a.c.start));
  const taken: Array<[number, number]> = [];
  const chosen: Array<{ start: number; end: number; name: string }> = [];
  for (const { c, name } of resolved) {
    if (taken.some(([s, e]) => c.start < e && s < c.end)) continue;
    taken.push([c.start, c.end]);
    chosen.push({ start: c.start, end: c.end, name });
  }
  chosen.sort((a, b) => b.start - a.start);
  let out = text;
  for (const { start, end, name } of chosen) out = `${out.slice(0, start)}\`${name}\`${out.slice(end)}`;
  return out;
}

/**
 * Convenience for callers: find candidates, look the names up with `lookup`
 * (e.g. the chat's file search), and apply. Never throws; a slow or failing
 * lookup leaves the text as spoken.
 */
export async function biasIdentifiers(
  text: string,
  lookup: (queries: string[]) => Promise<readonly string[]>,
  timeoutMs = 400,
): Promise<string> {
  const candidates = findCandidates(text);
  if (candidates.length === 0) return text;
  try {
    const known = await Promise.race([
      lookup(lookupQueries(candidates)),
      new Promise<readonly string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]);
    return applyBias(text, candidates, known);
  } catch {
    return text;
  }
}
