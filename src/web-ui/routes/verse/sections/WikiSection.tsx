/**
 * routes/verse/sections/WikiSection.tsx — the Repo wiki tray section (3.15).
 * Takes no props, per the shell contract; its own lazy chunk (the section
 * glob in shell/section-modules.ts), so the wiki — and the Markdown renderer
 * it shares with chat — never touch first paint. Reached from the gear tray
 * and from ⌘K ("Open repo wiki…", "Ask the codebase…").
 */
import { WikiView } from '../wiki/WikiView.js';

export function WikiSection() {
  return <WikiView />;
}
