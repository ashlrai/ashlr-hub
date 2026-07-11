import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildScannerObservationDigest,
  verifyScannerObservationDigest,
} from '../src/core/fleet/scanner-observation-digest.js';
import { buildSourceBaseDigest } from '../src/core/fleet/source-base-digest.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import type { ScannerObservation } from '../src/core/types.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
  const keyPath = provenanceKeyPath();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, Buffer.alloc(32, 13), { mode: 0o600 });
});

afterEach(() => fx.cleanup());

function observation(): ScannerObservation {
  const repo = '/tmp/ashlr-m368-repo';
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
    sourceBase: buildSourceBaseDigest({
      repo,
      scannerId: 'merge-verify-contract',
      scannerRevision: 1,
      sourceKind: 'git-tree',
      consistency: 'stable-double-read',
      dirty: 'clean',
      sourceSnapshot: { head: 'a'.repeat(40), contract: 'missing' },
      requirementSnapshot: { commands: [['npm', 'test']] },
      scannerConfig: { detector: 1 },
    })!,
  };
}

describe('M368 scanner observation attestation', () => {
  it('builds a deterministic digest and verifies the complete observation tuple', () => {
    const value = observation();
    const observationDigest = buildScannerObservationDigest(value)!;
    const attested = { ...value, observationDigest };

    expect(observationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(buildScannerObservationDigest(value)).toBe(observationDigest);
    expect(verifyScannerObservationDigest(attested)).toBe(true);
    expect(JSON.stringify(attested)).not.toContain('npm');
  });

  it('rejects itemId, objectiveHash, status, and observedAt tampering', () => {
    const value = observation();
    const attested = { ...value, observationDigest: buildScannerObservationDigest(value)! };

    expect(verifyScannerObservationDigest({ ...attested, itemId: 'tampered:item' })).toBe(false);
    expect(verifyScannerObservationDigest({ ...attested, objectiveHash: 'e'.repeat(64) })).toBe(false);
    expect(verifyScannerObservationDigest({ ...attested, status: 'absent' })).toBe(false);
    expect(verifyScannerObservationDigest({ ...attested, observedAt: '2026-07-10T11:00:01.000Z' })).toBe(false);
  });

  it('rejects missing attestations and unauthenticated source-base envelopes', () => {
    const value = observation();
    const observationDigest = buildScannerObservationDigest(value)!;

    expect(verifyScannerObservationDigest(value)).toBe(false);
    expect(buildScannerObservationDigest({
      ...value,
      sourceBase: { ...value.sourceBase!, baseDigest: 'e'.repeat(64) },
    })).toBeNull();
    expect(verifyScannerObservationDigest({
      ...value,
      observationDigest,
      sourceBase: { ...value.sourceBase!, baseDigest: 'e'.repeat(64) },
    })).toBe(false);
  });
});
