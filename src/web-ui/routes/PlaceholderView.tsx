/**
 * routes/PlaceholderView.tsx — every nav leaf in app/nav-config.ts without
 * `implemented: true` renders this instead of a real view. It exists so
 * the routing/nav/palette foundation is provably complete end-to-end
 * (every path resolves to *something* real, deep-links work, back/forward
 * works) without pretending unbuilt views are built. View agents replace
 * this by adding `implemented: true` to the leaf and pointing its route at
 * a real component — see routes.tsx and DESIGN.md "Adding a view".
 */
import styles from './PlaceholderView.module.css';

export function PlaceholderView({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
      <p className={styles.note}>Not built yet — this route, its nav entry, and its ⌘K command all already work.</p>
    </div>
  );
}
