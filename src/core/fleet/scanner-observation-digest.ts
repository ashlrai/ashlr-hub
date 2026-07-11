import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

import type { ScannerObservation } from '../types.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import { verifySourceBaseDigest } from './source-base-digest.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function canonicalPayload(
  observation: ScannerObservation,
  authenticatedBaseDigest: string,
): string | null {
  if (
    observation.schemaVersion !== 1
    || !canonicalTimestamp(observation.observedAt)
    || !boundedString(observation.repo, 4096)
    || !boundedString(observation.scannerId, 64)
    || !boundedString(observation.domain, 64)
    || !boundedString(observation.source, 32)
    || !boundedString(observation.status, 16)
    || !boundedString(observation.reason, 64)
    || (observation.itemId !== undefined && !boundedString(observation.itemId, 180))
    || (observation.objectiveHash !== undefined && !SHA256_HEX_RE.test(observation.objectiveHash))
  ) return null;

  return JSON.stringify([
    'ashlr:scanner-observation:v1',
    resolve(observation.repo).normalize('NFC'),
    observation.scannerId.normalize('NFC'),
    observation.domain.normalize('NFC'),
    observation.source,
    observation.status,
    observation.reason,
    observation.observedAt,
    observation.itemId?.normalize('NFC') ?? null,
    observation.objectiveHash ?? null,
    authenticatedBaseDigest,
  ]);
}

/** Build an attestation only when the observation's source-base envelope authenticates. */
export function buildScannerObservationDigest(observation: ScannerObservation): string | null {
  const sourceBase = verifySourceBaseDigest(
    observation.repo,
    observation.scannerId,
    observation.sourceBase,
  );
  const key = loadExistingProvenanceKey();
  if (!sourceBase || !key) return null;
  const payload = canonicalPayload(observation, sourceBase.baseDigest);
  if (!payload) return null;
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

/** Verify an observation attestation using constant-time digest comparison. */
export function verifyScannerObservationDigest(observation: ScannerObservation): boolean {
  if (!SHA256_HEX_RE.test(observation.observationDigest ?? '')) return false;
  const expected = buildScannerObservationDigest(observation);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(observation.observationDigest!, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
