/**
 * routes/verse/chat/TasksTray.tsx — "◌ 3 running tasks", beside the live
 * status line above the composer (SPEC-310C §2, unit C2).
 *
 * The count is this turn's running tool calls and subagents PLUS every
 * other chat with a turn in flight (tasks-model.ts): the operator is waiting
 * on all of them, and until 3.10 the others were only visible by scrolling
 * the sidebar. One click opens the dock's Tasks pane, which lists them and
 * jumps to each. Nothing renders when nothing runs.
 */
import { describeTaskCounts, type TaskCounts } from './tasks-model.js';
import styles from './TasksTray.module.css';

export interface TasksTrayProps {
  counts: TaskCounts;
  onOpen: () => void;
  /** The Tasks pane is the dock's visible pane right now. */
  active?: boolean;
}

export function TasksTray({ counts, onOpen, active = false }: TasksTrayProps) {
  if (counts.total === 0) return null;
  return (
    <button type="button" className={styles.tray} onClick={onOpen} aria-pressed={active}
      aria-label={`${describeTaskCounts(counts)}. Open the Tasks pane.`} title="Open the Tasks pane">
      <span className={styles.ring} aria-hidden="true" />
      <span className={styles.count}>{counts.total}</span>
      <span className={styles.word}>running task{counts.total === 1 ? '' : 's'}</span>
    </button>
  );
}
