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
import { useEffect, useRef, useState } from 'react';
import { useRunStream, RUN_STREAM_POLL_MS, type RunStreamPhase, type RunStreamTransport } from './useRunStream.js';
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

function PhaseBanner({
  phase,
  lastChangedAt,
  stallAgeMs,
  transport,
  error,
}: {
  phase: RunStreamPhase;
  lastChangedAt: number | null;
  stallAgeMs: number | null;
  transport: RunStreamTransport;
  error: Error | undefined;
}) {
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
    // Prefer the server's own stall age (SSE path — data-driven, not a
    // client guess); fall back to the client-computed gap on the polling path.
    const secs =
      stallAgeMs !== null
        ? Math.round(stallAgeMs / 1000)
        : lastChangedAt !== null
          ? Math.round((Date.now() - lastChangedAt) / 1000)
          : null;
    return (
      <div className={`${styles.banner} ${styles.bannerWarning}`} role="status" aria-live="polite">
        <span className={styles.bannerDot} data-tone="warning" aria-hidden="true" />
        No change observed{secs !== null ? ` in ${secs}s` : ''} — this run may be stalled, or is simply quiet between
        steps. Still {transport === 'sse' ? 'watching' : 'polling'}.
      </div>
    );
  }
  if (phase === 'live') {
    return (
      <div className={styles.banner} role="status">
        <span className={styles.bannerDot} data-tone="live" aria-hidden="true" />
        {transport === 'sse'
          ? 'Live · streaming (server tail ~500ms)'
          : `Live · polling every ${RUN_STREAM_POLL_MS / 1000}s (server refresh floor ~1.5s — this cannot be faster than that)`}
      </div>
    );
  }
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerDot} data-tone="done" aria-hidden="true" />
      Run finished — no longer {transport === 'sse' ? 'streaming' : 'polling'}.
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
  const { phase, run, error, lastChangedAt, transport, stallAgeMs, outputChunks } = stream;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Mirrors stickToBottomRef in React state purely so the "Follow" button can
  // render reactively — the ref alone is enough to drive the scroll effect,
  // but a ref mutation doesn't trigger a re-render.
  const [following, setFollowing] = useState(true);

  // v333: independent scroll/follow state for the live output pane — same
  // append/pin/follow contract as the step transcript above, but it tracks
  // its own scroll position since the two panes grow independently (an
  // engine can emit many output chunks between step boundaries).
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const outputStickToBottomRef = useRef(true);
  const [outputFollowing, setOutputFollowing] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run?.steps.length]);

  useEffect(() => {
    const el = outputScrollRef.current;
    if (!el || !outputStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [outputChunks.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom < 48;
    stickToBottomRef.current = pinned;
    setFollowing(pinned);
  }

  function onOutputScroll() {
    const el = outputScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom < 48;
    outputStickToBottomRef.current = pinned;
    setOutputFollowing(pinned);
  }

  function resumeFollowing() {
    stickToBottomRef.current = true;
    setFollowing(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function resumeOutputFollowing() {
    outputStickToBottomRef.current = true;
    setOutputFollowing(true);
    const el = outputScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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

      <PhaseBanner
        phase={phase}
        lastChangedAt={lastChangedAt}
        stallAgeMs={stallAgeMs}
        transport={transport}
        error={error}
      />

      {outputChunks.length > 0 ? (
        <div className={styles.transcriptWrap}>
          <div
            ref={outputScrollRef}
            className={styles.transcript}
            onScroll={onOutputScroll}
            tabIndex={0}
            role="log"
            aria-label="Live engine output"
            aria-live={outputFollowing ? 'polite' : 'off'}
          >
            {outputChunks.map((chunk, i) => (
              <div key={`${chunk.ts}-${i}`} className={styles.step} data-focus-key={`run-output-chunk-${i}`}>
                <span className={styles.stepKind} data-kind={chunk.kind}>
                  {chunk.kind}
                </span>
                <span className={styles.stepTime} title={chunk.ts}>
                  {formatClock(chunk.ts)}
                </span>
                <span className={styles.stepTask}>{chunk.taskId ?? ''}</span>
                <span className={styles.stepSummary}>{chunk.text}</span>
              </div>
            ))}
          </div>
          {!outputFollowing ? (
            <button type="button" className={styles.followButton} onClick={resumeOutputFollowing}>
              ↓ Follow
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.transcriptWrap}>
        <div
          ref={scrollRef}
          className={styles.transcript}
          onScroll={onScroll}
          tabIndex={0}
          role="log"
          aria-label="Run step transcript"
          aria-live={following ? 'polite' : 'off'}
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
        {!following ? (
          <button type="button" className={styles.followButton} onClick={resumeFollowing}>
            ↓ Follow
          </button>
        ) : null}
      </div>
    </div>
  );
}
