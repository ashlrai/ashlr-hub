/**
 * `ashlr authority setup` — the machine-readable checklist and resumability.
 *
 *   - `--dry-run --json` prints one JSON document (schema, steps with stable
 *     ids and what each needs from Mason, next step) and runs nothing
 *   - `--json` without `--dry-run` is refused (a real run asks questions)
 *   - the trust-root step can be rerun: an open PR, a key already merged on the
 *     base branch, or a branch pushed by an earlier run are recognised instead
 *     of failing on the leftover local branch; a git failure is a failed step
 *     with a summary, not an abort
 *   - an already-active grant still gets the autonomy switch offered
 *   - the last step reads (never changes) the daemon service and says exactly
 *     how to start it
 *
 * Every external effect is injected (gh/git fake, custody fake, daemon
 * service fake). HOME-isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trust = vi.hoisted(() => ({ roots: [] as unknown[] }));
vi.mock('../src/core/authority/trust-roots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/trust-roots.js')>();
  return {
    ...actual,
    get STANDING_GRANT_TRUST_ROOTS() {
      return trust.roots;
    },
  };
});

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

const standing = vi.hoisted(() => ({
  grantActive: false,
  switch: 'off' as 'off' | 'propose' | 'autonomous',
  switchRequests: [] as string[],
}));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/effective-config.js')>();
  return {
    ...actual,
    evaluateStandingAuthority: () => ({
      grantState: standing.grantActive ? 'active' : 'none',
      grant: standing.grantActive ? { grantSeq: 3 } : null,
      switch: standing.switch,
    }),
    requestAutonomySwitch: (to: string) => {
      standing.switchRequests.push(to);
      return { ok: true };
    },
  };
});

import { runAuthorityCli, type AuthorityCliDeps, type AuthoritySetupReportV1, type DaemonServiceState, type GhResult } from '../src/cli/authority.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

let restore: () => void;

beforeEach(() => {
  ({ restore } = withTempHome('setup-resume-'));
  trust.roots = [];
  standing.grantActive = false;
  standing.switch = 'off';
  standing.switchRequests = [];
});

afterEach(() => {
  restore();
});

type Call = { bin: string; args: readonly string[] };

function harness(opts: {
  confirm?: boolean | ((question: string) => boolean);
  installed?: boolean;
  custodyExtras?: { githubApp?: boolean; claudeToken?: boolean };
  run?: (bin: string, args: readonly string[]) => GhResult;
  service?: DaemonServiceState;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const installed = opts.installed ?? true;
  const custody = {
    custodyStatus: async () => ({
      installed,
      version: installed ? '1.0' : null,
      keyInitialized: installed ? true : null,
      keyId: installed ? TEST_ROOT.keyId : null,
      githubApp: opts.custodyExtras?.githubApp ?? false,
      claudeToken: opts.custodyExtras?.claudeToken ?? false,
      checkedAt: new Date().toISOString(),
      reasons: [],
    }),
    custodyHostBinding: async () => 'a'.repeat(64),
    custodyPublicKey: vi.fn(async () => ({ keyId: TEST_ROOT.keyId, publicKeyPem: TEST_ROOT.publicKeyPem })),
    custodyInit: vi.fn(async () => { throw new Error('custodyInit must not run'); }),
    signGrant: vi.fn(async () => { throw new Error('signGrant must not run'); }),
    storeGithubApp: vi.fn(async () => undefined),
    storeClaudeToken: vi.fn(async () => undefined),
    keyIdForPublicKeyPem,
  } as unknown as AuthorityCliDeps['custody'];
  const daemonService = vi.fn(async () => opts.service ?? 'not-loaded');
  const deps: Partial<AuthorityCliDeps> = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: async (question) => (typeof opts.confirm === 'function' ? opts.confirm(question) : opts.confirm ?? false),
    readSecret: async () => '',
    run: (bin, args) => {
      calls.push({ bin, args });
      return opts.run ? opts.run(bin, args) : { status: 1, stdout: '', stderr: 'offline' };
    },
    openBrowser: () => { throw new Error('no browser in tests'); },
    fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
    custody,
    daemonService,
  };
  return { deps, out, err, calls, daemonService };
}

const ok = (stdout = ''): GhResult => ({ status: 0, stdout, stderr: '' });
const no = (stderr = 'nope'): GhResult => ({ status: 1, stdout: '', stderr });

describe('setup --dry-run --json', () => {
  it('prints one JSON checklist on a fresh Mac and runs nothing', async () => {
    const h = harness({ installed: false });
    expect(await runAuthorityCli(['setup', '--dry-run', '--json'], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    const report = JSON.parse(h.out[0]!) as AuthoritySetupReportV1;
    expect(report.schema).toBe('ashlr.authority-setup.v1');
    expect(report.dryRun).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.next).toBe('custody-helper');
    expect(report.steps.map((s) => s.id)).toEqual([
      'custody-helper', 'host-binding', 'signing-key', 'trust-root', 'deploy', 'github-app', 'claude-token',
      'canary-repo', 'rulesets', 'old-activation-state', 'provenance-key', 'standing-grant', 'autonomy-switch', 'daemon-service',
    ]);
    expect(report.steps[0]).toMatchObject({ status: 'waiting-on-you', needs: ['sudo', 'terminal'] });
    expect(report.steps.find((s) => s.id === 'signing-key')?.needs).toEqual(['touch-id']);
    expect(report.steps.find((s) => s.id === 'github-app')?.needs).toEqual(['browser', 'github']);
    expect(report.summary).toEqual({ done: 0, already: 1, waitingOnYou: 1, failed: 0, planned: 12 });
    expect(h.calls).toEqual([]);
    expect(h.daemonService).not.toHaveBeenCalled();
  });

  it('is refused without --dry-run', async () => {
    const h = harness();
    expect(await runAuthorityCli(['setup', '--json'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/--json needs --dry-run/);
    expect(h.calls).toEqual([]);
  });

  it('with a trusted key walks every step and reports the daemon service it read', async () => {
    trust.roots = [TEST_ROOT];
    const h = harness({ service: 'not-loaded' });
    expect(await runAuthorityCli(['setup', '--dry-run', '--json'], h.deps)).toBe(0);
    const report = JSON.parse(h.out[0]!) as AuthoritySetupReportV1;
    const byId = new Map(report.steps.map((s) => [s.id, s]));
    expect(byId.get('trust-root')?.status).toBe('already');
    expect(byId.get('deploy')?.status).toBe('already');
    expect(byId.get('autonomy-switch')).toMatchObject({ status: 'skipped', detail: 'needs an active standing grant first' });
    expect(byId.get('daemon-service')?.status).toBe('waiting-on-you');
    expect(byId.get('daemon-service')?.detail).toContain('launchctl enable gui/$(id -u)/ai.ashlr.daemon && launchctl bootstrap');
    expect(report.next).toBe('github-app');
    expect(h.daemonService).toHaveBeenCalledTimes(1);
    // Read-only probes only: the canary existence check.
    expect(h.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['api repos/ashlrai/fleet-canary']);
  });
});

describe('setup is resumable', () => {
  it('a running daemon and an active grant with the switch already Autonomous are all in place', async () => {
    trust.roots = [TEST_ROOT];
    standing.grantActive = true;
    standing.switch = 'autonomous';
    const h = harness({ service: 'running' });
    expect(await runAuthorityCli(['setup', '--dry-run'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✓ standing grant: grant #3 is active$/m);
    expect(text).toMatch(/^✓ autonomy switch: Autonomous$/m);
    expect(text).toMatch(/^✓ daemon service: ai\.ashlr\.daemon is running/m);
  });

  it('an active grant from an earlier run still gets the switch offered (capped by the grant)', async () => {
    trust.roots = [TEST_ROOT];
    standing.grantActive = true;
    standing.switch = 'propose';
    const declined = harness();
    expect(await runAuthorityCli(['setup'], declined.deps)).toBe(0);
    expect(declined.out.join('\n')).toMatch(/… autonomy switch: it is propose — run `ashlr authority switch autonomous`/);
    expect(standing.switchRequests).toEqual([]);

    // Yes to the switch only: every other step stays untouched.
    const accepted = harness({ confirm: (q) => /autonomy switch/.test(q) });
    expect(await runAuthorityCli(['setup'], accepted.deps)).toBe(0);
    expect(standing.switchRequests).toEqual(['autonomous']);
    expect(accepted.out.join('\n')).toMatch(/✓ autonomy switch: Autonomous/);
  });

  it('finds the trust-root PR an earlier run opened instead of opening another', async () => {
    const h = harness({
      confirm: true,
      run: (_bin, args) => (args[0] === 'pr' && args[1] === 'list' ? ok('https://github.com/ashlrai/ashlr-hub/pull/999\n') : no()),
    });
    expect(await runAuthorityCli(['setup', '--source', '/nonexistent/checkout'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/… trust root: https:\/\/github\.com\/ashlrai\/ashlr-hub\/pull\/999 is already open/);
    expect(h.calls.some((c) => c.args.includes('worktree'))).toBe(false);
  });

  it('recognises a key already merged on the base branch as waiting for deploy', async () => {
    const h = harness({
      confirm: true,
      run: (_bin, args) => {
        if (args[0] === 'pr') return ok('');
        if (args[0] === 'repo') return ok('master\n');
        if (args.includes('fetch')) return ok();
        if (args.includes('show')) return ok(`export const STANDING_GRANT_TRUST_ROOTS = Object.freeze([{ keyId: '${TEST_ROOT.keyId}' }]);`);
        return no();
      },
    });
    expect(await runAuthorityCli(['setup', '--source', '/nonexistent/checkout'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(new RegExp(`… trust root: ${TEST_ROOT.keyId} is already on master`));
    expect(text).toMatch(/… deploy: after you merge that PR/);
    expect(h.calls.some((c) => c.args.includes('worktree'))).toBe(false);
  });

  it('opens the PR from a branch an earlier run pushed', async () => {
    const h = harness({
      confirm: true,
      run: (_bin, args) => {
        if (args[0] === 'pr' && args[1] === 'list') return ok('');
        if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/ashlrai/ashlr-hub/pull/1000\n');
        if (args[0] === 'repo') return ok('master\n');
        if (args.includes('fetch')) return ok();
        if (args.includes('show')) return ok("Object.freeze([]);");
        if (args.includes('ls-remote')) return ok('abc123\trefs/heads/authority/trust-root-x\n');
        return no();
      },
    });
    await runAuthorityCli(['setup', '--source', '/nonexistent/checkout'], h.deps);
    expect(h.out.join('\n')).toMatch(/… trust root: opened https:\/\/github\.com\/ashlrai\/ashlr-hub\/pull\/1000/);
    expect(h.calls.some((c) => c.args.includes('worktree'))).toBe(false);
  });

  it('resets a leftover local branch (-B), deletes it afterwards, and a git failure ends with a summary', async () => {
    const h = harness({
      confirm: true,
      run: (_bin, args) => {
        if (args[0] === 'pr') return ok('');
        if (args[0] === 'repo') return ok('master\n');
        if (args.includes('fetch')) return ok();
        if (args.includes('show')) return ok('Object.freeze([]);');
        if (args.includes('ls-remote')) return no('');
        if (args.includes('add') && args.includes('worktree')) return ok(); // no files appear: the read below fails
        return ok();
      },
    });
    expect(await runAuthorityCli(['setup', '--source', '/nonexistent/checkout'], h.deps)).toBe(1);
    const add = h.calls.find((c) => c.args.includes('worktree') && c.args.includes('add'));
    expect(add?.args).toContain('-B');
    expect(h.calls.some((c) => c.args.includes('branch') && c.args.includes('-D'))).toBe(true);
    const text = h.out.join('\n');
    expect(text).toMatch(/✗ trust root: /);
    expect(text).toMatch(/Setup: .* 1 failed\./);
  });
});
