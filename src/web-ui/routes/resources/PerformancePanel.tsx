import { useState } from 'react';
import type { ResourcePerformanceReport, ResourcePerformanceStatus, ResourceUsageScope } from '../../../core/resources/performance.js';
import { resourceNumber } from './CapacityBoard.js';
import styles from './ResourcePoolView.module.css';

export function executionTime(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Not measured' : value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}
export function usageScopeLabel(value: ResourceUsageScope | null | undefined): string {
  return value === 'codex-turn' ? 'Codex turn' : value === 'claude-main-loop' ? 'Claude main loop (excludes subagents)'
    : value === 'local-chat-completion' ? 'Local chat completion' : 'Scope not recorded';
}
export function PerformancePanel({ report, onSelect }: { report: ResourcePerformanceReport | null | undefined; onSelect: (id: string) => void }) {
  const [status, setStatus] = useState<ResourcePerformanceStatus>('completed');
  return <section className={styles.board} aria-labelledby="performance-title">
    <div className={styles.sectionHeading}><div><h2 id="performance-title">Worker performance</h2>
      <p>Recorded execution, separated by outcome. These tasks are not a matched benchmark.</p></div>
      {report ? <label className={styles.filter}>Execution outcome<select aria-label="Performance outcome" value={status}
        onChange={(event) => setStatus(event.target.value as ResourcePerformanceStatus)}>
        <option value="completed">Completed</option><option value="failed">Failed</option><option value="timed-out">Timed out</option>
        <option value="cancelled">Cancelled</option><option value="uncertain">Uncertain</option>
      </select></label> : null}</div>
    {!report ? <p className={styles.boardNote}>Performance evidence is unavailable in this snapshot. No duration or quality is inferred from older receipts.</p>
      : <><div className={styles.performanceScroll} tabIndex={0} role="region" aria-label="Worker performance measurements">
        <table className={styles.performanceTable}>
          <caption>{resourceNumber(report.attempts)} durable attempts across all retained history. Token coverage includes every outcome.</caption>
          <thead><tr><th scope="col">Worker</th><th scope="col">{status} samples</th><th scope="col">Execution p50</th><th scope="col">Execution p95</th><th scope="col">Reported tokens</th></tr></thead>
          <tbody>{report.workers.map((row) => {
            const duration = row.durations.find((value) => value.status === status);
            return <tr key={row.workerId}>
              <th scope="row"><button type="button" className={styles.performanceWorker} onClick={() => onSelect(row.workerId)}>{row.workerId}</button>
                <small>{row.model}</small><small>{row.counts.completed} completed / {row.counts.total} attempts</small></th>
              <td>{duration?.samples ?? 0} / {duration?.attempts ?? 0}<small>{duration?.unknownAttempts ?? 0} unmeasured</small></td>
              <td>{executionTime(duration?.p50Ms)}</td><td>{executionTime(duration?.p95Ms)}</td>
              <td>{resourceNumber(row.usage.reportedInputTokens)} in / {resourceNumber(row.usage.reportedOutputTokens)} out
                <small>{row.usage.reportedAttempts} reported / {row.usage.unknownAttempts} unknown</small>
                {row.usage.scopes.map((entry) => <small key={entry.scope ?? 'unknown'}>{usageScopeLabel(entry.scope)}: {entry.reportedAttempts} reported</small>)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div><p className={styles.boardNote}>Execution includes adapter preparation and cleanup, but excludes the queue and ledger settlement. p50/p95 use measured samples only; they are not provider latency. Token counters cover their named scope, not billing or all agent activity. Quality and accepted engineering yield remain unmeasured.</p></>}
  </section>;
}
