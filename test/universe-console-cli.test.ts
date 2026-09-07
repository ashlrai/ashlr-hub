import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ startUniverseConsoleServer: vi.fn(), imported: vi.fn() }));
vi.mock('../src/core/web/universe-console-server.js', () => {
  backend.imported();
  return { startUniverseConsoleServer: backend.startUniverseConsoleServer };
});
import { cmdUniverseConsole } from '../src/cli/universe-console.js';

const root = '/private/fixture/universe';
function server() {
  return { port: 42_123, url: 'http://127.0.0.1:42123', consoleUrl: 'http://127.0.0.1:42123/universe/',
    readToken: 'a'.repeat(64), close: vi.fn(async () => undefined) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function added(signal: 'SIGINT' | 'SIGTERM', previous: ReturnType<typeof process.listeners>) {
  const listener = process.listeners(signal).find((entry) => !previous.includes(entry));
  expect(listener).toBeDefined();
  return listener!;
}

describe('foreground Universe console CLI', () => {
  let output: ReturnType<typeof vi.spyOn>; let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    backend.startUniverseConsoleServer.mockResolvedValue(server());
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    [], ['--root'], ['--root', 'relative'], ['--root', '~/.ashlr/universe'], ['--root', '/'],
    ['--root', '////'], ['--root', '/private/..'], ['--root', '/private/x\n'], ['--root', '/private/x\0'],
    ['--root', '/private/x\u0085'], ['--root', `/${'x'.repeat(4_096)}`],
    ['--root', root, '--root', '/private/other'], ['--root', root, '--json', '--json'],
    ['--root', root, '--port', '0', '--port', '1'], ['--root', root, '--port'],
    ['--root', root, '--port', '-1'], ['--root', root, '--port', '1.5'], ['--root', root, '--port', '65536'],
    ['--root', root, '--port', '1e3'], ['--root', root, '--port', '+1'], ['--root', root, '--port', ' 1'],
    ['--root', root, '--port', '01'], ['--root', root, '--port', '0\n'],
    ['--root', root, '--open'], ['--root', root, '--allow-dispatch'], ['--root', root, '--unknown'],
    ['--root', root, 'extra'], ['--root', root, '--'], ['--root=/private/u'],
    ['--help', '--root', root], ['--root', root, '--help'], ['--help', '--json'], ['help'],
    ['--root', `/${'é'.repeat(2_048)}`], Array.from({ length: 17 }, () => '--json'),
  ])('rejects %j before backend import or startup', async (...args) => {
    const imports = backend.imported.mock.calls.length;
    expect(await cmdUniverseConsole(args)).toBe(2);
    expect(backend.imported).toHaveBeenCalledTimes(imports);
    expect(backend.startUniverseConsoleServer).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h']])('prints bounded help without starting a listener for %j', async (...args) => {
    const imports = backend.imported.mock.calls.length;
    expect(await cmdUniverseConsole(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('defaults to 0');
    expect(output.mock.calls[0]![0]).toContain('explicit absolute private root');
    expect(output.mock.calls[0]![0]).toContain('No browser is opened');
    expect(backend.imported).toHaveBeenCalledTimes(imports);
    expect(backend.startUniverseConsoleServer).not.toHaveBeenCalled();
  });

  it.each([undefined, '0', '1', '65535'])('passes exact root and bounded port %s and emits one JSON startup record', async (port) => {
    const handle = server(); backend.startUniverseConsoleServer.mockResolvedValue(handle);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdUniverseConsole(['--root', root, ...(port === undefined ? [] : ['--port', port]), '--json']);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
    expect(backend.startUniverseConsoleServer).toHaveBeenCalledWith({ root, port: Number(port ?? 0) });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ schemaVersion: 1, mode: 'universe', root,
      readOnly: true, url: handle.url, consoleUrl: handle.consoleUrl, port: handle.port,
      readToken: handle.readToken, readTokenHeader: 'X-Ashlr-Token' });
    expect(handle.url).not.toContain(handle.readToken); expect(handle.consoleUrl).not.toContain('?');
    expect(handle.close).not.toHaveBeenCalled();
    added('SIGINT', beforeInt)(); expect(await running).toBe(0);
    expect(handle.close).toHaveBeenCalledTimes(1); expect(output).toHaveBeenCalledTimes(1);
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('renders explicit root, private token, read-only scope, and no service activation in human output', async () => {
    const before = process.listeners('SIGTERM');
    const running = cmdUniverseConsole(['--root', root]);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain(`Root: ${root}`); expect(text).toContain('read-only');
    expect(text).toContain('Private read token:'); expect(text).toContain('No experiment execution or service activation');
    added('SIGTERM', before)(); expect(await running).toBe(0);
  });

  it.each([`${root}/`, '/private/fixture/./universe', '/private/fixture/parent/../universe/'])('uses one lexical scope identity for %s in forwarding and startup', async (input) => {
    const before = process.listeners('SIGINT');
    const running = cmdUniverseConsole(['--root', input, '--json']);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
    expect(backend.startUniverseConsoleServer).toHaveBeenCalledWith({ root, port: 0 });
    expect(JSON.parse(output.mock.calls[0]![0] as string).root).toBe(root);
    added('SIGINT', before)(); expect(await running).toBe(0);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('a signal during lazy import avoids binding at all', async () => {
    const before = process.listeners('SIGINT');
    const running = cmdUniverseConsole(['--root', root, '--json']);
    added('SIGINT', before)();
    expect(await running).toBe(0);
    expect(backend.startUniverseConsoleServer).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('a signal during binding awaits the exact startup and closes it without announcing a token', async () => {
    const handle = server(); const startup = deferred<ReturnType<typeof server>>();
    backend.startUniverseConsoleServer.mockReturnValue(startup.promise);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdUniverseConsole(['--root', root, '--json']);
    await vi.waitFor(() => expect(backend.startUniverseConsoleServer).toHaveBeenCalledTimes(1));
    added('SIGTERM', beforeTerm)(); added('SIGINT', beforeInt)();
    expect(handle.close).not.toHaveBeenCalled(); startup.resolve(handle);
    expect(await running).toBe(0); expect(handle.close).toHaveBeenCalledTimes(1); expect(output).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('coalesces repeated signals and waits for close to finish', async () => {
    const handle = server(); const closing = deferred<void>(); handle.close.mockReturnValue(closing.promise);
    backend.startUniverseConsoleServer.mockResolvedValue(handle);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    let finished = false;
    const running = cmdUniverseConsole(['--root', root, '--json']).then((code) => { finished = true; return code; });
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
    const interrupt = added('SIGINT', beforeInt); const terminate = added('SIGTERM', beforeTerm);
    interrupt(); terminate(); interrupt();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1)); expect(finished).toBe(false);
    closing.resolve(); expect(await running).toBe(0);
    expect(handle.close).toHaveBeenCalledTimes(1); expect(output).toHaveBeenCalledTimes(1);
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each([false, true])('sanitizes startup failures and removes both signal listeners (JSON=%s)', async (json) => {
    backend.startUniverseConsoleServer.mockRejectedValue(new Error('private raw bind details and secret'));
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    expect(await cmdUniverseConsole(['--root', root, ...(json ? ['--json'] : [])])).toBe(1);
    expect(backend.startUniverseConsoleServer).toHaveBeenCalledTimes(1);
    if (json) expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Universe console could not start or stop' });
    else expect(errors).toHaveBeenCalledWith('universe console: Universe console could not start or stop');
    expect([...output.mock.calls, ...errors.mock.calls].flat().join('')).not.toContain('secret');
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each([false, true])('failed close is exit1, sanitized, and does not add a stdout startup record (sync=%s)', async (sync) => {
    const handle = server();
    if (sync) handle.close.mockImplementation(() => { throw new Error('private close secret'); });
    else handle.close.mockRejectedValue(new Error('private close secret'));
    backend.startUniverseConsoleServer.mockResolvedValue(handle);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdUniverseConsole(['--root', root, '--json']);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1)); added('SIGINT', beforeInt)();
    expect(await running).toBe(1); expect(handle.close).toHaveBeenCalledTimes(1); expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errors.mock.calls[0]![0] as string)).toEqual({ error: 'Universe console could not start or stop' });
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('JSON usage errors do not echo private arguments', async () => {
    expect(await cmdUniverseConsole(['--sensitive-private-value', '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Unknown or duplicate console option' });
    expect(errors).not.toHaveBeenCalled();
  });

  it('delegates from Universe before the legacy parser and appears in the help registry', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['console', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('usage: ashlr universe console');
    const { AGENT_COMMANDS, HELP_ENTRIES } = await import('../src/cli/help.js');
    const entry = AGENT_COMMANDS.find((item) => item.usage.startsWith('ashlr universe console'))!;
    expect(entry.safety).toBe('read'); expect(entry.description).toContain('foreground');
    expect(HELP_ENTRIES.some((item) => item.cmd.startsWith('universe console'))).toBe(true);
    expect(backend.startUniverseConsoleServer).not.toHaveBeenCalled();
  });
});
