/**
 * M301 — Autonomy evidence pack + policy verdict.
 *
 * These tests keep the new autonomy layer pure and metadata-only. The existing
 * merge gate still recomputes safety from source inputs; this layer records and
 * classifies how far the passed evidence allows Ashlr to act autonomously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildAutonomyEvidencePack,
  evidenceDir,
  evidencePackMatchesLiveProposal,
  evidencePath,
  listAutonomyEvidencePacks,
  persistAutonomyEvidencePack,
  readAutonomyEvidencePack,
  sealAutonomyEvidencePackV3,
  verifyAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../src/core/autonomy/policy.js';
import { hashDiff } from '../src/core/foundry/provenance.js';
import { deriveCandidateAttemptIdentity } from '../src/core/fleet/attempt-identity.js';
import { buildRequiredVerificationManifest } from '../src/core/run/verification-manifest.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { VerifyCommand } from '../src/core/run/verify-commands.js';

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
let tmpHome: string;

function diff(): string {
  return [
    'diff --git a/docs/autonomy.md b/docs/autonomy.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/autonomy.md',
    '@@ -0,0 +1 @@',
    '+evidence',
    '',
  ].join('\n');
}

const TEST_DIFF_HASH = hashDiff(diff());
const TEST_VERIFY_COMMANDS: VerifyCommand[] = [{
  id: 'merge-test',
  kind: 'test',
  cmd: ['npm', 'test'],
  cwd: '.',
  timeoutMs: 120_000,
  required: true,
  profiles: ['merge'],
}];
const TEST_VERIFIER_MANIFEST = buildRequiredVerificationManifest('/tmp/repo', TEST_VERIFY_COMMANDS)!;

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-m301',
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: 'autonomy test',
    summary: 'autonomy evidence pack test',
    diff: diff(),
    diffHash: TEST_DIFF_HASH,
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        ...over,
      },
    },
  } as unknown as AshlrConfig;
}

function goodPack(over: Partial<Parameters<typeof buildAutonomyEvidencePack>[0]> = {}) {
  const verification = over.verification
    ? {
        ...over.verification,
        requiredManifestDigest:
          over.verification.requiredManifestDigest ?? TEST_VERIFIER_MANIFEST.digest,
        requiredCommandCount:
          over.verification.requiredCommandCount ?? TEST_VERIFIER_MANIFEST.commandCount,
      }
    : {
        passed: true,
        detail: 'all verify commands passed',
        commandKinds: ['test', 'typecheck'],
        requiredManifestDigest: TEST_VERIFIER_MANIFEST.digest,
        requiredCommandCount: TEST_VERIFIER_MANIFEST.commandCount,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-01T00:01:00.000Z',
        source: 'auto-merge' as const,
      };
  return buildAutonomyEvidencePack({
    proposal: proposal(),
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: true,
    riskClass: 'low',
    authority: { ok: true, detail: 'frontier authority' },
    provenance: { ok: true, detail: 'valid HMAC provenance' },
    risk: { ok: true, detail: "risk 'low' within maxRisk 'low'" },
    scope: { ok: true, detail: '1 file, 1 line within caps' },
    ...over,
    verification,
  });
}

function liveRemoteProtection() {
  return {
    ok: true as const,
    live: true as const,
    detail: 'live protected remote confirmed with required checks: ci/test',
    nameWithOwner: 'ashlrai/fixture',
    repositoryId: 'R_fixture',
    branch: 'main',
    baseHead: 'a'.repeat(40),
    observedAt: '2026-07-01T00:01:30.000Z',
    requirements: ['required_status_checks'],
    requiredChecks: ['ci/test'],
    requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
    policySources: ['classic' as const],
    policyHash: 'b'.repeat(64),
  };
}

function packFor(id: string, generatedAt: string) {
  const pack = goodPack({ proposal: proposal({ id }) });
  pack.generatedAt = generatedAt;
  pack.policy = evaluateAutonomyPolicy(pack, cfg());
  return pack;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m301-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
});

describe('M301 evaluateAutonomyPolicy', () => {
  it('authorizes main merge when full evidence is present', () => {
    const verdict = evaluateAutonomyPolicy(goodPack(), cfg());
    expect(verdict).toMatchObject({
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
    });
  });

  it('refuses when a required gate is missing or failed', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({ provenance: { ok: false, detail: 'signature mismatch' } }),
      cfg(),
    );
    expect(verdict).toMatchObject({
      tier: 'T0',
      action: 'escalate-human',
      allowed: false,
    });
    expect(verdict.reason).toMatch(/provenance|signature/i);
  });

  it('refuses self-target merges unless explicitly allowed by evidence', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        selfTarget: {
          ok: false,
          detail: 'self-target autonomous merge requires allowSelfMerge=true',
        },
      }),
      cfg(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/self-target/i);
  });

  it('maps branch evidence to ready PR action when a remote is preferred', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({ target: 'branch', remotePreferred: true }),
      cfg(),
    );
    expect(verdict).toMatchObject({
      tier: 'T3',
      action: 'open-ready-pr',
      allowed: true,
    });
  });

  it('refuses evidence-mode main merge when only local fallback evidence exists', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: false,
      }),
      cfg(),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/protected remote PR handoff|local merge fallback/i);
  });

  it('refuses evidence-mode main merge without remote protection or command evidence', () => {
    const missingRemote = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
      }),
      cfg(),
    );
    expect(missingRemote.allowed).toBe(false);
    expect(missingRemote.reason).toMatch(/remote protection gate failed/i);

    const noCommands = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but no command manifest',
          commandKinds: [],
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
          diffHash: TEST_DIFF_HASH,
        },
      }),
      cfg(),
    );
    expect(noCommands.allowed).toBe(false);
    expect(noCommands.reason).toMatch(/real verification command/i);
  });

  it('refuses evidence-mode main merge without base-bound verification metadata', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but legacy pack omitted base metadata',
          commandKinds: ['test'],
          diffHash: TEST_DIFF_HASH,
        },
      }),
      cfg(),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/base-bound verification metadata/i);
  });

  it('refuses evidence-mode main merge without diff-bound verification metadata', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but legacy pack omitted diff metadata',
          commandKinds: ['test'],
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
        },
      }),
      cfg(),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/diff-bound verification metadata/i);
  });

  it('refuses evidence-mode main merge when verification diff hash mismatches evidence diff hash', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but stale diff binding',
          commandKinds: ['test'],
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
          diffHash: '0'.repeat(64),
        },
      }),
      cfg(),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/diff hash does not match/i);
  });

  it('refuses evidence-mode main merge without verification freshness metadata', () => {
    const missingSource = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but source is missing',
          commandKinds: ['test'],
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
          diffHash: TEST_DIFF_HASH,
          verifiedAt: '2026-07-01T00:01:00.000Z',
        },
      }),
      cfg(),
    );
    expect(missingSource.allowed).toBe(false);
    expect(missingSource.reason).toMatch(/verification freshness metadata/i);

    const malformedTimestamp = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
        verification: {
          passed: true,
          detail: 'green but timestamp is malformed',
          commandKinds: ['test'],
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
          diffHash: TEST_DIFF_HASH,
          verifiedAt: 'not-a-date',
          source: 'auto-merge',
        },
      }),
      cfg(),
    );
    expect(malformedTimestamp.allowed).toBe(false);
    expect(malformedTimestamp.reason).toMatch(/verification freshness metadata/i);
  });

  it('authorizes evidence-mode main merge only for protected remote command-bound evidence', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        trustBasis: 'evidence',
        remotePreferred: true,
        remoteProtection: liveRemoteProtection(),
      }),
      cfg(),
    );

    expect(verdict).toMatchObject({
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
    });
  });

  it('refuses evidence authority when the required verifier manifest binding is absent', () => {
    const pack = goodPack({
      trustBasis: 'evidence',
      remotePreferred: true,
      remoteProtection: liveRemoteProtection(),
    });
    delete pack.verification.requiredManifestDigest;
    delete pack.verification.requiredCommandCount;

    expect(evaluateAutonomyPolicy(pack, cfg())).toMatchObject({
      tier: 'T0',
      action: 'escalate-human',
      allowed: false,
    });
    expect(evaluateAutonomyPolicy(pack, cfg()).reason).toMatch(/verifier manifest digest/i);
    expect(sealAutonomyEvidencePackV3(pack)).toBeNull();
  });

  it('binds evidence authority to every required verifier command field and live base/diff', () => {
    const draft = goodPack({
      trustBasis: 'evidence',
      remotePreferred: true,
      remoteProtection: liveRemoteProtection(),
      verification: {
        passed: true,
        detail: 'required merge verifier passed',
        commandKinds: ['test'],
        requiredManifestDigest: TEST_VERIFIER_MANIFEST.digest,
        requiredCommandCount: TEST_VERIFIER_MANIFEST.commandCount,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-01T00:01:00.000Z',
        source: 'auto-merge',
      },
    });
    draft.generatedAt = '2026-07-01T00:02:00.000Z';
    draft.policy = evaluateAutonomyPolicy(draft, cfg());
    if (draft.evidenceOutcome) {
      draft.evidenceOutcome.policyAllowed = draft.policy.allowed;
      draft.evidenceOutcome.policyAction = draft.policy.action;
      draft.evidenceOutcome.policyTier = draft.policy.tier;
    }
    const signed = sealAutonomyEvidencePackV3(draft);
    expect(signed).not.toBeNull();

    const live = proposal({
      verifyResult: {
        passed: true,
        detail: 'required merge verifier passed',
        ran: structuredClone(TEST_VERIFY_COMMANDS),
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-01T00:01:00.000Z',
        source: 'auto-merge',
      },
    });
    const matches = (candidate: Proposal) => evidencePackMatchesLiveProposal(
      signed!,
      candidate,
      { nowMs: Date.parse('2026-07-01T00:02:00.000Z') },
    );
    expect(matches(live)).toBe(true);

    const commandMutations: Array<(command: VerifyCommand) => void> = [
      (command) => { command.cmd = ['npm', 'run', 'test']; },
      (command) => { command.cwd = 'packages/app'; },
      (command) => { command.timeoutMs = 60_000; },
      (command) => { command.profiles = ['quick']; },
      (command) => { command.id = 'renamed-test'; },
      (command) => { command.required = false; },
      (command) => { command.kind = 'lint'; },
    ];
    for (const mutate of commandMutations) {
      const changed = structuredClone(live);
      mutate(changed.verifyResult!.ran![0]!);
      expect(matches(changed)).toBe(false);
    }

    const staleDiff = structuredClone(live);
    staleDiff.verifyResult!.diffHash = '0'.repeat(64);
    expect(matches(staleDiff)).toBe(false);

    const staleBase = structuredClone(live);
    staleBase.verifyResult!.baseHead = 'c'.repeat(40);
    expect(matches(staleBase)).toBe(false);
  });

  it('binds signed child-run evidence to coherent live outer-attempt metadata without changing V3', () => {
    const attemptId = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1' as const;
    const attemptCandidateIndex = 1;
    const runId = deriveCandidateAttemptIdentity(attemptId, attemptCandidateIndex);
    const trajectoryId = `run:${runId}`;
    const attemptProposal = proposal({
      attemptId,
      attemptCandidateIndex,
      runId,
      trajectoryId,
      runEventSummary: {
        runId,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
    });
    const draft = goodPack({
      proposal: attemptProposal,
      trustBasis: 'evidence',
      remotePreferred: true,
      remoteProtection: liveRemoteProtection(),
    });
    draft.generatedAt = '2026-07-01T00:02:00.000Z';
    draft.policy = evaluateAutonomyPolicy(draft, cfg());
    if (draft.evidenceOutcome) {
      draft.evidenceOutcome.policyAllowed = draft.policy.allowed;
      draft.evidenceOutcome.policyAction = draft.policy.action;
      draft.evidenceOutcome.policyTier = draft.policy.tier;
    }
    const signed = sealAutonomyEvidencePackV3(draft);
    expect(signed).not.toBeNull();
    expect(signed).not.toHaveProperty('attemptId');

    const live = proposal({
      ...attemptProposal,
      verifyResult: {
        passed: true,
        detail: 'all verify commands passed',
        ran: structuredClone(TEST_VERIFY_COMMANDS),
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-01T00:01:00.000Z',
        source: 'auto-merge',
      },
    });
    const matches = (candidate: Proposal) => evidencePackMatchesLiveProposal(
      signed!,
      candidate,
      { nowMs: Date.parse('2026-07-01T00:02:00.000Z') },
    );
    expect(matches(live)).toBe(true);
    expect(matches({ ...live, attemptCandidateIndex: 0 })).toBe(false);
    expect(matches({
      ...live,
      attemptId: 'attempt-11111111-1111-4111-8111-111111111111',
    })).toBe(false);
    expect(matches({
      ...live,
      runEventSummary: { ...live.runEventSummary!, runId: deriveCandidateAttemptIdentity(attemptId, 0) },
    })).toBe(false);
    const stripped = structuredClone(live);
    delete stripped.attemptId;
    delete stripped.attemptCandidateIndex;
    expect(matches(stripped)).toBe(false);
  });

  it('recognizes signed v3 evidence while legacy v1 remains non-authoritative', () => {
    const legacy = goodPack({
      trustBasis: 'evidence',
      remotePreferred: true,
      remoteProtection: liveRemoteProtection(),
    });
    legacy.policy = evaluateAutonomyPolicy(legacy, cfg());
    if (legacy.evidenceOutcome) {
      legacy.evidenceOutcome.policyAllowed = legacy.policy.allowed;
      legacy.evidenceOutcome.policyAction = legacy.policy.action;
      legacy.evidenceOutcome.policyTier = legacy.policy.tier;
    }
    const signed = sealAutonomyEvidencePackV3(legacy);

    expect(signed).not.toBeNull();
    expect(verifyAutonomyEvidencePackV3(signed).ok).toBe(true);
    expect(evaluateAutonomyPolicy(signed!, cfg())).toMatchObject({
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
    });

    legacy.version = 1;
    expect(evaluateAutonomyPolicy(legacy, cfg()).allowed).toBe(false);
  });
});

describe('M301 autonomy evidence pack persistence', () => {
  it('persists sanitized browser visual evidence without raw provider fields', () => {
    const pack = goodPack({
      verification: {
        passed: true,
        detail: 'all verify commands passed; browser verify passed',
        commandKinds: ['test'],
        browser: {
          ok: true,
          renderOk: true,
          consoleErrorCount: 0,
          screenshotCaptured: true,
          detail: 'renders clean, 0 console errors',
          visualGrounding: {
            status: 'ok',
            provider: 'generic-openai-vision',
            boxCount: 1,
            boxes: [
              {
                x1: 10,
                y1: 20,
                x2: 300,
                y2: 400,
                scale: 'normalized-1000',
                label: 'deploy',
                sourceText: 'raw provider source',
              } as never,
            ],
            image: {
              bytes: 8,
              sha256: 'c'.repeat(64),
              path: '/tmp/browser-verify/shot.png',
            } as never,
            detail: 'visual grounding found 1 box',
            rawText: 'raw provider text data:image/png;base64,AAAA',
          } as never,
        },
      },
    });

    const raw = JSON.stringify(pack);
    expect(pack.verification.browser?.visualGrounding).toEqual(expect.objectContaining({
      status: 'ok',
      boxCount: 1,
      image: { bytes: 8, sha256: 'c'.repeat(64) },
    }));
    expect(raw).not.toContain('/tmp/browser-verify');
    expect(raw).not.toContain('raw provider');
    expect(raw).not.toContain('base64');
    expect(raw).not.toContain('sourceText');
  });

  it('persists metadata without storing the raw diff', () => {
    const pack = goodPack();
    pack.policy = evaluateAutonomyPolicy(pack, cfg());

    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const raw = fs.readFileSync(evidencePath(pack.proposal.id), 'utf8');
    expect(raw).toContain('"policy"');
    expect(raw).toContain('"merge-main"');
    expect(raw).toContain('"baseBranch"');
    expect(raw).toContain('"baseHead"');
    expect(raw).toContain('"diffHash"');
    expect(raw).toContain('"verifiedAt"');
    expect(raw).toContain('"source"');
    expect(raw).not.toContain('diff --git');
    expect(raw).not.toContain('+evidence');
  });

  it('refuses to persist a legacy static-only remote protection claim', () => {
    const pack = goodPack();
    pack.gates.remoteProtection = {
      ok: true,
      detail: 'configured protection claim without live binding',
    } as never;

    expect(persistAutonomyEvidencePack(pack)).toBe(false);
    expect(fs.existsSync(evidencePath(pack.proposal.id))).toBe(false);
  });

  it('reads valid v2 evidence without treating a legacy v1 pack as source corruption', () => {
    const current = packFor('prop-current', '2026-07-02T00:00:00.000Z');
    expect(persistAutonomyEvidencePack(current)).toBe(true);
    const legacy = packFor('prop-legacy', '2026-07-01T00:00:00.000Z');
    legacy.version = 1;
    legacy.trustBasis = 'evidence';
    legacy.gates.remoteProtection = {
      ok: true,
      detail: 'historical static protection claim',
    } as never;
    fs.writeFileSync(evidencePath(legacy.proposal.id), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    expect(evaluateAutonomyPolicy(legacy, cfg()).allowed).toBe(false);
    expect(readAutonomyEvidencePack(current.proposal.id)?.version).toBe(2);
    const listed = listAutonomyEvidencePacks(10);
    expect(listed.map((pack) => pack.proposal.id)).toEqual(['prop-current', 'prop-legacy']);
    expect(listed.sourceQuality).toMatchObject({ sourceState: 'healthy', complete: true });
  });

  it('captures delete-only diff files without storing deleted content', () => {
    const deleteOnlyDiff = [
      'diff --git a/docs/obsolete.md b/docs/obsolete.md',
      'deleted file mode 100644',
      '--- a/docs/obsolete.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-DELETE_ONLY_SECRET',
      '',
    ].join('\n');
    const pack = goodPack({
      proposal: proposal({
        id: 'prop-delete-only',
        diff: deleteOnlyDiff,
      }),
    });
    pack.policy = evaluateAutonomyPolicy(pack, cfg());

    expect(pack.diff.files).toEqual(['docs/obsolete.md']);
    expect(pack.diff.changedLines).toBe(1);
    expect(pack.policy).toMatchObject({
      action: 'merge-main',
      allowed: true,
    });
    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const raw = fs.readFileSync(evidencePath(pack.proposal.id), 'utf8');
    expect(raw).toContain('docs/obsolete.md');
    expect(raw).not.toContain('diff --git');
    expect(raw).not.toContain('DELETE_ONLY_SECRET');
  });

  it('reads a single evidence pack by proposal id', () => {
    const pack = packFor('prop-read', '2026-07-01T00:00:00.000Z');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const read = readAutonomyEvidencePack('prop-read');
    expect(read?.proposal.id).toBe('prop-read');
    expect(read?.policy?.action).toBe('merge-main');
    if (process.platform !== 'win32') {
      expect(fs.statSync(evidenceDir()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(evidencePath('prop-read')).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')('single-pack reads refuse symlinks and oversized files', () => {
    const pack = packFor('prop-bounded-read', '2026-07-01T00:00:00.000Z');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    const target = path.join(tmpHome, 'outside-evidence.json');
    fs.renameSync(evidencePath(pack.proposal.id), target);
    fs.symlinkSync(target, evidencePath(pack.proposal.id));

    expect(readAutonomyEvidencePack(pack.proposal.id)).toBeNull();

    fs.unlinkSync(evidencePath(pack.proposal.id));
    fs.writeFileSync(evidencePath(pack.proposal.id), 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(readAutonomyEvidencePack(pack.proposal.id)).toBeNull();
  });

  it('lists newest-first, caps results, and marks malformed JSON as degraded', () => {
    expect(persistAutonomyEvidencePack(packFor('prop-old', '2026-07-01T00:00:00.000Z'))).toBe(true);
    expect(persistAutonomyEvidencePack(packFor('prop-new', '2026-07-02T00:00:00.000Z'))).toBe(true);
    fs.mkdirSync(evidenceDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(evidenceDir(), 'broken.json'), '{ nope', 'utf8');

    const packs = listAutonomyEvidencePacks(1);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.proposal.id).toBe('prop-new');
    expect(packs.sourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      unreadableFiles: 0,
    });
  });

  it('degrades aliased evidence files whose filename does not bind the proposal id', () => {
    const pack = packFor('prop-bound', '2026-07-02T00:00:00.000Z');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    fs.copyFileSync(evidencePath(pack.proposal.id), path.join(evidenceDir(), 'alias.json'));

    const packs = listAutonomyEvidencePacks(10);
    expect(packs.map((candidate) => candidate.proposal.id)).toEqual(['prop-bound']);
    expect(packs.sourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
    });
  });

  it('bounds physical directory enumeration before filtering evidence filenames', () => {
    fs.mkdirSync(evidenceDir(), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 2_049; index++) {
      fs.writeFileSync(path.join(evidenceDir(), `noise-${index}.tmp`), '', 'utf8');
    }

    const packs = listAutonomyEvidencePacks(10);
    expect(packs).toEqual([]);
    expect(packs.sourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      limitExceeded: true,
    });
  });
});
