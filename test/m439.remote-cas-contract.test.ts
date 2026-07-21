import { describe, expect, it } from 'vitest';

import {
  canonicalRemoteCasRequest,
  parseRemoteCasRequest,
  remoteCasRequestDigest,
  type RemoteCasRequestV1,
} from '../src/core/inbox/remote-cas-contract.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function request(): RemoteCasRequestV1 {
  return {
    schemaVersion: 1,
    requestId: 'request-439',
    authorityId: 'authority-prod-1',
    audience: 'ashlr-operational-projection',
    repositoryId: 'ashlrai/ashlr-hub',
    expectedEpoch: '0',
    action: 'would-write-proposal',
    requestedAt: '2026-07-21T00:00:00.000Z',
    binding: {
      schemaVersion: 1,
      transactionId: DIGEST,
      transactionAttestation: OTHER_DIGEST,
      proposalId: 'proposal-439',
      phase: 'prepared',
      before: { proposal: null, projection: null },
      after: { proposal: DIGEST, projection: OTHER_DIGEST },
      staged: {
        proposal: { present: true, digest: DIGEST, bytes: 12 },
        projection: { present: true, digest: OTHER_DIGEST, bytes: 34 },
      },
    },
  };
}

describe('M439 remote CAS request contract', () => {
  it('accepts a metadata-only V2 request and has a stable canonical digest', () => {
    const input = request();
    const parsed = parseRemoteCasRequest(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual({ state: 'valid', request: input });
    expect(canonicalRemoteCasRequest(input)).toContain('"transactionId"');
    expect(remoteCasRequestDigest(input)).toBe(remoteCasRequestDigest(parsed.state === 'valid' ? parsed.request : input));
  });

  it('normalizes object property order through parsing and canonical serialization', () => {
    const input = request();
    const reordered = {
      requestedAt: input.requestedAt, schemaVersion: 1, binding: input.binding, action: input.action,
      expectedEpoch: input.expectedEpoch, repositoryId: input.repositoryId, audience: input.audience,
      authorityId: input.authorityId, requestId: input.requestId,
    };
    const parsed = parseRemoteCasRequest(reordered);
    expect(parsed.state).toBe('valid');
    if (parsed.state === 'valid') expect(remoteCasRequestDigest(parsed.request)).toBe(remoteCasRequestDigest(input));
  });

  it.each([
    (value: RemoteCasRequestV1) => ({ ...value, expectedEpoch: '01' }),
    (value: RemoteCasRequestV1) => ({ ...value, requestedAt: '2026-07-21T00:00:00Z' }),
    (value: RemoteCasRequestV1) => ({ ...value, action: 'would-write-projection' }),
    (value: RemoteCasRequestV1) => ({ ...value, binding: { ...value.binding, staged: { ...value.binding.staged, proposal: { present: false, digest: null, bytes: 0 } } } }),
    (value: RemoteCasRequestV1) => ({ ...value, extra: true }),
  ])('fails closed for malformed epochs, timestamps, phase actions, and binding metadata', (mutate) => {
    expect(parseRemoteCasRequest(mutate(request())).state).toBe('invalid');
  });
});
