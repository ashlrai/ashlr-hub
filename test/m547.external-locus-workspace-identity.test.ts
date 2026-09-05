import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalLocusWorkspaceIdentityObservationBytesV1,
  compileExternalLocusWorkspaceIdentityObservationV1 as compileWithExpectations,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_BYTES,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_PROTOCOL,
  locusWorkspaceIdentityObservationDigestV1,
  type LocusWorkspaceIdentityObservationV1,
} from '../src/core/fabric/external-locus-workspace-identity.js';

const NOW = new Date('2026-09-03T12:01:00.000Z');
const EXPECTATIONS = Object.freeze({
  audienceDigest: `sha256:${'1'.repeat(64)}`,
  workspaceDigest: `sha256:${'2'.repeat(64)}`,
  sequence: 1,
  previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
});
const PRODUCER_FIXTURE_DIGEST = 'sha256:19e9b04545af50fe6247e7435b644e61b33737cd772bace80d7ed1ecd758f1e1';
const PRODUCER_FIXTURE_HEX = [
  '7b22616461707465724d616e6966657374446967657374223a227368613235363a333333333333333333333333333333',
  '333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333',
  '33222c22617070726f76616c53746f7265223a7b226475616c436f6e74726f6c57616974696e67223a312c2270656e64',
  '696e67223a322c227374617465223a226865616c746879227d2c2261756469656e6365446967657374223a2273686132',
  '35363a313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131',
  '31313131313131313131313131313131313131222c22617574686f72697479223a226f62736572766174696f6e5f6f6e',
  '6c79222c22617574686f72697479416e63686f72223a227665726966696564222c22656666656374417574686f726974',
  '79223a66616c73652c2265666665637473223a7b22617070726f76616c73223a66616c73652c2262756467657473223a',
  '66616c73652c2263726564656e7469616c73223a66616c73652c226465706c6f796d656e7473223a66616c73652c2264',
  '697370617463686573223a66616c73652c2265787465726e616c4d75746174696f6e73223a66616c73652c2266696c65',
  '73223a66616c73652c226c6561726e696e67223a66616c73652c226d6572676573223a66616c73652c2270696e73223a',
  '66616c73652c2270726f706f73616c73223a66616c73652c2270726f766964657273223a66616c73652c227075626c69',
  '636174696f6e73223a66616c73652c2272656c6561736573223a66616c73657d2c22657865637574696f6e417574686f',
  '72697479223a66616c73652c22657870697265734174223a22323032362d30392d30335431323a30353a30302e303030',
  '5a222c226964656e74697479506f7374757265223a227265616479222c226d637052656769737465726564223a7b2263',
  '6c61756465223a747275652c22636f646578223a747275652c22637572736f72223a66616c73652c2267726f6b223a66',
  '616c73657d2c226f62736572766174696f6e446967657374223a227368613235363a3139653962303435343561663530',
  '666536323437653734333562363434653631623333373337636437373262616365383064376564316563643735386631',
  '6531222c226f627365727665644174223a22323032362d30392d30335431323a30303a30302e3030305a222c22706861',
  '6e746f6d417661696c61626c65223a747275652c2270696e506f7374757265223a2276616c6964222c22706c616e6e69',
  '6e67417574686f72697479223a66616c73652c2270726576696f75734f62736572766174696f6e446967657374223a22',
  '7368613235363a3030303030303030303030303030303030303030303030303030303030303030303030303030303030',
  '3030303030303030303030303030303030303030303030222c2270726976616379436c617373223a226d657461646174',
  '615f6f6e6c79222c2270726f6475636572223a7b22636f6d6d6974223a22386336636661653437643862373165363337',
  '36623139623136306465336465653061636334633261222c2270726f64756374223a226c6f637573222c227665727369',
  '6f6e223a22302e352e30227d2c2270726f746f636f6c223a226173686c722d6c6f6375732d776f726b73706163652d69',
  '64656e746974792d6f62736572766174696f6e2d7631222c227265636f726454797065223a226c6f6375732d776f726b',
  '73706163652d6964656e746974792d6f62736572766174696f6e222c22736368656d6156657273696f6e223a312c2273',
  '657175656e6365223a312c22736f757263655374617465223a226c6f63616c5f756e7665726966696564222c22756e72',
  '65736f6c76656443726564656e7469616c73223a302c22776f726b7370616365446967657374223a227368613235363a',
  '323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232',
  '32323232323232323232323232323232222c22776f726b7370616365506f6c696379223a7b2270696e416c6c6f776564',
  '223a747275652c227265717569726550696e223a747275652c227374617465223a2276616c6964227d7d',
].join('');

function fixtureBytes(): Buffer {
  return Buffer.from(PRODUCER_FIXTURE_HEX, 'hex');
}

function cliFixtureBytes(): Buffer {
  const path = fileURLToPath(new URL(
    './fixtures/locus-workspace-identity-observation-v1.cli.hex',
    import.meta.url,
  ));
  return Buffer.from(readFileSync(path, 'ascii').trim(), 'hex');
}

function fixture(): LocusWorkspaceIdentityObservationV1 {
  return JSON.parse(fixtureBytes().toString('utf8')) as LocusWorkspaceIdentityObservationV1;
}

function canonical(value: unknown): Buffer {
  function normalize(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(normalize);
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  }
  return Buffer.from(JSON.stringify(normalize(value)), 'utf8');
}

function compileExternalLocusWorkspaceIdentityObservationV1(
  bytes: Uint8Array,
  now: Date = NOW,
) {
  return compileWithExpectations(bytes, EXPECTATIONS, now);
}

function unsafe(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('M547 external Locus workspace identity observation', () => {
  it('accepts the exact Locus producer fixture as consistency-only observation with no authority', () => {
    const result = compileExternalLocusWorkspaceIdentityObservationV1(fixtureBytes(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation).toMatchObject({
      schemaVersion: 1,
      protocol: 'ashlr-external-locus-workspace-identity-observation-v1',
      recordType: 'external-locus-workspace-identity-observation',
      authority: 'observation-only',
      sourceState: 'local-unverified',
      verification: 'canonical-digest-consistency-only',
      canonicalBytesVerified: true,
      digestVerified: true,
      freshnessVerified: true,
      originAuthenticated: false,
      truthVerified: false,
      releaseProvenanceVerified: false,
      trusted: false,
      sourceObservationDigest: PRODUCER_FIXTURE_DIGEST,
      producer: { product: 'locus', version: '0.5.0', commit: '8c6cfae47d8b71e6376b19b160de3dee0acc4c2a' },
      sequence: 1,
      reportedPosture: {
        identity: 'ready',
        pin: 'valid',
        authorityAnchor: 'verified',
        workspacePolicy: { state: 'valid', requirePin: true, pinAllowed: true },
      },
      approvalStore: { state: 'healthy', pending: 2, dualControlWaiting: 1 },
    });
    expect(result.observation.observationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect({
      planningAuthority: result.observation.planningAuthority,
      executionAuthority: result.observation.executionAuthority,
      effectAuthority: result.observation.effectAuthority,
      proposalAuthority: result.observation.proposalAuthority,
      routingAuthority: result.observation.routingAuthority,
      reservationAuthority: result.observation.reservationAuthority,
      budgetAuthority: result.observation.budgetAuthority,
      credentialAuthority: result.observation.credentialAuthority,
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

  it('matches the producer canonical hex and NUL-terminated digest domain exactly', () => {
    const value = fixture();
    expect(canonicalLocusWorkspaceIdentityObservationBytesV1(value)).toEqual(fixtureBytes());
    expect(value.protocol).toBe(LOCUS_WORKSPACE_IDENTITY_OBSERVATION_PROTOCOL);
    expect(value.observationDigest).toBe(PRODUCER_FIXTURE_DIGEST);
    expect(locusWorkspaceIdentityObservationDigestV1(value)).toBe(PRODUCER_FIXTURE_DIGEST);

    const { observationDigest: _observationDigest, ...unsigned } = value;
    const expected = `sha256:${createHash('sha256')
      .update('ashlr:locus-workspace-identity-observation:v1\0', 'utf8')
      .update(canonical(unsigned))
      .digest('hex')}`;
    expect(expected).toBe(PRODUCER_FIXTURE_DIGEST);
    expect(locusWorkspaceIdentityObservationDigestV1(unsigned)).toBe(expected);
  });

  it('accepts the exact newline-free production CLI projection including null optional metadata', () => {
    const bytes = cliFixtureBytes();
    expect(bytes).toHaveLength(1_523);
    expect(bytes.at(-1)).not.toBe(0x0a);
    const result = compileWithExpectations(bytes, EXPECTATIONS, NOW);
    expect(result).toMatchObject({
      ok: true,
      observation: {
        sourceObservationDigest: 'sha256:d89c1857904f14f9cc097afff3642cd1771f1410ae92464f87c0667dcca1c647',
        adapterManifestDigest: null,
        reportedPosture: {
          identity: 'protected',
          pin: 'absent',
          authorityAnchor: 'unavailable',
          workspacePolicy: { state: 'missing', requirePin: false, pinAllowed: null },
        },
        originAuthenticated: false,
        truthVerified: false,
        trusted: false,
      },
    });
  });

  it('deep-freezes a fresh clone and never freezes or aliases caller-owned bytes', () => {
    const caller = Buffer.from(fixtureBytes());
    const result = compileExternalLocusWorkspaceIdentityObservationV1(caller, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const digest = result.observation.observationDigest;
    caller.fill(0);

    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.producer)).toBe(true);
    expect(Object.isFrozen(result.observation.reportedPosture)).toBe(true);
    expect(Object.isFrozen(result.observation.reportedPosture.workspacePolicy)).toBe(true);
    expect(Object.isFrozen(result.observation.mcpRegistered)).toBe(true);
    expect(Object.isFrozen(result.observation.approvalStore)).toBe(true);
    expect(Object.isFrozen(result.observation.effects)).toBe(true);
    expect(() => { unsafe(result.observation.reportedPosture)['identity'] = 'unsafe'; }).toThrow(TypeError);
    expect(() => { unsafe(result.observation.approvalStore)['pending'] = 0; }).toThrow(TypeError);
    expect(result.observation.observationDigest).toBe(digest);
    expect(result.observation.reportedPosture.identity).toBe('ready');
  });

  it('rejects malformed UTF-8, malformed/reordered/duplicate JSON, excessive bytes, and invalid clocks', () => {
    expect(compileExternalLocusWorkspaceIdentityObservationV1(Buffer.from([0xff, 0xfe]), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-bytes'] });
    expect(compileExternalLocusWorkspaceIdentityObservationV1(Buffer.from('{"', 'utf8'), NOW))
      .toMatchObject({ ok: false, issues: ['non-canonical-json'] });
    expect(compileExternalLocusWorkspaceIdentityObservationV1(
      Buffer.alloc(LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_BYTES + 1), NOW,
    )).toMatchObject({ ok: false, issues: ['oversized-observation'] });
    expect(compileExternalLocusWorkspaceIdentityObservationV1(fixtureBytes(), new Date(Number.NaN)))
      .toMatchObject({ ok: false, issues: ['invalid-bytes'] });

    const value = fixture();
    const { adapterManifestDigest, ...rest } = value;
    const reordered = Buffer.from(JSON.stringify({ ...rest, adapterManifestDigest }), 'utf8');
    expect(reordered.equals(fixtureBytes())).toBe(false);
    expect(compileExternalLocusWorkspaceIdentityObservationV1(reordered, NOW))
      .toMatchObject({ ok: false, issues: ['non-canonical-json'] });
    const fixtureText = fixtureBytes().toString('utf8');
    const duplicate = Buffer.from('{"schemaVersion":1,' + fixtureText.slice(1), 'utf8');
    expect(compileExternalLocusWorkspaceIdentityObservationV1(duplicate, NOW))
      .toMatchObject({ ok: false, issues: ['non-canonical-json'] });
  });

  it('rejects unknown and privacy-bearing fields rather than forwarding identity data', () => {
    const sentinels = [
      ['path', '/Users/operator/private-client'],
      ['sessionId', 'session-private'],
      ['tenant', 'private-tenant'],
      ['bindingAlias', 'client-a'],
      ['credentialRef', 'phm:PRODUCTION_TOKEN'],
      ['secretName', 'PRODUCTION_TOKEN'],
      ['secretValue', 'plaintext-secret'],
      ['command', 'deploy --production'],
      ['audit', { raw: true }],
      ['providerAccount', 'account-private'],
    ] as const;
    for (const [key, privateValue] of sentinels) {
      const value = unsafe(fixture());
      value[key] = privateValue;
      expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(value), NOW), key)
        .toMatchObject({ ok: false, observation: null, issues: ['invalid-observation'] });
    }
    const fixtureText = fixtureBytes().toString('utf8');
    for (const sentinel of ['/Users/', 'sessionId', 'tenant', 'bindingAlias', 'credentialRef', 'secretName',
      'secretValue', 'command', 'audit', 'providerAccount']) {
      expect(fixtureText).not.toContain(sentinel);
    }
  });

  it('pins the audited Locus 0.5.x family and exact contract identity', () => {
    const incompatible = fixture();
    incompatible.producer.version = '0.6.0';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(incompatible), NOW))
      .toMatchObject({ ok: false, issues: ['unsupported-version'] });
    const overlong = fixture();
    overlong.producer.version = `0.5.1+${'a'.repeat(40)}`;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(overlong), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-observation'] });
    const wrongProtocol = fixture() as unknown as Record<string, unknown>;
    wrongProtocol['protocol'] = 'ashlr-locus-workspace-identity-observation-v2';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(wrongProtocol), NOW))
      .toMatchObject({ ok: false, issues: ['unsupported-version'] });
    const wrongProduct = fixture();
    unsafe(wrongProduct.producer)['product'] = 'impostor';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(wrongProduct), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-observation'] });
  });

  it('enforces canonical freshness, future skew, and maximum lifetime', () => {
    const future = fixture();
    future.observedAt = '2026-09-03T12:02:00.001Z';
    future.expiresAt = '2026-09-03T12:05:00.001Z';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(future), NOW))
      .toMatchObject({ ok: false, issues: ['future-observation'] });
    expect(compileExternalLocusWorkspaceIdentityObservationV1(
      fixtureBytes(), new Date('2026-09-03T12:05:00.000Z'),
    )).toMatchObject({ ok: false, issues: ['stale-observation'] });

    const overlong = fixture();
    overlong.expiresAt = '2026-09-03T12:05:00.001Z';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(overlong), NOW))
      .toMatchObject({ ok: false, issues: ['stale-observation'] });
    const inverted = fixture();
    inverted.expiresAt = inverted.observedAt;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(inverted), NOW))
      .toMatchObject({ ok: false, issues: ['stale-observation'] });
  });

  it('validates bounded sequence and genesis/non-genesis lineage shape', () => {
    const zero = fixture();
    zero.sequence = 0;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(zero), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-lineage'] });
    const wrongGenesis = fixture();
    wrongGenesis.sequence = 2;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(wrongGenesis), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-lineage'] });
    const nonGenesisFirst = fixture();
    nonGenesisFirst.previousObservationDigest = `sha256:${'4'.repeat(64)}`;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(nonGenesisFirst), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-lineage'] });
    const excessive = fixture();
    excessive.sequence = Number.MAX_SAFE_INTEGER + 1;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(excessive), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-lineage'] });
    expect(LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST).toBe(`sha256:${'0'.repeat(64)}`);
  });

  it('requires exact caller-owned audience, workspace, sequence, and predecessor bindings', () => {
    expect(compileWithExpectations(fixtureBytes(), {
      ...EXPECTATIONS,
      audienceDigest: `sha256:${'4'.repeat(64)}`,
    }, NOW)).toMatchObject({ ok: false, issues: ['binding-mismatch'] });
    expect(compileWithExpectations(fixtureBytes(), {
      ...EXPECTATIONS,
      workspaceDigest: `sha256:${'5'.repeat(64)}`,
    }, NOW)).toMatchObject({ ok: false, issues: ['binding-mismatch'] });
    expect(compileWithExpectations(fixtureBytes(), {
      ...EXPECTATIONS,
      sequence: 2,
      previousObservationDigest: `sha256:${'6'.repeat(64)}`,
    }, NOW)).toMatchObject({ ok: false, issues: ['lineage-mismatch'] });
  });

  it('rejects impossible workspace, approval, posture, and authority/effect combinations', () => {
    const policy = fixture();
    policy.workspacePolicy.state = 'missing';
    policy.workspacePolicy.pinAllowed = true;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(policy), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-workspace-policy'] });
    const approvals = fixture();
    approvals.approvalStore.pending = 0;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(approvals), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-approval-store'] });
    const readyWithoutPin = fixture();
    readyWithoutPin.pinPosture = 'absent';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(readyWithoutPin), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-posture'] });
    const readyWithoutMcp = fixture();
    readyWithoutMcp.mcpRegistered = { claude: false, cursor: false, codex: false, grok: false };
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(readyWithoutMcp), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-posture'] });
    const invalidWorkspace = fixture();
    invalidWorkspace.workspacePolicy = { state: 'invalid', requirePin: true, pinAllowed: null };
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(invalidWorkspace), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-workspace-policy'] });
    const validPinWithoutAnchor = fixture();
    validPinWithoutAnchor.authorityAnchor = 'unavailable';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(validPinWithoutAnchor), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-posture'] });
    const unavailableApprovalWithPending = fixture();
    unavailableApprovalWithPending.approvalStore = {
      state: 'unavailable', pending: 1, dualControlWaiting: 0,
    };
    expect(compileExternalLocusWorkspaceIdentityObservationV1(
      canonical(unavailableApprovalWithPending), NOW,
    )).toMatchObject({ ok: false, issues: ['invalid-approval-store'] });
    const authority = fixture();
    unsafe(authority)['effectAuthority'] = true;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(authority), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-observation'] });
    const effect = fixture();
    unsafe(effect.effects)['providers'] = true;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(effect), NOW))
      .toMatchObject({ ok: false, issues: ['invalid-observation'] });
  });

  it('rejects digest forgery and keeps consistency distinct from origin and truth', () => {
    const forged = fixture();
    forged.identityPosture = 'protected';
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(forged), NOW))
      .toMatchObject({ ok: false, observation: null, issues: ['observation-digest-mismatch'] });
    forged.observationDigest = `sha256:${'9'.repeat(64)}`;
    expect(compileExternalLocusWorkspaceIdentityObservationV1(canonical(forged), NOW))
      .toMatchObject({ ok: false, observation: null, issues: ['observation-digest-mismatch'] });

    const accepted = compileExternalLocusWorkspaceIdentityObservationV1(fixtureBytes(), NOW);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.observation.reportedPosture.authorityAnchor).toBe('verified');
    expect(accepted.observation.originAuthenticated).toBe(false);
    expect(accepted.observation.truthVerified).toBe(false);
    expect(accepted.observation.releaseProvenanceVerified).toBe(false);
    expect(accepted.observation.trusted).toBe(false);
  });

  it('has no machine-discovery, filesystem, process, provider, or network imports and calls', () => {
    const sourcePath = fileURLToPath(new URL('../src/core/fabric/external-locus-workspace-identity.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|tls|child_process|os|worker_threads)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|exec|execFile|spawn|fork)\s*\(/u);
    expect(source).not.toMatch(/\bprocess\s*\./u);
    expect(source).not.toMatch(/\b(?:readFile|readdir|stat|access|open|connect|request)Sync\s*\(/u);
  });
});
