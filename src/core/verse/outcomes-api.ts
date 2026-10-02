import type { IncomingMessage, ServerResponse } from 'node:http';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { normalizeOutcomeOperation } from './outcomes-input.js';
import { runOutcomeOperation } from './outcomes-io.js';
import { OUTCOMES_PATH, OUTCOME_ID_PATTERN, type OutcomeOperation, type OutcomeOperationResult } from './outcomes-api-types.js';

const REFUSAL = {
  invalid: [400, 'Check the outcome fields and revision.'],
  conflict: [409, 'This outcome changed. Refresh its revision before saving; your draft is preserved.'],
  held: [409, 'Outcome storage is busy. Retry with the same command.'],
  'unknown-source': [503, 'Outcome or enrollment records are unavailable. Refresh before retrying.'],
  'storage-failed': [503, 'The outcome write could not be confirmed. Retry with the same command.'],
  unenrolled: [409, 'Choose exact currently enrolled repositories.'],
} as const;

export interface OutcomesApiDeps { run?: (operation: OutcomeOperation) => Promise<OutcomeOperationResult> }

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
  try {
    if (new URL(req.url ?? path, 'http://localhost').search) throw new Error();
  } catch { sendJson(res, 400, { error: 'Outcomes do not accept query parameters.' }); return true; }
  let operation: OutcomeOperation;
  if (method === 'GET') {
    if (path !== OUTCOMES_PATH) { sendJson(res, 404, { error: 'Outcome read not found.' }); return true; }
    operation = { kind: 'read' };
  } else {
    const suffix = path.slice(OUTCOMES_PATH.length + 1).split('/');
    const start = suffix.length === 1 && suffix[0] === 'start';
    const action = suffix[1];
    if (!start && (suffix.length !== 2 || !OUTCOME_ID_PATTERN.test(suffix[0]!) || !['edit', 'pause', 'resume'].includes(action!))) {
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
