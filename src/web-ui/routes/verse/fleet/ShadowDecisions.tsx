/**
 * routes/verse/fleet/ShadowDecisions.tsx — every decision the merge gates
 * made under the standing grant, on Fleet (⌘2; 3.14).
 *
 *   ▲ Dropped back to Shadow from 2a — 1 sandbox violation in stage 2a · 3 h ago
 *   Shadow decisions                                    Shadow · 2 would-merge
 *   ashlrcode  #12  Would merge       +30 −4 · 2 files · low · Shadow · 2 h ago
 *     Every gate passed; held because the ladder is in shadow, so it only proposes.
 *     [G0][G1][G1b][G2][G3][G4][G5][G6][G7]              Evidence · PR ↗
 *
 * One row per proposal (newest first) from GET …/authority/ledger?view=decisions
 * (core/verse/autonomy-ladder.ts): the last verdict of each gate as a chip,
 * the outcome and WHY in one sentence. Ladder regressions sit above the list,
 * loud, with their breach. "Evidence" opens the 3.13 cloud timeline when a
 * cloud task's intake filed the proposal; "PR" opens the fleet PR on GitHub.
 *
 * LAZY: FleetSection loads this with React.lazy; the timeline is lazier still.
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import type { GateId } from '../../../../core/fleet/fleet-types.js';
import type { ShadowDecisionV1 } from '../../../../core/verse/autonomy-ladder.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { cloudQuery } from '../cloud/cloud-queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { anchorId } from '../command/nav.js';
import {
  ago,
  cloudTaskFor,
  gateTone,
  OUTCOME_TONE,
  OUTCOME_WORD,
  prUrl,
  recentRegressions,
  repoShort,
  sizeLine,
  stageLabel,
} from '../command/ladder-model.js';
import { DECISIONS_POLL_MS, decisionsQuery } from '../command/ladder-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from '../command/autonomy-ladder.module.css';

const EvidenceTimeline = lazy(() => import('../cloud/EvidenceTimeline.js'));

const GATES: readonly GateId[] = ['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

const VERDICT_WORD: Record<string, string> = { pass: 'passed', refuse: 'refused', 'owner-lane': 'sent to the owner lane', wait: 'waiting' };

function GateChips({ decision }: { decision: ShadowDecisionV1 }) {
  const byGate = new Map(decision.gates.map((g) => [g.gate, g]));
  return (
    <ul className={styles.gates} aria-label="Gate verdicts">
      {GATES.map((gate) => {
        const v = byGate.get(gate);
        const text = v ? `${gate} ${VERDICT_WORD[v.verdict] ?? v.verdict}${v.verdict === 'pass' ? '' : `: ${v.reason}`}` : `${gate} has not reported`;
        return (
          <li key={gate} className={styles.gate} data-tone={v ? gateTone(v.verdict) : 'absent'} title={text} aria-label={text}>
            {gate}
          </li>
        );
      })}
    </ul>
  );
}

function DecisionRow({ d, now, onEvidence, evidence }: { d: ShadowDecisionV1; now: number; evidence: { id: string; title: string } | null; onEvidence: (task: { id: string; title: string }) => void }) {
  const size = sizeLine(d);
  const pr = prUrl(d);
  return (
    <li className={styles.decision} data-outcome={d.outcome}>
      <div className={styles.decisionHead}>
        <span className={styles.repo} title={d.repo}>{repoShort(d.repo)}</span>
        {d.prNumber !== null ? <span className={styles.meta}>#{d.prNumber}</span> : null}
        <span className={styles.outcome} data-tone={OUTCOME_TONE[d.outcome]}>{OUTCOME_WORD[d.outcome]}</span>
        <span className={styles.meta}>
          {[size, d.stageId ? stageLabel(d.stageId) : null, ago(d.at, now)].filter(Boolean).join(' · ')}
          {d.headShort ? <> · <span className={styles.mono} title={`proposal ${d.proposalId}`}>{d.headShort}</span></> : null}
        </span>
      </div>
      <span className={styles.links}>
        {evidence ? (
          <button type="button" className={styles.decisionLink} onClick={() => onEvidence(evidence)}>
            Evidence
          </button>
        ) : null}
        {pr ? (
          <a className={styles.decisionLink} href={pr} target="_blank" rel="noreferrer noopener">
            PR <IconExternalLink width={11} height={11} aria-hidden="true" />
          </a>
        ) : null}
      </span>
      <p className={styles.why}>{d.why}</p>
      <GateChips decision={d} />
    </li>
  );
}

export function ShadowDecisions({ now }: { now: number }) {
  const read = useQuery(decisionsQuery, { freshMs: 15_000 });
  const refetch = useRefetch(decisionsQuery);
  usePollWhileVisible(refetch, DECISIONS_POLL_MS);
  // Only to link a proposal to its cloud task's timeline; its absence just drops the link.
  const cloud = useQuery(cloudQuery, { freshMs: 60_000 });
  const tasks = cloud.data?.value?.tasks ?? null;
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);

  const value = read.data?.value ?? null;
  const regressions = useMemo(() => recentRegressions(value), [value]);
  const counts = useMemo(() => {
    const byOutcome = new Map<string, number>();
    for (const d of value?.decisions ?? []) byOutcome.set(d.outcome, (byOutcome.get(d.outcome) ?? 0) + 1);
    return byOutcome;
  }, [value]);
  const caption = value
    ? value.decisions.length === 0
      ? 'Nothing has reached the gates yet'
      : [`${counts.get('would-merge') ?? 0} would merge`, `${counts.get('merged') ?? 0} merged`, `${counts.get('refused') ?? 0} refused`].join(' · ')
    : null;

  return (
    <div id={anchorId('shadow-decisions')} className={styles.stackGap}>
      {regressions.length > 0 ? (
        <ul className={styles.regressions} aria-label="Ladder regressions">
          {regressions.map((m) => (
            <li key={`${m.at}-${m.toStageId}`} className={styles.regression} role="alert">
              <span className={styles.regressionTitle}>
                ▲ Dropped back to {stageLabel(m.toStageId)}{m.fromStageId ? ` from ${stageLabel(m.fromStageId)}` : ''}
              </span>
              <span>{m.breach ?? 'A breach of the stage’s limits.'}</span>
              <span className={styles.when}>{ago(m.at, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Card title="Shadow decisions" caption={caption}>
        {!read.data ? (
          <p className={styles.muted} aria-busy="true">Reading the gate decisions…</p>
        ) : !value ? (
          <CardNote tone="unknown">{read.data.reason ?? 'The decisions did not answer.'}</CardNote>
        ) : value.decisions.length === 0 ? (
          <CardNote>No proposal has been through the merge gates under this grant yet. Each one will show here with its G0–G7 verdicts.</CardNote>
        ) : (
          <>
            {value.chain === 'broken' ? <CardNote tone="danger">{value.reason ?? 'The authority ledger is broken; these rows are the verified part.'}</CardNote> : null}
            <ol className={styles.decisions} aria-label="Decisions, newest first">
              {value.decisions.map((d) => (
                <DecisionRow key={d.proposalId} d={d} now={now} evidence={cloudTaskFor(d, tasks)} onEvidence={setOpen} />
              ))}
            </ol>
            {value.truncated ? <p className={styles.muted}>Older decisions are in the authority ledger (`ashlr authority status`).</p> : null}
          </>
        )}
      </Card>
      {open ? (
        <Suspense fallback={null}>
          <EvidenceTimeline taskId={open.id} title={open.title} open onClose={() => setOpen(null)} now={now} />
        </Suspense>
      ) : null}
    </div>
  );
}

export default ShadowDecisions;
