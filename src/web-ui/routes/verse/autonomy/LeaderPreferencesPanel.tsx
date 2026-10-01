import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronRight } from '../../../components/primitives/icons.js';
import { updateVerseCaps } from './control-queries.js';
import { validateGoalPreference } from './goal-preferences-spec.js';
import {
  LEADER_PREFERENCE_FIELDS, leaderPreferenceDraft, leaderPreferencePatch, readLeaderPreferences,
  type LeaderPreferenceDraft, type LeaderPreferenceKey, type LeaderPreferenceRead, type LeaderPreferences,
} from './leader-preferences-spec.js';
import { describeControlError, type GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

export function LeaderPreferencesPanel({ preferences, guard, dispatchEnabled }: {
  preferences: LeaderPreferences | undefined; guard: GuardedAction; dispatchEnabled: boolean;
}) {
  const read = readLeaderPreferences(preferences);
  return <section className={styles.panel} aria-label="Leader preferences">
    <details className={styles.goalDisclosure}>
      <summary className={styles.goalSummary}>
        <span className={styles.goalSummaryLabel}><IconChevronRight size={14} className={styles.goalChevron} /><span className={styles.panelTitle}>Leader preferences</span></span>
        <span className={styles.panelNote}>{read.state === 'ready' ? 'Advanced' : 'Unavailable'}</span>
      </summary>
      <p className={styles.goalNote}>Choose daily run preferences and requested capacity. Run intervals, account availability, Stop and your signed permissions still apply. Removing a preference limit does not start work.</p>
      {read.state === 'ready' ? <LeaderPreferencesForm read={read} serverValue={preferences!} guard={guard} dispatchEnabled={dispatchEnabled} />
        : <p className={styles.empty} role="status">{read.state === 'unsupported'
          ? 'Leader preferences are unavailable from this server. Update Hub to view and change them.'
          : read.state === 'unavailable' ? 'Saved Leader preferences could not be read. Refresh the connection before changing them.'
            : 'Saved Leader preferences need attention. Correct the configuration and refresh before changing them here.'}</p>}
    </details>
  </section>;
}

function LeaderPreferencesForm({ read, serverValue, guard, dispatchEnabled }: {
  read: Extract<LeaderPreferenceRead, { state: 'ready' }>; serverValue: LeaderPreferences;
  guard: GuardedAction; dispatchEnabled: boolean;
}) {
  const [saved, setSaved] = useState(read.values);
  const savedRef = useRef(saved);
  const [defaulted, setDefaulted] = useState(read.defaulted);
  const [draft, setDraft] = useState(() => leaderPreferenceDraft(saved));
  const [errors, setErrors] = useState<Partial<Record<LeaderPreferenceKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signature = JSON.stringify({ values: read.values, defaulted: read.defaulted });
  useEffect(() => {
    setDefaulted(read.defaulted);
    const before = savedRef.current;
    if (JSON.stringify(before) === JSON.stringify(read.values)) return;
    setDraft((current) => {
      const next = leaderPreferenceDraft(read.values);
      const merged = { ...current };
      for (const { key } of LEADER_PREFERENCE_FIELDS) {
        const value = validateGoalPreference(current[key].text, current[key].unlimited);
        if (value.ok && value.value === before[key]) merged[key] = next[key];
      }
      return merged;
    });
    savedRef.current = read.values;
    setSaved(read.values);
    setNotice(null);
    // Fresh server reads can revert a value previously confirmed by POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, serverValue]);

  const result = leaderPreferencePatch(draft, saved);
  const changed = Object.keys(result.patch).length > 0 || Object.keys(result.errors).length > 0;
  const locked = !dispatchEnabled || guard.readOnly || guard.busy || guard.tokenOpen || saving;
  function change(key: LeaderPreferenceKey, value: Partial<LeaderPreferenceDraft[LeaderPreferenceKey]>) {
    setDraft((current) => ({ ...current, [key]: { ...current[key], ...value } }));
    setErrors((current) => ({ ...current, [key]: undefined })); setError(null); setNotice(null);
  }
  function save() {
    if (locked || running.current) return;
    const checked = leaderPreferencePatch(draft, saved);
    setErrors(checked.errors); setError(null); setNotice(null);
    if (Object.keys(checked.errors).length || !Object.keys(checked.patch).length) return;
    guard.request(async () => {
      if (!mounted.current) throw new Error('Review Leader preferences again before saving.');
      if (running.current) throw new Error('A Leader preferences save is already in progress.');
      running.current = true; setSaving(true);
      try {
        const response = await updateVerseCaps({ leaderPreferences: checked.patch });
        const confirmed = readLeaderPreferences(response?.caps?.leaderPreferences);
        if (confirmed.state !== 'ready') throw new Error('The server did not confirm saved Leader preferences. Refresh before trying again.');
        if ((Object.keys(checked.patch) as LeaderPreferenceKey[]).some((key) => confirmed.values[key] !== checked.patch[key])) {
          throw new Error('The server returned different Leader preferences. Refresh and review them before trying again.');
        }
        return confirmed;
      } catch (err) { if (mounted.current) setError(describeControlError(err)); throw err; }
      finally { running.current = false; if (mounted.current) setSaving(false); }
    }, 'Saving Leader preferences requires the dispatch token.', (confirmed) => {
      if (!mounted.current) return;
      savedRef.current = confirmed.values; setSaved(confirmed.values); setDefaulted(confirmed.defaulted);
      setDraft(leaderPreferenceDraft(confirmed.values)); setErrors({});
      setNotice('Leader preferences saved. They apply when Leader next considers a run.');
    });
  }
  return <form onSubmit={(event) => { event.preventDefault(); save(); }} aria-busy={saving || undefined}>
    <fieldset className={styles.goalFields} disabled={locked}>
      <legend className={styles.srOnly}>Leader run preferences</legend>
      <div className={styles.capGrid}>{LEADER_PREFERENCE_FIELDS.map((field) => {
        const id = `leader-preference-${field.key}`; const choice = draft[field.key];
        return <div key={field.key} className={styles.cap}>
          <label className={styles.goalLabel} htmlFor={id}>{field.label}</label>
          <input id={id} className={`${styles.capInput} ${errors[field.key] ? styles.capInputInvalid : ''}`}
            type="text" inputMode="numeric" autoComplete="off" value={choice.unlimited ? '' : choice.text}
            placeholder={choice.unlimited ? 'No preference limit' : undefined} disabled={choice.unlimited}
            aria-invalid={errors[field.key] ? true : undefined} aria-describedby={`${id}-help${errors[field.key] ? ` ${id}-error` : ''}`}
            onChange={(event) => change(field.key, { text: event.target.value })} />
          <label className={styles.goalChoice}><input type="checkbox" checked={choice.unlimited}
            aria-label={`No preference limit for ${field.label.toLowerCase()}`}
            onChange={(event) => change(field.key, { unlimited: event.target.checked })} /><span>No preference limit</span></label>
          <span className={styles.capHelp} id={`${id}-help`}>{field.help}{defaulted.includes(field.key) ? ` Current default: ${saved[field.key]}.` : ''}</span>
          {errors[field.key] ? <span className={styles.capError} id={`${id}-error`} role="alert">{errors[field.key]}</span> : null}
        </div>;
      })}</div>
      <div className={styles.goalActions}><Button type="submit" busy={saving} disabled={!changed}>Save Leader preferences</Button>
        {changed ? <Button variant="ghost" onClick={() => { setDraft(leaderPreferenceDraft(saved)); setErrors({}); setError(null); setNotice(null); }}>Discard changes</Button> : null}</div>
    </fieldset>
    {!dispatchEnabled || guard.readOnly ? <p className={styles.capHelp}>This connection is read-only. Leader preferences cannot be changed here.</p> : null}
    {error ? <p className={styles.capError} role="alert">{error}</p> : null}
    {saving ? <p className={styles.capHelp} role="status">Saving Leader preferences…</p> : null}
    {notice ? <p className={styles.capApplied} role="status">{notice}</p> : null}
  </form>;
}
