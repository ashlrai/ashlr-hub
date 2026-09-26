/**
 * routes/verse/usage/AccountCard.tsx — one account, answering one question:
 * can I use this right now, and what will it cost me.
 *
 * Layout order is the argument:
 *   1. the VERDICT, as a badge with text (never color alone);
 *   2. the BINDING window — the constraint that actually blocks work, given
 *      the full-width treatment, because Claude's weekly per-model window sat
 *      at 100% while its all-models window read 58% and leading with 58%
 *      would be a lie of emphasis;
 *   3. the other windows, compact, so the detail is there without competing;
 *   4. credits and plan, which for Codex are INDEPENDENT of the window — a
 *      100%-used week with a spendable balance is not blocked, and this card
 *      must not let it read that way;
 *   5. an action when there is one (signed out → reconnect).
 *
 * Identity is the 2px engine marker on the leading edge — the only
 * engine-hued element on the card (docs/VERSE-DESIGN-V2.md §2).
 *
 * The card HEAD is the control that opens the detail view. Making the whole
 * <article> clickable would have meant either a div with an onClick and no
 * keyboard path, or a <button> wrapping the window meters — and a `role=meter`
 * inside a button is not a thing assistive tech can make sense of. A real
 * button spanning the label and the verdict badge is a large target, is
 * reachable by keyboard for free, and carries `aria-expanded`/`aria-controls`
 * so the relationship to the detail region is announced rather than implied.
 */
import type { CSSProperties, ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
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

function CreditsRow({ credits }: { credits: AccountCardModel['credits'] }): ReactNode {
  if (!credits) return null;
  const value = credits.unlimited
    ? 'unlimited'
    : credits.balance !== null
      ? credits.balanceValue !== null
        ? credits.balanceValue.toLocaleString('en-US', { maximumFractionDigits: 2 })
        : credits.balance
      : null;

  return (
    <div className={styles.creditsRow}>
      <span className={styles.figureLabel}>Credits</span>
      <span className={styles.num} title={credits.balance ?? undefined}>
        {value ?? 'not reported'}
      </span>
      <p className={styles.reason}>
        Separate from the window above — spendable even when the window is full.
      </p>
    </div>
  );
}

export function AccountCard({
  card,
  onOpen,
  expanded = false,
  triggerId,
  detailId,
}: {
  card: AccountCardModel;
  /** Omitted when there is nothing to open — the head then stays inert text. */
  onOpen?: ((id: string) => void) | undefined;
  expanded?: boolean;
  triggerId?: string | undefined;
  detailId?: string | undefined;
}): ReactNode {
  const engineStyle = { '--engine-color': card.color } as CSSProperties;
  const showReconnect = card.verdict.state === 'signed-out';
  const openable = onOpen !== undefined && card.hasDetail;

  const head = (
    <>
      <span className={styles.cardLabel}>{card.label}</span>
      <StatusBadge status={card.verdict.state} tone={VERDICT_TONE[card.verdict.state]}>
        {card.verdict.headline}
      </StatusBadge>
    </>
  );

  return (
    <article
      className={styles.card}
      style={engineStyle}
      aria-label={`${card.label} usage`}
      data-selected={expanded ? 'true' : undefined}
    >
      {openable ? (
        <button
          type="button"
          id={triggerId}
          className={`${styles.cardHead} ${styles.cardTrigger}`}
          aria-expanded={expanded}
          {...(detailId ? { 'aria-controls': detailId } : {})}
          onClick={() => onOpen(card.id)}
        >
          {head}
          <span className={styles.cardChevron} aria-hidden="true">
            {expanded ? '\u2212' : '+'}
          </span>
        </button>
      ) : (
        <div className={styles.cardHead}>{head}</div>
      )}

      <div className={styles.cardMeta}>
        <span>{ENGINE_LABEL[card.engine]}</span>
        <span aria-hidden="true">·</span>
        <span>{card.plan ? `${card.plan} plan` : 'plan not reported'}</span>
      </div>

      <p className={styles.verdictDetail}>{card.verdict.detail}</p>
      {card.verdict.code ? (
        /* The verbatim probe/collector code, kept as evidence and as the thing
           to search for — but never as the card's sentence. */
        <p className={styles.sourceLine}>
          Probe reason <code className={styles.commandInline}>{card.verdict.code}</code>
        </p>
      ) : null}

      {card.binding ? (
        <>
          <span className={styles.bindingLabel}>Binding constraint</span>
          <WindowMeter view={card.binding} ariaPrefix={card.label} prominent />
        </>
      ) : null}

      {card.others.length > 0 ? (
        <div className={styles.windows}>
          {card.others.map((w) => (
            <WindowMeter key={w.id} view={w} ariaPrefix={card.label} />
          ))}
        </div>
      ) : null}

      <CreditsRow credits={card.credits} />

      {showReconnect ? (
        <div className={styles.actionBlock}>
          {card.reconnectCommand ? (
            <>
              <span className={styles.figureLabel}>Reconnect</span>
              <code className={styles.command}>{card.reconnectCommand}</code>
            </>
          ) : (
            <p className={styles.reason}>
              Sign this account back in through its own provider CLI under its pinned profile.
              Ashlr does not print that invocation here, because the pinned-profile launcher path is
              never allowed onto a surface. <code className={styles.commandInline}>ashlr resources</code>{' '}
              shows the connection state once it is back.
            </p>
          )}
        </div>
      ) : null}

      {card.sourceNote ? <p className={styles.sourceLine}>{card.sourceNote}</p> : null}
    </article>
  );
}
