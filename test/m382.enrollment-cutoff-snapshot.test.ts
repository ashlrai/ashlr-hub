import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAuthenticatedCutoffEnvelopeV2,
  verifyAuthenticatedCutoffEnvelopeV2,
} from '../src/core/fleet/authenticated-cutoff-snapshot.js';
import {
  captureEnrollmentCutoffSnapshotV2,
  verifyEnrollmentCutoffSnapshotV2,
} from '../src/core/fleet/enrollment-cutoff-snapshot.js';

const key = Buffer.alloc(32, 11);
const capturedAt = '2026-07-12T07:30:00.000Z';
let home = '';
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;

function registryPath(): string {
  return join(home, '.ashlr', 'enrollment.json');
}

function writeRegistry(repos: string[]): void {
  writeFileSync(registryPath(), `${JSON.stringify({ repos })}\n`, { mode: 0o644 });
}

function capture(overrides: Record<string, unknown> = {}) {
  return captureEnrollmentCutoffSnapshotV2({
    now: () => capturedAt,
    monotonicNow: () => 0,
    identityKey: () => key,
    resolveDefaultBranch: () => 'main',
    inspectRepository: (repo: string) => ({
      repo, realPath: repo, dev: 1, ino: 1, gitEntryDigest: 'a'.repeat(64),
    }),
    ...overrides,
  });
}

beforeEach(() => {
  oldHome = process.env.HOME;
  oldAshlrHome = process.env.ASHLR_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m382-')));
  process.env.HOME = home;
  delete process.env.ASHLR_HOME;
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = oldAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M382 authenticated cutoff snapshot envelope', () => {
  it('binds source, projection, cutoff, kind, and authority key', () => {
    const input = {
      kind: 'enrollment' as const,
      capturedAt,
      sourcePayload: ['healthy', true, ['repo-a']],
      projectionPayload: [[['repo-a', 'main']]],
    };
    const envelope = createAuthenticatedCutoffEnvelopeV2(input, () => key);
    expect(envelope).not.toBeNull();
    expect(verifyAuthenticatedCutoffEnvelopeV2(envelope!, input, () => key)).toBe(true);
    expect(verifyAuthenticatedCutoffEnvelopeV2(envelope!, {
      ...input, sourcePayload: ['healthy', true, ['repo-b']],
    }, () => key)).toBe(false);
    expect(verifyAuthenticatedCutoffEnvelopeV2(envelope!, input, () => Buffer.alloc(32, 12))).toBe(false);
    expect(verifyAuthenticatedCutoffEnvelopeV2({
      ...envelope!, projectionRoot: '0'.repeat(64),
    }, input, () => key)).toBe(false);
    const nfc = createAuthenticatedCutoffEnvelopeV2({
      ...input, sourcePayload: ['café'],
    }, () => key);
    const nfd = createAuthenticatedCutoffEnvelopeV2({
      ...input, sourcePayload: ['café'],
    }, () => key);
    expect(nfc?.snapshotDigest).not.toBe(nfd?.snapshotDigest);
    expect(createAuthenticatedCutoffEnvelopeV2({
      ...input, sourcePayload: [undefined],
    }, () => key)).toBeNull();
    expect(createAuthenticatedCutoffEnvelopeV2({
      ...input, sourcePayload: [Number.NaN],
    }, () => key)).toBeNull();
  });

  it('refuses missing keys and noncanonical timestamps', () => {
    expect(createAuthenticatedCutoffEnvelopeV2({
      kind: 'enrollment', capturedAt: '2026-07-12T07:30:00Z',
      sourcePayload: [], projectionPayload: [],
    }, () => key)).toBeNull();
    expect(createAuthenticatedCutoffEnvelopeV2({
      kind: 'enrollment', capturedAt, sourcePayload: [], projectionPayload: [],
    }, () => null)).toBeNull();
  });
});

describe('M382 live enrollment cutoff producer', () => {
  it('captures sorted enrollment and branch authority across a stable cutoff', () => {
    const repoA = resolve(home, 'a');
    const repoB = resolve(home, 'b');
    writeRegistry([repoB, repoA]);
    const result = capture({ resolveDefaultBranch: (repo: string) => repo === repoA ? 'trunk' : 'main' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toMatchObject({
      snapshotKind: 'enrollment', authorityScope: 'observation-only', cutoffAuthority: false,
      cutoffBasis: 'bracketed-observation',
      consistency: 'stable-double-read', capturedAt, sourceState: 'healthy', complete: true,
      repos: [repoA, repoB],
      defaultBranches: [{ repo: repoA, branch: 'trunk' }, { repo: repoB, branch: 'main' }],
      repositoryIdentities: [
        { repo: repoA, realPath: repoA, dev: 1, ino: 1, gitEntryDigest: 'a'.repeat(64) },
        { repo: repoB, realPath: repoB, dev: 1, ino: 1, gitEntryDigest: 'a'.repeat(64) },
      ],
    });
    expect(verifyEnrollmentCutoffSnapshotV2(result.snapshot, () => key)).toBe(true);
    expect(verifyEnrollmentCutoffSnapshotV2({
      ...result.snapshot,
      defaultBranches: [{ repo: repoA, branch: 'release' }, { repo: repoB, branch: 'main' }],
    }, () => key)).toBe(false);
    expect(verifyEnrollmentCutoffSnapshotV2({
      ...result.snapshot, unexpected: 'not-bound',
    } as typeof result.snapshot, () => key)).toBe(false);
    expect(verifyEnrollmentCutoffSnapshotV2({
      ...result.snapshot, repos: ['relative/repo'],
      defaultBranches: [{ repo: 'relative/repo', branch: 'main' }],
      repositoryIdentities: [{
        repo: 'relative/repo', realPath: 'relative/repo', dev: 1, ino: 1,
        gitEntryDigest: 'a'.repeat(64),
      }],
    }, () => key)).toBe(false);
    expect(JSON.stringify({
      authorityId: result.snapshot.authorityId,
      sourceRoot: result.snapshot.sourceRoot,
      projectionRoot: result.snapshot.projectionRoot,
      snapshotDigest: result.snapshot.snapshotDigest,
    })).not.toContain(home);
  });

  it('refuses enrollment changes bracketing the cutoff', () => {
    const repoA = resolve(home, 'a');
    const repoB = resolve(home, 'b');
    writeRegistry([repoA]);
    const result = capture({
      onPhase: (phase: string) => { if (phase === 'after-first-read') writeRegistry([repoA, repoB]); },
    });
    expect(result).toEqual({ ok: false, reason: 'source-changed' });
  });

  it('refuses default branch changes bracketing the cutoff', () => {
    const repo = resolve(home, 'repo');
    writeRegistry([repo]);
    let calls = 0;
    const result = capture({ resolveDefaultBranch: () => ++calls === 1 ? 'main' : 'release' });
    expect(result).toEqual({ ok: false, reason: 'branch-changed' });
  });

  it('refuses repository identity changes and invalid Git branch names', () => {
    const repo = resolve(home, 'repo');
    writeRegistry([repo]);
    let inspections = 0;
    expect(capture({
      inspectRepository: () => ({
        repo, realPath: repo, dev: 1, ino: ++inspections <= 2 ? 1 : 2,
        gitEntryDigest: 'a'.repeat(64),
      }),
    })).toEqual({ ok: false, reason: 'branch-changed' });
    expect(capture({ resolveDefaultBranch: () => 'bad branch' })).toEqual({
      ok: false, reason: 'branch-unavailable',
    });
  });

  it('binds a regular Git directory and refuses linked-worktree metadata files', () => {
    const repo = resolve(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeRegistry([repo]);
    const dependencies = {
      now: () => capturedAt, monotonicNow: () => 0, identityKey: () => key,
      resolveDefaultBranch: () => 'main',
    };
    expect(captureEnrollmentCutoffSnapshotV2(dependencies).ok).toBe(true);
    rmSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: ../shared.git\n', 'utf8');
    expect(captureEnrollmentCutoffSnapshotV2(dependencies)).toEqual({
      ok: false, reason: 'branch-unavailable',
    });
  });

  it('refuses missing branch, key, expired deadline, and Windows authority', () => {
    const repo = resolve(home, 'repo');
    writeRegistry([repo]);
    expect(capture({ resolveDefaultBranch: () => null })).toEqual({
      ok: false, reason: 'branch-unavailable',
    });
    expect(capture({ identityKey: () => null })).toEqual({ ok: false, reason: 'key-unavailable' });
    let ticks = 0;
    expect(capture({ monotonicNow: () => ticks++ === 0 ? 0 : 20_000 })).toEqual({
      ok: false, reason: 'deadline-exceeded',
    });
    if (process.platform === 'win32') {
      expect(capture()).toEqual({ ok: false, reason: 'platform-unsupported' });
    }
  });

  it('refuses malformed, duplicate, linked, and over-limit registries', () => {
    writeFileSync(registryPath(), '{broken', 'utf8');
    expect(capture()).toEqual({ ok: false, reason: 'source-incomplete' });
    const repo = resolve(home, 'repo');
    writeRegistry([repo, repo]);
    expect(capture()).toEqual({ ok: false, reason: 'source-incomplete' });
    writeRegistry(Array.from({ length: 65 }, (_, index) => resolve(home, `repo-${index}`)));
    expect(capture()).toEqual({ ok: false, reason: 'source-incomplete' });
    rmSync(registryPath());
    const target = join(home, 'registry-target.json');
    writeFileSync(target, JSON.stringify({ repos: [repo] }), 'utf8');
    symlinkSync(target, registryPath());
    expect(capture()).toEqual({ ok: false, reason: 'source-incomplete' });
    rmSync(registryPath());
    linkSync(target, registryPath());
    expect(capture()).toEqual({ ok: false, reason: 'source-incomplete' });
  });

  it('never throws when injected dependencies fail', () => {
    const repo = resolve(home, 'repo');
    writeRegistry([repo]);
    expect(capture({ identityKey: () => { throw new Error('key failure'); } })).toEqual({
      ok: false, reason: 'key-unavailable',
    });
    expect(capture({ resolveDefaultBranch: () => { throw new Error('git failure'); } })).toEqual({
      ok: false, reason: 'branch-unavailable',
    });
  });
});
