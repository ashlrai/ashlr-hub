import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: backend.start }));
import { cmdResourceConsole } from '../src/cli/resource-console.js';

const base = ['--root', '/private/fixture/ledger', '--pool', '/private/fixture/pool.json',
  '--bindings', '/private/fixture/bindings.json', '--observations', '/private/fixture/observations.json'];
const execution = ['--execute', '--workspace', '/private/fixture/workspace', '--projects', '/private/fixture/projects.json'];
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.clearAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('explicit engineering console CLI capability', () => {
  it.each([
    [...base, '--engineering', '/private/fixture/engineering.json'],
    [...base, '--execute', '--workspace', '/private/fixture/workspace', '--engineering', '/private/fixture/engineering.json'],
    ...['relative', '/', '/private/\u0085'].map((path) => [...base, ...execution, '--engineering', path]),
    [...base, ...execution, '--engineering', '/private/fixture/a.json', '--engineering', '/private/fixture/b.json'],
    [...base, ...execution, '--engineering-supervision', '/private/fixture/supervision.json'],
    ...['relative', '/'].map(path => [...base, ...execution, '--engineering', '/private/fixture/engineering.json', '--engineering-supervision', path]),
  ])('refuses invalid enrollment authority before startup: %j', async (...args) => {
    expect(await cmdResourceConsole(args)).toBe(2); expect(backend.start).not.toHaveBeenCalled();
  });

  it('forwards only explicit private config and awaits owned shutdown', async () => {
    let finish!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    backend.start.mockResolvedValue({ url: 'http://127.0.0.1:41234', consoleUrl: 'http://127.0.0.1:41234/resources/',
      port: 41234, readToken: 'a'.repeat(64), controlToken: 'b'.repeat(64),
      scope: { schemaVersion: 1, mode: 'resource-pool', readOnly: false, engineeringSupported: true }, close });
    const before = process.listeners('SIGTERM');
    const pending = cmdResourceConsole([...base, ...execution, '--engineering', '/private/fixture/engineering.json',
      '--engineering-supervision', '/private/fixture/supervision.json', '--json']);
    try {
      await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0]).toMatchObject({ engineeringFile: '/private/fixture/engineering.json',
        engineeringSupervisionFile: '/private/fixture/supervision.json', projectsFile: '/private/fixture/projects.json', execute: true });
      const scope = JSON.parse(output.mock.calls[0]![0] as string);
      expect(scope.engineeringSupported).toBe(true); expect(scope.engineeringFile).toBeUndefined();
      (process.listeners('SIGTERM').find((listener) => !before.includes(listener))! as () => void)();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      let done = false; void pending.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
      finish(); expect(await pending).toBe(0);
    } finally {
      if (!finish) (process.listeners('SIGTERM').find((listener) => !before.includes(listener)) as (() => void) | undefined)?.();
      await vi.waitFor(() => expect(close).toHaveBeenCalled()); finish(); await pending;
    }
    expect(process.listeners('SIGTERM')).toEqual(before);
  });
});
