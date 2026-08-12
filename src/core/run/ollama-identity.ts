/**
 * Read-only Ollama artifact identity verification for local shadow candidates.
 *
 * This module deliberately uses only the bounded `/api/tags` inventory read.
 * It never pulls, loads, starts, or invokes a model, and redirects are refused
 * so a loopback endpoint cannot redirect the verifier to another authority.
 */

import { scrubSecrets } from '../util/scrub.js';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 5_000;
const MAX_TEXT_LENGTH = 256;
const MAX_FAMILIES = 16;

export interface OllamaModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaModelIdentity {
  name: string;
  digest: `sha256:${string}`;
  size: number;
  details: OllamaModelDetails;
}

export type OllamaIdentityRefusal =
  | 'invalid-config'
  | 'non-loopback-endpoint'
  | 'cancelled'
  | 'unreachable'
  | 'http-error'
  | 'response-too-large'
  | 'invalid-response'
  | 'model-not-found'
  | 'digest-mismatch';

export type OllamaIdentityVerification =
  | { ok: true; identity: OllamaModelIdentity }
  | { ok: false; reason: OllamaIdentityRefusal; identity?: OllamaModelIdentity };

export interface VerifyOllamaModelIdentityOptions {
  baseUrl: string;
  model: string;
  expectedDigest: string;
  signal?: AbortSignal;
  /** Test/diagnostic override. Production is always clamped to five seconds. */
  timeoutMs?: number;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    return undefined;
  }
  return scrubSecrets(value) === value ? value : undefined;
}

function boundedDetailText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && scrubSecrets(value) === value
    ? value
    : undefined;
}

function normalizeDigest(value: unknown): `sha256:${string}` | undefined {
  if (typeof value !== 'string') return undefined;
  if (SHA256_RE.test(value)) return value as `sha256:${string}`;
  if (BARE_SHA256_RE.test(value)) return `sha256:${value}`;
  return undefined;
}

export function normalizeNumericLoopbackOllamaBaseUrl(baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' ||
    !(/^127(?:\.\d{1,3}){3}$/.test(parsed.hostname) || ['[::1]', '::1'].includes(parsed.hostname)) ||
    !['/', '/v1', '/v1/'].includes(parsed.pathname)
  ) return undefined;
  if (/^127(?:\.\d{1,3}){3}$/.test(parsed.hostname)) {
    const octets = parsed.hostname.split('.').map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return undefined;
  }
  return `${parsed.origin}/v1`;
}

function loopbackTagsUrl(baseUrl: string): URL | undefined {
  const normalized = normalizeNumericLoopbackOllamaBaseUrl(baseUrl);
  return normalized ? new URL('/api/tags', normalized) : undefined;
}

function sanitizeDetails(value: unknown): OllamaModelDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const details: OllamaModelDetails = {};
  for (const key of ['parent_model', 'format', 'family', 'parameter_size', 'quantization_level'] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    const text = boundedDetailText(field);
    if (text === undefined) return undefined;
    details[key] = text;
  }
  if (raw['families'] !== undefined) {
    if (!Array.isArray(raw['families']) || raw['families'].length > MAX_FAMILIES) return undefined;
    const families = raw['families'].map(boundedDetailText);
    if (families.some((family) => family === undefined)) return undefined;
    details.families = families as string[];
  }
  return details;
}

function parseIdentity(value: unknown, requestedModel: string): OllamaModelIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const name = boundedText(raw['name']);
  const model = raw['model'] === undefined ? undefined : boundedText(raw['model']);
  if (!name || (name !== requestedModel && model !== requestedModel)) return undefined;
  const digest = normalizeDigest(raw['digest']);
  const size = raw['size'];
  const details = sanitizeDetails(raw['details']);
  if (!digest || !Number.isSafeInteger(size) || Number(size) < 0 || !details) return undefined;
  return { name, digest, size: Number(size), details };
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
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

export async function verifyOllamaModelIdentity(
  options: VerifyOllamaModelIdentityOptions,
): Promise<OllamaIdentityVerification> {
  const model = boundedText(options.model);
  if (!model || !SHA256_RE.test(options.expectedDigest)) {
    return { ok: false, reason: 'invalid-config' };
  }
  const tagsUrl = loopbackTagsUrl(options.baseUrl);
  if (!tagsUrl) return { ok: false, reason: 'non-loopback-endpoint' };
  if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(options.timeoutMs ?? MAX_TIMEOUT_MS)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = (): void => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(tagsUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        reason: options.signal?.aborted ? 'cancelled' : 'unreachable',
      };
    }
    if (!response.ok) return { ok: false, reason: 'http-error' };
    let body: string | undefined;
    try {
      body = await readBoundedBody(response);
    } catch {
      return {
        ok: false,
        reason: options.signal?.aborted ? 'cancelled' : 'unreachable',
      };
    }
    if (body === undefined) return { ok: false, reason: 'response-too-large' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'invalid-response' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid-response' };
    }
    const models = (parsed as Record<string, unknown>)['models'];
    if (!Array.isArray(models) || models.length > 10_000) {
      return { ok: false, reason: 'invalid-response' };
    }
    const exactRaw = models.find((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const raw = entry as Record<string, unknown>;
      return raw['name'] === model || raw['model'] === model;
    });
    if (exactRaw === undefined) return { ok: false, reason: 'model-not-found' };
    const identity = parseIdentity(exactRaw, model);
    if (!identity) return { ok: false, reason: 'invalid-response' };
    if (identity.digest !== options.expectedDigest) {
      return { ok: false, reason: 'digest-mismatch', identity };
    }
    return { ok: true, identity };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
