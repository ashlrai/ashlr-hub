/**
 * routes/verse/composer/BypassConfirmDialog.tsx — the per-chat confirmation
 * in front of Bypass permissions (SPEC-310C §0.6; unit C3).
 *
 * Bypass turns off every permission check the CLI has. It is never a
 * default, never inherited by a new chat, and never one keystroke away: this
 * dialog opens with focus on CANCEL, so Enter-Enter from the picker keeps the
 * chat as it was. Only the explicit red button sends `confirmBypass: true`
 * (the server refuses bypass without it).
 */
import { useId, useRef } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { shortcutLabel } from './composer-keys.js';
import styles from './composer.module.css';

export interface BypassConfirmDialogProps {
  open: boolean;
  /** "Claude Max · Opus 5.5" — which chat this applies to. */
  chatLabel: string;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BypassConfirmDialog({ open, chatLabel, running, onCancel, onConfirm }: BypassConfirmDialogProps) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onClose={onCancel} titleId={titleId} title="Bypass permissions for this chat?" initialFocusRef={cancel}
      description={<>The agent in <strong>{chatLabel}</strong> will run every command and edit every file without asking — including outside the project.</>}>
      <ul className={styles.bypassList}>
        <li>Applies to this chat only{running ? ', from the next turn' : ''}. New chats never inherit it.</li>
        <li>Switch back any time from the Permission menu{shortcutLabel('composer.permission') ? <> (<kbd>{shortcutLabel('composer.permission')}</kbd>)</> : null}.</li>
        <li>Use it in a sandbox or a throwaway worktree, not on work you can’t lose.</li>
      </ul>
      <div className={styles.bypassActions}>
        <Button ref={cancel} variant="subtle" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm}>Bypass for this chat</Button>
      </div>
    </Dialog>
  );
}
