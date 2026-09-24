/**
 * adapters/turn-extras.ts — the V3.10 per-turn launch extras (unit C3).
 *
 * Its own module, not index.ts, because the adapters import it and index.ts
 * imports the adapters: keeping the helpers here leaves no import cycle.
 */
import type { VerseSeatLaunch } from '../session-engine.js';

/**
 * V3.10 (unit C3) — per-turn extras the engine layers onto the seat launch it
 * hands `buildLaunch` (`{ ...seatLaunch, ...extras }`). Never persisted: the
 * launch record on disk stays exactly what `createSession` pinned. Read
 * structurally (like `nativeSession` / `thinkingDisplay`), so a launch without
 * them — every test fixture, every recovery before 3.10 — builds as before.
 */
export interface VerseTurnExtras {
  /**
   * The ONE attachment directory this turn's message names, when it names
   * any (`attachments.ts resolveAttachmentRefs`) — granted with exactly one
   * `--add-dir` on the engines that need a grant to read outside the cwd.
   */
  attachmentDirs?: string[];
  /** Absolute paths of the attached image files (codex passes them as `--image`). */
  attachmentImages?: string[];
}

function absoluteStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('/') && !item.includes('\0'))
    : [];
}

/** The attachment directories on a turn launch (empty when none). */
export function turnAttachmentDirs(launch: VerseSeatLaunch): string[] {
  return absoluteStrings((launch as VerseSeatLaunch & VerseTurnExtras).attachmentDirs);
}

/** The attached images on a turn launch (empty when none). */
export function turnAttachmentImages(launch: VerseSeatLaunch): string[] {
  return absoluteStrings((launch as VerseSeatLaunch & VerseTurnExtras).attachmentImages);
}
