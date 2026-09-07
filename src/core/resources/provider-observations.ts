import { createHash } from 'node:crypto';
import { MAX_RESOURCE_OBSERVATION_AGE_MS, MAX_RESOURCE_OBSERVATION_WINDOWS,
  RESOURCE_OBSERVATION_OVERFLOW, type ResourceObservation } from './pool-policy.js';

/**
 * Pure adapters for documented native-provider metadata; no auth, IO or polling.
 * https://learn.chatgpt.com/docs/app-server#read-account-rate-limits
 * https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/message_parser.py
 * https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
 * Sources checked 2026-09-07. Inputs are decoded native result/event objects,
 * not JSON-RPC envelopes, flattened legacy events, SDK auth or model text.
 */
export interface ResourceObservationOptions { nowMs: number; ttlMs: number }
export interface CodexResourceObservationOptions extends ResourceObservationOptions { bucketIds: string[] }

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EPOCH_SECONDS = 253_402_300_799; // Year 9999; rejects millisecond timestamps, not guessed units.
const MAX_TIME_MS = MAX_EPOCH_SECONDS * 1000 + 999;
type Window = ResourceObservation['windows'][number];
type ObjectValue = Record<string, unknown>;

function record(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME_MS;
}

function iso(value: number): string { return new Date(value).toISOString(); }
function isoTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length !== 24) return null;
  const ms = Date.parse(value);
  return validTime(ms) && iso(ms) === value ? ms : null;
}

function epoch(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_SECONDS
    ? iso(value * 1000) : undefined;
}

function optionsValid(workerId: unknown, options: unknown): options is ResourceObservationOptions {
  if (typeof workerId !== 'string' || !ID.test(workerId) || !record(options)) return false;
  return validTime(options.nowMs) && typeof options.ttlMs === 'number' && Number.isSafeInteger(options.ttlMs) &&
    options.ttlMs > 0 && options.ttlMs <= MAX_RESOURCE_OBSERVATION_AGE_MS && validTime(options.nowMs + options.ttlMs);
}

function observation(workerId: string, options: ResourceObservationOptions, windows: Window[]): ResourceObservation {
  return { workerId, observedAt: iso(options.nowMs), expiresAt: iso(options.nowMs + options.ttlMs),
    updatedAt: iso(options.nowMs), health: 'ready', windows, retryAfter: null };
}

function codexWindowId(bucket: string, window: 'primary' | 'secondary'): string {
  const readable = `codex_${bucket}_${window}`;
  return readable.length <= 64 ? readable : `codex_${createHash('sha256').update(bucket).digest('hex').slice(0, 40)}_${window}`;
}

function codexWindow(value: unknown, id: string): Window | null | undefined {
  if (value === undefined || value === null) return null;
  if (!record(value)) return undefined;
  const raw = value.usedPercent;
  if (raw !== undefined && raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1_000_000)) return undefined;
  if (value.windowDurationMins !== undefined && value.windowDurationMins !== null &&
    (typeof value.windowDurationMins !== 'number' || !Number.isSafeInteger(value.windowDurationMins) ||
      value.windowDurationMins <= 0 || value.windowDurationMins > 525_600)) return undefined;
  const resetsAt = epoch(value.resetsAt);
  if (resetsAt === undefined) return undefined;
  return { id, usedPercent: typeof raw === 'number' ? Math.min(100, raw) : null, resetsAt };
}

/** Only the explicitly selected buckets participate. An authoritative empty map never falls back. */
export function normalizeCodexResourceObservation(
  workerId: string, payload: unknown, options: CodexResourceObservationOptions,
): ResourceObservation | null {
  try {
    if (!optionsValid(workerId, options) || !Array.isArray(options.bucketIds) || options.bucketIds.length < 1 ||
      options.bucketIds.length > 4 || !Array.from(options.bucketIds).every((id) => typeof id === 'string' && ID.test(id)) ||
      new Set(options.bucketIds).size !== options.bucketIds.length || !record(payload)) return null;
    const hasMap = Object.hasOwn(payload, 'rateLimitsByLimitId');
    if (!hasMap && !Object.hasOwn(payload, 'rateLimits')) return null;
    const map = payload.rateLimitsByLimitId;
    if (hasMap && !record(map)) return null;
    const legacy = payload.rateLimits;
    if (!hasMap && legacy !== null && legacy !== undefined && !record(legacy)) return null;
    const windows: Window[] = [];
    for (const bucket of options.bucketIds) {
      const value = hasMap && record(map) ? (Object.hasOwn(map, bucket) ? map[bucket] : undefined)
        : record(legacy) && legacy.limitId === bucket ? legacy : undefined;
      const primaryId = codexWindowId(bucket, 'primary');
      if (value === undefined) { windows.push({ id: primaryId, usedPercent: null, resetsAt: null }); continue; }
      if (!record(value) || (value.limitId !== undefined && value.limitId !== null && value.limitId !== bucket)) return null;
      const reached = value.rateLimitReachedType;
      if (reached !== undefined && reached !== null && (typeof reached !== 'string' || reached.length < 1 || reached.length > 128 ||
        [...reached].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) return null;
      const primary = codexWindow(value.primary, primaryId);
      const secondary = codexWindow(value.secondary, codexWindowId(bucket, 'secondary'));
      if (primary === undefined || secondary === undefined) return null;
      // 100 is a hard-denial sentinel when the provider classifies a reached
      // limit, not an invented measurement or a claim of remaining tokens.
      if (reached !== undefined && reached !== null) {
        windows.push({ id: primaryId, usedPercent: 100, resetsAt: primary?.resetsAt ?? null });
      } else if (primary) windows.push(primary);
      if (secondary) windows.push(secondary);
      if (!primary && !secondary && (reached === undefined || reached === null)) {
        windows.push({ id: primaryId, usedPercent: null, resetsAt: null });
      }
    }
    return observation(workerId, options, windows);
  } catch { return null; }
}

function previousValid(value: unknown, workerId: string, nowMs: number): value is ResourceObservation {
  if (!record(value) || value.workerId !== workerId || (value.health !== 'ready' && value.health !== 'unavailable') ||
    !Array.isArray(value.windows) || value.windows.length > MAX_RESOURCE_OBSERVATION_WINDOWS) return false;
  const start = isoTime(value.observedAt); const end = isoTime(value.expiresAt);
  if (start === null || end === null || start > nowMs || end <= start || end - start > MAX_RESOURCE_OBSERVATION_AGE_MS ||
    (value.retryAfter !== null && isoTime(value.retryAfter) === null)) return false;
  if (value.updatedAt !== undefined) {
    const updated = isoTime(value.updatedAt);
    if (updated === null || updated < start || updated > nowMs) return false;
  }
  const ids = new Set<string>();
  for (const window of value.windows) {
    if (!record(window) || typeof window.id !== 'string' || !ID.test(window.id) || ids.has(window.id) ||
      (window.usedPercent !== null && (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 || window.usedPercent > 100)) || (window.resetsAt !== null && isoTime(window.resetsAt) === null)) return false;
    ids.add(window.id);
  }
  return true;
}

function claudeWindow(value: ObjectValue, statusKey: string, resetKey: string, id: string, utilization?: unknown): Window | undefined {
  const status = value[statusKey];
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return undefined;
  const resetsAt = epoch(value[resetKey]);
  if (resetsAt === undefined && status !== 'rejected') return undefined;
  // The wire contract reports a fraction. Never guess percentage units when a
  // newer provider value is outside that contract, or discard a known refusal.
  const usedPercent = typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1
    ? utilization * 100 : null;
  return { id, usedPercent: status === 'rejected' ? 100 : usedPercent, resetsAt: resetsAt ?? null };
}

function claudeWindowId(value: unknown): string | undefined {
  if (value === undefined || value === null) return 'unclassified';
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) return undefined;
  // Bucket names are opaque provider IDs, not a fixed model enum. Keep future
  // safe names, or bind them to a stable hash without echoing arbitrary labels.
  return ID.test(value) ? value : `claude_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

/** Merge only observed windows. Unseen windows retain their original conservative freshness. */
export function mergeClaudeResourceObservation(
  workerId: string, payload: unknown, previous: ResourceObservation | null, options: ResourceObservationOptions,
): ResourceObservation | null {
  try {
    if (!optionsValid(workerId, options) || !record(payload) || payload.type !== 'rate_limit_event' ||
      !record(payload.rate_limit_info) || (previous !== null && !previousValid(previous, workerId, options.nowMs))) return null;
    const info = payload.rate_limit_info;
    const kind = claudeWindowId(info.rateLimitType) ?? (info.status === 'rejected' ? 'unclassified' : undefined);
    if (kind === undefined) return null;
    let current = claudeWindow(info, 'status', 'resetsAt', kind, info.utilization);
    if (!current) return null;
    const before = previous?.windows.find((window) => window.id === current!.id);
    const previousCapture = previous ? Date.parse(previous.updatedAt ?? previous.observedAt) : -1;
    const knownFresh = current.usedPercent !== null && current.resetsAt !== null &&
      Date.parse(current.resetsAt) > options.nowMs && options.nowMs > previousCapture;
    const increased = current.usedPercent !== null && before?.usedPercent !== null && before?.usedPercent !== undefined &&
      current.usedPercent > before.usedPercent;
    const retainedCurrent = before !== undefined && before.usedPercent !== null && !knownFresh && !increased;
    if (retainedCurrent) current = { ...before };
    // Ancillary overageStatus describes a separate billing resource. It is not
    // intersected with subscription capacity, nor evidence that paid fallback
    // is enabled. An actual rateLimitType:'overage' event remains a named window.
    const updates: Window[] = [current];
    const updated = new Set(updates.map((window) => window.id));
    const retained = previous?.windows.filter((window) => !updated.has(window.id)) ?? [];
    let windows = [...retained.map((window) => ({ id: window.id,
      usedPercent: window.usedPercent, resetsAt: window.resetsAt })), ...updates];
    const overflow = windows.length > MAX_RESOURCE_OBSERVATION_WINDOWS ||
      windows.some((window) => window.id === RESOURCE_OBSERVATION_OVERFLOW);
    if (overflow) {
      // Preserve an inventory overflow even when its new bucket is allowed or
      // unknown. Discarded windows cannot be recovered by ordinary refresh, so
      // the marker remains sticky even after a fresh exact-marker replacement.
      windows = windows.filter((window) => window.id !== RESOURCE_OBSERVATION_OVERFLOW)
        .sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, MAX_RESOURCE_OBSERVATION_WINDOWS - 1);
      windows.push({ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null });
    }
    const result = observation(workerId, options, windows);
    if (previous) {
      // A one-window event cannot refresh another window, even after expiry.
      // Earliest local capture keeps expiresAt > observedAt for stale mixtures.
      if (retained.length > 0 || retainedCurrent || overflow) {
        result.observedAt = previous.observedAt;
        result.expiresAt = iso(Math.min(Date.parse(previous.expiresAt), options.nowMs + options.ttlMs));
        result.health = previous.health;
      }
      result.retryAfter = previous.retryAfter;
    }
    if (overflow) result.health = 'unavailable';
    return result;
  } catch { return null; }
}
