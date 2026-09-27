/**
 * routes/verse/panes/builtin/FilesPane.tsx — the first-party Files pane
 * (a registry STUB): the chat's folders, with a terminal or the changes one
 * click away, and every file the chat has read or changed. A file tree and
 * editor can replace it by registering the id `files` (../README.md).
 */
import { useMemo } from 'react';
import { EmptyState } from '../../../../components/primitives/EmptyState.js';
import { displayPath } from '../../chat/path-display.js';
import { fileBasename } from '../../chat/tool-semantics.js';
import { FilesGlyph } from '../../dock/dock-icons.js';
import { useVerseTranscript } from '../../useVerseTranscript.js';
import { formatRelative } from '../../verse-model.js';
import type { PaneProps } from '../pane-registry.js';
import { touchedFiles, type FileTouch } from './pane-models.js';
import styles from './stub-panes.module.css';

const TOUCH_MARK: Record<FileTouch, string> = { created: 'A', edited: 'M', deleted: 'D', read: 'R' };
const TOUCH_WORD: Record<FileTouch, string> = { created: 'created', edited: 'edited', deleted: 'deleted', read: 'read' };

/** The longest root that holds `path` — the one a diff for it is taken in. */
function rootOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const r = root.replace(/[\\/]+$/, '');
    if ((path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}\\`)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

export function FilesPane({ sessionId, roots, host }: PaneProps) {
  const transcript = useVerseTranscript(sessionId);
  const files = useMemo(() => touchedFiles(transcript.items), [transcript.items]);
  const changed = files.filter((f) => f.touch !== 'read');
  const read = files.filter((f) => f.touch === 'read');

  function open(path: string, touch: FileTouch) {
    const root = rootOf(path, roots) ?? roots[0];
    if (touch !== 'read' && root) {
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path;
      host.openDiff({ root, scope: 'working', file: rel });
    } else {
      host.addToMessage(`@${displayPath(path, roots)}`);
    }
  }

  return (
    <div className={styles.pane} aria-label="Files">
      <section className={styles.section} aria-labelledby="pane-files-roots">
        <h3 id="pane-files-roots" className={styles.sectionTitle}>Folders <span className={styles.count}>{roots.length || ''}</span></h3>
        {roots.length === 0 ? <p className={styles.muted}>This chat has no folders yet.</p> : (
          <ul className={styles.list}>
            {roots.map((root) => (
              <li key={root} className={styles.row} title={root}>
                <span className={styles.mark} aria-hidden="true"><FilesGlyph size={12} /></span>
                <span className={styles.name}>{fileBasename(root) || root}</span>
                <span>
                  <button type="button" className={styles.rowAction} onClick={() => host.openTerminal({ root })}>Terminal</button>
                  <button type="button" className={styles.rowAction} onClick={() => host.openDiff({ root, scope: 'working' })}>Changes</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {files.length === 0 ? (
        <section className={styles.section}>
          <EmptyState compact title="No files yet"
            body="Files this chat reads or changes appear here as it works — changed ones first. Click a changed file to see its diff, or a read one to mention it in your message." />
        </section>
      ) : null}

      {changed.length > 0 ? (
        <FileList id="pane-files-changed" title="Changed" files={changed} roots={roots} onOpen={open} />
      ) : null}
      {read.length > 0 ? <FileList id="pane-files-read" title="Read" files={read} roots={roots} onOpen={open} /> : null}
    </div>
  );
}

function FileList({ id, title, files, roots, onOpen }: {
  id: string;
  title: string;
  files: ReturnType<typeof touchedFiles>;
  roots: readonly string[];
  onOpen: (path: string, touch: FileTouch) => void;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>{title} <span className={styles.count}>{files.length}</span></h3>
      <ul className={styles.list}>
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={styles.row} onClick={() => onOpen(f.path, f.touch)}
              title={`${f.path} — ${TOUCH_WORD[f.touch]}${f.count > 1 ? `, ${f.count} times` : ''}`}
              aria-label={`${displayPath(f.path, roots)}, ${TOUCH_WORD[f.touch]}${f.touch === 'read' ? ' — add to message' : ' — show changes'}`}>
              <span className={styles.mark} data-touch={f.touch} aria-hidden="true">{TOUCH_MARK[f.touch]}</span>
              <span className={styles.name}>{displayPath(f.path, roots)}</span>
              <span className={styles.meta}>{formatRelative(f.lastAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
