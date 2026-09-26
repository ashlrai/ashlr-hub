/**
 * routes/verse/cloud/EvidenceTimeline.tsx — one cloud task's evidence chain
 * (3.13), in a side sheet opened from its row on Command's cloud card.
 *
 *   Evidence                                               [↻] [×]
 *   Fix the flaky tracker test · ashlrai/ashlr-hub
 *   7 verified · 2 claims or estimates · 1 unknown
 *   ● Objective      Fix the flaky tracker test         Verified
 *   │                From New cloud task, requested by mason…
 *   │                cloud task record · 2h ago
 *   ● Report         Session reports “done” (unverified)   Claim
 *   ○ Release        Release unknown                       Unknown
 *   …
 *
 * Reads GET /api/verse/cloud/tasks/<id>/timeline (core/cloud/timeline-api.ts)
 * only while open. Every step shows a trust WORD (timeline-model.ts): the
 * session's report is always a Claim and the cost an Estimate. Stages the
 * task has not reached are drawn hollow and quiet, never hidden, so the
 * chain always reads end to end.
 *
 * LAZY: CloudCard imports this with React.lazy, so none of it costs chat
 * first-paint bytes (cloud-queries.ts rule).
 */
import { useId, useMemo } from 'react';
import { cloudTimelinePath, type CloudTimelineResponse, type TimelineStep } from '../../../../core/cloud/timeline-types.js';
import { CLOUD_TASK_ID_PATTERN } from '../../../../core/cloud/types.js';
import { IconButton } from '../../../components/primitives/Button.js';
import { IconExternalLink, IconRefresh } from '../../../components/primitives/icons.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import {
  BADGE_MEANING,
  BADGE_WORD,
  badgeFor,
  narrowTimeline,
  STEP_LABEL,
  stepText,
  stepWhen,
  timelineSummary,
  type TimelineBadge,
} from './timeline-model.js';
import styles from './evidence-timeline.module.css';

const BADGE_TONE: Record<TimelineBadge, Tone> = {
  verified: 'success',
  claim: 'warning',
  estimate: 'neutral',
  unknown: 'unknown',
};

export type TimelineRead = { timeline: CloudTimelineResponse; reason: null } | { timeline: null; reason: string };

/** Operator words for a timeline read that did not answer — never a path, never a trace. */
function absence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Verse has no evidence for this task — it is not in the task store, or this build has no timeline yet.';
    if (err.status === 503) return 'The timeline failed to load on the server.';
    return `The timeline answered HTTP ${err.status}.`;
  }
  return 'The timeline could not be reached.';
}

export function cloudTimelineQuery(taskId: string): QueryDef<TimelineRead> {
  return {
    key: `verse-cloud-timeline-${taskId}`,
    fetch: async (signal) => {
      // The id came from the server, but it is spliced into a request path.
      if (!CLOUD_TASK_ID_PATTERN.test(taskId)) return { timeline: null, reason: 'That task id is not one Verse issued.' };
      try {
        const timeline = narrowTimeline(await apiGet<unknown>(cloudTimelinePath(taskId), signal));
        return timeline ? { timeline, reason: null } : { timeline: null, reason: 'Unrecognized response — update Ashlr.' };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        return { timeline: null, reason: absence(err) };
      }
    },
  };
}

function StepRow({ step, now, last }: { step: TimelineStep; now: number; last: boolean }) {
  const badge = badgeFor(step);
  const when = stepWhen(step, now);
  const detail = stepText(step.detail);
  return (
    <li className={styles.step} data-badge={badge} data-reached={step.reached ? 'true' : 'false'} data-kind={step.kind}>
      <span className={styles.rail} aria-hidden="true">
        <span className={styles.node} />
        {last ? null : <span className={styles.line} />}
      </span>
      <div className={styles.content}>
        <div className={styles.head}>
          <span className={styles.label}>{STEP_LABEL[step.kind]}</span>
          <span className={styles.badge} title={BADGE_MEANING[badge]}>
            <StatusBadge status={badge} tone={BADGE_TONE[badge]}>
              {badge === 'verified' ? `✓ ${BADGE_WORD[badge]}` : BADGE_WORD[badge]}
            </StatusBadge>
          </span>
        </div>
        <p className={styles.title}>{stepText(step.title)}</p>
        {detail ? <p className={styles.detail}>{detail}</p> : null}
        <p className={styles.meta}>
          <span>{step.source}</span>
          {when ? <span>{when}</span> : null}
          {step.link ? (
            <a className={styles.link} href={step.link.href} target="_blank" rel="noreferrer noopener">
              {step.link.label} <IconExternalLink width={11} height={11} aria-hidden="true" />
            </a>
          ) : null}
        </p>
      </div>
    </li>
  );
}

export interface EvidenceTimelineProps {
  taskId: string;
  /** The row's title, shown while the timeline loads. */
  title: string;
  open: boolean;
  onClose: () => void;
  now?: number;
}

function Body({ taskId, now }: { taskId: string; now: number }) {
  const def = useMemo(() => cloudTimelineQuery(taskId), [taskId]);
  const read = useQuery(def, { freshMs: 15_000 });
  const refetch = useRefetch(def);
  const timeline = read.data?.timeline ?? null;
  const summary = timeline ? timelineSummary(timeline.steps) : null;
  if (!read.data && !read.error) return <p className={styles.muted} aria-busy="true">Reading the evidence…</p>;
  if (!timeline) {
    return <p className={styles.notice} role="note">{read.data?.reason ?? read.error?.message ?? 'The timeline did not answer.'}</p>;
  }
  return (
    <>
      <div className={styles.summaryRow}>
        <p className={styles.summary}>{summary?.text}</p>
        <IconButton size="sm" variant="ghost" icon={<IconRefresh width={14} height={14} />} aria-label="Re-read the evidence" onClick={refetch} />
      </div>
      <ol className={styles.steps} aria-label="Evidence, from objective to cost">
        {timeline.steps.map((step, i) => (
          <StepRow key={step.kind} step={step} now={now} last={i === timeline.steps.length - 1} />
        ))}
      </ol>
    </>
  );
}

export function EvidenceTimeline({ taskId, title, open, onClose, now = Date.now() }: EvidenceTimelineProps) {
  const titleId = useId();
  return (
    <Sheet open={open} onClose={onClose} titleId={titleId} width={520} title="Evidence" description={title}>
      {open ? <Body taskId={taskId} now={now} /> : null}
    </Sheet>
  );
}

export default EvidenceTimeline;
