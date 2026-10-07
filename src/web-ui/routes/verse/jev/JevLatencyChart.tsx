/** Today's recorded call attempts; not a provider decode or quality benchmark. */
import type { JevKindStats } from '../../../../core/decide/types.js';
import { BarChart } from '../../../components/charts/BarChart.js';
import { ChartFrame, type ChartStatus } from '../../../components/charts/ChartFrame.js';
import { formatMetric } from '../../../components/charts/format-metric.js';
import { formatLatency } from './jev-model.js';
import styles from './jev.module.css';

export function JevLatencyChart({ byKind }: { byKind: readonly JevKindStats[] }) {
  // The wire response is narrowed upstream, but historical ledger values can
  // still be inconsistent. Do not turn absent timing or sample counts into 0.
  const rows = byKind.map((kind) => {
    const calls = Number.isSafeInteger(kind.calls) && kind.calls >= 0 ? kind.calls : null;
    const mean = calls !== null && calls > 0 && typeof kind.avgLatencyMs === 'number'
      && Number.isFinite(kind.avgLatencyMs) && kind.avgLatencyMs >= 0 ? kind.avgLatencyMs : null;
    const noCalls = calls === 0 && kind.avgLatencyMs === null;
    return { kind: kind.kind, calls, mean, noCalls };
  });
  const measured = rows.some((row) => row.mean !== null);
  const empty = rows.every((row) => row.noCalls);
  const status: ChartStatus = measured ? { kind: 'ready' }
    : empty ? { kind: 'empty', message: 'No Jev calls recorded today.' }
      : { kind: 'unknown', reason: 'recorded call counts or timing are unavailable or inconsistent.' };
  const table = (
    <table className={styles.kinds} aria-label="Jev response time today by decision kind">
      <thead><tr><th scope="col">Decision</th><th scope="col">Recorded calls</th><th scope="col">Mean response time</th></tr></thead>
      <tbody>{rows.map((row) => (
        <tr key={row.kind}>
          <th scope="row">{row.kind}</th>
          <td>{row.calls === null ? 'Unknown' : formatMetric(row.calls)}</td>
          <td>{row.noCalls ? 'No calls' : row.mean === null ? 'Not measured' : formatLatency(row.mean)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
  return (
    <ChartFrame
      title="Jev response time today"
      description="Mean decision wall time for recorded call attempts."
      caveat="Includes request and decision processing, not model decode speed. Cached decisions are excluded; batched questions count as one call. Missing timing stays unknown."
      status={status}
      table={table}
    >
      <BarChart
        orientation="horizontal"
        height={Math.max(80, rows.length * 34 + 10)}
        data={rows.map((row) => ({ label: `${row.kind} · ${row.calls === null ? 'unknown calls' : `${formatMetric(row.calls)} calls`}`, value: row.mean }))}
        formatValue={formatLatency}
        ariaLabel="Mean Jev decision wall time today by kind, with recorded call sample counts"
      />
    </ChartFrame>
  );
}
