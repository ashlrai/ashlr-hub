/**
 * components/stream/RunStreamPanel.tsx — live view of one in-progress run:
 * current status, elapsed time/usage, and the step transcript as it builds
 * (M416 "live run streaming"). Backed by useRunStream's polling, not a
 * push channel — see that hook's header comment for why, and
 * RUN_STREAM_POLL_MS / the 'stalled' phase for how staleness is surfaced
 * rather than hidden.
 *
 * Reusable: any owner (journal's "watch live" action today; a future
 * /work/runs/:id detail view tomorrow) can mount `<RunStreamPanel runId=.../>`
 * directly — it owns its own data fetching, so the caller only needs an id.
 */
import { useEffect, useRef } from 'react';
import { useRunStream, RUN_STREAM_POLL_MS, type RunStreamPhase } from './useRunStream.js';
import { StatusBadge } from '../primitives/StatusBadge.js';
import { SkeletonLine } from '../primitives/Skeleton.js';
import type { RunStep } from '../../data/api-types.js';
import styles from './RunStreamPanel.module.css';

const STEP_KIND_LABEL: Record<RunStep['kind'], string> = {
  plan: 'Plan',
  model: 'Model',
  tool: 'Tool',
  synthesize: 'Synthesize',
};

function formatElapsed(startIso: string, endIso?: string): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function formatClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return iso;
  }
}

function PhaseBanner({ phase, lastChangedAt, error }: { phase: RunStreamPhase; lastChangedAt: number | null; error: Error | undefined }) {
  if (phase === 'connecting') {
    return (
      <div className={styles.banner} role="status">
        <span className={styles.bannerDot} data-tone="connecting" aria-hidden="true" />
        Connecting to run…
      </div>
    );
  }
  if (phase === 'not-found') {
    return (
      <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
        <span className={styles.bannerDot} data-tone="danger" aria-hidden="true" />
        Run not found. It may have been pruned from disk since this link was opened.
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
        <span className={styles.bannerDot} data-tone="danger" aria-hidden="true" />
        Stream disconnected{error ? `: ${error.message}` : ''}. Retrying every {RUN_STREAM_POLL_MS / 1000}s…
      </div>
    );
  }
  if (phase === 'stalled') {
    const secs = lastChangedAt ? Math.round((Date.now() - lastChangedAt) / 1000) : null;
    return (
      <div className={`${styles.banner} ${styles.bannerWarning}`} role="status" aria-live="polite">
        <span className={styles.bannerDot} data-tone="warning" aria-hidden="true" />
        No change observed{secs !== null ? ` in ${secs}s` : ''} — this run may be stalled, or is simply quiet between
        steps. Still polling.
      </div>
    );
  }
  if (phase === 'live') {
    return (
      <div className={styles.banner} role="status">
        <span className={styles.bannerDot} data-tone="live" aria-hidden="true" />
        Live · polling every {RUN_STREAM_POLL_MS / 1000}s (server refresh floor ~1.5s — this cannot be faster than
        that)
      </div>
    );
  }
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerDot} data-tone="done" aria-hidden="true" />
      Run finished — no longer polling.
    </div>
  );
}

export function RunStreamPanelSkeleton() {
  return (
    <div className={styles.panel}>
      <SkeletonLine width="40%" />
      <SkeletonLine width="90%" />
      <SkeletonLine width="70%" />
    </div>
  );
}

export function RunStreamPanel({ runId }: { runId: string }) {
  const stream = useRunStream(runId);
  const { phase, run, error, lastChangedAt } = stream;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run?.steps.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
  }

  if (!run && phase === 'connecting') return <RunStreamPanelSkeleton />;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <h3 className={styles.title}>{run?.goal ?? `Run ${runId}`}</h3>
          {run ? <StatusBadge status={run.status} /> : null}
        </div>
        {run ? (
          <dl className={styles.statRow}>
            <div>
              <dt>Elapsed</dt>
              <dd>{formatElapsed(run.createdAt, run.status === 'running' ? undefined : run.updatedAt)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {run.usage.tokensIn.toLocaleString()} in / {run.usage.tokensOut.toLocaleString()} out
              </dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>${run.usage.estCostUsd.toFixed(3)}</dd>
            </div>
            <div>
              <dt>Steps</dt>
              <dd>{run.steps.length}</dd>
            </div>
            <div>
              <dt>Tasks</dt>
              <dd>
                {run.tasks.filter((t) => t.status === 'done').length}/{run.tasks.length}
              </dd>
            </div>
          </dl>
        ) : null}
      </header>

      <PhaseBanner phase={phase} lastChangedAt={lastChangedAt} error={error} />

      <div
        ref={scrollRef}
        className={styles.transcript}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Run step transcript"
      >
        {!run || run.steps.length === 0 ? (
          <p className={styles.empty}>No steps recorded yet.</p>
        ) : (
          run.steps.map((step, i) => (
            <div key={`${step.ts}-${i}`} className={styles.step} data-focus-key={`run-stream-step-${i}`}>
              <span className={styles.stepKind} data-kind={step.kind}>
                {STEP_KIND_LABEL[step.kind] ?? step.kind}
              </span>
              <span className={styles.stepTime} title={step.ts}>
                {formatClock(step.ts)}
              </span>
              <span className={styles.stepTask}>{step.taskId}</span>
              <span className={styles.stepSummary}>{step.summary}</span>
              {step.usage ? (
                <span className={styles.stepUsage}>
                  {(step.usage.tokensIn + step.usage.tokensOut).toLocaleString()} tok
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
