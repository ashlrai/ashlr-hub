import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { digestExternalEfficiencyReceiptV1 } from '../src/core/fabric/external-efficiency-receipt.js';
import {
  stackPlannedEffectManifestDigestV1,
  type StackPlannedEffectManifestV1,
} from '../src/core/fabric/external-stack-effect-plan.js';
import {
  stackObservationManifestDigestV1,
  type StackObservationManifestV1,
} from '../src/core/fabric/external-stack-observation.js';
import {
  runEcosystemConformanceV1,
  type EcosystemConformanceOptionsV1,
} from '../scripts/run-ecosystem-conformance.js';

const NOW = new Date('2026-09-03T12:01:00.000Z');
const CORE_DOMAIN = 'ashlr:external-efficiency-receipt:v1\0';

const CORE_PRODUCER = `
import { createHash } from 'node:crypto';
export const CORE_EFFICIENCY_RECEIPT_PROTOCOL = 'ashlr-external-efficiency-receipt-v1';
export function digestCoreEfficiencyReceiptV1(value) {
  return createHash('sha256').update('ashlr:external-efficiency-receipt:v1\\0', 'utf8').update(Buffer.from(JSON.stringify(value))).digest('hex');
}
export function validateCoreEfficiencyReceiptV1(value) {
  if (!value || typeof value !== 'object') return { valid: false };
  const { receiptDigest, ...unsigned } = value;
  const valid = value.schemaVersion === 1 && value.protocol === CORE_EFFICIENCY_RECEIPT_PROTOCOL &&
    value.sourceProduct === '@ashlr/core-efficiency' && /^0\\.3\\.[0-9]+$/.test(value.sourceVersion) &&
    receiptDigest === digestCoreEfficiencyReceiptV1(unsigned);
  return valid ? { valid: true, value } : { valid: false };
}
export function canonicalCoreEfficiencyReceiptBytesV1(value) {
  return validateCoreEfficiencyReceiptV1(value).valid ? Buffer.from(JSON.stringify(value), 'utf8') : null;
}
`;

const PLUGIN_PRODUCER = `
import { createHash } from 'node:crypto';
export const EFFICIENCY_RECEIPT_PROTOCOL = 'ashlr-external-efficiency-receipt-v1';
export function digestEfficiencyReceiptV1(value) {
  return createHash('sha256').update('ashlr:external-efficiency-receipt:v1\\0', 'utf8').update(Buffer.from(JSON.stringify(value))).digest('hex');
}
export function canonicalEfficiencyReceiptBytesV1(value) {
  if (!value || value.sourceProduct !== 'ashlr-plugin' || !/^1\\.[0-9]+\\.[0-9]+$/.test(value.sourceVersion)) return null;
  const { receiptDigest, ...unsigned } = value;
  return receiptDigest === digestEfficiencyReceiptV1(unsigned) ? Buffer.from(JSON.stringify(value), 'utf8') : null;
}
export function parseCanonicalEfficiencyReceiptV1(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = canonicalEfficiencyReceiptBytesV1(value);
    return canonical && Buffer.from(canonical).equals(Buffer.from(bytes)) ? value : null;
  } catch { return null; }
}
`;

const STACK_PRODUCER = `
import { createHash } from 'node:crypto';
export const STACK_OBSERVATION_MANIFEST_PROTOCOL = 'ashlr-stack-observation-manifest-v1';
export const STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL = 'ashlr-stack-planned-effect-manifest-v1';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(domain, value) {
  const { manifestDigest: _manifestDigest, ...unsigned } = value;
  return 'sha256:' + createHash('sha256').update(domain, 'utf8').update('\\0').update(Buffer.from(JSON.stringify(canonical(unsigned)))).digest('hex');
}
function validWindow(value, now) {
  const generated = Date.parse(value.generatedAt); const expires = Date.parse(value.expiresAt); const current = now.getTime();
  return generated <= current + 60000 && expires > generated && expires - generated <= 600000 && expires > current;
}
export function stackObservationManifestDigestV1(value) { return digest('ashlr:stack-observation-manifest:v1', value); }
export function stackPlannedEffectManifestDigestV1(value) { return digest('ashlr:stack-planned-effect-manifest:v1', value); }
export function canonicalStackObservationManifestBytesV1(value) { return Buffer.from(JSON.stringify(canonical(value))); }
export function canonicalStackPlannedEffectManifestBytesV1(value) { return Buffer.from(JSON.stringify(canonical(value))); }
export function validateStackObservationManifestV1(value, now = new Date()) {
  return value?.protocol === STACK_OBSERVATION_MANIFEST_PROTOCOL && /^0\\.2\\.[0-9]+$/.test(value?.source?.version) &&
    value.manifestDigest === stackObservationManifestDigestV1(value) && validWindow(value, now);
}
export function validateStackPlannedEffectManifestV1(value, now = new Date()) {
  return value?.protocol === STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL && /^0\\.2\\.[0-9]+$/.test(value?.source?.version) &&
    value.manifestDigest === stackPlannedEffectManifestDigestV1(value) && validWindow(value, now);
}
`;

interface FixtureOptions {
  coreVersion?: string;
  staleCore?: boolean;
  pluginVersion?: string;
  stackVersion?: string;
  staleStack?: boolean;
  mismatchedBinding?: boolean;
  privacyField?: boolean;
}

let directory = '';

function opaque(label: string): string {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonical((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
}

function coreBytes(version = '0.3.0', privacyField = false, stale = false): Buffer {
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-external-efficiency-receipt-v1' as const,
    sourceProduct: '@ashlr/core-efficiency' as const,
    sourceVersion: version,
    sourceCommit: 'a'.repeat(40),
    intervalStartedAt: stale ? '2026-09-01T11:00:00.000Z' : '2026-09-03T11:00:00.000Z',
    intervalEndedAt: stale ? '2026-09-01T11:58:00.000Z' : '2026-09-03T11:58:00.000Z',
    observedAt: stale ? '2026-09-01T11:59:00.000Z' : '2026-09-03T11:59:00.000Z',
    calls: 2,
    rawTokens: 2_000,
    compactTokens: 1_200,
    savedTokens: 800,
    measuredSavedTokens: 800,
    estimatedSavedTokens: 0,
    counterfactualSavedTokens: 0,
    accountingMethod: 'provider-usage-v1' as const,
    pricingVersion: 'core-rate-table-v3',
  };
  const receiptDigest = version === '0.3.0'
    ? digestExternalEfficiencyReceiptV1(unsigned)
    : createHash('sha256').update(CORE_DOMAIN, 'utf8')
      .update(Buffer.from(JSON.stringify(unsigned))).digest('hex');
  if (!receiptDigest) throw new Error('expected Core digest');
  const receipt: Record<string, unknown> = { ...unsigned, receiptDigest };
  if (privacyField) receipt['sessionId'] = 'session_secret_value';
  return Buffer.from(JSON.stringify(receipt), 'utf8');
}

function pluginBytes(version = '1.36.2', privacyField = false): Buffer {
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-external-efficiency-receipt-v1' as const,
    sourceProduct: 'ashlr-plugin' as const,
    sourceVersion: version,
    sourceCommit: 'c'.repeat(40),
    intervalStartedAt: '2026-09-03T11:00:00.000Z',
    intervalEndedAt: '2026-09-03T11:58:00.000Z',
    observedAt: '2026-09-03T11:59:00.000Z',
    calls: 2,
    rawTokens: 2_000,
    compactTokens: 1_200,
    savedTokens: 800,
    measuredSavedTokens: 0,
    estimatedSavedTokens: 800,
    counterfactualSavedTokens: 0,
    accountingMethod: 'chars-div-4-v1' as const,
    pricingVersion: 'plugin-chars-div-4-v1',
  };
  const receiptDigest = createHash('sha256').update(CORE_DOMAIN, 'utf8')
    .update(Buffer.from(JSON.stringify(unsigned))).digest('hex');
  const receipt: Record<string, unknown> = { ...unsigned, receiptDigest };
  if (privacyField) receipt['apiKey'] = 'private-provider-credential';
  return Buffer.from(JSON.stringify(receipt), 'utf8');
}

function stackBytes(options: FixtureOptions): { observation: Buffer; effect: Buffer } {
  const generatedAt = options.staleStack ? '2026-09-03T10:00:00.000Z' : '2026-09-03T12:00:00.000Z';
  const expiresAt = options.staleStack ? '2026-09-03T10:05:00.000Z' : '2026-09-03T12:05:00.000Z';
  const source = {
    product: 'stack' as const,
    version: options.stackVersion ?? '0.2.0',
    commit: 'b'.repeat(40),
  };
  const observationUnsigned: Omit<StackObservationManifestV1, 'manifestDigest'> = {
    schemaVersion: 1,
    protocol: 'ashlr-stack-observation-manifest-v1',
    source,
    generatedAt,
    expiresAt,
    topology: {
      componentCount: 2,
      connectionCount: 1,
      components: [
        { kind: 'control-plane', count: 1 },
        { kind: 'local-runtime', count: 1 },
      ],
      connections: [{ from: 'control-plane', to: 'local-runtime', count: 1 }],
    },
    resources: {
      resourceCount: 1,
      classes: [{ kind: 'compute', classDigest: opaque('compute'), state: 'available', count: 1 }],
    },
    phantom: null,
  };
  const observationDigest = stackObservationManifestDigestV1(observationUnsigned);
  if (!observationDigest) throw new Error('expected Stack observation digest');
  const observation: Record<string, unknown> = { ...observationUnsigned, manifestDigest: observationDigest };
  if (options.privacyField) observation['secretValue'] = '/private/production-token';

  const effectUnsigned: Omit<StackPlannedEffectManifestV1, 'manifestDigest'> = {
    schemaVersion: 1,
    protocol: 'ashlr-stack-planned-effect-manifest-v1',
    artifactClass: 'effect-proposal',
    source,
    generatedAt,
    expiresAt,
    targetDigest: opaque('target'),
    effect: { class: 'deployment', verb: 'deploy' },
    observationManifestDigest: options.mismatchedBinding ? opaque('other-observation') : observationDigest,
    preconditionsDigest: opaque('preconditions'),
    expectedDiffDigest: opaque('expected-diff'),
    idempotencyKeyDigest: opaque('idempotency'),
    estimatedCost: { known: false, amountMicroUnits: null, currency: null },
    requiredSecretCapabilityClass: null,
    rollback: { class: 'automatic', planDigest: opaque('rollback') },
    acceptancePredicateDigest: opaque('acceptance'),
  };
  const effectDigest = stackPlannedEffectManifestDigestV1(effectUnsigned);
  if (!effectDigest) throw new Error('expected Stack effect digest');
  const effect = { ...effectUnsigned, manifestDigest: effectDigest };
  return {
    observation: Buffer.from(JSON.stringify(canonical(observation))),
    effect: Buffer.from(JSON.stringify(canonical(effect))),
  };
}

async function arrange(options: FixtureOptions = {}): Promise<EcosystemConformanceOptionsV1> {
  const coreEntryPath = join(directory, 'core-receipts.mjs');
  const pluginEntryPath = join(directory, 'plugin-receipts.mjs');
  const stackEntryPath = join(directory, 'stack-contracts.mjs');
  const coreFixturePath = join(directory, 'core.json');
  const pluginFixturePath = join(directory, 'plugin.json');
  const stackObservationFixturePath = join(directory, 'stack-observation.json');
  const stackEffectFixturePath = join(directory, 'stack-effect.json');
  const stack = stackBytes(options);
  await Promise.all([
    writeFile(coreEntryPath, CORE_PRODUCER),
    writeFile(pluginEntryPath, PLUGIN_PRODUCER),
    writeFile(stackEntryPath, STACK_PRODUCER),
    writeFile(coreFixturePath, coreBytes(options.coreVersion, options.privacyField, options.staleCore)),
    writeFile(pluginFixturePath, pluginBytes(options.pluginVersion, options.privacyField)),
    writeFile(stackObservationFixturePath, stack.observation),
    writeFile(stackEffectFixturePath, stack.effect),
  ]);
  return {
    coreEntryPath,
    coreFixturePath,
    pluginEntryPath,
    pluginFixturePath,
    stackEntryPath,
    stackObservationFixturePath,
    stackEffectFixturePath,
    stackNow: NOW,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  directory = await mkdtemp(join(tmpdir(), 'ashlr-conformance-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe('M544 ecosystem conformance runner', () => {
  it('accepts byte-identical compatible producers while preserving zero authority', async () => {
    const report = await runEcosystemConformanceV1(await arrange());

    expect(report.state).toBe('pass');
    expect(report.authority).toBe(false);
    expect(report.evaluatedAt).toBe(NOW.toISOString());
    expect(report.releaseReady).toBe(false);
    expect(Object.values(report.products.coreEfficiency.checks)).toEqual(Array(6).fill('pass'));
    expect(Object.values(report.products.plugin.checks)).toEqual(Array(6).fill('pass'));
    expect(Object.values(report.products.stack.checks)).toEqual(Array(6).fill('pass'));
    expect(report.products.stack.acceptanceClock).toBe('explicit-historical');
    expect(report.products.stack.currentFreshness).toBe(true);
    expect(report.products.stack.evidence['observationToEffectBound']).toBe(true);
    const emitted = JSON.stringify(report);
    expect(emitted).not.toContain(directory);
    expect(emitted).not.toMatch(/sessionId|secretValue|\/Users\/private/u);
  });

  it('requires live acceptance and released-source provenance for release readiness', async () => {
    const options = await arrange();
    options.stackNow = undefined;
    options.coreFixtureProvenance = 'released-source';
    options.pluginFixtureProvenance = 'released-source';
    options.stackFixtureProvenance = 'released-source';
    const report = await runEcosystemConformanceV1(options);

    expect(report.state).toBe('pass');
    expect(report.releaseReady).toBe(true);
    expect(report.products.coreEfficiency.releaseReady).toBe(true);
    expect(report.products.plugin.releaseReady).toBe(true);
    expect(report.products.stack.acceptanceClock).toBe('live');
    expect(report.products.stack.releaseReady).toBe(true);
  });

  it('reports missing builds and fixtures as unavailable, never pass', async () => {
    const missingBuild = await arrange();
    missingBuild.coreEntryPath = join(directory, 'missing-core.mjs');
    const buildReport = await runEcosystemConformanceV1(missingBuild);
    expect(buildReport.state).toBe('unavailable');
    expect(buildReport.products.coreEfficiency.checks['producer-build-present']).toBe('unavailable');
    expect(Object.values(buildReport.products.coreEfficiency.checks)).not.toContain('pass');

    const missingFixture = await arrange();
    missingFixture.stackEffectFixturePath = join(directory, 'missing-effect.json');
    const fixtureReport = await runEcosystemConformanceV1(missingFixture);
    expect(fixtureReport.state).toBe('unavailable');
    expect(fixtureReport.products.stack.checks['producer-build-present']).toBe('pass');
    expect(fixtureReport.products.stack.checks['fixture-byte-identical']).toBe('unavailable');
    expect(fixtureReport.products.stack.checks['Hub-accepted']).toBe('unavailable');
  });

  it('fails closed when exact fixture bytes are tampered', async () => {
    const options = await arrange();
    const original = coreBytes();
    await writeFile(options.coreFixturePath, Buffer.concat([original, Buffer.from('\n')]));
    const report = await runEcosystemConformanceV1(options);
    expect(report.state).toBe('fail');
    expect(report.products.coreEfficiency.checks['fixture-byte-identical']).toBe('fail');
    expect(report.products.coreEfficiency.checks['Hub-accepted']).toBe('fail');
    expect(report.products.coreEfficiency.checks['authority=false']).toBe('unavailable');
  });

  it('fails stale Stack fixtures without conflating freshness with protocol version', async () => {
    const report = await runEcosystemConformanceV1(await arrange({ staleStack: true }));
    expect(report.state).toBe('fail');
    expect(report.products.stack.checks['protocol-compatible']).toBe('pass');
    expect(report.products.stack.checks['fixture-byte-identical']).toBe('pass');
    expect(report.products.stack.checks['Hub-accepted']).toBe('fail');
  });

  it('fails a stale Core receipt even when producer bytes and protocol still match', async () => {
    const report = await runEcosystemConformanceV1(await arrange({ staleCore: true }));
    expect(report.state).toBe('fail');
    expect(report.products.coreEfficiency.checks['protocol-compatible']).toBe('pass');
    expect(report.products.coreEfficiency.checks['fixture-byte-identical']).toBe('pass');
    expect(report.products.coreEfficiency.checks['Hub-accepted']).toBe('fail');
  });

  it('fails unsupported producer versions', async () => {
    const core = await runEcosystemConformanceV1(await arrange({ coreVersion: '0.4.0' }));
    expect(core.products.coreEfficiency.checks['protocol-compatible']).toBe('fail');
    expect(core.products.coreEfficiency.checks['Hub-accepted']).toBe('fail');

    const stack = await runEcosystemConformanceV1(await arrange({ stackVersion: '0.3.0' }));
    expect(stack.products.stack.checks['protocol-compatible']).toBe('fail');
    expect(stack.products.stack.checks['Hub-accepted']).toBe('fail');

    const plugin = await runEcosystemConformanceV1(await arrange({ pluginVersion: '2.0.0' }));
    expect(plugin.products.plugin.checks['protocol-compatible']).toBe('fail');
    expect(plugin.products.plugin.checks['Hub-accepted']).toBe('fail');
  });

  it('requires the planned effect to bind the exact accepted observation', async () => {
    const report = await runEcosystemConformanceV1(await arrange({ mismatchedBinding: true }));
    expect(report.products.stack.checks['fixture-byte-identical']).toBe('pass');
    expect(report.products.stack.evidence['observationToEffectBound']).toBe(false);
    expect(report.products.stack.checks['Hub-accepted']).toBe('fail');
    expect(report.products.stack.checks['authority=false']).toBe('unavailable');
  });

  it('rejects privacy-bearing fields without reflecting their keys, values, or paths', async () => {
    const report = await runEcosystemConformanceV1(await arrange({ privacyField: true }));
    expect(report.state).toBe('fail');
    expect(report.products.coreEfficiency.evidence['privacySafe']).toBe(false);
    expect(report.products.plugin.evidence['privacySafe']).toBe(false);
    expect(report.products.stack.evidence['privacySafe']).toBe(false);
    const emitted = JSON.stringify(report);
    expect(emitted).not.toContain('session_secret_value');
    expect(emitted).not.toContain('/private/production-token');
    expect(emitted).not.toContain('private-provider-credential');
    expect(emitted).not.toMatch(/sessionId|secretValue/u);
    expect(emitted).not.toContain(directory);
  });

  it('contains no discovery or ambient-import seam', async () => {
    const runner = await import('../scripts/run-ecosystem-conformance.js?source-check');
    expect(runner.ECOSYSTEM_CONFORMANCE_PROTOCOL).toBe('ashlr-ecosystem-conformance-v1');
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../scripts/run-ecosystem-conformance.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/\b(?:homedir|readdir|glob|find|process\.env)\b/u);
    expect(source).not.toContain(['/', 'Users', '/'].join(''));
    expect(source).not.toContain('Desktop');
  });

  it('keeps checked-in conformance evidence free of operator-local topology', async () => {
    const evidence = await readFile(new URL(
      '../workplans/2026-09-03-agent-native-engineering-os/ecosystem-conformance-evidence.md',
      import.meta.url,
    ), 'utf8');
    const userDirectory = /\/U[A-Za-z]+\/[A-Za-z0-9._-]+\//u;
    const privateWorktree = /\.[a-z]+\/worktrees(?:\/|\b)/iu;
    const ambientHomeName = ['HO', 'ME'].join('');

    expect(evidence).not.toMatch(userDirectory);
    expect(evidence).not.toMatch(privateWorktree);
    expect(evidence).not.toContain(ambientHomeName);
  });
});
