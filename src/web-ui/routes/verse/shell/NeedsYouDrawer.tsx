/**
 * routes/verse/shell/NeedsYouDrawer.tsx — ⌘J, the one inbox for everything
 * waiting on the operator (unit C1; SPEC-310C §1 "Needs-you drawer").
 *
 *   splits   All · Approvals · Fleet · Chats · Accounts      (H / L)
 *   list     J / K move · ↩ open · A approve · R reject · V veto · E done
 *            X (or Shift-click) picks rows; A / R / E then act on every pick
 *   detail   an approval reuses ApprovalDetail (diff, evidence, provenance);
 *            anything else shows its argument, its deadline and its actions
 *   cloud    a cloud PR shows its gate verdict (Clean / Held · why) and, in
 *            its detail, every check; "Land all clean" lands every Clean one
 *            after one confirmation (cloud-triage.ts)
 *
 * Every A / R / V goes through confirmation and then the mutation token
 * (needs-you-actions.ts → guarded-action.tsx) — keyboard triage is fast, but
 * never one keystroke from a real pull request.
 *
 * "All clear" is a claim, so it is only made for a split whose every producer
 * answered (needs-you-model splitCoverage). Otherwise the empty state names
 * who is not reporting — an empty list from a silent source is not good news.
 *
 * A right-hand sheet on a desktop window; a full-screen sheet below 480px.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import { IconExternalLink, IconX } from '../../../components/primitives/icons.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useToast } from '../../../components/primitives/Toast.js';
import type { VerseSeat } from '../../../data/api-types.js';
import type { CloudPrPreview } from '../../../../core/cloud/pr-preview.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import {
  NEEDS_YOU_ACTION_KEYS,
  type NeedsYouActionKind,
  type NeedsYouItem,
} from '../../../../core/verse/workbench-types.js';
import { ApprovalDetail } from '../approvals/ApprovalDetail.js';
import { useVerseUi } from '../useVerseUi.js';
import { ReturnKeyIcon } from '../verse-icons.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import {
  closeVerseOverlay,
  NEEDS_YOU_SPLITS,
  openVerseSession,
  sectionEntry,
  setVerseNeedsYouSplit,
  setVerseSection,
  type NeedsYouSplit,
} from '../verse-ui-store.js';
import { matchCommand } from './command-catalog.js';
import { isGuardOpen } from './guarded-action.js';
import { markResolved, pruneResolved, runNeedsYouAction, useResolvedIds } from './needs-you-actions.js';
import { cleanLandable, cloudPreviewsQuery, runBatch, triageChip, type TriageChip } from './cloud-triage.js';
import {
  actionOf,
  describeSilence,
  itemsForSplit,
  needsYouRowView,
  runModelDisplayName,
  seatDisplayName,
  SPLIT_LABEL,
  splitCounts,
  splitCoverage,
  until,
} from './needs-you-model.js';
import { NeedsYouList, NeedsYouRunFacts, TriageChipView } from './NeedsYouList.js';
import { refreshActivity, useActivity } from './useActivity.js';
import { useViewport } from './viewport.js';
import styles from './NeedsYouDrawer.module.css';

/** A section anchor for the surface an item points into (the shell reveals it: shell/reveal-anchor.ts). */
export { VERSE_ANCHOR_EVENT } from '../verse-ui-store.js';

/** Cloud PR items (cloud-api.ts cloudNeedsYouItems) — the only rows with a gate preview. */
const CLOUD_PR_ITEM_PREFIX = 'fleet:owner-lane-pr:cloud-';

const DRAWER_ACTION: Readonly<Record<string, NeedsYouActionKind>> = {
  'drawer.approve': 'approve',
  'drawer.reject': 'reject',
  'drawer.veto': 'veto',
  'drawer.done': 'done',
};

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function NeedsYouDrawer() {
  const ui = useVerseUi();
  const activity = useActivity();
  const toast = useToast();
  const bootstrap = useQuery(verseBootstrapQuery);
  const { compact } = useViewport();
  const resolved = useResolvedIds();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dispatchDenied, setDispatchDenied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());

  // Countdowns ("closes in 24m") tick while the drawer is open; nothing else re-renders.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const data = activity.data;
  const liveItems = data?.needsYou;
  useEffect(() => {
    if (liveItems) pruneResolved(new Set(liveItems.map((i) => i.id)));
  }, [liveItems]);

  const all = useMemo(() => (liveItems ?? []).filter((i) => !resolved.has(i.id)), [liveItems, resolved]);
  const split = ui.needsYouSplit;
  const items = useMemo(() => itemsForSplit(all, split), [all, split]);
  const counts = useMemo(() => splitCounts(all), [all]);
  const coverage = splitCoverage(data?.sources ?? null, split);
  const dispatchEnabled = (bootstrap.data?.dispatchEnabled ?? true) && !dispatchDenied;

  // Cloud PR verdicts: re-read whenever a cloud item's text changes (the
  // server rewrites its detail when a new preview lands).
  const previewsQuery = useQuery(cloudPreviewsQuery, { freshMs: 15_000 });
  const refetchPreviews = useRefetch(cloudPreviewsQuery);
  const cloudSignature = useMemo(
    () => all.filter((i) => i.id.startsWith(CLOUD_PR_ITEM_PREFIX)).map((i) => `${i.id}\u0000${i.detail ?? ''}`).join('\u0001'),
    [all],
  );
  const firstSignature = useRef(true);
  useEffect(() => {
    // The mount already fetched; only a CHANGE re-reads.
    if (firstSignature.current) {
      firstSignature.current = false;
      return;
    }
    if (cloudSignature) refetchPreviews();
  }, [cloudSignature, refetchPreviews]);
  const previews = previewsQuery.data ?? NO_PREVIEWS;
  const chips = useMemo(() => {
    const out = new Map<string, TriageChip>();
    for (const item of all) {
      const chip = triageChip(item, previews.get(item.id));
      if (chip) out.set(item.id, chip);
    }
    return out;
  }, [all, previews]);
  const landAll = useMemo(() => cleanLandable(items, previews), [items, previews]);

  // Picks only ever name rows this split shows.
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => items.some((i) => i.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);
  const togglePick = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const clearPicks = useCallback(() => setPicked(new Set()), []);

  // Open on the item the palette / a notification asked for.
  const focusId = ui.needsYouFocus;
  useEffect(() => {
    if (!focusId) return;
    const item = all.find((i) => i.id === focusId);
    if (!item) return;
    setSelectedId(item.id);
    setDetailId(item.id);
  }, [focusId, all]);

  // Keep the selection on a real row as items come and go.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((i) => i.id === selectedId)) setSelectedId(items[0]!.id);
  }, [items, selectedId]);

  const detailItem = detailId ? all.find((i) => i.id === detailId) ?? null : null;
  useEffect(() => {
    // The item was resolved (here or elsewhere) while open: back to the list.
    if (detailId && !detailItem) setDetailId(null);
  }, [detailId, detailItem]);

  const closeDetail = useCallback(() => setDetailId(null), []);

  const trapClose = useCallback(() => {
    // Esc in a dialog opened FROM the drawer (a confirmation, the token
    // prompt) belongs to that dialog: every trap hears Escape, and this one
    // registered first.
    if (isGuardOpen() || document.querySelector('[aria-modal="true"]:not([data-verse-overlay])')) return;
    if (detailId) closeDetail();
    else closeVerseOverlay();
  }, [detailId, closeDetail]);
  useFocusTrap({ open: true, containerRef: panelRef, onClose: trapClose, initialFocusRef: listRef });

  // Focus follows the view: into the detail when it opens, back to the list
  // when it closes (not on first mount — the focus trap places that).
  const detailWasOpen = useRef(false);
  useEffect(() => {
    if (detailId) {
      detailWasOpen.current = true;
      detailRef.current?.focus({ preventScroll: true });
    } else if (detailWasOpen.current) {
      detailWasOpen.current = false;
      listRef.current?.focus({ preventScroll: true });
    }
  }, [detailId]);

  // The list usually arrives AFTER the drawer opened (the first poll): the
  // trap focused the placeholder, which is then removed and focus falls to
  // <body>. Hand it to the list — unless the operator has moved it anywhere
  // real (a dialog opened from the drawer lives outside this panel).
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!hasItems || detailId) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active === panelRef.current) listRef.current?.focus({ preventScroll: true });
  }, [hasItems, detailId]);

  const openTarget = useCallback((item: NeedsYouItem) => {
    const target = item.target;
    switch (target.kind) {
      case 'approval':
        setSelectedId(item.id);
        setDetailId(item.id);
        return;
      case 'session':
        closeVerseOverlay();
        openVerseSession(target.sessionId);
        return;
      case 'section':
        closeVerseOverlay();
        setVerseSection(target.section, target.anchor);
        return;
      case 'seat':
        closeVerseOverlay();
        setVerseSection('apps', `seat:${target.seatId}`);
        return;
      case 'url':
        // https only (isNeedsYouItem), a new browsing context with no opener.
        window.open(target.url, '_blank', 'noopener,noreferrer');
        return;
      default:
        return;
    }
  }, []);

  const act = useCallback((item: NeedsYouItem, kind: NeedsYouActionKind) => {
    const action = actionOf(item, kind);
    if (!action) {
      toast.show(`Nothing to ${kind} on this item.`, 'neutral');
      return;
    }
    if (!dispatchEnabled && action.request) {
      toast.show('This server was started without dispatch — run `ashlr verse` to act.', 'neutral');
      return;
    }
    runNeedsYouAction(item, action, { openTarget, toast: toast.show });
  }, [dispatchEnabled, openTarget, toast]);

  const actOnMany = useCallback((targets: readonly NeedsYouItem[], kind: NeedsYouActionKind) => {
    if (!dispatchEnabled) {
      toast.show('This server was started without dispatch — run `ashlr verse` to act.', 'neutral');
      return;
    }
    runBatch(targets, kind, {
      toast: toast.show,
      onSettled: (done) => setPicked((prev) => new Set([...prev].filter((id) => !done.includes(id)))),
    });
  }, [dispatchEnabled, toast]);

  function move(delta: 1 | -1) {
    if (items.length === 0) return;
    const at = Math.max(0, items.findIndex((i) => i.id === selectedId));
    const next = items[(at + delta + items.length) % items.length]!;
    setSelectedId(next.id);
    if (detailId) setDetailId(next.id);
  }

  function stepSplit(delta: 1 | -1) {
    const at = NEEDS_YOU_SPLITS.indexOf(split);
    const next = NEEDS_YOU_SPLITS[(at + delta + NEEDS_YOU_SPLITS.length) % NEEDS_YOU_SPLITS.length]!;
    setVerseNeedsYouSplit(next);
    setDetailId(null);
    clearPicks();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || isTextTarget(event.target)) return;
    // React bubbles through portals: a key typed in a dialog ApprovalDetail
    // opened (rendered outside this panel's DOM) is not a triage key.
    if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) return;
    const command = matchCommand(event.nativeEvent, ['drawer']);
    if (!command) return;
    // A button inside the detail answers Enter itself; the drawer's Enter is
    // for the list.
    if (command.id === 'drawer.open' && event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.find((i) => i.id === (detailId ?? selectedId)) ?? null;
    switch (command.id) {
      case 'drawer.next':
        move(1);
        return;
      case 'drawer.prev':
        move(-1);
        return;
      case 'drawer.split-next':
        stepSplit(1);
        return;
      case 'drawer.split-prev':
        stepSplit(-1);
        return;
      case 'drawer.open':
        if (current) setDetailId(current.id);
        return;
      case 'drawer.select':
        if (current && !detailId) togglePick(current.id);
        return;
      default: {
        const kind = DRAWER_ACTION[command.id];
        if (!kind) return;
        // With rows picked (and the list showing), the key acts on every pick.
        const many = !detailId && picked.size > 0 ? items.filter((i) => picked.has(i.id)) : [];
        if (many.length > 0) actOnMany(many, kind);
        else if (current) act(current, kind);
      }
    }
  }

  const loading = !data && (activity.status === 'loading' || activity.status === 'idle');
  const unavailable = !data && activity.status === 'unavailable';

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && closeVerseOverlay()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.panel}
        data-presentation={compact ? 'full' : 'side'}
        data-verse-overlay="needs-you"
        data-scope="drawer"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            Needs you
            {data ? <span className={styles.titleCount}>{counts.all}</span> : null}
          </h2>
          <IconButton variant="ghost" size="sm" icon={<IconX />} aria-label="Close Needs you" onClick={closeVerseOverlay} />
        </header>

        <div
          role="tablist"
          aria-label="Splits"
          className={styles.splits}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            stepSplit(e.key === 'ArrowRight' ? 1 : -1);
          }}
        >
          {NEEDS_YOU_SPLITS.map((s: NeedsYouSplit) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === split}
              tabIndex={s === split ? 0 : -1}
              className={styles.split}
              onClick={() => {
                setVerseNeedsYouSplit(s);
                setDetailId(null);
              }}
            >
              {SPLIT_LABEL[s]}
              <span className={styles.splitCount} aria-label={`${counts[s]} items`}>{counts[s]}</span>
            </button>
          ))}
        </div>

        {!detailItem && (picked.size > 0 || landAll.length > 0) ? (
          <BatchBar
            pickedItems={items.filter((i) => picked.has(i.id))}
            landAll={landAll}
            dispatchEnabled={dispatchEnabled}
            onRun={actOnMany}
            onClear={clearPicks}
          />
        ) : null}

        <div className={styles.body}>
          {detailItem ? (
            <div ref={detailRef} className={styles.detail} tabIndex={-1} aria-label="Item detail">
              <button type="button" className={styles.back} onClick={closeDetail}>
                ‹ All {SPLIT_LABEL[split].toLowerCase()}
              </button>
              {detailItem.target.kind === 'approval' ? (
                <div className={styles.approval}>
                  <ApprovalDetail
                    key={detailItem.target.proposalId}
                    id={detailItem.target.proposalId}
                    dispatchEnabled={dispatchEnabled}
                    onDispatchDisabled={() => setDispatchDenied(true)}
                    onDecided={() => {
                      markResolved(detailItem.id);
                      void refreshActivity();
                      closeDetail();
                    }}
                  />
                </div>
              ) : (
                <ItemDetail
                  item={detailItem}
                  now={now}
                  seats={bootstrap.data?.seats ?? NO_SEATS}
                  onAct={act}
                  onOpenTarget={openTarget}
                  dispatchEnabled={dispatchEnabled}
                  chip={chips.get(detailItem.id) ?? null}
                  preview={chips.has(detailItem.id) ? previews.get(detailItem.id) ?? null : null}
                />
              )}
            </div>
          ) : loading ? (
            <div className={styles.loading} role="status" aria-label="Loading">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : unavailable ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Needs you isn't available on this server</p>
              <p className={styles.emptyBody}>This build does not report activity yet, so nothing here can be vouched for. Approvals still work from the inbox.</p>
            </div>
          ) : items.length === 0 ? (
            <EmptySplit coverageText={describeSilence(coverage)} vouched={coverage.vouched} autonomyLabel={data?.autonomy?.label ?? null} split={split} />
          ) : (
            <NeedsYouList
              ref={listRef}
              items={items}
              selectedId={selectedId}
              onSelect={setSelectedId}
              // A click (or a tap — a phone has no J / K) opens the item;
              // the keyboard moves the selection without opening.
              onOpen={(id) => {
                setSelectedId(id);
                setDetailId(id);
              }}
              now={now}
              label={`${SPLIT_LABEL[split]} needing you`}
              picked={picked}
              onTogglePick={togglePick}
              chips={chips}
            />
          )}
          {/* The list holds the initial focus; with no list, the panel does. */}
          {items.length === 0 && !detailItem ? <div ref={listRef} tabIndex={-1} className={styles.focusSink} aria-hidden="true" /> : null}
        </div>

        {!compact ? (
          <footer className={styles.foot} aria-hidden="true">
            <span><kbd className={styles.key}>J</kbd><kbd className={styles.key}>K</kbd> move</span>
            <span><kbd className={styles.key}><ReturnKeyIcon /></kbd> open</span>
            <span><kbd className={styles.key}>A</kbd> approve</span>
            <span><kbd className={styles.key}>R</kbd> reject</span>
            <span><kbd className={styles.key}>V</kbd> veto</span>
            <span><kbd className={styles.key}>E</kbd> done</span>
            <span><kbd className={styles.key}>X</kbd> pick</span>
            <span><kbd className={styles.key}>H</kbd><kbd className={styles.key}>L</kbd> splits</span>
          </footer>
        ) : null}
        {!coverage.vouched && items.length > 0 ? (
          <p className={styles.caveat} role="note">{describeSilence(coverage)} — this list may be incomplete.</p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function EmptySplit({ vouched, coverageText, autonomyLabel, split }: { vouched: boolean; coverageText: string; autonomyLabel: string | null; split: NeedsYouSplit }) {
  if (vouched) {
    return (
      <div className={styles.empty} data-state="clear">
        <span className={styles.clearMark} aria-hidden="true" />
        <p className={styles.emptyTitle}>All clear</p>
        <p className={styles.emptyBody}>{autonomyLabel ? `Fleet: ${autonomyLabel}.` : 'Nothing is waiting on you.'}</p>
      </div>
    );
  }
  return (
    <div className={styles.empty} data-state="unknown">
      <p className={styles.emptyTitle}>Nothing to show{split === 'all' ? '' : ` in ${SPLIT_LABEL[split]}`} — but it isn't an all-clear</p>
      <p className={styles.emptyBody}>{coverageText}.</p>
    </div>
  );
}

const TARGET_LABEL = (item: NeedsYouItem): string | null => {
  switch (item.target.kind) {
    case 'session':
      return 'Open chat';
    case 'section':
      return `Open ${sectionEntry(item.target.section).label}`;
    case 'seat':
      return 'Open Apps & Accounts';
    case 'url':
      return 'Open on GitHub';
    default:
      return null;
  }
};

const NO_SEATS: readonly VerseSeat[] = [];
const NO_PREVIEWS: ReadonlyMap<string, CloudPrPreview> = new Map();

/** Which actions the picks can run: every kind at least one pick has, with how many have it. */
function sharedActions(pickedItems: readonly NeedsYouItem[]): Array<{ kind: NeedsYouActionKind; label: string; destructive: boolean; count: number }> {
  const byKind = new Map<NeedsYouActionKind, { label: string; destructive: boolean; count: number }>();
  for (const item of pickedItems) {
    for (const action of item.actions) {
      if (!action.request) continue;
      const entry = byKind.get(action.kind);
      if (entry) entry.count += 1;
      else byKind.set(action.kind, { label: action.label, destructive: action.destructive, count: 1 });
    }
  }
  // Land first, Dismiss last.
  const order: NeedsYouActionKind[] = ['approve', 'fix', 'reject', 'veto', 'resume', 'renew', 'done'];
  return order.flatMap((kind) => {
    const entry = byKind.get(kind);
    return entry ? [{ kind, ...entry }] : [];
  });
}

/**
 * The strip over the list: what the picks can do (each button runs on the
 * picks that have that action), or — with nothing picked — "Land all clean".
 */
function BatchBar({
  pickedItems,
  landAll,
  dispatchEnabled,
  onRun,
  onClear,
}: {
  pickedItems: readonly NeedsYouItem[];
  landAll: readonly NeedsYouItem[];
  dispatchEnabled: boolean;
  onRun: (targets: readonly NeedsYouItem[], kind: NeedsYouActionKind) => void;
  onClear: () => void;
}) {
  if (pickedItems.length === 0) {
    return (
      <div className={styles.batch} role="toolbar" aria-label="Cloud pull requests">
        <span className={styles.batchCount}>
          {landAll.length} clean cloud {landAll.length === 1 ? 'PR' : 'PRs'}
        </span>
        <Button size="sm" variant="primary" disabled={!dispatchEnabled} onClick={() => onRun(landAll, 'approve')}>
          Land all clean
        </Button>
      </div>
    );
  }
  const actions = sharedActions(pickedItems);
  return (
    <div className={styles.batch} role="toolbar" aria-label="Picked items">
      <span className={styles.batchCount}>{pickedItems.length} picked</span>
      {actions.map((a) => {
        const key = NEEDS_YOU_ACTION_KEYS[a.kind];
        const partial = a.count < pickedItems.length;
        return (
          <Button
            key={a.kind}
            size="sm"
            variant={a.destructive ? 'danger' : a.kind === 'approve' ? 'primary' : 'subtle'}
            disabled={!dispatchEnabled}
            onClick={() => onRun(pickedItems, a.kind)}
            aria-keyshortcuts={key}
            title={partial ? `${a.count} of ${pickedItems.length} picked can do this` : undefined}
          >
            {a.label}{partial ? ` ${a.count}` : ''}
            {key ? <kbd className={styles.inlineKey} aria-hidden="true">{key}</kbd> : null}
          </Button>
        );
      })}
      <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
    </div>
  );
}

function ItemDetail({
  item,
  now,
  seats,
  onAct,
  onOpenTarget,
  dispatchEnabled,
  chip,
  preview,
}: {
  item: NeedsYouItem;
  now: number;
  /** The roster (bootstrap), for naming the item's seat and its run's model. */
  seats: readonly VerseSeat[];
  onAct: (item: NeedsYouItem, kind: NeedsYouActionKind) => void;
  onOpenTarget: (item: NeedsYouItem) => void;
  dispatchEnabled: boolean;
  /** A cloud PR's verdict and the checks behind it; null for everything else. */
  chip: TriageChip | null;
  preview: CloudPrPreview | null;
}) {
  const targetLabel = TARGET_LABEL(item);
  // The same readable text as the row (needs-you-model needsYouRowView), with room for the whole title.
  const view = needsYouRowView(item, now);
  // "Claude Max" and "Fable 5.1", never `claude-a` / `claude:claude-fable-5-1`
  // — the ids ride in tooltips (monospace only when the id is all we have).
  const seat = item.subject.seatId ? seatDisplayName(seats, item.subject.seatId) : null;
  const model = view.run ? runModelDisplayName(seats, view.run.model, item.subject.seatId) : null;
  return (
    <article className={styles.item}>
      <header className={styles.itemHead}>
        {view.kindLabel ? <p className={styles.rowKind}>{view.kindLabel}</p> : null}
        <h3 className={styles.itemTitle} title={view.fullTitle}>{view.title}</h3>
        {view.run ? <NeedsYouRunFacts run={view.run} /> : null}
      </header>
      {view.detail ? <p className={styles.itemDetail}>{view.detail}</p> : null}
      {chip && preview ? (
        <section className={styles.verdict} aria-label="Gate preview">
          <p className={styles.verdictHead}>
            <TriageChipView chip={{ ...chip, why: null }} />
            <span className={styles.mono} title={preview.headSha}>{preview.headSha.slice(0, 7)}</span>
          </p>
          <ul className={styles.checks}>
            {preview.checks.map((check) => (
              <li key={check.id} data-ok={check.ok ? 'true' : 'false'}>
                <span className={styles.checkMark} aria-hidden="true">{check.ok ? '✓' : '×'}</span>
                <span className="visually-hidden">{check.ok ? 'Passes: ' : 'Fails: '}</span>
                {check.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <dl className={styles.defs}>
        {view.repo ? (<><dt>Repo</dt><dd className={styles.repo} title={view.repoFull}>{view.repo}</dd></>) : null}
        {item.subject.pr ? (<><dt>Pull request</dt><dd>#{item.subject.pr}</dd></>) : null}
        {seat ? (<><dt>Seat</dt><dd className={seat.raw ? undefined : styles.mono} title={seat.raw}>{seat.text}</dd></>) : null}
        {model ? (<><dt>Model</dt><dd className={model.raw ? undefined : styles.mono} title={model.raw}>{model.text}</dd></>) : null}
        <dt>Raised</dt>
        <dd title={view.ageStamp}>{view.age}</dd>
        {item.expiresAt ? (<><dt>Closes</dt><dd className={styles.deadline}>{until(item.expiresAt, now)}</dd></>) : null}
      </dl>
      <div className={styles.itemActions}>
        {targetLabel ? (
          <Button variant="subtle" size="sm" onClick={() => onOpenTarget(item)} trailingIcon={item.target.kind === 'url' ? <IconExternalLink /> : undefined}>
            {targetLabel}
          </Button>
        ) : null}
        {item.actions.map((action) => {
          const key = NEEDS_YOU_ACTION_KEYS[action.kind];
          const needsDispatch = action.request !== null;
          return (
            <Button
              key={action.kind}
              size="sm"
              variant={action.destructive ? 'danger' : action.kind === 'approve' ? 'primary' : 'subtle'}
              disabled={needsDispatch && !dispatchEnabled}
              onClick={() => onAct(item, action.kind)}
              aria-keyshortcuts={key}
            >
              {action.label}
              {key ? <kbd className={styles.inlineKey} aria-hidden="true">{key}</kbd> : null}
            </Button>
          );
        })}
      </div>
      {!dispatchEnabled ? <p className={styles.caveat}>Read-only session — actions need `ashlr verse`.</p> : null}
    </article>
  );
}
