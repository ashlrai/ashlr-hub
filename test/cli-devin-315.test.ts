/**
 * 3.15 — `ashlr devin` (src/cli/devin.ts) with injected deps: the key is read
 * only through the hidden reader, never printed, and `connect` turns the
 * lane on; verbs map onto the service; flags are strict.
 */
import { describe, expect, it } from 'vitest';

import { runDevinCli, type DevinCliDeps } from '../src/cli/devin.js';
import { devinBudgetView } from '../src/core/devin/budget.js';
import { DEFAULT_DEVIN_BUDGET, type DevinBudgetUpdate, type DevinBudgetV1, type DevinStatus } from '../src/core/devin/types.js';

const KEY = 'cog_cliTestKey_abcdefghijklmnopqrstuvwxyz';

function harness(patch: Partial<DevinCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const config: Array<{ enabled?: boolean; fleet?: boolean }> = [];
  const updates: DevinBudgetUpdate[] = [];
  let budget: DevinBudgetV1 = { ...DEFAULT_DEVIN_BUDGET, updatedAt: new Date(0).toISOString() };
  const status: DevinStatus = {
    enabled: true, connected: true, state: 'ready', reason: 'Connected.', orgId: 'org-x', principal: 'service_user', principalName: 'Verse', keyStore: 'keychain',
    chatLine: 'Chat: n/a — Devin works in sessions, not chat turns', fleetLine: 'Fleet: Off — nope', fleetReady: false,
    chat: { ready: false, tone: 'off', word: 'n/a', detail: '', fix: null },
    fleet: { ready: false, tone: 'off', word: 'Off', detail: 'nope', fix: null, roles: [], reservePercent: null },
  };
  const deps: DevinCliDeps = {
    connect: async (input) => {
      if (input.key !== KEY) throw new Error(`bad key ${input.key}`);
      return { orgId: input.orgId ?? 'org-x', principal: 'service_user', principalName: 'Verse' };
    },
    disconnect: async () => ({ removedKey: true }),
    setConfig: (p) => { config.push(p); },
    status: async () => status,
    launch: async (req) => ({ ok: true, task: { id: 'dv_20260927T0400_aaaaaa', title: req.prompt, repo: req.repo, branch: 'ashlr-devin/dv_20260927T0400_aaaaaa', baseBranch: 'main', maxAcu: 10, sessionUrl: 'https://app.devin.ai/sessions/devin-1' } as never, error: null, failure: null }),
    listTasks: () => [],
    refresh: async () => ({ checked: 2, updated: 1 }),
    message: async () => ({ ok: true, task: {} as never }),
    readBudget: () => budget,
    updateBudget: (u) => {
      updates.push(u);
      budget = { ...budget, ...u };
      return budget;
    },
    budgetView: (tasks, b, now) => devinBudgetView(tasks, b, now),
    readSecret: async () => KEY,
    originRepo: () => 'ashlrai/ashlr-hub',
    cwd: () => '/tmp',
    now: () => new Date(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...patch,
  };
  return { deps, out, err, config, updates };
}

describe('ashlr devin', () => {
  it('connect reads the key hidden, never prints it, and turns the lane on', async () => {
    const h = harness();
    expect(await runDevinCli(['connect', '--org', 'org-abc'], h.deps)).toBe(0);
    expect(h.config).toEqual([{ enabled: true }]);
    expect(h.out.join('\n')).toMatch(/Connected to Devin as Verse \(service user\) in org-abc/);
    expect([...h.out, ...h.err].join('\n')).not.toContain(KEY);
  });

  it('a refused key is reported without echoing it', async () => {
    const h = harness({ readSecret: async () => 'cog_wrongKeyValue_abcdefghijklmnopqrstu' });
    expect(await runDevinCli(['connect'], h.deps)).toBe(1);
    expect(h.err.join('\n')).not.toContain('wrongKeyValue');
    expect(h.config).toEqual([]);
  });

  it('the key is never accepted as an argument', async () => {
    const h = harness();
    expect(await runDevinCli(['connect', KEY], h.deps)).toBe(2);
    expect(h.config).toEqual([]);
  });

  it('status prints the Chat and Fleet lines and the ACU budget', async () => {
    const h = harness();
    expect(await runDevinCli(['status'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Chat: n/a');
    expect(text).toContain('Fleet: Off');
    expect(text).toMatch(/ACUs: 0 ACUs of 50 ACUs used/);
  });

  it('fleet on/off, enable/disable, and launch from the folder origin', async () => {
    const h = harness();
    expect(await runDevinCli(['fleet', 'on'], h.deps)).toBe(0);
    expect(await runDevinCli(['disable'], h.deps)).toBe(0);
    expect(h.config).toEqual([{ fleet: true }, { enabled: false }]);
    expect(await runDevinCli(['fleet', 'maybe'], h.deps)).toBe(2);
    expect(await runDevinCli(['launch', 'Add', 'a', 'helper'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Launched Devin task: Add a helper');
  });

  it('budget flags are strict; --pause-at takes a percent', async () => {
    const h = harness();
    expect(await runDevinCli(['budget', '--acu', '80', '--per-session', '6', '--pause-at', '85'], h.deps)).toBe(0);
    expect(h.updates).toEqual([{ acuBudgetTotal: 80, maxAcuPerSession: 6, pauseAtFraction: 0.85 }]);
    expect(await runDevinCli(['budget', '--per-session', '1.5'], h.deps)).toBe(2);
    expect(await runDevinCli(['budget', '--bogus', '1'], h.deps)).toBe(2);
  });

  it('unknown verbs are usage errors', async () => {
    const h = harness();
    expect(await runDevinCli(['merge'], h.deps)).toBe(2);
  });
});
