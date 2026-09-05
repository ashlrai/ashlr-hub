import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compileAgentOsCommissioningPreflightV1,
  uncommissionedAgentOsPreflightV1,
  type AgentOsCommissioningPreflightInputV1,
} from '../src/core/vision/agent-os-commissioning-preflight.js';

const NOW = Date.parse('2026-09-03T18:00:30.000Z');
const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

function input(): AgentOsCommissioningPreflightInputV1 {
  return {
    schemaVersion: 1,
    observedAt: '2026-09-03T18:00:00.000Z',
    expiresAt: '2026-09-03T18:01:00.000Z',
    observerConfigured: 'disabled',
    daemonState: 'stopped-observed',
    observerChildState: 'absent-observed',
    legacyWriterState: 'absent-observed',
    legacyLockState: 'absent-observed',
    activeAttempts: { state: 'zero', authenticated: true },
    legacyRoots: { state: 'absent', stableRead: true, mutatedAfterBaseline: false },
    targetNamespace: 'absent',
    installedBinaryDigest: SHA_B,
    writerProtocolDigest: SHA_B,
    expectedWriterProtocolDigest: SHA_B,
    anchorState: 'configured-unverified',
    anchorHeadState: 'missing-observed',
    anchorPolicyDigest: SHA_A,
  };
}

describe('M551 Agent OS commissioning preflight', () => {
  it('emits only a short-lived local review candidate with every authority false', () => {
    const result = compileAgentOsCommissioningPreflightV1(input(), NOW);
    expect(result).toMatchObject({
      state: 'locally-quiescent-unverified', readyForExplicitCommissioningReview: true,
      stoppedRuntimeVerified: false, anchorCommissioned: false, commissioningAuthority: false,
      factsAuthenticated: false, evidenceAuthenticated: false,
      writeAuthority: false, activationAuthority: false, effectAuthority: false,
      policyAuthority: false, routingAuthority: false, reservationAuthority: false,
      verificationAuthority: false, learningAuthority: false, releaseAuthority: false,
      policyEligible: false, learningEligible: false, promotionEligible: false,
      rollbackProtected: false, sameUserTamperResistant: false, stopReasons: [],
    });
    expect(result.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.stopReasons)).toBe(true);
  });

  it('is deterministic and binds every accepted observation field', () => {
    const original = compileAgentOsCommissioningPreflightV1(input(), NOW);
    expect(compileAgentOsCommissioningPreflightV1(input(), NOW)).toEqual(original);
    const changed = input();
    changed.installedBinaryDigest = `sha256:${'c'.repeat(64)}`;
    expect(compileAgentOsCommissioningPreflightV1(changed, NOW).evidenceDigest)
      .not.toBe(original.evidenceDigest);
  });

  it.each([
    ['observerConfigured', 'enabled', 'observer-enabled'],
    ['daemonState', 'running', 'daemon-running'],
    ['observerChildState', 'present', 'observer-child-present'],
    ['legacyWriterState', 'present', 'legacy-writer-present'],
    ['legacyLockState', 'present', 'legacy-lock-present'],
    ['targetNamespace', 'present-empty', 'target-namespace-present'],
    ['anchorState', 'uncommissioned', 'anchor-uncommissioned'],
    ['anchorHeadState', 'present-unexpected', 'anchor-head-present'],
  ] as const)('blocks %s=%s', (field, value, reason) => {
    const candidate = input() as unknown as Record<string, unknown>;
    candidate[field] = value;
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW)).toMatchObject({
      state: 'blocked', readyForExplicitCommissioningReview: false,
      evidenceDigest: null, observedAt: null, expiresAt: null,
      stopReasons: expect.arrayContaining([reason]),
    });
  });

  it('requires a complete authenticated zero-attempt observation', () => {
    const candidate = input();
    candidate.activeAttempts = { state: 'nonzero', authenticated: false };
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).stopReasons).toEqual([
      'active-attempts-present', 'active-attempts-unauthenticated',
    ]);
  });

  it('treats missing or unstable legacy evidence as unknown, never proof of absence', () => {
    const candidate = input();
    candidate.legacyRoots = { state: 'unknown', stableRead: false, mutatedAfterBaseline: null };
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).stopReasons).toEqual([
      'legacy-roots-unknown', 'legacy-roots-unstable', 'legacy-mutation-unknown',
    ]);
  });

  it('detects post-baseline legacy activity independently', () => {
    const candidate = input();
    candidate.legacyRoots.mutatedAfterBaseline = true;
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).stopReasons)
      .toContain('legacy-mutation-detected');
  });

  it('requires exact binary/protocol/policy digest syntax and protocol equality', () => {
    const candidate = input();
    candidate.installedBinaryDigest = 'bad';
    candidate.expectedWriterProtocolDigest = SHA_A;
    candidate.anchorPolicyDigest = null;
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).stopReasons).toEqual([
      'binary-digest-invalid', 'writer-protocol-digest-mismatch', 'anchor-policy-invalid',
    ]);
  });

  it('binds the exact installed binary to the expected writer protocol', () => {
    for (const field of [
      'installedBinaryDigest', 'writerProtocolDigest', 'expectedWriterProtocolDigest',
    ] as const) {
      const candidate = input();
      candidate[field] = SHA_A;
      expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).state).toBe('blocked');
    }
    const candidate = input();
    candidate.installedBinaryDigest = SHA_A;
    expect(compileAgentOsCommissioningPreflightV1(candidate, NOW).stopReasons)
      .toContain('installed-writer-digest-mismatch');
  });

  it('distinguishes an existing or unreadable anchor head from fresh commissioning', () => {
    const existing = input();
    existing.anchorState = 'commissioned-observed';
    existing.anchorHeadState = 'present-unexpected';
    expect(compileAgentOsCommissioningPreflightV1(existing, NOW).stopReasons).toEqual([
      'anchor-already-commissioned', 'anchor-head-present',
    ]);
    const unavailable = input();
    unavailable.anchorHeadState = 'unavailable';
    expect(compileAgentOsCommissioningPreflightV1(unavailable, NOW).stopReasons)
      .toEqual(['anchor-head-unavailable']);
  });

  it('rejects expired, overlong, and future observations', () => {
    const expired = input();
    expired.expiresAt = '2026-09-03T18:00:30.000Z';
    expect(compileAgentOsCommissioningPreflightV1(expired, NOW).stopReasons)
      .toContain('observation-expired');
    const future = input();
    future.observedAt = '2026-09-03T18:00:36.000Z';
    future.expiresAt = '2026-09-03T18:01:00.000Z';
    expect(compileAgentOsCommissioningPreflightV1(future, NOW).stopReasons)
      .toContain('observation-future');
  });

  it('rejects unknown fields, accessors, prototypes, cycles, and malformed clocks', () => {
    expect(compileAgentOsCommissioningPreflightV1({ ...input(), extra: true }, NOW).stopReasons)
      .toEqual(['invalid-input']);
    const accessor = input() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'daemonState', { enumerable: true, get: () => 'stopped-observed' });
    expect(compileAgentOsCommissioningPreflightV1(accessor, NOW).stopReasons).toEqual(['invalid-input']);
    expect(compileAgentOsCommissioningPreflightV1(Object.assign(Object.create({}), input()), NOW).stopReasons)
      .toEqual(['invalid-input']);
    const malformed = input();
    malformed.observedAt = 'not-a-time';
    expect(compileAgentOsCommissioningPreflightV1(malformed, NOW).stopReasons).toEqual(['invalid-input']);
  });

  it('defaults to uncommissioned without reading or creating any state', () => {
    expect(uncommissionedAgentOsPreflightV1()).toMatchObject({
      state: 'blocked', stopReasons: ['anchor-uncommissioned'],
      commissioningAuthority: false, activationAuthority: false,
    });
  });

  it('has no import edge into daemon writers, key provisioning, policy mutation, or effects', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL(
      '../src/core/vision/agent-os-commissioning-preflight.ts', import.meta.url,
    ), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:daemon\/loop|observer-child|snapshot-store|attempt-store|source-bundle-store|provenance|effect|policy).*['"]/u);
    expect(source).not.toMatch(/(?:mkdir|writeFile|appendFile|rename|unlink|spawn|fetch)\s*\(/u);
  });

  it('has no reverse import edge from runtime, policy, learning, promotion, or effect code', () => {
    const root = join(process.cwd(), 'src');
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory()
        ? walk(join(directory, entry.name))
        : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
    const consumers = walk(root).filter((path) =>
      !path.endsWith('agent-os-commissioning-preflight.ts') &&
      readFileSync(path, 'utf8').includes('agent-os-commissioning-preflight'));
    expect(consumers).toEqual([]);
  });
});
