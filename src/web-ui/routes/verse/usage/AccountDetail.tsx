/**
 * routes/verse/usage/AccountDetail.tsx — one account, in full, on demand.
 *
 * The card answers "can I use this". This answers "why, exactly" — and it is
 * a separate surface rather than more card because the card must stay
 * readable in a glance and this is deliberately dense.
 *
 * What it shows that the card does not:
 *   - EVERY window, not just the binding one, each with its own reset signal;
 *   - the plan and, for Codex, the credit balance as a fact independent of
 *     the window;
 *   - the PROBE EVIDENCE — connection state, authentication, the monitor's
 *     health verdict, the verbatim machine code, and when the reading was
 *     taken. None of that is a measurement; all of it is why a measurement is
 *     or is not there.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: a history. No source this section reads
 * retains a per-account time series — `/api/verse/accounts` is a point-in-time
 * snapshot and `/api/verse/usage-series` is roster-wide with no per-account
 * breakdown — so the panel says that in one line instead of drawing a
 * one-point "trend" or back-filling a shape nobody measured.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { relativePhrase } from '../context/context-model.js';
import { ENGINE_LABEL } from '../verse-model.js';
import type { AccountCardModel, AccountVerdictState } from './accounts-model.js';
import { WindowMeter } from './WindowMeter.js';
import styles from './usage.module.css';

const VERDICT_TONE: Record<AccountVerdictState, Tone> = {
  available: 'success',
  credits: 'success',
  tight: 'warning',
  exhausted: 'danger',
  'signed-out': 'warning',
  'probe-unsupported': 'warning',
  unknown: 'unknown',
};

export const NO_HISTORY_NOTE =
  'No per-account history is retained by any source this view reads: the accounts route is a point-in-time snapshot and the usage series carries no per-account breakdown. A trend is not drawn from one reading.';

/**
 * Claude's health is `unknown` BY CONSTRUCTION (docs/VERSE-TELEMETRY-V2.md),
 * so rendering it as a fault would invent a problem. Every provider's
 * `unknown` is described as "not reported" for the same reason.
 */
function healthSentence(health: string | null, provider: string): string {
  if (health === null) return 'The source behind this card reports no health verdict at all.';
  if (health === 'unknown') {
    return provider === 'claude'
      ? 'Health reads unknown, which is how this provider always reads — the probe has no health channel for it. It is not a fault.'
      : 'Health reads unknown: the monitor took no verdict on this account.';
  }
  return `Monitor health: ${health}.`;
}

function EvidenceRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={styles.evidenceRow}>
      <dt className={styles.figureLabel}>{label}</dt>
      <dd className={styles.evidenceValue}>{children}</dd>
    </div>
  );
}

export function AccountDetail({
  card,
  onClose,
  headingId,
}: {
  card: AccountCardModel;
  onClose: () => void;
  /** Ties the region back to the card's own trigger for assistive tech. */
  headingId: string;
}): ReactNode {
  const { evidence } = card;
  const credits = card.credits;
  const historical = evidence.state !== 'observed';

  // Move focus to the heading when this opens, and again when the selection
  // moves to a different account.
  //
  // The trigger is a card in a wrapping grid, so the panel it reveals is never
  // the next thing in reading order and is often off-screen entirely. Leaving
  // focus on the card meant a keyboard or screen-reader operator pressed Enter,
  // was told "expanded", and then had to tab through the rest of the grid to
  // reach what they opened. `aria-controls` alone does not move anyone; only a
  // small minority of assistive tech offers to follow it.
  //
  // Keyed on `card.id`, not on every render: the 30s poll rebuilds this model
  // in place, and re-focusing on each one would yank focus out from under
  // whatever the operator was reading inside the panel.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [card.id]);

  return (
    <section className={styles.detail} aria-labelledby={headingId}>
      <div className={styles.detailHead}>
        <div>
          {/* tabIndex -1: a focus target for the effect above, not a tab stop. */}
          <h4 id={headingId} ref={headingRef} tabIndex={-1} className={styles.detailTitle}>
            {card.label}
          </h4>
          <div className={styles.cardMeta}>
            <span>{ENGINE_LABEL[card.engine]}</span>
            <span aria-hidden="true">·</span>
            <span>{card.plan ? `${card.plan} plan` : 'plan not reported'}</span>
            <span aria-hidden="true">·</span>
            <StatusBadge status={card.verdict.state} tone={VERDICT_TONE[card.verdict.state]}>
              {card.verdict.headline}
            </StatusBadge>
          </div>
        </div>
        <button type="button" className={styles.ghostButton} onClick={onClose}>
          Close
        </button>
      </div>

      <p className={styles.verdictDetail}>{card.verdict.detail}</p>

      <div className={styles.detailGrid}>
        <div className={styles.detailColumn}>
          <span className={styles.figureLabel}>
            {historical && card.allWindows.length > 0 ? 'Last reported windows' : 'All windows'} ({card.allWindows.length})
          </span>
          {card.allWindows.length === 0 ? (
            <p className={styles.reason}>
              No windows reported.
            </p>
          ) : (
            <div className={styles.windows}>
              {card.allWindows.map((w, i) => (
                <WindowMeter
                  key={w.id}
                  view={w}
                  ariaPrefix={card.label}
                  prominent={i === 0}
                  historical={historical}
                />
              ))}
            </div>
          )}
          {card.allWindows.some((w) => !w.measured) ? (
            <p className={styles.reason}>
              Flagged windows show no percentage — the provider sent only a limit flag.
            </p>
          ) : null}
        </div>

        <div className={styles.detailColumn}>
          <span className={styles.figureLabel}>Probe evidence</span>
          <dl className={styles.evidenceList}>
            <EvidenceRow label="Connection">{evidence.state}</EvidenceRow>
            <EvidenceRow label="Authentication">{evidence.authentication}</EvidenceRow>
            <EvidenceRow label="Health">{healthSentence(evidence.health, card.engine)}</EvidenceRow>
            <EvidenceRow label="Observed">
              {evidence.observedAt === null ? (
                <span className={styles.capacityMuted}>
                  no observation timestamp was reported
                </span>
              ) : (
                <span className={styles.num} title={new Date(evidence.observedAt).toLocaleString()}>
                  {relativePhrase(evidence.observedAt) ?? new Date(evidence.observedAt).toLocaleString()}
                </span>
              )}
            </EvidenceRow>
            <EvidenceRow label="Probe reason">
              {evidence.reasonCode === null ? (
                <span className={styles.capacityMuted}>none reported</span>
              ) : (
                <code className={styles.commandInline}>{evidence.reasonCode}</code>
              )}
            </EvidenceRow>
            {evidence.unsupported ? (
              <EvidenceRow label="Version pin">
                <code className={styles.commandInline}>{evidence.unsupported.code}</code>
                {evidence.unsupported.pinnedVersion ? (
                  <>
                    {' '}
                    pinned to <span className={styles.num}>{evidence.unsupported.pinnedVersion}</span>
                    . A one-line constant bump, not an outage.
                  </>
                ) : null}
              </EvidenceRow>
            ) : null}
          </dl>

          {credits ? (
            <div className={styles.creditsRow}>
              <span className={styles.figureLabel}>{historical ? 'Last reported credits' : 'Credits'}</span>
              <span className={styles.num} title={credits.balance ?? undefined}>
                {credits.unlimited
                  ? 'unlimited'
                  : credits.balanceValue !== null
                    ? credits.balanceValue.toLocaleString('en-US', { maximumFractionDigits: 2 })
                    : (credits.balance ?? 'not reported')}
              </span>
              <p className={styles.reason}>
                {historical
                  ? 'Prior balance for context only; current access and spendability are unconfirmed.'
                  : 'Separate from the windows above; shown as the provider reports it.'}
              </p>
            </div>
          ) : null}

          {evidence.notes.length > 0 ? (
            <>
              <span className={styles.figureLabel}>Provider notes</span>
              <ul className={styles.noteList}>
                {evidence.notes.map((n) => (
                  <li key={n} className={styles.capacityMuted}>
                    {n}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      <p className={styles.sourceLine}>{NO_HISTORY_NOTE}</p>
    </section>
  );
}
