/**
 * routes/verse/autonomy/ScopePanel.tsx — the enrollment registry: the single
 * biggest lever on what the autonomous loop is allowed to touch, and the one
 * with no UI path before V2.
 *
 * The empty state is the important one. An empty registry is the DEFAULT and
 * it means the daemon can mutate nothing at all — so the panel says that in
 * plain words instead of rendering an apologetic "no data" and letting the
 * operator conclude something is broken.
 *
 * Path rules mirror the server (docs/VERSE-CONTRACT-V2.md): absolute paths
 * only, and never anything under `~/.codex/artifacts`. The server is still the
 * authority; this just spares a round trip on an obvious mistake.
 */
import { useState } from 'react';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery } from '../../../data/hooks.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { updateVerseScope, verseScopeQuery } from './control-queries.js';
import { verseAutonomyScopeQuery } from '../verse-queries.js';
import { ROOT_PRIORITY_LABEL, ROOT_PRIORITY_NOTE } from '../workspace-model.js';
import type { VerseAutonomyScopeView } from '../../../data/api-types.js';
import type { VerseScopeRepo } from './control-types.js';
import { tidyProse } from './format.js';
import type { GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

/**
 * Returns an error string, or null when the path is worth sending.
 *
 * A courtesy gate only — `checkVerseScopePath` on the server is the authority
 * and knows the operator's real home directory, which this cannot. The rules
 * mirrored here are the ones expressible without it.
 */
export function validateRepoPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter the absolute path of the repository to enroll.';
  if (!trimmed.startsWith('/')) return 'Enrollment takes an absolute path, e.g. /Users/you/code/project.';
  if (trimmed === '/') return 'The filesystem root cannot be enrolled as autonomous scope.';
  if (/(^|\/)\.codex\/artifacts(\/|$)/.test(trimmed)) return 'Paths under ~/.codex/artifacts cannot be enrolled.';
  // ~/.ashlr holds config.json, the enrollment registry, the KILL sentinel and
  // the private launcher records. Enrolling it would put the agent's own
  // control directory inside the scope those files define.
  if (/(^|\/)\.ashlr(\/|$)/.test(trimmed)) return 'Paths under ~/.ashlr cannot be enrolled — that is the agent’s own control directory.';
  return null;
}

/**
 * One repo's standing in the autonomous lane: its sections and its priority.
 *
 * Renders NOTHING when the repo is in no section and carries the default
 * priority — which is every repo until the operator says otherwise, and is
 * exactly how the panel behaved before sections existed.
 */
function ScopeRepoStanding({ path, scope }: { path: string; scope: VerseAutonomyScopeView | null }) {
  const entry = scope?.entries.find((e) => e.path === path) ?? null;
  if (entry === null) return null;
  const ranked = entry.priority !== 'normal';
  if (!ranked && entry.sections.length === 0) return null;
  return (
    <span className={styles.repoStanding} title={ROOT_PRIORITY_NOTE}>
      {ranked ? <span className={styles.repoPriority}>{ROOT_PRIORITY_LABEL[entry.priority]}</span> : null}
      {entry.sections.map((section) => (
        <span key={section.id} className={styles.repoSection}>{section.name}</span>
      ))}
      {entry.outsideFocus ? <span className={styles.repoOutsideFocus}>outside the focused section</span> : null}
    </span>
  );
}

export function ScopePanel({ guard, dispatchEnabled }: { guard: GuardedAction; dispatchEnabled: boolean }) {
  const scope = useQuery(verseScopeQuery);
  // The RANKED view of the same registry. Read separately so it is obvious
  // these are two facts: what is enrolled, and in what order it is worked on.
  const autonomy = useQuery(verseAutonomyScopeQuery);
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<VerseScopeRepo | null>(null);
  // The path the confirm dialog is asking about. Enrolment GRANTS an
  // autonomous agent write authority over a directory; removal takes authority
  // away and changes nothing on disk. Confirming only the removal put the
  // friction on the safe half, so the grant gets the same step — and in the
  // desktop shell, where the mutation hold never expires, this dialog is the
  // only thing between an Enter keypress and the grant.
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const locked = !dispatchEnabled || guard.readOnly;

  /** Validate, then ASK. The Enter shortcut opens the confirm, never posts. */
  function submitEnroll() {
    const problem = validateRepoPath(path);
    if (problem) {
      setPathError(problem);
      return;
    }
    setPathError(null);
    setEnrolling(path.trim());
  }

  function confirmEnroll() {
    const target = enrolling;
    if (!target) return;
    guard.request(async () => {
      await updateVerseScope({ action: 'enroll', path: target });
      setPath('');
      setEnrolling(null);
    }, 'Enrolling a repository for autonomous work requires the dispatch token.');
  }

  const repos = scope.data?.repos ?? [];

  return (
    <section className={styles.panel} aria-label="Scope">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Scope — enrolled repositories</h3>
        {scope.status === 'refreshing' ? <RefreshIndicator /> : null}
      </div>

      {scope.data?.degradedReason ? (
        <p className={styles.readOnly}>The enrollment registry read is degraded: {tidyProse(scope.data.degradedReason)}</p>
      ) : null}

      {scope.status === 'loading' ? (
        <div className={styles.skeletons}>
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : scope.status === 'error' ? (
        <p className={styles.error} role="alert">
          {scope.error?.message ?? 'Could not read the enrollment registry.'}
        </p>
      ) : repos.length === 0 ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>No repositories are enrolled, so the daemon will do nothing.</span>{' '}
          That is the default and it is not a bug — nothing autonomous can mutate a real repository until you enroll it
          here. Add one below to give the loop somewhere to work.
        </p>
      ) : (
        <div className={styles.repoList}>
          {repos.map((repo) => (
            <div className={styles.repoRow} key={repo.path}>
              <span className={styles.repoName}>{repo.name}</span>
              {/* `direction: rtl` makes the ellipsis eat the head of a long path
                  so its tail survives; <bdi> keeps the path itself reading
                  left-to-right — without it the leading "/" is reordered to
                  the END ("Users/you/code/project/"). */}
              <span className={styles.repoPath} title={repo.path}>
                <bdi>{repo.path}</bdi>
              </span>
              {repo.exists ? null : <span className={styles.repoMissing}>⚠ path missing on disk</span>}
              {/* Workspace membership and rank, so the blast radius is legible:
                  WHICH sections claim this repo, and where the fleet's
                  attention goes. Both are ordering — neither enrols. */}
              <ScopeRepoStanding path={repo.path} scope={autonomy.data ?? null} />
              <button type="button" className={styles.button} disabled={locked || guard.busy} onClick={() => setRemoving(repo)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.addRow}>
        <input
          className={styles.addInput}
          type="text"
          value={path}
          placeholder="/absolute/path/to/repository"
          aria-label="Repository path to enroll"
          aria-invalid={pathError ? true : undefined}
          disabled={locked || guard.busy}
          onChange={(e) => {
            setPath(e.target.value);
            if (pathError) setPathError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitEnroll();
            }
          }}
        />
        <button type="button" className={styles.button} disabled={locked || guard.busy} onClick={submitEnroll}>
          Enroll repository
        </button>
      </div>
      {pathError ? (
        <p className={styles.capError} role="alert">
          {pathError}
        </p>
      ) : null}
      {guard.error && !pathError ? (
        <p className={styles.capError} role="alert">
          {guard.error}
        </p>
      ) : null}

      <ConfirmDialog
        open={enrolling !== null}
        onClose={() => setEnrolling(null)}
        title="Give the autonomous loop write authority here?"
        body={
          <>
            <code>{enrolling}</code> becomes autonomous scope. The loop may propose work against it, and the
            agent&rsquo;s own MCP-native write tools will act on it — enrolment is the gate those tools check.
            <br />
            <br />
            Nothing is written by enrolling. You can remove it again from this panel at any time.
          </>
        }
        confirmLabel="Enroll repository"
        busy={guard.busy}
        error={guard.error}
        onConfirm={confirmEnroll}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this repository from scope?"
        body={
          <>
            The autonomous loop will stop proposing work for <code>{removing?.path}</code>. Existing proposals stay in
            the inbox; nothing on disk is changed or deleted.
          </>
        }
        confirmLabel="Remove from scope"
        destructive
        busy={guard.busy}
        error={guard.error}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          guard.request(async () => {
            await updateVerseScope({ action: 'unenroll', path: target.path });
            setRemoving(null);
          }, 'Removing a repository from autonomous scope requires the dispatch token.');
        }}
      />
    </section>
  );
}
