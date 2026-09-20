/**
 * routes/verse/usage/LocalModelsPanel.tsx — local availability.
 *
 * A local seat has no subscription and no quota, so the honest analogue of a
 * meter is RESIDENT BYTES AGAINST THE MACHINE'S MEMORY BUDGET: that is what
 * decides whether a model can answer right now. Around it sit the four facts
 * the old surface fetched and discarded (docs/VERSE-TELEMETRY-V2.md):
 * resident vs installed, the GPU/CPU split from `size_vram`, the keep-alive
 * countdown from `expires_at`, and — the hard gate — whether the model
 * advertises `tools`, because a model without it cannot drive an agentic
 * session at all and should say so here instead of failing at turn time.
 *
 * `capabilities: null` means the runtime did not report a capability list.
 * That is rendered as unknown, not as "no tools": refusing to answer and
 * answering "no" are different facts.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { TableView, chartFormat, type TableColumn } from '../../../components/charts/index.js';
import type { AccountVerdictState, LocalCardModel } from './accounts-model.js';
import {
  formatBytes,
  formatContext,
  formatCountdown,
  type LocalModelRow,
  type LocalModelsView,
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
    <span>tools</span>
  ) : (
    <span className={styles.negative} title="Without tool support this model cannot drive an agentic session.">
      no tools
    </span>
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
    <span
      title={
        row.resident && row.sizeVramBytes === null
          ? `${provenance} The runtime did not report a VRAM split.`
          : provenance
      }
    >
      {formatBytes(row.sizeBytes)}
      {row.gpuPct === null ? '' : ` · ${Math.round(row.gpuPct)}% GPU`}
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
  { key: 'size', label: 'Size', numeric: true, render: (r) => <SizeCell row={r} /> },
  { key: 'params', label: 'Params', numeric: true, render: (r) => r.parameterSize ?? '—' },
  { key: 'quant', label: 'Quant', render: (r) => r.quantization ?? '—' },
  { key: 'context', label: 'Context', numeric: true, render: (r) => <ContextCell row={r} /> },
  { key: 'tools', label: 'Agentic', render: (r) => <ToolsCell row={r} /> },
  {
    key: 'keepalive',
    label: 'Keep-alive',
    numeric: true,
    render: (r) => (r.resident && r.expiresInMs !== null ? formatCountdown(r.expiresInMs) : '—'),
  },
];

export function LocalCard({ card }: { card: LocalCardModel }): ReactNode {
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

export function LocalModelsPanel({ view }: { view: LocalModelsView | null }): ReactNode {
  const expiring = view?.rows.some((r) => r.resident && r.expiresInMs !== null) ?? false;
  // Subscribing to the clock re-renders this panel; the value itself is only
  // needed because the rows were built against an older `now`.
  useNow(expiring);

  return (
    <section className={styles.panel} aria-labelledby="verse-usage-local">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-local" className={styles.panelTitle}>
          Local availability
        </h3>
        <p className={styles.panelNote}>
          Resident models answer immediately. A model without tool support cannot drive an agentic
          session at all.
        </p>
      </div>

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
        <div className={styles.tableScroll}>
          <TableView
            caption="Local models: residency, size, parameters, quantization, context and tool support"
            columns={COLUMNS}
            rows={view.rows}
            rowKey={(r) => r.name}
          />
        </div>
      )}

      {view && view.reachable && view.rows.length > 0 ? (
        <p className={styles.sourceLine}>
          Sizes and the GPU share come from the runtime&apos;s own resident report; a model with no
          reported VRAM split shows its size without one rather than assuming it is all on GPU.
          {view.residentBytes === null && view.rows.some((r) => r.resident)
            ? ' At least one resident model reported no size, so the resident total is withheld rather than understated.'
            : ''}
          {' '}
          {chartFormat.formatCompact(view.rows.filter((r) => r.tools === 'unsupported').length)} of{' '}
          {chartFormat.formatCompact(view.rows.length)} installed models cannot drive an agentic session.
        </p>
      ) : null}
    </section>
  );
}
