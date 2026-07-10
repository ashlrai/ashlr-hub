/**
 * m356.skill-retrieval.test.ts - bounded shadow-only verified skill selection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard } from '../src/core/types.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import {
  MAX_SELECTED_SKILLS,
  SKILL_RETRIEVAL_POLICY_VERSION,
  selectVerifiedSkills,
} from '../src/core/fleet/skill-retrieval.js';

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m356-skill-retrieval-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  const unsigned: SkillCard = {
    schemaVersion: 1,
    skillId: 'skill.verify-typescript',
    revision: 1,
    ts: '2026-07-10T12:00:00.000Z',
    name: 'Verify TypeScript changes',
    summary: 'Run focused typecheck and tests before broader verification.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['typescript', 'verification'],
    taskKinds: ['typescript-change'],
    commandKinds: ['typecheck', 'test'],
    verification: {
      passed: true,
      commandKinds: ['typecheck', 'test'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 3,
    },
    proposalId: 'proposal-fixture',
    ...overrides,
  };
  return attestSkillCard(unsigned)!;
}

describe('M356 verified skill retrieval', () => {
  it('selects at most two relevant verified-proposal cards in shadow mode', () => {
    const result = selectVerifiedSkills([
      card({ skillId: 'skill.z', name: 'TypeScript test workflow' }),
      card({ skillId: 'skill.a', name: 'TypeScript verification workflow' }),
      card({ skillId: 'skill.m', name: 'TypeScript lint workflow' }),
      card({ skillId: 'skill.manual', source: 'manual' }),
      card({ skillId: 'skill.imported', source: 'imported' }),
      card({ skillId: 'skill.candidate', status: 'candidate' }),
      card({ skillId: 'skill.unpassed', verification: { passed: false } }),
    ], {
      title: 'Repair TypeScript verification tests',
      tags: ['typescript', 'test'],
      route: { backend: 'codex', tier: 'frontier' },
    });

    expect(result).toMatchObject({
      mode: 'shadow',
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
      eligibleCount: 3,
    });
    expect(result.selected).toHaveLength(MAX_SELECTED_SKILLS);
    expect(result.selected[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.selectedSkillIds).toEqual(['skill.z', 'skill.a']);
    expect(result.selected.every((entry) => (
      entry.status === 'verified' && entry.source === 'verified-proposal'
    ))).toBe(true);
  });

  it('uses bounded metadata relevance instead of input order', () => {
    const cards = [
      card({
        skillId: 'skill.docs',
        name: 'Documentation workflow',
        summary: 'Update markdown documentation.',
        tags: ['docs'],
        taskKinds: ['documentation'],
      }),
      card({
        skillId: 'skill.security',
        name: 'Dependency security repair',
        summary: 'Audit vulnerable dependencies and run security tests.',
        tags: ['security', 'dependencies'],
        taskKinds: ['dependency-repair'],
      }),
    ];
    const query = { title: 'Repair a security dependency', tags: ['security'] };

    expect(selectVerifiedSkills(cards, query).selectedSkillIds).toEqual(['skill.security']);
    expect(selectVerifiedSkills([...cards].reverse(), query)).toEqual(selectVerifiedSkills(cards, query));
  });

  it('orders equal scores deterministically across permutations', () => {
    const cards = ['skill.c', 'skill.a', 'skill.b'].map((skillId) => card({
      skillId,
      name: 'Focused verification',
      summary: 'Run tests.',
      tags: ['verification'],
      taskKinds: ['typescript-change'],
    }));
    const query = { title: 'TypeScript verification' };
    const expected = selectVerifiedSkills(cards, query);

    expect(expected.selectedSkillIds).toEqual(['skill.a', 'skill.b']);
    expect(selectVerifiedSkills([cards[2]!, cards[0]!, cards[1]!], query)).toEqual(expected);
    expect(selectVerifiedSkills([cards[1]!, cards[2]!, cards[0]!], query)).toEqual(expected);
  });

  it('uses only the latest revision and fails closed on conflicting duplicate revisions', () => {
    const result = selectVerifiedSkills([
      card({ skillId: 'skill.latest', revision: 1, name: 'Old docs workflow', tags: ['docs'] }),
      card({ skillId: 'skill.latest', revision: 2, name: 'Current security workflow', tags: ['security'] }),
      card({ skillId: 'skill.revoked', revision: 1, tags: ['security'] }),
      card({ skillId: 'skill.revoked', revision: 2, status: 'revoked', tags: ['security'] }),
      card({ skillId: 'skill.deprecated', revision: 1, tags: ['security'] }),
      card({ skillId: 'skill.deprecated', revision: 2, status: 'deprecated', tags: ['security'] }),
      card({ skillId: 'skill.conflict', revision: 4, tags: ['security'] }),
      card({ skillId: 'skill.conflict', revision: 4, name: 'Conflicting immutable row', tags: ['security'] }),
      card({ skillId: 'skill.exact', revision: 3, tags: ['security'] }),
      card({ skillId: 'skill.exact', revision: 3, tags: ['security'] }),
    ], { title: 'Security workflow', tags: ['security'] });

    expect(result.selectedSkillIds).toEqual(['skill.latest', 'skill.exact']);
    expect(result.selected.find((entry) => entry.skillId === 'skill.latest')?.revision).toBe(2);
    expect(result.selectedSkillIds).not.toContain('skill.revoked');
    expect(result.selectedSkillIds).not.toContain('skill.deprecated');
    expect(result.selectedSkillIds).not.toContain('skill.conflict');
  });

  it('requires complete verification provenance and rejects skill chains', () => {
    const missingAttestation = { ...card({ skillId: 'skill.unsigned' }), attestation: undefined };
    const tampered = { ...card({ skillId: 'skill.tampered' }), summary: 'Changed after signing.' };
    const result = selectVerifiedSkills([
      card({ skillId: 'skill.eligible' }),
      missingAttestation,
      tampered,
      card({ skillId: 'skill.no-commands', commandKinds: [] }),
      card({
        skillId: 'skill.no-verification-commands',
        verification: { passed: true, commandKinds: [], diffHash: 'sha256:x', evidenceCount: 1 },
      }),
      card({
        skillId: 'skill.no-diff-hash',
        verification: { passed: true, commandKinds: ['test'], evidenceCount: 1 },
      }),
      card({
        skillId: 'skill.no-evidence',
        verification: { passed: true, commandKinds: ['test'], diffHash: 'sha256:x', evidenceCount: 0 },
      }),
      card({ skillId: 'skill.no-proposal', proposalId: undefined }),
      card({
        skillId: 'skill.chain',
        routeSnapshot: { selectedSkillIds: [], skillMode: 'shadow' },
      }),
    ], { title: 'Verify TypeScript changes', tags: ['verification'] });

    expect(result.eligibleCount).toBe(1);
    expect(result.selectedSkillIds).toEqual(['skill.eligible']);
  });

  it('skips malformed, empty, and hostile records without throwing', () => {
    const hostile = new Proxy(card(), {
      get() {
        throw new Error('hostile getter');
      },
    });
    const malformed: unknown[] = [
      null,
      {},
      card({ skillId: '' }),
      card({ name: '' }),
      card({ revision: 0 }),
      card({ revision: Number.NaN }),
      card({ ts: 'not-a-timestamp' }),
      { ...card(), tags: 'security' },
      hostile,
    ];

    expect(selectVerifiedSkills(malformed, { title: 'verification' }).selected).toEqual([]);
    expect(selectVerifiedSkills([], { title: 'verification' }).selected).toEqual([]);
    expect(selectVerifiedSkills([card()], {})).toMatchObject({ selected: [], eligibleCount: 0 });
    expect(selectVerifiedSkills(null, { title: 'verification' }).selected).toEqual([]);
  });

  it('never returns forbidden payload fields or poison embedded in metadata', () => {
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
    const selectedWithUnknownFields = { ...card({ skillId: 'skill.clean' }), ...canaries } as never;
    const poisonedSummary = card({
      skillId: 'skill.poisoned',
      name: 'Security verification',
      summary: 'security security diff --git a/private.ts b/private.ts\n+secret contents',
      tags: ['security'],
    });
    const secret = 'ghp_1234567890abcdefABCDEF';
    const secretMetadata = card({
      skillId: 'skill.secret',
      name: `Security token=${secret}`,
      tags: ['security'],
    });

    const result = selectVerifiedSkills(
      [selectedWithUnknownFields, poisonedSummary, secretMetadata],
      {
        title: 'Security verification RAW_PROMPT_QUERY_CANARY',
        detail: 'stdout contained RAW_STDOUT_QUERY_CANARY',
        tags: ['security'],
      },
    );
    const serialized = JSON.stringify(result);

    expect(result.selectedSkillIds).toEqual([]);
    for (const [field, canary] of Object.entries(canaries)) {
      expect(serialized).not.toContain(`"${field}"`);
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain('RAW_PROMPT_QUERY_CANARY');
    expect(serialized).not.toContain('RAW_STDOUT_QUERY_CANARY');
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('secret contents');
    expect(serialized).not.toContain(secret);
  });

  it('bounds hostile metadata and output summaries', () => {
    const manyTags = Array.from({ length: 1_000 }, (_, index) => `typescript-tag-${index}`);
    const huge = 'typescript '.repeat(10_000);
    const result = selectVerifiedSkills([
      card({
        skillId: 'skill.huge',
        name: huge,
        summary: huge,
        tags: manyTags,
        taskKinds: manyTags,
        commandKinds: manyTags,
      }),
      ...Array.from({ length: 20 }, (_, index) => card({ skillId: `skill.${index}` })),
    ], {
      title: huge,
      detail: huge,
      tags: manyTags,
    });

    expect(result.selected.length).toBeLessThanOrEqual(2);
    expect(result.selected[0]?.name.length).toBeLessThanOrEqual(120);
    expect(result.selected[0]?.summary.length).toBeLessThanOrEqual(320);
    expect(result.selected[0]?.matchedFields.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });
});
