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
  runVerifyCommandAsync,
} from '../run/verify-commands.js';
import {
  isActionableSelfHealFailureText,
  isActionableSelfHealItem,
} from './self-heal-trust.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreakageResult {
  broken: boolean;
  /** True only when the repo had verify commands and every checked command produced a trustworthy result. */
  verified?: boolean;
  /** Verification kinds proven green before the first failure. */
  clearedKinds?: Array<'build' | 'test'>;
  kind?: 'build' | 'test';
  /** First non-blank failure line from the command output, capped at 200 chars. */
  detail?: string;
  reason?: 'no-verify-commands' | 'detect-error' | 'untrusted-verify-result';
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
  // M341: a PASSING line whose test NAME contains "error"/"failure" must never
  // be quoted as the failure — "(pass) … handles success and failure cases"
  // and "ok 56 … without error" were being fed to fleet workers as the broken
  // test, producing unfixable self-heal items.
  const isPassLine = (l: string) => /^\((pass|skip|todo)\)|^ok \d|^[✓√]|\bpassed\b/i.test(l);
  const candidates = lines.filter((l) => !isPassLine(l));
  // Strong failure markers first (bun/tap/vitest), then the generic match.
  const errorLine =
    candidates.find((l) => /^\(fail\)|^not ok\b|^[✗×]|\bFAIL\b|\bERROR\b/.test(l)) ??
    candidates.find((l) => /error|fail/i.test(l));
  const chosen = errorLine ?? lines[0] ?? 'unknown failure';
  return chosen.slice(0, 200);
}

/** Map VerifyCommand kind to 'build' | 'test'. */
function kindOf(vcKind: string): 'build' | 'test' {
  return vcKind === 'test' ? 'test' : 'build';
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
 * - Uses detectVerifyCommands to find commands (typecheck / lint / build / test).
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
    const clearedKinds = new Set<'build' | 'test'>();

    for (const vc of commands) {
      const kind = kindOf(vc.kind);
      const result = await runVerifyCommandAsync(vc, repoDir, cfg as AshlrConfig ?? {} as AshlrConfig, { timeoutMs });
      if (!result.ok) {
        const failureCategory = result.failureCategory ?? 'code';
        if (failureCategory !== 'code') {
          return {
            broken: false,
            verified: false,
            clearedKinds: Array.from(clearedKinds),
            reason: 'untrusted-verify-result',
          };
        }
        const detail = firstFailureLine(result.output);
        if (!isActionableSelfHealFailureText(detail)) {
          return {
            broken: false,
            verified: false,
            clearedKinds: Array.from(clearedKinds),
            reason: 'untrusted-verify-result',
          };
        }
        return {
          broken: true,
          verified: true,
          clearedKinds: Array.from(clearedKinds),
          kind,
          detail,
        };
      }
      clearedKinds.add(kind);
    }

    return { broken: false, verified: true, clearedKinds: Array.from(clearedKinds) };
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

function isSelfHealItemForRepo(
  value: unknown,
  repoKey: string,
  kinds?: ReadonlySet<'build' | 'test'>,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (typeof item.repo !== 'string') return false;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  if (kinds && !item.tags.some((tag) => kinds.has(tag as 'build' | 'test'))) return false;
  try {
    return resolve(item.repo) === repoKey;
  } catch {
    return false;
  }
}

function invalidSelfHealItem(value: unknown, enrolledRepoKeys: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  if (typeof item.repo !== 'string') return true;
  if (
    typeof item.id !== 'string' ||
    typeof item.source !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.detail !== 'string' ||
    typeof item.value !== 'number' ||
    typeof item.effort !== 'number' ||
    typeof item.score !== 'number' ||
    typeof item.ts !== 'string'
  ) return true;
  try {
    const repoKey = resolve(item.repo);
    return !enrolledRepoKeys.has(repoKey) ||
      !existsSync(item.repo) ||
      !isActionableSelfHealItem(item as WorkItem);
  } catch {
    return true;
  }
}

function pruneSelfHealItemsFromQueue(repoDir: string, kinds?: ReadonlySet<'build' | 'test'>): number {
  try {
    const qPath = selfHealQueuePath();
    const existing = readWorkItemsArray(qPath);
    if (existing.length === 0) return 0;
    const repoKey = resolve(repoDir);
    const filtered = existing.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
    const removed = existing.length - filtered.length;
    if (removed > 0) writeJsonAtomic(qPath, filtered);
    return removed;
  } catch {
    return 0;
  }
}

function pruneSelfHealItemsFromBacklog(repoDir: string, kinds?: ReadonlySet<'build' | 'test'>): number {
  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return 0;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    const repoKey = resolve(repoDir);

    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
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
      const filtered = envelope.items.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
      const removed = envelope.items.length - filtered.length;
      if (removed > 0) writeJsonAtomic(bPath, { ...parsed, items: filtered });
      return removed;
    }

    return 0;
  } catch {
    return 0;
  }
}

function pruneStaleSelfHealItems(repoDir: string, kinds?: Array<'build' | 'test'>): number {
  const kindSet = kinds && kinds.length > 0 ? new Set(kinds) : undefined;
  return pruneSelfHealItemsFromQueue(repoDir, kindSet) + pruneSelfHealItemsFromBacklog(repoDir, kindSet);
}

function pruneInvalidSelfHealItems(repos: string[]): number {
  const enrolledRepoKeys = new Set<string>();
  for (const repo of repos) {
    try { enrolledRepoKeys.add(resolve(repo)); } catch { /* ignore invalid registry entries */ }
  }

  let removed = 0;
  try {
    const qPath = selfHealQueuePath();
    const existing = readWorkItemsArray(qPath);
    if (existing.length > 0) {
      const filtered = existing.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      removed += existing.length - filtered.length;
      if (filtered.length !== existing.length) writeJsonAtomic(qPath, filtered);
    }
  } catch {
    // Best-effort only.
  }

  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return removed;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      removed += parsed.length - filtered.length;
      if (filtered.length !== parsed.length) writeJsonAtomic(bPath, filtered);
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      removed += envelope.items.length - filtered.length;
      if (filtered.length !== envelope.items.length) writeJsonAtomic(bPath, { ...parsed, items: filtered });
    }
  } catch {
    // Best-effort only.
  }

  return removed;
}

function targetedInvalidSelfHealItem(
  value: unknown,
  targetRepoKeys: ReadonlySet<string>,
  enrolledRepoKeys: ReadonlySet<string>,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  if (typeof item.repo !== 'string') return false;
  try {
    if (!targetRepoKeys.has(resolve(item.repo))) return false;
    return invalidSelfHealItem(value, enrolledRepoKeys);
  } catch {
    return false;
  }
}

function pruneInvalidSelfHealItemsForRepos(targetRepos: string[], enrolled: string[]): number {
  const targetRepoKeys = new Set<string>();
  for (const repo of targetRepos) {
    try { targetRepoKeys.add(resolve(repo)); } catch { /* ignore malformed target rows */ }
  }
  if (targetRepoKeys.size === 0) return 0;

  const enrolledRepoKeys = new Set<string>();
  for (const repo of enrolled) {
    try { enrolledRepoKeys.add(resolve(repo)); } catch { /* ignore invalid registry entries */ }
  }

  let removed = 0;
  try {
    const qPath = selfHealQueuePath();
    const existing = readWorkItemsArray(qPath);
    if (existing.length > 0) {
      const filtered = existing.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      removed += existing.length - filtered.length;
      if (filtered.length !== existing.length) writeJsonAtomic(qPath, filtered);
    }
  } catch {
    // Best-effort only.
  }

  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return removed;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      removed += parsed.length - filtered.length;
      if (filtered.length !== parsed.length) writeJsonAtomic(bPath, filtered);
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      removed += envelope.items.length - filtered.length;
      if (filtered.length !== envelope.items.length) writeJsonAtomic(bPath, { ...parsed, items: filtered });
    }
  } catch {
    // Best-effort only.
  }

  return removed;
}

/**
 * Queue a heal item to disk so the fleet daemon picks it up on the next tick
 * ahead of other work. Best-effort — failure here must never abort the cycle.
 */
export function queueSelfHealItem(item: WorkItem): boolean {
  try {
    const qPath = selfHealQueuePath();
    const dir = join(homedir(), '.ashlr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const existing = readWorkItemsArray(qPath);

    // Replace existing entry for same id (idempotent)
    const filtered = existing.filter(i => i.id !== item.id);
    filtered.unshift(item); // high-priority: front of queue

    writeJsonAtomic(qPath, filtered);
    return true;
  } catch {
    // Best-effort — never propagate
    return false;
  }
}

function persistHealItem(item: WorkItem): void {
  queueSelfHealItem(item);
}

function uniqueEnrolledTargets(repos: string[], enrolled: string[]): string[] {
  const enrolledByKey = new Map<string, string>();
  for (const repo of enrolled) {
    try { enrolledByKey.set(resolve(repo), repo); } catch { /* ignore invalid enrollment rows */ }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of repos) {
    try {
      const key = resolve(repo);
      const enrolledRepo = enrolledByKey.get(key);
      if (!enrolledRepo || seen.has(key)) continue;
      seen.add(key);
      out.push(enrolledRepo);
    } catch {
      // Ignore malformed repo paths.
    }
  }
  return out;
}

async function runSelfHealCycleForRepoList(
  repos: string[],
  cfg?: Pick<AshlrConfig, 'foundry'>,
): Promise<SelfHealCycleResult> {
  const broken: string[] = [];
  const healItems: WorkItem[] = [];

  for (const repo of repos) {
    try {
      const result = await detectBreakage(repo, cfg);
      if (result.broken) {
        pruneStaleSelfHealItems(repo);
        broken.push(repo);
        const item = proposeHeal(repo, result, cfg);
        healItems.push(item);
        persistHealItem(item);
      } else if (result.verified === true) {
        pruneStaleSelfHealItems(repo);
      } else if (result.clearedKinds && result.clearedKinds.length > 0) {
        pruneStaleSelfHealItems(repo, result.clearedKinds);
      }
    } catch {
      // Per-repo errors never abort the cycle.
    }
  }

  return { checked: repos.length, broken, healItems };
}

export async function runSelfHealCycleForRepos(
  repos: string[],
  cfg?: Pick<AshlrConfig, 'foundry'>,
): Promise<SelfHealCycleResult> {
  try {
    const enabled = (cfg?.foundry as Record<string, unknown> | undefined)?.selfHeal !== false;
    if (!enabled) return { checked: 0, broken: [], healItems: [] };

    const enrolled = listEnrolled();
    const targets = uniqueEnrolledTargets(repos, enrolled);
    if (targets.length === 0) return { checked: 0, broken: [], healItems: [] };
    pruneInvalidSelfHealItemsForRepos(targets, enrolled);
    return await runSelfHealCycleForRepoList(targets, cfg);
  } catch {
    return { checked: 0, broken: [], healItems: [] };
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
    pruneInvalidSelfHealItems(repos);
    return await runSelfHealCycleForRepoList(repos, cfg);
  } catch {
    return { checked: 0, broken: [], healItems: [] };
  }
}
