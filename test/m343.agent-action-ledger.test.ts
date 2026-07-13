/**
 * m343.agent-action-ledger.test.ts — append-only agent action telemetry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentActionsDir,
  filterAgentActionsByRepoScope,
  isSafeAgentActionLedgerDirectory,
  isSafeAgentActionLedgerFile,
  readAgentActions,
  readAgentActionsDetailed,
  readAgentWorkspace,
  recordAgentAction,
  recordAgentActionResult,
  summarizeAgentWorkspace,
  type AgentActionEvent,
} from '../src/core/fleet/agent-action-ledger.js';

let prevAshlrHome: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let home: string;

function makeEvent(overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-08T12:00:00.000Z',
    machineId: 'machine-a',
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'no-proposal',
    action: 'daemon:dispatch',
    summary: 'codex empty-diff for Implement a thing',
    repo: '/tmp/repo-a',
    itemId: 'item-a',
    source: 'todo',
    backend: 'codex',
    tier: 'frontier',
    model: 'gpt-5.5',
    reason: 'empty-diff: no file changes',
    spentUsd: 0.001,
    tags: ['todo', 'empty-diff'],
    counts: { diffFiles: 0, diffLines: 0 },
    ...overrides,
  };
}

function writeEnrollment(repos: string[]): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos }), 'utf8');
}

beforeEach(() => {
  prevAshlrHome = process.env.ASHLR_HOME;
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m343-agent-actions-'));
  process.env.ASHLR_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M343 agent action ledger', () => {
  it('ignores emulated mode bits only on Windows while preserving filesystem safety checks', () => {
    const regular = statSync(home);
    const fileStat = {
      ...regular,
      mode: (regular.mode & ~0o777) | 0o666,
      nlink: 1,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as unknown as ReturnType<typeof statSync>;
    const directoryStat = {
      ...regular,
      mode: (regular.mode & ~0o777) | 0o777,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as ReturnType<typeof statSync>;

    expect(isSafeAgentActionLedgerFile(fileStat, 'win32')).toBe(true);
    expect(isSafeAgentActionLedgerFile(fileStat, 'linux')).toBe(false);
    expect(isSafeAgentActionLedgerDirectory(directoryStat, 'win32')).toBe(true);
    expect(isSafeAgentActionLedgerDirectory(directoryStat, 'linux')).toBe(false);

    expect(isSafeAgentActionLedgerFile({
      ...fileStat,
      isSymbolicLink: () => true,
    } as ReturnType<typeof statSync>, 'win32')).toBe(false);
    expect(isSafeAgentActionLedgerFile({
      ...fileStat,
      nlink: 2,
    } as ReturnType<typeof statSync>, 'win32')).toBe(false);
    expect(isSafeAgentActionLedgerDirectory({
      ...directoryStat,
      isSymbolicLink: () => true,
    } as ReturnType<typeof statSync>, 'win32')).toBe(false);
    if (typeof process.getuid === 'function') {
      expect(isSafeAgentActionLedgerFile({
        ...fileStat,
        uid: process.getuid() + 1,
      } as ReturnType<typeof statSync>, 'win32')).toBe(false);
    }
  });

  it('appends and reads action events newest first', () => {
    recordAgentAction([
      makeEvent({ action: 'old-action', ts: '2026-07-07T23:59:00.000Z' }),
      makeEvent({ action: 'new-action', ts: '2026-07-08T00:01:00.000Z', outcome: 'proposal-created', proposalId: 'prop-new' }),
    ]);

    const events = readAgentActions();

    expect(events.map((event) => event.action)).toEqual(['new-action', 'old-action']);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'proposal-created',
      proposalId: 'prop-new',
    });
  });

  it('honors limit and sinceMs filters', () => {
    recordAgentAction([
      makeEvent({ action: 'a', ts: '2026-07-08T00:00:00.000Z' }),
      makeEvent({ action: 'b', ts: '2026-07-08T00:01:00.000Z' }),
      makeEvent({ action: 'c', ts: '2026-07-08T00:02:00.000Z' }),
    ]);

    expect(readAgentActions({ limit: 2 }).map((event) => event.action)).toEqual(['c', 'b']);
    expect(readAgentActions({ sinceMs: Date.parse('2026-07-08T00:01:30.000Z') }).map((event) => event.action)).toEqual(['c']);
  });

  it('normalizes invalid timestamps before writing', () => {
    recordAgentAction(makeEvent({ action: 'bad-ts', ts: 'not-a-date' }));

    const event = readAgentActions({ limit: 1 })[0];

    expect(event).toMatchObject({ action: 'bad-ts' });
    expect(Number.isFinite(Date.parse(event!.ts))).toBe(true);
  });

  it('refuses to persist lifecycle rows that the reader would reject', () => {
    expect(recordAgentActionResult(makeEvent({
      outcome: 'verified',
      proposalId: undefined,
    }))).toEqual({ attempted: 1, recorded: 0 });
    expect(readAgentActionsDetailed()).toMatchObject({
      events: [],
      sourceState: 'healthy',
      complete: true,
    });
  });

  it('distinguishes a missing ledger from a present empty ledger', () => {
    expect(readAgentActionsDetailed()).toMatchObject({
      events: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });

    mkdirSync(agentActionsDir(), { recursive: true, mode: 0o700 });

    expect(readAgentActionsDetailed()).toMatchObject({
      events: [],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
    });
  });

  it('degrades source quality for malformed and invalid persisted timestamps', () => {
    const dir = agentActionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '2026-07-08.jsonl'), [
      JSON.stringify(makeEvent({ action: 'valid-row' })),
      '{malformed',
      JSON.stringify(makeEvent({ action: 'invalid-ts', ts: 'not-a-date' })),
      JSON.stringify(makeEvent({ action: 'wrong-partition', ts: '2026-07-09T00:00:00.000Z' })),
      '',
    ].join('\n'), 'utf8');

    const read = readAgentActionsDetailed();

    expect(read.events.map((event) => event.action)).toEqual(['valid-row']);
    expect(read).toMatchObject({
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      rowsScanned: 4,
      invalidRows: 3,
      unreadableFiles: 0,
    });
    expect(readAgentActions({ requireComplete: true })).toEqual([]);
  });

  it('fails complete reads closed at maxFiles, maxBytes, and maxRows', () => {
    recordAgentAction([
      makeEvent({ action: 'day-one', ts: '2026-07-07T12:00:00.000Z' }),
      makeEvent({ action: 'day-two-a', ts: '2026-07-08T11:00:00.000Z' }),
      makeEvent({ action: 'day-two-b', ts: '2026-07-08T12:00:00.000Z' }),
    ]);

    const fileLimited = readAgentActionsDetailed({ maxFiles: 1 });
    expect(fileLimited).toMatchObject({ sourceState: 'degraded', complete: false, filesRead: 1 });
    expect(fileLimited.stopReasons).toContain('file-limit');
    expect(readAgentActions({ maxFiles: 1, requireComplete: true })).toEqual([]);

    const byteLimited = readAgentActionsDetailed({ maxBytes: 1 });
    expect(byteLimited).toMatchObject({ sourceState: 'degraded', complete: false, bytesRead: 0 });
    expect(byteLimited.stopReasons).toContain('byte-limit');
    expect(readAgentActions({ maxBytes: 1, requireComplete: true })).toEqual([]);

    const rowLimited = readAgentActionsDetailed({ maxRows: 1 });
    expect(rowLimited).toMatchObject({ sourceState: 'degraded', complete: false, rowsScanned: 1 });
    expect(rowLimited.stopReasons).toContain('row-limit');
    expect(readAgentActions({ maxRows: 1, requireComplete: true })).toEqual([]);
  });

  it('marks logical event truncation partial while keeping exact caps complete', () => {
    recordAgentAction([
      makeEvent({ action: 'event-a', ts: '2026-07-08T10:00:00.000Z' }),
      makeEvent({ action: 'event-b', ts: '2026-07-08T11:00:00.000Z' }),
      makeEvent({ action: 'event-c', ts: '2026-07-08T12:00:00.000Z' }),
    ]);

    const partial = readAgentActionsDetailed({ limit: 2 });
    expect(partial.events.map((event) => event.action)).toEqual(['event-c', 'event-b']);
    expect(partial).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(partial.stopReasons).toContain('event-limit');
    expect(readAgentActions({ limit: 2, requireComplete: true })).toEqual([]);

    const exact = readAgentActionsDetailed({ limit: 3 });
    expect(exact).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(exact.stopReasons).not.toContain('event-limit');
  });

  it('reads up to three legacy loose partitions and rejects impossible dated partitions', () => {
    const dir = agentActionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'legacy.jsonl'), `${JSON.stringify(makeEvent({ action: 'legacy-row' }))}\n`, 'utf8');

    expect(readAgentActionsDetailed()).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      events: [expect.objectContaining({ action: 'legacy-row' })],
    });

    writeFileSync(join(dir, '2026-99-99.jsonl'), '', 'utf8');
    expect(readAgentActionsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
    });
  });

  it('keeps loose compatibility outside the dated maxFiles cap and rejects malformed causal objects', () => {
    const dir = agentActionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '2026-07-07.jsonl'), `${JSON.stringify(makeEvent({ action: 'dated-old', ts: '2026-07-07T12:00:00.000Z' }))}\n`, 'utf8');
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${JSON.stringify(makeEvent({ action: 'dated-new' }))}\n`, 'utf8');
    writeFileSync(join(dir, 'legacy.jsonl'), `${JSON.stringify(makeEvent({ action: 'loose-row' }))}\n`, 'utf8');

    const mixed = readAgentActionsDetailed({ maxFiles: 1 });
    expect(mixed.events.map((event) => event.action)).toEqual(expect.arrayContaining(['dated-new', 'loose-row']));
    expect(mixed.events.map((event) => event.action)).not.toContain('dated-old');
    expect(mixed.stopReasons).toContain('file-limit');

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${JSON.stringify({
      ...makeEvent({ action: 'corrupt-causal' }),
      routeSnapshot: 'corrupt',
      runEventSummary: 42,
    })}\n`, 'utf8');
    expect(readAgentActionsDetailed()).toMatchObject({
      events: [],
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
    });
  });

  it('separates a torn tail from the next appended record', () => {
    const dir = agentActionsDir();
    const path = join(dir, '2026-07-08.jsonl');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, '{"schemaVersion":1,"ts":"2026-07-08T12:00:00.000Z"', 'utf8');

    expect(recordAgentActionResult(makeEvent({ action: 'after-torn-tail' }))).toEqual({ attempted: 1, recorded: 1 });

    const raw = readFileSync(path, 'utf8');
    const read = readAgentActionsDetailed();
    expect(raw).toContain('12:00:00.000Z"\n{"schemaVersion":1');
    expect(read.events.map((event) => event.action)).toEqual(['after-torn-tail']);
    expect(read).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked directories and symlinked or hardlinked ledger files', () => {
    const dir = agentActionsDir();
    const realDir = join(home, 'real-agent-actions');
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, dir, 'dir');

    expect(recordAgentActionResult(makeEvent())).toEqual({ attempted: 1, recorded: 0 });
    expect(readAgentActionsDetailed()).toMatchObject({ sourceState: 'degraded', complete: false });

    rmSync(dir, { force: true });
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, '2026-07-08.jsonl');
    const target = join(home, 'ledger-target.jsonl');
    writeFileSync(target, `${JSON.stringify(makeEvent())}\n`, { mode: 0o600 });
    symlinkSync(target, path);

    expect(recordAgentActionResult(makeEvent())).toEqual({ attempted: 1, recorded: 0 });
    expect(readAgentActionsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
    });

    rmSync(path, { force: true });
    linkSync(target, path);

    expect(recordAgentActionResult(makeEvent())).toEqual({ attempted: 1, recorded: 0 });
    expect(readAgentActionsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
    });
  });

  it.skipIf(process.platform === 'win32')('creates private ledger directories and files', () => {
    expect(recordAgentActionResult(makeEvent())).toEqual({ attempted: 1, recorded: 1 });

    expect(statSync(agentActionsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(agentActionsDir(), '2026-07-08.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('falls back to the user home when ASHLR_HOME is relative', () => {
    process.env.ASHLR_HOME = 'relative-home';
    const fallbackDir = join(home, '.ashlr', 'agent-actions');

    expect(agentActionsDir()).toBe(fallbackDir);
    expect(recordAgentActionResult(makeEvent({ action: 'relative-home-fallback' }))).toEqual({ attempted: 1, recorded: 1 });
    expect(readAgentActionsDetailed().events.map((event) => event.action)).toEqual(['relative-home-fallback']);
    expect(existsSync(join(process.cwd(), 'relative-home', 'agent-actions'))).toBe(false);
  });

  it('preserves started, old-reader-safe cancellation metadata, and verification outcomes', () => {
    recordAgentAction([
      makeEvent({
        action: 'daemon:tick-start',
        kind: 'tick',
        outcome: 'started',
        summary: 'start: budget $1.00, perTick 4, parallel 3',
      }),
      makeEvent({
        action: 'daemon:dispatch-cancelled',
        outcome: 'skipped',
        summary: 'dispatch cancelled by owner',
        reason: 'run cancelled by owner',
        runEventSummary: {
          status: 'aborted',
          outcome: 'cancelled',
          proposalCreated: false,
        },
        learningLabel: {
          schemaVersion: 1,
          classifierVersion: 'attempt-shape-v2',
          authoritative: true,
          learningKind: 'cancelled',
          policySuppressed: false,
          diagnosticAttempt: false,
          diagnosticNoProposal: false,
          attemptShape: {
            backendNoDiff: 0,
            captureOrGateBlocked: 0,
            repairAttempts: 0,
            policyDisabled: 0,
          },
        },
      }),
      makeEvent({
        action: 'auto-merge:verify-before-judge-finish',
        actor: 'verifier',
        kind: 'verification',
        outcome: 'verified',
        proposalId: 'prop-verified',
        summary: 'verify-before-judge passed for Proposal',
      }),
    ]);

    const events = readAgentActions();

    expect(events.map((event) => event.outcome)).toEqual(['verified', 'skipped', 'started']);
    expect(events[0]).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      action: 'auto-merge:verify-before-judge-finish',
    });
    expect(events[1]).toMatchObject({
      actor: 'daemon',
      kind: 'dispatch',
      action: 'daemon:dispatch-cancelled',
      outcome: 'skipped',
      reason: 'run cancelled by owner',
      runEventSummary: {
        status: 'aborted',
        outcome: 'cancelled',
        proposalCreated: false,
      },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
    expect(events[2]).toMatchObject({
      actor: 'daemon',
      kind: 'tick',
      action: 'daemon:tick-start',
    });
  });

  it('skips malformed lines and scrubs secret-shaped text before persistence', () => {
    const dir = agentActionsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), 'not-json\n', 'utf8');

    recordAgentAction(makeEvent({
      action: 'secret-action',
      summary: 'Authorization Bearer sk-supersecretsecretsecret',
      reason: 'token=ghp_1234567890abcdefABCDEF leaked by tool',
      tags: ['secret=sk-supersecretsecretsecret'],
      counts: { 'token=ghp_1234567890abcdefABCDEF': 1 },
    }));

    const events = readAgentActions();

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('secret-action');
    const raw = readFileSync(join(dir, '2026-07-08.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-supersecretsecretsecret');
    expect(raw).not.toContain('ghp_1234567890abcdefABCDEF');
    expect(raw).toContain('[REDACTED]');
  });

  it('rejects corrupted enum-like legacy rows before returning summaries', () => {
    const dir = agentActionsDir();
    mkdirSync(dir, { recursive: true });
    const secret = 'ghp_1234567890abcdefABCDEF1234567890abcdef';
    writeFileSync(join(dir, '2026-07-08.jsonl'), JSON.stringify({
      schemaVersion: 1,
      ts: '2026-07-08T00:00:00.000Z',
      machineId: `machine-token=${secret}`,
      actor: `actor-token=${secret}`,
      kind: `kind-token=${secret}`,
      outcome: `outcome-token=${secret}`,
      action: `action token=${secret}`,
      summary: `summary token=${secret}`,
      repo: `/tmp/token=${secret}`,
      itemId: `item-token=${secret}`,
      source: `source-token=${secret}`,
      proposalId: `proposal-token=${secret}`,
      runId: `run-token=${secret}`,
      backend: `backend-token=${secret}`,
      tier: `tier-token=${secret}`,
      model: `model-token=${secret}`,
      reason: `reason-token=${secret}`,
    }) + '\n', 'utf8');

    const detailed = readAgentActionsDetailed();
    const events = detailed.events;
    const summary = summarizeAgentWorkspace(events);
    const serialized = JSON.stringify({ events, summary });

    expect(events).toEqual([]);
    expect(detailed).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
    });
    expect(serialized).not.toContain(secret);
  });

  it('omits non-finite numeric fields instead of persisting JSON nulls', () => {
    recordAgentAction(makeEvent({
      action: 'bad-numbers',
      durationMs: Number.NaN,
      spentUsd: Number.POSITIVE_INFINITY,
    }));

    const event = readAgentActions({ limit: 1 })[0]!;
    const raw = readFileSync(join(agentActionsDir(), '2026-07-08.jsonl'), 'utf8');

    expect(event.action).toBe('bad-numbers');
    expect(event.durationMs).toBeUndefined();
    expect(event.spentUsd).toBeUndefined();
    expect(raw).not.toContain('"durationMs":null');
    expect(raw).not.toContain('"spentUsd":null');
  });

  it('sanitizes run action-count summaries while dropping arbitrary secret-shaped keys', () => {
    const secretKey = 'GITHUB_TOKEN=ghp_1234567890abcdefABCDEF1234567890abcdef';
    recordAgentAction(makeEvent({
      action: 'run-action-counts',
      runEventSummary: {
        runId: 'run-action-counts',
        status: 'done',
        actionCounts: {
          sandboxCreated: 1,
          spawnAttempts: 2.8,
          transientRetries: -1,
          proposalDisabled: 1,
          [secretKey]: 7,
          unknownCounter: 9,
        } as never,
      },
    }));

    const event = readAgentActions({ limit: 1 })[0]!;
    const serialized = JSON.stringify(event);

    expect(event.runEventSummary?.actionCounts).toMatchObject({
      sandboxCreated: 1,
      spawnAttempts: 2,
      transientRetries: 0,
      proposalDisabled: 1,
    });
    expect(serialized).not.toContain('unknownCounter');
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain('ghp_1234567890abcdefABCDEF1234567890abcdef');
  });

  it('never throws when persistence is unavailable', () => {
    process.env.ASHLR_HOME = join(home, 'file-home');
    writeFileSync(process.env.ASHLR_HOME, 'not a directory', 'utf8');

    expect(() => recordAgentAction(makeEvent())).not.toThrow();
    expect(recordAgentActionResult(makeEvent())).toEqual({ attempted: 1, recorded: 0 });
    expect(() => readAgentActions()).not.toThrow();
    expect(readAgentActions()).toEqual([]);
    expect(existsSync(process.env.ASHLR_HOME)).toBe(true);
  });

  it('reports durable append counts and applies limits after filtering', () => {
    expect(recordAgentActionResult([
      makeEvent({ action: 'noise-a', kind: 'selection' }),
      makeEvent({ action: 'target-a' }),
      makeEvent({ action: 'noise-b', kind: 'selection' }),
      makeEvent({ action: 'target-b' }),
    ])).toEqual({ attempted: 4, recorded: 4 });

    const matched = readAgentActions({
      limit: 1,
      filter: (event) => event.action.startsWith('target-'),
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.action).toBe('target-b');
  });

  it('supports a synced append for restart-safe cadence markers', () => {
    expect(recordAgentActionResult(makeEvent({
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
      outcome: 'ok',
    }), { sync: true })).toEqual({ attempted: 1, recorded: 1 });
    expect(readAgentActions({ limit: 1 })[0]).toMatchObject({
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
    });
  });

  it('fails complete reads closed on malformed rows and deduplicates rollup identities', () => {
    const id = `cr-${'d'.repeat(64)}`;
    const rollup = makeEvent({
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
      outcome: 'ok',
      contextRollupId: id,
      contextRollupPolicyVersion: 'context-rollup-v1',
      contextRollupSourceMaxTs: '2026-07-08T11:59:00.000Z',
    });
    const summary = summarizeAgentWorkspace([rollup, { ...rollup }]);
    expect(summary.eventCount).toBe(1);
    expect(summary.byAction).toEqual([expect.objectContaining({ key: 'context-rollup', count: 1 })]);

    recordAgentAction(makeEvent({ action: 'valid-before-malformed' }));
    const path = join(agentActionsDir(), '2026-07-08.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{broken\n`, 'utf8');
    expect(readAgentActions({ requireComplete: true })).toEqual([]);
  });

  it('summarizes global-workspace attention and entropy from action events', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({ repo: '/tmp/repo-a', backend: 'codex', outcome: 'no-proposal', spentUsd: 0.1 }),
      makeEvent({ repo: '/tmp/repo-a', backend: 'codex', outcome: 'proposal-created', proposalId: 'p1', spentUsd: 0.2 }),
      makeEvent({ repo: '/tmp/repo-b', backend: 'claude', outcome: 'failed', spentUsd: 0.3 }),
    ], { windowHours: 24 });

    expect(summary).toMatchObject({
      eventCount: 3,
      proposalEvents: 1,
      noProposalEvents: 1,
      diagnosticAttempts: 3,
      diagnosticNoProposalEvents: 1,
      policySuppressedEvents: 0,
      diagnosticProposalRate: 1 / 3,
      diagnosticNoProposalRate: 1 / 3,
    });
    expect(summary.spendUsd).toBeCloseTo(0.6);
    expect(summary.repoEventCount).toBe(3);
    expect(summary.repoDistinctCount).toBe(2);
    expect(summary.topRepoCount).toBe(2);
    expect(summary.byRepo[0]).toMatchObject({ key: '/tmp/repo-a', count: 2 });
    expect(summary.byBackend[0]).toMatchObject({ key: 'codex', count: 2 });
    expect(summary.entropy.action).toBeGreaterThanOrEqual(0);
    expect(summary.attention.some((row) => row.kind === 'repo' && row.topic === '/tmp/repo-a')).toBe(true);
  });

  it('separates policy-suppressed proposal attempts from diagnostic workspace no-proposal events', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({
        outcome: 'no-proposal',
        runEventSummary: {
          outcome: 'proposal-disabled',
          proposalCreated: false,
          actionCounts: { proposalDisabled: 1 },
        },
      }),
      makeEvent({
        action: 'empty-diff',
        outcome: 'no-proposal',
        runEventSummary: {
          outcome: 'empty-diff',
          proposalCreated: false,
          actionCounts: { diffFiles: 0 },
        },
      }),
      makeEvent({
        action: 'proposal-created',
        outcome: 'proposal-created',
        proposalId: 'prop-created',
        runEventSummary: {
          outcome: 'proposal-created',
          proposalCreated: true,
          actionCounts: { proposalCreated: 1 },
        },
      }),
    ]);

    expect(summary).toMatchObject({
      proposalEvents: 1,
      noProposalEvents: 2,
      diagnosticAttempts: 2,
      diagnosticNoProposalEvents: 1,
      policySuppressedEvents: 1,
      diagnosticProposalRate: 0.5,
      diagnosticNoProposalRate: 0.5,
    });
  });

  it('uses durable learning labels for workspace diagnostic counts when present', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({
        action: 'labeled-policy',
        outcome: 'no-proposal',
        runEventSummary: {
          outcome: 'empty-diff',
          proposalCreated: false,
          actionCounts: { diffFiles: 0 },
        },
        learningLabel: {
          schemaVersion: 1,
          classifierVersion: 'attempt-shape-v1',
          authoritative: true,
          learningKind: 'policy-suppressed',
          policySuppressed: true,
          diagnosticNoProposal: false,
          diagnosticAttempt: false,
          attemptShape: {
            backendNoDiff: 0,
            captureOrGateBlocked: 0,
            repairAttempts: 0,
            policyDisabled: 4,
          },
        },
      }),
      makeEvent({
        action: 'proposal-created',
        outcome: 'proposal-created',
        proposalId: 'prop-created',
        runEventSummary: {
          outcome: 'proposal-created',
          proposalCreated: true,
          actionCounts: { proposalCreated: 1 },
        },
      }),
    ]);

    expect(summary).toMatchObject({
      proposalEvents: 1,
      noProposalEvents: 1,
      diagnosticAttempts: 1,
      diagnosticNoProposalEvents: 0,
      policySuppressedEvents: 1,
      diagnosticProposalRate: 1,
      diagnosticNoProposalRate: 0,
    });
  });

  it('uses all diagnostic attempts for mixed proposal, no-proposal, and failure rates', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({
        action: 'proposal-created',
        outcome: 'proposal-created',
        proposalId: 'prop-created',
        runEventSummary: {
          outcome: 'proposal-created',
          proposalCreated: true,
          actionCounts: { proposalCreated: 1 },
        },
      }),
      makeEvent({
        action: 'engine-failed',
        outcome: 'failed',
        runEventSummary: {
          outcome: 'engine-failed',
          proposalCreated: false,
          actionCounts: { diffFiles: 0 },
        },
      }),
      makeEvent({
        action: 'empty-diff',
        outcome: 'no-proposal',
        runEventSummary: {
          outcome: 'empty-diff',
          proposalCreated: false,
          actionCounts: { diffFiles: 0 },
        },
      }),
    ]);

    expect(summary).toMatchObject({
      proposalEvents: 1,
      noProposalEvents: 1,
      diagnosticAttempts: 3,
      diagnosticNoProposalEvents: 1,
      policySuppressedEvents: 0,
      diagnosticProposalRate: 1 / 3,
      diagnosticNoProposalRate: 1 / 3,
    });
  });

  it('keeps selection, start, and no-dispatch actions out of attempt rates', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({
        kind: 'dispatch',
        action: 'daemon:drain-select',
        outcome: 'no-proposal',
        counts: { selected: 1 },
      }),
      makeEvent({
        kind: 'dispatch',
        action: 'daemon:dispatch-start',
        outcome: 'started',
        counts: { dispatched: 1 },
      }),
      makeEvent({
        kind: 'dispatch',
        action: 'daemon:dispatch-skip',
        outcome: 'no-proposal',
        counts: { dispatched: 0 },
      }),
      makeEvent({
        kind: 'dispatch',
        action: 'daemon:dispatch',
        outcome: 'failed',
        counts: { dispatched: 1 },
        runEventSummary: { outcome: 'engine-failed', proposalCreated: false },
      }),
    ]);

    expect(summary).toMatchObject({
      proposalEvents: 0,
      noProposalEvents: 0,
      diagnosticAttempts: 1,
      diagnosticNoProposalEvents: 0,
      diagnosticProposalRate: 0,
      diagnosticNoProposalRate: 0,
    });
  });

  it('deduplicates sandbox and daemon terminal telemetry for one causal run', () => {
    const summary = summarizeAgentWorkspace([
      makeEvent({
        runId: 'run-paired-proposal',
        trajectoryId: undefined,
        kind: 'maintenance',
        action: 'sandbox:complete',
        outcome: 'proposal-created',
        runEventSummary: { outcome: 'proposal-created', proposalCreated: true },
      }),
      makeEvent({
        runId: 'run-paired-proposal',
        trajectoryId: 'run:run-paired-proposal',
        kind: 'dispatch',
        action: 'daemon:dispatch',
        outcome: 'proposal-created',
        runEventSummary: { outcome: 'proposal-created', proposalCreated: true },
      }),
      makeEvent({
        runId: 'run-terminal-failure',
        trajectoryId: 'run:run-terminal-failure',
        kind: 'dispatch',
        action: 'daemon:dispatch',
        outcome: 'failed',
        runEventSummary: { outcome: 'engine-failed', proposalCreated: false },
      }),
    ]);

    expect(summary).toMatchObject({
      proposalEvents: 1,
      noProposalEvents: 0,
      diagnosticAttempts: 2,
      diagnosticNoProposalEvents: 0,
      diagnosticProposalRate: 0.5,
      diagnosticNoProposalRate: 0,
    });
  });

  it('reads a bounded durable workspace window from disk', () => {
    const repo = join(home, 'repo-a');
    mkdirSync(repo, { recursive: true });
    writeEnrollment([repo]);
    recordAgentAction([
      makeEvent({ action: 'old', ts: '2026-07-07T00:00:00.000Z' }),
      makeEvent({ action: 'new', ts: new Date().toISOString(), repo, outcome: 'proposal-created', proposalId: 'p-new' }),
    ]);

    const summary = readAgentWorkspace({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary.eventCount).toBe(1);
    expect(summary.proposalEvents).toBe(1);
    expect(summary.recentActions[0]).toMatchObject({ action: 'new', proposalId: 'p-new' });
  });

  it('filters workspace summaries to enrolled existing repos while keeping repo-less system events', () => {
    const repo = join(home, 'repo-a');
    const missingRepo = join(home, 'deleted-fixture');
    mkdirSync(repo, { recursive: true });
    writeEnrollment([repo, missingRepo]);
    const now = new Date().toISOString();
    recordAgentAction([
      makeEvent({ action: 'kept-enrolled', ts: now, repo, outcome: 'proposal-created', proposalId: 'p-kept' }),
      makeEvent({ action: 'dropped-missing', ts: now, repo: missingRepo, outcome: 'failed' }),
      makeEvent({ action: 'kept-system', ts: now, repo: undefined, kind: 'tick', outcome: 'ok' }),
    ]);

    const filtered = filterAgentActionsByRepoScope(readAgentActions({ limit: 10 }), {
      repoScope: 'enrolled-existing',
      enrolledRepos: [repo, missingRepo],
    });
    const scoped = readAgentWorkspace({ windowMs: 60 * 60 * 1000, limit: 10 });
    const all = readAgentWorkspace({ windowMs: 60 * 60 * 1000, limit: 10, repoScope: 'all' });

    expect(filtered.map((event) => event.action)).toEqual(['kept-system', 'kept-enrolled']);
    expect(scoped.eventCount).toBe(2);
    expect(scoped.proposalEvents).toBe(1);
    expect(scoped.diagnosticNoProposalEvents).toBe(0);
    expect(scoped.policySuppressedEvents).toBe(0);
    expect(scoped.byRepo).toEqual([expect.objectContaining({ key: repo, count: 1 })]);
    expect(scoped.recentActions.map((event) => event.action)).not.toContain('dropped-missing');
    expect(all.eventCount).toBe(3);
    expect(all.byRepo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: repo, count: 1 }),
        expect.objectContaining({ key: missingRepo, count: 1 }),
      ]),
    );
  });

  it('falls back to HOME when ASHLR_HOME is unset or empty', () => {
    const fallbackHome = mkdtempSync(join(tmpdir(), 'ashlr-m343-home-fallback-'));
    try {
      process.env.HOME = fallbackHome;
      process.env.USERPROFILE = fallbackHome;
      delete process.env.ASHLR_HOME;

      recordAgentAction(makeEvent({ action: 'home-fallback' }));
      expect(readAgentActions({ limit: 1 })[0]).toMatchObject({ action: 'home-fallback' });
      expect(existsSync(join(fallbackHome, '.ashlr', 'agent-actions'))).toBe(true);

      process.env.ASHLR_HOME = '';
      recordAgentAction(makeEvent({ action: 'empty-env-fallback' }));
      expect(readAgentActions({ limit: 1 })[0]).toMatchObject({ action: 'empty-env-fallback' });
      expect(existsSync(join(process.cwd(), 'agent-actions'))).toBe(false);
    } finally {
      rmSync(fallbackHome, { recursive: true, force: true });
    }
  });
});
