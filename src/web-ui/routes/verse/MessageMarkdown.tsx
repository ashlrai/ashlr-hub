/**
 * routes/verse/MessageMarkdown.tsx — assistant text rendered as Markdown.
 *
 * This file is the light half. The renderer — marked + DOMPurify plus the
 * streaming block cache, ~70 KB minified — lives in MessageMarkdownRenderer
 * and loads as its own chunk (3.10 first paint, SPEC-310A §1: the chat's
 * critical JS was 658 KB against a 350 KB budget, and this was the largest
 * piece the transcript did not need in order to show text).
 *
 * Until the renderer is in, a message shows as PLAIN TEXT (React text, never
 * HTML — model output is untrusted, and nothing unsanitized can reach the
 * DOM on this path either). The download starts when this module evaluates,
 * so on a real load the renderer is usually in before the first message
 * mounts; once in, every mount renders Markdown synchronously. If the chunk
 * fails to load, the text stays plain (still complete and readable) and the
 * next mount asks again.
 *
 * The pure helpers (splitStreamingBlocks, appendInlineText, codeLanguage)
 * live in markdown-stream.ts and are re-exported here for existing importers.
 */
import { memo, useEffect, useState } from 'react';
import styles from './Transcript.module.css';

export { appendInlineText, codeLanguage, splitStreamingBlocks, type StreamingSplit } from './markdown-stream.js';

type RendererModule = typeof import('./MessageMarkdownRenderer.js');

let renderer: RendererModule | null = null;
let pending: Promise<RendererModule> | null = null;

/**
 * Load (once) the Markdown renderer chunk. Exported so a caller that needs
 * Markdown synchronously — a test, a print path — can await it first.
 */
export function loadMarkdownRenderer(): Promise<RendererModule> {
  pending ??= import('./MessageMarkdownRenderer.js').then(
    (mod) => (renderer = mod),
    (err: unknown) => {
      // Not cached: a transient failure must not pin every message to plain text for the tab's life.
      pending = null;
      throw err;
    },
  );
  return pending;
}

// Start now, in parallel with whatever else the transcript is waiting on.
if (typeof window !== 'undefined') void loadMarkdownRenderer().catch(() => undefined);

function useRenderer(): RendererModule | null {
  const [mod, setMod] = useState<RendererModule | null>(renderer);
  useEffect(() => {
    if (mod) return undefined;
    let live = true;
    loadMarkdownRenderer().then((m) => { if (live) setMod(m); }, () => undefined);
    return () => { live = false; };
  }, [mod]);
  return mod;
}

/** The message before the renderer lands: all of it, as text, in the Markdown box's typography. */
function PlainMessage({ text }: { text: string }) {
  return (
    <div className={styles.markdown} data-markdown-pending="">
      <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
    </div>
  );
}

/**
 * Memoized: a finished message re-renders only when its text changes, so a
 * token streaming into the NEXT reply never re-parses this one.
 */
export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const mod = useRenderer();
  return mod ? <mod.RenderedMarkdown text={text} streaming={streaming} /> : <PlainMessage text={text} />;
});
