/**
 * routes/verse/composer/ControlsSheet.tsx — the 375px composer's "⋯": the
 * Permission, Model and Effort pickers in one bottom sheet (SPEC-310C §2 "At
 * 375px"; unit C3).
 *
 * A phone footer holds [+] [mic], the seat, ⋯ and Send. A popover per picker
 * would open over the keyboard and off the screen edge, so the three become
 * radio lists in a sheet that rises from the bottom. It traps focus while
 * open, Esc and the backdrop close it, and focus returns to ⋯.
 *
 * Below the pickers: "Use playbook…" (3.15) — puts a playbook's `!macro` in
 * the message — then "Run in cloud" (3.11 cloud lane) — launches the typed
 * message as a cloud task — and "Run in Devin" (3.15 Devin lane). All are
 * import()s loaded the first time the sheet opens, so nothing cloud- or
 * Devin-related is on the chat's first-paint path.
 */
import { lazy, Suspense, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import styles from './composer.module.css';

const RunInCloudAction = lazy(() => import('../cloud/RunInCloudAction.js').then((m) => ({ default: m.RunInCloudAction })));
const RunInDevinAction = lazy(() => import('../devin/RunInDevinAction.js').then((m) => ({ default: m.RunInDevinAction })));
const UsePlaybookAction = lazy(() => import('../playbooks/UsePlaybookAction.js').then((m) => ({ default: m.UsePlaybookAction })));

export interface ControlsSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ControlsSheet({ open, onClose, children }: ControlsSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useFocusTrap({ open, containerRef: panel, onClose, initialFocusRef: close });
  if (!open) return null;
  return createPortal(
    <div className={styles.sheetBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.sheetHeader}>
          <h2 id={titleId} className={styles.sheetTitle}>Chat settings</h2>
          <button ref={close} type="button" className={styles.sheetClose} onClick={onClose}>Done</button>
        </div>
        <p className={styles.sheetNote}>Changes apply from the next turn.</p>
        <div className={styles.sheetBody}>
          {children}
          <Suspense fallback={<ActionLoading label="Loading playbooks…" />}>
            <UsePlaybookAction />
          </Suspense>
          <Suspense fallback={<ActionLoading label="Loading cloud action…" />}>
            <RunInCloudAction />
          </Suspense>
          <Suspense fallback={<ActionLoading label="Loading Devin action…" />}>
            <RunInDevinAction />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ActionLoading({ label }: { label: string }) {
  return <div className={styles.actionLoading} role="status" aria-label={label}>
    <span>{label}</span><div aria-hidden="true"><SkeletonLine width="72%" /></div>
  </div>;
}
