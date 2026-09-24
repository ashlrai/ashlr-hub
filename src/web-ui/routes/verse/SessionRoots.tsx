/**
 * routes/verse/SessionRoots.tsx — the folders THIS chat can reach, each with
 * its own git identity.
 *
 * WHY PER-ROOT IDENTITY IS THE POINT. A turn that edits two repositories
 * produces two diffs. Without a branch and a dirty count per root, the
 * transcript cannot attribute them, and "3 files changed" silently spans two
 * repositories on two different branches. So every root gets its own line:
 * branch, how many entries are dirty, and how far it has drifted from its
 * upstream.
 *
 * WHAT IT REFUSES TO IMPLY:
 *  - A root the engine cannot reach (a Grok seat takes no additional-directory
 *    flag) is LISTED and marked, never hidden — the operator chose it.
 *  - A root that is not enrolled is marked as refused BY THE AUTONOMOUS LANE,
 *    not as unusable here. This chat can edit it; the fleet cannot.
 *  - A root with no repo says so, rather than leaving a gap that would read as
 *    "clean, on the default branch".
 *
 * The read itself lives in chat/use-session-roots.ts (3.10): shared by every
 * consumer of a chat's roots, and refreshed each time a turn finishes,
 * because a branch is stale the moment a turn commits.
 */
import type { VerseSession, VerseSessionRootsResponse } from '../../data/api-types.js';
import { abbreviateHome } from './chat/path-display.js';
import { rootCaveat, rootGitLine, rootTone } from './workspace-model.js';
import styles from './SessionRoots.module.css';

export interface SessionRootsProps {
  session: VerseSession | null;
  /**
   * 3.10: the roots read, from the chat's shared `useSessionRoots` (one
   * request feeds the header breadcrumb, the dock panes and this list). It is
   * refreshed there whenever the chat's turnCount moves.
   */
  data: VerseSessionRootsResponse | null;
  error?: string | null;
}

export function SessionRoots({ session, data, error = null }: SessionRootsProps) {
  if (!session) return null;

  // A single-folder chat is the overwhelmingly common case and already says
  // which folder it is everywhere else. Showing a one-row "Folders" list for
  // it would be noise, so this surfaces only when there is something to
  // attribute between.
  if (data !== null && data.roots.length <= 1 && data.workspaceId === null) return null;

  return (
    <section className={styles.roots} aria-labelledby="verse-res-roots">
      <h3 id="verse-res-roots" className={styles.title}>
        Folders
        {data ? <span className={styles.count}>{data.roots.length}</span> : null}
      </h3>

      {data?.workspaceName ? (
        <p className={styles.workspace}>
          Workspace <strong>{data.workspaceName}</strong>
        </p>
      ) : null}

      {error ? <p role="alert" className={styles.error}>{error}</p> : null}

      <ul className={styles.list}>
        {(data?.roots ?? []).map((root) => {
          const git = rootGitLine(root);
          const caveat = rootCaveat(root);
          return (
            <li key={root.path} className={styles.root} data-tone={rootTone(root)}>
              <div className={styles.rootHead}>
                <span className={styles.name}>{root.name}</span>
                <span className={styles.badge}>{root.primary ? 'primary' : 'added'}</span>
              </div>
              {/* The path was a hover `title` on the folder name. This card is
                  the one place in the app that exists to ATTRIBUTE a diff to a
                  repository, and two checkouts of the same repo share a name —
                  so the thing that tells them apart cannot be the one fact you
                  have to hover to read. It is shown, directory-first, with the
                  head clipping so the tail that disambiguates stays visible;
                  `~`-abbreviated (3.10.1), the absolute path in the tooltip. */}
              <p className={styles.path} title={root.path}>{abbreviateHome(root.path)}</p>
              <p className={styles.git}>{git ?? 'not a git repo'}</p>
              {root.git?.remote ? <p className={styles.remote}>{root.git.remote}</p> : null}
              {caveat ? <p className={styles.caveat}>{caveat}</p> : null}
            </li>
          );
        })}
      </ul>

      {(data?.notes ?? []).map((note) => (
        <p key={note} className={styles.note}>{note}</p>
      ))}
    </section>
  );
}
