/**
 * 3.15 — `ashlr automations list|templates|add|enable|disable|remove|fire`
 * against the worker's isolated ASHLR_HOME and fake lanes / `gh`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAutomationsCli } from '../src/cli/automations.js';
import { listAutomations, readAutomationState } from '../src/core/automations/index.js';
import { fakeClock, fakeGh, fakeLanes, isolateAshlrHome } from './helpers/automations-fakes.js';

let restore: () => void;
let out: string[];
let err: string[];
let lanes: ReturnType<typeof fakeLanes>;

beforeEach(() => {
  restore = isolateAshlrHome();
  out = [];
  err = [];
  lanes = fakeLanes();
});
afterEach(() => restore());

const issues = [{ number: 5, title: 'Crash', body: 'b', html_url: 'https://github.com/acme/app/issues/5', updated_at: '2026-09-27T10:00:00Z', state: 'open' }];

const run = (...argv: string[]) => runAutomationsCli(argv, {
  engine: { ...lanes.deps, gh: fakeGh(() => ({ status: 200, body: issues })).gh, now: fakeClock(new Date('2026-09-27T12:00:00Z')).now, decider: null },
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  readFile: async (p) => {
    if (p === 'auto.json') return JSON.stringify({ name: 'From file', lane: 'fleet', trigger: { kind: 'webhook' }, repos: ['acme/app'] });
    throw new Error('ENOENT');
  },
});

describe('ashlr automations', () => {
  it('usage and unknown verbs', async () => {
    expect(await run()).toBe(2);
    expect(await run('help')).toBe(0);
    expect(out[0]).toMatch(/^Usage: ashlr automations/);
    expect(await run('explode')).toBe(2);
    expect(await run('list', '--nope')).toBe(2);
  });

  it('add from a template (disabled by default), from a file, list, enable, disable, remove', async () => {
    expect(await run('templates')).toBe(0);
    expect(out.join('\n')).toMatch(/fix-labeled-issues/);
    out = [];
    expect(await run('add', '--template', 'fix-labeled-issues', '--repos', 'acme/app,acme/web', '--name', 'Fix ashlr issues')).toBe(0);
    expect(out[0]).toMatch(/Created au_fix-ashlr-issues \(disabled/);
    expect(await run('add', '--file', 'auto.json', '--enable')).toBe(0);
    expect(await run('add', '--template', 'nope')).toBe(2);
    expect(await run('add', '--template', 'fix-labeled-issues', '--lane', 'mars')).toBe(1);
    expect(err.at(-1)).toMatch(/lane must be/);
    const all = await listAutomations();
    expect(all.map((a) => [a.id, a.enabled, a.repos])).toEqual([
      ['au_fix-ashlr-issues', false, ['acme/app', 'acme/web']],
      ['au_from-file', true, ['acme/app']],
    ]);

    out = [];
    expect(await run('list')).toBe(0);
    expect(out.join('\n')).toMatch(/○ au_fix-ashlr-issues/);
    expect(out.join('\n')).toMatch(/● au_from-file/);
    out = [];
    expect(await run('list', '--json')).toBe(0);
    expect((JSON.parse(out.join('\n')) as { automations: unknown[] }).automations).toHaveLength(2);

    expect(await run('enable', 'au_fix-ashlr-issues')).toBe(0);
    expect(await run('disable', 'au_from-file')).toBe(0);
    expect(await run('enable', 'au_missing')).toBe(1);
    expect(await run('remove', 'au_from-file')).toBe(0);
    expect((await listAutomations()).map((a) => [a.id, a.enabled])).toEqual([['au_fix-ashlr-issues', true]]);
  });

  it('fire --dry-run writes nothing; fire dispatches through the lane', async () => {
    await run('add', '--template', 'fix-labeled-issues', '--repos', 'acme/app', '--enable');
    out = [];
    expect(await run('fire', 'au_fix-issues-labeled-ashlr', '--dry-run')).toBe(0);
    expect(out).toEqual(['dry run · acme/app · Issue #5: Crash → dispatch to fleet']);
    expect((await readAutomationState()).firings).toEqual([]);
    out = [];
    expect(await run('fire', 'au_fix-issues-labeled-ashlr')).toBe(0);
    expect(out[0]).toMatch(/^dispatched\s+acme\/app · Issue #5: Crash/);
    expect(lanes.fleetCalls).toHaveLength(1);
    expect(await run('fire', 'au_missing')).toBe(1);
    expect(await run('fire')).toBe(2);
  });
});
