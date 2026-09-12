/** Deterministic deadline checks with fake bridge completion and private mailboxes.
 * No candidate, sandbox, Git, or other native process is launched. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { exitCode: number; signal: null; error?: string; timedOut: boolean; cancelled: boolean;
  outputTruncated: boolean; stdout: string; stderr: string; processGroupSettlement: string };
type Call = { input: string; timeoutMs: number; signal: AbortSignal };
type Startup = { sessionId: string; inbox: string; outbox: string; deadlineAt: string };
type Session = { call(method: string, input: unknown): Promise<unknown>; close(): Promise<void> };
let createSession: (options: unknown) => Promise<Session>;
let publish: (path: string, value: unknown) => void;
let read: (path: string) => { id: number; nonce: string } | null;
let root: string, now: number;
const fixtures: Array<{ finish(result: Result): void; session?: Session }> = [];
beforeAll(async () => {
  ({ createPreparationCandidateSession: createSession } = await import(new URL('../scripts/evaluators/preparation-verification-controller.mjs', import.meta.url).href));
  ({ publishMessage: publish, readMessage: read } = await import(new URL('../scripts/evaluators/preparation-verification-protocol.mjs', import.meta.url).href));
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-deadline-')));
  now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.finish({ ...clean(), cancelled: true });
    try { await f.session?.close(); } catch { /* Expected refused session, no native processes exist. */ }
  }
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
function clean(stdout = ''): Result {
  return { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false,
    stdout, stderr: '', processGroupSettlement: 'group-exit-confirmed' };
}
function fixture(onConfine: (index: number) => void = () => undefined, externalSignal?: AbortSignal) {
  const candidateRoot = join(root, 'candidate'), workRoot = join(root, 'work'), fixtureRoot = join(workRoot, 'fixture');
  for (const path of [candidateRoot, workRoot, fixtureRoot]) mkdirSync(path, { mode: 0o700 });
  const bridgePath = join(root, 'bridge.mjs'); writeFileSync(bridgePath, '// fake bridge\n', { mode: 0o600 });
  let finish!: (result: Result) => void;
  const completion = new Promise<Result>(resolve => { finish = resolve; });
  let startup!: Startup;
  const calls: Call[] = []; let confineCount = 0;
  const bridge = {
    confinedUniverseArgv(command: string[]) {
      onConfine(++confineCount); return ['/usr/bin/sandbox-exec', '-p', '(version 1)', ...command];
    },
    runVerifySubprocessAsync(_command: string[], options: Call) {
      calls.push(options);
      if (calls.length === 1) {
        startup = JSON.parse(options.input) as Startup;
        publish(join(startup.outbox, 'ready.json'), { schemaVersion: 1, sessionId: startup.sessionId, ready: true });
        options.signal.addEventListener('abort', () => finish({ ...clean(), cancelled: true }), { once: true });
        return completion;
      }
      return Promise.resolve(clean(JSON.stringify({ started: true, status: 0, signal: null,
        stdoutBase64: '', stderrBase64: '', error: null })));
    },
  };
  const f = { calls, finish, session: undefined as Session | undefined,
    async start() {
      f.session = await createSession({ bridge, bridgePath, candidateRoot, fixtureRoot, workRoot, timeoutMs: 1000, signal: externalSignal });
      return f.session;
    },
    reply(id: number, value: unknown) {
      const request = read(join(startup.inbox, `request-${id}.json`)); if (!request) throw new Error('Missing request');
      publish(join(startup.outbox, `reply-${id}.json`), { schemaVersion: 1, id, nonce: request.nonce, ok: true, value });
    },
    requestTool() {
      publish(join(startup.outbox, 'exec-1.json'), { schemaVersion: 1, id: 1, nonce: 'a'.repeat(64), api: 'spawnSync', file: 'git',
        args: ['-C', fixtureRoot, 'rev-parse', '--show-toplevel'],
        options: { cwd: null, encoding: 'buffer', timeoutMs: 30000, maxBuffer: 65536, inputBase64: null } });
    },
  };
  fixtures.push(f); return f;
}

describe.runIf(process.platform === 'darwin')('preparation controller fixed deadline boundaries', () => {
  it('refuses initial candidate launch when confinement reaches the original deadline', async () => {
    const f = fixture(() => { now = 1000; });
    await expect(f.start()).rejects.toThrow('CANDIDATE_SESSION_FAILED'); expect(f.calls).toEqual([]);
  });

  it('refuses initial candidate launch if cancellation arrives during confinement', async () => {
    const abort = new AbortController(); const f = fixture(() => abort.abort(), abort.signal);
    await expect(f.start()).rejects.toThrow('CANDIDATE_SESSION_FAILED'); expect(f.calls).toEqual([]);
  });

  it('deducts initial confinement time instead of renewing the candidate timeout', async () => {
    const f = fixture(() => { now = 250; }); const session = await f.start();
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.timeoutMs).toBe(750);
    const closing = session.close(); f.reply(1, null); f.finish(clean());
    await closing; await session.close();
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
  });

  it('refuses a tool launch when its confinement reaches the original deadline', async () => {
    const f = fixture(index => { if (index === 2) now = 1000; }); const session = await f.start();
    f.requestTool(); await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    expect(f.calls).toHaveLength(1); await expect(session.close()).rejects.toThrow();
  });

  it('deducts tool confinement time without granting its declared thirty-second budget', async () => {
    const f = fixture(index => { if (index === 2) now = 250; }); const session = await f.start();
    f.requestTool(); const call = session.call('check', null); f.reply(1, { correct: true });
    await expect(call).resolves.toEqual({ value: { correct: true }, measurement: { processes: 1, blobProcesses: 0 } });
    expect(f.calls[1]!.timeoutMs).toBe(750);
    const closing = session.close(); f.reply(2, null); f.finish(clean()); await closing;
  });

  it('refuses clean close when final settlement verification crosses the deadline', async () => {
    const f = fixture(); const session = await f.start(); const closing = session.close();
    f.reply(1, null);
    // Advance only when settle validates the result, after the close reply was accepted.
    f.finish({ ...clean(), get processGroupSettlement() { now = 1000; return 'group-exit-confirmed'; } });
    await expect(closing).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    await expect(session.close()).rejects.toThrow('CANDIDATE_SESSION_FAILED');
  });
});
