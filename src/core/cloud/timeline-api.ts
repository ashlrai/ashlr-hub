/**
 * Cloud task evidence timeline — HTTP module (3.13), mounted as
 * 'cloud-timeline' in verse-api.ts.
 *
 *   GET /api/verse/cloud/tasks/<id>/timeline  → CloudTimelineResponse (timeline-types.ts)
 *   GET /api/verse/devin/tasks/<id>/timeline  → CloudTimelineResponse (3.15, devin/timeline.ts)
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
 * 3.15 — the Devin lane's timeline lives here for the same reason: the
 * 'devin' module answers every /api/verse/devin/* path (unknown ones with a
 * 404) and is mounted AFTER this one, so this module claims exactly the one
 * Devin shape `/api/verse/devin/tasks/<id>/timeline` (a path devin-api.ts
 * never serves: its task routes are POST-only verbs) and nothing else. Each
 * lane's id is checked against that lane's own pattern, so an id Verse did
 * not issue never reaches a store read.
 *
 * The heavy builders (timeline.ts, devin/timeline.ts: ledger, merge
 * records, git) are imported only when the path matches, so a cold server
 * pays nothing for this module on any other request.
 */
import type { ServerResponse } from 'node:http';

import type { ApiModule } from '../verse/api-modules.js';
import { sendJson } from '../web/api.js';
import { DEVIN_TASK_ID_PATTERN } from '../devin/types.js';
import { CLOUD_TIMELINE_PATH_RE, DEVIN_TIMELINE_PATH_RE, type CloudTimelineResponse } from './timeline-types.js';
import { CLOUD_TASK_ID_PATTERN } from './types.js';

interface Lane {
  idPattern: RegExp;
  badId: string;
  missing: string;
  failed: string;
  load: (id: string) => Promise<CloudTimelineResponse | null>;
}

const CLOUD_LANE: Lane = {
  idPattern: CLOUD_TASK_ID_PATTERN,
  badId: 'That is not a cloud task id.',
  missing: 'No cloud task with that id.',
  failed: 'cloud timeline failed',
  load: async (id) => {
    const { cloudTaskTimeline, timelineDepsForRoute } = await import('./timeline.js');
    return cloudTaskTimeline(id, timelineDepsForRoute());
  },
};

const DEVIN_LANE: Lane = {
  idPattern: DEVIN_TASK_ID_PATTERN,
  badId: 'That is not a Devin task id.',
  missing: 'No Devin task with that id.',
  failed: 'devin timeline failed',
  load: async (id) => {
    const { devinTaskTimeline, devinTimelineDepsForRoute } = await import('../devin/timeline.js');
    return devinTaskTimeline(id, devinTimelineDepsForRoute());
  },
};

function laneOf(path: string): { lane: Lane; id: string } | null {
  const cloud = CLOUD_TIMELINE_PATH_RE.exec(path);
  if (cloud) return { lane: CLOUD_LANE, id: cloud[1]! };
  const devin = DEVIN_TIMELINE_PATH_RE.exec(path);
  if (devin) return { lane: DEVIN_LANE, id: devin[1]! };
  return null;
}

export const handleCloudTimelineApi: ApiModule = async (_ctx, req, res: ServerResponse, path, method) => {
  const match = laneOf(path);
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
  const { lane, id } = match;
  if (!lane.idPattern.test(id)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: lane.badId });
    return true;
  }
  try {
    const timeline = await lane.load(id);
    if (!timeline) {
      sendJson(res, 404, { error: lane.missing });
      return true;
    }
    sendJson(res, 200, timeline);
  } catch {
    // Never the raw message: store and git errors can carry paths.
    if (!res.headersSent) sendJson(res, 500, { error: lane.failed });
  }
  return true;
};
