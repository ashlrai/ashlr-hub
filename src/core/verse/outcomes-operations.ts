/** Fixed local metadata operations, executed off the HTTP event loop. */
import { readdirSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { OutcomeCoordinator } from '../goals/outcome-coordinator.js';
import { outcomeDirectory } from '../goals/outcome-runtime.js';
import { OutcomeStore } from '../goals/outcome-store.js';
import type { OutcomeState } from '../goals/outcome-types.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { OUTCOME_ID_PATTERN, type OutcomeOperation, type OutcomeOperationResult, type OutcomesRead, type OutcomeView } from './outcomes-api-types.js';

export function outcomeView(state: OutcomeState): OutcomeView {
  const tasks = state.activeNodeIds.map(id => {
    const node = state.nodes[id]!;
    const attempt = node.attempts.at(-1);
    return { key: node.basis.definition.key, title: node.basis.definition.title, repo: node.basis.definition.repo,
      state: node.completion ? 'complete' as const : node.humanApproval ? 'approved' as const : attempt?.state ?? 'pending' as const,
      runId: attempt?.terminalRunId ?? attempt?.runId ?? null, controllerRunId: attempt?.runId ?? null,
      proposalId: node.completion?.proposalId ?? attempt?.proposalId ?? null,
      mergeIdentity: node.completion?.mergeIdentity ?? null };
  });
  const status = state.paused ? 'paused' : !state.graph ? 'waiting-plan'
    : state.activeNodeIds.length && state.activeNodeIds.every(id => state.nodes[id]!.completion || state.nodes[id]!.humanApproval) ? 'plan-verified'
      : tasks.some(task => task.state === 'running') ? 'running'
        : tasks.some(task => task.state === 'failed' || task.state === 'aborted') ? 'failed'
          : tasks.some(task => task.state === 'proposed') ? 'waiting-verification' : 'queued';
  return { id: state.id, revision: state.revision, scopeRevision: state.scopeRevision, scope: state.scope, status, tasks };
}

/** Neither discovery nor projection creates directories or repairs ledgers. */
function readOutcomes(): OutcomesRead {
  const enrolled = readEnrollmentRegistry();
  const enrollment: OutcomesRead['enrollment'] = enrolled.state === 'ready'
    ? { sourceState: 'healthy', repos: enrolled.repos } : { sourceState: 'degraded', repos: null };
  const unknown: OutcomesRead = { v: 1, sourceState: 'degraded', outcomes: null, enrollment };
  const root = dirname(outcomeDirectory('root'));
  try {
    inspectPrivateDirectory(dirname(root));
    try { inspectPrivateDirectory(root); }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && enrollment.sourceState === 'healthy'
        ? { v: 1, sourceState: 'missing', outcomes: [], enrollment } : unknown;
    }
    const before = statSync(root);
    const names = readdirSync(root).sort();
    const outcomes: OutcomeView[] = [];
    for (const id of names) {
      if (!OUTCOME_ID_PATTERN.test(id)) return unknown;
      const read = new OutcomeStore(outcomeDirectory(id)).read();
      if (read.sourceState !== 'healthy' || read.state.id !== id) return unknown;
      outcomes.push(outcomeView(read.state));
    }
    const after = statSync(root);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        JSON.stringify(names) !== JSON.stringify(readdirSync(root).sort())) return unknown;
    inspectPrivateDirectory(root);
    return { v: 1, sourceState: 'healthy', outcomes, enrollment };
  } catch { return unknown; }
}

/** Saves the desired result only. Plan refinement and dispatch belong to the Leader/host. */
export function executeOutcomeOperation(operation: OutcomeOperation): OutcomeOperationResult {
  if (operation.kind === 'read') return readOutcomes();
  if (!OUTCOME_ID_PATTERN.test(operation.id)) return { ok: false, reason: 'invalid' };
  const enrollment = readEnrollmentRegistry();
  if (enrollment.state !== 'ready') return { ok: false, reason: 'unknown-source' };
  const store = new OutcomeStore(outcomeDirectory(operation.id));
  const coordinator = new OutcomeCoordinator(store);
  const command = { commandId: operation.commandId, expectedRevision: operation.expectedRevision };
  if (operation.kind === 'start' || operation.kind === 'edit') {
    // Round-trip the same user's /var↔/private/var home alias (macOS). Only
    // the fixed home is canonicalized; never probe a caller's repository.
    const canonicalHome = dirname(dirname(dirname(outcomeDirectory('root'))));
    const home = homedir();
    operation = { ...operation, scope: { ...operation.scope, targetRepos: operation.scope.targetRepos.map(repo =>
      repo === home ? canonicalHome : repo.startsWith(`${home}${sep}`) ? `${canonicalHome}${repo.slice(home.length)}` : repo) } };
    if (operation.scope.targetRepos.some(repo => !enrollment.repos.includes(repo))) return { ok: false, reason: 'unenrolled' };
  } else if (operation.kind === 'resume') {
    const read = store.read();
    if (read.sourceState !== 'healthy') return { ok: false, reason: 'unknown-source' };
    if (read.state.scope.targetRepos.some(repo => !enrollment.repos.includes(repo))) return { ok: false, reason: 'unenrolled' };
  }
  const write = operation.kind === 'start' ? coordinator.start(command, operation.id, operation.scope)
    : operation.kind === 'edit' ? coordinator.editScope(command, operation.scope)
      : coordinator.setPaused(command, operation.kind === 'pause');
  if (write.ok) return { ok: true, disposition: write.disposition, outcome: outcomeView(write.state) };
  // The terminal writer's lock taxonomy is host-only; HTTP callers retain
  // the existing retryable conflict response rather than a new wire status.
  return { ok: false, reason: write.reason === 'lock-conflict' ? 'conflict' : write.reason };
}
