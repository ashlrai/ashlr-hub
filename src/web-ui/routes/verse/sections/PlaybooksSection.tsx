/**
 * routes/verse/sections/PlaybooksSection.tsx — the Playbooks tray section
 * (3.15). Takes no props, per the shell contract; its own lazy chunk (the
 * section glob in shell/section-modules.ts). Reached from the gear tray and
 * from ⌘K ("Open Playbooks", "Run playbook…").
 */
import { PlaybooksView } from '../playbooks/PlaybooksView.js';

export function PlaybooksSection() {
  return <PlaybooksView />;
}
