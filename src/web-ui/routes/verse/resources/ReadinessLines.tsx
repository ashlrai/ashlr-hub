/**
 * routes/verse/resources/ReadinessLines.tsx — the two answers every resource
 * card in the drawer owes Mason (3.14):
 *
 *   Chat   ● Ready
 *   Fleet  ● Ready · reserve 40% kept for you
 *          63% of the weekly window is left for the fleet. Roles: judges, leads.
 *   Last reading 4:56 PM · Polling is paused …
 *   Set up the Claude seat — run in Terminal
 *   [ ashlr resources profile prepare …            ] [Copy]
 *
 * Every word comes from GET /api/verse/budget/readiness (core/routing/
 * readiness.ts), which asks the SAME gates the session engine and the fleet
 * daemon ask — this component only lays them out. The dot's SHAPE follows its
 * tone the way the drawer's status line does (disc ready, ring caveat,
 * diamond blocked, dashed off), so colour is never the only signal.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { IconCheck, IconCopy } from '../../../components/primitives/icons.js';
import type {
  ReadinessFix,
  ReadinessTone,
  ReadinessVerdict,
  ResourceReadinessRow,
} from '../../../../core/routing/readiness-types.js';
import { formatClock } from '../verse-model.js';
import styles from './ResourcesDrawer.module.css';

const TONE_ATTR: Readonly<Record<ReadinessTone, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  ok: 'success',
  warn: 'warning',
  blocked: 'danger',
  off: 'neutral',
};

/** "Ready · reserve 40% kept for you" when the fleet protects a share for Mason. */
export function fleetWord(row: ResourceReadinessRow): string {
  const { fleet } = row;
  if (fleet.ready && fleet.reservePercent !== null && fleet.reservePercent > 0) {
    return `${fleet.word} · reserve ${Math.round(fleet.reservePercent)}% kept for you`;
  }
  return fleet.word;
}

/** The reading caveat, or null when the reading is live. */
export function readingText(row: ResourceReadinessRow): string | null {
  const { reading } = row;
  if (reading.state === 'live' || row.kind !== 'subscription') return null;
  const clock = reading.at ? formatClock(reading.at) : '';
  const head = reading.state === 'last' && clock ? `Last reading ${clock}` : 'No current reading';
  return reading.note ? `${head} · ${reading.note}` : head;
}

function Line({ label, verdict, word }: { label: string; verdict: ReadinessVerdict; word: string }) {
  const tone = TONE_ATTR[verdict.tone];
  const full = verdict.detail ? `${label}: ${word} — ${verdict.detail}` : `${label}: ${word}`;
  return (
    <div className={styles.readyLine} data-tone={tone} data-ready={verdict.ready || undefined} title={full}>
      <span className={styles.readyKey}>{label}</span>
      <span className={styles.readyBody}>
        <span className={styles.readyHead}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span className={styles.readyWord}>{word}</span>
        </span>
        {verdict.detail ? <span className={styles.readyDetail}>{verdict.detail}</span> : null}
      </span>
    </div>
  );
}

function CommandFix({ fix }: { fix: ReadinessFix }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopied('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const line = fix.command ?? '';
  return (
    <div className={styles.fixBlock}>
      <p className={styles.fixLabel}>{fix.label} — run in Terminal</p>
      <div className={styles.fixCommand}>
        <code className={styles.fixCode} title={line}>{line}</code>
        <button
          type="button"
          className={styles.fixCopy}
          aria-label={copied === 'done' ? 'Copied' : `Copy command: ${fix.label}`}
          onClick={() => { void copyText(line).then((ok) => setCopied(ok ? 'done' : 'failed')); }}
        >
          {copied === 'done' ? <IconCheck /> : <IconCopy />}
          <span>{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}

/** Unique fixes across both verdicts, chat's first. */
export function readinessFixes(row: ResourceReadinessRow): ReadinessFix[] {
  const out: ReadinessFix[] = [];
  for (const fix of [row.chat.fix, row.fleet.fix]) {
    if (!fix) continue;
    if (out.some((f) => f.kind === fix.kind && f.command === fix.command && f.seatId === fix.seatId)) continue;
    out.push(fix);
  }
  return out;
}

export interface ReadinessLinesProps {
  row: ResourceReadinessRow | null | undefined;
  /**
   * Renders reconnect / check-again fixes as buttons. Omit it on a card that
   * already offers those actions (the account cards do), so the drawer never
   * shows the same button twice.
   */
  onAction?: (fix: ReadinessFix, row: ResourceReadinessRow) => void;
  busy?: boolean;
}

export function ReadinessLines({ row, onAction, busy = false }: ReadinessLinesProps) {
  if (!row) return null;
  const reading = readingText(row);
  const fixes = readinessFixes(row).filter((fix) => fix.kind === 'command' || onAction !== undefined);
  return (
    <div className={styles.readiness} data-readiness={row.id} role="group" aria-label={`${row.label}: readiness`}>
      <Line label="Chat" verdict={row.chat} word={row.chat.word} />
      <Line label="Fleet" verdict={row.fleet} word={fleetWord(row)} />
      {reading !== null ? <p className={styles.readyReading} title={reading}>{reading}</p> : null}
      {fixes.map((fix) =>
        fix.kind === 'command' ? (
          <CommandFix key={`${fix.kind}:${fix.command ?? ''}`} fix={fix} />
        ) : (
          <div key={`${fix.kind}:${fix.seatId ?? ''}`} className={styles.cardActions}>
            <Button size="sm" variant="primary" busy={busy} aria-label={`${fix.label}: ${row.label}`} onClick={() => onAction?.(fix, row)}>
              {fix.label}
            </Button>
          </div>
        ),
      )}
    </div>
  );
}
