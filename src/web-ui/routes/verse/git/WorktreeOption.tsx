/**
 * routes/verse/git/WorktreeOption.tsx — "Isolate in worktree" for the New
 * chat dialog (unit C5; SPEC-310C §2 "Worktrees", P1).
 *
 * NewChatDialog is C2's; this is the piece it mounts (CROSS-UNIT request in
 * the C5 report): a checkbox, a name, and one sentence saying exactly what
 * will be created. On submit C2 calls `resolveChatFolder(root, value)` and
 * starts the chat in the folder it returns — the worktree when isolation is
 * on, the project itself when it is off.
 *
 * The name is a slug (the server enforces the same rule); a default is
 * offered so isolation is one click, not a naming exercise.
 */
import { useId } from 'react';
import { createGitWorktree } from './git-queries.js';
import styles from './WorktreeOption.module.css';

export interface WorktreeValue {
  enabled: boolean;
  name: string;
}

/** Same rule as core/verse/worktrees.ts WORKTREE_NAME_RE. */
export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export function isValidWorktreeName(name: string): boolean {
  return WORKTREE_NAME_PATTERN.test(name) && !name.endsWith('.lock') && !name.includes('..');
}

/** A readable default: `chat-0924-1432` (month, day, hour, minute). */
export function defaultWorktreeName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `chat-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Turn free typing into a valid slug as the operator types ("Fix login!" → "fix-login"). */
export function slugifyWorktreeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63);
}

export interface WorktreeOptionProps {
  /** The project folder the chat would start in (its repository name is shown). */
  repoName: string;
  value: WorktreeValue;
  onChange: (next: WorktreeValue) => void;
  disabled?: boolean;
}

export function WorktreeOption({ repoName, value, onChange, disabled = false }: WorktreeOptionProps) {
  const nameId = useId();
  const hintId = useId();
  const valid = isValidWorktreeName(value.name);
  return (
    <fieldset className={styles.option} disabled={disabled}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked, name: value.name || defaultWorktreeName() })}
          aria-describedby={hintId}
        />
        Isolate in a worktree
      </label>
      {value.enabled ? (
        <div className={styles.details}>
          <label className={styles.nameLabel} htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className={styles.name}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: slugifyWorktreeName(e.target.value) })}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={!valid || undefined}
            aria-describedby={hintId}
            maxLength={63}
          />
        </div>
      ) : null}
      <p id={hintId} className={styles.hint}>
        {value.enabled ? (
          valid ? (
            <>
              Creates <code>~/.ashlr-worktrees/{repoName}/{value.name}</code> on a new branch <code>verse/{value.name}</code>, from the current commit.
              Uncommitted changes stay in {repoName}.
            </>
          ) : (
            'Use letters, digits, dots, dashes or underscores.'
          )
        ) : (
          'The chat works on its own branch in its own folder, so your checkout is untouched.'
        )}
      </p>
    </fieldset>
  );
}

/**
 * The folder a new chat should start in: the new worktree when isolation is
 * on (created now, through the mutation token like every git write), the
 * project itself when it is off. Throws the server's refusal (a taken name, a
 * repository with no commits) for the dialog to show.
 */
export async function resolveChatFolder(root: string, value: WorktreeValue): Promise<string> {
  if (!value.enabled) return root;
  const created = await createGitWorktree(root, value.name);
  return created.path;
}
