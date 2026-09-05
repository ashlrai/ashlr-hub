import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalStackObservationManifestBytesV1,
  compileExternalStackObservationV1,
  STACK_OBSERVATION_MANIFEST_PROTOCOL,
  STACK_OBSERVATION_MAX_BYTES,
  stackObservationManifestDigestV1,
  type StackObservationManifestV1,
} from '../src/core/fabric/external-stack-observation.js';

const GENERATED_AT = '2026-09-03T12:00:00.000Z';
const EXPIRES_AT = '2026-09-03T12:05:00.000Z';
const NOW = new Date('2026-09-03T12:01:00.000Z');

function digest(label: string): string {
  return `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function unsignedManifest(): Omit<StackObservationManifestV1, 'manifestDigest'> {
  return {
    schemaVersion: 1,
    protocol: STACK_OBSERVATION_MANIFEST_PROTOCOL,
    source: {
      product: 'stack',
      version: '0.2.0',
      commit: createHash('sha256').update('stack-commit', 'utf8').digest('hex'),
    },
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    topology: {
      componentCount: 5,
      connectionCount: 4,
      components: [
        { kind: 'control-plane', count: 1 },
        { kind: 'local-runtime', count: 2 },
        { kind: 'secret-broker', count: 1 },
        { kind: 'tool-gateway', count: 1 },
      ],
      connections: [
        { from: 'control-plane', to: 'local-runtime', count: 2 },
        { from: 'local-runtime', to: 'secret-broker', count: 1 },
        { from: 'local-runtime', to: 'tool-gateway', count: 1 },
      ],
    },
    resources: {
      resourceCount: 11,
      classes: [
        { kind: 'compute', classDigest: digest('arm64-local'), state: 'available', count: 2 },
        { kind: 'model', classDigest: digest('local-model'), state: 'constrained', count: 3 },
        { kind: 'tool', classDigest: digest('analysis-tool'), state: 'available', count: 4 },
        { kind: 'workspace', classDigest: digest('workspace'), state: 'unknown', count: 2 },
      ],
    },
    phantom: {
      installed: true,
      version: '1.9.0',
      vaultStatus: 'locked',
      keyPresenceCount: 2,
    },
  };
}

function manifest(
  mutate?: (value: Omit<StackObservationManifestV1, 'manifestDigest'>) => void,
): StackObservationManifestV1 {
  const unsigned = unsignedManifest();
  mutate?.(unsigned);
  const manifestDigest = stackObservationManifestDigestV1(unsigned);
  if (!manifestDigest) throw new Error('expected manifest digest');
  return { ...unsigned, manifestDigest };
}

function bytesOf(value: StackObservationManifestV1): Buffer {
  const bytes = canonicalStackObservationManifestBytesV1(value);
  if (!bytes) throw new Error('expected canonical manifest bytes');
  return bytes;
}

function unsafeRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('M541 external Stack observation protocol', () => {
  it('compiles canonical aggregate observations without granting any authority or effect', () => {
    const result = compileExternalStackObservationV1(bytesOf(manifest()), NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation).toMatchObject({
      schemaVersion: 1,
      protocol: 'ashlr-stack-observation-v1',
      recordType: 'external-stack-observation',
      authority: 'observation-only',
      verification: 'local-unverified',
      authenticated: false,
      trusted: false,
      topology: { componentCount: 5, connectionCount: 4, componentKinds: 4 },
      resources: {
        resourceCount: 11,
        classCount: 4,
        available: 6,
        constrained: 3,
        unavailable: 0,
        unknown: 2,
      },
      phantom: {
        installed: true,
        version: '1.9.0',
        vaultStatus: 'locked',
        keyPresenceCount: 2,
      },
    });
    expect(result.observation.observationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect({
      planningAuthority: result.observation.planningAuthority,
      effectAuthority: result.observation.effectAuthority,
      executionAuthority: result.observation.executionAuthority,
      proposalAuthority: result.observation.proposalAuthority,
      routingAuthority: result.observation.routingAuthority,
      reservationAuthority: result.observation.reservationAuthority,
      budgetAuthority: result.observation.budgetAuthority,
      learningAuthority: result.observation.learningAuthority,
      policyAuthority: result.observation.policyAuthority,
      promotionAuthority: result.observation.promotionAuthority,
      verificationAuthority: result.observation.verificationAuthority,
      mergeAuthority: result.observation.mergeAuthority,
      releaseAuthority: result.observation.releaseAuthority,
      deployAuthority: result.observation.deployAuthority,
      publicationAuthority: result.observation.publicationAuthority,
      externalMutationAuthority: result.observation.externalMutationAuthority,
      policyEligible: result.observation.policyEligible,
      promotionEligible: result.observation.promotionEligible,
      ...result.observation.effects,
    }).toSatisfy((flags: Record<string, boolean>) => Object.values(flags).every((flag) => flag === false));
  });

  it('deep-freezes the cloned digest-bound observation without freezing caller-owned manifests', () => {
    const callerOwned = manifest();
    const result = compileExternalStackObservationV1(bytesOf(callerOwned), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observationDigest = result.observation.observationDigest;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.source)).toBe(true);
    expect(Object.isFrozen(result.observation.topology)).toBe(true);
    expect(Object.isFrozen(result.observation.resources)).toBe(true);
    expect(Object.isFrozen(result.observation.phantom)).toBe(true);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    expect(() => { unsafeRecord(result.observation.source)['version'] = '9.9.9'; }).toThrow(TypeError);
    expect(() => { unsafeRecord(result.observation.resources)['resourceCount'] = 999; }).toThrow(TypeError);
    expect(result.observation.source.version).toBe('0.2.0');
    expect(result.observation.resources.resourceCount).toBe(11);
    expect(result.observation.observationDigest).toBe(observationDigest);
  });

  it('accepts one deterministic encoding and rejects reordered or duplicate JSON keys', () => {
    const value = manifest();
    const canonical = bytesOf(value);
    expect(compileExternalStackObservationV1(canonical, NOW).ok).toBe(true);

    const reordered = Buffer.from(JSON.stringify(value), 'utf8');
    expect(reordered.equals(canonical)).toBe(false);
    expect(compileExternalStackObservationV1(reordered, NOW)).toMatchObject({
      ok: false,
      issues: ['non-canonical-json'],
    });

    const text = canonical.toString('utf8');
    const duplicate = Buffer.from(text.replace('{', '{"schemaVersion":1,'), 'utf8');
    expect(compileExternalStackObservationV1(duplicate, NOW)).toMatchObject({
      ok: false,
      issues: ['non-canonical-json'],
    });
  });

  it('rejects exact-shape violations and privacy-bearing fields instead of forwarding them', () => {
    const cases: Array<[string, (value: Record<string, unknown>) => void, string]> = [
      ['freeform metadata', (value) => { value['metadata'] = { note: 'caller assertion' }; }, 'invalid-manifest'],
      ['provider resource id', (value) => {
        const resources = unsafeRecord(value['resources']);
        const classes = resources['classes'] as Array<Record<string, unknown>>;
        classes[0]!['providerResourceId'] = 'provider/account/resource-123';
      }, 'invalid-resources'],
      ['quota details', (value) => {
        const resources = unsafeRecord(value['resources']);
        const classes = resources['classes'] as Array<Record<string, unknown>>;
        classes[0]!['quota'] = { remaining: 99 };
      }, 'invalid-resources'],
      ['provider scopes', (value) => {
        const resources = unsafeRecord(value['resources']);
        const classes = resources['classes'] as Array<Record<string, unknown>>;
        classes[0]!['scopes'] = ['admin'];
      }, 'invalid-resources'],
      ['secret name', (value) => { unsafeRecord(value['phantom'])['secretName'] = 'PRODUCTION_TOKEN'; },
        'invalid-phantom-metadata'],
      ['secret value', (value) => { unsafeRecord(value['phantom'])['secretValue'] = 'plaintext'; },
        'invalid-phantom-metadata'],
      ['bare key-presence digests', (value) => {
        unsafeRecord(value['phantom'])['keyPresenceDigests'] = [digest('guessable-key-name')];
      }, 'invalid-phantom-metadata'],
      ['filesystem path', (value) => { unsafeRecord(value['phantom'])['path'] = '/Users/example/.phantom'; },
        'invalid-phantom-metadata'],
    ];

    for (const [label, mutate, issue] of cases) {
      const value = manifest() as unknown as Record<string, unknown>;
      mutate(value);
      const result = compileExternalStackObservationV1(Buffer.from(JSON.stringify(value), 'utf8'), NOW);
      expect(result, label).toMatchObject({ ok: false, observation: null, issues: [issue] });
    }
  });

  it('accepts only the audited Stack 0.2.x producer family', () => {
    for (const version of ['0.3.0', '1.0.0']) {
      const incompatible = manifest((value) => { value.source.version = version; });
      expect(compileExternalStackObservationV1(
        Buffer.from(JSON.stringify(incompatible), 'utf8'),
        NOW,
      ), version).toMatchObject({ ok: false, issues: ['unsupported-version'] });
    }

    const compatible = manifest((value) => { value.source.version = '0.2.17'; });
    expect(compileExternalStackObservationV1(bytesOf(compatible), NOW).ok).toBe(true);
  });

  it('rejects malformed UTF-8, malformed JSON, excessive bytes, and unsupported versions', () => {
    expect(compileExternalStackObservationV1(Buffer.from([0xff, 0xfe]), NOW)).toMatchObject({
      ok: false,
      issues: ['invalid-bytes'],
    });
    expect(compileExternalStackObservationV1(Buffer.from('{"', 'utf8'), NOW)).toMatchObject({
      ok: false,
      issues: ['non-canonical-json'],
    });
    expect(compileExternalStackObservationV1(Buffer.alloc(STACK_OBSERVATION_MAX_BYTES + 1), NOW)).toMatchObject({
      ok: false,
      issues: ['oversized-manifest'],
    });
    const unsupported = manifest() as unknown as Record<string, unknown>;
    unsupported['schemaVersion'] = 2;
    expect(compileExternalStackObservationV1(Buffer.from(JSON.stringify(unsupported), 'utf8'), NOW)).toMatchObject({
      ok: false,
      issues: ['unsupported-version'],
    });
  });

  it('rejects future, expired, inverted, and overlong observation windows', () => {
    const future = manifest((value) => {
      value.generatedAt = '2026-09-03T12:02:01.000Z';
      value.expiresAt = '2026-09-03T12:07:01.000Z';
    });
    expect(compileExternalStackObservationV1(bytesOf(future), NOW)).toMatchObject({
      ok: false,
      issues: ['future-manifest'],
    });

    const expired = manifest((value) => { value.expiresAt = NOW.toISOString(); });
    expect(compileExternalStackObservationV1(bytesOf(expired), NOW)).toMatchObject({
      ok: false,
      issues: ['stale-manifest'],
    });

    const inverted = manifest((value) => { value.expiresAt = value.generatedAt; });
    expect(compileExternalStackObservationV1(bytesOf(inverted), NOW)).toMatchObject({
      ok: false,
      issues: ['stale-manifest'],
    });

    const overlong = manifest((value) => { value.expiresAt = '2026-09-03T12:10:00.001Z'; });
    expect(compileExternalStackObservationV1(bytesOf(overlong), NOW)).toMatchObject({
      ok: false,
      issues: ['stale-manifest'],
    });
  });

  it('rejects a forged digest while preserving domain-separated deterministic digests', () => {
    const value = manifest();
    value.manifestDigest = digest('forged');
    expect(compileExternalStackObservationV1(bytesOf(value), NOW)).toMatchObject({
      ok: false,
      issues: ['manifest-digest-mismatch'],
    });

    const first = stackObservationManifestDigestV1(unsignedManifest());
    const second = stackObservationManifestDigestV1(unsignedManifest());
    expect(first).toBe(second);
    expect(first).not.toBe(digest(JSON.stringify(unsignedManifest())));
  });

  it('enforces unique sorted topology entries, valid endpoints, edge bounds, and exact totals', () => {
    const invalid: StackObservationManifestV1[] = [
      manifest((value) => { value.topology.components[1] = { ...value.topology.components[0]! }; }),
      manifest((value) => { value.topology.connections[1] = { ...value.topology.connections[0]! }; }),
      manifest((value) => { value.topology.connections[0]!.to = 'reasoning-plane'; }),
      manifest((value) => { value.topology.connections[0]!.count = 3; }),
      manifest((value) => { value.topology.componentCount += 1; }),
      manifest((value) => { value.topology.connectionCount += 1; }),
    ];
    for (const value of invalid) {
      expect(compileExternalStackObservationV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      )).toMatchObject({ ok: false, issues: ['invalid-topology'] });
    }
  });

  it('enforces unique sorted resource classes, exact totals, and Phantom state invariants', () => {
    const invalidResources = [
      manifest((value) => { value.resources.classes[1] = { ...value.resources.classes[0]! }; }),
      manifest((value) => { value.resources.resourceCount += 1; }),
    ];
    for (const value of invalidResources) {
      expect(compileExternalStackObservationV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      )).toMatchObject({ ok: false, issues: ['invalid-resources'] });
    }

    const excessiveKeyCount = manifest((value) => {
      if (value.phantom) value.phantom.keyPresenceCount = 1_000_001;
    });
    const absentWithDetails = manifest((value) => {
      value.phantom = {
        installed: false,
        version: '1.0.0',
        vaultStatus: 'locked',
        keyPresenceCount: 1,
      };
    });
    for (const value of [excessiveKeyCount, absentWithDetails]) {
      expect(compileExternalStackObservationV1(
        Buffer.from(JSON.stringify(value), 'utf8'),
        NOW,
      )).toMatchObject({ ok: false, issues: ['invalid-phantom-metadata'] });
    }
  });

  it('has no machine-discovery, filesystem, process, provider, or network imports and calls', () => {
    const sourcePath = fileURLToPath(new URL('../src/core/fabric/external-stack-observation.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|tls|child_process|os|worker_threads)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|exec|execFile|spawn|fork)\s*\(/u);
    expect(source).not.toMatch(/\bprocess\s*\./u);
    expect(source).not.toMatch(/\b(?:readFile|readdir|stat|access|open|connect|request)Sync\s*\(/u);
  });
});
