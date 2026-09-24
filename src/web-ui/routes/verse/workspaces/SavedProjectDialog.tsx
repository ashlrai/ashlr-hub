/**
 * routes/verse/workspaces/SavedProjectDialog.tsx — create, rename, reorder and
 * delete a SAVED PROJECT (a workspace in `~/.ashlr/verse/workspaces.json`).
 *
 * Why this dialog exists: the workspace routes were complete and nothing in
 * the console ever called them, so the only way to get a saved project was to
 * hand-edit a JSON file. A folder the operator typed into the new-chat dialog
 * came back only AFTER a chat had been created on it. Now a folder can be kept
 * before any chat exists, which is what "open my project again tomorrow"
 * actually requires.
 *
 * Three honesty rules are load-bearing here:
 *
 *  - THE FIRST FOLDER IS THE PRIMARY. It is the session's cwd, and it is the
 *    only folder a Grok seat can reach, so the reorder buttons are not
 *    cosmetic and the first row says "Primary folder" rather than "Folder 1".
 *  - PRIORITY ORDERS, IT NEVER GRANTS. `ROOT_PRIORITY_NOTE` is rendered at the
 *    point of the choice; ranking a repo `critical` does not enrol it.
 *  - NO SEAT IS CHOSEN HERE, so no per-seat caveat can be honest. The dialog
 *    states the engine rule flatly instead (`MULTI_ROOT_ENGINE_NOTE`); the
 *    seat-specific warning belongs in the new-chat dialog, where a seat exists.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { VerseRootPriority, VerseWorkspace } from '../../../data/api-types.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { nativePickerAvailable, pickDirectory } from '../folder-picker.js';
import { projectName } from '../verse-model.js';
import {
  createVerseWorkspace,
  deleteVerseWorkspace,
  setVerseFocusSection,
  setVerseRootPriority,
  updateVerseWorkspace,
} from '../verse-queries.js';
import {
  MAX_WORKSPACE_ROOTS,
  MULTI_ROOT_ENGINE_NOTE,
  moveRoot,
  priorityOf,
  ROOT_PRIORITY_LABEL,
  ROOT_PRIORITY_NOTE,
  ROOT_PRIORITY_ORDER,
  rootRowLabel,
  validateWorkspaceDraft,
  workspaceRootPaths,
} from '../workspace-model.js';
import styles from './SavedProjectDialog.module.css';

export interface SavedProjectDialogProps {
  open: boolean;
  /** The project being edited, or null to create a new one. */
  workspace: VerseWorkspace | null;
  /** Folder set to pre-fill a NEW project with (primary first). */
  initialRoots?: readonly string[];
  /** Per-path priority as the server holds it. Absent key means `normal`. */
  priorities?: Readonly<Record<string, VerseRootPriority>>;
  /** The section the autonomous lane is focused on, if any. */
  focusSectionId?: string | null;
  onClose: () => void;
  onSaved?: (workspace: VerseWorkspace) => void;
  onDeleted?: (id: string) => void;
}

export function SavedProjectDialog(props: SavedProjectDialogProps) {
  const { open, workspace, initialRoots, priorities, focusSectionId = null, onClose, onSaved, onDeleted } = props;
  const titleId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<string[]>(['']);
  const [section, setSection] = useState(false);
  const [focused, setFocused] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState<Record<string, VerseRootPriority>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on the OPEN transition only, for the same reason NewChatDialog does:
  // the workspace list is a fresh array on every invalidation, and re-running
  // this on it would wipe a half-typed path.
  useEffect(() => {
    if (!open) return;
    const existing = workspace;
    setName(existing?.name ?? '');
    setRoots(existing ? workspaceRootPaths(existing) : [...(initialRoots ?? [])].filter((r) => r.length > 0));
    setSection(existing?.section ?? false);
    setFocused(existing !== null && focusSectionId === existing.id);
    setPriorityDraft({});
    setConfirmingDelete(false);
    setBusy(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open transition only; the inputs are read once, on purpose.
  }, [open]);

  // Always at least one row, so there is somewhere to type the primary folder.
  const rows = roots.length === 0 ? [''] : roots;
  const showPicker = nativePickerAvailable();

  function setRow(index: number, value: string) {
    setRoots(rows.map((r, i) => (i === index ? value : r)));
  }

  async function choose(index: number) {
    const picked = await pickDirectory();
    if (picked !== null && picked.length > 0) setRow(index, picked);
  }

  function priorityFor(path: string): VerseRootPriority {
    return priorityDraft[path] ?? priorityOf(path, priorities);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = validateWorkspaceDraft(name, rows);
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = workspace === null
        ? await createVerseWorkspace({ name: draft.name, roots: draft.roots, section })
        : await updateVerseWorkspace(workspace.id, { name: draft.name, roots: draft.roots, section });
      // Priority is an attribute OF THE REPO, held once per path, so it is a
      // separate call per changed path rather than part of the workspace body.
      for (const path of draft.roots) {
        const next = priorityDraft[path];
        if (next !== undefined && next !== priorityOf(path, priorities)) {
          await setVerseRootPriority(path, next);
        }
      }
      const wasFocused = workspace !== null && focusSectionId === workspace.id;
      if (section && focused !== wasFocused) {
        await setVerseFocusSection(focused ? saved.id : null);
      }
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (workspace === null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteVerseWorkspace(workspace.id);
      onDeleted?.(workspace.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      title={workspace === null ? 'Save a project' : 'Edit project'}
      description="Saved projects stay in the picker — they do not need a chat on them first."
      widthClassName={styles.width}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <label className={styles.field} htmlFor={nameId}>
          <span className={styles.label}>Name</span>
          <input id={nameId} className={styles.input} value={name} onChange={(event) => setName(event.target.value)}
            placeholder="Defaults to the folder’s own name" maxLength={120} autoComplete="off" />
        </label>

        <div className={styles.field}>
          <span className={styles.label}>Folders</span>
          <p className={styles.hint}>
            The first folder is the primary: it is the chat’s working directory. Move a folder to the top to make it
            the primary.
          </p>
          {rows.map((root, index) => (
            <div key={index} className={styles.rootRow}>
              <input
                className={styles.input}
                value={root}
                // A long path is cut with an ellipsis while the field is idle; the tooltip keeps it whole.
                title={root || undefined}
                onChange={(event) => setRow(index, event.target.value)}
                placeholder="/absolute/path/to/folder"
                aria-label={rootRowLabel(index)}
                autoComplete="off"
                spellCheck={false}
              />
              {showPicker ? (
                <button type="button" className={styles.rowButton} onClick={() => void choose(index)}
                  aria-label={`Choose ${rootRowLabel(index).toLowerCase()}`}>Choose folder…</button>
              ) : null}
              {/* Glyph-only: the accessible name AND the tooltip both say what the arrow does. */}
              <button type="button" className={styles.rowButton} disabled={index === 0}
                onClick={() => setRoots(moveRoot(rows, index, 'up'))}
                aria-label={`Move ${rootRowLabel(index).toLowerCase()} up`}
                title={`Move ${rootRowLabel(index).toLowerCase()} up`}><span aria-hidden="true">↑</span></button>
              <button type="button" className={styles.rowButton} disabled={index === rows.length - 1}
                onClick={() => setRoots(moveRoot(rows, index, 'down'))}
                aria-label={`Move ${rootRowLabel(index).toLowerCase()} down`}
                title={`Move ${rootRowLabel(index).toLowerCase()} down`}><span aria-hidden="true">↓</span></button>
              <button type="button" className={styles.rowButton} disabled={rows.length === 1}
                onClick={() => setRoots(rows.filter((_, i) => i !== index))}
                aria-label={`Remove ${rootRowLabel(index).toLowerCase()}`}>Remove</button>
            </div>
          ))}
          {rows.length < MAX_WORKSPACE_ROOTS ? (
            <button type="button" className={styles.addRoot} onClick={() => setRoots([...rows, ''])}>Add a folder</button>
          ) : null}
          {rows.length > 1 ? <p className={styles.hint}>{MULTI_ROOT_ENGINE_NOTE}</p> : null}
        </div>

        <div className={styles.field}>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={section} onChange={(event) => setSection(event.target.checked)} />
            <span>Offer this project to the autonomous lane as a section</span>
          </label>
          {section ? (
            <>
              <label className={styles.checkbox}>
                <input type="checkbox" checked={focused} onChange={(event) => setFocused(event.target.checked)} />
                <span>Focus the fleet on this section</span>
              </label>
              <p className={styles.hint}>{ROOT_PRIORITY_NOTE}</p>
              {rows.filter((r) => r.trim().length > 0).map((root, index) => (
                <div key={`${root}-${index}`} className={styles.priorityRow}>
                  {/* The folder's own name; the full path is the tooltip (and the select's accessible name). */}
                  <span className={styles.priorityPath} title={root}>{projectName(root.trim())}</span>
                  <select
                    className={styles.select}
                    aria-label={`Priority for ${root}`}
                    value={priorityFor(root.trim())}
                    onChange={(event) =>
                      setPriorityDraft({ ...priorityDraft, [root.trim()]: event.target.value as VerseRootPriority })}
                  >
                    {ROOT_PRIORITY_ORDER.map((p) => (
                      <option key={p} value={p}>{ROOT_PRIORITY_LABEL[p]}</option>
                    ))}
                  </select>
                </div>
              ))}
            </>
          ) : null}
        </div>

        {error ? <p role="alert" className={styles.error}>{error}</p> : null}

        <div className={styles.actions}>
          {workspace === null ? null : confirmingDelete ? (
            <>
              <span className={styles.confirm}>Forget this project? Chats already on it are untouched.</span>
              <button type="button" className={styles.danger} onClick={() => void remove()} disabled={busy}>Forget</button>
              <button type="button" className={styles.cancel} onClick={() => setConfirmingDelete(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className={styles.remove} onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Forget project
            </button>
          )}
          <span className={styles.spacer} />
          <button type="button" className={styles.cancel} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.save} disabled={busy}>{busy ? 'Saving…' : 'Save project'}</button>
        </div>
      </form>
    </Dialog>
  );
}
