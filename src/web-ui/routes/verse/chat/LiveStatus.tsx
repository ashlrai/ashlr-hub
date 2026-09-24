/**
 * routes/verse/chat/LiveStatus.tsx — the line under a running turn (V3.10):
 *
 *     ● Running · 14s · npm test                              Stop
 *     ● Writing · 1m 3s · 38 tok/s                            Stop
 *
 * It replaces the bare caret that used to be the ONLY live signal: a turn
 * that had been silently retrying an overloaded API for four minutes looked
 * exactly like one that was about to answer.
 *
 * Sources, best first:
 *   1. transient `progress` frames (phase, server-measured elapsed, tok/s);
 *   2. the transcript itself — a pending tool call means "running that
 *      tool", a streaming bubble means "writing" — so a server that sends no
 *      progress frames still gets an honest line;
 *   3. the turn's own start stamp for the clock.
 * A figure nobody measured (tok/s, the tool) is left out, never guessed.
 *
 * Under it, when the engine says so, one plumbing notice: an API retry, a
 * failed preflight (e.g. Ollama not answering), or the no-output watchdog.
 * It clears itself once output resumes (verse-store livePersisted).
 *
 * Accessibility: the visible line ticks every second, so it is NOT a live
 * region; a visually hidden status announces only phase/tool changes, and a
 * notice is announced once when it appears.
 */
import { memo, useEffect, useState } from 'react';
import type { VerseProgressPhase, VerseStatusKind } from '../../../../core/verse/types.js';
import { summarizeToolInput } from '../verse-model.js';
import type { TranscriptItem, VerseLiveState } from '../verse-store.js';
import styles from './LiveStatus.module.css';

export interface LivePhase {
  phase: VerseProgressPhase;
  /** What the phase is about: the running command/path, when known. */
  detail: string | null;
}

/**
 * What the transcript says the running turn is doing right now — the
 * fallback for a server that sends no `progress` frames, and the source of
 * the tool's human-readable argument even when one does.
 */
export function derivePhaseFromTranscript(items: readonly TranscriptItem[], live: Pick<VerseLiveState, 'thinking'>): LivePhase {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'user') break;
    if (item.kind === 'tool') {
      if (item.result === null) return { phase: 'tool', detail: summarizeToolInput(item.input) || item.name };
      break;
    }
    if (item.kind === 'assistant' && item.streaming) return { phase: 'writing', detail: null };
    if (item.kind === 'assistant' || item.kind === 'thinking') break;
  }
  if (live.thinking) return { phase: 'thinking', detail: null };
  return { phase: 'waiting', detail: null };
}

const PHASE_WORD: Record<VerseProgressPhase, string> = {
  thinking: 'Thinking',
  tool: 'Running',
  writing: 'Writing',
  waiting: 'Waiting',
};

const NOTICE_WORD: Record<VerseStatusKind, string> = {
  retry: 'Retrying',
  preflight: 'Preflight',
  watchdog: 'Still running',
};

/** "14s" / "1m 3s" / "1h 2m". */
export function formatLiveElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface LiveStatusLine {
  phase: VerseProgressPhase;
  word: string;
  elapsedMs: number | null;
  detail: string | null;
  rate: string | null;
}

/** Pure: the parts of the line at clock time `now` (exported for tests). */
export function liveStatusLine(live: VerseLiveState, derived: LivePhase, now: number): LiveStatusLine {
  const progress = live.progress;
  // The transcript knows a tool call is pending before (or without) a
  // progress frame saying so, and it knows the call's argument; a progress
  // frame knows about reasoning and waiting, which the transcript cannot see.
  const phase: VerseProgressPhase = derived.phase === 'tool' || derived.phase === 'writing'
    ? derived.phase
    : progress?.phase ?? derived.phase;
  const elapsedMs = progress
    ? progress.elapsedMs + Math.max(0, now - progress.receivedAt)
    : live.startedAt !== null ? Math.max(0, now - live.startedAt) : null;
  const detail = phase === 'tool' ? derived.detail ?? progress?.tool ?? null : null;
  const tps = progress?.tokPerSec ?? null;
  const rate = (phase === 'writing' || phase === 'thinking') && tps !== null && tps > 0 ? `${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s` : null;
  return { phase, word: PHASE_WORD[phase], elapsedMs, detail, rate };
}

export interface LiveStatusProps {
  live: VerseLiveState;
  derived: LivePhase;
  onStop?: () => void;
}

export const LiveStatus = memo(function LiveStatus({ live, derived, onStop }: LiveStatusProps) {
  const [now, setNow] = useState(() => Date.now());
  // The clock only; never a request. Re-armed per turn.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live.turnId]);

  const line = liveStatusLine(live, derived, now);
  const spoken = line.detail ? `${line.word}: ${line.detail}` : line.word;
  const notice = live.notice;

  return (
    <div className={styles.live} data-phase={line.phase}>
      <div className={styles.line}>
        <span className={styles.pulse} aria-hidden="true" />
        <span className={styles.text} aria-hidden="true">
          <span className={styles.word}>{line.word}</span>
          {line.elapsedMs !== null ? <><span className={styles.sep}>·</span><span className={styles.figure}>{formatLiveElapsed(line.elapsedMs)}</span></> : null}
          {line.detail ? <><span className={styles.sep}>·</span><span className={styles.detail} title={line.detail}>{line.detail}</span></> : null}
          {line.rate ? <><span className={styles.sep}>·</span><span className={styles.figure}>{line.rate}</span></> : null}
        </span>
        <span className="visually-hidden" role="status">{spoken}</span>
        {onStop ? (
          <button type="button" className={styles.stop} onClick={onStop} aria-label="Stop this turn" title="Stop this turn (⌘.)">
            <span className={styles.stopIcon} aria-hidden="true" />Stop
          </button>
        ) : null}
      </div>
      {notice ? (
        <p className={styles.notice} data-kind={notice.kind} role="status">
          <span className={styles.noticeWord}>{NOTICE_WORD[notice.kind]}</span>
          <span className={styles.noticeText}>{notice.message}</span>
        </p>
      ) : null}
    </div>
  );
});
