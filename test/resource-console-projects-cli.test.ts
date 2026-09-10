import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ start: vi.fn(), imported: vi.fn() }));
vi.mock('../src/core/web/resource-console-server.js', () => {
  backend.imported(); return { startResourceConsoleServer: backend.start };
});
import { cmdResourceConsole } from '../src/cli/resource-console.js';

const args = ['--root', '/private/fixture/ledger', '--pool', '/private/fixture/pool.json',
  '--bindings', '/private/fixture/bindings.json', '--observations', '/private/fixture/observations.json'];
const execution = ['--execute', '--workspace', '/private/fixture/default'];
let out: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('explicit project catalog CLI', () => {
  it.each([
    [...args, '--projects', '/private/fixture/projects.json'],
    [...args, '--execute', '--projects', '/private/fixture/projects.json'],
    [...args, ...execution, '--projects'],
    [...args, ...execution, '--projects', 'relative.json'],
    [...args, ...execution, '--projects', '/'],
    [...args, ...execution, '--projects', '/private/\u0085.json'],
    [...args, ...execution, '--projects', '/private/a.json', '--projects', '/private/b.json'],
  ])('rejects invalid catalog authority before loading the backend: %j', async (...input) => {
    const imports = backend.imported.mock.calls.length;
    expect(await cmdResourceConsole(input)).toBe(2);
    expect(backend.start).not.toHaveBeenCalled(); expect(backend.imported).toHaveBeenCalledTimes(imports);
  });

  it('passes one explicit catalog and publishes the supervisor project scope without URL credentials', async () => {
    const projects = [{ id: 'default', label: 'Default', workspace: '/private/fixture/default', enabled: true },
      { id: 'tools', label: 'Tools', workspace: '/private/fixture/tools', enabled: true }];
    const handle = { port: 41234, url: 'http://127.0.0.1:41234', consoleUrl: 'http://127.0.0.1:41234/resources/',
      readToken: 'a'.repeat(64), controlToken: 'b'.repeat(64), close: vi.fn(async () => {}),
      scope: { schemaVersion: 1, mode: 'resource-pool', root: '/private/fixture/ledger', poolId: 'fixture',
        readOnly: false, workspace: '/private/fixture/default', maxParallel: 4, maxQueued: 64, projects, defaultProjectId: 'default' } };
    backend.start.mockResolvedValue(handle); const before = process.listeners('SIGTERM');
    const pending = cmdResourceConsole([...args, ...execution, '--projects', '/private/fixture/projects.json', '--json']);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0]).toMatchObject({ projectsFile: '/private/fixture/projects.json',
        execute: true, workspace: '/private/fixture/default' });
      const record = JSON.parse(out.mock.calls[0]![0] as string);
      expect(record.projects).toEqual(projects); expect(record.defaultProjectId).toBe('default');
      expect(record.consoleUrl).not.toContain('?'); expect(record.consoleUrl).not.toContain(handle.controlToken);
    } finally {
      const listener = process.listeners('SIGTERM').find((entry) => !before.includes(entry));
      expect(listener).toBeDefined(); listener!(); await pending;
    }
    expect(await pending).toBe(0); expect(handle.close).toHaveBeenCalledOnce();
    expect(process.listeners('SIGTERM')).toEqual(before);
  });

  it('describes explicit shared-account scope in inert help', async () => {
    expect(await cmdResourceConsole(['--help'])).toBe(0); expect(backend.start).not.toHaveBeenCalled();
    expect(out.mock.calls[0]![0]).toContain('--projects requires --execute and --workspace');
    expect(out.mock.calls[0]![0]).toContain('Browser requests select IDs, never arbitrary paths');
    expect(out.mock.calls[0]![0]).toContain('share the same supervisor, resource ledger');
  });
});
