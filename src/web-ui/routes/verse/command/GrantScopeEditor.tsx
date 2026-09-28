/**
 * routes/verse/command/GrantScopeEditor.tsx — edit a grant draft's scope
 * before signing it (3.15), inside the Touch ID sheet.
 *
 * The editor only CHOOSES within the server's draft: repos from the draft
 * (the enrolled repos + the canary), engines the draft offers (the four fleet
 * lanes, plus Devin when the custody helper can sign it), Leader classes A/B,
 * the budget ceiling, metered dollars and the days. "Preview" sends the choice
 * to POST /api/verse/authority/draft, which applies it to its OWN draft
 * (authority/grant-scope.ts), re-validates it and answers the new draft with a
 * diff against the grant in force. What gets signed is exactly that returned
 * draft (its digest) — the helper then shows the scope again in its own Touch
 * ID prompt. Nothing here can sign, and nothing here holds a secret.
 */
import { useId, useState } from 'react';
import type { AuthorityGrantDraft, LeaderGrantClass } from '../../../../core/authority/types.js';
import type { GrantDiffLine, GrantDraftEditable, GrantScopeEdit } from '../../../../core/authority/grant-scope-types.js';
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
}

export function GrantScopeEditor({ draft, busy, onPreview, onReset, edited }: GrantScopeEditorProps) {
  const base = draft.editable;
  const g = draft.payload;
  const [repos, setRepos] = useState<string[]>(() => g.repos.map((r) => r.nameWithOwner));
  const [engines, setEngines] = useState<string[]>(() => [...g.engines]);
  const [classes, setClasses] = useState<string[]>(() => [...g.leader.classes]);
  const [mode, setMode] = useState<BudgetMode>(g.spend.maxMode);
  const [metered, setMetered] = useState<string>(String(g.spend.meteredUsdPerDay));
  const [days, setDays] = useState<string>(String(daysOf(draft)));
  const ids = { metered: useId(), days: useId(), mode: useId() };
  if (!base) {
    return <p className={styles.scopeMeta}>This server cannot edit a draft yet — update Ashlr to choose repos and engines here.</p>;
  }
  const meteredN = Number(metered);
  const daysN = Number(days);
  const valid = repos.length > 0 && engines.length > 0 && Number.isInteger(meteredN) && meteredN >= 0 && Number.isInteger(daysN) && daysN >= 1 && daysN <= base.maxDays;

  function preview(): void {
    onPreview({
      repos,
      engines: engines as GrantEngine[],
      leaderClasses: classes as LeaderGrantClass[],
      maxMode: mode,
      meteredUsdPerDay: meteredN,
      days: daysN,
    });
  }

  return (
    <div className={styles.scopeEditor} aria-label="Edit the grant scope">
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
      {!valid ? <p className={styles.scopeMeta}>Keep at least one repo and one engine, whole dollars, and 1–{base.maxDays} days.</p> : null}
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
