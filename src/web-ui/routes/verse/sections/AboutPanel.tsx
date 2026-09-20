/**
 * routes/verse/sections/AboutPanel.tsx — what this is and which build it is.
 * The version comes from package.json at build time (./app-version.ts).
 */
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Tag } from '../../../components/primitives/index.js';
import { APP_NAME, APP_VERSION } from './app-version.js';
import { Panel } from './SettingRow.js';
import styles from './SettingsSection.module.css';

export function AboutPanel() {
  return (
    <Panel title="About">
      <div className={`${styles.row} ${styles.rowStacked}`}>
        <div className={styles.about}>
          <p className={styles.aboutName}>{APP_NAME}</p>
          <p className={styles.aboutLine}>
            <Tag mono>v{APP_VERSION}</Tag>
            <span>ashlr-hub — local-first command center for agentic engineers.</span>
          </p>
          <p className={styles.aboutLine}>
            Every session, token and artifact stays on this machine. The console talks to one local server and no
            third-party service.
          </p>
          <p className={styles.aboutLine}>
            <a
              className={styles.link}
              href="https://github.com/ashlrai/ashlr-hub"
              target="_blank"
              rel="noreferrer noopener"
            >
              Source and changelog
              <IconExternalLink size={12} />
            </a>
          </p>
        </div>
      </div>
    </Panel>
  );
}
