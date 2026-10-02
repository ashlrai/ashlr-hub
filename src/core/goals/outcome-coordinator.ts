import { realpathSync } from 'node:fs';
import type { Proposal } from '../types.js';
import { canonicalRealizedMergeIdentity } from '../inbox/realized-merge.js';
import { proposalCompletesGoalMilestone } from './completion.js';
import { compileEcosystemMissionGraph, type MissionGraphInput } from '../vision/mission-graph.js';
import { OutcomeStore } from './outcome-store.js';
import { normalizeOutcomeScope, outcomeDigest, outcomeGraphObjective, outcomeIdentity, outcomeToken,
  type OutcomeAttempt, type OutcomeNode, type OutcomeScope, type OutcomeState, type OutcomeWrite } from './outcome-types.js';

export interface OutcomeCommand { commandId: string; expectedRevision: number }
export interface OutcomeInventory { sourceState: 'healthy' | 'missing' | 'degraded'; complete: boolean; repos: readonly string[] }
/** Host-owned live admission, including standing grant, Stop, lane and financial policy.
 * Functions are never accepted from persisted JSON or a planner. This fence must be checked
 * again by the actual producer immediately before provider contact. */
export interface OutcomeAdmission {
  stillAuthorized(): boolean;
  executionRepoAllowed(approvedTarget: string, executionRepo: string): boolean;
}
export interface OutcomeMaterializationAdmission {
  stillAuthorized(): boolean;
  /** The host must read the exact existing Goal/milestone and immutable node linkage,
   * or successfully perform its existing CAS materialization, before acknowledging. */
  matchesPersistedGoal(node: OutcomeNode): boolean;
}
export interface OutcomeTerminal {
  nodeId: string;
  attemptId: string;
  generationId: OutcomeAttempt['generationId'];
  executionRepo: string;
  runId: string;
  proposalId: string | null;
  state: 'proposed' | 'failed' | 'aborted';
}
export interface OutcomeProjection {
  sourceState: 'healthy' | 'missing' | 'degraded';
  revision: number | null;
  paused: boolean | null;
  ready: string[];
  materializationIntents: string[];
  /** All active graph nodes have authenticated completion/explicit gate evidence. */
  complete: boolean;
}
function completed(node: OutcomeNode | undefined): boolean { return !!(node?.completion || node?.humanApproval); }
function ready(state: OutcomeState, node: OutcomeNode): boolean {
  return !state.paused && state.activeNodeIds.includes(node.id) && !node.completion &&
    node.basis.definition.kind === 'work' && node.materialization.state === 'linked' &&
    !node.attempts.length && node.basis.dependencies.every(id => completed(state.nodes[id]));
}
function registeredAttempt(state: OutcomeState, terminal: OutcomeTerminal): OutcomeAttempt | null {
  const node = state.nodes[terminal.nodeId];
  const attempt = node?.attempts.find(value => value.id === terminal.attemptId);
  return attempt?.id === terminal.attemptId &&
    attempt.generationId === terminal.generationId && attempt.executionRepo === terminal.executionRepo &&
    attempt.providerRunIds.includes(terminal.runId) ? attempt : null;
}
function recordTerminal(current: OutcomeState | null, terminal: OutcomeTerminal): OutcomeState | null {
  if (!current) return null;
  const attempt = registeredAttempt(current, terminal);
  if (!attempt || attempt.state !== 'running' || !['proposed', 'failed', 'aborted'].includes(terminal.state) ||
      (terminal.state === 'proposed' ? !outcomeToken(terminal.proposalId) : terminal.proposalId !== null)) return null;
  // Retired nodes retain truthful terminal history; completion is active-only.
  attempt.state = terminal.state;
  attempt.terminalRunId = terminal.runId;
  attempt.proposalId = terminal.proposalId;
  return current;
}

/** Durable coordination only. The parent Fleet runtime owns materialization, dispatch,
 * authentication, merge and recovery scheduling; this object never launches work. */
export class OutcomeCoordinator {
  constructor(readonly store: OutcomeStore) {}
  project(): OutcomeProjection {
    const read = this.store.read();
    if (read.sourceState !== 'healthy') return { sourceState: read.sourceState, revision: null, paused: null,
      ready: [], materializationIntents: [], complete: false };
    const state = read.state;
    return { sourceState: 'healthy', revision: state.revision, paused: state.paused,
      ready: state.activeNodeIds.filter(id => ready(state, state.nodes[id]!)),
      materializationIntents: state.paused ? [] : state.activeNodeIds.filter(id => state.nodes[id]!.basis.definition.kind === 'work' && state.nodes[id]!.materialization.state === 'intent'),
      complete: state.activeNodeIds.length > 0 && state.activeNodeIds.every(id => completed(state.nodes[id])) };
  }
  start(command: OutcomeCommand, id: string, scope: OutcomeScope): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'start', id, scope }, current => {
      if (current || !outcomeIdentity(id)) return null;
      const normalized = normalizeOutcomeScope(scope);
      return { schemaVersion: 1, id, revision: 0, scopeRevision: 1, scope: normalized, scopeDigest: outcomeDigest(normalized),
        planRevision: 0, graphDigest: null, graph: null, activeNodeIds: [], nodes: {}, paused: false };
    });
  }
  editScope(command: OutcomeCommand, scope: OutcomeScope): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'edit-scope', scope }, current => {
      if (!current) return null;
      const normalized = normalizeOutcomeScope(scope);
      if (outcomeDigest(normalized) === current.scopeDigest) return current;
      return { ...current, scope: normalized, scopeDigest: outcomeDigest(normalized), scopeRevision: current.scopeRevision + 1,
        graphDigest: null, graph: null, activeNodeIds: [] };
    });
  }
  setPaused(command: OutcomeCommand, paused: boolean): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'pause', paused }, current =>
      current && typeof paused === 'boolean' ? { ...current, paused } : null);
  }
  /** The graph refines tasks, but cannot replace the outcome's desired result, acceptance or targets.
   * A routine in-scope refinement is automatic; no semantic equality or human plan approval required. */
  refinePlan(command: OutcomeCommand, input: MissionGraphInput, inventory: OutcomeInventory, stillAuthorized?: () => boolean): OutcomeWrite {
    if (inventory.sourceState !== 'healthy' || !inventory.complete) return { ok: false, reason: 'unknown-source' };
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'refine', input }, current => {
      if (!current || input.missionKey !== current.id || input.objective !== current.scope.desiredOutcome ||
          current.scope.targetRepos.some(repo => !inventory.repos.includes(repo))) return null;
      // The caller must supply the complete saved objective above. Only this host-owned
      // representation changes for the graph's bounded wire format.
      const compiled = compileEcosystemMissionGraph({ ...input, objective: outcomeGraphObjective(current) }, current.scope.targetRepos);
      if (!compiled.ok || compiled.graph.nodes.some(node => node.kind === 'work' &&
          (!node.repo || !current.scope.targetRepos.includes(node.repo)))) return null;
      const definitions = new Map(compiled.graph.nodes.map(node => [node.key, node]));
      const ids = new Map<string, string>();
      const nodes = { ...current.nodes };
      const nextPlan = current.planRevision + 1;
      const visit = (key: string): string => {
        const known = ids.get(key);
        if (known) return known;
        const definition = definitions.get(key)!;
        const dependencies = definition.dependsOn.map(visit).sort();
        const semanticDigest = outcomeDigest({ definition, dependencies });
        const id = outcomeDigest([current.id, current.scopeDigest, current.scopeRevision, semanticDigest]);
        ids.set(key, id);
        if (!nodes[id]) nodes[id] = { id, semanticDigest, basis: { scopeRevision: current.scopeRevision,
          scopeDigest: current.scopeDigest, planRevision: nextPlan, graphDigest: compiled.graph.graphDigest,
          definition, dependencies }, materialization: { goalId: `outcome-${id}`, milestoneId: `milestone-${id}`,
          state: 'intent' }, attempts: [], humanApproval: null, completion: null };
        return id;
      };
      const activeNodeIds = compiled.graph.nodes.map(node => visit(node.key)).sort();
      return { ...current, planRevision: nextPlan, graphDigest: compiled.graph.graphDigest, graph: compiled.graph, activeNodeIds, nodes };
    }, stillAuthorized);
  }
  linkMaterialization(command: OutcomeCommand, nodeId: string, goalId: string, milestoneId: string,
    admission: OutcomeMaterializationAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'materialized', nodeId, goalId, milestoneId }, current => {
      const node = current?.nodes[nodeId];
      if (!current || current.paused || !current.activeNodeIds.includes(nodeId) || !node || node.basis.definition.kind !== 'work' ||
          node.materialization.goalId !== goalId || node.materialization.milestoneId !== milestoneId || admission.matchesPersistedGoal(node) !== true) return null;
      node.materialization.state = 'linked';
      return current;
    }, () => admission.stillAuthorized());
  }
  claimReady(command: OutcomeCommand, nodeId: string, executionRepo: string, admission: OutcomeAdmission, retryFailed = false): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'claim', nodeId, executionRepo, retryFailed }, current => {
      const node = current?.nodes[nodeId];
      const target = node?.basis.definition.repo;
      if (!current || !node || !target ||
          !(ready(current, node) || retryFailed && !current.paused && current.activeNodeIds.includes(nodeId) &&
            !node.completion && node.materialization.state === 'linked' &&
            ['failed', 'aborted'].includes(node.attempts.at(-1)?.state ?? '') &&
            node.basis.dependencies.every(id => completed(current.nodes[id]))) ||
          realpathSync.native(executionRepo) !== executionRepo || admission.executionRepoAllowed(target, executionRepo) !== true) return null;
      const id = outcomeDigest([nodeId, command.commandId]);
      node.attempts.push({ id, executionRepo, workItemId: `goal:${node.materialization.goalId}:${node.materialization.milestoneId}`,
        generationId: `outcome:v1:${outcomeDigest([nodeId, id])}`, runId: null, providerRunIds: [], terminalRunId: null, proposalId: null, state: 'claimed' });
      return current;
    }, () => admission.stillAuthorized());
  }
  /** The resident records its owned claim and existing run identity atomically.
   * A separate claim/join CAS permits an unrelated writer to strand a claim
   * before any producer starts. This records metadata only; even a recorded
   * result needs a fresh inspectClaim at contact, and replay never launches. */
  claimRunReady(command: OutcomeCommand, nodeId: string, executionRepo: string,
    runId: string, admission: OutcomeAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision,
      { kind: 'claim-run', nodeId, executionRepo, runId }, current => {
        const node = current?.nodes[nodeId];
        const target = node?.basis.definition.repo;
        if (!current || !node || !target || !ready(current, node) || !outcomeToken(runId) ||
            realpathSync.native(executionRepo) !== executionRepo ||
            admission.executionRepoAllowed(target, executionRepo) !== true) return null;
        const id = outcomeDigest([nodeId, command.commandId]);
        node.attempts.push({ id, executionRepo, workItemId: `goal:${node.materialization.goalId}:${node.materialization.milestoneId}`,
          generationId: `outcome:v1:${outcomeDigest([nodeId, id])}`, runId, providerRunIds: [runId],
          terminalRunId: null, proposalId: null, state: 'running' });
        return current;
      }, () => admission.stillAuthorized());
  }
  /** Read-only final admission seam. No stored claim is itself permission to spend or dispatch.
   * Unrelated graph revisions keep an unchanged active node usable; edited scope retires it. */
  inspectClaim(nodeId: string, attemptId: string, generationId: OutcomeAttempt['generationId'], admission: OutcomeAdmission):
    { admitted: true; node: OutcomeNode; attempt: OutcomeAttempt } | { admitted: false } {
    const read = this.store.read();
    if (read.sourceState !== 'healthy' || read.state.paused || !read.state.activeNodeIds.includes(nodeId)) return { admitted: false };
    const node = read.state.nodes[nodeId];
    const attempt = node?.attempts.at(-1);
    const target = node?.basis.definition.repo;
    try {
      if (!node || !attempt || !target || attempt.id !== attemptId || attempt.generationId !== generationId ||
          !['claimed', 'running'].includes(attempt.state) || !node.basis.dependencies.every(id => completed(read.state.nodes[id])) ||
          realpathSync.native(attempt.executionRepo) !== attempt.executionRepo ||
          admission.executionRepoAllowed(target, attempt.executionRepo) !== true || admission.stillAuthorized() !== true) return { admitted: false };
      return { admitted: true, node, attempt };
    } catch { return { admitted: false }; }
  }
  /** Explicit graph human gates use an authenticated operator receipt supplied by the host;
   * routine work-node graph refinement never requires such a gate. */
  joinHumanApproval(command: OutcomeCommand, nodeId: string, receiptDigest: string,
    authenticateReceipt: (node: OutcomeNode, receiptDigest: string) => boolean): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'human-approval', nodeId, receiptDigest }, current => {
      const node = current?.nodes[nodeId];
      if (!current || !node || current.paused || !current.activeNodeIds.includes(nodeId) || node.humanApproval ||
          node.basis.definition.kind !== 'human-gate' || !node.basis.dependencies.every(id => completed(current.nodes[id])) ||
          authenticateReceipt(node, receiptDigest) !== true) return null;
      node.humanApproval = { receiptDigest };
      return current;
    });
  }
  /** Caller must retain this claim through final producer admission, with another live fence.
   * Recording a run does not authorize it or assert a provider has started. */
  joinRun(command: OutcomeCommand, nodeId: string, attemptId: string, runId: string): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'run', nodeId, attemptId, runId }, current => {
      const attempt = current?.nodes[nodeId]?.attempts.at(-1);
      if (!current || !current.activeNodeIds.includes(nodeId) || !attempt || attempt.id !== attemptId ||
          !outcomeToken(runId) || attempt.state !== 'claimed' || attempt.runId !== null) return null;
      attempt.runId = runId;
      attempt.providerRunIds.push(runId);
      attempt.state = 'running';
      return current;
    });
  }
  /** Registers each actual candidate before contact, without creating a candidate ceiling.
   * A replay is not admission: the host must inspectProviderRun with its live fence again. */
  registerProviderRun(command: OutcomeCommand, nodeId: string, attemptId: string,
    generationId: OutcomeAttempt['generationId'], runId: string, admission: OutcomeAdmission): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision,
      { kind: 'provider-run', nodeId, attemptId, generationId, runId }, current => {
        const node = current?.nodes[nodeId];
        const attempt = node?.attempts.at(-1);
        const target = node?.basis.definition.repo;
        if (!current || current.paused || !current.activeNodeIds.includes(nodeId) || !node || !attempt || !target ||
            attempt.id !== attemptId || attempt.generationId !== generationId || attempt.state !== 'running' ||
            !outcomeToken(runId) || !node.basis.dependencies.every(id => completed(current.nodes[id])) ||
            realpathSync.native(attempt.executionRepo) !== attempt.executionRepo ||
            admission.executionRepoAllowed(target, attempt.executionRepo) !== true) return null;
        if (!attempt.providerRunIds.includes(runId)) attempt.providerRunIds.push(runId);
        return current;
      }, () => admission.stillAuthorized());
  }
  inspectProviderRun(nodeId: string, attemptId: string, generationId: OutcomeAttempt['generationId'], runId: string,
    admission: OutcomeAdmission): { admitted: true; node: OutcomeNode; attempt: OutcomeAttempt } | { admitted: false } {
    const inspected = this.inspectClaim(nodeId, attemptId, generationId, admission);
    return inspected.admitted && inspected.attempt.state === 'running' && inspected.attempt.providerRunIds.includes(runId)
      ? inspected : { admitted: false };
  }
  /** Recovery may cancel a claimed intent only after the host proves it never started.
   * A missing run receipt alone is unknown, not proof that provider work never began. */
  cancelUnstartedClaim(command: OutcomeCommand, nodeId: string, attemptId: string,
    generationId: OutcomeAttempt['generationId'], proveNeverStarted: (attempt: OutcomeAttempt) => boolean): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'cancel-unstarted', nodeId, attemptId, generationId }, current => {
      const attempt = current?.nodes[nodeId]?.attempts.at(-1);
      if (!current || !attempt || attempt.id !== attemptId || attempt.generationId !== generationId ||
          attempt.state !== 'claimed' || attempt.runId !== null || proveNeverStarted(attempt) !== true) return null;
      attempt.state = 'aborted';
      return current;
    });
  }
  joinTerminal(command: OutcomeCommand, terminal: OutcomeTerminal): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'terminal', terminal },
      current => recordTerminal(current, terminal));
  }
  /** Actual resident result, independent of unrelated operator revisions.
   * This metadata-only seam cannot claim, start, plan or complete work. */
  joinTerminalCurrent(commandId: string, terminal: OutcomeTerminal): OutcomeWrite {
    return this.store.transactCurrent(commandId, { kind: 'terminal', terminal },
      current => recordTerminal(current, terminal));
  }
  /** Only a terminal proposed attempt can be completed. A producer's 'done' status,
   * an unverified patch or a bare merge flag cannot release dependent nodes. The host
   * must supply the protected persisted Proposal and its durable producer join: existing
   * merge HMACs do not themselves authenticate run/trajectory/generation metadata. */
  joinCompletion(command: OutcomeCommand, terminal: OutcomeTerminal, proposal: Proposal): OutcomeWrite {
    return this.store.transact(command.commandId, command.expectedRevision, { kind: 'complete', terminal,
      proposalDigest: outcomeDigest(proposal) }, current => {
      if (!current || terminal.state !== 'proposed') return null;
      const attempt = registeredAttempt(current, terminal);
      if (!current.activeNodeIds.includes(terminal.nodeId) || current.nodes[terminal.nodeId]?.attempts.at(-1) !== attempt ||
          !attempt || attempt.state !== 'proposed' || attempt.terminalRunId !== terminal.runId || attempt.proposalId !== terminal.proposalId ||
          proposal.id !== terminal.proposalId || proposal.repo !== attempt.executionRepo || proposal.runId !== terminal.runId ||
          proposal.workItemId !== attempt.workItemId || proposal.workItemGenerationId !== attempt.generationId ||
          proposal.trajectoryId !== `run:${terminal.runId}` ||
          proposal.producerStatus !== 'done' || proposal.isPartial === true || !proposalCompletesGoalMilestone(proposal)) return null;
      const identity = canonicalRealizedMergeIdentity(proposal);
      if (!identity) return null;
      attempt.state = 'complete';
      current.nodes[terminal.nodeId]!.completion = { attemptId: attempt.id, proposalId: proposal.id, mergeIdentity: identity.key };
      return current;
    });
  }
}
