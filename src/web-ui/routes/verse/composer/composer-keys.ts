/**
 * routes/verse/composer/composer-keys.ts — the composer's keys, read from
 * C0's command catalog (the one table the palette, the shortcuts overlay and
 * the native menu also read), never re-declared here (unit C3).
 */
import {
  chordMatches,
  findCommand,
  formatChord,
  type KeyEventLike,
} from '../shell/command-catalog.js';

/** The composer commands this unit implements (command-catalog ids). */
export const COMPOSER_COMMAND_IDS = [
  'composer.permission',
  'composer.model',
  'composer.effort',
  'composer.attach',
  'composer.send',
  'composer.stop-and-send',
  'composer.stop',
] as const;
export type ComposerCommandId = (typeof COMPOSER_COMMAND_IDS)[number];

/**
 * The window event the palette (C1) and the native menu bridge dispatch to
 * run a catalog command on the surface that owns it. Defined in C0's
 * command-catalog.ts (beside the ids it carries); re-exported here so the
 * composer's importers keep one import site.
 */
export { WORKBENCH_COMMAND_EVENT } from '../shell/command-catalog.js';

/** Does this key event press the catalog chord for `id`? */
export function pressesCommand(event: KeyEventLike, id: ComposerCommandId): boolean {
  const command = findCommand(id);
  return command !== null && command.keys.some((chord) => chordMatches(event, chord));
}

/** The chord for `id` as the platform prints it ("⇧⌘M" / "Ctrl+Shift+M"); '' when unbound. */
export function shortcutLabel(id: ComposerCommandId): string {
  const chord = findCommand(id)?.keys[0];
  return chord ? formatChord(chord) : '';
}
