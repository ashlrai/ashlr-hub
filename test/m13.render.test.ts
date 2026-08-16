/**
 * M13 render tests — pure, deterministic renderFrame() contract.
 *
 * Tests renderFrame() from src/tui/render.ts:
 *   - PURE: same inputs → same output (called twice → identical strings).
 *   - Each tab produces a frame containing the expected header/section text.
 *   - No line (after stripAnsi) exceeds the supplied cols width.
 *   - The selected row is visually highlighted (bold/ANSI code or '>' indicator).
 *   - The tab bar marks the active tab.
 *   - The frame does not exceed rows lines (when rows is constrained).
 *   - Footer key hints are present.
 *   - Handles edge-case dimensions (very narrow, very short).
 */

import { describe, it, expect } from 'vitest';
import type { DashboardSnapshot, TuiTab } from '../src/core/types.js';
import { renderFrame } from '../src/tui/render.js';
import { stripAnsi } from '../src/cli/ui.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: '2026-06-08T10:00:00.000Z',
    repos: { total: 12, dirty: 3, stale: 2 },
    tools: { installed: 5, total: 10 },
    activity: { sessions: 8, tokens: 42000, estCostUsd: 1.23, commits: 15 },
    runs: [
      { id: 'run-001', goal: 'Build feature X', status: 'done', tokens: 4500 },
      { id: 'run-002', goal: 'Refactor module Y', status: 'running', tokens: 3000 },
      { id: 'run-003', goal: 'Fix critical bug Z', status: 'failed', tokens: 1200 },
    ],
    swarms: [
      { id: 'swarm-001', goal: 'M13 surfaces', status: 'running', tasksDone: 2, tasksTotal: 6, phase: 'build' },
      { id: 'swarm-002', goal: 'Refactor core', status: 'done', tasksDone: 4, tasksTotal: 4 },
    ],
    mcp: [
      { name: 'ashlr', ok: true, tools: 12 },
      { name: 'phantom-secrets', ok: false, tools: 0 },
    ],
    genome: { entries: 42, projects: 7 },
    ...overrides,
  };
}

const DEFAULT_STATE = {
  tab: 'overview' as TuiTab,
  selected: 0,
  cols: 120,
  rows: 30,
  nowMs: Date.parse('2026-06-08T10:00:10.000Z'),
};

function makeOperatorFleet(overrides: Record<string, unknown> = {}): NonNullable<DashboardSnapshot['fleet']> {
  return {
    generatedAt: '2026-06-08T10:00:00.000Z',
    daemon: {
      running: true,
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      lastTickAt: '2026-06-08T10:00:00.000Z',
      todaySpentUsd: 0.25,
    },
    queue: { backlogItems: 2, activeWork: { itemCount: 1 } },
    proposals: { pending: 0, frontierPending: 0, applied: 0 },
    merges: {
      recent: 0,
      sourceQuality: {
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
        filesDiscovered: 1, filesRead: 1, invalidFiles: 0, unreadableFiles: 0,
      },
    },
    backends: [],
    autonomyControlMode: 'proposal-only',
    killed: false,
    killSwitch: { state: 'inactive', sourceState: 'healthy', reason: 'missing' },
    autonomousShipReadiness: {
      verdict: 'ready',
      confidence: 'high',
      freshness: {
        generatedAt: '2026-06-08T10:00:00.000Z', overall: 'fresh', freshestAt: null,
        stalestAt: null, maxAgeMs: 0, staleSources: 0, unknownSources: 0,
      },
      topBlocker: null,
      primaryAction: null,
      sources: [],
      sourceSummary: { healthy: 1, degraded: 0, blocked: 0, unavailable: 0, unknown: 0 },
    },
    missionBrief: {
      generatedAt: '2026-06-08T10:00:00.000Z',
      directive: 'Continue bounded work',
      confidence: 'high',
      operatingMode: 'autonomous',
      blocker: null,
      action: null,
      whyNow: 'All observed sources are healthy.',
      evidence: {
        readinessVerdict: 'ready', effectivenessPhase: 'idle', bottleneck: 'none',
        queueBacklogItems: 2, eligibleBacklogItems: 2, pendingProposals: 0,
        preflightReady: 2, guardBlocked: false,
      },
    },
    dispatchProduction: {
      windowHours: 24, attempts: 1, events: 1, proposalsCreated: 1, noProposal: 0,
      spentUsd: 0.1, outcomes: {}, topReasons: [], byBackend: [], bySource: [],
      byRepo: [], byBackendModel: [], byBackendSource: [],
    },
    dispatchProductionSource: {
      sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesRead: 1, bytesRead: 1, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0,
    },
    ...overrides,
  } as unknown as NonNullable<DashboardSnapshot['fleet']>;
}

// ---------------------------------------------------------------------------
// Helper: split a frame into non-empty lines for per-line assertions
// ---------------------------------------------------------------------------

function frameLines(frame: string): string[] {
  return frame.split('\n');
}

function visibleLines(frame: string): string[] {
  return frameLines(frame).map(stripAnsi);
}

// ---------------------------------------------------------------------------
// PURE / deterministic
// ---------------------------------------------------------------------------

describe('renderFrame — pure and deterministic', () => {
  it('returns a string', () => {
    const frame = renderFrame(makeSnapshot(), DEFAULT_STATE);
    expect(typeof frame).toBe('string');
  });

  it('same inputs produce identical output (deterministic)', () => {
    const snap = makeSnapshot();
    const state = { ...DEFAULT_STATE };
    const frame1 = renderFrame(snap, state);
    const frame2 = renderFrame(snap, state);
    expect(frame1).toBe(frame2);
  });

  it('different tabs produce different frames', () => {
    const snap = makeSnapshot();
    const overviewFrame = renderFrame(snap, { ...DEFAULT_STATE, tab: 'overview' });
    const runsFrame = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs' });
    expect(overviewFrame).not.toBe(runsFrame);
  });

  it('does not mutate the snapshot', () => {
    const snap = makeSnapshot();
    const snapBefore = JSON.stringify(snap);
    renderFrame(snap, DEFAULT_STATE);
    expect(JSON.stringify(snap)).toBe(snapBefore);
  });

  it('does not mutate the state', () => {
    const state = { ...DEFAULT_STATE };
    const stateBefore = JSON.stringify(state);
    renderFrame(makeSnapshot(), state);
    expect(JSON.stringify(state)).toBe(stateBefore);
  });
});

// ---------------------------------------------------------------------------
// Width constraint: no line exceeds cols after stripAnsi
// ---------------------------------------------------------------------------

describe('renderFrame — respects cols width', () => {
  const COLS_CASES = [40, 80, 120, 200] as const;
  const TABS: TuiTab[] = ['overview', 'runs', 'swarms', 'pulse', 'mcp'];

  for (const cols of COLS_CASES) {
    for (const tab of TABS) {
      it(`tab=${tab} cols=${cols}: no line wider than ${cols} visible chars`, () => {
        const frame = renderFrame(makeSnapshot(), { ...DEFAULT_STATE, tab, cols, rows: 40 });
        const lines = visibleLines(frame);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(cols);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Terminal-safety: renderFrame must NEVER throw at any width.
//
// Regression guard for the narrow-Pulse RangeError: bodyPulse computes
// BAR_W = cols - 16, which goes negative below 16 cols; fullBar() then called
// '█'.repeat(width - fill) with a negative count → "RangeError: Invalid count
// value". Since renderFrame runs from the SIGWINCH/keypress/refresh paths
// (none wrapped in try/catch), a throw here corrupts the terminal. Probe every
// width 1..200 across all tabs with tokens > 0 (the case that triggered it).
// ---------------------------------------------------------------------------

describe('renderFrame — never throws at any width', () => {
  const TABS: TuiTab[] = ['overview', 'runs', 'swarms', 'pulse', 'mcp'];
  // tokens > 0 is required to exercise the Pulse token bar (the throw site).
  const snap = makeSnapshot({
    activity: { sessions: 8, tokens: 42000, estCostUsd: 1.23, commits: 15 },
  });

  for (const tab of TABS) {
    it(`tab=${tab}: does not throw for cols in [1..200]`, () => {
      for (let cols = 1; cols <= 200; cols++) {
        expect(() =>
          renderFrame(snap, { ...DEFAULT_STATE, tab, cols, rows: 24 }),
        ).not.toThrow();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Row constraint: frame does not exceed rows lines
// ---------------------------------------------------------------------------

describe('renderFrame — respects rows height', () => {
  it('frame with rows=10 has at most 10 lines', () => {
    const frame = renderFrame(makeSnapshot(), { ...DEFAULT_STATE, rows: 10, cols: 80 });
    const lines = frameLines(frame);
    // Allow for a trailing newline (empty last element)
    const nonEmpty = lines.filter((_, i) => i < lines.length - 1 || lines[i] !== '');
    expect(nonEmpty.length).toBeLessThanOrEqual(10);
  });

  it('frame with rows=24 has at most 24 lines', () => {
    const frame = renderFrame(makeSnapshot(), { ...DEFAULT_STATE, rows: 24, cols: 100 });
    const lines = frameLines(frame);
    const nonEmpty = lines.filter((_, i) => i < lines.length - 1 || lines[i] !== '');
    expect(nonEmpty.length).toBeLessThanOrEqual(24);
  });
});

// ---------------------------------------------------------------------------
// Tab bar: active tab is visually marked
// ---------------------------------------------------------------------------

describe('renderFrame — tab bar marks active tab', () => {
  const TABS: TuiTab[] = ['overview', 'runs', 'swarms', 'pulse', 'mcp'];

  for (const activeTab of TABS) {
    it(`tab bar shows "${activeTab}" as active when tab=${activeTab}`, () => {
      const frame = renderFrame(makeSnapshot(), { ...DEFAULT_STATE, tab: activeTab });
      // Strip ANSI for text search; the tab name should appear in the frame
      const plainFrame = stripAnsi(frame);
      expect(plainFrame.toLowerCase()).toContain(activeTab.toLowerCase());
    });
  }

  it('tab bar contains all five tab names', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), DEFAULT_STATE));
    expect(frame.toLowerCase()).toContain('overview');
    expect(frame.toLowerCase()).toContain('runs');
    expect(frame.toLowerCase()).toContain('swarms');
    expect(frame.toLowerCase()).toContain('pulse');
    expect(frame.toLowerCase()).toContain('mcp');
  });
});

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

describe('renderFrame — overview tab', () => {
  const overviewState = { ...DEFAULT_STATE, tab: 'overview' as TuiTab };

  it('shows repo count', () => {
    const snap = makeSnapshot();
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('12');
  });

  it('shows dirty repo count', () => {
    const snap = makeSnapshot({ repos: { total: 5, dirty: 2, stale: 1 } });
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('2');
  });

  it('shows stale repo count', () => {
    const snap = makeSnapshot({ repos: { total: 5, dirty: 1, stale: 3 } });
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('3');
  });

  it('shows installed tools', () => {
    const snap = makeSnapshot({ tools: { installed: 7, total: 10 } });
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('7');
  });

  it('shows sessions count', () => {
    const snap = makeSnapshot({ activity: { sessions: 9, tokens: 1000, estCostUsd: 0.5, commits: 4 } });
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('9');
  });
});

describe('renderFrame — exception-first Operator briefing', () => {
  const overviewState = { ...DEFAULT_STATE, tab: 'overview' as TuiTab };

  it('fails closed to a read-only inspection when fleet evidence is absent', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), overviewState));
    expect(frame).toContain('Operator briefing');
    expect(frame).toContain('Needs you: Inspect fleet state');
    expect(frame).toContain('[read-only] ashlr fleet status --json');
    expect(frame).toContain('Autonomous now: Daemon state unknown · mode unknown · active work unknown · spend unknown');
    expect(frame).toContain('Acted activity unknown → Proved Proof withheld · sources incomplete');
    expect(frame).not.toContain('0 active');
    expect(frame).toContain('Last proof: Observed');
    expect(frame).toContain('Proof withheld · sources incomplete');
    expect(frame.indexOf('Operator briefing')).toBeLessThan(frame.indexOf('Repos'));
  });

  it('shows a clear state only for fresh, known, non-blocked authority', () => {
    const snap = makeSnapshot({ fleet: makeOperatorFleet() });
    const frame = stripAnsi(renderFrame(snap, overviewState));
    expect(frame).toContain('Needs you: No operator action · fresh evidence within authority');
    expect(frame).toContain('No command · display only');
    expect(frame).toContain('Autonomous now: Daemon running · autonomous · 1 active · $0.25 today');
    expect(frame).toContain('Proved 1 proposal produced');
    expect(frame).not.toContain('ashlr fleet status --json');
  });

  it('surfaces one human-owned action with its visible safety label', () => {
    const action = {
      id: 'repair-service',
      priority: 'critical' as const,
      label: 'Repair daemon service',
      detail: 'Repair the resident service.',
      commands: [{
        label: 'Repair service', argv: ['ashlr', 'daemon', 'install'],
        shell: 'ashlr daemon install', safety: 'control-plane' as const,
      }],
    };
    const fleet = makeOperatorFleet({
      nextActions: [action],
      autonomousShipReadiness: {
        ...makeOperatorFleet().autonomousShipReadiness,
        primaryAction: action,
      },
    });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Needs you: Repair daemon service');
    expect(frame).toContain('[control-plane] ashlr daemon install');
    expect(frame).not.toContain('ashlr fleet status --json');
  });

  it('keeps medium read-only work autonomous but escalates high read-only work', () => {
    const readOnly = {
      id: 'inspect-backlog', priority: 'medium' as const, label: 'Inspect backlog', detail: 'Inspect it.',
      commands: [{
        label: 'Inspect', argv: ['ashlr', 'fleet', 'status', '--json'],
        shell: 'ashlr fleet status --json', safety: 'read-only' as const,
      }],
    };
    const autonomousFrame = stripAnsi(renderFrame(
      makeSnapshot({ fleet: makeOperatorFleet({ nextActions: [readOnly] }) }),
      overviewState,
    ));
    expect(autonomousFrame).toContain('Needs you: No operator action');
    expect(autonomousFrame).not.toContain('ashlr fleet status --json');

    const humanFrame = stripAnsi(renderFrame(
      makeSnapshot({
        fleet: makeOperatorFleet({ nextActions: [{ ...readOnly, priority: 'high' as const }] }),
      }),
      overviewState,
    ));
    expect(humanFrame).toContain('Needs you: Inspect backlog');
    expect(humanFrame).toContain('[read-only] ashlr fleet status --json');
  });

  it('shows the consequential command when a mixed action requires a person', () => {
    const action = {
      id: 'recover-lane', priority: 'medium' as const, label: 'Recover stale lane', detail: 'Recover it.',
      commands: [
        {
          label: 'Inspect', argv: ['ashlr', 'fleet', 'status', '--json'],
          shell: 'ashlr fleet status --json', safety: 'read-only' as const,
        },
        {
          label: 'Stop daemon', argv: ['ashlr', 'daemon', 'stop'],
          shell: 'ashlr daemon stop', safety: 'control-plane' as const,
        },
      ],
    };
    const frame = stripAnsi(renderFrame(
      makeSnapshot({ fleet: makeOperatorFleet({ nextActions: [action] }) }),
      overviewState,
    ));
    expect(frame).toContain('Needs you: Recover stale lane');
    expect(frame).toContain('[control-plane] ashlr daemon stop +1');
    expect(frame).not.toContain('[read-only] ashlr fleet status --json');
  });

  it('does not promote autonomous-dispatch-only work into Needs you', () => {
    const action = {
      id: 'start-daemon', priority: 'critical' as const, label: 'Start daemon', detail: 'Start it.',
      commands: [{
        label: 'Start', argv: ['ashlr', 'daemon', 'start'], shell: 'ashlr daemon start',
        safety: 'autonomous-dispatch' as const,
      }],
    };
    const fleet = makeOperatorFleet({ nextActions: [action] });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Needs you: No operator action · fresh evidence within authority');
    expect(frame).not.toContain('ashlr daemon start');
  });

  it('requires inspection for stale snapshots, unknown kill authority, or degraded daemon authority', () => {
    const stale = stripAnsi(renderFrame(
      makeSnapshot({ fleet: makeOperatorFleet() }),
      { ...overviewState, nowMs: Date.parse('2026-06-08T10:01:00.001Z') },
    ));
    expect(stale).toContain('Needs you: Inspect fleet state');
    expect(stale).toContain('Autonomous now: Daemon state unknown · mode unknown · active work unknown · spend unknown');
    expect(stale).toContain('Acted activity unknown → Proved Proof withheld · sources incomplete');
    expect(stale).not.toContain('Daemon running');
    expect(stale).not.toContain('$0.25 today');
    expect(stale).not.toContain('1 proposal produced');

    const unknownKill = makeOperatorFleet({ killSwitch: undefined });
    expect(stripAnsi(renderFrame(makeSnapshot({ fleet: unknownKill }), overviewState)))
      .toContain('Needs you: Inspect fleet state');

    const degradedDaemon = makeOperatorFleet({
      daemon: {
        ...makeOperatorFleet().daemon,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unavailable' },
      },
    });
    expect(stripAnsi(renderFrame(makeSnapshot({ fleet: degradedDaemon }), overviewState)))
      .toContain('Needs you: Inspect fleet state');
  });

  it('treats an inactive kill state from a degraded source as unknown authority', () => {
    const fleet = makeOperatorFleet({
      killSwitch: { state: 'inactive', sourceState: 'degraded', reason: 'unavailable' },
    });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Needs you: Inspect fleet state');
    expect(frame).not.toContain('Needs you: No operator action');
  });

  it('fails closed when observation time is omitted or the snapshot is too far in the future', () => {
    const snap = makeSnapshot({ fleet: makeOperatorFleet() });
    const omitted = stripAnsi(renderFrame(snap, {
      tab: 'overview', selected: 0, cols: 120, rows: 30,
    }));
    expect(omitted).toContain('Needs you: Inspect fleet state');
    expect(omitted).toContain('Autonomous now: Daemon state unknown · mode unknown · active work unknown · spend unknown');
    expect(omitted).toContain('Proved Proof withheld · sources incomplete');
    expect(omitted).not.toContain('1 proposal produced');

    const future = stripAnsi(renderFrame(snap, {
      ...overviewState,
      nowMs: Date.parse('2026-06-08T09:59:54.999Z'),
    }));
    expect(future).toContain('Needs you: Inspect fleet state');
  });

  it('withholds proof unless merge or dispatch sources are healthy and complete', () => {
    const fleet = makeOperatorFleet({
      merges: { recent: 7, sourceQuality: { sourceState: 'degraded', complete: false } },
      dispatchProductionSource: { sourceState: 'degraded', complete: false },
    });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Proof withheld · sources incomplete');
    expect(frame).not.toContain('7 landed merges');
  });

  it('shows landed merge proof only from a healthy complete merge source', () => {
    const fleet = makeOperatorFleet({
      merges: { recent: 2, sourceQuality: makeOperatorFleet().merges.sourceQuality },
    });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Proved 2 landed merges');
  });

  it('does not attribute tick-only proposal telemetry to a healthy empty durable source', () => {
    const fleet = makeOperatorFleet({
      dispatchProduction: undefined,
      proposalProduction: { dispatched: 4, proposalsCreated: 3 },
      dispatchProductionSource: {
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
        filesRead: 0, bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0,
      },
    });
    const frame = stripAnsi(renderFrame(makeSnapshot({ fleet }), overviewState));
    expect(frame).toContain('Acted 4 dispatches');
    expect(frame).toContain('Proved No recent landed proof');
    expect(frame).not.toContain('3 proposals produced');
  });

  it('keeps the safety command and complete proof chain visible at 40x12', () => {
    const action = {
      id: 'recover-lane', priority: 'medium' as const, label: 'Recover lane', detail: 'Recover it.',
      commands: [
        {
          label: 'Inspect', argv: ['ashlr', 'fleet', 'status', '--json'],
          shell: 'ashlr fleet status --json', safety: 'read-only' as const,
        },
        {
          label: 'Stop', argv: ['ashlr', 'daemon', 'stop'],
          shell: 'ashlr daemon stop', safety: 'control-plane' as const,
        },
      ],
    };
    const fleet = makeOperatorFleet({ nextActions: [action] });
    const frame = stripAnsi(renderFrame(
      makeSnapshot({ fleet }),
      { ...overviewState, cols: 40, rows: 12 },
    ));
    expect(frame).toContain('Needs you:');
    expect(frame).toContain('[control-plane] ashlr daemon stop');
    expect(frame).toContain('[control-plane] ashlr daemon stop +1');
    expect(frame).toContain('Autonomous now:');
    expect(frame).toContain('Last proof: Observed');
    expect(frame).toContain('Decided autonomous');
    expect(frame).toContain('Acted 1 dispatch · Proved 1 proposal');
  });
});

// ---------------------------------------------------------------------------
// Runs tab
// ---------------------------------------------------------------------------

describe('renderFrame — runs tab', () => {
  const runsState = { ...DEFAULT_STATE, tab: 'runs' as TuiTab };

  it('contains run goal text', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), runsState));
    expect(frame).toContain('Build feature X');
  });

  it('contains run status', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), runsState));
    expect(frame).toContain('done');
  });

  it('contains run id or token count', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), runsState));
    // Either the id or the token count (4500) should appear
    expect(frame.includes('run-001') || frame.includes('4500')).toBe(true);
  });

  it('contains all three runs', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), runsState));
    expect(frame).toContain('Build feature X');
    expect(frame).toContain('Refactor module Y');
    expect(frame).toContain('Fix critical bug Z');
  });
});

// ---------------------------------------------------------------------------
// Swarms tab
// ---------------------------------------------------------------------------

describe('renderFrame — swarms tab', () => {
  const swarmsState = { ...DEFAULT_STATE, tab: 'swarms' as TuiTab };

  it('contains swarm goal text', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), swarmsState));
    expect(frame).toContain('M13 surfaces');
  });

  it('contains tasksDone / tasksTotal burndown numbers', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), swarmsState));
    // 2/6 burndown
    expect(frame).toContain('2');
    expect(frame).toContain('6');
  });

  it('contains phase name for active swarm', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), swarmsState));
    expect(frame).toContain('build');
  });

  it('contains swarm status', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), swarmsState));
    expect(frame).toContain('running');
  });
});

// ---------------------------------------------------------------------------
// Pulse tab
// ---------------------------------------------------------------------------

describe('renderFrame — pulse tab', () => {
  const pulseState = { ...DEFAULT_STATE, tab: 'pulse' as TuiTab };

  it('contains token or cost data', () => {
    const snap = makeSnapshot({ activity: { sessions: 3, tokens: 55000, estCostUsd: 2.10, commits: 7 } });
    const frame = stripAnsi(renderFrame(snap, pulseState));
    // Some activity data should be visible
    expect(frame.includes('55') || frame.includes('2.1') || frame.includes('2.10') || frame.includes('7')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP tab
// ---------------------------------------------------------------------------

describe('renderFrame — mcp tab', () => {
  const mcpState = { ...DEFAULT_STATE, tab: 'mcp' as TuiTab };

  it('contains server names', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), mcpState));
    expect(frame).toContain('ashlr');
  });

  it('shows ok/fail status for servers', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), mcpState));
    // One server is ok, one is not — some indicator should be present
    expect(
      frame.includes('ok') || frame.includes('✓') || frame.includes('✗') ||
      frame.includes('up') || frame.includes('down') || frame.includes('true') ||
      frame.includes('false') || frame.includes('12')
    ).toBe(true);
  });

  it('shows tool counts', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), mcpState));
    expect(frame).toContain('12');
  });
});

// ---------------------------------------------------------------------------
// Selected row highlighting
// ---------------------------------------------------------------------------

describe('renderFrame — selected row highlighting', () => {
  it('selected=0 in runs tab applies highlighting to the first row', () => {
    const snap = makeSnapshot();
    // With ANSI: the raw frame (not stripped) should contain a bold/highlight code
    const highlighted = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 0 });
    const notHighlighted = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 1 });
    // The frames should differ because different rows are highlighted
    expect(highlighted).not.toBe(notHighlighted);
  });

  it('selected row in runs tab contains ANSI highlight or ">" indicator', () => {
    const snap = makeSnapshot();
    const frame = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 0 });
    // Either an ANSI escape (bold/reverse/highlight) or a ">" cursor indicator
    // eslint-disable-next-line no-control-regex
    const hasAnsi = /\x1b\[/.test(frame);
    const hasArrow = frame.includes('>');
    expect(hasAnsi || hasArrow).toBe(true);
  });

  it('different selected rows produce different frames', () => {
    const snap = makeSnapshot();
    const frame0 = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 0 });
    const frame1 = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 1 });
    const frame2 = renderFrame(snap, { ...DEFAULT_STATE, tab: 'runs', selected: 2 });
    // All three should differ
    expect(frame0).not.toBe(frame1);
    expect(frame1).not.toBe(frame2);
  });

  it('selected row in mcp tab highlights correctly', () => {
    const snap = makeSnapshot();
    const frame0 = renderFrame(snap, { ...DEFAULT_STATE, tab: 'mcp', selected: 0 });
    const frame1 = renderFrame(snap, { ...DEFAULT_STATE, tab: 'mcp', selected: 1 });
    expect(frame0).not.toBe(frame1);
  });
});

// ---------------------------------------------------------------------------
// Footer key hints
// ---------------------------------------------------------------------------

describe('renderFrame — footer key hints', () => {
  it('footer contains "q" quit hint', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), DEFAULT_STATE));
    expect(frame.toLowerCase()).toMatch(/\bq\b|quit/);
  });

  it('footer contains "r" refresh hint', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), DEFAULT_STATE));
    expect(frame.toLowerCase()).toMatch(/\br\b|refresh/);
  });

  it('footer contains tab-switching hint', () => {
    const frame = stripAnsi(renderFrame(makeSnapshot(), DEFAULT_STATE));
    // Tab, 1-5, or shift-tab switching hint
    expect(frame.toLowerCase()).toMatch(/tab|1-5|\btab\b/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty data
// ---------------------------------------------------------------------------

describe('renderFrame — empty data edge cases', () => {
  const emptySnap = makeSnapshot({
    runs: [],
    swarms: [],
    mcp: [],
    repos: { total: 0, dirty: 0, stale: 0 },
    tools: { installed: 0, total: 0 },
    activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
    genome: { entries: 0, projects: 0 },
  });

  it('does not throw on empty runs tab', () => {
    expect(() => renderFrame(emptySnap, { ...DEFAULT_STATE, tab: 'runs' })).not.toThrow();
  });

  it('does not throw on empty swarms tab', () => {
    expect(() => renderFrame(emptySnap, { ...DEFAULT_STATE, tab: 'swarms' })).not.toThrow();
  });

  it('does not throw on empty mcp tab', () => {
    expect(() => renderFrame(emptySnap, { ...DEFAULT_STATE, tab: 'mcp' })).not.toThrow();
  });

  it('does not throw on very narrow terminal (cols=20)', () => {
    expect(() => renderFrame(emptySnap, { ...DEFAULT_STATE, cols: 20, rows: 10 })).not.toThrow();
  });

  it('does not throw on very short terminal (rows=3)', () => {
    expect(() => renderFrame(makeSnapshot(), { ...DEFAULT_STATE, cols: 80, rows: 3 })).not.toThrow();
  });

  it('width constraint still holds on very narrow terminal (cols=20)', () => {
    const frame = renderFrame(emptySnap, { ...DEFAULT_STATE, cols: 20, rows: 10 });
    const lines = visibleLines(frame);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });
});
