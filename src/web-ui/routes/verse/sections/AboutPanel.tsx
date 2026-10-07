/**
 * routes/verse/sections/AboutPanel.tsx — what this is and which build it is.
 * The version comes from package.json at build time (./app-version.ts).
 */
import { PRODUCT_COMPANY, PRODUCT_DESCRIPTOR } from '../../../app/product-brand.js';
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
            <span>{PRODUCT_DESCRIPTOR} · by {PRODUCT_COMPANY}</span>
          </p>
          <p className={styles.aboutLine}>
            The workbench connects to a local server. Agent and cloud sessions use the providers and accounts you connect.
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
