import { useEffect, useId, useRef, useState } from 'react';
import type { JevResponse } from '../../../../core/decide/jev-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery } from '../../../data/hooks.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import { updateJevCallPreference } from './jev-queries.js';
import styles from './jev.module.css';

export function JevCallPreference({ response }: { response: JevResponse }) {
  const value = response.config?.dailyCallBudget;
  return <details className={styles.preference}>
    <summary tabIndex={0}>Daily call preference</summary>
    <p className={styles.muted}>Choose a daily request preference. Zero pauses new Jev calls; No preference limit removes this count ceiling. Enabled state, account availability and Stop still apply. Jev API calls can cost money.</p>
    {value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? <PreferenceForm value={value} /> : <p role="status">Call preference unavailable on this server.</p>}
  </details>;
}

function parse(text: string, unlimited: boolean): number | null | undefined {
  if (unlimited) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function PreferenceForm({ value }: { value: number | null }) {
  const bootstrap = useQuery(verseBootstrapQuery);
  const guard = useGuardedAction();
  const id = useId();
  const [saved, setSaved] = useState(value);
  const savedRef = useRef(value);
  const [text, setText] = useState(String(value ?? 1500));
  const [unlimited, setUnlimited] = useState(value === null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (savedRef.current === value) return;
    if (parse(text, unlimited) === savedRef.current) { setText(String(value ?? 1500)); setUnlimited(value === null); }
    savedRef.current = value; setSaved(value); setNotice(null);
    // A refresh replaces only an untouched choice; an unsaved choice is preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const chosen = parse(text, unlimited);
  const locked = bootstrap.data?.dispatchEnabled !== true || guard.readOnly || guard.busy || guard.tokenOpen;
  function save() {
    if (locked || running.current) return;
    setNotice(null); setInvalid(chosen === undefined);
    if (chosen === undefined || chosen === saved) return;
    guard.request(async () => {
      if (!mounted.current || running.current) throw new Error('Review the preference again before saving.');
      running.current = true;
      try { return await updateJevCallPreference(chosen); }
      finally { running.current = false; }
    }, 'Saving this preference requires the mutation token.', (confirmed) => {
      if (!mounted.current) return;
      savedRef.current = confirmed; setSaved(confirmed); setText(String(confirmed ?? 1500)); setUnlimited(confirmed === null);
      setNotice('Preference saved. Enabled state and Stop are unchanged.');
    });
  }
  return <div className={styles.preferenceForm}>
    <label htmlFor={`${id}-number`}>Requests per day</label>
    <input id={`${id}-number`} type="text" inputMode="numeric" value={text} disabled={locked || unlimited} aria-invalid={invalid}
      onChange={(event) => { setText(event.target.value); setInvalid(false); setNotice(null); guard.clearError(); }} />
    <label className={styles.preferenceChoice}><input type="checkbox" checked={unlimited} disabled={locked}
      onChange={(event) => { setUnlimited(event.target.checked); setInvalid(false); setNotice(null); guard.clearError(); }} />No preference limit</label>
    {invalid ? <p role="alert">Choose a nonnegative whole number within the supported numeric range.</p> : null}
    <Button size="sm" onClick={save} disabled={locked || chosen === saved}>{guard.busy ? 'Saving…' : 'Save preference'}</Button>
    {bootstrap.data?.dispatchEnabled !== true || guard.readOnly ? <p role="status">This session can view the preference; changes require a writable connection.</p> : null}
    {guard.error ? <p role="alert">Could not confirm the saved preference. Your choice is kept.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <MutationTokenDialog open={guard.tokenOpen} onClose={guard.closeToken} reason={guard.tokenReason} tokenHelp="the mutation token ashlr verse printed" />
  </div>;
}
