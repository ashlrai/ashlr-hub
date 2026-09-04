import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalLocusWorkspaceIdentityObservationBytesV1,
  compileExternalLocusWorkspaceIdentityObservationV1,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
  locusWorkspaceIdentityObservationDigestV1,
  type ExternalLocusWorkspaceIdentityObservationV1,
  type LocusWorkspaceIdentityObservationV1,
} from '../src/core/fabric/external-locus-workspace-identity.js';
import {
  appendLocusWorkspaceIdentityObservationV1,
  readLocusWorkspaceIdentityLedgerV1,
  verifyLocusWorkspaceIdentityLedgerRecordV1,
  type LocusWorkspaceIdentityChainV1,
  type LocusWorkspaceIdentityLedgerDependenciesV1,
} from '../src/core/fabric/locus-workspace-identity-ledger.js';

const NOW = new Date('2026-09-03T12:01:00.000Z');
const AUDIENCE = `sha256:${'1'.repeat(64)}`;
const WORKSPACE = `sha256:${'2'.repeat(64)}`;
const OTHER_AUDIENCE = `sha256:${'3'.repeat(64)}`;
const OTHER_WORKSPACE = `sha256:${'4'.repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonical(value: unknown): Buffer {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(normalize);
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return Buffer.from(JSON.stringify(normalize(value)), 'utf8');
}

function external(
  sequence: number,
  previousObservationDigest: string,
  options: {
    audienceDigest?: string;
    workspaceDigest?: string;
    observedAt?: string;
    expiresAt?: string;
    phantomAvailable?: boolean;
  } = {},
): ExternalLocusWorkspaceIdentityObservationV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-locus-workspace-identity-observation-v1' as const,
    recordType: 'locus-workspace-identity-observation' as const,
    authority: 'observation_only' as const,
    sourceState: 'local_unverified' as const,
    privacyClass: 'metadata_only' as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    effectAuthority: false as const,
    producer: { product: 'locus' as const, version: '0.5.0', commit: 'a'.repeat(40) },
    observedAt: options.observedAt ?? '2026-09-03T12:00:00.000Z',
    expiresAt: options.expiresAt ?? '2026-09-03T12:05:00.000Z',
    sequence,
    previousObservationDigest,
    audienceDigest: options.audienceDigest ?? AUDIENCE,
    workspaceDigest: options.workspaceDigest ?? WORKSPACE,
    identityPosture: 'ready' as const,
    pinPosture: 'valid' as const,
    authorityAnchor: 'verified' as const,
    workspacePolicy: { state: 'valid' as const, requirePin: true, pinAllowed: true },
    mcpRegistered: { claude: true, cursor: false, codex: true, grok: false },
    adapterManifestDigest: null,
    phantomAvailable: options.phantomAvailable ?? true,
    unresolvedCredentials: 0,
    approvalStore: { state: 'healthy' as const, pending: 0, dualControlWaiting: 0 },
    effects: {
      files: false as const, providers: false as const, credentials: false as const,
      pins: false as const, approvals: false as const, dispatches: false as const,
      proposals: false as const, merges: false as const, releases: false as const,
      deployments: false as const, publications: false as const,
      externalMutations: false as const, budgets: false as const, learning: false as const,
    },
  };
  const observationDigest = locusWorkspaceIdentityObservationDigestV1(unsigned);
  if (!observationDigest) throw new Error('test producer could not be digested');
  const producer = { ...unsigned, observationDigest } satisfies LocusWorkspaceIdentityObservationV1;
  const bytes = canonicalLocusWorkspaceIdentityObservationBytesV1(producer);
  if (!bytes) throw new Error('test producer could not be serialized');
  expect(bytes).toEqual(canonical(producer));
  const result = compileExternalLocusWorkspaceIdentityObservationV1(bytes, {
    audienceDigest: producer.audienceDigest,
    workspaceDigest: producer.workspaceDigest,
    sequence: producer.sequence,
    previousObservationDigest: producer.previousObservationDigest,
  }, NOW);
  if (!result.ok) throw new Error(`test producer could not be compiled: ${result.issues.join(',')}`);
  return result.observation;
}

function harness(options: { maxRecords?: number; now?: Date; key?: Buffer | null } = {}): {
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1;
  chain: LocusWorkspaceIdentityChainV1;
} {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m548-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const anchorPath = join(root, '.ashlr');
  mkdirSync(anchorPath, { mode: 0o700 });
  const dependencies: LocusWorkspaceIdentityLedgerDependenciesV1 = {
    anchorPath,
    rootPath: join(anchorPath, 'locus-workspace-identity-ledger-v1'),
    key: options.key === undefined ? Buffer.alloc(32, 0x54) : options.key,
    maxRecords: options.maxRecords,
    now: () => options.now ?? NOW,
  };
  return { dependencies, chain: { audienceDigest: AUDIENCE, workspaceDigest: WORKSPACE } };
}

function sequenceTwo(first: ExternalLocusWorkspaceIdentityObservationV1, options = {}): ExternalLocusWorkspaceIdentityObservationV1 {
  return external(2, first.sourceObservationDigest, options);
}

function forgeExternal(
  source: ExternalLocusWorkspaceIdentityObservationV1,
  mutate: (value: Record<string, unknown>) => void,
): ExternalLocusWorkspaceIdentityObservationV1 {
  const value = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  mutate(value);
  delete value['observationDigest'];
  value['observationDigest'] = `sha256:${createHash('sha256')
    .update('ashlr:external-locus-workspace-identity-observation:v1\0', 'utf8')
    .update(canonical(value))
    .digest('hex')}`;
  return value as unknown as ExternalLocusWorkspaceIdentityObservationV1;
}

function resealLedgerRecord(value: Record<string, unknown>, key: Buffer): void {
  delete value['recordDigest'];
  delete value['attestation'];
  const recordDigest = `sha256:${createHash('sha256')
    .update('ashlr:locus-workspace-identity-ledger:record:v1\0', 'utf8')
    .update(canonical(value))
    .digest('hex')}`;
  value['recordDigest'] = recordDigest;
  value['attestation'] = createHmac('sha256', key)
    .update('ashlr:locus-workspace-identity-ledger:attestation:v1\0', 'utf8')
    .update(canonical([recordDigest, value['chainKey'], value['sequence']]))
    .digest('hex');
}

describe('M548 durable Locus workspace identity lineage ledger', () => {
  it('records genesis and exact successor continuity under one opaque audience/workspace pair', () => {
    const { dependencies, chain } = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const second = sequenceTwo(first, {
      observedAt: '2026-09-03T12:00:30.000Z',
      expiresAt: '2026-09-03T12:05:30.000Z',
    });

    const genesis = appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies);
    expect(genesis.disposition).toBe('recorded');
    const successor = appendLocusWorkspaceIdentityObservationV1(chain, second, dependencies);
    expect(successor.disposition).toBe('recorded');
    if (genesis.disposition !== 'recorded' || successor.disposition !== 'recorded') return;
    expect(successor.record.previousRecordDigest).toBe(genesis.record.recordDigest);
    expect(successor.record.previousSourceObservationDigest).toBe(first.sourceObservationDigest);
    expect(successor.record.chainKey).toBe(genesis.record.chainKey);

    const read = readLocusWorkspaceIdentityLedgerV1(chain, dependencies);
    expect(read).toMatchObject({
      sourceState: 'healthy', chainState: 'healthy', complete: true, totalRecords: 2,
      capacityExhausted: false, rollover: 'unimplemented', tipFresh: true,
      authority: 'observation-only', effectAuthority: 'none', originAuthenticated: false,
      truthVerified: false, releaseProvenanceVerified: false, trusted: false,
      planningAuthority: false, executionAuthority: false, policyEligible: false,
      promotionEligible: false,
    });
    expect(read.records.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(read.tip?.sourceObservationDigest).toBe(second.sourceObservationDigest);
    expect(verifyLocusWorkspaceIdentityLedgerRecordV1(read.tip, dependencies.key))
      .toEqual(read.tip);
  });

  it('rejects exact replay, same-sequence fork, gaps, and wrong predecessors without mutation', () => {
    const { dependencies, chain } = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies).disposition).toBe('recorded');
    expect(appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies).disposition)
      .toBe('observation-replay');
    const fork = sequenceTwo(first, { phantomAvailable: false });
    const second = sequenceTwo(first);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, second, dependencies).disposition).toBe('recorded');
    expect(appendLocusWorkspaceIdentityObservationV1(chain, fork, dependencies).disposition).toBe('fork-detected');
    expect(appendLocusWorkspaceIdentityObservationV1(
      chain,
      external(4, second.sourceObservationDigest),
      dependencies,
    ).disposition).toBe('sequence-gap');
    expect(appendLocusWorkspaceIdentityObservationV1(
      chain,
      external(3, first.sourceObservationDigest),
      dependencies,
    ).disposition).toBe('predecessor-mismatch');
    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies).records).toHaveLength(2);
  });

  it('rejects cross-audience and cross-workspace routing before creating a store', () => {
    const { dependencies, chain } = harness();
    const observation = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(
      { ...chain, audienceDigest: OTHER_AUDIENCE }, observation, dependencies,
    ).disposition).toBe('cross-audience');
    expect(appendLocusWorkspaceIdentityObservationV1(
      { ...chain, workspaceDigest: OTHER_WORKSPACE }, observation, dependencies,
    ).disposition).toBe('cross-workspace');
    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies).sourceState).toBe('missing');
  });

  it('keeps distinct exact audience/workspace chains separated inside one bounded store', () => {
    const { dependencies, chain } = harness();
    const otherChain = { audienceDigest: OTHER_AUDIENCE, workspaceDigest: OTHER_WORKSPACE };
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const other = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST, {
      audienceDigest: OTHER_AUDIENCE,
      workspaceDigest: OTHER_WORKSPACE,
    });
    expect(appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies).disposition).toBe('recorded');
    expect(appendLocusWorkspaceIdentityObservationV1(otherChain, other, dependencies).disposition).toBe('recorded');
    const selected = readLocusWorkspaceIdentityLedgerV1(chain, dependencies);
    expect(selected.records).toHaveLength(1);
    expect(selected.totalRecords).toBe(2);
    expect(selected.records[0]?.workspaceDigest).toBe(WORKSPACE);
    expect(readLocusWorkspaceIdentityLedgerV1(otherChain, dependencies).records[0]?.workspaceDigest)
      .toBe(OTHER_WORKSPACE);
  });

  it('rejects stale and future inputs even when they were previously successful consumer outputs', () => {
    const staleHarness = harness({ now: new Date('2026-09-03T12:05:00.000Z') });
    const observation = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(
      staleHarness.chain, observation, staleHarness.dependencies,
    ).disposition).toBe('stale-observation');

    const futureHarness = harness({ now: new Date('2026-09-03T11:58:59.999Z') });
    expect(appendLocusWorkspaceIdentityObservationV1(
      futureHarness.chain, observation, futureHarness.dependencies,
    ).disposition).toBe('future-observation');
  });

  it('does not call a tip current when the reader clock is behind its observedAt skew bound', () => {
    const { dependencies, chain } = harness();
    const observation = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, observation, dependencies).disposition)
      .toBe('recorded');
    const backwardClock = {
      ...dependencies,
      now: () => new Date('2026-09-03T11:58:59.999Z'),
    };
    expect(readLocusWorkspaceIdentityLedgerV1(chain, backwardClock))
      .toMatchObject({ sourceState: 'healthy', chainState: 'healthy', tipFresh: false });
  });

  it('rejects successor producer-time and local acceptance-time regressions', () => {
    const producerTime = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(
      producerTime.chain, first, producerTime.dependencies,
    ).disposition).toBe('recorded');
    const earlierObservation = sequenceTwo(first, {
      observedAt: '2026-09-03T11:59:59.999Z',
      expiresAt: '2026-09-03T12:04:59.999Z',
    });
    expect(appendLocusWorkspaceIdentityObservationV1(
      producerTime.chain, earlierObservation, producerTime.dependencies,
    ).disposition).toBe('clock-regression');

    const acceptanceTime = harness();
    expect(appendLocusWorkspaceIdentityObservationV1(
      acceptanceTime.chain, first, acceptanceTime.dependencies,
    ).disposition).toBe('recorded');
    acceptanceTime.dependencies.now = () => new Date('2026-09-03T12:00:45.000Z');
    const next = sequenceTwo(first, {
      observedAt: '2026-09-03T12:00:30.000Z',
      expiresAt: '2026-09-03T12:05:30.000Z',
    });
    expect(appendLocusWorkspaceIdentityObservationV1(
      acceptanceTime.chain, next, acceptanceTime.dependencies,
    ).disposition).toBe('clock-regression');
  });

  it('rechecks freshness at publication so lock time cannot admit an expired observation', () => {
    const { dependencies, chain } = harness();
    let clockReads = 0;
    dependencies.now = () => {
      clockReads += 1;
      return clockReads === 1 ? NOW : new Date('2026-09-03T12:05:00.000Z');
    };
    const observation = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, observation, dependencies).disposition)
      .toBe('stale-observation');
    expect(readLocusWorkspaceIdentityLedgerV1(chain, { ...dependencies, now: () => NOW }).records)
      .toEqual([]);
  });

  it('rejects recomputed unkeyed projections that violate the consumer posture invariants', () => {
    const { dependencies, chain } = harness();
    const valid = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const forged = [
      forgeExternal(valid, (value) => {
        value['mcpRegistered'] = { claude: false, cursor: false, codex: false, grok: false };
      }),
      forgeExternal(valid, (value) => {
        const posture = value['reportedPosture'] as Record<string, unknown>;
        posture['pin'] = 'absent';
      }),
      forgeExternal(valid, (value) => {
        const posture = value['reportedPosture'] as Record<string, unknown>;
        posture['identity'] = 'protected';
        posture['workspacePolicy'] = { state: 'missing', requirePin: false, pinAllowed: true };
      }),
      forgeExternal(valid, (value) => {
        const posture = value['reportedPosture'] as Record<string, unknown>;
        posture['identity'] = 'unsafe';
        posture['workspacePolicy'] = { state: 'invalid', requirePin: true, pinAllowed: null };
      }),
      forgeExternal(valid, (value) => {
        const posture = value['reportedPosture'] as Record<string, unknown>;
        posture['authorityAnchor'] = 'unavailable';
      }),
      forgeExternal(valid, (value) => {
        value['approvalStore'] = { state: 'unavailable', pending: 1, dualControlWaiting: 0 };
      }),
      forgeExternal(valid, (value) => {
        const producer = value['producer'] as Record<string, unknown>;
        producer['version'] = `0.5.1+${'a'.repeat(40)}`;
      }),
    ];
    for (const observation of forged) {
      expect(appendLocusWorkspaceIdentityObservationV1(chain, observation, dependencies).disposition)
        .toBe('invalid-observation');
    }
    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies).sourceState).toBe('missing');
  });

  it('reconstructs the canonical producer digest before accepting a locally attestable record', () => {
    const { dependencies, chain } = harness();
    const valid = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const forgedSourceDigest = forgeExternal(valid, (value) => {
      value['sourceObservationDigest'] = `sha256:${'f'.repeat(64)}`;
    });
    expect(forgedSourceDigest.observationDigest).not.toBe(valid.observationDigest);
    expect(appendLocusWorkspaceIdentityObservationV1(
      chain, forgedSourceDigest, dependencies,
    ).disposition).toBe('invalid-observation');

    const reboundAudience = forgeExternal(valid, (value) => {
      value['audienceDigest'] = OTHER_AUDIENCE;
    });
    expect(appendLocusWorkspaceIdentityObservationV1(
      { ...chain, audienceDigest: OTHER_AUDIENCE }, reboundAudience, dependencies,
    ).disposition).toBe('invalid-observation');
    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies).sourceState).toBe('missing');
    expect(readLocusWorkspaceIdentityLedgerV1(
      { ...chain, audienceDigest: OTHER_AUDIENCE }, dependencies,
    ).sourceState).toBe('missing');
  });

  it('degrades explicitly at capacity because bounded rollover is not implemented', () => {
    const { dependencies, chain } = harness({ maxRecords: 2 });
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const second = sequenceTwo(first);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies).disposition).toBe('recorded');
    expect(appendLocusWorkspaceIdentityObservationV1(chain, second, dependencies).disposition).toBe('recorded');
    const full = readLocusWorkspaceIdentityLedgerV1(chain, dependencies);
    expect(full).toMatchObject({
      sourceState: 'degraded', chainState: 'capacity-exhausted', complete: false,
      capacity: 2, capacityExhausted: true, rollover: 'unimplemented',
      stopReasons: ['capacity-exhausted', 'rollover-unimplemented'],
    });
    expect(full.records).toHaveLength(2);
    const third = external(3, second.sourceObservationDigest);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, third, dependencies).disposition)
      .toBe('capacity-exhausted');
    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies, { requireComplete: true }).records)
      .toEqual([]);
  });

  it('fails closed on tampering and unsafe storage', () => {
    const tampered = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(
      tampered.chain, first, tampered.dependencies,
    ).disposition).toBe('recorded');
    const recordsPath = join(tampered.dependencies.rootPath, 'records');
    const file = join(recordsPath, readdirSync(recordsPath)[0]!);
    const contents = readFileSync(file, 'utf8').replace('"truthVerified":false', '"truthVerified":true');
    writeFileSync(file, contents, { mode: 0o600 });
    expect(readLocusWorkspaceIdentityLedgerV1(tampered.chain, tampered.dependencies, { requireComplete: true }))
      .toMatchObject({ sourceState: 'degraded', chainState: 'degraded', records: [], tip: null });

    const unsafe = harness();
    expect(appendLocusWorkspaceIdentityObservationV1(
      unsafe.chain, first, unsafe.dependencies,
    ).disposition).toBe('recorded');
    chmodSync(unsafe.dependencies.rootPath, 0o755);
    expect(readLocusWorkspaceIdentityLedgerV1(unsafe.chain, unsafe.dependencies))
      .toMatchObject({ sourceState: 'degraded', chainState: 'degraded', stopReasons: ['unsafe-storage'] });
  });

  it('degrades an authenticated history whose local acceptance clock regresses', () => {
    const { dependencies, chain } = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const second = sequenceTwo(first);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies).disposition).toBe('recorded');
    expect(appendLocusWorkspaceIdentityObservationV1(chain, second, dependencies).disposition).toBe('recorded');
    const recordsPath = join(dependencies.rootPath, 'records');
    const secondFile = join(recordsPath, readdirSync(recordsPath).sort()[1]!);
    const record = JSON.parse(readFileSync(secondFile, 'utf8')) as Record<string, unknown>;
    expect(record['rollbackProtected']).toBe(false);
    record['acceptedAt'] = '2026-09-03T12:00:59.999Z';
    resealLedgerRecord(record, dependencies.key!);
    writeFileSync(secondFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    expect(readLocusWorkspaceIdentityLedgerV1(chain, dependencies, { requireComplete: true }))
      .toMatchObject({
        sourceState: 'degraded', chainState: 'degraded', complete: false,
        records: [], tip: null, stopReasons: ['clock-regression'],
      });
  });

  it('requires an existing key and anchor and never creates either trust input', () => {
    const noKey = harness({ key: null });
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(noKey.chain, first, noKey.dependencies).disposition)
      .toBe('key-unavailable');
    expect(readLocusWorkspaceIdentityLedgerV1(noKey.chain, noKey.dependencies))
      .toMatchObject({ sourceState: 'degraded', stopReasons: ['key-unavailable'] });
    expect(exists(noKey.dependencies.rootPath)).toBe(false);

    const missing = harness();
    rmSync(missing.dependencies.anchorPath, { recursive: true });
    expect(appendLocusWorkspaceIdentityObservationV1(missing.chain, first, missing.dependencies).disposition)
      .toBe('store-unavailable');
    expect(exists(missing.dependencies.anchorPath)).toBe(false);
  });

  it('returns fresh deep-frozen clones and never turns consistency into authority', () => {
    const { dependencies, chain } = harness();
    const first = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    const written = appendLocusWorkspaceIdentityObservationV1(chain, first, dependencies);
    expect(written.disposition).toBe('recorded');
    const read = readLocusWorkspaceIdentityLedgerV1(chain, dependencies);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.records)).toBe(true);
    expect(Object.isFrozen(read.records[0])).toBe(true);
    expect(Object.isFrozen(read.records[0]?.observation.reportedPosture.workspacePolicy)).toBe(true);
    expect(read.records[0]).not.toBe(written.record);
    expect(() => {
      (read.records[0] as unknown as Record<string, unknown>)['truthVerified'] = true;
    }).toThrow(TypeError);
    const flags = {
      originAuthenticated: read.originAuthenticated,
      truthVerified: read.truthVerified,
      releaseProvenanceVerified: read.releaseProvenanceVerified,
      trusted: read.trusted,
      planningAuthority: read.planningAuthority,
      executionAuthority: read.executionAuthority,
      policyEligible: read.policyEligible,
      promotionEligible: read.promotionEligible,
    };
    expect(Object.values(flags).every((value) => value === false)).toBe(true);
  });

  it('does not report success if the transaction lock inode is replaced before release', () => {
    const { dependencies, chain } = harness();
    const transactionLockPath = join(dependencies.anchorPath, '.locus-workspace-identity-ledger-transaction.lock');
    let clockReads = 0;
    dependencies.now = () => {
      clockReads += 1;
      if (clockReads === 2) {
        unlinkSync(transactionLockPath);
        writeFileSync(transactionLockPath, '{}\n', { mode: 0o600 });
      }
      return NOW;
    };
    const observation = external(1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST);
    expect(appendLocusWorkspaceIdentityObservationV1(chain, observation, dependencies).disposition)
      .toBe('persistence-failed');
  });
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    try {
      readdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
}
