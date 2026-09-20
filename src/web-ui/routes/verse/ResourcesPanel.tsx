/**
 * routes/verse/ResourcesPanel.tsx — the right column: every seat with its
 * health and usage windows, the local Ollama runtime, running sessions with
 * elapsed time + Stop, and the current session's cumulative token usage.
 */
import { useEffect, useState } from 'react';
import type { VerseBootstrap, VerseSeat, VerseSession } from '../../data/api-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { ENGINE_LABEL, formatElapsed, groupSeats, healthTone, projectName } from './verse-model.js';
import { formatTokens } from './verse-store.js';
import styles from './ResourcesPanel.module.css';

export interface ResourcesPanelProps {
  bootstrap: VerseBootstrap | undefined;
  sessions: readonly VerseSession[];
  current: VerseSession | null;
  onStop: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function formatReset(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `resets ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function SeatRow({ seat }: { seat: VerseSeat }) {
  return (
    <li className={`${styles.seat} ${styles[`engine-${seat.engine}`] ?? ''}`} data-engine={seat.engine}>
      <div className={styles.seatHead}>
        <span className={styles.seatLabel}>{seat.label}</span>
        <StatusBadge status={seat.health.state} tone={healthTone(seat.health.state)} />
      </div>
      <div className={styles.seatMeta}>
        <span>{ENGINE_LABEL[seat.engine]}</span>
        <span>·</span>
        <span>{seat.models.length} model{seat.models.length === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{seat.contextWindow ? `${formatTokens(seat.contextWindow)} ctx` : 'ctx n/a'}</span>
      </div>
      {seat.health.summary ? <p className={styles.seatSummary}>{seat.health.summary}</p> : null}
      {seat.health.windows.length > 0 ? (
        <ul className={styles.windows}>
          {seat.health.windows.map((w) => {
            const pct = w.usedPercent === null ? null : Math.max(0, Math.min(100, Math.round(w.usedPercent)));
            const tone = pct === null ? 'unknown' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
            return (
              <li key={w.id} className={styles.window}>
                <div className={styles.windowHead}>
                  <span>{w.id}</span>
                  <span>{pct === null ? 'n/a' : `${pct}%`} {formatReset(w.resetsAt) ? <span className={styles.reset}>· {formatReset(w.resetsAt)}</span> : null}</span>
                </div>
                <div className={styles.windowTrack} role="meter" aria-label={`${seat.label} ${w.id} window`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} data-tone={tone}>
                  <div className={styles.windowFill} style={{ width: `${pct ?? 0}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export function ResourcesPanel({ bootstrap, sessions, current, onStop, onOpen, onClose }: ResourcesPanelProps) {
  const running = sessions.filter((s) => s.status === 'running');
  const now = useNow(running.length > 0);
  const groups = bootstrap ? groupSeats(bootstrap.seats) : [];
  const local = bootstrap?.localRuntime.ollama;
  return (
    <aside className={styles.panel} aria-label="Resources">
      <header className={styles.head}>
        <h2 className={styles.title}>Resources</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Hide resources">×</button>
      </header>
      <div className={styles.scroll}>
        <section className={styles.section} aria-labelledby="verse-res-seats">
          <h3 id="verse-res-seats" className={styles.sectionTitle}>Seats</h3>
          {!bootstrap ? <div className={styles.skeleton}><SkeletonLine width="70%" /><SkeletonLine width="50%" /><SkeletonLine width="64%" /></div>
            : groups.length === 0 ? <p className={styles.muted}>No seats discovered. Connect an account with <code>ashlr accounts</code> or start Ollama.</p>
              : groups.map((group) => (
                <div key={group.engine} className={styles.engineGroup}>
                  <h4 className={styles.engineTitle}>{ENGINE_LABEL[group.engine]}</h4>
                  <ul className={styles.seatList}>{group.seats.map((seat) => <SeatRow key={seat.id} seat={seat} />)}</ul>
                </div>
              ))}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-local">
          <h3 id="verse-res-local" className={styles.sectionTitle}>Local runtime</h3>
          {!local ? <SkeletonLine width="60%" /> : (
            <div className={styles.local}>
              <div className={styles.seatHead}>
                <span className={styles.seatLabel}>Ollama</span>
                <StatusBadge status={local.reachable ? 'ready' : 'unavailable'} tone={local.reachable ? 'success' : 'danger'}>
                  {local.reachable ? 'reachable' : 'unreachable'}
                </StatusBadge>
              </div>
              <p className={styles.mono} title={local.baseUrl}>{local.baseUrl}</p>
              {local.reachable ? (
                local.models.length > 0
                  ? <ul className={styles.models}>{local.models.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
                  : <p className={styles.muted}>No models pulled yet.</p>
              ) : <p className={styles.muted}>Start Ollama to enable local seats.</p>}
            </div>
          )}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-running">
          <h3 id="verse-res-running" className={styles.sectionTitle}>Running <span className={styles.count}>{running.length}</span></h3>
          {running.length === 0 ? <p className={styles.muted}>Nothing running.</p> : (
            <ul className={styles.runningList}>
              {running.map((s) => (
                <li key={s.id} className={styles.runningRow}>
                  <button type="button" className={styles.runningOpen} onClick={() => onOpen(s.id)} title={s.title}>
                    <span className={styles.runningDot} role="img" aria-label="Running" />
                    <span className={styles.runningTitle}>{s.title || 'Untitled chat'}</span>
                    <span className={styles.runningMeta}>{projectName(s.projectPath, bootstrap?.projects ?? [])} · {formatElapsed(now - new Date(s.updatedAt).getTime())}</span>
                  </button>
                  <button type="button" className={styles.stop} onClick={() => onStop(s.id)} aria-label={`Stop ${s.title || 'chat'}`}>Stop</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-usage">
          <h3 id="verse-res-usage" className={styles.sectionTitle}>This chat</h3>
          {!current ? <p className={styles.muted}>Select a chat to see its usage.</p> : (
            <dl className={styles.usage}>
              <div><dt>Input</dt><dd>{formatTokens(current.usage.inputTokens)}</dd></div>
              <div><dt>Output</dt><dd>{formatTokens(current.usage.outputTokens)}</dd></div>
              <div><dt>Cache read</dt><dd>{formatTokens(current.usage.cacheReadTokens)}</dd></div>
              <div><dt>Cache write</dt><dd>{formatTokens(current.usage.cacheCreationTokens)}</dd></div>
              <div><dt>Turns</dt><dd>{current.turnCount}</dd></div>
              <div><dt>Context</dt><dd>{formatTokens(current.usage.contextTokens)}{current.usage.contextWindow ? ` / ${formatTokens(current.usage.contextWindow)}` : ''}</dd></div>
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
