import { canonical, digest } from './artifacts.js';
import { validateDiagnostics } from './feedback.js';
import type { UniverseSeedContext, UniverseSeedContextReceipt } from './types.js';

export const MAX_SEED_CONTEXT_BYTES = 16 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
function invalid(): never { throw new Error('Invalid Universe seed context: bounded data-only measured seed evidence required'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function data(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

/** Getter-free validation before canonicalization; returned evidence shares no mutable references. */
export function validateUniverseSeedContext(value: unknown): UniverseSeedContext {
  const sourceKeys = ['universeId', 'campaignId', 'definitionDigest', 'manifestDigest', 'comparatorDigest', 'seedArtifactDigest', 'intentDigest', 'resultDigest'];
  if (!data(value, ['schemaVersion', 'source', 'measurement']) || value.schemaVersion !== 1 ||
      !data(value.source, sourceKeys) || !data(value.measurement, ['passed', 'score', 'metrics', 'diagnostics'])) invalid();
  const source = value.source; const measured = value.measurement;
  for (const key of sourceKeys) if (typeof source[key] !== 'string' || !(key.endsWith('Id') ? ID : HASH).test(source[key] as string)) invalid();
  if (typeof measured.passed !== 'boolean' || !finite(measured.score) || !object(measured.metrics)) invalid();
  const metrics = measured.metrics;
  const metricKeys = Reflect.ownKeys(metrics);
  if (metricKeys.length > 32 || metricKeys.some(key => typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) ||
      !('value' in Object.getOwnPropertyDescriptor(metrics, key)!) || !finite(metrics[key]))) invalid();
  const diagnostics = measured.diagnostics;
  if (!Array.isArray(diagnostics) || Object.getPrototypeOf(diagnostics) !== Array.prototype || diagnostics.length > 16 ||
      Reflect.ownKeys(diagnostics).length !== diagnostics.length + 1) invalid();
  for (let index = 0; index < diagnostics.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(diagnostics, String(index));
    if (!descriptor || !('value' in descriptor) || !data(descriptor.value, ['code', 'message'], ['path', 'line'])) invalid();
  }
  const result = { schemaVersion: 1, source: { ...source }, measurement: { passed: measured.passed, score: measured.score,
    metrics: { ...measured.metrics }, diagnostics: validateDiagnostics(diagnostics) } } as UniverseSeedContext;
  if (Buffer.byteLength(canonical(result), 'utf8') > MAX_SEED_CONTEXT_BYTES) invalid();
  return result;
}

export function seedContextReceipt(context: UniverseSeedContext): UniverseSeedContextReceipt {
  return { schemaVersion: 1, digest: digest(canonical(validateUniverseSeedContext(context))) };
}

export function validSeedContextReceipt(value: unknown): value is UniverseSeedContextReceipt {
  return data(value, ['schemaVersion', 'digest']) && value.schemaVersion === 1 && typeof value.digest === 'string' && HASH.test(value.digest);
}
