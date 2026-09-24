/**
 * routes/verse/shell/ShortcutsOverlay.tsx — ⌘/ (unit C1). Every key the
 * workbench answers, read straight from C0's command catalog: the overlay
 * cannot list a key that does not exist, or miss one that does, because it
 * is the same table the key handlers match against.
 *
 * Also rendered inline by Settings ▸ Keyboard (`ShortcutsTable`).
 */
import { useId, useMemo } from 'react';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { closeVerseOverlay } from '../verse-ui-store.js';
import { detectKeyPlatform, formatChord, shortcutSections, type KeyPlatform } from './command-catalog.js';
import styles from './ShortcutsOverlay.module.css';

export function ShortcutsTable({ platform }: { platform?: KeyPlatform }) {
  const resolved = useMemo(() => platform ?? detectKeyPlatform(), [platform]);
  const sections = useMemo(() => shortcutSections(), []);
  return (
    <div className={styles.grid}>
      {sections.map(({ section, commands }) => (
        <section key={section} className={styles.section} aria-label={section}>
          <h3 className={styles.sectionTitle}>{section}</h3>
          <dl className={styles.list}>
            {commands.map((command) => (
              <div key={command.id} className={styles.row}>
                <dt className={styles.action}>
                  {command.title}
                  {command.note ? <span className={styles.note}>{command.note}</span> : null}
                </dt>
                <dd className={styles.keys}>
                  {command.keys.map((chord) => (
                    <kbd key={formatChord(chord, resolved)} className={styles.key}>
                      {formatChord(chord, resolved)}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

export function ShortcutsOverlay({ onClose = closeVerseOverlay }: { onClose?: () => void }) {
  const titleId = useId();
  return (
    <Dialog open onClose={onClose} titleId={titleId} title="Keyboard shortcuts" widthClassName={styles.dialog}
      description="Letters in Needs you work while its list has focus. ⌘ is Ctrl off a Mac.">
      <div data-verse-overlay="shortcuts" className={styles.scroll}>
        <ShortcutsTable />
      </div>
    </Dialog>
  );
}
