/**
 * routes/verse/sections/ShortcutsPanel.tsx — the keyboard reference.
 *
 * It documents the bindings the V2 shell contract fixes (⌘1-⌘5, ⌘K, ⌘N, ⌘,)
 * plus the composer's own keys. It is a REFERENCE, not the implementation:
 * the handlers live with the shell (owner C) and the composer. Keeping the
 * list here means an operator can find a binding without a manual; keeping
 * it declarative means it is one array to update when a binding changes.
 */
import { Panel } from './SettingRow.js';
import styles from './SettingsSection.module.css';

/** ⌘ on Apple platforms, Ctrl everywhere else. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(source);
}

interface Shortcut {
  keys: string[];
  action: string;
}

export function shortcutGroups(mod: string): Array<{ title: string; items: Shortcut[] }> {
  return [
    {
      title: 'Navigation',
      items: [
        { keys: [mod, '1'], action: 'Chat' },
        { keys: [mod, '2'], action: 'Autonomy' },
        { keys: [mod, '3'], action: 'Approvals' },
        { keys: [mod, '4'], action: 'Usage' },
        { keys: [mod, '5'], action: 'Settings' },
        { keys: [mod, 'K'], action: 'Quick switcher' },
        { keys: [mod, ','], action: 'Settings' },
      ],
    },
    {
      title: 'Chat',
      items: [
        { keys: [mod, 'N'], action: 'New chat' },
        { keys: ['Enter'], action: 'Send message' },
        { keys: ['Shift', 'Enter'], action: 'New line' },
        { keys: ['Esc'], action: 'Stop dictation / close overlay' },
      ],
    },
  ];
}

export function ShortcutsPanel() {
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';
  return (
    <Panel title="Keyboard">
      <div className={styles.shortcuts}>
        {shortcutGroups(mod).flatMap((group) =>
          group.items.map((item) => (
            <div key={`${group.title}-${item.action}-${item.keys.join('+')}`} className={styles.shortcut}>
              <span>{item.action}</span>
              <span className={styles.keys}>
                {item.keys.map((key) => (
                  <kbd key={key} className={styles.key}>
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          )),
        )}
      </div>
    </Panel>
  );
}
