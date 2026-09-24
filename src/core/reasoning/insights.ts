/**
 * Reasoning insights + digest (V3.10, unit A7). Deterministic, NO model calls.
 *
 * `DigestBuilder` is fed steps and turn features (streamed from the store, in
 * any order) and folds them into a ReasoningDigest:
 *
 *  - insights: clusters of per-turn signals grouped by (kind, repo, engine,
 *    signature) — "`npm test` failed 7× across 3 turns in ashlr-hub (claude)".
 *    Titles are built from DERIVED labels (tool signatures, counts, repo
 *    basenames), never from reasoning text; evidence points at step ids or
 *    event refs so a reader can drill into the source.
 *  - trends: per local day, steps / struggling turns / winning turns.
 *
 * Pure: the builder does no I/O; reasoning-api.ts owns the reads and cache.
 * A local summariser (Track B) may later add prose — it would sit on top of
 * this, never replace it.
 */

import { createHash } from 'node:crypto';
import {
  BACKTRACK_TURN_MIN,
  UNCERTAIN_TURN_SCORE,
  repoLabel,
  type TurnFeaturesV1,
} from './extractors.js';
import type {
  ReasoningDigest,
  ReasoningEvidence,
  ReasoningInsight,
  ReasoningInsightKind,
  ReasoningSeverity,
  ReasoningStepV1,
  ReasoningTrendDay,
} from './types.js';

export const MAX_INSIGHTS = 50;
const MAX_EVIDENCE = 5;
const MAX_TREND_DAYS = 190;

const SEVERITY_RANK: Record<ReasoningSeverity, number> = { high: 3, warn: 2, info: 1 };

interface Cluster {
  kind: ReasoningInsightKind;
  /** Sub-kind so one (kind, repo, engine) can hold distinct stories (e.g. claim vs untested). */
  variant: string;
  repo: string | null;
  engine: string | null;
  signature: string | null;
  count: number;
  turns: Set<string>;
  evidence: ReasoningEvidence[];
  firstAt: string;
  lastAt: string;
}

interface ScopeTotals {
  turns: number;
  editingTurns: number;
}

function scopeKey(repo: string | null, engine: string | null): string {
  return `${repo ?? ''}\u0000${engine ?? ''}`;
}

/** YYYY-MM-DD in the server's local time zone (the contract's "local day"). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function where(repo: string | null, engine: string | null): string {
  const label = repoLabel(repo);
  return `${label ? ` in ${label}` : ''}${engine ? ` (${engine})` : ''}`;
}

export interface DigestWindow {
  fromMs: number;
  toMs: number;
}

export class DigestBuilder {
  private readonly window: DigestWindow;
  private readonly clusters = new Map<string, Cluster>();
  private readonly scopes = new Map<string, ScopeTotals>();
  private readonly trend = new Map<string, ReasoningTrendDay>();
  private readonly conversations = new Set<string>();
  private readonly byEngine: Record<string, number> = {};
  private steps = 0;

  constructor(window: DigestWindow) {
    this.window = window;
  }

  private inWindow(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= this.window.fromMs && ms <= this.window.toMs ? ms : null;
  }

  private day(ms: number): ReasoningTrendDay {
    const key = localDay(ms);
    let entry = this.trend.get(key);
    if (!entry) {
      entry = { day: key, steps: 0, struggles: 0, wins: 0 };
      this.trend.set(key, entry);
    }
    return entry;
  }

  addStep(step: ReasoningStepV1): void {
    const ms = this.inWindow(step.at);
    if (ms === null) return;
    this.steps += 1;
    this.byEngine[step.engine] = (this.byEngine[step.engine] ?? 0) + 1;
    const conversation = step.sessionId ?? step.runId;
    if (conversation) this.conversations.add(`${step.source}:${conversation}`);
    this.day(ms).steps += 1;
  }

  private cluster(
    kind: ReasoningInsightKind,
    variant: string,
    feature: TurnFeaturesV1,
    signature: string | null,
    count: number,
    evidence: ReasoningEvidence[] | undefined,
  ): void {
    const key = [kind, variant, feature.repo ?? '', feature.engine, signature ?? ''].join('\u0000');
    const at = feature.endedAt ?? feature.at;
    let cluster = this.clusters.get(key);
    if (!cluster) {
      cluster = {
        kind,
        variant,
        repo: feature.repo,
        engine: feature.engine,
        signature,
        count: 0,
        turns: new Set(),
        evidence: [],
        firstAt: feature.at,
        lastAt: at,
      };
      this.clusters.set(key, cluster);
    }
    cluster.count += count;
    cluster.turns.add(feature.id);
    cluster.firstAt = minIso(cluster.firstAt, feature.at);
    cluster.lastAt = maxIso(cluster.lastAt, at);
    for (const item of evidence ?? []) {
      if (!cluster.evidence.some((e) => e.ref === item.ref)) cluster.evidence.push(item);
    }
    // Keep the newest evidence: that is what an operator will want to open.
    if (cluster.evidence.length > MAX_EVIDENCE * 2) {
      cluster.evidence.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      cluster.evidence.length = MAX_EVIDENCE;
    }
  }

  addFeature(feature: TurnFeaturesV1): void {
    const ms = this.inWindow(feature.at);
    if (ms === null) return;
    const conversation = feature.sessionId ?? feature.runId;
    if (conversation) this.conversations.add(`${feature.source}:${conversation}`);

    const scope = scopeKey(feature.repo, feature.engine);
    const totals = this.scopes.get(scope) ?? { turns: 0, editingTurns: 0 };
    totals.turns += 1;
    if (feature.edits > 0) totals.editingTurns += 1;
    this.scopes.set(scope, totals);

    const trendMs = this.inWindow(feature.endedAt) ?? ms;
    if (feature.struggle) this.day(trendMs).struggles += 1;
    if (feature.win) this.day(trendMs).wins += 1;

    const ev = feature.evidence ?? {};
    for (const failure of feature.failures ?? []) {
      this.cluster('struggle', 'failure', feature, failure.signature, failure.count, failure.evidence ? [failure.evidence] : undefined);
    }
    if (feature.outcome === 'error') {
      this.cluster('struggle', 'error', feature, feature.errorClass ?? 'error', 1, ev.struggle);
    }
    if (feature.gaveUp) this.cluster('struggle', 'gave-up', feature, null, 1, ev.struggle);
    for (const loop of feature.loops ?? []) {
      this.cluster('loop', 'loop', feature, loop.signature, loop.count, loop.evidence ? [loop.evidence] : ev.loop);
    }
    if (feature.uncertaintyScore >= UNCERTAIN_TURN_SCORE) {
      this.cluster('uncertainty', 'uncertainty', feature, null, 1, ev.uncertainty);
    }
    if (feature.backtrackHits >= BACKTRACK_TURN_MIN || feature.reEditedFiles > 0) {
      this.cluster('backtrack', 'backtrack', feature, null, 1, ev.backtrack);
    }
    if (feature.claimUnverified) {
      this.cluster('verification-gap', 'claim', feature, null, 1, ev['verification-gap']);
    }
    if (feature.verificationGap) {
      this.cluster('verification-gap', 'untested', feature, null, 1, ev['verification-gap']);
    }
    if (feature.win) this.cluster('win', 'win', feature, null, 1, ev.win);
  }

  private toInsight(cluster: Cluster): ReasoningInsight | null {
    const turns = cluster.turns.size;
    const scope = this.scopes.get(scopeKey(cluster.repo, cluster.engine)) ?? { turns, editingTurns: turns };
    const loc = where(cluster.repo, cluster.engine);
    const sig = cluster.signature;
    let severity: ReasoningSeverity;
    let title: string;
    switch (cluster.variant) {
      case 'failure': {
        // One failure in one turn is noise; a signature failing repeatedly is a pattern.
        if (cluster.count < 2) return null;
        severity = cluster.count >= 6 || turns >= 3 ? 'high' : cluster.count >= 3 ? 'warn' : 'info';
        title = `"${sig}" failed ${cluster.count}× across ${plural(turns, 'turn')}${loc}`;
        break;
      }
      case 'error': {
        severity = turns >= 3 ? 'high' : turns >= 2 ? 'warn' : 'info';
        title = `${plural(turns, 'turn')} ended in ${sig === 'error' ? 'an error' : `${sig} errors`}${loc}`;
        break;
      }
      case 'gave-up': {
        severity = turns >= 3 ? 'high' : 'warn';
        title = `Gave up without making a change in ${plural(turns, 'turn')}${loc}`;
        break;
      }
      case 'loop': {
        severity = turns >= 4 || cluster.count >= 12 ? 'high' : turns >= 2 || cluster.count >= 5 ? 'warn' : 'info';
        title = `Repeated "${sig}" ${cluster.count}× without an edit in between (${plural(turns, 'turn')})${loc}`;
        break;
      }
      case 'uncertainty': {
        if (turns < 2) return null;
        const rate = turns / Math.max(1, scope.turns);
        severity = turns >= 5 && rate >= 0.5 ? 'high' : turns >= 3 && rate >= 0.3 ? 'warn' : 'info';
        title = `Uncertain reasoning in ${turns} of ${plural(scope.turns, 'turn')}${loc}`;
        break;
      }
      case 'backtrack': {
        if (turns < 2) return null;
        severity = turns >= 5 ? 'warn' : 'info';
        title = `Backtracked or re-edited the same file in ${plural(turns, 'turn')}${loc}`;
        break;
      }
      case 'claim': {
        // Claiming success with no passing check is the failure mode that
        // ships broken code — escalate fastest.
        severity = turns >= 2 ? 'high' : 'warn';
        title = `Claimed success without a passing test or build in ${plural(turns, 'turn')}${loc}`;
        break;
      }
      case 'untested': {
        const rate = turns / Math.max(1, scope.editingTurns);
        severity = turns >= 3 && rate >= 0.5 ? 'warn' : 'info';
        title = `Edited without testing afterwards in ${turns} of ${plural(scope.editingTurns, 'editing turn')}${loc}`;
        break;
      }
      case 'win': {
        severity = 'info';
        title = `Tests passed after edits in ${plural(turns, 'turn')}${loc}`;
        break;
      }
      default:
        return null;
    }
    const evidence = [...cluster.evidence]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_EVIDENCE);
    const id = 'ri-' + createHash('sha256')
      .update([cluster.kind, cluster.variant, cluster.repo ?? '', cluster.engine ?? '', sig ?? ''].join('\u0000'))
      .digest('hex')
      .slice(0, 16);
    return {
      id,
      kind: cluster.kind,
      repo: cluster.repo,
      engine: cluster.engine,
      severity,
      title,
      evidence,
      count: cluster.variant === 'failure' || cluster.variant === 'loop' ? cluster.count : turns,
      firstAt: cluster.firstAt,
      lastAt: cluster.lastAt,
    };
  }

  private trends(): ReasoningTrendDay[] {
    const out: ReasoningTrendDay[] = [];
    const cursor = new Date(this.window.fromMs);
    cursor.setHours(0, 0, 0, 0);
    const lastDay = localDay(this.window.toMs);
    for (let i = 0; i < MAX_TREND_DAYS; i += 1) {
      const key = localDay(cursor.getTime());
      out.push(this.trend.get(key) ?? { day: key, steps: 0, struggles: 0, wins: 0 });
      if (key >= lastDay) break;
      // setDate (not +86400000) so DST days still advance exactly one calendar day.
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  build(nowMs = Date.now(), maxInsights = MAX_INSIGHTS): ReasoningDigest {
    const insights = [...this.clusters.values()]
      .map((cluster) => this.toInsight(cluster))
      .filter((insight): insight is ReasoningInsight => insight !== null)
      .sort((a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Number(a.kind === 'win') - Number(b.kind === 'win') ||
        b.count - a.count ||
        Date.parse(b.lastAt) - Date.parse(a.lastAt) ||
        a.id.localeCompare(b.id))
      .slice(0, maxInsights);
    return {
      generatedAt: new Date(nowMs).toISOString(),
      window: { from: new Date(this.window.fromMs).toISOString(), to: new Date(this.window.toMs).toISOString() },
      totals: { steps: this.steps, sessions: this.conversations.size, byEngine: { ...this.byEngine } },
      insights,
      trends: this.trends(),
    };
  }
}

/** One-shot convenience for tests and small in-memory inputs. */
export function buildDigest(
  window: DigestWindow,
  steps: Iterable<ReasoningStepV1>,
  features: Iterable<TurnFeaturesV1>,
  nowMs = Date.now(),
): ReasoningDigest {
  const builder = new DigestBuilder(window);
  for (const step of steps) builder.addStep(step);
  for (const feature of features) builder.addFeature(feature);
  return builder.build(nowMs);
}
