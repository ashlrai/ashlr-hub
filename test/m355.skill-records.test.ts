/**
 * m355.skill-records.test.ts - verified skill card/use metadata ledgers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard, SkillUseEvent } from '../src/core/types.js';
import {
  readSkillCards,
  readSkillUseEvents,
  recordSkillCard,
  recordSkillUseEvent,
  skillCardsDir,
  skillRecordsDir,
  skillUseEventsDir,
} from '../src/core/fleet/skill-records.js';

let previousAshlrHome: string | undefined;
let home: string;

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    schemaVersion: 1,
    skillId: 'skill.verify-focused-tests',
    revision: 1,
    ts: '2026-07-10T12:00:00.000Z',
    name: 'Verify focused tests',
    summary: 'Run the focused contract before broader verification.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['verification', 'tests'],
    taskKinds: ['typescript-change'],
    commandKinds: ['test', 'typecheck'],
    verification: {
      passed: true,
      verifiedAt: '2026-07-10T11:59:00.000Z',
      commandKinds: ['test', 'typecheck'],
      diffHash: 'sha256:fixture-diff',
      riskClass: 'low',
      evidenceCount: 2,
    },
    proposalId: 'proposal-1',
    runId: 'run-1',
    trajectoryId: 'trajectory-1',
    routeSnapshot: {
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      reason: 'verification-heavy change',
      selectedSkillIds: ['skill.verify-focused-tests'],
      skillPolicyVersion: 'skill-policy-v1',
      skillMode: 'shadow',
    },
    runEventSummary: {
      runId: 'run-1',
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'proposal-1',
      diffFiles: 2,
      diffLines: 30,
    },
    evidenceOutcome: {
      target: 'proposal',
      trustBasis: 'verification',
      riskClass: 'low',
      verificationPassed: true,
      policyAllowed: true,
      gateCount: 5,
    },
    learningSource: 'skill-card',
    labelBasis: 'evidence-policy',
    routerPolicyVersion: 'fleet-router-v1',
    learningEpoch: '2026-07-10',
    ...overrides,
  };
}

function useEvent(overrides: Partial<SkillUseEvent> = {}): SkillUseEvent {
  return {
    schemaVersion: 1,
    eventId: 'skill-use-1',
    ts: '2026-07-10T12:01:00.000Z',
    skillId: 'skill.verify-focused-tests',
    skillRevision: 1,
    mode: 'shadow',
    stage: 'selected',
    outcome: 'unknown',
    rank: 0,
    score: 0.8754,
    reason: 'Matched verification task metadata.',
    proposalId: 'proposal-1',
    runId: 'run-1',
    trajectoryId: 'trajectory-1',
    routeSnapshot: {
      backend: 'codex',
      selectedSkillIds: ['skill.verify-focused-tests'],
      skillPolicyVersion: 'skill-policy-v1',
      skillMode: 'shadow',
    },
    learningSource: 'skill-use',
    labelBasis: 'evidence-policy',
    routerPolicyVersion: 'fleet-router-v1',
    learningEpoch: '2026-07-10',
    ...overrides,
  };
}

beforeEach(() => {
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m355-skill-records-'));
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M355 skill records', () => {
  it('appends cards and use events to separate streams and reads newest first', () => {
    recordSkillCard([
      card({ skillId: 'skill-old', ts: '2026-07-09T23:59:00.000Z' }),
      card({ skillId: 'skill-new', ts: '2026-07-10T00:01:00.000Z', revision: 2 }),
    ]);
    recordSkillUseEvent([
      useEvent({ eventId: 'use-old', ts: '2026-07-09T23:59:30.000Z' }),
      useEvent({ eventId: 'use-new', ts: '2026-07-10T00:01:30.000Z', stage: 'outcome', outcome: 'merged' }),
    ]);

    expect(skillRecordsDir()).toBe(join(home, 'skills'));
    expect(readSkillCards().map((entry) => entry.skillId)).toEqual(['skill-new', 'skill-old']);
    expect(readSkillUseEvents().map((entry) => entry.eventId)).toEqual(['use-new', 'use-old']);
    expect(readSkillCards()[0]).toMatchObject({ revision: 2, status: 'verified' });
    expect(readSkillUseEvents()[0]).toMatchObject({ stage: 'outcome', outcome: 'merged' });
  });

  it('preserves only bounded, sanitized skill route metadata', () => {
    const manyIds = Array.from({ length: 20 }, (_, index) => `skill-${index}`);
    recordSkillCard(card({
      verification: {
        passed: true,
        verifiedAt: 'not-a-timestamp',
      },
      routeSnapshot: {
        backend: 'codex',
        reason: 'metadata route',
        selectedSkillIds: [...manyIds, 'token=ghp_1234567890abcdefABCDEF'],
        skillPolicyVersion: 'skill-policy-v1 token=ghp_1234567890abcdefABCDEF',
        skillMode: 'active',
        rawPrompt: 'RAW_PROMPT_ROUTE_CANARY',
        argv: ['ashlr', 'run', 'RAW_ARGV_ROUTE_CANARY'],
      } as never,
    }));

    const persistedCard = readSkillCards({ limit: 1 })[0]!;
    const route = persistedCard.routeSnapshot!;
    expect(route.selectedSkillIds).toHaveLength(8);
    expect(route.skillPolicyVersion).toBe('skill-policy-v1 token=[REDACTED]');
    expect(route.skillMode).toBe('active');
    expect(persistedCard.verification?.verifiedAt).toBeUndefined();
    expect(route).not.toHaveProperty('rawPrompt');
    expect(route).not.toHaveProperty('argv');
    expect(JSON.stringify(route)).not.toContain('ghp_1234567890abcdefABCDEF');
  });

  it('skips malformed rows without hiding later valid history', () => {
    mkdirSync(skillCardsDir(), { recursive: true });
    writeFileSync(
      join(skillCardsDir(), '2026-07-10.jsonl'),
      [
        'not-json',
        JSON.stringify({ schemaVersion: 1, skillId: 'missing-required-fields' }),
        JSON.stringify(card({ skillId: 'invalid-timestamp-row', ts: 'not-a-timestamp' })),
        JSON.stringify(card({ skillId: 'valid-manual-row' })),
        '{"schemaVersion":1,"skillId":',
      ].join('\n') + '\n',
      'utf8',
    );

    const hostile = new Proxy(card({ skillId: 'hostile-row' }), {
      get() {
        throw new Error('hostile getter');
      },
    });
    recordSkillCard([
      hostile,
      card({ skillId: '', name: '' }),
      card({ skillId: 'invalid-timestamp-write', ts: 'not-a-timestamp' }),
      card({ skillId: 'batch-survivor' }),
    ]);

    expect(readSkillCards().map((entry) => entry.skillId)).toEqual(['batch-survivor', 'valid-manual-row']);
  });

  it('bounds row, date, file, list, and numeric metadata', () => {
    recordSkillUseEvent([
      useEvent({ eventId: 'old-file', ts: '2026-07-08T00:00:00.000Z' }),
      useEvent({ eventId: 'middle', ts: '2026-07-09T00:00:00.000Z' }),
      useEvent({
        eventId: 'new-a',
        ts: '2026-07-10T00:00:00.000Z',
        rank: -4,
        score: 7,
      }),
      useEvent({ eventId: 'new-b', ts: '2026-07-10T00:01:00.000Z' }),
    ]);

    expect(readSkillUseEvents({ limit: 2 }).map((entry) => entry.eventId)).toEqual(['new-b', 'new-a']);
    expect(readSkillUseEvents({ maxFiles: 1 }).map((entry) => entry.eventId)).toEqual(['new-b', 'new-a']);
    expect(readSkillUseEvents({ sinceMs: Date.parse('2026-07-09T12:00:00.000Z') }).map((entry) => entry.eventId))
      .toEqual(['new-b', 'new-a']);
    expect(readSkillUseEvents({ limit: 2 })[1]).toMatchObject({ rank: 0, score: 1 });
  });

  it('scrubs every allowed string before write and again on read', () => {
    const secret = 'ghp_1234567890abcdefABCDEF';
    recordSkillCard(card({
      skillId: `skill-token=${secret}`,
      name: `Name token=${secret}`,
      summary: 'stdout contained RAW_STDOUT_SUMMARY_CANARY',
      tags: [`token=${secret}`],
      commandKinds: [`test token=${secret}`],
      routeSnapshot: {
        reason: 'command output: RAW_COMMAND_OUTPUT_ROUTE_CANARY',
        selectedSkillIds: [`skill-token=${secret}`],
        skillPolicyVersion: `policy token=${secret}`,
        skillMode: 'shadow',
      },
      runEventSummary: {
        status: 'stderr included RAW_STDERR_RUN_CANARY',
        outcome: `token=${secret}`,
      },
    }));

    const file = join(skillCardsDir(), '2026-07-10.jsonl');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/RAW_(?:STDOUT|STDERR|COMMAND_OUTPUT)/);
    expect(raw).toContain('[REDACTED]');

    const hostileSecret = 'sk-hostilelegacysecret123456789';
    const hostile = card({ name: `legacy ${hostileSecret}` });
    appendFileSync(file, JSON.stringify(hostile) + '\n', 'utf8');
    const serialized = JSON.stringify(readSkillCards());
    expect(serialized).not.toContain(hostileSecret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('never persists forbidden raw payload fields or their contents', () => {
    const canaries = {
      rawPrompt: 'RAW_PROMPT_FIELD_CANARY',
      rawDiff: 'RAW_DIFF_FIELD_CANARY',
      stdout: 'RAW_STDOUT_FIELD_CANARY',
      stderr: 'RAW_STDERR_FIELD_CANARY',
      env: 'RAW_ENV_FIELD_CANARY',
      fileContents: 'RAW_FILE_CONTENTS_FIELD_CANARY',
      argv: 'RAW_ARGV_FIELD_CANARY',
      commandOutput: 'RAW_COMMAND_OUTPUT_FIELD_CANARY',
    };
    recordSkillCard({
      ...card(),
      ...canaries,
      verification: {
        passed: true,
        commandKinds: ['test'],
        rawPrompt: canaries.rawPrompt,
        stdout: canaries.stdout,
        commandOutput: canaries.commandOutput,
      },
    } as never);
    recordSkillUseEvent({
      ...useEvent(),
      ...canaries,
      routeSnapshot: {
        selectedSkillIds: ['skill.verify-focused-tests'],
        skillMode: 'shadow',
        env: { TOKEN: canaries.env },
        fileContents: canaries.fileContents,
      },
    } as never);

    const cardRaw = readFileSync(join(skillCardsDir(), '2026-07-10.jsonl'), 'utf8');
    const useRaw = readFileSync(join(skillUseEventsDir(), '2026-07-10.jsonl'), 'utf8');
    const persisted = `${cardRaw}\n${useRaw}`;
    for (const [field, value] of Object.entries(canaries)) {
      expect(persisted).not.toContain(`"${field}"`);
      expect(persisted).not.toContain(value);
    }
    expect(JSON.parse(cardRaw)).toMatchObject({
      verification: { passed: true, commandKinds: ['test'] },
    });
    expect(JSON.parse(useRaw)).toMatchObject({
      routeSnapshot: { selectedSkillIds: ['skill.verify-focused-tests'], skillMode: 'shadow' },
    });
  });
});
