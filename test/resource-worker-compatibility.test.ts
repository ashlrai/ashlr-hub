/** Inert subprocess transcripts only; never vendor CLI or provider calls. */
import { describe, expect, it, vi } from 'vitest';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { executeResourceWorker } from '../src/core/resources/worker.js';

vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
const subprocess = vi.mocked(runVerifySubprocessAsync);
const model = 'fixture-model';
const message = `The '${model}' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.`;
const rejection = (patch: Record<string, unknown> = {}) => JSON.stringify({ type: 'error', status: 400,
  error: { type: 'invalid_request_error', message }, ...patch });
async function run(rows: unknown[], patch: Partial<Awaited<ReturnType<typeof runVerifySubprocessAsync>>> = {}) {
  subprocess.mockResolvedValue({ stdout: rows.map((row) => JSON.stringify(row)).join('\n'), stderr: 'PRIVATE_PROVIDER_TEXT',
    exitCode: 1, signal: null, cancelled: false, timedOut: false, ...patch });
  return executeResourceWorker({ id: 'codex', provider: 'codex', model, maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 3, taskWindowMs: 60000, priority: 1 },
  { workerId: 'codex', capacityKey: 'account', kind: 'native-cli', command: ['/fixture/codex'] },
  { prompt: 'Only inspect the supplied fixture.', cwd: process.cwd(), mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 64 });
}

describe('Codex model/CLI compatibility diagnosis', () => {
  it.each(['error', 'turn.failed'])('recognizes the exact structured %s rejection without storing the message', async (type) => {
    const result = await run([type === 'error' ? { type, message: rejection() } : { type, error: { message: rejection() } }]);
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-cli-upgrade-required', inputTokens: null, outputTokens: null,
      nativeProcess: { exitCode: 1, signal: null, stderrPresent: true, outputTruncated: false } });
    expect(JSON.stringify(result)).not.toContain(message);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_TEXT');
  });
  it.each([message, rejection({ status: 401 }), rejection({ type: 'other' }),
    rejection({ error: { type: 'invalid_request_error', message: 'The model does not exist.' } }),
    rejection({ error: { type: 'other_error', message } }), rejection().replace('fixture-model', 'another-model')])(
    'keeps unknown rejection %# generic', async (text) => {
      expect((await run([{ type: 'error', message: text }])).reason).toBe('worker-exit-failed');
    });
  it('does not classify matching text in an agent message as a provider rejection', async () => {
    const result = await run([{ type: 'item.completed', item: { type: 'agent_message', text: rejection() } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }], { exitCode: 0, stderr: '' });
    expect(result.reason).toBe('worker-completed');
  });
  it.each([
    [{ timedOut: true, exitCode: 124 }, 'worker-timed-out'],
    [{ cancelled: true }, 'worker-cancelled'],
    [{ signal: 'SIGTERM' as const }, 'worker-exit-failed'],
    [{ outputTruncated: true as const }, 'worker-output-truncated'],
    [{ error: 'subprocess stdin delivery failed' }, 'worker-process-failed'],
    [{ error: 'termination deadline elapsed with process-group exit unconfirmed' }, 'worker-termination-uncertain'],
  ])('retains runner failure precedence %#', async (patch, reason) => {
    const result = await run([{ type: 'error', message: rejection() }], patch);
    expect(result.reason).toBe(reason);
  });
});
