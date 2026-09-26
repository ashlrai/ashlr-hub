/**
 * routes/verse/shell/NeedsYouList.tsx — the rows of the Needs-you drawer
 * (unit C1). A listbox with ONE tab stop and aria-activedescendant, so J / K
 * move the selection without moving focus (and without the page scrolling
 * under the drawer). Presentational: selection and keys belong to the drawer.
 *
 * Each row says what, where, and how urgent — severity is a word AND a colour
 * (never colour alone), and an item with a deadline shows it counting down.
 *
 * Rows print needsYouRowView, not the wire text: "patch: claude run: Advance
 * goal "… so a deg" becomes a "Patch · Claude run" label over a title that
 * ends on a whole word (two lines at most; the server's text is the tooltip),
 * a run summary becomes "2 files · +384 −0 · Test-and-repair loop", and an age
 * is "38 days ago" with the exact local time on hover.
 *
 * Triage (3.13): a cloud PR's row carries its gate verdict as a chip ("Clean",
 * or "Held · 2 commits behind"), and rows can be picked for a batch — X on
 * the selected row or Shift-click — which the drawer then acts on with
 * A / R / E. Picking never moves the cursor and never opens the item.
 */
import { forwardRef, useEffect, useRef } from 'react';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { NEEDS_YOU_ACTION_KEYS } from '../../../../core/verse/workbench-types.js';
import type { TriageChip } from './cloud-triage.js';
import { needsYouRowView, until, type NeedsYouRunView } from './needs-you-model.js';
import styles from './NeedsYouDrawer.module.css';

/**
 * "2 files · +384 −0 · Test-and-repair loop". The stats are drawn for the eye
 * and spoken as a sentence; the source's meaning (what TITRR did) is its
 * tooltip. Shared with the drawer's item detail.
 */
export function NeedsYouRunFacts({ run }: { run: NeedsYouRunView }) {
  return (
    <span className={styles.runFacts}>
      <span className={styles.diffStats} aria-hidden="true">{run.stats}</span>
      <span className="visually-hidden">{run.statsSpoken}</span>
      <span aria-hidden="true">·</span>
      <span className={styles.runSource} title={run.sourceHint ?? undefined}>
        {run.partial ? 'Partial · ' : ''}{run.source}
      </span>
    </span>
  );
}

const SEVERITY_WORD: Readonly<Record<NeedsYouItem['severity'], string>> = { high: 'Urgent', warn: 'Soon', info: 'When you can' };

const SOURCE_WORD: Readonly<Record<NeedsYouItem['source'], string>> = {
  approvals: 'Approval',
  authority: 'Autonomy',
  fleet: 'Fleet',
  leader: 'Leader',
  chats: 'Chat',
  accounts: 'Account',
};

export interface NeedsYouListProps {
  items: readonly NeedsYouItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  now: number;
  label: string;
  /** Rows picked for a batch action. */
  picked?: ReadonlySet<string>;
  /** Shift-click: pick or unpick a row. */
  onTogglePick?: (id: string) => void;
  /** Cloud PR verdicts by item id. */
  chips?: ReadonlyMap<string, TriageChip>;
}

const NO_PICKS: ReadonlySet<string> = new Set();
const NO_CHIPS: ReadonlyMap<string, TriageChip> = new Map();

/** "Clean" / "Held · 2 commits behind" — tone is a word as well as a colour. */
export function TriageChipView({ chip }: { chip: TriageChip }) {
  return (
    <span className={styles.chip} data-tone={chip.tone} title={chip.title}>
      {chip.label}
      {chip.why ? <span className={styles.chipWhy}> · {chip.why}</span> : null}
    </span>
  );
}

export const NeedsYouList = forwardRef<HTMLDivElement, NeedsYouListProps>(function NeedsYouList(
  { items, selectedId, onSelect, onOpen, now, label, picked = NO_PICKS, onTogglePick, chips = NO_CHIPS },
  ref,
) {
  const listId = 'verse-needs-you-list';
  const rowsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    // Matched by dataset, not a selector: ids come from other units' producers.
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>('[data-item-id]') ?? [];
    const row = [...rows].find((el) => el.dataset['itemId'] === selectedId);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div
      ref={(node) => {
        rowsRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      id={listId}
      role="listbox"
      aria-label={picked.size > 0 ? `${label}, ${picked.size} picked` : label}
      tabIndex={0}
      aria-activedescendant={selectedId ? `${listId}-${items.findIndex((i) => i.id === selectedId)}` : undefined}
      className={styles.rows}
    >
      {items.map((item, index) => {
        const keyed = item.actions
          .map((a) => NEEDS_YOU_ACTION_KEYS[a.kind])
          .filter((k): k is 'A' | 'R' | 'V' | 'E' => k !== undefined);
        const view = needsYouRowView(item, now);
        const isPicked = picked.has(item.id);
        const chip = chips.get(item.id);
        return (
          <div
            key={item.id}
            id={`${listId}-${index}`}
            data-item-id={item.id}
            role="option"
            aria-selected={item.id === selectedId}
            data-picked={isPicked ? 'true' : undefined}
            className={styles.row}
            data-severity={item.severity}
            onClick={(event) => {
              if (event.shiftKey && onTogglePick) {
                event.preventDefault();
                onTogglePick(item.id);
                return;
              }
              onOpen(item.id);
            }}
            onMouseMove={() => item.id !== selectedId && onSelect(item.id)}
          >
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.rowMain}>
              {view.kindLabel ? <span className={styles.rowKind}>{view.kindLabel}</span> : null}
              {/* Two lines at most, ending on a whole word; the server's title is the tooltip. */}
              <span className={styles.rowTitle} title={view.fullTitle}>{view.title}</span>
              {view.run ? <NeedsYouRunFacts run={view.run} /> : null}
              <span className={styles.rowMeta}>
                {isPicked ? <span className="visually-hidden">Picked. </span> : null}
                {chip ? <TriageChipView chip={chip} /> : null}
                <span className={styles.severity} data-severity={item.severity}>{SEVERITY_WORD[item.severity]}</span>
                <span>{SOURCE_WORD[item.source]}</span>
                {view.repo ? <span className={styles.repo} title={view.repoFull}>{view.repo}</span> : null}
                {item.subject.pr ? <span>#{item.subject.pr}</span> : null}
                <span title={view.ageStamp}>{view.age}</span>
                {item.expiresAt ? <span className={styles.deadline}>closes {until(item.expiresAt, now)}</span> : null}
              </span>
            </span>
            {isPicked ? <span className={styles.pickMark} aria-hidden="true">✓</span> : item.id === selectedId && keyed.length > 0 ? (
              <span className={styles.rowKeys} aria-hidden="true">
                {keyed.map((k) => (
                  <kbd key={k} className={styles.key}>{k}</kbd>
                ))}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
