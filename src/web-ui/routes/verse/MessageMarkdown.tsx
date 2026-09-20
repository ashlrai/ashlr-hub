/**
 * routes/verse/MessageMarkdown.tsx — assistant text rendered as Markdown.
 * `marked` produces HTML, DOMPurify strips anything that isn't safe inline
 * content, then each fenced block gets a language label and a copy button
 * revealed on hover (DESIGN §5). Model output is untrusted: raw HTML in the
 * Markdown never reaches the DOM unsanitized, links open in a new tab with
 * rel=noopener, and no script/style/handler attributes survive.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
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

export function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const root = useRef<HTMLDivElement>(null);

  // Decorate every <pre> with a language label + copy control after the
  // sanitized HTML lands. Buttons are stripped by the sanitizer, so the only
  // <button> inside a code block is one we put there ourselves.
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    for (const pre of node.querySelectorAll('pre')) {
      if (pre.querySelector('[data-code-head]')) continue;
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
  }, [html]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
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

  return (
    <div
      ref={root}
      className={`${styles.markdown} ${streaming ? styles.streaming : ''}`}
      onClick={onClick}
      // Sanitized above — DOMPurify with the html profile, no raw model HTML.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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
