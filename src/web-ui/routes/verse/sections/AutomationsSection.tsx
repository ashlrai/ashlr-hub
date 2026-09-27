/**
 * routes/verse/sections/AutomationsSection.tsx — the Automations tray
 * section (3.15). Takes no props, per the shell contract; its own lazy chunk
 * (the section glob in shell/section-modules.ts). Reached from the gear tray
 * and from ⌘K ("Open Automations", "New automation…").
 */
import { AutomationsView } from '../automations/AutomationsView.js';

export function AutomationsSection() {
  return <AutomationsView />;
}
