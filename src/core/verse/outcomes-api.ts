import type { IncomingMessage, ServerResponse } from 'node:http';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { getVerseEngine, type VerseApiContext } from './verse-api.js';
import type { VerseEngineHandle } from './session-engine.js';
import { isValidSessionId } from './session-store.js';
import { reconcileOutcomeManagerSession, submitOutcomeManagerMessage, validManagerSubmit, type ManagerSessionDeps } from './manager-session.js';
import { normalizeOutcomeOperation } from './outcomes-input.js';
import { runOutcomeOperation, runOutcomeTaskContext } from './outcomes-io.js';
import type { OutcomeTaskContextRequest, OutcomeTaskContextResult } from './outcome-task-context.js';
import { parseOutcomeTaskPublicId } from './outcome-task-context.js';
import { taskContextTimestamp } from '../context/task-temporal-context.js';
import { OUTCOMES_PATH, OUTCOME_ID_PATTERN, type OutcomeOperation } from './outcomes-api-types.js';

const REFUSAL = {
  invalid: [400, 'Check the outcome fields and revision.'],
  conflict: [409, 'This outcome changed. Refresh its revision before saving; your draft is preserved.'],
  held: [409, 'Outcome storage is busy. Retry with the same command.'],
  'unknown-source': [503, 'Outcome or enrollment records are unavailable. Refresh before retrying.'],
  'storage-failed': [503, 'The outcome write could not be confirmed. Retry with the same command.'],
  unenrolled: [409, 'Choose exact currently enrolled repositories.'],
} as const;

export interface OutcomesApiDeps extends ManagerSessionDeps {
  engine?: () => Promise<VerseEngineHandle>;
  taskContext?: (input: OutcomeTaskContextRequest) => Promise<OutcomeTaskContextResult>;
}

export async function handleOutcomesApiWithDeps(
  ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string, deps: OutcomesApiDeps = {},
): Promise<boolean> {
  if (path !== OUTCOMES_PATH && !path.startsWith(`${OUTCOMES_PATH}/`)) return false;
  if (method !== 'GET' && method !== 'POST') { sendJson(res, 404, { error: 'Outcome action not found.' }); return true; }
  if (method === 'GET' && (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now())) {
    sendJson(res, 401, { error: 'A current read session is required.' }); return true;
  }
  if (method === 'POST') {
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
  }
  const suffixParts = path.slice(OUTCOMES_PATH.length + 1).split('/');
  if (method === 'GET' && suffixParts.length === 4 && suffixParts[1] === 'tasks' && suffixParts[3] === 'context') {
    let input: OutcomeTaskContextRequest;
    try {
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      const taskId = parseOutcomeTaskPublicId(suffixParts[2]);
      if ([...params.keys()].some(key => !['asOf', 'observedThrough', 'maxEvents'].includes(key) || params.getAll(key).length !== 1) ||
          !OUTCOME_ID_PATTERN.test(suffixParts[0]!) || !taskId) throw new Error();
      const asOf = params.get('asOf'), observedThrough = params.get('observedThrough'), maxEvents = params.get('maxEvents');
      if (asOf !== null && !taskContextTimestamp(asOf) || observedThrough !== null && !taskContextTimestamp(observedThrough) ||
          maxEvents !== null && (!/^[1-9]\d{0,5}$/.test(maxEvents) || Number(maxEvents) > 100_000)) throw new Error();
      input = { outcomeId: suffixParts[0]!, taskId, ...(asOf === null ? {} : { asOf }),
        ...(observedThrough === null ? {} : { observedThrough }), ...(maxEvents === null ? {} : { maxEvents: Number(maxEvents) }) };
    } catch { sendJson(res, 400, { error: 'Invalid task context scope, time or retrieval size.' }); return true; }
    try {
      const result = await (deps.taskContext ?? runOutcomeTaskContext)(input);
      if (result.ok) sendJson(res, 200, result.context);
      else sendJson(res, result.reason === 'invalid' ? 400 : result.reason === 'not-found' ? 404 : result.reason === 'unenrolled' ? 409 : 503,
        { error: 'Task context is unavailable in the current outcome and repository scope.', reason: result.reason });
    } catch { sendJson(res, 503, { error: 'Task context could not be read. Refresh before retrying.' }); }
    return true;
  }
  try {
    if (new URL(req.url ?? path, 'http://localhost').search) throw new Error();
  } catch { sendJson(res, 400, { error: 'Outcomes do not accept query parameters.' }); return true; }
  if (method === 'GET' && suffixParts.length === 2 && suffixParts[0] === 'session' && isValidSessionId(suffixParts[1]!)) {
    try {
      const engine = await (deps.engine ?? getVerseEngine)();
      const result = await reconcileOutcomeManagerSession(engine, suffixParts[1]!, deps);
      sendJson(res, 200, result);
    } catch { sendJson(res, 503, { error: 'Manager conversation is unavailable. Refresh before retrying.' }); }
    return true;
  }
  if (method === 'POST' && suffixParts.length === 1 && suffixParts[0] === 'interactive') {
    let raw: string;
    try { raw = await readBody(req, 96 * 1024); }
    catch { sendJson(res, 413, { error: 'Manager message body too large.' }); return true; }
    let input: unknown;
    try { input = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'Invalid manager message.' }); return true; }
    if (!validManagerSubmit(input)) { sendJson(res, 400, { error: 'Invalid manager message.' }); return true; }
    try {
      const engine = await (deps.engine ?? getVerseEngine)();
      const result = await submitOutcomeManagerMessage(engine, input, deps);
      sendJson(res, 202, result);
    } catch { sendJson(res, 409, { error: 'Manager message could not be confirmed. Refresh and retry with the same message; your draft is preserved.' }); }
    return true;
  }
  let operation: OutcomeOperation;
  if (method === 'GET') {
    if (path !== OUTCOMES_PATH) { sendJson(res, 404, { error: 'Outcome read not found.' }); return true; }
    operation = { kind: 'read' };
  } else {
    const suffix = path.slice(OUTCOMES_PATH.length + 1).split('/');
    const start = suffix.length === 1 && suffix[0] === 'start';
    const action = suffix[1];
    if (!start && (suffix.length !== 2 || !OUTCOME_ID_PATTERN.test(suffix[0]!) || !['edit', 'pause', 'resume', 'manager-configure'].includes(action!))) {
      sendJson(res, 404, { error: 'Outcome action not found.' }); return true;
    }
    let raw: string;
    try { raw = await readBody(req, 96 * 1024); }
    catch { sendJson(res, 413, { error: 'Outcome request body too large.' }); return true; }
    try {
      const input: unknown = JSON.parse(raw);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'kind') ||
          (!start && Object.hasOwn(input, 'id'))) throw new Error('Unexpected outcome fields.');
      operation = normalizeOutcomeOperation({ ...input, kind: start ? 'start' : action, ...(start ? {} : { id: suffix[0] }) });
    } catch { sendJson(res, 400, { error: 'Invalid outcome fields. Provide the result, enrolled repositories, acceptance, command and revision.' }); return true; }
  }
  try {
    const result = await (deps.run ?? runOutcomeOperation)(operation);
    if ('ok' in result && !result.ok) {
      const [status, error] = REFUSAL[result.reason];
      sendJson(res, status, { code: 'OUTCOME_REFUSED', reason: result.reason, error });
    } else sendJson(res, method === 'POST' && operation.kind === 'start' ? 201 : 200, result);
  } catch { sendJson(res, 503, { error: 'Outcome records are unavailable. Retry with the same command.' }); }
  return true;
}

export const handleOutcomesApi: ApiModule = handleOutcomesApiWithDeps;
