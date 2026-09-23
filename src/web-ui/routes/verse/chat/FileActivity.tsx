/**
 * routes/verse/chat/FileActivity.tsx — the blast radius of one turn.
 *
 * The question this answers is the first one asked of any agentic turn:
 * *what did it touch?* Today that costs expanding every tool card and
 * reading JSON. Here it is one compact list — which files were read,
 * edited, created or deleted, with counts and line deltas — and clicking a
 * row scrolls to the call that changed it.
 *
 * DESIGN §6: the action is a WORD, never only the tint on the rule. The
 * 2px left rule repeats the same information for scanning, and the row's
 * accessible name spells it out in full.
 */
import { useState } from 'react';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { fileBasename, fileDirname } from './tool-semantics.js';
import { describeFiles, type TurnFileEntry } from './turn-model.js';
import styles from './chat.module.css';

/** Beyond this the list collapses; a big refactor should not be a wall. */
const COLLAPSE_AFTER = 8;

const VERB: Record<TurnFileEntry['action'], string> = {
  read: 'read',
  edit: 'edited',
  create: 'created',
  delete: 'deleted',
};

export interface FileActivityProps {
  files: readonly TurnFileEntry[];
  /** Scroll to the tool call that did the work. */
  onJump: (toolUseId: string) => void;
}

export function FileActivity({ files, onJump }: FileActivityProps) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const visible = expanded || files.length <= COLLAPSE_AFTER ? files : files.slice(0, COLLAPSE_AFTER);
  const hidden = files.length - visible.length;

  return (
    <section className={styles.activity} aria-label="Files this turn touched">
      <h3 className={styles.activityHead}>
        <span className={styles.activityCount}>{files.length}</span>
        <span className={styles.activityLabel}>file{files.length === 1 ? '' : 's'}</span>
        <span className={styles.activityBreakdown}>{describeFiles(files)}</span>
      </h3>
      <ul className={styles.activityList}>
        {visible.map((file) => {
          const times = file.reads + file.edits + file.creates + file.deletes;
          const name = `${VERB[file.action]} ${file.path}${times > 1 ? `, ${times} calls` : ''}${
            file.additions || file.deletions ? `, +${file.additions} −${file.deletions}` : ''
          }${file.failed ? ', a call on this file failed' : ''}`;
          return (
            <li key={file.path}>
              {/* The row draws the basename in full and lets the DIRECTORY
                  clip, which is the half that tells two same-named files
                  apart. The full path stays in aria-label — this restores it
                  for sighted operators, on focus as well as hover. */}
              <Tooltip label={file.path} placement="right">
                <button type="button" className={styles.activityRow} data-action={file.action}
                  data-failed={file.failed ? 'true' : undefined}
                  onClick={() => onJump(file.anchorToolUseId)} aria-label={name}>
                  <span className={styles.activityRule} aria-hidden="true" />
                  <span className={styles.activityVerb}>{VERB[file.action]}</span>
                  <span className={styles.activityPath}>
                    <span className={styles.activityName}>{fileBasename(file.path)}</span>
                    <span className={styles.activityDir}>{fileDirname(file.path)}</span>
                  </span>
                  {file.failed ? (
                    // DESIGN §6: the danger tint on the 2px rule was the ONLY
                    // difference between a failed row and a successful one, and
                    // it is the same rule once hue is removed. The word is what
                    // actually carries it.
                    <span className={styles.activityFailed} aria-hidden="true">! failed</span>
                  ) : null}
                  {times > 1 ? <span className={styles.activityTimes}>×{times}</span> : null}
                  <span className={styles.activityDelta}>
                    {file.additions > 0 ? <span className={styles.activityAdd}>+{file.additions}</span> : null}
                    {file.deletions > 0 ? <span className={styles.activityDel}>−{file.deletions}</span> : null}
                  </span>
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      {hidden > 0 || expanded ? (
        <button type="button" className={styles.activityMore} aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer files' : `Show ${hidden} more file${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  );
}
