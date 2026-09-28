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
import { useId, useState } from 'react';
import type { AuthorityGrantDraft, RolloutStage, StandingGrantV1 } from '../../../../core/authority/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { IconLock } from '../../../components/primitives/icons.js';
import { useQuery } from '../../../data/hooks.js';
import { authorityDraftQuery, authorityEliteDraftQuery, type OptionalRead } from './surface-data.js';
import { SWITCH_LABEL } from './authority-model.js';
import { CardNote, MicroLabel } from './Surface.js';
import type { AutonomySwitch } from '../../../../core/authority/types.js';
import type { SurfaceActions } from './actions.js';
import { GrantDiff, GrantScopeEditor, postGrantDraft, type EditableGrantDraft } from './GrantScopeEditor.js';
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
  /**
   * 3.15: the surface's guarded action. With it the sheet can EDIT the draft's
   * scope (repos, engines, Leader classes, caps, days) before signing — the
   * token prompt comes first, like every write. Without it, view-only.
   */
  act?: SurfaceActions['act'];
  /** 3.15: open straight into the scope editor (Fleet's "Edit scope"). */
  startEditing?: boolean;
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

/** The reserved rung id (authority/elite-models.ts ELITE_DIRECT_STAGE_ID; the web bundle keeps its own copy). */
const ELITE_DIRECT_STAGE_ID = 'elite-direct';

/** One line the sheet shows for an elite-direct grant — what Mason is signing. */
export const ELITE_DIRECT_SHEET_LINE =
  'Elite models (Opus 5.5/5, Fable 5.1/5, Sonnet 5, GPT-6 Astra/Sol/Luna, Grok 4.7/4.6, SWE-2, Qwen 3.8 27B) land directly on green tests — no judge. '
  + 'Other models still need an independent judge; changes to authority code still come to you.';

function stageLine(s: RolloutStage): string {
  const c = s.criteria;
  if (s.id === ELITE_DIRECT_STAGE_ID) {
    return `${s.repos.filter((r) => r.stage === 'merge').length} of ${s.repos.length} repos merge · ${s.maxRisk} risk · ≤ ${s.maxFiles} files / ${s.maxLines} lines — one rung, no ramp; elite models land on green tests, no judge`;
  }
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
        {g.rollout.stages.some((s) => s.id === ELITE_DIRECT_STAGE_ID) ? (
          <>
            <MicroLabel>Elite direct</MicroLabel>
            <p className={styles.scopeLead}>{ELITE_DIRECT_SHEET_LINE}</p>
          </>
        ) : (
          <MicroLabel>Rollout ladder ({g.rollout.stages.length} stages, advances by itself)</MicroLabel>
        )}
        <ol className={styles.ladder}>
          {g.rollout.stages.map((s) => (
            <li key={s.id}>
              <span className={styles.ladderId}>{s.id}</span>
              <span>{stageLine(s)}</span>
            </li>
          ))}
        </ol>
        <p className={styles.scopeMeta}>
          {g.rollout.stages.length === 1 && g.rollout.stages[0]?.id === ELITE_DIRECT_STAGE_ID
            ? 'A sandbox violation, reserve breach, or reverts above 10% restart this rung’s evidence window. Elite direct remains the signed merge ceiling until you stop, revoke, or replace the grant.'
            : 'Any sandbox violation or reserve breach drops it back one stage. It can never climb past the last stage.'}
        </p>
      </section>

      <p className={styles.scopeMeta}>
        Draft digest <span className={styles.mono}>{draft.digest.slice(0, 16)}…</span>
      </p>
    </div>
  );
}

export function GrantSheet({ open, intent, then, busy, why, onApprove, onClose, act, startEditing }: GrantSheetProps) {
  const titleId = useId();
  // Only read the draft while the sheet is open: drafting is cheap on the
  // server, but a draft read while the sheet is closed would be stale by the
  // time anyone approved it.
  return open ? <GrantSheetBody titleId={titleId} intent={intent} then={then} busy={busy} why={why} onApprove={onApprove} onClose={onClose} {...(act ? { act } : {})} startEditing={startEditing === true} /> : null;
}

function GrantSheetBody({ titleId, intent, then, busy, why, onApprove, onClose, act, startEditing }: Omit<GrantSheetProps, 'open'> & { titleId: string }) {
  const [elite, setElite] = useState(false);
  const eliteHintId = useId();
  const read = useQuery(elite ? authorityEliteDraftQuery : authorityDraftQuery, { freshMs: 0 });
  const served = (read.data as OptionalRead<EditableGrantDraft> | undefined)?.value ?? null;
  // 3.15: Mason's edited draft (the server's answer to the editor) replaces
  // the served one; approving signs exactly the draft on screen (its digest).
  const [edited, setEdited] = useState<EditableGrantDraft | null>(null);
  const [editing, setEditing] = useState(startEditing === true);
  const [editError, setEditError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // A late preview from the previous ladder must never replace the new one.
  const draft: EditableGrantDraft | null = edited && edited.eliteDirect === served?.eliteDirect ? edited : served;
  const reason = read.data?.reason ?? null;
  const canEdit = act !== undefined && served?.editable !== undefined;
  const fixedElite = served?.kind === 'reapprove' && served.eliteDirect === true;

  function preview(scope: Parameters<typeof postGrantDraft>[1]): void {
    if (!act || !served) return;
    const kind = served.kind ?? 'auto';
    setEditError(null);
    setPreviewing(true);
    act(
      async () => {
        try {
          return await postGrantDraft(kind, scope, served.eliteDirect === true);
        } catch (error) {
          setEditError(error instanceof Error ? error.message : String(error));
          return null;
        } finally {
          setPreviewing(false);
        }
      },
      'Preview the edited grant',
      {
        onDone: (next) => {
          if (next && typeof next === 'object' && typeof next.digest === 'string' && next.eliteDirect === served.eliteDirect) setEdited(next);
        },
      },
    );
  }
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
      <label className={styles.eliteToggle}>
        <input type="checkbox" checked={elite || fixedElite} disabled={previewing || busy || fixedElite} onChange={(e) => { setElite(e.target.checked); setEdited(null); setEditError(null); }} aria-describedby={eliteHintId} />
        Elite direct
      </label>
      <p id={eliteHintId} className={styles.scopeMeta}>
        {ELITE_DIRECT_SHEET_LINE}
      </p>
      {read.status === 'loading' && !read.data ? (
        <p className={styles.muted} aria-busy="true">Preparing the grant draft…</p>
      ) : draft ? (
        <>
          {canEdit ? (
            <div className={styles.scopeEditToggle}>
              <Button variant="ghost" size="sm" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
                {editing ? 'Hide the scope editor' : 'Edit scope'}
              </Button>
              {edited ? <span className={styles.scopeMeta}>Showing your edited draft.</span> : null}
            </div>
          ) : null}
          {canEdit && editing && served ? (
            <GrantScopeEditor
              draft={served as EditableGrantDraft}
              busy={previewing}
              edited={edited !== null}
              onPreview={preview}
              onReset={() => {
                setEdited(null);
                setEditError(null);
              }}
            />
          ) : null}
          {editError ? <CardNote tone="danger">{editError}</CardNote> : null}
          <GrantDiff lines={draft.diff} />
          <DraftScope draft={draft} />
        </>
      ) : (
        <CardNote tone="unknown">{reason ?? 'Grant draft unreadable — nothing to approve.'}</CardNote>
      )}
    </Sheet>
  );
}
