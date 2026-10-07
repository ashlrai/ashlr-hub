import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createVerseEngine, type VerseEngineHandle } from '../src/core/verse/session-engine.js';
import { submitOutcomeManagerMessage, reconcileOutcomeManagerSession, type ManagerSubmitInput } from '../src/core/verse/manager-session.js';
import { readOutcomeManagerSessionProjection } from '../src/core/daemon/outcome-manager.js';
import { executeOutcomeOperation } from '../src/core/verse/outcomes-operations.js';
import { runOutcomeOperation } from '../src/core/verse/outcomes-io.js';
import { readOutcomeManagerConversation } from '../src/core/verse/manager-conversation.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { handleOutcomesApiWithDeps } from '../src/core/verse/outcomes-api.js';
import type { OutcomesApiDeps } from '../src/core/verse/outcomes-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OutcomeOperation } from '../src/core/verse/outcomes-api-types.js';
import type { VerseSeat } from '../src/core/verse/types.js';

let home: string; let repo: string; let engine: VerseEngineHandle; let input: ManagerSubmitInput;
const seat: VerseSeat = { id: 'seat', accountId: 'native-account', engine: 'codex', label: 'Seat', models: [{ id: 'model', label: 'Model', contextWindow: null }], contextWindow: null, health: { state: 'unknown', summary: null, windows: [], observedAt: null } };
const deps = () => ({ run: async (operation: OutcomeOperation) => executeOutcomeOperation(operation) });
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'manager-session-')));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 }); repo = join(home, 'repo'); mkdirSync(repo);
  writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo] }), { mode: 0o600 });
  engine = createVerseEngine({ root: join(home, '.ashlr', 'verse'), readiness: null, preflight: null, reasoningTap: null, processRegistry: false });
  const chat = engine.createSession({ projectPath: repo, seatId: seat.id }, { seat, launcher: ['never-launch'], ollamaBaseUrl: 'http://127.0.0.1:11434' });
  input = { sessionId: chat.id, outcomeId: 'chat-result', commandId: 'send-1', messageId: 'message-1', text: 'Improve this repository' };
});
afterEach(() => { engine.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

async function request(path: string, method: string, body: unknown, ctx: VerseApiContext, injected: OutcomesApiDeps) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
  req.url = path; req.headers = { 'x-ashlr-token': 'token', 'content-type': 'application/json' };
  const captured = { status: 0, value: null as unknown };
  const res = { writeHead(status: number) { captured.status = status; }, end(text: string) { captured.value = JSON.parse(text); } } as unknown as ServerResponse;
  await handleOutcomesApiWithDeps(ctx, req, res, path, method, injected); return captured;
}
const context = (): VerseApiContext => ({ token: 'token', allowDispatch: true, readSession: { id: 'read', expiresAt: Date.now() + 60_000 } } as VerseApiContext);

describe('interactive manager admission and recovery', () => {
  it('saves the actual private conversation through the real fixed metadata worker without a native turn', async () => {
    const read = await submitOutcomeManagerMessage(engine, input, { run: runOutcomeOperation });
    expect(read).toMatchObject({ sourceState: 'healthy', association: { outcomeId: input.outcomeId, paused: false, manager: { mode: 'interactive', sessionId: input.sessionId, conversationRevision: 1 } } });
    const state = new OutcomeStore(outcomeDirectory(input.outcomeId)).read().state!;
    expect(readOutcomeManagerConversation(input.sessionId, input.outcomeId, state.manager!.interjections)).toEqual([{ messageId: input.messageId, eventSeq: 1, text: input.text }]);
    expect(engine.getSession(input.sessionId)).toMatchObject({ status: 'idle', turnCount: 0 });
    expect(state.graph).toBeNull(); expect(state.manager!.stages).toEqual([]);
  });
  it('retries the identical partially acknowledged message without duplicate events or ledger records', async () => {
    const run = vi.fn(async (operation: OutcomeOperation) => {
      const result = executeOutcomeOperation(operation);
      if (operation.kind === 'manager-interject') throw new Error('Response lost after durable write');
      return result;
    });
    await expect(submitOutcomeManagerMessage(engine, input, { run })).rejects.toThrow('Response lost');
    const before = new OutcomeStore(outcomeDirectory(input.outcomeId)).read();
    await submitOutcomeManagerMessage(engine, input, deps());
    const after = new OutcomeStore(outcomeDirectory(input.outcomeId)).read();
    expect(after.records).toHaveLength(before.records.length);
    expect(after.state!.manager!.conversationRevision).toBe(1);
    expect(engine.getEvents(input.sessionId).filter(event => event.type === 'manager-message')).toHaveLength(1);
  });
  it.each(['start', 'manager-configure', 'message', 'manager-interject'] as const)('recovers an interrupted %s phase after an intervening revision', async phase => {
    let interrupted = false;
    const record = engine.recordManagerMessage!.bind(engine);
    if (phase === 'message') vi.spyOn(engine, 'recordManagerMessage').mockImplementation(async (...args) => {
      const result = await record(...args);
      if (!interrupted) { interrupted = true; throw new Error('Acknowledgement lost'); }
      return result;
    });
    const run = async (operation: OutcomeOperation) => {
      const result = executeOutcomeOperation(operation);
      if (operation.kind === phase && !interrupted) { interrupted = true; throw new Error('Acknowledgement lost'); }
      return result;
    };
    await expect(submitOutcomeManagerMessage(engine, input, { run })).rejects.toThrow('Acknowledgement lost');
    const store = new OutcomeStore(outcomeDirectory(input.outcomeId));
    const before = store.read().state!;
    expect(executeOutcomeOperation({ kind: 'pause', id: input.outcomeId, commandId: 'intervening-pause', expectedRevision: before.revision })).toMatchObject({ ok: true });
    expect(executeOutcomeOperation({ kind: 'resume', id: input.outcomeId, commandId: 'intervening-resume', expectedRevision: before.revision + 1 })).toMatchObject({ ok: true });
    await expect(submitOutcomeManagerMessage(engine, input, { run })).resolves.toMatchObject({ sourceState: 'healthy' });
    expect(store.read().state!.manager!.conversationRevision).toBe(1);
    expect(engine.getEvents(input.sessionId).filter(event => event.type === 'manager-message')).toHaveLength(1);
  });
  it('preserves the draft when current enrollment disappears, without starting an outcome', async () => {
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [] }));
    await expect(submitOutcomeManagerMessage(engine, input, deps())).rejects.toThrow('enrolled');
    expect(new OutcomeStore(outcomeDirectory(input.outcomeId)).read().sourceState).toBe('missing');
    expect(engine.getEvents(input.sessionId)).toEqual([]);
  });
  it('refuses a paused or differently linked outcome rather than stealing it', async () => {
    await submitOutcomeManagerMessage(engine, input, deps());
    const state = new OutcomeStore(outcomeDirectory(input.outcomeId)).read().state!;
    executeOutcomeOperation({ kind: 'pause', id: input.outcomeId, commandId: 'pause', expectedRevision: state.revision });
    await expect(submitOutcomeManagerMessage(engine, { ...input, commandId: 'send-2', messageId: 'message-2' }, deps())).rejects.toThrow('paused');
    await expect(submitOutcomeManagerMessage(engine, { ...input, outcomeId: 'another-outcome' }, deps())).rejects.toThrow('another outcome');
    expect(engine.getEvents(input.sessionId)).toHaveLength(1);
  });
  it('refuses changed text under the same stable message identity', async () => {
    await submitOutcomeManagerMessage(engine, input, deps());
    await expect(submitOutcomeManagerMessage(engine, { ...input, text: 'A different request' }, deps())).rejects.toThrow('different content');
    expect(new OutcomeStore(outcomeDirectory(input.outcomeId)).read().state!.manager!.conversationRevision).toBe(1);
  });
  it('reconciliation preserves missing/degraded truth and does not request synthetic replies', async () => {
    const record = vi.spyOn(engine, 'recordManagerResult');
    expect(await reconcileOutcomeManagerSession(engine, input.sessionId)).toMatchObject({ sourceState: 'missing', association: null });
    expect(record).not.toHaveBeenCalled();
    await submitOutcomeManagerMessage(engine, input, deps());
    expect(await reconcileOutcomeManagerSession(engine, input.sessionId)).toMatchObject({ sourceState: 'healthy', association: { terminalStageIds: [] } });
    expect(record).not.toHaveBeenCalled();
  });
  it('does not repeatedly load old run results when their actual events are already persisted', async () => {
    await submitOutcomeManagerMessage(engine, input, deps());
    const stageId = 'a'.repeat(64); const record = vi.spyOn(engine, 'recordManagerResult');
    vi.spyOn(engine, 'getManagerResultStages').mockReturnValue([stageId]);
    const actual = readOutcomeManagerSessionProjection(input.sessionId, [repo]);
    if (actual.sourceState !== 'healthy') throw new Error('Missing fixture association');
    const project = vi.fn(() => ({ ...actual, association: { ...actual.association, terminalStageIds: [stageId] } }));
    await reconcileOutcomeManagerSession(engine, input.sessionId, { project });
    expect(record).not.toHaveBeenCalled(); expect(project).toHaveBeenCalledTimes(2);
  });
});

describe('manager HTTP boundaries', () => {
  it('checks the existing read session and mutation gates before loading the engine', async () => {
    const load = vi.fn(async () => engine); const ctx = context(); ctx.readSession = undefined;
    expect((await request(`/api/verse/outcomes/session/${input.sessionId}`, 'GET', undefined, ctx, { engine: load })).status).toBe(401);
    ctx.allowDispatch = false;
    expect((await request('/api/verse/outcomes/interactive', 'POST', input, ctx, { engine: load })).status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects caller-written result/projection fields before host IO', async () => {
    const load = vi.fn(async () => engine);
    expect((await request('/api/verse/outcomes/interactive', 'POST', { ...input, result: 'Fake reply' }, context(), { engine: load })).status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
  it('returns durable acceptance and reads current manager state through authenticated endpoints', async () => {
    const injected = { ...deps(), engine: async () => engine };
    expect(await request('/api/verse/outcomes/interactive', 'POST', input, context(), injected)).toMatchObject({ status: 202, value: { sourceState: 'healthy' } });
    expect(await request(`/api/verse/outcomes/session/${input.sessionId}`, 'GET', undefined, context(), injected)).toMatchObject({ status: 200, value: { sourceState: 'healthy', association: { manager: { conversationRevision: 1 } } } });
  });
});
