/**
 * routes/verse/mind/MindCards.tsx — Mind's cards (SPEC-310B §6, SPEC-310C §5;
 * unit C7): the memo timeline with each move's 7-day outcome ✓/✗ and Veto,
 * the hit-rate gauge with the standards, three A7 insight cards and the
 * action log. Everything the Leader or A7 wrote is untrusted text: rendered
 * as plain text, never as markdown or a link.
 */
import type { ReasoningInsight } from '../../../../core/reasoning/types.js';
import type { LeaderAction, LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import { Gauge } from '../../../components/charts/Gauge.js';
import { UNKNOWN, formatRelative } from '../autonomy/format.js';
import type { SurfaceActions } from '../command/actions.js';
import { ActionRow } from '../command/LeaderCard.js';
import { anchorId } from '../command/nav.js';
import { Card, CardNote, MicroLabel } from '../command/Surface.js';
import { postLeader, type OptionalRead } from '../command/surface-data.js';
import { KIND_LABEL } from './mind-model.js';
import { OUTCOME_WORD, expectedDeltaText, isVetoable, outcomeMark } from './leader-model.js';
import { projectLabel, type ProjectLabel } from './project-label.js';
import styles from './mind.module.css';

const MARK: Record<ReturnType<typeof outcomeMark>, string> = { hit: '✓', miss: '✗', pending: '…', ungraded: '—' };

function dayHeading(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
}

export function MemoTimeline({ read, actions }: { read: OptionalRead<LeaderStateV1> | undefined; actions: SurfaceActions }) {
  const state = read?.value ?? null;
  const memos = state?.timeline ?? [];
  const latestId = state?.latest?.id ?? null;
  const latestVetoable = state?.latest?.actions.some((a) => isVetoable(state.actions.find((x) => x.id === a.id) ?? a)) ?? false;
  return (
    <Card title="Memos" caption={state ? `${memos.length} in view · each move graded 7 days later` : undefined}>
      {!read ? (
        <p className={styles.muted} aria-busy="true">Reading the Leader…</p>
      ) : !state ? (
        <CardNote tone="unknown">{read.reason ?? 'The Leader did not answer.'}</CardNote>
      ) : memos.length === 0 ? (
        <CardNote>No memos yet{state.lastRun ? ` — last run: ${state.lastRun.reason ?? state.lastRun.outcome}` : ''}.</CardNote>
      ) : (
        <ol className={styles.timeline}>
          {memos.map((m) => {
            const mark = outcomeMark(m);
            const delta = expectedDeltaText(m.expectedDelta);
            return (
              <li key={m.id} className={styles.memo} data-outcome={mark} id={anchorId(`memo-${m.id}`)}>
                <span className={styles.memoDay}>{dayHeading(m.at)}</span>
                <span className={styles.mark} data-outcome={mark} aria-hidden="true">{MARK[mark]}</span>
                <div className={styles.memoBody}>
                  <span className={styles.memoMove}>{m.move ?? (m.status === 'ok' ? 'No move' : `No memo (${m.status.replace(/-/g, ' ')})`)}</span>
                  {m.bottleneck ? <span className={styles.memoWhy}>Bottleneck: {m.bottleneck}</span> : null}
                  <span className={styles.memoMeta}>
                    {delta ? `Expected ${delta}` : 'No expected delta'}
                    {' · '}
                    <span data-outcome={mark}>
                      {mark === 'hit' || mark === 'miss'
                        ? `${OUTCOME_WORD[mark]} (actual ${m.outcome?.actualDelta === null || m.outcome?.actualDelta === undefined ? '—' : `${m.outcome.actualDelta >= 0 ? '+' : ''}${m.outcome.actualDelta}`})`
                        : OUTCOME_WORD[mark]}
                    </span>
                    {` · ${m.actionCount} action${m.actionCount === 1 ? '' : 's'}`}
                  </span>
                </div>
                {m.id === latestId && latestVetoable ? (
                  <button
                    type="button"
                    className={styles.veto}
                    aria-label={`Veto the memo of ${dayHeading(m.at)}`}
                    disabled={actions.busy || actions.readOnly}
                    onClick={() =>
                      actions.act(() => postLeader({ action: 'veto-memo', memoId: m.id }), 'Veto the whole memo', {
                        confirm: {
                          title: 'Veto this memo?',
                          body: 'Every applied action is undone exactly and every scheduled one is cancelled. The Leader records the veto.',
                          confirmLabel: 'Veto memo',
                          destructive: true,
                        },
                      })
                    }
                  >
                    Veto
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function HitRateCard({ read }: { read: OptionalRead<LeaderStateV1> | undefined }) {
  const state = read?.value ?? null;
  const hr = state?.hitRate ?? null;
  const standards = (state?.standards ?? []).filter((s) => s.retiredAt === null);
  return (
    <div className={styles.stack}>
      <Gauge
        title="Leader hit rate"
        description={hr ? `${hr.hits} of ${hr.graded} graded moves · ${hr.windowDays} days` : undefined}
        status={!read ? { kind: 'loading' } : !state ? { kind: 'unknown', reason: read.reason ?? 'the Leader did not answer.' } : undefined}
        value={hr?.rate ?? null}
        showState={false}
        caption={hr && hr.rate === null ? 'nothing graded yet — moves are graded 7 days after they are made' : undefined}
        size={180}
      />
      <Card title="Standards" caption={state ? `${standards.length} in force` : undefined}>
        {!state ? (
          <CardNote tone="unknown">{read?.reason ?? 'The Leader did not answer.'}</CardNote>
        ) : standards.length === 0 ? (
          <CardNote>No standards yet.</CardNote>
        ) : (
          <ul className={styles.standards}>
            {standards.map((s) => (
              <li key={s.id}>
                <span className={styles.standardRule}>{s.rule}</span>
                <span className={styles.standardMeta}>
                  {s.appliesTo} · {s.source === 'mason' ? 'yours' : 'Leader'} · {formatRelative(s.addedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const SEVERITY_WORD = { high: 'High', warn: 'Worth a look', info: 'FYI' } as const;

/**
 * Where the insight happened: the project's name, the full path only in the
 * tooltip, and a quiet `scratch` tag for a folder under the OS temp dir
 * (project-label.ts). Plain text, never a link.
 */
function InsightPlace({ place }: { place: ProjectLabel }) {
  return (
    <>
      <span className={styles.insightPlace} title={place.full}>{place.label}</span>
      {place.scratch ? (
        <span className={styles.scratchTag} title="A scratch folder under the system temp directory">scratch</span>
      ) : null}
    </>
  );
}

export function InsightCards({
  insights,
  reason,
  loading = false,
  places,
}: {
  insights: ReasoningInsight[];
  reason: string | null;
  loading?: boolean;
  /** Labels for the insights' repos (MindSection builds them once for the cards and the facet). */
  places?: ReadonlyMap<string, ProjectLabel>;
}) {
  if (loading) return <p className={styles.muted} aria-busy="true">Reading the reasoning digest…</p>;
  if (reason !== null) return <CardNote tone="unknown">{reason}</CardNote>;
  if (insights.length === 0) {
    return <CardNote>No loops, repeated failures or verification gaps in the last 30 days.</CardNote>;
  }
  return (
    <ul className={styles.insights} aria-label="Reasoning insights">
      {insights.map((i) => {
        const place = i.repo ? (places?.get(i.repo) ?? projectLabel(i.repo)) : null;
        const seen = formatRelative(i.lastAt);
        const rest = [i.engine, `${i.count}×`, seen === UNKNOWN ? null : `last seen ${seen}`].filter(Boolean).join(' · ');
        return (
          <li key={i.id} className={styles.insight} data-severity={i.severity}>
            <span className={styles.insightKind}>
              <MicroLabel>{KIND_LABEL[i.kind]}</MicroLabel>
              <span className={styles.insightSeverity} data-severity={i.severity}>{SEVERITY_WORD[i.severity]}</span>
            </span>
            <span className={styles.insightTitle}>{i.title}</span>
            <span className={styles.insightMeta}>
              {place ? <InsightPlace place={place} /> : null}
              {place && rest ? ' · ' : null}
              {rest}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ActionLog({ read, actions }: { read: OptionalRead<LeaderStateV1> | undefined; actions: SurfaceActions }) {
  const state = read?.value ?? null;
  const list: LeaderAction[] = state?.actions ?? [];
  return (
    <Card title="Action log" caption={state ? 'Newest first · Veto runs the recorded inverse' : undefined}>
      {!read ? (
        <p className={styles.muted} aria-busy="true">Reading the action log…</p>
      ) : !state ? (
        <CardNote tone="unknown">{read.reason ?? 'The Leader did not answer.'}</CardNote>
      ) : list.length === 0 ? (
        <CardNote>The Leader has not acted yet.</CardNote>
      ) : (
        <ul className={styles.log} aria-label="Leader actions">
          {list.map((a) => (
            <ActionRow key={a.id} action={a} actions={actions} />
          ))}
        </ul>
      )}
    </Card>
  );
}
