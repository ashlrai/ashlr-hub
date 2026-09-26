/**
 * routes/verse/shell/copy-setup.ts — ⌘K "Copy autonomy setup command" and
 * onboarding's Copy button: put `ashlr authority setup` (or the setup
 * checklist's next command) on the clipboard and say what to do with it.
 *
 * Split from run-command.ts for the same reason guarded-runners.ts is:
 * run-command is on the chat first-paint path (the shell's key handler runs
 * through it), and nothing here is needed until someone asks to copy — so
 * run-command loads this module with import() when the command runs.
 */
import { copyText } from '../../../components/primitives/clipboard.js';
import { AUTONOMY_SETUP_COMMAND } from './command-catalog.js';
import { shellNotify } from './run-command.js';

/** Copy the setup command (or the checklist's next one) and toast the outcome; resolves to whether it was copied. */
export async function copyAutonomySetupCommand(command: string = AUTONOMY_SETUP_COMMAND): Promise<boolean> {
  const ok = await copyText(command);
  const then = command === AUTONOMY_SETUP_COMMAND
    ? 'add --dry-run to see every step first.'
    : `then rerun \`${AUTONOMY_SETUP_COMMAND}\`.`;
  shellNotify(
    ok
      ? `Copied \`${command}\`. Run it in a terminal; ${then}`
      : `Could not reach the clipboard. Run \`${command}\` in a terminal.`,
    ok ? 'success' : 'neutral',
  );
  return ok;
}
