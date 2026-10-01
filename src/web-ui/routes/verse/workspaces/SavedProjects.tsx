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
import { useId, useState } from 'react';
import type { VerseWorkspace } from '../../../data/api-types.js';
import { useQuery } from '../../../data/hooks.js';
import { SAVED_PROJECTS_GROUP, setSidebarGroupCollapsed, useSidebarCollapse } from '../chat/sidebar-collapse-pref.js';
import { PlusIcon } from '../verse-icons.js';
import { verseWorkspacesQuery } from '../verse-queries.js';
import { workspacePrimary, workspaceSummary } from '../workspace-model.js';
import { SavedProjectDialog } from './SavedProjectDialog.js';
import styles from './SavedProjects.module.css';

export function SavedProjects() {
  const listId = useId();
  const countId = useId();
  const collapsed = useSidebarCollapse().has(SAVED_PROJECTS_GROUP);
  const query = useQuery(verseWorkspacesQuery);
  const workspaces = query.data?.workspaces ?? [];
  const [editing, setEditing] = useState<{ open: boolean; workspace: VerseWorkspace | null }>(
    { open: false, workspace: null },
  );

  return (
    <section className={styles.projects} aria-label="Saved projects">
      <h2 className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={!collapsed} aria-controls={listId}
          aria-label="Projects" aria-describedby={countId} onClick={() => setSidebarGroupCollapsed(SAVED_PROJECTS_GROUP, !collapsed)}>
          <span className={styles.twist} data-open={!collapsed || undefined} aria-hidden="true" />
          <span className={styles.headText}>Projects</span>
          <span className={styles.count} aria-hidden="true">{workspaces.length}</span>
          <span id={countId} className="visually-hidden">{workspaces.length} saved {workspaces.length === 1 ? 'project' : 'projects'}</span>
        </button>
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

      <div id={listId} hidden={collapsed}>
      {workspaces.length > 0 ? (
        <ul className={styles.list}>
          {workspaces.map((workspace) => {
            const primary = workspacePrimary(workspace) ?? '';
            return (
              <li key={workspace.id}>
                <button
                  type="button"
                  className={styles.project}
                  // The name truncates to one line, so the tooltip carries it in
                  // full, then the primary folder — which costs no pixels here.
                  title={primary ? `${workspace.name}\n${primary}` : workspace.name}
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
        <p className={styles.empty}>No saved projects yet. Press + to keep a folder you work in.</p>
      )}

      </div>

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
