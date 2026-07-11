/**
 * test/m342.dispatch-production-ledger.test.ts — append-only dispatch-production history.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchProductionDir,
  readDispatchProductionEvents,
  readDispatchProductionEventsDetailed,
  readDispatchProductionYield,
  readDispatchProductionYieldDetailed,
  recordDispatchProduction,
  summarizeDispatchProductionYield,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { repairGenerationIdFromHandoffId } from '../src/core/fleet/repair-handoff-journal.js';

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

  it('preserves complete repair transition lineage and marks partial or inconsistent tuples invalid', () => {
    const handoffId = 'a'.repeat(64);
    const generationId = repairGenerationIdFromHandoffId(handoffId)!;
    recordDispatchProduction([
      makeEvent({
        itemId: 'repair-first',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 1,
      }),
      makeEvent({
        itemId: 'repair-retry',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
        backend: 'kimi',
      }),
      makeEvent({
        itemId: 'repair-partial',
        repairHandoffId: handoffId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
      }),
      makeEvent({
        itemId: 'repair-inconsistent',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 1,
        repairPreviousBackend: 'local-coder',
      }),
      makeEvent({
        itemId: 'repair-unbound',
        repairHandoffId: handoffId,
        repairGenerationId: 'b'.repeat(64),
        repairAttemptOrdinal: 1,
      }),
      makeEvent({
        itemId: 'repair-same-backend',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
        backend: 'local-coder',
      }),
    ]);

    const byId = new Map(readDispatchProductionEvents().map((event) => [event.itemId, event]));
    expect(byId.get('repair-first')).toMatchObject({
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 1,
    });
    expect(byId.get('repair-first')).not.toHaveProperty('repairPreviousBackend');
    expect(byId.get('repair-retry')).toMatchObject({
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      backend: 'kimi',
    });
    expect(byId.get('repair-partial')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-inconsistent')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-unbound')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-same-backend')).toMatchObject({ repairLineageInvalid: true });
    expect(summarizeDispatchProductionYield([...byId.values()])?.generatedRepairBackendTransitions).toMatchObject({
      sourceState: 'degraded',
      lineageEvents: 2,
      transitionEvents: 1,
      attempts: 1,
      invalidLineageEvents: 4,
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
    expect(readDispatchProductionEventsDetailed({ limit: 2 })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['event-limit'],
      events: [{ itemId: 'c' }, { itemId: 'b' }],
    });
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

  it('persists authoritative versioned learning labels and drops hostile label payloads', () => {
    const rawPromptCanary = 'RAW_PROMPT_ATTEMPT_LABEL_CANARY_M342';
    const rawDiffCanary = 'RAW_DIFF_ATTEMPT_LABEL_CANARY_M342';
    recordDispatchProduction(makeEvent({
      itemId: 'policy-label',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      runEventSummary: {
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: { proposalDisabled: 2, diffFiles: 0 },
      },
      learningLabel: {
        schemaVersion: 1,
        classifierVersion: 'attempt-shape-v1',
        authoritative: true,
        learningKind: 'diagnostic-no-proposal',
        policySuppressed: false,
        diagnosticNoProposal: true,
        diagnosticAttempt: true,
        attemptShape: {
          backendNoDiff: 99,
          captureOrGateBlocked: 99,
          repairAttempts: 99,
          policyDisabled: 0,
        },
        rawPrompt: rawPromptCanary,
        rawDiff: rawDiffCanary,
      } as never,
      rawPrompt: rawPromptCanary,
      rawDiff: rawDiffCanary,
    } as never));

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    expect(event?.learningLabel).toMatchObject({
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
        policyDisabled: 2,
      },
    });

    const raw = readFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), 'utf8');
    expect(raw).toContain('"learningLabel"');
    expect(raw).toContain('"authoritative":true');
    expect(raw).toContain('"routerPolicyVersion":"fleet-router-v1"');
    expect(raw).toContain('"learningEpoch":"2026-07-08"');
    expect(event?.routerPolicyVersion).toBe('fleet-router-v1');
    expect(event?.learningEpoch).toBe('2026-07-08');
    expect(raw).not.toContain(rawPromptCanary);
    expect(raw).not.toContain(rawDiffCanary);
    expect(JSON.stringify(event)).not.toContain(rawPromptCanary);
    expect(JSON.stringify(event)).not.toContain(rawDiffCanary);
  });

  it('keeps legacy rows visible with read-time labels but without durable rewrite', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), JSON.stringify(makeEvent({ itemId: 'legacy-row' })) + '\n', 'utf8');

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    const summary = summarizeDispatchProductionYield(event ? [event] : []);

    expect(event?.itemId).toBe('legacy-row');
    expect(event?.routeSnapshot).toMatchObject({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      reason: 'local-mid bulk: local-coder',
    });
    expect(event?.runEventSummary).toMatchObject({
      runId: 'run-a',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: 0.001,
    });
    expect(event?.learningLabel).toMatchObject({
      authoritative: true,
      learningKind: 'diagnostic-no-proposal',
      diagnosticNoProposal: true,
      attemptShape: { backendNoDiff: 1 },
    });
    expect(summary).toMatchObject({
      attempts: 1,
      attemptShape: { backendNoDiff: 1 },
    });
    const raw = readFileSync(join(dir, '2026-07-08.jsonl'), 'utf8');
    expect(raw).not.toContain('"routeSnapshot"');
    expect(raw).not.toContain('"runEventSummary"');
    expect(raw).not.toContain('"learningLabel"');
  });

  it('uses a valid durable learning label for attempt-shape aggregation when raw signals disagree', () => {
    const event = makeEvent({
      itemId: 'contradictory-label',
      outcome: 'empty-diff',
      proposalCreated: false,
      reason: 'empty-diff from raw run',
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
          policyDisabled: 7,
        },
      },
    });

    const summary = summarizeDispatchProductionYield([event]);

    expect(summary).toMatchObject({
      attempts: 1,
      outcomes: { emptyDiff: 1 },
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 7,
      },
      topReasons: [{ reason: 'empty-diff from raw run', count: 1 }],
      diagnosticTopReasons: [],
      byBackend: [{
        key: 'local-coder',
        topReasons: [{ reason: 'empty-diff from raw run', count: 1 }],
        diagnosticTopReasons: [],
      }],
    });
  });

  it('never throws when persistence is unavailable', () => {
    process.env.ASHLR_HOME = join(home, 'file-home');
    writeFileSync(process.env.ASHLR_HOME, 'not a directory', 'utf8');

    expect(recordDispatchProduction(makeEvent())).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(() => readDispatchProductionEvents()).not.toThrow();
    expect(readDispatchProductionEvents()).toEqual([]);
    expect(existsSync(process.env.ASHLR_HOME)).toBe(true);
  });

  it('reports missing, healthy-empty, and malformed source states without healthy-zero collapse', () => {
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });

    mkdirSync(dispatchProductionDir(), { recursive: true });
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
    });

    writeFileSync(
      join(dispatchProductionDir(), '2026-07-08.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'valid' }))}\nnot-json\n`,
      'utf8',
    );
    const degraded = readDispatchProductionEventsDetailed();
    expect(degraded.events.map((event) => event.itemId)).toEqual(['valid']);
    expect(degraded).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
      unreadableFiles: 0,
    });
  });

  it('reads only the newest bounded tail and never backfills an older partition', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-07.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'older-partition' }))}\n`,
      'utf8',
    );
    const filler = `${JSON.stringify(makeEvent({ itemId: 'newer-filler' }))}\n`;
    const newest = `${JSON.stringify(makeEvent({ itemId: 'newest-event' }))}\n`;
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${filler}${newest}`, 'utf8');

    const maxBytes = Buffer.byteLength(newest, 'utf8') + 1;
    const read = readDispatchProductionEventsDetailed({ maxBytes, limit: 20, maxRows: 100 });

    expect(read.events.map((event) => event.itemId)).toEqual(['newest-event']);
    expect(read).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['byte-limit'],
      filesRead: 1,
      bytesRead: maxBytes,
    });
    expect(read.events.map((event) => event.itemId)).not.toContain('older-partition');
  });

  it('bounds physical malformed rows even when no valid event can be returned', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${'not-json\n'.repeat(10)}`, 'utf8');

    const read = readDispatchProductionEventsDetailed({ maxRows: 3, limit: 20 });

    expect(read).toMatchObject({
      events: [],
      sourceState: 'degraded',
      complete: false,
      rowsScanned: 3,
      invalidRows: 3,
    });
    expect(read.stopReasons).toContain('row-limit');
  });

  it('does not count the terminal JSONL separator against the physical row budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-08.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'single-row' }))}\n`,
      'utf8',
    );

    expect(readDispatchProductionEventsDetailed({ maxRows: 1, limit: 20 })).toMatchObject({
      events: [{ itemId: 'single-row' }],
      sourceState: 'healthy',
      complete: true,
      rowsScanned: 1,
    });
    expect(readDispatchProductionEventsDetailed({ maxRows: 10, limit: 1 })).toMatchObject({
      events: [{ itemId: 'single-row' }],
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
    });
  });

  it('prunes stale partitions before deciding an exact row budget is exhausted', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${now.slice(0, 10)}.jsonl`),
      `${JSON.stringify(makeEvent({ itemId: 'current-row', ts: now }))}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, '2020-01-01.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'stale-row', ts: '2020-01-01T00:00:00.000Z' }))}\n`,
      'utf8',
    );

    expect(readDispatchProductionEventsDetailed({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxRows: 1,
      limit: 20,
    })).toMatchObject({
      events: [{ itemId: 'current-row' }],
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
      rowsScanned: 1,
    });
  });

  it('reads dated partitions before loose legacy filenames under a shared byte budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const dated = `${JSON.stringify(makeEvent({ itemId: 'dated-current' }))}\n`;
    writeFileSync(join(dir, '2026-07-08.jsonl'), dated, 'utf8');
    writeFileSync(join(dir, 'zz-legacy.jsonl'), `${'x'.repeat(500)}\n`, 'utf8');

    const read = readDispatchProductionEventsDetailed({ maxBytes: Buffer.byteLength(dated) + 1, limit: 20 });

    expect(read.events.map((event) => event.itemId)).toEqual(['dated-current']);
    expect(read.filesRead).toBe(2);
    expect(read.stopReasons).toContain('byte-limit');
  });

  it('rejects linked partitions and exposes the I/O failure', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const target = join(home, 'outside.jsonl');
    writeFileSync(target, `${JSON.stringify(makeEvent({ itemId: 'linked' }))}\n`, 'utf8');
    symlinkSync(target, join(dir, '2026-07-08.jsonl'));

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a linked storage directory', () => {
    const dir = dispatchProductionDir();
    const outside = join(home, 'outside-dir');
    mkdirSync(outside, { mode: 0o700 });
    mkdirSync(join(home, 'placeholder'), { mode: 0o700 });
    symlinkSync(outside, dir, 'dir');
    writeFileSync(join(outside, '2026-07-08.jsonl'), `${JSON.stringify(makeEvent())}\n`, { mode: 0o600 });

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [], sourceState: 'degraded', complete: false,
      stopReasons: ['io-error'], unreadableFiles: 1,
    });
  });

  it('bounds physical directory enumeration before selecting ledger files', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 2_049; index++) {
      writeFileSync(join(dir, `noise-${index}.txt`), '');
    }

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [], sourceState: 'degraded', complete: false,
      stopReasons: ['file-limit'], filesRead: 0,
    });
  });

  it('isolates a torn tail before appending the next durable event', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-07-08.jsonl');
    writeFileSync(path, `${JSON.stringify(makeEvent({ itemId: 'before-torn' }))}\n{"partial":`, 'utf8');

    recordDispatchProduction(makeEvent({ itemId: 'after-torn' }));
    const read = readDispatchProductionEventsDetailed();

    expect(read.events.map((event) => event.itemId)).toEqual(['after-torn', 'before-torn']);
    expect(read).toMatchObject({ sourceState: 'degraded', invalidRows: 1 });
  });

  it('rejects malformed persisted timestamps instead of promoting them into the current window', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(makeEvent({ itemId: 'bad-persisted-ts', ts: 'not-a-date' }))}\n`,
      'utf8',
    );

    const read = readDispatchProductionEventsDetailed({ sinceMs: Date.now() - 60_000 });
    expect(read).toMatchObject({ events: [], sourceState: 'degraded', invalidRows: 1 });
  });

  it('propagates bounded read quality through yield diagnostics while preserving wrappers', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, new Date().toISOString().slice(0, 10) + '.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'yield-valid', ts: new Date().toISOString() }))}\nnot-json\n`,
      'utf8',
    );

    const detailed = readDispatchProductionYieldDetailed({ windowMs: 60 * 60 * 1000, limit: 20 });
    expect(detailed.summary).toMatchObject({ events: 1 });
    expect(detailed.sourceQuality).toMatchObject({ sourceState: 'degraded', invalidRows: 1 });
    expect(readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 })).toMatchObject({ events: 1 });
    expect(readDispatchProductionEvents({ limit: 20 })).toHaveLength(1);
  });

  it('summarizes proposal yield by backend, source, repo, and model', () => {
    const events = [
      makeEvent({
        itemId: 'a',
        backend: 'local-coder',
        model: 'qwen',
        outcome: 'empty-diff',
        proposalCreated: false,
        reason: 'no diff',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            diffFiles: 0,
            proposalBlocked: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'b',
        backend: 'local-coder',
        model: 'qwen',
        outcome: 'gate-blocked',
        proposalCreated: false,
        reason: 'gate blocked',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            completenessGateRuns: 1,
            verifyRepairAttempts: 1,
            diffFiles: 2,
            diffLines: 15,
            proposalBlocked: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'c',
        backend: 'codex',
        model: 'gpt-5.5',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-c',
        source: 'goal',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            diffFiles: 1,
            diffLines: 5,
            proposalCreated: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'd',
        backend: 'codex',
        model: 'gpt-5.5',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this sandboxed attempt',
        runEventSummary: {
          actionCounts: {
            proposalDisabled: 1,
          },
        },
      }),
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
      actionCounts: {
        proposalCaptureAttempts: 3,
        completenessGateRuns: 1,
        verifyRepairAttempts: 1,
        diffFiles: 3,
        diffLines: 20,
        proposalCreated: 1,
        proposalBlocked: 2,
        proposalDisabled: 1,
      },
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 1,
        repairAttempts: 1,
        policyDisabled: 1,
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
      actionCounts: {
        proposalCaptureAttempts: 2,
        completenessGateRuns: 1,
        verifyRepairAttempts: 1,
        diffFiles: 2,
        diffLines: 15,
        proposalBlocked: 2,
      },
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 1,
        repairAttempts: 1,
        policyDisabled: 0,
      },
    });
    expect(summary?.bySource.some((bucket) => bucket.source === 'goal' && bucket.proposalsCreated === 1)).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'local-coder:todo' &&
      bucket.backend === 'local-coder' &&
      bucket.source === 'todo' &&
      bucket.attempts === 2 &&
      bucket.proposalRate === 0
    )).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'codex:goal' &&
      bucket.backend === 'codex' &&
      bucket.source === 'goal' &&
      bucket.attempts === 1 &&
      bucket.proposalRate === 1
    )).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'codex:todo' &&
      bucket.backend === 'codex' &&
      bucket.source === 'todo' &&
      bucket.attempts === 1 &&
      bucket.outcomes.proposalDisabled === 1
    )).toBe(true);
    expect(summary?.byBackend.some((bucket) =>
      bucket.backend === 'codex' &&
      bucket.attempts === 2 &&
      bucket.outcomes.proposalDisabled === 1 &&
      bucket.actionCounts?.proposalCreated === 1 &&
      bucket.actionCounts?.proposalDisabled === 1
    )).toBe(true);
    expect(summary?.byBackendModel.some((bucket) =>
      bucket.key === 'codex:gpt-5.5' &&
      bucket.attempts === 2 &&
      bucket.proposalRate === 0.5 &&
      bucket.outcomes.proposalDisabled === 1 &&
      bucket.actionCounts?.diffFiles === 1 &&
      bucket.actionCounts?.diffLines === 5
    )).toBe(true);
  });

  it('classifies generated repair work as repair attempts without raw text in labels', () => {
    const captureRepair = makeEvent({
      itemId: 'ashlr-hub:proposal-repair-capture:abcdef123456',
      title: 'Repair dispatch capture failure for ashlr-hub item ashlr-hub:self-heal:stalled',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-repair',
      reason: 'completed repair proposal',
      runEventSummary: {
        runId: 'run-repair',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-repair',
        actionCounts: { proposalCreated: 1, diffFiles: 1, diffLines: 8 },
      },
    });
    const noDiffReslice = makeEvent({
      itemId: 'ashlr-hub:proposal-repair-nodiff:123456789abc',
      title: 'Reslice no-diff dispatch for ashlr-hub item ashlr-hub:goal:stalled',
      outcome: 'empty-diff',
      proposalCreated: false,
      proposalId: undefined,
      reason: 'still no diff',
      runEventSummary: {
        runId: 'run-reslice',
        outcome: 'empty-diff',
        proposalCreated: false,
        actionCounts: { diffFiles: 0 },
      },
    });
    recordDispatchProduction(captureRepair);

    const event = readDispatchProductionEvents()[0]!;
    const summary = summarizeDispatchProductionYield([event, noDiffReslice]);

    expect(event.learningLabel).toMatchObject({
      learningKind: 'proposal-created',
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 1,
        policyDisabled: 0,
      },
    });
    expect(JSON.stringify(event.learningLabel)).not.toContain('Repair dispatch');
    expect(summary).toMatchObject({
      attempts: 2,
      proposalsCreated: 1,
      noProposal: 1,
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 0,
        repairAttempts: 2,
        policyDisabled: 0,
      },
      generatedRepairAttempts: {
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        captureRepairs: 1,
        diagnosticReslices: 1,
        proposalRepairs: 0,
      },
    });
  });

  it('keeps raw proposal-disabled reasons while exposing diagnostic reasons for operators', () => {
    const summary = summarizeDispatchProductionYield([
      makeEvent({
        itemId: 'sandbox-policy',
        backend: 'codex',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this sandboxed attempt',
      }),
      makeEvent({
        itemId: 'api-policy',
        backend: 'codex',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this api-model attempt',
      }),
      makeEvent({
        itemId: 'empty-diff',
        backend: 'local-coder',
        outcome: 'empty-diff',
        proposalCreated: false,
        reason: 'engine "local-coder" completed without file changes',
      }),
    ]);

    expect(summary?.topReasons.map((row) => row.reason)).toEqual([
      'engine "local-coder" completed without file changes',
      'proposal filing disabled for this api-model attempt',
      'proposal filing disabled for this sandboxed attempt',
    ]);
    expect(summary?.diagnosticTopReasons).toEqual([
      { reason: 'engine "local-coder" completed without file changes', count: 1 },
    ]);
    const codex = summary?.byBackend.find((bucket) => bucket.backend === 'codex');
    expect(codex?.topReasons.map((row) => row.reason)).toEqual([
      'proposal filing disabled for this api-model attempt',
      'proposal filing disabled for this sandboxed attempt',
    ]);
    expect(codex?.diagnosticTopReasons).toEqual([]);
  });

  it('treats capture-missing proposal-disabled telemetry as diagnostic, not policy-suppressed', () => {
    recordDispatchProduction(makeEvent({
      itemId: 'capture-missing',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      reason: 'capture-missing: required proposal dispatch ended before final capture',
      runEventSummary: {
        status: 'failed',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: {
          proposalDisabled: 1,
          proposalCaptureAttempts: 0,
        },
      },
    }));

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    expect(event?.learningLabel).toMatchObject({
      learningKind: 'diagnostic-no-proposal',
      policySuppressed: false,
      diagnosticNoProposal: true,
      diagnosticAttempt: true,
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 1,
        policyDisabled: 0,
      },
    });

    const summary = summarizeDispatchProductionYield([event!]);
    expect(summary).toMatchObject({
      attempts: 1,
      proposalsCreated: 0,
      outcomes: {
        proposalCaptureError: 1,
        proposalDisabled: 0,
      },
      actionCounts: {
        proposalDisabled: 1,
      },
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 1,
        policyDisabled: 0,
      },
      diagnosticTopReasons: [
        {
          reason: 'capture-missing: required proposal dispatch ended before final capture',
          count: 1,
        },
      ],
    });
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

  it('deduplicates repair transition learning and degrades contradictory lineage', () => {
    const handoffId = 'a'.repeat(64);
    const generationId = repairGenerationIdFromHandoffId(handoffId)!;
    const retry = makeEvent({
      itemId: `diagnostic:generated-repair:${generationId}`,
      backend: 'kimi',
      outcome: 'proposal-created',
      proposalCreated: true,
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    const distinct = makeEvent({
      ...retry,
      runId: 'run-b',
      outcome: 'engine-failed',
      proposalCreated: false,
    });
    const conflict = makeEvent({
      ...retry,
      runId: retry.runId,
      backend: 'nim',
      outcome: 'empty-diff',
      proposalCreated: false,
    });

    const healthy = summarizeDispatchProductionYield([retry, { ...retry }, distinct]);
    expect(healthy?.generatedRepairBackendTransitions).toEqual({
      sourceState: 'healthy',
      lineageEvents: 3,
      transitionEvents: 3,
      attempts: 2,
      duplicateEvents: 1,
      conflictingAttempts: 0,
      invalidLineageEvents: 0,
      byTransition: [{
        previousBackend: 'local-coder',
        retryBackend: 'kimi',
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        outcomes: expect.objectContaining({ proposalCreated: 1, engineFailed: 1 }),
      }],
    });

    const degraded = summarizeDispatchProductionYield([retry, distinct, conflict]);
    expect(degraded?.generatedRepairBackendTransitions).toMatchObject({
      sourceState: 'degraded',
      lineageEvents: 3,
      transitionEvents: 3,
      attempts: 1,
      conflictingAttempts: 1,
      byTransition: [{
        previousBackend: 'local-coder',
        retryBackend: 'kimi',
        attempts: 1,
        proposalsCreated: 0,
        noProposal: 1,
      }],
    });
    expect(JSON.stringify(degraded?.generatedRepairBackendTransitions)).not.toContain(generationId);
    expect(JSON.stringify(degraded?.generatedRepairBackendTransitions)).not.toContain(handoffId);
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
    expect(readDispatchProductionEventsDetailed({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxFiles: 1,
      limit: 20,
    })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      datedFilesRead: 1,
      looseFilesRead: 3,
    });
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
