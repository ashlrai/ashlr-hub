import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listRuns, listRunsDetailed, loadRun, saveRun } from '../src/core/run/orchestrator.js';
import { listSwarms, listSwarmsDetailed, loadSwarm, saveSwarm } from '../src/core/swarm/store.js';
import type { RunState, SwarmRun } from '../src/core/types.js';

type PersistedRecord = RunState | SwarmRun;

interface StoreHarness {
  name: string;
  storeDir(): string;
  recordPath(id: string): string;
  make(id: string): PersistedRecord;
  trySave(record: PersistedRecord): boolean;
  load(id: string): PersistedRecord | null;
  list(): PersistedRecord[];
}

interface OutsideSnapshot {
  bytes: Buffer;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  size: number;
}

const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1_000;
const originalEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ASHLR_HOME: process.env.ASHLR_HOME,
};

let tmpHome: string;

function makeRun(id: string): RunState {
  const now = '2026-07-13T13:00:00.000Z';
  return {
    id,
    goal: 'Verify recoverable run ownership',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'running',
  };
}

function makeSwarm(id: string): SwarmRun {
  const now = '2026-07-13T13:00:00.000Z';
  const goal = 'Verify recoverable swarm ownership';
  return {
    id,
    goal,
    specId: null,
    project: null,
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'running',
    plan: { specId: null, goal, tasks: [] },
    tasks: [],
  };
}

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pendingClaimPaths(store: StoreHarness): string[] {
  if (!fs.existsSync(store.storeDir())) return [];
  return fs.readdirSync(store.storeDir(), { withFileTypes: true })
    .filter((entry) => /^\.id-claim-v1-[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => path.join(store.storeDir(), entry.name))
    .sort();
}

function onlyPendingClaim(store: StoreHarness): string {
  const claims = pendingClaimPaths(store);
  expect(claims).toHaveLength(1);
  return claims[0]!;
}

function legacyClaimPath(store: StoreHarness, id: string): string {
  const hash = createHash('sha256').update(id.toLowerCase()).digest('hex');
  return path.join(store.storeDir(), `.id-claim-${hash}`);
}

function writeLegacyClaim(store: StoreHarness, id: string): string {
  fs.mkdirSync(store.storeDir(), { recursive: true, mode: 0o700 });
  const claim = legacyClaimPath(store, id);
  fs.writeFileSync(claim, id, { encoding: 'utf8', mode: 0o600 });
  return claim;
}

function expiredClaimText(claimPath: string): string {
  const value: unknown = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  expect(typeof value).toBe('object');
  const claim = value as Record<string, unknown>;
  expect(Number.isSafeInteger(claim['createdAtMs'])).toBe(true);
  expect(Number.isSafeInteger(claim['expiresAtMs'])).toBe(true);

  const expiresAtMs = Date.now() - 60_000;
  claim['createdAtMs'] = expiresAtMs - CLAIM_RETENTION_MS;
  claim['expiresAtMs'] = expiresAtMs;
  expect(Number(claim['expiresAtMs']) - Number(claim['createdAtMs']))
    .toBe(CLAIM_RETENTION_MS);
  return `${JSON.stringify(claim)}\n`;
}

function expirePendingClaim(claimPath: string): void {
  fs.writeFileSync(claimPath, expiredClaimText(claimPath), 'utf8');
}

function writeHistoricalRecord(store: StoreHarness, id: string): void {
  fs.writeFileSync(
    store.recordPath(id),
    `${JSON.stringify(store.make(id), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function outsideSnapshot(file: string): OutsideSnapshot {
  const stat = fs.statSync(file);
  return {
    bytes: fs.readFileSync(file),
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    nlink: stat.nlink,
    size: stat.size,
  };
}

function expectOutsideUnchanged(file: string, before: OutsideSnapshot): void {
  const after = outsideSnapshot(file);
  expect(after.bytes.equals(before.bytes)).toBe(true);
  expect({ ...after, bytes: undefined }).toEqual({ ...before, bytes: undefined });
}

const stores: StoreHarness[] = [
  {
    name: 'run',
    storeDir: () => path.join(tmpHome, '.ashlr', 'runs'),
    recordPath(id) {
      return path.join(this.storeDir(), `${id}.json`);
    },
    make: makeRun,
    trySave(record) {
      try {
        saveRun(record as RunState);
        return true;
      } catch {
        return false;
      }
    },
    load: loadRun,
    list: listRuns,
  },
  {
    name: 'swarm',
    storeDir: () => path.join(tmpHome, '.ashlr', 'swarms'),
    recordPath(id) {
      return path.join(this.storeDir(), `${id}.json`);
    },
    make: makeSwarm,
    trySave(record) {
      return saveSwarm(record as SwarmRun).ok;
    },
    load: loadSwarm,
    list: listSwarms,
  },
];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m390-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  restoreEnvironment('HOME');
  restoreEnvironment('USERPROFILE');
  restoreEnvironment('ASHLR_HOME');
});

for (const store of stores) {
  describe(`${store.name} case-folded ownership recovery`, () => {
    it('retires committed claims so deleting a record makes its casing immediately reusable', () => {
      const originalId = 'CommittedOwner';
      const variantId = originalId.toLowerCase();

      expect(store.trySave(store.make(originalId))).toBe(true);
      expect(pendingClaimPaths(store)).toEqual([]);

      fs.rmSync(store.recordPath(originalId));
      expect(store.trySave(store.make(variantId))).toBe(true);

      expect(store.load(variantId)?.id).toBe(variantId);
      expect(store.list().map((record) => record.id)).toEqual([variantId]);
      expect(pendingClaimPaths(store)).toEqual([]);
      expect(fs.existsSync(legacyClaimPath(store, variantId))).toBe(false);
    });

    it('migrates a fresh legacy claim, quarantines its variant, then allows it after strict expiry', () => {
      const originalId = 'CrashedBeforeCommit';
      const variantId = originalId.toLowerCase();
      const legacyPath = writeLegacyClaim(store, originalId);

      expect(store.trySave(store.make(variantId))).toBe(false);
      expect(fs.existsSync(legacyPath)).toBe(true);
      const pendingPath = onlyPendingClaim(store);
      expect(store.load(variantId)).toBeNull();
      expect(store.list()).toEqual([]);

      expirePendingClaim(pendingPath);
      expect(store.trySave(store.make(variantId))).toBe(true);

      expect(store.load(variantId)?.id).toBe(variantId);
      expect(store.list().map((record) => record.id)).toEqual([variantId]);
      expect(pendingClaimPaths(store)).toEqual([]);
    });

    it('keeps an existing differently-cased record authoritative over an aged pending claim', () => {
      const originalId = 'ExistingAuthority';
      const variantId = originalId.toLowerCase();
      writeLegacyClaim(store, originalId);
      expect(store.trySave(store.make(variantId))).toBe(false);
      const pendingPath = onlyPendingClaim(store);
      expirePendingClaim(pendingPath);
      writeHistoricalRecord(store, originalId);
      expect(store.load(originalId)?.id).toBe(originalId);

      expect(store.trySave(store.make(variantId))).toBe(false);

      expect(store.load(originalId)?.id).toBe(originalId);
      expect(store.load(variantId)).toBeNull();
      expect(store.list().map((record) => record.id)).toEqual([originalId]);
    });

    it('fails closed on a malformed migrated pending claim', () => {
      const originalId = 'MalformedPending';
      const variantId = originalId.toLowerCase();
      writeLegacyClaim(store, originalId);
      expect(store.trySave(store.make(variantId))).toBe(false);
      const pendingPath = onlyPendingClaim(store);
      fs.writeFileSync(pendingPath, '{"createdAtMs":"invalid"}\n', 'utf8');

      expect(store.trySave(store.make(variantId))).toBe(false);
      expect(store.load(variantId)).toBeNull();
      expect(store.list()).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'fails closed on a symlinked expired pending claim without mutating its outside target',
      () => {
        const originalId = 'SymlinkPending';
        const variantId = originalId.toLowerCase();
        writeLegacyClaim(store, originalId);
        expect(store.trySave(store.make(variantId))).toBe(false);
        const pendingPath = onlyPendingClaim(store);
        const outside = path.join(tmpHome, `${store.name}-symlink-target.json`);
        fs.writeFileSync(outside, expiredClaimText(pendingPath), { mode: 0o600 });
        fs.rmSync(pendingPath);
        fs.symlinkSync(outside, pendingPath, 'file');
        const before = outsideSnapshot(outside);

        expect(store.trySave(store.make(variantId))).toBe(false);

        expect(store.load(variantId)).toBeNull();
        expectOutsideUnchanged(outside, before);
      },
    );

    it(
      'fails closed on a hardlinked expired pending claim without mutating its outside target',
      () => {
        const originalId = 'HardlinkPending';
        const variantId = originalId.toLowerCase();
        writeLegacyClaim(store, originalId);
        expect(store.trySave(store.make(variantId))).toBe(false);
        const pendingPath = onlyPendingClaim(store);
        const outside = path.join(tmpHome, `${store.name}-hardlink-target.json`);
        fs.writeFileSync(outside, expiredClaimText(pendingPath), { mode: 0o600 });
        fs.rmSync(pendingPath);
        fs.linkSync(outside, pendingPath);
        const before = outsideSnapshot(outside);
        expect(before.nlink).toBe(2);

        expect(store.trySave(store.make(variantId))).toBe(false);

        expect(store.load(variantId)).toBeNull();
        expectOutsideUnchanged(outside, before);
      },
    );
  });
}

describe('pending ownership capacity', () => {
  it('reclaims one safe malformed slot at the bounded cap without polluting run history', () => {
    const store = stores[0]!;
    fs.mkdirSync(store.storeDir(), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 1_024; index += 1) {
      fs.writeFileSync(
        path.join(store.storeDir(), `.id-claim-v1-${index.toString(16).padStart(64, '0')}`),
        '{}\n',
        { mode: 0o600 },
      );
    }
    expect(store.trySave(store.make('capacity-recovered'))).toBe(true);
    expect(store.load('capacity-recovered')?.id).toBe('capacity-recovered');
    expect(store.list().map((record) => record.id)).toEqual(['capacity-recovered']);
    expect(pendingClaimPaths(store)).toHaveLength(1_023);
  });

  it('reconciles a dead writer lock while pruning an expired claim', () => {
    const store = stores[0]!;
    const originalId = 'DeadWriterClaim';
    const variantId = originalId.toLowerCase();
    writeLegacyClaim(store, originalId);
    expect(store.trySave(store.make(variantId))).toBe(false);
    const pendingPath = onlyPendingClaim(store);
    expirePendingClaim(pendingPath);
    const hash = createHash('sha256').update(originalId.toLowerCase()).digest('hex');
    const staleLock = path.join(store.storeDir(), `.write-lock-${hash}`);
    fs.writeFileSync(staleLock, `${JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-writer-lock',
      startRef: '0'.repeat(64),
      startRefVerified: false,
    })}\n`, { mode: 0o600 });

    expect(store.trySave(store.make('prune-trigger'))).toBe(true);
    expect(fs.existsSync(staleLock)).toBe(false);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.existsSync(legacyClaimPath(store, originalId))).toBe(false);
  });
});

describe('ownership metadata history isolation', () => {
  it('does not let bounded legacy run claims consume the record scan allowance', () => {
    const store = stores[0]!;
    for (let index = 0; index < 20; index += 1) {
      writeLegacyClaim(store, `legacy-run-${index}`);
    }
    writeHistoricalRecord(store, 'visible-run');

    const detailed = listRunsDetailed({ limit: 1, maxDirectoryEntries: 1 });
    expect(detailed.runs.map((record) => record.id)).toEqual(['visible-run']);
    expect(detailed.entriesExamined).toBe(1);
  });

  it('does not let bounded legacy swarm claims consume the record scan allowance', () => {
    const store = stores[1]!;
    for (let index = 0; index < 20; index += 1) {
      writeLegacyClaim(store, `legacy-swarm-${index}`);
    }
    writeHistoricalRecord(store, 'visible-swarm');

    const detailed = listSwarmsDetailed({ limit: 1, maxDirectoryEntries: 1 });
    expect(detailed.swarms.map((record) => record.id)).toEqual(['visible-swarm']);
    expect(detailed.entriesExamined).toBe(1);
  });
});

describe('swarm ownership outcomes', () => {
  it('classifies an unexpired foreign pending claim as a conflict', () => {
    const store = stores[1]!;
    writeLegacyClaim(store, 'PendingSwarmOwner');

    expect(saveSwarm(makeSwarm('pendingswarmowner')))
      .toEqual({ ok: false, reason: 'conflict' });
  });

  it('classifies malformed pending state as unavailable', () => {
    const store = stores[1]!;
    writeLegacyClaim(store, 'MalformedSwarmOwner');
    expect(saveSwarm(makeSwarm('malformedswarmowner')))
      .toEqual({ ok: false, reason: 'conflict' });
    fs.writeFileSync(onlyPendingClaim(store), '{}\n', { mode: 0o600 });

    expect(saveSwarm(makeSwarm('malformedswarmowner')))
      .toEqual({ ok: false, reason: 'unavailable' });
  });

  it('commits successfully after strict pending-claim expiry', () => {
    const store = stores[1]!;
    writeLegacyClaim(store, 'ExpiredSwarmOwner');
    expect(saveSwarm(makeSwarm('expiredswarmowner')))
      .toEqual({ ok: false, reason: 'conflict' });
    expirePendingClaim(onlyPendingClaim(store));

    expect(saveSwarm(makeSwarm('expiredswarmowner')))
      .toEqual({ ok: true, revision: 1 });
  });
});
