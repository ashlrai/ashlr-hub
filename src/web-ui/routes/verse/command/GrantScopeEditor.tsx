/**
 * routes/verse/command/GrantScopeEditor.tsx — edit a grant draft's scope
 * before signing it (3.15), inside the Touch ID sheet.
 *
 * The editor chooses available scope and explicitly reviewed volume limits: repos from the draft
 * (the enrolled repos + the canary), engines the draft offers (the four fleet
 * lanes, plus Devin when the custody helper can sign it), Leader classes A/B,
 * the budget ceiling, metered dollars, the days, and per-change/per-repo volume. "Preview" sends the choice
 * to POST /api/verse/authority/draft, which applies it to its OWN draft
 * (authority/grant-scope.ts), re-validates it and answers the new draft with a
 * diff against the grant in force. What gets signed is exactly that returned
 * draft (its digest) — the helper then shows the scope again in its own Touch
 * ID prompt. Nothing here can sign, and nothing here holds a secret.
 */
import { useId, useState } from 'react';
import type { AuthorityGrantDraft, LeaderGrantClass, SeatRole } from '../../../../core/authority/types.js';
import type { GrantDiffLine, GrantDraftEditable, GrantScopeEdit, GrantSeatPolicyEdit } from '../../../../core/authority/grant-scope-types.js';
import type { GrantEngine } from '../../../../core/fleet/fleet-types.js';
import type { BudgetMode } from '../../../../core/routing/types.js';
import { apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { Button } from '../../../components/primitives/Button.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { AUTHORITY_DRAFT_PATH } from './surface-data.js';
import { MicroLabel } from './Surface.js';
import styles from './command.module.css';

/** The draft with the 3.15 additions the editor reads (absent from an older server). */
export interface EditableGrantDraft extends AuthorityGrantDraft {
  kind?: 'new' | 'reapprove';
  summary?: string[];
  startStageId?: string;
  diff?: GrantDiffLine[];
  editable?: GrantDraftEditable;
  eliteDirect?: boolean;
}

/** A draft with Mason's scope edits applied server-side, within its own draft. */
export async function postGrantDraft(kind: 'new' | 'reapprove' | 'auto', scope: GrantScopeEdit, eliteDirect?: boolean): Promise<EditableGrantDraft> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<EditableGrantDraft>(AUTHORITY_DRAFT_PATH, { kind, scope, ...(eliteDirect === undefined ? {} : { eliteDirect }) }, token);
  touchMutationHold();
  return result;
}

const ENGINE_LABEL: Record<string, string> = {
  'claude-cli': 'Claude Code (claude-cli)',
  codex: 'Codex',
  'grok-cli': 'Grok (grok-cli)',
  devin: 'Devin',
  'devin-cli': 'Devin CLI',
  local: 'Local models',
};

/** Editing only budget/scope must never opt a legacy grant into wider local limits. */
function VolumeInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const unlimited = value === String(Number.MAX_SAFE_INTEGER);
  return <div>
    <label className={styles.scopeField} htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" min={label === 'Files per change' || label === 'Lines per change' ? 1 : 0} max={Number.MAX_SAFE_INTEGER} step={1} inputMode="numeric" disabled={unlimited} value={unlimited ? '' : value} onChange={(e) => onChange(e.target.value)} />
    </label>
    <label className={styles.scopeCheck}>
      <input type="checkbox" checked={unlimited} aria-label={`No volume cap: ${label}`} onChange={(e) => onChange(e.target.checked ? String(Number.MAX_SAFE_INTEGER) : '1')} />
      <span>No volume cap</span>
    </label>
  </div>;
}

interface SeatInputs {
  enabled: boolean;
  roles: SeatRole[];
  reserve: string;
  session: string;
  ceiling: boolean;
}

function SeatPolicyInputs({ id, value, roles, onChange }: { id: string; value: SeatInputs; roles: SeatRole[]; onChange: (field: keyof GrantSeatPolicyEdit, change: Partial<SeatInputs>) => void }) {
  const controlId = useId();
  return <fieldset className={styles.scopeFieldset}>
    <legend>{id}</legend>
    <label className={styles.scopeCheck}>
      <input type="checkbox" checked={value.enabled} onChange={(e) => onChange('enabled', { enabled: e.target.checked })} />
      <span>Permit autonomy on {id}</span>
    </label>
    {roles.map((role) => <label key={role} className={styles.scopeCheck}>
      <input type="checkbox" checked={value.roles.includes(role)} onChange={(e) => onChange('roles', { roles: toggle(value.roles, role, e.target.checked) })} />
      <span>{id}: {role}</span>
    </label>)}
    <label className={styles.scopeField} htmlFor={`${controlId}-reserve`}>
      <span>{id}: reserve for you (%)</span>
      <input id={`${controlId}-reserve`} type="number" min={0} max={100} step={1} inputMode="numeric" value={value.reserve} onChange={(e) => onChange('reserveFloorPercent', { reserve: e.target.value })} />
    </label>
    <label className={styles.scopeCheck}>
      <input type="checkbox" checked={!value.ceiling} onChange={(e) => onChange('maxSessionWindowPercent', { ceiling: !e.target.checked })} />
      <span>{id}: No session ceiling</span>
    </label>
    <label className={styles.scopeField} htmlFor={`${controlId}-session`}>
      <span>{id}: session usage ceiling (%)</span>
      <input id={`${controlId}-session`} type="number" min={1} max={100} step={1} inputMode="numeric" disabled={!value.ceiling} value={value.ceiling ? value.session : ''} onChange={(e) => onChange('maxSessionWindowPercent', { session: e.target.value })} />
    </label>
  </fieldset>;
}

const MODE_LABEL: Record<BudgetMode, string> = { reserve: 'Reserve', balanced: 'Balanced', 'all-in': 'All-in' };

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((v) => v !== value);
}

function daysOf(draft: AuthorityGrantDraft): number {
  const d = Math.round((Date.parse(draft.payload.expiresAt) - Date.parse(draft.payload.issuedAt)) / 86_400_000);
  return Number.isFinite(d) && d > 0 ? d : 30;
}

export interface GrantScopeEditorProps {
  draft: EditableGrantDraft;
  busy: boolean;
  /** Ask the server for the edited draft (the sheet runs it through the token guard). */
  onPreview: (scope: GrantScopeEdit) => void;
  onReset: () => void;
  edited: boolean;
  onAccountSettings?: () => void;
  onResources?: () => void;
  onDirty?: () => void;
}

export function GrantScopeEditor({ draft, busy, onPreview, onReset, edited, onAccountSettings, onResources, onDirty }: GrantScopeEditorProps) {
  const base = draft.editable;
  const g = draft.payload;
  const [repos, setRepos] = useState<string[]>(() => g.repos.map((r) => r.nameWithOwner));
  const [engines, setEngines] = useState<string[]>(() => [...g.engines]);
  const [classes, setClasses] = useState<string[]>(() => [...g.leader.classes]);
  const [mode, setMode] = useState<BudgetMode>(g.spend.maxMode);
  const [metered, setMetered] = useState<string>(String(g.spend.meteredUsdPerDay));
  const [days, setDays] = useState<string>(String(daysOf(draft)));
  const [files, setFiles] = useState(String(g.merge.maxFiles));
  const [lines, setLines] = useState(String(g.merge.maxLines));
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries(g.repos.map((r) => [r.nameWithOwner, String(r.maxMergesPerDay)])));
  const [volumeEdited, setVolumeEdited] = useState(false);
  const [seats, setSeats] = useState<Record<string, SeatInputs>>(() => Object.fromEntries(Object.entries(g.spend.seats).map(([id, seat]) => [id, { enabled: seat.enabled, roles: [...seat.roles], reserve: String(seat.reserveFloorPercent), session: String(seat.maxSessionWindowPercent ?? 70), ceiling: seat.maxSessionWindowPercent !== undefined }])));
  const [seatFields, setSeatFields] = useState<Record<string, (keyof GrantSeatPolicyEdit)[]>>({});
  function changeSeat(id: string, field: keyof GrantSeatPolicyEdit, change: Partial<SeatInputs>): void {
    setSeats((current) => ({ ...current, [id]: { ...current[id]!, ...change } }));
    setSeatFields((current) => ({ ...current, [id]: toggle(current[id] ?? [], field, true) }));
  }

  const ids = { metered: useId(), days: useId(), mode: useId() };
  if (!base) {
    return <p className={styles.scopeMeta}>This server cannot edit a draft yet — update Ashlr to choose repos and engines here.</p>;
  }
  const meteredN = Number(metered);
  const daysN = Number(days);
  const volumeValid = !volumeEdited || (Number.isSafeInteger(Number(files)) && Number(files) > 0 && Number.isSafeInteger(Number(lines)) && Number(lines) > 0 && repos.every((repo) => rates[repo] !== undefined && rates[repo] !== '' && Number.isSafeInteger(Number(rates[repo])) && Number(rates[repo]) >= 0));
  const seatValid = Object.keys(seatFields).every((id) => {
    const seat = seats[id]!;
    return seat.roles.length > 0 && seat.reserve !== '' && Number.isInteger(Number(seat.reserve)) && Number(seat.reserve) >= 0 && Number(seat.reserve) <= 100
      && (!seat.ceiling || (seat.session !== '' && Number.isInteger(Number(seat.session)) && Number(seat.session) >= 1 && Number(seat.session) <= 100));
  });
  const valid = seatValid && volumeValid && repos.length > 0 && engines.length > 0 && Number.isInteger(meteredN) && meteredN >= 0 && Number.isInteger(daysN) && daysN >= 1 && daysN <= base.maxDays;

  function preview(): void {
    onPreview({
      repos,
      engines: engines as GrantEngine[],
      leaderClasses: classes as LeaderGrantClass[],
      maxMode: mode,
      meteredUsdPerDay: meteredN,
      days: daysN,
      ...(base?.seatPolicies && Object.keys(seatFields).length ? { seatPolicies: Object.fromEntries(Object.entries(seatFields).map(([id, fields]) => {
        const seat = seats[id]!;
        const policy: GrantSeatPolicyEdit = {};
        if (fields.includes('enabled')) policy.enabled = seat.enabled;
        if (fields.includes('roles')) policy.roles = seat.roles;
        if (fields.includes('reserveFloorPercent')) policy.reserveFloorPercent = Number(seat.reserve);
        if (fields.includes('maxSessionWindowPercent')) policy.maxSessionWindowPercent = seat.ceiling ? Number(seat.session) : null;
        return [id, policy];
      })) } : {}),
      ...(base?.volumeLimits && volumeEdited ? {
        maxFiles: Number(files), maxLines: Number(lines),
        repoMaxMergesPerDay: Object.fromEntries(repos.map((repo) => [repo, Number(rates[repo])])),
      } : {}),
    });
  }

  return (
    <div className={styles.scopeEditor} aria-label="Edit the grant scope" onChange={onDirty}>
      <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Repositories ({repos.length}/{base.repos.length})</MicroLabel></legend>
        {base.repos.map((repo) => (
          <label key={repo} className={styles.scopeCheck}>
            <input type="checkbox" checked={repos.includes(repo)} onChange={(e) => setRepos(toggle(repos, repo, e.target.checked))} />
            <span className={styles.mono}>{repo}</span>
          </label>
        ))}
        <p className={styles.scopeMeta}>Only enrolled repos can be granted. Enroll another checkout to add it here.</p>
      </fieldset>
      <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Engines</MicroLabel></legend>
        {base.engines.map((engine) => (
          <label key={engine} className={styles.scopeCheck}>
            <input type="checkbox" checked={engines.includes(engine)} onChange={(e) => setEngines(toggle(engines, engine, e.target.checked))} />
            <span>{ENGINE_LABEL[engine] ?? engine}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Leader may act</MicroLabel></legend>
        {base.leaderClasses.map((c) => (
          <label key={c} className={styles.scopeCheck}>
            <input type="checkbox" checked={classes.includes(c)} onChange={(e) => setClasses(toggle(classes, c, e.target.checked))} />
            <span>Class {c}{c === 'A' ? ' — reversible housekeeping' : ' — larger changes, with a veto window'}</span>
          </label>
        ))}
      </fieldset>
      {base.volumeLimits ? <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Signed volume limits</MicroLabel></legend>
        <label className={styles.scopeCheck}>
          <input type="checkbox" checked={volumeEdited} onChange={(e) => setVolumeEdited(e.target.checked)} />
          <span>Replace volume limits for all models and enforcement modes</span>
        </label>
        <p className={styles.scopeMeta}>An explicit choice applies these size limits to every rollout stage and these daily limits to merging stages. Local work keeps its risk and verification rules. Unchanged or renewed grants keep their existing volume policy. Preview shows the change before Touch ID.</p>
        <VolumeInput label="Files per change" value={files} onChange={(value) => { setFiles(value); setVolumeEdited(true); }} />
        <VolumeInput label="Lines per change" value={lines} onChange={(value) => { setLines(value); setVolumeEdited(true); }} />
        {repos.map((repo) => <VolumeInput key={repo} label={`${repo} merges/day`} value={rates[repo] ?? ''} onChange={(value) => { setRates((current) => ({ ...current, [repo]: value })); setVolumeEdited(true); }} />)}
      </fieldset> : null}
      <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Budget caps</MicroLabel></legend>
        <label className={styles.scopeField} htmlFor={ids.mode}>
          <span>Budget mode up to</span>
          <select id={ids.mode} value={mode} onChange={(e) => setMode(e.target.value as BudgetMode)}>
            {(['reserve', 'balanced', 'all-in'] as const).map((m) => (
              <option key={m} value={m}>{MODE_LABEL[m]}</option>
            ))}
          </select>
        </label>
        <label className={styles.scopeField} htmlFor={ids.metered}>
          <span>Metered APIs, $ per day</span>
          <input id={ids.metered} type="number" min={0} step={1} inputMode="numeric" value={metered} onChange={(e) => setMetered(e.target.value)} />
        </label>
        <label className={styles.scopeField} htmlFor={ids.days}>
          <span>Valid for (days, at most {base.maxDays})</span>
          <input id={ids.days} type="number" min={1} max={base.maxDays} step={1} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </fieldset>
      {base.seatPolicies ? <fieldset className={styles.scopeFieldset}>
        <legend><MicroLabel>Account permissions and reserves</MicroLabel></legend>
        <p className={styles.scopeMeta}>All-in does not remove account reserves or session ceilings. Set 0% reserve or No session ceiling explicitly. These are standing permissions; current budget settings, known usage and provider readiness may tighten them further. A producer role does not qualify an unsupported provider.</p>
        <p className={styles.scopeMeta}>Current Budget settings are in Apps &amp; Accounts; Resources shows usage and readiness. Opening either leaves this unsigned draft.</p>
        <span className={styles.sheetButtons}>
          {onAccountSettings ? <Button variant="ghost" size="sm" onClick={onAccountSettings}>Current account settings</Button> : null}
          {onResources ? <Button variant="ghost" size="sm" onClick={onResources}>Resources</Button> : null}
        </span>
        {Object.entries(base.seatPolicies).filter(([id]) => seats[id] !== undefined).map(([id, policy]) => <SeatPolicyInputs key={id} id={id} value={seats[id]!} roles={policy.roles} onChange={(field, change) => changeSeat(id, field, change)} />)}
      </fieldset> : null}
      <span className={styles.sheetButtons}>
        {edited ? (
          <Button variant="ghost" size="sm" onClick={onReset}>
            Back to the default draft
          </Button>
        ) : null}
        <Button variant="subtle" size="sm" onClick={preview} disabled={!valid} busy={busy}>
          Preview the changes
        </Button>
      </span>
      {!valid ? <p className={styles.scopeMeta}>Keep at least one repo and one engine, whole dollars, at least one role per edited account, whole reserve percentages (0–100) and session ceilings (1–100), positive whole size limits, nonnegative whole merge limits, and 1–{base.maxDays} days.</p> : null}
    </div>
  );
}

const DIRECTION_WORD: Record<GrantDiffLine['direction'], string> = { wider: 'wider', narrower: 'narrower', changed: 'changed' };

/** What signing this draft changes vs the grant in force. */
export function GrantDiff({ lines }: { lines: GrantDiffLine[] | undefined }) {
  if (!lines) return null;
  if (lines.length === 0) {
    return (
      <section className={styles.scopeBlock} aria-label="Changes">
        <MicroLabel>Changes vs the grant in force</MicroLabel>
        <p className={styles.scopeMeta}>Same scope as the grant in force.</p>
      </section>
    );
  }
  return (
    <section className={styles.scopeBlock} aria-label="Changes">
      <MicroLabel>Changes vs the grant in force</MicroLabel>
      <table className={styles.scopeTable}>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">Now</th>
            <th scope="col">After signing</th>
            <th scope="col">Authority</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={`${line.field}-${i}`} data-direction={line.direction}>
              <td>{line.label}</td>
              <td className={styles.mono}>{line.before}</td>
              <td className={styles.mono}>{line.after}</td>
              <td className={styles.diffDirection} data-direction={line.direction}>{DIRECTION_WORD[line.direction]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
