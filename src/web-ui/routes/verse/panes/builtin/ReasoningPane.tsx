/**
 * routes/verse/panes/builtin/ReasoningPane.tsx — the first-party Reasoning
 * pane (a registry STUB): the chat's thinking, turn by turn, newest first,
 * beside the answer instead of folded into it. The Reasoning + Sources unit
 * replaces it by registering the id `reasoning` (../README.md).
 */
import { useMemo } from 'react';
import { EmptyState } from '../../../../components/primitives/EmptyState.js';
import { formatThinkingTokens } from '../../chat/ThinkingBlock.js';
import { useVerseTranscript } from '../../useVerseTranscript.js';
import type { PaneProps } from '../pane-registry.js';
import { reasoningByTurn } from './pane-models.js';
import styles from './stub-panes.module.css';

function seconds(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export function ReasoningPane({ sessionId }: PaneProps) {
  const transcript = useVerseTranscript(sessionId);
  const turns = useMemo(() => reasoningByTurn(transcript.items), [transcript.items]);
  if (turns.length === 0) {
    return (
      <div className={styles.pane} aria-label="Reasoning">
        <section className={styles.section}>
          <EmptyState compact title="No reasoning yet"
            body="When the model thinks before it answers, its reasoning streams here, turn by turn — so you can follow why without scrolling the answer away. Raise the effort in the composer for more of it." />
        </section>
      </div>
    );
  }
  return (
    <div className={styles.pane} aria-label="Reasoning">
      <section className={styles.section}>
        {turns.map((turn) => (
          <article key={turn.turnId} className={styles.turn} aria-label={turn.ask ? `Reasoning for: ${turn.ask}` : 'Reasoning'}>
            {turn.ask ? <p className={styles.ask} title={turn.ask}>{turn.ask}</p> : null}
            {turn.blocks.map((block) => {
              const meta = [seconds(block.durationMs), block.estimatedTokens !== null ? formatThinkingTokens(block.estimatedTokens) : null]
                .filter(Boolean).join(' · ');
              return (
                <p key={block.key} className={styles.thought}>
                  {meta ? <span className={styles.thoughtMeta}>{meta}</span> : null}
                  {block.redacted ? <em>The model thought here; the provider withheld the text.</em> : block.text}
                </p>
              );
            })}
          </article>
        ))}
      </section>
    </div>
  );
}
