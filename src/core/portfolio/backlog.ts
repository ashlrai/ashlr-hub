/**
 * backlog.ts — Aggregated work-discovery backlog for enrolled repos.
 *
 * GUARDRAILS:
 *  - READ-ONLY: this module never writes to any scanned repo.
 *  - ENROLLMENT-SCOPED: only listEnrolled() repos are scanned (DEFAULT EMPTY).
 *  - Never throws: all errors are caught and produce empty/null results.
 *  - No secrets in persisted data (enforced by scanners + audit).
 *  - Persists atomically to ~/.ashlr/backlog.json.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Backlog, Proposal, ScannerDescriptor, ScannerObservation, WorkItem } from '../types.js';
import { listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { isTrivialItem } from './value-filter.js';
import { computeOutcomePriors, scoreAdjustment } from '../fleet/feedback.js';
import { strategicRepoMultiplier } from '../ecosystem/focus.js';
import {
  blockingPendingProposalsForBacklog,
  pendingProposalItemKeysForBacklog,
  workItemCoverageKey,
} from '../fleet/proposal-matching.js';
import { withSelfHealQueueLock } from '../fleet/self-heal.js';
import { sanitizeSourceBaseDigest } from '../fleet/source-base-digest.js';

// ---------------------------------------------------------------------------
// M133: normalized title for dedup matching
// ---------------------------------------------------------------------------

/**
 * Normalize a title for dedup comparison. Lower-cases, strips punctuation,
 * collapses whitespace. Used to detect duplicate items / pending proposals
 * without exact-string matching (avoids false positives from minor wording
 * differences while still catching the same item filed N times).
 *
 * Strategy: lowercase → strip leading issue/PR prefixes → strip non-word chars
 * → collapse spaces → truncate to 120 chars.
 * "Issue #42: fix null pointer" and "Fix null pointer" will NOT match (the
 * issue number makes them distinct). "1 marker in src/foo.ts:17" filed twice
 * WILL match (same id and same normalized title).
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(issue|pr|bug|feat|fix|chore|refactor|todo|fixme|hack|xxx)\s*[#:]?\s*/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path of the persisted backlog file: ~/.ashlr/backlog.json.
 * Re-resolved at call time so tests can relocate HOME.
 */
export function backlogPath(): string {
  return join(homedir(), '.ashlr', 'backlog.json');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Priority score; higher = do first.
 * Heuristic: value / effort (effort clamped >= 1; both clamped to 1..5).
 * Deterministic, pure.
 */
export function scoreItem(value: number, effort: number): number {
  const v = Math.max(1, Math.min(5, value));
  const e = Math.max(1, Math.min(5, effort));
  return v / e;
}

// ---------------------------------------------------------------------------
// M161: Source-tier weighting
// ---------------------------------------------------------------------------

/**
 * Source priority tiers. Higher tier = more substantive work.
 *
 * Tier 3 (highest) — goal, issue: directive goals and tracked bugs drive real
 *   feature/fix work; the fleet should always prefer these.
 * Tier 2 (high)    — security, test: security vulnerabilities and failing tests
 *   are urgent and produce concrete diffs.
 * Tier 1 (normal)  — self, plugin, doc: useful but not fleet-critical.
 * Tier 0 (low)     — dep, lint, hygiene, todo: often noisy / low yield; should
 *   rank below substantive work when both are present.
 *
 * Multipliers are chosen so that a tier-3 item with value=2 outranks a tier-0
 * item with value=5 (2 * 1.8 = 3.6 > 5/5 * 0.6 = 0.6, even at effort=1).
 */
const SOURCE_TIER_MULTIPLIER: Record<string, number> = {
  goal:     1.8,
  issue:    1.8,
  security: 1.4,
  test:     1.4,
  self:     1.0,
  plugin:   1.0,
  doc:      1.0,
  todo:     0.6,
  dep:      0.6,
  lint:     0.6,
  hygiene:  0.6,
};

const LOW_VALUE_MAINTENANCE_SOURCES = new Set(['dep', 'lint', 'hygiene', 'todo']);

/** Returns the source-tier multiplier for an item's source. Unknown sources → 1.0. */
export function sourceTierMultiplier(source: string): number {
  return SOURCE_TIER_MULTIPLIER[source] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load the persisted backlog from ~/.ashlr/backlog.json.
 * Returns null if the file is absent or unreadable/malformed.
 * Never throws.
 */
export function loadBacklog(): Backlog | null {
  try {
    const p = backlogPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['generatedAt'] === 'string' &&
      Array.isArray((parsed as Record<string, unknown>)['repos']) &&
      Array.isArray((parsed as Record<string, unknown>)['items'])
    ) {
      const backlog = parsed as Backlog;
      const snapshotId = typeof backlog.snapshotId === 'string' && /^[a-f0-9]{32}$/.test(backlog.snapshotId)
        ? backlog.snapshotId
        : undefined;
      const rawObservations = (parsed as Record<string, unknown>)['observations'];
      if (!Array.isArray(rawObservations)) {
        const {
          observations: _observations,
          observationSourceState: _sourceState,
          observationsTruncated: _truncated,
          snapshotId: _snapshotId,
          ...legacy
        } = backlog;
        return { ...legacy, ...(snapshotId ? { snapshotId } : {}) };
      }
      const boundedRaw = rawObservations.slice(0, MAX_PERSISTED_SCANNER_OBSERVATIONS * 2);
      const sanitized = boundedRaw
        .map(sanitizeScannerObservation)
        .filter((observation): observation is ScannerObservation => observation !== null)
        .slice(0, MAX_PERSISTED_SCANNER_OBSERVATIONS);
      const rowsDropped = sanitized.length !== rawObservations.length;
      const truncated = backlog.observationsTruncated === true || rawObservations.length > MAX_PERSISTED_SCANNER_OBSERVATIONS;
      const degraded = rowsDropped || truncated || backlog.observationSourceState === 'degraded';
      const {
        observations: _observations,
        observationSourceState: _sourceState,
        observationsTruncated: _truncated,
        snapshotId: _snapshotId,
        ...base
      } = backlog;
      return {
        ...base,
        ...(snapshotId ? { snapshotId } : {}),
        observations: sanitized,
        observationSourceState: degraded ? 'degraded' : 'healthy',
        ...(truncated ? { observationsTruncated: true } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the backlog atomically (write + sync approach for node builtins). */
function persistBacklog(backlog: Backlog, opts: { fullSnapshot: boolean }): void {
  const persisted = withSelfHealQueueLock(() => {
    const current = loadBacklog();
    const currentMs = Date.parse(current?.generatedAt ?? '');
    const snapshotMs = Date.parse(backlog.generatedAt);
    const currentIsNewer = Boolean(current && Number.isFinite(currentMs) && Number.isFinite(snapshotMs) && currentMs > snapshotMs);
    let observationCandidates: ScannerObservation[] = [];
    let observationDegraded = backlog.observationSourceState === 'degraded' || backlog.observationsTruncated === true;
    if (currentIsNewer && opts.fullSnapshot) {
      observationCandidates = current?.observations ?? [];
      observationDegraded = current?.observationSourceState === 'degraded' || current?.observationsTruncated === true;
    } else if (!currentIsNewer && opts.fullSnapshot) {
      observationCandidates = backlog.observations ?? [];
    } else {
      const incomingRepos = new Set(backlog.repos.map((repo) => resolve(repo)));
      const retainedCurrent = currentIsNewer
        ? current?.observations ?? []
        : (current?.observations ?? []).filter((observation) => !incomingRepos.has(resolve(observation.repo)));
      observationCandidates = mergeConcurrentObservations(backlog.observations, retainedCurrent) ?? [];
      observationDegraded ||= current?.observationSourceState === 'degraded' || current?.observationsTruncated === true;
    }
    const mergedObservationCount = observationCandidates.length;
    const observations = observationCandidates.slice(0, MAX_PERSISTED_SCANNER_OBSERVATIONS);
    const observationsTruncated = mergedObservationCount > observations.length;
    observationDegraded ||= observationsTruncated;
    const observationEnvelope = observations.length > 0 || backlog.observations !== undefined || current?.observations !== undefined
      ? {
          observations,
          observationSourceState: observationDegraded ? 'degraded' as const : 'healthy' as const,
          ...(observationsTruncated ? { observationsTruncated: true } : {}),
        }
      : {};
    if (current && Number.isFinite(currentMs) && Number.isFinite(snapshotMs) && currentMs > snapshotMs) {
      const currentIds = new Set(current.items.map((item) => item.id));
      const nonConflictingIncoming = backlog.items.filter((item) => !currentIds.has(item.id));
      persistBacklogUnlocked({
        generatedAt: current.generatedAt,
        ...(current.snapshotId ? { snapshotId: current.snapshotId } : {}),
        repos: [...new Set([...current.repos, ...backlog.repos])],
        items: [...current.items, ...nonConflictingIncoming],
        ...observationEnvelope,
      });
      return;
    }
    persistBacklogUnlocked({ ...backlog, ...observationEnvelope });
  });
  if (!persisted.ok) throw new Error('backlog persistence lock unavailable');
}

/** Append work under the same lock used by queue pruning and backlog persistence. */
export function enqueueBacklogItems(items: WorkItem[]): number {
  const result = enqueueBacklogItemsDetailed(items);
  return result.ok ? result.enqueued : 0;
}

export function enqueueBacklogItemsDetailed(items: WorkItem[]): { ok: boolean; enqueued: number } {
  if (items.length === 0) return { ok: true, enqueued: 0 };
  const persisted = withSelfHealQueueLock(() => {
    const existing = loadBacklog();
    const existingItems = existing?.items ?? [];
    const existingIds = new Set(existingItems.map((item) => item.id));
    const fresh = items.filter((item) => !existingIds.has(item.id));
    if (fresh.length === 0) return 0;
    persistBacklogUnlocked({
      generatedAt: new Date().toISOString(),
      repos: [...new Set([...existingItems, ...fresh].map((item) => item.repo))],
      items: [...existingItems, ...fresh],
      ...(existing?.observations ? { observations: existing.observations } : {}),
      ...(existing?.observationSourceState ? { observationSourceState: existing.observationSourceState } : {}),
      ...(existing?.observationsTruncated ? { observationsTruncated: true } : {}),
    });
    return fresh.length;
  });
  return persisted.ok ? { ok: true, enqueued: persisted.value } : { ok: false, enqueued: 0 };
}

function persistBacklogUnlocked(backlog: Backlog): void {
  const p = backlogPath();
  const dir = join(homedir(), '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(backlog, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, p);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  }
}

const MAX_PERSISTED_SCANNER_OBSERVATIONS = 500;

function observationKey(observation: ScannerObservation): string {
  return `${resolve(observation.repo)}\0${observation.scannerId}`;
}

function mergeConcurrentObservations(
  incoming: ScannerObservation[] | undefined,
  current: ScannerObservation[] | undefined,
): ScannerObservation[] | undefined {
  if (!incoming && !current) return undefined;
  const groups = new Map<string, { observedAt: string; observations: ScannerObservation[] }>();
  for (const observations of [current ?? [], incoming ?? []]) {
    const candidateGroups = new Map<string, ScannerObservation[]>();
    for (const observation of observations) {
      const sanitized = sanitizeScannerObservation(observation);
      if (!sanitized) continue;
      const key = observationKey(sanitized);
      const group = candidateGroups.get(key) ?? [];
      group.push(sanitized);
      candidateGroups.set(key, group);
    }
    for (const [key, candidate] of candidateGroups) {
      const observedAt = candidate.reduce(
        (latest, observation) => observation.observedAt > latest ? observation.observedAt : latest,
        '',
      );
      const prior = groups.get(key);
      if (!prior || observedAt >= prior.observedAt) groups.set(key, { observedAt, observations: candidate });
    }
  }
  return [...groups.values()]
    .flatMap((group) => group.observations)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

function sanitizeScannerObservation(value: unknown): ScannerObservation | null {
  if (!value || typeof value !== 'object') return null;
  const observation = value as Partial<ScannerObservation>;
  if (
    observation.schemaVersion !== 1 ||
    typeof observation.observedAt !== 'string' ||
    observation.observedAt.length > 40
  ) return null;
  const observedAtMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAtMs) || new Date(observedAtMs).toISOString() !== observation.observedAt) return null;
  if (typeof observation.repo !== 'string' || observation.repo.length === 0 || observation.repo.length > 4096) return null;
  if (typeof observation.scannerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(observation.scannerId)) return null;
  if (typeof observation.domain !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(observation.domain)) return null;
  if (!['issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent'].includes(observation.source ?? '')) return null;
  if (!['present', 'absent', 'unavailable'].includes(observation.status ?? '')) return null;
  const common = {
    schemaVersion: 1 as const,
    observedAt: observation.observedAt,
    repo: resolve(observation.repo),
    scannerId: observation.scannerId,
    domain: observation.domain,
    source: observation.source as ScannerObservation['source'],
  };
  const sourceBase = observation.sourceBase === undefined
    ? undefined
    : sanitizeSourceBaseDigest(observation.sourceBase);
  const observationDigest = observation.observationDigest === undefined
    ? undefined
    : typeof observation.observationDigest === 'string' && /^[a-f0-9]{64}$/.test(observation.observationDigest)
      ? observation.observationDigest
      : null;
  if (observationDigest === null) return null;
  if (observation.status !== 'unavailable' && observation.sourceBase !== undefined && !sourceBase) return null;
  if (observationDigest && !sourceBase) return null;
  if (observation.status === 'unavailable' && observation.observationDigest !== undefined) return null;
  if (observation.status === 'present') {
    if (observation.reason !== 'item-observed' ||
      typeof observation.itemId !== 'string' || observation.itemId.length === 0 || observation.itemId.length > 180 ||
      typeof observation.objectiveHash !== 'string' || !/^[a-f0-9]{64}$/.test(observation.objectiveHash)) return null;
    return {
      ...common,
      status: 'present',
      reason: 'item-observed',
      itemId: observation.itemId,
      objectiveHash: observation.objectiveHash,
      ...(sourceBase ? { sourceBase } : {}),
      ...(observationDigest ? { observationDigest } : {}),
    };
  }
  if (observation.itemId !== undefined || observation.objectiveHash !== undefined) return null;
  if (observation.status === 'absent') {
    return observation.reason === 'source-confirmed-empty'
      ? {
          ...common,
          status: 'absent',
          reason: 'source-confirmed-empty',
          ...(sourceBase ? { sourceBase } : {}),
          ...(observationDigest ? { observationDigest } : {}),
        }
      : null;
  }
  if (![
    'legacy-empty-result',
    'scanner-failed',
    'source-unavailable',
    'source-unreadable',
    'source-malformed',
    'source-unsafe',
    'source-raced',
    'source-dirty',
    'source-snapshot-unavailable',
    'config-unavailable',
    'scanner-revision-unknown',
    'objective-hash-unavailable',
  ].includes(observation.reason ?? '')) return null;
  return { ...common, status: 'unavailable', reason: observation.reason as ScannerObservation['reason'] };
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

function dedupeItems(items: WorkItem[]): WorkItem[] {
  const seenId = new Set<string>();
  const seenTitle = new Set<string>();
  const out: WorkItem[] = [];
  for (const item of items) {
    const idKey = workItemCoverageKey(item);
    const titleKey = `${resolve(item.repo)}\0${normalizeTitle(item.title)}`;
    if (!seenId.has(idKey) && !seenTitle.has(titleKey)) {
      seenId.add(idKey);
      seenTitle.add(titleKey);
      out.push(item);
    }
  }
  return out;
}

function sameRepoSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((repo) => resolve(repo)));
  const right = new Set(b.map((repo) => resolve(repo)));
  if (left.size !== right.size) return false;
  for (const repo of left) {
    if (!right.has(repo)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// buildBacklog
// ---------------------------------------------------------------------------

// Deferred import of SCANNERS to avoid a circular-dependency risk and to keep
// this module importable even before scanners.ts exists (e.g. in tests that
// only exercise backlogPath/scoreItem/loadBacklog).
import type { AshlrConfig } from '../types.js';
type Scanner = (repo: string, cfg?: Pick<AshlrConfig, 'foundry'>) => Promise<WorkItem[]>;

interface ScannerEntry {
  scanner: Scanner;
  descriptor?: ScannerDescriptor;
}

async function getScanners(): Promise<ReadonlyArray<ScannerEntry>> {
  let builtin: ReadonlyArray<Scanner> = [];
  let registered: ReadonlyArray<ScannerEntry> | null = null;
  try {
    const mod = await import('./scanners.js');
    // SCANNERS type in scanners.ts is ReadonlyArray<(repo, cfg?) => ...>, which
    // matches Scanner here. The cast silences the readonly widening mismatch.
    builtin = mod.SCANNERS as unknown as ReadonlyArray<Scanner>;
    if (Array.isArray(mod.SCANNER_REGISTRATIONS)) {
      registered = mod.SCANNER_REGISTRATIONS.map((entry) => ({
        scanner: entry.scanner as Scanner,
        descriptor: entry.descriptor,
      }));
    }
  } catch {
    builtin = [];
  }
  // M33: merge enabled-plugin scanners (already wrapped: bounded, never-throw,
  // scrubbed, namespaced). Best-effort — a broken plugin layer never blocks
  // the builtin sweep; with plugins.enabled [] this resolves to [].
  let fromPlugins: ReadonlyArray<Scanner> = [];
  try {
    const { loadConfig } = await import('../config.js');
    const { getPluginScanners } = await import('../plugins/registry.js');
    fromPlugins = await getPluginScanners(loadConfig());
  } catch {
    fromPlugins = [];
  }
  return [
    ...(registered ?? builtin.map((scanner) => ({ scanner }))),
    ...fromPlugins.map((scanner) => ({ scanner })),
  ];
}

/**
 * Run all SCANNERS over each enrolled repo, aggregate, dedupe, score, persist,
 * and return the Backlog.
 *
 * - Default repos = listEnrolled() (DEFAULT EMPTY => items: []).
 * - Bounded concurrency: repos scanned sequentially; scanners within a repo
 *   run in parallel (each scanner is individually bounded + never throws).
 * - Never throws: any scanner error yields [] (enforced by scanner contract).
 */
export async function buildBacklog(opts?: {
  repos?: string[];
  minItemValue?: number;
  /** Persist the global backlog snapshot. Defaults to true for full enrolled scans only. */
  persist?: boolean;
  /** M125: injectable listProposals for feedback-loop tests. */
  listProposals?: () => Proposal[];
  /**
   * M133: injectable pending-proposals reader for dedup tests.
   * When provided, replaces the default listProposals({status:'pending'}) call
   * that drops items already represented by an open pending proposal.
   * Separate from the M125 listProposals to keep feedback-loop tests isolated.
   */
  listPendingProposals?: () => Proposal[];
  /** Override the loaded config (tests / programmatic scanner-flag control, e.g. scanTodos). */
  cfg?: Pick<AshlrConfig, "foundry">;
}): Promise<Backlog> {
  const enrolledSnapshot = listEnrolled();
  const repos: string[] = opts?.repos ?? enrolledSnapshot;
  const scanners = await getScanners();
  const now = new Date().toISOString();

  // Load cfg ONCE — used for minItemValue, feedbackEnabled, and scanner flags
  // (e.g. cfg.foundry.scanTodos). Must be loaded before the scanner loop so
  // it can be threaded through to each scanner call.
  let cfg: Pick<AshlrConfig, 'foundry'> | undefined = opts?.cfg;
  if (!cfg) {
    try {
      const { loadConfig } = await import('../config.js');
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
  }

  // Resolve min-value threshold: explicit opt > config > default (2).
  let minValue = opts?.minItemValue;
  // M125: resolve feedbackEnabled from config (default true).
  let feedbackEnabled = true;
  // M151: EDV independent-confirmation gate (default false = opt-in via cfg.foundry.edvVerify).
  let edvVerify = false;
  if (minValue === undefined) {
    minValue = cfg?.foundry?.minItemValue ?? 2;
    // cfg.foundry.feedbackEnabled: absent → true (opt-out by setting false).
    const rawFeedback = (cfg?.foundry as Record<string, unknown> | undefined)?.['feedbackEnabled'];
    if (rawFeedback === false) feedbackEnabled = false;
    // M151: cfg.foundry.edvVerify: absent → false (opt-in).
    const rawEdv = (cfg?.foundry as Record<string, unknown> | undefined)?.['edvVerify'];
    if (rawEdv === true) edvVerify = true;
  }

  const allItems: WorkItem[] = [];
  const observations: ScannerObservation[] = [];

  // Repos scanned sequentially to avoid thundering-herd on gh/npm APIs.
  for (const repo of repos) {
    // Scanners within each repo run in parallel; each is bounded + never throws.
    // cfg is threaded so scanners that consult flags (e.g. scanTodos checks
    // cfg.foundry.scanTodos) receive the live config rather than undefined.
    const perScannerResults = await Promise.all(
      scanners.map(async ({ scanner, descriptor }) => {
        try {
          if (descriptor) {
            const { runScannerWithObservations } = await import('./scanners.js');
            return await runScannerWithObservations(descriptor, scanner, repo, cfg);
          }
          return { items: await scanner(repo, cfg), observations: [] as ScannerObservation[] };
        } catch {
          // Belt-and-suspenders: scanners must not throw, but we catch anyway.
          return { items: [] as WorkItem[], observations: [] as ScannerObservation[] };
        }
      }),
    );
    for (const result of perScannerResults) {
      const items = result.items;
      allItems.push(...items.map((item) => ({ ...item, repo })));
      observations.push(...result.observations);
    }
  }

  // Dedupe by id, recompute score, sort descending.
  // M161: score = raw value/effort score × source-tier multiplier so substantive
  // sources (goal, issue, security, test) naturally outrank dep/lint/hygiene
  // even when raw scores are similar.
  //
  // Strategic focus weighting is intentionally gentler than source weighting:
  // core-fleet repos should win close calls, but support repos are still scanned
  // and can surface when they contain high-value work.
  const deduped = dedupeItems(allItems).map((item) => ({
    ...item,
    score: scoreItem(item.value, item.effort) *
      sourceTierMultiplier(item.source) *
      strategicRepoMultiplier(item.repo),
  }));
  deduped.sort((a, b) => b.score - a.score);

  // M124: value-filter gate — drop trivial / low-value items before persisting.
  // Two-stage: (1) drop items below minItemValue threshold, (2) drop items that
  // isTrivialItem flags as unlikely to yield a valuable diff. Both gates apply.
  const passed: WorkItem[] = [];
  const filtered: WorkItem[] = [];
  for (const item of deduped) {
    if (item.value < minValue) {
      filtered.push(item);
      continue;
    }
    const { trivial } = isTrivialItem(item);
    if (trivial) {
      filtered.push(item);
      continue;
    }
    passed.push(item);
  }

  // M161/M271: No-starvation guard — if ALL items were filtered by isTrivialItem
  // (not by the value gate) AND no substantive items exist, restore only
  // non-maintenance trivial-flagged items. Mechanical maintenance sources are not
  // worth frontier/judge cycles when the judge consistently rejects them.
  //
  // Condition: passed is empty but deduped is non-empty. In this case we restore
  // non-maintenance trivial-flagged items that still met the minValue threshold.
  if (passed.length === 0 && deduped.length > 0) {
    const valueGateOnly = deduped.filter(
      (item) => item.value >= minValue && !LOW_VALUE_MAINTENANCE_SOURCES.has(item.source),
    );
    passed.push(...valueGateOnly);
    // Remove the restored items from filtered to avoid double-counting in audit.
    const restoredIds = new Set(valueGateOnly.map((i) => i.id));
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (restoredIds.has(filtered[i]!.id)) filtered.splice(i, 1);
    }
  }

  // M133: Dedup vs open pending proposals — drop any item that already has an
  // open (pending) proposal so the same item cannot be re-filed N times while
  // one is still awaiting review.
  //
  // Matching strategy (robust, not naive substring):
  //   1. Match by item.id against proposal.workItemId (when set).
  //   2. Match by normalized title — strips punctuation/prefixes/case so minor
  //      wording differences don't cause false negatives, but the normalization
  //      is narrow enough that different items (different file paths, different
  //      issue numbers) still resolve to distinct tokens.
  //
  // False-positive avoidance: we do NOT match on raw title substring (that
  // would drop "Fix auth.ts:88" because "auth" appears in "Fix auth flow in
  // docs/auth.md"). The normalized-title approach requires the CORE noun phrase
  // to match, not just a shared substring.
  let passedAfterPendingDedup = passed;
  let pendingDedupCount = 0;
  try {
    const pendingProposals: Proposal[] = opts?.listPendingProposals
      ? opts.listPendingProposals()
      : await (async () => {
          try {
            const { listProposals: lp } = await import('../inbox/store.js');
            return lp({ status: 'pending' });
          } catch {
            return [] as Proposal[];
          }
        })();

    const blockingPendingProposals = blockingPendingProposalsForBacklog(pendingProposals, cfg);
    if (blockingPendingProposals.length > 0) {
      const pendingItemKeys = pendingProposalItemKeysForBacklog(passed, blockingPendingProposals);
      const pendingGlobalNormTitles = new Set<string>();
      const pendingRepoNormTitles = new Set<string>();
      for (const p of blockingPendingProposals) {
        const workItemId = typeof p.workItemId === 'string' ? p.workItemId.trim() : '';
        if (workItemId) continue;
        const normTitle = normalizeTitle(p.title);
        if (!normTitle) continue;
        if (p.repo) pendingRepoNormTitles.add(`${resolve(p.repo)}\0${normTitle}`);
        else pendingGlobalNormTitles.add(normTitle);
      }

      passedAfterPendingDedup = passed.filter((item) => {
        if (pendingItemKeys.has(workItemCoverageKey(item))) {
          pendingDedupCount++;
          return false;
        }
        const normTitle = normalizeTitle(item.title);
        if (item.repairGenerationId) return true;
        if (
          pendingGlobalNormTitles.has(normTitle) ||
          pendingRepoNormTitles.has(`${resolve(item.repo)}\0${normTitle}`)
        ) {
          pendingDedupCount++;
          return false;
        }
        return true;
      });
    }
  } catch {
    // Pending-dedup failure must never block backlog delivery.
    passedAfterPendingDedup = passed;
  }

  // M125: feedback-loop re-ranking — apply outcome priors to adjust item scores.
  // Gate: feedbackEnabled (default true; set cfg.foundry.feedbackEnabled=false to skip).
  // When enabled, items from historically-productive sources are up-ranked; noisy/
  // empty sources are down-ranked. Floor ≥ 0.5 keeps exploration alive.
  // Flag-off: no adjustment, byte-identical order to pre-M125.
  let finalItems = passedAfterPendingDedup;
  if (feedbackEnabled) {
    try {
      const priors = await computeOutcomePriors({ listProposals: opts?.listProposals, edvVerify });
      const adjusted = passedAfterPendingDedup.map((item) => {
        const multiplier = scoreAdjustment(item, priors);
        return multiplier === 1.0 ? item : { ...item, score: item.score * multiplier };
      });
      adjusted.sort((a, b) => b.score - a.score);
      finalItems = adjusted;
    } catch {
      // Feedback failure must never disrupt backlog delivery — fall through to
      // the original passed array (flag-off equivalent).
      finalItems = passed;
    }
  }

  const completeObservations = mergeConcurrentObservations(observations, undefined) ?? [];
  const observationsTruncated = completeObservations.length > MAX_PERSISTED_SCANNER_OBSERVATIONS;
  const backlog: Backlog = {
    generatedAt: now,
    snapshotId: randomBytes(16).toString('hex'),
    repos,
    items: finalItems,
    observations: completeObservations.slice(0, MAX_PERSISTED_SCANNER_OBSERVATIONS),
    observationSourceState: observationsTruncated ? 'degraded' : 'healthy',
    ...(observationsTruncated ? { observationsTruncated: true } : {}),
  };

  const fullSnapshot = sameRepoSet(repos, enrolledSnapshot);
  const shouldPersist = opts?.persist ?? (opts?.repos === undefined || fullSnapshot);
  if (shouldPersist) {
    // Persist; never throw on persistence failure.
    try {
      persistBacklog(backlog, { fullSnapshot });
    } catch {
      // Persistence failure does not prevent returning the in-memory backlog.
    }
  }

  // Audit record (metadata only; never secrets).
  const filteredMsg = filtered.length > 0 ? `; ${filtered.length} trivial/low-value item(s) filtered (minItemValue=${minValue})` : '';
  const dedupMsg = pendingDedupCount > 0 ? `; ${pendingDedupCount} item(s) deduplicated vs open pending proposals` : '';
  audit({
    action: 'backlog:refresh',
    repo: null,
    sandboxId: null,
    summary: `backlog refreshed: ${repos.length} repo(s), ${finalItems.length} item(s)${filteredMsg}${dedupMsg}`,
    result: 'ok',
  });

  return backlog;
}
