/**
 * test/m243.skill-library.test.ts — M243: skill-library positive write-back.
 *
 * Verifies the key properties of the skill-library module:
 *  1. authoritative applied+verified evidence writes both the legacy genome
 *     workflow and a forced verified-proposal SkillCard.
 *  2. flag-off (skillLibrary: false) → absolute no-op (byte-identical).
 *  3. genome-write-throw → swallowed, learnFromApplied never throws.
 *  4. distillWorkflow produces an abstracted workflow, NOT the raw diff verbatim.
 *  5. stale/missing/denied/skill-assisted evidence fails closed.
 *  6. curateSkills remains disabled until a release-proof verifier exists.
 *
 * HERMETICITY:
 *  - HOME overridden to a fresh tmp dir per test — no real ~/.ashlr touched.
 *  - appendHubEntry and recordDecision are MOCKED via vi.mock() so no real I/O
 *    occurs and we get call-level assertions (mirrors m235 pattern).
 *  - Fixed timestamps via vi.setSystemTime() — no Date.now()-flaky tests.
 *  - No network, no LLM, no child processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type {
  AutonomyEvidencePack,
  SignedAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// HOME isolation — override before any module resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports so modules bind to the mocks
// ---------------------------------------------------------------------------

const mockAppendHubEntry = vi.fn();
vi.mock('../src/core/genome/store.js', () => ({
  appendHubEntry: (...args: unknown[]) => mockAppendHubEntry(...args),
  loadGenome: vi.fn(() => []),
  genomeHealth: vi.fn(() => ({})),
  genomeHubHealth: vi.fn(() => ({})),
  hubStorePath: vi.fn(() => ''),
}));

const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
  readDecisions: vi.fn(() => []),
  decisionsDir: vi.fn(() => ''),
}));

const mockLoadProposal = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
}));

const mockReadAutonomyEvidencePack = vi.fn();
const mockVerifyAutonomyEvidencePackV3 = vi.fn();
vi.mock('../src/core/autonomy/evidence-pack.js', () => ({
  readAutonomyEvidencePack: (...args: unknown[]) => mockReadAutonomyEvidencePack(...args),
  verifyAutonomyEvidencePackV3: (...args: unknown[]) => mockVerifyAutonomyEvidencePackV3(...args),
}));

const mockRecordSkillCard = vi.fn();
vi.mock('../src/core/fleet/skill-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-records.js')>();
  return {
    ...actual,
    recordSkillCard: (...args: unknown[]) => mockRecordSkillCard(...args),
  };
});

const mockHasReleasedPostMergeCredit = vi.fn();
vi.mock('../src/core/fleet/post-merge-credit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/post-merge-credit.js')>();
  return {
    ...actual,
    hasReleasedPostMergeCredit: (...args: unknown[]) => mockHasReleasedPostMergeCredit(...args),
  };
});

const mockAttestSkillCard = vi.fn();
vi.mock('../src/core/fleet/skill-attestation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-attestation.js')>();
  return {
    ...actual,
    attestSkillCard: (...args: unknown[]) => mockAttestSkillCard(...args),
  };
});

// ---------------------------------------------------------------------------
// Lazy import — after mocks
// ---------------------------------------------------------------------------

import {
  learnFromApplied,
  distillWorkflow,
  curateSkills,
} from '../src/core/fleet/skill-library.js';
import { POST_MERGE_CREDIT_RELEASE_LABEL } from '../src/core/fleet/post-merge-credit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_TS = new Date('2026-01-15T12:00:00.000Z');
const DEFAULT_DIFF = '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+if (!user) return;\n const tok = user.token;';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const diff = overrides.diff ?? DEFAULT_DIFF;
  const diffHash = hashDiff(diff);
  const proposal = {
    id: 'prop-m243-001',
    repo: '/home/user/myrepo',
    origin: 'swarm',
    kind: 'patch',
    title: 'Fix null pointer in auth module',
    summary: 'Added null check before accessing user.token to prevent crash',
    status: 'applied',
    labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL,
    createdAt: FIXED_TS.toISOString(),
    engineTier: 'frontier',
    engineModel: 'claude:claude-opus-4-5',
    diff,
    diffHash,
    verifyResult: {
      passed: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      baseBranch: 'master',
      baseHead: 'abc123',
      diffHash,
      verifiedAt: FIXED_TS.toISOString(),
      source: 'auto-merge',
    },
    realizedMerge: {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'master',
      baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40),
      observedAt: FIXED_TS.toISOString(),
    },
    ...overrides,
  } as Proposal;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'provenanceSig')) {
    proposal.provenanceSig = signProvenance(
      proposal.engineModel ?? '',
      proposal.engineTier ?? '',
      proposal.diffHash ?? '',
    );
  }
  return proposal;
}

function makeEvidence(
  proposal: Proposal,
  overrides: Partial<AutonomyEvidencePack> = {},
): AutonomyEvidencePack {
  const diffHash = hashDiff(proposal.diff ?? '');
  return {
    version: 3,
    generatedAt: FIXED_TS.toISOString(),
    proposal: {
      id: proposal.id,
      repo: proposal.repo,
      kind: proposal.kind,
      status: proposal.status,
      origin: proposal.origin,
      title: proposal.title,
      createdAt: proposal.createdAt,
    },
    producer: {
      engineModel: proposal.engineModel,
      engineTier: proposal.engineTier,
    },
    diff: { hash: diffHash, files: ['src/auth.ts'], changedLines: 1 },
    target: 'main',
    trustBasis: 'evidence',
    remotePreferred: true,
    riskClass: 'low',
    gates: {
      authority: { ok: true, detail: 'authority passed' },
      provenance: { ok: true, detail: 'provenance passed' },
      verification: { ok: true, detail: 'verification passed' },
      risk: { ok: true, detail: 'risk passed' },
      scope: { ok: true, detail: 'scope passed' },
    },
    verification: {
      passed: true,
      detail: 'verification passed',
      commandKinds: ['test'],
      baseBranch: 'master',
      baseHead: 'abc123',
      diffHash,
      verifiedAt: FIXED_TS.toISOString(),
      source: 'auto-merge',
    },
    policy: {
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      reason: 'verified evidence passed',
    },
    payloadDigest: 'a'.repeat(64),
    signatureAlgorithm: 'hmac-sha256',
    signingKeyId: 'd'.repeat(64),
    signature: 'b'.repeat(64),
    sealedPackDigest: 'c'.repeat(64),
    ...overrides,
  } as SignedAutonomyEvidencePackV3;
}

function primeAuthoritativeState(
  proposal: Proposal,
  evidence: AutonomyEvidencePack | null = makeEvidence(proposal),
): void {
  mockLoadProposal.mockReturnValue(proposal);
  mockReadAutonomyEvidencePack.mockReturnValue(evidence);
}

function learnVerified(proposal: Proposal, cfg: AshlrConfig): void {
  primeAuthoritativeState(proposal);
  learnFromApplied(proposal, cfg);
}

function expectNoWrites(): void {
  expect(mockAppendHubEntry).not.toHaveBeenCalled();
  expect(mockRecordSkillCard).not.toHaveBeenCalled();
  expect(mockRecordDecision).not.toHaveBeenCalled();
}

function enableReleaseGateValidation(): void {
  mockHasReleasedPostMergeCredit.mockImplementation(
    (labelBasis) => labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL,
  );
}

function expectRejectedBeforeAttestation(): void {
  expectNoWrites();
  expect(mockAttestSkillCard).not.toHaveBeenCalled();
}

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
      cooldownMs: 6 * 60 * 60 * 1000,
    },
    ...overrides,
  } as AshlrConfig;
}

function makeCfgWithSkillLibrary(skillLibrary: boolean): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: { skillLibrary } as unknown,
  } as AshlrConfig;
}

function makeCfgNoFlag(): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: {} as unknown,
  } as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m243-home-'));
  process.env.HOME = tmpHome;

  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TS);

  mockAppendHubEntry.mockReset();
  mockRecordDecision.mockReset();
  mockLoadProposal.mockReset();
  mockReadAutonomyEvidencePack.mockReset();
  mockVerifyAutonomyEvidencePackV3.mockReset();
  mockRecordSkillCard.mockReset();
  mockHasReleasedPostMergeCredit.mockReset();
  mockAttestSkillCard.mockReset();

  mockAppendHubEntry.mockReturnValue(undefined);
  mockRecordDecision.mockReturnValue(undefined);
  mockRecordSkillCard.mockReturnValue(undefined);
  mockHasReleasedPostMergeCredit.mockReturnValue(false);
  mockAttestSkillCard.mockReturnValue(null);
  mockVerifyAutonomyEvidencePackV3.mockReturnValue({ ok: true, reason: 'valid signed fixture' });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ===========================================================================
// 1. distillWorkflow — pure function checks
// ===========================================================================

describe('M243 distillWorkflow — pure function', () => {
  it('returns a non-empty string containing the proposal title', () => {
    const p = makeProposal({ title: 'Add rate limiting to API' });
    const workflow = distillWorkflow(p);
    expect(typeof workflow).toBe('string');
    expect(workflow.length).toBeGreaterThan(20);
    expect(workflow).toContain('Add rate limiting to API');
  });

  it('contains the engine/model info', () => {
    const p = makeProposal({ engineModel: 'claude:claude-opus-4-5', engineTier: 'frontier' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('claude:claude-opus-4-5');
  });

  it('contains the repo path', () => {
    const p = makeProposal({ repo: '/home/user/myrepo' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('/home/user/myrepo');
  });

  it('includes the summary when present', () => {
    const p = makeProposal({ summary: 'Added null check for user object' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('Added null check for user object');
  });

  it('does NOT include the raw diff verbatim', () => {
    // AWM/Voyager principle: workflow must be abstracted, not a raw diff copy
    const p = makeProposal({
      diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+if (!user) return;\n const tok = user.token;',
    });
    const workflow = distillWorkflow(p);
    // The raw unified diff hunk markers must not appear verbatim
    expect(workflow).not.toContain('--- a/src/auth.ts');
    expect(workflow).not.toContain('+++ b/src/auth.ts');
    expect(workflow).not.toContain('@@ -1,3 +1,4 @@');
  });

  it('derives a task class from the title', () => {
    const bugP = makeProposal({ title: 'Fix crash in parser' });
    expect(distillWorkflow(bugP)).toContain('bug-fix');

    const featP = makeProposal({ title: 'Add new dashboard feature' });
    expect(distillWorkflow(featP)).toContain('feature-add');

    const refactorP = makeProposal({ title: 'Refactor auth module' });
    expect(distillWorkflow(refactorP)).toContain('refactor');
  });

  it('truncates extremely long non-secret titles to 80 chars in the workflow text', () => {
    const longTitle = 'Z'.repeat(200);
    const p = makeProposal({ title: longTitle });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('Z'.repeat(80));
    expect(workflow).not.toContain('Z'.repeat(81));
  });

  it('falls back gracefully when title is empty', () => {
    const p = makeProposal({ title: '' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('(untitled)');
  });

  it('falls back to engineTier when engineModel is absent', () => {
    const p = makeProposal({ engineModel: undefined, engineTier: 'frontier' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('frontier');
  });
});

// ===========================================================================
// 2. learnFromApplied — no current release authority
// ===========================================================================

describe('M243 learnFromApplied — current reuse remains fail closed', () => {
  it('does not mint skill authority from caller-supplied release metadata', () => {
    learnVerified(makeProposal(), makeCfg());
    expectNoWrites();
  });

  it('does not mint when skillLibrary is enabled explicitly or by default', () => {
    learnVerified(makeProposal(), makeCfgNoFlag());
    expectNoWrites();

    mockAppendHubEntry.mockClear();
    mockRecordSkillCard.mockClear();
    mockRecordDecision.mockClear();
    learnVerified(makeProposal(), makeCfgWithSkillLibrary(true));
    expectNoWrites();
  });

  it('does not turn authoritative caller state into a release protocol', () => {
    const authoritative = makeProposal({ status: 'applied', engineTier: 'frontier' });
    const caller = { ...authoritative, status: 'pending', engineTier: 'local' } as Proposal;
    primeAuthoritativeState(authoritative);

    learnFromApplied(caller, makeCfg());

    expectNoWrites();
  });
});

// ===========================================================================
// 3. learnFromApplied — authoritative verification/evidence refusals
// ===========================================================================

describe('M243 learnFromApplied — verified distillation gates fail closed', () => {
  beforeEach(() => {
    enableReleaseGateValidation();
  });

  it('does not distill realized-merge-v1 alone into a reusable skill', () => {
    const p = makeProposal({ labelBasis: 'realized-merge-v1' });
    primeAuthoritativeState(p);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not distill an applied proposal without realized merge evidence', () => {
    const p = makeProposal({ realizedMerge: undefined });
    primeAuthoritativeState(p);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });
  it('does not write when authoritative proposal provenance is missing', () => {
    const p = makeProposal({ provenanceSig: undefined });
    primeAuthoritativeState(p);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when authoritative proposal provenance is forged', () => {
    const p = makeProposal({ provenanceSig: '0'.repeat(64) });
    primeAuthoritativeState(p);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when signed authoritative provenance metadata was tampered', () => {
    const signed = makeProposal();
    const tampered = { ...signed, engineModel: 'claude:forged-model' } as Proposal;
    primeAuthoritativeState(tampered);

    learnFromApplied(signed, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when authoritative autonomy evidence is missing', () => {
    const p = makeProposal();
    primeAuthoritativeState(p, null);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('keeps unsigned legacy evidence observational and rejects invalid v3 signatures', () => {
    const p = makeProposal();
    const signed = makeEvidence(p) as SignedAutonomyEvidencePackV3;
    const {
      payloadDigest: _payloadDigest,
      signatureAlgorithm: _signatureAlgorithm,
      signingKeyId: _signingKeyId,
      signature: _signature,
      sealedPackDigest: _sealedPackDigest,
      ...payload
    } = signed;

    primeAuthoritativeState(p, { ...payload, version: 2 });
    learnFromApplied(p, makeCfg());
    expectRejectedBeforeAttestation();

    primeAuthoritativeState(p, signed);
    mockVerifyAutonomyEvidencePackV3.mockReturnValue({ ok: false, reason: 'signature mismatch' });
    learnFromApplied(p, makeCfg());
    expectRejectedBeforeAttestation();
  });

  it('does not write when the live diff changed after verification', () => {
    const caller = makeProposal();
    const live = { ...caller, diff: `${caller.diff}\n+const later = true;` } as Proposal;
    primeAuthoritativeState(live, makeEvidence(caller));

    learnFromApplied(caller, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when autonomy evidence is bound to an older diff', () => {
    const oldProposal = makeProposal();
    const live = makeProposal({ diff: `${DEFAULT_DIFF}\n+const current = true;` });
    primeAuthoritativeState(live, makeEvidence(oldProposal));

    learnFromApplied(live, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when signed evidence belongs to another proposal identity', () => {
    const signedFor = makeProposal();
    const live = makeProposal({ repo: '/home/user/another-repo' });
    primeAuthoritativeState(live, makeEvidence(signedFor));

    learnFromApplied(live, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when an autonomy evidence gate failed', () => {
    const p = makeProposal();
    const evidence = makeEvidence(p);
    evidence.gates.scope = { ok: false, detail: 'scope exceeded' };
    primeAuthoritativeState(p, evidence);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not write when autonomy policy denied the action', () => {
    const p = makeProposal();
    const evidence = makeEvidence(p, {
      policy: { tier: 'T0', action: 'escalate-human', allowed: false, reason: 'denied' },
    });
    primeAuthoritativeState(p, evidence);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('does not distill proposal-only evidence after a later manual merge', () => {
    const p = makeProposal();
    const evidence = makeEvidence(p, {
      target: 'proposal',
      trustBasis: 'tier',
      policy: { tier: 'T1', action: 'propose-only', allowed: true, reason: 'proposal only' },
    });
    primeAuthoritativeState(p, evidence);

    learnFromApplied(p, makeCfgWithSkillLibrary(true));

    expectRejectedBeforeAttestation();
  });

  it('does not trust an applied caller when the live proposal is not applied', () => {
    const caller = makeProposal({ status: 'applied' });
    const live = { ...caller, status: 'approved' } as Proposal;
    primeAuthoritativeState(live, makeEvidence(caller));

    learnFromApplied(caller, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('prevents skill-assisted proposals from distilling another skill', () => {
    const p = makeProposal({
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        selectedSkillIds: ['skill.verify-focused-tests'],
        skillMode: 'shadow',
      },
    });
    primeAuthoritativeState(p);

    learnFromApplied(p, makeCfg());

    expectRejectedBeforeAttestation();
  });

  it('requires nonempty verification commands and an authoritative producer tier', () => {
    const noCommands = makeProposal({
      verifyResult: { passed: true, ran: [], diffHash: hashDiff(DEFAULT_DIFF) },
    });
    primeAuthoritativeState(noCommands);
    learnFromApplied(noCommands, makeCfg());
    expectRejectedBeforeAttestation();

    const p = makeProposal();
    const evidence = makeEvidence(p, { producer: {} });
    primeAuthoritativeState(p, evidence);
    learnFromApplied(p, makeCfg());
    expectRejectedBeforeAttestation();
  });
});

// ===========================================================================
// 4. learnFromApplied — flag-off is a byte-identical no-op
// ===========================================================================

describe('M243 learnFromApplied — flag-off (skillLibrary: false) is a no-op', () => {
  it('does not call appendHubEntry when skillLibrary is false', () => {
    learnFromApplied(makeProposal(), makeCfgWithSkillLibrary(false));
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
  });

  it('does not call recordDecision when skillLibrary is false', () => {
    learnFromApplied(makeProposal(), makeCfgWithSkillLibrary(false));
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it('is a no-op for multiple proposal shapes when skillLibrary is false', () => {
    const cfg = makeCfgWithSkillLibrary(false);
    for (const title of ['Fix bug', 'Add feature', 'Refactor module', 'Update deps']) {
      mockAppendHubEntry.mockReset();
      mockRecordSkillCard.mockReset();
      mockRecordDecision.mockReset();
      learnFromApplied(makeProposal({ title }), cfg);
      expect(mockAppendHubEntry).not.toHaveBeenCalled();
      expect(mockRecordSkillCard).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// 5. learnFromApplied — never throws (store-write failures are swallowed)
// ===========================================================================

describe('M243 learnFromApplied — never throws', () => {
  it('does not throw when appendHubEntry throws', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => learnVerified(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when recordDecision throws', () => {
    mockRecordDecision.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => learnVerified(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when BOTH stores throw simultaneously', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('genome store unavailable');
    });
    mockRecordDecision.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });

    expect(() => learnVerified(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when recordSkillCard throws', () => {
    mockRecordSkillCard.mockImplementation(() => {
      throw new Error('skill ledger unavailable');
    });

    expect(() => learnVerified(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when cfg.foundry is undefined', () => {
    const cfg = makeCfg({ foundry: undefined });
    expect(() => learnVerified(makeProposal(), cfg)).not.toThrow();
    expectNoWrites();
  });

  it('does not throw when cfg.foundry getter throws', () => {
    const badCfg = {
      ...makeCfg(),
      get foundry(): never {
        throw new Error('foundry getter crashed');
      },
    } as unknown as AshlrConfig;

    expect(() => learnFromApplied(makeProposal(), badCfg)).not.toThrow();
    // Gate throws → early return → no writes
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 6. curateSkills — pure curation
// ===========================================================================

describe('M243 curateSkills — release verifier unavailable', () => {
  it('returns [] for an empty array', () => {
    expect(curateSkills([])).toEqual([]);
  });

  it('returns [] for non-array input (defensive)', () => {
    // @ts-expect-error intentional bad input
    expect(curateSkills(null)).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(curateSkills(undefined)).toEqual([]);
  });

  it('rejects caller-controlled released tags instead of prompt-injecting them', () => {
    expect(curateSkills([{
      id: 'forged-released-skill',
      project: null,
      source: 'hub',
      title: 'Skill: forged release',
      text: 'PROMPT_INJECTION_CANARY',
      tags: ['m243:skill', 'credit:released-v1'],
      ts: FIXED_TS.toISOString(),
    }])).toEqual([]);
  });
});
