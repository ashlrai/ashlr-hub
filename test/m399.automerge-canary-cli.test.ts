import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inputTrustRace = vi.hoisted(() => ({
  beforeActivationOpen: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  duringActivationRead: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  foreignOwnerPath: undefined as string | undefined,
  openedActivationPath: '',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync(file: import('node:fs').PathLike, ...args: unknown[]) {
      const stat = (actual.lstatSync as (...params: unknown[]) => import('node:fs').Stats)(file, ...args);
      if (inputTrustRace.foreignOwnerPath === String(file)) {
        Object.defineProperty(stat, 'uid', {
          configurable: true,
          value: typeof stat.uid === 'bigint' ? stat.uid + 1n : stat.uid + 1,
        });
      }
      return stat;
    },
    openSync(file: import('node:fs').PathLike, ...args: unknown[]) {
      if (inputTrustRace.beforeActivationOpen && String(file).endsWith('.json')) {
        const hook = inputTrustRace.beforeActivationOpen;
        inputTrustRace.beforeActivationOpen = undefined;
        hook(String(file), actual);
      }
      const descriptor = (actual.openSync as (...params: unknown[]) => number)(file, ...args);
      if (String(file).endsWith('.json')) inputTrustRace.openedActivationPath = String(file);
      return descriptor;
    },
    readSync(descriptor: number, ...args: unknown[]) {
      if (inputTrustRace.duringActivationRead && inputTrustRace.openedActivationPath) {
        const hook = inputTrustRace.duringActivationRead;
        inputTrustRace.duringActivationRead = undefined;
        hook(inputTrustRace.openedActivationPath, actual);
      }
      return (actual.readSync as (...params: unknown[]) => number)(descriptor, ...args);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTOMERGE_CANARY_MAX_ACTIVATION_INPUT_BYTES,
  cmdAutoMergeCanary,
  formatAutoMergeCanaryStatus,
  projectAutoMergeCanaryStatus,
} from '../src/cli/automerge-canary.js';
import { cmdFleet } from '../src/cli/fleet.js';
import {
  automergeCanaryStatus,
  automergeCanaryStoreDirectory,
  type AutoMergeCanaryActivationInput,
  type AutoMergeCanaryReadResult,
  type AutoMergeCanaryStateV1,
} from '../src/core/fleet/automerge-canary-store.js';

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

interface PreparedRepo {
  repo: string;
  baseOid: string;
  headOid: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function activationInput(mode?: 'shadow' | 'enforce'): AutoMergeCanaryActivationInput {
  return {
    ...(mode ? { mode } : {}),
    repository: {
      repositoryId: digest('owner/repository'),
      fetchDestinationDigest: digest('fetch'),
      pushDestinationDigest: digest('push'),
      baseRefDigest: digest('refs/heads/master'),
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
    },
    policyDigest: digest('policy'),
    configDigest: digest('config'),
    classifierDigest: digest('classifier'),
    pathDigest: digest('docs/readme.md'),
    budgets: {
      maxAdmissions: 1,
      maxMerges: 1,
      maxInFlight: 1,
      minMergeIntervalMs: 24 * 60 * 60 * 1_000,
      leaseDurationMs: 10 * 60 * 1_000,
      observationDurationMs: 7 * 24 * 60 * 60 * 1_000,
    },
  };
}

function observedState(): AutoMergeCanaryStateV1 {
  return {
    schemaVersion: 1,
    epochId: '11111111-1111-4111-8111-111111111111',
    revision: 5,
    previousAttestation: digest('previous'),
    mode: 'shadow',
    state: 'shadow',
    repository: {
      repositoryId: digest('private-repository'),
      fetchDestinationDigest: digest('private-fetch'),
      pushDestinationDigest: digest('private-push'),
      baseRefDigest: digest('private-base-ref'),
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
    },
    policyDigest: digest('private-policy'),
    configDigest: digest('private-config'),
    classifierDigest: digest('private-classifier'),
    pathDigest: digest('private-paths'),
    budgets: {
      maxAdmissions: 1,
      maxMerges: 1,
      maxInFlight: 1,
      minMergeIntervalMs: 86_400_000,
      leaseDurationMs: 600_000,
      observationDurationMs: 7_200_000,
    },
    counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
    shadowCounters: {
      attempts: 4,
      eligible: 2,
      rejected: 1,
      bindingMismatches: 1,
      inspectionErrors: 0,
      casRetries: 1,
    },
    lastShadowEvidence: {
      observationDigest: digest('private-observation'),
      observedAt: '2026-07-14T12:15:00.000Z',
      outcome: 'binding-mismatch',
      mismatchFields: ['baseOid'],
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
      treeOid: 'c'.repeat(40),
      fileCount: 3,
      lineCount: 21,
      reasonDigest: digest('private-reason'),
      pathDigest: digest('private-paths'),
    },
    lease: { holderDigest: null, acquiredAt: null, expiresAt: null },
    observation: {
      startedAt: '2026-07-14T12:00:00.000Z',
      deadlineAt: '2026-07-14T13:00:00.000Z',
      completedAt: null,
    },
    activatedAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T12:15:00.000Z',
    clockHighWater: '2026-07-14T12:15:00.000Z',
    pendingEffect: null,
    blocker: null,
    attestation: digest('private-attestation'),
  };
}

function inputFile(value: unknown, name = 'activation.json'): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function prepareConfig(): void {
  const configDir = path.join(home, '.ashlr');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    foundry: {
      autoMerge: {
        enabled: false,
        allowSelfMerge: false,
        allowWithoutVerification: false,
        pushToRemote: true,
        trustBasis: 'verification',
      },
    },
  }), { mode: 0o600 });
}

function preparedRepo(): PreparedRepo {
  const repo = path.join(fs.realpathSync(home), 'prepared-repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Ashlr Test']);
  git(repo, ['config', 'user.email', 'ashlr-test@example.com']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  const baseOid = git(repo, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n\nPrepared safely.\n');
  git(repo, ['add', 'docs/guide.md']);
  git(repo, ['commit', '-m', 'docs']);
  const headOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/ashlrai/prepare-shadow-fixture.git']);
  return { repo, baseOid, headOid };
}

function preparationArgs(repo: PreparedRepo): string[] {
  return [
    'prepare-shadow',
    '--repo', repo.repo,
    '--base-ref', 'main',
    '--base-oid', repo.baseOid,
    '--head-oid', repo.headOid,
    '--json',
  ];
}

async function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const error = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { code: await cmdAutoMergeCanary(args), stdout, stderr };
  } finally {
    out.mockRestore();
    error.mockRestore();
  }
}

async function captureFleet(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const error = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { code: await cmdFleet(args), stdout, stderr };
  } finally {
    out.mockRestore();
    error.mockRestore();
  }
}

function revisionFiles(): string[] {
  if (!fs.existsSync(automergeCanaryStoreDirectory())) return [];
  return fs.readdirSync(automergeCanaryStoreDirectory())
    .filter((name) => name.startsWith('.epoch-v1-'))
    .sort()
    .map((name) => path.join(automergeCanaryStoreDirectory(), name));
}

function summaryFiles(): string[] {
  if (!fs.existsSync(automergeCanaryStoreDirectory())) return [];
  return fs.readdirSync(automergeCanaryStoreDirectory())
    .filter((name) => name.startsWith('.terminal-v1-'))
    .sort()
    .map((name) => path.join(automergeCanaryStoreDirectory(), name));
}

beforeEach(() => {
  inputTrustRace.beforeActivationOpen = undefined;
  inputTrustRace.duringActivationRead = undefined;
  inputTrustRace.foreignOwnerPath = undefined;
  inputTrustRace.openedActivationPath = '';
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m399-canary-cli-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
});

afterEach(() => {
  inputTrustRace.beforeActivationOpen = undefined;
  inputTrustRace.duringActivationRead = undefined;
  inputTrustRace.foreignOwnerPath = undefined;
  inputTrustRace.openedActivationPath = '';
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
});

describe('auto-merge canary CLI status', () => {
  it('projects and formats status purely with the observation-only boundary', () => {
    const read: AutoMergeCanaryReadResult = {
      enforceSupported: false,
      sourceState: 'missing',
      severity: 'none',
      status: 'inactive',
      active: false,
      state: null,
      revisions: [],
      terminalEpochs: [],
      diagnostics: [],
      limitExceeded: false,
    };
    const before = JSON.stringify(read);

    expect(projectAutoMergeCanaryStatus(read)).toEqual({
      schemaVersion: 1,
      authority: 'observation-only',
      policyEligible: false,
      enforceSupported: false,
      hostCancellationProven: false,
      sourceState: 'missing',
      severity: 'none',
      status: 'inactive',
      active: false,
      state: null,
      telemetry: {
        shadowCounters: null,
        outcomeRates: {
          eligible: null,
          rejected: null,
          bindingMismatch: null,
          inspectionError: null,
        },
        casRetries: null,
        revisionCapacity: {
          maximum: 64, used: null, remaining: null,
          reservedForTerminal: 1, observationWritesRemaining: null,
        },
        epochAgeMs: null,
        observationDeadlineRemainingMs: null,
        lastShadowEvidence: null,
      },
      diagnostics: [],
      limitExceeded: false,
    });
    expect(JSON.parse(formatAutoMergeCanaryStatus(read, true))).toMatchObject({
      authority: 'observation-only', policyEligible: false, hostCancellationProven: false,
    });
    expect(formatAutoMergeCanaryStatus(read)).toContain('auto-merge canary: inactive (missing)');
    expect(formatAutoMergeCanaryStatus(read)).toContain('shadow soak: unknown');
    expect(JSON.stringify(read)).toBe(before);
  });

  it('shows bounded authenticated soak telemetry without exposing authority digests or commit ids', () => {
    const state = observedState();
    const read: AutoMergeCanaryReadResult = {
      enforceSupported: false,
      sourceState: 'healthy',
      severity: 'none',
      status: 'shadow',
      active: true,
      state,
      revisions: [state],
      terminalEpochs: [],
      diagnostics: [],
      limitExceeded: false,
    };
    const before = JSON.stringify(read);
    const now = new Date('2026-07-14T12:30:00.000Z');
    const projected = projectAutoMergeCanaryStatus(read, now);

    expect(projected.telemetry).toEqual({
      shadowCounters: {
        attempts: 4,
        eligible: 2,
        rejected: 1,
        bindingMismatches: 1,
        inspectionErrors: 0,
        casRetries: 1,
      },
      outcomeRates: {
        eligible: 0.5,
        rejected: 0.25,
        bindingMismatch: 0.25,
        inspectionError: 0,
      },
      casRetries: 1,
      revisionCapacity: {
        maximum: 64, used: 5, remaining: 59,
        reservedForTerminal: 1, observationWritesRemaining: 58,
      },
      epochAgeMs: 5_400_000,
      observationDeadlineRemainingMs: 1_800_000,
      lastShadowEvidence: {
        observedAt: '2026-07-14T12:15:00.000Z',
        outcome: 'binding-mismatch',
        mismatchFields: ['baseOid'],
        fileCount: 3,
        lineCount: 21,
      },
    });
    const serialized = JSON.stringify(projected);
    for (const secret of [
      state.repository.repositoryId,
      state.repository.baseOid,
      state.repository.headOid,
      state.policyDigest,
      state.configDigest,
      state.classifierDigest,
      state.pathDigest,
      state.attestation,
      state.lastShadowEvidence!.observationDigest,
      state.lastShadowEvidence!.reasonDigest,
    ]) expect(serialized).not.toContain(secret);
    expect(projected.state).not.toHaveProperty('repository');
    expect(projected.state).not.toHaveProperty('attestation');
    expect(formatAutoMergeCanaryStatus(read, false, now)).toContain(
      'shadow soak: 4 attempt(s); eligible 2 (50.0%); rejected 1 (25.0%)',
    );
    expect(formatAutoMergeCanaryStatus(read, false, now)).toContain('CAS retries 1');
    expect(JSON.stringify(read)).toBe(before);
  });

  it('keeps rates null for a healthy epoch with no attempts', async () => {
    expect((await capture(['activate-shadow', '--input', inputFile(activationInput())])).code).toBe(0);
    const projected = projectAutoMergeCanaryStatus(automergeCanaryStatus());

    expect(projected.telemetry.shadowCounters).toMatchObject({ attempts: 0, casRetries: 0 });
    expect(projected.telemetry.outcomeRates).toEqual({
      eligible: null,
      rejected: null,
      bindingMismatch: null,
      inspectionError: null,
    });
  });

  it('refuses to project state or soak values from a degraded source', () => {
    const state = observedState();
    const projected = projectAutoMergeCanaryStatus({
      enforceSupported: false,
      sourceState: 'degraded',
      severity: 'critical',
      status: 'critical',
      active: false,
      state,
      revisions: [state],
      terminalEpochs: [],
      diagnostics: ['invalid-record'],
      limitExceeded: false,
    }, new Date('2026-07-14T12:30:00.000Z'));

    expect(projected.state).toBeNull();
    expect(projected.telemetry).toMatchObject({
      shadowCounters: null,
      outcomeRates: {
        eligible: null,
        rejected: null,
        bindingMismatch: null,
        inspectionError: null,
      },
      casRetries: null,
      revisionCapacity: {
        used: null, remaining: null,
        reservedForTerminal: 1, observationWritesRemaining: null,
      },
      epochAgeMs: null,
      observationDeadlineRemainingMs: null,
      lastShadowEvidence: null,
    });
  });

  it('keeps missing status filesystem-pure and returns one concise JSON object', async () => {
    const before = fs.readdirSync(home);
    const result = await capture(['status', '--json']);
    const after = fs.readdirSync(home);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      enforceSupported: false,
      hostCancellationProven: false,
      sourceState: 'missing',
      status: 'inactive',
      active: false,
      state: null,
    });
    expect(after).toEqual(before);
    expect(fs.existsSync(process.env.ASHLR_HOME!)).toBe(false);
  });

  it('is reachable through the nested fleet command without loading fleet config', async () => {
    const result = await captureFleet(['automerge-canary', 'status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      authority: 'observation-only', sourceState: 'missing', status: 'inactive',
    });
    expect(fs.existsSync(process.env.ASHLR_HOME!)).toBe(false);
  });

  it('returns code 1 for degraded status without mutating the damaged store', async () => {
    expect((await capture(['activate-shadow', '--input', inputFile(activationInput())])).code).toBe(0);
    const revision = revisionFiles()[0]!;
    fs.appendFileSync(revision, 'tamper');
    const before = fs.readFileSync(revision);

    const result = await capture(['status', '--json']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sourceState: 'degraded', severity: 'critical', status: 'critical',
      telemetry: {
        shadowCounters: null,
        outcomeRates: { eligible: null, rejected: null },
        casRetries: null,
      },
    });
    expect(fs.readFileSync(revision)).toEqual(before);
  });
});

describe('auto-merge canary CLI activation', () => {
  it('prepares deterministically from in-memory defaults without seeding config or controller state', async () => {
    const fixture = preparedRepo();
    const configDir = path.join(home, '.ashlr');
    expect(fs.existsSync(configDir)).toBe(false);

    const first = await capture(preparationArgs(fixture));
    const second = await capture(preparationArgs(fixture));

    expect(first.code).toBe(0);
    expect(second).toEqual(first);
    expect(fs.existsSync(configDir)).toBe(false);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('prepares one strict activation object that activate-shadow consumes unchanged', async () => {
    prepareConfig();
    const fixture = preparedRepo();
    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const beforeStatus = git(fixture.repo, ['status', '--porcelain=v1']);
    const beforeState = fs.readdirSync(path.join(home, '.ashlr')).sort();

    const prepared = await capture(preparationArgs(fixture));
    const activation = JSON.parse(prepared.stdout) as AutoMergeCanaryActivationInput;
    const preparedWithoutJsonFlag = await capture(preparationArgs(fixture).slice(0, -1));

    expect(prepared.code).toBe(0);
    expect(prepared.stderr).toBe('');
    expect(preparedWithoutJsonFlag).toEqual({ code: 0, stdout: prepared.stdout, stderr: '' });
    expect(activation).toEqual({
      mode: 'shadow',
      repository: {
        repositoryId: expect.stringMatching(/^[a-f0-9]{64}$/),
        fetchDestinationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        pushDestinationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        baseRefDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        baseOid: fixture.baseOid,
        headOid: fixture.headOid,
      },
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      classifierDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      pathDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      budgets: {
        maxAdmissions: 1,
        maxMerges: 1,
        maxInFlight: 1,
        minMergeIntervalMs: 86_400_000,
        leaseDurationMs: 600_000,
        observationDurationMs: 604_800_000,
      },
    });
    expect(prepared.stdout).not.toContain(fixture.repo);
    expect(prepared.stdout).not.toContain('github.com');
    expect(fs.readdirSync(path.join(home, '.ashlr')).sort()).toEqual(beforeState);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(fixture.repo, ['status', '--porcelain=v1'])).toBe(beforeStatus);

    const activationPath = path.join(home, 'prepared-activation.json');
    fs.writeFileSync(activationPath, prepared.stdout, { mode: 0o600 });
    const activated = await capture(['activate-shadow', '--input', activationPath, '--json']);
    expect(activated.code, JSON.stringify(activated)).toBe(0);
  });

  it('rejects noncanonical, symbolic, mutable, malformed, duplicate, and unknown preparation inputs', async () => {
    prepareConfig();
    const fixture = preparedRepo();
    const cases = [
      preparationArgs({ ...fixture, repo: path.relative(process.cwd(), fixture.repo) }),
      [...preparationArgs(fixture).slice(0, -1), '--base-ref', 'other'],
      [...preparationArgs(fixture).slice(0, 4), 'HEAD', ...preparationArgs(fixture).slice(5)],
      [...preparationArgs(fixture).slice(0, 6), fixture.baseOid.toUpperCase(), ...preparationArgs(fixture).slice(7)],
      [...preparationArgs(fixture), '--unknown'],
    ];
    if (process.platform !== 'win32') {
      const linked = path.join(fs.realpathSync(home), 'linked-repo');
      fs.symlinkSync(fixture.repo, linked, 'dir');
      cases.push(preparationArgs({ ...fixture, repo: linked }));
    }

    for (const args of cases) {
      const result = await capture(args);
      expect(result.code, args.join(' ')).toBe(2);
    }
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('fails closed when bindings cannot be derived without mutating config, canary state, or repo', async () => {
    prepareConfig();
    const repo = path.join(fs.realpathSync(home), 'not-a-git-repo');
    fs.mkdirSync(repo);
    const configPath = path.join(home, '.ashlr', 'config.json');
    const beforeConfig = fs.readFileSync(configPath);
    const beforeRepo = fs.readdirSync(repo);

    const result = await capture([
      'prepare-shadow', '--repo', repo, '--base-ref', 'main',
      '--base-oid', 'a'.repeat(40), '--head-oid', 'b'.repeat(40), '--json',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      action: 'prepare-shadow',
      reason: 'binding-derivation-failed',
      authority: 'observation-only',
    });
    expect(fs.readFileSync(configPath)).toEqual(beforeConfig);
    expect(fs.readdirSync(repo)).toEqual(beforeRepo);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('activates shadow mode from one bounded strict JSON file using the store API', async () => {
    const input = activationInput();
    const result = await capture(['activate-shadow', '--input', inputFile(input), '--json']);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toMatchObject({
      ok: true,
      action: 'activate-shadow',
      changed: true,
      authority: 'observation-only',
      policyEligible: false,
      enforceSupported: false,
      hostCancellationProven: false,
      sourceState: 'healthy',
      status: 'shadow',
      active: true,
      state: { revision: 1, mode: 'shadow', state: 'shadow' },
    });
    expect(automergeCanaryStatus()).toMatchObject({
      sourceState: 'healthy', status: 'shadow', active: true,
    });
    expect(result.stdout).not.toContain(input.repository.repositoryId);
    expect(result.stdout).not.toContain(input.policyDigest);
  });

  it('rejects malformed, oversized, linked, and schema-invalid input before activation', async () => {
    const malformed = path.join(home, 'malformed.json');
    fs.writeFileSync(malformed, '{', { mode: 0o600 });
    expect((await capture(['activate-shadow', '--input', malformed])).code).toBe(2);

    const oversized = path.join(home, 'oversized.json');
    fs.writeFileSync(oversized, Buffer.alloc(AUTOMERGE_CANARY_MAX_ACTIVATION_INPUT_BYTES + 1, 0x20));
    expect((await capture(['activate-shadow', '--input', oversized])).code).toBe(2);

    if (process.platform !== 'win32') {
      const target = inputFile(activationInput(), 'target.json');
      const linked = path.join(home, 'linked.json');
      fs.symlinkSync(target, linked);
      expect((await capture(['activate-shadow', '--input', linked])).code).toBe(2);
    }

    const invalid = { ...activationInput(), unexpected: true };
    expect((await capture(['activate-shadow', '--input', inputFile(invalid, 'invalid.json')])).code).toBe(2);
    expect(automergeCanaryStatus().status).toBe('inactive');
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects input not owned by the current user', async () => {
    const input = inputFile(activationInput(), 'foreign-owner.json');
    inputTrustRace.foreignOwnerPath = input;

    const result = await capture(['activate-shadow', '--input', input, '--json']);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      action: 'activate-shadow',
      reason: 'input must be a private current-user regular file with one link',
    });
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects group or world permissions on activation input', async () => {
    const readable = inputFile(activationInput(), 'group-readable.json');
    fs.chmodSync(readable, 0o640);
    expect((await capture(['activate-shadow', '--input', readable])).code).toBe(2);

    const writable = inputFile(activationInput(), 'world-writable.json');
    fs.chmodSync(writable, 0o602);
    expect((await capture(['activate-shadow', '--input', writable])).code).toBe(2);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('rejects multiply linked activation input', async () => {
    const input = inputFile(activationInput(), 'hard-linked.json');
    fs.linkSync(input, path.join(home, 'second-link.json'));

    expect((await capture(['activate-shadow', '--input', input])).code).toBe(2);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects writable ancestors between input and home anchor', async () => {
    const directory = path.join(home, 'operator', 'prepared');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const input = path.join(directory, 'activation.json');
    fs.writeFileSync(input, JSON.stringify(activationInput()), { mode: 0o600 });
    fs.chmodSync(path.join(home, 'operator'), 0o770);

    expect((await capture(['activate-shadow', '--input', input])).code).toBe(2);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('rejects same-size replacement between path inspection and descriptor open', async () => {
    const input = inputFile(activationInput(), 'replace-at-open.json');
    const replacement = inputFile(activationInput(), 'replacement.json');
    inputTrustRace.beforeActivationOpen = (openedPath, actual) => {
      actual.renameSync(openedPath, path.join(home, 'original.json'));
      actual.renameSync(replacement, openedPath);
    };

    expect((await capture(['activate-shadow', '--input', input])).code).toBe(2);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('rejects same-size content mutation on the opened inode', async () => {
    const input = inputFile(activationInput(), 'mutate-during-read.json');
    inputTrustRace.duringActivationRead = (openedPath, actual) => {
      const bytes = actual.readFileSync(openedPath);
      bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x30 ? 0x31 : 0x30;
      actual.writeFileSync(openedPath, bytes, { mode: 0o600 });
    };

    expect((await capture(['activate-shadow', '--input', input])).code).toBe(2);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('refuses enforce mode without creating controller state', async () => {
    const result = await capture([
      'activate-shadow', '--input', inputFile(activationInput('enforce')), '--json',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, action: 'activate-shadow', reason: 'enforce-unsupported', enforceSupported: false,
    });
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });
});

describe('auto-merge canary CLI halt and unsupported operations', () => {
  it('refuses inactive halt, then halts the exact healthy CAS and is idempotent', async () => {
    const inactive = await capture(['halt', '--json']);
    expect(inactive.code).toBe(1);
    expect(JSON.parse(inactive.stdout)).toMatchObject({ ok: false, action: 'halt', reason: 'inactive' });

    expect((await capture([
      'activate-shadow', '--input', inputFile(activationInput()), '--json',
    ])).code).toBe(0);
    const halted = await capture(['halt', '--json']);
    expect(halted.code).toBe(0);
    expect(JSON.parse(halted.stdout)).toMatchObject({
      ok: true,
      action: 'halt',
      changed: true,
      hostCancellationProven: false,
      status: 'halted',
      active: false,
      state: { revision: 2, state: 'halted', blocker: { code: 'operator-halt' } },
    });
    expect(revisionFiles()).toHaveLength(2);

    const again = await capture(['halt', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      ok: true, action: 'halt', changed: false, hostCancellationProven: false,
      state: { revision: 2, state: 'halted' },
    });
    expect(revisionFiles()).toHaveLength(2);
  });

  it('refuses to halt degraded state and does not append a revision', async () => {
    expect((await capture([
      'activate-shadow', '--input', inputFile(activationInput()), '--json',
    ])).code).toBe(0);
    fs.appendFileSync(revisionFiles()[0]!, 'tamper');

    const result = await capture(['halt', '--json']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, action: 'halt', reason: 'degraded' });
    expect(revisionFiles()).toHaveLength(1);
  });

  it('repairs only the authenticated missing-terminal-summary crash window', async () => {
    expect((await capture([
      'activate-shadow', '--input', inputFile(activationInput()), '--json',
    ])).code).toBe(0);
    expect((await capture(['halt', '--json'])).code).toBe(0);
    expect(summaryFiles()).toHaveLength(1);
    fs.unlinkSync(summaryFiles()[0]!);

    const recovered = await capture(['halt', '--json']);

    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      action: 'halt',
      changed: true,
      status: 'halted',
      active: false,
      state: { state: 'halted', revision: 2 },
    });
    expect(summaryFiles()).toHaveLength(1);
  });

  it('makes reconcile and enforce explicit unsupported refusals without touching storage', async () => {
    const before = fs.readdirSync(home);
    const reconcile = await capture(['reconcile', '--json']);
    const enforce = await capture(['activate-enforce', '--json']);

    expect(reconcile.code).toBe(1);
    expect(JSON.parse(reconcile.stdout)).toMatchObject({
      ok: false,
      action: 'reconcile',
      reason: 'unsupported',
      hostCancellationProven: false,
      enforceSupported: false,
    });
    expect(enforce.code).toBe(1);
    expect(JSON.parse(enforce.stdout)).toMatchObject({
      ok: false, action: 'activate-enforce', reason: 'enforce-unsupported', enforceSupported: false,
    });
    expect(fs.readdirSync(home)).toEqual(before);
    expect(fs.existsSync(process.env.ASHLR_HOME!)).toBe(false);
  });
});
