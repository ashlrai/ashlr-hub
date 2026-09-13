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
function signal(name: 'SIGINT' | 'SIGTERM', before: NodeJS.SignalsListener[]): void {
  const added = process.listeners(name).find((listener) => !before.includes(listener)); expect(added).toBeDefined(); added!(name);
}
let out: ReturnType<typeof vi.spyOn>; let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); out = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {}); backend.start.mockResolvedValue(server());
});
afterEach(() => vi.restoreAllMocks());

describe('explicit foreground resource console CLI', () => {
  it('forwards explicit history compaction within the complete 32-argument contract', async () => {
    const before = process.listeners('SIGTERM'); backend.start.mockResolvedValue(server(true));
    const input = [...args, '--execute', '--workspace', '/private/work', '--projects', '/private/projects',
      '--engineering', '/private/engineering', '--engineering-preparation', '/private/preparation',
      '--engineering-supervision', '/private/supervision', '--engineering-successors', '/private/successors',
      '--quota-config', '/private/quota', '--connections-config', '/private/connections', '--port', '0',
      '--max-parallel', '4', '--allocation-controls', '--archive-history', '--json'];
    expect(input).toHaveLength(32);
    const running = cmdResourceConsole(input);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0].archiveHistory).toBe(true);
    } finally { signal('SIGTERM', before); await running; }
    expect(await running).toBe(0);
  });
  it.each([
    ['--archive-history'], ['--archive-history', 'true'],
    ['--execute', '--workspace', '/private/work', '--archive-history', '--archive-history'],
    ['--execute', '--workspace', '/private/work', '--archive-history', 'false'],
  ])('rejects ambiguous history compaction before startup: %j', async (...extra) => {
    const imported = backend.imported.mock.calls.length;
    expect(await cmdResourceConsole([...args, ...extra])).toBe(2);
    expect(backend.start).not.toHaveBeenCalled(); expect(backend.imported).toHaveBeenCalledTimes(imported);
  });
  it.each([false, true])('passes managed mission enrollment with explicit startup=%s', async automatic => {
    const handle = server(true); backend.start.mockResolvedValue(handle); const before = process.listeners('SIGTERM');
    const running = cmdResourceConsole([...args, '--execute', '--workspace', '/private/fixture/workspace', '--projects', '/private/fixture/projects.json',
      '--engineering-mission', '/private/fixture/mission.json', ...(automatic ? ['--mission-auto-start'] : []), '--json']);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0]).toMatchObject({ engineeringMissionFile: '/private/fixture/mission.json', projectsFile: '/private/fixture/projects.json' });
      expect(backend.start.mock.calls[0]![0].engineeringMissionAutoStart).toBe(automatic ? true : undefined);
    } finally { signal('SIGTERM', before); await running; }
    expect(await running).toBe(0);
  });
  it.each([
    ['--mission-auto-start'], ['--engineering-mission', '/private/mission.json'],
    ['--execute', '--workspace', '/private/work', '--engineering-mission', '/private/mission.json'],
    ['--execute', '--workspace', '/private/work', '--projects', '/private/projects.json', '--engineering-mission', '/private/mission.json', '--engineering', '/private/engineering.json'],
    ['--execute', '--workspace', '/private/work', '--projects', '/private/projects.json', '--engineering-mission', '/private/mission.json', '--mission-auto-start', '--mission-auto-start'],
  ])('refuses ambiguous mission enrollment before startup: %j', async (...extra) => {
    expect(await cmdResourceConsole([...args, ...extra])).toBe(2); expect(backend.start).not.toHaveBeenCalled();
  });
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
    expect(out.mock.calls[0]![0]).toContain('--archive-history requires execution and is off by default');
    expect(out.mock.calls[0]![0]).toContain('previously dispatching work is never');
    expect(out.mock.calls[0]![0]).toContain('--allocation-controls for usage ceilings, whole-account pauses and General/Spark reservations');
    expect(out.mock.calls[0]![0]).toContain('per-account General/Spark reservations for new tasks');
    expect(out.mock.calls[0]![0]).toContain('Whole-account pauses\nstill block both General and Spark');
    expect(out.mock.calls[0]![0]).toContain('does not grant access to the other scope');
    expect(out.mock.calls[0]![0]).toContain('do not enable execution, reset quota, stop in-flight tasks or authorize overage');
    expect(out.mock.calls[0]![0]).toContain('--engineering-preparation requires --execute and --projects');
    expect(out.mock.calls[0]![0]).toContain('Run the prepared plan separately');
    expect(out.mock.calls[0]![0]).toContain('autoAdmitPrepared');
    expect(out.mock.calls[0]![0]).toContain('original deadline and retained queue capacity');
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
      expect(Object.hasOwn(opts, 'archiveHistory')).toBe(false);
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
  it('passes explicit quota opt-in independently of task execution', async () => {
    const handle = server(); backend.start.mockResolvedValue(handle);
    const before = process.listeners('SIGTERM');
    const running = cmdResourceConsole([...args, '--quota-config', '/private/fixture/quota.json', '--json']);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0]).toMatchObject({ quotaConfigFile: '/private/fixture/quota.json', execute: false });
    } finally { signal('SIGTERM', before); await running; }
    expect(await running).toBe(0);
  });
  it.each(['relative', '/', '/private/\u0085'])('refuses invalid quota configuration path %j', async (path) => {
    expect(await cmdResourceConsole([...args, '--quota-config', path])).toBe(2); expect(backend.start).not.toHaveBeenCalled();
  });
  it.each([{ extra: [] }, { extra: ['--execute', '--workspace', '/private/fixture/workspace'] }])('requires registered execution projects for preparation %#', async ({ extra }) => {
    expect(await cmdResourceConsole([...args, ...extra, '--engineering-preparation', '/private/fixture/profiles.json'])).toBe(2);
    expect(backend.start).not.toHaveBeenCalled();
  });
  it.each([false, true])('passes preparation profiles without a static catalog (supervision=%s)', async (automatic) => {
    backend.start.mockResolvedValue(server(true)); const before = process.listeners('SIGTERM');
    const running = cmdResourceConsole([...args, '--execute', '--workspace', '/private/fixture/workspace', '--projects', '/private/fixture/projects.json',
      '--engineering-preparation', '/private/fixture/profiles.json', ...(automatic ? ['--engineering-supervision', '/private/fixture/supervision.json'] : []), '--json']);
    try {
      await vi.waitFor(() => expect(out).toHaveBeenCalledOnce());
      expect(backend.start.mock.calls[0]![0]).toMatchObject({ engineeringPreparationFile: '/private/fixture/profiles.json', execute: true });
      expect(backend.start.mock.calls[0]![0]).not.toHaveProperty('engineeringFile');
      expect(backend.start.mock.calls[0]![0].engineeringSupervisionFile).toBe(automatic ? '/private/fixture/supervision.json' : undefined);
    } finally { signal('SIGTERM', before); await running; }
    expect(await running).toBe(0);
  });
});
