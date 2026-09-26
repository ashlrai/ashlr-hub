/**
 * Cloud task evidence timeline — HTTP module (3.13), mounted as
 * 'cloud-timeline' in verse-api.ts.
 *
 *   GET /api/verse/cloud/tasks/<id>/timeline  → CloudTimelineResponse (timeline-types.ts)
 *                                                404 unknown task, 400 bad id / any query
 *
 * READ-ONLY. A GET behind server.ts's read-session boundary like every
 * Verse read; the mutation token is never needed. Any other verb on this
 * path is a 404 (mutations are refused before this module by the mount).
 *
 * WHY its own module and not a route in cloud-api.ts: the cloud module is
 * edited by other units, and this family only reads. It is mounted BEFORE
 * 'cloud' because cloud-api.ts answers every /api/verse/cloud/* path it does
 * not know with a 404; this module claims exactly one path shape and
 * declines everything else without writing, so it can never shadow a cloud
 * route.
 *
 * The heavy builder (timeline.ts: ledger, merge records, git) is imported
 * only when the path matches, so a cold server pays nothing for this module
 * on any other request.
 */
import type { ApiModule } from '../verse/api-modules.js';
import { sendJson } from '../web/api.js';
import { CLOUD_TIMELINE_PATH_RE } from './timeline-types.js';
import { CLOUD_TASK_ID_PATTERN } from './types.js';

export const handleCloudTimelineApi: ApiModule = async (_ctx, req, res, path, method) => {
  const match = CLOUD_TIMELINE_PATH_RE.exec(path);
  if (!match) return false;
  if (method !== 'GET') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  let query: URLSearchParams;
  try {
    query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'Invalid query string.' });
    return true;
  }
  const first = query.keys().next();
  if (!first.done) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: `Unknown query parameter: ${first.value}.` });
    return true;
  }
  const id = match[1]!;
  if (!CLOUD_TASK_ID_PATTERN.test(id)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'That is not a cloud task id.' });
    return true;
  }
  try {
    const { cloudTaskTimeline, timelineDepsForRoute } = await import('./timeline.js');
    const timeline = await cloudTaskTimeline(id, timelineDepsForRoute());
    if (!timeline) {
      sendJson(res, 404, { error: 'No cloud task with that id.' });
      return true;
    }
    sendJson(res, 200, timeline);
  } catch {
    // Never the raw message: store and git errors can carry paths.
    if (!res.headersSent) sendJson(res, 500, { error: 'cloud timeline failed' });
  }
  return true;
};
