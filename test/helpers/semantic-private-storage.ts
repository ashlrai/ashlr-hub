import type {
  PrivateStorageInvocation,
  PrivateStorageRunner,
} from '../../src/core/util/private-storage.js';

/**
 * Exercise the authenticated private-storage adapter protocol without starting
 * PowerShell. Callers still use the production parser and retry classifier.
 */
export const semanticPrivateStorageRunner: PrivateStorageRunner = (
  invocation: PrivateStorageInvocation,
) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};
