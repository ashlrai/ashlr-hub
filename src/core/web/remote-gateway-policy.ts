/**
 * Policy for the opt-in phone gateway. It is separate from the Hub server:
 * a remote browser must never reach the local token prompt, desktop assets,
 * or the general /api/* router.
 */
import { timingSafeEqual } from 'node:crypto';

export interface RemoteRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export type RemoteReadRoute = string;

const READ_ROUTES = new Set<RemoteReadRoute>([
  '/api/verse/bootstrap',
  '/api/verse/activity',
  '/api/verse/sessions',
  '/api/verse/control',
  '/api/verse/fleet/live',
  '/api/verse/authority',
  '/api/verse/budget',
  '/api/verse/seats',
  '/api/verse/session-meta',
  '/api/verse/cloud',
  '/api/verse/leader',
  '/api/verse/leader/directives',
  '/api/verse/cloud/previews',
  '/api/verse/devin/previews',
]);

export type RemoteRouteDecision =
  | { kind: 'read' | 'stream'; path: RemoteReadRoute }
  | { kind: 'write'; path: string; stepUp: boolean }
  | { kind: 'deny' };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHECKPOINT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROOT_ID = /^[0-9a-f]{8,64}$/;
const THREAD_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const ACTION_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const PROPOSAL_ID = /^[A-Za-z0-9._-]{1,160}$/;
const CLOUD_TASK_ID = /^ct_\d{8}T\d{4}_[a-z0-9]{6}$/;
const DEVIN_TASK_ID = /^dv_\d{8}T\d{4}_[a-z0-9]{6}$/;
const AGENT_ID = /^ag_[a-z0-9]{8,32}$/;
const QUEUE_ID = /^[0-9a-f]{12}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function exactParams(params: URLSearchParams, shape: Record<string, (value: string) => boolean>): boolean {
  const keys = [...params.keys()];
  return keys.length === Object.keys(shape).length
    && keys.every((key) => shape[key]?.(params.get(key) ?? '') === true && params.getAll(key).length === 1);
}

function safeFile(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..')
    && ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** Every path and query shape here is reviewed separately; no general /api/* proxy. */
export function classifyRemoteRoute(method: string | undefined, rawTarget: string | undefined): RemoteRouteDecision {
  if (!rawTarget || !rawTarget.startsWith('/') || rawTarget.length > 2048) return { kind: 'deny' };
  // Reject alternate URL spellings before URL normalization can hide them.
  const [path, query, ...rest] = rawTarget.split('?');
  if (!path || rest.length > 0 || /[#%\\]/.test(path) || rawTarget.includes('#') || path.includes('//')
    || [...rawTarget].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return { kind: 'deny' };
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return { kind: 'deny' };
  if (method === 'POST' || method === 'DELETE') {
    if (query !== undefined) return { kind: 'deny' };
    if (method === 'DELETE' && /^\/api\/verse\/leader\/directives\/[^/]+$/.test(path)
      && ACTION_ID.test(path.slice('/api/verse/leader/directives/'.length))) return { kind: 'write', path, stepUp: true };
    if (method !== 'POST') return { kind: 'deny' };
    if (path === '/api/verse/activity/seen' || path === '/api/verse/sessions'
      || path === '/api/verse/leader/thread' || path === '/api/verse/leader/directives') return { kind: 'write', path, stepUp: false };
    if (path === '/api/verse/daemon' || path === '/api/verse/budget' || path === '/api/verse/authority'
      || path === '/api/verse/fleet/live'
      || path === '/api/verse/leader') return { kind: 'write', path, stepUp: true };
    const inbox = /^\/api\/inbox\/([^/]+)\/(approve|reject)$/.exec(path);
    if (inbox && PROPOSAL_ID.test(inbox[1]!)) return { kind: 'write', path, stepUp: true };
    const task = /^\/api\/verse\/(cloud|devin)\/tasks\/([^/]+)\/(land|close|update-branch|dismiss)$/.exec(path);
    if (task && (task[1] === 'cloud' ? CLOUD_TASK_ID : DEVIN_TASK_ID).test(task[2]!)) {
      return { kind: 'write', path, stepUp: task[3] !== 'dismiss' };
    }
    const sessionAction = /^\/api\/verse\/sessions\/([^/]+)\/(turns|cancel|terminate)$/.exec(path);
    if (sessionAction && SESSION_ID.test(sessionAction[1]!)) {
      return { kind: 'write', path, stepUp: sessionAction[2] !== 'turns' };
    }
    const queue = /^\/api\/verse\/queue\/([^/]+)$/.exec(path);
    if (queue && SESSION_ID.test(queue[1]!)) return { kind: 'write', path, stepUp: false };
    const heldQueue = /^\/api\/verse\/queue\/([^/]+)\/([^/]+)\/send$/.exec(path);
    if (heldQueue && SESSION_ID.test(heldQueue[1]!) && QUEUE_ID.test(heldQueue[2]!)) {
      return { kind: 'write', path, stepUp: true };
    }
    const agentPlan = /^\/api\/verse\/agents\/([^/]+)\/plan$/.exec(path);
    if (agentPlan && AGENT_ID.test(agentPlan[1]!)) return { kind: 'write', path, stepUp: true };
    const leaderQuestion = /^\/api\/verse\/leader\/questions\/([^/]+)\/answer$/.exec(path);
    if (leaderQuestion && ACTION_ID.test(leaderQuestion[1]!)) return { kind: 'write', path, stepUp: false };
    const leaderApproval = /^\/api\/verse\/leader\/actions\/([^/]+)\/approve$/.exec(path);
    if (leaderApproval && ACTION_ID.test(leaderApproval[1]!)) return { kind: 'write', path, stepUp: true };
    return { kind: 'deny' };
  }
  if (method !== 'GET') return { kind: 'deny' };
  if (query === undefined && READ_ROUTES.has(path)) return { kind: 'read', path };
  if (/^\/api\/verse\/sessions\/([^/]+)$/.test(path) && query === undefined) {
    const id = path.slice('/api/verse/sessions/'.length);
    if (SESSION_ID.test(id)) return { kind: 'read', path };
  }
  if (query === undefined) return { kind: 'deny' };
  const params = new URLSearchParams(query);
  if (path === '/api/verse/authority/ledger'
    && exactParams(params, { view: (v) => v === 'decisions', limit: (v) => v === '40' })) return { kind: 'read', path };
  if (path === '/api/verse/leader/thread' && (
    exactParams(params, { limit: (v) => v === '50' })
    || exactParams(params, { limit: (v) => v === '50', before: (v) => THREAD_ID.test(v) })
  )) return { kind: 'read', path };
  if (path === '/api/verse/checkpoints'
    && exactParams(params, { chatId: (v) => CHECKPOINT_ID.test(v) })) return { kind: 'read', path };
  if (path === '/api/verse/checkpoints/diff') {
    const shape = {
      chatId: (v: string) => CHECKPOINT_ID.test(v),
      turnId: (v: string) => CHECKPOINT_ID.test(v),
      rootId: (v: string) => ROOT_ID.test(v),
      mode: (v: string) => v === 'since' || v === 'turn',
    };
    if (exactParams(params, shape) || exactParams(params, { ...shape, file: safeFile })) return { kind: 'read', path };
  }
  if (path === '/api/events' && exactParams(params, { topics: (v) => v === 'verse-sessions' })) return { kind: 'stream', path };
  const tail = /^\/api\/verse\/sessions\/([^/]+)\/events$/.exec(path);
  if (tail && SESSION_ID.test(tail[1]!) && (
    params.size === 0 || exactParams(params, { after: (v) => /^\d{1,15}$/.test(v) })
  )) return { kind: 'stream', path };
  return { kind: 'deny' };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max && !value.includes('\0');
}

/** Exact body shapes, before the gateway adds its server-side local credential. */
export function validateRemoteMutation(decision: RemoteRouteDecision, body: unknown): boolean {
  if (decision.kind !== 'write') return false;
  const { path } = decision;
  if (/^\/api\/verse\/leader\/directives\/[^/]+$/.test(path)) return body === undefined || (record(body) && Object.keys(body).length === 0);
  if (!record(body)) return false;
  if (path === '/api/verse/activity/seen') return keys(body, ['sessionId', 'turnCount'])
    && typeof body.sessionId === 'string' && SESSION_ID.test(body.sessionId)
    && Number.isSafeInteger(body.turnCount) && (body.turnCount as number) >= 0;
  if (path === '/api/verse/sessions') return keys(body, ['projectPath', 'seatId', 'model'])
    && boundedText(body.projectPath, 1024) && boundedText(body.seatId, 128)
    && (body.model === undefined || boundedText(body.model, 128));
  if (path === '/api/verse/daemon') return keys(body, ['action'])
    && typeof body.action === 'string' && ['start', 'stop', 'pause', 'resume'].includes(body.action);
  if (path === '/api/verse/budget') return keys(body, ['mode'])
    && typeof body.mode === 'string' && ['all-in', 'balanced', 'reserve'].includes(body.mode);
  if (path === '/api/verse/authority') return (keys(body, ['action']) && body.action === 'stop')
    || (keys(body, ['action', 'to']) && body.action === 'switch'
      && typeof body.to === 'string' && ['off', 'propose', 'autonomous'].includes(body.to));
  if (path === '/api/verse/fleet/live') return keys(body, ['action', 'repo', 'kind'])
    && body.action === 'resume-repo' && typeof body.repo === 'string' && REPO.test(body.repo)
    && (body.kind === undefined || (typeof body.kind === 'string'
      && ['quarantine', 'owner-hold', 'leader-pause', 'cooldown'].includes(body.kind)));
  if (path === '/api/verse/leader') return (keys(body, ['action', 'actionId'])
    && body.action === 'veto' && boundedText(body.actionId, 128))
    || (keys(body, ['action', 'itemId']) && body.action === 'dismiss' && boundedText(body.itemId, 256));
  if (path === '/api/verse/leader/thread') return keys(body, ['text', 'replyTo'])
    && boundedText(body.text, 16_384)
    && (body.replyTo === undefined || (typeof body.replyTo === 'string' && THREAD_ID.test(body.replyTo)));
  if (path === '/api/verse/leader/directives') return keys(body, ['text']) && boundedText(body.text, 2_048);
  if (/^\/api\/inbox\/[^/]+\/(approve|reject)$/.test(path)
    || /^\/api\/verse\/leader\/actions\/[^/]+\/approve$/.test(path)
    || /^\/api\/verse\/sessions\/[^/]+\/cancel$/.test(path)) return keys(body, []) && Object.keys(body).length === 0;
  if (/^\/api\/verse\/sessions\/[^/]+\/terminate$/.test(path)) return keys(body, ['confirm']) && body.confirm === true;
  const task = /^\/api\/verse\/(cloud|devin)\/tasks\/[^/]+\/(land|close|update-branch|dismiss)$/.exec(path);
  if (task) {
    if (task[2] === 'dismiss') return keys(body, []) && Object.keys(body).length === 0;
    return keys(body, task[2] === 'close' ? ['headSha', 'reason'] : ['headSha'])
      && typeof body.headSha === 'string' && HEAD_SHA.test(body.headSha)
      && (body.reason === undefined || (task[2] === 'close' && boundedText(body.reason, 200)));
  }
  if (/^\/api\/verse\/sessions\/[^/]+\/turns$/.test(path)
    || /^\/api\/verse\/leader\/questions\/[^/]+\/answer$/.test(path)) return keys(body, ['text']) && boundedText(body.text, 64_000);
  if (/^\/api\/verse\/agents\/[^/]+\/plan$/.test(path)) return keys(body, ['action'])
    && (body.action === 'approve' || body.action === 'discard');
  if (/^\/api\/verse\/queue\/[^/]+\/[^/]+\/send$/.test(path)) return Object.keys(body).length === 0;
  if (/^\/api\/verse\/queue\/[^/]+$/.test(path)) return keys(body, ['text', 'sendNow'])
    && boundedText(body.text, 64_000) && (body.sendNow === undefined || typeof body.sendNow === 'boolean');
  return false;
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RemoteEnvelopeDecision = { ok: true } | { ok: false; reason: 'host' | 'origin' | 'csrf' | 'hub-token' };

/**
 * Check the public origin before dispatch. `csrfSecret` will come from a paired
 * device's server-side session; leaving it absent denies every unsafe method.
 */
export function checkRemoteEnvelope(
  request: RemoteRequest,
  publicOrigin: string,
  csrfSecret?: string,
): RemoteEnvelopeDecision {
  let expected: URL;
  try { expected = new URL(publicOrigin); } catch { return { ok: false, reason: 'host' }; }
  if (expected.protocol !== 'https:' || expected.origin !== publicOrigin || !expected.hostname) return { ok: false, reason: 'host' };
  if (oneHeader(request.headers.host) !== expected.host) return { ok: false, reason: 'host' };
  // Hub's local read/mutation credentials are never valid on a remote request.
  if (request.headers['x-ashlr-token'] !== undefined || request.headers['x-ashlr-read-client'] !== undefined) {
    return { ok: false, reason: 'hub-token' };
  }
  const origin = request.headers.origin;
  if (origin !== undefined && oneHeader(origin) !== publicOrigin) return { ok: false, reason: 'origin' };
  if (request.method === 'GET' || request.method === 'HEAD') return { ok: true };
  if (origin === undefined || oneHeader(origin) !== publicOrigin) return { ok: false, reason: 'origin' };
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && oneHeader(site) !== 'same-origin') return { ok: false, reason: 'origin' };
  const proof = oneHeader(request.headers['x-ashlr-remote-csrf']);
  if (!csrfSecret || !proof || !equalSecret(proof, csrfSecret)) return { ok: false, reason: 'csrf' };
  return { ok: true };
}
