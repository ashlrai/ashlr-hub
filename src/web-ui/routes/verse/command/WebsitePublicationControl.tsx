import type { AuthorityStatusV1 } from '../../../../core/authority/types.js';
import { postAuthority } from './surface-data.js';
import type { SurfaceActions } from './actions.js';
import styles from './command.module.css';

/** Deferred operator control; loading it grants no deployment authority. */
export default function WebsitePublicationControl({ status, actions, disabled }: {
  status: NonNullable<AuthorityStatusV1['websitePublication']>; actions: SurfaceActions; disabled: boolean;
}) {
  return <label className={styles.switchWrap} title={status.reason ?? 'Publish qualified Phantom website changes automatically'}>
    <span className={styles.barLabel}>Website</span>
    <select aria-label="Website publication" value={status.mode} disabled={disabled}
      onChange={(event) => actions.act(() => postAuthority({ action: 'website-mode', to: event.target.value as 'auto' | 'paused' | 'off' }), 'Change website publication mode')}>
      <option value="auto">Auto</option><option value="paused">Paused</option><option value="off">Off</option>
    </select>
  </label>;
}
