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
    expect(text).toMatch(/ACUs: 0 ACUs of 50 ACUs accounted for/);
  });

  it('does not price an uncertain create reservation as reported spend', async () => {
    const h = harness({ listTasks: () => [{
      sessionId: null, session: null, maxAcu: 10, state: 'failed', failure: 'network',
      origin: 'fleet', createdAt: new Date().toISOString(), launchedAt: null,
    } as never] });
    expect(await runDevinCli(['status'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('0 ACUs reported usage + adjustment · 10 ACUs held exposure');
    expect(h.out.join('\n')).toContain('$0 for recorded usage (estimate)');
    expect(h.out.join('\n')).not.toContain('$22.5');
    h.out.length = 0;
    expect(await runDevinCli(['budget'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('0 ACUs reported usage + adjustment · 10 ACUs held exposure');
    expect(h.out.join('\n')).toContain('$0 for recorded usage');
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

  it('explains skipped legacy holds and keeps old refresh reply compatibility', async () => {
    const h = harness({ refresh: async () => ({ checked: 0, updated: 0,
      diagnostics: { sourceState: 'ready', legacyUnboundCount: 4, legacyUnboundAcu: 40 } }) });
    expect(await runDevinCli(['refresh'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Skipped 4 legacy launches: 40 ACUs held; original account evidence is missing.');
    const old = harness(); expect(await runDevinCli(['refresh'], old.deps)).toBe(0);
    expect(old.out).toEqual(['Checked 2 Devin task(s); 1 changed.']);
  });

  it('reports unknown refresh/task-budget evidence without zero or available capacity', async () => {
    const h = harness({ refresh: async () => ({ checked: 0, updated: 0,
      diagnostics: { sourceState: 'unavailable', legacyUnboundCount: null, legacyUnboundAcu: null } }),
      taskInventory: () => ({ tasks: [], sourceState: 'unavailable' }),
      budgetView: (tasks, budget, now, sourceState) => devinBudgetView(tasks, budget, now, sourceState) });
    expect(await runDevinCli(['refresh'], h.deps)).toBe(0);
    expect(await runDevinCli(['budget'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Task evidence is unavailable');
    expect(h.out.join('\n')).toContain('local budget capacity is unknown');
    expect(h.out.join('\n')).not.toContain('ACUs left');
  });

  it('unknown verbs are usage errors', async () => {
    const h = harness();
    expect(await runDevinCli(['merge'], h.deps)).toBe(2);
  });

  it.each([
    ['--max-concurrent', 'maxConcurrent'], ['--max-per-day', 'maxSessionsPerDay'],
    ['--fleet-concurrent', 'fleetMaxConcurrent'], ['--fleet-per-day', 'fleetMaxSessionsPerDay'],
  ] as const)('%s accepts safe counts without a product ceiling and rejects malformed counts before updates', async (flag, field) => {
    const h = harness();
    for (const count of [64, 999, 1_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(await runDevinCli(['budget', flag, String(count)], h.deps)).toBe(0);
      expect(h.updates.at(-1)).toEqual({ [field]: count });
    }
    const before = h.updates.length;
    for (const invalid of ['-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1), 'NaN', 'Infinity', 'nope']) {
      expect(await runDevinCli(['budget', flag, invalid], h.deps)).toBe(2);
    }
    expect(h.updates).toHaveLength(before);
  });
});
