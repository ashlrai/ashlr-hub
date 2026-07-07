/**
 * Parse the STRICT structured result a per-milestone agent returns
 * (see docs/MILESTONE-CONTRACT.md). This is the only value that crosses back from
 * a heavy, disposable agent context into the tiny, durable driver.
 *
 * The parser is TOLERANT and NEVER THROWS: malformed, missing, or
 * wrong-milestone output becomes a safe `blocked` result whose `blocked_on`
 * explains the parse failure. The driver turns that into a clean stop — a flaky
 * agent can never crash the loop.
 *
 * Input shapes accepted (most specific first):
 *  1. The `claude --output-format json` envelope: `{ result: "<text>", ... }` —
 *     the agent's answer is the `result` text, which we re-scan for the object.
 *  2. A bare JSON object: `{ "milestone": "...", "status": "...", ... }`.
 *  3. A JSON object embedded in surrounding prose / code fences — we extract the
 *     first balanced `{...}` span and parse that.
 */

import type { MilestoneResult, MilestoneStatus } from './types.js';

const VALID_STATUSES: readonly MilestoneStatus[] = [
  'done',
  'needs_human',
  'blocked',
  'in_progress',
];

/** Build a safe `blocked` result — the never-throws fallback. */
function blockedResult(milestone: string, reason: string): MilestoneResult {
  return {
    milestone,
    status: 'blocked',
    gate_passed: false,
    steps_completed: [],
    blocked_on: reason,
    summary: `Could not parse a milestone result: ${reason}`,
  };
}

/** Extract the first balanced top-level `{...}` span from arbitrary text. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Try every accepted shape and return the first parseable object as a plain
 * record, or null. Unwraps the claude JSON envelope's `result` text one level.
 */
function findResultObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Attempt a direct JSON parse first.
  let top: unknown;
  try {
    top = JSON.parse(trimmed);
  } catch {
    top = null;
  }

  if (top && typeof top === 'object') {
    const obj = top as Record<string, unknown>;
    // Envelope: the agent's answer lives in `result` as text (or already-object).
    if ('result' in obj && !('status' in obj)) {
      const inner = obj['result'];
      if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
      if (typeof inner === 'string') {
        const span = extractFirstObject(inner);
        if (span) {
          try {
            return JSON.parse(span) as Record<string, unknown>;
          } catch {
            /* fall through */
          }
        }
      }
    }
    // Otherwise treat the top object itself as the result.
    return obj;
  }

  // Not directly parseable — scan for an embedded object (prose / code fence).
  const span = extractFirstObject(trimmed);
  if (span) {
    try {
      return JSON.parse(span) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Coerce an unknown into a string[] of ids, dropping non-strings. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Parse an agent's stdout into a MilestoneResult. Never throws.
 *
 * `expectMilestone` is the id that was dispatched; if the result names a
 * different milestone, we treat it as a parse failure (a `blocked` result for the
 * expected id) rather than trust a mismatched report.
 */
export function parseMilestoneResult(
  raw: string,
  expectMilestone: string,
): MilestoneResult {
  const obj = findResultObject(raw);
  if (!obj) {
    return blockedResult(expectMilestone, 'no JSON object found in agent output');
  }

  const status = obj['status'];
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as MilestoneStatus)) {
    return blockedResult(
      expectMilestone,
      `missing or invalid status (got ${JSON.stringify(status)})`,
    );
  }

  const milestone = typeof obj['milestone'] === 'string' ? obj['milestone'] : expectMilestone;
  if (milestone !== expectMilestone) {
    return blockedResult(
      expectMilestone,
      `result milestone "${milestone}" does not match dispatched "${expectMilestone}"`,
    );
  }

  const blockedOn = obj['blocked_on'];
  const summary = obj['summary'];

  return {
    milestone: expectMilestone,
    status: status as MilestoneStatus,
    gate_passed: obj['gate_passed'] === true,
    steps_completed: toStringArray(obj['steps_completed']),
    blocked_on: typeof blockedOn === 'string' ? blockedOn : null,
    summary: typeof summary === 'string' ? summary : '',
  };
}
