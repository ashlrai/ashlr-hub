import { describe, expect, it } from 'vitest';
import { ReadSessionRevocations } from '../src/core/web/read-session-revocations.js';

describe('dashboard read-session revocations', () => {
  it('revokes one exact session until expiry without affecting a rival', () => {
    const revocations = new ReadSessionRevocations(2);
    const now = 1_000;
    revocations.revoke({ id: 'logged-out', expiresAt: 2_000 }, now);

    expect(revocations.isRevoked('logged-out', now)).toBe(true);
    expect(revocations.isRevoked('rival', now)).toBe(false);
    expect(revocations.isRevoked('logged-out', 2_000)).toBe(false);
  });

  it('requires signing-key rotation on capacity instead of evicting a live revocation', () => {
    const revocations = new ReadSessionRevocations(2);
    const now = 10_000;
    revocations.revoke({ id: 'first', expiresAt: 11_000 }, now);
    revocations.revoke({ id: 'second', expiresAt: 12_000 }, now);
    const result = revocations.revoke({ id: 'overflow', expiresAt: 13_000 }, now);

    expect(result).toEqual({ rotateSigningKey: true });
    // The registry never silently preserves only a subset. Its owner must
    // rotate the signer and drain every existing stream before logout returns.
    expect(revocations.isRevoked('first', now)).toBe(true);
    expect(revocations.isRevoked('unseen-ticket', now)).toBe(false);
  });
});
