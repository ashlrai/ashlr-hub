import { setTimeout as delay } from 'node:timers/promises';
import type { DaemonDispatchProduction, WorkItem } from '../types.js';
import { loadProposal } from '../inbox/store.js';
import { OutcomeCoordinator, type OutcomeAdmission, type OutcomeTerminal } from '../goals/outcome-coordinator.js';
import { readOutcomeWorkItemContext, type OutcomeGoalContext } from '../goals/outcome-runtime.js';
import { outcomeDigest, type OutcomeAttemptGeneration } from '../goals/outcome-types.js';

/** A queued candidate is not authority. In particular, a missing/retired outcome
 * must never fall through to the legacy Goal producer. */
export function isOutcomeWorkItem(item: Pick<WorkItem, 'id' | 'tags'>): boolean {
  return item.tags.includes('outcome') || /^goal:outcome-[a-f0-9]{64}:/.test(item.id);
}

/** Resident-owned bridge into the existing queue, producers and protected Inbox.
 * No model selection, provider worker or outward primitive lives here. */
export class OutcomeDispatch {
  private readonly coordinator: OutcomeCoordinator;
  private readonly claimId: string;
  private readonly attemptId: string;
  readonly generationId: OutcomeAttemptGeneration;
  private began = false;
  constructor(readonly context: OutcomeGoalContext, readonly item: WorkItem,
    readonly runId: string, readonly admission: OutcomeAdmission) {
    this.coordinator = new OutcomeCoordinator(context.store);
    this.claimId = `dispatch-claim-${runId}`;
    this.attemptId = outcomeDigest([context.node.id, this.claimId]);
    this.generationId = `outcome:v1:${outcomeDigest([context.node.id, this.attemptId])}`;
  }
  /** Runs only after the existing shared queue claim has entered execution. */
  begin(): boolean {
    if (this.began) return this.stillAuthorized();
    const fresh = readOutcomeWorkItemContext(this.item);
    if (!fresh || fresh.node.id !== this.context.node.id) return false;
    const claimed = this.coordinator.claimRunReady({ commandId: this.claimId,
      expectedRevision: fresh.state.revision }, fresh.node.id, this.item.repo, this.runId, this.admission);
    // Claim and parent registration are one transaction. A replay can describe
    // an earlier launch, but never permits a second provider execution.
    if (!claimed.ok || claimed.disposition !== 'recorded') return false;
    this.began = true;
    return this.stillAuthorized();
  }
  stillAuthorized(): boolean {
    if (!this.began || !readOutcomeWorkItemContext(this.item)) return false;
    return this.coordinator.inspectClaim(this.context.node.id, this.attemptId,
      this.generationId, this.admission).admitted;
  }
  /** Called with each real BON candidate identity before its first contact. */
  registerProviderRun(runId: string): boolean {
    if (!this.stillAuthorized()) return false;
    const read = this.context.store.read();
    if (read.sourceState !== 'healthy') return false;
    const result = this.coordinator.registerProviderRun({
      commandId: `provider-${outcomeDigest([this.attemptId, runId])}`,
      expectedRevision: read.state.revision,
    }, this.context.node.id, this.attemptId, this.generationId, runId, this.admission);
    return result.ok && this.coordinator.inspectProviderRun(this.context.node.id,
      this.attemptId, this.generationId, runId, this.admission).admitted;
  }
  prompt(): string {
    const { scope } = this.context.state;
    const node = this.context.node.basis.definition;
    // WorkItem.detail is bounded UI/protocol text. The producer gets the full
    // immutable scope and node acceptance, including criteria beyond that bound.
    return `Desired outcome:\n${scope.desiredOutcome}\n\nOutcome acceptance:\n${scope.acceptance.map(x => `- ${x}`).join('\n')}\n\nCurrent task:\n${node.objective}\nDeliverable:\n${node.deliverable}\nTask acceptance:\n${node.acceptance.map(x => `- ${x}`).join('\n')}\n\nWork only on this task in the assigned repository. Preserve evidence of verification and report actual failures.`;
  }
  /** History is written even when an edit retires this node. Completion is a
   * separate exact protected merge join, never inferred from a producer status. */
  private terminalFor(production?: DaemonDispatchProduction, cancelled = false): OutcomeTerminal | null {
    const read = this.context.store.read();
    if (read.sourceState !== 'healthy') return null;
    const attempt = read.state.nodes[this.context.node.id]?.attempts.find(x => x.id === this.attemptId);
    if (!attempt || attempt.state !== 'running') return null;
    const runId = production?.runId ?? this.runId;
    if (!attempt.providerRunIds.includes(runId)) return null;
    const proposal = production?.proposalId ? loadProposal(production.proposalId) : null;
    const proposed = production?.outcome === 'proposal-created' && proposal &&
      proposal.repo === attempt.executionRepo && proposal.runId === runId &&
      proposal.workItemId === attempt.workItemId && proposal.workItemGenerationId === attempt.generationId &&
      proposal.trajectoryId === `run:${runId}`;
    const terminal: OutcomeTerminal = { nodeId: this.context.node.id, attemptId: attempt.id,
      generationId: attempt.generationId, executionRepo: attempt.executionRepo, runId,
      proposalId: proposed ? proposal.id : null,
      state: proposed ? 'proposed' : cancelled || production?.outcome === 'cancelled' ? 'aborted' : 'failed' };
    return terminal;
  }
  finish(production?: DaemonDispatchProduction, cancelled = false): boolean {
    if (!this.began) return true;
    const terminal = this.terminalFor(production, cancelled);
    return terminal !== null && this.coordinator.joinTerminalCurrent(`terminal-${terminal.attemptId}`, terminal).ok;
  }
  /** Retry only transient host-store lock contention, never a producer or
   * a semantic/CAS/storage error. Preserve the selected terminal tuple even
   * when scope changes while another writer owns the store. */
  async finishWithRetry(production?: DaemonDispatchProduction, cancelled = false): Promise<boolean> {
    if (!this.began) return true;
    const terminal = this.terminalFor(production, cancelled);
    if (terminal === null) return false;
    const commandId = `terminal-${terminal.attemptId}`;
    const waits = [25, 50, 100, 200, 400];
    for (let attempt = 0; ; attempt++) {
      const result = this.coordinator.joinTerminalCurrent(commandId, terminal);
      if (result.ok) return true;
      if (result.reason !== 'lock-conflict' || attempt >= waits.length) return false;
      await delay(waits[attempt]);
    }
  }
}

/** Restart-safe completion uses the original selected terminal identity and
 * the protected persisted proposal; request/planner JSON cannot supply evidence. */
export function reconcileOutcomeCompletions(context: Pick<OutcomeGoalContext, 'store'>): number {
  const read = context.store.read();
  if (read.sourceState !== 'healthy') return 0;
  const coordinator = new OutcomeCoordinator(context.store);
  let joined = 0;
  for (const nodeId of read.state.activeNodeIds) {
    const attempt = read.state.nodes[nodeId]?.attempts.at(-1);
    if (attempt?.state !== 'proposed' || !attempt.proposalId || !attempt.terminalRunId) continue;
    const proposal = loadProposal(attempt.proposalId);
    const latest = context.store.read();
    if (!proposal || latest.sourceState !== 'healthy') continue;
    const result = coordinator.joinCompletion({ commandId: `complete-${attempt.id}`,
      expectedRevision: latest.state.revision }, { nodeId, attemptId: attempt.id,
      generationId: attempt.generationId, executionRepo: attempt.executionRepo,
      runId: attempt.terminalRunId, proposalId: attempt.proposalId, state: 'proposed' }, proposal);
    if (result.ok && result.disposition === 'recorded') joined++;
  }
  return joined;
}
