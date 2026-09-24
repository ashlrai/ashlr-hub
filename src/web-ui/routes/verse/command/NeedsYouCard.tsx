/**
 * routes/verse/command/NeedsYouCard.tsx — Command's "Needs you" card (span 5
 * at 1440, FIRST at 375; SPEC-310C §5). The five most urgent items from the
 * one inbox (owner-lane PRs, class-C asks, veto windows, holds, grant
 * renewal, reconnects — R1 producers via C1's activity route), each with its
 * own actions. The full, keyboard-triaged list is the ⌘J drawer (C1); this
 * card is the glance and the one-click path.
 *
 * Honesty: when any producer did not answer, the card never says "All
 * clear" — it names the silent sources instead ("fleet not answering").
 * Every approve / reject / veto confirms first (NeedsYouAction contract),
 * then asks for the token; items render their text as plain text only.
 */
import type { NeedsYouAction, NeedsYouItem, VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { formatAge } from '../autonomy/format.js';
import { rankNeedsYou, silentSources } from './command-model.js';
import { anchorId, goToSection, openChat, openNeedsYou } from './nav.js';
import { postNeedsYouAction } from './surface-data.js';
import type { ActivityState } from '../shell/useActivity.js';
import { Card, CardNote } from './Surface.js';
import type { ConfirmSpec, SurfaceActions } from './actions.js';
import styles from './command.module.css';

export const NEEDS_YOU_CARD_LIMIT = 5;

const SEVERITY_WORD = { high: 'Urgent', warn: 'Soon', info: 'FYI' } as const;
const SOURCE_WORD: Record<string, string> = {
  approvals: 'approvals',
  authority: 'authority',
  fleet: 'fleet',
  leader: 'Leader',
  chats: 'chats',
  accounts: 'accounts',
};

/** Generic confirmation for the kinds the drawer always confirms (approve / reject / veto). */
export function confirmFor(item: NeedsYouItem, action: NeedsYouAction): ConfirmSpec | undefined {
  if (action.confirm) return { ...action.confirm, destructive: action.destructive };
  if (action.kind === 'approve' || action.kind === 'reject' || action.kind === 'veto') {
    const verb = action.kind === 'approve' ? 'Approve' : action.kind === 'reject' ? 'Reject' : 'Veto';
    return { title: `${verb}?`, body: item.title, confirmLabel: action.label, destructive: action.destructive };
  }
  return undefined;
}

function targetLink(item: NeedsYouItem): { label: string; onOpen?: () => void; href?: string } | null {
  const t = item.target;
  switch (t.kind) {
    case 'url':
      return /^https:\/\//.test(t.url) ? { label: 'Open', href: t.url } : null;
    case 'section':
      return { label: 'Show', onOpen: () => goToSection(t.section, t.anchor) };
    case 'session':
      return { label: 'Open chat', onOpen: () => openChat(t.sessionId) };
    case 'approval':
    case 'seat':
      return { label: 'Open', onOpen: () => openNeedsYou(item.id) };
    default:
      return null;
  }
}

function meta(item: NeedsYouItem): string {
  const s = item.subject;
  return [s.repo, s.pr ? `#${s.pr}` : null, s.seatId, formatAge(item.since)].filter(Boolean).join(' · ');
}

export function NeedsYouRow({ item, actions }: { item: NeedsYouItem; actions: SurfaceActions }) {
  const link = targetLink(item);
  const runnable = item.actions.filter((a) => a.request !== null);
  return (
    <li className={styles.needsRow} data-severity={item.severity} id={anchorId(item.id)}>
      <span className={styles.sevDot} data-severity={item.severity} aria-hidden="true" />
      <div className={styles.needsText}>
        <span className={styles.needsTitle}>
          <span className="visually-hidden">{SEVERITY_WORD[item.severity]}: </span>
          {item.title}
        </span>
        {item.detail ? <span className={styles.needsDetail}>{item.detail}</span> : null}
        <span className={styles.needsMeta}>{meta(item)}</span>
      </div>
      <div className={styles.needsActions}>
        {runnable.map((action) => (
          <Button
            key={action.kind}
            size="sm"
            variant={action.destructive ? 'danger' : action.kind === 'approve' ? 'primary' : 'subtle'}
            disabled={actions.busy || actions.readOnly}
            onClick={() =>
              actions.act(() => postNeedsYouAction(action.request!.path, action.request!.body), `${action.label}: ${item.title}`, {
                confirm: confirmFor(item, action),
              })
            }
          >
            {action.label}
          </Button>
        ))}
        {link ? (
          link.href ? (
            <a className={styles.linkButton} href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
              <IconExternalLink width={12} height={12} aria-hidden="true" />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          ) : (
            <button type="button" className={styles.linkButton} onClick={link.onOpen}>
              {link.label}
            </button>
          )
        ) : null}
      </div>
    </li>
  );
}

/** C1's activity store in the surfaces' OptionalRead words. */
export function activityRead(state: ActivityState): { activity: VerseActivityResponse | null; loading: boolean; reason: string | null; stale: boolean } {
  if (state.status === 'unavailable') {
    return { activity: null, loading: false, reason: 'The Needs-you inbox is not in this build yet, so this card has no source.', stale: false };
  }
  if (!state.data) return { activity: null, loading: true, reason: null, stale: false };
  return { activity: state.data, loading: false, reason: null, stale: state.status === 'stale' };
}

export function NeedsYouCard({ state, actions, fleetLine }: { state: ActivityState; actions: SurfaceActions; fleetLine: string }) {
  const { activity, loading, reason, stale } = activityRead(state);
  const items = activity ? rankNeedsYou(activity.needsYou) : [];
  const silent = silentSources(activity);
  const shown = items.slice(0, NEEDS_YOU_CARD_LIMIT);
  const count = activity ? activity.needsYou.length : null;
  return (
    <Card
      title={count === null ? 'Needs you' : `Needs you (${count})`}
      caption={count === null ? undefined : count === 0 ? undefined : 'Most urgent first'}
      tone={count ? 'attention' : undefined}
      actions={
        <button type="button" className={styles.linkButton} onClick={() => openNeedsYou()} aria-keyshortcuts="Meta+J">
          Open all <kbd className={styles.kbd}>⌘J</kbd>
        </button>
      }
    >
      {loading ? (
        <p className={styles.muted} aria-busy="true">Reading the inbox…</p>
      ) : !activity ? (
        <CardNote tone="unknown">{reason ?? 'The Needs-you inbox did not answer.'} Nothing is shown rather than a false all-clear.</CardNote>
      ) : shown.length === 0 ? (
        silent.length || stale ? (
          <CardNote tone="unknown">
            {silent.length
              ? `Nothing to show, but ${silent.map((s) => SOURCE_WORD[s] ?? s).join(', ')} ${silent.length === 1 ? 'is' : 'are'} not answering — this is not an all-clear.`
              : 'Nothing to show, but the last refresh failed — this is not an all-clear.'}
          </CardNote>
        ) : (
          <div className={styles.allClear} role="status">
            <span className={styles.allClearTitle}>All clear</span>
            <span className={styles.allClearBody}>{fleetLine}</span>
          </div>
        )
      ) : (
        <>
          <ul className={styles.needsList}>
            {shown.map((item) => (
              <NeedsYouRow key={item.id} item={item} actions={actions} />
            ))}
          </ul>
          {items.length > shown.length ? (
            <button type="button" className={styles.moreLink} onClick={() => openNeedsYou()}>
              {items.length - shown.length} more in the drawer
            </button>
          ) : null}
          {silent.length ? (
            <p className={styles.muted}>{silent.map((s) => SOURCE_WORD[s] ?? s).join(', ')} not answering — the list may be incomplete.</p>
          ) : null}
          {stale ? <p className={styles.muted}>The last refresh failed; showing the previous list.</p> : null}
        </>
      )}
    </Card>
  );
}
