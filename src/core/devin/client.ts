/**
 * Devin REST client (3.15). The ONLY code that talks to api.devin.ai.
 *
 * Every endpoint and field below is taken from the official v3 docs and
 * OpenAPI schema (https://docs.devin.ai/v3-openapi.yaml); each call cites its
 * page. Parsers are tolerant where the docs are loose (the create example in
 * https://docs.devin.ai/api-reference/common-flows returns only session_id,
 * url and status) and FAIL CLOSED where a wrong guess would matter: an
 * unknown status, a missing session id or a non-https URL is `unparsed`,
 * never a guessed state.
 *
 * SECRETS: the key is passed per call by the caller (which read it from
 * custody / the Keychain) and only ever placed in the Authorization header.
 * No request, header, URL or response body is logged. Error messages are
 * fixed sentences plus, at most, the API's own `detail`, scrubbed
 * (util/scrub.ts) and clipped — the key, a Bearer header or a `cog_` token
 * can never ride out in an error.
 *
 * Transport: global fetch (Node ≥ 20), injectable for tests (a fake Devin
 * server — no test ever reaches the network). Each attempt has its own
 * timeout. Idempotent reads retry on network errors, 429 and 5xx with
 * bounded exponential backoff; creating a session retries ONLY on 429 (the
 * request was refused, not processed), because a retried create after an
 * ambiguous failure could start — and bill — a second session.
 */
import { scrubSecrets } from '../util/scrub.js';
import {
  DEVIN_API_BASE_URL,
  DEVIN_ORG_ID_PATTERN,
  DEVIN_SESSION_ID_PATTERN,
  type DevinFailureCode,
  type DevinSessionStatus,
} from './types.js';

export type DevinFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface DevinClientOptions {
  /** The `cog_` key, read by the caller from custody / the Keychain. */
  apiKey: string;
  /** Base URL override for tests (default DEVIN_API_BASE_URL). */
  baseUrl?: string;
  fetch?: DevinFetch;
  /** Per-attempt timeout (default 20 s). */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures (default 2). */
  retries?: number;
  /** Backoff sleeper (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export class DevinApiError extends Error {
  readonly code: DevinFailureCode;
  readonly status: number | null;
  constructor(code: DevinFailureCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'DevinApiError';
    this.code = code;
    this.status = status;
  }
}

/** GET /v3/self — https://docs.devin.ai/api-reference/v3/self/self (ServiceUserSelf | PatUserSelf | …). */
export interface DevinSelf {
  principal: 'service_user' | 'pat_user' | 'other';
  name: string | null;
  /** null for org-scoped service users (docs: common-flows step 1) — the operator supplies it. */
  orgId: string | null;
}

/** SessionResponse, reduced to what Verse uses. https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session */
export interface DevinSession {
  sessionId: string;
  url: string;
  status: DevinSessionStatus;
  statusDetail: string | null;
  /** null when omitted (create responses may omit it — see the module header). */
  acusConsumed: number | null;
  pullRequests: Array<{ url: string; state: string | null }>;
  tags: string[];
  title: string | null;
  structuredOutput: Record<string, unknown> | null;
}

/**
 * SessionMessage (3.15, the chat seat) — GET …/sessions/{devin_id}/messages.
 * https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
 * `source` is `devin` | `user`; `created_at` is an integer whose unit the docs
 * do not state (kept as given, only for ordering).
 */
export interface DevinSessionMessage {
  eventId: string;
  source: 'devin' | 'user';
  message: string;
  createdAt: number | null;
}

/** SessionCreateRequest fields Verse sends. https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions */
export interface DevinCreateSessionInput {
  prompt: string;
  title?: string;
  /** "owner/name" repository names. */
  repos?: string[];
  tags?: string[];
  /** Hard ACU cap for the session (max_acu_limit). */
  maxAcuLimit?: number;
  /** JSON Schema (Draft 7, ≤ 64 KB, self-contained). */
  structuredOutputSchema?: Record<string, unknown>;
  /** false: the provide_structured_output tool is available, not mandatory. */
  structuredOutputRequired?: boolean;
  /** devin_mode, pinned (never `fusion`: multi-model routing has no single producer identity). */
  devinMode?: 'normal' | 'fast' | 'lite' | 'ultra';
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 8_000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_DETAIL_CHARS = 200;
const MAX_PROMPT_CHARS = 60_000;

const SESSION_STATUSES: readonly DevinSessionStatus[] = ['new', 'claimed', 'running', 'exit', 'error', 'suspended', 'resuming'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure, exported for tests)
// ---------------------------------------------------------------------------

/** GET /v3/self. principal_type is a documented const per variant; anything else is 'other'. */
export function parseDevinSelf(raw: unknown): DevinSelf | null {
  if (!isRecord(raw) || typeof raw['principal_type'] !== 'string') return null;
  const type = raw['principal_type'];
  const orgId = typeof raw['org_id'] === 'string' && DEVIN_ORG_ID_PATTERN.test(raw['org_id']) ? raw['org_id'] : null;
  if (type === 'service_user') {
    return { principal: 'service_user', name: typeof raw['service_user_name'] === 'string' ? raw['service_user_name'].slice(0, 120) : null, orgId };
  }
  if (type === 'pat_user') {
    return { principal: 'pat_user', name: typeof raw['user_name'] === 'string' ? raw['user_name'].slice(0, 120) : null, orgId };
  }
  return { principal: 'other', name: null, orgId };
}

/**
 * SessionResponse. Required by Verse: session_id (devin-…), an https url and a
 * documented status. acus_consumed / pull_requests / tags are required by the
 * schema but tolerated when absent (null / []); a present-but-wrong-typed
 * value fails the parse instead of being guessed.
 */
export function parseDevinSession(raw: unknown): DevinSession | null {
  if (!isRecord(raw)) return null;
  const sessionId = raw['session_id'];
  const url = raw['url'];
  const status = raw['status'];
  if (typeof sessionId !== 'string' || !DEVIN_SESSION_ID_PATTERN.test(sessionId)) return null;
  if (!isHttpsUrl(url)) return null;
  if (typeof status !== 'string' || !SESSION_STATUSES.includes(status as DevinSessionStatus)) return null;

  const detail = raw['status_detail'];
  if (detail !== undefined && detail !== null && typeof detail !== 'string') return null;

  const acus = raw['acus_consumed'];
  let acusConsumed: number | null = null;
  if (acus !== undefined && acus !== null) {
    if (typeof acus !== 'number' || !Number.isFinite(acus) || acus < 0) return null;
    acusConsumed = acus;
  }

  const prs = raw['pull_requests'];
  const pullRequests: DevinSession['pullRequests'] = [];
  if (prs !== undefined && prs !== null) {
    if (!Array.isArray(prs)) return null;
    for (const pr of prs.slice(0, 50)) {
      // SessionPullRequest: { pr_url: string, pr_state: string | null }.
      if (!isRecord(pr) || !isHttpsUrl(pr['pr_url'])) continue;
      pullRequests.push({ url: pr['pr_url'], state: typeof pr['pr_state'] === 'string' ? pr['pr_state'].slice(0, 40) : null });
    }
  }

  const rawTags = raw['tags'];
  const tags = Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string').slice(0, 50) : [];
  const structured = raw['structured_output'];
  return {
    sessionId,
    url,
    status: status as DevinSessionStatus,
    statusDetail: typeof detail === 'string' ? detail.slice(0, 60) : null,
    acusConsumed,
    pullRequests,
    tags,
    title: typeof raw['title'] === 'string' ? raw['title'].slice(0, 200) : null,
    structuredOutput: isRecord(structured) ? structured : null,
  };
}

/** PaginatedResponse[SessionResponse] — https://docs.devin.ai/api-reference/concepts/pagination. Unparseable items are dropped. */
export function parseDevinSessionPage(raw: unknown): { items: DevinSession[]; endCursor: string | null; hasNextPage: boolean } | null {
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return null;
  const items: DevinSession[] = [];
  for (const item of raw['items']) {
    const parsed = parseDevinSession(item);
    if (parsed) items.push(parsed);
  }
  return {
    items,
    endCursor: typeof raw['end_cursor'] === 'string' ? raw['end_cursor'] : null,
    hasNextPage: raw['has_next_page'] === true,
  };
}

const MAX_MESSAGE_CHARS = 100_000;

/**
 * PaginatedResponse[SessionMessage]. An item without an event id, a known
 * source or a string message is dropped (never guessed); a very long message
 * is clipped rather than refused, so one huge reply cannot wedge the stream.
 */
export function parseDevinMessagePage(raw: unknown): { items: DevinSessionMessage[]; endCursor: string | null; hasNextPage: boolean } | null {
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return null;
  const items: DevinSessionMessage[] = [];
  for (const item of raw['items'].slice(0, 500)) {
    if (!isRecord(item)) continue;
    const eventId = item['event_id'];
    const source = item['source'];
    const message = item['message'];
    if (typeof eventId !== 'string' || eventId === '' || eventId.length > 200) continue;
    if (source !== 'devin' && source !== 'user') continue;
    if (typeof message !== 'string') continue;
    const created = item['created_at'];
    items.push({
      eventId,
      source,
      message: message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message,
      createdAt: typeof created === 'number' && Number.isFinite(created) ? created : null,
    });
  }
  const cursor = raw['end_cursor'];
  return {
    items,
    endCursor: typeof cursor === 'string' && cursor !== '' && cursor.length <= 512 ? cursor : null,
    hasNextPage: raw['has_next_page'] === true,
  };
}

/** HTTP status → failure code (docs: overview#error-handling). */
export function failureForStatus(status: number): DevinFailureCode {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid-request';
  return 'unparsed';
}

const STATUS_SENTENCES: Record<DevinFailureCode, string> = {
  'not-enabled': 'The Devin lane is turned off.',
  'not-connected': 'Devin is not connected. Run `ashlr devin connect`.',
  auth: 'Devin refused the API key (401). It may be revoked or expired — run `ashlr devin connect` with a new key.',
  forbidden: "Devin says this key can't do that in this organization (403). Check the service user's role.",
  'rate-limited': 'Devin is rate-limiting requests (429). Try again shortly.',
  budget: 'The Devin budget refused this launch.',
  'invalid-request': 'Devin refused the request.',
  server: 'Devin had a server error. Try again shortly.',
  network: "Devin's API could not be reached.",
  unparsed: "Devin answered with something Verse doesn't recognise, so nothing was changed.",
  'session-error': 'The Devin session ended in an error.',
  unknown: 'Something went wrong talking to Devin.',
};

export function devinFailureSentence(code: DevinFailureCode): string {
  return STATUS_SENTENCES[code];
}

/** ProblemDetail.detail (RFC 9457 body), scrubbed and clipped; '' when absent. */
function problemDetail(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return '';
  }
  if (!isRecord(body) || typeof body['detail'] !== 'string') return '';
  const flat = scrubSecrets(body['detail']).replace(/\bcog_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…` : flat;
}

/** Seconds from a sane Retry-After header (≤ 60 s), else null. */
function retryAfterMs(value: string | null): number | null {
  if (!value || !/^\d{1,3}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds <= 60 ? seconds * 1000 : null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type RetryPolicy = 'read' | 'create';

export class DevinClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: DevinFetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DevinClientOptions) {
    if (typeof options?.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new DevinApiError('not-connected', STATUS_SENTENCES['not-connected']);
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEVIN_API_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as DevinFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, Math.min(5, options.retries ?? DEFAULT_RETRIES));
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Never includes the key: JSON.stringify / util.inspect of a client prints only the base URL. */
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `DevinClient(${this.baseUrl})`;
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, policy: RetryPolicy): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let lastError: DevinApiError = new DevinApiError('unknown', STATUS_SENTENCES.unknown);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      let response: Awaited<ReturnType<DevinFetch>>;
      let text: string;
      try {
        response = await this.fetchImpl(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}), signal: controller.signal });
        text = await response.text();
      } catch {
        clearTimeout(timer);
        // The error object is dropped on purpose: undici's can quote the request.
        lastError = new DevinApiError('network', STATUS_SENTENCES.network);
        if (policy === 'read') continue;
        // A create whose outcome is unknown is never retried (see the header).
        throw lastError;
      }
      clearTimeout(timer);
      if (text.length > MAX_RESPONSE_CHARS) throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed, response.status);
      if (response.status >= 200 && response.status < 300) {
        try {
          return text.trim() === '' ? null : (JSON.parse(text) as unknown);
        } catch {
          throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed, response.status);
        }
      }
      const code = failureForStatus(response.status);
      const detail = problemDetail(text);
      lastError = new DevinApiError(code, detail ? `${STATUS_SENTENCES[code]} Devin said: ${detail}` : STATUS_SENTENCES[code], response.status);
      const retryable = code === 'rate-limited' || (policy === 'read' && code === 'server');
      if (!retryable || attempt === this.retries) throw lastError;
      const wait = code === 'rate-limited' ? retryAfterMs(response.headers.get('retry-after')) : null;
      if (wait !== null) await this.sleep(wait);
    }
    throw lastError;
  }

  /** GET /v3/self — https://docs.devin.ai/api-reference/v3/self/self */
  async getSelf(): Promise<DevinSelf> {
    const parsed = parseDevinSelf(await this.request('GET', '/self', undefined, 'read'));
    if (!parsed) throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed);
    return parsed;
  }

  /** POST /v3/organizations/{org_id}/sessions — https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions */
  async createSession(orgId: string, input: DevinCreateSessionInput): Promise<DevinSession> {
    const org = checkOrg(orgId);
    if (typeof input?.prompt !== 'string' || input.prompt.trim() === '' || input.prompt.length > MAX_PROMPT_CHARS) {
      throw new DevinApiError('invalid-request', 'The Devin prompt is empty or too long.');
    }
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.title) body['title'] = input.title.slice(0, 200);
    if (input.repos && input.repos.length > 0) body['repos'] = input.repos.slice(0, 10);
    if (input.tags && input.tags.length > 0) body['tags'] = input.tags.slice(0, 50);
    if (input.maxAcuLimit !== undefined) {
      if (!Number.isInteger(input.maxAcuLimit) || input.maxAcuLimit < 1) throw new DevinApiError('invalid-request', 'The ACU cap must be a whole number of at least 1.');
      body['max_acu_limit'] = input.maxAcuLimit;
    }
    if (input.devinMode !== undefined) {
      if (!['normal', 'fast', 'lite', 'ultra'].includes(input.devinMode)) throw new DevinApiError('invalid-request', 'That Devin mode is not accepted.');
      body['devin_mode'] = input.devinMode;
    }
    if (input.structuredOutputSchema) {
      body['structured_output_schema'] = input.structuredOutputSchema;
      body['structured_output_required'] = input.structuredOutputRequired ?? false;
    }
    const parsed = parseDevinSession(await this.request('POST', `/organizations/${encodeURIComponent(org)}/sessions`, body, 'create'));
    if (!parsed) throw new DevinApiError('unparsed', 'Devin did not return a recognisable session. Check app.devin.ai before launching again.');
    return parsed;
  }

  /** GET /v3/organizations/{org_id}/sessions/{devin_id} — https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session */
  async getSession(orgId: string, sessionId: string): Promise<DevinSession> {
    const org = checkOrg(orgId);
    if (!DEVIN_SESSION_ID_PATTERN.test(sessionId)) throw new DevinApiError('invalid-request', 'That is not a Devin session id.');
    const parsed = parseDevinSession(await this.request('GET', `/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(sessionId)}`, undefined, 'read'));
    if (!parsed || parsed.sessionId !== sessionId) throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed);
    return parsed;
  }

  /** GET /v3/organizations/{org_id}/sessions?first=&after= — https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions */
  async listSessions(orgId: string, opts: { first?: number; after?: string } = {}): Promise<{ items: DevinSession[]; endCursor: string | null; hasNextPage: boolean }> {
    const org = checkOrg(orgId);
    const first = Math.min(200, Math.max(1, Math.floor(opts.first ?? 25)));
    const query = new URLSearchParams({ first: String(first) });
    if (typeof opts.after === 'string' && opts.after !== '' && opts.after.length <= 512) query.set('after', opts.after);
    const parsed = parseDevinSessionPage(await this.request('GET', `/organizations/${encodeURIComponent(org)}/sessions?${query.toString()}`, undefined, 'read'));
    if (!parsed) throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed);
    return parsed;
  }

  /**
   * POST /v3/organizations/{org_id}/sessions/{devin_id}/messages — "The session
   * will be automatically resumed if suspended."
   * https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
   */
  async sendMessage(orgId: string, sessionId: string, message: string): Promise<void> {
    const org = checkOrg(orgId);
    if (!DEVIN_SESSION_ID_PATTERN.test(sessionId)) throw new DevinApiError('invalid-request', 'That is not a Devin session id.');
    if (typeof message !== 'string' || message.trim() === '' || message.length > 20_000) throw new DevinApiError('invalid-request', 'The message is empty or too long.');
    // A message is not idempotent either: retried only on 429, like create.
    await this.request('POST', `/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(sessionId)}/messages`, { message }, 'create');
  }

  /**
   * GET /v3/organizations/{org_id}/sessions/{devin_id}/messages?after=&first=
   * (3.15, the chat seat) — chronological, cursor-paged: pass the previous
   * page's `endCursor` as `after`.
   * https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
   */
  async listMessages(orgId: string, sessionId: string, opts: { after?: string | null; first?: number } = {}): Promise<{ items: DevinSessionMessage[]; endCursor: string | null; hasNextPage: boolean }> {
    const org = checkOrg(orgId);
    const id = checkSessionId(sessionId);
    const first = Math.min(200, Math.max(1, Math.floor(opts.first ?? 100)));
    const query = new URLSearchParams({ first: String(first) });
    if (typeof opts.after === 'string' && opts.after !== '' && opts.after.length <= 512) query.set('after', opts.after);
    const parsed = parseDevinMessagePage(await this.request('GET', `/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(id)}/messages?${query.toString()}`, undefined, 'read'));
    if (!parsed) throw new DevinApiError('unparsed', STATUS_SENTENCES.unparsed);
    return parsed;
  }

  /**
   * DELETE /v3/organizations/{org_id}/sessions/{devin_id} (3.15) — terminate.
   * "A terminated session cannot be resumed." Not retried on a network error
   * (like create: the outcome is unknown, and the caller re-reads the session).
   * https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions
   */
  async terminateSession(orgId: string, sessionId: string): Promise<DevinSession | null> {
    const org = checkOrg(orgId);
    const id = checkSessionId(sessionId);
    const raw = await this.request('DELETE', `/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(id)}`, undefined, 'create');
    return parseDevinSession(raw);
  }
}

function checkSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !DEVIN_SESSION_ID_PATTERN.test(sessionId)) throw new DevinApiError('invalid-request', 'That is not a Devin session id.');
  return sessionId;
}

function checkOrg(orgId: string): string {
  if (typeof orgId !== 'string' || !DEVIN_ORG_ID_PATTERN.test(orgId)) {
    throw new DevinApiError('not-connected', 'No Devin organization id is set. Run `ashlr devin connect --org <org-…>`.');
  }
  return orgId;
}
