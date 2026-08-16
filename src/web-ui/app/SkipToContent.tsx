/**
 * app/SkipToContent.tsx — a real skip link, deliberately NOT `<a
 * href="#main-content">`: this app uses HashRouter, so a literal `#`
 * anchor would rewrite location.hash and hijack client-side routing
 * instead of just scrolling. A button that imperatively focuses the
 * `#main-content` element (set on <main> in components/layout/Shell.tsx)
 * gets the same keyboard behavior without touching the route.
 */
import styles from './SkipToContent.module.css';

export function SkipToContent() {
  return (
    <button
      type="button"
      className={styles.skipLink}
      onClick={() => {
        const main = document.getElementById('main-content');
        main?.focus();
        main?.scrollIntoView({ block: 'start' });
      }}
    >
      Skip to content
    </button>
  );
}
