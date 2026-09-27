/**
 * Automations API (3.15) — mounted by verse-api.ts as the `automations`
 * workbench family.
 *
 *   GET  /api/verse/automations                         → AutomationsOverviewResponse
 *   GET  /api/verse/automations/journal                 → { entries } (newest last, ≤ 200)
 *   POST /api/verse/automations                         AutomationInput → 201 { automation }
 *   POST /api/verse/automations/<id>                    Partial<AutomationInput> → { automation }
 *   POST /api/verse/automations/<id>/enable|disable     {} → { automation }
 *   POST /api/verse/automations/<id>/delete             {} → { ok }
 *   POST /api/verse/automations/<id>/fire               AutomationFireRequest → AutomationFireResponse
 *   POST /api/verse/automations/<id>/webhook            AutomationWebhookRequest → { ok, firing, deduped }
 *   POST /api/verse/automations/firings/<fid>/approve   {} → { ok, firing }   (leader-review)
 *   POST /api/verse/automations/firings/<fid>/reject    {} → { ok, firing }
 *
 * THE WEBHOOK IS LOCAL-ONLY. There is no public inbound endpoint: the Verse
 * server listens on 127.0.0.1 with a Host allow-list, and this route also
 * refuses any non-loopback peer. A caller (n8n, a Linear bridge on this Mac)
 * needs the same mutation token as the UI.
 *
 * Posture matches every Verse route: GETs behind the read session; a POST is
 * 404 unless dispatch is allowed, then the constant-time mutation token +
 * JSON gate, then a bounded, STRICT body (unknown keys are 400s). All I/O is
 * async (scripts/check-verse-sync-io.mjs); GETs read disk only — polling and
 * dispatch happen on the scheduler's timer, or on an explicit POST.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import {
  AUTOMATION_FIRING_ID_PATTERN,
  AUTOMATION_ID_PATTERN,
  AutomationInputError,
  automationsOverview,
  createAutomation,
  deleteAutomation,
  disableAutomation,
  enableAutomation,
  fireAutomation,
  readAutomationJournal,
  receiveWebhook,
  reviewFiring,
  updateAutomation,
  VERSE_AUTOMATIONS_PATH,
  type AutomationEngineDeps,
} from '../automations/index.js';
import { refreshAutomationsNeedsYou } from '../automations/needs-you.js';
import { automationsSchedulerRunning } from '../automations/scheduler.js';

const DEFINITION_BODY_MAX = 32 * 1024;
const SMALL_BODY_MAX = 4 * 1024;
const WEBHOOK_BODY_MAX = 32 * 1024;

const DEFINITION_KEYS = [
  'id', 'name', 'enabled', 'trigger', 'lane', 'playbookId', 'repos', 'instructions',
  'maxConcurrent', 'maxPerDay', 'queueDepth', 'spendCapUsd', 'dedupeKey', 'triage',
] as const;
const FIRE_KEYS = ['dryRun', 'repo', 'title', 'text'] as const;
const WEBHOOK_KEYS = ['repo', 'title', 'text', 'key', 'url'] as const;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface AutomationsApiDeps {
  engine?: AutomationEngineDeps;
  schedulerRunning?: () => boolean;
  /** Tests: bypass the socket-address check (supertest-style fakes). */
  isLoopback?: (req: IncomingMessage) => boolean;
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function sendNotFound(res: ServerResponse, what: string): void {
  sendJson(res, 404, { error: `not found: ${what}` });
}

function hasNoQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key.slice(0, 64)}`);
    return false;
  }
  return true;
}

async function readMutationBody(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  if (!hasNoQuery(req, res)) return null;
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown key: ${key.slice(0, 64)}`);
      return null;
    }
  }
  return parsed as Record<string, unknown>;
}

const defaultIsLoopback = (req: IncomingMessage): boolean => LOOPBACK.has(req.socket?.remoteAddress ?? '');

function optionalString(body: Record<string, unknown>, key: string): string | undefined | null {
  const v = body[key];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : null;
}

export function createAutomationsApi(deps: AutomationsApiDeps = {}): ApiModule {
  const engine = deps.engine ?? {};
  const schedulerRunning = deps.schedulerRunning ?? automationsSchedulerRunning;
  const isLoopback = deps.isLoopback ?? defaultIsLoopback;

  return async (ctx, req, res, p, method) => {
    if (p !== VERSE_AUTOMATIONS_PATH && !p.startsWith(`${VERSE_AUTOMATIONS_PATH}/`)) return false;
    try {
      // ── GET /api/verse/automations ───────────────────────────────────────
      if (p === VERSE_AUTOMATIONS_PATH && method === 'GET') {
        if (!hasNoQuery(req, res)) return true;
        sendJson(res, 200, await automationsOverview({ schedulerRunning: schedulerRunning(), ...(engine.now ? { now: engine.now() } : {}) }));
        return true;
      }
      if (p === `${VERSE_AUTOMATIONS_PATH}/journal` && method === 'GET') {
        if (!hasNoQuery(req, res)) return true;
        sendJson(res, 200, { entries: await readAutomationJournal(200) });
        return true;
      }
      if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);

      // ── POST /api/verse/automations (create) ─────────────────────────────
      if (p === VERSE_AUTOMATIONS_PATH) {
        const body = await readMutationBody(ctx, req, res, DEFINITION_KEYS, DEFINITION_BODY_MAX);
        if (!body) return true;
        const automation = await createAutomation(body);
        sendJson(res, 201, { automation });
        return true;
      }

      const rest = p.slice(VERSE_AUTOMATIONS_PATH.length + 1).split('/');

      // ── POST /api/verse/automations/firings/<fid>/(approve|reject) ───────
      if (rest[0] === 'firings') {
        const [, fid, verb, extra] = rest;
        if (!fid || !AUTOMATION_FIRING_ID_PATTERN.test(fid) || (verb !== 'approve' && verb !== 'reject') || extra !== undefined) {
          return (sendNotFound(res, `${method} ${p}`), true);
        }
        const body = await readMutationBody(ctx, req, res, [], SMALL_BODY_MAX);
        if (!body) return true;
        const result = await reviewFiring(fid, verb, engine);
        await refreshAutomationsNeedsYou();
        if (!result.ok) {
          sendJson(res, result.status, { code: 'VERSE_REFUSED', error: result.error });
          return true;
        }
        sendJson(res, 200, { ok: true, firing: result.firing });
        return true;
      }

      const [id, verb, extra] = rest;
      if (!id || !AUTOMATION_ID_PATTERN.test(id) || extra !== undefined) return (sendNotFound(res, `${method} ${p}`), true);

      // ── POST /api/verse/automations/<id> (update) ────────────────────────
      if (verb === undefined) {
        const body = await readMutationBody(ctx, req, res, DEFINITION_KEYS, DEFINITION_BODY_MAX);
        if (!body) return true;
        const automation = await updateAutomation(id, body);
        if (!automation) return (sendNotFound(res, `automation ${id}`), true);
        sendJson(res, 200, { automation });
        return true;
      }

      switch (verb) {
        case 'enable':
        case 'disable': {
          const body = await readMutationBody(ctx, req, res, [], SMALL_BODY_MAX);
          if (!body) return true;
          const automation = verb === 'enable' ? await enableAutomation(id) : await disableAutomation(id);
          if (!automation) return (sendNotFound(res, `automation ${id}`), true);
          sendJson(res, 200, { automation });
          return true;
        }
        case 'delete': {
          const body = await readMutationBody(ctx, req, res, [], SMALL_BODY_MAX);
          if (!body) return true;
          const ok = await deleteAutomation(id);
          if (!ok) return (sendNotFound(res, `automation ${id}`), true);
          await refreshAutomationsNeedsYou();
          sendJson(res, 200, { ok: true });
          return true;
        }
        case 'fire': {
          const body = await readMutationBody(ctx, req, res, FIRE_KEYS, WEBHOOK_BODY_MAX);
          if (!body) return true;
          if (body['dryRun'] !== undefined && typeof body['dryRun'] !== 'boolean') return (sendInvalid(res, 'dryRun must be true or false'), true);
          const repo = optionalString(body, 'repo');
          const title = optionalString(body, 'title');
          const text = optionalString(body, 'text');
          if (repo === null || title === null || text === null) return (sendInvalid(res, 'repo, title and text must be text'), true);
          const result = await fireAutomation(id, {
            ...(body['dryRun'] === true ? { dryRun: true } : {}),
            ...(repo !== undefined ? { repo } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(text !== undefined ? { text } : {}),
          }, engine);
          await refreshAutomationsNeedsYou();
          sendJson(res, result.ok ? 200 : 409, result);
          return true;
        }
        case 'webhook': {
          if (!isLoopback(req)) {
            sendJson(res, 403, { error: 'The automations webhook only answers on this Mac (loopback).' });
            return true;
          }
          const body = await readMutationBody(ctx, req, res, WEBHOOK_KEYS, WEBHOOK_BODY_MAX);
          if (!body) return true;
          const text = optionalString(body, 'text');
          if (typeof text !== 'string') return (sendInvalid(res, 'text is required'), true);
          for (const key of ['repo', 'title', 'key', 'url'] as const) {
            if (optionalString(body, key) === null) return (sendInvalid(res, `${key} must be text`), true);
          }
          const result = await receiveWebhook(id, {
            text,
            ...(typeof body['repo'] === 'string' ? { repo: body['repo'] } : {}),
            ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
            ...(typeof body['key'] === 'string' ? { key: body['key'] } : {}),
            ...(typeof body['url'] === 'string' ? { url: body['url'] } : {}),
          }, engine);
          await refreshAutomationsNeedsYou();
          sendJson(res, result.status, { ok: result.ok, firing: result.firing, deduped: result.deduped, error: result.error });
          return true;
        }
        default:
          return (sendNotFound(res, `${method} ${p}`), true);
      }
    } catch (err) {
      if (err instanceof AutomationInputError) {
        if (!res.headersSent) sendInvalid(res, err.message);
        return true;
      }
      // Never the raw message: store errors can carry paths.
      if (!res.headersSent) sendJson(res, 500, { error: 'automations request failed' });
      return true;
    }
  };
}

export const handleAutomationsApi: ApiModule = createAutomationsApi();
