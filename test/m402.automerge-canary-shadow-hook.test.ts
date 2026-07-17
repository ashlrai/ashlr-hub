import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import {
  deriveAutoMergeCanaryCandidateBindings,
  observeAutoMergeCanaryShadow,
  observeAutoMergeCanaryShadowAsync,
  type AutoMergeCanaryBindingField,
  type AutoMergeCanaryCandidateBindings,
  type AutoMergeCanaryShadowObserverInput,
} from '../src/core/fleet/automerge-canary-observer.js';
import {
  inspectCommittedAutoMergeCanaryPatch,
  type AutoMergeCanaryCommittedClassification,
} from '../src/core/fleet/automerge-canary.js';
import type {
  AutoMergeCanaryReadResult,
  AutoMergeCanaryShadowObservationInput,
  AutoMergeCanaryStateV1,
} from '../src/core/fleet/automerge-canary-store.js';
import {
  activateShadow,
  appendShadowObservation,
  readAutomergeCanaryStore,
} from '../src/core/fleet/automerge-canary-store.js';
import { resolveGitHubOriginAuthorityDetails } from '../src/core/git.js';

let repo: string;
let baseOid: string;
let headOid: string;

const OBSERVATION_DURATION_MS = 24 * 60 * 60 * 1_000;

function activeObservationNow(active: AutoMergeCanaryStateV1): Date {
  return new Date(Date.parse(active.activatedAt) + 1_000);
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(relative: string, value: string): void {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function cfg(): AshlrConfig {
  return {
    foundry: {
      autoMerge: {
        enabled: true,
        trustBasis: 'tier',
        maxRisk: 'low',
        managerGate: true,
        allowSelfMerge: false,
        maxAutomergeFiles: 4,
        maxAutomergeLines: 150,
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'test', appId: '1234' }],
        },
        allowWithoutVerification: false,
      },
    },
  } as unknown as AshlrConfig;
}

function input(overrides: Partial<AutoMergeCanaryShadowObserverInput> = {}): AutoMergeCanaryShadowObserverInput {
  return { repo, baseRef: 'main', baseOid, headOid, cfg: cfg(), ...overrides };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function state(
  bindings: AutoMergeCanaryCandidateBindings,
  activatedAt = new Date(Date.now() - 1_000),
): AutoMergeCanaryStateV1 {
  const activatedAtIso = activatedAt.toISOString();
  const deadlineAtIso = new Date(activatedAt.getTime() + OBSERVATION_DURATION_MS).toISOString();
  return {
    schemaVersion: 1,
    epochId: '123e4567-e89b-42d3-a456-426614174000',
    revision: 1,
    previousAttestation: '0'.repeat(64),
    mode: 'shadow',
    state: 'shadow',
    repository: {
      repositoryId: bindings.repositoryId,
      fetchDestinationDigest: bindings.fetchDestinationDigest,
      pushDestinationDigest: bindings.pushDestinationDigest,
      baseRefDigest: bindings.baseRefDigest,
      baseOid: bindings.baseOid,
      headOid: bindings.headOid,
    },
    policyDigest: bindings.policyDigest,
    configDigest: bindings.configDigest,
    classifierDigest: bindings.classifierDigest,
    pathDigest: bindings.pathDigest,
    budgets: {
      maxAdmissions: 1,
      maxMerges: 1,
      maxInFlight: 1,
      minMergeIntervalMs: 1,
      leaseDurationMs: 60_000,
      observationDurationMs: OBSERVATION_DURATION_MS,
    },
    counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
    shadowCounters: {
      attempts: 0,
      eligible: 0,
      rejected: 0,
      bindingMismatches: 0,
      inspectionErrors: 0,
      casRetries: 0,
    },
    lastShadowEvidence: null,
    lease: { holderDigest: null, acquiredAt: null, expiresAt: null },
    observation: {
      startedAt: activatedAtIso,
      deadlineAt: deadlineAtIso,
      completedAt: null,
    },
    activatedAt: activatedAtIso,
    updatedAt: activatedAtIso,
    clockHighWater: activatedAtIso,
    pendingEffect: null,
    blocker: null,
    attestation: digest('observer-state'),
  };
}

function read(active: AutoMergeCanaryStateV1 | null): AutoMergeCanaryReadResult {
  return {
    enforceSupported: false,
    sourceState: 'healthy',
    severity: 'none',
    status: active?.state ?? (active ? 'shadow' : 'inactive'),
    active: active !== null && active.state !== 'halted',
    state: active,
    revisions: active ? [active] : [],
    terminalEpochs: [],
    diagnostics: [],
    limitExceeded: false,
  };
}

function success(active: AutoMergeCanaryStateV1) {
  return { ok: true as const, state: active, clockRollbackDetected: false };
}

function actualBindings(candidate = input()): AutoMergeCanaryCandidateBindings {
  const bindings = deriveAutoMergeCanaryCandidateBindings(candidate);
  if (!bindings) throw new Error('fixture bindings unavailable');
  return bindings;
}

function changed(value: string): string {
  return `${value[0] === 'a' ? 'b' : 'a'}${value.slice(1)}`;
}

async function runMergeFlowWithObserverFailure(failure: 'none' | 'classifier' | 'store' | 'pending') {
  const previousHome = process.env.HOME;
  const previousAshlrHome = process.env.ASHLR_HOME;
  const previousAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  const flowHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-flow-home-'));
  const flowRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-flow-repo-'));
  process.env.HOME = flowHome;
  process.env.ASHLR_HOME = path.join(flowHome, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  let observerCalls = 0;
  let observerSawOutwardResult = false;
  let outwardSettled = false;
  let markObserverStarted: (() => void) | undefined;
  const observerStarted = new Promise<void>((resolve) => { markObserverStarted = resolve; });
  let releasePendingObserver: (() => void) | undefined;
  const pendingObserver = new Promise<void>((resolve) => { releasePendingObserver = resolve; });
  let completionHeldResult = false;
  vi.resetModules();
  vi.doMock('../src/core/fleet/automerge-canary-observer.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/core/fleet/automerge-canary-observer.js')>();
    return {
      ...actual,
      observeAutoMergeCanaryShadowAsync: async () => {
        observerCalls += 1;
        observerSawOutwardResult = outwardSettled;
        markObserverStarted?.();
        if (failure === 'classifier') throw new Error(`${failure} observer injection`);
        if (failure === 'store') return await Promise.reject(new Error(`${failure} observer injection`));
        if (failure === 'pending') await pendingObserver;
        return { status: 'inactive' as const };
      },
    };
  });
  try {
    const [{ autoMergeProposal }, store, policy, provenance, auditStore] = await Promise.all([
      import('../src/core/inbox/merge.js'),
      import('../src/core/inbox/store.js'),
      import('../src/core/sandbox/policy.js'),
      import('../src/core/foundry/provenance.js'),
      import('../src/core/sandbox/audit.js'),
    ]);
    execFileSync('git', ['init', '--initial-branch=main', flowRepo], { stdio: 'pipe' });
    execFileSync('git', ['-C', flowRepo, 'config', 'user.email', 'm402-flow@ashlr.test']);
    execFileSync('git', ['-C', flowRepo, 'config', 'user.name', 'M402 Flow']);
    fs.writeFileSync(path.join(flowRepo, 'README.md'), '# Flow fixture\n');
    execFileSync('git', ['-C', flowRepo, 'add', '--', 'README.md']);
    execFileSync('git', ['-C', flowRepo, 'commit', '-qm', 'base']);
    const origin = path.join(flowHome, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
    execFileSync('git', ['-C', flowRepo, 'remote', 'add', 'origin', origin]);
    execFileSync('git', ['-C', flowRepo, 'push', '-u', 'origin', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', flowRepo, 'remote', 'set-head', 'origin', 'main']);
    execFileSync('git', ['-C', flowRepo, 'checkout', '-qb', 'work']);
    policy.setKill(false);
    policy.enroll(flowRepo);

    const relative = 'docs/m402-flow.md';
    const diff = [
      `diff --git a/${relative} b/${relative}`,
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/${relative}`,
      '@@ -0,0 +1 @@',
      '+observer failures are non-authoritative',
      '',
    ].join('\n');
    const diffHash = provenance.hashDiff(diff);
    const proposal = store.createProposal({
      repo: flowRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'M402 observer isolation',
      summary: 'Prove the shadow hook cannot alter merge flow',
      diff,
      diffHash,
      provenanceSig: provenance.signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    store.setStatus(proposal.id, 'approved');
    const outwardResult = autoMergeProposal(proposal.id, {
      foundry: {
        mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
        autoMerge: {
          enabled: true,
          maxRisk: 'low',
          allowWithoutVerification: true,
          managerGate: false,
          pushToRemote: false,
        },
      },
    } as unknown as AshlrConfig).then((result) => {
      outwardSettled = true;
      return result;
    });
    if (failure === 'pending') {
      await observerStarted;
      await Promise.resolve();
      expect(outwardSettled).toBe(false);
      expect(store.loadProposal(proposal.id)?.status).toBe('applied');
      expect(execFileSync('git', ['-C', flowRepo, 'show', `main:${relative}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()).toBe('observer failures are non-authoritative');
      completionHeldResult = true;
      releasePendingObserver?.();
    }
    const result = await outwardResult;
    const applied = store.loadProposal(proposal.id)?.status;
    let mergedFile = 'missing';
    try {
      mergedFile = execFileSync('git', ['-C', flowRepo, 'show', `main:${relative}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { /* surfaced through the returned merge result */ }
    const shadowAudits = auditStore.readAudit().filter((entry) =>
      entry.action === 'inbox:auto-merge-canary-shadow');
    return {
      result: {
        ok: result.ok,
        merged: result.merged,
        branched: result.branched,
        handoff: result.handoff,
      },
      applied,
      mergedFile,
      shadowAuditCount: shadowAudits.length,
      observerCalls,
      observerSawOutwardResult,
      completionHeldResult,
    };
  } finally {
    vi.doUnmock('../src/core/fleet/automerge-canary-observer.js');
    vi.resetModules();
    try { fs.rmSync(flowRepo, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(flowHome, { recursive: true, force: true }); } catch { /* best effort */ }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = previousAshlrHome;
    if (previousAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previousAllowAny;
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-'));
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'm402@ashlr.test']);
  git(['config', 'user.name', 'M402']);
  git(['remote', 'add', 'origin', 'https://github.com/AshlrAI/Observer-Fixture.git']);
  write('README.md', '# Observer fixture\n');
  write('src/app.ts', 'export const value = 1;\n');
  git(['add', '--', 'README.md', 'src/app.ts']);
  git(['commit', '-qm', 'base']);
  baseOid = git(['rev-parse', 'HEAD']);
  write('docs/guide.md', '# Exact docs candidate\n');
  git(['add', '--', 'docs/guide.md']);
  git(['commit', '-qm', 'docs candidate']);
  headOid = git(['rev-parse', 'HEAD']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('M402 real shadow observation hook', () => {
  it('classifies docs and source commits while preserving exact base, head, tree, and path facts', () => {
    const candidate = input();
    const bindings = actualBindings(candidate);
    const active = state(bindings);
    const append = vi.fn(() => success(active));
    const result = observeAutoMergeCanaryShadow(candidate, {
      deps: {
        readStore: () => read(active),
        appendObservation: append,
        now: () => activeObservationNow(active),
      },
    });
    const inspection = inspectCommittedAutoMergeCanaryPatch(repo, baseOid, headOid);
    expect(result).toMatchObject({ status: 'observed', outcome: 'eligible', mismatchFields: [] });
    const evidence = append.mock.calls[0]![1] as AutoMergeCanaryShadowObservationInput;
    expect(evidence).toMatchObject({
      baseOid,
      headOid,
      treeOid: inspection.headTreeOid,
      fileCount: 1,
      lineCount: 1,
      pathDigest: bindings.pathDigest,
      outcome: 'eligible',
    });
    expect(evidence.pathDigest).not.toBe(inspection.pathDigest);

    git(['checkout', '-q', '-B', 'source-candidate', baseOid]);
    write('src/app.ts', 'export const value = 2;\n');
    git(['add', '--', 'src/app.ts']);
    git(['commit', '-qm', 'source candidate']);
    const sourceHead = git(['rev-parse', 'HEAD']);
    const sourceInput = input({ headOid: sourceHead });
    const sourceBindings = actualBindings(sourceInput);
    const sourceState = state(sourceBindings);
    const sourceAppend = vi.fn(() => success(sourceState));
    expect(observeAutoMergeCanaryShadow(sourceInput, {
      deps: {
        readStore: () => read(sourceState),
        appendObservation: sourceAppend,
        now: () => activeObservationNow(sourceState),
      },
    })).toMatchObject({ status: 'observed', outcome: 'rejected' });
    expect(sourceAppend.mock.calls[0]![1]).toMatchObject({
      outcome: 'rejected',
      baseOid,
      headOid: sourceHead,
      treeOid: git(['show', '-s', '--format=%T', sourceHead]),
    });
  });

  it('derives facts independently and compares every active binding', () => {
    const candidate = input();
    const bindings = actualBindings(candidate);
    const fields = Object.keys(bindings) as AutoMergeCanaryBindingField[];
    expect(fields).toHaveLength(10);

    for (const field of fields) {
      const mismatched = state(bindings);
      if (field in mismatched.repository) {
        (mismatched.repository as unknown as Record<string, string>)[field] = changed(bindings[field]);
      } else {
        (mismatched as unknown as Record<string, unknown>)[field] = changed(bindings[field]);
      }
      const append = vi.fn(() => success(mismatched));
      const result = observeAutoMergeCanaryShadow(candidate, {
        deps: {
          readStore: () => read(mismatched),
          appendObservation: append,
          now: () => activeObservationNow(mismatched),
        },
      });
      expect(result, field).toMatchObject({
        status: 'observed',
        outcome: 'binding-mismatch',
        mismatchFields: [field],
      });
      const evidence = append.mock.calls[0]![1] as AutoMergeCanaryShadowObservationInput;
      expect(evidence.mismatchFields, field).toEqual([field]);
      expect(evidence[field], field).toBe(bindings[field]);
      expect(evidence.baseOid).toBe(baseOid);
      expect(evidence.headOid).toBe(headOid);
      expect(evidence.pathDigest).toBe(bindings.pathDigest);
    }
  });

  it('appends a matching exact observation through the real authenticated store', () => {
    const previousAshlrHome = process.env.ASHLR_HOME;
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-store-'));
    process.env.ASHLR_HOME = storeHome;
    try {
      const activatedAt = new Date();
      const observedAt = new Date(activatedAt.getTime() + 1_000);
      const bindings = actualBindings();
      const activated = activateShadow({
        repository: {
          repositoryId: bindings.repositoryId,
          fetchDestinationDigest: bindings.fetchDestinationDigest,
          pushDestinationDigest: bindings.pushDestinationDigest,
          baseRefDigest: bindings.baseRefDigest,
          baseOid: bindings.baseOid,
          headOid: bindings.headOid,
        },
        policyDigest: bindings.policyDigest,
        configDigest: bindings.configDigest,
        classifierDigest: bindings.classifierDigest,
        pathDigest: bindings.pathDigest,
        budgets: {
          maxAdmissions: 1,
          maxMerges: 1,
          maxInFlight: 1,
          minMergeIntervalMs: 1,
          leaseDurationMs: 60_000,
          observationDurationMs: 60_000,
        },
      }, { now: activatedAt });
      expect(activated.ok).toBe(true);
      expect(observeAutoMergeCanaryShadow(input(), {
        deps: { now: () => observedAt },
      })).toMatchObject({ status: 'observed', outcome: 'eligible', casRetries: 0 });
      expect(readAutomergeCanaryStore({ now: new Date(observedAt.getTime() + 1_000) }).state)
        .toMatchObject({
          revision: 2,
          shadowCounters: { attempts: 1, eligible: 1 },
          lastShadowEvidence: {
            baseOid,
            headOid,
            treeOid: git(['show', '-s', '--format=%T', headOid]),
            pathDigest: bindings.pathDigest,
          },
        });
    } finally {
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  });

  it('awaits a real child-process observation while the parent event loop remains responsive', async () => {
    const previousAshlrHome = process.env.ASHLR_HOME;
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-async-store-'));
    process.env.ASHLR_HOME = storeHome;
    try {
      const bindings = actualBindings();
      const activated = activateShadow({
        repository: {
          repositoryId: bindings.repositoryId,
          fetchDestinationDigest: bindings.fetchDestinationDigest,
          pushDestinationDigest: bindings.pushDestinationDigest,
          baseRefDigest: bindings.baseRefDigest,
          baseOid: bindings.baseOid,
          headOid: bindings.headOid,
        },
        policyDigest: bindings.policyDigest,
        configDigest: bindings.configDigest,
        classifierDigest: bindings.classifierDigest,
        pathDigest: bindings.pathDigest,
        budgets: {
          maxAdmissions: 1,
          maxMerges: 1,
          maxInFlight: 1,
          minMergeIntervalMs: 1,
          leaseDurationMs: 60_000,
          observationDurationMs: 60_000,
        },
      });
      expect(activated.ok).toBe(true);

      let parentTurnRan = false;
      setImmediate(() => { parentTurnRan = true; });
      const result = await observeAutoMergeCanaryShadowAsync(input());
      expect(result).toMatchObject({ status: 'observed', outcome: 'eligible' });
      expect(parentTurnRan).toBe(true);
      expect(readAutomergeCanaryStore().state).toMatchObject({
        revision: 2,
        shadowCounters: { attempts: 1, eligible: 1 },
      });
    } finally {
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists and validates the complete ordered binding mismatch set through the real store', () => {
    const previousAshlrHome = process.env.ASHLR_HOME;
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-mismatch-store-'));
    process.env.ASHLR_HOME = storeHome;
    try {
      const actual = actualBindings();
      const order: AutoMergeCanaryBindingField[] = [
        'repositoryId', 'fetchDestinationDigest', 'pushDestinationDigest', 'baseRefDigest',
        'baseOid', 'headOid', 'policyDigest', 'configDigest', 'classifierDigest', 'pathDigest',
      ];
      const expected = { ...actual };
      for (const field of order) expected[field] = changed(actual[field]);
      const activatedAt = new Date();
      const activated = activateShadow({
        repository: {
          repositoryId: expected.repositoryId,
          fetchDestinationDigest: expected.fetchDestinationDigest,
          pushDestinationDigest: expected.pushDestinationDigest,
          baseRefDigest: expected.baseRefDigest,
          baseOid: expected.baseOid,
          headOid: expected.headOid,
        },
        policyDigest: expected.policyDigest,
        configDigest: expected.configDigest,
        classifierDigest: expected.classifierDigest,
        pathDigest: expected.pathDigest,
        budgets: {
          maxAdmissions: 1,
          maxMerges: 1,
          maxInFlight: 1,
          minMergeIntervalMs: 1,
          leaseDurationMs: 60_000,
          observationDurationMs: 60_000,
        },
      }, { now: activatedAt });
      expect(activated.ok).toBe(true);
      const result = observeAutoMergeCanaryShadow(input(), {
        deps: { now: () => new Date(activatedAt.getTime() + 1_000) },
      });
      expect(result).toMatchObject({
        status: 'observed',
        outcome: 'binding-mismatch',
        mismatchFields: order,
      });
      const persisted = readAutomergeCanaryStore().state!;
      expect(persisted.shadowCounters).toMatchObject({ attempts: 1, bindingMismatches: 1 });
      expect(persisted.lastShadowEvidence).toMatchObject({
        mismatchFields: order,
        repositoryId: actual.repositoryId,
        fetchDestinationDigest: actual.fetchDestinationDigest,
        pushDestinationDigest: actual.pushDestinationDigest,
        baseRefDigest: actual.baseRefDigest,
        baseOid: actual.baseOid,
        headOid: actual.headOid,
        policyDigest: actual.policyDigest,
        configDigest: actual.configDigest,
        classifierDigest: actual.classifierDigest,
        pathDigest: actual.pathDigest,
      });
    } finally {
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  });

  it('is read-only and does no Git, classifier, append, or audit work when not actively shadowing', () => {
    for (const inactive of [
      null,
      { ...state(actualBindings()), state: 'halt-requested' as const },
      { ...state(actualBindings()), state: 'halted' as const },
    ]) {
      const inspect = vi.fn();
      const origin = vi.fn();
      const append = vi.fn();
      const audit = vi.fn();
      expect(observeAutoMergeCanaryShadow(input(), {
        deps: {
          readStore: () => read(inactive),
          inspectCommitted: inspect,
          resolveOrigin: origin,
          appendObservation: append,
          auditEvent: audit,
        },
      })).toEqual({ status: 'inactive' });
      expect(inspect).not.toHaveBeenCalled();
      expect(origin).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['at the exact deadline', 0],
    ['after the deadline', 1],
  ])('does no observer work %s', (_label, offsetMs) => {
    const active = state(actualBindings());
    const now = new Date(Date.parse(active.observation.deadlineAt) + offsetMs);
    const inspect = vi.fn();
    const origin = vi.fn();
    const append = vi.fn();
    const audit = vi.fn();

    expect(observeAutoMergeCanaryShadow(input(), {
      deps: {
        readStore: () => read(active),
        inspectCommitted: inspect,
        resolveOrigin: origin,
        appendObservation: append,
        auditEvent: audit,
        now: () => now,
      },
    })).toEqual({ status: 'inactive' });
    expect(inspect).not.toHaveBeenCalled();
    expect(origin).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('retries exactly once on a CAS conflict and deduplicates with the same observation digest', () => {
    const bindings = actualBindings();
    const initial = state(bindings);
    let firstEvidence: AutoMergeCanaryShadowObservationInput | undefined;
    const winner = { ...initial, revision: 2, attestation: digest('winner') };
    const append = vi.fn((_cas, evidence: AutoMergeCanaryShadowObservationInput) => {
      if (!firstEvidence) {
        firstEvidence = evidence;
        const { casRetries: _retry, ...persisted } = evidence;
        winner.lastShadowEvidence = persisted;
        return { ok: false as const, reason: 'conflict' as const };
      }
      return success(winner);
    });
    const readStore = vi.fn()
      .mockReturnValueOnce(read(initial))
      .mockReturnValueOnce(read(winner));
    const result = observeAutoMergeCanaryShadow(input(), {
      deps: { readStore, appendObservation: append, now: () => activeObservationNow(initial) },
    });
    expect(result).toMatchObject({ status: 'observed', casRetries: 1 });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![0]).toMatchObject({ revision: 2, attestation: winner.attestation });
    expect(append.mock.calls[1]![1]).toMatchObject({
      observationDigest: firstEvidence!.observationDigest,
      observedAt: firstEvidence!.observedAt,
      casRetries: 1,
    });

    append.mockReset();
    append.mockReturnValue({ ok: false, reason: 'unavailable' });
    const audit = vi.fn();
    expect(observeAutoMergeCanaryShadow(input(), {
      deps: {
        readStore: () => read(initial),
        appendObservation: append,
        auditEvent: audit,
        now: () => activeObservationNow(initial),
      },
    })).toEqual({ status: 'failed', stage: 'append' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inbox:auto-merge-canary-shadow',
      result: 'error',
    }));

    const cleanWinner = { ...initial, revision: 2, attestation: digest('clean-winner') };
    const racedEvidence: AutoMergeCanaryShadowObservationInput[] = [];
    const racedAppend = vi.fn((_cas, currentEvidence: AutoMergeCanaryShadowObservationInput) => {
      racedEvidence.push(currentEvidence);
      return racedEvidence.length === 1
        ? { ok: false as const, reason: 'conflict' as const }
        : success(cleanWinner);
    });
    const activatedAt = Date.parse(initial.activatedAt);
    const times = [1_000, 2_000, 3_000].map((offsetMs) => new Date(activatedAt + offsetMs));
    const racedResult = observeAutoMergeCanaryShadow(input(), {
      deps: {
        readStore: vi.fn().mockReturnValueOnce(read(initial)).mockReturnValueOnce(read(cleanWinner)),
        appendObservation: racedAppend,
        now: () => times.shift()!,
      },
    });
    expect(racedEvidence[1]!.observedAt).not.toBe(racedEvidence[0]!.observedAt);
    expect(racedEvidence[1]!.observationDigest).not.toBe(racedEvidence[0]!.observationDigest);
    expect(racedResult).toMatchObject({
      status: 'observed',
      observationDigest: racedEvidence[1]!.observationDigest,
      casRetries: 1,
    });
  });

  it('turns classifier and store failures into bounded audit-only failures', () => {
    const active = state(actualBindings());
    const audit = vi.fn();
    const flow = (deps: Parameters<typeof observeAutoMergeCanaryShadow>[1]['deps']) => {
      const before = { merged: false, route: 'local' };
      const observation = observeAutoMergeCanaryShadow(input(), {
        deps: { now: () => activeObservationNow(active), auditEvent: audit, ...deps },
      });
      const after = { merged: false, route: 'local' };
      return { before, observation, after };
    };

    const classifierFailure = flow({
      readStore: () => read(active),
      inspectCommitted: () => { throw new Error('raw classifier failure must not escape'); },
    });
    expect(classifierFailure.after).toEqual(classifierFailure.before);
    expect(classifierFailure.observation).toEqual({ status: 'failed', stage: 'inspect' });

    const storeFailure = flow({
      readStore: () => read(active),
      appendObservation: () => { throw new Error('raw store failure must not escape'); },
    });
    expect(storeFailure.after).toEqual(storeFailure.before);
    expect(storeFailure.observation).toEqual({ status: 'failed', stage: 'append' });
    expect(audit).toHaveBeenCalledTimes(2);
    for (const [entry] of audit.mock.calls) {
      expect(entry).toMatchObject({ action: 'inbox:auto-merge-canary-shadow', result: 'error' });
      expect(entry.summary.length).toBeLessThanOrEqual(160);
      expect(entry.summary).not.toContain('raw classifier failure');
      expect(entry.summary).not.toContain('raw store failure');
    }
  });

  it('preserves identical real merge-flow behavior under injected classifier and store failures', async () => {
    const baseline = await runMergeFlowWithObserverFailure('none');
    const classifierFailure = await runMergeFlowWithObserverFailure('classifier');
    const storeFailure = await runMergeFlowWithObserverFailure('store');
    expect(baseline).toMatchObject({
      result: { ok: true, merged: true },
      applied: 'applied',
      mergedFile: 'observer failures are non-authoritative',
      shadowAuditCount: 0,
      observerCalls: 1,
      observerSawOutwardResult: false,
      completionHeldResult: false,
    });
    expect({ ...classifierFailure, shadowAuditCount: 0 }).toEqual(baseline);
    expect({ ...storeFailure, shadowAuditCount: 0 }).toEqual(baseline);
    expect(classifierFailure.shadowAuditCount).toBe(1);
    expect(storeFailure.shadowAuditCount).toBe(1);
  }, 30_000);

  it('holds completion for an unresolved observer after fixing the outward merge result', async () => {
    const baseline = await runMergeFlowWithObserverFailure('none');
    const pending = await runMergeFlowWithObserverFailure('pending');
    expect({ ...pending, completionHeldResult: false }).toEqual(baseline);
    expect(pending).toMatchObject({
      result: { ok: true, merged: true },
      applied: 'applied',
      observerCalls: 1,
      observerSawOutwardResult: false,
      completionHeldResult: true,
    });
  }, 30_000);

  it('classifies bounded inspection failures without fabricating exact object authority', () => {
    const bindings = actualBindings();
    const active = state(bindings);
    const failedInspection: AutoMergeCanaryCommittedClassification = {
      outcome: 'inspection-failed',
      eligible: false,
      reason: 'git metadata unavailable',
      fileCount: 0,
      lineCount: 0,
      class: 'rejected',
      baseCommitOid: null,
      headCommitOid: null,
      baseTreeOid: null,
      headTreeOid: null,
      pathDigest: null,
    };
    const append = vi.fn(() => success(active));
    expect(observeAutoMergeCanaryShadow(input(), {
      deps: {
        readStore: () => read(active),
        resolveOrigin: resolveGitHubOriginAuthorityDetails,
        inspectCommitted: () => failedInspection,
        appendObservation: append,
        now: () => activeObservationNow(active),
      },
    })).toMatchObject({ status: 'observed', outcome: 'inspection-error' });
    expect(append.mock.calls[0]![1]).toMatchObject({
      outcome: 'inspection-error',
      baseOid: null,
      headOid: null,
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
      pathDigest: null,
    });
  });

  it('persists genuine null-identity inspection evidence and rejects it as fabricated success', () => {
    const previousAshlrHome = process.env.ASHLR_HOME;
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-inspection-store-'));
    process.env.ASHLR_HOME = storeHome;
    try {
      const bindings = actualBindings();
      const activatedAt = new Date();
      const activated = activateShadow({
        repository: {
          repositoryId: bindings.repositoryId,
          fetchDestinationDigest: bindings.fetchDestinationDigest,
          pushDestinationDigest: bindings.pushDestinationDigest,
          baseRefDigest: bindings.baseRefDigest,
          baseOid: bindings.baseOid,
          headOid: bindings.headOid,
        },
        policyDigest: bindings.policyDigest,
        configDigest: bindings.configDigest,
        classifierDigest: bindings.classifierDigest,
        pathDigest: bindings.pathDigest,
        budgets: {
          maxAdmissions: 1,
          maxMerges: 1,
          maxInFlight: 1,
          minMergeIntervalMs: 1,
          leaseDurationMs: 60_000,
          observationDurationMs: 60_000,
        },
      }, { now: activatedAt });
      expect(activated.ok).toBe(true);
      const failedInspection: AutoMergeCanaryCommittedClassification = {
        outcome: 'inspection-failed',
        eligible: false,
        reason: 'git metadata unavailable',
        fileCount: 0,
        lineCount: 0,
        class: 'rejected',
        baseCommitOid: null,
        headCommitOid: null,
        baseTreeOid: null,
        headTreeOid: null,
        pathDigest: null,
      };
      expect(observeAutoMergeCanaryShadow(input(), {
        deps: {
          resolveOrigin: resolveGitHubOriginAuthorityDetails,
          inspectCommitted: () => failedInspection,
          now: () => new Date(activatedAt.getTime() + 1_000),
        },
      })).toMatchObject({ status: 'observed', outcome: 'inspection-error' });

      const persisted = readAutomergeCanaryStore().state!;
      expect(persisted.shadowCounters).toMatchObject({ attempts: 1, inspectionErrors: 1 });
      expect(persisted.lastShadowEvidence).toMatchObject({
        outcome: 'inspection-error',
        mismatchFields: [],
        baseOid: null,
        headOid: null,
        treeOid: null,
        pathDigest: null,
        fileCount: 0,
        lineCount: 0,
      });
      expect(appendShadowObservation({
        epochId: persisted.epochId,
        revision: persisted.revision,
        attestation: persisted.attestation,
      }, {
        ...persisted.lastShadowEvidence!,
        observationDigest: digest('fabricated-inspection-success'),
        observedAt: new Date(Date.parse(persisted.clockHighWater) + 1).toISOString(),
        outcome: 'eligible',
        casRetries: 0,
      })).toEqual({ ok: false, reason: 'invalid' });
      expect(readAutomergeCanaryStore().state?.shadowCounters)
        .toMatchObject({ attempts: 1, eligible: 0, inspectionErrors: 1 });
    } finally {
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  });

  it('preserves a within-skew wall-clock rollback and durably blocks the shadow observer', () => {
    const previousAshlrHome = process.env.ASHLR_HOME;
    const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m402-clock-store-'));
    process.env.ASHLR_HOME = storeHome;
    try {
      const bindings = actualBindings();
      const activatedAt = new Date();
      const activated = activateShadow({
        repository: {
          repositoryId: bindings.repositoryId,
          fetchDestinationDigest: bindings.fetchDestinationDigest,
          pushDestinationDigest: bindings.pushDestinationDigest,
          baseRefDigest: bindings.baseRefDigest,
          baseOid: bindings.baseOid,
          headOid: bindings.headOid,
        },
        policyDigest: bindings.policyDigest,
        configDigest: bindings.configDigest,
        classifierDigest: bindings.classifierDigest,
        pathDigest: bindings.pathDigest,
        budgets: {
          maxAdmissions: 1,
          maxMerges: 1,
          maxInFlight: 1,
          minMergeIntervalMs: 1,
          leaseDurationMs: 60_000,
          observationDurationMs: 60_000,
        },
      }, { now: activatedAt });
      expect(activated.ok).toBe(true);
      const auditEvent = vi.fn();
      expect(observeAutoMergeCanaryShadow(input(), {
        deps: {
          now: () => new Date(activatedAt.getTime() - 30_000),
          auditEvent,
        },
      })).toEqual({ status: 'failed', stage: 'append' });

      const persisted = readAutomergeCanaryStore({ now: activatedAt });
      expect(persisted).toMatchObject({
        sourceState: 'healthy',
        severity: 'critical',
        status: 'critical',
        active: true,
        state: {
          revision: 2,
          state: 'halt-requested',
          clockHighWater: activatedAt.toISOString(),
          blocker: {
            code: 'clock-rollback',
            severity: 'critical',
            since: activatedAt.toISOString(),
          },
          shadowCounters: { attempts: 0, eligible: 0, rejected: 0 },
          lastShadowEvidence: null,
        },
      });
      expect(auditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'inbox:auto-merge-canary-shadow',
        result: 'error',
        summary: expect.stringContaining('clock-rollback'),
      }));
    } finally {
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      fs.rmSync(storeHome, { recursive: true, force: true });
    }
  });

  it('captures after staging but invokes only after outward routing and lock release', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/core/inbox/merge.ts'), 'utf8');
    const stage = source.indexOf('const stagedHead = staged.head;');
    const capture = source.indexOf('shadowObservation = {', stage);
    const cleanup = source.indexOf('const refuseStaged =', capture);
    const routing = source.indexOf('if (wantRemote && githubOrigin)', cleanup);
    const release = source.indexOf('releaseProposalMutationLock(authorityFence);', routing);
    const completion = source.indexOf(
      'await completeAutoMergeCanaryShadowObservation(shadowObservation, id);',
      release,
    );
    expect(stage).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(stage);
    expect(cleanup).toBeGreaterThan(capture);
    expect(routing).toBeGreaterThan(cleanup);
    expect(release).toBeGreaterThan(routing);
    expect(completion).toBeGreaterThan(release);
  });
});
