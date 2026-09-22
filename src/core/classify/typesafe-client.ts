/**
 * classify/typesafe-client.ts — typed client for the TypeSafe AI ("Jev")
 * System One decision model.
 *
 * WHAT JEV IS: you POST some state plus a bag of typed questions and get back,
 * per question, an answer AND a separate calibrated confidence. The framing
 * that matters here is: *the answer tells you what, the confidence tells you
 * whether to act on it.* Callers gate on confidence and fall back to their own
 * deterministic implementation below it — see docs/JEV-INTEGRATION.md.
 *
 * DESIGN RULES (all from the integration contract, all load-bearing):
 *
 *   1. NEVER A HARD DEPENDENCY. This module never throws into a caller. Every
 *      failure mode — unkeyed, disabled, offline, timed out, throttled, 5xx,
 *      garbage body — returns a typed `{ ok: false, reason }` result so the
 *      call site can use its deterministic path. The hub is local-first and
 *      must work with no network at all; a classifier outage may degrade
 *      accuracy, never availability.
 *   2. ONE CALL, MANY QUESTIONS. The API is priced and shaped per request, not
 *      per question, so `askTypeSafe` takes a question *map*. Prefer one call
 *      with N questions over N calls.
 *   3. NO RETRIES. A classifier is an optimisation; retrying one against a
 *      provider that just said 429 only deepens the hole. A throttled call
 *      returns `reason: 'rate-limited'` (with `retryAfterMs` when the provider
 *      supplied it) and the caller falls back immediately.
 *   4. HARD TIMEOUT + BOUNDED BODY. A deadline the caller cannot exceed, and a
 *      byte ceiling on the response so a pathological body cannot balloon
 *      memory. Both mirror `run/provider-client.ts`.
 *   5. NO SECRET EVER LEAVES THIS MODULE. The key is resolved on demand through
 *      `resolveProviderKey` (phantom vault wins when installed, else
 *      `process.env.TYPESAFE_API_KEY`), used for exactly one Authorization
 *      header, and never returned, cached, or written to a result field. No
 *      result string in this file is built from the key.
 *
 * WIRE FORMAT is documented in docs/JEV-INTEGRATION.md and verified live. The
 * one trap worth repeating: `criteria` is FLAT on the question object, NOT
 * nested under a `choice` key — the validator's error path mentions the union
 * variant name and reads as though it should be nested. It should not.
 *
 * No new runtime dependency: there is no TypeSafe SDK vendored in this repo and
 * none resolvable offline, and the hub ships a deliberately tiny dependency
 * set, so this speaks the documented REST shape over `fetch` directly.
 */

import type { AshlrConfig } from '../types.js';
import { resolveProviderKey } from '../integrations/secrets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var holding the credential. Resolved via phantom first — never read raw. */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

/** Set to "1"/"true" to hard-disable every classifier call process-wide. */
export const TYPESAFE_DISABLE_ENV = 'ASHLR_CLASSIFY_DISABLE';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * 8s. Every approved call site fires only after something has already failed
 * and is about to fall back to a deterministic answer anyway, so the cost of
 * waiting is a slightly later retry, not a slower happy path. Measured live
 * latency for a two-question call is ~0.4s, so 8s is ~20x headroom while still
 * bounding how long a failure path can stall — rule 4 of the contract ("do not
 * let it delay a retry unboundedly").
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Response ceiling. A System One answer set is hundreds of bytes; 256 KiB is
 *  pure paranoia against a misrouted or hostile body. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Ceiling on the `state` we send. Engine stderr can be megabytes (a crashing
 * model can print a whole context window). Sending it all would be slow and
 * expensive for zero accuracy gain — the signal in a stderr blob is at the head
 * and the tail. Budget-awareness is rule 5 of the contract.
 */
const MAX_STATE_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Question / answer types
// ---------------------------------------------------------------------------

export type TypeSafeModel = 'jev-latest' | 'jev-preview';

/** Pick exactly one label. `criteria` maps label -> when that label applies. */
export interface TypeSafeChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  /** FLAT on the question — not nested under a `choice` key. See module docs. */
  readonly criteria: Readonly<Record<string, string>>;
}

/** Rate on a numeric scale. */
export interface TypeSafeScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly min?: number;
  readonly max?: number;
}

/** A yes/no question answered as a probability in [0, 1]. */
export interface TypeSafeNoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

export type TypeSafeQuestion =
  | TypeSafeChoiceQuestion
  | TypeSafeScoreQuestion
  | TypeSafeNoulQuestion;

export interface TypeSafeChoiceAnswer<K extends string = string> {
  readonly type: 'choice';
  readonly choice: K;
  /** Calibrated in [0, 1]. This is the gate — not the top probability. */
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface TypeSafeScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly confidence: number;
}

export interface TypeSafeNoulAnswer {
  readonly type: 'noul';
  /** Probability the answer is "yes", in [0, 1]. */
  readonly noul: number;
}

export type TypeSafeAnswer = TypeSafeChoiceAnswer | TypeSafeScoreAnswer | TypeSafeNoulAnswer;

export interface TypeSafeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// ---------------------------------------------------------------------------
// Result types — never an exception, always one of these
// ---------------------------------------------------------------------------

/**
 * Why the classifier could not answer. Callers branch on this only for
 * observability; for control flow, `ok: false` alone means "use your
 * deterministic path".
 */
export type TypeSafeUnavailableReason =
  /** No credential resolvable (phantom vault empty and env unset). */
  | 'no-key'
  /** Turned off by env, or the caller passed an empty question set. */
  | 'disabled'
  /** Deadline hit, or the caller's signal aborted. */
  | 'timeout'
  /** DNS/connect/TLS failure — i.e. offline. */
  | 'network'
  /** HTTP 429 (or 503 with Retry-After). Never retried here. */
  | 'rate-limited'
  /** Any other non-2xx. */
  | 'http-error'
  /** 2xx whose body was not a well-formed answer set. */
  | 'malformed-response'
  /** Body exceeded MAX_RESPONSE_BYTES. */
  | 'oversized-response';

export interface TypeSafeOk {
  readonly ok: true;
  /** Concrete model id the service answered with, e.g. "jev-1.13.0". */
  readonly model: string;
  readonly answers: Readonly<Record<string, TypeSafeAnswer>>;
  readonly usage?: TypeSafeUsage;
  readonly durationMs: number;
}

export interface TypeSafeUnavailable {
  readonly ok: false;
  readonly reason: TypeSafeUnavailableReason;
  /** Short, secret-free explanation, safe to log. */
  readonly detail: string;
  readonly status?: number;
  /** Populated from Retry-After on a throttled response, when parseable. */
  readonly retryAfterMs?: number;
  readonly durationMs: number;
}

export type TypeSafeResult = TypeSafeOk | TypeSafeUnavailable;

export interface TypeSafeRequest {
  /** The text being classified. Truncated head+tail to MAX_STATE_CHARS. */
  readonly state: string;
  /** Ask them all at once — the API is priced per call, not per question. */
  readonly questions: Readonly<Record<string, TypeSafeQuestion>>;
  readonly model?: TypeSafeModel;
}

export interface TypeSafeCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Override for tests and self-hosted deployments. */
  readonly endpoint?: string;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function classifierDisabled(): boolean {
  const raw = process.env[TYPESAFE_DISABLE_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * True when a call has any chance of succeeding (enabled + a key resolvable).
 * Cheap enough to call on a failure path; does not touch the network. Callers
 * do not have to call it — `askTypeSafe` performs the same checks and returns
 * `no-key`/`disabled` with no I/O — but it is useful for doctor/status output.
 */
export function typeSafeAvailable(cfg: AshlrConfig): boolean {
  if (classifierDisabled()) return false;
  try {
    return Boolean(resolveProviderKey(TYPESAFE_API_KEY_ENV, cfg)?.trim());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Head+tail truncation. A stack trace's first lines say what failed and its
 * last lines say how it died; the middle is repetition. Keeping both ends
 * preserves more signal per token than a plain prefix cut.
 */
function boundState(state: string): string {
  if (state.length <= MAX_STATE_CHARS) return state;
  const head = Math.floor(MAX_STATE_CHARS * 0.6);
  const tail = MAX_STATE_CHARS - head;
  return `${state.slice(0, head)}\n…[${state.length - MAX_STATE_CHARS} chars elided]…\n${state.slice(-tail)}`;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Retry-After is either delta-seconds or an HTTP-date. Both are bounded to 1h. */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 3_600_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unitInterval(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  return n >= 0 && n <= 1 ? n : undefined;
}

function parseProbabilities(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [label, p] of Object.entries(value)) {
    const n = unitInterval(p);
    if (n !== undefined) out[label] = n;
  }
  return out;
}

/** Parse one answer. Returns undefined for anything that is not a well-formed
 *  answer of a type we understand — an unparseable answer is a missing answer,
 *  never a guessed one. */
function parseAnswer(value: unknown): TypeSafeAnswer | undefined {
  if (!isRecord(value)) return undefined;
  switch (value['type']) {
    case 'choice': {
      const choice = value['choice'];
      const confidence = unitInterval(value['confidence']);
      if (typeof choice !== 'string' || choice === '' || confidence === undefined) return undefined;
      return {
        type: 'choice',
        choice,
        confidence,
        probabilities: parseProbabilities(value['probabilities']),
      };
    }
    case 'score': {
      const score = finiteNumber(value['score']);
      if (score === undefined) return undefined;
      // Confidence is optional on score answers; absent means "unstated", and
      // an unstated confidence must not read as certainty — report 0 so a
      // confidence gate rejects it rather than waving it through.
      return { type: 'score', score, confidence: unitInterval(value['confidence']) ?? 0 };
    }
    case 'noul': {
      const noul = unitInterval(value['noul']);
      if (noul === undefined) return undefined;
      return { type: 'noul', noul };
    }
    default:
      return undefined;
  }
}

function parseUsage(value: unknown): TypeSafeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteNumber(value['input_tokens']);
  const outputTokens = finiteNumber(value['output_tokens']);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------

/**
 * Ask Jev one or more typed questions about one piece of state, in ONE request.
 *
 * NEVER THROWS. Every failure — including a caller-signalled abort — comes back
 * as `{ ok: false, reason, detail }`. Callers must treat `ok: false` as "use
 * the deterministic path" and carry on.
 *
 * Does not retry. A 429 returns `reason: 'rate-limited'`; re-issuing the call
 * is the caller's decision to make (and for a fallback-capable call site, the
 * right decision is not to).
 */
export async function askTypeSafe(
  request: TypeSafeRequest,
  cfg: AshlrConfig,
  opts: TypeSafeCallOptions = {},
): Promise<TypeSafeResult> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;

  if (classifierDisabled()) {
    return { ok: false, reason: 'disabled', detail: `${TYPESAFE_DISABLE_ENV} is set`, durationMs: elapsed() };
  }

  const questionNames = Object.keys(request.questions);
  if (questionNames.length === 0) {
    return { ok: false, reason: 'disabled', detail: 'no questions asked', durationMs: elapsed() };
  }

  // Resolved here, used once, never stored or returned.
  let apiKey: string | undefined;
  try {
    apiKey = resolveProviderKey(TYPESAFE_API_KEY_ENV, cfg)?.trim();
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no-key',
      detail: `no ${TYPESAFE_API_KEY_ENV} in the phantom vault or the environment`,
      durationMs: elapsed(),
    };
  }

  const endpoint = opts.endpoint ?? process.env['ASHLR_TYPESAFE_ENDPOINT']?.trim() ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model: request.model ?? 'jev-latest',
    state: boundState(request.state),
    questions: request.questions,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  const onDeadline = (): void => {
    timedOut = true;
  };
  controller.signal.addEventListener('abort', onDeadline, { once: true });

  const forwardAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      return { ok: false, reason: 'timeout', detail: 'cancelled before dispatch', durationMs: elapsed() };
    }
    opts.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          // The only place the secret is used. Never logged, never returned.
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = timedOut || opts.signal?.aborted === true || (err as { name?: string })?.name === 'AbortError';
      if (aborted) {
        return {
          ok: false,
          reason: 'timeout',
          detail: timedOut ? `no response within ${timeoutMs}ms` : 'cancelled by caller',
          durationMs: elapsed(),
        };
      }
      return { ok: false, reason: 'network', detail: safeErrorDetail(err), durationMs: elapsed() };
    }

    if (response.status === 429 || (response.status === 503 && response.headers.get('retry-after'))) {
      // Rule 3: never retried here. Drain nothing, report, let the caller fall back.
      void response.body?.cancel();
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      return {
        ok: false,
        reason: 'rate-limited',
        detail: `classifier throttled (HTTP ${response.status})`,
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        durationMs: elapsed(),
      };
    }

    let text: string | null;
    try {
      text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (err) {
      const aborted = timedOut || opts.signal?.aborted === true;
      return aborted
        ? { ok: false, reason: 'timeout', detail: `body not read within ${timeoutMs}ms`, durationMs: elapsed() }
        : { ok: false, reason: 'network', detail: safeErrorDetail(err), durationMs: elapsed() };
    }

    if (text === null) {
      return {
        ok: false,
        reason: 'oversized-response',
        detail: `response body exceeded ${MAX_RESPONSE_BYTES} bytes`,
        status: response.status,
        durationMs: elapsed(),
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: 'http-error',
        detail: `HTTP ${response.status}: ${truncateDetail(text)}`,
        status: response.status,
        durationMs: elapsed(),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: 'malformed-response',
        detail: 'response body was not JSON',
        status: response.status,
        durationMs: elapsed(),
      };
    }

    if (!isRecord(parsed) || !isRecord(parsed['answers'])) {
      return {
        ok: false,
        reason: 'malformed-response',
        detail: 'response had no answers object',
        status: response.status,
        durationMs: elapsed(),
      };
    }

    const answers: Record<string, TypeSafeAnswer> = {};
    for (const [name, raw] of Object.entries(parsed['answers'])) {
      const answer = parseAnswer(raw);
      if (answer) answers[name] = answer;
    }
    if (Object.keys(answers).length === 0) {
      return {
        ok: false,
        reason: 'malformed-response',
        detail: 'no well-formed answers in response',
        status: response.status,
        durationMs: elapsed(),
      };
    }

    const usage = parseUsage(parsed['usage']);
    const model = typeof parsed['model'] === 'string' ? parsed['model'] : (request.model ?? 'jev-latest');
    return { ok: true, model, answers, ...(usage ? { usage } : {}), durationMs: elapsed() };
  } catch (err) {
    // Belt and braces: rule 1 says this function never throws, so even an
    // unanticipated failure becomes a typed unavailable result.
    return { ok: false, reason: 'network', detail: safeErrorDetail(err), durationMs: elapsed() };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onDeadline);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}

function truncateDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function safeErrorDetail(err: unknown): string {
  if (err instanceof Error) return truncateDetail(`${err.name}: ${err.message}`);
  return truncateDetail(String(err));
}

// ---------------------------------------------------------------------------
// Typed answer accessors
// ---------------------------------------------------------------------------

/**
 * Narrow one choice answer, rejecting a label outside `allowed`. A model that
 * invents a label is as unusable as no answer at all, so this returns
 * undefined rather than letting an unknown string escape into a typed union.
 */
export function choiceAnswer<K extends string>(
  result: TypeSafeResult,
  name: string,
  allowed: readonly K[],
): TypeSafeChoiceAnswer<K> | undefined {
  if (!result.ok) return undefined;
  const answer = result.answers[name];
  if (!answer || answer.type !== 'choice') return undefined;
  if (!(allowed as readonly string[]).includes(answer.choice)) return undefined;
  return answer as TypeSafeChoiceAnswer<K>;
}

export function scoreAnswer(result: TypeSafeResult, name: string): TypeSafeScoreAnswer | undefined {
  if (!result.ok) return undefined;
  const answer = result.answers[name];
  return answer && answer.type === 'score' ? answer : undefined;
}

export function noulAnswer(result: TypeSafeResult, name: string): TypeSafeNoulAnswer | undefined {
  if (!result.ok) return undefined;
  const answer = result.answers[name];
  return answer && answer.type === 'noul' ? answer : undefined;
}
