import { sectionEntry } from '../verse-ui-store.js';
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';

/** Intent describes the view, never a permission or a fleet activation. */
export type WorkMode = 'with-me' | 'for-me';

export const WORK_MODES = [
  { id: 'with-me', label: 'Work with me', section: 'chat', description: 'Talk, ask questions, and guide a chat.' },
  { id: 'for-me', label: 'Work for me', section: 'fleet', description: 'Give agents tasks and manage the fleet.' },
] as const;

export function workModeForSection(section: WorkbenchSectionId): WorkMode | null {
  if (section === 'chat') return 'with-me';
  // The existing rail groups delegated work; shared tools live in the tray.
  if (sectionEntry(section).placement === 'rail') return 'for-me';
  // Shared tools belong to either intent. A settings visit is not a mode change.
  return null;
}

export function workModeSection(mode: WorkMode): 'chat' | 'fleet' {
  return mode === 'with-me' ? 'chat' : 'fleet';
}
