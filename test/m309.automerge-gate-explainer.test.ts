/**
 * M309 — read-only auto-merge gate explainer.
 *
 * The explainer is a shared display surface for CLI/API/UI. These tests keep it
 * pure: no inbox reads, no git worktrees, no judge calls, no mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { explainAutoMergeGate } from '../src/core/inbox/merge.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';

const origHome = process.env.HOME;
let tmpHome: string;

const docDiff = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const sourceDiff = [
  'diff --git a/src/widget.ts b/src/widget.ts',
  '--- a/src/widget.ts',
  '+++ b/src/widget.ts',
  '@@ -1 +1 @@',
  '-export const oldValue = 1;',
  '+export const newValue = 2;',
  '',
].join('\n');

function cfg(autoMerge: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: { enabled: true, maxRisk: 'low', ...autoMerge },
    },
  } as unknown as AshlrConfig;
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  const diff = over.diff ?? docDiff;
  const engineModel = over.engineModel ?? 'codex:gpt-5.5';
  const engineTier = over.engineTier ?? 'frontier';
  const diffHash = hashDiff(diff);
  return {
    id: 'm309-prop',
    repo: '/tmp/m309-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'explainer proposal',
    summary: 'test',
    diff,
    diffHash,
    provenanceSig: signProvenance(engineModel, engineTier, diffHash),
    engineModel,
    engineTier,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  } as Proposal;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m309-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

describe('M309 explainAutoMergeGate', () => {
  it('explains disabled auto-merge before any proposal gate', () => {
    const r = explainAutoMergeGate(
      proposal({ verifyResult: { passed: true, detail: 'green' } }),
      cfg({ enabled: false }),
    );

    expect(r.mergeable).toBe(false);
    expect(r.reason).toMatch(/auto-merge disabled/);
    expect(r.blockers.map((b) => b.code)).toEqual(['auto-merge-disabled']);
  });

  it('explains self-target policy when self-merge is not explicitly allowed', () => {
    const r = explainAutoMergeGate(
      proposal({ verifyResult: { passed: true, detail: 'green' } }),
      cfg(),
      { selfTarget: true },
    );

    expect(r.mergeable).toBe(false);
    expect(r.blockers.some((b) => b.code === 'self-target-policy')).toBe(true);
    expect(r.reason).toMatch(/self-target autonomous merge requires/);
    expect(r.facts.selfTarget).toBe(true);
    expect(r.facts.allowSelfMerge).toBe(false);
  });

  it('explains missing verification evidence without running checks', () => {
    const r = explainAutoMergeGate(proposal(), cfg());

    expect(r.mergeable).toBe(false);
    expect(r.blockers.some((b) => b.code === 'missing-verification-evidence')).toBe(true);
    expect(r.reason).toMatch(/verification evidence is missing/);
  });

  it('explains missing verification-mode judge evidence', () => {
    const r = explainAutoMergeGate(
      proposal({ verifyResult: { passed: true, detail: 'green' } }),
      cfg({ trustBasis: 'verification' }),
      { decisionsForProposal: [] },
    );

    expect(r.mergeable).toBe(false);
    expect(r.blockers.some((b) => b.code === 'missing-judge-evidence')).toBe(true);
    expect(r.reason).toMatch(/no 'judged' decision/);
  });

  it('explains evidence-mode authority without requiring judge evidence', () => {
    const diff = docDiff;
    const r = explainAutoMergeGate(
      proposal({
        diff,
        verifyResult: {
          passed: true,
          detail: 'green',
          ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
          baseBranch: 'main',
          baseHead: '0123456789abcdef0123456789abcdef01234567',
          diffHash: hashDiff(diff),
        },
      }),
      cfg({
        trustBasis: 'evidence',
        allowWithoutVerification: false,
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      }),
      { decisionsForProposal: [] },
    );

    expect(r.mergeable).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.facts.trustBasis).toBe('evidence');
    expect(r.reason).toMatch(/satisfied by available read-only evidence/);
  });

  it('explains missing protected remote signal in evidence mode', () => {
    const diff = docDiff;
    const r = explainAutoMergeGate(
      proposal({
        diff,
        verifyResult: {
          passed: true,
          detail: 'green',
          ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
          baseBranch: 'main',
          baseHead: '0123456789abcdef0123456789abcdef01234567',
          diffHash: hashDiff(diff),
        },
      }),
      cfg({
        trustBasis: 'evidence',
        allowWithoutVerification: false,
        pushToRemote: true,
      }),
      { decisionsForProposal: [] },
    );

    expect(r.mergeable).toBe(false);
    expect(r.blockers.some((b) => b.code === 'remote-protection')).toBe(true);
    expect(r.reason).toMatch(/protected remote signal missing|branch-protection/i);
  });

  it('explains risk threshold blockers', () => {
    const r = explainAutoMergeGate(
      proposal({ diff: sourceDiff, verifyResult: { passed: true, detail: 'green' } }),
      cfg({ maxRisk: 'low' }),
    );

    expect(r.mergeable).toBe(false);
    expect(r.facts.risk).toBe('medium');
    expect(r.blockers.some((b) => b.code === 'risk-threshold')).toBe(true);
    expect(r.reason).toMatch(/risk class 'medium' exceeds maxRisk 'low'/);
  });

  it('reports mergeable when available read-only evidence satisfies the gates', () => {
    const r = explainAutoMergeGate(
      proposal({ verifyResult: { passed: true, detail: 'all checks passed' } }),
      cfg(),
    );

    expect(r.mergeable).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.reason).toMatch(/satisfied by available read-only evidence/);
    expect(r.facts).toMatchObject({
      trustBasis: 'tier',
      target: 'main',
      maxRisk: 'low',
      risk: 'low',
      scopeFiles: 1,
      scopeLines: 2,
    });
  });
});
