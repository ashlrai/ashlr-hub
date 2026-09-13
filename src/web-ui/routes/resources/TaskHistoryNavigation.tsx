import type { useResourceTaskHistory } from '../../data/use-resource-task-history.js';

/** Counts are console-wide, including when the surrounding rail filters a project. */
export function TaskHistoryNavigation({ history, disabled, buttonClassName, className }: {
  history: ReturnType<typeof useResourceTaskHistory>; disabled: boolean; buttonClassName?: string; className?: string;
}) {
  if (!history.window) return null;
  return <div aria-label="Task history navigation" className={className}>
    <p>Console history: {history.window.totalJobs} tasks. {history.window.omittedJobs} older tasks omitted from the live window.</p>
    {history.page ? <>
      <p>History page: {history.page.items.length} tasks from {history.page.totalJobs} recorded tasks across all projects. Active and recent tasks remain shown.</p>
      <button type="button" className={buttonClassName} disabled={disabled || history.loading || !history.page.nextBefore}
        onClick={() => { void history.load(true); }}>Older tasks</button>
      <button type="button" className={buttonClassName} onClick={history.latest}>Latest tasks</button>
    </> : history.window.omittedJobs > 0 ? <button type="button" className={buttonClassName} disabled={disabled || history.loading}
      onClick={() => { void history.load(); }}>Browse task history</button> : null}
    {history.loading ? <p role="status">Loading task history…</p> : null}
    {history.error ? <p role="alert">{history.error}</p> : null}
  </div>;
}
