import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronRight } from '../../../components/primitives/icons.js';
import { updateVerseCaps } from './control-queries.js';
import {
  GOAL_PREFERENCE_FIELDS, goalPreferenceDraft, goalPreferencePatch, readGoalFocus, readGoalPreferences, validateGoalPreference,
  type GoalPreferenceDraft, type GoalPreferenceKey, type GoalPreferenceRead, type GoalPreferences,
} from './goal-preferences-spec.js';
import { describeControlError, type GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

export function GoalPreferencesPanel({ preferences, focusMode, focusThreshold, focusDefaulted = false, guard, dispatchEnabled }: {
  preferences: GoalPreferences | undefined; guard: GuardedAction; dispatchEnabled: boolean;
  focusMode?: boolean; focusThreshold?: number; focusDefaulted?: boolean;
}) {
  const read = readGoalPreferences(preferences);
  return (
    <section className={styles.panel} aria-label="Goal preferences">
      <details className={styles.goalDisclosure}>
      <summary className={styles.goalSummary}>
        <span className={styles.goalSummaryLabel}><IconChevronRight size={14} className={styles.goalChevron} /><span className={styles.panelTitle}>Goal preferences</span></span>
        <span className={styles.panelNote}>{read.state === 'ready' ? 'Advanced' : 'Unavailable'}</span>
      </summary>
      <p className={styles.goalNote}>Guide how much work Leader proposes and keeps open. Available agent slots, provider limits and your signed permissions still determine what runs.</p>
      {read.state === 'ready' ? <GoalPreferencesForm read={read} serverValue={preferences!}
        focusMode={focusMode} focusThreshold={focusThreshold} focusDefaulted={focusDefaulted} guard={guard} dispatchEnabled={dispatchEnabled} /> : (
        <p className={styles.empty} role="status">{read.state === 'unsupported'
          ? 'Goal preferences are unavailable from this server. Update Phantom to view and change them.'
          : read.state === 'unavailable' ? 'Saved goal preferences could not be read. Refresh the connection before changing them.'
            : 'Saved goal preferences need attention. Correct the configuration and refresh before changing them here.'}</p>
      )}
      </details>
    </section>
  );
}

function GoalPreferencesForm({ read, serverValue, focusMode, focusThreshold, focusDefaulted, guard, dispatchEnabled }: {
  read: Extract<GoalPreferenceRead, { state: 'ready' }>; guard: GuardedAction; dispatchEnabled: boolean;
  serverValue: GoalPreferences; focusMode: boolean | undefined; focusThreshold: number | undefined; focusDefaulted: boolean;
}) {
  const [saved, setSaved] = useState(read.values);
  const [defaulted, setDefaulted] = useState(read.defaulted);
  const savedRef = useRef(saved);
  const [draft, setDraft] = useState(() => goalPreferenceDraft(read.values));
  const [errors, setErrors] = useState<Partial<Record<GoalPreferenceKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const focus = readGoalFocus(focusMode, focusThreshold);
  const [savedFocus, setSavedFocus] = useState(focus);
  const savedFocusRef = useRef(savedFocus);
  const [draftFocus, setDraftFocus] = useState(focus?.mode ?? null);
  const focusEdited = useRef(false);
  const [defaultFocus, setDefaultFocus] = useState(focusDefaulted);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signature = JSON.stringify({ values: read.values, defaulted: read.defaulted, focus, focusDefaulted });

  useEffect(() => {
    const next = read.values;
    const before = savedRef.current;
    setDefaulted(read.defaulted);
    setDefaultFocus(focusDefaulted);
    const beforeFocus = savedFocusRef.current;
    if (JSON.stringify(beforeFocus) !== JSON.stringify(focus)) {
      if (!focusEdited.current) setDraftFocus(focus?.mode ?? null);
      savedFocusRef.current = focus;
      setSavedFocus(focus);
      setNotice(null);
    }
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    // Refresh untouched choices without discarding an operator's unsaved edit.
    setDraft((current) => {
      const fresh = goalPreferenceDraft(next);
      const merged = { ...current };
      for (const field of GOAL_PREFERENCE_FIELDS) {
        const value = validateGoalPreference(current[field.key].text, current[field.key].unlimited);
        if (value.ok && value.value === before[field.key]) merged[field.key] = fresh[field.key];
      }
      return merged;
    });
    savedRef.current = next;
    setSaved(next);
    setNotice(null);
    // Depend on values, not a newly allocated projection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, serverValue]);

  const result = goalPreferencePatch(draft, saved);
  const focusChanged = focusEdited.current && focus !== null && draftFocus !== null && draftFocus !== savedFocus?.mode;
  const changed = Object.keys(result.patch).length > 0 || Object.keys(result.errors).length > 0 || focusChanged;
  const locked = !dispatchEnabled || guard.readOnly || guard.busy || guard.tokenOpen || saving;

  function change(key: GoalPreferenceKey, update: Partial<GoalPreferenceDraft[GoalPreferenceKey]>) {
    setDraft((current) => ({ ...current, [key]: { ...current[key], ...update } }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setNotice(null);
  }

  function save() {
    if (locked || running.current) return;
    const checked = goalPreferencePatch(draft, saved);
    setErrors(checked.errors);
    setError(null);
    setNotice(null);
    if (Object.keys(checked.errors).length || (!Object.keys(checked.patch).length && !focusChanged)) return;
    const patch = {
      ...(Object.keys(checked.patch).length ? { goalPreferences: checked.patch } : {}),
      ...(focusChanged && draftFocus !== null ? { goalFocusMode: draftFocus } : {}),
    };
    guard.request(async () => {
      if (!mounted.current) throw new Error('Review goal preferences again before saving.');
      if (running.current) throw new Error('A goal preferences save is already in progress.');
      running.current = true;
      setSaving(true);
      try {
        const response = await updateVerseCaps(patch);
        const confirmed = readGoalPreferences(response?.caps?.goalPreferences);
        if (confirmed.state !== 'ready') throw new Error('The server did not confirm saved goal preferences. Refresh before trying again.');
        if ((Object.keys(checked.patch) as GoalPreferenceKey[]).some((key) => confirmed.values[key] !== checked.patch[key])) {
          throw new Error('The server returned different goal preferences. Refresh and review them before trying again.');
        }
        const confirmedFocus = readGoalFocus(response.caps.goalFocusMode, response.caps.goalFocusActiveThreshold);
        if (focusChanged && (!confirmedFocus || confirmedFocus.mode !== draftFocus)) throw new Error('The server did not confirm the finishing preference. Refresh before trying again.');
        return { confirmed, confirmedFocus, defaultFocus: Array.isArray(response.caps.defaulted)
          && response.caps.defaulted.length <= 32 && response.caps.defaulted.includes('goalFocusMode') };
      } catch (err) {
        if (mounted.current) setError(describeControlError(err));
        throw err;
      } finally {
        running.current = false;
        if (mounted.current) setSaving(false);
      }
    }, 'Saving goal preferences requires the dispatch token.', ({ confirmed, confirmedFocus, defaultFocus: confirmedDefaultFocus }) => {
      if (!mounted.current) return;
      savedRef.current = confirmed.values;
      setSaved(confirmed.values);
      setDefaulted(confirmed.defaulted);
      setDraft(goalPreferenceDraft(confirmed.values));
      savedFocusRef.current = confirmedFocus;
      setSavedFocus(confirmedFocus);
      setDraftFocus(confirmedFocus?.mode ?? null);
      focusEdited.current = false;
      setDefaultFocus(confirmedDefaultFocus);
      setErrors({});
      setNotice('Goal preferences saved. Leader uses them on its next planning pass.');
    });
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); save(); }} aria-busy={saving || undefined}>
      <fieldset className={styles.goalFields} disabled={locked}>
        <legend className={styles.srOnly}>Leader goal preferences</legend>
        <div className={styles.capGrid}>
          {GOAL_PREFERENCE_FIELDS.map((field) => {
            const id = `goal-preference-${field.key}`;
            const choice = draft[field.key];
            return <div key={field.key} className={styles.cap}>
              <label className={styles.goalLabel} htmlFor={id}>{field.label}</label>
              <input id={id} className={`${styles.capInput} ${errors[field.key] ? styles.capInputInvalid : ''}`}
                type="text" inputMode="numeric" autoComplete="off" value={choice.unlimited ? '' : choice.text}
                placeholder={choice.unlimited ? 'No preference limit' : undefined} disabled={choice.unlimited}
                aria-invalid={errors[field.key] ? true : undefined}
                aria-describedby={`${id}-help${errors[field.key] ? ` ${id}-error` : ''}`}
                onChange={(event) => change(field.key, { text: event.target.value })} />
              <label className={styles.goalChoice}>
                <input type="checkbox" checked={choice.unlimited} aria-label={`No preference limit for ${field.label.toLowerCase()}`}
                  onChange={(event) => change(field.key, { unlimited: event.target.checked })} />
                <span>No preference limit</span>
              </label>
              <span className={styles.capHelp} id={`${id}-help`}>{field.help}{defaulted.includes(field.key) ? ` Current default: ${saved[field.key]}.` : ''}</span>
              {errors[field.key] ? <span className={styles.capError} id={`${id}-error`} role="alert">{errors[field.key]}</span> : null}
            </div>;
          })}
        </div>
        <div className={styles.goalFocus}>
          {focus && savedFocus ? <>
            <label className={styles.goalChoice}>
              <input type="checkbox" checked={draftFocus === true} aria-describedby="goal-focus-help"
                onChange={(event) => { focusEdited.current = event.target.checked !== savedFocus.mode; setDraftFocus(event.target.checked); setError(null); setNotice(null); }} />
              <span>Prefer finishing current work before expanding</span>
            </label>
            <p className={styles.capHelp} id="goal-focus-help">At {savedFocus.threshold} or more active goals, defer new planning and invention. Clear this preference to plan new work alongside current goals.{defaultFocus ? ' On by default.' : ''} This is separate from the active-goal limit above.</p>
          </> : <p className={styles.capHelp}>The finishing preference is unavailable from this server. A separate planning preference may still defer new goals.</p>}
        </div>
        <div className={styles.goalActions}>
          <Button type="submit" busy={saving} disabled={!changed}>Save goal preferences</Button>
          {changed ? <Button variant="ghost" onClick={() => {
            setDraft(goalPreferenceDraft(saved)); setDraftFocus(savedFocus?.mode ?? null); focusEdited.current = false; setErrors({}); setError(null); setNotice(null);
          }}>Discard changes</Button> : null}
        </div>
      </fieldset>
      {!dispatchEnabled || guard.readOnly ? <p className={styles.capHelp}>This connection is read-only. Goal preferences cannot be changed here.</p> : null}
      {error ? <p className={styles.capError} role="alert">{error}</p> : null}
      {saving ? <p className={styles.capHelp} role="status">Saving goal preferences…</p> : null}
      {notice ? <p className={styles.capApplied} role="status">{notice}</p> : null}
    </form>
  );
}
