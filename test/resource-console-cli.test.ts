import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ start: vi.fn(), imported: vi.fn() }));
vi.mock('../src/core/web/resource-console-server.js', () => {
  backend.imported(); return { startResourceConsoleServer: backend.start };
});
import { cmdResourceConsole } from '../src/cli/resource-console.js';

const args = ['--root', '/private/fixture/ledger', '--pool', '/private/fixture/pool.json',
  '--bindings', '/private/fixture/bindings.json', '--observations', '/private/fixture/observations.json'];
function server(execute = false) {
  return { port: 41234, url: 'http://127.0.0.1:41234', consoleUrl: 'http://127.0.0.1:41234/resources/',
    readToken: 'a'.repeat(64), controlToken: execute ? 'b'.repeat(64) : null,
    scope: { schemaVersion: 1, mode: 'resource-pool', root: '/private/fixture/ledger', poolId: 'fixture', readOnly: !execute,
      workspace: execute ? '/private/fixture/workspace' : null, maxParallel: execute ? 4 : 0, maxQueued: execute ? 64 : 0 },
    close: vi.fn(async () => {}) };
}
function signal(name: 'SIGINT' | 'SIGTERM', before: ReturnType<typeof process.listeners>): void {
  const added = process.listeners(name).find((listener) => !before.includes(listener)); expect(added).toBeDefined(); added!();
}
let out: ReturnType<typeof vi.spyOn>; let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); out = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {}); backend.start.mockResolvedValue(server());
});
afterEach(() => vi.restoreAllMocks());

describe('explicit foreground resource console CLI', () => {
  it.each([[], ['--help', '--json'], ['--root', '/'], ['--root', 'relative'], [...args, '--unknown'],
    [...args, '--port', '-1'], [...args, '--port', '65536'], [...args, '--port', '01'], [...args, '--port', '1.5'],
    [...args, '--execute'], [...args, '--workspace', '/private/work'], [...args, '--max-parallel', '2'],
    [...args, '--execute', '--execute', '--workspace', '/private/work'],
    [...args, '--execute', '--workspace', '/private/work', '--max-parallel', '17'],
    [...args, '--execute', '--workspace', '/private/work', '--max-parallel', '0'],
    [...args, '--json', '--json'], [...args, '--root', '/private/other'], [...args, '--observations', '/private/secret'],
    [...args, '--port', '1\n'], [...args, '--workspace', '/private/\u0085'],
    ['--root', '/private/\0'], ['--root', '/private/..'], ['--root', `/${'x'.repeat(4096)}`], Array(25).fill('--json'),
  ])('rejects invalid flags before backend import/start: %j', async (...input) => {
    const imported = backend.imported.mock.calls.length;
    expect(await cmdResourceConsole(input)).toBe(2); expect(backend.start).not.toHaveBeenCalled();
    expect(backend.imported).toHaveBeenCalledTimes(imported);
  });
  it.each(['--help', '-h'])('help is inert: %s', async (flag) => {
    expect(await cmdResourceConsole([flag])).toBe(0); expect(backend.start).not.toHaveBeenCalled();
    expect(out.mock.calls[0]![0]).toContain('Read-only by default');
    expect(out.mock.calls[0]![0]).toContain('previously dispatching work is never');
  });
  it.each([false, true])('passes explicit scope and emits one startup record (execute=%s)', async (execute) => {
    const handle = server(execute); backend.start.mockResolvedValue(handle);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdResourceConsole([...args, ...(execute ? ['--execute', '--workspace', '/private/fixture/workspace'] : []), '--json']);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      const opts = backend.start.mock.calls[0]![0];
      expect(opts).toMatchObject({ root: '/private/fixture/ledger', poolFile: '/private/fixture/pool.json',
        bindingsFile: '/private/fixture/bindings.json', observationsFile: '/private/fixture/observations.json', port: 0, execute });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.workspace).toBe(execute ? '/private/fixture/workspace' : undefined);
      const record = JSON.parse(out.mock.calls[0]![0] as string);
      expect(record.readOnly).toBe(!execute); expect(record.controlToken).toBe(handle.controlToken);
      expect(record.consoleUrl).not.toContain(handle.readToken); expect(record.consoleUrl).not.toContain('?');
    } finally { signal('SIGTERM', beforeTerm); await running; }
    expect(await running).toBe(0); expect(handle.close).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
  it('does not bind when interrupted during lazy import', async () => {
    const before = process.listeners('SIGINT'); const pending = cmdResourceConsole(args); signal('SIGINT', before);
    expect(await pending).toBe(0); expect(backend.start).not.toHaveBeenCalled(); expect(out).not.toHaveBeenCalled();
  });
  it('sanitizes startup failure and removes both signal listeners', async () => {
    backend.start.mockRejectedValue(new Error('private-file-secret'));
    const before = process.listeners('SIGINT');
    expect(await cmdResourceConsole([...args, '--json'])).toBe(1);
    expect(out).toHaveBeenCalledWith(JSON.stringify({ error: 'Resource console could not start or stop' }));
    expect(process.listeners('SIGINT')).toEqual(before); expect(err).not.toHaveBeenCalled();
  });
  it('awaits one failing close and reports nonzero without a second stdout record', async () => {
    const handle = server(true); handle.close.mockRejectedValue(new Error('unconfirmed-private-worker'));
    backend.start.mockResolvedValue(handle); const before = process.listeners('SIGINT');
    const pending = cmdResourceConsole([...args, '--execute', '--workspace', '/private/workspace', '--json']);
    await vi.waitFor(() => expect(out).toHaveBeenCalledOnce()); signal('SIGINT', before); signal('SIGINT', before);
    expect(await pending).toBe(1); expect(handle.close).toHaveBeenCalledOnce(); expect(out).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalledWith(JSON.stringify({ error: 'Resource console could not start or stop' }));
  });
  it('delegates console help before standalone pool parsing without starting a server', async () => {
    const { cmdResourcePool } = await import('../src/cli/resource-pool.js');
    expect(await cmdResourcePool(['console', '--help'])).toBe(0);
    expect(backend.start).not.toHaveBeenCalled(); expect(out.mock.calls[0]![0]).toContain('foreground queued tasks');
  });
});
