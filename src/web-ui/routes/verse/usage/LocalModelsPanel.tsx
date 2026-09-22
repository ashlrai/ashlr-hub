/**
 * routes/verse/usage/LocalModelsPanel.tsx — local availability as a
 * first-class capacity surface, not a list of installed files.
 *
 * A local seat has no subscription and no quota, so the honest analogue of a
 * meter is RESIDENT BYTES AGAINST THE MACHINE'S MEMORY BUDGET: that is what
 * decides whether a model can answer right now. Around it sit the facts the
 * old surface fetched and discarded (docs/VERSE-TELEMETRY-V2.md):
 *
 *   - resident vs installed, as counts AND as a memory chart, because "12
 *     models installed" and "nothing loaded" are compatible and only one of
 *     them is about capacity;
 *   - the GPU/CPU split from `size_vram` / `placement`, drawn as a two-segment
 *     bar: a model that half-spilled to the CPU is usable but slow, and that
 *     is a fact to see before picking the seat, not mid-turn;
 *   - the keep-alive countdown from `expires_at`, which ticks;
 *   - and the hard gate: whether the model advertises `tools`. A model without
 *     it CANNOT drive an agentic session at any speed, so it is marked in the
 *     row, counted in the summary, and filterable — not buried in a column.
 *
 * `capabilities: null` is rendered as unknown, never as "no tools": refusing
 * to answer and answering "no" are different facts.
 *
 * STALENESS (V2.1): when a runtime probe times out the server serves the last
 * known-good report with `stale: true` and `staleForMs`. That is the right
 * call — a timeout is "no answer yet", not "the runtime is gone" — but it
 * obliges this panel to say the numbers are N seconds old, in words, above
 * everything they describe.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import {
  BarChart,
  ChartContainer,
  TableView,
  chartFormat,
  seriesColor,
  type TableColumn,
} from '../../../components/charts/index.js';
import type { ServingRuntimeSnapshot } from '../autonomy/fleet-contract.js';
import { runtimeCapacity } from '../autonomy/fleet-model.js';
import type { AccountVerdictState, LocalCardModel } from './accounts-model.js';
import {
  formatAge,
  formatBytes,
  formatContext,
  formatCountdown,
  localStaleness,
  type LocalModelRow,
  type LocalModelsView,
  type LocalStaleness,
} from './local-model.js';
import { unknownQuality } from './usage-model.js';
import styles from './usage.module.css';

const VERDICT_TONE: Record<AccountVerdictState, Tone> = {
  available: 'success',
  credits: 'success',
  tight: 'warning',
  exhausted: 'danger',
  'signed-out': 'warning',
  'probe-unsupported': 'warning',
  unknown: 'unknown',
};

const GPU_COLOR = seriesColor(0);
const CPU_COLOR = seriesColor(5);

/**
 * A keep-alive countdown that does not tick is worse than no countdown, so
 * this re-renders while (and only while) something is actually expiring.
 * 5s is slow enough to be invisible work and fast enough that the number on
 * screen is never meaningfully wrong.
 */
function useNow(active: boolean, intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * The keep-alive countdown, derived from the expiry INSTANT against a live
 * clock. The row's `expiresInMs` was computed when `buildLocalModelsView` ran
 * and is frozen inside that memo, so rendering it would show the same number
 * until the local-models payload itself changed — a stopped clock with a
 * second hand painted on.
 */
function KeepAliveCell({ row }: { row: LocalModelRow }): ReactNode {
  const at = row.resident ? row.expiresAtMs : null;
  const now = useNow(at !== null);
  if (at === null) return '—';
  return formatCountdown(at - now);
}

/**
 * The agentic gate, rendered so it cannot be skimmed past: a danger-toned
 * badge with the words "no tools", not a quiet cell. The unknown case gets the
 * shared Epistemic treatment instead, because the runtime declining to answer
 * is not the model saying no.
 */
function ToolsCell({ row }: { row: LocalModelRow }): ReactNode {
  if (row.tools === 'unknown') {
    return (
      <Epistemic
        quality={unknownQuality('The runtime did not report a capability list for this model.')}
        label={`${row.name} tool support`}
      >
        {null}
      </Epistemic>
    );
  }
  return row.tools === 'supported' ? (
    <StatusBadge status="agentic" tone="success">
      tools
    </StatusBadge>
  ) : (
    <StatusBadge status="no-tools" tone="danger">
      no tools
    </StatusBadge>
  );
}

/**
 * `sizeBytes` is NOT a residency figure for an unloaded model: core's
 * `local-models.ts` sets it to `live?.sizeBytes ?? tag.sizeBytes`, and
 * `tag.sizeBytes` is the ON-DISK size from `/api/tags`. Under this column's
 * old "Resident size" header, a machine with nothing resident and twelve
 * installed models showed a multi-GB figure on every row — tens of gigabytes
 * that read as memory in use when the true resident total was zero, which is
 * the exact "can I run this now" question this panel exists to answer. The
 * header is now "Size" and the State column carries residency; the tooltip
 * says which figure this is for this row.
 */
function SizeCell({ row }: { row: LocalModelRow }): ReactNode {
  if (row.sizeBytes === null) return <span>—</span>;
  const provenance = row.resident
    ? 'Resident size reported by the runtime.'
    : 'On-disk size; this model is not resident, so it is using no memory.';
  return (
    <span title={provenance}>
      {formatBytes(row.sizeBytes)}
      {row.resident && row.memoryPct !== null ? ` · ${Math.round(row.memoryPct)}% of machine` : ''}
    </span>
  );
}

/**
 * The GPU/CPU split as a two-segment bar.
 *
 * Only a RESIDENT model has a placement — an installed one is on disk and
 * occupies neither. An unreported split draws nothing rather than assuming
 * "all GPU", which is the flattering guess and the wrong one.
 */
function PlacementCell({ row }: { row: LocalModelRow }): ReactNode {
  if (!row.resident) return <span className={styles.capacityMuted}>not resident</span>;
  if (row.gpuPct === null) {
    return (
      <Epistemic
        quality={unknownQuality('The runtime reported no VRAM split for this resident model.')}
        label={`${row.name} placement`}
      >
        {null}
      </Epistemic>
    );
  }
  const gpu = Math.round(row.gpuPct);
  return (
    <span className={styles.placement}>
      <span
        className={styles.placementBar}
        role="img"
        aria-label={`${row.name}: ${gpu}% of resident bytes on GPU, ${100 - gpu}% on CPU`}
      >
        <span
          className={styles.placementGpu}
          style={{ width: `${gpu}%`, '--split-color': GPU_COLOR } as CSSProperties}
        />
        <span
          className={styles.placementCpu}
          style={{ width: `${100 - gpu}%`, '--split-color': CPU_COLOR } as CSSProperties}
        />
      </span>
      <span className={styles.placementText}>
        {row.placement === 'unknown' ? `${gpu}% GPU` : `${row.placement} · ${gpu}% GPU`}
      </span>
    </span>
  );
}

function ContextCell({ row }: { row: LocalModelRow }): ReactNode {
  if (row.nativeContext === null && row.configuredContext === null) return <span>—</span>;
  if (!row.contextTruncated) return <span>{formatContext(row.nativeContext ?? row.configuredContext)}</span>;
  return (
    <span title={`Native context is ${formatContext(row.nativeContext)}; Ashlr runs this seat at ${formatContext(row.configuredContext)}.`}>
      {`${formatContext(row.configuredContext)} of ${formatContext(row.nativeContext)}`}
    </span>
  );
}

const COLUMNS: TableColumn<LocalModelRow>[] = [
  { key: 'name', label: 'Model', render: (r) => r.name },
  {
    key: 'state',
    label: 'State',
    render: (r) =>
      r.resident ? (
        <StatusBadge status="resident" tone="success">
          resident
        </StatusBadge>
      ) : (
        <StatusBadge status="installed" tone="neutral">
          installed
        </StatusBadge>
      ),
  },
  { key: 'tools', label: 'Agentic', render: (r) => <ToolsCell row={r} /> },
  { key: 'size', label: 'Size', numeric: true, render: (r) => <SizeCell row={r} /> },
  { key: 'placement', label: 'Placement', render: (r) => <PlacementCell row={r} /> },
  { key: 'params', label: 'Params', numeric: true, render: (r) => r.parameterSize ?? '—' },
  { key: 'quant', label: 'Quant', render: (r) => r.quantization ?? '—' },
  { key: 'context', label: 'Context', numeric: true, render: (r) => <ContextCell row={r} /> },
  { key: 'keepalive', label: 'Keep-alive', numeric: true, render: (r) => <KeepAliveCell row={r} /> },
];

/**
 * The staleness sentence. It says the age in words, names the runtimes, and
 * states outright that this is the last KNOWN-GOOD reading rather than a fresh
 * one — which is the difference between a number an operator can act on and
 * one that quietly misleads.
 */
export function StaleNotice({ staleness }: { staleness: LocalStaleness }): ReactNode {
  if (!staleness.stale) return null;
  return (
    <p className={styles.staleNotice} role="status">
      <span className={styles.staleFlag}>last known-good</span> Every local figure below is the last
      known-good reading from {formatAge(staleness.staleForMs)} ago
      {staleness.runtimes.length > 0 ? ` (${staleness.runtimes.join(', ')})` : ''}, not a fresh
      probe: the runtime did not answer in time and the server kept the previous report rather than
      erasing it.
    </p>
  );
}

export function LocalCard({
  card,
  staleness,
}: {
  card: LocalCardModel;
  staleness?: LocalStaleness | undefined;
}): ReactNode {
  const engineStyle = { '--engine-color': card.color } as CSSProperties;
  const pct = card.usedPct === null ? null : Math.round(card.usedPct);

  return (
    <article className={styles.card} style={engineStyle} aria-label="Local usage">
      <div className={styles.cardHead}>
        <span className={styles.cardLabel}>Local</span>
        <StatusBadge status={card.verdict.state} tone={VERDICT_TONE[card.verdict.state]}>
          {card.verdict.headline}
        </StatusBadge>
      </div>

      <div className={styles.cardMeta}>
        <span>Ollama</span>
        <span aria-hidden="true">·</span>
        <span>no subscription, no quota, no bill</span>
      </div>

      {staleness?.stale ? <StaleNotice staleness={staleness} /> : null}

      <p className={styles.verdictDetail}>{card.verdict.detail}</p>
      {card.verdict.code ? (
        /* The runtime's verbatim probe code, kept as evidence beside the
           sentence rather than standing in for it — same treatment an account
           card gives a collector code. */
        <p className={styles.sourceLine}>
          Probe reason <code className={styles.commandInline}>{card.verdict.code}</code>
        </p>
      ) : null}

      <span className={styles.bindingLabel}>Memory budget</span>
      {pct === null ? (
        <div className={styles.windowBlockLead}>
          <div className={styles.windowHead}>
            <span>Resident against machine memory</span>
            <Epistemic
              quality={unknownQuality(
                'Either the resident size or the machine memory budget was not reported, so no share can be computed.',
              )}
              label="local memory budget"
            >
              {null}
            </Epistemic>
          </div>
          <hr className={styles.unknownRule} aria-hidden="true" />
        </div>
      ) : (
        <div className={styles.windowBlockLead}>
          <div className={styles.windowHead}>
            <span>Resident against machine memory</span>
            <span className={styles.windowPct}>{pct}%</span>
          </div>
          <div
            className={styles.track}
            data-tone={card.tone}
            role="meter"
            aria-label="Local resident models against machine memory budget"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={`${formatBytes(card.residentBytes)} of ${formatBytes(card.memoryBudgetBytes)} resident`}
          >
            <div className={styles.fill} style={{ width: `${pct}%` }} />
          </div>
          <p className={styles.windowReset}>
            {formatBytes(card.residentBytes)} of {formatBytes(card.memoryBudgetBytes)}
          </p>
        </div>
      )}

      <p className={styles.sourceLine}>
        {card.residentCount} resident · {card.installedCount} installed
      </p>
    </article>
  );
}

/**
 * The concurrency note.
 *
 * Residency and concurrency are different questions, and this panel answers
 * only the first. A model can be resident, fit entirely in VRAM, advertise
 * tools — and still be servable to exactly one agent at a time, because that
 * is a property of the RUNTIME, not the model. Measured on this machine
 * (docs/LOCAL-FLEET.md), four concurrent Qwen3.8 requests to Ollama returned
 * staggered four seconds apart while the same weights on llama-server returned
 * together.
 *
 * So the panel states the boundary rather than letting a full "Resident now"
 * tile imply a fleet. When the caller hands it the serving runtime it prints
 * the real figure; when it does not, it says where the answer lives instead of
 * quoting a number it has no source for.
 */
function ConcurrencyNote({ serving }: { serving: ServingRuntimeSnapshot | null | undefined }): ReactNode {
  if (serving === undefined) {
    return (
      <p className={styles.sourceLine}>
        Residency is not concurrency. How many local agents can run at once is decided by the serving
        runtime, not by these models — a resident model can still be served to one agent at a time.
        The serving runtime and its real slot count are in Autonomy.
      </p>
    );
  }
  const capacity = runtimeCapacity(serving);
  return (
    <p className={styles.sourceLine}>
      <strong>{capacity.headline}.</strong> {capacity.detail}
    </p>
  );
}

export function LocalModelsPanel({
  view,
  serving,
}: {
  view: LocalModelsView | null;
  /**
   * The serving runtime, when the host has it. `undefined` means this caller
   * does not supply one — which is rendered as "the answer is in Autonomy",
   * never as a concurrency of zero or one.
   */
  serving?: ServingRuntimeSnapshot | null;
}): ReactNode {
  const [agenticOnly, setAgenticOnly] = useState(false);
  // The keep-alive countdown subscribes to the clock in its own cell
  // (`KeepAliveCell`), where the value is actually derived — re-rendering the
  // whole panel around a frozen number achieved nothing.

  const staleness = useMemo(() => localStaleness(view?.runtimes ?? []), [view]);

  // The filter hides models that CANNOT drive a session. It deliberately keeps
  // the `unknown` ones: hiding a model because its runtime declined to answer
  // would turn an unanswered question into a verdict.
  const rows = useMemo(
    () => (agenticOnly ? (view?.rows ?? []).filter((r) => r.tools !== 'unsupported') : (view?.rows ?? [])),
    [view, agenticOnly],
  );

  const residentRows = useMemo(() => rows.filter((r) => r.resident && r.sizeBytes !== null), [rows]);

  return (
    <section className={styles.panel} aria-labelledby="verse-usage-local">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-local" className={styles.panelTitle}>
          Local availability
        </h3>
        <p className={styles.panelNote}>
          Resident models answer immediately. A model without tool support cannot drive an agentic
          session at all, however much memory is free.
        </p>
      </div>

      <ConcurrencyNote serving={serving} />

      <StaleNotice staleness={staleness} />

      {view === null ? (
        <p className={styles.muted}>
          No local-model source answered, so neither resident nor installed models can be listed. This
          is a missing source, not an empty machine.
        </p>
      ) : !view.reachable ? (
        /* `view.reason` is a machine code, not a sentence. It is shown as
           evidence after the sentence rather than being the whole panel. */
        <p className={styles.muted}>
          No local runtime answered this probe, so nothing about local models can be read. That is an
          unanswered probe, not a report that no models are installed.
          {view.reason ? (
            <>
              {' '}
              Probe reason <code className={styles.commandInline}>{view.reason}</code>.
            </>
          ) : null}
        </p>
      ) : view.rows.length === 0 ? (
        <p className={styles.muted}>
          The local runtime answered and reports no installed models. Pull one to give Ashlr a local
          seat.
        </p>
      ) : (
        <>
          <div className={styles.tiles}>
            <StatFigure
              label="Resident now"
              value={String(view.rows.filter((r) => r.resident).length)}
              caption={
                view.residentBytes === null
                  ? 'At least one resident model reported no size, so the total is withheld rather than understated.'
                  : `${formatBytes(view.residentBytes)} in memory`
              }
            />
            <StatFigure
              label="Installed"
              value={String(view.rows.length)}
              caption="On disk; the first turn on one of these pays a load"
            />
            <StatFigure
              label="Can drive a session"
              value={String(view.agenticCount)}
              caption={
                view.unknownToolCount > 0
                  ? `${view.nonAgenticCount} cannot; ${view.unknownToolCount} did not report a capability list`
                  : `${view.nonAgenticCount} cannot drive one`
              }
            />
            <StatFigure
              label="Machine memory"
              value={
                view.memoryBudgetBytes === null ? 'unknown' : formatBytes(view.memoryBudgetBytes)
              }
              caption={
                view.freeMemoryBytes === null
                  ? 'The machine reported no free-memory figure.'
                  : `${formatBytes(view.freeMemoryBytes)} reported free by the OS`
              }
            />
          </div>

          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={agenticOnly}
              onClick={() => setAgenticOnly((v) => !v)}
            >
              Hide models that cannot drive a session
            </button>
            {view.nonAgenticCount > 0 ? (
              <span className={styles.capacityMuted}>
                {view.nonAgenticCount} of {view.rows.length} installed models cannot drive an agentic
                session.
              </span>
            ) : null}
          </div>

          <div className={styles.tableScroll}>
            <TableView
              caption="Local models: residency, tool support, size, placement, parameters, quantization, context and keep-alive"
              columns={COLUMNS}
              rows={rows}
              rowKey={(r) => `${r.runtime ?? 'runtime'}:${r.name}`}
            />
          </div>

          <div className={styles.charts}>
            <ChartContainer
              title="Resident memory by model"
              description="What is actually in memory right now"
              caveat="Only models the runtime reports as resident WITH a size appear here. An installed model occupies no memory and is not a bar at zero."
              empty={residentRows.length === 0}
              emptyMessage="Nothing is resident, so there is no memory in use to chart. That is an idle machine, not a zero reading."
              table={
                <TableView
                  caption="Resident size per model"
                  columns={[
                    { key: 'name', label: 'Model', render: (r: LocalModelRow) => r.name },
                    {
                      key: 'size',
                      label: 'Resident',
                      numeric: true,
                      render: (r: LocalModelRow) => formatBytes(r.sizeBytes),
                    },
                  ]}
                  rows={residentRows}
                  rowKey={(r) => r.name}
                />
              }
            >
              <BarChart
                data={residentRows.map((r) => ({ label: r.name, value: r.sizeBytes }))}
                orientation="horizontal"
                height={Math.max(120, residentRows.length * 34)}
                formatValue={(v) => formatBytes(v)}
                ariaLabel="Resident memory by local model"
              />
            </ChartContainer>
          </div>

          {view.runtimes.length > 0 ? (
            <ul className={styles.noteList}>
              {view.runtimes.map((r) => (
                <li key={r.runtime} className={styles.capacityMuted}>
                  {r.runtime}:{' '}
                  {r.reachable
                    ? `${r.modelCount} model${r.modelCount === 1 ? '' : 's'} reported`
                    : 'did not answer'}
                  {r.stale ? ` · retained reading, ${formatAge(r.staleForMs)} old` : ''}
                  {r.reason ? ' · ' : ''}
                  {r.reason ? <code className={styles.commandInline}>{r.reason}</code> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {view.notes.length > 0 ? (
            <ul className={styles.noteList}>
              {view.notes.map((n) => (
                <li key={n} className={styles.capacityMuted}>
                  {n}
                </li>
              ))}
            </ul>
          ) : null}

          <p className={styles.sourceLine}>
            Sizes and the GPU share come from the runtime&apos;s own resident report; a model with no
            reported VRAM split shows no placement bar rather than being drawn as fully on GPU.{' '}
            {chartFormat.formatCompact(view.rows.length)} models installed.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A local figure tile. Deliberately NOT `StatTile`: that primitive is built
 * around a sparkline and a delta, and there is no local time series to put in
 * one — a tile with an empty trend slot invites the eye to look for a trend
 * that does not exist.
 */
function StatFigure({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}): ReactNode {
  return (
    <div className={styles.figureTile}>
      <span className={styles.figureLabel}>{label}</span>
      <span className={styles.figureBig}>{value}</span>
      <span className={styles.figureCaption}>{caption}</span>
    </div>
  );
}
