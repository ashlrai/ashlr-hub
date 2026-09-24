/**
 * routes/verse/dock/dock-panes.ts — which dock panes exist in this build,
 * and their names (unit C2).
 *
 * Split out of Dock.tsx so the header's pane toggles can ask without pulling
 * the dock itself into the chat's first-paint chunk: the dock is lazy (it
 * starts closed), the toggles are not.
 */
import { DOCK_PANES, type DockPaneId } from '../shell/dock-catalog.js';
import { isSlotAvailable, type SlotId } from '../shell/slots.js';

const SLOT_FOR: Readonly<Partial<Record<DockPaneId, SlotId>>> = Object.fromEntries(
  DOCK_PANES.filter((p) => p.slot !== null).map((p) => [p.id, p.slot]),
);

/** A pane exists in this build: C2's always, a slot pane once its unit's file landed. */
export function isPaneAvailable(pane: DockPaneId): boolean {
  const slot = SLOT_FOR[pane];
  return slot === undefined || isSlotAvailable(slot);
}

export const DOCK_PANE_LABEL: Readonly<Record<DockPaneId, string>> = Object.fromEntries(
  DOCK_PANES.map((p) => [p.id, p.label]),
) as Record<DockPaneId, string>;
