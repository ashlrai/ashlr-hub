import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELEASE_TIP_GENESIS_DIGEST,
  bootstrapReleaseTipSettlement,
  createReleaseTipSettlement,
  readReleaseTipSettlements,
  recordReleaseTipSettlement,
  releaseTipSettlementRootPath,
  verifyReleaseTipSettlement,
  type ReleaseTipSettlementInput,
  type ReleaseTipSettlementResult,
  type ReleaseTipSettlementV1,
} from '../src/core/daemon/release-current-tip-store.js';
import {
  loadOrCreateKey,
  provenanceKeyPath,
} from '../src/core/foundry/provenance.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import { recoverImmutablePrivateRecordStore } from '../src/core/util/immutable-private-record-store.js';

const execFileAsync = promisify(execFile);
const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);
const RELEASE_C = 'c'.repeat(64);
const SCOPE_A = '1'.repeat(64);
const SCOPE_B = '2'.repeat(64);

function input(
  sequence: number,
  predecessorDigest: string,
  releaseDigest = RELEASE_A,
  releaseScopeDigest = SCOPE_A,
): ReleaseTipSettlementInput {
  return {
    releaseScopeDigest,
    sequence,
    predecessorDigest,
    releaseDigest,
    reportedAt: `2026-08-03T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  };
}

function recordsPath(scope = SCOPE_A): string {
  return join(releaseTipSettlementRootPath(scope), 'records');
}

function recordPath(sequence: number, scope = SCOPE_A): string {
  return join(recordsPath(scope), `${String(sequence).padStart(12, '0')}.json`);
}

function transactionLockPath(home: string, scope = SCOPE_A): string {
  return join(home, '.ashlr', `.release-current-tip-${scope}.transaction.lock`);
}

function writeAuthenticatedStage(
  candidate: ReleaseTipSettlementV1,
  temporary = false,
): string {
  const key = readFileSync(provenanceKeyPath());
  const stageToken = createHmac('sha256', key)
    .update(JSON.stringify([
      'ashlr:release-tip-settlement:publication-stage:v1',
      candidate.releaseScopeDigest,
      candidate.sequence,
      candidate.settlementDigest,
    ]), 'utf8')
    .digest('hex')
    .slice(0, 32);
  const stagePath = join(
    releaseTipSettlementRootPath(candidate.releaseScopeDigest),
    'staging',
    `.${String(candidate.sequence).padStart(12, '0')}.${stageToken}.stage${temporary ? '.tmp' : ''}`,
  );
  writeFileSync(stagePath, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(stagePath, 0o600);
  return stagePath;
}

function boundedTypeScriptFiles(root: string, maxFiles = 10_000): string[] {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(path);
        if (files.length > maxFiles) throw new Error('source traversal exceeded bound');
      }
    }
  }
  return files.sort();
}

function bootstrap(scope = SCOPE_A, releaseDigest = RELEASE_A): ReleaseTipSettlementResult {
  return bootstrapReleaseTipSettlement(input(
    1,
    RELEASE_TIP_GENESIS_DIGEST,
    releaseDigest,
    scope,
  ));
}

async function recordInChild(
  home: string,
  value: ReleaseTipSettlementInput,
  barrierPath: string,
): Promise<ReleaseTipSettlementResult> {
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    'src/core/daemon/release-current-tip-store.ts',
  )).href;
  const script = [
    "import { existsSync } from 'node:fs';",
    `import { recordReleaseTipSettlement } from ${JSON.stringify(moduleUrl)};`,
    `while (!existsSync(${JSON.stringify(barrierPath)})) {`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '}',
    `const result = recordReleaseTipSettlement(${JSON.stringify(value)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const { stdout } = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as ReleaseTipSettlementResult;
}

describe('M476 release current tip store', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-release-current-tip-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    loadOrCreateKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('requires explicit bootstrap and keeps continuity and operational authority false', () => {
    expect(recordReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST))).toMatchObject({
      disposition: 'rejected',
      reason: 'bootstrap-required',
      sourceState: 'missing',
      availability: 'unavailable',
      currentTipAuthority: false,
      continuityAuthority: false,
      durableCompareAndSwapVerified: false,
      bootstrapContinuityVerified: false,
    });
    expect(existsSync(releaseTipSettlementRootPath(SCOPE_A))).toBe(false);

    const first = bootstrap();
    expect(first).toMatchObject({
      disposition: 'recorded',
      reason: 'bootstrapped',
      sourceState: 'healthy',
      availability: 'available',
      authority: 'observation-only',
      sameUserTamperResistant: false,
      transparencyAuthority: false,
      rollbackProtected: false,
      currentTipAuthority: false,
      continuityAuthority: false,
      durableCompareAndSwapVerified: false,
      bootstrapContinuityVerified: false,
      releaseAuthority: false,
      mergePermitted: false,
      deployPermitted: false,
      installPermitted: false,
      startPermitted: false,
      activationPermitted: false,
      rollbackPermitted: false,
    });
    expect(first.currentTip).toMatchObject({
      releaseScopeDigest: SCOPE_A,
      provenanceKeyGeneration: 1,
      currentTipAuthority: false,
      continuityAuthority: false,
      durableCompareAndSwapVerified: false,
      bootstrapContinuityVerified: false,
    });
    expect(first.currentTip!.provenanceKeyId).toMatch(/^[a-f0-9]{64}$/);

    const second = recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    expect(second).toMatchObject({
      disposition: 'recorded',
      currentTip: { sequence: 2, releaseDigest: RELEASE_B },
    });
    const read = readReleaseTipSettlements(SCOPE_A, { requireComplete: true });
    expect(read).toMatchObject({
      sourceState: 'healthy',
      availability: 'available',
      complete: true,
      filesRead: 2,
      invalidFiles: 0,
      stopReasons: [],
      currentTip: { sequence: 2 },
      currentTipAuthority: false,
      continuityAuthority: false,
      durableCompareAndSwapVerified: false,
      bootstrapContinuityVerified: false,
      releaseAuthority: false,
    });
    expect(read.settlements.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(existsSync(recordPath(1))).toBe(true);
    expect(existsSync(recordPath(2))).toBe(true);
    expect(existsSync(transactionLockPath(home))).toBe(false);
  });

  it('replays or conflicts historical slots after later tips settle', () => {
    const firstInput = input(1, RELEASE_TIP_GENESIS_DIGEST);
    const first = bootstrapReleaseTipSettlement(firstInput);
    const second = recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    expect(second.disposition).toBe('recorded');

    expect(recordReleaseTipSettlement(firstInput)).toMatchObject({
      disposition: 'replayed',
      reason: 'exact-replay',
      currentTip: { sequence: 2 },
    });
    expect(recordReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST, RELEASE_C)))
      .toMatchObject({
        disposition: 'conflicted',
        reason: 'sequence-conflict',
        currentTip: { sequence: 2 },
      });
    expect(recordReleaseTipSettlement(input(4, second.currentTip!.settlementDigest, RELEASE_C)))
      .toMatchObject({ disposition: 'rejected', reason: 'non-contiguous-sequence' });
    expect(recordReleaseTipSettlement(input(3, RELEASE_TIP_GENESIS_DIGEST, RELEASE_C)))
      .toMatchObject({ disposition: 'rejected', reason: 'predecessor-mismatch' });
  });

  it('never turns store deletion into an ordinary successful second genesis', () => {
    expect(bootstrap().disposition).toBe('recorded');
    rmSync(releaseTipSettlementRootPath(SCOPE_A), { recursive: true, force: true });

    expect(recordReleaseTipSettlement(input(
      1,
      RELEASE_TIP_GENESIS_DIGEST,
      RELEASE_B,
    ))).toMatchObject({
      disposition: 'rejected',
      reason: 'bootstrap-required',
      sourceState: 'missing',
      currentTipAuthority: false,
      continuityAuthority: false,
      bootstrapContinuityVerified: false,
    });
    expect(bootstrap(SCOPE_A, RELEASE_B)).toMatchObject({
      disposition: 'recorded',
      reason: 'bootstrapped',
      bootstrapContinuityVerified: false,
      continuityAuthority: false,
    });
  });

  it('discards an authenticated one-link stage and records the validated incoming candidate', () => {
    const implementationSource = readFileSync(join(
      process.cwd(),
      'src/core/daemon/release-current-tip-store.ts',
    ), 'utf8');
    expect(implementationSource).toContain('recoverImmutablePrivateRecordStore(config');
    const first = bootstrap();
    const candidate = createReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    expect(candidate).not.toBeNull();
    const stagePath = writeAuthenticatedStage(candidate!);
    expect(existsSync(recordPath(2))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({
      disposition: 'recorded',
      reason: 'recorded',
      currentTip: { sequence: 2 },
    });
    expect(existsSync(stagePath)).toBe(false);
    expect(existsSync(recordPath(2))).toBe(true);
  });

  it('discards an authenticated one-link temporary and never promotes it directly', () => {
    const first = bootstrap();
    const candidate = createReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    const temporaryPath = writeAuthenticatedStage(candidate!, true);
    expect(existsSync(recordPath(2))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({ disposition: 'recorded', reason: 'recorded' });
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(recordPath(2))).toBe(true);
  });

  it('removes an authenticated orphan-sequence stage without creating its target', () => {
    const first = bootstrap();
    const orphan = createReleaseTipSettlement(input(
      3,
      first.currentTip!.settlementDigest,
      RELEASE_C,
    ));
    const orphanStage = writeAuthenticatedStage(orphan!);
    expect(existsSync(recordPath(3))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({ disposition: 'recorded', reason: 'recorded' });
    expect(existsSync(orphanStage)).toBe(false);
    expect(existsSync(recordPath(3))).toBe(false);
    expect(existsSync(recordPath(2))).toBe(true);
  });

  it('removes an authenticated wrong-predecessor stage before normal publication', () => {
    const first = bootstrap();
    const wrongPredecessor = createReleaseTipSettlement(input(
      2,
      RELEASE_TIP_GENESIS_DIGEST,
      RELEASE_C,
    ));
    const wrongStage = writeAuthenticatedStage(wrongPredecessor!);
    expect(existsSync(recordPath(2))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({ disposition: 'recorded', reason: 'recorded' });
    expect(existsSync(wrongStage)).toBe(false);
    expect(readReleaseTipSettlements(SCOPE_A).currentTip).toMatchObject({
      sequence: 2,
      releaseDigest: RELEASE_B,
    });
  });

  it('removes an authenticated over-capacity stage and admits the bounded next record', () => {
    const first = bootstrap();
    const overCapacity = createReleaseTipSettlement(input(
      3,
      first.currentTip!.settlementDigest,
      RELEASE_C,
    ));
    const overCapacityStage = writeAuthenticatedStage(overCapacity!);
    expect(existsSync(recordPath(3))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ), { maxSequence: 2 })).toMatchObject({ disposition: 'recorded', reason: 'recorded' });
    expect(existsSync(overCapacityStage)).toBe(false);
    expect(existsSync(recordPath(3))).toBe(false);
    expect(existsSync(recordPath(2))).toBe(true);
  });

  it('fails closed on a two-link stage that is not linked to its canonical target', () => {
    const first = bootstrap();
    const candidate = createReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    const stagePath = writeAuthenticatedStage(candidate!);
    const unexpectedLink = join(releaseTipSettlementRootPath(SCOPE_A), 'unexpected-stage-link');
    linkSync(stagePath, unexpectedLink);
    expect(existsSync(recordPath(2))).toBe(false);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({ disposition: 'failed', reason: 'recovery-failed' });
    expect(existsSync(stagePath)).toBe(true);
    expect(existsSync(unexpectedLink)).toBe(true);
    expect(existsSync(recordPath(2))).toBe(false);
  });

  it('finalizes cleanup only for an authenticated two-link canonical target', () => {
    const first = bootstrap();
    const candidate = createReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ));
    const stagePath = writeAuthenticatedStage(candidate!);
    linkSync(stagePath, recordPath(2));
    expect(statSync(stagePath).nlink).toBe(2);
    expect(statSync(recordPath(2)).nlink).toBe(2);

    expect(recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ))).toMatchObject({ disposition: 'replayed', reason: 'exact-replay' });
    expect(existsSync(stagePath)).toBe(false);
    expect(statSync(recordPath(2)).nlink).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'synchronizes competing writers and depends on the scope outer transaction lock',
    async () => {
      const first = bootstrap();
      const predecessor = first.currentTip!.settlementDigest;
      const held = acquireLocalStoreLock(transactionLockPath(home), 0, {
        anchorPath: join(home, '.ashlr'),
        exactPrivateStorage: true,
      });
      expect(held).not.toBeNull();
      expect(recordReleaseTipSettlement(input(2, predecessor, RELEASE_B), { lockWaitMs: 0 }))
        .toMatchObject({ disposition: 'failed', reason: 'publication-failed' });
      releaseLocalStoreLock(held!);

      const barrier = join(home, 'release-tip-concurrency.barrier');
      const leftPromise = recordInChild(home, input(2, predecessor, RELEASE_B), barrier);
      const rightPromise = recordInChild(home, input(2, predecessor, RELEASE_C), barrier);
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(barrier, 'go', { mode: 0o600 });
      const [left, right] = await Promise.all([leftPromise, rightPromise]);
      expect([left.disposition, right.disposition].sort()).toEqual(['conflicted', 'recorded']);
      const read = readReleaseTipSettlements(SCOPE_A, { requireComplete: true });
      expect(read).toMatchObject({ complete: true, currentTip: { sequence: 2 } });
      expect(read.settlements).toHaveLength(2);
    },
  );

  it('isolates scope paths and rejects a valid record copied across scopes', () => {
    expect(bootstrap(SCOPE_A, RELEASE_A).disposition).toBe('recorded');
    expect(bootstrap(SCOPE_B, RELEASE_B).disposition).toBe('recorded');
    expect(releaseTipSettlementRootPath(SCOPE_A)).not.toBe(releaseTipSettlementRootPath(SCOPE_B));
    expect(readReleaseTipSettlements(SCOPE_A).currentTip).toMatchObject({
      releaseScopeDigest: SCOPE_A,
      releaseDigest: RELEASE_A,
    });
    expect(readReleaseTipSettlements(SCOPE_B).currentTip).toMatchObject({
      releaseScopeDigest: SCOPE_B,
      releaseDigest: RELEASE_B,
    });

    copyFileSync(recordPath(1, SCOPE_A), recordPath(1, SCOPE_B));
    if (process.platform !== 'win32') chmodSync(recordPath(1, SCOPE_B), 0o600);
    expect(readReleaseTipSettlements(SCOPE_B, { requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      availability: 'unavailable',
      stopReasons: ['invalid-file'],
      settlements: [],
    });
  });

  it('fails closed when current provenance key generation identity changes', () => {
    const first = bootstrap();
    expect(first.currentTip).toMatchObject({ provenanceKeyGeneration: 1 });
    const oldKeyId = first.currentTip!.provenanceKeyId;
    writeFileSync(provenanceKeyPath(), randomBytes(32), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(provenanceKeyPath(), 0o600);

    expect(verifyReleaseTipSettlement(first.currentTip)).toBeNull();
    const read = readReleaseTipSettlements(SCOPE_A, { requireComplete: true });
    expect(read).toMatchObject({
      sourceState: 'degraded',
      availability: 'unavailable',
      stopReasons: ['invalid-file'],
      currentTip: null,
    });
    const replacement = createReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST));
    expect(replacement!.provenanceKeyGeneration).toBe(1);
    expect(replacement!.provenanceKeyId).not.toBe(oldKeyId);
    expect(recordReleaseTipSettlement(input(2, first.currentTip!.settlementDigest, RELEASE_B)))
      .toMatchObject({ disposition: 'unavailable', reason: 'chain-unavailable' });
  });

  it('withholds missing or tampered chain members and refuses advancement', () => {
    const first = bootstrap();
    const second = recordReleaseTipSettlement(input(2, first.currentTip!.settlementDigest, RELEASE_B));
    expect(recordReleaseTipSettlement(input(3, second.currentTip!.settlementDigest, RELEASE_C)))
      .toMatchObject({ disposition: 'recorded' });
    rmSync(recordPath(2));
    expect(readReleaseTipSettlements(SCOPE_A, { requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      availability: 'unavailable',
      complete: false,
      currentTip: null,
      settlements: [],
    });
    expect(readReleaseTipSettlements(SCOPE_A).stopReasons).toEqual(expect.arrayContaining([
      'sequence-gap',
      'broken-predecessor',
    ]));
    expect(recordReleaseTipSettlement(input(4, 'd'.repeat(64), RELEASE_A)))
      .toMatchObject({ disposition: 'unavailable', reason: 'chain-unavailable' });

    const record = JSON.parse(readFileSync(recordPath(1), 'utf8')) as Record<string, unknown>;
    record['provenanceKeyGeneration'] = 2;
    writeFileSync(recordPath(1), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(recordPath(1), 0o600);
    expect(verifyReleaseTipSettlement(record)).toBeNull();
  });

  it('rejects hostile input and option proxies without throwing', () => {
    const hostileInput = new Proxy({}, {
      ownKeys: () => { throw new Error('hostile ownKeys'); },
    });
    const hostileOptions = new Proxy({}, {
      get: () => { throw new Error('hostile get'); },
      ownKeys: () => { throw new Error('hostile ownKeys'); },
    });
    expect(createReleaseTipSettlement(hostileInput as ReleaseTipSettlementInput)).toBeNull();
    expect(() => recordReleaseTipSettlement(
      hostileInput as ReleaseTipSettlementInput,
      hostileOptions,
    )).not.toThrow();
    expect(recordReleaseTipSettlement(
      hostileInput as ReleaseTipSettlementInput,
      hostileOptions,
    )).toMatchObject({ disposition: 'invalid', reason: 'invalid-input' });
    expect(() => bootstrapReleaseTipSettlement(
      hostileInput as ReleaseTipSettlementInput,
      hostileOptions,
    )).not.toThrow();
    expect(() => readReleaseTipSettlements(SCOPE_A, hostileOptions)).not.toThrow();
    expect(readReleaseTipSettlements(SCOPE_A, hostileOptions)).toMatchObject({
      sourceState: 'degraded',
      availability: 'unavailable',
      stopReasons: ['invalid-options'],
    });
    expect(() => recoverImmutablePrivateRecordStore(hostileOptions as never, hostileOptions))
      .not.toThrow();
    expect(recoverImmutablePrivateRecordStore(hostileOptions as never, hostileOptions)).toBe('invalid');
    expect(createReleaseTipSettlement({
      ...input(1, RELEASE_TIP_GENESIS_DIGEST),
      rawPrompt: 'do not persist me',
    } as ReleaseTipSettlementInput)).toBeNull();
  });

  it('enforces the exact lowered capacity boundary without raising the production cap', () => {
    const first = bootstrapReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST), {
      maxSequence: 2,
    });
    const second = recordReleaseTipSettlement(input(
      2,
      first.currentTip!.settlementDigest,
      RELEASE_B,
    ), { maxSequence: 2 });
    expect(second.disposition).toBe('recorded');
    expect(recordReleaseTipSettlement(input(
      3,
      second.currentTip!.settlementDigest,
      RELEASE_C,
    ), { maxSequence: 2 })).toMatchObject({
      disposition: 'rejected',
      reason: 'capacity-exhausted',
      currentTip: null,
      durableCompareAndSwapVerified: false,
    });
    expect(recordReleaseTipSettlement(input(
      3,
      second.currentTip!.settlementDigest,
      RELEASE_C,
    ), { maxSequence: 4_097 } as never)).toMatchObject({
      disposition: 'invalid',
      reason: 'invalid-input',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'enforces exact-private POSIX storage and fails closed after permission drift',
    () => {
      expect(bootstrap().disposition).toBe('recorded');
      expect(statSync(releaseTipSettlementRootPath(SCOPE_A)).mode & 0o777).toBe(0o700);
      expect(statSync(recordsPath()).mode & 0o777).toBe(0o700);
      expect(statSync(join(releaseTipSettlementRootPath(SCOPE_A), 'staging')).mode & 0o777)
        .toBe(0o700);
      expect(statSync(recordPath(1)).mode & 0o777).toBe(0o600);
      chmodSync(recordPath(1), 0o644);
      expect(readReleaseTipSettlements(SCOPE_A, { requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        availability: 'unavailable',
        settlements: [],
      });
    },
  );

  it('refuses Windows before touching a scope store and keeps every authority false', () => {
    const untouchedHome = mkdtempSync(join(tmpdir(), 'ashlr-release-current-tip-win-'));
    try {
      vi.stubEnv('HOME', untouchedHome);
      vi.stubEnv('USERPROFILE', untouchedHome);
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const write = recordReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST));
      const boot = bootstrapReleaseTipSettlement(input(1, RELEASE_TIP_GENESIS_DIGEST));
      const read = readReleaseTipSettlements(SCOPE_A);
      for (const outcome of [write, boot]) {
        expect(outcome).toMatchObject({
          disposition: 'unavailable',
          reason: 'platform-unsupported',
          currentTipAuthority: false,
          continuityAuthority: false,
          durableCompareAndSwapVerified: false,
          bootstrapContinuityVerified: false,
          releaseAuthority: false,
          mergePermitted: false,
          deployPermitted: false,
          installPermitted: false,
          startPermitted: false,
          activationPermitted: false,
          rollbackPermitted: false,
        });
      }
      expect(read).toMatchObject({
        sourceState: 'degraded',
        availability: 'unavailable',
        stopReasons: ['platform-unsupported'],
        currentTipAuthority: false,
        continuityAuthority: false,
        durableCompareAndSwapVerified: false,
        bootstrapContinuityVerified: false,
      });
      expect(existsSync(join(untouchedHome, '.ashlr'))).toBe(false);
    } finally {
      rmSync(untouchedHome, { recursive: true, force: true });
    }
  });

  it('keeps the dormant store metadata-only and isolated from operational consumers', () => {
    const sourcePath = join(process.cwd(), 'src/core/daemon/release-current-tip-store.ts');
    const source = readFileSync(sourcePath, 'utf8');
    for (const forbiddenImport of [
      '../inbox/merge',
      '../daemon/service',
      '../daemon/installer',
      'node:child_process',
      'node:net',
      'node:http',
      'node:https',
      'node:dgram',
      'node:worker_threads',
    ]) {
      expect(source).not.toContain(forbiddenImport);
    }
    const consumers = boundedTypeScriptFiles(join(process.cwd(), 'src'))
      .filter((path) => path !== sourcePath)
      .filter((path) => readFileSync(path, 'utf8').includes('release-current-tip-store'));
    expect(consumers).toEqual([]);

    const first = bootstrap();
    const serialized = JSON.stringify(first.candidate);
    for (const forbiddenField of [
      'prompt', 'diff', 'stdout', 'stderr', 'environment', 'fileContents', 'repoPath',
    ]) {
      expect(serialized).not.toContain(forbiddenField);
    }
    for (const permission of [
      'mergePermitted', 'deployPermitted', 'installPermitted', 'startPermitted',
      'activationPermitted', 'rollbackPermitted',
    ]) {
      expect(serialized).toContain(`"${permission}":false`);
    }
    expect(dirname(releaseTipSettlementRootPath(SCOPE_A))).toBe(join(home, '.ashlr'));
  });
});
