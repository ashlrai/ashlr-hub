import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalStackPlannedEffectManifestBytesV1,
  compileExternalStackEffectPlanV1,
  STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
  STACK_PLANNED_EFFECT_MAX_BYTES,
  stackPlannedEffectManifestDigestV1,
  type StackPlannedEffectManifestV1,
} from '../src/core/fabric/external-stack-effect-plan.js';

const GENERATED_AT = '2026-09-03T12:00:00.000Z';
const EXPIRES_AT = '2026-09-03T12:05:00.000Z';
const NOW = new Date('2026-09-03T12:01:00.000Z');

function digest(label: string): string {
  return `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function unsignedManifest(): Omit<StackPlannedEffectManifestV1, 'manifestDigest'> {
  return {
    schemaVersion: 1,
    protocol: STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
    artifactClass: 'effect-proposal',
    source: {
      product: 'stack',
      version: '0.2.0',
      commit: createHash('sha256').update('stack-effect-commit', 'utf8').digest('hex'),
    },
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    targetDigest: digest('opaque-target'),
    effect: { class: 'deployment', verb: 'deploy' },
    observationManifestDigest: digest('observation-manifest'),
    preconditionsDigest: digest('preconditions'),
    expectedDiffDigest: digest('expected-diff'),
    idempotencyKeyDigest: digest('idempotency-key'),
    estimatedCost: { known: true, amountMicroUnits: 2_500_000, currency: 'USD' },
    requiredSecretCapabilityClass: 'deployment-control',
    rollback: { class: 'automatic', planDigest: digest('rollback-plan') },
    acceptancePredicateDigest: digest('acceptance-predicate'),
  };
}

function manifest(
  mutate?: (value: Omit<StackPlannedEffectManifestV1, 'manifestDigest'>) => void,
): StackPlannedEffectManifestV1 {
  const unsigned = unsignedManifest();
  mutate?.(unsigned);
  const manifestDigest = stackPlannedEffectManifestDigestV1(unsigned);
  if (!manifestDigest) throw new Error('expected manifest digest');
  return { ...unsigned, manifestDigest };
}

function bytesOf(value: StackPlannedEffectManifestV1): Buffer {
  const bytes = canonicalStackPlannedEffectManifestBytesV1(value);
  if (!bytes) throw new Error('expected canonical manifest bytes');
  return bytes;
}

function unsafeRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('M542 external Stack effect proposal protocol', () => {
  it('binds the complete proposal tuple while granting no approval, eligibility, authority, or performed effect', () => {
    const value = manifest();
    const result = compileExternalStackEffectPlanV1(bytesOf(value), NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      schemaVersion: 1,
      protocol: 'ashlr-external-stack-effect-plan-v1',
      recordType: 'external-stack-effect-plan',
      artifactClass: 'effect-proposal',
      verification: 'local-unverified',
      source: value.source,
      targetDigest: value.targetDigest,
      effect: value.effect,
      observationManifestDigest: value.observationManifestDigest,
      preconditionsDigest: value.preconditionsDigest,
      expectedDiffDigest: value.expectedDiffDigest,
      idempotencyKeyDigest: value.idempotencyKeyDigest,
      estimatedCost: value.estimatedCost,
      requiredSecretCapabilityClass: value.requiredSecretCapabilityClass,
      rollback: value.rollback,
      acceptancePredicateDigest: value.acceptancePredicateDigest,
      manifestDigest: value.manifestDigest,
    });
    expect(result.plan.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const gates = {
      authenticated: result.plan.authenticated,
      trusted: result.plan.trusted,
      authority: result.plan.authority,
      effectAuthority: result.plan.effectAuthority,
      planningAuthority: result.plan.planningAuthority,
      executionAuthority: result.plan.executionAuthority,
      proposalAuthority: result.plan.proposalAuthority,
      approvalAuthority: result.plan.approvalAuthority,
      policyAuthority: result.plan.policyAuthority,
      promotionAuthority: result.plan.promotionAuthority,
      mergeAuthority: result.plan.mergeAuthority,
      releaseAuthority: result.plan.releaseAuthority,
      deployAuthority: result.plan.deployAuthority,
      publicationAuthority: result.plan.publicationAuthority,
      externalMutationAuthority: result.plan.externalMutationAuthority,
      secretAccessAuthority: result.plan.secretAccessAuthority,
      eligible: result.plan.eligible,
      planningEligible: result.plan.planningEligible,
      executionEligible: result.plan.executionEligible,
      policyEligible: result.plan.policyEligible,
      promotionEligible: result.plan.promotionEligible,
      approved: result.plan.approved,
      performed: result.plan.performed,
      effectPerformed: result.plan.effectPerformed,
    };
    expect(Object.values(gates).every((flag) => flag === false)).toBe(true);
  });

  it('deep-freezes the cloned digest-bound plan without freezing caller-owned manifests', () => {
    const callerOwned = manifest();
    const result = compileExternalStackEffectPlanV1(bytesOf(callerOwned), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const planDigest = result.plan.planDigest;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.source)).toBe(true);
    expect(Object.isFrozen(result.plan.effect)).toBe(true);
    expect(Object.isFrozen(result.plan.estimatedCost)).toBe(true);
    expect(Object.isFrozen(result.plan.rollback)).toBe(true);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    expect(() => { unsafeRecord(result.plan.effect)['verb'] = 'delete'; }).toThrow(TypeError);
    expect(() => { unsafeRecord(result.plan.rollback)['planDigest'] = digest('forged'); }).toThrow(TypeError);
    expect(result.plan.effect.verb).toBe('deploy');
    expect(result.plan.rollback.planDigest).toBe(callerOwned.rollback.planDigest);
    expect(result.plan.planDigest).toBe(planDigest);
  });

  it('accepts exactly one canonical encoding and rejects reordered, whitespace, and duplicate-key JSON', () => {
    const value = manifest();
    const canonical = bytesOf(value);
    expect(compileExternalStackEffectPlanV1(canonical, NOW).ok).toBe(true);

    for (const candidate of [
      Buffer.from(JSON.stringify(value), 'utf8'),
      Buffer.concat([canonical, Buffer.from('\n', 'utf8')]),
      Buffer.from(canonical.toString('utf8').replace('{', '{"schemaVersion":1,'), 'utf8'),
    ]) {
      expect(candidate.equals(canonical)).toBe(false);
      expect(compileExternalStackEffectPlanV1(candidate, NOW)).toMatchObject({
        ok: false,
        issues: ['non-canonical-json'],
      });
    }
  });

  it('rejects arbitrary prose, metadata, provider identifiers, URLs, scopes, paths, and secret material', () => {
    const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['prose', (value) => { value['description'] = 'Please deploy this to production.'; }],
      ['metadata', (value) => { value['metadata'] = { owner: 'caller' }; }],
      ['provider id', (value) => { value['providerResourceId'] = 'provider/account/resource-123'; }],
      ['URL', (value) => { value['url'] = 'https://provider.example/control'; }],
      ['scope', (value) => { value['scopes'] = ['administrator']; }],
      ['path', (value) => { value['path'] = '/Users/example/private'; }],
      ['secret value', (value) => { value['secretValue'] = 'plaintext-token'; }],
      ['secret name', (value) => { value['secretName'] = 'PRODUCTION_TOKEN'; }],
      ['secret reference', (value) => { value['secretRef'] = 'vault://production/token'; }],
    ];

    for (const [label, mutate] of cases) {
      const value = manifest() as unknown as Record<string, unknown>;
      mutate(value);
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      ), label).toMatchObject({ ok: false, plan: null, issues: ['invalid-manifest'] });
    }

    const namedCapability = manifest() as unknown as Record<string, unknown>;
    namedCapability['requiredSecretCapabilityClass'] = 'AWS_PRODUCTION_ADMIN_KEY';
    expect(compileExternalStackEffectPlanV1(
      Buffer.from(JSON.stringify(namedCapability), 'utf8'),
      NOW,
    )).toMatchObject({ ok: false, issues: ['invalid-manifest'] });
  });

  it('rejects malformed bytes, malformed JSON, and oversized inputs', () => {
    expect(compileExternalStackEffectPlanV1(Buffer.from([0xff, 0xfe]), NOW)).toMatchObject({
      ok: false,
      issues: ['invalid-bytes'],
    });
    expect(compileExternalStackEffectPlanV1(Buffer.from('{"', 'utf8'), NOW)).toMatchObject({
      ok: false,
      issues: ['non-canonical-json'],
    });
    expect(compileExternalStackEffectPlanV1(Buffer.alloc(STACK_PLANNED_EFFECT_MAX_BYTES + 1), NOW)).toMatchObject({
      ok: false,
      issues: ['oversized-manifest'],
    });
  });

  it('supports only stable Stack 0.2.x manifests and the exact protocol version', () => {
    for (const version of ['0.3.0', '1.0.0', '0.2.1-alpha.1']) {
      const value = manifest((candidate) => { candidate.source.version = version; });
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      ), version).toMatchObject({ ok: false, issues: ['unsupported-version'] });
    }
    const compatible = manifest((value) => { value.source.version = '0.2.19'; });
    expect(compileExternalStackEffectPlanV1(bytesOf(compatible), NOW).ok).toBe(true);

    const futureProtocol = manifest() as unknown as Record<string, unknown>;
    futureProtocol['schemaVersion'] = 2;
    expect(compileExternalStackEffectPlanV1(
      Buffer.from(JSON.stringify(futureProtocol), 'utf8'),
      NOW,
    )).toMatchObject({ ok: false, issues: ['unsupported-version'] });
  });

  it('rejects future, expired, inverted, and overlong validity windows', () => {
    const future = manifest((value) => {
      value.generatedAt = '2026-09-03T12:02:01.000Z';
      value.expiresAt = '2026-09-03T12:07:01.000Z';
    });
    expect(compileExternalStackEffectPlanV1(bytesOf(future), NOW)).toMatchObject({
      ok: false,
      issues: ['future-manifest'],
    });

    for (const value of [
      manifest((candidate) => { candidate.expiresAt = NOW.toISOString(); }),
      manifest((candidate) => { candidate.expiresAt = candidate.generatedAt; }),
      manifest((candidate) => { candidate.expiresAt = '2026-09-03T12:10:00.001Z'; }),
    ]) {
      expect(compileExternalStackEffectPlanV1(bytesOf(value), NOW)).toMatchObject({
        ok: false,
        issues: ['stale-manifest'],
      });
    }
  });

  it('rejects forged manifest digests and binds each exact proposal tuple', () => {
    const value = manifest();
    const originalDigest = value.manifestDigest;
    value.manifestDigest = digest('forged');
    expect(compileExternalStackEffectPlanV1(bytesOf(value), NOW)).toMatchObject({
      ok: false,
      issues: ['manifest-digest-mismatch'],
    });

    const changed = manifest((candidate) => { candidate.targetDigest = digest('another-target'); });
    expect(changed.manifestDigest).not.toBe(originalDigest);
    expect(stackPlannedEffectManifestDigestV1(unsignedManifest())).not.toBe(digest(JSON.stringify(unsignedManifest())));
  });

  it('enforces closed effect class/verb allowlists and class-compatible verbs', () => {
    const invalid: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['class', (value) => { unsafeRecord(value['effect'])['class'] = 'shell'; }],
      ['verb', (value) => { unsafeRecord(value['effect'])['verb'] = 'execute-arbitrary'; }],
      ['pair', (value) => { unsafeRecord(value['effect'])['verb'] = 'delete'; }],
    ];
    for (const [label, mutate] of invalid) {
      const value = manifest() as unknown as Record<string, unknown>;
      mutate(value);
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      ), label).toMatchObject({ ok: false, issues: ['invalid-effect'] });
    }
  });

  it('requires bounded known cost or an exact explicit-unknown representation', () => {
    const unknown = manifest((value) => {
      value.estimatedCost = { known: false, amountMicroUnits: null, currency: null };
    });
    expect(compileExternalStackEffectPlanV1(bytesOf(unknown), NOW).ok).toBe(true);

    const invalid = [
      manifest((value) => { value.estimatedCost = { known: true, amountMicroUnits: -1, currency: 'USD' }; }),
      manifest((value) => {
        value.estimatedCost = { known: true, amountMicroUnits: 1_000_000_000_001, currency: 'USD' };
      }),
      manifest((value) => {
        value.estimatedCost = { known: false, amountMicroUnits: null, currency: null };
        unsafeRecord(value.estimatedCost)['currency'] = 'USD';
      }),
    ];
    for (const value of invalid) {
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      )).toMatchObject({ ok: false, issues: ['invalid-cost'] });
    }
  });

  it('requires a closed rollback class and plan digest exactly when rollback exists', () => {
    const noRollback = manifest((value) => {
      value.rollback = { class: 'not-applicable', planDigest: null };
    });
    expect(compileExternalStackEffectPlanV1(bytesOf(noRollback), NOW).ok).toBe(true);

    const invalid = [
      manifest((value) => { value.rollback = { class: 'automatic', planDigest: null }; }),
      manifest((value) => { value.rollback = { class: 'not-applicable', planDigest: digest('unexpected') }; }),
    ];
    for (const value of invalid) {
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      )).toMatchObject({ ok: false, issues: ['invalid-rollback'] });
    }
  });

  it('rejects non-digest target, precondition, diff, idempotency, observation, and acceptance fields', () => {
    for (const key of [
      'targetDigest',
      'observationManifestDigest',
      'preconditionsDigest',
      'expectedDiffDigest',
      'idempotencyKeyDigest',
      'acceptancePredicateDigest',
    ]) {
      const value = manifest() as unknown as Record<string, unknown>;
      value[key] = 'raw-sensitive-value';
      expect(compileExternalStackEffectPlanV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      ), key).toMatchObject({ ok: false, issues: ['invalid-manifest'] });
    }
  });

  it('has no filesystem, environment, process, provider, network, or execution imports and calls', () => {
    const sourcePath = fileURLToPath(new URL('../src/core/fabric/external-stack-effect-plan.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|tls|child_process|os|worker_threads)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|exec|execFile|spawn|fork)\s*\(/u);
    expect(source).not.toMatch(/\bprocess\s*\./u);
    expect(source).not.toMatch(/\b(?:readFile|readdir|stat|access|open|connect|request)Sync\s*\(/u);
  });
});
