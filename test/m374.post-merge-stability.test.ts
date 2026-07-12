import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { recordPostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import {
  buildPostMergeStabilityCohortManifest,
  buildPostMergeStabilityWitness,
  postMergeStabilityDir,
  postMergeStabilityPartitionPath,
  readPostMergeStability,
  readPostMergeStabilityDetailed,
  recordPostMergeStabilityCohort,
  sanitizePostMergeStabilityWitness,
  verifyPostMergeStabilityCohortManifest,
  verifyPostMergeStabilityWitness,
  type PostMergeStabilityCohortInput,
  type PostMergeStabilityWitnessInput,
} from '../src/core/fleet/post-merge-stability.js';

let home: string;
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m374-stability-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function key(): void { expect(loadOrCreateKey()).toHaveLength(32); }

function witness(overrides: Partial<PostMergeStabilityWitnessInput> = {}): PostMergeStabilityWitnessInput {
  return {
    cohortId: 'cohort-2026-07-11-a',
    repo: join(home, 'repo'),
    proposalId: 'proposal-123',
    mergeCommit: 'a'.repeat(40),
    observedHead: 'b'.repeat(40),
    windowStartedAt: '2026-07-11T00:00:00.000Z',
    stableAt: '2026-07-11T12:00:00.000Z',
    windowMs: 12 * 60 * 60 * 1_000,
    verificationDigest: '2'.repeat(64),
    ...overrides,
  };
}

function cohort(overrides: Partial<PostMergeStabilityWitnessInput> = {}): PostMergeStabilityCohortInput {
  return {
    cohortId: 'cohort-2026-07-11-a',
    completedAt: '2026-07-11T12:01:00.000Z',
    witnesses: [witness(overrides)],
  };
}

describe('M374 post-merge stable-after-window cohorts', () => {
  it('fails closed without creating signing authority', () => {
    expect(buildPostMergeStabilityWitness(witness())).toBeNull();
    expect(existsSync(join(home, '.ashlr', 'foundry', 'provenance.key'))).toBe(false);
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'missing', sourcePresent: false, complete: true, witnesses: [],
      cohortSummary: { completeCohorts: 0, releasedWitnesses: 0, distinctRepoDigests: 0 },
    });
  });

  it('fails writes and verification when the existing provenance key disappears', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort())).toMatchObject({ recorded: 1 });
    rmSync(join(home, '.ashlr', 'foundry', 'provenance.key'));
    expect(recordPostMergeStabilityCohort(cohort({ proposalId: 'proposal-456' }))).toMatchObject({
      failed: 1, invalid: 0, recorded: 0,
    });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', complete: false, witnesses: [], stopReasons: ['key-unavailable'],
    });
  });

  it('builds strict signed witness and manifest types for outcome-watcher callers', () => {
    key();
    const built = buildPostMergeStabilityWitness(witness())!;
    const manifest = buildPostMergeStabilityCohortManifest(
      built.cohortId, '2026-07-11T12:01:00.000Z', [built],
    )!;
    expect(built).toMatchObject({
      schemaVersion: 1, recordType: 'stable-after-window', authority: 'observation-only',
      repoDigest: expect.stringMatching(/^[a-f0-9]{64}$/), witnessDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(built).not.toHaveProperty('repo');
    expect(manifest).toMatchObject({
      schemaVersion: 1, recordType: 'cohort-manifest', authority: 'observation-only',
      partitionDate: '2026-07-11', memberCount: 1,
      members: [{ witnessId: built.witnessId, witnessDigest: built.witnessDigest }],
    });
    expect(verifyPostMergeStabilityWitness(built)).toBe(true);
    expect(verifyPostMergeStabilityCohortManifest(manifest)).toBe(true);
    expect(verifyPostMergeStabilityWitness({ ...built, prompt: 'forbidden' })).toBe(false);
    expect(verifyPostMergeStabilityCohortManifest({ ...manifest, output: 'forbidden' })).toBe(false);
    rmSync(provenanceKeyPath());
    expect(verifyPostMergeStabilityWitness(built)).toBe(false);
    expect(verifyPostMergeStabilityCohortManifest(manifest)).toBe(false);
    expect(buildPostMergeStabilityWitness(witness())).toBeNull();
  });

  it('durably writes all witnesses before one complete manifest and summarizes the cohort', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort())).toMatchObject({
      attempted: 1, recorded: 1, witnessesRecorded: 1, invalid: 0, failed: 0,
    });
    const path = postMergeStabilityPartitionPath('2026-07-11');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { recordType: string });
    expect(rows.map((row) => row.recordType)).toEqual(['stable-after-window', 'cohort-manifest']);
    expect(readPostMergeStabilityDetailed()).toMatchObject({
      sourceState: 'healthy', complete: true, releasedCohorts: 1,
      cohortSummary: {
        completeCohorts: 1, releasedWitnesses: 1, distinctRepoDigests: 1,
        latestCompletedAt: '2026-07-11T12:01:00.000Z',
      },
    });
  });

  it('persists no repo path, prompts, diffs, output, environment, or files', () => {
    key();
    const secret = 'github_pat_never-persist-this';
    const supplied = Object.assign(witness(), {
      prompt: secret, diff: secret, output: secret, stdout: secret, stderr: secret,
      env: { TOKEN: secret }, files: [secret], fileContents: secret,
    });
    expect(recordPostMergeStabilityCohort({ ...cohort(), witnesses: [supplied] })).toMatchObject({ recorded: 1 });
    const raw = readFileSync(postMergeStabilityPartitionPath('2026-07-11'), 'utf8');
    for (const forbidden of ['"repo"', 'prompt', 'diff', 'output', 'stdout', 'stderr', 'env', 'files', secret, home]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('withholds orphan rows and requireComplete clears otherwise released evidence', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    const path = postMergeStabilityPartitionPath('2026-07-11');
    const first = readFileSync(path, 'utf8').split('\n')[0]!;
    writeFileSync(path, `${first}\n`, { mode: 0o600 });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', complete: false, witnesses: [], orphanWitnesses: 1,
      stopReasons: ['orphan-witness'],
    });
    expect(readPostMergeStability({ requireComplete: true })).toMatchObject({
      witnesses: [], manifests: [], releasedCohorts: 0,
      cohortSummary: { completeCohorts: 0, releasedWitnesses: 0 },
    });
  });

  it('rejects a manifest physically written before its witness', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    const path = postMergeStabilityPartitionPath('2026-07-11');
    const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
    writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', witnesses: [], incompleteManifests: 1, orphanWitnesses: 1,
      stopReasons: expect.arrayContaining(['incomplete-manifest', 'orphan-witness']),
    });
  });

  it('detects signed payload, signature, and extra-field tampering', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    const path = postMergeStabilityPartitionPath('2026-07-11');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    rows[0]!['observedHead'] = 'c'.repeat(40);
    rows[1]!['attestation'] = 'f'.repeat(64);
    rows.push({ ...rows[0], prompt: 'forbidden' });
    writeFileSync(path, `${rows.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', witnesses: [], invalidRows: 3,
      stopReasons: expect.arrayContaining(['invalid-row']),
    });
  });

  it('replays an exact cohort and refuses a conflicting manifest', () => {
    key();
    const first = cohort();
    expect(recordPostMergeStabilityCohort(first)).toMatchObject({ recorded: 1 });
    expect(recordPostMergeStabilityCohort(first)).toMatchObject({ replayed: 1, witnessesRecorded: 0 });
    expect(recordPostMergeStabilityCohort(cohort({
      proposalId: 'proposal-456', mergeCommit: 'c'.repeat(40), observedHead: 'd'.repeat(40),
    }))).toMatchObject({ conflicted: 1, recorded: 0, failed: 0 });
    expect(readPostMergeStability()).toMatchObject({ sourceState: 'healthy', physicalRows: 2, releasedCohorts: 1 });
  });

  it('keeps stable evidence when a later adverse observation coexists separately', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    expect(recordPostMergeObservation({
      observedAt: '2026-07-12T00:00:00.000Z', outcome: 'regressed', basis: 'bisect-first-bad',
      confidence: 'deterministic', repo: join(home, 'repo'), proposalId: 'proposal-123',
      mergeCommit: 'a'.repeat(40), observedHead: 'c'.repeat(40), baselineHead: 'd'.repeat(40),
    })).toMatchObject({ recorded: 1 });
    expect(readPostMergeStability()).toMatchObject({ witnesses: [expect.objectContaining({ proposalId: 'proposal-123' })] });
    expect(readFileSync(postMergeStabilityPartitionPath('2026-07-11'), 'utf8')).not.toContain('regressed');
  });

  it('enforces 0700/0600 and refuses symlink, hardlink, and widened paths', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    const path = postMergeStabilityPartitionPath('2026-07-11');
    if (process.platform !== 'win32') {
      expect(lstatSync(postMergeStabilityDir()).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    chmodSync(path, 0o644);
    expect(readPostMergeStability()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'] });
    rmSync(path);
    const target = join(home, 'target.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, path);
    expect(recordPostMergeStabilityCohort(cohort())).toMatchObject({ failed: 1 });
    rmSync(path);
    linkSync(target, path);
    expect(recordPostMergeStabilityCohort(cohort())).toMatchObject({ failed: 1 });
  });

  it('reports file, byte, row, row-size, and member bounds', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    expect(readPostMergeStability({ maxFiles: 0 })).toMatchObject({
      sourceState: 'degraded', limitExceeded: true, stopReasons: ['file-limit'], filesRead: 0,
    });
    expect(readPostMergeStability({ maxBytes: 1 })).toMatchObject({
      sourceState: 'degraded', limitExceeded: true, stopReasons: ['byte-limit'], witnesses: [],
    });
    expect(readPostMergeStability({ maxRows: 1 })).toMatchObject({
      sourceState: 'degraded', limitExceeded: true, stopReasons: expect.arrayContaining(['row-limit']),
    });
    writeFileSync(postMergeStabilityPartitionPath('2026-07-11'), `${'x'.repeat(16 * 1024 + 1)}\n`, { flag: 'a' });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', oversizedRows: 1, stopReasons: expect.arrayContaining(['row-size']),
    });
    expect(recordPostMergeStabilityCohort({
      cohortId: 'too-many', completedAt: '2026-07-11T12:01:00.000Z',
      witnesses: Array.from({ length: 65 }, (_, index) => witness({ proposalId: `proposal-${index}` })),
    })).toMatchObject({ invalid: 1, recorded: 0 });
  });

  it('rejects malformed windows, identities, supplied signatures, and partition mismatch', () => {
    key();
    const invalid = [
      witness({ cohortId: '../bad id' }), witness({ repo: 'relative/repo' }),
      witness({ mergeCommit: 'A'.repeat(40) }), witness({ stableAt: '2026-07-11 12:00:00Z' }),
      witness({ windowMs: 365 * 24 * 60 * 60 * 1_000 + 1 }),
      witness({ stableAt: '2026-07-11T01:00:00.000Z' }),
      witness({ witnessDigest: 'e'.repeat(64) }), witness({ attestation: 'f'.repeat(64) }),
    ];
    expect(invalid.map(sanitizePostMergeStabilityWitness)).toEqual(Array(invalid.length).fill(null));
    expect(recordPostMergeStabilityCohort({
      ...cohort(), completedAt: '2026-07-12T12:01:00.000Z',
    })).toMatchObject({ invalid: 1, recorded: 0 });
    expect(recordPostMergeStabilityCohort({
      ...cohort(), completedAt: '2026-07-11T11:59:59.000Z',
    })).toMatchObject({ invalid: 1, recorded: 0 });
  });

  it('degrades reuse of one cohort identity across partitions', () => {
    key();
    expect(recordPostMergeStabilityCohort(cohort()).recorded).toBe(1);
    expect(recordPostMergeStabilityCohort({
      cohortId: 'cohort-2026-07-11-a',
      completedAt: '2026-07-12T12:01:00.000Z',
      witnesses: [witness({
        stableAt: '2026-07-12T12:00:00.000Z',
        windowStartedAt: '2026-07-12T00:00:00.000Z',
      })],
    }).recorded).toBe(1);

    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded',
      witnesses: [],
      conflictingCohorts: 1,
      stopReasons: expect.arrayContaining(['conflict']),
    });
  });

  it('degrades unsafe directory entries without following them', () => {
    key();
    mkdirSync(postMergeStabilityDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(postMergeStabilityDir(), 'unexpected.txt'), 'not a partition', { mode: 0o600 });
    expect(readPostMergeStability()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], limitExceeded: false,
    });
    expect(dirname(postMergeStabilityPartitionPath('2026-07-11'))).toBe(postMergeStabilityDir());
  });
});
