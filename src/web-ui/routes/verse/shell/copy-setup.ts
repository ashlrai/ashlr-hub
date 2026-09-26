/**
 * routes/verse/shell/copy-setup.ts — ⌘K "Copy autonomy setup command" and
 * onboarding's Copy button: put `ashlr authority setup` on the clipboard and
 * say what to do with it.
 *
 * Split from run-command.ts for the same reason guarded-runners.ts is:
 * run-command is on the chat first-paint path (the shell's key handler runs
 * through it), and nothing here is needed until someone asks to copy — so
 * run-command loads this module with import() when the command runs.
 */
import { copyText } from '../../../components/primitives/clipboard.js';
import { AUTONOMY_SETUP_COMMAND } from './command-catalog.js';
import { shellNotify } from './run-command.js';

/** Copy the setup command and toast the outcome; resolves to whether it was copied. */
export async function copyAutonomySetupCommand(): Promise<boolean> {
  const ok = await copyText(AUTONOMY_SETUP_COMMAND);
  shellNotify(
    ok
      ? `Copied \`${AUTONOMY_SETUP_COMMAND}\`. Run it in a terminal; add --dry-run to see every step first.`
      : `Could not reach the clipboard. Run \`${AUTONOMY_SETUP_COMMAND}\` in a terminal.`,
    ok ? 'success' : 'neutral',
  );
  return ok;
}
