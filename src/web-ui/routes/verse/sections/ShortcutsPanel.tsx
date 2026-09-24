/**
 * routes/verse/sections/ShortcutsPanel.tsx — Settings ▸ Keyboard (unit C1).
 *
 * The same table ⌘/ shows, read from C0's command catalog: the reference
 * can no longer drift from the keys the handlers actually match (the 3.9
 * version was a hand-written list that still said ⌘1 = Chat).
 */
import { useMemo } from 'react';
import { detectKeyPlatform, findCommand, formatChord } from '../shell/command-catalog.js';
import { ShortcutsTable } from '../shell/ShortcutsOverlay.js';
import { Panel } from './SettingRow.js';
import styles from './SettingsSection.module.css';

/** ⌘ on Apple platforms, Ctrl everywhere else. */
export function isApplePlatform(): boolean {
  return detectKeyPlatform() === 'mac';
}

export function ShortcutsPanel() {
  const platform = useMemo(() => detectKeyPlatform(), []);
  const overlay = findCommand('shortcuts.open')?.keys[0];
  return (
    <Panel title="Keyboard">
      <p className={styles.panelNote}>
        {overlay ? `${formatChord(overlay, platform)} shows this list from anywhere.` : null}
      </p>
      <ShortcutsTable platform={platform} />
    </Panel>
  );
}
