/**
 * components/primitives/Skeleton.tsx — loading placeholders. Used ONLY for
 * `status === 'loading'` (no data at all yet). A resource that already has
 * data and is merely refreshing should show <RefreshIndicator/> instead —
 * never re-blank a populated view (see DESIGN.md "no blank screens").
 */
import styles from './Skeleton.module.css';

export function SkeletonLine({ width = '100%' }: { width?: string }) {
  return <div className={`skeleton ${styles.line}`} style={{ width }} />;
}

export function SkeletonCard() {
  return (
    <div className={styles.card}>
      <div className={`skeleton ${styles.title}`} />
      <div className={`skeleton ${styles.stat}`} />
      <div className={`skeleton ${styles.caption}`} />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className={styles.row}>
      <div className={`skeleton ${styles.cell}`} style={{ width: '18%' }} />
      <div className={`skeleton ${styles.cell}`} style={{ width: '38%' }} />
      <div className={`skeleton ${styles.cell}`} style={{ width: '14%' }} />
      <div className={`skeleton ${styles.cell}`} style={{ width: '10%' }} />
    </div>
  );
}

export function SkeletonCardGrid({ count = 4 }: { count?: number }) {
  return (
    <div className={styles.grid}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
