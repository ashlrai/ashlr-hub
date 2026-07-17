import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSandbox,
  listSandboxes,
  removeSandbox,
  sandboxInventory,
  sandboxesDir,
  sweepOrphanSandboxesDetailed,
} from '../src/core/sandbox/worktree.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const originalMaxSandboxes = process.env.ASHLR_MAX_SANDBOXES;
let fx: H1Fixture;

function reservationHome(id: string): string {
  return join(sandboxesDir(), id);
}

function createReservation(id: string, metadata?: string): string {
  const home = reservationHome(id);
  mkdirSync(sandboxesDir(), { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  if (metadata !== undefined) {
    writeFileSync(join(home, 'sandbox.json'), metadata, { encoding: 'utf8', mode: 0o600 });
  }
  return home;
}

function ageReservation(home: string): void {
  const old = new Date(Date.now() - 7 * 60 * 60_000);
  const metadata = join(home, 'sandbox.json');
  if (existsSync(metadata)) utimesSync(metadata, old, old);
  utimesSync(home, old, old);
}

beforeEach(() => {
  fx = makeFixture();
  delete process.env.ASHLR_MAX_SANDBOXES;
});

afterEach(() => {
  if (originalMaxSandboxes === undefined) delete process.env.ASHLR_MAX_SANDBOXES;
  else process.env.ASHLR_MAX_SANDBOXES = originalMaxSandboxes;
  fx.cleanup();
});

describe('sandbox reservation recovery', () => {
  it('reclaims an aged crash-at-reservation home during the authority-held cap pre-sweep', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const crashedId = '000000000001';
    const crashedHome = createReservation(crashedId);
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(crashedHome, old, old);
    process.env.ASHLR_MAX_SANDBOXES = '1';

    expect(sandboxInventory()).toMatchObject({ totalHomes: 1, validHomes: 0, malformedHomes: 1 });
    const sandbox = createSandbox(repo.dir);
    try {
      expect(existsSync(crashedHome)).toBe(false);
      expect(existsSync(sandbox.worktreePath)).toBe(true);
      expect(repo.branches()).toContain(sandbox.branch);
    } finally {
      expect(removeSandbox(sandbox).status).toBe('complete');
    }
  }, 15_000);

  it('reclaims canonical partial metadata that never reached a Git effect', () => {
    const id = 'partial-reservation';
    const home = reservationHome(id);
    createReservation(id, `${JSON.stringify({
      id,
      worktreePath: join(home, 'worktree'),
      branch: `ashlr/sandbox/${id}`,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })}\n`);
    ageReservation(home);

    expect(listSandboxes()).toEqual([]);
    expect(sweepOrphanSandboxesDetailed()).toMatchObject({
      completed: [id],
      residual: [],
      refused: [],
      unavailable: [],
      inventory: { totalHomes: 1, validHomes: 0, malformedHomes: 1, unsafeEntries: 0 },
      unexpectedErrors: [],
    });
    expect(existsSync(home)).toBe(false);
  });

  it('does not reclaim a reservation without cleanup authority', () => {
    const id = 'authority-held-reservation';
    const home = createReservation(id);
    ageReservation(home);
    fx.setKill(true);

    expect(sweepOrphanSandboxesDetailed()).toMatchObject({ completed: [], refused: [], unavailable: [] });
    expect(existsSync(home)).toBe(true);

    fx.setKill(false);
    expect(sweepOrphanSandboxesDetailed().completed).toEqual([id]);
    expect(existsSync(home)).toBe(false);
  });

  it('preserves live, effectful, and unsafe malformed homes', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const sandbox = createSandbox(repo.dir);
    const metadataPath = join(reservationHome(sandbox.id), 'sandbox.json');
    const canonicalMetadata = readFileSync(metadataPath, 'utf8');

    const liveReservationId = 'live-partial-reservation';
    const liveReservationHome = reservationHome(liveReservationId);
    createReservation(liveReservationId, `${JSON.stringify({
      id: liveReservationId,
      worktreePath: join(liveReservationHome, 'worktree'),
      branch: `ashlr/sandbox/${liveReservationId}`,
      ownerPid: process.pid,
    })}\n`);

    const symlinkId = 'symlink-metadata-reservation';
    const symlinkHome = createReservation(symlinkId);
    const outside = join(fx.home, 'outside-metadata.json');
    writeFileSync(outside, 'outside remains\n', 'utf8');
    symlinkSync(outside, join(symlinkHome, 'sandbox.json'));

    const unknownId = 'unknown-entry-reservation';
    const unknownHome = createReservation(unknownId);
    writeFileSync(join(unknownHome, 'payload.txt'), 'do not delete\n', 'utf8');

    try {
      // Model metadata corruption while a real sandbox is active. The worktree
      // itself is sufficient reason to refuse reservation-only recovery.
      writeFileSync(metadataPath, `${JSON.stringify({
        id: sandbox.id,
        worktreePath: sandbox.worktreePath,
        branch: sandbox.branch,
      })}\n`, 'utf8');

      const sweep = sweepOrphanSandboxesDetailed();
      expect(sweep.completed).toEqual([]);
      expect(sweep.refused).toEqual(expect.arrayContaining([sandbox.id, symlinkId, unknownId]));
      expect(sweep.refused).not.toContain(liveReservationId);
      expect(existsSync(sandbox.worktreePath)).toBe(true);
      expect(repo.branches()).toContain(sandbox.branch);
      expect(existsSync(liveReservationHome)).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('outside remains\n');
      expect(existsSync(symlinkHome)).toBe(true);
      expect(readFileSync(join(unknownHome, 'payload.txt'), 'utf8')).toBe('do not delete\n');
    } finally {
      writeFileSync(metadataPath, canonicalMetadata, 'utf8');
      expect(removeSandbox(sandbox).status).toBe('complete');
    }
  });

  it('bounds reservation cleanup to sixteen homes per sweep', () => {
    const ids = Array.from({ length: 17 }, (_, index) => `bounded-${String(index).padStart(2, '0')}`);
    for (const id of ids) ageReservation(createReservation(id));

    const first = sweepOrphanSandboxesDetailed();
    expect(first.inventory).toMatchObject({ totalHomes: 17, validHomes: 0, malformedHomes: 17 });
    expect(first.completed).toHaveLength(16);
    expect(sandboxInventory()).toMatchObject({ totalHomes: 1, malformedHomes: 1 });

    const second = sweepOrphanSandboxesDetailed();
    expect(second.completed).toHaveLength(1);
    expect(sandboxInventory()).toMatchObject({ totalHomes: 0, malformedHomes: 0 });
  });
});
