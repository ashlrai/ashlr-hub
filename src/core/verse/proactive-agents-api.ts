/** Saved personal-agent metadata; these routes never dispatch external work. */
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { getProactiveProfilesStore, ProactiveProfileError, type ProactiveProfilesStore } from '../proactive/profiles.js';
import { VERSE_PROACTIVE_AGENTS_PATH } from '../proactive/types.js';
import type { ApiModule } from './api-modules.js';

export function createProactiveAgentsApi(store: () => ProactiveProfilesStore = getProactiveProfilesStore): ApiModule {
  return async (ctx, req, res, path, method) => {
    const base = VERSE_PROACTIVE_AGENTS_PATH;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    try {
      if (method !== 'GET' && method !== 'POST') { sendJson(res, 404, { error: 'not found' }); return true; }
      if (method === 'POST') {
        if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
        if (!passesMutationGate(req, res, ctx.token)) return true;
      }
      if (new URL(req.url ?? path, 'http://localhost').search) {
        sendJson(res, 400, { code: 'INVALID_INPUT', error: 'This endpoint does not accept query parameters.' }); return true;
      }
      if (path === base && method === 'GET') { sendJson(res, 200, await store().list()); return true; }
      const match = path.match(/^\/api\/verse\/proactive-agents\/(pa_[a-f0-9]{24})(\/delete)?$/u);
      if (method !== 'POST' || path !== base && !match) { sendJson(res, 404, { error: 'not found' }); return true; }
      let bytes: string;
      try { bytes = await readBody(req, 32 * 1024); }
      catch { sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'Profile request is too large.' }); return true; }
      let body: unknown;
      try { body = JSON.parse(bytes); }
      catch { sendJson(res, 400, { code: 'INVALID_INPUT', error: 'Use a JSON object.' }); return true; }
      if (path === base) sendJson(res, 201, { profile: await store().create(body) });
      else if (match?.[2]) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('expectedVersion' in body)) {
          throw new ProactiveProfileError('INVALID_INPUT', 'Deletion requires only the current expectedVersion.');
        }
        await store().remove(match[1]!, (body as { expectedVersion: number }).expectedVersion);
        sendJson(res, 200, { ok: true });
      } else sendJson(res, 200, { profile: await store().update(match![1]!, body) });
    } catch (error) {
      if (error instanceof ProactiveProfileError) {
        const status = { INVALID_INPUT: 400, CONFLICT: 409, NOT_FOUND: 404, UNAVAILABLE: 503 }[error.code];
        if (!res.headersSent) sendJson(res, status, { code: error.code, error: error.message });
      } else if (!res.headersSent) sendJson(res, 503, { code: 'UNAVAILABLE', error: 'Proactive agent profiles are unavailable; existing data was preserved.' });
    }
    return true;
  };
}
export const handleProactiveAgentsApi = createProactiveAgentsApi();
