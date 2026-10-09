/** Durable manager stages over the existing outcome journal; this class never launches work. */
import { realpathSync } from 'node:fs';
import type { MissionGraphInput } from '../vision/mission-graph.js';
import { OutcomeStore } from './outcome-store.js';
import { refineOutcomeState, type OutcomeAdmission, type OutcomeCommand } from './outcome-coordinator.js';
import { outcomeDigest, outcomeToken, type OutcomeState, type OutcomeWrite } from './outcome-types.js';
import { managerGeneration, managerWorkItemId, outcomeManagerBasis, validOutcomeManagerRoute,
  type OutcomeManagerIntent, type OutcomeManagerRoute, type OutcomeManagerStage } from './outcome-manager-types.js';

export interface OutcomeManagerMessageRef { sessionId: string; messageId: string; eventSeq: number }
export interface OutcomeManagerAdmission extends OutcomeAdmission {
  /** Host-only coverage of an immutable target by its current admitted workspace.
   * Absence retains the legacy exact-target execution check. This cannot admit
   * actual contact: that still needs executionRepoAllowed and the exact route. */
  targetRepoAllowed?(target: string): boolean;
  /** Exact native account/model contact admission, including current capacity. */
  routeAllowed(route: OutcomeManagerRoute, executionRepo: string): boolean;
  /** Exact current native route/policy binding; terminal metadata needs no new quota ticket. */
  routeCurrent(route: OutcomeManagerRoute, executionRepo: string): boolean;
  /** The host verifies the existing conversation reaches only the admitted outcome roots. */
  sessionAllowed(sessionId: string, state: OutcomeState): boolean;
  /** The reference must name an actual immutable private manager-message event. */
  messageExists(reference: OutcomeManagerMessageRef, state: OutcomeState): boolean;
  /** Model-authored risk/targets must fit the current host policy before plan publication. */
  planAllowed(state: OutcomeState, plan: MissionGraphInput): boolean;
}
export interface OutcomeManagerNext {
  intent: OutcomeManagerIntent;
  basis: OutcomeManagerStage['basis'];
  basisDigest: string;
  workItemId: string;
}
export interface OutcomeManagerProjection {
  sourceState: 'healthy' | 'missing' | 'degraded';
  enabled: boolean;
  mode: 'interactive' | 'resident' | null;
  sessionId: string | null;
  conversationRevision: number | null;
  running: OutcomeManagerStage | null;
  next: OutcomeManagerNext | null;
  latest: OutcomeManagerStage | null;
}
export function projectOutcomeManager(state: OutcomeState): OutcomeManagerProjection {
  const manager = state.manager;
  const basic: OutcomeManagerProjection = { sourceState: 'healthy', enabled: !!manager, mode: manager?.mode ?? null,
    sessionId: manager?.sessionId ?? null, conversationRevision: manager?.conversationRevision ?? null,
    running: null, next: null, latest: manager?.stages.at(-1) ?? null };
  if (!manager || state.paused || manager.mode === 'interactive' && manager.conversationRevision === 0) return basic;
  const running = manager.stages.find(stage => stage.state === 'running');
  if (running) return { ...basic, running };
  const basis = outcomeManagerBasis(state); const basisDigest = outcomeDigest(basis);
  if (manager.stages.some(stage => (stage.basisDigest === basisDigest || stage.settledBasisDigest === basisDigest) && stage.state === 'succeeded')) return basic;
  const attempts = state.activeNodeIds.flatMap(id => state.nodes[id]!.attempts.at(-1) ?? []);
  const failed = attempts.some(attempt => ['failed', 'aborted'].includes(attempt.state));
  const last = manager.stages.at(-1);
  const failedManager = !!last && ['failed', 'aborted', 'stale'].includes(last.state) &&
    last.basis.scopeRevision === state.scopeRevision && last.basis.planRevision === state.planRevision;
  const changedConversation = manager.conversationRevision > (manager.stages.at(-1)?.basis.conversationRevision ?? 0);
  const intent: OutcomeManagerIntent | null = state.graphDigest === null ? 'plan'
    : failed || failedManager || changedConversation ? 'replan'
      : attempts.some(attempt => ['proposed', 'complete'].includes(attempt.state)) ? 'review' : null;
  return intent ? { ...basic, next: { intent, basis, basisDigest, workItemId: managerWorkItemId(state.id, basisDigest) } } : basic;
}
function targetAllowed(target: string, admission: OutcomeManagerAdmission): boolean {
  return admission.targetRepoAllowed
    ? admission.targetRepoAllowed(target)
    : admission.executionRepoAllowed(target, target);
}
function admitted(state: OutcomeState, admission: OutcomeManagerAdmission): boolean {
  try {
    return !state.paused && admission.stillAuthorized() && state.scope.targetRepos.every(repo =>
      realpathSync.native(repo) === repo && targetAllowed(repo, admission)) &&
      (state.manager?.sessionId == null || admission.sessionAllowed(state.manager.sessionId, state));
  } catch { return false; }
}
export interface OutcomeManagerTerminal {
  stageId: string;
  runId: string;
  state: 'succeeded' | 'failed' | 'aborted';
  resultDigest: string | null;
  proposalId: string | null;
  failureReason?: 'invalid-result' | 'plan-refused' | 'run-failed';
  /** A host-parsed actual manager result. Never exposed as a caller-authored API operation. */
  plan?: MissionGraphInput;
}
export class OutcomeManagerCoordinator {
  constructor(readonly store: OutcomeStore) {}
  project(): OutcomeManagerProjection {
    const read = this.store.read();
    return read.sourceState === 'healthy' ? projectOutcomeManager(read.state) : { sourceState: read.sourceState,
      enabled: false, mode: null, sessionId: null, conversationRevision: null, running: null, next: null, latest: null };
  }
  configure(command: OutcomeCommand, config: { mode: 'interactive' | 'resident'; sessionId: string | null },
    admission: OutcomeManagerAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'manager-configure', config }, current => {
      if (!current || !admitted(current, admission) || !['interactive', 'resident'].includes(config.mode) ||
          !(config.sessionId === null || outcomeToken(config.sessionId)) ||
          config.mode === 'interactive' && config.sessionId === null ||
          config.sessionId !== null && !admission.sessionAllowed(config.sessionId, current)) return null;
      if (current.manager) {
        // Moving a saved conversation is a different outcome, never an alias for its existing history.
        if (current.manager.sessionId !== config.sessionId || current.manager.stages.some(stage => stage.state === 'running')) return null;
        current.manager.mode = config.mode;
      } else current.manager = { schemaVersion: 1, ...config, conversationRevision: 0, interjections: [], stages: [] };
      current.schemaVersion = 2;
      return current;
    }, () => admission.stillAuthorized());
  }
  interject(command: OutcomeCommand, reference: OutcomeManagerMessageRef, admission: OutcomeManagerAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'manager-interject', reference }, current => {
      if (!current?.manager || !admitted(current, admission) || reference.sessionId !== current.manager.sessionId ||
          !outcomeToken(reference.messageId) || !Number.isSafeInteger(reference.eventSeq) || reference.eventSeq < 1 ||
          !admission.messageExists(reference, current)) return null;
      const previous = current.manager.interjections.find(message => message.messageId === reference.messageId);
      if (previous) return previous.sessionId === reference.sessionId && previous.eventSeq === reference.eventSeq ? current : null;
      const last = current.manager.interjections.at(-1);
      if (last && reference.eventSeq <= last.eventSeq) return null;
      current.manager.conversationRevision += 1;
      current.manager.interjections.push({ ...reference, revision: current.manager.conversationRevision });
      return current;
    }, () => admission.stillAuthorized());
  }
  claimRun(command: OutcomeCommand, expected: OutcomeManagerNext, executionRepo: string,
    route: OutcomeManagerRoute, runId: string, admission: OutcomeManagerAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision,
      { kind: 'manager-claim-run', expected, executionRepo, route, runId }, current => {
        if (!current?.manager || !admitted(current, admission) || !validOutcomeManagerRoute(route) || !outcomeToken(runId) ||
            realpathSync.native(executionRepo) !== executionRepo ||
            !current.scope.targetRepos.some(target => admission.executionRepoAllowed(target, executionRepo)) ||
            !admission.routeAllowed(route, executionRepo)) return null;
        const projected = projectOutcomeManager(current).next;
        if (!projected || outcomeDigest(projected) !== outcomeDigest(expected)) return null;
        const id = outcomeDigest(['manager-stage', current.id, command.commandId]);
        current.manager.stages.push({ id, ...expected, executionRepo, route,
          generationId: managerGeneration(current.id, id), runId, providerRunIds: [runId], state: 'running',
          terminalRunId: null, resultDigest: null, resultKind: null, proposalId: null,
          appliedPlanRevision: null, appliedGraphDigest: null, settledBasisDigest: null, failureReason: null });
        return current;
      }, () => admission.stillAuthorized() && admission.routeAllowed(route, executionRepo));
  }
  inspectStage(stageId: string, admission: OutcomeManagerAdmission): { admitted: true; state: OutcomeState; stage: OutcomeManagerStage } | { admitted: false } {
    const read = this.store.read();
    if (read.sourceState !== 'healthy' || !admitted(read.state, admission)) return { admitted: false };
    const stage = read.state.manager?.stages.find(stage => stage.id === stageId);
    try {
      if (!stage || stage.state !== 'running' || outcomeDigest(outcomeManagerBasis(read.state)) !== stage.basisDigest ||
          !read.state.scope.targetRepos.some(target => admission.executionRepoAllowed(target, stage.executionRepo)) ||
          !admission.routeAllowed(stage.route, stage.executionRepo)) return { admitted: false };
      return { admitted: true, state: read.state, stage };
    } catch { return { admitted: false }; }
  }
  registerProviderRun(command: OutcomeCommand, stageId: string, runId: string, admission: OutcomeManagerAdmission): OutcomeWrite {
    const inspected = this.inspectStage(stageId, admission);
    if (!inspected.admitted || !outcomeToken(runId)) return { ok: false, reason: 'held' };
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'manager-provider', stageId, runId }, current => {
      if (!current?.manager || !admitted(current, admission)) return null;
      const stage = current.manager.stages.find(stage => stage.id === stageId);
      if (!stage || stage.state !== 'running' || stage.basisDigest !== outcomeDigest(outcomeManagerBasis(current)) ||
          !admission.routeAllowed(stage.route, stage.executionRepo)) return null;
      if (!stage.providerRunIds.includes(runId)) stage.providerRunIds.push(runId);
      return current;
    }, () => admission.stillAuthorized() && admission.routeAllowed(inspected.stage.route, inspected.stage.executionRepo));
  }
  /** Terminal history survives an unrelated edit; obsolete results never revise the current plan. */
  finish(commandId: string, terminal: OutcomeManagerTerminal, admission: OutcomeManagerAdmission): OutcomeWrite {
    let applied = false;
    let admittedBasis: OutcomeState | null = null;
    let admittedRoute: OutcomeManagerRoute | null = null;
    let executionRepo: string | null = null;
    return this.store.transactCurrent(commandId, { kind: 'manager-terminal', terminal }, current => {
      const stage = current?.manager?.stages.find(stage => stage.id === terminal.stageId);
      if (!current || !stage || stage.state !== 'running' || !stage.providerRunIds.includes(terminal.runId) ||
          !['succeeded', 'failed', 'aborted'].includes(terminal.state)) return null;
      const currentBasis = stage.basisDigest === outcomeDigest(outcomeManagerBasis(current));
      const mayApply = currentBasis && admitted(current, admission) && admission.routeCurrent(stage.route, stage.executionRepo);
      let result = current;
      if (terminal.state === 'succeeded' && mayApply) {
        admittedBasis = structuredClone(current); admittedRoute = stage.route; executionRepo = stage.executionRepo;
        if (!terminal.resultDigest) return null;
        if (terminal.plan) {
          if (terminal.plan.missionKey !== current.id || terminal.plan.objective !== current.scope.desiredOutcome ||
              terminal.plan.nodes.some(node => node.kind !== 'work' || !current.scope.targetRepos.includes(node.targetRepo!) ||
                !targetAllowed(node.targetRepo!, admission))) return null;
          if (!admission.planAllowed(current, terminal.plan)) {
            stage.state = 'failed'; stage.failureReason = 'plan-refused';
            stage.terminalRunId = terminal.runId; stage.resultDigest = terminal.resultDigest; stage.proposalId = terminal.proposalId;
            return current;
          }
          const refined = refineOutcomeState(current, terminal.plan);
          if (!refined) return null;
          result = refined;
          stage.resultKind = 'plan-applied'; stage.appliedPlanRevision = result.planRevision; stage.appliedGraphDigest = result.graphDigest;
        } else {
          if (stage.intent !== 'review') return null;
          stage.resultKind = 'review-recorded';
        }
        stage.state = 'succeeded'; applied = true;
      } else stage.state = terminal.state === 'aborted' ? 'aborted' : !currentBasis || !mayApply ? 'stale' : 'failed';
      stage.terminalRunId = terminal.runId; stage.resultDigest = terminal.resultDigest; stage.proposalId = terminal.proposalId;
      stage.failureReason = stage.state === 'failed' ? terminal.failureReason ?? 'run-failed' : null;
      if (applied) stage.settledBasisDigest = outcomeDigest(outcomeManagerBasis(result));
      return result;
    // The store owns the source revision lock through publication. Reading its staged
    // record here would correctly mark it incomplete, so recheck live authority
    // against the exact admitted source snapshot rather than the unpublished ledger.
    }, () => !applied || !!admittedBasis && !!admittedRoute && !!executionRepo &&
      admitted(admittedBasis, admission) && admission.routeCurrent(admittedRoute, executionRepo) &&
      (!terminal.plan || admission.planAllowed(admittedBasis, terminal.plan)));
  }
}
