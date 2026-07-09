/**
 * m343.agent-action-ledger.test.ts — append-only agent action telemetry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentActionsDir,
  readAgentActions,
  readAgentWorkspace,
  recordAgentAction,
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

  it('preserves started and verification lifecycle outcomes', () => {
    recordAgentAction([
      makeEvent({
        action: 'daemon:tick-start',
        kind: 'tick',
        outcome: 'started',
        summary: 'start: budget $1.00, perTick 4, parallel 3',
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

    expect(events.map((event) => event.outcome)).toEqual(['verified', 'started']);
    expect(events[0]).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      action: 'auto-merge:verify-before-judge-finish',
    });
    expect(events[1]).toMatchObject({
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

  it('scrubs and bounds corrupted enum-like legacy rows before returning summaries', () => {
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

    const events = readAgentActions();
    const summary = summarizeAgentWorkspace(events);
    const serialized = JSON.stringify({ events, summary });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'system',
      kind: 'reflection',
      outcome: 'unknown',
    });
    expect(events[0]!.backend).toBeUndefined();
    expect(events[0]!.source).toBeUndefined();
    expect(events[0]!.tier).toBeUndefined();
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
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

  it('never throws when persistence is unavailable', () => {
    process.env.ASHLR_HOME = join(home, 'file-home');
    writeFileSync(process.env.ASHLR_HOME, 'not a directory', 'utf8');

    expect(() => recordAgentAction(makeEvent())).not.toThrow();
    expect(() => readAgentActions()).not.toThrow();
    expect(readAgentActions()).toEqual([]);
    expect(existsSync(process.env.ASHLR_HOME)).toBe(true);
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
    });
    expect(summary.spendUsd).toBeCloseTo(0.6);
    expect(summary.byRepo[0]).toMatchObject({ key: '/tmp/repo-a', count: 2 });
    expect(summary.byBackend[0]).toMatchObject({ key: 'codex', count: 2 });
    expect(summary.entropy.action).toBeGreaterThanOrEqual(0);
    expect(summary.attention.some((row) => row.kind === 'repo' && row.topic === '/tmp/repo-a')).toBe(true);
  });

  it('reads a bounded durable workspace window from disk', () => {
    recordAgentAction([
      makeEvent({ action: 'old', ts: '2026-07-07T00:00:00.000Z' }),
      makeEvent({ action: 'new', ts: new Date().toISOString(), outcome: 'proposal-created', proposalId: 'p-new' }),
    ]);

    const summary = readAgentWorkspace({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary.eventCount).toBe(1);
    expect(summary.proposalEvents).toBe(1);
    expect(summary.recentActions[0]).toMatchObject({ action: 'new', proposalId: 'p-new' });
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
