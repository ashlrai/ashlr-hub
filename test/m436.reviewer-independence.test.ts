import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateReviewerIndependence,
  reviewModelFamily,
} from '../src/core/fleet/reviewer-independence.js';
import {
  hashDiff,
  signJudgeAttestation,
  signProvenance,
} from '../src/core/foundry/provenance.js';
import { evaluateVerificationGate } from '../src/core/inbox/merge.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';

const DIFF = [
  'diff --git a/docs/review.md b/docs/review.md',
  '--- a/docs/review.md',
  '+++ b/docs/review.md',
  '@@ -1 +1 @@',
  '-review policy',
  '+independent review policy',
  '',
].join('\n');
const DIFF_HASH = hashDiff(DIFF);
const VERIFY_CFG = {
  foundry: { autoMerge: { maxRisk: 'low' } },
} as unknown as AshlrConfig;

const originalHome = process.env.HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m436-'));
  process.env.HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function proposal(
  id: string,
  engineModel: string | undefined,
  routeModel?: string,
): Proposal {
  const engineTier = engineModel?.includes('qwen') ? 'local' : 'frontier';
  return {
    id,
    repo: '/tmp/m436-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'Reviewer independence policy',
    summary: 'Exercise the independent reviewer merge gate.',
    diff: DIFF,
    diffHash: DIFF_HASH,
    engineModel,
    engineTier,
    provenanceSig: signProvenance(engineModel, engineTier, DIFF_HASH),
    verifyResult: { passed: true },
    status: 'pending',
    createdAt: '2026-07-16T20:00:00.000Z',
    ...(routeModel === undefined
      ? {}
      : { routeSnapshot: { backend: 'codex', tier: 'frontier', model: routeModel } }),
  };
}

function decisions(proposalId: string, reviewerModel: string): DecisionEntry[] {
  return [
    {
      ts: '2026-07-16T20:00:01.000Z',
      proposalId,
      action: 'judged',
      engine: reviewerModel,
      model: reviewerModel,
      verdict: 'ship',
      detail: 'would-merge',
      judgeAttestation: signJudgeAttestation({
        proposalId,
        judgeEngine: reviewerModel,
        verdict: 'ship',
        diffHash: DIFF_HASH,
      }),
    },
    {
      ts: '2026-07-16T20:00:02.000Z',
      proposalId,
      action: 'verified',
      verdict: 'approved',
      detail: 'EDV independent verification passed',
    },
  ];
}

describe('M436 reviewer independence API', () => {
  it.each([
    ['anthropic/claude-opus-4-8', 'claude'],
    ['gpt-5.5', 'openai'],
    ['codex:gpt-5.5', 'openai'],
    ['codex:claude-opus-4-8', 'unknown'],
    ['claude:gpt-5.5', 'unknown'],
    ['openai/claude-opus-4-8', 'unknown'],
    ['anthropic/gpt-5.5', 'unknown'],
    ['local-coder:qwen3-coder', 'local'],
    ['xai:grok-4', 'local'],
    ['anthropic/opus-4-8', 'claude'],
    ['mystery:frontier-1', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('classifies %s as %s', (model, family) => {
    expect(reviewModelFamily(model)).toBe(family);
  });

  it.each([
    ['claude:claude-sonnet-4-5', 'claude-opus-4-8', false, 'claude', 'claude'],
    ['claude:claude-sonnet-4-5', 'gpt-5.5', true, 'claude', 'openai'],
    ['codex:gpt-5.5', 'gpt-5.5', false, 'openai', 'openai'],
    ['codex:gpt-5.5', 'claude-opus-4-8', true, 'openai', 'claude'],
    ['local-coder:qwen3-coder', 'claude-opus-4-8', true, 'local', 'claude'],
    ['mystery:frontier-1', 'claude-opus-4-8', false, 'unknown', 'claude'],
    ['codex:gpt-5.5', 'mystery-reviewer', false, 'openai', 'unknown'],
  ] as const)(
    '%s producer reviewed by %s has independence=%s',
    (producerModel, reviewerModel, independent, producerFamily, reviewerFamily) => {
      expect(evaluateReviewerIndependence(producerModel, reviewerModel)).toMatchObject({
        independent,
        producerFamily,
        reviewerFamily,
      });
    },
  );

  it.each([
    ['claude:claude-sonnet-4-5', 'codex:claude-opus-4-8'],
    ['codex:gpt-5.5', 'claude:gpt-5.5'],
    ['claude:claude-sonnet-4-5', 'openai/claude-opus-4-8'],
    ['codex:gpt-5.5', 'anthropic/gpt-5.5'],
  ] as const)(
    'fails closed when authoritative reviewer prefix conflicts in %s / %s',
    (producerModel, reviewerModel) => {
      expect(evaluateReviewerIndependence(producerModel, reviewerModel)).toMatchObject({
        independent: false,
        reviewerFamily: 'unknown',
      });
    },
  );

  it.each([
    ['codex:claude-opus-4-8', 'gpt-5.5'],
    ['claude:gpt-5.5', 'claude-opus-4-8'],
  ] as const)(
    'fails closed when authoritative producer prefix conflicts in %s',
    (producerModel, reviewerModel) => {
      expect(evaluateReviewerIndependence(producerModel, reviewerModel)).toMatchObject({
        independent: false,
        producerFamily: 'unknown',
      });
    },
  );

  it.each([
    ['codex:gpt-5.5', 'claude-opus-4-8', 'openai', 'claude'],
    ['claude:claude-sonnet-4-5', 'gpt-5.5', 'claude', 'openai'],
    ['local-coder:qwen3-coder', 'claude-opus-4-8', 'local', 'claude'],
  ] as const)(
    'accepts consistent producer composite %s',
    (producerModel, reviewerModel, producerFamily, reviewerFamily) => {
      expect(evaluateReviewerIndependence(producerModel, reviewerModel)).toMatchObject({
        independent: true,
        producerFamily,
        reviewerFamily,
      });
    },
  );

  it('accepts a proposal-shaped producer input and reads only engineModel', () => {
    const producer = {
      engineModel: 'claude:claude-sonnet-4-5',
      routeSnapshot: { model: 'gpt-5.5' },
    };
    expect(evaluateReviewerIndependence(producer, 'claude-opus-4-8')).toMatchObject({
      independent: false,
      producerFamily: 'claude',
      reviewerFamily: 'claude',
    });
  });
});

describe('M436 evaluateVerificationGate integration', () => {
  it.each([
    ['claude/claude refuses', 'claude:claude-sonnet-4-5', 'claude-opus-4-8', false],
    ['claude/openai authorizes', 'claude:claude-sonnet-4-5', 'gpt-5.5', true],
    ['openai/openai refuses', 'codex:gpt-5.5', 'gpt-5.5', false],
    ['openai/claude authorizes', 'codex:gpt-5.5', 'claude-opus-4-8', true],
    ['local/claude authorizes', 'local-coder:qwen3-coder', 'claude-opus-4-8', true],
    ['unknown producer fails closed', 'mystery:frontier-1', 'claude-opus-4-8', false],
  ] as const)('%s', (name, producerModel, reviewerModel, authorized) => {
    const proposalId = `m436-${name.replaceAll(/[^a-z]+/g, '-')}`;
    const candidate = proposal(proposalId, producerModel);
    const verdict = evaluateVerificationGate(
      candidate,
      VERIFY_CFG,
      decisions(proposalId, reviewerModel),
    );

    expect(verdict.authorized).toBe(authorized);
    if (!authorized) expect(verdict.reason).toMatch(/independence denied|family is unknown/i);
  });

  it('does not let routeSnapshot override the signed producer engineModel', () => {
    const proposalId = 'm436-route-snapshot-non-authority';
    const candidate = proposal(
      proposalId,
      'claude:claude-sonnet-4-5',
      'gpt-5.5',
    );
    const verdict = evaluateVerificationGate(
      candidate,
      VERIFY_CFG,
      decisions(proposalId, 'claude-opus-4-8'),
    );

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/both claude family/i);
  });

  it.each([
    ['codex:claude-opus-4-8', 'gpt-5.5'],
    ['claude:gpt-5.5', 'claude-opus-4-8'],
  ] as const)(
    'rejects conflicting signed producer composite %s at the merge gate',
    (producerModel, reviewerModel) => {
      const proposalId = `m436-conflicting-${producerModel.replaceAll(/[^a-z0-9]+/gi, '-')}`;
      const verdict = evaluateVerificationGate(
        proposal(proposalId, producerModel),
        VERIFY_CFG,
        decisions(proposalId, reviewerModel),
      );

      expect(verdict.authorized).toBe(false);
      expect(verdict.reason).toMatch(/signed producer family is unknown/i);
    },
  );
});
