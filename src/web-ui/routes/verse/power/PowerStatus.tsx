import { useState } from 'react';
import { setDesktopPreference, useDesktopState } from '../../../app/desktop-shell.js';
import styles from './PowerStatus.module.css';

function checked(at: number | null): string {
  return at === null ? 'Not checked yet' : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** Native owns policy and its OS request. Never infer host power from this tab. */
export function PowerStatus() {
  const power = useDesktopState()?.power;
  const [error, setError] = useState<string | null>(null);
  const label = !power ? 'Host power unavailable' : !power.automatic ? 'System sleep settings' : power.error ? 'Awake request failed' : power.requested ? 'Awake request active' : power.localRuns === null ? 'Automatic · checking activity' : 'Automatic awake';
  return (
    <details className={styles.status}>
      <summary aria-label={`Computer power: ${label}`}>{label}</summary>
      <div className={styles.panel}>
        <strong>Keep awake while working</strong>
        {power ? <>
          <p>{power.powerSource === 'ac' ? 'Plugged in' : power.powerSource === 'battery' ? 'On battery' : 'Power source unavailable'} · {power.idleSleepSeconds === null ? 'System sleep timer unavailable' : power.idleSleepSeconds === 0 ? 'System idle sleep disabled' : `System idle sleep after ${Math.ceil(power.idleSleepSeconds / 60)} min`}</p>
          <label><input type="checkbox" checked={power.automatic} onChange={(event) => {
            setError(setDesktopPreference('automaticAwake', event.target.checked) ? null : 'The desktop app could not change this setting.');
          }} />Automatic during local work</label>
          <p>{power.requested ? 'Idle-sleep request active.' : power.automatic ? power.localRuns === null ? 'Local work status unavailable; checking again.' : 'Ready for local work.' : 'Your system settings control idle sleep.'}</p>
          {(power.error || error) && <p role="alert">{power.error || error}</p>}
          <p>Last activity check: {checked(power.checkedAt)}.</p>
        </> : <p>Host power is available in the desktop app.</p>}
        <p>The display can sleep. Manual sleep, screen locks and lid closure still apply.</p>
        <details>
          <summary>Details</summary>
          {power && <>
            <p>{power.localRuns === null ? 'Current local work is unavailable. A recent request can remain briefly while checks retry.' : `${power.localRuns} observed local runs; other worker activity may be unavailable.`}</p>
            <p>System settings checked: {checked(power.settingsCheckedAt)}.</p>
          </>}
          <p>The desktop observes local chats and resident Fleet dispatches with verified process identity. Standalone CLI workers are not observed. Quitting the desktop ends its request; resident services manage power separately. Cloud sessions run on their provider's computers.</p>
          <p>Checks can take a few seconds. Battery and thermal restrictions may override requests. Browser and computer tools need their own permissions and cannot be promised to work asleep or locked.</p>
        </details>
      </div>
    </details>
  );
}
