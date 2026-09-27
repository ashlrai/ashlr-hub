/**
 * routes/verse/reasoning/ReasoningPanel.tsx — the chat's chain of thought,
 * turn by turn, in one scroll (V3.15).
 *
 * In the transcript, reasoning folds between the actions it explains — right
 * for reading one answer, wrong for asking "how did it get here over the last
 * twenty turns". This pane lines the reasoning up alone: each turn's ask, the
 * one-line summary of what it did, every block it showed (streamed text,
 * provider summaries marked as such, withheld blocks said out loud) — and for
 * a seat that never shares its reasoning, that fact, in words, instead of an
 * empty space that looks like a bug.
 *
 * `ReasoningPanel` is presentational over derived turns; `ReasoningPane` is
 * the registry adapter (just `{sessionId}`).
 */
import { useMemo } from 'react';
import { reasoningPolicyFor } from '../../../../core/verse/trace.js';
import { formatThinkingDuration, formatThinkingTokens, ThinkingBlock } from '../chat/ThinkingBlock.js';
import type { TurnBlock } from '../chat/turn-model.js';
import { buildReasoningTrail, reasoningTotals } from './reasoning-model.js';
import { useChatTurns, usePaneActions, useSessionRecord } from './pane-data.js';
import styles from './reasoning.module.css';

export interface ReasoningPanelProps {
  turns: readonly TurnBlock[];
  /** The seat's engine, for the honest "not shared" wording. */
  engine?: string | null;
  jumpToTurn: (turnKey: string) => void;
}

export function ReasoningPanel({ turns, engine = null, jumpToTurn }: ReasoningPanelProps) {
  const trail = useMemo(() => buildReasoningTrail(turns, engine), [turns, engine]);
  const totals = useMemo(() => reasoningTotals(trail), [trail]);
  const policy = reasoningPolicyFor(engine);
  const parts: string[] = [];
  if (totals.shown > 0) parts.push(`${totals.shown} thought${totals.shown === 1 ? '' : 's'}`);
  if (totals.durationMs !== null && totals.durationMs > 0) parts.push(formatThinkingDuration(totals.durationMs));
  if (totals.tokens !== null && totals.tokens > 0) parts.push(formatThinkingTokens(totals.tokens));
  if (totals.hidden > 0) parts.push(`${totals.hidden} withheld by the provider`);

  if (trail.length === 0) {
    return <div className={styles.panel}><p className={styles.empty}>Reasoning appears here as the agent works.</p></div>;
  }

  return (
    <div className={styles.panel}>
      <p className={styles.totals}>
        {parts.length > 0 ? parts.join(' · ') : policy.visibility === 'hidden' ? 'This seat does not share its reasoning.' : 'No reasoning shown yet.'}
        {policy.visibility === 'summary' ? <span className={styles.totalsNote}>Summaries written by the provider, not the raw chain of thought.</span> : null}
      </p>
      <ol className={styles.trail}>
        {trail.map((entry) => (
          <li key={entry.turnKey} className={styles.trailTurn} data-status={entry.status}>
            <button type="button" className={styles.trailHead} onClick={() => jumpToTurn(entry.turnKey)}
              aria-label={`Turn ${entry.index}: ${entry.title} — go to turn`}>
              <span className={styles.trailIndex}>{entry.index}</span>
              <span className={styles.trailTitle}>{entry.title}</span>
            </button>
            {entry.work ? <p className={styles.trailWork}>{entry.work}</p> : null}
            {entry.thoughts.map((t) => (
              <ThinkingBlock key={t.key} text={t.text} redacted={t.redacted} durationMs={t.durationMs}
                estimatedTokens={t.estimatedTokens} kind={t.kind} stateKey={`pane-thinking:${t.key}`} />
            ))}
            {entry.silentNote ? <p className={styles.trailSilent}>{entry.silentNote}.</p> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Pane-registry adapter: everything from the session id. */
export function ReasoningPane({ sessionId }: { sessionId: string }) {
  const turns = useChatTurns(sessionId);
  const session = useSessionRecord(sessionId);
  const { jumpToTurn } = usePaneActions(sessionId);
  return <ReasoningPanel turns={turns} engine={session?.engine ?? null} jumpToTurn={jumpToTurn} />;
}
