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
 *
 * Rows read like the drawer's (shell/needs-you-model needsYouRowView, one
 * copy): a "Patch · Claude run" label over a title that ends on a whole word
 * (two lines at most, the server's text as its tooltip), "2 files · +384 −0 ·
 * Test-and-repair loop" for a sandboxed run, the repo's short name, the seat
 * by its label ("Claude Max", the id on hover — never "claude-a"), and "38
 * days ago" with the exact local time on hover.
 */
import { Fragment, type ReactElement } from 'react';
import type { NeedsYouAction, NeedsYouItem, VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { useNow } from '../autonomy/use-ticker.js';
import { ENGINE_LABEL, isVerseEngine } from '../verse-model.js';
import { rankNeedsYou, silentSources } from './command-model.js';
import { anchorId, goToSection, openChat, openNeedsYou } from './nav.js';
import { postNeedsYouAction } from './surface-data.js';
import type { ActivityState } from '../shell/useActivity.js';
import { needsYouRowView, readableItemTitle, type NeedsYouRowView } from '../shell/needs-you-model.js';
import { NeedsYouRunFacts } from '../shell/NeedsYouList.js';
import { Card, CardNote } from './Surface.js';
import type { ConfirmSpec, SurfaceActions } from './actions.js';
import styles from './command.module.css';

export const NEEDS_YOU_CARD_LIMIT = 5;

/** Relative ages ("38 days ago") only need to stay true to the minute. */
const AGE_TICK_MS = 30_000;

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
    return { title: `${verb}?`, body: readableItemTitle(item).text, confirmLabel: action.label, destructive: action.destructive };
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

/** Seat id → display label (command-model `seatNames`). */
export type SeatNames = ReadonlyMap<string, string>;

/**
 * The row's kind label with its engine named the way every other surface
 * names it (verse-model ENGINE_LABEL): the shared title reader
 * (approvals-model `readableTitle`) keeps the wire's lower case for a
 * PARTIAL run, so "Patch · Claude run" sat beside "Patch · Partial claude
 * run". Only the trailing "<engine> run" eyebrow is touched.
 */
export function cardKindLabel(label: string | null): string | null {
  if (label === null) return null;
  return label.replace(/(^|· )(Partial )?([a-z][\w-]*) run$/, (_m, lead: string, partial: string | undefined, engine: string) => {
    const name = isVerseEngine(engine) ? ENGINE_LABEL[engine] : `${engine.charAt(0).toUpperCase()}${engine.slice(1)}`;
    return `${lead}${partial ?? ''}${name} run`;
  });
}

/** "binshield · #81 · Claude Max · 38 days ago" — the full repo, the seat id and the exact time ride in tooltips. */
function Meta({ item, view, seatNames }: { item: NeedsYouItem; view: NeedsYouRowView; seatNames: SeatNames | undefined }) {
  const s = item.subject;
  const parts: ReactElement[] = [];
  if (view.repo) parts.push(<span key="repo" className={styles.needsRepo} title={view.repoFull}>{view.repo}</span>);
  if (s.pr) parts.push(<span key="pr">#{s.pr}</span>);
  if (s.seatId) {
    // Unknown to both the roster and the budget route: the id is all there is.
    const name = seatNames?.get(s.seatId) ?? s.seatId;
    parts.push(<span key="seat" title={name === s.seatId ? undefined : s.seatId}>{name}</span>);
  }
  parts.push(<span key="age" title={view.ageStamp}>{view.age}</span>);
  return (
    <span className={styles.needsMeta}>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

export function NeedsYouRow({ item, actions, now, seatNames }: { item: NeedsYouItem; actions: SurfaceActions; now: number; seatNames?: SeatNames }) {
  const link = targetLink(item);
  const runnable = item.actions.filter((a) => a.request !== null);
  const view = needsYouRowView(item, now);
  const kind = cardKindLabel(view.kindLabel);
  return (
    <li className={styles.needsRow} data-severity={item.severity} id={anchorId(item.id)}>
      <span className={styles.sevDot} data-severity={item.severity} aria-hidden="true" />
      <div className={styles.needsText}>
        {kind ? <span className={styles.needsKind}>{kind}</span> : null}
        {/* Two lines at most, ending on a whole word; the server's title is the tooltip. */}
        <span className={styles.needsTitle} title={view.fullTitle}>
          <span className="visually-hidden">{SEVERITY_WORD[item.severity]}: </span>
          {view.title}
        </span>
        {view.run ? <NeedsYouRunFacts run={view.run} /> : null}
        {view.detail ? <span className={styles.needsDetail}>{view.detail}</span> : null}
        <Meta item={item} view={view} seatNames={seatNames} />
      </div>
      <div className={styles.needsActions}>
        {runnable.map((action) => (
          <Button
            key={action.kind}
            size="sm"
            variant={action.destructive ? 'danger' : action.kind === 'approve' ? 'primary' : 'subtle'}
            disabled={actions.busy || actions.readOnly}
            onClick={() =>
              actions.act(() => postNeedsYouAction(action.request!.path, action.request!.body), `${action.label}: ${view.title}`, {
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
    // `unavailable` is also where a FIRST poll that failed lands: only a
    // failure-free one (the route's 404) means "not in this build".
    const reason = state.error
      ? `Needs-you inbox unavailable. ${state.error}`
      : 'The Needs-you inbox is not in this build yet, so this card has no source.';
    return { activity: null, loading: false, reason, stale: false };
  }
  if (!state.data) return { activity: null, loading: true, reason: null, stale: false };
  return { activity: state.data, loading: false, reason: null, stale: state.status === 'stale' };
}

export function NeedsYouCard({
  state,
  actions,
  fleetLine,
  seatNames,
}: {
  state: ActivityState;
  actions: SurfaceActions;
  /** One line under "All clear"; null when the surface already says it (Command's "Autonomy is off" banner). */
  fleetLine: string | null;
  /** Labels for the seats items name; an id neither source knows is shown as sent. */
  seatNames?: SeatNames;
}) {
  const { activity, loading, reason, stale } = activityRead(state);
  const now = useNow(AGE_TICK_MS);
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
        <CardNote tone="unknown">{reason ?? "The inbox didn't answer."} This is not an all-clear.</CardNote>
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
            {fleetLine ? <span className={styles.allClearBody}>{fleetLine}</span> : null}
          </div>
        )
      ) : (
        <>
          <ul className={styles.needsList}>
            {shown.map((item) => (
              <NeedsYouRow key={item.id} item={item} actions={actions} now={now} seatNames={seatNames} />
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
