/**
 * routes/verse/sections/section-fixtures.test-support.ts — hand-built payloads
 * for the Autonomy/Approvals section tests, shaped to the V2 contract.
 *
 * Deliberately NOT snapshots of a live server: these ARE the assertion that
 * the UI codes against the documented contract. They are now typed by the
 * REAL `src/core/verse/control-types.ts` declarations (via
 * routes/verse/autonomy/control-types.ts), so a server-side shape change
 * fails the typecheck here rather than degrading silently in the browser.
 */
import { VERSE_DAEMON_PAUSE_NOTE, VERSE_KILL_SWITCH_NOTE } from '../autonomy/control-types.js';
import { localDateKey } from '../autonomy/format.js';
import type { VerseCaps, VerseControlSnapshot, VerseSafetyReport } from '../autonomy/control-types.js';

/**
 * The ledger day for a HEALTHY fixture. It has to be today's, not a frozen
 * string: `spend.todayUsd` is only a statement about today when
 * `spend.todayDate` says so, and the panels now check. A hardcoded date made
 * every fixture permanently stale the day after it was written.
 */
export const TODAY = localDateKey();

export const CAPS: VerseCaps = {
  dailyBudgetUsd: 25,
  perTickItems: 4,
  parallel: 2,
  intervalMs: 900_000,
  mode: 'batch',
  maxConcurrent: 8,
  concurrency: { local: 2, cloud: 6, total: 8 },
  subscriptionMaxPercent: 80,
  foundryLimits: [{ engine: 'claude', window: '7d', max: 2000 }],
  defaulted: [],
};

export function controlSnapshot(over: Partial<VerseControlSnapshot> = {}): VerseControlSnapshot {
  const lastTickAt = new Date(Date.now() - 60_000).toISOString();
  return {
    generatedAt: new Date().toISOString(),
    daemon: {
      observedAt: new Date().toISOString(),
      runtimeState: 'running',
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      running: true,
      pid: 4242,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastTickAt,
      todayDate: TODAY,
      todaySpentUsd: 4.5,
      itemsProcessed: 12,
      ticks: [
        {
          ts: lastTickAt,
          itemsConsidered: 3,
          proposalsCreated: 1,
          spentUsd: 0.42,
          reason: 'ok',
          dispatches: [
            {
              itemId: 'wi-1',
              title: 'Tighten the enrollment guard',
              repo: '/Users/m/code/hub',
              source: 'todo',
              backend: 'codex',
              tier: 'frontier',
              assignedBy: 'router',
              reason: 'routed',
              dispatched: true,
              spentUsd: 0.42,
            },
          ],
        },
      ],
    },
    fleet: {
      directionMode: 'auto-merge-ready',
      directionAt: lastTickAt,
      directionReason: 'resource headroom',
      autonomyControlLoop: true,
      autonomyControlMode: 'observe',
      service: { registrationState: 'present', installed: true, running: true, runtimeState: 'running' },
      freshness: { stale: false, ageMs: 1_200 },
    },
    caps: CAPS,
    scope: { repos: [{ path: '/Users/m/code/hub', name: 'hub', exists: true }] },
    killSwitch: { state: 'inactive', sourceState: 'healthy', reason: 'missing', note: VERSE_KILL_SWITCH_NOTE },
    // The daemon-scoped pause is a SEPARATE sentinel from the kill switch above.
    // Default fixture: not paused, proven so (the sentinel is absent).
    pause: {
      state: 'running',
      sourceState: 'healthy',
      reason: 'missing',
      pausedAt: null,
      by: null,
      note: VERSE_DAEMON_PAUSE_NOTE,
    },
    pendingApprovals: 2,
    spend: { todayUsd: 4.5, todayDate: TODAY, dailyBudgetUsd: CAPS.dailyBudgetUsd },
    quota: [
      {
        engine: 'claude',
        callsToday: 11,
        subscriptionWindow: { state: 'unknown', usedPct: 0 },
        limit: 2000,
        limitWindow: '7d',
      },
    ],
    dispatchEnabled: true,
    ...over,
  };
}

export const AUDIT_ENTRIES = [
  { ts: new Date(Date.now() - 120_000).toISOString(), action: 'enroll.add', repo: '/Users/m/code/hub', sandboxId: null, summary: 'enrolled hub', result: 'ok' as const },
  { ts: new Date(Date.now() - 300_000).toISOString(), action: 'sandbox.create', repo: '/Users/m/code/hub', sandboxId: 'sb-1', summary: 'worktree created', result: 'ok' as const },
  { ts: new Date(Date.now() - 600_000).toISOString(), action: 'kill.set', repo: null, sandboxId: null, summary: 'kill switch engaged', result: 'refused' as const },
];

export const SAFETY_REPORT: VerseSafetyReport = {
  ok: false,
  checks: [
    { id: 'enrollment-default-empty', label: 'enrollment registry defaults to empty', pass: true, detail: '' },
    { id: 'kill-switch-honored', label: 'kill switch refuses sandbox writes', pass: true, detail: '' },
    { id: 'daemon-no-outward-primitive', label: 'daemon exports no outward primitive', pass: true, detail: '' },
    { id: 'sandbox-isolation', label: 'sandbox writes stay inside the worktree', pass: true, detail: '' },
    { id: 'local-client-gate', label: 'local model client gate is not bypassed', pass: false, detail: 'gate moved below the client build' },
  ],
};

export const BOOTSTRAP = {
  seats: [],
  projects: [],
  sessions: [],
  dispatchEnabled: true,
  localRuntime: { ollama: { reachable: false, baseUrl: 'http://127.0.0.1:11434', models: [] } },
};
