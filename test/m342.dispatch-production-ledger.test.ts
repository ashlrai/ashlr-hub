/**
 * test/m342.dispatch-production-ledger.test.ts — append-only dispatch-production history.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchProductionDir,
  readDispatchProductionEvents,
  readDispatchProductionYield,
  recordDispatchProduction,
  summarizeDispatchProductionYield,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';

let prevAshlrHome: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let home: string;

function makeEvent(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-08T12:00:00.000Z',
    machineId: 'machine-a',
    itemId: 'item-a',
    source: 'todo',
    repo: '/tmp/repo',
    title: 'Implement a thing',
    backend: 'local-coder',
    tier: 'mid',
    model: 'qwen',
    assignedBy: 'daemon',
    routeReason: 'local-mid bulk: local-coder',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: 'run-a',
    spentUsd: 0.001,
    reason: 'engine completed without file changes',
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

beforeEach(() => {
  prevAshlrHome = process.env.ASHLR_HOME;
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m342-dispatch-production-'));
  process.env.ASHLR_HOME = home;
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

describe('M342 dispatch production ledger', () => {
  it('appends and reads dispatch-production events newest first', () => {
    recordDispatchProduction([
      makeEvent({ itemId: 'old', ts: '2026-07-07T23:59:00.000Z' }),
      makeEvent({ itemId: 'new', ts: '2026-07-08T00:01:00.000Z', outcome: 'proposal-created', proposalCreated: true, proposalId: 'prop-new' }),
    ]);

    const events = readDispatchProductionEvents();

    expect(events.map((event) => event.itemId)).toEqual(['new', 'old']);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-new',
      basis: 'run-proposal-outcome',
    });
  });

  it('honors limit and sinceMs filters', () => {
    recordDispatchProduction([
      makeEvent({ itemId: 'a', ts: '2026-07-08T00:00:00.000Z' }),
      makeEvent({ itemId: 'b', ts: '2026-07-08T00:01:00.000Z' }),
      makeEvent({ itemId: 'c', ts: '2026-07-08T00:02:00.000Z' }),
    ]);

    expect(readDispatchProductionEvents({ limit: 2 }).map((event) => event.itemId)).toEqual(['c', 'b']);
    expect(readDispatchProductionEvents({ sinceMs: Date.parse('2026-07-08T00:01:30.000Z') }).map((event) => event.itemId)).toEqual(['c']);
  });

  it('normalizes invalid timestamps before writing', () => {
    recordDispatchProduction(makeEvent({ itemId: 'bad-ts', ts: 'not-a-date' }));

    const event = readDispatchProductionEvents({ limit: 1 })[0];

    expect(event).toMatchObject({ itemId: 'bad-ts' });
    expect(Number.isFinite(Date.parse(event!.ts))).toBe(true);
  });

  it('skips malformed lines and scrubs secret-shaped text before persistence', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), 'not-json\n', 'utf8');

    recordDispatchProduction(makeEvent({
      itemId: 'secret-item',
      routeReason: 'Authorization Bearer sk-supersecretsecretsecret',
      reason: 'token=ghp_1234567890abcdefABCDEF leaked by tool',
    }));

    const events = readDispatchProductionEvents();

    expect(events).toHaveLength(1);
    expect(events[0]!.itemId).toBe('secret-item');
    const raw = readFileSync(join(dir, '2026-07-08.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-supersecretsecretsecret');
    expect(raw).not.toContain('ghp_1234567890abcdefABCDEF');
    expect(raw).toContain('[REDACTED]');
  });

  it('never throws when persistence is unavailable', () => {
    process.env.ASHLR_HOME = join(home, 'file-home');
    writeFileSync(process.env.ASHLR_HOME, 'not a directory', 'utf8');

    expect(() => recordDispatchProduction(makeEvent())).not.toThrow();
    expect(() => readDispatchProductionEvents()).not.toThrow();
    expect(readDispatchProductionEvents()).toEqual([]);
    expect(existsSync(process.env.ASHLR_HOME)).toBe(true);
  });

  it('summarizes proposal yield by backend, source, repo, and model', () => {
    const events = [
      makeEvent({ itemId: 'a', backend: 'local-coder', model: 'qwen', outcome: 'empty-diff', proposalCreated: false, reason: 'no diff' }),
      makeEvent({ itemId: 'b', backend: 'local-coder', model: 'qwen', outcome: 'gate-blocked', proposalCreated: false, reason: 'gate blocked' }),
      makeEvent({ itemId: 'c', backend: 'codex', model: 'gpt-5.5', outcome: 'proposal-created', proposalCreated: true, proposalId: 'prop-c', source: 'goal' }),
      makeEvent({ itemId: 'd', backend: 'codex', model: 'gpt-5.5', outcome: 'proposal-disabled', proposalCreated: false, reason: 'proposal filing disabled for this sandboxed attempt' }),
    ];

    const summary = summarizeDispatchProductionYield(events, { windowHours: 24 });

    expect(summary).toMatchObject({
      attempts: 4,
      events: 4,
      proposalsCreated: 1,
      noProposal: 3,
      proposalRate: 1 / 4,
      outcomes: {
        proposalCreated: 1,
        emptyDiff: 1,
        gateBlocked: 1,
        proposalDisabled: 1,
      },
    });
    expect(summary?.byBackend[0]).toMatchObject({
      backend: 'local-coder',
      attempts: 2,
      proposalsCreated: 0,
      noProposal: 2,
      proposalRate: 0,
      outcomes: {
        emptyDiff: 1,
        gateBlocked: 1,
      },
    });
    expect(summary?.bySource.some((bucket) => bucket.source === 'goal' && bucket.proposalsCreated === 1)).toBe(true);
    expect(summary?.byBackend.some((bucket) =>
      bucket.backend === 'codex' &&
      bucket.attempts === 2 &&
      bucket.outcomes.proposalDisabled === 1
    )).toBe(true);
    expect(summary?.byBackendModel.some((bucket) =>
      bucket.key === 'codex:gpt-5.5' &&
      bucket.attempts === 2 &&
      bucket.proposalRate === 0.5 &&
      bucket.outcomes.proposalDisabled === 1
    )).toBe(true);
  });

  it('reads a bounded durable yield window from disk', () => {
    recordDispatchProduction([
      makeEvent({ itemId: 'old', ts: '2026-07-07T00:00:00.000Z' }),
      makeEvent({ itemId: 'new', ts: new Date().toISOString(), outcome: 'proposal-created', proposalCreated: true }),
    ]);

    const summary = readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary).toMatchObject({
      events: 1,
      proposalsCreated: 1,
      noProposal: 0,
    });
  });

  it('falls back to HOME when ASHLR_HOME is unset or empty', () => {
    const fallbackHome = mkdtempSync(join(tmpdir(), 'ashlr-m342-home-fallback-'));
    try {
      process.env.HOME = fallbackHome;
      process.env.USERPROFILE = fallbackHome;
      delete process.env.ASHLR_HOME;

      recordDispatchProduction(makeEvent({ itemId: 'home-fallback' }));
      expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({ itemId: 'home-fallback' });
      expect(existsSync(join(fallbackHome, '.ashlr', 'dispatch-production'))).toBe(true);

      process.env.ASHLR_HOME = '';
      recordDispatchProduction(makeEvent({ itemId: 'empty-env-fallback' }));
      expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({ itemId: 'empty-env-fallback' });
      expect(existsSync(join(process.cwd(), 'dispatch-production'))).toBe(false);
    } finally {
      rmSync(fallbackHome, { recursive: true, force: true });
    }
  });

  it('scrubs manually-written legacy rows during read aggregation', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-08.jsonl'),
      JSON.stringify(makeEvent({
        itemId: 'legacy-secret',
        routeReason: 'token=ghp_1234567890abcdefABCDEF',
        reason: 'Authorization Bearer sk-supersecretsecretsecret',
      })) + '\n',
      'utf8',
    );

    const event = readDispatchProductionEvents({ limit: 1 })[0]!;
    const summary = summarizeDispatchProductionYield([event]);

    expect(event.routeReason).not.toContain('ghp_1234567890abcdefABCDEF');
    expect(summary?.topReasons[0]?.reason).not.toContain('sk-supersecretsecretsecret');
    expect(JSON.stringify(summary)).toContain('[REDACTED]');
  });

  it('prunes stale day files before applying recent yield windows', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2020-01-01.jsonl'),
      JSON.stringify(makeEvent({ itemId: 'stale-file-recent-event', ts: new Date().toISOString() })) + '\n',
      'utf8',
    );
    recordDispatchProduction(makeEvent({
      itemId: 'current-file',
      ts: new Date().toISOString(),
      outcome: 'proposal-created',
      proposalCreated: true,
    }));

    const summary = readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary).toMatchObject({ events: 1, proposalsCreated: 1 });
    expect(summary?.byBackend[0]?.key).toBe('local-coder');
  });

  it('does not let loose legacy jsonl files consume the dated file budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, `zz-legacy-${i}.jsonl`),
        JSON.stringify(makeEvent({ itemId: `legacy-${i}`, ts: new Date().toISOString() })) + '\n',
        'utf8',
      );
    }
    recordDispatchProduction(makeEvent({ itemId: 'current-dated', ts: new Date().toISOString() }));

    const events = readDispatchProductionEvents({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxFiles: 1,
      limit: 20,
    });

    expect(events.map((event) => event.itemId)).toContain('current-dated');
  });

  it('derives durable yield file bounds from the requested window', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    recordDispatchProduction(makeEvent({
      itemId: 'five-days-old',
      ts: fiveDaysAgo.toISOString(),
      outcome: 'proposal-created',
      proposalCreated: true,
    }));

    const summary = readDispatchProductionYield({
      windowMs: 6 * 24 * 60 * 60 * 1000,
      limit: 20,
    });

    expect(summary).toMatchObject({ events: 1, proposalsCreated: 1 });
    expect(summary?.byBackend[0]?.key).toBe('local-coder');
  });
});
