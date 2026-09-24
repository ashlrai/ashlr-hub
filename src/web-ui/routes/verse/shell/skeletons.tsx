/**
 * routes/verse/shell/skeletons.tsx — what a surface looks like while its
 * chunk loads (unit C1; SPEC-310C §1 "Surfaces show skeletons while
 * loading"). The pre-3.10 fallback was a bare "Loading…" line; a skeleton in
 * the surface's own shape means the layout does not jump when it lands.
 *
 * Also the designed state for a surface whose module is not in this build
 * (`SurfaceNotInBuild`): it names the surface in operator language — never a
 * source path (the old MissingSection printed `routes/verse/sections/X.tsx`).
 */
import { SkeletonCard, SkeletonLine, SkeletonRow } from '../../../components/primitives/Skeleton.js';
import type { VerseSectionId } from '../verse-ui-store.js';
import styles from './skeletons.module.css';

const DASHBOARD: ReadonlySet<VerseSectionId> = new Set(['command', 'fleet', 'growth', 'mind']);

export function SurfaceSkeleton({ section, label }: { section: VerseSectionId; label: string }) {
  return (
    <div className={styles.frame} role="status" aria-label={`Loading ${label}`} data-skeleton={section}>
      <div className={styles.strip}>
        <SkeletonLine width="140px" />
      </div>
      {section === 'chat' ? (
        <div className={styles.chat}>
          <div className={styles.chatList}>
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonLine key={i} width={`${70 + ((i * 13) % 25)}%`} />
            ))}
          </div>
          <div className={styles.chatBody}>
            <SkeletonLine width="42%" />
            <SkeletonLine width="88%" />
            <SkeletonLine width="76%" />
            <SkeletonLine width="64%" />
          </div>
        </div>
      ) : DASHBOARD.has(section) ? (
        <div className={styles.grid}>
          <div className={styles.wide}><SkeletonLine width="60%" /></div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={styles.kpi}><SkeletonCard /></div>
          ))}
          <div className={styles.half}><SkeletonCard /></div>
          <div className={styles.half}><SkeletonCard /></div>
        </div>
      ) : (
        <div className={styles.column}>
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A surface this build does not ship yet. */
export function SurfaceNotInBuild({ label, blurb }: { label: string; blurb: string }) {
  return (
    <div className={styles.missing} role="status">
      <h1 className={styles.missingTitle}>{label} isn't in this build yet</h1>
      <p className={styles.missingBody}>{blurb}</p>
      <p className={styles.missingBody}>It appears here as soon as it ships. Everything else in Verse works normally.</p>
    </div>
  );
}
