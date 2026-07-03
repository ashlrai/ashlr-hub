/**
 * Provider-neutral visual grounding primitives.
 *
 * This module is the "pixel perception" layer: image + natural language query
 * -> normalized boxes. It deliberately does not live under src/core/vision,
 * which is the strategic/north-star vision system.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

export type VisualGroundingProviderId = 'locateanything-http' | 'generic-openai-vision';

export interface ResolvedVisualGroundingConfig {
  enabled: boolean;
  provider: VisualGroundingProviderId;
  endpoint?: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxImageBytes: number;
  licenseAccepted: boolean;
  allowRemoteEndpoint: boolean;
  blockedReason?: string;
}

export interface VisualGroundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Always normalized to the LocateAnything convention: [0, 1000]. */
  scale: 'normalized-1000';
  label?: string;
  confidence?: number;
  sourceText?: string;
}

export interface VisualGroundingRequest {
  imagePath: string;
  query: string;
  /** Optional context such as 'browser-verify', 'pdf-verify', or 'desktop-proposal'. */
  purpose?: string;
}

export interface VisualGroundingResult {
  ok: boolean;
  skipped?: boolean;
  blocked?: boolean;
  reason?: string;
  provider: VisualGroundingProviderId | 'disabled';
  boxes: VisualGroundingBox[];
  detail: string;
  image?: {
    path: string;
    bytes: number;
    sha256: string;
  };
  /** Short scrubbed provider text. Never includes base64 image payloads. */
  rawText?: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

type FetchLike = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BOXES = 64;
const RAW_TEXT_LIMIT = 4_000;

export function resolveVisualGroundingConfig(cfg: Pick<AshlrConfig, 'foundry'>): ResolvedVisualGroundingConfig {
  const raw = cfg.foundry?.visualGrounding;
  const provider = normalizeProvider(raw?.provider);
  const endpoint = typeof raw?.endpoint === 'string' && raw.endpoint.trim() ? raw.endpoint.trim() : undefined;
  const model = typeof raw?.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : provider === 'locateanything-http'
      ? 'nvidia/LocateAnything-3B'
      : 'visual-grounder';
  const timeoutMs = finitePositive(raw?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const maxImageBytes = finitePositive(raw?.maxImageBytes) ?? DEFAULT_MAX_IMAGE_BYTES;
  const enabled = raw?.enabled === true;
  const licenseAccepted = raw?.licenseAccepted === true;
  const allowRemoteEndpoint = raw?.allowRemoteEndpoint === true;

  let blockedReason: string | undefined;
  if (enabled && provider === 'locateanything-http' && !licenseAccepted) {
    blockedReason = 'LocateAnything-3B is non-commercial/research-only; set foundry.visualGrounding.licenseAccepted=true after reviewing the model terms.';
  } else if (enabled && !endpoint) {
    blockedReason = 'foundry.visualGrounding.endpoint is required when visual grounding is enabled.';
  } else if (enabled && endpoint && !isLoopbackEndpoint(endpoint) && !allowRemoteEndpoint) {
    blockedReason = 'visual grounding endpoint is not loopback; set foundry.visualGrounding.allowRemoteEndpoint=true before uploading screenshots remotely.';
  }

  return {
    enabled,
    provider,
    ...(endpoint ? { endpoint } : {}),
    model,
    ...(raw?.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv } : {}),
    timeoutMs,
    maxImageBytes,
    licenseAccepted,
    allowRemoteEndpoint,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function parseLocateAnythingBoxes(text: string): VisualGroundingBox[] {
  const boxes: VisualGroundingBox[] = [];
  const seen = new Set<string>();

  const push = (coords: number[], sourceText?: string, label?: string, confidence?: number): void => {
    const normalized = normalizeBox(coords, sourceText, label, confidence);
    if (!normalized) return;
    const key = `${normalized.x1},${normalized.y1},${normalized.x2},${normalized.y2},${normalized.label ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    boxes.push(normalized);
  };

  for (const item of boxesFromJsonish(text)) {
    push(item.coords, item.sourceText, item.label, item.confidence);
    if (boxes.length >= MAX_BOXES) return boxes;
  }

  const tagRe = /<box\b[^>]*>[\s\S]*?<\/box>/gi;
  for (const match of text.matchAll(tagRe)) {
    const boxText = match[0] ?? '';
    const tagged = coordsFromCoordinateTags(boxText);
    if (tagged) {
      push(tagged, boxText);
    } else {
      const nums = numberList(boxText);
      if (nums.length >= 4) push(nums.slice(0, 4), boxText);
    }
    if (boxes.length >= MAX_BOXES) return boxes;
  }

  const attrRe = /(?:x1|left)\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?[\s,;]+(?:y1|top)\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?[\s,;]+(?:x2|right)\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?[\s,;]+(?:y2|bottom)\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/gi;
  for (const match of text.matchAll(attrRe)) {
    push([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])], match[0]);
    if (boxes.length >= MAX_BOXES) return boxes;
  }

  const bracketRe = /(?:\[|\()\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:\]|\))/g;
  for (const match of text.matchAll(bracketRe)) {
    push([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])], match[0]);
    if (boxes.length >= MAX_BOXES) return boxes;
  }

  return boxes;
}

export async function locateVisualTargets(
  request: VisualGroundingRequest,
  cfg: Pick<AshlrConfig, 'foundry'>,
  opts?: { fetch?: FetchLike },
): Promise<VisualGroundingResult> {
  const resolved = resolveVisualGroundingConfig(cfg);
  if (!resolved.enabled) {
    return {
      ok: true,
      skipped: true,
      provider: 'disabled',
      boxes: [],
      detail: 'visual grounding skipped (foundry.visualGrounding.enabled !== true)',
    };
  }
  if (resolved.blockedReason) {
    return {
      ok: false,
      skipped: true,
      blocked: true,
      reason: resolved.blockedReason,
      provider: resolved.provider,
      boxes: [],
      detail: resolved.blockedReason,
    };
  }
  if (!request.query.trim()) {
    return failure(resolved.provider, 'visual grounding query must be non-empty');
  }

  try {
    const image = readImageForGrounding(request.imagePath, resolved.maxImageBytes);
    if (!image.ok) return failure(resolved.provider, image.detail);
    const fetchImpl = opts?.fetch ?? defaultFetch();
    if (!fetchImpl) return failure(resolved.provider, 'global fetch is unavailable in this runtime');

    const rawText = await callOpenAiCompatibleGrounder(request, resolved, image.data, fetchImpl);
    const boxes = parseLocateAnythingBoxes(rawText);
    const shortText = shorten(rawText);
    return {
      ok: boxes.length > 0,
      provider: resolved.provider,
      boxes,
      detail: boxes.length > 0
        ? `visual grounding found ${boxes.length} box${boxes.length === 1 ? '' : 'es'}`
        : 'visual grounding returned no parseable boxes',
      image: {
        path: request.imagePath,
        bytes: image.data.bytes,
        sha256: image.data.sha256,
      },
      ...(shortText ? { rawText: shortText } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failure(resolved.provider, `visual grounding failed: ${scrubSecrets(msg)}`);
  }
}

function normalizeProvider(provider: unknown): VisualGroundingProviderId {
  return provider === 'generic-openai-vision' ? 'generic-openai-vision' : 'locateanything-http';
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeBox(
  coords: number[],
  sourceText?: string,
  label?: string,
  confidence?: number,
): VisualGroundingBox | null {
  if (coords.length < 4 || coords.slice(0, 4).some((n) => !Number.isFinite(n))) return null;
  let [x1, y1, x2, y2] = coords.slice(0, 4);
  const maxAbs = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
  if (maxAbs <= 1) {
    x1 *= 1000;
    y1 *= 1000;
    x2 *= 1000;
    y2 *= 1000;
  }
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  const out: VisualGroundingBox = {
    x1: clampRound(x1),
    y1: clampRound(y1),
    x2: clampRound(x2),
    y2: clampRound(y2),
    scale: 'normalized-1000',
  };
  if (out.x2 <= out.x1 || out.y2 <= out.y1) return null;
  if (label) out.label = label.slice(0, 120);
  if (typeof confidence === 'number' && Number.isFinite(confidence)) out.confidence = Math.max(0, Math.min(1, confidence));
  if (sourceText) out.sourceText = shorten(sourceText, 500);
  return out;
}

function clampRound(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function numberList(text: string): number[] {
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g), (m) => Number(m[0]));
}

function coordsFromCoordinateTags(text: string): number[] | null {
  const read = (name: 'x1' | 'y1' | 'x2' | 'y2'): number | null => {
    const re = new RegExp(`<${name}>\\s*(-?\\d+(?:\\.\\d+)?)\\s*<\\/${name}>`, 'i');
    const match = re.exec(text);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const x1 = read('x1');
  const y1 = read('y1');
  const x2 = read('x2');
  const y2 = read('y2');
  return x1 === null || y1 === null || x2 === null || y2 === null ? null : [x1, y1, x2, y2];
}

function boxesFromJsonish(text: string): Array<{ coords: number[]; label?: string; confidence?: number; sourceText?: string }> {
  const parsed = parseJsonish(text);
  if (parsed === null) return [];
  const out: Array<{ coords: number[]; label?: string; confidence?: number; sourceText?: string }> = [];
  const visit = (node: unknown): void => {
    if (out.length >= MAX_BOXES) return;
    if (Array.isArray(node)) {
      if (node.length >= 4 && node.slice(0, 4).every((v) => typeof v === 'number')) {
        out.push({ coords: node.slice(0, 4) as number[], sourceText: JSON.stringify(node.slice(0, 4)) });
        return;
      }
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const direct = coordsFromObject(rec);
    const label = stringField(rec, ['label', 'name', 'text', 'target']);
    const confidence = numberField(rec, ['confidence', 'score', 'probability']);
    if (direct) {
      out.push({ coords: direct, ...(label ? { label } : {}), ...(confidence !== null ? { confidence } : {}), sourceText: shorten(JSON.stringify(rec), 500) });
    }
    for (const key of ['box', 'bbox', 'bounds', 'rect', 'coordinates']) {
      const value = rec[key];
      if (Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every((v) => typeof v === 'number')) {
        out.push({ coords: value.slice(0, 4) as number[], ...(label ? { label } : {}), ...(confidence !== null ? { confidence } : {}), sourceText: shorten(JSON.stringify(value.slice(0, 4)), 500) });
      }
    }
    for (const value of Object.values(rec)) visit(value);
  };
  visit(parsed);
  return out.slice(0, MAX_BOXES);
}

function coordsFromObject(rec: Record<string, unknown>): number[] | null {
  const x1 = numeric(rec, ['x1', 'left']);
  const y1 = numeric(rec, ['y1', 'top']);
  const x2 = numeric(rec, ['x2', 'right']);
  const y2 = numeric(rec, ['y2', 'bottom']);
  return x1 === null || y1 === null || x2 === null || y2 === null ? null : [x1, y1, x2, y2];
}

function numeric(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function stringField(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function parseJsonish(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function jsonCandidates(text: string): string[] {
  const candidates = [text];
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
  return candidates;
}

function readImageForGrounding(imagePath: string, maxBytes: number): {
  ok: true;
  data: { bytes: number; base64: string; mime: string; sha256: string };
} | { ok: false; detail: string } {
  if (!imagePath || !existsSync(imagePath)) return { ok: false, detail: `image not found: ${imagePath || '(empty)'}` };
  const stat = statSync(imagePath);
  if (!stat.isFile()) return { ok: false, detail: `image path is not a file: ${imagePath}` };
  if (stat.size > maxBytes) return { ok: false, detail: `image exceeds max size (${stat.size} > ${maxBytes} bytes)` };
  const bytes = readFileSync(imagePath);
  return {
    ok: true,
    data: {
      bytes: stat.size,
      base64: bytes.toString('base64'),
      mime: mimeForImage(imagePath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

function mimeForImage(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

async function callOpenAiCompatibleGrounder(
  request: VisualGroundingRequest,
  cfg: ResolvedVisualGroundingConfig,
  image: { base64: string; mime: string },
  fetchImpl: FetchLike,
): Promise<string> {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('missing visual grounding endpoint');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const prompt = [
      'Locate the requested target in the image.',
      'Return only bounding boxes normalized to [0,1000] as JSON: {"boxes":[{"label":"...","x1":0,"y1":0,"x2":1000,"y2":1000,"confidence":0.0}]}',
      `Target: ${request.query}`,
      request.purpose ? `Purpose: ${request.purpose}` : '',
    ].filter(Boolean).join('\n');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) headers['Authorization'] = `Bearer ${process.env[cfg.apiKeyEnv]}`;
    const response = await fetchImpl(completionsUrl(endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
            ],
          },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`provider returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${shorten(text)}`);
    }
    return extractOpenAiText(text) ?? text;
  } finally {
    clearTimeout(timer);
  }
}

function completionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function extractOpenAiText(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const choices = parsed['choices'];
    if (!Array.isArray(choices)) return null;
    const texts: string[] = [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>)['message'];
      if (!message || typeof message !== 'object') continue;
      const content = (message as Record<string, unknown>)['content'];
      if (typeof content === 'string') texts.push(content);
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string') {
            texts.push((part as Record<string, string>)['text']);
          }
        }
      }
    }
    return texts.join('\n').trim() || null;
  } catch {
    return null;
  }
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) as unknown as FetchLike : null;
}

function failure(provider: VisualGroundingProviderId, detail: string): VisualGroundingResult {
  return {
    ok: false,
    provider,
    boxes: [],
    detail: scrubSecrets(detail),
  };
}

function shorten(text: string, limit = RAW_TEXT_LIMIT): string {
  const scrubbed = scrubSecrets(text).replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[redacted];base64,[REDACTED]');
  if (scrubbed.length <= limit) return scrubbed;
  return `${scrubbed.slice(0, Math.floor(limit * 0.75))}\n...[truncated]...\n${scrubbed.slice(-Math.floor(limit * 0.2))}`;
}
