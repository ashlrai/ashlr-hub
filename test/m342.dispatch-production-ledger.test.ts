/**
 * test/m342.dispatch-production-ledger.test.ts — append-only dispatch-production history.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchProductionDir,
  readDispatchProductionEvents,
  readDispatchProductionEventsDetailed,
  readDispatchProductionParents,
  readDispatchProductionYield,
  readDispatchProductionYieldDetailed,
  recordDispatchProduction,
  sanitizeDispatchProductionEvent,
  summarizeDispatchProductionYield,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { repairGenerationIdFromHandoffId } from '../src/core/fleet/repair-handoff-journal.js';
import {
  generatedRepairLifecycleAttemptHash,
  repairTreatmentForUnitId,
  repairTreatmentUnitId,
} from '../src/core/fleet/generated-repair-identity.js';

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
    repo: join(realpathSync.native(tmpdir()), 'repo'),
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
    const written = recordDispatchProduction([
      makeEvent({ itemId: 'old', ts: '2026-07-07T23:59:00.000Z' }),
      makeEvent({ itemId: 'new', ts: '2026-07-08T00:01:00.000Z', outcome: 'proposal-created', proposalCreated: true, proposalId: 'prop-new' }),
    ]);

    const events = readDispatchProductionEvents();

    expect(written).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    expect(events.map((event) => event.itemId)).toEqual(['new', 'old']);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-new',
      basis: 'run-proposal-outcome',
    });
  });

  it('persists physical repo identity and rejects legacy lexical or linked aliases', () => {
    const physicalRepo = join(home, 'physical-repo');
    const nested = join(physicalRepo, 'identity-probe');
    const linkedAlias = join(home, 'repo-alias');
    mkdirSync(nested, { recursive: true });
    const canonicalRepo = realpathSync.native(physicalRepo);
    const lexicalAlias = join(nested, '..');
    symlinkSync(canonicalRepo, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(recordDispatchProduction([
      makeEvent({ itemId: 'lexical-alias', repo: lexicalAlias }),
      makeEvent({ itemId: 'linked-alias', repo: linkedAlias }),
    ])).toEqual({ attempted: 2, recorded: 2, failed: 0 });

    const ledgerPath = join(dispatchProductionDir(), '2026-07-08.jsonl');
    const raw = readFileSync(ledgerPath, 'utf8');
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line) as DispatchProductionEvent);
    expect(rows.map((row) => row.repo)).toEqual([canonicalRepo, canonicalRepo]);
    expect(readDispatchProductionEvents().map((event) => event.repo)).toEqual([canonicalRepo, canonicalRepo]);
    expect(readDispatchProductionParents([{
      ts: '2026-07-08T12:00:00.000Z',
      itemId: 'linked-alias',
      repo: linkedAlias,
      outcome: 'empty-diff',
      attemptId: rows[1]!.trajectoryId ?? rows[1]!.runId!,
    }])).toEqual(['found']);

    const legacyAlias = makeEvent({ itemId: 'legacy-alias', repo: linkedAlias });
    writeFileSync(ledgerPath, `${raw}${JSON.stringify(legacyAlias)}\n`, 'utf8');
    const detailed = readDispatchProductionEventsDetailed();
    expect(detailed.events.map((event) => event.itemId)).toEqual(['linked-alias', 'lexical-alias']);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    const rawAfter = readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as DispatchProductionEvent);
    expect(rawAfter.at(-1)?.repo).toBe(linkedAlias);
  });

  it('idempotently rejects relative and secret-shaped raw repo identities without fallback rows', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const invalidRepos = ['relative/repo', join(home, `token=${secret}`)];

    for (const [index, repo] of invalidRepos.entries()) {
      const event = makeEvent({ itemId: `invalid-repo-${index}`, repo });
      expect(() => sanitizeDispatchProductionEvent(event)).toThrow(/repository identity/);
      expect(() => sanitizeDispatchProductionEvent(event)).toThrow(/repository identity/);
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    }

    expect(existsSync(join(dispatchProductionDir(), '2026-07-08.jsonl'))).toBe(false);
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
      classifierVersion: 'attempt-shape-v2',
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
      diagnosticAttempts: 3,
      diagnosticNoProposal: 2,
      diagnosticProposalRate: 1 / 3,
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
      diagnosticAttempts: 2,
      diagnosticNoProposal: 2,
      diagnosticProposalRate: 0,
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
      bucket.diagnosticAttempts === 1 &&
      bucket.diagnosticNoProposal === 0 &&
      bucket.diagnosticProposalRate === 1 &&
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

  it('accounts explicit and historical cancellation separately from genuine engine failure', () => {
    const explicitCancellation = makeEvent({
      itemId: 'explicit-cancellation',
      outcome: 'cancelled' as never,
      proposalCreated: false,
      reason: 'run cancelled by owner',
      runEventSummary: {
        status: 'aborted',
        outcome: 'cancelled',
        proposalCreated: false,
      },
    });
    const historicalCancellation = makeEvent({
      itemId: 'historical-cancellation',
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'swarm cancelled by owner',
      runEventSummary: {
        status: 'aborted',
        outcome: 'engine-failed',
        proposalCreated: false,
      },
    });
    const genuineFailure = makeEvent({
      itemId: 'genuine-engine-failure',
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'provider request failed',
      runEventSummary: {
        status: 'aborted',
        outcome: 'engine-failed',
        proposalCreated: false,
      },
    });

    const summary = summarizeDispatchProductionYield([
      explicitCancellation,
      historicalCancellation,
      genuineFailure,
    ]);

    expect(summary?.outcomes).toEqual({
      proposalCreated: 0,
      emptyDiff: 0,
      gateBlocked: 0,
      engineFailed: 1,
      cancelled: 2,
      sandboxFailed: 0,
      proposalCaptureError: 0,
      proposalDisabled: 0,
      unknown: 0,
    });
    expect(summary).toMatchObject({
      attempts: 3,
      noProposal: 3,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
    });
    expect(summary?.byBackend[0]).toMatchObject({
      attempts: 3,
      noProposal: 3,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
      diagnosticTopReasons: [{ reason: 'provider request failed', count: 1 }],
    });
    expect(summary?.diagnosticTopReasons).toEqual([
      { reason: 'provider request failed', count: 1 },
    ]);
    expect(summary?.byBackend[0]?.outcomes).toEqual(summary?.outcomes);
    expect(summarizeDispatchProductionYield([genuineFailure])?.outcomes.cancelled).toBe(0);
  });

  it('excludes current and historical cancellation from generated-repair conversion accounting', () => {
    const generatedRepair = {
      itemId: 'ashlr-hub:proposal-repair-nodiff:123456789abc',
      title: 'Reslice no-diff dispatch for cancellation accounting',
      proposalCreated: false,
    } as const;
    const explicitCancellation = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-cancelled',
      outcome: 'cancelled' as never,
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    });
    const historicalCancellation = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-legacy-cancelled',
      outcome: 'engine-failed',
      reason: 'best-of-2 selection cancelled by owner',
      runEventSummary: { status: 'failed', outcome: 'engine-failed', proposalCreated: false },
    });
    const genuineFailure = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-failed',
      outcome: 'engine-failed',
      reason: 'provider request failed',
      runEventSummary: { status: 'failed', outcome: 'engine-failed', proposalCreated: false },
    });

    const summary = summarizeDispatchProductionYield([
      explicitCancellation,
      historicalCancellation,
      genuineFailure,
    ]);

    expect(summary?.outcomes).toMatchObject({ cancelled: 2, engineFailed: 1 });
    expect(summary?.generatedRepairAttempts).toMatchObject({
      attempts: 1,
      proposalsCreated: 0,
      noProposal: 1,
      proposalRate: 0,
      captureRepairs: 0,
      diagnosticReslices: 1,
      proposalRepairs: 0,
    });
  });

  function treatmentEvents(ts = '2026-07-08T12:00:00.000Z'): DispatchProductionEvent[] {
    const byTreatment = new Map<string, number>();
    const events: DispatchProductionEvent[] = [];
    for (let index = 0; index < 1_000 && (
      (byTreatment.get('baseline-reslice') ?? 0) < 3 ||
      (byTreatment.get('target-localization') ?? 0) < 3
    ); index++) {
      const unitId = repairTreatmentUnitId({
        kind: 'no-diff-reslice',
        repo: '/tmp/repo',
        parentItemId: `repo:goal:treatment-${index}`,
        parentObjectiveHash: index.toString(16).padStart(64, '0'),
      })!;
      const treatment = repairTreatmentForUnitId(unitId)!;
      const armIndex = byTreatment.get(treatment) ?? 0;
      if (armIndex >= 3) continue;
      const handoffId = (index + 1_000).toString(16).padStart(64, '0');
      const itemId = `ashlr-hub:proposal-repair-nodiff:${index.toString(16).padStart(12, '0')}`;
      const runId = `run-treatment-${index}-1`;
      const converted = armIndex === 0;
      const first = makeEvent({
        ts,
        itemId,
        title: 'Reslice no-diff dispatch for treatment learning',
        runId,
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        repairTreatmentUnitId: unitId,
        repairTreatment: treatment,
        repairAttemptOrdinal: 1,
        outcome: converted ? 'proposal-created' : 'empty-diff',
        proposalCreated: converted,
        ...(converted ? { proposalId: `prop-treatment-${treatment}` } : {}),
      });
      events.push(first);
      const terminal = converted
        ? first
        : makeEvent({
          ...first,
          runId: `run-treatment-${index}-2`,
          backend: 'kimi',
          repairAttemptOrdinal: 2,
          repairPreviousBackend: 'local-coder',
        });
      if (!converted) events.push(terminal);
      events.push({
        ...terminal,
        basis: 'repair-lifecycle-candidate',
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(terminal.runId!),
      });
      events.push({
        ...terminal,
        basis: 'repair-lifecycle-outcome',
        repairTreatmentOutcome: converted ? 'converted' : 'not-converted',
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(terminal.runId!),
      });
      byTreatment.set(treatment, armIndex + 1);
    }
    return events;
  }

  it('requires terminal lifecycle witnesses, sample-gates distinct units, and withholds replayed data', () => {
    const events = treatmentEvents();
    const raw = events.find((event) => event.repairTreatmentOutcome === undefined)!;
    const replay = { ...raw, runId: 'replayed-execution' };
    const lastUnit = events.at(-1)!.repairTreatmentUnitId;

    expect(summarizeDispatchProductionYield(events.filter((event) => event.repairTreatmentUnitId !== lastUnit))?.generatedRepairAttempts)
      .not.toHaveProperty('treatmentConversions');
    const generated = summarizeDispatchProductionYield(events)?.generatedRepairAttempts;
    expect(generated?.treatmentAttribution).toEqual({
      eligibleEvents: 10,
      attributedEvents: 10,
      unattributedEvents: 0,
      distinctUnits: 6,
      replayedEvents: 0,
      minimumTerminalUnitsPerArm: 3,
      arms: [
        { repairTreatment: 'baseline-reslice', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
        { repairTreatment: 'target-localization', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
      ],
      gate: 'ready',
      blockers: [],
    });
    expect(generated?.treatmentConversions).toEqual([
      { repairTreatment: 'baseline-reslice', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
      { repairTreatment: 'target-localization', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
    ]);
    const terminalWitness = events.find((event) => event.repairTreatmentOutcome !== undefined)!;
    const active = summarizeDispatchProductionYield(events.filter((event) => event !== terminalWitness))?.generatedRepairAttempts;
    expect(active?.treatmentAttribution).toMatchObject({
      gate: 'collecting',
      blockers: ['in-flight'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(active).not.toHaveProperty('treatmentConversions');
    const mismatched = summarizeDispatchProductionYield(events.map((event) =>
      event === terminalWitness ? { ...event, repairTreatmentAttemptHash: 'f'.repeat(64) } : event
    ))?.generatedRepairAttempts;
    expect(mismatched?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: ['in-flight', 'unattributed'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(mismatched).not.toHaveProperty('treatmentConversions');
    const duplicateWitness = summarizeDispatchProductionYield([...events, terminalWitness])?.generatedRepairAttempts;
    expect(duplicateWitness?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: ['in-flight', 'unmatched-terminal', 'replayed'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(duplicateWitness).not.toHaveProperty('treatmentConversions');
    const replayed = summarizeDispatchProductionYield([...events, replay])?.generatedRepairAttempts;
    expect(replayed?.treatmentAttribution?.replayedEvents).toBe(1);
    expect(replayed).not.toHaveProperty('treatmentConversions');
  });

  it('does not let cancelled repair executions contaminate treatment conversions', () => {
    const events = treatmentEvents();
    const raw = events.find((event) =>
      event.repairTreatmentOutcome === undefined &&
      event.basis !== 'repair-lifecycle-candidate'
    )!;
    const explicitCancellation = {
      ...raw,
      runId: 'cancelled-treatment-execution',
      outcome: 'cancelled' as never,
      proposalCreated: false,
      proposalId: undefined,
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    };
    const historicalCancellation = {
      ...raw,
      runId: 'legacy-cancelled-treatment-execution',
      outcome: 'engine-failed' as const,
      proposalCreated: false,
      proposalId: undefined,
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', proposalCreated: false },
    };

    const generated = summarizeDispatchProductionYield([
      ...events,
      explicitCancellation,
      historicalCancellation,
    ])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      eligibleEvents: 10,
      attributedEvents: 10,
      replayedEvents: 0,
      gate: 'ready',
      blockers: [],
    });
    expect(generated?.treatmentConversions).toEqual([
      { repairTreatment: 'baseline-reslice', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
      { repairTreatment: 'target-localization', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
    ]);
  });

  it('reports sorted per-arm terminal progress for imbalanced treatment samples', () => {
    const events = treatmentEvents();
    const targetUnits = [...new Set(events
      .filter((event) => event.repairTreatment === 'target-localization')
      .map((event) => event.repairTreatmentUnitId))];
    const summary = summarizeDispatchProductionYield(events.filter((event) =>
      event.repairTreatmentUnitId !== targetUnits.at(-1)
    ))?.generatedRepairAttempts?.treatmentAttribution;

    expect(summary).toMatchObject({
      minimumTerminalUnitsPerArm: 3,
      gate: 'collecting',
      blockers: [],
      arms: [
        { repairTreatment: 'baseline-reslice', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
        { repairTreatment: 'target-localization', attributedUnits: 2, terminalUnits: 2, remaining: 1 },
      ],
    });
  });

  it('keeps an otherwise sufficient sample collecting while an extra unit is in flight', () => {
    const events = treatmentEvents();
    const raw = events.find((event) =>
      event.repairTreatment === 'baseline-reslice' &&
      event.basis !== 'repair-lifecycle-candidate' &&
      event.basis !== 'repair-lifecycle-outcome'
    )!;
    const extraUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: '/tmp/repo',
      parentItemId: 'repo:goal:extra-in-flight',
      parentObjectiveHash: 'f'.repeat(64),
    })!;
    const extra = {
      ...raw,
      itemId: 'ashlr-hub:proposal-repair-nodiff:eeeeeeeeeeee',
      runId: 'run-extra-in-flight',
      repairTreatmentUnitId: extraUnitId,
      repairTreatment: repairTreatmentForUnitId(extraUnitId)!,
    };
    const generated = summarizeDispatchProductionYield([...events, extra])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      gate: 'collecting',
      blockers: ['in-flight'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: extra.repairTreatment,
          attributedUnits: 4,
          terminalUnits: 3,
          remaining: 0,
        }),
      ]),
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds a ready-looking sample when an extra terminal witness has no raw execution', () => {
    const events = treatmentEvents();
    const terminal = events.find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const extraUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: '/tmp/repo',
      parentItemId: 'repo:goal:terminal-only',
      parentObjectiveHash: 'e'.repeat(64),
    })!;
    const terminalOnly = {
      ...terminal,
      itemId: 'ashlr-hub:proposal-repair-nodiff:abababababab',
      runId: 'run-terminal-only',
      trajectoryId: 'trajectory-terminal-only',
      repairTreatmentUnitId: extraUnitId,
      repairTreatment: repairTreatmentForUnitId(extraUnitId)!,
      repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash('trajectory-terminal-only'),
    };
    const generated = summarizeDispatchProductionYield([...events, terminalOnly])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: expect.arrayContaining(['unmatched-terminal']),
      distinctUnits: 7,
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds attribution progress with bounded replay and unattributed blockers', () => {
    const events = treatmentEvents();
    const raw = events.find((event) => event.basis === 'run-proposal-outcome')!;
    const replay = { ...raw, runId: 'replayed-execution' };
    const unattributed = { ...raw, itemId: 'ashlr-hub:proposal-repair-nodiff:dddddddddddd', repairTreatmentUnitId: undefined };
    const summary = summarizeDispatchProductionYield([...events, replay, unattributed])
      ?.generatedRepairAttempts?.treatmentAttribution;

    expect(summary).toMatchObject({
      gate: 'withheld',
      blockers: ['unattributed', 'replayed'],
      unattributedEvents: 1,
      replayedEvents: 1,
    });
    expect(summary?.blockers.every((blocker) =>
      ['in-flight', 'unmatched-terminal', 'unattributed', 'replayed'].includes(blocker)
    )).toBe(true);
  });

  it('exposes treatment progress without raw identities, objectives, paths, or payloads', () => {
    const rawId = 'RAW_TREATMENT_ID_CANARY_M342';
    const rawObjective = 'RAW_TREATMENT_OBJECTIVE_CANARY_M342';
    const rawPath = '/private/treatment/path/canary';
    const rawPayload = 'RAW_TREATMENT_PAYLOAD_CANARY_M342';
    const events = treatmentEvents().map((event) => ({
      ...event,
      rawId,
      objective: rawObjective,
      path: rawPath,
      payload: rawPayload,
    } as DispatchProductionEvent));
    const attribution = summarizeDispatchProductionYield(events)
      ?.generatedRepairAttempts?.treatmentAttribution;
    const serialized = JSON.stringify(attribution);

    expect(attribution).toBeDefined();
    expect(serialized).not.toContain(rawId);
    expect(serialized).not.toContain(rawObjective);
    expect(serialized).not.toContain(rawPath);
    expect(serialized).not.toContain(rawPayload);
    expect(Object.keys(attribution!)).toEqual([
      'eligibleEvents',
      'attributedEvents',
      'unattributedEvents',
      'distinctUnits',
      'replayedEvents',
      'minimumTerminalUnitsPerArm',
      'arms',
      'gate',
      'blockers',
    ]);
  });

  it('appends a terminal lifecycle witness idempotently across acknowledgement retries', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), '{malformed-history}\n', { mode: 0o600 });

    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const rows = readDispatchProductionEvents({ limit: 100 });
    expect(rows.filter((event) =>
      event.basis === 'repair-lifecycle-outcome' &&
      event.repairGenerationId === witness.repairGenerationId &&
      event.repairTreatmentAttemptHash === witness.repairTreatmentAttemptHash)).toHaveLength(1);
  });

  it('marks only learning windows intersecting receipt retention as incomplete', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    expect(recordDispatchProduction(witness).recorded).toBe(1);
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    writeFileSync(join(receiptDir, '.retention.json'), JSON.stringify({
      schemaVersion: 1,
      droppedThrough: '2026-07-07T23:59:59.999Z',
    }) + '\n', { mode: 0o600 });

    expect(readDispatchProductionEventsDetailed({ sinceMs: Date.parse('2026-07-08T00:00:00.000Z') }))
      .toMatchObject({ sourceState: 'healthy', complete: true });
    expect(readDispatchProductionEventsDetailed({ sinceMs: Date.parse('2026-07-07T00:00:00.000Z') }))
      .toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['file-limit'] });
  });

  it('withholds conversions when eligible metadata is stripped', () => {
    const events = treatmentEvents();
    const stripped = sanitizeDispatchProductionEvent({
      ...events[0]!,
      repairTreatmentUnitId: undefined,
    });
    const generated = summarizeDispatchProductionYield([...events, stripped])?.generatedRepairAttempts;

    expect(stripped).toMatchObject({ repairLineageInvalid: true });
    expect(stripped).not.toHaveProperty('repairTreatment');
    expect(generated?.treatmentAttribution).toMatchObject({
      eligibleEvents: 11,
      attributedEvents: 10,
      unattributedEvents: 1,
      distinctUnits: 6,
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds detailed conversions for truncated and degraded sources', () => {
    const now = new Date().toISOString();
    const events = treatmentEvents(now);
    recordDispatchProduction([makeEvent({ ts: now, itemId: 'older-noise' }), ...events]);

    const truncated = readDispatchProductionYieldDetailed({ windowMs: 60_000, limit: 100, maxRows: 6 });
    expect(truncated.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(truncated.sourceQuality.stopReasons).toContain('row-limit');
    expect(truncated.summary?.generatedRepairAttempts?.treatmentAttribution?.distinctUnits).toBeLessThan(6);
    expect(truncated.summary?.generatedRepairAttempts?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: expect.arrayContaining(['source-incomplete']),
    });
    expect(truncated.summary?.generatedRepairAttempts).not.toHaveProperty('treatmentConversions');

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(
      join(dispatchProductionDir(), `${now.slice(0, 10)}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const degraded = readDispatchProductionYieldDetailed({ windowMs: 60_000, limit: 100 });
    expect(degraded.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(degraded.summary?.generatedRepairAttempts?.treatmentAttribution).toMatchObject({
      distinctUnits: 6,
      gate: 'withheld',
      blockers: expect.arrayContaining(['source-incomplete']),
    });
    expect(degraded.summary?.generatedRepairAttempts).not.toHaveProperty('treatmentConversions');
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
    expect(codex).toMatchObject({
      attempts: 2,
      noProposal: 2,
      diagnosticAttempts: 0,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
    });
  });

  it('sorts and truncates buckets by diagnostic yield instead of raw suppressed volume', () => {
    const events = Array.from({ length: 20 }, (_, index) => makeEvent({
      itemId: `cancelled-${index}`,
      backend: 'local-coder',
      outcome: 'cancelled',
      reason: 'dispatch cancelled after daemon ownership changed',
      runEventSummary: {
        status: 'aborted',
        outcome: 'cancelled',
        proposalCreated: false,
      },
    }));
    events.push(
      makeEvent({
        itemId: 'policy-suppressed',
        backend: 'kimi',
        outcome: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      }),
      makeEvent({
        itemId: 'actionable-empty-diff',
        backend: 'codex',
        outcome: 'empty-diff',
        reason: 'engine completed without file changes',
      }),
    );

    const summary = summarizeDispatchProductionYield(events, { limitPerDimension: 1 });

    expect(summary?.byBackend).toHaveLength(1);
    expect(summary?.byBackend[0]).toMatchObject({
      key: 'codex',
      attempts: 1,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 1,
      diagnosticProposalRate: 0,
    });
  });

  it('uses the bucket key as a deterministic diagnostic-yield tie breaker', () => {
    const forward = summarizeDispatchProductionYield([
      makeEvent({ itemId: 'zeta-failure', backend: 'kimi', outcome: 'empty-diff' }),
      makeEvent({ itemId: 'alpha-failure', backend: 'codex', outcome: 'empty-diff' }),
    ]);
    const reverse = summarizeDispatchProductionYield([
      makeEvent({ itemId: 'alpha-failure', backend: 'codex', outcome: 'empty-diff' }),
      makeEvent({ itemId: 'zeta-failure', backend: 'kimi', outcome: 'empty-diff' }),
    ]);

    expect(forward?.byBackend.map((bucket) => bucket.key)).toEqual(['codex', 'kimi']);
    expect(reverse?.byBackend.map((bucket) => bucket.key)).toEqual(['codex', 'kimi']);
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
    const cancelled = makeEvent({
      ...retry,
      runId: 'run-c',
      outcome: 'cancelled',
      proposalCreated: false,
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    });
    const historicalCancelledDuplicate = makeEvent({
      ...cancelled,
      outcome: 'engine-failed',
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', proposalCreated: false },
    });
    const conflict = makeEvent({
      ...retry,
      runId: retry.runId,
      backend: 'nim',
      outcome: 'empty-diff',
      proposalCreated: false,
    });

    const healthy = summarizeDispatchProductionYield([
      retry,
      { ...retry },
      distinct,
      cancelled,
      historicalCancelledDuplicate,
    ]);
    expect(healthy?.generatedRepairBackendTransitions).toEqual({
      sourceState: 'healthy',
      lineageEvents: 5,
      transitionEvents: 5,
      attempts: 2,
      duplicateEvents: 2,
      conflictingAttempts: 0,
      invalidLineageEvents: 0,
      byTransition: [{
        previousBackend: 'local-coder',
        retryBackend: 'kimi',
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        outcomes: expect.objectContaining({ proposalCreated: 1, engineFailed: 1, cancelled: 1 }),
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
