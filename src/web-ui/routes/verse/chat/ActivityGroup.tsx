/**
 * routes/verse/chat/ActivityGroup.tsx — a run of tool calls as ONE row
 * (SPEC-310C §2, unit C2):
 *
 *   ▸ Ran 12 commands · read 8 files · edited 3 files · 1 failed, 1 running · 2m 14s
 *
 * Three views, not two, because "folded" and "everything" both fail the
 * common case:
 *
 *   collapsed  the line alone — a clean, finished run is one line of prose;
 *   focus      the line plus ONLY the rows that matter right now — the calls
 *              that failed and the ones still running (each with a live
 *              timer) — and "Show 11 more" for the rest;
 *   all        every member.
 *
 * Until the operator clicks, the view follows the run: it opens on focus the
 * moment a call fails or while one runs, and folds itself when the run
 * finishes clean. Once they click, their choice wins for the life of the row.
 *
 * Failure is said in words and with the left rule, never by colour alone
 * (DESIGN §6). The line is a real button with aria-expanded, so the whole
 * disclosure works from the keyboard and reads as one sentence.
 */
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { ToolGroupItem, ToolGroupMember } from '../verse-store.js';
import { formatDuration } from '../verse-model.js';
import { defaultActivityView, focusMembers, summarizeActivity, type ActivityView } from './activity-model.js';
import { LiveTimer } from './LiveTimer.js';
import { toolAnchorId, type ToolFacts } from './tool-semantics.js';
import styles from './ActivityGroup.module.css';

// ---------------------------------------------------------------------------
// Reveal: a jump to a call folded inside a group
// ---------------------------------------------------------------------------
//
// The file-activity rows and "jump to the first failure" scroll to a tool
// call's DOM anchor. A folded group does not render its members (a long
// session would otherwise carry thousands of hidden cards), so the anchor
// does not exist until the group opens. The transcript asks here first; the
// group that holds the call opens itself to "all", and the transcript retries
// the scroll on the next frame.

const revealListeners = new Set<(anchorId: string) => boolean>();

/** Ask every mounted group to open if it holds `anchorId`. True when one did. */
export function revealAnchorInGroups(anchorId: string): boolean {
  let claimed = false;
  for (const listener of [...revealListeners]) if (listener(anchorId)) claimed = true;
  return claimed;
}

export interface ActivityGroupProps {
  item: ToolGroupItem;
  facts: ReadonlyMap<string, ToolFacts>;
  /** Renders one member (a tool card or a reasoning block) — the transcript owns those components and their memoization. */
  renderMember: (member: ToolGroupMember) => ReactNode;
}

export function ActivityGroupView({ item, facts, renderMember }: ActivityGroupProps) {
  const summary = useMemo(() => summarizeActivity(item, facts), [item, facts]);
  const [chosen, setChosen] = useState<ActivityView | null>(null);
  const view: ActivityView = chosen ?? defaultActivityView(summary);
  const bodyId = useId();

  const focus = useMemo(() => focusMembers(item, facts), [item, facts]);
  // "focus" with nothing left to focus on (the run finished clean) folds.
  const effective: ActivityView = view === 'focus' && focus.shown.length === 0 ? 'collapsed' : view;
  const members = effective === 'all' ? item.items : effective === 'focus' ? focus.shown : [];

  function toggle() {
    setChosen(effective === 'collapsed' ? (focus.shown.length > 0 ? 'focus' : 'all') : 'collapsed');
  }

  useEffect(() => {
    const listener = (anchorId: string) => {
      const holds = item.items.some((m) => m.kind === 'tool' && toolAnchorId(m.toolUseId) === anchorId);
      if (holds) setChosen('all');
      return holds;
    };
    revealListeners.add(listener);
    return () => { revealListeners.delete(listener); };
  }, [item]);

  const running = summary.running > 0;
  const firstAt = item.items[0]?.at ?? null;
  const spoken = summary.sentence || `${summary.toolCount} tool calls`;

  return (
    <div className={styles.group} data-view={effective} data-failed={summary.failed > 0 || undefined}
      data-running={running || undefined} data-state-key={`activity:${item.key}`}>
      <button type="button" className={styles.line} aria-expanded={effective !== 'collapsed'}
        aria-controls={bodyId} aria-label={spoken} onClick={toggle}>
        <span className={styles.chevron} aria-hidden="true" />
        <span className={styles.work} aria-hidden="true">{summary.work || `${summary.toolCount} tool calls`}</span>
        {summary.state ? (
          <span className={styles.state} aria-hidden="true">
            {summary.failed > 0 ? <span className={styles.failed}>{summary.failed} failed</span> : null}
            {summary.failed > 0 && running ? <span className={styles.sep}>, </span> : null}
            {running ? <span className={styles.running}><span className={styles.pulse} />{summary.running} running</span> : null}
          </span>
        ) : null}
        <span className={styles.time} aria-hidden="true">
          {running
            ? <LiveTimer since={firstAt} />
            : summary.spanMs !== null ? formatDuration(summary.spanMs) : null}
        </span>
      </button>
      <div id={bodyId} className={styles.body} hidden={effective === 'collapsed'}>
        {effective === 'collapsed' ? null : (
          <>
            <ol className={styles.list}>
              {members.map((member) => (
                <li key={member.key} data-member={member.kind}>{renderMember(member)}</li>
              ))}
            </ol>
            {effective === 'focus' && focus.hidden > 0 ? (
              <button type="button" className={styles.more} onClick={() => setChosen('all')}>
                Show {focus.hidden} more
              </button>
            ) : null}
            {effective === 'all' && focus.shown.length > 0 && focus.hidden > 0 ? (
              <button type="button" className={styles.more} onClick={() => setChosen('focus')}>
                Show only {summary.failed > 0 ? 'failures' : 'running'}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Memoized on identity; the transcript wraps ActivityGroupView with a content comparator instead. */
export const ActivityGroup = memo(ActivityGroupView);
