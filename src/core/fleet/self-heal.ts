/**
 * M165: self-heal loop — detect broken build/test in enrolled repos and
 * auto-propose a HIGH-PRIORITY fix so the fleet moves forward.
 *
 * Philosophy: "easier to fix-forward than gate up front." When the fleet
 * breaks a repo it should immediately detect and queue a repair, not wait
 * on a human to notice.
 *
 * SAFETY / POSTURE:
 *  - Never throws — every failure is captured as metadata.
 *  - No secrets in output — VerifyCommandResult.output is already scrubbed.
 *  - Flag-gated: cfg.foundry?.selfHeal defaults TRUE (fix-forward posture).
 *    Set to false to disable.
 *  - Bounded: each repo is time-boxed (timeoutMs per command, default 120 s).
 *  - Proposal-only: proposeHeal returns a WorkItem for the backlog; nothing
 *    is applied or merged here.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AshlrConfig, WorkItem } from '../types.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  detectVerifyCommands,
  runVerifyCommand,
} from '../run/verify-commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreakageResult {
  broken: boolean;
  /** True only when the repo had verify commands and every checked command produced a trustworthy result. */
  verified?: boolean;
  kind?: 'build' | 'test';
  /** First non-blank failure line from the command output, capped at 200 chars. */
  detail?: string;
  reason?: 'no-verify-commands' | 'detect-error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first meaningful failure line from command output.
 * Prefers lines with "error", "fail", or "FAIL" to cut through noise.
 */
function firstFailureLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  // Prefer a line that looks like an error
  const errorLine = lines.find(l =>
    /error|fail|FAIL|Error/i.test(l)
  );
  const chosen = errorLine ?? lines[0] ?? 'unknown failure';
  return chosen.slice(0, 200);
}

/** Map VerifyCommand kind to 'build' | 'test'. */
function kindOf(vcKind: string): 'build' | 'test' {
  if (vcKind === 'typecheck' || vcKind === 'lint') return 'build';
  return 'test';
}

/** Stable deterministic id for a self-heal WorkItem. */
function selfHealId(repo: string, breakageKind: string): string {
  const hash = createHash('sha1')
    .update(`${repo}:self-heal:${breakageKind}`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:self-heal:${hash}`;
}

// ---------------------------------------------------------------------------
// detectBreakage
// ---------------------------------------------------------------------------

/**
 * Run the repo's build + test commands and detect whether any are RED.
 *
 * - Uses detectVerifyCommands to find commands (typecheck / test / lint).
 * - Degrades gracefully: if no commands are detected, returns { broken: false }.
 * - Time-boxed per command (default 90 s; short to keep the cycle snappy).
 * - Never throws.
 */
export async function detectBreakage(
  repoDir: string,
  cfg?: Pick<AshlrConfig, 'foundry'>,
): Promise<BreakageResult> {
  try {
    const commands = detectVerifyCommands(repoDir);
    if (commands.length === 0) {
      return { broken: false, verified: false, reason: 'no-verify-commands' };
    }

    // Per-command timeout: use cfg.foundry.timeoutMs if set, else 90 s (shorter
    // than the M43 default of 120 s so the self-heal cycle stays snappy).
    const timeoutMs = Math.min(
      cfg?.foundry?.timeoutMs ?? 90_000,
      90_000,
    );

    for (const vc of commands) {
      const result = runVerifyCommand(vc, repoDir, cfg as AshlrConfig ?? {} as AshlrConfig, { timeoutMs });
      if (!result.ok) {
        return {
          broken: true,
          verified: true,
          kind: kindOf(vc.kind),
          detail: firstFailureLine(result.output),
        };
      }
    }

    return { broken: false, verified: true };
  } catch {
    // Never throw, but do not treat detector failures as proven green.
    return { broken: false, verified: false, reason: 'detect-error' };
  }
}

// ---------------------------------------------------------------------------
// proposeHeal
// ---------------------------------------------------------------------------

/**
 * Build a HIGH-PRIORITY WorkItem that tells the fleet to fix the broken repo.
 *
 * Score: value=5 / effort=1 = 5.0 — top of the backlog, jumps the queue.
 * Source: 'self-heal' would be ideal but WorkSource is a fixed union; 'self'
 * is the closest existing value (M54: "the fleet's own backlog").
 */
export function proposeHeal(
  repoDir: string,
  breakage: BreakageResult,
  _cfg?: Pick<AshlrConfig, 'foundry'>,
): WorkItem {
  const kind = breakage.kind ?? 'build';
  const repoName = basename(repoDir);
  const detail = breakage.detail ?? 'unknown failure';

  const title = `Fix broken ${kind} in ${repoName}: ${detail}`;
  const fullDetail =
    `Self-heal: ${kind} is RED in ${repoDir}.\n` +
    `First failure: ${detail}\n` +
    `Investigate the failing command, fix the root cause, and verify the suite passes.`;

  // value=5 effort=1 → score=5 (highest possible)
  const value = 5;
  const effort = 1;
  const score = value / Math.max(1, effort); // = 5

  return {
    id: selfHealId(repoDir, kind),
    repo: repoDir,
    source: 'self',
    title,
    detail: fullDetail,
    value,
    effort,
    score,
    tags: ['self-heal', kind, 'high-priority'],
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// runSelfHealCycle
// ---------------------------------------------------------------------------

export interface SelfHealCycleResult {
  checked: number;
  broken: string[];
  healItems: WorkItem[];
}

/** Absolute path to the self-heal queue file under ~/.ashlr/. */
function selfHealQueuePath(): string {
  return join(homedir(), '.ashlr', 'self-heal-queue.json');
}

function backlogPath(): string {
  return join(homedir(), '.ashlr', 'backlog.json');
}

function readWorkItemsArray(filePath: string): WorkItem[] {
  try {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as WorkItem[];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function isSelfHealItemForRepo(value: unknown, repoKey: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (typeof item.repo !== 'string') return false;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  try {
    return resolve(item.repo) === repoKey;
  } catch {
    return false;
  }
}

function pruneSelfHealItemsFromQueue(repoDir: string): number {
  try {
    const qPath = selfHealQueuePath();
    const existing = readWorkItemsArray(qPath);
    if (existing.length === 0) return 0;
    const repoKey = resolve(repoDir);
    const filtered = existing.filter((item) => !isSelfHealItemForRepo(item, repoKey));
    const removed = existing.length - filtered.length;
    if (removed > 0) writeJsonAtomic(qPath, filtered);
    return removed;
  } catch {
    return 0;
  }
}

function pruneSelfHealItemsFromBacklog(repoDir: string): number {
  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return 0;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    const repoKey = resolve(repoDir);

    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !isSelfHealItemForRepo(item, repoKey));
      const removed = parsed.length - filtered.length;
      if (removed > 0) writeJsonAtomic(bPath, filtered);
      return removed;
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !isSelfHealItemForRepo(item, repoKey));
      const removed = envelope.items.length - filtered.length;
      if (removed > 0) writeJsonAtomic(bPath, { ...parsed, items: filtered });
      return removed;
    }

    return 0;
  } catch {
    return 0;
  }
}

function pruneStaleSelfHealItems(repoDir: string): number {
  return pruneSelfHealItemsFromQueue(repoDir) + pruneSelfHealItemsFromBacklog(repoDir);
}

/**
 * Queue a heal item to disk so the fleet daemon picks it up on the next tick
 * ahead of other work. Best-effort — failure here must never abort the cycle.
 */
function persistHealItem(item: WorkItem): void {
  try {
    const qPath = selfHealQueuePath();
    const dir = join(homedir(), '.ashlr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const existing = readWorkItemsArray(qPath);

    // Replace existing entry for same id (idempotent)
    const filtered = existing.filter(i => i.id !== item.id);
    filtered.unshift(item); // high-priority: front of queue

    writeJsonAtomic(qPath, filtered);
  } catch {
    // Best-effort — never propagate
  }
}

/**
 * Iterate every enrolled repo, detect breakage, propose heals for broken ones,
 * and queue them for the next fleet tick.
 *
 * - Flag-gated: skipped entirely when cfg.foundry?.selfHeal === false.
 * - Default is TRUE (fix-forward posture).
 * - Bounded: repos processed sequentially (avoids overwhelming the machine).
 * - Never throws.
 */
export async function runSelfHealCycle(
  cfg?: Pick<AshlrConfig, 'foundry'>,
): Promise<SelfHealCycleResult> {
  try {
    // Flag gate — default TRUE
    const enabled = (cfg?.foundry as Record<string, unknown> | undefined)?.selfHeal !== false;
    if (!enabled) {
      return { checked: 0, broken: [], healItems: [] };
    }

    const repos = listEnrolled();
    const broken: string[] = [];
    const healItems: WorkItem[] = [];

    for (const repo of repos) {
      try {
        const result = await detectBreakage(repo, cfg);
        if (result.broken) {
          broken.push(repo);
          const item = proposeHeal(repo, result, cfg);
          healItems.push(item);
          persistHealItem(item);
        } else if (result.verified === true) {
          pruneStaleSelfHealItems(repo);
        }
      } catch {
        // Per-repo errors never abort the cycle
      }
    }

    return { checked: repos.length, broken, healItems };
  } catch {
    return { checked: 0, broken: [], healItems: [] };
  }
}
