/**
 * routes/verse/reasoning/ReasoningSheet.tsx — the Sources and Reasoning panes,
 * hosted by the transcript itself (V3.15).
 *
 * The workbench shell's pane registry is the long-term home for both panes
 * (reasoning/pane-adapter.ts describes them for it). Until a build carries
 * that registry, the transcript opens them here: a sheet over the right edge
 * of the conversation, two tabs, Escape to close, focus returned to the
 * button that opened it. Lazy — nothing here loads until the sheet opens.
 */
import { useEffect, useRef } from 'react';
import type { VerseSession } from '../../../../core/verse/types.js';
import type { SourceActions } from '../chat/SourceList.js';
import type { TurnBlock } from '../chat/turn-model.js';
import { ReasoningPanel } from './ReasoningPanel.js';
import { SourcesPanel } from './SourcesPanel.js';
import styles from './reasoning.module.css';

export type ReasoningSheetTab = 'sources' | 'reasoning';

export interface ReasoningSheetProps extends SourceActions {
  tab: ReasoningSheetTab;
  onTab: (tab: ReasoningSheetTab) => void;
  onClose: () => void;
  turns: readonly TurnBlock[];
  engine?: string | null;
  session?: Pick<VerseSession, 'memoryEnabled' | 'projectPath'> | null;
  jumpToTurn: (turnKey: string) => void;
}

const TABS: ReadonlyArray<{ id: ReasoningSheetTab; label: string }> = [
  { id: 'sources', label: 'Sources' },
  { id: 'reasoning', label: 'Reasoning' },
];

export function ReasoningSheet({ tab, onTab, onClose, turns, engine = null, session = null, openFile, jumpToTool, jumpToTurn }: ReasoningSheetProps) {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    // Mount/unmount only: the opener is whoever had focus when the sheet opened.
    return () => { opener?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside ref={root} className={styles.sheet} aria-label="Reasoning and sources for this chat">
      <header className={styles.sheetHead}>
        <div role="tablist" aria-label="Show" className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`verse-rs-tab-${t.id}`} aria-selected={tab === t.id}
              aria-controls={`verse-rs-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={styles.tab}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = TABS[(TABS.findIndex((x) => x.id === tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
                  onTab(next.id);
                  requestAnimationFrame(() => document.getElementById(`verse-rs-tab-${next.id}`)?.focus());
                }
              }}>
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close reasoning and sources">Close</button>
      </header>
      <div id={`verse-rs-panel-${tab}`} role="tabpanel" aria-labelledby={`verse-rs-tab-${tab}`} className={styles.sheetBody}>
        {tab === 'sources'
          ? <SourcesPanel turns={turns} session={session} openFile={openFile} jumpToTool={jumpToTool} jumpToTurn={jumpToTurn} />
          : <ReasoningPanel turns={turns} engine={engine} jumpToTurn={jumpToTurn} />}
      </div>
    </aside>
  );
}
