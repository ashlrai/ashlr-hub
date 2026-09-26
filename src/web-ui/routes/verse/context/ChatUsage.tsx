/**
 * routes/verse/context/ChatUsage.tsx — the open chat's usage and context
 * efficiency (moved out of ResourcesPanel in 3.10, unit C2).
 *
 * The resources column is gone: accounts and seat capacity moved to Apps &
 * Accounts (C6), and what was about THIS CHAT moved into the dock's Context
 * pane. This block came with it unchanged — every figure is still derived
 * from the session record and its own event log, with no request and no
 * spend, and every number the CLI did not report still reads "—" or "≤".
 */
import type { VerseEvent, VerseSeat, VerseSession } from '../../../data/api-types.js';
import { MEMORY_BLOCK_MAX_BYTES } from './context-model.js';
import {
  CONTEXT_MODE_LABEL,
  idleCacheWarning,
  reportedCacheHitRatio,
  sessionContext,
  turnContextStats,
} from '../usage/context-model.js';
import { formatContextWindow, formatElapsed, windowSourceText } from '../verse-model.js';
import { formatWholePercent } from '../autonomy/format.js';
import { formatTokens, lastTurnActivityAt } from '../verse-store.js';
import styles from './ChatUsage.module.css';

/**
 * The open chat's usage and context efficiency. Every figure is derived from
 * the session record and its own event log — no request, no spend.
 */
export function ChatUsage({
  session,
  seats,
  events,
  now,
}: {
  session: VerseSession;
  seats: readonly VerseSeat[];
  events: readonly VerseEvent[] | undefined;
  now: number;
}) {
  const usage = session.usage;
  const ctx = sessionContext(session, seats);
  const stats = turnContextStats(events ?? []);
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const hit = reportedCacheHitRatio(usage);
  // The record's count is the durable one (a long log may be truncated); the
  // log's own count stands in only when the record predates the field.
  const compactions = session.compactionCount ?? stats.compactions;
  const idle = idleCacheWarning(session, ctx.tokens, now, lastTurnActivityAt(events ?? []));
  const bound = ctx.exact ? '' : '≤';
  const statBound = stats.exact ? '' : '≤';

  return (
    <>
      <dl className={styles.usage}>
        <div><dt>Input</dt><dd>{formatTokens(usage.inputTokens)}</dd></div>
        <div><dt>Output</dt><dd>{formatTokens(usage.outputTokens)}</dd></div>
        <div><dt>Cache read</dt><dd>{formatTokens(usage.cacheReadTokens)}</dd></div>
        <div><dt>Cache write</dt><dd>{formatTokens(usage.cacheCreationTokens)}</dd></div>
        <div><dt>Turns</dt><dd>{session.turnCount}</dd></div>
        <div>
          <dt>Context</dt>
          <dd title={ctx.exact ? undefined : 'An upper bound: the CLI reported only the turn total, which sums every call.'}>
            {bound}{formatTokens(ctx.tokens)}{ctx.window === null ? '' : ` / ${formatContextWindow(ctx.window)}`}
          </dd>
        </div>
      </dl>

      <h4 className={styles.subTitle}>Efficiency</h4>
      <dl className={styles.usage} aria-label="Context efficiency">
        <div>
          <dt>Cache hit</dt>
          <dd title="Share of prompt tokens served from the provider's cache: cache read ÷ (input + cache read + cache write).">
            {/* Whole percent, "<1%" for a sliver — never "0%" beside real cache reads. */}
            {hit !== null ? formatWholePercent(hit) : promptTokens > 0 ? 'none reported' : '—'}
          </dd>
        </div>
        <div><dt>Compactions</dt><dd>{compactions}</dd></div>
        <div>
          <dt>Avg context / turn</dt>
          <dd>{stats.average === null ? '—' : `${statBound}${formatTokens(stats.average)}`}</dd>
        </div>
        <div>
          <dt>Peak context</dt>
          <dd>{stats.peak === null ? '—' : `${statBound}${formatTokens(stats.peak)}`}</dd>
        </div>
        <div><dt>Mode</dt><dd>{CONTEXT_MODE_LABEL[ctx.mode]}</dd></div>
        <div>
          <dt>Compacts at</dt>
          <dd>{ctx.autoCompactAt === null ? '—' : `≈${formatTokens(ctx.autoCompactAt)}`}</dd>
        </div>
      </dl>
      <p className={styles.muted}>
        {ctx.source !== null
          ? `Window ${windowSourceText(ctx.source, session.engine)}.`
          : ctx.window !== null
            ? 'Window as stored when this chat was created; how it was known was not recorded.'
            : 'Window unknown for this chat.'}
        {stats.turns > 0 && !stats.exact ? ' Figures marked ≤ are upper bounds: the CLI reported only turn totals.' : ''}
      </p>
      {/* Pinned per chat at creation, like its roots: the memory panel below
          edits the PROJECT's file, not what this conversation was offered.
          On a paid seat memory is not free — its block rides in the system
          prompt of every turn — so the sentence says what it adds rather than
          leaving the operator to assume it costs nothing. */}
      <p className={styles.muted}>
        {session.memoryEnabled !== true
          ? 'This chat started without shared project memory.'
          : session.engine === 'local'
            ? 'Shared project memory was given to this chat’s agent when it started.'
            : `Shared project memory was given to this chat’s agent when it started: a block of up to ${MEMORY_BLOCK_MAX_BYTES / 1024} KB in its system prompt, re-sent every turn (cached after the first), plus the agent’s own reads and updates of MEMORY.md — a little of this seat’s usage.`}
      </p>
      {idle === null ? null : (
        <p role="status" className={styles.idleWarn}>
          {idle.local
            ? `Idle for ${formatElapsed(idle.idleMs)}: the local model has likely dropped this chat from its cache, so the next turn re-processes ~${formatTokens(idle.tokens)} tokens before it replies — time, not spend.`
            : `Idle for ${formatElapsed(idle.idleMs)}, past the ~1 h prompt-cache lifetime: the next turn likely re-reads ~${formatTokens(idle.tokens)} tokens uncached, at full price.`}
        </p>
      )}
    </>
  );
}
