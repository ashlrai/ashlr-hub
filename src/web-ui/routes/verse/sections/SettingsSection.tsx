/**
 * routes/verse/sections/SettingsSection.tsx — the Settings rail item
 * (VERSE-CONTRACT-V2, owner A). Named export, NO props: the shell
 * lazy-mounts it and it reads everything it needs from the stores.
 *
 * Four panels in one 720px reading column: Appearance (live, no save
 * button), Connection (server, authority state, how to get tokens back),
 * Keyboard, and About. Each row is label + description on the left, control
 * on the right — the same rhythm all the way down, so the page reads as one
 * object rather than four inventions.
 */
import { useAppearance } from '../../../data/hooks.js';
import { AboutPanel } from './AboutPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { ShortcutsPanel } from './ShortcutsPanel.js';
import styles from './SettingsSection.module.css';

export function SettingsSection() {
  const { appearance, set, reset } = useAppearance();

  return (
    <div className={styles.section}>
      <header className={styles.strip} data-app-region="drag">
        <h2 className={styles.stripTitle}>Settings</h2>
      </header>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <AppearancePanel appearance={appearance} onChange={set} onReset={reset} />
          <ConnectionPanel />
          <ShortcutsPanel />
          <AboutPanel />
        </div>
      </div>
    </div>
  );
}
