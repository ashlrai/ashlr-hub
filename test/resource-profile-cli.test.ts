/** Parser/routing fixtures: no native account preparation or provider contact. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ prepare: vi.fn(), legacy: vi.fn() }));
vi.mock('../src/core/resources/native-profile.js', () => ({ prepareResourceNativeProfile: backend.prepare }));
vi.mock('../src/core/config.js', () => ({ loadConfig: backend.legacy }));
import { cmdResources } from '../src/cli/resources.js';
const directory = "/private/owner's profiles/codex-a";
const args = ['profile', 'prepare', '--provider', 'codex', '--directory', directory, '--executable', '/private/native'];
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  backend.prepare.mockImplementation((options) => ({ ...options, status: 'prepared', authentication: 'not-checked',
    commandPath: `${directory}/command.json`, loginCommand: ['/private/node', `${directory}/launcher.mjs`, 'login'] }));
});
afterEach(() => vi.restoreAllMocks());

describe('native profile preparation CLI', () => {
  it.each(['codex', 'claude', 'grok'])('prepares only the exact %s target and returns unauthenticated metadata', async (provider) => {
    const input = [...args]; input[3] = provider;
    expect(await cmdResources([...input, '--json'])).toBe(0);
    expect(backend.prepare).toHaveBeenCalledWith({ provider, directory, executable: '/private/native' });
    expect(JSON.parse(output.mock.calls[0]![0]).authentication).toBe('not-checked'); expect(backend.legacy).not.toHaveBeenCalled();
  });
  it('quotes the separate native login hint without executing it', async () => {
    expect(await cmdResources(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain("'/private/owner'\\''s profiles/codex-a/launcher.mjs'");
    expect(output.mock.calls[0]![0]).toContain('No login was executed');
  });
  it.each([['--help'], ['-h']])('does not prepare anything for help %j', async (...input) => {
    expect(await cmdResources(['profile', ...input])).toBe(0); expect(backend.prepare).not.toHaveBeenCalled(); expect(backend.legacy).not.toHaveBeenCalled();
  });
  it.each([
    [], ['prepare'], ['prepare', '--provider', 'unsupported-provider'], ['prepare', '--help'], ['--help', '--json'],
    ['prepare', '--provider', 'codex', '--directory', directory],
    ['prepare', '--provider', 'codex', '--directory', 'relative', '--executable', '/private/native'],
    ['prepare', '--provider', 'codex', '--directory', '/private/../x', '--executable', '/private/native'],
    ['prepare', '--provider', 'codex', '--directory', directory, '--executable', '/'],
    ['prepare', '--provider', 'codex', '--directory', directory, '--executable', '/private/native\n'],
    ['prepare', '--provider', 'codex', '--directory', directory, '--executable', '/private/native\u0085'],
  ])('rejects malformed scope %j before backend call', async (...input) => {
    expect(await cmdResources(['profile', ...input, '--json'])).toBe(2); expect(backend.prepare).not.toHaveBeenCalled();
  });
  it.each([['--json', '--json'], ['--directory', '/private/other'], ['--force'], ['--login'], ['--provider', 'claude'], ['extra']])(
    'rejects duplicate/extra options %j', async (...extra) => {
      expect(await cmdResources([...args, ...extra])).toBe(2); expect(backend.prepare).not.toHaveBeenCalled();
    });
  it('does not expose raw failure details or automatically retry a partially created target', async () => {
    backend.prepare.mockImplementation(() => { throw new Error('PRIVATE credential path'); });
    expect(await cmdResources([...args, '--json'])).toBe(1); expect(backend.prepare).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]![0]).toContain('partial files'); expect(output.mock.calls[0]![0]).not.toContain('PRIVATE');
  });
});
