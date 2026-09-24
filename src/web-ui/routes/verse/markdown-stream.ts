/**
 * routes/verse/markdown-stream.ts — the pure, dependency-free half of the
 * chat's Markdown: where a streaming reply may be cut, the plain-text tail's
 * inline marks, and a code block's language. Split out of MessageMarkdown in
 * 3.10 so the renderer (marked + DOMPurify, ~70 KB) can load as its own chunk
 * while these stay importable anywhere for free. MessageMarkdown.tsx
 * re-exports them for existing importers.
 */

/** `language-ts` / `lang-ts` → `ts`; anything else is an unlabelled block. */
export function codeLanguage(code: Element | null): string {
  const match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(code?.className ?? '');
  return match?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// Streaming split
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface StreamingSplit {
  /** Blocks that a later token can no longer change (a blank line followed them). */
  done: string[];
  /** The unfinished last block. */
  tail: string;
  /** The tail is inside an open code fence (its opening line is included). */
  tailInFence: boolean;
}

/**
 * Cut streamed Markdown at blank lines that are not inside a code fence.
 * Exported for tests; pure and linear in the text.
 */
export function splitStreamingBlocks(text: string): StreamingSplit {
  const done: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    const marker = FENCE_RE.exec(line)?.[1] ?? null;
    if (fence === null && marker !== null) {
      fence = marker;
    } else if (fence !== null && marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker && !isLast) {
      // A closing fence only counts once its line is complete: "``" of a
      // still-arriving "```" must not close anything.
      fence = null;
    }
    if (fence === null && line.trim() === '' && !isLast) {
      if (current.length > 0) done.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  const tail = current.join('\n');
  return { done, tail, tailInFence: fence !== null };
}

/** The inline marks worth showing while a sentence is still arriving. */
const INLINE_RE = /(`+)([^`]+?)\1|\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|__(?=\S)([^_\n]+?)(?<=\S)__|(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g;

/**
 * Append `text` to `parent` as text nodes plus <code>/<strong>/<em> for the
 * inline marks. Only textContent is ever assigned — model text cannot become
 * markup on this path.
 */
export function appendInlineText(parent: HTMLElement, text: string): void {
  const doc = parent.ownerDocument;
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m !== null; m = INLINE_RE.exec(text)) {
    if (m.index > last) parent.append(doc.createTextNode(text.slice(last, m.index)));
    let tag: 'code' | 'strong' | 'em';
    let inner: string;
    if (m[2] !== undefined) { tag = 'code'; inner = m[2]; }
    else if (m[3] !== undefined) { tag = 'strong'; inner = m[3]; }
    else if (m[4] !== undefined) { tag = 'strong'; inner = m[4]; }
    else if (m[5] !== undefined) { tag = 'em'; inner = m[5]; }
    else { tag = 'em'; inner = m[6] ?? ''; }
    const el = doc.createElement(tag);
    el.textContent = inner;
    parent.append(el);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
}
