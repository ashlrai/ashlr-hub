/**
 * routes/verse/sections/AgentsSection.tsx — the Agents board (⌘6, 3.16).
 * Takes no props, per the shell contract; its own lazy chunk (the section
 * glob in shell/section-modules.ts), so the board costs chat first paint
 * nothing.
 */
import { AgentsBoard } from '../agents/AgentsBoard.js';

export function AgentsSection() {
  return <AgentsBoard />;
}
