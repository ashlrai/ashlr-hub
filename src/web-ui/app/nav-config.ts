/**
 * app/nav-config.ts — single source of truth for navigation hierarchy.
 * routes.tsx, components/layout/Sidebar.tsx, and the command palette all
 * read this one list rather than each maintaining their own — the audit
 * that kicked this rebuild off found 14 flat, ~70%-overlapping hash links
 * because the old app had no such shared structure. Add a route here once;
 * it shows up in the sidebar AND ⌘K automatically.
 *
 * Only `overview` has a real view wired up (FleetDashboardView — the
 * foundation's reference implementation). Every other leaf renders
 * <PlaceholderView/> until another agent builds it; see routes.tsx.
 */

export interface NavLeaf {
  path: string;
  label: string;
  description: string;
  /** Present once a real view exists; routes.tsx falls back to a placeholder otherwise. */
  implemented?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  leaves: NavLeaf[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    leaves: [
      {
        path: '/overview',
        label: 'Fleet Dashboard',
        description: 'Repos, activity, runs, swarms, MCP health, genome, and daemon status at a glance.',
        implemented: true,
      },
    ],
  },
  {
    id: 'journal',
    label: 'Journal',
    leaves: [
      {
        path: '/journal',
        label: 'Work Journal',
        description:
          'Chronological, filterable, scrubable record of runs, merges, judge verdicts, and daemon ticks — with live streaming into any in-progress run.',
        implemented: true,
      },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    leaves: [
      {
        path: '/work/runs',
        label: 'Runs',
        description: 'Dispatched goal runs and their token burn.',
        implemented: true,
      },
      {
        path: '/work/swarms',
        label: 'Swarms',
        description: 'Multi-task DAG runs with live burndown.',
        implemented: true,
      },
    ],
  },
  {
    id: 'inbox',
    label: 'Inbox',
    leaves: [
      {
        path: '/inbox',
        label: 'Proposals',
        description: 'Review, filter, and approve/reject proposals — including history (rejected/approved).',
        implemented: true,
      },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    leaves: [
      {
        path: '/control/daemon',
        label: 'Daemon',
        description: 'Autonomous operator state, spend, and direction mode.',
        implemented: true,
      },
      {
        path: '/control/fleet',
        label: 'Fleet',
        description: 'Queue depth, lease health, and the kill switch.',
        implemented: true,
      },
      {
        path: '/control/security',
        label: 'Security',
        description: 'Supply-chain / binshield findings from the cached backlog.',
        implemented: true,
      },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    leaves: [
      {
        path: '/intelligence/pulse',
        label: 'Pulse',
        description: 'Activity rollups over the dashboard window.',
        implemented: true,
      },
      {
        path: '/intelligence/genome',
        label: 'Genome',
        description: 'Cross-repo knowledge search and recall.',
        implemented: true,
      },
      {
        path: '/intelligence/production',
        label: 'Production',
        description: 'Ships-per-day, judge verdicts, auto-merges.',
        implemented: true,
      },
    ],
  },
  {
    id: 'portfolio',
    label: 'Portfolio',
    leaves: [
      {
        path: '/portfolio',
        label: 'Portfolio',
        description: 'Org-level roll-up across enrolled repos.',
        implemented: true,
      },
    ],
  },
  {
    id: 'goals',
    label: 'Goals',
    leaves: [
      { path: '/goals', label: 'Goals', description: 'Active goals and milestone progress.', implemented: true },
    ],
  },
];

export const ALL_NAV_LEAVES: NavLeaf[] = NAV_GROUPS.flatMap((g) => g.leaves);
