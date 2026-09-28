import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier, parseRemoteAccessConfig, verifyRemoteAccessHeader } from '../src/core/web/remote-access.js';
import { checkRemoteEnvelope, classifyRemoteRoute, type RemoteRequest } from '../src/core/web/remote-gateway-policy.js';

const ORIGIN = 'https://phone.example.com';
const AUD = 'a'.repeat(64);
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const CONFIG = {
  publicOrigin: ORIGIN,
  teamDomain: 'https://team.cloudflareaccess.com',
  audience: AUD,
  allowedSubjects: [SUBJECT],
};

function request(method = 'GET', headers: RemoteRequest['headers'] = {}): RemoteRequest {
  return { method, url: '/api/verse/activity', headers: { host: 'phone.example.com', ...headers } };
}

describe('unstarted remote gateway policy', () => {
  it('allows only explicitly reviewed query-free reads', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/activity')).toEqual({ kind: 'read', path: '/api/verse/activity' });
    for (const target of [
      '/api/verse/agent-tools/mcp', '/api/session', '/api/verse/terminal', '/api/verse/browser',
      '/api/verse/computer', '/api/verse/sessions/s1', '/api/verse/authority/ledger?view=decisions',
      '/api/verse/activity?x=1', '/api/verse/%61ctivity', '/api/verse/../activity',
      '/api//verse/activity', '//phone.example.com/api/verse/activity', '/verse/m/',
      'https://phone.example.com/api/verse/activity', '/api/verse/activity#fragment',
    ]) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', '/api/verse/activity')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('DELETE', '/api/verse/activity')).toEqual({ kind: 'deny' });
  });

  it('requires the exact public Host and Origin, with a session CSRF proof for writes', () => {
    expect(checkRemoteEnvelope(request(), ORIGIN)).toEqual({ ok: true });
    expect(checkRemoteEnvelope(request('GET', { host: 'localhost:7777' }), ORIGIN)).toEqual({ ok: false, reason: 'host' });
    expect(checkRemoteEnvelope(request('GET', { host: 'phone.example.com:8443' }), ORIGIN)).toEqual({ ok: false, reason: 'host' });
    expect(checkRemoteEnvelope(request('GET', { host: ['phone.example.com'] }), ORIGIN)).toEqual({ ok: false, reason: 'host' });
    expect(checkRemoteEnvelope(request('GET', { origin: 'https://evil.example' }), ORIGIN)).toEqual({ ok: false, reason: 'origin' });
    expect(checkRemoteEnvelope(request('POST'), ORIGIN, 'secret')).toEqual({ ok: false, reason: 'origin' });
    expect(checkRemoteEnvelope(request('POST', { origin: ORIGIN }), ORIGIN, 'secret')).toEqual({ ok: false, reason: 'csrf' });
    expect(checkRemoteEnvelope(request('POST', { origin: ORIGIN, 'x-ashlr-remote-csrf': 'wrong' }), ORIGIN, 'secret')).toEqual({ ok: false, reason: 'csrf' });
    expect(checkRemoteEnvelope(request('POST', { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'x-ashlr-remote-csrf': 'secret' }), ORIGIN, 'secret')).toEqual({ ok: false, reason: 'origin' });
    expect(checkRemoteEnvelope(request('POST', { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-ashlr-remote-csrf': 'secret' }), ORIGIN, 'secret')).toEqual({ ok: true });
  });

  it('refuses raw Hub credentials even on an otherwise allowed read', () => {
    expect(checkRemoteEnvelope(request('GET', { 'x-ashlr-token': 'local-token' }), ORIGIN)).toEqual({ ok: false, reason: 'hub-token' });
    expect(checkRemoteEnvelope(request('GET', { 'x-ashlr-read-client': 'local-proof' }), ORIGIN)).toEqual({ ok: false, reason: 'hub-token' });
  });
});

describe('Cloudflare Access assertion verifier', () => {
  it('fails closed for absent or malformed configuration', () => {
    for (const config of [null, {}, { ...CONFIG, audience: '' }, { ...CONFIG, teamDomain: 'https://evil.example' },
      { ...CONFIG, publicOrigin: 'http://phone.example.com' }, { ...CONFIG, publicOrigin: 'https://127.0.0.1' },
      { ...CONFIG, allowedSubjects: [] },
      { ...CONFIG, allowedSubjects: ['*'] }]) {
      expect(parseRemoteAccessConfig(config)).toBeNull();
      expect(() => createRemoteAccessVerifier(config)).toThrow();
    }
  });

  it('accepts only signed, in-date human application assertions for exact issuer, audience and subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const verify = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [jwk] }));
    const sign = (claims: Record<string, unknown> = {}, aud = AUD, iss = CONFIG.teamDomain) => new SignJWT({
      type: 'app', email: 'owner@example.com', ...claims,
    }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(iss).setAudience(aud).setSubject(SUBJECT)
      .setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(privateKey);
    const valid = await sign();
    expect(await verifyRemoteAccessHeader({ 'cf-access-jwt-assertion': valid }, verify)).toMatchObject({ subject: SUBJECT, email: 'owner@example.com' });
    expect(await verifyRemoteAccessHeader({ cookie: `CF_Authorization=${valid}` }, verify)).toBeNull();
    expect(await verifyRemoteAccessHeader({ 'cf-access-jwt-assertion': `${valid}x`, cookie: `CF_Authorization=${valid}` }, verify)).toBeNull();
    expect(await verifyRemoteAccessHeader({ 'cf-access-jwt-assertion': [valid] }, verify)).toBeNull();
    expect(await verify(await sign({}, 'b'.repeat(64)))).toBeNull();
    expect(await verify(await sign({}, AUD, 'https://other.cloudflareaccess.com'))).toBeNull();
    expect(await verify(await sign({ type: 'org' }))).toBeNull();
    expect(await verify(await sign({ email: undefined }))).toBeNull();
    expect(await verify(await sign({ common_name: 'service-token' }))).toBeNull();
    const other = await new SignJWT({ type: 'app', email: 'other@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(CONFIG.teamDomain).setAudience(AUD)
      .setSubject('another-user-id').setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(privateKey);
    expect(await verify(other)).toBeNull();
    const expired = await new SignJWT({ type: 'app', email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(CONFIG.teamDomain).setAudience(AUD)
      .setSubject(SUBJECT).setIssuedAt(1).setNotBefore(1).setExpirationTime(2).sign(privateKey);
    expect(await verify(expired)).toBeNull();
  });
});
