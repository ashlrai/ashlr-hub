import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard, SkillUseEvent } from '../src/core/types.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import { ROUTER_POLICY_VERSION } from '../src/core/learning/causal.js';
import {
  type SkillRetrievalQuery,
} from '../src/core/fleet/skill-retrieval.js';
import {
  observeShadowSkills,
  type ObserveShadowSkillsResult,
} from '../src/core/fleet/skill-shadow-observer.js';

const selectedAt = '2026-07-10T12:00:00.000Z';
const identity = { trajectoryId: 'attempt:equivalence-123', runId: 'run-equivalence-123' };

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-07-10T12:01:00.000Z');
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m359-skill-equivalence-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  const signed = attestSkillCard({
    schemaVersion: 1,
    skillId: 'skill.typescript-verification',
    revision: 1,
    ts: selectedAt,
    name: 'TypeScript verification',
    summary: 'Run focused type checks and tests.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['typescript', 'verification'],
    taskKinds: ['typescript-change'],
    commandKinds: ['typecheck', 'test'],
    verification: {
      passed: true,
      commandKinds: ['typecheck', 'test'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 2,
    },
    proposalId: 'proposal-equivalence-fixture',
    ...overrides,
  });
  if (!signed) throw new Error('failed to attest skill-card fixture');
  return signed;
}

function observeSelection(
  cards: readonly SkillCard[],
  query: SkillRetrievalQuery,
  route: { backend: string; tier: string; model: string },
): ObserveShadowSkillsResult {
  const recorded: SkillUseEvent[] = [];
  const observed = observeShadowSkills(
    { cards, query, identity, selectedAt, route },
    {
      record: (input) => recorded.push(...(Array.isArray(input) ? input : [input])),
    },
  );
  return { selection: observed.selection, events: recorded };
}

describe('observe-only skill-selection equivalence', () => {
  it('projects the exact retrieved identity without changing executable inputs', () => {
    const cards = [
      card({ skillId: 'skill.typescript-tests', tags: ['typescript', 'test'] }),
      card({ skillId: 'skill.typescript-types', tags: ['typescript', 'typecheck'] }),
    ];
    const execution = {
      route: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        reason: 'final executable route',
      },
      goal: 'GOAL_EQUIVALENCE_CANARY',
      prompt: 'PROMPT_EQUIVALENCE_CANARY',
      budgetUsd: 4,
      delegation: 'DELEGATION_EQUIVALENCE_CANARY',
      retries: 2,
      bestOfN: 3,
      mergeAuthority: false,
    } as const;
    const query = {
      title: 'Repair TypeScript tests',
      tags: ['typescript', 'test'],
      route: execution.route,
    };
    const cardsBefore = structuredClone(cards);
    const queryBefore = structuredClone(query);
    const executionBefore = structuredClone(execution);

    const { selection, events } = observeSelection(cards, query, execution.route);

    expect(selection.selectedSkillIds).toEqual([]);
    expect(selection.selected).toEqual([]);
    expect(events).toEqual([]);
    expect(events.map((event) => ({
      skillId: event.skillId,
      revision: event.skillRevision,
      contentHash: event.contentHash,
      rank: event.rank,
      score: event.score,
    }))).toEqual(selection.selected.map((skill) => ({
      skillId: skill.skillId,
      revision: skill.revision,
      contentHash: skill.contentHash,
      rank: skill.rank,
      score: skill.score,
    })));
    expect(events.map((event) => event.routeSnapshot)).toEqual(selection.selected.map((skill) => ({
      backend: execution.route.backend,
      tier: execution.route.tier,
      model: execution.route.model,
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      selectedSkillIds: [skill.skillId],
      skillPolicyVersion: selection.policyVersion,
      skillMode: 'shadow',
    })));

    expect(cards).toEqual(cardsBefore);
    expect(query).toEqual(queryBefore);
    expect(execution).toEqual(executionBefore);
    expect(execution.route).not.toHaveProperty('selectedSkillIds');

    const telemetry = JSON.stringify(events);
    expect(telemetry).not.toContain(execution.goal);
    expect(telemetry).not.toContain(execution.prompt);
    expect(telemetry).not.toContain(execution.delegation);
    expect(telemetry).not.toContain(execution.route.reason);
    expect(telemetry).not.toContain('budgetUsd');
    expect(telemetry).not.toContain('bestOfN');
    expect(telemetry).not.toContain('mergeAuthority');
  });

  it('is retrieval-order and replay equivalent for the same attempt', () => {
    const cards = [
      card({ skillId: 'skill.z', name: 'TypeScript test workflow' }),
      card({ skillId: 'skill.a', name: 'TypeScript verification workflow' }),
      card({ skillId: 'skill.m', name: 'TypeScript lint workflow' }),
    ];
    const query = { title: 'TypeScript verification tests', tags: ['typescript'] };
    const route = { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' };

    const first = observeSelection(cards, query, route);
    const reordered = observeSelection([...cards].reverse(), query, route);
    const replay = observeSelection(cards, query, route);

    expect(reordered).toEqual(first);
    expect(replay).toEqual(first);
    expect(new Set(first.events.map((event) => event.eventId)).size).toBe(first.events.length);
  });

  it('leaves the execution envelope unchanged when no skill matches', () => {
    const cards = [card({ tags: ['documentation'], taskKinds: ['documentation'] })];
    const execution = {
      route: { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' },
      prompt: 'UNCHANGED_NO_MATCH_PROMPT',
      budgetUsd: 2,
      retries: 1,
    } as const;
    const before = structuredClone(execution);

    const observed = observeSelection(cards, { title: 'Rust dependency audit' }, execution.route);

    expect(observed.selection.selected).toEqual([]);
    expect(observed.events).toEqual([]);
    expect(execution).toEqual(before);
  });
});
