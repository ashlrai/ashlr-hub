/** Authenticated aggregate agent/human read port. GET only peeks; refresh retains the mutation gate. */
import type { ApiModule } from './api-modules.js';
import { sendJson, passesMutationGate, readBody } from '../web/api.js';
import { adoptionCache, type createAdoptionCache } from './adoption-cache.js';
import { VERSE_ADOPTION_PATH, VERSE_ADOPTION_REFRESH_PATH } from './adoption-types.js';

export function createAdoptionApi(cache: ReturnType<typeof createAdoptionCache> = adoptionCache): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_ADOPTION_PATH && path !== VERSE_ADOPTION_REFRESH_PATH) return false;
    try {
      if (method !== 'GET') {
        if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
        if (!passesMutationGate(req, res, ctx.token)) return true;
      }
      // Inert request primitives only: scheduler-owning API modules cannot be imported for helpers.
      if ([...new URL(req.url ?? '/', 'http://localhost').searchParams].length > 0) {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: 'Adoption does not accept target or query overrides.' }); return true;
      }
      if (path === VERSE_ADOPTION_PATH && method === 'GET') { sendJson(res, 200, cache.peek()); return true; }
      if (path === VERSE_ADOPTION_REFRESH_PATH && method === 'POST') {
        let raw: string;
        try { raw = await readBody(req, 256); }
        catch { sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'Request body too large.' }); return true; }
        let body: unknown;
        try { body = raw.trim() ? JSON.parse(raw) : {}; }
        catch { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'Body must be an empty JSON object.' }); return true; }
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
          sendJson(res, 400, { code: 'VERSE_INVALID', error: 'Body must be an empty JSON object.' }); return true;
        }
        await cache.refresh(true); sendJson(res, 200, { ok: true }); return true;
      }
      sendJson(res, 404, { error: 'adoption route not found' }); return true;
    } catch {
      sendJson(res, 503, { error: 'Adoption metadata unavailable.' }); return true;
    }
  };
}
export const handleAdoptionApi = createAdoptionApi();
