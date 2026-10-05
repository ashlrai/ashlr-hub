import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AshlrConfig, Goal, GoalOutcomeBindingV1, WorkItem } from '../types.js';
import { goalsDir } from '../config.js';
import { createOutcomeGoalIfAbsent, goalSnapshotDigest, isValidGoalOutcomeBinding, loadGoal } from './store.js';
import { goalProjectMatchesRepo } from './project-match.js';
import { OutcomeStore } from './outcome-store.js';
import { OutcomeCoordinator } from './outcome-coordinator.js';
import { outcomeCanonical, outcomeDigest, outcomeIdentity, type OutcomeNode, type OutcomeState } from './outcome-types.js';

/** Same home as existing Goals; never resolve a store path supplied by a Goal/planner. */
export function outcomeDirectory(outcomeId: string): string {
  if (!outcomeIdentity(outcomeId)) throw new Error('Invalid outcome identity');
  // Canonicalize the existing home, including macOS /var aliases, without creating
  // .ashlr on read. The owned private store still rejects symlinks inside .ashlr.
  const canonicalHome = realpathSync.native(dirname(dirname(goalsDir())));
  return join(canonicalHome, '.ashlr', 'outcomes', outcomeId);
}
export function outcomeGoalBinding(outcomeId: string, node: OutcomeNode): GoalOutcomeBindingV1 {
  return { schemaVersion: 1, outcomeId, nodeId: node.id, nodeBasisDigest: outcomeDigest(node.basis),
    scopeRevision: node.basis.scopeRevision, scopeDigest: node.basis.scopeDigest };
}
function milestoneDetail(node: OutcomeNode): string {
  return `${node.basis.definition.deliverable}\nAcceptance:\n${node.basis.definition.acceptance.map(item => `- ${item}`).join('\n')}`;
}
/** Detached binding and concrete milestone must all agree with the immutable node basis.
 * Lifecycle fields may advance independently; they are checked by the relevant admission. */
export function matchesOutcomeGoal(state: OutcomeState, node: OutcomeNode, goal: Goal | null): goal is Goal {
  const milestone = goal?.milestones[0];
  return !!goal && isValidGoalOutcomeBinding(goal.outcome) &&
    outcomeCanonical(goal.outcome) === outcomeCanonical(outcomeGoalBinding(state.id, node)) &&
    goal.id === node.materialization.goalId && goal.project === node.basis.definition.repo &&
    goal.objective === node.basis.definition.objective &&
    outcomeCanonical(goal.mission) === outcomeCanonical({ schemaVersion: 1, graphDigest: node.basis.graphDigest,
      missionKey: state.id, nodeKey: node.basis.definition.key }) &&
    goal.milestones.length === 1 && milestone?.id === node.materialization.milestoneId &&
    milestone.title === node.basis.definition.title && milestone.detail === milestoneDetail(node);
}
export interface OutcomeGoalContext {
  store: OutcomeStore;
  state: OutcomeState;
  node: OutcomeNode;
  goal: Goal;
}
function readGoalContext(goal: Goal, repo: string): OutcomeGoalContext | null {
  try {
    if (!isValidGoalOutcomeBinding(goal.outcome)) return null;
    const store = new OutcomeStore(outcomeDirectory(goal.outcome.outcomeId));
    const read = store.read();
    const actualGoal = loadGoal(goal.id);
    if (read.sourceState !== 'healthy' || read.state.paused || !actualGoal ||
        goalSnapshotDigest(actualGoal) !== goalSnapshotDigest(goal) || actualGoal.status !== 'active' ||
        !['pending', 'in-progress'].includes(actualGoal.milestones[0]?.status ?? '')) return null;
    const node = read.state.nodes[goal.outcome.nodeId];
    if (!node || !read.state.activeNodeIds.includes(node.id) || node.basis.definition.kind !== 'work' ||
        node.materialization.state !== 'linked' || !matchesOutcomeGoal(read.state, node, actualGoal) ||
        !goalProjectMatchesRepo(actualGoal.project, repo)) return null;
    return { store, state: read.state, node, goal: actualGoal };
  } catch { return null; }
}
/** Read-only discovery admission. A WorkItem is a candidate, never provider permission. */
export function readOutcomeGoalForScan(goal: Goal, repo: string): OutcomeGoalContext | null {
  const context = readGoalContext(goal, repo);
  if (!context || context.goal.status !== 'active' || context.goal.milestones[0]?.status !== 'pending') return null;
  return new OutcomeCoordinator(context.store).project().ready.includes(context.node.id) ? context : null;
}
/** Reload exact protected Goal/outcome binding at the producer seam. This deliberately
 * permits a claimed context; actual claim ownership/generation and live grant admission
 * remain the loop's responsibility via coordinator.inspectClaim + producer fences. */
export function readOutcomeWorkItemContext(item: Pick<WorkItem, 'id' | 'source' | 'repo'>): OutcomeGoalContext | null {
  if (item.source !== 'goal') return null;
  const match = /^goal:(outcome-[a-f0-9]{64}):(milestone-[a-f0-9]{64})$/.exec(item.id);
  if (!match) return null;
  const goal = loadGoal(match[1]!);
  if (!goal || goal.milestones[0]?.id !== match[2]) return null;
  return readGoalContext(goal, item.repo);
}
export interface OutcomeMaterializationResult {
  sourceState: 'healthy' | 'missing' | 'degraded';
  outcomes: Array<{ nodeId: string; status: 'linked' | 'held' | 'conflict' }>;
}
/** Only local metadata writes. A crash between atomic Goal creation and intent
 * acknowledgment is replayable: deterministic IDs return the exact existing Goal. */
export function materializeOutcomeIntents(outcomeId: string, options: {
  stillAuthorized(): boolean;
  cfg?: Pick<AshlrConfig, 'user'>;
  now?: string;
}): OutcomeMaterializationResult {
  const store = new OutcomeStore(outcomeDirectory(outcomeId));
  const read = store.read();
  if (read.sourceState !== 'healthy') return { sourceState: read.sourceState, outcomes: [] };
  const coordinator = new OutcomeCoordinator(store);
  const results: OutcomeMaterializationResult['outcomes'] = [];
  for (const nodeId of coordinator.project().materializationIntents) {
    const latest = store.read();
    if (latest.sourceState !== 'healthy') return { sourceState: latest.sourceState, outcomes: results };
    const node = latest.state.nodes[nodeId];
    if (!node || latest.state.paused || !latest.state.activeNodeIds.includes(nodeId) || !node.basis.definition.repo ||
        options.stillAuthorized() !== true) { results.push({ nodeId, status: 'held' }); continue; }
    const result = createOutcomeGoalIfAbsent({ objective: node.basis.definition.objective, project: node.basis.definition.repo,
      mission: { schemaVersion: 1, graphDigest: node.basis.graphDigest, missionKey: outcomeId, nodeKey: node.basis.definition.key },
      outcome: outcomeGoalBinding(outcomeId, node), milestone: { title: node.basis.definition.title, detail: milestoneDetail(node) } }, { ...options, stillAuthorized: () => options.stillAuthorized() });
    if (result.status === 'failed') { results.push({ nodeId, status: 'held' }); continue; }
    if (!matchesOutcomeGoal(latest.state, node, result.goal)) { results.push({ nodeId, status: 'conflict' }); continue; }
    const linked = coordinator.linkMaterialization({ commandId: `materialize-${nodeId}`, expectedRevision: latest.state.revision },
      nodeId, node.materialization.goalId, node.materialization.milestoneId, { stillAuthorized: () => options.stillAuthorized(),
        matchesPersistedGoal: candidate => matchesOutcomeGoal(latest.state, candidate, loadGoal(candidate.materialization.goalId)) });
    results.push({ nodeId, status: linked.ok ? 'linked' : linked.reason === 'conflict' ? 'conflict' : 'held' });
  }
  return { sourceState: 'healthy', outcomes: results };
}
