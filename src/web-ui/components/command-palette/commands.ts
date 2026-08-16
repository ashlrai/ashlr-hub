/**
 * components/command-palette/commands.ts — the command registry. Static
 * navigation commands are derived from app/nav-config.ts (single source of
 * truth, shared with the sidebar); action commands are declared here.
 * Extend this array — do not hand-roll a second command list somewhere
 * else.
 */
import { ALL_NAV_LEAVES } from '../../app/nav-config.js';
import { pauseFleet, resumeFleet } from '../../data/mutations.js';

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: 'Navigate' | 'Actions';
  keywords?: string[];
  /** Requires the mutation-token hold; the palette prompts for it if absent. */
  requiresMutationToken?: boolean;
  run: (nav: (path: string) => void) => void | Promise<void>;
}

const navCommands: Command[] = ALL_NAV_LEAVES.map((leaf) => ({
  id: `nav:${leaf.path}`,
  title: leaf.label,
  subtitle: leaf.description,
  group: 'Navigate',
  run: (nav) => nav(leaf.path),
}));

const actionCommands: Command[] = [
  {
    id: 'action:pause-fleet',
    title: 'Pause fleet',
    subtitle: 'Engage the fleet kill switch',
    group: 'Actions',
    keywords: ['stop', 'kill', 'halt'],
    requiresMutationToken: true,
    run: async () => {
      await pauseFleet();
    },
  },
  {
    id: 'action:resume-fleet',
    title: 'Resume fleet',
    subtitle: 'Clear the fleet kill switch',
    group: 'Actions',
    keywords: ['start', 'unpause'],
    requiresMutationToken: true,
    run: async () => {
      await resumeFleet();
    },
  },
];

export const COMMANDS: Command[] = [...navCommands, ...actionCommands];

export function filterCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => {
    const haystack = [c.title, c.subtitle ?? '', ...(c.keywords ?? [])].join(' ').toLowerCase();
    return q.split(/\s+/).every((term) => haystack.includes(term));
  });
}
