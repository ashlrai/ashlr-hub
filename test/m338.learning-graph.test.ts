/**
 * M338 — telemetry/learning graph metadata lane.
 *
 * The learning graph stores causal labels and small summaries only. Raw prompts,
 * diffs, stdout, and stderr belong in their existing operational surfaces, not
 * in the learning summaries used for routing/credit assignment.
 */

import { describe, expect, it } from 'vitest';

import { buildAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { recordDecision, readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { causalMetadata } from '../src/core/learning/causal.js';
import type { Proposal } from '../src/core/types.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-learning-summary',
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: 'Learning summary',
    summary: 'Metadata-only learning summary test',
    diff:
      'diff --git a/src/raw.ts b/src/raw.ts\n' +
      '--- a/src/raw.ts\n' +
      '+++ b/src/raw.ts\n' +
      '@@ -1 +1 @@\n' +
      '-RAW_DIFF_SENTINEL\n' +
      '+new line\n',
    diffHash: 'sha256:metadata-only',
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: '2026-07-08T12:00:00.000Z',
    workItemId: 'repo:test:learning',
    workSource: 'test',
    runId: 'run-learning-summary',
    ...overrides,
  };
}

describe('M338 learning graph metadata summaries', () => {
  it('keeps raw prompts, diffs, and stdout out of learning summary fields', () => {
    const pack = buildAutonomyEvidencePack({
      proposal: proposal(),
      target: 'main',
      trustBasis: 'evidence',
      remotePreferred: false,
      riskClass: 'low',
      authority: { ok: true, detail: 'judge-free evidence authority' },
      provenance: { ok: true, detail: 'valid provenance' },
      verification: {
        passed: true,
        detail: 'stdout RAW_STDOUT_SENTINEL prompt RAW_PROMPT_SENTINEL',
        commandKinds: ['test', 'typecheck'],
        browser: {
          ok: true,
          renderOk: true,
          consoleErrorCount: 0,
          screenshotCaptured: true,
          detail: 'browser stdout RAW_STDOUT_SENTINEL',
        },
      },
      risk: { ok: true, detail: 'low risk' },
      scope: { ok: true, detail: '1 file, 2 changed lines' },
    });

    const learningSummaries = JSON.stringify({
      trajectoryId: pack.trajectoryId,
      routeSnapshot: pack.routeSnapshot,
      runEventSummary: pack.runEventSummary,
      evidenceOutcome: pack.evidenceOutcome,
      learningSource: pack.learningSource,
      labelBasis: pack.labelBasis,
      routerPolicyVersion: pack.routerPolicyVersion,
      learningEpoch: pack.learningEpoch,
    });

    expect(learningSummaries).toContain('run:run-learning-summary');
    expect(learningSummaries).not.toContain('RAW_PROMPT_SENTINEL');
    expect(learningSummaries).not.toContain('RAW_DIFF_SENTINEL');
    expect(learningSummaries).not.toContain('RAW_STDOUT_SENTINEL');
    expect(learningSummaries).not.toContain('diff --git');
  });

  it('normalizes decision rows with trajectory, label basis, and learning epoch', () => {
    let fx: H1Fixture | undefined;
    const prevHome = process.env.ASHLR_HOME;
    try {
      fx = makeFixture();
      process.env.ASHLR_HOME = `${fx.home}/.ashlr`;
      recordDecision({
        ts: '2026-07-08T12:30:00.000Z',
        proposalId: 'prop-decision-learning',
        workItemId: 'repo:test:decision',
        workSource: 'test',
        runId: 'run-decision-learning',
        action: 'judged',
        verdict: 'ship',
        runEventSummary: {
          runId: 'run-decision-learning',
          status: 'done',
          outcome: 'proposal-created',
          proposalCreated: true,
          diffFiles: 1,
          diffLines: 2,
        },
      });

      const row = readDecisions({ proposalId: 'prop-decision-learning' })[0];
      expect(row).toMatchObject({
        trajectoryId: 'run:run-decision-learning',
        learningSource: 'decision-ledger',
        labelBasis: 'judge-verdict',
        routerPolicyVersion: 'fleet-router-v1',
        learningEpoch: '2026-07-08',
      });
      expect(JSON.stringify(row?.runEventSummary)).not.toContain('stdout');
      expect(JSON.stringify(row?.runEventSummary)).not.toContain('diff --git');
    } finally {
      if (fx) fx.cleanup();
      if (prevHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prevHome;
    }
  });

  it('preserves bounded context summaries without raw prompt or output payloads', () => {
    const meta = causalMetadata({
      runId: 'run-context-summary',
      runEventSummary: {
        runId: 'run-context-summary',
        status: 'done',
        contextSummary: {
          prompt: {
            role: 'executor',
            profileId: 'adaptive-v1',
            contextWindowTokens: 200_000,
            estimatedPromptTokens: 40_000,
            promptBudgetRatio: 1.2,
            contextWindowRatio: 0.25,
            layersIncluded: ['base', 'tool', 'memory'],
            toolCount: 7,
            cacheHit: false,
            rawPrompt: 'RAW_PROMPT_SENTINEL',
          } as never,
          retrieval: {
            source: 'local-context',
            requestedLimit: 10,
            candidateCount: 50,
            hitCount: 6,
            injectedHitCount: 4,
            limitHitRate: 0.6,
            candidateHitRate: 0.12,
            methodCounts: { keyword: 4, embedding: 2 },
            topScore: 0.98765,
            injectedChars: 3200,
            rawEntryText: 'RAW_DIFF_SENTINEL',
          } as never,
          compression: {
            source: 'prompt-budget',
            strategy: 'truncate',
            inputChars: 10000,
            outputChars: 6000,
            compressionRatio: 0.6,
            truncated: true,
            droppedLayers: ['output'],
            stdout: 'RAW_STDOUT_SENTINEL',
          } as never,
        },
      },
    });

    expect(meta.runEventSummary?.contextSummary).toMatchObject({
      prompt: {
        role: 'executor',
        profileId: 'adaptive-v1',
        promptBudgetRatio: 1,
        contextWindowRatio: 0.25,
        layersIncluded: ['base', 'tool', 'memory'],
        toolCount: 7,
        cacheHit: false,
      },
      retrieval: {
        source: 'local-context',
        hitCount: 6,
        limitHitRate: 0.6,
        candidateHitRate: 0.12,
        methodCounts: { keyword: 4, embedding: 2 },
        topScore: 0.988,
      },
      compression: {
        source: 'prompt-budget',
        strategy: 'truncate',
        compressionRatio: 0.6,
        truncated: true,
        droppedLayers: ['output'],
      },
    });
    const serialized = JSON.stringify(meta.runEventSummary?.contextSummary);
    expect(serialized).not.toContain('RAW_PROMPT_SENTINEL');
    expect(serialized).not.toContain('RAW_DIFF_SENTINEL');
    expect(serialized).not.toContain('RAW_STDOUT_SENTINEL');
  });
});
