/** Sidecar-owned interactive manager metadata and restart-safe result reconciliation. */
import type { OutcomeManagerSessionRead } from '../daemon/outcome-manager.js';
import type { VerseEngineHandle } from './session-engine.js';
import { verseSessionRoots } from './types.js';
import { resolveManagerSessionTargets } from './manager-scope.js';
import type { OutcomeOperation, OutcomeOperationResult, OutcomeView } from './outcomes-api-types.js';
import { runOutcomeOperation } from './outcomes-io.js';
import { outcomeToken } from '../goals/outcome-types.js';
import { OUTCOME_ID_PATTERN } from './outcomes-api-types.js';

export interface ManagerSubmitInput { sessionId: string; outcomeId: string; commandId: string; messageId: string; text: string }
export interface ManagerSessionDeps {
  project?: (sessionId: string, roots: readonly string[]) => OutcomeManagerSessionRead;
  run?: (operation: OutcomeOperation) => Promise<OutcomeOperationResult>;
}
export function validManagerSubmit(value: unknown): value is ManagerSubmitInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as ManagerSubmitInput;
  return Object.keys(input).length === 5 && ['sessionId', 'outcomeId', 'commandId', 'messageId', 'text'].every(key => Object.hasOwn(input, key)) &&
    typeof input.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId) &&
    typeof input.outcomeId === 'string' && OUTCOME_ID_PATTERN.test(input.outcomeId) && outcomeToken(input.commandId) &&
    input.commandId.length <= 100 && outcomeToken(input.messageId) && typeof input.text === 'string' && !!input.text.trim() &&
    Buffer.byteLength(input.text, 'utf8') <= 64 * 1024;
}
async function projectionReader(deps: ManagerSessionDeps) {
  return deps.project ?? (await import('../daemon/outcome-manager.js')).readOutcomeManagerSessionProjection;
}
function requireChat(engine: VerseEngineHandle, id: string) {
  const session = engine.getSession(id);
  if (!session) throw new Error('The chat is unavailable. Your draft is preserved.');
  return session;
}

/** The daemon need not own a chat engine. Opening/polling the sidecar recovers real terminal replies. */
export async function reconcileOutcomeManagerSession(engine: VerseEngineHandle, id: string, deps: ManagerSessionDeps = {}): Promise<OutcomeManagerSessionRead> {
  const project = await projectionReader(deps);
  let read = project(id, verseSessionRoots(requireChat(engine, id)));
  if (read.sourceState !== 'healthy') return read;
  if (!engine.recordManagerResult) throw new Error('Update the host to read manager replies.');
  const saved = engine.getManagerResultStages?.(id, read.association.outcomeId);
  if (!saved) throw new Error('Saved manager replies are unavailable.');
  const persisted = new Set(saved);
  for (const stageId of read.association.terminalStageIds.filter(stage => !persisted.has(stage))) {
    await engine.recordManagerResult(id, { outcomeId: read.association.outcomeId, stageId });
  }
  read = project(id, verseSessionRoots(requireChat(engine, id)));
  return read;
}
function written(result: OutcomeOperationResult): OutcomeView {
  if (!('ok' in result) || !result.ok) throw new Error('The manager write could not be confirmed. Retry with the same message; your draft is preserved.');
  return result.outcome;
}

/** Each durable phase reuses its command ID. A partial/uncertain response never claims launch or completion. */
export async function submitOutcomeManagerMessage(engine: VerseEngineHandle, input: ManagerSubmitInput, deps: ManagerSessionDeps = {}): Promise<OutcomeManagerSessionRead> {
  if (!validManagerSubmit(input)) throw new Error('Invalid manager message.');
  if (!engine.recordManagerMessage) throw new Error('Update the host before sending manager messages.');
  const project = await projectionReader(deps); const run = deps.run ?? runOutcomeOperation;
  const roots = verseSessionRoots(requireChat(engine, input.sessionId));
  const current = project(input.sessionId, roots);
  if (current.sourceState === 'degraded') throw new Error('Manager records are unavailable. Your draft is preserved.');
  if (current.sourceState === 'healthy' && current.association.outcomeId !== input.outcomeId) throw new Error('This chat is linked to another outcome. Refresh before sending.');
  const inventory = await run({ kind: 'read' });
  if ('ok' in inventory || inventory.sourceState === 'degraded' || inventory.enrollment.sourceState !== 'healthy') {
    throw new Error('Current enrollment is unavailable. Your draft is preserved.');
  }
  const targets = resolveManagerSessionTargets(verseSessionRoots(requireChat(engine, input.sessionId)), inventory.enrollment.repos);
  if (!targets) throw new Error('Each chat folder must match one current enrolled repository. Your draft is preserved.');
  let outcome = inventory.outcomes?.find(row => row.id === input.outcomeId);
  if (!outcome) outcome = written(await run({ kind: 'start', id: input.outcomeId, commandId: `${input.commandId}-start`, expectedRevision: 0,
    // The saved request itself is the acceptance; no invented benchmark or coding-success shortcut.
    scope: { desiredOutcome: input.text, targetRepos: targets, acceptance: [input.text] } }));
  if (outcome.scope.targetRepos.length !== targets.length || targets.some(target => !outcome!.scope.targetRepos.includes(target))) {
    throw new Error('The outcome scope no longer matches this chat. Refresh before sending.');
  }
  if (!outcome.manager?.enabled) {
    if (outcome.scope.desiredOutcome !== input.text.trim() || outcome.scope.acceptance.length !== 1 || outcome.scope.acceptance[0] !== input.text.trim()) {
      throw new Error('The existing outcome names a different request. Your draft is preserved.');
    }
    outcome = written(await run({ kind: 'manager-configure', id: input.outcomeId, commandId: `${input.commandId}-configure`,
      expectedRevision: outcome.revision, mode: 'interactive', sessionId: input.sessionId }));
  }
  if (outcome.status === 'paused' || outcome.manager?.mode !== 'interactive' || outcome.manager.sessionId !== input.sessionId) {
    throw new Error('The manager is paused or linked elsewhere. Resume it before sending; your draft is preserved.');
  }
  const reference = await engine.recordManagerMessage(input.sessionId, { outcomeId: input.outcomeId, messageId: input.messageId, text: input.text });
  written(await run({ kind: 'manager-interject', id: input.outcomeId, commandId: `${input.commandId}-interject`,
    expectedRevision: outcome.revision, reference }));
  const final = project(input.sessionId, verseSessionRoots(requireChat(engine, input.sessionId)));
  if (final.sourceState !== 'healthy' || final.association.outcomeId !== input.outcomeId || final.association.manager.conversationRevision === 0) {
    throw new Error('Saved manager state could not be confirmed. Retry with the same message.');
  }
  return final;
}
