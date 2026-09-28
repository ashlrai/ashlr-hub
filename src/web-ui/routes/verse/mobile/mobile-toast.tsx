/**
 * routes/verse/mobile/mobile-toast.tsx — one-line confirmations under the
 * status bar ("Approved: fix the flaky test"). A module store rather than a
 * context so a helper outside React (an action's onDone) can post one; one
 * aria-live region announces each once.
 */
import { useSyncExternalStore } from 'react';
import partStyles from './parts.module.css';
import coreStyles from './ui.module.css';

const styles = { ...coreStyles, ...partStyles };

export type MobileToastTone = 'neutral' | 'success' | 'danger';

interface ToastItem {
  id: number;
  message: string;
  tone: MobileToastTone;
}

const AUTO_DISMISS_MS = 4000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: ToastItem[]): void {
  items = next;
  for (const l of [...listeners]) l();
}

function dismiss(id: number): void {
  emit(items.filter((t) => t.id !== id));
}

export function showMobileToast(message: string, tone: MobileToastTone = 'neutral'): void {
  const id = nextId++;
  // At most three: a burst of actions must not bury the screen.
  emit([...items.slice(-2), { id, message, tone }]);
  setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
}

export function resetMobileToastsForTest(): void {
  emit([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function MobileToasts() {
  const current = useSyncExternalStore(subscribe, () => items, () => items);
  return (
    <div className={styles.toasts} role="status" aria-live="polite">
      {current.map((t) => (
        <div key={t.id} className={styles.toast} data-tone={t.tone}>
          <span>{t.message}</span>
          <button type="button" className={`${styles.btn} ${styles.iconBtn}`} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
