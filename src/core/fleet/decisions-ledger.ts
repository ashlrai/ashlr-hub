/**
 * M119: Append-only decisions ledger for the fleet oversight layer.
 *
 * Writes to ~/.ashlr/decisions/<YYYY-MM-DD>.jsonl — one DecisionEntry per line.
 *
 * Rules (mirror audit.ts):
 *   - Append-only: never truncate, never rewrite, never delete a prior line.
 *   - Never write secrets: detail field is stripped of secret-shaped tokens.
 *   - recordDecision() never throws.
 *   - readDecisions() skips malformed lines, never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
  readFileSync,
} from 'node:fs';
import type { DecisionEntry } from '../types.js';
import { normalizeDecisionLearningFields } from '../learning/causal.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the decisions directory: ~/.ashlr/decisions. */
export function decisionsDir(): string {
  return join(process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'decisions');
}

/** Current date as YYYY-MM-DD (UTC) for the daily file name. */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Secret scrubbing (mirror audit.ts's stripSecrets)
// ---------------------------------------------------------------------------

function stripSecrets(s: string): string {
  return scrubSecrets(s);
}

const DECISION_ACTIONS = new Set<DecisionEntry['action']>([
  'proposed',
  'verified',
  'judged',
  'merged',
  'handoff',
  'rejected',
  'escalated',
]);

function isDecisionAction(value: unknown): value is DecisionEntry['action'] {
  return typeof value === 'string' && DECISION_ACTIONS.has(value as DecisionEntry['action']);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalScrubbedText(value: unknown): string | undefined {
  return typeof value === 'string' ? stripSecrets(value) : undefined;
}

function optionalJudgeAttestation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  return stripSecrets(value);
}

function sanitizeDecisionEntry(entry: DecisionEntry): DecisionEntry {
  const clean: DecisionEntry = {
    ts: stripSecrets(entry.ts || new Date().toISOString()),
    proposalId: stripSecrets(entry.proposalId),
    action: entry.action,
    ...(optionalScrubbedText(entry.workItemId) !== undefined ? { workItemId: optionalScrubbedText(entry.workItemId) } : {}),
    ...(optionalScrubbedText(entry.workSource) !== undefined ? { workSource: optionalScrubbedText(entry.workSource) as DecisionEntry['workSource'] } : {}),
    ...(optionalScrubbedText(entry.runId) !== undefined ? { runId: optionalScrubbedText(entry.runId) } : {}),
    ...(optionalScrubbedText(entry.trajectoryId) !== undefined ? { trajectoryId: optionalScrubbedText(entry.trajectoryId) } : {}),
    ...(entry.routeSnapshot !== undefined ? { routeSnapshot: entry.routeSnapshot } : {}),
    ...(entry.runEventSummary !== undefined ? { runEventSummary: entry.runEventSummary } : {}),
    ...(entry.evidenceOutcome !== undefined ? { evidenceOutcome: entry.evidenceOutcome } : {}),
    ...(optionalScrubbedText(entry.learningSource) !== undefined ? { learningSource: optionalScrubbedText(entry.learningSource) as DecisionEntry['learningSource'] } : {}),
    ...(optionalScrubbedText(entry.labelBasis) !== undefined ? { labelBasis: optionalScrubbedText(entry.labelBasis) as DecisionEntry['labelBasis'] } : {}),
    ...(optionalScrubbedText(entry.routerPolicyVersion) !== undefined ? { routerPolicyVersion: optionalScrubbedText(entry.routerPolicyVersion) } : {}),
    ...(optionalScrubbedText(entry.learningEpoch) !== undefined ? { learningEpoch: optionalScrubbedText(entry.learningEpoch) } : {}),
    ...(optionalScrubbedText(entry.engine) !== undefined ? { engine: optionalScrubbedText(entry.engine) } : {}),
    ...(optionalScrubbedText(entry.model) !== undefined ? { model: optionalScrubbedText(entry.model) } : {}),
    ...(optionalScrubbedText(entry.verdict) !== undefined ? { verdict: optionalScrubbedText(entry.verdict) } : {}),
    ...(optionalScrubbedText(entry.reason) !== undefined ? { reason: optionalScrubbedText(entry.reason) } : {}),
    ...(optionalScrubbedText(entry.detail) !== undefined ? { detail: optionalScrubbedText(entry.detail) } : {}),
    ...(optionalJudgeAttestation(entry.judgeAttestation) !== undefined ? { judgeAttestation: optionalJudgeAttestation(entry.judgeAttestation) } : {}),
    ...(finiteNumber(entry.costUsd) !== undefined ? { costUsd: finiteNumber(entry.costUsd) } : {}),
    ...(finiteNumber(entry.tokensIn) !== undefined ? { tokensIn: finiteNumber(entry.tokensIn) } : {}),
    ...(finiteNumber(entry.tokensOut) !== undefined ? { tokensOut: finiteNumber(entry.tokensOut) } : {}),
    ...(finiteNumber(entry.durationMs) !== undefined ? { durationMs: finiteNumber(entry.durationMs) } : {}),
    ...(optionalBoolean(entry.cacheHit) !== undefined ? { cacheHit: optionalBoolean(entry.cacheHit) } : {}),
  };
  return normalizeDecisionLearningFields(clean);
}

// ---------------------------------------------------------------------------
// Public: recordDecision()
// ---------------------------------------------------------------------------

/**
 * Append one DecisionEntry to today's JSONL file under ~/.ashlr/decisions/.
 * Sets `ts` to the current ISO timestamp when not provided.
 *
 * Append-only. Never throws.
 */
export function recordDecision(entry: DecisionEntry): void {
  try {
    const dir = decisionsDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const record = sanitizeDecisionEntry(entry);

    const line = JSON.stringify(record) + '\n';
    const filePath = join(dir, `${todayDateString()}.jsonl`);
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // Intentionally swallowed: ledger must never disrupt the caller's flow.
  }
}

// ---------------------------------------------------------------------------
// Public: readDecisions()
// ---------------------------------------------------------------------------

/**
 * Read decision entries, newest-first.
 *
 * Options:
 *   sinceMs   — exclude entries older than this epoch ms
 *   proposalId — filter to a specific proposal id
 *   limit     — cap total returned (0 or undefined = all)
 *
 * Malformed JSONL lines are silently skipped. Never throws.
 */
export function readDecisions(opts?: {
  sinceMs?: number;
  proposalId?: string;
  limit?: number;
}): DecisionEntry[] {
  try {
    const dir = decisionsDir();
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse(); // newest date first
    } catch {
      return [];
    }

    const entries: DecisionEntry[] = [];
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    const sinceMs = opts?.sinceMs;
    const pid = opts?.proposalId;

    for (const file of files) {
      if (entries.length >= cap) break;

      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = raw.split('\n').filter((l) => l.trim() !== '').reverse();

      for (const line of lines) {
        if (entries.length >= cap) break;

        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (
              typeof obj['ts'] === 'string' &&
              typeof obj['proposalId'] === 'string' &&
              typeof obj['action'] === 'string'
            ) {
              if (!isDecisionAction(obj['action'])) continue;
              const record = sanitizeDecisionEntry(obj as unknown as DecisionEntry);
              // Window filter
              if (sinceMs !== undefined) {
                const entryMs = Date.parse(record.ts);
                if (!isNaN(entryMs) && entryMs < sinceMs) continue;
              }
              // Proposal filter
              if (pid !== undefined && record.proposalId !== pid) continue;

              entries.push(record);
            }
          }
        } catch {
          // Malformed line — skip silently.
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}
