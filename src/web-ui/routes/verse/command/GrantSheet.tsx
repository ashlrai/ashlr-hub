/**
 * routes/verse/command/GrantSheet.tsx — the Touch ID sheet (SPEC-310B §6:
 * "Raising it past the grant opens the Touch ID sheet, which shows scope and
 * expiry"; unit C7).
 *
 * It shows EXACTLY what the custody helper will sign — the server's draft
 * StandingGrantV1 and its digest — before anything is sent: repos and how
 * far each may go, merge caps, spend (mode ceiling, metered dollars, every
 * seat's reserve floor), engines, the Leader's classes and veto window, the
 * rollout ladder with each rung's exit criteria, and the expiry. Approving
 * echoes the draft's digest back, so the server signs what Mason read, not
 * whatever it would draft a second later. The Touch ID prompt itself is the
 * helper's, on this Mac; this page never sees a key.
 *
 * All copy is plain text; the draft is server data but rendered as text only.
 */
import { useId } from 'react';
import type { AuthorityGrantDraft, RolloutStage, StandingGrantV1 } from '../../../../core/authority/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { IconLock } from '../../../components/primitives/icons.js';
import { useQuery } from '../../../data/hooks.js';
import { authorityDraftQuery, type OptionalRead } from './surface-data.js';
import { SWITCH_LABEL } from './authority-model.js';
import { CardNote, MicroLabel } from './Surface.js';
import type { AutonomySwitch } from '../../../../core/authority/types.js';
import styles from './command.module.css';

export type GrantIntent = 'grant' | 're-approve';

export interface GrantSheetProps {
  open: boolean;
  intent: GrantIntent;
  /** The switch position the operator asked for (applied after the grant, if it allows it). */
  then: AutonomySwitch | null;
  busy: boolean;
  /** Why the sheet opened, in one sentence ("Autonomous needs a new grant."). */
  why: string;
  onApprove: (draft: AuthorityGrantDraft) => void;
  onClose: () => void;
}

const DAY = 86_400_000;

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

export function grantDays(g: Pick<StandingGrantV1, 'issuedAt' | 'expiresAt'>): number | null {
  const a = Date.parse(g.issuedAt);
  const b = Date.parse(g.expiresAt);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null;
}

function stageLine(s: RolloutStage): string {
  const c = s.criteria;
  const parts = [
    `${s.repos.length} repo${s.repos.length === 1 ? '' : 's'}`,
    `${s.maxRisk} risk`,
    `≤ ${s.maxFiles} files / ${s.maxLines} lines`,
    `≤ ${s.maxMergesPerRepoPerDay} merges/repo/day`,
  ];
  const exit = [`${c.minMerges} merges`, `${c.minHours} h`, c.minPostMergeGreenPct ? `≥ ${c.minPostMergeGreenPct}% green` : null, `≤ ${c.maxRevertRatePct}% reverts`].filter(Boolean);
  return `${parts.join(' · ')} — advances after ${exit.join(', ')}`;
}

export function DraftScope({ draft }: { draft: AuthorityGrantDraft }) {
  const g = draft.payload;
  const days = grantDays(g);
  return (
    <div className={styles.scope}>
      <section className={styles.scopeBlock} aria-label="Expiry">
        <MicroLabel>Expiry</MicroLabel>
        <p className={styles.scopeLead}>
          {days !== null ? `${days} days` : '—'}, until {fmtDate(g.expiresAt)}
        </p>
        <p className={styles.scopeMeta}>
          Signed by key <span className={styles.mono}>{g.keyId}</span> · sequence {g.grantSeq} · bound to this Mac
        </p>
      </section>

      <section className={styles.scopeBlock} aria-label="Repositories">
        <MicroLabel>Repositories ({g.repos.length})</MicroLabel>
        <table className={styles.scopeTable}>
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Up to</th>
              <th scope="col">Checks</th>
              <th scope="col">Risk</th>
              <th scope="col" className={styles.num}>Merges/day</th>
            </tr>
          </thead>
          <tbody>
            {g.repos.map((r) => (
              <tr key={r.nameWithOwner}>
                <td className={styles.mono}>{r.nameWithOwner}</td>
                <td>{r.stage === 'merge' ? 'Merge' : 'Propose'}</td>
                <td>{r.enforcement === 'server' ? 'GitHub' : 'Local only'}</td>
                <td>{r.maxRisk}</td>
                <td className={styles.num}>{r.maxMergesPerDay}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.scopeMeta}>
          Every merge ≤ {g.merge.maxFiles} files / {g.merge.maxLines} lines · ashlr-hub itself: {g.merge.selfRepo === 'propose-only' ? 'propose only' : 'merge outside authority code'}
        </p>
      </section>

      <section className={styles.scopeBlock} aria-label="Spend">
        <MicroLabel>Spend</MicroLabel>
        <p className={styles.scopeLead}>
          Up to {g.spend.maxMode === 'all-in' ? 'All-in' : g.spend.maxMode === 'balanced' ? 'Balanced' : 'Reserve'} · metered APIs ${g.spend.meteredUsdPerDay}/day
        </p>
        <ul className={styles.scopeList}>
          {Object.entries(g.spend.seats).map(([seatId, seat]) => (
            <li key={seatId}>
              <span className={styles.mono}>{seatId}</span>
              {seat.enabled ? `: keeps ${seat.reserveFloorPercent}% for you` : ': not used by autonomy'}
              {seat.enabled && seat.maxSessionWindowPercent !== undefined ? `, never above ${seat.maxSessionWindowPercent}% of its 5-hour window` : ''}
              {seat.enabled ? ` · ${seat.roles.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.scopeBlock} aria-label="Engines and Leader">
        <MicroLabel>Engines and Leader</MicroLabel>
        <p className={styles.scopeLead}>{g.engines.join(', ') || 'none'}</p>
        <p className={styles.scopeMeta}>
          Leader classes {g.leader.classes.length ? g.leader.classes.join(' + ') : 'none (proposes only)'} · class-B veto window {g.leader.vetoMinutes} min ·
          goal conductor {g.conductorGoals ? 'on' : 'off'}
        </p>
      </section>

      <section className={styles.scopeBlock} aria-label="Rollout ladder">
        <MicroLabel>Rollout ladder ({g.rollout.stages.length} stages, advances by itself)</MicroLabel>
        <ol className={styles.ladder}>
          {g.rollout.stages.map((s) => (
            <li key={s.id}>
              <span className={styles.ladderId}>{s.id}</span>
              <span>{stageLine(s)}</span>
            </li>
          ))}
        </ol>
        <p className={styles.scopeMeta}>Any sandbox violation or reserve breach drops it back one stage. It can never climb past the last stage.</p>
      </section>

      <p className={styles.scopeMeta}>
        Draft digest <span className={styles.mono}>{draft.digest.slice(0, 16)}…</span>
      </p>
    </div>
  );
}

export function GrantSheet({ open, intent, then, busy, why, onApprove, onClose }: GrantSheetProps) {
  const titleId = useId();
  // Only read the draft while the sheet is open: drafting is cheap on the
  // server, but a draft read while the sheet is closed would be stale by the
  // time anyone approved it.
  return open ? <GrantSheetBody titleId={titleId} intent={intent} then={then} busy={busy} why={why} onApprove={onApprove} onClose={onClose} /> : null;
}

function GrantSheetBody({ titleId, intent, then, busy, why, onApprove, onClose }: Omit<GrantSheetProps, 'open'> & { titleId: string }) {
  const read = useQuery(authorityDraftQuery, { freshMs: 0 });
  const draft = (read.data as OptionalRead<AuthorityGrantDraft> | undefined)?.value ?? null;
  const reason = read.data?.reason ?? null;
  return (
    <Sheet
      open
      onClose={onClose}
      titleId={titleId}
      width={600}
      title={intent === 're-approve' ? 'Re-approve the standing grant' : 'Approve a standing grant'}
      description={why}
      footer={
        <div className={styles.sheetFooter}>
          <p className={styles.sheetFootnote}>
            Touch ID appears on this Mac. Lowering authority — Off, Stop, Revoke — never needs it.
            {then ? ` After approval the switch moves to ${SWITCH_LABEL[then]}.` : ''}
          </p>
          <span className={styles.sheetButtons}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<IconLock />} disabled={!draft} busy={busy} onClick={() => draft && onApprove(draft)}>
              Approve with Touch ID
            </Button>
          </span>
        </div>
      }
    >
      {read.status === 'loading' && !read.data ? (
        <p className={styles.muted} aria-busy="true">Preparing the grant draft…</p>
      ) : draft ? (
        <DraftScope draft={draft} />
      ) : (
        <CardNote tone="unknown">{reason ?? 'Grant draft unreadable — nothing to approve.'}</CardNote>
      )}
    </Sheet>
  );
}
