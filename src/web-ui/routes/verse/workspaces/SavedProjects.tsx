/**
 * routes/verse/workspaces/SavedProjects.tsx — the sidebar's "Projects"
 * section: every saved project, and the one button that creates one.
 *
 * SELF-SUPPLIED ON PURPOSE. It reads `verseWorkspacesQuery` itself rather
 * than taking the list as a prop, because the sidebar's props are owned by the
 * chat section and this list has exactly one consumer. The key is the same one
 * the new-chat dialog's list is read from, so the cache serves both from one
 * request and the picker and this list can never disagree.
 *
 * Quiet when the read fails: an older server has no /api/verse/workspaces at
 * all, and a permanent red line in the sidebar for a feature that server does
 * not have would be noise, not honesty. The "Save a project" button stays —
 * pressing it surfaces the real refusal from the server, in the dialog.
 */
import { useState } from 'react';
import type { VerseWorkspace } from '../../../data/api-types.js';
import { useQuery } from '../../../data/hooks.js';
import { PlusIcon } from '../verse-icons.js';
import { verseWorkspacesQuery } from '../verse-queries.js';
import { workspacePrimary, workspaceSummary } from '../workspace-model.js';
import { SavedProjectDialog } from './SavedProjectDialog.js';
import styles from './SavedProjects.module.css';

export function SavedProjects() {
  const query = useQuery(verseWorkspacesQuery);
  const workspaces = query.data?.workspaces ?? [];
  const [editing, setEditing] = useState<{ open: boolean; workspace: VerseWorkspace | null }>(
    { open: false, workspace: null },
  );

  return (
    <section className={styles.projects} aria-label="Saved projects">
      <h2 className={styles.head}>
        <span className={styles.headText}>Projects</span>
        <button
          type="button"
          className={styles.add}
          title="Save a project"
          aria-label="Save a project"
          onClick={() => setEditing({ open: true, workspace: null })}
        >
          <PlusIcon />
        </button>
      </h2>

      {workspaces.length > 0 ? (
        <ul className={styles.list}>
          {workspaces.map((workspace) => {
            const primary = workspacePrimary(workspace) ?? '';
            return (
              <li key={workspace.id}>
                <button
                  type="button"
                  className={styles.project}
                  title={primary}
                  aria-label={`Edit project ${workspace.name}`}
                  onClick={() => setEditing({ open: true, workspace })}
                >
                  <span className={styles.name}>{workspace.name}</span>
                  <span className={styles.summary}>{workspaceSummary(workspace)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : query.status === 'error' ? null : (
        <p className={styles.empty}>No saved projects yet.</p>
      )}

      <SavedProjectDialog
        open={editing.open}
        workspace={editing.workspace}
        priorities={query.data?.priorities}
        focusSectionId={query.data?.focusSectionId ?? null}
        onClose={() => setEditing({ open: false, workspace: null })}
      />
    </section>
  );
}
