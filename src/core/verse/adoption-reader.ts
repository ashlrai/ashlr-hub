/** Read-only, fixed-origin transport. No enrolled paths, personal identities or artifact downloads. */
import { execFile } from 'node:child_process';
import { request } from 'node:https';
import {
  ADOPTION_TARGET, type AdoptionRepository, type AdoptionNpm, type AdoptionTraffic,
  type AdoptionRelease, type AdoptionReleaseAsset, type AdoptionSourceId, type AdoptionValues, type AdoptionReason,
} from './adoption-types.js';

const MAX_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 20_000;
const GH_REPO = `/repos/${ADOPTION_TARGET.repo}`;
export interface AdoptionHttp { status: number; headers: Record<string, string>; body: string }
export interface AdoptionTransport {
  github(path: string, signal: AbortSignal): Promise<AdoptionHttp>;
  public(url: string, signal: AbortSignal): Promise<AdoptionHttp>;
}
export type AdoptionResult<T> = { ok: true; value: T } | { ok: false; reason: AdoptionReason; retryAt: number | null };
const invalid = (): AdoptionResult<never> => ({ ok: false, reason: 'invalid-response', retryAt: null });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positiveId = (v: unknown): v is number => count(v) && v > 0;
const boundedText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
export function isAdoptionDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}
function timestamp(v: unknown): v is string { return typeof v === 'string' && Number.isFinite(Date.parse(v)) && /Z$/.test(v); }
export function parseAdoptionRepository(v: unknown): AdoptionRepository | null {
  if (!record(v) || v['full_name'] !== ADOPTION_TARGET.repo || v['private'] !== false || !count(v['stargazers_count']) || !count(v['forks_count'])) return null;
  return { repo: ADOPTION_TARGET.repo, stars: v['stargazers_count'], forks: v['forks_count'] };
}
export function parseAdoptionNpm(v: unknown): AdoptionNpm | null {
  if (!record(v) || v['package'] !== ADOPTION_TARGET.packageName || !isAdoptionDay(v['start']) || !isAdoptionDay(v['end']) || !Array.isArray(v['downloads'])) return null;
  const start = v['start'], end = v['end'];
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (span !== 30) return null; // last-month is the source's last 30 available days, not the local clock's yesterday.
  const byDay = new Map<string, number>();
  for (const row of v['downloads']) {
    if (!record(row) || !isAdoptionDay(row['day']) || row['day'] < start || row['day'] > end || !count(row['downloads']) || byDay.has(row['day'])) return null;
    byDay.set(row['day'], row['downloads']);
  }
  const days = Array.from({ length: span }, (_, i) => {
    const day = new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10);
    return { day, count: byDay.get(day) ?? null };
  });
  const complete = days.every((d) => d.count !== null);
  const sum = complete ? days.reduce((n, d) => n + d.count!, 0) : null;
  if (sum !== null && !count(sum)) return null;
  return { packageName: ADOPTION_TARGET.packageName, start, end, days, complete, total: sum };
}
export function parseAdoptionTraffic(v: unknown, kind: 'views' | 'clones'): AdoptionTraffic | null {
  if (!record(v) || !count(v['count']) || !count(v['uniques']) || v['uniques'] > v['count'] || !Array.isArray(v[kind])) return null;
  const days: AdoptionTraffic['days'] = [], seen = new Set<string>();
  for (const row of v[kind]) {
    if (!record(row) || typeof row['timestamp'] !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(row['timestamp'])) return null;
    const day = row['timestamp'].slice(0, 10);
    if (!isAdoptionDay(day) || seen.has(day) || !count(row['count']) || !count(row['uniques']) || row['uniques'] > row['count']) return null;
    days.push({ day, count: row['count'], uniques: row['uniques'] }); seen.add(day);
  }
  if (days.length > 15) return null; // GitHub's rolling14d response can contain both partial boundary dates.
  days.sort((a, b) => a.day.localeCompare(b.day));
  if (days.length > 1 && Date.parse(days.at(-1)!.day) - Date.parse(days[0]!.day) > 14 * 86_400_000) return null;
  if (days.reduce((n, d) => n + d.count, 0) !== v['count']) return null;
  return { count: v['count'], uniques: v['uniques'], days, window: 'provider-last-14-days-utc' };
}
function parseRelease(v: unknown): Omit<AdoptionRelease, 'assets'> | null {
  if (!record(v) || !positiveId(v['id']) || !boundedText(v['tag_name']) || !timestamp(v['published_at']) || v['draft'] !== false || v['prerelease'] !== false || v['url'] !== `https://api.github.com${GH_REPO}/releases/${v['id']}`) return null;
  return { id: v['id'], tag: v['tag_name'], publishedAt: v['published_at'], coverage: 'latest-published-release-only' };
}
export function parseAdoptionAssets(v: unknown, releaseId: number): AdoptionReleaseAsset[] | null {
  if (!Array.isArray(v) || v.length > 100) return null;
  const assets: AdoptionReleaseAsset[] = [], seen = new Set<number>();
  for (const row of v) {
    if (!record(row) || !positiveId(row['id']) || !boundedText(row['name']) || !count(row['download_count']) || row['state'] !== 'uploaded' || row['url'] !== `https://api.github.com${GH_REPO}/releases/assets/${row['id']}` || !row['browser_download_url'] || typeof row['browser_download_url'] !== 'string') return null;
    // Asset identity comes from a release-scoped listing; never return uploader objects or download URLs.
    if (!positiveId(releaseId) || seen.has(row['id'])) return null;
    seen.add(row['id']); assets.push({ id: row['id'], name: row['name'], count: row['download_count'] });
  }
  return assets;
}
function retryDeadline(headers: Record<string, string>, now: number): number | null {
  const raw = headers['retry-after'];
  let deadline: number | null = null;
  if (raw && raw.length <= 64) {
    const n = /^\d+$/.test(raw) ? Number(raw) : null;
    const ms = n !== null ? now + n * 1000 : Date.parse(raw);
    if (Number.isSafeInteger(ms) && ms >= now && ms <= 8_640_000_000_000_000) deadline = ms;
  }
  const reset = headers['x-ratelimit-reset'];
  if (reset && /^\d{1,16}$/.test(reset) && headers['x-ratelimit-remaining'] === '0') {
    const ms = Number(reset) * 1000;
    if (Number.isSafeInteger(ms) && ms >= now && ms <= 8_640_000_000_000_000) deadline = Math.max(deadline ?? now, ms);
  }
  return deadline;
}
function failure(response: AdoptionHttp, now: number): AdoptionResult<never> | null {
  if (response.status === 200) return null;
  const retryAt = retryDeadline(response.headers, now);
  const payload = response.status === 403 ? json(response.body) : null;
  const rateMessage = record(payload) && typeof payload['message'] === 'string' && payload['message'].length <= 1024 && /rate limit/i.test(payload['message']);
  return { ok: false, reason: response.status === 429 || (response.status === 403 && (retryAt !== null || rateMessage)) ? 'rate-limited' : response.status === 403 ? 'permission' : response.status === 401 ? 'authentication' : response.status === 404 ? 'not-found' : 'unavailable', retryAt };
}
function json(body: string): unknown { try { return JSON.parse(body); } catch { return null; } }

/** Header-inclusive gh output is parsed without forwarding stderr or account identity. */
export function parseGhAdoptionResponse(stdout: string): AdoptionHttp | null {
  const split = stdout.search(/\r?\n\r?\n/);
  if (split < 0) return null;
  const head = stdout.slice(0, split).split(/\r?\n/), status = /^HTTP\/\S+\s+(\d{3})/.exec(head.shift() ?? '');
  if (!status) return null;
  const headers: Record<string, string> = {};
  for (const line of head) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(status[1]), headers, body: stdout.slice(split).replace(/^\r?\n\r?\n/, '') };
}
function publicGet(url: string, signal: AbortSignal): Promise<AdoptionHttp> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !['api.github.com', 'api.npmjs.org'].includes(parsed.hostname)) return Promise.reject(new Error('unsupported origin'));
  return new Promise((resolve, reject) => {
    const req = request(parsed, { method: 'GET', signal, headers: { Accept: 'application/json', 'User-Agent': 'Ashlr-Hub-adoption-readback', ...(parsed.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) { req.destroy(new Error('metadata too large')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (size > MAX_BYTES) return;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') headers[key] = value;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(DEADLINE_MS, () => req.destroy(new Error('metadata timeout'))); req.once('error', reject); req.end();
  });
}
export const adoptionTransport: AdoptionTransport = {
  public: publicGet,
  github: (path, signal) => new Promise((resolve, reject) => {
    execFile('gh', ['api', '--hostname', 'github.com', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', path.slice(1)], {
      timeout: DEADLINE_MS, maxBuffer: MAX_BYTES, encoding: 'utf8', signal,
      env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }, (_error, stdout) => {
      const response = typeof stdout === 'string' ? parseGhAdoptionResponse(stdout) : null;
      if (response) resolve(response); else reject(new Error('GitHub metadata unavailable'));
    });
  }),
};

export async function readAdoptionSource<K extends AdoptionSourceId>(id: K, transport: AdoptionTransport, signal: AbortSignal, clock: number | (() => number) = Date.now): Promise<AdoptionResult<AdoptionValues[K]>> {
  const now = typeof clock === 'function' ? clock : () => clock;
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const combined = AbortSignal.any([signal, deadline]);
  let bytes = 0;
  async function github(path: string, allowPublic: boolean): Promise<AdoptionHttp> {
    let response: AdoptionHttp; let usedPublic = false;
    try { response = await transport.github(path, combined); }
    catch { if (!allowPublic || combined.aborted) throw new Error('unavailable'); usedPublic = true; response = await transport.public(`https://api.github.com${path}`, combined); }
    // A headerless 403 can be a secondary rate limit. Only missing authentication
    // permits public fallback; ambiguous/permission 403s retain the original evidence.
    if (allowPublic && !usedPublic && response.status === 401 && retryDeadline(response.headers, now()) === null) response = await transport.public(`https://api.github.com${path}`, combined);
    bytes += Buffer.byteLength(response.body);
    if (bytes > MAX_BYTES || combined.aborted) throw new Error('bounded read ended');
    return response;
  }
  try {
    if (id === 'release') {
      const response = await github(`${GH_REPO}/releases/latest`, true), failed = failure(response, now());
      if (failed) return failed;
      const release = parseRelease(json(response.body)); if (!release) return invalid();
      const assets: AdoptionReleaseAsset[] = [], seen = new Set<number>();
      let page = 1;
      for (;;) {
        const path = `${GH_REPO}/releases/${release.id}/assets?per_page=100&page=${page}`;
        const response = await github(path, true), failed = failure(response, now()); if (failed) return failed;
        const rows = parseAdoptionAssets(json(response.body), release.id); if (!rows) return invalid();
        for (const asset of rows) { if (seen.has(asset.id)) return invalid(); seen.add(asset.id); assets.push(asset); }
        const link = response.headers['link'];
        const next = link?.split(',').find((part) => /;\s*rel="next"/.test(part));
        if (!next) break; // GitHub's absent next relation marks the complete final page.
        const url = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next)?.[1];
        if (url !== `https://api.github.com${GH_REPO}/releases/${release.id}/assets?per_page=100&page=${page + 1}`) return invalid();
        page += 1;
      }
      return { ok: true, value: { ...release, assets } as AdoptionValues[K] };
    }
    const response = id === 'npm'
      ? await transport.public(`https://api.npmjs.org/downloads/range/last-month/${ADOPTION_TARGET.packageName}`, combined)
      : await github(id === 'repository' ? GH_REPO : `${GH_REPO}/traffic/${id}?per=day`, id === 'repository');
    if (Buffer.byteLength(response.body) > MAX_BYTES || combined.aborted) throw new Error('bounded read ended');
    const failed = failure(response, now()); if (failed) return failed;
    const raw = json(response.body);
    const value = id === 'npm' ? parseAdoptionNpm(raw) : id === 'repository' ? parseAdoptionRepository(raw) : parseAdoptionTraffic(raw, id as 'views' | 'clones');
    return value ? { ok: true, value: value as AdoptionValues[K] } : invalid();
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'unavailable', retryAt: null };
  }
}
