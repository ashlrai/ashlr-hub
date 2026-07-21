import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/core/config.js';
import { parseRemoteCasAuthorityConfig } from '../src/core/inbox/remote-cas-authority.js';

describe('M438 remote CAS authority configuration', () => {
  it('defaults absent configuration to an inert off state', () => {
    expect(parseRemoteCasAuthorityConfig(undefined)).toEqual({ state: 'off', config: { mode: 'off' } });
    expect(parseRemoteCasAuthorityConfig(defaultConfig().fleet?.remoteCasAuthority))
      .toEqual({ state: 'off', config: { mode: 'off' } });
  });

  it('accepts a bounded HTTPS observation configuration without probing it', () => {
    expect(parseRemoteCasAuthorityConfig({
      mode: 'probe', provider: 'ashlr-authority', endpoint: 'https://authority.ashlr.ai/',
      audience: 'ashlr-operational-projection', authorityId: 'authority-prod-1',
    })).toEqual({
      state: 'probe',
      config: {
        mode: 'probe', provider: 'ashlr-authority', endpoint: 'https://authority.ashlr.ai/',
        audience: 'ashlr-operational-projection', authorityId: 'authority-prod-1',
      },
    });
  });

  it.each([
    { mode: 'off', extra: true },
    { mode: 'probe', provider: 'x', endpoint: 'http://authority.ashlr.ai/', audience: 'a', authorityId: 'id' },
    { mode: 'probe', provider: 'x', endpoint: 'https://user:secret@authority.ashlr.ai/', audience: 'a', authorityId: 'id' },
    { mode: 'probe', provider: 'x', endpoint: 'https://127.0.0.1/', audience: 'a', authorityId: 'id' },
    { mode: 'probe', provider: 'x', endpoint: 'https://[::1]/', audience: 'a', authorityId: 'id' },
    { mode: 'probe', provider: 'x', endpoint: 'https://authority.ashlr.ai/path', audience: 'a', authorityId: 'id' },
    { mode: 'probe', provider: 'x', endpoint: 'https://authority.ashlr.ai/', audience: ' a', authorityId: 'id' },
    { mode: 'unknown' },
  ])('refuses malformed or unsafe configuration without echoing it', (value) => {
    const result = parseRemoteCasAuthorityConfig(value);
    expect(result.state).toBe('invalid-config');
    if (result.state === 'invalid-config') expect(result.reason).not.toContain('secret');
  });
});
