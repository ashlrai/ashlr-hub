/**
 * routes/verse/mobile/mobile-actions.ts — every write the phone makes goes
 * through here: confirmation (unless the action is trivially undoable), then
 * the mutation token if it is not held, then the call — the one order
 * shell/guard-store.ts enforces for the desktop too. MobileGuardSheet draws
 * it; this module only describes the action.
 */
import { requestGuarded } from '../shell/guard-store.js';
import { showMobileToast } from './mobile-toast.js';

export interface MobileAction {
  /** Sheet title: the question ("Stop the fleet?"). */
  title: string;
  /** What will happen, in operator language — the sheet's body. */
  consequences: string;
  /** The confirm button ("Stop fleet"). */
  confirmLabel: string;
  destructive?: boolean;
  /**
   * false = no confirmation sheet (Pause, Send): the token prompt still
   * appears if the hold has lapsed, and a failure becomes a toast.
   */
  confirm?: boolean;
  run: () => Promise<unknown>;
  /** Toast after success; omit for none. */
  success?: string;
  onDone?: () => void;
}

/** Start `action`. False when another guarded action is already open. */
export function runMobileAction(action: MobileAction): boolean {
  const confirm = action.confirm !== false;
  return requestGuarded({
    title: action.title,
    body: action.consequences,
    confirmLabel: action.confirmLabel,
    destructive: action.destructive === true,
    token: true,
    tokenReason: `${action.confirmLabel} changes state on your Mac and needs the mutation token \`ashlr verse\` printed.`,
    skipConfirm: !confirm,
    run: async () => {
      await action.run();
    },
    onDone: () => {
      if (action.success) showMobileToast(action.success, 'success');
      action.onDone?.();
    },
    onError: confirm ? undefined : (message) => showMobileToast(message, 'danger'),
  });
}
