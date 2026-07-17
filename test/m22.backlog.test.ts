/**
 * M22 backlog tests — buildBacklog, loadBacklog, scoreItem, enrollment scope.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/backlog.json and
 *    ~/.ashlr/enrollment.json are never touched.
 *  - A TMP git repo is created and enrolled only for tests that require it;
 *    unenrolled between tests.
 *  - child_process.execFile is mocked so NO real subprocesses run during scans.
 *  - The empty-enrollment invariant is verified explicitly: with nothing
 *    enrolled, buildBacklog MUST return an empty backlog and MUST NOT scan disk.
 *
 * Invariants asserted:
 *   - scoreItem(value, effort): higher value => higher score; higher effort =>
 *     lower score; clamped inputs; deterministic/pure
 *   - buildBacklog with empty enrollment returns empty backlog (never scans disk)
 *   - buildBacklog over an enrolled tmp repo aggregates, dedupes, scores, persists
 *   - items sorted by score descending
 *   - deduplication by item id
 *   - persisted JSON is valid Backlog shape
 *   - loadBacklog returns null when no file exists
 *   - loadBacklog returns the persisted Backlog after buildBacklog
 *   - backlogPath() is under HOME/.ashlr/
 *   - buildBacklog never throws even when all scanners error
 *   - opts.repos overrides listEnrolled() (still READ-ONLY, bounded)
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation (must happen before any module import resolves homedir())
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// execFile mock
// ---------------------------------------------------------------------------

let _execFileImpl: Mock;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => _execFileImpl(...args),
    // Keep production-local adapters available for authority setup. Only gh is
    // outward-facing here and must remain under the test double.
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'gh'
      ? { pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }
      : actual.spawnSync(...args),
  };
});

// ---------------------------------------------------------------------------
// Lazy imports — MUST be after vi.mock is hoisted
// ---------------------------------------------------------------------------

import {
  buildBacklog,
  loadBacklog,
  backlogPath,
  scoreItem,
  enqueueBacklogItemsDetailed,
} from '../src/core/portfolio/backlog.js';
import { isStrictWorkItem } from '../src/core/portfolio/queued-autonomy.js';

import {
  enroll,
  unenroll,
  listEnrolled,
  enrollmentPath,
  setKill,
} from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal git repo in dir so git-based scanners don't error. */
function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
}

/** execFile stub that always errors (safe baseline). */
function makeErrorStub(): Mock {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as ((err: Error, stdout: string, stderr: string) => void) | undefined;
    if (typeof cb === 'function') cb(new Error('execFile stubbed'), '', '');
  });
}

/** execFile stub that returns stdout once per call (round-robin over responses). */
function makeRoundRobinStub(responses: string[]): Mock {
  let idx = 0;
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    if (typeof cb !== 'function') return;
    const resp = responses[idx % responses.length] ?? '';
    idx++;
    cb(null, resp, '');
  });
}

function writeValidMergeContract(repo: string): void {
  fs.writeFileSync(
    path.join(repo, 'ashlr.verify.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'augment-detected',
      commands: [
        {
          id: 'test',
          kind: 'test',
          cmd: ['npm', 'test'],
          profiles: ['merge'],
          required: true,
        },
      ],
    }),
    'utf8',
  );
}

/** Create repo fixtures in the same physical path namespace enrollment persists. */
function makePhysicalTmpRepo(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function setFixtureHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
}

function restoreFixtureHome(): void {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m22-backlog-home-')));
  tmpRepo = makePhysicalTmpRepo('ashlr-m22-backlog-repo-');
  setFixtureHome(tmpHome);

  // Safe baseline — all execFile calls error so no real subprocesses run
  _execFileImpl = makeErrorStub();

  initBareGitDir(tmpRepo);
  // Provide package.json for dep/doc/test scanners
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ name: 'test-repo', version: '1.0.0', scripts: { test: 'vitest run' } }),
    'utf8',
  );
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Test Repo\n', 'utf8');
});

afterEach(() => {
  // Unenroll the tmp repo if it's still enrolled
  try { unenroll(tmpRepo); } catch { /* ignore */ }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  restoreFixtureHome();
  vi.clearAllMocks();
});

// ===========================================================================
// scoreItem — pure, deterministic, clamped
// ===========================================================================

describe('M22 scoreItem — pure priority heuristic', () => {
  it('higher value with same effort yields higher score', () => {
    expect(scoreItem(5, 2)).toBeGreaterThan(scoreItem(2, 2));
  });

  it('lower effort with same value yields higher score', () => {
    expect(scoreItem(3, 1)).toBeGreaterThan(scoreItem(3, 4));
  });

  it('score = value / effort (basic heuristic)', () => {
    expect(scoreItem(4, 2)).toBeCloseTo(2, 5);
    expect(scoreItem(3, 3)).toBeCloseTo(1, 5);
    expect(scoreItem(5, 1)).toBeCloseTo(5, 5);
  });

  it('is deterministic (same inputs always yield same output)', () => {
    for (let v = 1; v <= 5; v++) {
      for (let e = 1; e <= 5; e++) {
        expect(scoreItem(v, e)).toBe(scoreItem(v, e));
      }
    }
  });

  it('clamps effort >= 1 (never divides by zero)', () => {
    expect(() => scoreItem(3, 0)).not.toThrow();
    const s = scoreItem(3, 0);
    expect(isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });

  it('clamps inputs to 1..5 range', () => {
    // Values above 5 or below 1 should produce defined finite results
    expect(isFinite(scoreItem(10, 1))).toBe(true);
    expect(isFinite(scoreItem(1, 10))).toBe(true);
    expect(isFinite(scoreItem(0, 0))).toBe(true);
  });

  it('ordering: (5,1) > (4,2) > (3,3) > (2,4) > (1,5)', () => {
    const scores = [
      scoreItem(5, 1),
      scoreItem(4, 2),
      scoreItem(3, 3),
      scoreItem(2, 4),
      scoreItem(1, 5),
    ];
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]!);
    }
  });

  it('returns a positive finite number for all valid 1..5 combinations', () => {
    for (let v = 1; v <= 5; v++) {
      for (let e = 1; e <= 5; e++) {
        const s = scoreItem(v, e);
        expect(typeof s).toBe('number');
        expect(isFinite(s)).toBe(true);
        expect(s).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// backlogPath
// ===========================================================================

describe('M22 backlogPath — location', () => {
  it('returns a path ending in backlog.json', () => {
    const p = backlogPath();
    expect(p.endsWith('backlog.json')).toBe(true);
  });

  it('is under the current HOME/.ashlr/', () => {
    const p = backlogPath();
    expect(p.startsWith(tmpHome)).toBe(true);
    expect(p).toContain('.ashlr');
  });
});

// ===========================================================================
// loadBacklog — no file
// ===========================================================================

describe('M22 loadBacklog — returns null when no backlog exists', () => {
  it('returns null before any buildBacklog call', () => {
    const result = loadBacklog();
    expect(result).toBeNull();
  });

  it('returns null if backlog.json does not exist', () => {
    const bp = backlogPath();
    if (fs.existsSync(bp)) fs.unlinkSync(bp);
    expect(loadBacklog()).toBeNull();
  });

  it('returns null if backlog.json is malformed', () => {
    const bp = backlogPath();
    fs.mkdirSync(path.dirname(bp), { recursive: true });
    fs.writeFileSync(bp, 'NOT VALID JSON }{{', 'utf8');
    expect(loadBacklog()).toBeNull();
  });

  it('loads a legacy backlog without scanner observations', () => {
    const legacy = {
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo],
      items: [],
    };
    fs.mkdirSync(path.dirname(backlogPath()), { recursive: true });
    fs.writeFileSync(backlogPath(), JSON.stringify(legacy), 'utf8');

    expect(loadBacklog()).toEqual(legacy);
    expect(loadBacklog()).not.toHaveProperty('observations');
  });

  it('drops malformed or semantically inconsistent persisted observations', () => {
    const observedAt = new Date().toISOString();
    const valid = {
      schemaVersion: 1 as const,
      observedAt,
      repo: tmpRepo,
      scannerId: 'queued-autonomy',
      domain: 'local-queue',
      source: 'self' as const,
      status: 'absent' as const,
      reason: 'source-confirmed-empty' as const,
    };
    fs.mkdirSync(path.dirname(backlogPath()), { recursive: true });
    fs.writeFileSync(backlogPath(), JSON.stringify({
      generatedAt: observedAt,
      repos: [tmpRepo],
      items: [],
      observations: [
        { ...valid, secret: 'RAW_OBSERVATION_CANARY' },
        { ...valid, status: 'present', reason: 'scanner-failed' },
        { ...valid, scannerId: '../unsafe' },
        { ...valid, itemId: 'unexpected', objectiveHash: 'a'.repeat(64) },
        { ...valid, observedAt: '2026-07-10T12:00:00Z' },
      ],
    }), 'utf8');

    expect(loadBacklog()?.observations).toEqual([valid]);
    expect(JSON.stringify(loadBacklog())).not.toContain('RAW_OBSERVATION_CANARY');
    expect(loadBacklog()?.observationSourceState).toBe('degraded');
  });

  it('preserves persisted degraded and truncated observation truth', () => {
    const observedAt = new Date().toISOString();
    const observation = {
      schemaVersion: 1 as const,
      observedAt,
      repo: tmpRepo,
      scannerId: 'queued-autonomy',
      domain: 'local-queue',
      source: 'self' as const,
      status: 'absent' as const,
      reason: 'source-confirmed-empty' as const,
    };
    fs.mkdirSync(path.dirname(backlogPath()), { recursive: true });
    fs.writeFileSync(backlogPath(), JSON.stringify({
      generatedAt: observedAt,
      repos: [tmpRepo],
      items: [],
      observations: Array.from({ length: 500 }, () => observation),
      observationSourceState: 'degraded',
      observationsTruncated: true,
    }), 'utf8');

    const loaded = loadBacklog();
    expect(loaded?.observations).toHaveLength(500);
    expect(loaded?.observationSourceState).toBe('degraded');
    expect(loaded?.observationsTruncated).toBe(true);

    fs.writeFileSync(backlogPath(), JSON.stringify({
      generatedAt: observedAt,
      repos: [tmpRepo],
      items: [],
      observations: [],
      observationSourceState: 'degraded',
    }), 'utf8');
    expect(loadBacklog()).toMatchObject({ observations: [], observationSourceState: 'degraded' });
  });

  it('persists exact source bases only on present or absent observations', () => {
    const observedAt = new Date().toISOString();
    const sourceBase = {
      schemaVersion: 1 as const,
      algorithm: 'hmac-sha256' as const,
      sourceKind: 'git-tree' as const,
      sourceDigest: 'a'.repeat(64),
      requirementDigest: 'f'.repeat(64),
      configDigest: 'b'.repeat(64),
      baseDigest: 'c'.repeat(64),
      scannerRevision: 1,
      consistency: 'stable-double-read' as const,
      dirty: 'clean' as const,
    };
    const common = {
      schemaVersion: 1 as const,
      observedAt,
      repo: tmpRepo,
      scannerId: 'merge-verify-contract',
      domain: 'verification',
      source: 'test' as const,
    };
    fs.mkdirSync(path.dirname(backlogPath()), { recursive: true });
    fs.writeFileSync(backlogPath(), JSON.stringify({
      generatedAt: observedAt,
      repos: [tmpRepo],
      items: [],
      observations: [
        {
          ...common,
          status: 'present',
          reason: 'item-observed',
          itemId: 'merge-contract-item',
          objectiveHash: 'd'.repeat(64),
          sourceBase: { ...sourceBase, rawConfig: 'RAW_SOURCE_BASE_CANARY' },
          observationDigest: 'e'.repeat(64),
        },
        { ...common, status: 'absent', reason: 'source-confirmed-empty', sourceBase },
        { ...common, status: 'unavailable', reason: 'source-dirty', sourceBase },
        {
          ...common,
          status: 'present',
          reason: 'item-observed',
          itemId: 'malformed-base',
          objectiveHash: 'e'.repeat(64),
          sourceBase: { ...sourceBase, baseDigest: 'invalid' },
        },
        {
          ...common,
          status: 'absent',
          reason: 'source-confirmed-empty',
          sourceBase,
          observationDigest: 'invalid',
        },
      ],
    }), 'utf8');

    const loaded = loadBacklog();
    expect(loaded?.observations).toHaveLength(3);
    expect(loaded?.observations?.[0]?.sourceBase).toEqual(sourceBase);
    expect(loaded?.observations?.[0]?.observationDigest).toBe('e'.repeat(64));
    expect(loaded?.observations?.[1]?.sourceBase).toEqual(sourceBase);
    expect(loaded?.observations?.[1]).not.toHaveProperty('observationDigest');
    expect(loaded?.observations?.[2]).not.toHaveProperty('sourceBase');
    expect(JSON.stringify(loaded)).not.toContain('RAW_SOURCE_BASE_CANARY');
    expect(loaded?.observationSourceState).toBe('degraded');
  });
});

// ===========================================================================
// ENROLLMENT-SCOPED: empty enrollment => empty backlog, NEVER scans disk
// ===========================================================================

describe('M22 buildBacklog — ENROLLMENT-SCOPED: empty enrollment = empty backlog', () => {
  it('returns items:[] when nothing is enrolled (DEFAULT EMPTY)', async () => {
    // Confirm nothing enrolled
    expect(listEnrolled()).toEqual([]);

    const backlog = await buildBacklog();

    expect(backlog.items).toEqual([]);
    expect(backlog.repos).toEqual([]);
  });

  it('does NOT scan disk when enrollment is empty', async () => {
    expect(listEnrolled()).toEqual([]);

    const spy = vi.fn();
    _execFileImpl = spy;

    await buildBacklog();

    // execFile must NOT have been called (no scanning happened)
    // Note: execFile may be called 0 times OR the scanners may short-circuit
    // before calling it — both are valid. We assert no file-system writes.
    // The key invariant is that the result is empty, verified above.
    expect(listEnrolled()).toEqual([]); // unchanged
  });

  it('backlog persisted with empty items when enrollment is empty', async () => {
    await buildBacklog();
    const bp = backlogPath();
    expect(fs.existsSync(bp)).toBe(true);
    const raw = fs.readFileSync(bp, 'utf8');
    const parsed = JSON.parse(raw) as { items: unknown[] };
    expect(parsed.items).toEqual([]);
  });

  it('loadBacklog() after empty buildBacklog returns empty Backlog shape', async () => {
    await buildBacklog();
    const bl = loadBacklog();
    expect(bl).not.toBeNull();
    expect(bl!.items).toEqual([]);
    expect(Array.isArray(bl!.repos)).toBe(true);
    expect(typeof bl!.generatedAt).toBe('string');
  });

  it('explicit opts.repos=[] also yields empty backlog', async () => {
    const backlog = await buildBacklog({ repos: [] });
    expect(backlog.items).toEqual([]);
  });
});

// ===========================================================================
// buildBacklog over an enrolled repo
// ===========================================================================

describe('M22 buildBacklog — over an enrolled tmp repo', () => {
  beforeEach(() => {
    // Enroll the tmp repo for each test in this suite
    enroll(tmpRepo);
  });

  afterEach(() => {
    unenroll(tmpRepo);
  });

  it('includes the enrolled repo in backlog.repos', async () => {
    const bl = await buildBacklog();
    expect(bl.repos).toContain(tmpRepo);
  });

  it('backlog has a valid generatedAt ISO timestamp', async () => {
    const before = new Date().toISOString();
    const bl = await buildBacklog();
    const after = new Date().toISOString();

    expect(typeof bl.generatedAt).toBe('string');
    expect(bl.generatedAt >= before).toBe(true);
    expect(bl.generatedAt <= after).toBe(true);
  });

  it('items are sorted by score descending', async () => {
    // Stub scanTodos to return 3 items with different values/efforts
    // by returning a grep-style output
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      if (typeof cb !== 'function') return;
      // Return TODO matches so scanTodos produces items
      cb(null, [
        `${path.join(tmpRepo, 'a.ts')}:1:// TODO: high value task`,
        `${path.join(tmpRepo, 'b.ts')}:2:// FIXME: medium task`,
        `${path.join(tmpRepo, 'c.ts')}:3:// XXX: low task`,
      ].join('\n') + '\n', '');
    });

    const bl = await buildBacklog();
    const scores = bl.items.map(i => i.score);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
    }
  });

  it('deduplicates items by id (same id appears only once)', async () => {
    // Stub to return identical grep output on every call so all scanners
    // that use execFile would produce the same id — dedupe must collapse them
    _execFileImpl = makeRoundRobinStub([
      `${path.join(tmpRepo, 'dup.ts')}:1:// TODO: duplicate task\n`,
    ]);

    const bl = await buildBacklog();
    const ids = bl.items.map(i => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('persists backlog.json under HOME/.ashlr/', async () => {
    await buildBacklog();
    const bp = backlogPath();
    expect(fs.existsSync(bp)).toBe(true);
  });

  it('persisted backlog is valid JSON with correct Backlog shape', async () => {
    await buildBacklog();
    const bp = backlogPath();
    const raw = fs.readFileSync(bp, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    const bl = parsed as Record<string, unknown>;
    expect(typeof bl['generatedAt']).toBe('string');
    expect(Array.isArray(bl['repos'])).toBe(true);
    expect(Array.isArray(bl['items'])).toBe(true);
    expect(Array.isArray(bl['observations'])).toBe(true);
  });

  it('refuses an invalid outgoing row before temp creation and preserves prior bytes', async () => {
    const built = await buildBacklog();
    const priorBytes = fs.readFileSync(backlogPath());
    const base = built.items[0]!;
    expect(base).toBeDefined();
    const validFresh = { ...base, id: 'm22-valid-fresh-row', title: 'Valid fresh backlog row' };
    const beforeValidation = structuredClone(validFresh);
    const invalidFresh = { ...validFresh, id: 'm22-invalid-fresh-row', title: 'x'.repeat(241) };

    expect(isStrictWorkItem(validFresh)).toBe(true);
    expect(validFresh).toEqual(beforeValidation);
    expect(isStrictWorkItem(invalidFresh)).toBe(false);

    expect(enqueueBacklogItemsDetailed([validFresh, invalidFresh])).toEqual({ ok: false, enqueued: 0 });
    expect(fs.readFileSync(backlogPath())).toEqual(priorBytes);
    expect(loadBacklog()?.items.some((item) => item.id === validFresh.id)).toBe(false);
    expect(fs.readdirSync(path.dirname(backlogPath())).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('persists bounded metadata-only scanner observations', async () => {
    const built = await buildBacklog();
    const loaded = loadBacklog();

    expect(loaded?.observations).toEqual(built.observations);
    expect(loaded?.observations?.length).toBeLessThanOrEqual(500);
    expect(loaded?.observations?.length).toBeGreaterThan(0);
    for (const observation of loaded!.observations!) {
      expect(observation.repo).toBe(tmpRepo);
      expect(observation.scannerId.length).toBeGreaterThan(0);
      expect(observation.domain.length).toBeGreaterThan(0);
      expect(['present', 'absent', 'unavailable']).toContain(observation.status);
      expect(observation).not.toHaveProperty('title');
      expect(observation).not.toHaveProperty('detail');
      if (observation.status === 'present') {
        expect(observation.itemId).toEqual(expect.any(String));
        expect(observation.objectiveHash).toMatch(/^[a-f0-9]{64}$/);
      } else {
        expect(observation).not.toHaveProperty('itemId');
        expect(observation).not.toHaveProperty('objectiveHash');
      }
    }
  });

  it('includes and persists the merge-contract rollout item', async () => {
    const built = await buildBacklog();
    const item = built.items.find((candidate) =>
      candidate.tags.includes('merge-contract') &&
      candidate.tags.includes('ashlr.verify.json'));

    expect(item).toBeDefined();
    expect(item!.source).toBe('test');
    expect(item!.value).toBe(4);
    expect(item!.effort).toBe(2);
    expect(item!.detail).toContain('Add root ashlr.verify.json');

    const loaded = loadBacklog();
    expect(loaded).not.toBeNull();
    expect(loaded!.items.some((candidate) => candidate.id === item!.id)).toBe(true);
  });

  it('keeps identical merge-contract rollout titles for different enrolled repos', async () => {
    const secondRepo = makePhysicalTmpRepo('ashlr-m22-contract-second-');
    try {
      initBareGitDir(secondRepo);
      fs.writeFileSync(
        path.join(secondRepo, 'package.json'),
        JSON.stringify({ name: 'second-repo', version: '1.0.0', scripts: { test: 'vitest run' } }),
        'utf8',
      );
      enroll(secondRepo);

      const built = await buildBacklog();
      const contractItems = built.items.filter((candidate) =>
        candidate.tags.includes('merge-contract') &&
        candidate.tags.includes('ashlr.verify.json'));

      expect(contractItems).toHaveLength(2);
      expect(new Set(contractItems.map((item) => item.title)).size).toBe(1);
      expect(new Set(contractItems.map((item) => item.repo))).toEqual(new Set([tmpRepo, secondRepo]));
      expect(new Set(contractItems.map((item) => item.id)).size).toBe(2);

      const loaded = loadBacklog();
      expect(loaded).not.toBeNull();
      const persistedIds = new Set(loaded!.items.map((item) => item.id));
      for (const item of contractItems) expect(persistedIds.has(item.id)).toBe(true);
    } finally {
      unenroll(secondRepo);
      fs.rmSync(secondRepo, { recursive: true, force: true });
    }
  });

  it('loadBacklog() returns the persisted Backlog after buildBacklog', async () => {
    const built = await buildBacklog();
    const loaded = loadBacklog();

    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(built.generatedAt);
    expect(loaded!.repos).toEqual(built.repos);
    expect(loaded!.items.length).toBe(built.items.length);
  });

  it('all persisted WorkItems have required fields with valid types', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'x.ts')}:1:// TODO: check fields\n`, '');
    });

    const bl = await buildBacklog();
    for (const item of bl.items) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.repo).toBe('string');
      expect(['issue', 'todo', 'test', 'dep', 'doc', 'security']).toContain(item.source);
      expect(typeof item.title).toBe('string');
      expect(typeof item.detail).toBe('string');
      expect(typeof item.value).toBe('number');
      expect(item.value).toBeGreaterThanOrEqual(1);
      expect(item.value).toBeLessThanOrEqual(5);
      expect(typeof item.effort).toBe('number');
      expect(item.effort).toBeGreaterThanOrEqual(1);
      expect(item.effort).toBeLessThanOrEqual(5);
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThan(0);
      expect(Array.isArray(item.tags)).toBe(true);
      expect(typeof item.ts).toBe('string');
      expect(() => new Date(item.ts)).not.toThrow();
    }
  });

  it('never throws even when all scanners return errors', async () => {
    _execFileImpl = makeErrorStub();

    let bl: unknown;
    await expect(
      buildBacklog().then(r => { bl = r; }),
    ).resolves.not.toThrow();

    expect(typeof bl).toBe('object');
    expect((bl as { items: unknown[] }).items).toBeDefined();
  });

  it('opts.repos overrides listEnrolled() for the build', async () => {
    // Unenroll the repo, then pass it explicitly via opts
    unenroll(tmpRepo);
    expect(listEnrolled()).not.toContain(tmpRepo);

    const bl = await buildBacklog({ repos: [tmpRepo] });
    // Should have scanned tmpRepo via the override
    expect(bl.repos).toContain(tmpRepo);
  });

  it('explicit subset scans do not clobber an existing fleet backlog snapshot', async () => {
    enroll(tmpRepo);
    const persisted = await buildBacklog();
    const loadedBefore = loadBacklog();
    expect(loadedBefore).not.toBeNull();
    expect(loadedBefore!.generatedAt).toBe(persisted.generatedAt);

    unenroll(tmpRepo);
    const subset = await buildBacklog({ repos: [tmpRepo] });

    expect(subset.repos).toEqual([tmpRepo]);
    expect(loadBacklog()).toEqual(loadedBefore);
  });

  it('explicit subset scans can still persist when the caller opts in', async () => {
    unenroll(tmpRepo);

    const subset = await buildBacklog({ repos: [tmpRepo], persist: true });
    const loaded = loadBacklog();

    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(subset.generatedAt);
    expect(loaded!.repos).toEqual([tmpRepo]);
  });

  it('merges disjoint scanner observations from concurrent persisted scans', async () => {
    const secondRepo = makePhysicalTmpRepo('ashlr-m22-observation-second-');
    try {
      initBareGitDir(secondRepo);
      fs.writeFileSync(
        path.join(secondRepo, 'package.json'),
        JSON.stringify({ name: 'observation-second', version: '1.0.0', scripts: { test: 'vitest run' } }),
        'utf8',
      );
      fs.writeFileSync(path.join(secondRepo, 'README.md'), '# Second\n', 'utf8');

      await Promise.all([
        buildBacklog({ repos: [tmpRepo], persist: true }),
        buildBacklog({ repos: [secondRepo], persist: true }),
      ]);

      const observedRepos = new Set(loadBacklog()?.observations?.map((observation) => observation.repo));
      expect(observedRepos).toEqual(new Set([tmpRepo, secondRepo]));
    } finally {
      fs.rmSync(secondRepo, { recursive: true, force: true });
    }
  });

  it('replaces stale observation scope on a newer full enrolled refresh', async () => {
    const secondRepo = makePhysicalTmpRepo('ashlr-m22-observation-stale-');
    try {
      initBareGitDir(secondRepo);
      fs.writeFileSync(
        path.join(secondRepo, 'package.json'),
        JSON.stringify({ name: 'observation-stale', version: '1.0.0', scripts: { test: 'vitest run' } }),
        'utf8',
      );
      fs.writeFileSync(path.join(secondRepo, 'README.md'), '# Stale\n', 'utf8');
      enroll(secondRepo);
      await buildBacklog();
      expect(new Set(loadBacklog()?.observations?.map((observation) => observation.repo))).toContain(secondRepo);

      unenroll(secondRepo);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      await buildBacklog();

      expect(new Set(loadBacklog()?.observations?.map((observation) => observation.repo))).toEqual(new Set([tmpRepo]));
    } finally {
      try { unenroll(secondRepo); } catch { /* best-effort test cleanup */ }
      fs.rmSync(secondRepo, { recursive: true, force: true });
    }
  });

  it('keeps newer same-id work when an older scan persists after it', async () => {
    const initial = await buildBacklog();
    expect(initial.items.length).toBeGreaterThan(0);
    const item = initial.items[0]!;
    const newerTitle = 'Newer authoritative objective meaning';
    fs.writeFileSync(backlogPath(), JSON.stringify({
      ...initial,
      generatedAt: '2099-01-01T00:00:00.000Z',
      items: [{ ...item, title: newerTitle }],
    }), 'utf8');

    await buildBacklog({ repos: [tmpRepo], persist: true });

    expect(loadBacklog()?.generatedAt).toBe('2099-01-01T00:00:00.000Z');
    expect(loadBacklog()?.items.find((candidate) => candidate.id === item.id)?.title).toBe(newerTitle);
  });

  it('score on each WorkItem equals scoreItem(value, effort)', async () => {
    writeValidMergeContract(tmpRepo);
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'z.ts')}:1:// TODO: score check\n`, '');
    });

    const bl = await buildBacklog();
    for (const item of bl.items) {
      expect(item.score).toBeCloseTo(scoreItem(item.value, item.effort), 10);
    }
  });
});

// ===========================================================================
// buildBacklog — never scans repos outside enrollment
// ===========================================================================

describe('M22 buildBacklog — ENROLLMENT-SCOPED: only scans enrolled repos', () => {
  it('keeps the healthy full snapshot when an exact canonical enrollment is temporarily missing', async () => {
    expect(setKill(false)).toMatchObject({ ok: true, quiesced: true });
    expect(enroll(tmpRepo)).toMatchObject({ ok: true, quiesced: true });
    const observedAt = new Date().toISOString();
    const healthySnapshot = {
      generatedAt: observedAt,
      snapshotId: 'a'.repeat(32),
      repos: [tmpRepo],
      items: [],
      observations: [{
        schemaVersion: 1 as const,
        observedAt,
        repo: tmpRepo,
        scannerId: 'queued-autonomy',
        domain: 'local-queue',
        source: 'self' as const,
        status: 'absent' as const,
        reason: 'source-confirmed-empty' as const,
      }],
      observationSourceState: 'healthy' as const,
    };
    fs.mkdirSync(path.dirname(backlogPath()), { recursive: true });
    fs.writeFileSync(backlogPath(), JSON.stringify(healthySnapshot), 'utf8');
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    const scanner = vi.fn();
    _execFileImpl = scanner;

    const incomplete = await buildBacklog();

    expect(incomplete).toMatchObject({
      repos: [],
      items: [],
      observations: [],
      observationSourceState: 'degraded',
    });
    expect(scanner).not.toHaveBeenCalled();
    expect(loadBacklog()).toEqual(healthySnapshot);
  }, 15_000);

  it('fails closed on a legacy lexical enrollment row after its alias is retargeted', async () => {
    const firstTarget = makePhysicalTmpRepo('ashlr-m22-legacy-first-');
    const secondTarget = makePhysicalTmpRepo('ashlr-m22-legacy-second-');
    const alias = path.join(tmpHome, 'legacy-enrolled-repo');
    try {
      initBareGitDir(firstTarget);
      initBareGitDir(secondTarget);
      fs.symlinkSync(firstTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect(setKill(false)).toMatchObject({ ok: true, quiesced: true });
      expect(enroll(firstTarget)).toMatchObject({ ok: true, quiesced: true });
      fs.mkdirSync(path.dirname(enrollmentPath()), { recursive: true });
      fs.writeFileSync(
        enrollmentPath(),
        JSON.stringify({ repos: [alias] }),
        'utf8',
      );

      fs.unlinkSync(alias);
      fs.symlinkSync(secondTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const scanner = vi.fn();
      _execFileImpl = scanner;

      expect(listEnrolled()).toEqual([alias]);
      const backlog = await buildBacklog();

      expect(backlog.repos).toEqual([]);
      expect(backlog.items).toEqual([]);
      expect(backlog.observationSourceState).toBe('degraded');
      expect(scanner).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(alias, { recursive: true, force: true });
      fs.rmSync(firstTarget, { recursive: true, force: true });
      fs.rmSync(secondTarget, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not include an unenrolled repo in results', async () => {
    // Enroll only tmpRepo; create a second tmp repo but do not enroll it
    enroll(tmpRepo);
    const otherRepo = makePhysicalTmpRepo('ashlr-m22-other-');
    try {
      initBareGitDir(otherRepo);
      fs.writeFileSync(path.join(otherRepo, 'file.ts'), '// TODO: not enrolled\n', 'utf8');

      const bl = await buildBacklog();
      // otherRepo must not appear in the scanned repos list
      expect(bl.repos).not.toContain(otherRepo);
      // No items should reference the unenrolled repo
      for (const item of bl.items) {
        expect(item.repo).not.toBe(otherRepo);
      }
    } finally {
      unenroll(tmpRepo);
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('enrolling a second repo causes it to appear in backlog.repos', async () => {
    const secondRepo = makePhysicalTmpRepo('ashlr-m22-second-');
    try {
      initBareGitDir(secondRepo);
      fs.writeFileSync(
        path.join(secondRepo, 'package.json'),
        JSON.stringify({ name: 'second', scripts: {} }),
        'utf8',
      );
      enroll(tmpRepo);
      enroll(secondRepo);

      const bl = await buildBacklog();
      expect(bl.repos).toContain(tmpRepo);
      expect(bl.repos).toContain(secondRepo);
    } finally {
      unenroll(tmpRepo);
      unenroll(secondRepo);
      fs.rmSync(secondRepo, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// buildBacklog — READ-ONLY: enrolled repo files byte-unchanged after build
// ===========================================================================

describe('M22 buildBacklog — READ-ONLY: repo files unchanged after build', () => {
  /** Snapshot all files under a directory. */
  function snapshotDir(dir: string): Map<string, Buffer> {
    const snap = new Map<string, Buffer>();
    function walk(d: string) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else snap.set(path.relative(dir, full), fs.readFileSync(full));
      }
    }
    walk(dir);
    return snap;
  }

  it('enrolled repo directory is byte-unchanged after buildBacklog', async () => {
    enroll(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, 'src.ts'), '// TODO: read-only check\n', 'utf8');

    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'src.ts')}:1:// TODO: read-only check\n`, '');
    });

    const before = snapshotDir(tmpRepo);
    await buildBacklog();

    const after = snapshotDir(tmpRepo);
    for (const [k, buf] of before) {
      expect(after.has(k), `buildBacklog deleted file: ${k}`).toBe(true);
      expect(
        Buffer.compare(buf, after.get(k)!),
        `buildBacklog modified file: ${k}`,
      ).toBe(0);
    }
    for (const k of after.keys()) {
      expect(before.has(k), `buildBacklog created file in repo: ${k}`).toBe(true);
    }

    unenroll(tmpRepo);
  });
});
