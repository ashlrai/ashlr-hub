import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveMergeContractResolutionWitness } from '../src/core/fleet/merge-contract-resolution-witness.js';
import { buildSourceBaseDigest } from '../src/core/fleet/source-base-digest.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import type { ScannerObservation, SourceBaseDigestV1 } from '../src/core/types.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const repo = '/tmp/ashlr-m366-repo';
const observerRunId = 'observer-12345678-1234-4123-8123-123456789abc';
const decidedAt = '2026-07-10T12:00:00.000Z';
let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
  const path = provenanceKeyPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(32, 9), { mode: 0o600 });
});

afterEach(() => fx.cleanup());

function sourceBase(
  state: 'missing' | 'satisfied',
  overrides: Partial<SourceBaseDigestV1> = {},
): SourceBaseDigestV1 {
  return {
    ...buildSourceBaseDigest({
      repo,
      scannerId: 'merge-verify-contract',
      scannerRevision: 1,
      sourceKind: 'git-tree',
      consistency: 'stable-double-read',
      dirty: 'clean',
      sourceSnapshot: { head: state === 'missing' ? 'a'.repeat(40) : 'b'.repeat(40), contract: state },
      requirementSnapshot: { projectKinds: ['node'], detectedCommands: [['npm', 'test']] },
      scannerConfig: { detector: 1 },
    })!,
    ...overrides,
  };
}

function present(overrides: Partial<ScannerObservation> = {}): ScannerObservation {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-10T11:00:00.000Z',
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'present',
    reason: 'item-observed',
    itemId: 'repo:test:merge-contract',
    objectiveHash: 'd'.repeat(64),
    sourceBase: sourceBase('missing'),
    ...overrides,
  };
}

function absent(overrides: Partial<ScannerObservation> = {}): ScannerObservation {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-10T11:30:00.000Z',
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'absent',
    reason: 'source-confirmed-empty',
    sourceBase: sourceBase('satisfied'),
    ...overrides,
  };
}

function derive(
  prior: ScannerObservation = present(),
  current: ScannerObservation = absent(),
  overrides: Partial<{ observerRunId: string; decidedAt: string }> = {},
) {
  return deriveMergeContractResolutionWitness({ prior, current, observerRunId, decidedAt, ...overrides });
}

describe('M366 advisory merge-contract resolution witness derivation', () => {
  it('derives only fixed witness metadata from exactly matched observations', () => {
    const prior = present();
    const current = absent();
    expect(derive(prior, current)).toMatchObject({
      schemaVersion: 1,
      decision: 'no-change-required',
      repo,
      scannerId: 'merge-verify-contract',
      scannerRevision: 1,
      itemId: 'repo:test:merge-contract',
      objectiveHash: 'd'.repeat(64),
      observerRunId,
      postStateBaseDigest: current.sourceBase?.baseDigest,
      observationBaseDigest: prior.sourceBase?.baseDigest,
      resolutionKind: 'merge-contract-satisfied',
      resolutionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      decidedAt,
    });
  });

  it('excludes raw and unrecognized observation and source-base metadata', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const prior = present({
      title: secret,
      stdout: secret,
      sourceBase: { ...sourceBase('missing'), rawSource: secret, scannerConfig: { token: secret } },
    } as Partial<ScannerObservation>);
    const current = absent({
      detail: secret,
      sourceBase: { ...sourceBase('satisfied'), rawConfig: secret },
    } as Partial<ScannerObservation>);

    const result = derive(prior, current);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('title');
    expect(result).not.toHaveProperty('sourceBase');
  });

  it('rejects wrong states, legacy/unavailable/raced evidence, and current identity', () => {
    const cases: Array<[ScannerObservation, ScannerObservation]> = [
      [present({ status: 'absent', reason: 'source-confirmed-empty', itemId: undefined, objectiveHash: undefined }), absent()],
      [present(), absent({ status: 'present', reason: 'item-observed', itemId: 'item', objectiveHash: 'e'.repeat(64) })],
      [present(), absent({ status: 'unavailable', reason: 'legacy-empty-result' })],
      [present(), absent({ status: 'unavailable', reason: 'source-raced' })],
      [present({ itemId: undefined }), absent()],
      [present({ objectiveHash: undefined }), absent()],
      [present(), absent({ itemId: 'unexpected' })],
      [present(), absent({ objectiveHash: 'e'.repeat(64) })],
    ];

    expect(cases.map(([prior, current]) => derive(prior, current))).toEqual(Array(cases.length).fill(null));
  });

  it('rejects repo, scanner metadata, revision, source-base, and consistency mismatches', () => {
    const cases: Array<[ScannerObservation, ScannerObservation]> = [
      [present(), absent({ repo: '/tmp/other-repo' })],
      [present(), absent({ scannerId: 'test-health' })],
      [present({ scannerId: 'test-health' }), absent({ scannerId: 'test-health' })],
      [present({ domain: 'tests' }), absent()],
      [present(), absent({ domain: 'tests' })],
      [present({ source: 'self' }), absent()],
      [present(), absent({ source: 'self' })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { scannerRevision: 2 }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { sourceKind: 'filesystem-snapshot' }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { sourceDigest: 'e'.repeat(64) }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { requirementDigest: 'e'.repeat(64) }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { configDigest: 'e'.repeat(64) }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { baseDigest: 'e'.repeat(64) }) })],
      [present(), absent({ sourceBase: sourceBase('satisfied', { consistency: 'locked' }) })],
      [present(), absent({ sourceBase: sourceBase('missing') })],
    ];

    expect(cases.map(([prior, current]) => derive(prior, current))).toEqual(Array(cases.length).fill(null));
  });

  it('rejects malformed, equal, reversed, and decision-inconsistent chronology', () => {
    const cases = [
      derive(present({ observedAt: '2026-07-10 11:00:00Z' })),
      derive(present(), absent({ observedAt: 'not-a-timestamp' })),
      derive(present({ observedAt: '2026-07-10T11:30:00.000Z' })),
      derive(present({ observedAt: '2026-07-10T11:31:00.000Z' })),
      derive(present(), absent(), { decidedAt: '2026-07-10T11:29:59.999Z' }),
    ];

    expect(cases).toEqual(Array(cases.length).fill(null));
    expect(derive(present(), absent(), { decidedAt: '2026-07-10T11:30:00.000Z' })).not.toBeNull();
  });

  it('rejects missing, malformed, or dirty source bases and malformed witness metadata', () => {
    const malformedBase = { ...sourceBase('missing'), baseDigest: 'not-a-digest' } as SourceBaseDigestV1;
    const cases = [
      derive(present({ sourceBase: undefined })),
      derive(present(), absent({ sourceBase: undefined })),
      derive(present({ sourceBase: malformedBase })),
      derive(present({ sourceBase: sourceBase('missing', { dirty: 'tracked' }) })),
      derive(present(), absent({ sourceBase: sourceBase('satisfied', { dirty: 'mixed' }) })),
      derive(present(), absent(), { observerRunId: 'unsafe/observer' }),
      derive(present(), absent(), { decidedAt: '2026-07-10 12:00:00Z' }),
      derive(present({ objectiveHash: 'not-a-hash' })),
    ];

    expect(cases).toEqual(Array(cases.length).fill(null));
  });
});
