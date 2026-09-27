/**
 * routes/verse/panes/builtin/SourcesPane.tsx — the first-party Sources pane
 * (a registry STUB): what the chat looked at to answer — pages fetched, web
 * searches, files read — newest first. The Reasoning + Sources unit replaces
 * it by registering the id `sources` (../README.md).
 */
import { useMemo } from 'react';
import { EmptyState } from '../../../../components/primitives/EmptyState.js';
import { displayPath } from '../../chat/path-display.js';
import { useVerseTranscript } from '../../useVerseTranscript.js';
import { formatRelative } from '../../verse-model.js';
import type { PaneProps } from '../pane-registry.js';
import { chatSources, type SourceKind } from './pane-models.js';
import styles from './stub-panes.module.css';

const KIND_MARK: Record<SourceKind, string> = { web: '↗', search: '⌕', file: '¶' };
const KIND_WORD: Record<SourceKind, string> = { web: 'Page', search: 'Search', file: 'File' };

export function SourcesPane({ sessionId, roots, host }: PaneProps) {
  const transcript = useVerseTranscript(sessionId);
  const sources = useMemo(() => chatSources(transcript.items), [transcript.items]);
  if (sources.length === 0) {
    return (
      <div className={styles.pane} aria-label="Sources">
        <section className={styles.section}>
          <EmptyState compact title="No sources yet"
            body="When this chat fetches a page, searches the web or reads a file to answer you, it is listed here — so you can check what an answer rests on." />
        </section>
      </div>
    );
  }
  const web = sources.filter((s) => s.kind !== 'file');
  const files = sources.filter((s) => s.kind === 'file');
  return (
    <div className={styles.pane} aria-label="Sources">
      {[{ id: 'pane-sources-web', title: 'Web', list: web }, { id: 'pane-sources-files', title: 'Files read', list: files }]
        .filter((group) => group.list.length > 0)
        .map((group) => (
          <section key={group.id} className={styles.section} aria-labelledby={group.id}>
            <h3 id={group.id} className={styles.sectionTitle}>{group.title} <span className={styles.count}>{group.list.length}</span></h3>
            <ul className={styles.list}>
              {group.list.map((source) => {
                const label = source.kind === 'file' ? displayPath(source.target, roots) : source.target;
                return (
                  <li key={source.key} className={styles.row} data-failed={source.failed || undefined}
                    title={`${KIND_WORD[source.kind]}: ${source.target}${source.failed ? ' (failed)' : ''}`}>
                    <span className={styles.mark} aria-label={KIND_WORD[source.kind]}>{KIND_MARK[source.kind]}</span>
                    {source.href ? (
                      <a className={`${styles.name} ${styles.link}`} href={source.href} target="_blank" rel="noopener noreferrer">{label}</a>
                    ) : <span className={styles.name}>{label}</span>}
                    <span>
                      <button type="button" className={styles.rowAction} aria-label={`Cite ${label} in your message`}
                        onClick={() => host.addToMessage(source.kind === 'file' ? `@${label}` : source.target)}>Cite</button>
                      <span className={styles.meta}>{formatRelative(source.at)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
