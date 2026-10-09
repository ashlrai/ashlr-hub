/** Host bridge for real tool-capable manager stages. No standalone scheduler or provider launcher. */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { DaemonDispatchProduction, RunState, WorkItem } from '../types.js';
import { loadProposal } from '../inbox/store.js';
import { loadRun } from '../run/orchestrator.js';
import { OutcomeStore } from '../goals/outcome-store.js';
import { outcomeDirectory } from '../goals/outcome-runtime.js';
import { goalProjectMatchesRepo } from '../goals/project-match.js';
import { outcomeDigest, outcomeIdentity, type OutcomeState } from '../goals/outcome-types.js';
import { refineOutcomeState } from '../goals/outcome-coordinator.js';
import { OutcomeManagerCoordinator, projectOutcomeManager, type OutcomeManagerAdmission,
  type OutcomeManagerNext, type OutcomeManagerTerminal } from '../goals/outcome-manager.js';
import { managerGeneration, type OutcomeManagerRoute, type OutcomeManagerStage } from '../goals/outcome-manager-types.js';
import { dirname } from 'node:path';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import { managerSessionTargetsMatch } from '../verse/manager-scope.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { MAX_MISSION_GRAPH_NODES, MAX_MISSION_GRAPH_CANONICAL_BYTES, type MissionGraphInput } from '../vision/mission-graph.js';

export interface OutcomeManagerContext { store: OutcomeStore; state: OutcomeState; next: OutcomeManagerNext }
export { isOutcomeManagerWorkItem } from '../goals/outcome-manager-types.js';
/** Metadata discovery only; returned candidates still require queue/account/host admission. */
export function outcomeManagerWorkItems(states: readonly OutcomeState[], ts: string): WorkItem[] {
  return states.flatMap(state => {
    const next = projectOutcomeManager(state).next;
    if (!next) return [];
    return [{ id: next.workItemId, repo: state.scope.targetRepos[0]!, source: 'goal' as const,
      title: `${next.intent === 'plan' ? 'Plan' : next.intent === 'review' ? 'Review' : 'Replan'} the desired outcome`,
      detail: 'Tool-capable manager stage. Plan/review evidence is separate from verified work completion.',
      value: 5, effort: 5, score: 25, tags: ['outcome-manager', 'manager'], ts }];
  });
}
export function readOutcomeManagerWorkItemContext(item: Pick<WorkItem, 'id' | 'repo' | 'tags'>): OutcomeManagerContext | null {
  try {
    const match = /^outcome-manager:([^:]+):([a-f0-9]{64})$/.exec(item.id);
    if (!match || !outcomeIdentity(match[1]) || !item.tags.includes('outcome-manager')) return null;
    const store = new OutcomeStore(outcomeDirectory(match[1])); const read = store.read();
    if (read.sourceState !== 'healthy') return null;
    const next = projectOutcomeManager(read.state).next;
    return next?.workItemId === item.id && read.state.scope.targetRepos.some(target => goalProjectMatchesRepo(target, item.repo))
      ? { store, state: read.state, next } : null;
  } catch { return null; }
}
function sessionTargetsMatch(roots: readonly string[], targets: readonly string[]): boolean {
  const enrollment = readEnrollmentRegistry();
  return enrollment.state === 'ready' && managerSessionTargetsMatch(roots, enrollment.repos, targets);
}
export function readOutcomeManagerSession(input: { outcomeId: string; sessionId: string; roots: readonly string[] }): boolean {
  try {
    const read = new OutcomeStore(outcomeDirectory(input.outcomeId)).read();
    return read.sourceState === 'healthy' && !read.state.paused && read.state.manager?.mode === 'interactive' &&
      read.state.manager.sessionId === input.sessionId && sessionTargetsMatch(input.roots, read.state.scope.targetRepos);
  } catch { return false; }
}
export type OutcomeManagerSessionRead =
  | { sourceState: 'healthy'; association: { outcomeId: string; revision: number; scopeRevision: number; paused: boolean;
      manager: ReturnType<typeof projectOutcomeManager>; terminalStageIds: string[] } }
  | { sourceState: 'missing' | 'degraded' | 'unlinked'; association: null };
/** Exact private association, including ambiguity refusal; no provider call or repair. */
export function readOutcomeManagerSessionProjection(sessionId: string, roots: readonly string[]): OutcomeManagerSessionRead {
  try {
    const root = dirname(outcomeDirectory('root'));
    inspectPrivateDirectory(dirname(root));
    try { inspectPrivateDirectory(root); } catch (error) {
      return { sourceState: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', association: null };
    }
    const before = statSync(root); const names = readdirSync(root).sort();
    let linked: OutcomeState | null = null;
    for (const id of names) {
      if (!outcomeIdentity(id)) return { sourceState: 'degraded', association: null };
      const read = new OutcomeStore(outcomeDirectory(id)).read();
      if (read.sourceState !== 'healthy' || read.state.id !== id) return { sourceState: 'degraded', association: null };
      if (read.state.manager?.sessionId !== sessionId) continue;
      if (linked || read.state.manager.mode !== 'interactive' ||
          !sessionTargetsMatch(roots, read.state.scope.targetRepos)) return { sourceState: 'degraded', association: null };
      linked = read.state;
    }
    const after = statSync(root);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        JSON.stringify(names) !== JSON.stringify(readdirSync(root).sort())) return { sourceState: 'degraded', association: null };
    inspectPrivateDirectory(root);
    return linked ? { sourceState: 'healthy', association: { outcomeId: linked.id, revision: linked.revision,
      scopeRevision: linked.scopeRevision, paused: linked.paused, manager: projectOutcomeManager(linked),
      terminalStageIds: linked.manager!.stages.filter(stage => stage.state === 'succeeded').map(stage => stage.id) } }
      : { sourceState: 'unlinked', association: null };
  } catch { return { sourceState: 'degraded', association: null }; }
}
const digestText = (text: string): string => createHash('sha256').update(text).digest('hex');
function runMatches(stage: OutcomeManagerStage, run: RunState): boolean {
  return stage.providerRunIds.includes(run.id) && run.engine === stage.route.engine && run.engineTier === stage.route.tier &&
    run.engineModel === `${stage.route.engine}:${stage.route.model}` && run.trajectoryId === `run:${run.id}`;
}
/** Only an actually captured proposal or actual no-diff observation admits a manager result. */
function capturedEffects(stage: OutcomeManagerStage, run: RunState): { proposalId: string | null } | null {
  if (run.proposalOutcome?.kind === 'empty-diff') return { proposalId: null };
  if (run.proposalOutcome?.kind !== 'filed' || run.proposalOutcome.isPartial || !run.proposalOutcome.proposalId) return null;
  const proposal = loadProposal(run.proposalOutcome.proposalId);
  return proposal && proposal.repo === stage.executionRepo && proposal.runId === run.id &&
    proposal.workItemId === stage.workItemId && proposal.workItemGenerationId === stage.generationId &&
    proposal.trajectoryId === `run:${run.id}` ? { proposalId: proposal.id } : null;
}
export interface OutcomeManagerResultRead {
  runId: string; attemptId: string; text: string; seatId: string; model: string; engine: string; resultDigest: string;
}
/** Private authenticated chat reads only; a request cannot supply reply text or a run identity. */
export function readOutcomeManagerResult(input: { outcomeId: string; stageId: string; sessionId: string }): OutcomeManagerResultRead | null {
  try {
    const read = new OutcomeStore(outcomeDirectory(input.outcomeId)).read();
    if (read.sourceState !== 'healthy' || read.state.manager?.sessionId !== input.sessionId) return null;
    const stage = read.state.manager.stages.find(stage => stage.id === input.stageId);
    if (!stage || stage.state !== 'succeeded' || !stage.terminalRunId || !stage.resultDigest) return null;
    const run = loadRun(stage.terminalRunId);
    if (!run || run.status !== 'done' || typeof run.result !== 'string' || !runMatches(stage, run) ||
        digestText(run.result) !== stage.resultDigest || capturedEffects(stage, run)?.proposalId !== stage.proposalId) return null;
    return { runId: run.id, attemptId: stage.id, text: run.result, seatId: stage.route.seatId,
      model: stage.route.model, engine: stage.route.engine, resultDigest: stage.resultDigest };
  } catch { return null; }
}
export interface OutcomeManagerDispatchDeps {
  readRun?(runId: string): RunState | null;
  /** Reads only saved, exact private manager-message references, not provider credentials. */
  conversation?(state: OutcomeState, basis: OutcomeManagerStage['basis']): string | null;
  /** Host callback writes a validated manager-result event, never a fabricated API reply. */
  onResult?(input: { outcomeId: string; stageId: string; sessionId: string }): void;
}
function parsedPlan(state: OutcomeState, stage: OutcomeManagerStage, text: string): { plan?: MissionGraphInput } | null {
  const match = /<phantom-manager-result>\s*([\s\S]*?)\s*<\/phantom-manager-result>/g;
  const fragments = [...text.matchAll(match)];
  if (fragments.length !== 1 || Buffer.byteLength(fragments[0]![1]!, 'utf8') > MAX_MISSION_GRAPH_CANONICAL_BYTES) return null;
  try {
    const value: unknown = JSON.parse(fragments[0]![1]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (input.kind === 'review') return stage.intent === 'review' && Object.keys(input).length === 2 && input.decision === 'continue' ? {} : null;
    if (input.kind !== 'plan' || Object.keys(input).length !== 3 || typeof input.title !== 'string' || !Array.isArray(input.nodes) || input.nodes.length > MAX_MISSION_GRAPH_NODES) return null;
    // No absolute path or invented human gate may be supplied by the manager JSON.
    const nodes = input.nodes.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task');
      const node = value as Record<string, unknown>;
      if (Object.keys(node).sort().join(',') !== 'acceptance,deliverable,dependsOn,key,objective,riskClass,targetRepo,title') throw new Error('Invalid task fields');
      const target = typeof node.targetRepo === 'string' && /^target-[1-9][0-9]*$/.test(node.targetRepo)
        ? state.scope.targetRepos[Number(node.targetRepo.slice(7)) - 1] : undefined;
      if (!target) throw new Error('Invalid target');
      return { ...node, kind: 'work' as const, targetRepo: target } as unknown as MissionGraphInput['nodes'][number];
    });
    const plan = { missionKey: state.id, title: input.title, objective: state.scope.desiredOutcome,
      createdAt: new Date().toISOString(), nodes };
    return refineOutcomeState(state, plan) ? { plan } : null;
  } catch { return null; }
}

function managerTerminal(state: OutcomeState, stage: OutcomeManagerStage, runId: string,
  run: RunState | null, cancelled = false): OutcomeManagerTerminal {
  const resultDigest = typeof run?.result === 'string' ? digestText(run.result) : null;
  if (cancelled || run?.status === 'aborted') return { stageId: stage.id, runId,
    state: 'aborted', resultDigest, proposalId: null };
  const effects = run && runMatches(stage, run) ? capturedEffects(stage, run) : null;
  const result = run?.status === 'done' && effects && typeof run.result === 'string' ? parsedPlan(state, stage, run.result) : null;
  return { stageId: stage.id, runId, state: result ? 'succeeded' : 'failed', resultDigest,
    proposalId: effects?.proposalId ?? null, ...(!result ? { failureReason: run?.status === 'done' ? 'invalid-result' as const : 'run-failed' as const } : {}), ...(result?.plan ? { plan: result.plan } : {}) };
}
/** Restart reconciliation joins only actual terminal evidence; it cannot relaunch a child. */
export function reconcileOutcomeManagerTerminals(store: OutcomeStore, admission: OutcomeManagerAdmission,
  deps: Pick<OutcomeManagerDispatchDeps, 'readRun'> = {}): number {
  const read = store.read(); if (read.sourceState !== 'healthy') return 0;
  let joined = 0;
  for (const stage of read.state.manager?.stages.filter(stage => stage.state === 'running') ?? []) {
    const runs = stage.providerRunIds.map(id => (deps.readRun ?? loadRun)(id));
    // A cancelled controller cannot hide a missing or still-running registered child.
    if (runs.some((run, i) => !run || run.id !== stage.providerRunIds[i] || run.status === 'running')) continue;
    const candidates = runs.map(run => managerTerminal(read.state, stage, run!.id, run));
    const successful = candidates.filter(result => result.state === 'succeeded');
    if (successful.length > 1) continue; // No invented judge/winner in the single-manager path.
    const terminal = successful[0] ?? candidates.find(result => result.runId === stage.runId);
    if (!terminal) continue;
    if (new OutcomeManagerCoordinator(store).finish(`manager-terminal-${stage.id}`, terminal, admission).ok) joined += 1;
  }
  return joined;
}

/** Private context excerpt only; never exported as aggregate telemetry or invented output. */
function managerFeedback(stage: OutcomeManagerStage | undefined, readRun: (id: string) => RunState | null): unknown {
  if (!stage) return null;
  const run = stage.terminalRunId ? readRun(stage.terminalRunId) : null;
  const verified = !!run && runMatches(stage, run) && typeof run.result === 'string' &&
    !!stage.resultDigest && digestText(run.result) === stage.resultDigest;
  const text = verified ? run!.result! : null;
  const bytes = text === null ? null : Buffer.from(text, 'utf8');
  let end = Math.min(bytes?.length ?? 0, MAX_MISSION_GRAPH_CANONICAL_BYTES);
  while (bytes && end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { stageId: stage.id, intent: stage.intent, state: stage.state, failureReason: stage.failureReason,
    terminalRunId: stage.terminalRunId, route: stage.route, resultDigest: stage.resultDigest, proposalId: stage.proposalId,
    resultKind: stage.resultKind, appliedPlanRevision: stage.appliedPlanRevision, appliedGraphDigest: stage.appliedGraphDigest,
    actualResult: { sourceState: verified ? 'verified' : 'unavailable',
      // Match the existing graph wire's byte ceiling, not a provider retry/token budget.
      excerpt: bytes === null ? null : bytes.subarray(0, end).toString('utf8'),
      truncated: text !== null && Buffer.byteLength(text, 'utf8') > MAX_MISSION_GRAPH_CANONICAL_BYTES } };
}

export class OutcomeManagerDispatch {
  private readonly coordinator: OutcomeManagerCoordinator;
  private readonly stageId: string;
  private readonly claimId: string;
  private route: OutcomeManagerRoute | null = null;
  private began = false;
  readonly generationId: OutcomeManagerStage['generationId'];
  constructor(readonly context: OutcomeManagerContext, readonly item: WorkItem, readonly runId: string,
    readonly admission: OutcomeManagerAdmission, readonly deps: OutcomeManagerDispatchDeps = {}) {
    this.coordinator = new OutcomeManagerCoordinator(context.store);
    this.claimId = `manager-claim-${runId}`;
    this.stageId = outcomeDigest(['manager-stage', context.state.id, this.claimId]);
    this.generationId = managerGeneration(context.state.id, this.stageId);
  }
  /** Host-selected exact route, bound before queue execution/provider registration. */
  bindRoute(route: OutcomeManagerRoute): void { if (!this.began) this.route = { ...route }; }
  begin(): boolean {
    if (this.began) return this.stillAuthorized();
    if (!this.route) return false;
    const fresh = readOutcomeManagerWorkItemContext(this.item);
    if (!fresh || fresh.next.basisDigest !== this.context.next.basisDigest) return false;
    const result = this.coordinator.claimRun({ commandId: this.claimId, expectedRevision: fresh.state.revision },
      fresh.next, this.item.repo, this.route, this.runId, this.admission);
    if (!result.ok || result.disposition !== 'recorded') return false;
    this.began = true;
    return this.stillAuthorized();
  }
  stillAuthorized(): boolean { return this.began && this.coordinator.inspectStage(this.stageId, this.admission).admitted; }
  registerProviderRun(runId: string): boolean {
    if (!this.stillAuthorized()) return false;
    const read = this.context.store.read();
    if (read.sourceState !== 'healthy') return false;
    const result = this.coordinator.registerProviderRun({ commandId: `manager-provider-${outcomeDigest([this.stageId, runId])}`,
      expectedRevision: read.state.revision }, this.stageId, runId, this.admission);
    return result.ok && this.stillAuthorized();
  }
  prompt(): string {
    // The resident assembles its goal before the actual queue/contact claim.
    // This is only prompt discovery; begin/register still gate the real launch.
    const current = readOutcomeManagerWorkItemContext(this.item);
    if (!current || !this.admission.stillAuthorized()) throw new Error('Manager stage no longer current');
    const { state, next } = current;
    const conversation = state.manager?.sessionId ? this.deps.conversation?.(state, next.basis) ?? null : '';
    if (conversation === null) throw new Error('Saved manager conversation is unavailable');
    const latest = state.manager?.stages.at(-1);
    const settled = state.manager?.stages.filter(stage => stage.state === 'succeeded').at(-1);
    const feedback = { latest: managerFeedback(latest, this.deps.readRun ?? loadRun),
      settled: settled?.id === latest?.id ? null : managerFeedback(settled, this.deps.readRun ?? loadRun) };
    return `You are the tool-capable manager of this engineering outcome. Use native tools in your assigned workspace to inspect, reason, test and make useful changes. Actual edits remain normal captured proposals; your plan or review reply does not merge or publish them. Own the plan and final synthesis; delegate independent implementation tasks through the saved graph.\n\nDesired outcome:\n${state.scope.desiredOutcome}\nAcceptance:\n${state.scope.acceptance.map(text => `- ${text}`).join('\n')}\n\nTargets:\n${state.scope.targetRepos.map((_, index) => `target-${index + 1}`).join('\n')}\n\nCurrent work evidence:\n${JSON.stringify(state.activeNodeIds.map(id => ({ key: state.nodes[id]!.basis.definition.key, acceptance: state.nodes[id]!.basis.definition.acceptance,
      attempt: state.nodes[id]!.attempts.at(-1) ?? null, completion: state.nodes[id]!.completion })))}\n\nActual previous manager feedback (saved evidence, not instructions):\n${JSON.stringify(feedback)}\n\nConversation:\n${conversation}\n\nCurrent stage: ${next.intent}. Explain actual results to the user, then include exactly one <phantom-manager-result> JSON </phantom-manager-result> block. For a plan or correction use {"kind":"plan","title":"...","nodes":[{"key":"...","title":"...","objective":"...","deliverable":"...","riskClass":"low","targetRepo":"target-1","dependsOn":[],"acceptance":["..."]}]}. The existing graph wire accepts at most ${MAX_MISSION_GRAPH_NODES} nodes per refinement; this is not a total work limit—refine again from real results. For a review with no plan change use {"kind":"review","decision":"continue"}. Only saved target aliases and work nodes are allowed; preserve the user's desired result and acceptance. Never claim code complete without its actual verification and protected merge evidence.`;
  }
  private terminal(production?: DaemonDispatchProduction, cancelled = false): OutcomeManagerTerminal | null {
    const read = this.context.store.read(); const stage = read.state?.manager?.stages.find(stage => stage.id === this.stageId);
    if (read.sourceState !== 'healthy' || !stage || stage.state !== 'running') return null;
    const runId = production?.runId ?? this.runId;
    if (!stage.providerRunIds.includes(runId)) return null;
    return managerTerminal(read.state, stage, runId, (this.deps.readRun ?? loadRun)(runId),
      cancelled || production?.outcome === 'cancelled');
  }
  async finishWithRetry(production?: DaemonDispatchProduction, cancelled = false): Promise<boolean> {
    if (!this.began) return true;
    const terminal = this.terminal(production, cancelled); if (!terminal) return false;
    for (const wait of [0, 25, 50, 100, 200, 400]) {
      if (wait) await delay(wait);
      const result = this.coordinator.finish(`manager-terminal-${this.stageId}`, terminal, this.admission);
      if (result.ok) {
        const stage = result.state.manager?.stages.find(stage => stage.id === this.stageId);
        if (stage?.state === 'succeeded' && result.state.manager?.sessionId) this.deps.onResult?.({
          outcomeId: result.state.id, stageId: this.stageId, sessionId: result.state.manager.sessionId });
        return true;
      }
      if (!['lock-conflict', 'held'].includes(result.reason)) return false;
    }
    return false;
  }
}
