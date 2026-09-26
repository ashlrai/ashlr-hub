/**
 * routes/verse/composer/composer-keys.ts — the composer's keys, read from
 * C0's key table (shell/command-keys.ts, the keys half of the command
 * catalog the palette, the shortcuts overlay and the native menu also
 * read), never re-declared here (unit C3).
 */
import {
  chordMatches,
  commandChord,
  formatChord,
  keyBinding,
  type KeyEventLike,
} from '../shell/command-keys.js';

/** The composer commands this unit implements (command-catalog ids). */
export const COMPOSER_COMMAND_IDS = [
  'composer.permission',
  'composer.model',
  'composer.effort',
  'composer.attach',
  'composer.cloud',
  'composer.send',
  'composer.stop-and-send',
  'composer.stop',
] as const;
export type ComposerCommandId = (typeof COMPOSER_COMMAND_IDS)[number];

/**
 * The window event the palette (C1) and the native menu bridge dispatch to
 * run a catalog command on the surface that owns it. Defined in C0's
 * command-keys.ts (beside the ids it carries); re-exported here so the
 * composer's importers keep one import site.
 */
export { WORKBENCH_COMMAND_EVENT } from '../shell/command-keys.js';

/** Does this key event press the catalog chord for `id`? */
export function pressesCommand(event: KeyEventLike, id: ComposerCommandId): boolean {
  const binding = keyBinding(id);
  return binding !== null && binding.keys.some((chord) => chordMatches(event, chord));
}

/** The chord for `id` as the platform prints it ("⇧⌘M" / "Ctrl+Shift+M"); '' when unbound. */
export function shortcutLabel(id: ComposerCommandId): string {
  const chord = commandChord(id);
  return chord ? formatChord(chord) : '';
}
