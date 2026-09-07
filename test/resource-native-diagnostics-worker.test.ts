/** Inert subprocess results only. No process, provider, account, or service calls. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifySubprocessAsync, type VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import { executeResourceWorker } from '../src/core/resources/worker.js';

vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
const transcript = [{ type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } },
  { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }].map((row) => JSON.stringify(row)).join('\n');
const worker = { id: 'native', provider: 'codex' as const, model: 'fixture', maxConcurrent: 1,
  reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 };
function run() {
  return executeResourceWorker(worker, { workerId: 'native', capacityKey: 'account', kind: 'native-cli', command: ['/inert/native'] },
    { prompt: 'fixture', cwd: process.cwd(), timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' });
}
beforeEach(() => vi.mocked(runVerifySubprocessAsync).mockReset());

describe('native subprocess diagnostic normalization', () => {
  it.each([
    { patch: {}, status: 'completed', reason: 'worker-completed', exitCode: 0, signal: null },
    { patch: { exitCode: 7 }, status: 'failed', reason: 'worker-exit-failed', exitCode: 7, signal: null },
    { patch: { exitCode: 124 }, status: 'failed', reason: 'worker-exit-failed', exitCode: 124, signal: null },
    { patch: { exitCode: -1 }, status: 'failed', reason: 'worker-exit-failed', exitCode: null, signal: null },
    { patch: { exitCode: 512 }, status: 'failed', reason: 'worker-exit-failed', exitCode: null, signal: null },
    { patch: { exitCode: 1, signal: 'SIGTERM' }, status: 'failed', reason: 'worker-exit-failed', exitCode: null, signal: 'SIGTERM' },
    { patch: { exitCode: 124, signal: 'SIGKILL', timedOut: true }, status: 'timed-out', reason: 'worker-timed-out', exitCode: null, signal: 'SIGKILL' },
    { patch: { exitCode: 0, cancelled: true }, status: 'cancelled', reason: 'worker-cancelled', exitCode: null, signal: null },
    { patch: { exitCode: 0, error: 'PRIVATE_SPAWN_ERROR' }, status: 'failed', reason: 'worker-process-failed', exitCode: null, signal: null },
    { patch: { exitCode: 0, error: 'termination authority lost: PRIVATE_DETAILS' }, status: 'uncertain', reason: 'worker-termination-uncertain', exitCode: null, signal: null },
    { patch: { exitCode: 0, error: 'termination deadline elapsed with process-group exit unconfirmed' }, status: 'uncertain', reason: 'worker-termination-uncertain', exitCode: null, signal: null },
    { patch: { stdout: 'PRIVATE_INVALID_EVENTS' }, status: 'failed', reason: 'worker-invalid-events', exitCode: 0, signal: null },
  ])('retains process facts independently from fixed reason: $reason / $exitCode / $signal', async ({ patch, status, reason, exitCode, signal }) => {
    vi.mocked(runVerifySubprocessAsync).mockResolvedValue({ stdout: transcript, stderr: 'PRIVATE_STDERR', exitCode: 0,
      signal: null, timedOut: false, cancelled: false, ...patch } as VerifySubprocessResult);
    const result = await run();
    expect(result).toMatchObject({ status, reason, nativeProcess: { schemaVersion: 1, scope: 'native-process',
      exitCode, signal, stderrPresent: true, outputTruncated: false } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(runVerifySubprocessAsync).toHaveBeenCalledTimes(1);
  });
  it('retains truncation facts without reading provider error text or recovering visible success', async () => {
    vi.mocked(runVerifySubprocessAsync).mockResolvedValue({ stdout: transcript, stderr: '', exitCode: 0,
      signal: null, timedOut: false, cancelled: false, outputTruncated: true });
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-output-truncated', output: '', inputTokens: null,
      outputTokens: null, nativeProcess: { exitCode: 0, signal: null, stderrPresent: false, outputTruncated: true } });
  });
});
