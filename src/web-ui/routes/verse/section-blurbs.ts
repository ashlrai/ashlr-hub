/** Detailed tour and missing-section descriptions; loaded only when needed. */
import type { VerseSectionId } from './verse-ui-store.js';

export const SECTION_BLURBS: Readonly<Record<VerseSectionId, string>> = {
  'command': 'What the fleet did, what needs you, and the autonomy switch — the morning read.',
  'fleet': 'Every lane live: what is building, what the gates refused, and why each seat was chosen.',
  'growth': 'Is the fleet getting better? Merges, cost per merge and the experiments behind them.',
  'mind': "The Leader's memos, what came of each move, and what the reasoning shows.",
  'chat': 'Talk to a seat. Chats are grouped by project and resume where they stopped.',
  'agents': 'Every chat and agent, by what it needs — with one-click workspaces and Checks.',
  'settings': 'Theme, chat, desktop and keyboard — and this tour again.',
  'apps': 'Seats, terminal agents, local models and MCP servers in one list.',
  'usage': 'Which account you can actually use right now, and what it costs.',
  'wiki': 'A private architecture wiki per repo, written on your own models — and Ask, with cited answers.',
  'playbooks': 'Versioned task templates any chat, goal, cloud or Devin run follows — `!macro` in the message — with how each version’s runs ended.',
  'automations': 'Labelled issues, a red main, schedules and webhooks become work on their own — within your limits and the grant.',
};
