/**
 * routes/verse/MessageMarkdown.tsx — assistant text rendered as Markdown.
 * `marked` produces HTML, DOMPurify strips anything that isn't safe inline
 * content, then each fenced block gets a language label and a copy button
 * revealed on hover (DESIGN §5). Model output is untrusted: raw HTML in the
 * Markdown never reaches the DOM unsanitized, links open in a new tab with
 * rel=noopener, and no script/style/handler attributes survive.
 *
 * STREAMING (V3.10). The old bubble re-ran marked + DOMPurify over the WHOLE
 * accumulated text on every token and replaced the bubble's innerHTML — a
 * 27 KB reply cost 6–19 s of main thread in jsdom, 93% of it DOMPurify.
 * Now a streaming reply is split at blank lines (outside code fences):
 *
 *   - every COMPLETED block is rendered as Markdown exactly once (cached by
 *     its text) and only re-inserted when a new block completes;
 *   - the unfinished TAIL — the only part a token can change — is plain text,
 *     built with textContent (never HTML), with the cheap inline marks
 *     (`code`, **bold**, *italic*) so a sentence does not flash asterisks.
 *     An open code fence streams into a plain <pre>.
 *
 * When the reply is complete the whole text is rendered once, as before, so
 * whatever the block split approximated (a loose list, a reference link) is
 * exact in the final message.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import styles from './Transcript.module.css';

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const SANITIZE: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
};

export function renderMarkdown(text: string): string {
  ensureHooks();
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, SANITIZE);
}

const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';

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

/** Language label + copy control on every <pre> not yet decorated. */
function decorateCodeBlocks(node: HTMLElement): void {
  for (const pre of node.querySelectorAll('pre')) {
    if (pre.querySelector('[data-code-head]')) continue;
    if (pre.hasAttribute('data-stream-tail')) continue;
    const head = document.createElement('div');
    head.className = styles.codeHead ?? '';
    head.setAttribute('data-code-head', '');

    const language = codeLanguage(pre.querySelector('code'));
    const tag = document.createElement('span');
    tag.className = styles.codeLang ?? '';
    tag.textContent = language;
    head.append(tag);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = styles.copy ?? '';
    button.setAttribute('data-copy', '');
    button.setAttribute('aria-label', 'Copy code');
    button.textContent = COPY_LABEL;
    head.append(button);

    pre.prepend(head);
  }
}

function onCopyClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('[data-copy]');
  if (!button) return;
  event.preventDefault();
  const pre = button.closest('pre');
  const codeNode = pre?.querySelector('code');
  const head = pre?.querySelector('[data-code-head]');
  const code = codeNode
    ? codeNode.textContent ?? ''
    : Array.from(pre?.childNodes ?? []).filter((n) => n !== head).map((n) => n.textContent ?? '').join('');
  void copyText(code).then((ok) => {
    button.textContent = ok ? COPIED_LABEL : 'Copy failed';
    setTimeout(() => {
      button.textContent = COPY_LABEL;
    }, 1500);
  });
}

/** Completed-block HTML survives across frames; bounded so one huge reply cannot grow it forever. */
const BLOCK_CACHE_LIMIT = 400;

function StreamingMarkdown({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  const blockHtml = useRef(new Map<string, string>());
  const tailNode = useRef<HTMLElement | null>(null);
  const split = useMemo(() => splitStreamingBlocks(text), [text]);

  // Completed blocks only change when one more completes, so this runs once
  // per paragraph — never per token.
  const doneKey = split.done.length === 0 ? '' : `${split.done.length}:${split.done[split.done.length - 1]!.length}`;
  const doneHtml = useMemo(() => {
    const cache = blockHtml.current;
    const parts = split.done.map((block) => {
      let html = cache.get(block);
      if (html === undefined) {
        html = renderMarkdown(block);
        if (cache.size >= BLOCK_CACHE_LIMIT) cache.clear();
        cache.set(block, html);
      }
      return html;
    });
    return parts.join('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the completed blocks, which only ever grow.
  }, [doneKey]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    node.innerHTML = doneHtml;
    decorateCodeBlocks(node);
    // The tail element is re-appended after the blocks; the effect below fills it.
    tailNode.current = null;
  }, [doneHtml]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const wantPre = split.tailInFence;
    let el = tailNode.current;
    if (!el || el.parentNode !== node || (el.tagName === 'PRE') !== wantPre) {
      el?.remove();
      el = document.createElement(wantPre ? 'pre' : 'p');
      el.setAttribute('data-stream-tail', '');
      node.append(el);
      tailNode.current = el;
    }
    el.replaceChildren();
    if (wantPre) {
      const code = document.createElement('code');
      // The opening fence line is Markdown syntax, not code.
      const newline = split.tail.indexOf('\n');
      code.textContent = newline === -1 ? '' : split.tail.slice(newline + 1);
      el.append(code);
    } else {
      el.style.whiteSpace = 'pre-wrap';
      appendInlineText(el, split.tail);
    }
  }, [split, doneHtml]);

  return <div ref={root} className={`${styles.markdown} ${styles.streaming}`} onClick={onCopyClick} data-markdown-streaming="" />;
}

function FinalMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const root = useRef<HTMLDivElement>(null);

  // Decorate every <pre> with a language label + copy control after the
  // sanitized HTML lands. Buttons are stripped by the sanitizer, so the only
  // <button> inside a code block is one we put there ourselves.
  useEffect(() => {
    const node = root.current;
    if (node) decorateCodeBlocks(node);
  }, [html]);

  return (
    <div
      ref={root}
      className={styles.markdown}
      onClick={onCopyClick}
      // Sanitized above — DOMPurify with the html profile, no raw model HTML.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Memoized: a finished message re-renders only when its text changes, so a
 * token streaming into the NEXT reply never re-parses this one.
 */
export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Keyed so switching modes (a stopped turn's bubble becoming final)
  // remounts the element: the streaming one manages its children by hand.
  return streaming ? <StreamingMarkdown key="streaming" text={text} /> : <FinalMarkdown key="final" text={text} />;
});

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
