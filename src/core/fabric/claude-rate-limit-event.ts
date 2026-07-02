/**
 * claude-rate-limit-event.ts - Claude CLI rate_limit_event persistence.
 *
 * The Claude CLI can emit JSONL metadata such as:
 *   { "type":"rate_limit_event", "status":"allowed_warning",
 *     "resetsAt":1783080000, "rateLimitType":"seven_day", "utilization":1 }
 *
 * Persist only the small rate-limit metadata subset under ~/.ashlr/fabric.
 * Never persist prompts, diffs, tool arguments, model text, or raw lines.
 * All functions are best-effort and never throw.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeRateLimitEvent {
  type: 'rate_limit_event';
  status: string;
  rateLimitType: string;
  utilization: number;
  resetsAt: number;
  capturedAt: string;
}

const MAX_LABEL_LENGTH = 80;
type ClaudeRateLimitEventListener = (event: ClaudeRateLimitEvent) => void;
const listeners = new Set<ClaudeRateLimitEventListener>();

export function onClaudeRateLimitEventRecorded(listener: ClaudeRateLimitEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function fabricDir(): string {
  return join(homedir(), '.ashlr', 'fabric');
}

/** Absolute path to the sanitized Claude rate-limit event JSONL store. */
export function claudeRateLimitEventsPath(): string {
  return join(fabricDir(), 'claude-rate-limit-events.jsonl');
}

function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, MAX_LABEL_LENGTH);
}

function epochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const seconds = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  return seconds > 0 ? seconds : null;
}

function capturedAtIso(value: unknown, capturedAtMs: number): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const ms = Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now();
  return new Date(ms).toISOString();
}

function notifyRecorded(event: ClaudeRateLimitEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Observers must never disrupt Claude CLI output capture.
    }
  }
}

/**
 * Parse a single JSONL line into sanitized Claude rate-limit metadata.
 * Malformed JSON, non-rate-limit lines, and incomplete metadata return null.
 */
export function parseClaudeRateLimitEventLine(
  line: string,
  capturedAtMs = Date.now(),
): ClaudeRateLimitEvent | null {
  try {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj['type'] !== 'rate_limit_event') return null;

    const status = sanitizeLabel(obj['status']) ?? 'unknown';
    const rateLimitType = sanitizeLabel(obj['rateLimitType']) ?? 'unknown';
    const utilization = obj['utilization'];
    const resetsAt = epochSeconds(obj['resetsAt']);
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
    if (resetsAt === null) return null;

    return {
      type: 'rate_limit_event',
      status,
      rateLimitType,
      utilization,
      resetsAt,
      capturedAt: capturedAtIso(obj['capturedAt'], capturedAtMs),
    };
  } catch {
    return null;
  }
}

/** Append a sanitized rate_limit_event record when the line contains one. */
export function recordClaudeRateLimitEventLine(line: string): void {
  try {
    const event = parseClaudeRateLimitEventLine(line);
    if (!event) return;
    const dir = fabricDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(claudeRateLimitEventsPath(), JSON.stringify(event) + '\n', 'utf8');
    notifyRecorded(event);
  } catch {
    // CLI output capture must never disrupt engine execution.
  }
}

function isUnexpired(event: ClaudeRateLimitEvent, nowMs: number): boolean {
  return event.resetsAt * 1000 > nowMs;
}

/**
 * Read the newest unexpired persisted Claude rate-limit event.
 * Malformed/corrupt JSONL records are skipped.
 */
export function readLatestClaudeRateLimitEvent(opts: {
  rateLimitType?: string;
  nowMs?: number;
} = {}): ClaudeRateLimitEvent | null {
  try {
    const path = claudeRateLimitEventsPath();
    if (!existsSync(path)) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const wantedType = opts.rateLimitType;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.trim().length === 0) continue;
      const event = parseClaudeRateLimitEventLine(line, nowMs);
      if (!event) continue;
      if (wantedType && event.rateLimitType !== wantedType) continue;
      if (!isUnexpired(event, nowMs)) continue;
      return event;
    }
    return null;
  } catch {
    return null;
  }
}
