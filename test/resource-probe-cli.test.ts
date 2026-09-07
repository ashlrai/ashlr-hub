import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../src/core/resources/codex-account-probe.js', () => ({ probeCodexResourceAccount: native.probe }));
import { cmdResourceProbe } from '../src/cli/resource-probe.js';

let base: string; let args: string[]; let output: string;
let stdout: ReturnType<typeof vi.spyOn>; let stderr: ReturnType<typeof vi.spyOn>;
const report = { schemaVersion: 1, scope: 'codex-native-metadata', workerId: 'codex-a', poolDigest: 'a'.repeat(64),
  status: 'observed', reason: 'probe-observed', startedAt: '2026-09-07T12:00:00.000Z', finishedAt: '2026-09-07T12:00:00.050Z',
  accountHint: 'b'.repeat(64), planType: 'pro', observation: null };
beforeEach(() => {
  vi.clearAllMocks(); base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-probe-cli-')));
  const pool = join(base, 'pool.json'); const bindings = join(base, 'bindings.json'); output = join(base, 'report.json');
  writeFileSync(pool, '{"schemaVersion":1}', { mode: 0o600 }); writeFileSync(bindings, '[]', { mode: 0o600 });
  args = ['--pool', pool, '--bindings', bindings, '--worker', 'codex-a', '--bucket', 'codex', '--output', output];
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {}); stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  native.probe.mockResolvedValue(report);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

describe('native metadata probe CLI', () => {
  it.each([[], ['--help', '--json'], ['--pool', '/'], ['--pool', 'relative'], ['--secret', 'value']].map((input) => ({ input })))(
    'rejects invalid scope before native contact %#', async ({ input }) => {
      expect(await cmdResourceProbe(input)).toBe(2); expect(native.probe).not.toHaveBeenCalled(); expect(existsSync(output)).toBe(false);
    });
  it.each([['--bucket', 'codex'], ['--timeout-ms', '0'], ['--timeout-ms', '30001'], ['--timeout-ms', '1.5'],
    ['--expected-account-hint', 'not-a-hint'], ['--json', '--json'], ['--pool', '/private/other'], ['--worker', 'PRIVATE\nDATA']].map((extra) => ({ extra })))(
    'rejects malformed or duplicate flags %#', async ({ extra }) => {
      expect(await cmdResourceProbe([...args, ...extra])).toBe(2); expect(native.probe).not.toHaveBeenCalled();
    });
  it.each(['--help', '-h'])('help is inert and explains metadata versus generation: %s', async (flag) => {
    expect(await cmdResourceProbe([flag])).toBe(0); expect(native.probe).not.toHaveBeenCalled();
    expect(stdout.mock.calls[0]![0]).toContain('creates no thread, turn or model request');
  });
  it('reserves private output before contact, passes pinned scope and retains only normalized metadata', async () => {
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    native.probe.mockImplementation(async (options) => {
      expect(existsSync(output)).toBe(true); expect(statSync(output).size).toBe(0); expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(options).toMatchObject({ workerId: 'codex-a', cwd: base, bucketIds: ['codex', 'codex_other'],
        expectedAccountHint: 'b'.repeat(64), timeoutMs: 30000 });
      expect(options.signal).toBeInstanceOf(AbortSignal); return report;
    });
    expect(await cmdResourceProbe([...args, '--bucket', 'codex_other', '--expected-account-hint', 'b'.repeat(64), '--timeout-ms', '30000', '--json'])).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
    const value = JSON.parse(stdout.mock.calls[0]![0] as string);
    expect(value).toMatchObject({ report, outputFile: { path: output, state: 'written', bytes: statSync(output).size } });
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
  it('refuses an existing output without contacting the native launcher', async () => {
    writeFileSync(output, 'original', { mode: 0o600 });
    expect(await cmdResourceProbe([...args, '--json'])).toBe(1); expect(native.probe).not.toHaveBeenCalled();
    expect(readFileSync(output, 'utf8')).toBe('original'); expect(stdout.mock.calls[0]![0]).not.toContain('original');
  });
  it('sanitizes provider failure and identifies the empty reserved file', async () => {
    native.probe.mockRejectedValue(new Error('PRIVATE_NATIVE_EMAIL_TOKEN'));
    expect(await cmdResourceProbe([...args, '--json'])).toBe(1);
    expect(stdout.mock.calls[0]![0]).not.toContain('PRIVATE_NATIVE');
    expect(JSON.parse(stdout.mock.calls[0]![0] as string).outputFile.state).toBe('empty');
    expect(statSync(output).size).toBe(0); expect(stderr).not.toHaveBeenCalled();
  });
  it('waits for signal-owned cancellation and writes its sanitized terminal report', async () => {
    const before = process.listeners('SIGTERM');
    const cancelled = { ...report, status: 'cancelled', reason: 'probe-cancelled', accountHint: null, planType: null };
    native.probe.mockImplementation((options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve(cancelled), { once: true });
    }));
    const running = cmdResourceProbe([...args, '--json']);
    await vi.waitFor(() => expect(native.probe).toHaveBeenCalledOnce());
    process.listeners('SIGTERM').find((listener) => !before.includes(listener))!();
    expect(await running).toBe(1); expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(cancelled);
    expect(process.listeners('SIGTERM')).toEqual(before);
  });
  it('routes through the existing pool entry point without reading native state', async () => {
    const { cmdResourcePool } = await import('../src/cli/resource-pool.js');
    expect(await cmdResourcePool(['probe', '--help'])).toBe(0); expect(native.probe).not.toHaveBeenCalled();
  });
});
