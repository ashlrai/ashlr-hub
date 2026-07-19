/**
 * m357.skill-shadow-observer.test.ts - released-credit latch for observation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard, SkillUseEvent } from '../src/core/types.js';
import { skillCardContentHash } from '../src/core/fleet/skill-attestation.js';
import { signSkillCardAttestation } from '../src/core/foundry/provenance.js';
import {
  SKILL_RETRIEVAL_POLICY_VERSION,
  selectVerifiedSkills,
  type ShadowSkillSelection,
} from '../src/core/fleet/skill-retrieval.js';
import { observeShadowSkills } from '../src/core/fleet/skill-shadow-observer.js';

const CREDIT_RELEASE_LABEL = 'post-merge-credit-release-v1' as const;
const CREDIT_RELEASE_TAG = 'credit:released-v1' as const;
const selectedAt = '2026-07-10T12:00:00.000Z';
const query = { title: 'Verify TypeScript changes', tags: ['typescript', 'verification'] };
const route = { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' };
const identity = { trajectoryId: 'attempt:credit-latch-357', runId: 'run-credit-latch-357' };

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-07-10T12:01:00.000Z');
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m357-skill-shadow-observer-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  const unsigned: SkillCard = {
    schemaVersion: 1,
    skillId: 'skill.released-credit',
    revision: 1,
    ts: selectedAt,
    name: 'Verify TypeScript changes',
    summary: 'Run focused typecheck and test commands.',
    status: 'verified',
    source: 'verified-proposal',
    tags: [CREDIT_RELEASE_TAG, 'typescript', 'verification'],
    taskKinds: ['typescript-change'],
    commandKinds: ['typecheck', 'test'],
    verification: {
      passed: true,
      commandKinds: ['typecheck', 'test'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 2,
    },
    proposalId: 'proposal-credit-latch-357',
    labelBasis: CREDIT_RELEASE_LABEL,
    ...overrides,
  };
  const diffHash = unsigned.verification?.diffHash;
  if (!unsigned.proposalId || !diffHash) throw new Error('invalid persisted skill fixture');
  const contentHash = skillCardContentHash(unsigned);
  const attestation = signSkillCardAttestation({
    contentHash,
    skillId: unsigned.skillId,
    revision: unsigned.revision,
    proposalId: unsigned.proposalId,
    diffHash,
  });
  if (!attestation) throw new Error('failed to sign persisted skill fixture');
  return { ...unsigned, contentHash, attestation };
}

function observe(cards: readonly SkillCard[], record = vi.fn()) {
  return {
    record,
    result: observeShadowSkills(
      { cards, query, identity, selectedAt, route },
      { record },
    ),
  };
}

describe('M357 released-credit shadow observation', () => {
  it('does not observe a generic-signed card carrying released-credit markers', () => {
    const { record, result } = observe([card()]);

    expect(result.selection.selectedSkillIds).toEqual([]);
    expect(result.selection.selected).toEqual([]);
    expect(result.events).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy label', { labelBasis: 'evidence-policy' }],
    ['missing label', { labelBasis: undefined }],
    ['realized-only label', { labelBasis: 'realized-merge-v1' }],
    ['missing release tag', { tags: ['typescript', 'verification'] }],
  ] as const)('does not select or observe %s metadata', (_label, overrides) => {
    const { record, result } = observe([card(overrides)]);

    expect(result.selection).toMatchObject({ eligibleCount: 0, selectedSkillIds: [], selected: [] });
    expect(result.events).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['missing label', { labelBasis: undefined }],
    ['legacy label', { labelBasis: 'evidence-policy' }],
    ['realized-only label', { labelBasis: 'realized-merge-v1' }],
    ['false release flag', { creditReleased: false }],
  ] as const)('rejects forged selector output with %s', (_label, mutation) => {
    const valid = selectVerifiedSkills([card()], query);
    const forged: ShadowSkillSelection = {
      ...valid,
      selected: [{ ...valid.selected[0]!, ...mutation } as never],
    };
    const record = vi.fn<(events: SkillUseEvent | SkillUseEvent[]) => void>();
    const result = observeShadowSkills(
      { cards: [card()], query, identity, selectedAt, route },
      { select: vi.fn(() => forged), record },
    );

    expect(result.selection).toMatchObject({
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
      selectedSkillIds: [],
      selected: [],
    });
    expect(result.events).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('fails closed for mismatched selected identities before building or recording events', () => {
    const valid = selectVerifiedSkills([card()], query);
    const forged = {
      ...valid,
      selectedSkillIds: ['skill.different'],
    } as ShadowSkillSelection;
    const buildEvent = vi.fn();
    const record = vi.fn();

    const result = observeShadowSkills(
      { cards: [card()], query, identity, selectedAt, route },
      { select: vi.fn(() => forged), buildEvent, record },
    );

    expect(result.events).toEqual([]);
    expect(buildEvent).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a dependency-injected nonempty released selection before recording', () => {
    const forged: ShadowSkillSelection = {
      mode: 'shadow',
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
      consideredCount: 1,
      eligibleCount: 1,
      selectedSkillIds: ['skill.forged-release'],
      selected: [{
        skillId: 'skill.forged-release',
        revision: 1,
        contentHash: 'a'.repeat(64),
        rank: 1,
        score: 1,
        name: 'Forged released skill',
        summary: 'Must not become a use event.',
        matchedFields: ['tags'],
        status: 'verified',
        source: 'verified-proposal',
        labelBasis: CREDIT_RELEASE_LABEL,
        creditReleased: true,
      }],
    };
    const buildEvent = vi.fn();
    const record = vi.fn();

    const result = observeShadowSkills(
      { cards: [], query, identity, selectedAt, route },
      { select: vi.fn(() => forged), buildEvent, record },
    );

    expect(result.selection.selected).toEqual([]);
    expect(result.events).toEqual([]);
    expect(buildEvent).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
