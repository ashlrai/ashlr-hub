/**
 * routes/verse/leader/LeaderLine.tsx — the foot of Command's Leader card:
 * the Leader's latest message (one line, any channel) and a "Message the
 * Leader…" affordance that opens Mind's conversation with the composer
 * focused (leader-focus.ts).
 *
 *   ┌ L  Leader · Telegram · 12m ago                                        ┐
 *   │    Judge queue is clearing; raising Grok to 3 lanes at 14:20 unless…  │
 *   │ [ Message the Leader…                                          ⌘4 ↵ ] │
 *
 * Reads the thread's first page from the shared cache (Mind reads the same
 * key), polls it at Command's calm pace, and hides the preview — never the
 * button — when the conversation route is absent or silent.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { requestLeaderFocus } from './leader-focus.js';
import { leaderThreadQuery } from './thread-data.js';
import { CHANNEL_LABEL, latestLeaderMessage, previewText } from './thread-model.js';
import styles from './leader-line.module.css';

export const LEADER_LINE_POLL_MS = 30_000;

export function LeaderLine() {
  const thread = useQuery(leaderThreadQuery, { freshMs: 15_000 });
  const refetch = useRefetch(leaderThreadQuery);
  usePollWhileVisible(refetch, LEADER_LINE_POLL_MS);
  const latest = latestLeaderMessage(thread.data?.value?.messages ?? []);
  return (
    <div className={styles.line}>
      {latest ? (
        <p className={styles.preview} aria-label="The Leader's latest message">
          <span className={styles.meta}>
            Leader · {CHANNEL_LABEL[latest.channel]} · {formatRelative(latest.at)}
          </span>
          {/* Model text: one plain line (Markdown marks dropped), never HTML. */}
          <span className={styles.text} title={latest.text}>{previewText(latest.text)}</span>
        </p>
      ) : null}
      <button type="button" className={styles.ask} onClick={() => requestLeaderFocus({ kind: 'composer' })}>
        <span className={styles.askText}>Message the Leader…</span>
        <span className={styles.where} aria-hidden="true">opens Mind</span>
      </button>
    </div>
  );
}
