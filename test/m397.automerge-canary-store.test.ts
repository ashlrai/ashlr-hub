import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
  AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS,
  activateEnforce,
  activateShadow,
  appendRevision,
  appendShadowObservation,
  automergeCanarySigningKeyPath,
  automergeCanaryStatus,
  automergeCanaryStoreDirectory,
  haltShadow,
  readAutomergeCanaryStore,
  type AutoMergeCanaryActivationInput,
  type AutoMergeCanaryCas,
  type AutoMergeCanaryShadowObservationInput,
  type AutoMergeCanaryStateV1,
} from '../src/core/fleet/automerge-canary-store.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';

const RECORD_DOMAIN = 'ashlr:automerge-canary-revision:v1';
const RAW_REPOSITORY = '/private/worktrees/docs-canary';
const RAW_FETCH = 'https://token@example.invalid/owner/repo.git';
const RAW_PUSH = 'git@example.invalid:owner/repo.git';
const RAW_SHADOW_REASON = 'path is outside the documentation allowlist: /private/secret.md';
const ACTIVE_FIXTURE_TIME = '2026-07-13T12:00:01.000Z';

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

function activeFixtureNow(): Date {
  return new Date(ACTIVE_FIXTURE_TIME);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function activationInput(mode?: 'shadow' | 'enforce'): AutoMergeCanaryActivationInput {
  return {
    ...(mode ? { mode } : {}),
    repository: {
      repositoryId: digest(RAW_REPOSITORY),
      fetchDestinationDigest: digest(RAW_FETCH),
      pushDestinationDigest: digest(RAW_PUSH),
      baseRefDigest: digest('refs/heads/master'),
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
    },
    policyDigest: digest('policy-v1'),
    configDigest: digest('config-v1'),
    classifierDigest: digest('docs-only-classifier-v1'),
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

function activate(now = new Date('2026-07-13T12:00:00.000Z')): AutoMergeCanaryStateV1 {
  const result = activateShadow(activationInput(), { now });
  expect(result).toMatchObject({ ok: true, clockRollbackDetected: false });
  if (!result.ok) throw new Error(`activation failed: ${result.reason}`);
  return result.state;
}

function cas(state: AutoMergeCanaryStateV1): AutoMergeCanaryCas {
  return { epochId: state.epochId, revision: state.revision, attestation: state.attestation };
}

function shadowEvidence(
  state: AutoMergeCanaryStateV1,
  overrides: Partial<AutoMergeCanaryShadowObservationInput> = {},
): AutoMergeCanaryShadowObservationInput {
  return {
    observationDigest: digest(`shadow-observation-${state.revision}`),
    observedAt: new Date(Date.parse(state.clockHighWater) + 1_000).toISOString(),
    outcome: 'eligible',
    mismatchFields: [],
    repositoryId: state.repository.repositoryId,
    fetchDestinationDigest: state.repository.fetchDestinationDigest,
    pushDestinationDigest: state.repository.pushDestinationDigest,
    baseRefDigest: state.repository.baseRefDigest,
    baseOid: state.repository.baseOid,
    headOid: state.repository.headOid,
    policyDigest: state.policyDigest,
    configDigest: state.configDigest,
    classifierDigest: state.classifierDigest,
    treeOid: 'c'.repeat(state.repository.headOid.length),
    fileCount: 1,
    lineCount: 2,
    reasonDigest: digest(RAW_SHADOW_REASON),
    pathDigest: state.pathDigest,
    casRetries: 0,
    ...overrides,
  };
}

function canonicalRetryObservationDigest(
  state: AutoMergeCanaryStateV1,
  evidence: Omit<AutoMergeCanaryShadowObservationInput, 'casRetries' | 'observationDigest'>,
): string {
  const bindings = {
    repositoryId: evidence.repositoryId,
    fetchDestinationDigest: evidence.fetchDestinationDigest,
    pushDestinationDigest: evidence.pushDestinationDigest,
    baseRefDigest: evidence.baseRefDigest,
    baseOid: evidence.baseOid,
    headOid: evidence.headOid,
    policyDigest: evidence.policyDigest,
    configDigest: evidence.configDigest,
    classifierDigest: evidence.classifierDigest,
    pathDigest: evidence.pathDigest,
  };
  return createHash('sha256').update(JSON.stringify([
    'ashlr:automerge-canary-observer:observation:v1',
    { epochId: state.epochId, bindings, evidence },
  ]), 'utf8').digest('hex');
}

function revisionFiles(): string[] {
  return fs.readdirSync(automergeCanaryStoreDirectory())
    .filter((name) => name.startsWith('.epoch-v1-'))
    .sort()
    .map((name) => path.join(automergeCanaryStoreDirectory(), name));
}

function summaryFiles(): string[] {
  return fs.readdirSync(automergeCanaryStoreDirectory())
    .filter((name) => name.startsWith('.terminal-v1-'))
    .sort()
    .map((name) => path.join(automergeCanaryStoreDirectory(), name));
}

function rewriteSignedRecord(
  file: string,
  mutate: (row: Record<string, unknown>) => void,
): void {
  const key = fs.readFileSync(automergeCanarySigningKeyPath());
  expect(key).toHaveLength(32);
  const row = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(row);
  delete row['attestation'];
  row['attestation'] = createHmac('sha256', key)
    .update(JSON.stringify([RECORD_DOMAIN, row]))
    .digest('hex');
  fs.writeFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

interface SnapshotRow {
  mode: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

function metadataSnapshot(root: string): Map<string, SnapshotRow> {
  const output = new Map<string, SnapshotRow>();
  const visit = (candidate: string): void => {
    const stat = fs.lstatSync(candidate);
    output.set(path.relative(root, candidate) || '.', {
      mode: stat.mode,
      size: stat.size,
      nlink: stat.nlink,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(candidate).sort()) visit(path.join(candidate, name));
    }
  };
  visit(root);
  return output;
}

function runChild(source: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out: ${stderr}`));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

function runCrashingChild(source: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`crashing child timed out: ${stderr}`));
    }, 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 1) reject(new Error(stderr));
      else resolve(code);
    });
  });
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m397-canary-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ASHLR_HOME;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
});

describe('bounded shadow auto-merge canary store', () => {
  it('treats missing state as inactive and performs a pure read with no key, lock, directory, or metadata mutation', () => {
    const before = metadataSnapshot(home);
    const result = automergeCanaryStatus();
    const after = metadataSnapshot(home);

    expect(result).toMatchObject({
      enforceSupported: false,
      sourceState: 'missing',
      severity: 'none',
      status: 'inactive',
      active: false,
      state: null,
    });
    expect(after).toEqual(before);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
    expect(fs.existsSync(automergeCanarySigningKeyPath())).toBe(false);
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(false);
  });

  it('explicitly refuses enforce activation before touching storage', () => {
    const before = metadataSnapshot(home);
    expect(activateEnforce()).toEqual({ ok: false, reason: 'enforce-unsupported' });
    expect(activateShadow(activationInput('enforce'))).toEqual({ ok: false, reason: 'enforce-unsupported' });
    expect(metadataSnapshot(home)).toEqual(before);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
    expect(fs.existsSync(automergeCanarySigningKeyPath())).toBe(false);
  });

  it('reports invalid ASHLR_HOME as degraded and refuses activation without throwing', () => {
    process.env.ASHLR_HOME = 'relative/controller-state';

    expect(() => automergeCanaryStatus()).not.toThrow();
    expect(automergeCanaryStatus()).toMatchObject({
      sourceState: 'degraded', severity: 'critical', status: 'critical',
      diagnostics: ['storage-unsafe'],
    });
    expect(activateShadow(activationInput())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('uses only an explicitly canonical absolute ASHLR_HOME', () => {
    for (const invalid of ['', 'relative-state', `${home}/state/../state`, `${home}\nstate`]) {
      process.env.ASHLR_HOME = invalid;
      expect(() => automergeCanaryStoreDirectory(), JSON.stringify(invalid))
        .toThrow('ASHLR_HOME must be canonical and absolute');
    }

    const configured = path.join(home, 'canary-state');
    process.env.ASHLR_HOME = configured;
    const state = activate();
    expect(state.state).toBe('shadow');
    expect(automergeCanaryStoreDirectory()).toBe(path.join(configured, 'fleet', 'automerge-canary'));
    expect(fs.existsSync(automergeCanaryStoreDirectory())).toBe(true);
  });

  it('activates one immutable shadow epoch with private metadata-only storage', () => {
    const state = activate();
    const status = readAutomergeCanaryStore({ now: new Date('2026-07-13T12:00:01.000Z') });

    expect(status).toMatchObject({
      enforceSupported: false,
      sourceState: 'healthy',
      severity: 'none',
      status: 'shadow',
      active: true,
      state: { epochId: state.epochId, revision: 1, mode: 'shadow', state: 'shadow' },
    });
    expect(state.observation).toEqual({
      startedAt: state.activatedAt,
      deadlineAt: '2026-07-20T12:00:00.000Z',
      completedAt: null,
    });
    expect(readAutomergeCanaryStore({ now: new Date(state.observation.deadlineAt!) })).toMatchObject({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      diagnostics: ['observation-overdue'],
    });
    const directory = fs.lstatSync(automergeCanaryStoreDirectory());
    const revision = fs.lstatSync(revisionFiles()[0]!);
    const key = fs.lstatSync(automergeCanarySigningKeyPath());
    if (process.platform !== 'win32') {
      expect(directory.mode & 0o077).toBe(0);
      expect(revision.mode & 0o077).toBe(0);
      expect(key.mode & 0o077).toBe(0);
    }
    expect(revision.nlink).toBe(1);
    expect(key.nlink).toBe(1);
    expect(key.size).toBe(32);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);

    const persisted = fs.readdirSync(path.join(home, '.ashlr'), { recursive: true, encoding: 'utf8' })
      .map(String)
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(home, '.ashlr', name), 'utf8'))
      .join('\n');
    expect(persisted).not.toContain(RAW_REPOSITORY);
    expect(persisted).not.toContain(RAW_FETCH);
    expect(persisted).not.toContain(RAW_PUSH);
    expect(persisted).not.toContain('docs/readme.md');
  });

  it('completes short key, revision, and summary writes and cleans a zero-progress candidate', async () => {
    const shortWriteSource = String.raw`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWrite = fs.writeSync;
      fs.writeSync = (fd, buffer, offset, length, position) => {
        const prefix = Buffer.isBuffer(buffer) ? buffer.toString('utf8', 0, 24) : '';
        const bounded = prefix.includes('"pid"') ? length : Math.min(length, 7);
        return originalWrite(fd, buffer, offset, bounded, position);
      };
      syncBuiltinESMExports();
      const store = await import('./src/core/fleet/automerge-canary-store.ts');
      const activation = store.activateShadow(JSON.parse(process.env.CANARY_INPUT), {
        now: new Date('2026-07-13T12:00:00.000Z'),
      });
      const halted = activation.ok
        ? store.haltShadow({
            epochId: activation.state.epochId,
            revision: activation.state.revision,
            attestation: activation.state.attestation,
          }, { now: new Date('2026-07-13T12:01:00.000Z') })
        : activation;
      process.stdout.write(JSON.stringify({ activation, halted }));
    `;
    const env = {
      HOME: home,
      USERPROFILE: home,
      CANARY_INPUT: JSON.stringify(activationInput()),
    };
    const completed = await runChild(shortWriteSource, env);
    expect(completed['activation']).toMatchObject({ ok: true, state: { revision: 1 } });
    expect(completed['halted']).toMatchObject({ ok: true, state: { revision: 2, state: 'halted' } });
    expect(readAutomergeCanaryStore()).toMatchObject({ sourceState: 'healthy', active: false });
    expect(fs.readdirSync(automergeCanaryStoreDirectory()).some((name) => name.includes('publish-v1')))
      .toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    const zeroWriteSource = String.raw`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWrite = fs.writeSync;
      fs.writeSync = (fd, buffer, offset, length, position) => {
        const prefix = Buffer.isBuffer(buffer) ? buffer.toString('utf8', 0, 24) : '';
        return prefix.includes('"pid"') ? originalWrite(fd, buffer, offset, length, position) : 0;
      };
      syncBuiltinESMExports();
      const store = await import('./src/core/fleet/automerge-canary-store.ts');
      const result = store.activateShadow(JSON.parse(process.env.CANARY_INPUT));
      const names = fs.readdirSync(store.automergeCanaryStoreDirectory());
      process.stdout.write(JSON.stringify({ result, names }));
    `;
    const failed = await runChild(zeroWriteSource, env);
    expect(failed['result']).toEqual({ ok: false, reason: 'unavailable' });
    expect(failed['names']).toEqual([]);
    expect(readAutomergeCanaryStore()).toMatchObject({ sourceState: 'missing', active: false });
  });

  it.skipIf(process.platform === 'win32')('recovers private candidates across key, revision, and summary publication crashes', async () => {
    const env = {
      HOME: home,
      USERPROFILE: home,
      CANARY_INPUT: JSON.stringify(activationInput()),
    };
    const crashSource = (target: 'key' | 'revision' | 'summary', beforeLink: boolean, operation: string) => String.raw`
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const originalLink = fs.linkSync;
      fs.linkSync = (existing, published) => {
        const name = path.basename(String(published));
        const matches = ${JSON.stringify(target)} === 'key'
          ? name === '.controller-signing.key'
          : ${JSON.stringify(target)} === 'revision'
            ? name.endsWith('-0002.json')
            : name.startsWith('.terminal-v1-');
        if (matches && ${String(beforeLink)}) process.exit(71);
        originalLink(existing, published);
        if (matches) process.exit(72);
      };
      syncBuiltinESMExports();
      const store = await import('./src/core/fleet/automerge-canary-store.ts');
      ${operation}
      process.exit(1);
    `;

    expect(await runCrashingChild(crashSource('key', true,
      `store.activateShadow(JSON.parse(process.env.CANARY_INPUT));`), env)).toBe(71);
    expect(fs.existsSync(automergeCanarySigningKeyPath())).toBe(false);
    expect(fs.readdirSync(automergeCanaryStoreDirectory()).some((name) => name.includes('publish-v1')))
      .toBe(true);
    const active = activate();
    expect(fs.readdirSync(automergeCanaryStoreDirectory()).some((name) => name.includes('publish-v1')))
      .toBe(false);

    const evidence = shadowEvidence(active);
    const revisionEnv = { ...env, CANARY_CAS: JSON.stringify(cas(active)), CANARY_EVIDENCE: JSON.stringify(evidence) };
    expect(await runCrashingChild(crashSource('revision', false, String.raw`
      const evidence = JSON.parse(process.env.CANARY_EVIDENCE);
      store.appendShadowObservation(
        JSON.parse(process.env.CANARY_CAS),
        evidence,
        { now: new Date(evidence.observedAt) },
      );
    `), revisionEnv)).toBe(72);
    const recoveredRevision = readAutomergeCanaryStore({ now: activeFixtureNow() });
    expect(recoveredRevision).toMatchObject({
      sourceState: 'healthy', active: true, state: { revision: 2, state: 'shadow' },
    });
    expect(haltShadow(cas(recoveredRevision.state!), { now: new Date('2026-07-13T12:02:00.000Z') }))
      .toMatchObject({ ok: true, state: { revision: 3, state: 'halted' } });

    const summaryActive = activate(new Date('2026-07-13T12:03:00.000Z'));
    const summaryEnv = { ...env, CANARY_CAS: JSON.stringify(cas(summaryActive)) };
    expect(await runCrashingChild(crashSource('summary', false, String.raw`
      store.haltShadow(JSON.parse(process.env.CANARY_CAS), {
        now: new Date('2026-07-13T12:04:00.000Z'),
      });
    `), summaryEnv)).toBe(72);
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'healthy', active: false, state: { revision: 2, state: 'halted' },
    });
    expect(haltShadow(cas(summaryActive), { now: new Date('2026-07-13T12:04:00.000Z') }))
      .toMatchObject({ ok: true, state: { revision: 2, state: 'halted' } });
    expect(readAutomergeCanaryStore()).toMatchObject({ sourceState: 'healthy', active: false });
    expect(fs.readdirSync(automergeCanaryStoreDirectory()).some((name) => name.includes('publish-v1')))
      .toBe(false);
  }, 30_000);

  it('starts shadow observation persistence at strict zero and derives counters without merge authority', () => {
    const first = activate();
    expect(first.shadowCounters).toEqual({
      attempts: 0,
      eligible: 0,
      rejected: 0,
      bindingMismatches: 0,
      inspectionErrors: 0,
      casRetries: 0,
    });
    expect(first.lastShadowEvidence).toBeNull();

    const evidence = shadowEvidence(first, { casRetries: 1 });
    const appended = appendShadowObservation(cas(first), evidence, { now: activeFixtureNow() });
    const { observationDigest: _staleDigest, casRetries: _retry, ...canonicalEvidence } = evidence;
    const reboundDigest = canonicalRetryObservationDigest(first, canonicalEvidence);
    expect(appended).toMatchObject({
      ok: true,
      state: {
        revision: 2,
        counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
        shadowCounters: {
          attempts: 1,
          eligible: 1,
          rejected: 0,
          bindingMismatches: 0,
          inspectionErrors: 0,
          casRetries: 1,
        },
        lastShadowEvidence: {
          observationDigest: reboundDigest,
          observedAt: evidence.observedAt,
          outcome: 'eligible',
        },
      },
    });
    if (!appended.ok) return;
    expect(Object.keys(appended.state.lastShadowEvidence!).sort()).toEqual([
      'baseOid', 'baseRefDigest', 'classifierDigest', 'configDigest', 'fetchDestinationDigest',
      'fileCount', 'headOid', 'lineCount', 'mismatchFields', 'observationDigest', 'observedAt',
      'outcome', 'pathDigest', 'policyDigest', 'pushDestinationDigest', 'reasonDigest',
      'repositoryId', 'treeOid',
    ]);
    expect(appended.state.lastShadowEvidence).not.toHaveProperty('casRetries');
    const persisted = fs.readFileSync(revisionFiles().at(-1)!, 'utf8');
    expect(persisted).not.toContain(RAW_SHADOW_REASON);
    expect(persisted).not.toContain('/private/secret.md');
    expect(persisted).not.toContain(RAW_REPOSITORY);

    const fabricated = appendShadowObservation(cas(appended.state), {
      ...shadowEvidence(appended.state),
      counters: { admissions: 1, merges: 1, inFlight: 0, rollbacks: 0 },
    } as AutoMergeCanaryShadowObservationInput, { now: new Date(appended.state.clockHighWater) });
    expect(fabricated).toEqual({ ok: false, reason: 'invalid' });
    expect(readAutomergeCanaryStore({ now: new Date(appended.state.clockHighWater) }).state?.revision).toBe(2);
  });

  it.each([
    ['at the exact deadline', 0],
    ['after the deadline', 1],
  ])('refuses shadow evidence %s without consuming counters or revision capacity', (_label, offsetMs) => {
    const first = activate();
    const deadlineMs = Date.parse(first.observation.deadlineAt!);
    const attemptedAt = new Date(deadlineMs + offsetMs);
    const evidence = shadowEvidence(first, {
      observedAt: new Date(deadlineMs - 1).toISOString(),
    });
    const beforeFiles = revisionFiles();

    expect(appendShadowObservation(cas(first), evidence, { now: attemptedAt }))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(revisionFiles()).toEqual(beforeFiles);
    expect(readAutomergeCanaryStore({ now: attemptedAt })).toMatchObject({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      diagnostics: ['observation-overdue'],
      state: {
        revision: 1,
        shadowCounters: {
          attempts: 0,
          eligible: 0,
          rejected: 0,
          bindingMismatches: 0,
          inspectionErrors: 0,
          casRetries: 0,
        },
        lastShadowEvidence: null,
      },
    });
    expect(haltShadow(cas(first), { now: attemptedAt }))
      .toMatchObject({ ok: true, state: { revision: 2, state: 'halted' } });
  });

  it('validates exact observation schema, binding mismatches, outcome arithmetic, and retry bounds', () => {
    const first = activate();
    const wrongBase = 'd'.repeat(first.repository.baseOid.length);
    const binding = shadowEvidence(first, {
      observationDigest: digest('binding-mismatch'),
      outcome: 'binding-mismatch',
      mismatchFields: ['baseOid'],
      baseOid: wrongBase,
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
    });
    const appended = appendShadowObservation(cas(first), binding, { now: activeFixtureNow() });
    expect(appended).toMatchObject({
      ok: true,
      state: {
        shadowCounters: { attempts: 1, bindingMismatches: 1 },
        lastShadowEvidence: { mismatchFields: ['baseOid'], baseOid: wrongBase },
      },
    });
    if (!appended.ok) return;

    const next = shadowEvidence(appended.state, { observationDigest: digest('invalid-binding') });
    expect(appendShadowObservation(cas(appended.state), {
      ...next,
      outcome: 'binding-mismatch',
    }), { now: new Date(appended.state.clockHighWater) }).toEqual({ ok: false, reason: 'invalid' });
    expect(appendShadowObservation(cas(appended.state), {
      ...next,
      casRetries: 2,
    } as AutoMergeCanaryShadowObservationInput, { now: new Date(appended.state.clockHighWater) }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(appendShadowObservation(cas(appended.state), {
      ...next,
      rawReason: RAW_SHADOW_REASON,
    } as AutoMergeCanaryShadowObservationInput, { now: new Date(appended.state.clockHighWater) }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(readAutomergeCanaryStore({ now: new Date(appended.state.clockHighWater) }).state?.revision).toBe(2);
  });

  it('deduplicates an observation digest idempotently without consuming a revision', () => {
    const first = activate();
    const evidence = shadowEvidence(first);
    const appended = appendShadowObservation(cas(first), evidence, { now: activeFixtureNow() });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    expect(appendShadowObservation(cas(first), evidence, {
      now: new Date(appended.state.clockHighWater),
    })).toMatchObject({
      ok: true,
      state: { revision: 2, shadowCounters: { attempts: 1 } },
    });
    expect(appendShadowObservation(cas(appended.state), evidence, {
      now: new Date(appended.state.clockHighWater),
    })).toMatchObject({
      ok: true,
      state: { revision: 2, shadowCounters: { attempts: 1 } },
    });
    const newerEvidence = shadowEvidence(appended.state, {
      observationDigest: digest('newer-shadow-observation'),
      outcome: 'rejected',
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
    });
    const newer = appendShadowObservation(cas(appended.state), newerEvidence, {
      now: new Date(newerEvidence.observedAt),
    });
    expect(newer).toMatchObject({ ok: true, state: { revision: 3, shadowCounters: { attempts: 2 } } });
    if (!newer.ok) return;
    expect(appendShadowObservation(cas(first), evidence, {
      now: new Date(newer.state.clockHighWater),
    })).toMatchObject({
      ok: true,
      state: { revision: 3, shadowCounters: { attempts: 2 } },
    });
    expect(appendShadowObservation(cas(first), {
      ...evidence,
      reasonDigest: digest('different-reason-with-reused-digest'),
    }, { now: new Date(newer.state.clockHighWater) })).toEqual({ ok: false, reason: 'invalid' });
    expect(revisionFiles()).toHaveLength(3);
  });

  it('does not write for missing, halted, or halt-requested state', () => {
    const fakeCas: AutoMergeCanaryCas = {
      epochId: '123e4567-e89b-42d3-a456-426614174000',
      revision: 1,
      attestation: digest('missing-attestation'),
    };
    const fakeEvidence: AutoMergeCanaryShadowObservationInput = {
      observationDigest: digest('missing-observation'),
      observedAt: '2026-07-13T12:00:01.000Z',
      outcome: 'inspection-error',
      mismatchFields: [],
      repositoryId: digest('missing-repository'),
      fetchDestinationDigest: digest('missing-fetch'),
      pushDestinationDigest: digest('missing-push'),
      baseRefDigest: digest('missing-base-ref'),
      baseOid: null,
      headOid: null,
      policyDigest: digest('missing-policy'),
      configDigest: digest('missing-config'),
      classifierDigest: digest('missing-classifier'),
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
      reasonDigest: digest('missing'),
      pathDigest: null,
      casRetries: 0,
    };
    const missingBefore = metadataSnapshot(home);
    expect(appendShadowObservation(fakeCas, fakeEvidence)).toEqual({ ok: false, reason: 'conflict' });
    expect(metadataSnapshot(home)).toEqual(missingBefore);

    const active = activate();
    const activeEvidence = shadowEvidence(active);
    const halted = haltShadow(cas(active), { now: new Date(activeEvidence.observedAt) });
    expect(halted.ok).toBe(true);
    const haltedBefore = metadataSnapshot(path.join(home, '.ashlr'));
    expect(appendShadowObservation(cas(active), activeEvidence, {
      now: new Date(activeEvidence.observedAt),
    })).toEqual({ ok: false, reason: 'conflict' });
    expect(metadataSnapshot(path.join(home, '.ashlr'))).toEqual(haltedBefore);

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    const second = activate();
    const requested = appendRevision(cas(second), { state: 'halt-requested' }, {
      now: new Date(Date.parse(second.clockHighWater) + 1),
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const requestedBefore = metadataSnapshot(path.join(home, '.ashlr'));
    expect(appendShadowObservation(cas(requested.state), shadowEvidence(requested.state), {
      now: new Date(requested.state.clockHighWater),
    }))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(metadataSnapshot(path.join(home, '.ashlr'))).toEqual(requestedBefore);
  });

  it('does not alter an existing Foundry provenance key during shadow activation', () => {
    process.env.ASHLR_HOME = path.join(home, 'controller-state');
    const foundryKey = provenanceKeyPath();
    fs.mkdirSync(path.dirname(foundryKey), { recursive: true, mode: 0o700 });
    fs.writeFileSync(foundryKey, Buffer.alloc(32, 0x5a), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(foundryKey, 0o600);
    const before = metadataSnapshot(path.dirname(foundryKey));
    const bytes = fs.readFileSync(foundryKey);

    activate();

    expect(metadataSnapshot(path.dirname(foundryKey))).toEqual(before);
    expect(fs.readFileSync(foundryKey)).toEqual(bytes);
    expect(automergeCanarySigningKeyPath()).not.toBe(foundryKey);
    expect(fs.readFileSync(automergeCanarySigningKeyPath())).toHaveLength(32);
    expect(fs.readFileSync(automergeCanarySigningKeyPath())).not.toEqual(bytes);
  });

  it('does not mutate existing state, key, lock files, modes, or mtimes during status reads', () => {
    activate();
    const before = metadataSnapshot(path.join(home, '.ashlr'));
    const first = readAutomergeCanaryStore({ now: new Date('2026-07-13T12:00:01.000Z') });
    const second = automergeCanaryStatus({ now: new Date('2026-07-13T12:00:02.000Z') });
    const after = metadataSnapshot(path.join(home, '.ashlr'));

    expect(first.sourceState).toBe('healthy');
    expect(second.sourceState).toBe('healthy');
    expect(after).toEqual(before);
  });

  it('detects byte tampering and exact-schema additions as critical degradation', () => {
    activate();
    const file = revisionFiles()[0]!;
    const tampered = fs.readFileSync(file, 'utf8').replace('"maxAdmissions":1', '"maxAdmissions":2');
    fs.writeFileSync(file, tampered);
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'degraded', severity: 'critical', status: 'critical', diagnostics: ['invalid-record'],
    });

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    activate();
    rewriteSignedRecord(revisionFiles()[0]!, (row) => { row['rawPath'] = RAW_REPOSITORY; });
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');
  });

  it('detects HMAC tampering and validly signed shadow counter or transition fabrication', () => {
    const first = activate();
    const appended = appendShadowObservation(cas(first), shadowEvidence(first), { now: activeFixtureNow() });
    expect(appended.ok).toBe(true);
    const latest = revisionFiles().at(-1)!;
    fs.writeFileSync(latest, fs.readFileSync(latest, 'utf8').replace('"attempts":1', '"attempts":2'));
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    const second = activate();
    expect(appendShadowObservation(cas(second), shadowEvidence(second), { now: activeFixtureNow() }).ok)
      .toBe(true);
    rewriteSignedRecord(revisionFiles().at(-1)!, (row) => {
      row['shadowCounters'] = {
        attempts: 2,
        eligible: 1,
        rejected: 0,
        bindingMismatches: 0,
        inspectionErrors: 0,
        casRetries: 0,
      };
    });
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    const third = activate();
    const thirdObservation = appendShadowObservation(cas(third), shadowEvidence(third), {
      now: activeFixtureNow(),
    });
    expect(thirdObservation.ok).toBe(true);
    if (!thirdObservation.ok) return;
    const ordinary = appendRevision(cas(thirdObservation.state), { state: 'shadow' }, {
      now: new Date(Date.parse(thirdObservation.state.clockHighWater) + 1),
    });
    expect(ordinary.ok).toBe(true);
    rewriteSignedRecord(revisionFiles().at(-1)!, (row) => {
      row['shadowCounters'] = {
        attempts: 2,
        eligible: 2,
        rejected: 0,
        bindingMismatches: 0,
        inspectionErrors: 0,
        casRetries: 0,
      };
    });
    expect(readAutomergeCanaryStore().diagnostics).toContain('chain-broken');
  });

  it('detects a validly signed broken chain, a missing revision, and a duplicate logical revision', () => {
    const first = activate();
    const secondResult = appendRevision(cas(first), { state: 'shadow' }, {
      now: new Date('2026-07-13T12:01:00.000Z'),
    });
    expect(secondResult.ok).toBe(true);
    rewriteSignedRecord(revisionFiles()[1]!, (row) => { row['previousAttestation'] = digest('wrong-parent'); });
    expect(readAutomergeCanaryStore().diagnostics).toContain('chain-broken');

    fs.rmSync(revisionFiles()[0]!);
    expect(readAutomergeCanaryStore().diagnostics).toContain('revision-gap');

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
    activate();
    const original = revisionFiles()[0]!;
    const duplicate = original.replace('-0001.json', '-0002.json');
    fs.copyFileSync(original, duplicate);
    fs.chmodSync(duplicate, 0o600);
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');
  });

  it('classifies two independently valid active epochs as a critical conflict', () => {
    activate();
    const key = fs.readFileSync(automergeCanarySigningKeyPath());
    const row = JSON.parse(fs.readFileSync(revisionFiles()[0]!, 'utf8')) as Record<string, unknown>;
    const epochId = '123e4567-e89b-42d3-a456-426614174000';
    row['epochId'] = epochId;
    row['activatedAt'] = '2026-07-13T12:00:01.000Z';
    row['updatedAt'] = '2026-07-13T12:00:01.000Z';
    row['clockHighWater'] = '2026-07-13T12:00:01.000Z';
    row['observation'] = {
      startedAt: '2026-07-13T12:00:01.000Z',
      deadlineAt: '2026-07-20T12:00:01.000Z',
      completedAt: null,
    };
    delete row['attestation'];
    row['attestation'] = createHmac('sha256', key)
      .update(JSON.stringify([RECORD_DOMAIN, row]))
      .digest('hex');
    const conflicting = path.join(automergeCanaryStoreDirectory(), `.epoch-v1-${epochId}-0001.json`);
    fs.writeFileSync(conflicting, `${JSON.stringify(row)}\n`, { mode: 0o600 });

    expect(readAutomergeCanaryStore({ now: new Date('2026-07-13T12:00:02.000Z') })).toMatchObject({
      sourceState: 'degraded',
      severity: 'critical',
      diagnostics: ['epoch-conflict'],
    });
  });

  it('reserves revision 64 for emergency halt and fails closed at the ordinary append cap', () => {
    let state = activate();
    for (let revision = 2; revision < AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH; revision += 1) {
      const result = appendRevision(cas(state), { state: 'shadow' }, {
        now: new Date(Date.parse(state.clockHighWater) + 1),
      });
      expect(result.ok, `revision ${revision}`).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      state = result.state;
    }
    expect(state.revision).toBe(63);
    expect(revisionFiles()).toHaveLength(63);
    expect(appendRevision(cas(state), { state: 'shadow' }, { now: new Date(state.clockHighWater) }))
      .toEqual({ ok: false, reason: 'capacity' });
    expect(appendShadowObservation(cas(state), shadowEvidence(state), {
      now: new Date(state.clockHighWater),
    }))
      .toEqual({ ok: false, reason: 'capacity' });
    expect(revisionFiles()).toHaveLength(63);
    expect(readAutomergeCanaryStore({ now: new Date(state.clockHighWater) })).toMatchObject({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      diagnostics: ['capacity-exceeded'],
      limitExceeded: true,
      state: { revision: 63, state: 'shadow' },
    });

    const halted = haltShadow(cas(state), {
      now: new Date(Date.parse(state.clockHighWater) + 1),
      blockerCode: 'revision-cap-halt',
    });
    expect(halted).toMatchObject({ ok: true, state: { revision: 64, state: 'halted' } });
    expect(revisionFiles()).toHaveLength(64);
    expect(readAutomergeCanaryStore().sourceState).toBe('healthy');

    const overCap = revisionFiles().at(-1)!.replace('-0064.json', '-0065.json');
    fs.copyFileSync(revisionFiles().at(-1)!, overCap);
    fs.chmodSync(overCap, 0o600);
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'degraded', severity: 'critical', limitExceeded: true,
    });
    expect(readAutomergeCanaryStore().diagnostics).toContain('capacity-exceeded');
  }, 30_000);

  it('retains at most 32 terminal epoch summaries and refuses the next activation without GC', () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    for (let epoch = 0; epoch < AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS; epoch += 1) {
      const state = activate(new Date(now));
      now += 1;
      const halted = haltShadow(cas(state), { now: new Date(now), blockerCode: `bounded-halt-${epoch}` });
      expect(halted.ok, `epoch ${epoch}`).toBe(true);
      now += 1;
    }
    const read = readAutomergeCanaryStore({ now: new Date(now + 1) });
    expect(read.sourceState).toBe('healthy');
    expect(read.terminalEpochs).toHaveLength(32);
    expect(activateShadow(activationInput(), { now: new Date(now + 2) }))
      .toEqual({ ok: false, reason: 'capacity' });
  }, 30_000);

  it('classifies future authenticated observations as critical', () => {
    activate();
    const future = '2036-01-01T00:00:00.000Z';
    rewriteSignedRecord(revisionFiles()[0]!, (row) => {
      row['activatedAt'] = future;
      row['updatedAt'] = future;
      row['clockHighWater'] = future;
      row['observation'] = {
        startedAt: future,
        deadlineAt: '2036-01-08T00:00:00.000Z',
        completedAt: null,
      };
    });
    expect(readAutomergeCanaryStore({ now: new Date('2026-07-13T12:00:00.000Z') })).toMatchObject({
      sourceState: 'degraded',
      severity: 'critical',
      diagnostics: ['future-time'],
    });
  });

  it('durably blocks clock rollback while preserving the activation observation window', () => {
    const first = activate();
    const startedAt = '2026-07-13T12:01:00.000Z';
    const withGate = appendRevision(cas(first), { state: 'shadow' }, { now: new Date(startedAt) });
    expect(withGate.ok).toBe(true);
    if (!withGate.ok) return;

    const rolledBack = appendRevision(cas(withGate.state), {
      observation: withGate.state.observation,
    }, { now: new Date('2026-07-13T11:59:00.000Z') });
    expect(rolledBack).toMatchObject({
      ok: true,
      clockRollbackDetected: true,
      state: {
        state: 'halt-requested',
        clockHighWater: startedAt,
        observation: first.observation,
        blocker: { code: 'clock-rollback', severity: 'critical', since: startedAt },
      },
    });
    expect(readAutomergeCanaryStore({ now: new Date(startedAt) })).toMatchObject({
      sourceState: 'healthy', severity: 'critical', status: 'critical', active: true,
    });
  });

  it('rejects counter reset and shortened observation or lease gates', () => {
    const first = activate();
    const acquiredAt = '2026-07-13T12:01:00.000Z';
    const expiresAt = '2026-07-13T12:11:00.000Z';
    const second = appendRevision(cas(first), {
      counters: { admissions: 1, merges: 0, inFlight: 1, rollbacks: 0 },
      lease: { holderDigest: digest('owner'), acquiredAt, expiresAt },
    }, { now: new Date(acquiredAt) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(appendRevision(cas(second.state), {
      counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(appendRevision(cas(second.state), {
      lease: {
        holderDigest: digest('owner'),
        acquiredAt,
        expiresAt: '2026-07-13T12:10:00.000Z',
      },
    })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('marks expired leases and overdue observations critical while retaining emergency halt authority', () => {
    const first = activate();
    const startedAt = '2026-07-13T12:01:00.000Z';
    const active = appendRevision(cas(first), {
      counters: { admissions: 1, merges: 0, inFlight: 1, rollbacks: 0 },
      lease: {
        holderDigest: digest('stale-owner'),
        acquiredAt: startedAt,
        expiresAt: '2026-07-13T12:11:00.000Z',
      },
    }, { now: new Date(startedAt) });
    expect(active.ok).toBe(true);
    if (!active.ok) return;

    expect(readAutomergeCanaryStore({ now: new Date('2026-07-21T12:01:00.000Z') })).toMatchObject({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      diagnostics: ['lease-expired', 'observation-overdue'],
    });
    expect(haltShadow(cas(active.state), { now: new Date('2026-07-21T12:01:01.000Z') }))
      .toMatchObject({ ok: true, state: { state: 'halted' } });
  });

  it('rejects impossible counters and lease or observation windows beyond effective-time budgets', () => {
    const first = activate();
    const now = '2026-07-13T12:01:00.000Z';
    expect(appendRevision(cas(first), {
      counters: { admissions: 0, merges: 0, inFlight: 1, rollbacks: 0 },
    }, { now: new Date(now) })).toEqual({ ok: false, reason: 'invalid' });
    expect(appendRevision(cas(first), {
      counters: { admissions: 1, merges: 0, inFlight: 0, rollbacks: 1 },
    }, { now: new Date(now) })).toEqual({ ok: false, reason: 'invalid' });
    expect(appendRevision(cas(first), {
      lease: {
        holderDigest: digest('owner'),
        acquiredAt: now,
        expiresAt: '2026-07-13T12:11:00.001Z',
      },
    }, { now: new Date(now) })).toEqual({ ok: false, reason: 'invalid' });
    expect(appendRevision(cas(first), {
      observation: {
        startedAt: now,
        deadlineAt: '2026-07-20T12:01:00.001Z',
        completedAt: null,
      },
    }, { now: new Date(now) })).toEqual({ ok: false, reason: 'invalid' });
    expect(appendRevision(cas(first), {
      lease: {
        holderDigest: digest('future-owner'),
        acquiredAt: '2026-07-13T12:01:00.001Z',
        expiresAt: '2026-07-13T12:11:00.001Z',
      },
    }, { now: new Date(now) })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('allows only haltShadow to terminalize and clears in-flight lease and pending-effect state', () => {
    const first = activate();
    expect(appendRevision(cas(first), { state: 'halted' }))
      .toEqual({ ok: false, reason: 'invalid' });

    const at = '2026-07-13T12:01:00.000Z';
    const active = appendRevision(cas(first), {
      counters: { admissions: 1, merges: 0, inFlight: 1, rollbacks: 0 },
      lease: {
        holderDigest: digest('owner'),
        acquiredAt: at,
        expiresAt: '2026-07-13T12:11:00.000Z',
      },
      pendingEffect: { kind: 'shadow-observation', effectDigest: digest('effect'), requestedAt: at },
    }, { now: new Date(at) });
    expect(active.ok).toBe(true);
    if (!active.ok) return;

    const halted = haltShadow(cas(active.state), {
      now: new Date('2026-07-13T12:02:00.000Z'),
      blockerCode: 'active-emergency-halt',
    });
    expect(halted).toMatchObject({
      ok: true,
      state: {
        state: 'halted',
        counters: { admissions: 1, merges: 0, inFlight: 0, rollbacks: 0 },
        lease: { holderDigest: null, acquiredAt: null, expiresAt: null },
        pendingEffect: null,
      },
    });
  });

  it('rejects a validly signed halted record that retains non-terminal work state', () => {
    const first = activate();
    const halted = haltShadow(cas(first), { now: new Date('2026-07-13T12:01:00.000Z') });
    expect(halted.ok).toBe(true);
    rewriteSignedRecord(revisionFiles().at(-1)!, (row) => {
      row['counters'] = { admissions: 1, merges: 0, inFlight: 1, rollbacks: 0 };
    });
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');
  });

  it.skipIf(process.platform === 'win32')('elects exactly one activation and one CAS winner across processes', async () => {
    const activateSource = String.raw`
      import { activateShadow } from './src/core/fleet/automerge-canary-store.ts';
      const result = activateShadow(JSON.parse(process.env.CANARY_INPUT));
      process.stdout.write(JSON.stringify(result));
    `;
    const env = {
      HOME: home,
      USERPROFILE: home,
      CANARY_INPUT: JSON.stringify(activationInput()),
    };
    const activations = await Promise.all([
      runChild(activateSource, env),
      runChild(activateSource, env),
    ]);
    expect(activations.filter((result) => result['ok'] === true), JSON.stringify(activations)).toHaveLength(1);
    expect(activations.filter((result) => result['reason'] === 'conflict'), JSON.stringify(activations)).toHaveLength(1);
    expect(readAutomergeCanaryStore().revisions).toHaveLength(1);

    const state = readAutomergeCanaryStore().state!;
    const appendSource = String.raw`
      import { appendRevision } from './src/core/fleet/automerge-canary-store.ts';
      const result = appendRevision(JSON.parse(process.env.CANARY_CAS), { state: 'shadow' });
      process.stdout.write(JSON.stringify(result));
    `;
    const casEnv = { ...env, CANARY_CAS: JSON.stringify(cas(state)) };
    const appends = await Promise.all([
      runChild(appendSource, casEnv),
      runChild(appendSource, casEnv),
    ]);
    expect(appends.filter((result) => result['ok'] === true), JSON.stringify(appends)).toHaveLength(1);
    expect(appends.filter((result) => result['reason'] === 'conflict'), JSON.stringify(appends)).toHaveLength(1);
    expect(readAutomergeCanaryStore().revisions).toHaveLength(2);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('elects one shadow observation winner and counts one successful observer retry', async () => {
    const first = activate();
    const eligible = shadowEvidence(first, { observationDigest: digest('concurrent-eligible') });
    const rejected = shadowEvidence(first, {
      observationDigest: digest('concurrent-rejected'),
      outcome: 'rejected',
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
      reasonDigest: digest('concurrent rejection'),
    });
    const source = String.raw`
      import { appendShadowObservation } from './src/core/fleet/automerge-canary-store.ts';
      const evidence = JSON.parse(process.env.CANARY_EVIDENCE);
      const result = appendShadowObservation(
        JSON.parse(process.env.CANARY_CAS),
        evidence,
        { now: new Date(evidence.observedAt) },
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const baseEnv = {
      HOME: home,
      USERPROFILE: home,
      CANARY_CAS: JSON.stringify(cas(first)),
    };
    const results = await Promise.all([
      runChild(source, { ...baseEnv, CANARY_EVIDENCE: JSON.stringify(eligible) }),
      runChild(source, { ...baseEnv, CANARY_EVIDENCE: JSON.stringify(rejected) }),
    ]);
    expect(results.filter((result) => result['ok'] === true), JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((result) => result['reason'] === 'conflict'), JSON.stringify(results)).toHaveLength(1);

    const winner = readAutomergeCanaryStore({ now: activeFixtureNow() }).state!;
    expect(winner).toMatchObject({
      revision: 2,
      counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
      shadowCounters: { attempts: 1, casRetries: 0 },
    });
    const retryEvidence = shadowEvidence(winner, {
      observationDigest: digest('observer-retry-success'),
      outcome: 'inspection-error',
      baseOid: null,
      headOid: null,
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
      pathDigest: null,
      reasonDigest: digest('observer refreshed after CAS conflict'),
      casRetries: 1,
    });
    const retry = appendShadowObservation(cas(winner), retryEvidence, {
      now: new Date(retryEvidence.observedAt),
    });
    expect(retry).toMatchObject({
      ok: true,
      state: {
        revision: 3,
        counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
        shadowCounters: { attempts: 2, inspectionErrors: 1, casRetries: 1 },
      },
    });
    expect(revisionFiles()).toHaveLength(3);
  }, 30_000);

  it('rebinds a CAS retry digest and signed revision when observedAt advances', () => {
    const first = activate();
    const stale = shadowEvidence(first, { casRetries: 1 });
    const retriedAt = new Date(Date.parse(stale.observedAt) + 5_000).toISOString();
    const retried = { ...stale, observedAt: retriedAt };
    const { observationDigest: staleDigest, casRetries: _retry, ...canonicalEvidence } = retried;
    const reboundDigest = canonicalRetryObservationDigest(first, canonicalEvidence);

    expect(reboundDigest).not.toBe(staleDigest);
    const appended = appendShadowObservation(cas(first), retried, { now: new Date(retriedAt) });
    expect(appended).toMatchObject({
      ok: true,
      state: {
        revision: 2,
        updatedAt: retriedAt,
        clockHighWater: retriedAt,
        lastShadowEvidence: { observedAt: retriedAt, observationDigest: reboundDigest },
        shadowCounters: { attempts: 1, casRetries: 1 },
      },
    });
    if (!appended.ok) return;
    expect(appended.state.attestation).not.toBe(first.attestation);
    expect(readAutomergeCanaryStore({ now: new Date(retriedAt) })).toMatchObject({
      sourceState: 'healthy',
      state: {
        attestation: appended.state.attestation,
        lastShadowEvidence: { observedAt: retriedAt, observationDigest: reboundDigest },
      },
    });
  });

  it.runIf(process.platform !== 'win32')('fails closed on permissive modes, symlinks, and multiply linked authority files', () => {
    activate();
    fs.chmodSync(revisionFiles()[0]!, 0o644);
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');

    fs.chmodSync(revisionFiles()[0]!, 0o600);
    const hardlink = path.join(home, 'revision-hardlink');
    fs.linkSync(revisionFiles()[0]!, hardlink);
    expect(readAutomergeCanaryStore().diagnostics).toContain('invalid-record');
    fs.unlinkSync(hardlink);

    const store = automergeCanaryStoreDirectory();
    const moved = `${store}-real`;
    fs.renameSync(store, moved);
    fs.symlinkSync(moved, store, 'dir');
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'degraded', severity: 'critical', diagnostics: ['storage-unsafe'],
    });
  });

  it('fails closed when the dedicated key is deleted or replaced unsafely without repairing it', () => {
    const state = activate();
    const keyPath = automergeCanarySigningKeyPath();
    const key = fs.readFileSync(keyPath);
    fs.unlinkSync(keyPath);
    const before = metadataSnapshot(path.join(home, '.ashlr'));
    expect(readAutomergeCanaryStore().diagnostics).toContain('key-unavailable');
    expect(metadataSnapshot(path.join(home, '.ashlr'))).toEqual(before);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(appendRevision(cas(state), { state: 'shadow' })).toEqual({ ok: false, reason: 'degraded' });

    const replacement = path.join(home, 'canary-key-replacement');
    fs.writeFileSync(replacement, key, { mode: 0o600 });
    fs.linkSync(replacement, keyPath);
    expect(fs.lstatSync(keyPath).nlink).toBe(2);
    const unsafeBefore = metadataSnapshot(path.join(home, '.ashlr'));
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'degraded', severity: 'critical', diagnostics: ['key-unavailable'],
    });
    expect(metadataSnapshot(path.join(home, '.ashlr'))).toEqual(unsafeBefore);
    expect(haltShadow(cas(state))).toEqual({ ok: false, reason: 'degraded' });
  });

  it('halts shadow state with one chained revision and one authenticated terminal summary', () => {
    const state = activate();
    const result = haltShadow(cas(state), {
      now: new Date('2026-07-13T12:01:00.000Z'),
      blockerCode: 'operator-requested',
    });
    expect(result).toMatchObject({ ok: true, state: { revision: 2, state: 'halted', pendingEffect: null } });
    const read = readAutomergeCanaryStore({ now: new Date('2026-07-13T12:01:01.000Z') });
    expect(read.sourceState).toBe('healthy');
    expect(read.active).toBe(false);
    expect(read.revisions).toHaveLength(2);
    expect(read.terminalEpochs).toMatchObject([{
      sequence: 1,
      epochId: state.epochId,
      terminalRevision: 2,
      terminalState: 'halted',
    }]);
  });

  it('idempotently recovers an interrupted terminal-summary publication', () => {
    const active = activate();
    const firstHalt = haltShadow(cas(active), {
      now: new Date('2026-07-13T12:01:00.000Z'),
      blockerCode: 'summary-recovery-halt',
    });
    expect(firstHalt.ok).toBe(true);
    expect(summaryFiles()).toHaveLength(1);

    // Models loss of the summary publication only; coherent history/key rollback remains out of scope.
    fs.unlinkSync(summaryFiles()[0]!);
    expect(readAutomergeCanaryStore()).toMatchObject({
      sourceState: 'degraded',
      diagnostics: ['terminal-conflict'],
    });

    const recovered = haltShadow(cas(active), {
      now: new Date('2026-07-13T12:02:00.000Z'),
      blockerCode: 'summary-recovery-halt',
    });
    expect(recovered).toMatchObject({ ok: true, state: { state: 'halted', revision: 2 } });
    expect(summaryFiles()).toHaveLength(1);
    expect(readAutomergeCanaryStore()).toMatchObject({ sourceState: 'healthy', active: false });

    const repeated = haltShadow(cas(active), {
      now: new Date('2026-07-13T12:03:00.000Z'),
      blockerCode: 'summary-recovery-halt',
    });
    expect(repeated).toMatchObject({ ok: true, state: { state: 'halted', revision: 2 } });
    expect(summaryFiles()).toHaveLength(1);
  });
});
