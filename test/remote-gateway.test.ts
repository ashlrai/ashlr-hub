import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier, parseRemoteAccessConfig, verifyRemoteAccessHeader } from '../src/core/web/remote-access.js';
import { checkRemoteEnvelope, classifyRemoteRoute, validateRemoteMutation, type RemoteRequest } from '../src/core/web/remote-gateway-policy.js';

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
  it('allows only reviewed mobile reads and bounded stream query shapes', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/activity')).toEqual({ kind: 'read', path: '/api/verse/activity' });
    for (const target of [
      '/api/verse/seats', '/api/verse/session-meta', '/api/verse/cloud', '/api/verse/leader',
      '/api/verse/leader/directives', '/api/verse/sessions/vs_1',
      '/api/verse/cloud/previews', '/api/verse/devin/previews',
      '/api/verse/authority/ledger?view=decisions&limit=40',
      '/api/verse/leader/thread?limit=50&before=msg-1',
      '/api/verse/checkpoints?chatId=vs_1',
      '/api/verse/checkpoints/diff?chatId=vs_1&turnId=t1&rootId=1234abcd&mode=since&file=src%2Findex.ts',
    ]) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'read', path: target.split('?')[0] });
    expect(classifyRemoteRoute('GET', '/api/events?topics=verse-sessions')).toEqual({ kind: 'stream', path: '/api/events' });
    expect(classifyRemoteRoute('GET', '/api/verse/sessions/vs_1/events?after=42')).toEqual({ kind: 'stream', path: '/api/verse/sessions/vs_1/events' });
    for (const target of [
      '/api/verse/agent-tools/mcp', '/api/session', '/api/verse/terminal', '/api/verse/browser',
      '/api/verse/computer', '/api/verse/sessions/.', '/api/verse/authority/ledger?view=decisions',
      '/api/verse/activity?x=1', '/api/verse/%61ctivity', '/api/verse/../activity',
      '/api//verse/activity', '//phone.example.com/api/verse/activity', '/verse/m/',
      'https://phone.example.com/api/verse/activity', '/api/verse/activity#fragment',
      '/api/verse/leader/thread?limit=50&limit=50',
      '/api/verse/leader/thread?limit=50&before=..%2Fsecret',
      '/api/verse/checkpoints/diff?chatId=s1&turnId=t1&rootId=1234abcd&mode=since&file=..%2Fsecret',
      '/api/events?topics=all', '/api/events?topics=verse-sessions&client=raw-local-proof',
      '/api/verse/sessions/s1/events?after=1&client=raw-local-proof',
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

  it('restricts mutations to reviewed routes and exact bounded bodies', () => {
    const approved = [
      ['POST', '/api/verse/sessions', { projectPath: '/repo', seatId: 'claude', model: 'opus' }, false],
      ['POST', '/api/verse/sessions/vs_1/turns', { text: 'Please inspect this.' }, false],
      ['POST', '/api/verse/queue/vs_1', { text: 'And test it.', sendNow: true }, false],
      ['POST', '/api/verse/queue/vs_1/012345abcdef/send', {}, true],
      ['POST', '/api/verse/agents/ag_12345678/plan', { action: 'approve' }, true],
      ['POST', '/api/verse/agents/ag_12345678/plan', { action: 'discard' }, true],
      ['POST', '/api/verse/activity/seen', { sessionId: 'vs_1', turnCount: 3 }, false],
      ['POST', '/api/verse/leader/thread', { text: 'What is running?' }, false],
      ['POST', '/api/verse/leader/questions/memo-1:0/answer', { text: 'Hold.' }, false],
      ['POST', '/api/verse/daemon', { action: 'stop' }, true],
      ['POST', '/api/verse/budget', { mode: 'reserve' }, true],
      ['POST', '/api/verse/authority', { action: 'stop' }, true],
      ['POST', '/api/verse/leader/actions/a1/approve', {}, true],
      ['POST', '/api/inbox/p1/approve', {}, true],
      ['POST', '/api/inbox/p.1/reject', {}, true],
      ['POST', '/api/verse/cloud/tasks/ct_20260927T2305_abcdef/land', { headSha: 'a'.repeat(40) }, true],
      ['POST', '/api/verse/devin/tasks/dv_20260927T2305_abcdef/close', { headSha: 'a'.repeat(40), reason: 'Needs revision' }, true],
      ['POST', '/api/verse/cloud/tasks/ct_20260927T2305_abcdef/dismiss', {}, false],
      ['POST', '/api/verse/fleet/live', { action: 'resume-repo', repo: 'ashlrai/ashlr-hub', kind: 'owner-hold' }, true],
      ['POST', '/api/verse/sessions/vs_1/cancel', {}, true],
      ['DELETE', '/api/verse/leader/directives/d1', undefined, true],
    ] as const;
    for (const [method, path, body, stepUp] of approved) {
      const decision = classifyRemoteRoute(method, path);
      expect(decision).toEqual({ kind: 'write', path, stepUp });
      expect(validateRemoteMutation(decision, body)).toBe(true);
    }
    for (const target of [
      '/api/verse/authority/draft', '/api/verse/terminal', '/api/verse/browser',
      '/api/verse/checkpoints/apply', '/api/verse/sessions/s1/delete',
      '/api/verse/authority?mode=stop', '/api/inbox/../p1/approve',
      '/api/verse/agents/ag_12345678/settings', '/api/verse/agents/a1/plan',
      '/api/verse/queue/vs_1/not-a-queue-id/send', '/api/verse/queue/vs_1/012345abcdef/delete',
      '/api/inbox/p1%2Fapprove', '/api/verse/leader/actions/a1/approve/extra',
    ]) expect(classifyRemoteRoute('POST', target)).toEqual({ kind: 'deny' });
    const stop = classifyRemoteRoute('POST', '/api/verse/daemon');
    for (const body of [null, [], {}, { action: 'clear-stop' }, { action: 'stop', extra: true },
      { action: { toString: null } }]) expect(validateRemoteMutation(stop, body)).toBe(false);
    const authority = classifyRemoteRoute('POST', '/api/verse/authority');
    for (const body of [{ action: 'grant', draftDigest: 'x' }, { action: 'clear-stop' },
      { action: 'switch', to: 'autonomous', draftDigest: 'x' }]) expect(validateRemoteMutation(authority, body)).toBe(false);
    expect(validateRemoteMutation(classifyRemoteRoute('POST', '/api/inbox/p1/approve'), { reason: 'skip' })).toBe(false);
    const cloudLand = classifyRemoteRoute('POST', '/api/verse/cloud/tasks/ct_20260927T2305_abcdef/land');
    expect(validateRemoteMutation(cloudLand, { headSha: 'a'.repeat(40), reason: 'smuggled' })).toBe(false);
    expect(validateRemoteMutation(cloudLand, { headSha: 'a'.repeat(39) })).toBe(false);
    const agentPlan = classifyRemoteRoute('POST', '/api/verse/agents/ag_12345678/plan');
    for (const body of [{}, { action: 'approve', text: 'unreviewed edit' }, { action: 'merge' },
      { action: 'discard', extra: true }]) expect(validateRemoteMutation(agentPlan, body)).toBe(false);
    const heldQueue = classifyRemoteRoute('POST', '/api/verse/queue/vs_1/012345abcdef/send');
    expect(validateRemoteMutation(heldQueue, { text: 'new prompt' })).toBe(false);
    expect(classifyRemoteRoute('POST', '/api/verse/cloud/tasks/../land')).toEqual({ kind: 'deny' });
    expect(validateRemoteMutation(classifyRemoteRoute('GET', '/api/verse/activity'), {})).toBe(false);
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
