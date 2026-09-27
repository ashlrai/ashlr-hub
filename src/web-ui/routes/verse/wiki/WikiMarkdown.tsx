/**
 * routes/verse/wiki/WikiMarkdown.tsx — a wiki page (or an Ask answer) as
 * Markdown, with clickable citations.
 *
 * Rendering is the chat's renderer (marked + DOMPurify, MessageMarkdownRenderer):
 * the stored page is already secret-scrubbed on the server and is still
 * treated as untrusted HTML here. Citations arrive as fragment links —
 * `#cite:src/a.ts:10-12` and `#page:modules` — which DOMPurify keeps (unknown
 * schemes would be stripped); one delegated click handler turns them into
 * "open at that line" / "go to that page" instead of navigation.
 */
import { useMemo, type MouseEvent } from 'react';
import { renderMarkdown } from '../MessageMarkdownRenderer.js';
import type { WikiCitation } from '../../../../core/knowledge/wiki/types.js';
import { parseCitationHref } from './wiki-model.js';
import styles from './Wiki.module.css';

export interface WikiMarkdownProps {
  markdown: string;
  onCite: (cite: WikiCitation) => void;
  onPage?: (id: string) => void;
  label?: string;
}

export function WikiMarkdown({ markdown, onCite, onPage, label }: WikiMarkdownProps) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href') ?? '';
    if (href.startsWith('#cite:')) {
      event.preventDefault();
      const cite = parseCitationHref(href);
      if (cite) onCite(cite);
    } else if (href.startsWith('#page:')) {
      event.preventDefault();
      const id = href.slice('#page:'.length);
      if (/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) onPage?.(id);
    }
  };
  return (
    // Clicks are delegated to the links inside; the links themselves are the
    // focusable, keyboard-operable elements (Enter on a link fires click).
    <div className={styles.markdown} aria-label={label} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
