/**
 * routes/verse/composer/ContextRing.tsx — "◔ 31%" in the composer footer
 * (unit C3): how full this chat's context window is.
 *
 * It IS the header ring, not a lookalike: the percentage, the tone and the
 * compaction tick come from ContextMeter's `describeContext` (context-math
 * `occupancy()`, measured against the compaction point) and are drawn by the
 * same `ContextRingGlyph`, from the SAME budget (verse-model
 * `sessionContextBudget`), so the two can never disagree. Hover or focus
 * shows the reading in full — used / limit tokens and where the CLI
 * compacts. Unknown occupancy is a dashed ring and "—", never a zero.
 *
 * The ring is quantity (the fixed azure ramp); it takes the warning colour
 * only as the chat nears the compaction point, and says so in words.
 */
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import type { VerseEngine } from '../../../data/api-types.js';
import { ContextRingGlyph, describeContext } from '../ContextMeter.js';
import styles from './composer.module.css';

export interface ContextRingProps {
  contextTokens: number | null;
  contextWindow: number | null;
  autoCompactAt: number | null;
  exact: boolean;
  /** Who compacts ("Claude Code", "Codex") — the same words the header uses. */
  engine?: VerseEngine | null;
}

export function ContextRing({ contextTokens, contextWindow, autoCompactAt, exact, engine = null }: ContextRingProps) {
  const measured = contextTokens !== null;
  const d = describeContext({ contextTokens, contextWindow, autoCompactAt, exact, engine });
  const [used = '', limit = 'n/a'] = d.label.split(' / ');
  // The accessible name is the short reading; the tooltip (its description) the full one.
  const name = !measured
    ? 'Context — not measured yet'
    : d.percent === null
      ? `Context ${used} tokens — the window is unknown`
      : `Context ${d.percentLabel} — ${used} of ${limit} tokens${d.compactLabel ? `, ${d.compactLabel}` : ''}`;
  return (
    <Tooltip placement="top" content={(
      <span className={styles.tip}>
        {measured ? d.summary.map((line) => <span key={line}>{line}</span>) : <span>Context — not measured yet</span>}
      </span>
    )}>
      <span className={styles.contextRing} role="img" aria-label={name} tabIndex={0}
        data-tone={measured ? d.tone : 'unknown'} data-exact={exact ? undefined : 'false'}>
        <ContextRingGlyph fillPercent={measured ? d.fillPercent : 0} tickPercent={measured ? d.tickPercent : null}
          classes={{ track: styles.ringTrack, fill: styles.contextFill, tick: styles.contextTick }} />
        <span className={styles.contextText} aria-hidden="true">{measured ? d.percentLabel : '—'}</span>
      </span>
    </Tooltip>
  );
}
