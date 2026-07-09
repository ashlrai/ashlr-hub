import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAttentionEvalReport, type AttentionEvalReport } from '../src/core/eval/attention.js';
import {
  loadAttentionReports,
  saveAttentionReport,
} from '../src/core/eval/attention-store.js';
import { cmdEvalAttention } from '../src/cli/eval-attention.js';
import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';

const FIXTURE = resolve('test/fixtures/attention/input.json');

function fixtureEvents(): unknown[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown[];
}

describe('M346 eval attention', () => {
  it('builds a metadata-only attention report from agent action events', () => {
    const report = buildAttentionEvalReport(fixtureEvents(), {
      window: '1d',
      generatedAt: '2026-07-09T05:01:00.000Z',
      limit: 100,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      eventCount: 3,
      repoAttention: {
        repoEventCount: 3,
        activeRepos: 2,
        topRepoShare: 0.667,
        verdict: 'balanced',
      },
      productionYield: {
        attempts: 2,
        proposalCreated: 1,
        noProposal: 1,
        policySuppressed: 0,
        diagnosticAttempts: 2,
        diagnosticNoProposal: 1,
        proposalRate: 0.5,
        diagnosticProposalRate: 0.5,
        diagnosticNoProposalRate: 0.5,
        attemptShape: {
          backendNoDiff: 1,
          captureOrGateBlocked: 0,
          repairAttempts: 0,
          policyDisabled: 0,
        },
      },
      contextPressure: {
        samples: 2,
        droppedLayerCount: 3,
        truncationRate: 0.5,
        cacheHitRate: 0.5,
      },
      retrievalQuality: {
        samples: 2,
        hitCount: 8,
        injectedHitCount: 5,
        injectedChars: 4000,
      },
      evidence: {
        samples: 2,
        verificationPassed: 2,
        policyAllowed: 2,
        gateCount: 3,
      },
      trajectory: {
        withTrajectoryId: 3,
        distinctTrajectories: 2,
      },
    });
    expect(report.contextPressure.promptBudgetRatio.avg).toBe(0.85);
    expect(report.retrievalQuality.limitHitRate.avg).toBe(0.4);
    expect(report.routingCost.spendUsd).toBe(0.012345);
    expect(report.routingCost.totalTokens).toBe(1790);
    expect(report.repoAttention.topRepos[0]).toMatchObject({
      repoLabel: 'ashlr-hub',
      count: 2,
      share: 0.667,
    });
    expect(report.repoAttention.topRepos[0]?.repoKey).toMatch(/^[a-f0-9]{12}$/);
  });

  it('counts policy-disabled production attempts separately from diagnostic no-proposal attempts', () => {
    const events: AgentActionEvent[] = [
      {
        schemaVersion: 1,
        ts: '2026-07-09T05:00:00.000Z',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'proposal-created',
        action: 'dispatch',
        summary: 'proposal filed',
        repo: '/tmp/repo-a',
        runEventSummary: {
          outcome: 'proposal-created',
          proposalCreated: true,
          actionCounts: { proposalCreated: 1 },
        },
      },
      {
        schemaVersion: 1,
        ts: '2026-07-09T05:00:01.000Z',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'dispatch',
        summary: 'policy-disabled control flow',
        repo: '/tmp/repo-a',
        runEventSummary: {
          outcome: 'proposal-disabled',
          proposalCreated: false,
          actionCounts: { proposalDisabled: 1 },
        },
      },
      {
        schemaVersion: 1,
        ts: '2026-07-09T05:00:02.000Z',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'dispatch',
        summary: 'policy-disabled action count',
        repo: '/tmp/repo-a',
        runEventSummary: {
          outcome: 'no-proposal',
          proposalCreated: false,
          actionCounts: { proposalDisabled: 1 },
        },
      },
      {
        schemaVersion: 1,
        ts: '2026-07-09T05:00:03.000Z',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'dispatch',
        summary: 'empty diff',
        repo: '/tmp/repo-a',
        runEventSummary: {
          outcome: 'empty-diff',
          proposalCreated: false,
          actionCounts: { diffFiles: 0 },
        },
      },
    ];

    const report = buildAttentionEvalReport(events, {
      window: '1d',
      generatedAt: '2026-07-09T05:01:00.000Z',
    });

    expect(report.productionYield).toMatchObject({
      attempts: 4,
      proposalCreated: 1,
      noProposal: 3,
      policySuppressed: 2,
      diagnosticAttempts: 2,
      diagnosticNoProposal: 1,
      proposalRate: 0.25,
      noProposalRate: 0.75,
      diagnosticProposalRate: 0.5,
      diagnosticNoProposalRate: 0.5,
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 2,
      },
    });
  });

  it('does not persist raw prompt, diff, stdout, stderr, summary, reason, detail, or full paths', () => {
    const report = buildAttentionEvalReport(fixtureEvents(), {
      generatedAt: '2026-07-09T05:01:00.000Z',
    });
    const serialized = JSON.stringify(report);

    for (const sentinel of [
      'RAW_GOAL_SENTINEL',
      'RAW_PROMPT_SENTINEL',
      'RAW_CONTENT_SENTINEL',
      'RAW_MESSAGE_SENTINEL',
      'RAW_DIFF_SENTINEL',
      'RAW_STDOUT_SENTINEL',
      'RAW_STDERR_SENTINEL',
      'RAW_SUMMARY_SENTINEL',
      'RAW_REASON_SENTINEL',
      'RAW_DETAIL_SENTINEL',
      'RAW_ROUTE_REASON_SENTINEL',
      'diff --git',
      '/Users/masonwyatt',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    for (const rawKey of [
      '"goal"',
      '"content"',
      '"message"',
      '"diff"',
      '"stdout"',
      '"stderr"',
      '"summary"',
      '"reason"',
      '"detail"',
    ]) {
      expect(serialized).not.toContain(rawKey);
    }
    expect(report.dataQuality).toMatchObject({
      privacyMode: 'metadata-only',
      repoPathMode: 'basename+sha256-12',
      persistedTextFields: 0,
    });
  });

  it('saves attention reports atomically under the attention eval store', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m346-attention-store-'));
    try {
      const report = buildAttentionEvalReport(fixtureEvents(), {
        generatedAt: '2026-07-09T05:01:00.000Z',
      });

      const file = saveAttentionReport(report, { rootDir: root });
      const dir = join(root, 'eval', 'attention', 'reports');

      expect(file).toBe(join(dir, `${report.id}.json`));
      expect(readFileSync(file, 'utf8')).toMatch(/\n$/);
      expect(readdirSync(dir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
      expect(loadAttentionReports({ rootDir: root }).map((row) => row.id)).toEqual([report.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders JSON and optionally saves through injectable CLI dependencies', async () => {
    let output = '';
    let capturedReadOpts: { sinceMs?: number; limit?: number; maxFiles?: number } | undefined;
    let saved: AttentionEvalReport | undefined;

    const code = await cmdEvalAttention(['--window', '7d', '--limit', '2', '--json', '--save', '--all-repos'], {
      now: () => new Date('2026-07-09T05:01:00.000Z'),
      readEvents: (opts) => {
        capturedReadOpts = opts;
        return fixtureEvents().slice(0, 2) as never;
      },
      saveReport: (report) => {
        saved = report;
        return '/tmp/attention-report.json';
      },
      stdout: (text) => {
        output += text;
      },
    });

    expect(code).toBe(0);
    expect(capturedReadOpts).toMatchObject({
      limit: 2,
      maxFiles: 8,
    });
    expect(capturedReadOpts?.sinceMs).toBe(Date.parse('2026-07-02T05:01:00.000Z'));
    expect(saved?.window).toBe('7d');
    const parsed = JSON.parse(output) as { report: AttentionEvalReport; savedPath: string };
    expect(parsed.savedPath).toBe('/tmp/attention-report.json');
    expect(parsed.report.eventCount).toBe(2);
    expect(parsed.report.source.limit).toBe(2);
    expect(parsed.report.source.repoScope).toBe('all');
  });

  it('filters CLI reports to enrolled existing repos by default and supports all-repos mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m346-attention-scope-'));
    try {
      const repo = join(root, 'repo-a');
      const missingRepo = join(root, 'deleted-fixture');
      mkdirSync(repo, { recursive: true });
      const events: AgentActionEvent[] = [
        {
          ...(fixtureEvents()[0] as AgentActionEvent),
          repo,
          action: 'kept-enrolled',
        },
        {
          ...(fixtureEvents()[1] as AgentActionEvent),
          repo: missingRepo,
          action: 'dropped-missing',
        },
        {
          ...(fixtureEvents()[2] as AgentActionEvent),
          repo: undefined,
          action: 'kept-system',
        },
      ];
      const baseDeps = {
        now: () => new Date('2026-07-09T05:01:00.000Z'),
        readEvents: () => events,
        listEnrolledRepos: () => [repo, missingRepo],
      };
      let scopedOutput = '';
      const scopedCode = await cmdEvalAttention(['--json'], {
        ...baseDeps,
        stdout: (text) => {
          scopedOutput += text;
        },
      });
      let allOutput = '';
      const allCode = await cmdEvalAttention(['--json', '--all-repos'], {
        ...baseDeps,
        stdout: (text) => {
          allOutput += text;
        },
      });

      expect(scopedCode).toBe(0);
      expect(allCode).toBe(0);
      const scoped = JSON.parse(scopedOutput) as { report: AttentionEvalReport };
      const all = JSON.parse(allOutput) as { report: AttentionEvalReport };
      expect(scoped.report.eventCount).toBe(2);
      expect(scoped.report.repoAttention.activeRepos).toBe(1);
      expect(scoped.report.source.repoScope).toBe('enrolled-existing');
      expect(scoped.report.repoAttention.topRepos.map((row) => row.repoLabel)).toEqual(['repo-a']);
      expect(all.report.eventCount).toBe(3);
      expect(all.report.repoAttention.activeRepos).toBe(2);
      expect(all.report.source.repoScope).toBe('all');
      expect(all.report.repoAttention.topRepos.map((row) => row.repoLabel)).toEqual(
        expect.arrayContaining(['repo-a', 'deleted-fixture']),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns usage errors for invalid CLI flags without reading ledgers', async () => {
    let stderr = '';
    let read = false;

    const code = await cmdEvalAttention(['--bad'], {
      readEvents: () => {
        read = true;
        return [];
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(code).toBe(2);
    expect(read).toBe(false);
    expect(stderr).toContain('unknown flag: --bad');
  });
});
