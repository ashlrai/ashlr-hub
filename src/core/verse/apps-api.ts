/**
 * core/verse/apps-api.ts — `/api/verse/apps*` (unit C6, SPEC-310C §4),
 * mounted by verse-api.ts's workbench table (C0) by prefix.
 *
 *   GET  /api/verse/apps                 → VerseAppsResponse (cached; stale-while-revalidate)
 *   POST /api/verse/apps/refresh     {}  → VerseAppsResponse (re-asks the login shell, re-probes)
 *   POST /api/verse/apps/:id/toggle  { enabled, confirm: true }
 *        → 202 { ok, opened: 'terminal-app', command } — opens the switch's own
 *          command in Terminal; anything but `confirm: true` is a 400
 *   POST /api/verse/apps/:id/launch  { root, via?, model? }
 *        → 202 { ok, opened: 'terminal-app', command } — the agent (or
 *          `ollama launch <id> [--model <tag>]`) in Terminal, in `root`
 *
 * GROUPS. This route answers DESKTOP, TERMINAL AGENTS and LOCAL MODELS — the
 * facts nothing else serves. The page composes ACCOUNTS from `/api/verse/seats`
 * (via bootstrap), `/api/verse/health` and `/api/verse/budget`, and MCP SERVERS
 * from `/api/verse/mcp`: those reads already exist, are already cached by the
 * other surfaces, and a server-side copy here would be a fourth description
 * of the same seat (research r5/audit.md #9 — the duplication this page was
 * asked to remove).
 *
 * SECURITY. Every non-GET already passed verse-api.ts's dispatch + mutation
 * gate (constant-time token, JSON content type) before this module loads; the
 * checks here are the route's own: strict bodies (an unknown key is a 400),
 * ids from the fixed catalog only, a root that is a chat folder or a
 * discovered project AND passes checkWorkspaceRootPath, a model that is an
 * installed Ollama tag. Nothing here spends: status commands and loopback
 * GETs only, and Launch/toggle open a visible Terminal the operator drives.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../web/api.js';
import { resolveLlamaServerOrigin } from '../local-runtime/llama/config.js';
import type { AshlrConfig } from '../types.js';
import type { ApiModule } from './api-modules.js';
import {
  createAppsService,
  defaultAppsDeps,
  getAppsService,
  lastLocalThroughput,
  setAppsService,
  type AppLaunchVia,
  type AppsActionResult,
  type AppsService,
} from './apps.js';
import { checkWorkspaceRootPath } from './path-guard.js';
import { discoverProjects } from './projects.js';
import { resolveOllamaBaseUrl } from './seats.js';
import { peekVerseEngine } from './verse-api.js';
import { VERSE_APPS_PATH } from './workbench-types.js';

export const VERSE_APPS_REFRESH_PATH = `${VERSE_APPS_PATH}/refresh`;
const APP_ACTION_RE = /^\/api\/verse\/apps\/([a-z0-9][a-z0-9-]{0,63})\/(toggle|launch)$/;

function ensureService(cfg: AshlrConfig): AppsService {
  const existing = getAppsService();
  if (existing) return existing;
  let llamaServerBaseUrl: string | undefined;
  try {
    llamaServerBaseUrl = resolveLlamaServerOrigin(cfg);
  } catch {
    llamaServerBaseUrl = undefined;
  }
  const created = createAppsService(defaultAppsDeps({
    ollamaBaseUrl: resolveOllamaBaseUrl(cfg),
    ...(llamaServerBaseUrl ? { llamaServerBaseUrl } : {}),
    // peek, never create: the Apps page must not be what boots the chat engine.
    localThroughput: () => {
      const engine = peekVerseEngine();
      if (!engine) return null;
      return lastLocalThroughput(engine.listSessions(), (id) => engine.getEvents(id));
    },
    allowedRoots: () => {
      const sessions = peekVerseEngine()?.listSessions() ?? [];
      const roots = new Set<string>();
      for (const s of sessions) {
        roots.add(s.projectPath);
        for (const extra of s.extraRoots ?? []) roots.add(extra);
      }
      for (const p of discoverProjects({ sessions })) roots.add(p.path);
      return [...roots];
    },
    checkRoot: (raw) => checkWorkspaceRootPath(raw),
  }));
  setAppsService(created);
  return created;
}

/**
 * Collect the Apps snapshot in the background, so the first GET
 * /api/verse/apps is served from a finished (or in-flight, coalesced)
 * collect instead of paying the cold one — the login-shell PATH probe and
 * the version reads measured 1.35–1.8 s on the operator's Mac (and 5.7 s
 * under load). Called once by the long-lived servers (`ashlr verse`,
 * `ashlr serve`) shortly after they bind; never by a route, never in tests.
 * It runs status commands and loopback GETs only (apps.ts WHAT IT COSTS) and
 * never throws.
 */
export function warmVerseApps(cfg: AshlrConfig): Promise<void> {
  try {
    return ensureService(cfg).snapshot().then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}

async function readStrictBody(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid JSON body' });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'body must be a JSON object' });
    return null;
  }
  const unknown = Object.keys(parsed).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown field: ${unknown[0]!.slice(0, 64)}` });
    return null;
  }
  return parsed as Record<string, unknown>;
}

function sendAction(res: ServerResponse, result: AppsActionResult): void {
  if (result.ok) sendJson(res, result.status, result.body);
  else sendJson(res, result.status, { code: result.code, error: result.error });
}

/**
 * The route module. True for every `/api/verse/apps*` path (the prefix is
 * this family's alone), false for anything else.
 */
export const handleAppsApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_APPS_PATH && !path.startsWith(`${VERSE_APPS_PATH}/`)) return false;
  const service = ensureService(ctx.cfg);

  if (path === VERSE_APPS_PATH) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    sendJson(res, 200, await service.get());
    return true;
  }

  if (path === VERSE_APPS_REFRESH_PATH) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const body = await readStrictBody(req, res, []);
    if (!body) return true;
    sendJson(res, 200, await service.refresh());
    return true;
  }

  const match = APP_ACTION_RE.exec(path);
  if (!match) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
    return true;
  }
  const [, appId, verb] = match;

  if (verb === 'toggle') {
    const body = await readStrictBody(req, res, ['enabled', 'confirm']);
    if (!body) return true;
    // `confirm: true` is the page's statement that the operator saw both
    // commands; a body without it never changes another app's settings.
    if (body['confirm'] !== true) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'confirm must be true' });
      return true;
    }
    if (typeof body['enabled'] !== 'boolean') {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'enabled must be a boolean' });
      return true;
    }
    sendAction(res, await service.toggle(appId!, body['enabled']));
    return true;
  }

  const body = await readStrictBody(req, res, ['root', 'via', 'model']);
  if (!body) return true;
  const root = body['root'];
  if (typeof root !== 'string' || root.length === 0 || root.length > 4096) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'root must be a folder path' });
    return true;
  }
  const via = body['via'];
  if (via !== undefined && via !== 'native' && via !== 'ollama') {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: "via must be 'native' or 'ollama'" });
    return true;
  }
  const model = body['model'];
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length === 0 || model.length > 128)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'model must be an Ollama tag' });
    return true;
  }
  sendAction(res, await service.launch(appId!, {
    root,
    ...(via !== undefined ? { via: via as AppLaunchVia } : {}),
    model: typeof model === 'string' ? model : null,
  }));
  return true;
};
