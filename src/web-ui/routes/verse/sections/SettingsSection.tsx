/**
 * routes/verse/sections/SettingsSection.tsx — the Settings rail item
 * (VERSE-CONTRACT-V2, owner A). Named export, NO props: the shell
 * lazy-mounts it and it reads everything it needs from the stores.
 *
 * One 720px reading column: Appearance (live, no save button), Chat (how
 * reasoning shows), Desktop (system-wide shortcut, notifications — 3.10),
 * Connection (server, authority state, how to get tokens back), Keyboard (the
 * catalog's own table), the tour, and About. Each row is label + description
 * on the left, control on the right — the same rhythm all the way down, so
 * the page reads as one object rather than seven inventions.
 *
 * 3.10: reached from the gear tray (⌘,), not the rail.
 */
import { useAppearance } from '../../../data/hooks.js';
import { OnboardingPanel } from '../onboarding/OnboardingPanel.js';
import { AboutPanel } from './AboutPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { ChatSettingsPanel } from './ChatSettingsPanel.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { DesktopSettingsPanel } from './DesktopSettingsPanel.js';
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
          <ChatSettingsPanel />
          <DesktopSettingsPanel />
          <ConnectionPanel />
          <ShortcutsPanel />
          <OnboardingPanel />
          <AboutPanel />
        </div>
      </div>
    </div>
  );
}
