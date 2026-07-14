import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifyCommandResult } from '../src/core/run/verify-commands.js';

const verifyMocks = vi.hoisted(() => ({
  detectVerifyCommands: vi.fn(),
  runVerifyCommandAsync: vi.fn(),
}));

vi.mock('../src/core/run/verify-commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/verify-commands.js')>();
  return {
    ...actual,
    detectVerifyCommands: (...args: unknown[]) => verifyMocks.detectVerifyCommands(...args),
    runVerifyCommandAsync: (...args: unknown[]) => verifyMocks.runVerifyCommandAsync(...args),
  };
});

import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { createProposal, loadProposal, setStatus } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { enroll, killSwitchOn, setKill } from '../src/core/sandbox/policy.js';
import type { AshlrConfig } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
const originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

let home: string;
let repo: string;
let verificationStarted: Promise<void>;
let markVerificationStarted: () => void;
let releaseVerification: () => void;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function initRepo(): void {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(repo, ['config', 'user.email', 'test@ashlr.test']);
  git(repo, ['config', 'user.name', 'Ashlr Test']);
  writeFileSync(join(repo, 'README.md'), '# m407 fixture\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);

  const origin = join(home, 'origin.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  git(repo, ['checkout', '-b', 'work']);
}

function addFileDiff(): string {
  return [
    'diff --git a/docs/m407.md b/docs/m407.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/m407.md',
    '@@ -0,0 +1 @@',
    '+verification mutation fence',
    '',
  ].join('\n');
}

function config(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: false,
      },
    },
  } as AshlrConfig;
}

function verificationConfig(): AshlrConfig {
  const cfg = config();
  cfg.foundry!.autoMerge!.trustBasis = 'verification';
  cfg.foundry!.autoMerge!.managerGate = false;
  return cfg;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-m407-home-'));
  repo = join(home, 'repo');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

  verificationStarted = new Promise<void>((resolve) => {
    markVerificationStarted = resolve;
  });
  const verificationRelease = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });

  verifyMocks.detectVerifyCommands.mockReset();
  verifyMocks.runVerifyCommandAsync.mockReset();
  verifyMocks.detectVerifyCommands.mockReturnValue([{
    id: 'm407-required-typecheck',
    kind: 'typecheck',
    cmd: ['mock-verifier'],
    required: true,
    profiles: ['merge'],
  }]);
  verifyMocks.runVerifyCommandAsync.mockImplementation(async (): Promise<VerifyCommandResult> => {
    markVerificationStarted();
    await verificationRelease;
    return {
      ok: true,
      command: 'mock-verifier',
      exitCode: 0,
      output: '',
      timedOut: false,
    };
  });

  initRepo();
  expect(setKill(false)).toMatchObject({ ok: true, quiesced: true });
  expect(enroll(repo)).toMatchObject({ ok: true, quiesced: true });
});

afterEach(() => {
  releaseVerification?.();
  try { setKill(false); } catch { /* best-effort cleanup */ }
  rmSync(home, { recursive: true, force: true });

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
});

describe('M407 auto-merge verification mutation fence', () => {
  it('holds the outward fence until verification drains and refuses the merge after kill', async () => {
    const diff = addFileDiff();
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'M407 verification race',
      summary: 'Must not merge after kill is armed during verification.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(proposal.id, 'approved');
    const mainBefore = git(repo, ['rev-parse', 'main']);

    const merge = autoMergeProposal(proposal.id, config());
    await verificationStarted;

    expect(setKill(true, { waitMs: 25 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);

    releaseVerification();
    await expect(merge).resolves.toMatchObject({
      ok: false,
      merged: false,
      reason: expect.stringMatching(/kill switch is ON/i),
    });

    expect(git(repo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(proposal.id)?.status).toBe('approved');
    expect(loadProposal(proposal.id)?.verifyResult).toBeUndefined();
    expect(verifyMocks.runVerifyCommandAsync).toHaveBeenCalledTimes(1);
  });

  it('re-verifies a passing cache entry that belongs to a different diff', async () => {
    const diff = addFileDiff();
    const diffHash = hashDiff(diff);
    const baseHead = git(repo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'M407 stale verification binding',
      summary: 'Passing evidence for diff A must not authorize diff B.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      verifyResult: {
        passed: true,
        detail: 'stale cached pass',
        ran: [{
          id: 'm407-required-typecheck',
          kind: 'typecheck',
          cmd: ['mock-verifier'],
          required: true,
          profiles: ['merge'],
        }],
        baseBranch: 'main',
        baseHead,
        diffHash: hashDiff(`${diff}\n# stale diff A`),
        source: 'auto-merge',
      },
    });
    setStatus(proposal.id, 'approved');
    verifyMocks.runVerifyCommandAsync.mockResolvedValue({
      ok: false,
      command: 'mock-verifier',
      exitCode: 1,
      output: 'diff B fails verification',
      timedOut: false,
    });

    await expect(autoMergeProposal(proposal.id, verificationConfig())).resolves.toMatchObject({
      ok: false,
      merged: false,
      reason: expect.stringMatching(/verification failed/i),
    });

    expect(verifyMocks.runVerifyCommandAsync).toHaveBeenCalledTimes(1);
    expect(loadProposal(proposal.id)?.status).toBe('approved');
    expect(loadProposal(proposal.id)?.verifyResult).toMatchObject({
      passed: false,
      diffHash,
      baseBranch: 'main',
      baseHead,
    });
  });

  it('re-verifies a failed cache entry that belongs to a different diff', async () => {
    const diff = addFileDiff();
    const diffHash = hashDiff(diff);
    const baseHead = git(repo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'M407 stale failed diff binding',
      summary: 'Failure evidence for diff A must not reject diff B.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      verifyResult: {
        passed: false,
        failed: ['diff A failed verification'],
        detail: 'stale cached failure',
        ran: [{
          id: 'm407-required-typecheck',
          kind: 'typecheck',
          cmd: ['mock-verifier'],
          required: true,
          profiles: ['merge'],
        }],
        baseBranch: 'main',
        baseHead,
        diffHash: hashDiff(`${diff}\n# stale diff A`),
        source: 'auto-merge',
      },
    });
    setStatus(proposal.id, 'approved');
    verifyMocks.runVerifyCommandAsync.mockResolvedValue({
      ok: true,
      command: 'mock-verifier',
      exitCode: 0,
      output: '',
      timedOut: false,
    });

    await expect(autoMergeProposal(proposal.id, verificationConfig())).resolves.toMatchObject({
      ok: false,
      merged: false,
      reason: expect.stringMatching(/no 'judged' decision/i),
    });

    expect(verifyMocks.runVerifyCommandAsync).toHaveBeenCalledTimes(1);
    expect(loadProposal(proposal.id)?.status).toBe('approved');
    expect(loadProposal(proposal.id)?.verifyResult).toMatchObject({
      passed: true,
      diffHash,
      baseBranch: 'main',
      baseHead,
    });
  });

  it('re-verifies a failed cache entry bound to an obsolete base head', async () => {
    const diff = addFileDiff();
    const diffHash = hashDiff(diff);
    const staleBaseHead = git(repo, ['rev-parse', 'main']);
    git(repo, ['checkout', 'main']);
    writeFileSync(join(repo, 'README.md'), '# m407 fixture\n\nnew base\n', 'utf8');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'advance base']);
    const currentBaseHead = git(repo, ['rev-parse', 'main']);
    git(repo, ['checkout', 'work']);

    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'M407 stale failed base binding',
      summary: 'Failure evidence for an obsolete base must not reject the current proposal.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      verifyResult: {
        passed: false,
        failed: ['old base failed verification'],
        detail: 'stale cached failure',
        ran: [{
          id: 'm407-required-typecheck',
          kind: 'typecheck',
          cmd: ['mock-verifier'],
          required: true,
          profiles: ['merge'],
        }],
        baseBranch: 'main',
        baseHead: staleBaseHead,
        diffHash,
        source: 'auto-merge',
      },
    });
    setStatus(proposal.id, 'approved');
    verifyMocks.runVerifyCommandAsync.mockResolvedValue({
      ok: true,
      command: 'mock-verifier',
      exitCode: 0,
      output: '',
      timedOut: false,
    });

    await expect(autoMergeProposal(proposal.id, verificationConfig())).resolves.toMatchObject({
      ok: false,
      merged: false,
      reason: expect.stringMatching(/no 'judged' decision/i),
    });

    expect(verifyMocks.runVerifyCommandAsync).toHaveBeenCalledTimes(1);
    expect(loadProposal(proposal.id)?.status).toBe('approved');
    expect(loadProposal(proposal.id)?.verifyResult).toMatchObject({
      passed: true,
      diffHash,
      baseBranch: 'main',
      baseHead: currentBaseHead,
    });
  });

  it('keeps a failed result fail-closed when its base and diff bindings are current', async () => {
    const diff = addFileDiff();
    const diffHash = hashDiff(diff);
    const baseHead = git(repo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'M407 current failed binding',
      summary: 'Current failure evidence must remain authoritative.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      verifyResult: {
        passed: false,
        failed: ['current proposal failed verification'],
        detail: 'current cached failure',
        ran: [{
          id: 'm407-required-typecheck',
          kind: 'typecheck',
          cmd: ['mock-verifier'],
          required: true,
          profiles: ['merge'],
        }],
        baseBranch: 'main',
        baseHead,
        diffHash,
        source: 'auto-merge',
      },
    });
    setStatus(proposal.id, 'approved');
    verifyMocks.runVerifyCommandAsync.mockResolvedValue({
      ok: true,
      command: 'mock-verifier',
      exitCode: 0,
      output: '',
      timedOut: false,
    });

    await expect(autoMergeProposal(proposal.id, verificationConfig())).resolves.toMatchObject({
      ok: false,
      merged: false,
    });

    expect(verifyMocks.runVerifyCommandAsync).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.status).toBe('approved');
    expect(loadProposal(proposal.id)?.verifyResult).toMatchObject({
      passed: false,
      detail: 'current cached failure',
      diffHash,
      baseBranch: 'main',
      baseHead,
    });
  });
});
