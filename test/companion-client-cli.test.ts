import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCompanions } from '../src/cli/companions.js';

afterEach(() => { vi.restoreAllMocks(); });
function capture() {
  const stdout: string[] = []; const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { stdout.push(String(value)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(value => { stderr.push(String(value)); return true; });
  return { stdout, stderr };
}

describe('explicit companion client-plan CLI', () => {
  it('documents an inert plan and current runtime requirement', async () => {
    const output = capture();
    expect(await cmdCompanions(['client-plan', '--help'])).toBe(0);
    expect(output.stdout.join('')).toContain('No files are written, processes started');
    expect(output.stdout.join('')).toContain('current Node host');
    expect(output.stderr).toEqual([]);
  });

  it.each([
    [], ['--installation'], ['--installation', 'relative'], ['--json', '--json'],
    ['--help', '--json'], ['--node', '/unreviewed/runtime'], ['--apply'],
    ['--project', '/one', '--project', '/two'],
  ])('refuses incomplete, repeated or effect-bearing options %j', async (...args: string[]) => {
    const output = capture();
    expect(await cmdCompanions(['client-plan', ...args])).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.length).toBe(1);
  });

  it('reports blocked inspection without publishing config entries', async () => {
    const output = capture();
    expect(await cmdCompanions(['client-plan', '--installation', '/phantom-missing-fixture-root',
      '--project', '/phantom-missing-project', '--client', 'fixture',
      '--registry', '/phantom-missing-project/registry.json', '--config', '/phantom-missing-project/client.json', '--json'])).toBe(1);
    const report = JSON.parse(output.stdout.join(''));
    expect(report).toMatchObject({ status: 'blocked', effects: [], wiringApplied: false, patches: [],
      runtimeCapability: 'not-inspected', requiresRevalidationBeforeExecution: true });
    expect(output.stderr).toEqual([]);
  });
});
