import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQuerySnapshot, runQuery, evictAll } from './cache.js';
import {
  clearReadSession,
  getMutationToken,
  markCheckComplete,
  reportSessionExpired,
  setMutationToken,
} from './auth-store.js';

describe('auth-store protected-state eviction', () => {
  beforeEach(() => {
    evictAll();
    markCheckComplete(true);
    setMutationToken('a'.repeat(64));
  });

  it('evicts protected cache data and the mutation hold on session expiry', async () => {
    await runQuery('protected', async () => ({ secret: true }));
    expect(getQuerySnapshot('protected').data).toEqual({ secret: true });
    reportSessionExpired();
    expect(getQuerySnapshot('protected').data).toBeUndefined();
    expect(getMutationToken()).toBeNull();
  });

  it('evicts protected cache data and the mutation hold on explicit logout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await runQuery('protected', async () => ({ secret: true }));
    await clearReadSession();
    expect(getQuerySnapshot('protected').data).toBeUndefined();
    expect(getMutationToken()).toBeNull();
  });
});
