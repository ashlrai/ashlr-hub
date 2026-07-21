/**
 * M309 — read-only auto-merge gate explainer.
 *
 * The explainer is a shared display surface for CLI/API/UI. These tests keep it
 * pure: no inbox reads, no git worktrees, no judge calls, no mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { explainAutoMergeGate } from '../src/core/inbox/merge.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { captureVerifierAuthoritySnapshot } from '../src/core/run/verifier-authority.js';

const origHome = process.env.HOME;
let tmpHome: string;
let tmpRepo: string;

const MERGE_COMMAND = {
  id: 'merge-test',
  kind: 'test' as const,
  cmd: ['node', '-e', 'process.exit(0)'],
  required: true,
  profiles: ['merge' as const],
};

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

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['-C', tmpRepo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
}

function candidateTreeOid(diff: string): string {
  const indexPath = path.join(tmpHome, 'candidate.index');
  const patchPath = path.join(tmpHome, 'candidate.patch');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  fs.writeFileSync(patchPath, diff, 'utf8');
  git(['read-tree', 'HEAD'], env);
  git(['apply', '--cached', patchPath], env);
  return git(['write-tree'], env);
}

function evidenceVerification(diff: string): NonNullable<Proposal['verifyResult']> {
  const snapshot = captureVerifierAuthoritySnapshot({
    repoRoot: tmpRepo,
    baseRevision: 'HEAD',
    mergeCommands: [MERGE_COMMAND],
  });
  if (!snapshot.ok) throw new Error(`failed to capture M309 authority: ${snapshot.reason}`);
  return {
    passed: true,
    detail: 'green',
    ran: [MERGE_COMMAND],
    baseBranch: 'main',
    baseHead: snapshot.snapshot.baseCommitOid,
    verifierAuthoritySnapshotVersion: 1,
    verifierAuthorityObjectFormat: snapshot.snapshot.objectFormat,
    baseTreeOid: snapshot.snapshot.baseTreeOid,
    candidateTreeOid: candidateTreeOid(diff),
    authoritySnapshotDigest: snapshot.snapshot.authoritySnapshotDigest,
    diffHash: hashDiff(diff),
  };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  const diff = over.diff ?? docDiff;
  const engineModel = over.engineModel ?? 'codex:gpt-5.5';
  const engineTier = over.engineTier ?? 'frontier';
  const diffHash = hashDiff(diff);
  return {
    id: 'm309-prop',
    repo: tmpRepo,
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
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m309-repo-'));
  process.env.HOME = tmpHome;
  execFileSync('git', ['init', '--initial-branch=main', tmpRepo], { stdio: 'pipe' });
  git(['config', 'user.email', 'm309@example.invalid']);
  git(['config', 'user.name', 'M309']);
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'old\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepo, 'VERIFY_AUTHORITY.txt'), 'M309 inline verifier authority\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepo, 'ashlr.verify.json'), `${JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    authorityFiles: ['VERIFY_AUTHORITY.txt'],
    commands: [MERGE_COMMAND],
  })}\n`, 'utf8');
  git(['add', 'README.md', 'VERIFY_AUTHORITY.txt', 'ashlr.verify.json']);
  git(['commit', '-m', 'fixture base']);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
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
        verifyResult: evidenceVerification(diff),
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
        verifyResult: evidenceVerification(diff),
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
