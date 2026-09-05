/**
 * components/command-palette/commands.ts — the command registry. Static
 * navigation commands are derived from app/nav-config.ts (single source of
 * truth, shared with the sidebar); action commands are declared here.
 * Extend this array — do not hand-roll a second command list somewhere
 * else.
 *
 * Two additional command sources are generated fresh on every palette
 * open/keystroke rather than living in the static COMMANDS array, because
 * they need live router/cache state a plain module-load-time array can't
 * capture:
 *   - buildContextCommands(pathname) — actions scoped to what the operator
 *     is already looking at (right now: approve/reject when on /inbox/:id
 *     and that proposal is still pending)
 *   - buildJumpCommands(query) — fuzzy id/title search across whatever
 *     runs/proposals/goals are already cached, generated FROM the query
 *     rather than filtered by it after the fact
 *
 * Every guarded action (pause/resume fleet, approve/reject a proposal)
 * carries `requiresConfirm` AND `requiresMutationToken` and goes through
 * both, in that order — CommandPalette.tsx enforces this the same way
 * FleetView/ProposalDetail already do for their own buttons. The palette is
 * a second entry point into the same actions, never a shortcut around their
 * safety gates.
 */
import { ALL_NAV_LEAVES } from '../../app/nav-config.js';
import { pauseFleet, resumeFleet, approveProposal, rejectProposal } from '../../data/mutations.js';
import { openPanel as openNotificationPanel } from '../notifications/notification-store.js';
import { getQuerySnapshot, runQuery } from '../../data/cache.js';
import { runsQuery, goalsQuery, inboxListQuery, type GoalSummary, type InboxListResponse } from '../../data/queries.js';
import { cycleTheme } from '../../data/theme-store.js';
import type { RunState } from '../../data/api-types.js';

export interface CommandConfirm {
  title: string;
  body: string;
  confirmLabel: string;
  /** Approve-shaped actions read as primary even though irreversible;
   * reject/pause-shaped ones read as destructive. Matches ConfirmDialog's
   * own `destructive` prop 1:1. */
  destructive?: boolean;
}

export type NavigateFn = (path: string, opts?: { state?: unknown }) => void;

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: 'Navigate' | 'Actions' | 'Jump to';
  keywords?: string[];
  /** Shown before anything runs, regardless of token state — the palette
   * must never let a guarded action skip the same confirm step its regular
   * UI requires. */
  requiresConfirm?: CommandConfirm;
  /** Requires the mutation-token hold; the palette prompts for it if
   * absent, after any requiresConfirm step. */
  requiresMutationToken?: boolean;
  run: (nav: NavigateFn) => void | Promise<void>;
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
    requiresConfirm: {
      title: 'Pause the fleet?',
      body: 'This engages the global kill switch. Autonomous dispatch halts fleet-wide until explicitly resumed.',
      confirmLabel: 'Yes, pause',
    },
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
    requiresConfirm: {
      title: 'Resume the fleet?',
      body: 'This clears the global kill switch. Autonomous dispatch will resume across the fleet.',
      confirmLabel: 'Yes, resume',
    },
    requiresMutationToken: true,
    run: async () => {
      await resumeFleet();
    },
  },
  {
    id: 'action:open-notifications',
    title: 'Open notification centre',
    subtitle: 'What needs you right now, ranked by severity',
    group: 'Actions',
    keywords: ['alerts', 'attention', 'bell', 'needs you'],
    run: () => {
      openNotificationPanel();
    },
  },
  {
    id: 'action:toggle-theme',
    title: 'Toggle theme',
    subtitle: 'Cycle system → light → dark',
    group: 'Actions',
    keywords: ['dark mode', 'light mode', 'appearance', 'dark', 'light'],
    run: () => {
      cycleTheme();
    },
  },
  {
    id: 'action:open-journal-today',
    title: 'Open journal — today',
    subtitle: 'Work journal filtered to today',
    group: 'Actions',
    keywords: ['journal', 'today', 'log', 'history'],
    run: (nav) => {
      nav('/journal', { state: { windowToday: true } });
    },
  },
];

export const COMMANDS: Command[] = [...navCommands, ...actionCommands];

/**
 * Warm the caches buildJumpCommands reads from. Fire-and-forget: called
 * once when the palette opens so jump results are ready by the time the
 * operator finishes typing. runQuery is safe to call redundantly (in-flight
 * de-dupe) and never throws into the caller — a cold/failed cache just
 * means jump results appear a beat late or not at all, never an error
 * surfaced through the palette.
 */
export function warmJumpCaches(): void {
  void runQuery(runsQuery.key, runsQuery.fetch);
  void runQuery(goalsQuery.key, goalsQuery.fetch);
  const allProposals = inboxListQuery({ status: 'all', limit: 500 });
  void runQuery(allProposals.key, allProposals.fetch);
}

const JUMP_LIMIT = 5;
const JUMP_MIN_QUERY_LEN = 2;

function matchesJump(haystack: string, q: string): boolean {
  return haystack.toLowerCase().includes(q);
}

/**
 * Jump-to-id/title search across whatever's already cached for
 * runs/proposals/goals — substring match, same rigor as filterCommands'
 * static search (no fuzzy-match library exists anywhere in this repo).
 * Generated FROM the query, unlike filterCommands: these commands don't
 * exist until there's something short enough to be worth jumping to.
 */
export function buildJumpCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (q.length < JUMP_MIN_QUERY_LEN) return [];

  const results: Command[] = [];

  const runs = getQuerySnapshot<RunState[]>(runsQuery.key).data ?? [];
  for (const run of runs) {
    if (results.length >= JUMP_LIMIT) break;
    if (matchesJump(run.id, q) || matchesJump(run.goal, q)) {
      results.push({
        id: `jump:run:${run.id}`,
        title: run.goal,
        subtitle: `Run ${run.id} · ${run.status}`,
        group: 'Jump to',
        run: (nav) => nav(`/work/runs/${run.id}`),
      });
    }
  }

  const goals = getQuerySnapshot<GoalSummary[]>(goalsQuery.key).data ?? [];
  let goalCount = 0;
  for (const goal of goals) {
    if (goalCount >= JUMP_LIMIT) break;
    if (matchesJump(goal.id, q) || matchesJump(goal.objective, q)) {
      goalCount++;
      results.push({
        id: `jump:goal:${goal.id}`,
        title: goal.objective,
        subtitle: `Goal ${goal.id} · ${goal.status}`,
        group: 'Jump to',
        // No per-goal detail route exists yet (routes.tsx only has the
        // /goals list) — jump lands on the list, same as every other goal
        // link in the app today.
        run: (nav) => nav('/goals'),
      });
    }
  }

  const proposalsKey = inboxListQuery({ status: 'all', limit: 500 }).key;
  const proposals = getQuerySnapshot<InboxListResponse>(proposalsKey).data?.proposals ?? [];
  let proposalCount = 0;
  for (const p of proposals) {
    if (proposalCount >= JUMP_LIMIT) break;
    if (matchesJump(p.id, q) || matchesJump(p.title, q)) {
      proposalCount++;
      results.push({
        id: `jump:proposal:${p.id}`,
        title: p.title,
        subtitle: `Proposal ${p.id} · ${p.status}`,
        group: 'Jump to',
        run: (nav) => nav(`/inbox/${encodeURIComponent(p.id)}`),
      });
    }
  }

  return results;
}

const PROPOSAL_ROUTE_RE = /^\/inbox\/([^/]+)$/;

interface CachedProposalDetail {
  id: string;
  title: string;
  status: string;
}

/**
 * Contextual actions scoped to the current route — right now just
 * approve/reject when the operator is already looking at one pending
 * proposal (/inbox/:id). Reads the same `proposal-detail-${id}` cache key
 * ProposalDetail.tsx populates (data/queries.ts's proposalDetailQuery) —
 * if it isn't warm yet (e.g. the palette is opened before that view
 * finishes its own fetch) this simply omits the contextual commands rather
 * than guessing at proposal state.
 */
export function buildContextCommands(pathname: string): Command[] {
  const match = PROPOSAL_ROUTE_RE.exec(pathname);
  if (!match) return [];
  const id = decodeURIComponent(match[1]!);
  const detail = getQuerySnapshot<CachedProposalDetail>(`proposal-detail-${id}`).data;
  if (!detail || detail.status !== 'pending') return [];

  return [
    {
      id: `action:approve-proposal:${id}`,
      title: `Approve "${detail.title}"`,
      subtitle: 'Writes the diff to disk and dispatches it',
      group: 'Actions',
      keywords: ['approve', 'ship', 'proposal'],
      requiresConfirm: {
        title: 'Approve this proposal?',
        body: `"${detail.title}" will be applied. This writes the diff to disk and dispatches it.`,
        confirmLabel: 'Approve',
      },
      requiresMutationToken: true,
      run: async () => {
        await approveProposal(id);
      },
    },
    {
      id: `action:reject-proposal:${id}`,
      title: `Reject "${detail.title}"`,
      subtitle: 'Cannot be undone',
      group: 'Actions',
      keywords: ['reject', 'decline', 'proposal'],
      requiresConfirm: {
        title: 'Reject this proposal?',
        body: `"${detail.title}" will be rejected. This cannot be undone.`,
        confirmLabel: 'Reject',
        destructive: true,
      },
      requiresMutationToken: true,
      run: async () => {
        await rejectProposal(id);
      },
    },
  ];
}

/**
 * Static + contextual commands, substring-matched against the query (every
 * whitespace-split term must match), plus fuzzy jump results appended at
 * the end. Context commands are searched like any other — they don't get a
 * free pass past the query.
 */
export function filterCommands(query: string, contextCommands: Command[] = []): Command[] {
  const q = query.trim().toLowerCase();
  const staticAndContext = [...contextCommands, ...COMMANDS];
  const staticMatches = !q
    ? staticAndContext
    : staticAndContext.filter((c) => {
        const haystack = [c.title, c.subtitle ?? '', ...(c.keywords ?? [])].join(' ').toLowerCase();
        return q.split(/\s+/).every((term) => haystack.includes(term));
      });
  return [...staticMatches, ...buildJumpCommands(query)];
}
