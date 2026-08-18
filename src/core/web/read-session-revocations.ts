/**
 * Bounded, process-local revocation state for signed dashboard read sessions.
 *
 * Tickets are otherwise self-contained, so deleting the browser cookie alone
 * would not revoke a copied ticket. This registry remembers the exact ticket
 * digest until its signed expiry. If the bounded registry saturates, it tells
 * the owning server to rotate the independent ticket-signing key and drain
 * every stream. That invalidates all old tickets without evicting a still-live
 * revocation and still permits a fresh ticket exchange afterward.
 */

export interface RevocableReadSession {
  id: string;
  expiresAt: number;
}

export interface ReadSessionRevocationResult {
  rotateSigningKey: boolean;
}

export class ReadSessionRevocations {
  private readonly revoked = new Map<string, number>();

  constructor(private readonly maxEntries = 1_024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('read session revocation capacity must be a positive integer');
    }
  }

  private prune(nowMs: number): void {
    for (const [id, expiresAt] of this.revoked) {
      if (expiresAt <= nowMs) this.revoked.delete(id);
    }
  }

  isRevoked(id: string, nowMs = Date.now()): boolean {
    this.prune(nowMs);
    return (this.revoked.get(id) ?? 0) > nowMs;
  }

  revoke(session: RevocableReadSession, nowMs = Date.now()): ReadSessionRevocationResult {
    this.prune(nowMs);
    if (session.expiresAt <= nowMs) {
      return { rotateSigningKey: false };
    }

    const priorExpiry = this.revoked.get(session.id);
    if (priorExpiry !== undefined || this.revoked.size < this.maxEntries) {
      this.revoked.set(session.id, Math.max(priorExpiry ?? 0, session.expiresAt));
      return { rotateSigningKey: false };
    }

    // Never evict a live revocation. The caller must synchronously rotate the
    // ticket-signing key and drain all streams before returning logout success.
    return { rotateSigningKey: true };
  }

  clear(): void {
    this.revoked.clear();
  }
}
