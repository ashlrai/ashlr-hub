import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADOPTION_TARGET, ADOPTION_SOURCE_IDS, VERSE_ADOPTION_PATH } from '../src/core/verse/adoption-types.js';
import { parseAdoptionAssets, parseAdoptionNpm, parseAdoptionRepository, parseAdoptionTraffic, parseGhAdoptionResponse, readAdoptionSource, type AdoptionHttp, type AdoptionTransport } from '../src/core/verse/adoption-reader.js';
import { createAdoptionCache } from '../src/core/verse/adoption-cache.js';
import { createAdoptionApi } from '../src/core/verse/adoption-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const now = Date.parse('2026-10-05T12:00:00Z');
const response = (value: unknown, status = 200, headers: Record<string, string> = {}): AdoptionHttp => ({ status, headers, body: JSON.stringify(value) });
const repo = () => ({ full_name: ADOPTION_TARGET.repo, private: false, stargazers_count: 0, forks_count: 7 });
const npm = () => ({ package: '@ashlr/phantom', start: '2026-09-01', end: '2026-09-30', downloads: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, downloads: i })) });
const traffic = (kind = 'views') => ({ count: 8, uniques: 3, [kind]: [{ timestamp: '2026-10-02T00:00:00Z', count: 0, uniques: 0 }, { timestamp: '2026-10-04T00:00:00Z', count: 8, uniques: 3 }] });
const release = () => ({ id: 5, tag_name: 'v3.22.2', published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: false, url: 'https://api.github.com/repos/ashlrai/phantom/releases/5' });
const asset = (id = 10) => ({ id, name: 'Ashlr.dmg', download_count: 3, state: 'uploaded', url: `https://api.github.com/repos/ashlrai/phantom/releases/assets/${id}`, browser_download_url: 'https://github.com/ashlrai/phantom/releases/download/v3.22.2/Ashlr.dmg', uploader: { login: 'private-person' } });
function fakeTransport(): AdoptionTransport {
  return {
    github: vi.fn(async (path) => response(path.endsWith('/latest') ? release() : path.includes('/assets?') ? [asset()] : path.includes('/traffic/') ? traffic(path.includes('/clones?') ? 'clones' : 'views') : repo())),
    public: vi.fn(async (url) => response(url.includes('npmjs.org') ? npm() : repo())),
  };
}
const signal = () => new AbortController().signal;

describe('source semantics and strict parsers', () => {
  it('retains zero stocks but refuses a private or wrong repository', () => {
    expect(parseAdoptionRepository(repo())).toEqual({ repo: ADOPTION_TARGET.repo, stars: 0, forks: 7 });
    expect(parseAdoptionRepository({ ...repo(), full_name: 'private/other' })).toBeNull();
    expect(parseAdoptionRepository({ ...repo(), full_name: 'ashlrai/ashlr-hub' })).toBeNull();
    expect(parseAdoptionRepository({ ...repo(), private: true })).toBeNull();
  });
  it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses malformed count %s', (n) => {
    expect(parseAdoptionRepository({ ...repo(), stargazers_count: n })).toBeNull();
    expect(parseAdoptionAssets([{ ...asset(), download_count: n }], 5)).toBeNull();
  });
  it('uses provider available dates rather than inventing yesterday', () => {
    const value = parseAdoptionNpm(npm())!;
    expect(value.start).toBe('2026-09-01'); expect(value.end).toBe('2026-09-30');
    expect(value.days[0]).toEqual({ day: '2026-09-01', count: 0 }); expect(value.total).toBe(435);
  });
  it('keeps missing npm bins unknown and refuses mismatched/duplicate dates', () => {
    const raw = npm(); raw.downloads.splice(4, 1);
    expect(parseAdoptionNpm(raw)).toMatchObject({ complete: false, total: null });
    expect(parseAdoptionNpm(raw)?.days[4]).toEqual({ day: '2026-09-05', count: null });
    expect(parseAdoptionNpm({ ...npm(), package: 'other' })).toBeNull();
    expect(parseAdoptionNpm({ ...npm(), package: '@ashlr/hub' })).toBeNull();
    expect(parseAdoptionNpm({ ...npm(), downloads: [...npm().downloads, npm().downloads[0]] })).toBeNull();
    expect(parseAdoptionNpm({ ...npm(), start: '2026-02-30' })).toBeNull();
  });
  it('traffic uniques remain a separate provider aggregate and gaps are not zeros', () => {
    expect(parseAdoptionTraffic(traffic(), 'views')).toMatchObject({ count: 8, uniques: 3, days: [{ day: '2026-10-02', count: 0, uniques: 0 }, { day: '2026-10-04', count: 8, uniques: 3 }] });
    expect(parseAdoptionTraffic({ ...traffic(), count: 9 }, 'views')).toBeNull();
    expect(parseAdoptionTraffic({ ...traffic(), uniques: 9 }, 'views')).toBeNull();
    expect(parseAdoptionTraffic({ ...traffic(), views: [{ timestamp: '2026-10-02T01:00:00Z', count: 8, uniques: 3 }] }, 'views')).toBeNull();
  });
  it('returns only asset metadata, replacement IDs distinct, never uploader identities', () => {
    expect(parseAdoptionAssets([asset()], 5)).toEqual([{ id: 10, name: 'Ashlr.dmg', count: 3 }]);
    expect(parseAdoptionAssets([asset(), asset()], 5)).toBeNull();
    expect(parseAdoptionAssets([{ ...asset(), url: 'https://api.github.com/repos/other/repo/releases/assets/10' }], 5)).toBeNull();
    expect(parseAdoptionAssets([asset(11)], 5)?.[0]?.id).toBe(11);
  });
  it('parses status and provider backoff without exposing gh stderr', () => {
    expect(parseGhAdoptionResponse('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 7200\r\n\r\n{"message":"rate limited"}')).toEqual({ status: 429, headers: { 'retry-after': '7200' }, body: '{"message":"rate limited"}' });
    expect(parseGhAdoptionResponse('gh auth login token')).toBeNull();
  });
});

describe('fixed source reader', () => {
  it('public stocks and npm still work without gh; denied traffic never falls back', async () => {
    const t = fakeTransport(); t.github = vi.fn(async () => { throw new Error('secret stderr'); });
    expect(await readAdoptionSource('repository', t, signal(), now)).toMatchObject({ ok: true, value: { stars: 0 } });
    expect(await readAdoptionSource('npm', t, signal(), now)).toMatchObject({ ok: true, value: { total: 435 } });
    expect(await readAdoptionSource('views', t, signal(), now)).toEqual({ ok: false, reason: 'unavailable', retryAt: null });
    expect(t.public).toHaveBeenCalledTimes(2);
  });
  it('403 traffic remains independent while repository stocks succeed', async () => {
    const t = fakeTransport(); t.github = vi.fn(async (path) => path.includes('/traffic/') ? response({}, 403) : response(repo()));
    expect(await readAdoptionSource('repository', t, signal(), now)).toMatchObject({ ok: true });
    expect(await readAdoptionSource('views', t, signal(), now)).toEqual({ ok: false, reason: 'permission', retryAt: null });
    expect(t.public).not.toHaveBeenCalled();
  });
  it('public stocks retain anonymous fallback for missing authentication only', async () => {
    const t = fakeTransport(); t.github = vi.fn(async () => response({}, 401));
    expect(await readAdoptionSource('repository', t, signal(), now)).toMatchObject({ ok: true, value: { stars: 0 } });
    expect(t.public).toHaveBeenCalledTimes(1);
    t.public = vi.fn(async () => response(repo()));
    t.github = vi.fn(async () => response({}, 403));
    expect(await readAdoptionSource('repository', t, signal(), now)).toEqual({ ok: false, reason: 'permission', retryAt: null });
    expect(t.public).not.toHaveBeenCalled();
  });
  it('a deferred headerless secondary-limit 403 never falls back anonymously', async () => {
    let settle!: (response: AdoptionHttp) => void;
    const t = fakeTransport(); t.github = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const pending = readAdoptionSource('repository', t, signal(), now);
    settle(response({ message: 'You have exceeded a secondary rate limit.' }, 403));
    expect(await pending).toEqual({ ok: false, reason: 'rate-limited', retryAt: null });
    expect(t.public).not.toHaveBeenCalled();
  });
  it.each(['7200', 'Mon, 05 Oct 2026 14:00:00 GMT'])('preserves long Retry-After %s and does not bypass to anonymous API', async (header) => {
    const t = fakeTransport(); t.github = vi.fn(async () => response({}, 429, { 'retry-after': header }));
    expect(await readAdoptionSource('repository', t, signal(), now)).toEqual({ ok: false, reason: 'rate-limited', retryAt: now + 7_200_000 });
    expect(t.public).not.toHaveBeenCalled();
  });
  it('numeric Retry-After begins at the actual response receipt, not request start', async () => {
    let clock = now, settle!: (response: AdoptionHttp) => void;
    const t = fakeTransport(); t.github = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const pending = readAdoptionSource('repository', t, signal(), () => clock);
    clock += 15_000; settle(response({}, 429, { 'retry-after': '7200' }));
    expect(await pending).toEqual({ ok: false, reason: 'rate-limited', retryAt: clock + 7_200_000 });
  });
  it('403 exhausted quota honors GitHub reset rather than anonymous retry', async () => {
    const t = fakeTransport(); t.github = vi.fn(async () => response({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 3600_000) / 1000) }));
    expect(await readAdoptionSource('repository', t, signal(), now)).toMatchObject({ ok: false, reason: 'rate-limited', retryAt: now + 3600_000 }); expect(t.public).not.toHaveBeenCalled();
  });
  it('latest-only assets require complete valid pagination and retain asset IDs', async () => {
    const t = fakeTransport();
    t.github = vi.fn(async (path) => path.endsWith('/latest') ? response(release()) : path.endsWith('page=1') ? response([asset()], 200, { link: '<https://api.github.com/repos/ashlrai/phantom/releases/5/assets?per_page=100&page=2>; rel="next"' }) : response([asset(11)]));
    expect(await readAdoptionSource('release', t, signal(), now)).toMatchObject({ ok: true, value: { id: 5, coverage: 'latest-published-release-only', assets: [{ id: 10 }, { id: 11 }] } });
    t.github = vi.fn(async (path) => path.endsWith('/latest') ? response(release()) : response([asset()], 200, { link: '<https://evil.example/secret>; rel="next"' }));
    expect(await readAdoptionSource('release', t, signal(), now)).toMatchObject({ ok: false, reason: 'invalid-response' });
  });
  it('a failure on a later asset page rejects the partial listing', async () => {
    const t = fakeTransport(); t.github = vi.fn(async (path) => path.endsWith('/latest') ? response(release()) : path.endsWith('page=1') ? response([asset()], 200, { link: '<https://api.github.com/repos/ashlrai/phantom/releases/5/assets?per_page=100&page=2>; rel="next"' }) : response({}, 429, { 'retry-after': '900' }));
    expect(await readAdoptionSource('release', t, signal(), now)).toEqual({ ok: false, reason: 'rate-limited', retryAt: now + 900_000 });
  });
  it('a repository mismatch and oversized/malformed payload stay unknown', async () => {
    const t = fakeTransport(); t.github = vi.fn(async () => ({ status: 200, headers: {}, body: '{not json' }));
    expect(await readAdoptionSource('repository', t, signal(), now)).toMatchObject({ ok: false, reason: 'invalid-response' });
    t.public = vi.fn(async () => ({ status: 200, headers: {}, body: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect(await readAdoptionSource('npm', t, signal(), now)).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('cache and admission', () => {
  it('peeks do not contact transports; repeated clients share each source flight', async () => {
    const t = fakeTransport(), cache = createAdoptionCache({ transport: t, now: () => now });
    expect(cache.peek().sources.repository.value).toBeNull(); cache.peek(); expect(t.github).not.toHaveBeenCalled();
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(t.github).toHaveBeenCalledTimes(5); expect(t.public).toHaveBeenCalledTimes(1);
    await cache.refresh(); expect(t.github).toHaveBeenCalledTimes(5);
  });
  it('failed refresh retains prior observations, stale and separate latest attempt', async () => {
    let clock = now; const t = fakeTransport(), cache = createAdoptionCache({ transport: t, now: () => clock });
    await cache.refresh(); const previous = cache.peek().sources.views;
    clock += 1000; t.github = vi.fn(async () => response({}, 403));
    await cache.refresh(true); const next = cache.peek().sources.views;
    expect(next.value).toEqual(previous.value); expect(next.observedAt).toBe(previous.observedAt);
    expect(next.checkedAt).not.toBe(previous.checkedAt); expect(next.stale).toBe(true); expect(next.reason).toBe('permission');
  });
  it('a forced refresh cannot bypass the provider retry deadline', async () => {
    let clock = now; const t = fakeTransport(); t.github = vi.fn(async () => response({}, 429, { 'retry-after': '7200' }));
    const cache = createAdoptionCache({ transport: t, now: () => clock });
    await cache.refresh(); const calls = vi.mocked(t.github).mock.calls.length;
    clock += 3600_000; await cache.refresh(true); expect(t.github).toHaveBeenCalledTimes(calls);
    clock += 3600_001; await cache.refresh(true); expect(vi.mocked(t.github).mock.calls.length).toBeGreaterThan(calls);
  });
  it('headerless secondary limits retain old timestamps and forced refresh backoff', async () => {
    let clock = now; const t = fakeTransport(), cache = createAdoptionCache({ transport: t, now: () => clock });
    await cache.refresh(); const previous = cache.peek().sources.repository;
    clock += 1000; t.github = vi.fn(async () => response({ message: 'You have exceeded a secondary rate limit.' }, 403));
    await cache.refresh(true);
    expect(cache.peek().sources.repository).toMatchObject({ value: previous.value, observedAt: previous.observedAt, stale: true, reason: 'rate-limited' });
    expect(vi.mocked(t.public).mock.calls.every(([url]) => url.startsWith('https://api.npmjs.org/'))).toBe(true);
    const calls = vi.mocked(t.github).mock.calls.length;
    clock += 60_001; await cache.refresh(true); expect(t.github).toHaveBeenCalledTimes(calls);
    clock += 240_000; await cache.refresh(true); expect(vi.mocked(t.github).mock.calls.length).toBeGreaterThan(calls);
  });
  it('a transient failure retries when its backoff expires instead of waiting a successful-reading TTL', async () => {
    let clock = now; const t = fakeTransport(); t.github = vi.fn(async () => response({}, 503));
    const cache = createAdoptionCache({ transport: t, now: () => clock });
    await cache.refresh(); clock += 60_001;
    t.github = vi.fn(async (path) => response(path.endsWith('/latest') ? release() : path.includes('/assets?') ? [asset()] : path.includes('/traffic/') ? traffic(path.includes('/clones?') ? 'clones' : 'views') : repo()));
    await cache.refresh(); expect(cache.peek().sources.repository).toMatchObject({ state: 'ready', reason: null });
  });
  it('reset aborts/drains owned reads and late old-generation results cannot return', async () => {
    const controllers: AbortSignal[] = [];
    const t = fakeTransport();
    t.github = vi.fn((_path, signal) => new Promise((resolve) => { controllers.push(signal); signal.addEventListener('abort', () => resolve(response(repo())), { once: true }); }));
    t.public = vi.fn((_url, signal) => new Promise((resolve) => { controllers.push(signal); signal.addEventListener('abort', () => resolve(response(npm())), { once: true }); }));
    const cache = createAdoptionCache({ transport: t, now: () => now });
    const pending = cache.refresh(); await cache.reset(); await pending;
    expect(controllers.every((s) => s.aborted)).toBe(true);
    for (const id of ADOPTION_SOURCE_IDS) expect(cache.peek().sources[id]).toMatchObject({ state: 'warming', value: null, checkedAt: null });
  });
  it('authenticated read handler is cache-only and rejects arbitrary target queries', async () => {
    const t = fakeTransport(), cache = createAdoptionCache({ transport: t }), handler = createAdoptionApi(cache);
    const call = async (url: string) => {
      const req = Readable.from([]) as unknown as IncomingMessage; req.url = url;
      let body = ''; const res = { statusCode: 0, setHeader: vi.fn(), writeHead(status: number) { this.statusCode = status; }, end: (v: string) => { body = v; } } as unknown as ServerResponse;
      await handler({ allowDispatch: false } as VerseApiContext, req, res, VERSE_ADOPTION_PATH, 'GET');
      return { status: res.statusCode, body: JSON.parse(body) };
    };
    expect((await call(VERSE_ADOPTION_PATH)).body.target).toEqual(ADOPTION_TARGET);
    expect((await call(`${VERSE_ADOPTION_PATH}?repo=private/other`)).status).toBe(400);
    expect(t.github).not.toHaveBeenCalled(); expect(t.public).not.toHaveBeenCalled();
  });
});
