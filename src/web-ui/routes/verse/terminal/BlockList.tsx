/**
 * terminal/BlockList.tsx — command blocks as cards (3.15, Warp-style).
 *
 * One card per command: the command line, where it ran, how long it took,
 * how it ended; the output folds away and unfolds (in colour, as selectable
 * text). Actions per card: copy output, send to chat, and — for a command
 * that failed — "Explain / fix", which hands the block to the chat seat.
 * The same list shows the operator's own terminal blocks and, read-only,
 * the commands the chat's agents ran (the Agent tab).
 *
 * Output of a terminal block is fetched when the card opens (the server
 * keeps it; the stream only carries metadata) and refetched while the
 * command is still running.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { IconChevronRight, IconCopy, IconSend } from '../../../components/primitives/icons.js';
import { parseAnsi, runCss } from './ansi-spans.js';
import { blockStatus, formatDuration, type BlockView } from './blocks-model.js';
import styles from './TerminalPanel.module.css';

export type BlockAction = 'copy-output' | 'copy-command' | 'send' | 'explain' | 'paste' | 'jump';

export interface BlockListProps {
  blocks: readonly BlockView[];
  /** Terminal blocks: the output as the shell wrote it. Agent blocks carry theirs. */
  loadOutput?: (block: BlockView) => Promise<string>;
  onAction: (action: BlockAction, block: BlockView) => void;
  /** Which actions this list offers (the Agent tab has no "Jump to"). */
  actions: readonly BlockAction[];
  emptyTitle: string;
  emptyBody: string;
  /** Scroll to and ring this block (⌘↑/⌘↓ from the terminal, a gutter dot). */
  highlightId?: string | null;
  label: string;
}

/** Cards open at first: the latest few, and any that failed. */
const OPEN_LATEST = 3;
const RUNNING_REFRESH_MS = 1_500;

function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString();
}

function folderName(cwd: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed;
}

const AnsiOutput = memo(function AnsiOutput({ text }: { text: string }) {
  const runs = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {runs.map((run, i) => {
        const css = runCss(run.style);
        return Object.keys(css).length === 0
          ? <span key={i}>{run.text}</span>
          : <span key={i} style={css as CSSProperties}>{run.text}</span>;
      })}
    </>
  );
});

interface CardProps {
  block: BlockView;
  open: boolean;
  onToggle: (id: string) => void;
  loadOutput?: (block: BlockView) => Promise<string>;
  onAction: (action: BlockAction, block: BlockView) => void;
  actions: readonly BlockAction[];
  highlighted: boolean;
  now: number;
}

const BlockCard = memo(function BlockCard({ block, open, onToggle, loadOutput, onAction, actions, highlighted, now }: CardProps) {
  const [fetched, setFetched] = useState<{ text: string; at: string } | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const status = blockStatus(block);
  const output = block.output ?? fetched?.text ?? null;

  // Terminal blocks fetch their output when opened, again when they finish,
  // and every so often while running.
  const version = `${block.running ? 'run' : 'done'}:${block.durationMs ?? ''}`;
  useEffect(() => {
    if (!open || block.output !== null || !loadOutput || block.fullscreen) return undefined;
    let cancelled = false;
    const load = () => {
      loadOutput(block).then(
        (text) => { if (!cancelled) { setFetched({ text, at: version }); setError(false); } },
        () => { if (!cancelled) setError(true); },
      );
    };
    if (fetched?.at !== version) load();
    const timer = block.running ? setInterval(load, RUNNING_REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fetched` is read, not a trigger
  }, [open, version, block.id, loadOutput]);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const cwdName = folderName(block.cwd);
  const offerExplain = actions.includes('explain') && (status.tone === 'error');
  return (
    <li ref={ref} className={styles.block} data-tone={status.tone} data-highlight={highlighted || undefined} data-testid={`block-${block.id}`}>
      <div className={styles.blockTop}>
        <button type="button" className={styles.blockHead} aria-expanded={open} onClick={() => onToggle(block.id)}
          title={block.command || 'Command'}>
          <span className={styles.chevron} aria-hidden="true"><IconChevronRight size={12} /></span>
          <span className={styles.prompt} aria-hidden="true">$</span>
          <span className={styles.command} data-empty={block.command ? undefined : true}>{block.command || 'command'}</span>
          <span className={styles.meta}>
            {cwdName ? <span title={block.cwd ?? undefined}>{cwdName}</span> : null}
            {block.durationMs !== null ? <span>{formatDuration(block.durationMs)}</span> : null}
            <span>{relativeTime(block.startedAt, now)}</span>
            <span className={styles.status} data-tone={status.tone}>{status.label}</span>
          </span>
        </button>
        <div className={styles.blockActions}>
          {actions.includes('copy-output') ? (
            <button type="button" className={styles.iconBtn} aria-label="Copy output" title="Copy output"
              disabled={block.fullscreen} onClick={() => onAction('copy-output', block)}>
              <IconCopy size={14} />
            </button>
          ) : null}
          {actions.includes('copy-command') && block.command ? (
            <button type="button" className={styles.iconBtn} aria-label="Copy command" title="Copy the command"
              onClick={() => onAction('copy-command', block)}>
              <span aria-hidden="true" className={styles.prompt}>$</span>
            </button>
          ) : null}
          {actions.includes('send') ? (
            <button type="button" className={styles.iconBtn} aria-label="Send to chat" title="Send this block to the chat"
              onClick={() => onAction('send', block)}>
              <IconSend size={14} />
            </button>
          ) : null}
          {offerExplain ? (
            <button type="button" className={styles.iconBtn} aria-label="Explain and fix this error" title="Ask the chat to explain and fix this error"
              onClick={() => onAction('explain', block)}>
              <span aria-hidden="true" style={{ fontSize: 'var(--text-2xs-size)', fontWeight: 600 }}>Fix</span>
            </button>
          ) : null}
          {actions.includes('jump') ? (
            <button type="button" className={styles.iconBtn} aria-label="Show in terminal" title="Show in terminal"
              onClick={() => onAction('jump', block)}>
              <span aria-hidden="true">↗</span>
            </button>
          ) : null}
          {actions.includes('paste') && block.command ? (
            <button type="button" className={styles.iconBtn} aria-label="Paste command in terminal" title="Paste the command at a terminal prompt (it does not run)"
              onClick={() => onAction('paste', block)}>
              <PasteGlyph />
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        block.fullscreen ? (
          <p className={styles.outputNote}>A full-screen program (an editor, a pager): its screen is not kept as output.</p>
        ) : output === null ? (
          <p className={styles.outputNote} role={error ? 'alert' : 'status'}>{error ? 'The output could not be loaded.' : 'Loading output…'}</p>
        ) : output.trim().length === 0 ? (
          <p className={styles.outputNote}>{block.running ? 'No output yet.' : 'No output.'}</p>
        ) : (
          <>
            <pre className={styles.output} tabIndex={0} aria-label={`Output of ${block.command || 'the command'}`}><AnsiOutput text={output} /></pre>
            {block.truncated ? <p className={styles.outputNote}>Only the last part of this output is kept.</p> : null}
          </>
        )
      ) : null}
    </li>
  );
});

export function BlockList({ blocks, loadOutput, onAction, actions, emptyTitle, emptyBody, highlightId = null, label }: BlockListProps) {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const onToggle = useCallback((id: string) => {
    setToggled((prev) => {
      const next = new Map(prev);
      const index = blocks.findIndex((b) => b.id === id);
      const current = prev.get(id) ?? defaultOpen(blocks, index);
      next.set(id, !current);
      return next;
    });
  }, [blocks]);

  // Follow new blocks while the list is scrolled to the bottom (like a terminal).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current || highlightId) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, highlightId]);

  if (blocks.length === 0) {
    return (
      <div className={styles.blocksEmpty}>
        <EmptyState compact title={emptyTitle} body={emptyBody} />
      </div>
    );
  }

  return (
    <div className={styles.blocks} ref={scroller} onScroll={(e) => {
      const el = e.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }}>
      <ol className={styles.blockList} aria-label={label}>
        {blocks.map((block, index) => (
          <BlockCard
            key={block.id}
            block={block}
            open={toggled.get(block.id) ?? defaultOpen(blocks, index)}
            onToggle={onToggle}
            {...(loadOutput ? { loadOutput } : {})}
            onAction={onAction}
            actions={actions}
            highlighted={highlightId === block.id}
            now={now}
          />
        ))}
      </ol>
    </div>
  );
}

/** "Type at a prompt": a return arrow into a line (same grammar as the shared 16px icons). */
function PasteGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M13 3.5v4.25a1.5 1.5 0 0 1-1.5 1.5H3.5" /><path d="m6 6.5-2.5 2.75L6 12" />
    </svg>
  );
}

function defaultOpen(blocks: readonly BlockView[], index: number): boolean {
  const block = blocks[index];
  if (!block) return false;
  return index >= blocks.length - OPEN_LATEST || block.running || blockStatus(block).tone === 'error';
}
