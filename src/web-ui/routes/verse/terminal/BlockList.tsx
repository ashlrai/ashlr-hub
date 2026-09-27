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
 * 3.15 "many agents" additions (terminal blocks only — `extras`):
 *   - ⇧-click / ⌘-click a card's head to select several; the selection bar
 *     copies, sends or asks a seat about all of them at once;
 *   - the RUNNING block's head sticks to the top while its output scrolls;
 *   - Filter-in-block: keep (or, inverted, drop) the lines matching a text
 *     or a regular expression;
 *   - bookmarks (★, per tab, this device) and "Bookmarked only";
 *   - Ask… (any seat), Re-run, Copy link (verse://terminal/<tab>/<block>);
 *   - a loopback URL the command printed → "Open in Browser pane";
 *   - a failed command: the local model's fix chips (Paste, never run).
 *
 * Output of a terminal block is fetched when the card opens (the server
 * keeps it; the stream only carries metadata) and refetched while the
 * command is still running.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { VerseTerminalFixResponse } from '../../../data/api-types.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { IconChevronRight, IconCopy, IconSend, IconX } from '../../../components/primitives/icons.js';
import { parseAnsi, runCss } from './ansi-spans.js';
import { EMPTY_FILTER, filterOutputLines, urlLabel, type BlockSelection, type OutputFilter } from './block-tools.js';
import { blockStatus, formatDuration, type BlockView } from './blocks-model.js';
import { AskGlyph, BrowserGlyph, FilterGlyph, LinkGlyph, RerunGlyph, StarGlyph } from './extra-glyphs.js';
import { FixChips, type AskTarget } from './FixChips.js';
import styles from './TerminalPanel.module.css';
import extra from './TerminalExtras.module.css';

export type BlockAction =
  | 'copy-output' | 'copy-command' | 'send' | 'explain' | 'paste' | 'jump'
  // 3.15 many-agents actions
  | 'ask' | 'ask-seat' | 'rerun' | 'bookmark' | 'copy-link' | 'open-url' | 'paste-text';

/** What some actions need besides the block: where to anchor a menu, which URL, which text, which seat. */
export interface BlockActionExtra {
  anchor?: HTMLElement;
  url?: string;
  text?: string;
  seatId?: string;
}

/** The terminal-only additions (the Agent tab's list has none). */
export interface BlockListExtras {
  selection: BlockSelection;
  /** A modifier-click on a card's head. */
  onSelect: (id: string, gesture: { range: boolean; toggle: boolean }) => void;
  onClearSelection: () => void;
  onSelectionAction: (action: 'copy-output' | 'send' | 'ask', anchor?: HTMLElement) => void;
  bookmarks: ReadonlySet<string>;
  /** Null = fix suggestions are off. */
  loadFix: ((block: BlockView) => Promise<VerseTerminalFixResponse>) | null;
  askTargets: readonly AskTarget[];
  /** Re-run is offered (a live, plain shell with no command running). */
  canRerun: boolean;
}

export interface BlockListProps {
  blocks: readonly BlockView[];
  /** Terminal blocks: the output as the shell wrote it. Agent blocks carry theirs. */
  loadOutput?: (block: BlockView) => Promise<string>;
  onAction: (action: BlockAction, block: BlockView, extra?: BlockActionExtra) => void;
  /** Which actions this list offers (the Agent tab has no "Jump to"). */
  actions: readonly BlockAction[];
  emptyTitle: string;
  emptyBody: string;
  /** Scroll to and ring this block (⌘↑/⌘↓ from the terminal, a gutter dot). */
  highlightId?: string | null;
  label: string;
  extras?: BlockListExtras;
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
  onAction: (action: BlockAction, block: BlockView, extra?: BlockActionExtra) => void;
  actions: readonly BlockAction[];
  highlighted: boolean;
  now: number;
  extras?: BlockListExtras;
  selected: boolean;
  bookmarked: boolean;
}

const BlockCard = memo(function BlockCard({ block, open, onToggle, loadOutput, onAction, actions, highlighted, now, extras, selected, bookmarked }: CardProps) {
  const [fetched, setFetched] = useState<{ text: string; at: string } | null>(null);
  const [error, setError] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<OutputFilter>(EMPTY_FILTER);
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

  const filtered = useMemo(() => (output !== null && filter.pattern ? filterOutputLines(output, filter) : null), [output, filter]);
  const loadFix = extras?.loadFix ?? null;
  const fixLoader = useMemo(() => (loadFix ? () => loadFix(block) : null), [loadFix, block]);

  const cwdName = folderName(block.cwd);
  const offerExplain = actions.includes('explain') && (status.tone === 'error');
  const terminal = block.source === 'terminal' && extras !== undefined;
  const onHead = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (extras && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      extras.onSelect(block.id, { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
      return;
    }
    onToggle(block.id);
  };
  const urls = block.localUrls ?? [];
  return (
    <li ref={ref} className={`${styles.block}${selected ? ` ${extra.selected}` : ''}`} data-tone={status.tone} data-highlight={highlighted || undefined}
      data-selected={selected || undefined} data-testid={`block-${block.id}`} aria-selected={extras ? selected : undefined}>
      <div className={`${styles.blockTop}${block.running && terminal ? ` ${extra.runningTop}` : ''}`}>
        <button type="button" className={styles.blockHead} aria-expanded={open} onClick={onHead}
          title={extras ? `${block.command || 'Command'} — ⇧-click or ⌘-click to select several` : block.command || 'Command'}>
          <span className={styles.chevron} aria-hidden="true"><IconChevronRight size={12} /></span>
          <span className={styles.prompt} aria-hidden="true">$</span>
          <span className={styles.command} data-empty={block.command ? undefined : true}>{block.command || 'command'}</span>
          <span className={styles.meta}>
            {bookmarked ? <span className={extra.bookmarked} aria-label="Bookmarked"><StarGlyph filled size={12} /></span> : null}
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
          {actions.includes('ask') ? (
            <button type="button" className={styles.iconBtn} aria-label="Ask a seat about this command" aria-haspopup="menu"
              title="Ask… — Claude Code, Codex, Devin, Grok, a local model, or all of them side by side"
              onClick={(e) => onAction('ask', block, { anchor: e.currentTarget })}>
              <AskGlyph />
            </button>
          ) : null}
          {offerExplain ? (
            <button type="button" className={styles.iconBtn} aria-label="Explain and fix this error" title="Ask the chat to explain and fix this error"
              onClick={() => onAction('explain', block)}>
              <span aria-hidden="true" style={{ fontSize: 'var(--text-2xs-size)', fontWeight: 600 }}>Fix</span>
            </button>
          ) : null}
          {actions.includes('rerun') && extras?.canRerun && block.command && !block.running ? (
            <button type="button" className={styles.iconBtn} aria-label="Re-run this command" title="Re-run: type it at the prompt and press Enter"
              onClick={() => onAction('rerun', block)}>
              <RerunGlyph />
            </button>
          ) : null}
          {actions.includes('bookmark') ? (
            <button type="button" className={styles.iconBtn} aria-pressed={bookmarked} aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this block'}
              title={bookmarked ? 'Remove bookmark' : 'Bookmark'} onClick={() => onAction('bookmark', block)}>
              <StarGlyph filled={bookmarked} />
            </button>
          ) : null}
          {actions.includes('copy-link') ? (
            <button type="button" className={styles.iconBtn} aria-label="Copy link to this block" title="Copy a verse://terminal link to this block"
              onClick={() => onAction('copy-link', block)}>
              <LinkGlyph />
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
          {terminal && open && output !== null && output.trim().length > 0 ? (
            <button type="button" className={styles.iconBtn} aria-pressed={filterOpen} aria-label="Filter output lines" title="Filter the output's lines"
              onClick={() => { setFilterOpen((o) => !o); if (filterOpen) setFilter(EMPTY_FILTER); }}>
              <FilterGlyph />
            </button>
          ) : null}
        </div>
      </div>
      {terminal && urls.length > 0 ? (
        <div className={extra.bar}>
          {urls.map((url) => (
            <button key={url} type="button" className={extra.chip} onClick={() => onAction('open-url', block, { url })}
              title={`Open ${url} in the Browser pane`}>
              <BrowserGlyph size={12} /><span className={extra.chipCode}>{urlLabel(url)}</span><span className={extra.chipVerb}>Open in Browser</span>
            </button>
          ))}
        </div>
      ) : null}
      {open && filterOpen ? (
        <div className={extra.filterRow} role="search" aria-label="Filter output">
          <input className={extra.filterInput} aria-label="Filter lines" placeholder={filter.regex ? 'Regular expression' : 'Text to match'}
            value={filter.pattern} autoFocus aria-invalid={filtered?.error ? true : undefined}
            onChange={(e) => setFilter((f) => ({ ...f, pattern: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setFilter(EMPTY_FILTER); setFilterOpen(false); } }} />
          <button type="button" className={styles.toggle} aria-pressed={filter.regex} aria-label="Regular expression" title="Regular expression"
            onClick={() => setFilter((f) => ({ ...f, regex: !f.regex }))}>.*</button>
          <button type="button" className={styles.toggle} aria-pressed={filter.caseSensitive} aria-label="Match case" title="Match case"
            onClick={() => setFilter((f) => ({ ...f, caseSensitive: !f.caseSensitive }))}>Aa</button>
          <button type="button" className={styles.toggle} aria-pressed={filter.invert} aria-label="Invert: hide matching lines" title="Invert: show the lines that do NOT match"
            onClick={() => setFilter((f) => ({ ...f, invert: !f.invert }))}>!</button>
          <span className={extra.filterCount} aria-live="polite">
            {filtered?.error ? 'Invalid pattern' : filtered ? `${filtered.shown} of ${filtered.total} lines` : ''}
          </span>
        </div>
      ) : null}
      {open ? (
        block.fullscreen ? (
          <p className={styles.outputNote}>A full-screen program (an editor, a pager): its screen is not kept as output.</p>
        ) : output === null ? (
          <p className={styles.outputNote} role={error ? 'alert' : 'status'}>{error ? 'The output could not be loaded.' : 'Loading output…'}</p>
        ) : output.trim().length === 0 ? (
          <p className={styles.outputNote}>{block.running ? 'No output yet.' : 'No output.'}</p>
        ) : (
          <>
            <pre className={styles.output} tabIndex={0} aria-label={`Output of ${block.command || 'the command'}`}>
              <AnsiOutput text={filtered && !filtered.error ? filtered.text : output} />
            </pre>
            {block.truncated ? <p className={styles.outputNote}>Only the last part of this output is kept.</p> : null}
          </>
        )
      ) : null}
      {terminal && status.tone === 'error' && block.exitCode !== null && open ? (
        <FixChips
          variant="card"
          load={fixLoader}
          askTargets={extras!.askTargets}
          onPaste={(text) => onAction('paste-text', block, { text })}
          onAsk={(seatId) => onAction('ask-seat', block, { seatId })}
          onAskMore={(anchor) => onAction('ask', block, { anchor })}
        />
      ) : null}
    </li>
  );
});

export function BlockList({ blocks, loadOutput, onAction, actions, emptyTitle, emptyBody, highlightId = null, label, extras }: BlockListProps) {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const shown = useMemo(
    () => (bookmarkedOnly && extras ? blocks.filter((b) => extras.bookmarks.has(b.id)) : blocks),
    [blocks, bookmarkedOnly, extras],
  );

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

  const selectedCount = extras ? extras.selection.ids.size : 0;
  const bookmarkCount = extras ? blocks.filter((b) => extras.bookmarks.has(b.id)).length : 0;

  return (
    <div className={styles.blocks} ref={scroller} onScroll={(e) => {
      const el = e.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }}>
      {extras && (selectedCount > 0 || bookmarkCount > 0) ? (
        <div className={extra.listTools} role="toolbar" aria-label={selectedCount > 0 ? 'Selected blocks' : 'Blocks'}>
          {selectedCount > 0 ? (
            <>
              <span aria-live="polite">{selectedCount} selected</span>
              <button type="button" className={extra.chip} onClick={() => extras.onSelectionAction('copy-output')}>Copy outputs</button>
              <button type="button" className={extra.chip} onClick={() => extras.onSelectionAction('send')}>Send to chat</button>
              <button type="button" className={extra.chip} aria-haspopup="menu" onClick={(e) => extras.onSelectionAction('ask', e.currentTarget)}>Ask…</button>
              <button type="button" className={extra.chip} aria-label="Clear selection" title="Clear selection" onClick={extras.onClearSelection}>
                <IconX size={10} />
              </button>
            </>
          ) : <span>⇧/⌘-click blocks to select several</span>}
          <span className={extra.barSpacer} />
          {bookmarkCount > 0 ? (
            <button type="button" className={styles.toggle} aria-pressed={bookmarkedOnly} title="Show only bookmarked blocks"
              onClick={() => setBookmarkedOnly((v) => !v)}>
              <StarGlyph filled={bookmarkedOnly} size={12} /> {bookmarkCount}
            </button>
          ) : null}
        </div>
      ) : null}
      <ol className={styles.blockList} aria-label={label} aria-multiselectable={extras ? true : undefined}>
        {shown.map((block) => {
          const index = blocks.indexOf(block);
          return (
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
              {...(extras ? { extras } : {})}
              selected={extras?.selection.ids.has(block.id) ?? false}
              bookmarked={extras?.bookmarks.has(block.id) ?? false}
            />
          );
        })}
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
