/** Observe actual source-CLI module loading in fresh processes, without provider or service work. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/cli/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function run(args: string[], mode: 'block' | 'dispatch' | 'throw' | 'import-failure' = 'dispatch') {
  const home = mkdtempSync(join(tmpdir(), 'phantom-cli-lazy-')); fixtures.push(home);
  const observer = join(home, 'observe.mjs');
  const selectedModule = args[0] === 'setup' ? 'setup.ts' : 'doctor-init.ts';
  // Synchronous loader hooks observe both the initial graph and later literal
  // imports. Fixture command handlers never access providers, stores or services.
  writeFileSync(observer, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const name = url.split('/').at(-1);
  if (name !== 'doctor-init.ts' && name !== 'setup.ts') return nextLoad(url, context);
  if (${JSON.stringify(mode)} === 'block') throw Error('Unrelated onboarding module loaded');
  if (name !== ${JSON.stringify(selectedModule)}) throw Error('Unselected onboarding module loaded');
  if (${JSON.stringify(mode)} === 'import-failure') throw Error('fixture import failure');
  const command = name === 'setup.ts' ? 'setup' : null;
  const body = ${JSON.stringify(mode)} === 'throw' ? "throw Error('fixture handler failure')" :
    "console.log(JSON.stringify({command: name, args})); return 17";
  const handler = name => 'export async function ' + name + '(args) {' +
    body.replace('command: name', 'command: ' + JSON.stringify(name)) + '}';
  return { format: 'module', shortCircuit: true, source: command ? handler('cmdSetup') : handler('cmdDoctor') + handler('cmdInit') };
}});`);
  return spawnSync(process.execPath, ['--import', 'tsx', '--import', observer, 'src/cli/index.ts', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('CLI loads onboarding only for the selected command', () => {
  it('serves help without evaluating doctor or setup dependencies', () => {
    const result = run(['help'], 'block');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stderr).toBe(''); expect(result.stdout).toContain('Phantom');
  });
  it.each([['doctor', 'cmdDoctor'], ['init', 'cmdInit'], ['setup', 'cmdSetup']])(
    'preserves %s handler arguments and returned exit code', (command, handler) => {
      const result = run([command!, '--json', '--fixture']);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(17); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ command: handler, args: ['--json', '--fixture'] });
    });
  it.each(['doctor', 'init', 'setup'])('keeps %s import failures in the common CLI error path', command => {
    const result = run([command], 'import-failure');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(stripAnsi(result.stderr)).toBe('error: fixture import failure\n');
    expect(result.stderr).not.toContain('module not yet built');
  });
  it.each(['doctor', 'init', 'setup'])('keeps %s failures in the common CLI error path', command => {
    const result = run([command], 'throw');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(stripAnsi(result.stderr)).toBe('error: fixture handler failure\n');
    expect(result.stderr).not.toContain('module not yet built');
  });
});
