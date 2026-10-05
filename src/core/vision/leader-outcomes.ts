/** The existing Leader plans durable outcomes; this port never launches agents or selects resources. */
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { EffectivePolicy } from '../authority/types.js';
import { repoIdentityOfPath } from '../fleet/repo-identity.js';
import { OutcomeCoordinator } from '../goals/outcome-coordinator.js';
import { goalProjectMatchesRepo } from '../goals/project-match.js';
import { outcomeDirectory } from '../goals/outcome-runtime.js';
import { OutcomeStore } from '../goals/outcome-store.js';
import { outcomeDigest, outcomeIdentity, type OutcomeState } from '../goals/outcome-types.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { cleanModelText } from './leader-memo.js';
import type { MissionGraphNodeInput } from './mission-graph.js';
import type { LeaderOutcomePlanIdentity, LeaderOutcomeRefinement } from './leader-types.js';

export interface OutcomeInventoryRead {
  sourceState: 'healthy' | 'missing' | 'degraded';
  complete: boolean;
  states: OutcomeState[];
  unreadable: number;
  limitExceeded: boolean;
}
/** Filesystem admission bound shared in scale with the immutable record store, not an outcome/agent quota. */
const MAX_OUTCOME_DIRECTORY_ENTRIES = 100_000;
export function readOutcomeInventory(rootPath?: string): OutcomeInventoryRead {
  const states: OutcomeState[] = [];
  let unreadable = 0;
  let limitExceeded = false;
  try {
    // Default-path failures are qualified discovery failures too. Evaluating
    // this outside the try would stop unrelated legacy backlog discovery.
    rootPath ??= dirname(outcomeDirectory('inventory'));
    // Inspect the owned parent when present; a missing parent must still have a real ancestor.
    try { inspectPrivateDirectory(dirname(rootPath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let ancestor = dirname(rootPath);
      for (;;) {
        try { lstatSync(ancestor); if (realpathSync.native(ancestor) !== ancestor) throw new Error('Unsafe outcome ancestor'); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
      }
    }
    let identity;
    try { identity = lstatSync(rootPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sourceState: 'missing', complete: true, states, unreadable, limitExceeded };
      }
      throw error;
    }
    inspectPrivateDirectory(rootPath);
    const handle = opendirSync(rootPath);
    let count = 0;
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (++count > MAX_OUTCOME_DIRECTORY_ENTRIES) { limitExceeded = true; break; }
        if (!entry.isDirectory() || !outcomeIdentity(entry.name)) { unreadable += 1; continue; }
        const read = new OutcomeStore(join(rootPath, entry.name)).read();
        if (read.sourceState !== 'healthy' || read.state.id !== entry.name) { unreadable += 1; continue; }
        states.push(read.state);
      }
    } finally { handle.closeSync(); }
    const after = lstatSync(rootPath);
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs || after.isSymbolicLink()) throw new Error('Outcome inventory changed while reading');
    states.sort((a, b) => a.id.localeCompare(b.id));
    const complete = unreadable === 0 && !limitExceeded;
    return { sourceState: complete ? 'healthy' : 'degraded', complete, states, unreadable, limitExceeded };
  } catch { return { sourceState: 'degraded', complete: false, states, unreadable: unreadable + 1, limitExceeded }; }
}
export interface LeaderOutcomeEvidence {
  sourceState: OutcomeInventoryRead['sourceState'];
  complete: boolean;
  unreadable: number;
  limitExceeded: boolean;
  outcomes: Array<{ outcomeId: string; scopeRevision: number; scopeDigest: string; planRevision: number;
    graphDigest: string | null; paused: boolean; desiredOutcome: string; acceptance: string[];
    targets: Array<{ alias: string; label: string }>; nodes: Array<{ nodeId?: string; key: string; kind: string; title: string;
      state: string; attemptId: string | null; terminalRunId: string | null; dependsOn: string[]; acceptance: string[] }> }>;
}
export function buildLeaderOutcomeEvidence(read: OutcomeInventoryRead): LeaderOutcomeEvidence {
  return { sourceState: read.sourceState, complete: read.complete, unreadable: read.unreadable, limitExceeded: read.limitExceeded,
    outcomes: read.states.map(state => ({ outcomeId: state.id, scopeRevision: state.scopeRevision, scopeDigest: state.scopeDigest,
      planRevision: state.planRevision, graphDigest: state.graphDigest, paused: state.paused,
      // Privacy replacements can expand text. Preserve the entire scrubbed
      // saved requirement; the original length is not an output/context cap.
      desiredOutcome: cleanModelText(state.scope.desiredOutcome, Number.POSITIVE_INFINITY) ?? '',
      acceptance: state.scope.acceptance.map(text => cleanModelText(text, Number.POSITIVE_INFINITY) ?? ''),
      targets: state.scope.targetRepos.map((repo, index) => ({ alias: `target-${index + 1}`, label: cleanModelText(basename(repo), 200) ?? 'target' })),
      nodes: state.activeNodeIds.map(id => { const node = state.nodes[id]!; return { nodeId: node.id, key: node.basis.definition.key,
        kind: node.basis.definition.kind, title: cleanModelText(node.basis.definition.title, 200) ?? '',
        state: node.completion ? 'complete' : node.humanApproval ? 'approved' : node.attempts.at(-1)?.state ?? 'pending',
        attemptId: node.attempts.at(-1)?.id ?? null, terminalRunId: node.attempts.at(-1)?.terminalRunId ?? null,
        dependsOn: node.basis.definition.dependsOn, acceptance: node.basis.definition.acceptance.map(text => cleanModelText(text, 500) ?? '') }; }) })) };
}
/** Retry identity uses saved scope and immutable failed attempts, never plan timestamps/revision churn. */
export function outcomePlanningBasis(evidence: LeaderOutcomeEvidence | undefined): string | null {
  if (!evidence?.complete || !['healthy', 'missing'].includes(evidence.sourceState)) return null;
  const pending = evidence.outcomes.filter(outcome => !outcome.paused && (outcome.graphDigest === null ||
    outcome.nodes.some(node => node.state === 'failed' || node.state === 'aborted')));
  if (pending.length === 0) return null;
  return outcomeDigest(pending.map(outcome => ({ outcomeId: outcome.outcomeId, scopeRevision: outcome.scopeRevision,
    scopeDigest: outcome.scopeDigest, unplanned: outcome.graphDigest === null,
    failed: outcome.nodes.filter(node => node.state === 'failed' || node.state === 'aborted').map(node => ({
      nodeId: node.nodeId ?? null, key: node.key, state: node.state, attemptId: node.attemptId, terminalRunId: node.terminalRunId,
    })).sort((a, b) => a.key.localeCompare(b.key)) })).sort((a, b) => a.outcomeId.localeCompare(b.outcomeId)));
}

/** A memo/action label is not progress: re-read the owned graph and require new executable work. */
export function outcomePlanningProgress(before: LeaderOutcomeEvidence | undefined, after: LeaderOutcomeEvidence | undefined):
  'progress' | 'stale' | 'unknown' | 'unchanged' {
  if (!before?.complete || !after?.complete || !['healthy', 'missing'].includes(before.sourceState) || !['healthy', 'missing'].includes(after.sourceState)) return 'unknown';
  let currentNeeds = false;
  for (const previous of before.outcomes) {
    if (previous.paused || previous.graphDigest !== null && !previous.nodes.some(node => node.state === 'failed' || node.state === 'aborted')) continue;
    const current = after.outcomes.find(outcome => outcome.outcomeId === previous.outcomeId);
    if (!current || current.paused || current.scopeRevision !== previous.scopeRevision || current.scopeDigest !== previous.scopeDigest) continue;
    currentNeeds = true;
    const previousIds = new Set(previous.nodes.map(node => node.nodeId).filter((id): id is string => typeof id === 'string'));
    if (previous.nodes.some(node => typeof node.nodeId !== 'string')) return 'unknown';
    const feasibility = new Map<string, boolean>();
    const feasible = (key: string, seen: Set<string>): boolean => {
      if (seen.has(key)) return false;
      const cached = feasibility.get(key);
      if (cached !== undefined) return cached;
      const node = current.nodes.find(item => item.key === key);
      if (!node || ['failed', 'aborted'].includes(node.state)) { feasibility.set(key, false); return false; }
      if (node.kind === 'human-gate') {
        const approved = node.state === 'approved' || node.state === 'complete';
        feasibility.set(key, approved); return approved;
      }
      const result = node.kind === 'work' && node.dependsOn.every(dependency => feasible(dependency, new Set([...seen, key])));
      // Successful shared DAG paths are context-independent. A dependency
      // failure may originate from this traversal's cycle guard: do not cache it.
      if (result) feasibility.set(key, true);
      return result;
    };
    if (current.graphDigest !== null && current.nodes.some(node => node.kind === 'work' && typeof node.nodeId === 'string' &&
      !previousIds.has(node.nodeId) && ['pending', 'claimed', 'running', 'proposed'].includes(node.state) && feasible(node.key, new Set()))) return 'progress';
  }
  return currentNeeds ? 'unchanged' : 'stale';
}
export type LeaderOutcomeApplyResult = { ok: true; applied: LeaderOutcomePlanIdentity } | { ok: false; reason: string };
export interface LeaderOutcomesPort {
  evidence(): LeaderOutcomeEvidence;
  refine(actionId: string, params: LeaderOutcomeRefinement, createdAt: string): LeaderOutcomeApplyResult;
  pausePlan(actionId: string, applied: LeaderOutcomePlanIdentity): { ran: boolean; detail: string };
}
export interface LeaderOutcomesDeps {
  now(): number;
  standingPolicy(): EffectivePolicy | null;
  enrollment(): { state: 'ready'; repos: string[] } | { state: 'degraded' };
  identityOfPath(repo: string): string | null;
  directory(outcomeId: string): string;
  inventory(): OutcomeInventoryRead;
}
export function createLeaderOutcomesPort(deps: LeaderOutcomesDeps): LeaderOutcomesPort {
  const ranks = { low: 0, medium: 1, high: 2 };
  const authorized = (state: OutcomeState, nodes: readonly MissionGraphNodeInput[] = []): boolean => {
    try {
      const policy = deps.standingPolicy(); const inventory = deps.enrollment();
      return policy?.switch === 'autonomous' && policy.leader.classes.includes('A') && inventory.state === 'ready' &&
        state.scope.targetRepos.every(repo => realpathSync.native(repo) === repo && inventory.repos.some(executionRepo =>
          realpathSync.native(executionRepo) === executionRepo && goalProjectMatchesRepo(repo, executionRepo)) &&
          policy.repos.some(granted => granted.nameWithOwner === deps.identityOfPath(repo))) &&
        nodes.every(node => node.kind === 'human-gate' || policy.repos.some(granted =>
          granted.nameWithOwner === deps.identityOfPath(node.targetRepo!) && ranks[node.riskClass] <= ranks[granted.maxRisk]));
    } catch { return false; }
  };
  return {
    evidence: () => buildLeaderOutcomeEvidence(deps.inventory()),
    refine(actionId, params, createdAt) {
      const coordinator = new OutcomeCoordinator(new OutcomeStore(deps.directory(params.outcomeId)));
      const read = coordinator.store.read();
      if (read.sourceState !== 'healthy') return { ok: false, reason: 'Outcome source is unavailable.' };
      const state = read.state;
      if (state.paused || state.scopeRevision !== params.scopeRevision || state.scopeDigest !== params.scopeDigest || !authorized(state)) {
        return { ok: false, reason: 'Outcome scope changed, is paused, or is outside current enrollment/authority.' };
      }
      if (params.nodes.some(node => node.kind !== 'work')) return { ok: false, reason: 'Automatic planning cannot invent human gates; an authenticated operator gate port is required.' };
      const nodes = params.nodes.map(node => {
        const index = typeof node.targetRepo === 'string' && /^target-[1-9][0-9]*$/.test(node.targetRepo) ? Number(node.targetRepo.slice(7)) - 1 : -1;
        return { ...node, targetRepo: node.kind === 'human-gate' ? null : state.scope.targetRepos[index] ?? '/unapproved-target' };
      });
      if (!authorized(state, nodes) || nodes.some(node => node.kind === 'work' && !state.scope.targetRepos.includes(node.targetRepo!))) {
        return { ok: false, reason: 'Plan target or risk exceeds the current approved scope.' };
      }
      const result = coordinator.refinePlan({ commandId: `leader-refine-${outcomeDigest(actionId)}`, expectedRevision: state.revision },
        { missionKey: state.id, title: params.title, objective: state.scope.desiredOutcome, createdAt, nodes },
        { sourceState: 'healthy', complete: true, repos: state.scope.targetRepos }, () => authorized(state, nodes));
      if (!result.ok || !result.state.graphDigest) return { ok: false, reason: result.ok ? 'Plan was not created.' : `Outcome plan held: ${result.reason}.` };
      return { ok: true, applied: { outcomeId: state.id, scopeRevision: state.scopeRevision, scopeDigest: state.scopeDigest,
        planRevision: result.state.planRevision, graphDigest: result.state.graphDigest } };
    },
    pausePlan(actionId, applied) {
      const coordinator = new OutcomeCoordinator(new OutcomeStore(deps.directory(applied.outcomeId)));
      const read = coordinator.store.read();
      if (read.sourceState !== 'healthy') return { ran: false, detail: 'Outcome source is unavailable; no state was changed.' };
      const state = read.state;
      if (state.scopeRevision !== applied.scopeRevision || state.scopeDigest !== applied.scopeDigest ||
          state.planRevision !== applied.planRevision || state.graphDigest !== applied.graphDigest || state.paused) {
        return { ran: false, detail: 'The outcome was changed or paused since this action; left as is.' };
      }
      const result = coordinator.setPaused({ commandId: `leader-pause-${outcomeDigest(actionId)}`, expectedRevision: state.revision }, true);
      return { ran: result.ok, detail: result.ok ? 'The applied plan was paused; immutable plan and attempt history remain. Prior state was not restored.' : `The plan could not be paused: ${result.reason}.` };
    },
  };
}
export async function loadDefaultLeaderOutcomesPort(policy: () => EffectivePolicy | null): Promise<LeaderOutcomesPort> {
  return createLeaderOutcomesPort({ now: () => Date.now(), standingPolicy: policy, enrollment: readEnrollmentRegistry,
    identityOfPath: repoIdentityOfPath, directory: outcomeDirectory, inventory: readOutcomeInventory });
}
