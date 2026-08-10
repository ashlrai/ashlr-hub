import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANDIDATE_ADMISSION_EVALUATOR_VERSION,
  buildCandidateAdmissionAttestationId,
  candidateAdmissionAuthorityPath,
  inspectCandidateRepoAdmission,
  parseCandidateAdmissionTrustedPolicy,
  readCandidateAdmissionTrustedPolicyAuthority,
  readCandidateCheckRunEvidence,
  type CandidateGithubApiReader,
  type CandidateCheckRunEvidence,
  type CandidateCheckRunRequest,
  type CandidateRepoAdmissionDeps,
} from '../src/core/portfolio/candidate-admission.js';
import type { BranchProtectionAttestation } from '../src/core/integrations/github.js';
import {
  resolveTrustedGitCli,
  trustedGitEnvironment,
  trustedGithubEnvironment,
  verifyTrustedGitCli,
} from '../src/core/util/trusted-executable.js';

const POLICY_DIGEST = 'b'.repeat(64);
const APP_ID = '42424242';
const WORKFLOW_APP_ID = '15368';
const CHECK = 'ashlr admission';
const ATTESTATION_CHECK = 'Ashlr admission attestation';
const WORKFLOW = '.github/workflows/ashlr-admission.yml';
const EVALUATED_AT = '2026-08-10T12:00:00.000Z';
const AUTHORITY_PROOF = 'f'.repeat(64);
const TRUSTED_GH_PIN = {
  canonicalPath: '/trusted/bin/gh',
  executable: '/trusted/bin/gh',
  digest: 'e'.repeat(64),
};
const TRUSTED_GIT_PIN = resolveTrustedGitCli([])!;
const TRUSTED_POLICY_INPUT = {
  schemaVersion: 2,
  trustedAppIds: [APP_ID],
  attestationCheck: ATTESTATION_CHECK,
  evidenceMaxAgeMs: 30 * 60_000,
  evidenceFutureSkewMs: 60_000,
};
const TRUSTED_POLICY = parseCandidateAdmissionTrustedPolicy(TRUSTED_POLICY_INPUT)!;

let fixture = '';
let home = '';
let priorHome: string | undefined;

function git(args: string[]): string {
  return execFileSync('git', ['-C', fixture, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeVerifier(): void {
  writeFileSync(join(fixture, 'ashlr.verify.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    commands: [{
      id: 'merge',
      kind: 'test',
      cmd: ['npm', 'test'],
      required: true,
      profiles: ['merge'],
    }],
  }), 'utf8');
}

function writeAdmission(riskClassification = 'ordinary', check = CHECK): void {
  writeFileSync(join(fixture, 'ashlr.admission.json'), JSON.stringify({
    schemaVersion: 2,
    riskClassification,
    judgeFreeEvidence: {
      profile: 'merge',
      workflow: WORKFLOW,
      check,
    },
  }), 'utf8');
}

function protection(
  nameWithOwner: string,
  overrides: Partial<BranchProtectionAttestation> = {},
): BranchProtectionAttestation {
  const head = git(['rev-parse', 'HEAD']);
  return {
    ok: true,
    available: true,
    protected: true,
    branchProtection: true,
    nameWithOwner,
    repositoryId: 'R_candidate',
    defaultBranch: 'main',
    branch: 'main',
    baseHead: head,
    observedAt: '2026-08-10T12:00:00.000Z',
    requirements: ['non_fast_forward', 'pull_request', 'required_status_checks'],
    requiredChecks: [CHECK],
    requiredCheckBindings: [{ context: CHECK, appId: WORKFLOW_APP_ID }],
    sources: ['classic'],
    policySnapshot: { schemaVersion: 2, classic: null, rulesets: [] },
    detail: 'live protected branch',
    ...overrides,
  };
}

function readyCheck(request: CandidateCheckRunRequest): CandidateCheckRunEvidence {
  const attestation = request.expectedAttestations[0]!;
  return {
    available: true,
    ready: true,
    workflow: request.workflow,
    workflowRunId: '41',
    workflowRunNumber: 7,
    workflowRunAttempt: 1,
    check: request.check,
    workflowJobId: '42',
    workflowCheckRunId: '43',
    workflowAppId: request.workflowAppId,
    attestationCheck: request.attestationCheck,
    attestationCheckRunId: '44',
    appId: attestation.appId,
    head: request.head,
    status: 'completed',
    conclusion: 'success',
    externalIdMatched: true,
    trustedPolicyDigest: request.trustedPolicyDigest,
    evaluatorVersion: request.evaluatorVersion,
    workflowCreatedAt: '2026-08-10T11:50:00.000Z',
    workflowStartedAt: '2026-08-10T11:51:00.000Z',
    workflowCompletedAt: '2026-08-10T11:56:00.000Z',
    jobStartedAt: '2026-08-10T11:52:00.000Z',
    jobCompletedAt: '2026-08-10T11:55:00.000Z',
    workflowCheckStartedAt: '2026-08-10T11:52:00.000Z',
    workflowCheckCompletedAt: '2026-08-10T11:55:00.000Z',
    attestationStartedAt: '2026-08-10T11:57:00.000Z',
    attestationCompletedAt: '2026-08-10T11:58:00.000Z',
    fresh: true,
    authorityDigest: 'c'.repeat(64),
    detail: 'exact attestation',
  };
}

function deps(overrides: Partial<CandidateRepoAdmissionDeps> = {}): Partial<CandidateRepoAdmissionDeps> {
  return {
    now: () => new Date(EVALUATED_AT),
    readTrustedPolicy: () => ({
      state: 'verified',
      path: join(home, '.ashlr', 'control', 'candidate-admission-authority.json'),
      value: TRUSTED_POLICY_INPUT,
      proof: AUTHORITY_PROOF,
      detail: 'fixture authority custody',
    }),
    readEnrollment: () => ({ state: 'ready', repos: [], reason: 'missing-empty' }),
    readRemoteHead: (nameWithOwner) => ({
      available: true,
      nameWithOwner,
      defaultBranch: 'main',
      head: git(['rev-parse', 'HEAD']),
      detail: 'exact remote head',
    }),
    readProtection: vi.fn(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner)),
    readCheckRun: vi.fn((request) => readyCheck(request)),
    resolveGitCli: vi.fn(() => TRUSTED_GIT_PIN),
    verifyGitCli: vi.fn(() => true),
    resolveGithubCli: vi.fn(() => TRUSTED_GH_PIN),
    verifyGithubCli: vi.fn(() => true),
    evaluateSafeMinimum: vi.fn(() => ({
      ok: true,
      policyVersion: 1,
      snapshotSchemaVersion: 2,
      signaturePolicy: 'not-required',
      sourceCount: 1,
      detail: 'safe minimum',
    })),
    buildPolicyDigest: vi.fn(() => POLICY_DIGEST),
    ...overrides,
  };
}

function directCheckRequest(overrides: Partial<CandidateCheckRunRequest> = {}): CandidateCheckRunRequest {
  return {
    candidateRoot: fixture || tmpdir(),
    nameWithOwner: 'ashlrai/candidate',
    branch: 'main',
    head: 'a'.repeat(40),
    workflow: WORKFLOW,
    check: CHECK,
    workflowAppId: WORKFLOW_APP_ID,
    attestationCheck: ATTESTATION_CHECK,
    expectedAttestations: [{ appId: APP_ID, externalId: `ashlr-admission-v5:${'d'.repeat(64)}` }],
    trustedPolicyDigest: TRUSTED_POLICY.digest,
    evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
    evaluatedAt: EVALUATED_AT,
    evidenceMaxAgeMs: TRUSTED_POLICY.evidenceMaxAgeMs,
    evidenceFutureSkewMs: TRUSTED_POLICY.evidenceFutureSkewMs,
    ...overrides,
  };
}

interface FakeGitHubEvidenceInput {
  workflowRun?: Record<string, unknown>;
  extraWorkflowRuns?: Record<string, unknown>[];
  job?: Record<string, unknown>;
  workflowCheckRun?: Record<string, unknown>;
  extraWorkflowCheckRuns?: Record<string, unknown>[];
  attestationCheckRun?: Record<string, unknown>;
  extraAttestationCheckRuns?: Record<string, unknown>[];
}

function fakeGitHubApi(
  input: FakeGitHubEvidenceInput,
  request = directCheckRequest(),
): CandidateGithubApiReader {
  const workflowRun = {
    id: 41,
    run_number: 7,
    run_attempt: 1,
    path: `${WORKFLOW}@main`,
    head_sha: request.head,
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-08-10T11:50:00Z',
    run_started_at: '2026-08-10T11:51:00Z',
    updated_at: '2026-08-10T11:56:00Z',
    ...input.workflowRun,
  };
  const job = {
    id: 42,
    name: CHECK,
    run_id: 41,
    head_sha: request.head,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-10T11:52:00Z',
    completed_at: '2026-08-10T11:55:00Z',
    check_run_url: 'https://api.github.com/repos/ashlrai/candidate/check-runs/43',
    ...input.job,
  };
  const workflowCheckRun = {
    id: 43,
    name: CHECK,
    head_sha: request.head,
    app: { id: Number(WORKFLOW_APP_ID) },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-10T11:52:00Z',
    completed_at: '2026-08-10T11:55:00Z',
    ...input.workflowCheckRun,
  };
  const attestationCheckRun = {
    id: 44,
    name: ATTESTATION_CHECK,
    head_sha: request.head,
    app: { id: Number(APP_ID) },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-10T11:57:00Z',
    completed_at: '2026-08-10T11:58:00Z',
    external_id: request.expectedAttestations[0]!.externalId,
    ...input.attestationCheckRun,
  };
  return (endpoint) => {
    const page = Number(new URLSearchParams(endpoint.includes('?') ? endpoint.slice(endpoint.indexOf('?') + 1) : '').get('page') ?? '1');
    const collection = (key: string, rows: Record<string, unknown>[]): Record<string, unknown> => {
      const start = (page - 1) * 100;
      return { total_count: rows.length, [key]: rows.slice(start, start + 100) };
    };
    if (endpoint.includes('/actions/workflows/') && endpoint.includes('/runs?')) {
      return collection('workflow_runs', [workflowRun, ...(input.extraWorkflowRuns ?? [])]);
    }
    if (endpoint.includes('/actions/runs/41/attempts/1/jobs?')) return collection('jobs', [job]);
    if (endpoint.endsWith('/check-runs/43')) return workflowCheckRun;
    if (endpoint.includes('/commits/') && endpoint.includes('/check-runs?')) {
      const appId = new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1)).get('app_id');
      return appId === WORKFLOW_APP_ID
        ? collection('check_runs', [workflowCheckRun, ...(input.extraWorkflowCheckRuns ?? [])])
        : collection('check_runs', [attestationCheckRun, ...(input.extraAttestationCheckRuns ?? [])]);
    }
    return null;
  };
}

function fakeGitHubCheckEvidence(input: FakeGitHubEvidenceInput): CandidateCheckRunEvidence {
  const request = directCheckRequest();
  return readCandidateCheckRunEvidence(request, fakeGitHubApi(input, request));
}

function repositoryDigest(): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(fixture, path).replace(/\\/g, '/');
      const stat = lstatSync(path);
      hash.update(`${rel}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(fixture);
  return hash.digest('hex');
}

function indexBytes(): Buffer {
  return readFileSync(join(fixture, '.git', 'index'));
}

beforeEach(() => {
  priorHome = process.env['HOME'];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'm489-home-')));
  process.env['HOME'] = home;
  fixture = mkdtempSync(join(tmpdir(), 'm489-repo-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', fixture]);
  git(['config', 'user.email', 'm489@ashlr.test']);
  git(['config', 'user.name', 'M489']);
  git(['remote', 'add', 'origin', 'https://github.com/ashlrai/candidate.git']);
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: '@ashlr/candidate', scripts: { test: 'vitest' } }), 'utf8');
  writeFileSync(join(fixture, 'README.md'), '# candidate\n', 'utf8');
  mkdirSync(join(fixture, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(fixture, WORKFLOW), 'name: Ashlr admission\n', 'utf8');
  writeVerifier();
  writeAdmission();
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'candidate']);
});

afterEach(() => {
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  rmSync(fixture, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('M489 hardened candidate repo admission preflight', () => {
  it('accepts only a bounded owner-only authority file through a stable descriptor double-read', () => {
    const path = join(home, 'candidate-admission-authority.json');
    writeFileSync(path, JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home })).toMatchObject({
      state: 'verified',
      path,
      value: TRUSTED_POLICY_INPUT,
    });
  });

  it('anchors operator and GitHub credential discovery to the OS account, not hostile environment paths', () => {
    const keys = ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'SSL_CERT_FILE', 'TMPDIR'] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env['HOME'] = fixture;
    process.env['GH_CONFIG_DIR'] = join(fixture, 'gh-config');
    process.env['XDG_CONFIG_HOME'] = join(fixture, 'xdg');
    process.env['SSL_CERT_FILE'] = join(fixture, 'candidate-ca.pem');
    process.env['TMPDIR'] = join(fixture, 'tmp');
    try {
      expect(candidateAdmissionAuthorityPath()).toBe(join(
        userInfo().homedir,
        '.ashlr',
        'control',
        'candidate-admission-authority.json',
      ));
      const env = trustedGithubEnvironment();
      expect(env['HOME']).toBe(userInfo().homedir);
      expect(env['GH_CONFIG_DIR']).toBeUndefined();
      expect(env['XDG_CONFIG_HOME']).toBeUndefined();
      expect(env['SSL_CERT_FILE']).toBeUndefined();
      expect(env['TMPDIR']).toBeUndefined();
      expect(env['PATH']).toBeUndefined();
    } finally {
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
      }
    }
  });

  it.each(['bin', 'node_modules/.bin'])('never executes candidate-controlled %s Git under a hostile PATH', async (relativeBin) => {
    const fakeBin = join(fixture, ...relativeBin.split('/'));
    const fakeGit = join(fakeBin, 'git');
    const marker = join(home, `fake-git-${relativeBin.replace(/\W/g, '-')}`);
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 99\n`, 'utf8');
    chmodSync(fakeGit, 0o755);
    const currentHead = git(['rev-parse', 'HEAD']);
    const protectedBranch = protection('ashlrai/candidate');
    const priorPath = process.env['PATH'];
    process.env['PATH'] = [fakeBin, '.', dirname(TRUSTED_GIT_PIN.executable)].join(delimiter);
    try {
      const resolved = resolveTrustedGitCli([fixture, join(fixture, 'node_modules')]);
      expect(resolved).toEqual(TRUSTED_GIT_PIN);
      const childEnv = trustedGitEnvironment(resolved!);
      expect(childEnv['PATH']).not.toContain(fixture);
      expect(childEnv['HOME']).toBe(userInfo().homedir);
      expect(childEnv['TMPDIR']).toBeUndefined();
      const report = await inspectCandidateRepoAdmission(fixture, deps({
        resolveGitCli: () => resolved,
        readRemoteHead: (nameWithOwner) => ({
          available: true,
          nameWithOwner,
          defaultBranch: 'main',
          head: currentHead,
          detail: 'exact remote head',
        }),
        readProtection: vi.fn(async () => protectedBranch),
      }));
      expect(report.source.available).toBe(true);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : 'missing').toBe('missing');
    } finally {
      if (priorPath === undefined) delete process.env['PATH']; else process.env['PATH'] = priorPath;
    }
  });

  it('rejects a candidate-owned symlink alias to the trusted Git inode', () => {
    const fakeBin = join(fixture, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    symlinkSync(TRUSTED_GIT_PIN.executable, join(fakeBin, 'git'));
    const priorPath = process.env['PATH'];
    process.env['PATH'] = fakeBin;
    try {
      expect(resolveTrustedGitCli([fixture, join(fixture, 'node_modules')])).toBeNull();
    } finally {
      if (priorPath === undefined) delete process.env['PATH']; else process.env['PATH'] = priorPath;
    }
  });

  it('rejects a replaced candidate Git pin before invocation', async () => {
    const fakeBin = join(fixture, 'bin');
    const fakeGit = join(fakeBin, 'git');
    const marker = join(home, 'replaced-git-executed');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, '#!/bin/sh\nexit 99\n', 'utf8');
    chmodSync(fakeGit, 0o755);
    const fakePin = { canonicalPath: fakeGit, executable: fakeGit, digest: 'a'.repeat(64) };
    const gitRunner = vi.fn(() => {
      writeFileSync(marker, 'executed', 'utf8');
      return { status: 0, stdout: Buffer.alloc(0) };
    });
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      git: gitRunner,
      resolveGitCli: () => fakePin,
      verifyGitCli: verifyTrustedGitCli,
    }));
    expect(report).toMatchObject({ admissionReady: false, source: { available: false } });
    expect(report.admissionBlockers.map((item) => item.id)).toContain('trusted-git-custody-changed');
    expect(gitRunner).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it('discards every Git result when custody changes across an invocation', async () => {
    const marker = join(home, 'git-toctou-invoked');
    const verifyGitCli = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const gitRunner = vi.fn(() => {
      writeFileSync(marker, 'invoked', 'utf8');
      return { status: 0, stdout: Buffer.from('forged\n') };
    });
    const report = await inspectCandidateRepoAdmission(fixture, deps({ git: gitRunner, verifyGitCli }));
    expect(gitRunner).toHaveBeenCalledTimes(1);
    expect(existsSync(marker)).toBe(true);
    expect(report).toMatchObject({ admissionReady: false, source: { available: false } });
    expect(report.admissionBlockers.map((item) => item.id)).toContain('trusted-git-custody-changed');
  });

  it('rejects symlinked, over-permissive, wrong-owner, and oversized authority files', () => {
    const target = join(home, 'policy-target.json');
    const path = join(home, 'candidate-admission-authority.json');
    writeFileSync(target, JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    symlinkSync(target, path);
    expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home }).state).toBe('unsafe');

    rmSync(path);
    writeFileSync(path, JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o644 });
    expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home }).state).toBe('unsafe');

    chmodSync(path, 0o600);
    if (typeof process.getuid === 'function') {
      const actualUid = process.getuid();
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
      expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home }).state).toBe('unsafe');
      getuid.mockRestore();
    }

    writeFileSync(path, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home }).state).toBe('unsafe');
  });

  it('rejects symlinked or group-writable authority parent components', () => {
    const realControl = join(home, 'real-control');
    const linkedControl = join(home, 'linked-control');
    mkdirSync(realControl, { mode: 0o700 });
    writeFileSync(join(realControl, 'policy.json'), JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    symlinkSync(realControl, linkedControl);
    expect(readCandidateAdmissionTrustedPolicyAuthority(join(linkedControl, 'policy.json'), { authorityAnchorPath: home })).toMatchObject({
      state: 'unsafe',
      proof: null,
    });

    const writableControl = join(home, 'writable-control');
    mkdirSync(writableControl, { mode: 0o770 });
    chmodSync(writableControl, 0o770);
    writeFileSync(join(writableControl, 'policy.json'), JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    expect(readCandidateAdmissionTrustedPolicyAuthority(join(writableControl, 'policy.json'), { authorityAnchorPath: home })).toMatchObject({
      state: 'unsafe',
      proof: null,
    });
  });

  it('rejects an authority parent with an untrusted macOS write ACL', () => {
    if (process.platform !== 'darwin') return;
    const control = join(home, 'acl-control');
    mkdirSync(control, { mode: 0o700 });
    const path = join(control, 'policy.json');
    writeFileSync(path, JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_file,delete_child', control]);
    expect(readCandidateAdmissionTrustedPolicyAuthority(path, { authorityAnchorPath: home })).toMatchObject({ state: 'unsafe', proof: null });
  });

  it('rejects authority inode replacement after open and same-inode bytes changing mid-read', () => {
    const path = join(home, 'candidate-admission-authority.json');
    const displaced = join(home, 'authority-opened.json');
    const replacement = join(home, 'authority-replacement.json');
    writeFileSync(path, JSON.stringify(TRUSTED_POLICY_INPUT), { mode: 0o600 });
    writeFileSync(replacement, JSON.stringify({ ...TRUSTED_POLICY_INPUT, trustedAppIds: ['987654321'] }), { mode: 0o600 });
    const swapped = readCandidateAdmissionTrustedPolicyAuthority(path, {
      authorityAnchorPath: home,
      afterOpen: () => {
        renameSync(path, displaced);
        renameSync(replacement, path);
      },
    });
    expect(swapped).toMatchObject({ state: 'unstable', value: null });

    rmSync(path);
    renameSync(displaced, path);
    const unstable = readCandidateAdmissionTrustedPolicyAuthority(path, {
      authorityAnchorPath: home,
      afterFirstRead: () => writeFileSync(path, JSON.stringify({ ...TRUSTED_POLICY_INPUT, evidenceFutureSkewMs: 1 }), { mode: 0o600 }),
    });
    expect(unstable).toMatchObject({ state: 'unstable', value: null });
  });

  it('returns non-authoritative exact evidence while preserving every repo and index byte', async () => {
    const beforeRepo = repositoryDigest();
    const beforeIndex = indexBytes();
    const readCheckRun = vi.fn((request) => readyCheck(request));
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readCheckRun }));

    expect(report).toMatchObject({
      schemaVersion: 6,
      readOnly: true,
      authorityGranted: false,
      mutationPerformed: false,
      verdict: 'evidence-candidate',
      admissionReady: true,
      judgeFreeEligible: true,
      source: {
        available: true,
        clean: true,
        current: true,
        gitMetadataSafe: true,
        mutationProof: {
          indexUnchanged: true,
          repoBytesUnchanged: true,
        },
      },
      verifier: {
        contractSource: 'head-regular',
        headMode: '100644',
        worktreeMatchesHead: true,
        mergeGradeExplicit: true,
        declaredProfile: 'merge',
      },
      admissionContract: {
        state: 'head-regular',
        riskClassification: 'ordinary',
        declaredProfile: 'merge',
        workflow: WORKFLOW,
        check: CHECK,
      },
      trustedPolicy: {
        available: true,
        trustedAppIds: [APP_ID],
        attestationCheck: ATTESTATION_CHECK,
        custodyState: 'verified',
        digest: TRUSTED_POLICY.digest,
      },
      remotePr: {
        ready: true,
        baseHead: git(['rev-parse', 'HEAD']),
        candidateHead: git(['rev-parse', 'HEAD']),
        trustedPolicyDigest: TRUSTED_POLICY.digest,
        evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
        evidenceScope: 'whole-head-snapshot',
        remoteStableAfterChecks: true,
        trustedPolicyStableAfterChecks: true,
        checkEvidenceStableAfterRecheck: true,
        checkRun: {
          ready: true,
          externalIdMatched: true,
          fresh: true,
          authorityDigest: 'c'.repeat(64),
        },
      },
      risk: {
        state: 'attested',
        restricted: false,
        selfTarget: false,
        filenameHeuristicsUsed: false,
      },
    });
    expect(report.remotePr.expectedAttestationId).toMatch(/^ashlr-admission-v5:[0-9a-f]{64}$/);
    expect(report.remotePr.candidateTreeOid).toBe(git(['rev-parse', 'HEAD^{tree}']));
    expect(readCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      nameWithOwner: 'ashlrai/candidate',
      branch: 'main',
      head: git(['rev-parse', 'HEAD']),
      workflow: WORKFLOW,
      check: CHECK,
      workflowAppId: WORKFLOW_APP_ID,
      attestationCheck: ATTESTATION_CHECK,
      expectedAttestations: [{ appId: APP_ID, externalId: report.remotePr.expectedAttestationId }],
      trustedPolicyDigest: TRUSTED_POLICY.digest,
      evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
      evaluatedAt: EVALUATED_AT,
    }));
    expect(indexBytes()).toEqual(beforeIndex);
    expect(repositoryDigest()).toBe(beforeRepo);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('names and binds whole-HEAD snapshot evidence including the exact tree object', () => {
    const common = {
      nameWithOwner: 'ashlrai/candidate',
      repositoryId: 'R_candidate',
      branch: 'main',
      baseHead: 'a'.repeat(40),
      candidateHead: 'a'.repeat(40),
      evidenceScope: 'whole-head-snapshot' as const,
      workflow: WORKFLOW,
      check: CHECK,
      workflowAppId: WORKFLOW_APP_ID,
      attestationCheck: ATTESTATION_CHECK,
      attestationAppId: APP_ID,
      trustedPolicyDigest: TRUSTED_POLICY.digest,
      protectedRemotePolicyDigest: POLICY_DIGEST,
      evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
      verifierManifestDigest: 'e'.repeat(64),
      profile: 'merge' as const,
      riskClassification: 'ordinary' as const,
    };
    const first = buildCandidateAdmissionAttestationId({ ...common, candidateTreeOid: 'b'.repeat(40) });
    const changedTree = buildCandidateAdmissionAttestationId({ ...common, candidateTreeOid: 'c'.repeat(40) });
    expect(first).toMatch(/^ashlr-admission-v5:[0-9a-f]{64}$/);
    expect(changedTree).not.toBe(first);
  });

  it('cannot construct or accept an attestation from the protected workflow App', async () => {
    const common = {
      nameWithOwner: 'ashlrai/candidate',
      repositoryId: 'R_candidate',
      branch: 'main',
      baseHead: 'a'.repeat(40),
      candidateHead: 'a'.repeat(40),
      candidateTreeOid: 'b'.repeat(40),
      evidenceScope: 'whole-head-snapshot' as const,
      workflow: WORKFLOW,
      check: CHECK,
      workflowAppId: WORKFLOW_APP_ID,
      attestationCheck: ATTESTATION_CHECK,
      attestationAppId: WORKFLOW_APP_ID,
      trustedPolicyDigest: TRUSTED_POLICY.digest,
      protectedRemotePolicyDigest: POLICY_DIGEST,
      evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
      verifierManifestDigest: 'e'.repeat(64),
      profile: 'merge' as const,
      riskClassification: 'ordinary' as const,
    };
    expect(buildCandidateAdmissionAttestationId(common)).toBeNull();
    expect(readCandidateCheckRunEvidence(directCheckRequest({
      expectedAttestations: [{
        appId: WORKFLOW_APP_ID,
        externalId: `ashlr-admission-v5:${'d'.repeat(64)}`,
      }],
    }), () => null).detail).toMatch(/malformed/i);

    const readCheckRun = vi.fn((request) => readyCheck(request));
    const sameAppPolicy = { ...TRUSTED_POLICY_INPUT, trustedAppIds: [WORKFLOW_APP_ID] };
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readTrustedPolicy: () => ({
        state: 'verified',
        path: join(home, 'policy.json'),
        value: sameAppPolicy,
        proof: AUTHORITY_PROOF,
        detail: 'fixture',
      }),
      readCheckRun,
    }));
    expect(report.remotePr).toMatchObject({ ready: false, trustedPolicyStableAfterChecks: true });
    expect(report.remotePr.detail).toMatch(/attestor App must be independent/i);
    expect(readCheckRun).not.toHaveBeenCalled();
  });

  it('never invokes a hostile fsmonitor and preserves the index and repo bytes', async () => {
    const marker = join(home, 'fsmonitor-executed');
    const monitor = join(home, 'hostile-fsmonitor.sh');
    writeFileSync(monitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, 'utf8');
    chmodSync(monitor, 0o755);
    git(['config', 'core.fsmonitor', monitor]);
    const beforeRepo = repositoryDigest();
    const beforeIndex = indexBytes();

    const report = await inspectCandidateRepoAdmission(fixture, deps());

    expect(report.admissionBlockers.map((item) => item.id)).toContain('hostile-git-metadata');
    expect(report.source.gitMetadataSafe).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(indexBytes()).toEqual(beforeIndex);
    expect(repositoryDigest()).toBe(beforeRepo);
  });

  it('severs inherited Git config injection and disables pagers without losing read-only evidence', async () => {
    const marker = join(home, 'ambient-git-executed');
    const payload = join(home, 'ambient-git.sh');
    writeFileSync(payload, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, 'utf8');
    chmodSync(payload, 0o755);
    git(['config', 'core.pager', payload]);
    const prior = {
      count: process.env['GIT_CONFIG_COUNT'],
      key: process.env['GIT_CONFIG_KEY_0'],
      value: process.env['GIT_CONFIG_VALUE_0'],
    };
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'core.fsmonitor';
    process.env['GIT_CONFIG_VALUE_0'] = payload;
    try {
      const report = await inspectCandidateRepoAdmission(fixture, deps());
      expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: true });
      expect(existsSync(marker)).toBe(false);
      expect(report.source.mutationProof.repoBytesUnchanged).toBe(true);
    } finally {
      if (prior.count === undefined) delete process.env['GIT_CONFIG_COUNT']; else process.env['GIT_CONFIG_COUNT'] = prior.count;
      if (prior.key === undefined) delete process.env['GIT_CONFIG_KEY_0']; else process.env['GIT_CONFIG_KEY_0'] = prior.key;
      if (prior.value === undefined) delete process.env['GIT_CONFIG_VALUE_0']; else process.env['GIT_CONFIG_VALUE_0'] = prior.value;
    }
  });

  it('rejects credential helpers and hooks before any helper can execute', async () => {
    const marker = join(home, 'helper-executed');
    git(['config', 'credential.helper', `!touch ${marker}`]);
    git(['config', 'credential.https://github.com.helper', `!touch ${marker}`]);
    git(['config', 'core.hooksPath', home]);
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report.admissionBlockers.map((item) => item.id)).toContain('hostile-git-metadata');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects ext remote helpers without launching their payload', async () => {
    const marker = join(home, 'ext-helper-executed');
    git(['remote', 'set-url', 'origin', `ext::sh -c 'touch ${marker}'`]);
    const before = repositoryDigest();

    const report = await inspectCandidateRepoAdmission(fixture, deps());

    expect(report.admissionBlockers.map((item) => item.id)).toContain('hostile-git-metadata');
    expect(existsSync(marker)).toBe(false);
    expect(repositoryDigest()).toBe(before);
  });

  it.each([
    ['symlink', () => {
      rmSync(join(fixture, 'ashlr.verify.json'));
      symlinkSync('package.json', join(fixture, 'ashlr.verify.json'));
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', 'symlink verifier']);
    }],
    ['submodule', () => {
      const target = git(['rev-parse', 'HEAD']);
      git(['rm', '--quiet', 'ashlr.verify.json']);
      git(['update-index', '--add', '--cacheinfo', `160000,${target},ashlr.verify.json`]);
      git(['commit', '--quiet', '-m', 'gitlink verifier']);
    }],
  ] as const)('rejects a %s verifier entry from immutable HEAD', async (_label, mutate) => {
    mutate();
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report).toMatchObject({ admissionReady: false, judgeFreeEligible: false });
    expect(report.admissionBlockers.map((item) => item.id)).toContain('verifier-contract-not-immutable');
    expect(report.verifier.headMode).toMatch(/^(120000|160000)$/);
  });

  it('rejects worktree verifier divergence even when the HEAD blob is valid', async () => {
    writeFileSync(join(fixture, 'ashlr.verify.json'), '{"schemaVersion":1,"mode":"replace-detected","commands":[]}');
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report.admissionBlockers.map((item) => item.id)).toEqual(expect.arrayContaining([
      'source-dirty',
      'verifier-contract-not-immutable',
    ]));
    expect(report.verifier).toMatchObject({ contractSource: 'worktree-diverged', worktreeMatchesHead: false });
  });

  it('refuses arbitrary or spoofed check names despite otherwise strong branch protection', async () => {
    const readCheckRun = vi.fn((request) => ({
      ...readyCheck(request),
      ready: false,
      externalIdMatched: false,
      detail: 'spoofed external id',
    }));
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readCheckRun }));
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.remotePr).toMatchObject({ ready: false, checkRun: { ready: false, externalIdMatched: false } });
    expect(report.autonomyBlockers.map((item) => item.id)).toContain('protected-remote-pr-incomplete');

    const arbitrary = await inspectCandidateRepoAdmission(fixture, deps({
      readProtection: vi.fn(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner, {
        requiredChecks: ['ci/test'],
        requiredCheckBindings: [{ context: 'ci/test', appId: APP_ID }],
      })),
    }));
    expect(arbitrary.remotePr.ready).toBe(false);
    expect(arbitrary.remotePr.detail).toMatch(/not bound to exactly one required-check App/i);
  });

  it('refuses candidate-controlled App 987654321 as attestor even when it controls the workflow check', async () => {
    const candidateApp = '987654321';
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => ({
      ...readyCheck(request),
      ready: false,
      appId: candidateApp,
      externalIdMatched: false,
      detail: 'candidate App is not in the trusted attestor set',
    }));
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readProtection: vi.fn(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner, {
        requiredCheckBindings: [{ context: CHECK, appId: candidateApp }],
      })),
      readCheckRun,
    }));
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.remotePr).toMatchObject({ ready: false, trustedPolicyDigest: TRUSTED_POLICY.digest });
    expect(report.remotePr.detail).toMatch(/candidate App is not in the trusted attestor set/i);
    expect(readCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      workflowAppId: candidateApp,
      expectedAttestations: [{ appId: APP_ID, externalId: expect.stringMatching(/^ashlr-admission-v5:/) }],
    }));

    writeFileSync(join(fixture, 'ashlr.admission.json'), JSON.stringify({
      schemaVersion: 2,
      riskClassification: 'ordinary',
      judgeFreeEvidence: { profile: 'merge', workflow: WORKFLOW, check: CHECK, appId: candidateApp },
    }));
    git(['add', 'ashlr.admission.json']);
    git(['commit', '--quiet', '-m', 'attempt signer nomination']);
    const signerNomination = await inspectCandidateRepoAdmission(fixture, deps());
    expect(signerNomination.admissionContract.state).toBe('invalid');
    expect(signerNomination.judgeFreeEligible).toBe(false);
  });

  it('fails closed when operator-pinned signer policy is absent', async () => {
    const readCheckRun = vi.fn((request) => readyCheck(request));
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readTrustedPolicy: () => ({ state: 'missing', path: join(home, 'missing-policy.json'), value: null, proof: null, detail: 'missing' }),
      readCheckRun,
    }));
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.trustedPolicy).toMatchObject({ available: false, digest: null, trustedAppIds: [] });
    expect(report.autonomyBlockers.map((item) => item.id)).toContain('trusted-signer-policy-unavailable');
    expect(readCheckRun).not.toHaveBeenCalled();
  });

  it('requires a fresh trusted check whenever the operator policy digest changes', async () => {
    let acceptedExternalId: string | null = null;
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => {
      const externalId = request.expectedAttestations[0]!.externalId;
      acceptedExternalId ??= externalId;
      const matched = externalId === acceptedExternalId;
      return { ...readyCheck(request), ready: matched, externalIdMatched: matched };
    });
    const first = await inspectCandidateRepoAdmission(fixture, deps({ readCheckRun }));
    expect(first.judgeFreeEligible).toBe(true);

    const changedPolicy = { ...TRUSTED_POLICY_INPUT, evidenceMaxAgeMs: 31 * 60_000 };
    const second = await inspectCandidateRepoAdmission(fixture, deps({
      readTrustedPolicy: () => ({ state: 'verified', path: join(home, 'policy.json'), value: changedPolicy, proof: AUTHORITY_PROOF, detail: 'fixture' }),
      readCheckRun,
    }));
    expect(second).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(second.trustedPolicy.digest).not.toBe(first.trustedPolicy.digest);
    expect(second.remotePr.expectedAttestationId).not.toBe(first.remotePr.expectedAttestationId);
    expect(second.remotePr.checkRun).toMatchObject({ ready: false, externalIdMatched: false });
  });

  it('requires a fresh trusted check whenever the protected-remote policy digest changes', async () => {
    let acceptedExternalId: string | null = null;
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => {
      const externalId = request.expectedAttestations[0]!.externalId;
      acceptedExternalId ??= externalId;
      const matched = externalId === acceptedExternalId;
      return { ...readyCheck(request), ready: matched, externalIdMatched: matched };
    });
    const first = await inspectCandidateRepoAdmission(fixture, deps({ readCheckRun }));
    expect(first.judgeFreeEligible).toBe(true);

    const second = await inspectCandidateRepoAdmission(fixture, deps({
      readCheckRun,
      buildPolicyDigest: vi.fn(() => 'c'.repeat(64)),
    }));
    expect(second).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(second.remotePr.policyDigest).not.toBe(first.remotePr.policyDigest);
    expect(second.remotePr.expectedAttestationId).not.toBe(first.remotePr.expectedAttestationId);
    expect(second.remotePr.checkRun).toMatchObject({ ready: false, externalIdMatched: false });
  });

  it.each([
    ['completed in 2020', {
      workflowRun: { created_at: '2020-01-01T00:00:00Z', run_started_at: '2020-01-01T00:01:00Z', updated_at: '2020-01-01T00:06:00Z' },
      job: { started_at: '2020-01-01T00:02:00Z', completed_at: '2020-01-01T00:05:00Z' },
      workflowCheckRun: { started_at: '2020-01-01T00:02:00Z', completed_at: '2020-01-01T00:05:00Z' },
      attestationCheckRun: { started_at: '2020-01-01T00:07:00Z', completed_at: '2020-01-01T00:08:00Z' },
    }],
    ['missing timestamp', { attestationCheckRun: { completed_at: undefined } }],
    ['future-skewed timestamp', {
      workflowRun: { created_at: '2026-08-11T00:00:00Z', run_started_at: '2026-08-11T00:01:00Z', updated_at: '2026-08-11T00:06:00Z' },
      job: { started_at: '2026-08-11T00:02:00Z', completed_at: '2026-08-11T00:05:00Z' },
      workflowCheckRun: { started_at: '2026-08-11T00:02:00Z', completed_at: '2026-08-11T00:05:00Z' },
      attestationCheckRun: { started_at: '2026-08-11T00:07:00Z', completed_at: '2026-08-11T00:08:00Z' },
    }],
    ['order-inconsistent timestamp', { job: { started_at: '2026-08-10T11:55:00Z', completed_at: '2026-08-10T11:52:00Z' } }],
  ])('rejects %s check evidence', (_label, payload) => {
    const evidence = fakeGitHubCheckEvidence(payload);
    expect(evidence).toMatchObject({ available: true, ready: false, fresh: false });
    expect(evidence.detail).toMatch(/timestamps.*missing.*invalid.*future-skewed.*inconsistent.*expired/i);
  });

  it('never executes a candidate-controlled PATH gh or exposes GitHub credentials to it', () => {
    const fakeBin = join(fixture, 'node_modules', '.bin');
    const fakeGh = join(fakeBin, 'gh');
    const marker = join(home, 'candidate-gh-executed');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > ${JSON.stringify(marker)}\n`, 'utf8');
    chmodSync(fakeGh, 0o755);
    const priorPath = process.env['PATH'];
    const priorToken = process.env['GH_TOKEN'];
    process.env['PATH'] = fakeBin;
    process.env['GH_TOKEN'] = 'M489_PATH_CANARY';
    try {
      const evidence = readCandidateCheckRunEvidence(directCheckRequest());
      expect(evidence).toMatchObject({ available: false, ready: false });
      expect(evidence.detail).toMatch(/trusted GitHub executable custody is unavailable/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (priorPath === undefined) delete process.env['PATH']; else process.env['PATH'] = priorPath;
      if (priorToken === undefined) delete process.env['GH_TOKEN']; else process.env['GH_TOKEN'] = priorToken;
    }
  });

  it('collects later workflow-run pages before selecting the latest actual execution', () => {
    const request = directCheckRequest();
    const oldRuns = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      run_number: index + 1,
      run_attempt: 1,
      path: `${WORKFLOW}@main`,
      head_sha: request.head,
      head_branch: request.branch,
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-08-10T11:40:00Z',
      run_started_at: '2026-08-10T11:41:00Z',
      updated_at: '2026-08-10T11:59:00Z',
    }));
    const newerFailed = {
      id: 9999,
      run_number: 1,
      run_attempt: 2,
      path: `${WORKFLOW}@main`,
      head_sha: request.head,
      head_branch: request.branch,
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-08-10T11:40:00Z',
      run_started_at: '2026-08-10T11:58:00Z',
      updated_at: '2026-08-10T11:58:30Z',
    };
    const rows = [...oldRuns, newerFailed];
    const api: CandidateGithubApiReader = (endpoint) => {
      if (!endpoint.includes('/actions/workflows/')) return null;
      const page = Number(new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1)).get('page'));
      const start = (page - 1) * 100;
      return { total_count: rows.length, workflow_runs: rows.slice(start, start + 100) };
    };
    const evidence = readCandidateCheckRunEvidence(request, api);
    expect(evidence).toMatchObject({
      available: true,
      ready: false,
      workflowRunId: '9999',
      workflowRunNumber: 1,
      workflowRunAttempt: 2,
      conclusion: 'failure',
    });
  });

  it('treats a later-started failed execution as newer than an older success that completed later', () => {
    const evidence = fakeGitHubCheckEvidence({
      workflowRun: { updated_at: '2026-08-10T11:59:00Z' },
      extraWorkflowRuns: [{
        id: 40,
        run_number: 6,
        run_attempt: 2,
        path: `${WORKFLOW}@main`,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-08-10T11:40:00Z',
        run_started_at: '2026-08-10T11:58:00Z',
        updated_at: '2026-08-10T11:58:30Z',
      }],
    });
    expect(evidence).toMatchObject({
      available: true,
      ready: false,
      workflowRunId: '40',
      workflowRunNumber: 6,
      workflowRunAttempt: 2,
      conclusion: 'failure',
    });
  });

  it('binds API-realistic Actions attempt/job evidence separately from the dedicated App attestation', () => {
    expect(fakeGitHubCheckEvidence({})).toMatchObject({
      available: true,
      ready: true,
      workflowRunId: '41',
      workflowRunNumber: 7,
      workflowRunAttempt: 1,
      workflowJobId: '42',
      workflowCheckRunId: '43',
      workflowAppId: WORKFLOW_APP_ID,
      attestationCheck: ATTESTATION_CHECK,
      attestationCheckRunId: '44',
      appId: APP_ID,
      externalIdMatched: true,
      trustedPolicyDigest: TRUSTED_POLICY.digest,
      evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
      fresh: true,
    });
  });

  it('rejects an exact-head duplicate required context/App check from another workflow', () => {
    const evidence = fakeGitHubCheckEvidence({
      extraWorkflowCheckRuns: [{
        id: 45,
        name: CHECK,
        head_sha: 'a'.repeat(40),
        app: { id: Number(WORKFLOW_APP_ID) },
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-10T11:53:00Z',
        completed_at: '2026-08-10T11:56:00Z',
      }],
    });
    expect(evidence).toMatchObject({ available: false, ready: false });
    expect(evidence.detail).toMatch(/duplicate, cross-workflow, or uncorrelated/i);
  });

  it('rejects API evidence when candidate App 987654321 impersonates the pinned attestor', () => {
    const evidence = fakeGitHubCheckEvidence({
      attestationCheckRun: { app: { id: 987654321 } },
    });
    expect(evidence).toMatchObject({ available: false, ready: false, externalIdMatched: false });
    expect(evidence.detail).toMatch(/malformed or ambiguous exact-head evidence/i);
  });

  it.each([
    ['pending run', { id: 45, run_number: 8, run_attempt: 1, status: 'in_progress', conclusion: null }],
    ['failed rerun attempt', { id: 45, run_number: 7, run_attempt: 2, status: 'completed', conclusion: 'failure' }],
    ['cancelled rerun attempt', { id: 45, run_number: 7, run_attempt: 2, status: 'completed', conclusion: 'cancelled' }],
  ])('never falls back to an older success behind a newer exact-head %s', (_label, newer) => {
    const evidence = fakeGitHubCheckEvidence({
      extraWorkflowRuns: [{
        path: WORKFLOW,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        created_at: '2026-08-10T11:59:00Z',
        run_started_at: '2026-08-10T11:59:10Z',
        updated_at: '2026-08-10T11:59:20Z',
        ...newer,
      }],
    });
    expect(evidence).toMatchObject({ available: true, ready: false, workflowRunId: '45' });
    expect(evidence.detail).toMatch(/latest exact-head workflow execution is not successful/i);
  });

  it.each([
    ['running', 'in_progress', null],
    ['failed', 'completed', 'failure'],
    ['cancelled', 'completed', 'cancelled'],
  ])('lets a later %s rerun of an older run number supersede an earlier higher-number success', (
    _label,
    status,
    conclusion,
  ) => {
    const evidence = fakeGitHubCheckEvidence({
      workflowRun: { run_number: 8 },
      extraWorkflowRuns: [{
        id: 45,
        run_number: 7,
        run_attempt: 2,
        path: WORKFLOW,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        status,
        conclusion,
        created_at: '2026-08-10T11:40:00Z',
        run_started_at: '2026-08-10T11:59:00Z',
        updated_at: '2026-08-10T11:59:30Z',
      }],
    });
    expect(evidence).toMatchObject({
      available: true,
      ready: false,
      workflowRunId: '45',
      workflowRunNumber: 7,
      workflowRunAttempt: 2,
    });
  });

  it('fails closed when distinct executions share the latest activity chronology', () => {
    const evidence = fakeGitHubCheckEvidence({
      extraWorkflowRuns: [{
        id: 45,
        run_number: 8,
        run_attempt: 1,
        path: WORKFLOW,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-10T11:49:00Z',
        run_started_at: '2026-08-10T11:51:00Z',
        updated_at: '2026-08-10T11:56:00Z',
      }],
    });
    expect(evidence).toMatchObject({ available: false, ready: false });
    expect(evidence.detail).toMatch(/chronologically ambiguous/i);
  });

  it('rejects an ambiguous latest workflow attempt instead of selecting either success', () => {
    const evidence = fakeGitHubCheckEvidence({
      extraWorkflowRuns: [{
        id: 45,
        run_number: 7,
        run_attempt: 1,
        path: WORKFLOW,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-10T11:50:30Z',
        run_started_at: '2026-08-10T11:51:30Z',
        updated_at: '2026-08-10T11:56:30Z',
      }],
    });
    expect(evidence).toMatchObject({ available: false, ready: false });
    expect(evidence.detail).toMatch(/missing.*ambiguous/i);
  });

  it('does not fall back when a newer exact-head workflow row is missing attempt identity', () => {
    const evidence = fakeGitHubCheckEvidence({
      extraWorkflowRuns: [{
        id: 45,
        run_number: 8,
        path: WORKFLOW,
        head_sha: 'a'.repeat(40),
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-10T11:59:00Z',
      }],
    });
    expect(evidence).toMatchObject({ available: false, ready: false });
    expect(evidence.detail).toMatch(/missing.*ambiguous/i);
  });

  it.each([
    ['pending', 'in_progress', null, null],
    ['failed', 'completed', 'failure', '2026-08-10T11:59:30Z'],
    ['cancelled', 'completed', 'cancelled', '2026-08-10T11:59:30Z'],
  ])('does not accept an older attestation when the newer trusted-App check is %s', (_label, status, conclusion, completedAt) => {
    const evidence = fakeGitHubCheckEvidence({
      extraAttestationCheckRuns: [{
        id: 45,
        name: ATTESTATION_CHECK,
        head_sha: 'a'.repeat(40),
        app: { id: Number(APP_ID) },
        status,
        conclusion,
        started_at: '2026-08-10T11:59:00Z',
        completed_at: completedAt,
        external_id: null,
      }],
    });
    expect(evidence).toMatchObject({ available: true, ready: false, attestationCheckRunId: '45' });
    expect(evidence.externalIdMatched).toBe(false);
  });

  it('does not accept an older attestation when newer exact-head check identity is missing', () => {
    const evidence = fakeGitHubCheckEvidence({
      extraAttestationCheckRuns: [{
        name: ATTESTATION_CHECK,
        head_sha: 'a'.repeat(40),
        app: { id: Number(APP_ID) },
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-10T11:59:00Z',
        completed_at: '2026-08-10T11:59:30Z',
        external_id: directCheckRequest().expectedAttestations[0]!.externalId,
      }],
    });
    expect(evidence).toMatchObject({ available: false, ready: false });
    expect(evidence.detail).toMatch(/unavailable|missing or ambiguous/i);
  });

  it('refuses stale protected-base evidence even when the declared check claims success', async () => {
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readProtection: vi.fn(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner, {
        baseHead: 'a'.repeat(40),
      })),
    }));
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.remotePr).toMatchObject({ ready: false, baseHead: 'a'.repeat(40) });
    expect(report.remotePr.detail).toMatch(/identity\/base/i);
  });

  it('refuses when the remote default head changes after check collection', async () => {
    const original = git(['rev-parse', 'HEAD']);
    const readRemoteHead = vi.fn()
      .mockReturnValueOnce({ available: true, nameWithOwner: 'ashlrai/candidate', defaultBranch: 'main', head: original, detail: 'first' })
      .mockReturnValueOnce({ available: true, nameWithOwner: 'ashlrai/candidate', defaultBranch: 'main', head: 'a'.repeat(40), detail: 'second' });
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readRemoteHead }));
    expect(readRemoteHead).toHaveBeenCalledTimes(2);
    expect(report.remotePr).toMatchObject({ ready: false, remoteStableAfterChecks: false });
    expect(report.remotePr.detail).toMatch(/changed during check collection/i);
  });

  it('refuses when protected policy changes after check collection', async () => {
    const readProtection = vi.fn()
      .mockImplementationOnce(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner))
      .mockImplementationOnce(async (_cwd, _branch, options) => protection(options.expectedNameWithOwner, {
        requiredChecks: [CHECK, 'security'],
        requiredCheckBindings: [
          { context: CHECK, appId: WORKFLOW_APP_ID },
          { context: 'security', appId: WORKFLOW_APP_ID },
        ],
      }));
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readProtection }));
    expect(readProtection).toHaveBeenCalledTimes(2);
    expect(report.remotePr).toMatchObject({ ready: false, remoteStableAfterChecks: false });
    expect(report.remotePr.detail).toMatch(/changed during check collection/i);
  });

  it('pins every initial and final protected-policy read outside the candidate root', async () => {
    const readProtection = vi.fn(async (_cwd, _branch, options) => {
      expect(options).toMatchObject({
        forceFresh: true,
        expectedNameWithOwner: 'ashlrai/candidate',
        trustedGithubCli: TRUSTED_GH_PIN,
        untrustedRoots: [realpathSync(fixture)],
      });
      return protection(options.expectedNameWithOwner);
    });
    const readRemoteHead = vi.fn((nameWithOwner, candidateRoot, trustedGithubCli) => {
      expect(candidateRoot).toBe(realpathSync(fixture));
      expect(trustedGithubCli).toEqual(TRUSTED_GH_PIN);
      return {
        available: true,
        nameWithOwner,
        defaultBranch: 'main',
        head: git(['rev-parse', 'HEAD']),
        detail: 'exact remote head',
      };
    });
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readProtection, readRemoteHead }));
    expect(report.remotePr.ready).toBe(true);
    expect(readProtection).toHaveBeenCalledTimes(2);
    expect(readRemoteHead).toHaveBeenCalledTimes(2);
  });

  it('captures final local mutation evidence before the last remote and operator-policy authority reads', async () => {
    const readme = join(fixture, 'README.md');
    const original = readFileSync(readme);
    const authority = {
      state: 'verified' as const,
      path: join(home, 'policy.json'),
      value: TRUSTED_POLICY_INPUT,
      proof: AUTHORITY_PROOF,
      detail: 'stable fixture authority',
    };
    const readTrustedPolicy = vi.fn()
      .mockReturnValueOnce(authority)
      .mockImplementationOnce(() => {
        writeFileSync(readme, original);
        return authority;
      });
    const readCheckRun = vi.fn((request) => {
      writeFileSync(readme, '# transient candidate mutation\n', 'utf8');
      return readyCheck(request);
    });
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readTrustedPolicy, readCheckRun }));
    expect(readTrustedPolicy).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      admissionReady: false,
      verdict: 'blocked',
      source: { mutationProof: { repoBytesUnchanged: false } },
      remotePr: {
        remoteStableAfterChecks: true,
        trustedPolicyStableAfterChecks: true,
      },
    });
  });

  it.each([
    ['identity', AUTHORITY_PROOF, TRUSTED_POLICY_INPUT],
    ['digest', AUTHORITY_PROOF, { ...TRUSTED_POLICY_INPUT, evidenceMaxAgeMs: 31 * 60_000 }],
  ])('rereads and rejects operator policy %s drift immediately before verdict', async (
    drift,
    initialProof,
    finalPolicy,
  ) => {
    const readTrustedPolicy = vi.fn()
      .mockReturnValueOnce({
        state: 'verified',
        path: join(home, 'policy.json'),
        value: TRUSTED_POLICY_INPUT,
        proof: initialProof,
        detail: 'initial',
      })
      .mockReturnValueOnce({
        state: 'verified',
        path: join(home, 'policy.json'),
        value: finalPolicy,
        proof: drift === 'identity' ? 'a'.repeat(64) : initialProof,
        detail: 'final',
      });
    const report = await inspectCandidateRepoAdmission(fixture, deps({ readTrustedPolicy }));
    expect(readTrustedPolicy).toHaveBeenCalledTimes(2);
    expect(report.remotePr).toMatchObject({
      ready: false,
      remoteStableAfterChecks: true,
      trustedPolicyStableAfterChecks: false,
      checkRun: { ready: true },
    });
    expect(report.remotePr.detail).toMatch(/operator signer policy identity or digest changed/i);
  });

  it.each([
    ['pending', 'in_progress', null],
    ['failed', 'completed', 'failure'],
    ['cancelled', 'completed', 'cancelled'],
  ])('final authority recheck rejects a newer exact-head %s rerun race', async (_label, status, conclusion) => {
    let finalPhase = false;
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => readCandidateCheckRunEvidence(
      request,
      fakeGitHubApi(finalPhase ? {
        extraWorkflowRuns: [{
          id: 45,
          run_number: 7,
          run_attempt: 2,
          path: `${WORKFLOW}@main`,
          head_sha: request.head,
          head_branch: request.branch,
          status,
          conclusion,
          created_at: '2026-08-10T11:58:00Z',
          run_started_at: '2026-08-10T11:59:00Z',
          updated_at: '2026-08-10T11:59:30Z',
        }],
      } : {}, request),
    ));
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readCheckRun,
      beforeFinalEvidenceRecheck: () => { finalPhase = true; },
    }));
    expect(readCheckRun).toHaveBeenCalledTimes(2);
    expect(report.remotePr).toMatchObject({
      ready: false,
      checkEvidenceStableAfterRecheck: false,
      checkRun: { ready: false, workflowRunId: '45', status, conclusion },
    });
    expect(report.remotePr.detail).toMatch(/changed during final evidence recheck/i);
  });

  it.each([
    ['workflow run', { workflowRun: { display_title: 'changed after first collection' } }],
    ['attempt job', { job: { runner_name: 'changed after first collection' } }],
    ['required check', { workflowCheckRun: { details_url: 'https://example.invalid/changed' } }],
    ['attestation', { attestationCheckRun: { details_url: 'https://example.invalid/changed' } }],
  ])('final authority recheck canonically rejects changed correlated %s content', async (_label, changed) => {
    let finalPhase = false;
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => readCandidateCheckRunEvidence(
      request,
      fakeGitHubApi(finalPhase ? changed : {}, request),
    ));
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readCheckRun,
      beforeFinalEvidenceRecheck: () => { finalPhase = true; },
    }));
    expect(report.remotePr).toMatchObject({
      ready: false,
      checkEvidenceStableAfterRecheck: false,
      checkRun: { ready: true },
    });
    expect(report.remotePr.detail).toMatch(/changed during final evidence recheck/i);
  });

  it('final authority recheck rejects changed pagination/content even when the selected verdict summary is unchanged', async () => {
    let finalPhase = false;
    const olderAttestations = Array.from({ length: 100 }, (_, index) => ({
      id: 1_000 + index,
      name: ATTESTATION_CHECK,
      head_sha: git(['rev-parse', 'HEAD']),
      app: { id: Number(APP_ID) },
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-08-10T11:40:00Z',
      completed_at: '2026-08-10T11:41:00Z',
      external_id: null,
    }));
    const readCheckRun = vi.fn((request: CandidateCheckRunRequest) => readCandidateCheckRunEvidence(
      request,
      fakeGitHubApi(finalPhase ? { extraAttestationCheckRuns: olderAttestations } : {}, request),
    ));
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readCheckRun,
      beforeFinalEvidenceRecheck: () => { finalPhase = true; },
    }));
    expect(readCheckRun).toHaveBeenCalledTimes(2);
    expect(report.remotePr).toMatchObject({
      ready: false,
      checkEvidenceStableAfterRecheck: false,
      checkRun: { ready: true, attestationCheckRunId: '44' },
    });
    expect(report.remotePr.checkRun.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.remotePr.detail).toMatch(/changed during final evidence recheck/i);
  });

  it('prohibits self-target judge-free evidence even when every external check is strong', async () => {
    git(['remote', 'set-url', 'origin', 'https://github.com/ashlrai/ashlr-hub.git']);
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.risk).toMatchObject({ selfTarget: true, restricted: true });
    expect(report.autonomyBlockers.map((item) => item.id)).toContain('self-target-prohibited');
  });

  it('never treats renamed sensitive paths or the absence of filename matches as positive risk evidence', async () => {
    mkdirSync(join(fixture, 'src', 'auth'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'auth', 'tokens.ts'), 'export const classification = "regulated";\n', 'utf8');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'sensitive path']);
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true });
    git(['mv', 'src/auth/tokens.ts', 'src/core/data.ts']);
    rmSync(join(fixture, 'ashlr.admission.json'));
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'rename and remove risk declaration']);

    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.risk).toMatchObject({
      state: 'missing',
      restricted: true,
      filenameHeuristicsUsed: false,
      classification: null,
    });
    expect(report.autonomyBlockers.map((item) => item.id)).toContain('risk-classification-unattested');
  });

  it('fails closed for a declared sensitive classification even with its exact check attestation', async () => {
    writeAdmission('regulated');
    git(['add', 'ashlr.admission.json']);
    git(['commit', '--quiet', '-m', 'regulated classification']);
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report).toMatchObject({ admissionReady: true, judgeFreeEligible: false, verdict: 'proposal-only' });
    expect(report.risk).toMatchObject({ state: 'attested', classification: 'regulated', restricted: true });
    expect(report.autonomyBlockers.map((item) => item.id)).toContain('risk-classification-restricted');
  });

  it('fails closed when enrollment authority is degraded and never persists raw control content', async () => {
    writeFileSync(join(fixture, 'private.txt'), 'TOP_SECRET_VALUE\n', 'utf8');
    git(['add', 'private.txt']);
    git(['commit', '--quiet', '-m', 'private fixture']);
    const report = await inspectCandidateRepoAdmission(fixture, deps({
      readEnrollment: () => ({ state: 'degraded', reason: 'malformed-registry' }),
    }));
    const serialized = JSON.stringify(report);
    expect(report.admissionBlockers.map((item) => item.id)).toContain('enrollment-registry-degraded');
    expect(serialized).not.toContain('TOP_SECRET_VALUE');
    expect(serialized).not.toContain('npm test');
    expect(serialized).not.toContain(readFileSync(join(fixture, 'ashlr.verify.json'), 'utf8'));
  });

  it('redacts malformed verifier JSON without returning parser snippets or input bytes', async () => {
    const marker = 'TOP_SECRET_VERIFIER_BYTES';
    writeFileSync(join(fixture, 'ashlr.verify.json'), marker, 'utf8');
    git(['add', 'ashlr.verify.json']);
    git(['commit', '--quiet', '-m', 'malformed private verifier']);
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report.verifier).toMatchObject({
      contractValid: false,
      detail: 'invalid ashlr.verify.json: invalid-json',
    });
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(JSON.stringify(report)).not.toContain('Unexpected token');
  });

  it('preserves #238 goal materialization behind downstream enrollment authority with no preflight consumer', async () => {
    const candidateSource = readFileSync(join(process.cwd(), 'src/core/portfolio/candidate-admission.ts'), 'utf8');
    const strategistSource = readFileSync(join(process.cwd(), 'src/core/vision/strategist.ts'), 'utf8');
    expect(candidateSource).not.toMatch(/vision\/strategist|goals\/store|adoptBriefing|createGoalIfAbsent/);
    expect(strategistSource).toContain("const enrollment = (await import('../sandbox/policy.js')).readEnrollmentRegistry();");
    expect(strategistSource).toContain('enrolledRepos = enrollment.repos;');
    expect(strategistSource.indexOf("if (entry.disposition !== 'create')"))
      .toBeLessThan(strategistSource.indexOf('createGoalIfAbsent(entry.objective'));

    const before = repositoryDigest();
    const report = await inspectCandidateRepoAdmission(fixture, deps());
    expect(report).toMatchObject({ readOnly: true, authorityGranted: false, mutationPerformed: false });
    expect(repositoryDigest()).toBe(before);
  });
});
