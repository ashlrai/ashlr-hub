import { canonical, digest } from './artifacts.js';
import { readUniverseCampaign, validateUniverseCampaignDefinition } from './campaign-store.js';
import type { UniverseCampaignSummary, UniverseStoreOptions } from './types.js';
import type {
  UniversePortfolioDefinition, UniversePortfolioPlan, UniversePortfolioPlanNode, UniversePortfolioTask,
} from './portfolio-types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TASKS = 64;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}

function integer(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}

function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

/** Iterative Kahn ordering; every choice prefers the earliest caller-declared task. */
function topologicalOrder(tasks: UniversePortfolioTask[]): string[] {
  const remaining = new Map(tasks.map((task) => [task.campaignId, task.dependsOn.length]));
  const dependants = new Map(tasks.map((task) => [task.campaignId, [] as string[]]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependants.get(dependency)!.push(task.campaignId);
  const ordered: string[] = [];
  while (ordered.length < tasks.length) {
    const next = tasks.find((task) => remaining.get(task.campaignId) === 0);
    if (!next) throw new Error('Invalid Universe portfolio: dependency cycle');
    remaining.delete(next.campaignId);
    ordered.push(next.campaignId);
    for (const dependant of dependants.get(next.campaignId)!) remaining.set(dependant, remaining.get(dependant)! - 1);
  }
  return ordered;
}

/** Return an exact independent definition snapshot without retaining caller-owned arrays. */
export function validateUniversePortfolioDefinition(value: unknown): UniversePortfolioDefinition {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'tasks', 'maxParallel', 'maxDurationMs']) ||
      value.schemaVersion !== 1 || !identifier(value.id) || !Array.isArray(value.tasks) ||
      value.tasks.length < 1 || value.tasks.length > MAX_TASKS || !integer(value.maxParallel, 1, 8) ||
      !integer(value.maxDurationMs, 1, 86_400_000)) {
    throw new Error('Invalid Universe portfolio: bounded identity, explicit tasks, concurrency and duration required');
  }
  const tasks: UniversePortfolioTask[] = [];
  const known = new Set<string>();
  for (const task of value.tasks) {
    if (!object(task) || !exact(task, ['campaignId', 'dependsOn']) || !identifier(task.campaignId) ||
        known.has(task.campaignId) || !Array.isArray(task.dependsOn) || task.dependsOn.length >= MAX_TASKS) {
      throw new Error('Invalid Universe portfolio: unique campaign tasks and bounded dependencies required');
    }
    const dependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (!identifier(dependency) || dependency === task.campaignId || dependencies.has(dependency)) {
        throw new Error('Invalid Universe portfolio: unique non-self dependencies required');
      }
      dependencies.add(dependency);
    }
    known.add(task.campaignId);
    tasks.push({ campaignId: task.campaignId, dependsOn: [...dependencies] });
  }
  for (const task of tasks) if (task.dependsOn.some((dependency) => !known.has(dependency))) {
    throw new Error('Invalid Universe portfolio: dependency must name an enrolled campaign');
  }
  topologicalOrder(tasks);
  return { schemaVersion: 1, id: value.id, tasks, maxParallel: value.maxParallel, maxDurationMs: value.maxDurationMs };
}

function healthyIdentity(campaign: UniverseCampaignSummary, campaignId: string): boolean {
  try {
    const definition = validateUniverseCampaignDefinition(campaign.definition);
    return campaign.sourceState === 'healthy' && campaign.reasons.length === 0 && definition.id === campaignId &&
      campaign.definitionDigest === digest(canonical(definition)) && HASH.test(campaign.manifestDigest) &&
      HASH.test(campaign.comparatorDigest) && ['ready', 'running', 'pause-requested', 'paused', 'stop-requested',
        'stopped', 'completed', 'interrupted', 'failed'].includes(campaign.state);
  } catch { return false; }
}

/**
 * Project selected campaign snapshots only. Dependencies express ordering, not
 * artifact transfer, accepted changes, or proof that an earlier campaign caused a result.
 */
export function buildUniversePortfolioPlan(input: unknown,
  campaigns: ReadonlyMap<string, UniverseCampaignSummary | null>, sampledAt = new Date().toISOString()): UniversePortfolioPlan {
  const definition = validateUniversePortfolioDefinition(input);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(sampledAt) ||
      !Number.isFinite(Date.parse(sampledAt)) || new Date(sampledAt).toISOString() !== sampledAt) {
    throw new Error('Invalid Universe portfolio sample time');
  }
  const reasons: string[] = [];
  const nodes: UniversePortfolioPlanNode[] = definition.tasks.map((task) => {
    // Clone both the definition and snapshots: returned pins cannot alias mutable
    // caller maps or a campaign summary retained by another consumer.
    const observed = campaigns.get(task.campaignId) ?? null;
    const campaign = observed === null ? null : structuredClone(observed);
    const node: UniversePortfolioPlanNode = { campaignId: task.campaignId, dependsOn: [...task.dependsOn],
      universeId: null, campaign, definitionDigest: null, manifestDigest: null, comparatorDigest: null,
      state: 'unavailable', reason: 'Campaign evidence is missing or degraded' };
    if (!campaign || !healthyIdentity(campaign, task.campaignId)) {
      reasons.push(`${task.campaignId}: campaign evidence is missing, degraded, or has inconsistent identity`);
      return node;
    }
    Object.assign(node, { universeId: campaign.definition.universeId, definitionDigest: campaign.definitionDigest,
      manifestDigest: campaign.manifestDigest, comparatorDigest: campaign.comparatorDigest });
    if (campaign.state === 'completed') {
      node.state = 'completed'; node.reason = 'Campaign completed; ordering satisfied, not an accepted-work claim';
    } else if (campaign.state === 'running') {
      node.state = 'busy'; node.reason = 'Campaign already has an execution owner';
    } else if (['failed', 'stopped', 'pause-requested', 'stop-requested'].includes(campaign.state)) {
      node.state = 'blocked'; node.reason = `Campaign is ${campaign.state}`;
    } else {
      node.state = 'ready'; node.reason = null;
    }
    return node;
  });
  const byId = new Map(nodes.map((node) => [node.campaignId, node]));
  const universes = new Map<string, UniversePortfolioPlanNode[]>();
  for (const node of nodes) if (node.universeId !== null) {
    universes.set(node.universeId, [...(universes.get(node.universeId) ?? []), node]);
  }
  for (const group of universes.values()) if (group.length > 1) {
    for (const node of group) {
      node.state = 'blocked'; node.reason = 'Portfolio campaigns must use distinct Universes';
      reasons.push(`${node.campaignId}: another enrolled campaign uses the same Universe`);
    }
  }
  const ordered = topologicalOrder(definition.tasks);
  for (const id of ordered) {
    const node = byId.get(id)!;
    // Already-completed evidence remains completed regardless of declared edges:
    // the portfolio must not retroactively claim dependency causality.
    if (node.state !== 'ready') continue;
    const dependencies = node.dependsOn.map((dependency) => byId.get(dependency)!);
    if (dependencies.some((dependency) => dependency.state === 'blocked' || dependency.state === 'unavailable')) {
      node.state = 'blocked'; node.reason = 'A campaign dependency is blocked or unavailable';
    } else if (dependencies.some((dependency) => dependency.state !== 'completed')) {
      node.state = 'waiting'; node.reason = 'Waiting for campaign dependencies to complete';
    }
  }
  return { schemaVersion: 1, definition, definitionDigest: digest(canonical(definition)), sampledAt,
    measurementScope: 'local-experiment', sourceState: reasons.length ? 'degraded' : 'healthy', reasons, nodes,
    topologicalOrder: ordered };
}

/** Targeted, read-only planning: missing storage is never initialized. */
export function readUniversePortfolioPlan(input: unknown, options: UniverseStoreOptions = {}): UniversePortfolioPlan {
  const definition = validateUniversePortfolioDefinition(input);
  const campaigns = new Map<string, UniverseCampaignSummary | null>();
  for (const task of definition.tasks) {
    try { campaigns.set(task.campaignId, readUniverseCampaign(task.campaignId, options)); }
    catch { campaigns.set(task.campaignId, null); }
  }
  return buildUniversePortfolioPlan(definition, campaigns);
}
