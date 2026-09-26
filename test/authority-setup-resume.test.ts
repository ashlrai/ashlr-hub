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
 *   - a read-only service observation cannot make resident activation complete:
 *     the resident step also needs the admission verdict (grant, clean build)
 *     and a plist matching config (docs/RESIDENT-RUNTIME.md)
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

// Setup only reaches the draft when Mason says yes to signing; these tests
// never sign, so the draft is a stand-in that fails the way a real one can.
const drafting = vi.hoisted(() => ({ fail: null as string | null }));
vi.mock('../src/core/verse/authority-api.js', () => ({
  buildStandingGrantDraft: async () => {
    throw new Error(drafting.fail ?? 'no grant draft in these tests');
  },
}));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  authoritySetupReport,
  buildFleetRuleset,
  FLEET_APP_INSTALL_URL,
  FLEET_RULESET_NAME,
  isReadOnlyGhApiCall,
  planAuthoritySetup,
  readOnlyGhRun,
  rulesetMatches,
  runAuthorityCli,
  type AuthorityCliDeps,
  type AuthoritySetupReportV1,
  type DaemonServiceState,
  type GhResult,
} from '../src/cli/authority.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

let restore: () => void;
let home: string;

beforeEach(() => {
  ({ restore, home } = withTempHome('setup-resume-'));
  trust.roots = [];
  standing.grantActive = false;
  standing.switch = 'off';
  standing.switchRequests = [];
  drafting.fail = null;
});

afterEach(() => {
  restore();
});

type Call = { bin: string; args: readonly string[] };

function harness(opts: {
  confirm?: boolean | ((question: string) => boolean);
  installed?: boolean;
  custodyExtras?: { githubApp?: boolean; claudeToken?: boolean };
  run?: (bin: string, args: readonly string[], input?: string) => GhResult;
  service?: DaemonServiceState;
  /** custody gh-token: resolve (installed) or reject with this error. */
  githubToken?: (repo: string) => Promise<unknown>;
  readSecret?: () => Promise<string>;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: (Call & { input?: string })[] = [];
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
    githubToken: vi.fn(opts.githubToken ?? (async () => { throw new Error('githubToken must not run'); })),
    keyIdForPublicKeyPem,
  } as unknown as AuthorityCliDeps['custody'];
  const daemonService = vi.fn(async () => opts.service ?? 'not-loaded');
  // A source (tsx) run is never a compiled release, so the real verdict would
  // be `not-compiled-release`; the fake says so explicitly.
  const resident: AuthorityCliDeps['resident'] = {
    admission: async () => ({
      ok: false, code: 'not-compiled-release', status: 'blocked', command: null,
      reason: 'this ashlr is not a compiled release', grantId: null, grantSeq: null, expiresAt: null, revision: null, packageRoot: null,
    }),
    observe: async () => { throw new Error('observe must not run without an admission'); },
    operatorRefusal: async () => 'not an operator in tests',
    start: async () => { throw new Error('start must not run'); },
    stop: async () => { throw new Error('stop must not run'); },
  };
  const deps: Partial<AuthorityCliDeps> = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: async (question) => (typeof opts.confirm === 'function' ? opts.confirm(question) : opts.confirm ?? false),
    readSecret: opts.readSecret ?? (async () => ''),
    run: (bin, args, runOpts) => {
      calls.push({ bin, args, ...(runOpts?.input !== undefined ? { input: runOpts.input } : {}) });
      return opts.run ? opts.run(bin, args, runOpts?.input) : { status: 1, stdout: '', stderr: 'offline' };
    },
    openBrowser: () => { throw new Error('no browser in tests'); },
    fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
    custody,
    daemonService,
    resident,
  };
  return { deps, out, err, calls, daemonService, custody };
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
      'canary-repo', 'rulesets', 'old-activation-state', 'provenance-key', 'standing-grant', 'autonomy-switch', 'daemon-service', 'resident-runtime',
    ]);
    expect(report.steps[0]).toMatchObject({ status: 'waiting-on-you', needs: ['sudo', 'terminal'] });
    expect(report.steps.find((s) => s.id === 'signing-key')?.needs).toEqual(['touch-id']);
    expect(report.steps.find((s) => s.id === 'github-app')?.needs).toEqual(['browser', 'github']);
    expect(report.steps.at(-1)).toMatchObject({ status: 'blocked', needs: ['terminal'] });
    expect(report.steps.at(-1)?.detail).toMatch(/blocked until a grant is active/);
    expect(report.summary).toEqual({ done: 0, already: 1, waitingOnYou: 1, blocked: 1, failed: 0, planned: 12 });
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
    expect(byId.get('daemon-service')?.detail).toContain('after the standing grant, run `ashlr authority resident start`');
    expect(byId.get('resident-runtime')).toMatchObject({ status: 'blocked', needs: ['terminal'] });
    expect(report.next).toBe('github-app');
    expect(h.daemonService).toHaveBeenCalledTimes(1);
    // Read-only probes only: the canary existence check.
    expect(h.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['api repos/ashlrai/fleet-canary']);
  });

  it('3.13: an existing App without checks:write waits on you, with the exact settings links', async () => {
    trust.roots = [TEST_ROOT];
    const app = (checks: string) => ok(JSON.stringify({ id: 424242, slug: 'ashlr-fleet', owner: { login: 'ashlrai', type: 'Organization' }, permissions: { checks } }));
    const readOnly = harness({ custodyExtras: { githubApp: true }, run: (_bin, args) => (args[1] === 'apps/ashlr-fleet' ? app('read') : no()) });
    expect(await runAuthorityCli(['setup', '--dry-run', '--json'], readOnly.deps)).toBe(0);
    const step = (JSON.parse(readOnly.out[0]!) as AuthoritySetupReportV1).steps.find((s) => s.id === 'github-app')!;
    expect(step.status).toBe('waiting-on-you');
    expect(step.detail).toContain('https://github.com/organizations/ashlrai/settings/apps/ashlr-fleet/permissions');
    expect(step.detail).toContain('https://github.com/organizations/ashlrai/settings/installations');
    expect(step.detail).toMatch(/Checks: Read and write/);

    const writable = harness({ custodyExtras: { githubApp: true }, run: (_bin, args) => (args[1] === 'apps/ashlr-fleet' ? app('write') : no()) });
    expect(await runAuthorityCli(['setup', '--dry-run', '--json'], writable.deps)).toBe(0);
    expect((JSON.parse(writable.out[0]!) as AuthoritySetupReportV1).steps.find((s) => s.id === 'github-app'))
      .toMatchObject({ status: 'already', detail: expect.stringMatching(/checks: write/) });
  });
});

describe('setup is resumable', () => {
  it('reports the resident block exactly once when live setup stops at the missing helper', async () => {
    const h = harness({ installed: false, confirm: true });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/… custody helper: run `sudo scripts\/install-custody\.sh`/);
    expect(text.match(/^× resident runtime:/gm)).toHaveLength(1);
    expect(text).toMatch(/1 blocked on a prerequisite/);
    expect(text).not.toMatch(/signing key:|GitHub App:|standing grant:/);
    expect(h.calls).toEqual([]);
    expect(h.daemonService).not.toHaveBeenCalled();
  });

  it('a running daemon and an active grant still need the resident admission (a source run is blocked)', async () => {
    trust.roots = [TEST_ROOT];
    standing.grantActive = true;
    standing.switch = 'autonomous';
    const h = harness({ service: 'running' });
    expect(await runAuthorityCli(['setup', '--dry-run'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✓ standing grant: grant #3 is active$/m);
    expect(text).toMatch(/^✓ autonomy switch: Autonomous$/m);
    expect(text).toMatch(/^✓ daemon service: ai\.ashlr\.daemon is running/m);
    expect(text).toMatch(/^× resident runtime: this ashlr is not a compiled release/m);
  });

  it('never reports setup complete merely because every preparatory step is ready', () => {
    const ready = ['custody helper', 'host binding', 'signing key', 'trust root', 'deploy', 'GitHub App',
      'Claude token', 'canary repo', 'rulesets', 'old activation state', 'provenance key',
      'standing grant', 'autonomy switch', 'daemon service']
      .map((step) => ({ step, status: 'already' as const, detail: 'verified' }));
    const report = authoritySetupReport([...ready, {
      step: 'resident runtime', status: 'blocked' as const,
      detail: 'blocked until a grant is active',
    }], true);
    expect(report.complete).toBe(false);
    expect(report.next).toBe('resident-runtime');
    expect(report.summary).toMatchObject({ already: ready.length, blocked: 1, waitingOnYou: 0 });
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

// ---------------------------------------------------------------------------
// Rerun safety: Mason runs setup several times; nothing already in place is
// done again, and a step that fails is a failed row, never an abort.
// ---------------------------------------------------------------------------

const CANARY = 'ashlrai/fleet-canary';

/** What GitHub returns for a ruleset we applied: our fields plus its own ids, links and rule defaults. */
function asGitHubReturns(ruleset: Record<string, unknown>): Record<string, unknown> {
  const rules = (ruleset['rules'] as { type: string; parameters?: Record<string, unknown> }[]).map((rule) => (
    rule.type === 'pull_request'
      ? { ...rule, parameters: { ...rule.parameters, allowed_merge_methods: ['merge', 'squash', 'rebase'], automatic_copilot_code_review_enabled: false } }
      : rule
  ));
  return {
    id: 7,
    source_type: 'Repository',
    source: CANARY,
    node_id: 'RRS_x',
    current_user_can_bypass: 'always',
    _links: { self: { href: `https://api.github.com/repos/${CANARY}/rulesets/7` } },
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
    ...ruleset,
    // GitHub hands arrays back in its own order.
    bypass_actors: [...(ruleset['bypass_actors'] as unknown[])].reverse(),
    rules: [...rules].reverse(),
  };
}

const CANARY_CHECKS = [{ context: 'test', integrationId: 15368 }];

/** A small GitHub: the canary, its ruleset, the org's App installations. Writes answer ok and are only recorded. */
function fakeGitHub(state: {
  canary?: boolean;
  ruleset?: Record<string, unknown> | null;
  installations?: { app_slug: string; repository_selection: 'all' | 'selected' }[] | null;
  /** The App's checks permission as GitHub reports it (3.13 needs 'write'). */
  appChecks?: 'write' | 'read';
} = {}) {
  return (bin: string, args: readonly string[]): GhResult => {
    if (bin !== 'gh' || args[0] !== 'api') return no('unexpected command');
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    if (method !== 'GET') return ok('{}');
    const path = args[1]!;
    if (path === 'apps/ashlr-fleet') {
      return ok(JSON.stringify({ id: 4242, slug: 'ashlr-fleet', owner: { login: 'ashlrai', type: 'Organization' }, permissions: { checks: state.appChecks ?? 'write' } }));
    }
    if (path === `repos/${CANARY}`) return state.canary === false ? no('HTTP 404: Not Found') : ok(JSON.stringify({ default_branch: 'main', private: false }));
    if (path.startsWith(`repos/${CANARY}/commits/main/check-runs`)) return ok(JSON.stringify({ check_runs: [{ name: 'test', app: { id: 15368 } }] }));
    if (path === `repos/${CANARY}/rulesets`) return ok(JSON.stringify(state.ruleset ? [{ id: 7, name: FLEET_RULESET_NAME }] : []));
    if (path === `repos/${CANARY}/rulesets/7`) return state.ruleset ? ok(JSON.stringify(state.ruleset)) : no('HTTP 404');
    if (path.startsWith('orgs/ashlrai/installations')) {
      if (state.installations === null) return no('HTTP 403: Must have admin rights');
      const installations = state.installations ?? [{ app_slug: 'ashlr-fleet', repository_selection: 'all' }];
      return ok(JSON.stringify({ total_count: installations.length, installations }));
    }
    return no(`unexpected path ${path}`);
  };
}

/** Everything before the step under test is already in place (trusted key, grant active, switch autonomous). */
function readyHarness(opts: Parameters<typeof harness>[0] = {}) {
  trust.roots = [TEST_ROOT];
  standing.grantActive = true;
  standing.switch = 'autonomous';
  return harness({
    custodyExtras: { githubApp: true, claudeToken: true },
    run: fakeGitHub({ ruleset: asGitHubReturns(buildFleetRuleset(CANARY_CHECKS)) }),
    ...opts,
  });
}

const writes = (calls: readonly Call[]): Call[] => calls.filter((c) => c.args.includes('--method') || c.args[0] === 'repo' || c.args[0] === 'pr' || c.bin === 'git');

async function dryRunReport(h: ReturnType<typeof harness>): Promise<AuthoritySetupReportV1> {
  h.out.length = 0;
  await runAuthorityCli(['setup', '--dry-run', '--json'], h.deps);
  return JSON.parse(h.out.join('\n')) as AuthoritySetupReportV1;
}

describe('setup is rerun-safe: the provenance key', () => {
  const keyPath = (): string => join(home, '.ashlr', 'foundry', 'provenance.key');

  it('rotates the burned key once; every rerun (even with --yes) leaves the rotated key alone', async () => {
    const { loadOrCreateKey } = await import('../src/core/foundry/provenance.js');
    const burned = Buffer.from(loadOrCreateKey()); // the key agents could read
    const h = readyHarness();
    expect(await runAuthorityCli(['setup', '--yes'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^✓ provenance key: rotated; the old key was moved aside$/m);
    const rotated = readFileSync(keyPath());
    expect(rotated.equals(burned)).toBe(false);

    for (let run = 0; run < 2; run += 1) {
      h.out.length = 0;
      expect(await runAuthorityCli(['setup', '--yes'], h.deps)).toBe(0);
      expect(h.out.join('\n')).toMatch(/^✓ provenance key: rotated \d{4}-\d{2}-\d{2}; not rotated again, so pending proposals keep verifying$/m);
      expect(readFileSync(keyPath()).equals(rotated)).toBe(true);
    }
    const report = await dryRunReport(h);
    expect(report.steps.find((s) => s.id === 'provenance-key')).toMatchObject({ status: 'already', command: null });
  });

  it('an explicit rotate-provenance is recorded too, and a key swapped in afterwards is not "already rotated"', async () => {
    const h = readyHarness();
    expect(await runAuthorityCli(['rotate-provenance', '--yes'], h.deps)).toBe(0);
    expect((await dryRunReport(h)).steps.find((s) => s.id === 'provenance-key')?.status).toBe('already');
    // Same file, other bytes: the record names the key it made, so this one is not trusted as rotated.
    writeFileSync(keyPath(), Buffer.alloc(32, 7));
    const step = (await dryRunReport(h)).steps.find((s) => s.id === 'provenance-key');
    expect(step).toMatchObject({ status: 'skipped', command: 'ashlr authority setup' });
    expect(step?.detail).toMatch(/rotate-provenance/);
  });

  it('a Mac with no key yet gets one created (and recorded) — nothing was burned', async () => {
    const h = readyHarness({ confirm: (q) => /provenance/.test(q) });
    expect(existsSync(keyPath())).toBe(false);
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^✓ provenance key: created$/m);
    expect((await dryRunReport(h)).steps.find((s) => s.id === 'provenance-key')?.status).toBe('already');
  });
});

describe('setup is rerun-safe: rulesets', () => {
  it('a ruleset GitHub already holds with identical content is reported in place and never re-applied', async () => {
    const h = readyHarness({ confirm: true });
    expect(await runAuthorityCli(['setup', '--yes'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^✓ rulesets: the fleet ruleset is in place on 1 repo$/m);
    expect(writes(h.calls)).toEqual([]);
    // protect --apply agrees: nothing to do.
    h.out.length = 0;
    expect(await runAuthorityCli(['protect', '--apply', '--yes'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/ruleset 7 already up to date/);
    expect(writes(h.calls)).toEqual([]);
  });

  it('a drifted ruleset (an extra bypass actor) is re-applied — to that repo only, with a PUT', async () => {
    const drifted = asGitHubReturns(buildFleetRuleset(CANARY_CHECKS));
    drifted['bypass_actors'] = [...(drifted['bypass_actors'] as unknown[]), { actor_id: 99, actor_type: 'Integration', bypass_mode: 'always' }];
    const h = readyHarness({ confirm: (q) => /ruleset/.test(q), run: fakeGitHub({ ruleset: drifted }) });
    const plan = await dryRunReport(h);
    expect(plan.steps.find((s) => s.id === 'rulesets')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/^1 repo\(s\) need the fleet ruleset \(ashlrai\/fleet-canary\)/) });
    expect(writes(h.calls)).toEqual([]);
    h.out.length = 0;
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    const put = writes(h.calls);
    expect(put).toHaveLength(1);
    expect(put[0]!.args).toEqual(['api', '--method', 'PUT', `repos/${CANARY}/rulesets/7`, '--input', '-']);
    expect(h.out.join('\n')).toMatch(/^✓ rulesets: applied to ashlrai\/fleet-canary$/m);
  });

  it('rulesetMatches: GitHub decorations and order are fine; any field we set, or an extra array entry, is drift', () => {
    const desired = buildFleetRuleset([{ context: 'test', integrationId: 15368 }, { context: 'lint', integrationId: null }]);
    expect(rulesetMatches(desired, asGitHubReturns(desired))).toBe(true);
    expect(rulesetMatches(desired, { ...asGitHubReturns(desired), enforcement: 'evaluate' })).toBe(false);
    expect(rulesetMatches(desired, asGitHubReturns(buildFleetRuleset([{ context: 'test', integrationId: 15368 }])))).toBe(false);
    expect(rulesetMatches(desired, asGitHubReturns(buildFleetRuleset([{ context: 'test', integrationId: 15368 }, { context: 'lint', integrationId: null }, { context: 'e2e', integrationId: null }])))).toBe(false);
    const extraRule = asGitHubReturns(desired);
    extraRule['rules'] = [...(extraRule['rules'] as unknown[]), { type: 'creation' }];
    expect(rulesetMatches(desired, extraRule)).toBe(false);
    expect(rulesetMatches(desired, null)).toBe(false);
    expect(rulesetMatches(desired, [])).toBe(false);
  });
});

describe('setup: the GitHub App is installed, not just stored', () => {
  it('an App installed on all of the org’s repositories is in place', async () => {
    const h = readyHarness();
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^✓ GitHub App: the ashlr-fleet key is in custody; installed on ashlrai\/fleet-canary; the App can post ashlr\/verify \(checks: write\)$/m);
    expect(h.custody.githubToken).not.toHaveBeenCalled();
  });

  it('installed, but a pre-3.13 App (checks: read) still waits on Mason — with the permissions page as its link', async () => {
    const h = readyHarness({ run: fakeGitHub({ ruleset: asGitHubReturns(buildFleetRuleset(CANARY_CHECKS)), appChecks: 'read' }) });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^… GitHub App: the ashlr-fleet key is in custody and the App is installed on ashlrai\/fleet-canary, but it cannot post the ashlr\/verify check \(Checks: read\)/m);
    const step = (await dryRunReport(h)).steps.find((s) => s.id === 'github-app');
    expect(step).toMatchObject({ status: 'waiting-on-you', link: 'https://github.com/organizations/ashlrai/settings/apps/ashlr-fleet/permissions' });
  });

  it('a stored key with no installation waits on Mason with the install page', async () => {
    const h = readyHarness({ run: fakeGitHub({ ruleset: asGitHubReturns(buildFleetRuleset(CANARY_CHECKS)), installations: [{ app_slug: 'vercel', repository_selection: 'all' }] }) });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(`… GitHub App: the ashlr-fleet key is in custody, but the App is not installed on ashlrai/fleet-canary — install it: ${FLEET_APP_INSTALL_URL}, then rerun setup`);
    const step = (await dryRunReport(h)).steps.find((s) => s.id === 'github-app');
    expect(step).toMatchObject({ status: 'waiting-on-you', link: FLEET_APP_INSTALL_URL, needs: ['browser', 'github'] });
    expect(h.custody.githubToken).not.toHaveBeenCalled();
  });

  it('what gh cannot settle is asked of the App itself (custody gh-token): a 404 lookup is "not installed"', async () => {
    const notInstalled = Object.assign(new Error('the ashlr-fleet App is not installed on ashlrai/fleet-canary'), { code: 'github' });
    const h = readyHarness({
      run: fakeGitHub({ ruleset: asGitHubReturns(buildFleetRuleset(CANARY_CHECKS)), installations: null }),
      githubToken: async () => { throw notInstalled; },
    });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/^… GitHub App: .*not installed on ashlrai\/fleet-canary — install it/m);
    expect(h.custody.githubToken).toHaveBeenCalledWith(CANARY);
  });

  it('"Only select repositories": the App’s own lookup confirms the repo, and an unanswerable one is never counted as installed', async () => {
    const selected = fakeGitHub({ ruleset: asGitHubReturns(buildFleetRuleset(CANARY_CHECKS)), installations: [{ app_slug: 'ashlr-fleet', repository_selection: 'selected' }] });
    const yes = readyHarness({ run: selected, githubToken: async () => ({ token: 'ghs_x', expiresAt: null }) });
    expect(await runAuthorityCli(['setup'], yes.deps)).toBe(0);
    expect(yes.out.join('\n')).toMatch(/^✓ GitHub App: .*installed on ashlrai\/fleet-canary; the App can post ashlr\/verify \(checks: write\)$/m);

    const offline = readyHarness({ run: selected, githubToken: async () => { throw Object.assign(new Error('network down'), { code: 'network' }); } });
    expect(await runAuthorityCli(['setup'], offline.deps)).toBe(0);
    expect(offline.out.join('\n')).toMatch(/^… GitHub App: .*could not be confirmed \(network down\)/m);
  });

  it('a canary that does not exist yet is left out of the check (and said so)', async () => {
    const h = readyHarness({ run: fakeGitHub({ canary: false }) });
    await runAuthorityCli(['setup'], h.deps);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✓ GitHub App: .*no enrolled repo needs it yet \(ashlrai\/fleet-canary needs it too once it exists\); the App can post ashlr\/verify \(checks: write\)$/m);
    expect(text).toMatch(/^… canary repo: create ashlrai\/fleet-canary/m);
    // Nothing to protect yet is not "in place on 0 repos".
    expect(text).toMatch(/^… rulesets: ashlrai\/fleet-canary gets the fleet ruleset once it exists$/m);
  });
});

describe('setup: a failing step is recorded, and the run still ends with its summary', () => {
  it('the GitHub App flow', async () => {
    const h = readyHarness({ custodyExtras: { githubApp: false, claudeToken: true }, confirm: (q) => /GitHub App/.test(q) });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✗ GitHub App: not created \(no browser in tests\) — rerun setup, or run `ashlr authority github-app`$/m);
    expect(text).toMatch(/^✓ rulesets: /m); // later steps still ran
    expect(text).toMatch(/Setup: .* 1 failed\./);
    expect(h.err).toEqual([]);
  });

  it('the Claude token prompt', async () => {
    const h = readyHarness({
      custodyExtras: { githubApp: true, claudeToken: false },
      confirm: (q) => /Claude token/.test(q),
      readSecret: async () => { throw new Error('cancelled'); },
    });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✗ Claude token: not stored \(cancelled\) — run `claude setup-token`, then rerun setup$/m);
    expect(text).toMatch(/Setup: .* 1 failed\./);
    expect(h.custody.storeClaudeToken).not.toHaveBeenCalled();
  });

  it('building the grant draft', async () => {
    const h = readyHarness({ confirm: (q) => /standing grant/.test(q) });
    standing.grantActive = false;
    drafting.fail = 'The authority ledger is unavailable: locked';
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/^✗ standing grant: no grant was drafted \(The authority ledger is unavailable: locked\)/m);
    expect(text).toMatch(/^… autonomy switch: needs an active standing grant first$/m);
    expect(text).toMatch(/^× resident runtime:/m);
    expect(text).toMatch(/Setup: .* 1 failed\./);
    expect(h.custody.signGrant).not.toHaveBeenCalled();
  });
});

describe('the read-only checklist (Verse GET /api/verse/authority/setup)', () => {
  it('each open step names the command that moves it on; steps in place name none', async () => {
    const report = await dryRunReport(harness({ installed: false }));
    expect(report.steps[0]).toMatchObject({ id: 'custody-helper', command: 'sudo scripts/install-custody.sh', link: null });
    expect(report.steps.find((s) => s.id === 'old-activation-state')).toMatchObject({ status: 'already', command: null });
    expect(report.steps.find((s) => s.id === 'standing-grant')?.command).toBe('ashlr authority grant');
    // Before a grant, the resident step is unblocked by the grant.
    expect(report.steps.find((s) => s.id === 'resident-runtime')).toMatchObject({ status: 'blocked', command: 'ashlr authority grant' });
  });

  it('planAuthoritySetup is the dry run: same checklist, no prompt, only gh api reads', async () => {
    const h = readyHarness();
    const confirm = vi.fn(async () => true);
    const report = await planAuthoritySetup({ ...h.deps, confirm, out: () => { throw new Error('nothing is printed'); } });
    expect(report).toMatchObject({ schema: 'ashlr.authority-setup.v1', dryRun: true });
    expect(report.steps.map((s) => s.id)).toContain('rulesets');
    expect(report.steps.find((s) => s.id === 'github-app')?.status).toBe('already');
    expect(confirm).not.toHaveBeenCalled();
    expect(writes(h.calls)).toEqual([]);
    expect(h.calls.every((c) => c.bin === 'gh' && c.args[0] === 'api' && c.args.length === 2)).toBe(true);
  });

  it('its gh runner refuses anything but a `gh api <path>` read, without running it', async () => {
    for (const [bin, args] of [
      ['gh', ['api', '--method', 'PUT', `repos/${CANARY}/rulesets/7`]],
      ['gh', ['api', '-f', 'x=1']],
      ['gh', ['api', `repos/${CANARY}`, '--input', '-']],
      ['gh', ['repo', 'create', CANARY]],
      ['gh', ['pr', 'create']],
      ['git', ['push']],
      ['gh', ['api', '--paginate']],
    ] as const) {
      const result = await readOnlyGhRun(bin, args);
      expect(result, `${bin} ${args.join(' ')}`).toMatchObject({ status: 1, stderr: expect.stringMatching(/^refused/) });
    }
  });
});

describe('the dry run finds the trust-root PR through gh api reads (and so does Verse)', () => {
  const BRANCH = `authority/trust-root-${TEST_ROOT.keyId}`;
  const PR = 'https://github.com/ashlrai/ashlr-hub/pull/512';

  /** GitHub as seen through `gh api <path>` GETs only; anything else fails the test. */
  function hub(state: { open?: boolean; merged?: boolean; pushed?: boolean }) {
    return (bin: string, args: readonly string[]): GhResult => {
      expect(isReadOnlyGhApiCall(bin as 'gh', args), `${bin} ${args.join(' ')}`).toBe(true);
      const path = args[1]!;
      if (path.startsWith('repos/ashlrai/ashlr-hub/pulls?')) {
        expect(path).toContain(`head=ashlrai%3A${encodeURIComponent(BRANCH)}`);
        expect(path).toContain('state=open');
        return ok(JSON.stringify(state.open ? [{ html_url: PR }] : []));
      }
      if (path === 'repos/ashlrai/ashlr-hub') return ok(JSON.stringify({ default_branch: 'master' }));
      if (path === 'repos/ashlrai/ashlr-hub/contents/src/core/authority/trust-roots.ts?ref=master') {
        const source = state.merged ? `Object.freeze([Object.freeze({ keyId: '${TEST_ROOT.keyId}' })]);` : 'Object.freeze([]);';
        return ok(JSON.stringify({ encoding: 'base64', content: Buffer.from(source).toString('base64') }));
      }
      if (path === `repos/ashlrai/ashlr-hub/git/ref/heads/${BRANCH}`) {
        return state.pushed ? ok(JSON.stringify({ ref: `refs/heads/${BRANCH}`, object: { sha: 'abc' } })) : no('HTTP 404');
      }
      return no('HTTP 404');
    };
  }

  const trustRoot = async (state: Parameters<typeof hub>[0]) => {
    const h = harness({ run: hub(state) });
    const report = await dryRunReport(h);
    return { step: report.steps.find((s) => s.id === 'trust-root')!, h };
  };

  it('an open PR: waiting on your review, with its link', async () => {
    const { step, h } = await trustRoot({ open: true, merged: true, pushed: true });
    expect(step).toMatchObject({ status: 'waiting-on-you', detail: `${PR} is already open — review and merge it yourself`, link: PR, command: null });
    expect(writes(h.calls)).toEqual([]);
    // The human dry run says the same.
    h.out.length = 0;
    await runAuthorityCli(['setup', '--dry-run'], h.deps);
    expect(h.out.join('\n')).toContain(`… trust root: ${PR} is already open — review and merge it yourself`);
  });

  it('a key already merged: install a release built after it', async () => {
    const { step } = await trustRoot({ merged: true, pushed: true });
    expect(step).toMatchObject({
      status: 'waiting-on-you',
      detail: `${TEST_ROOT.keyId} is merged on master, but this release was built before it — install a release built after it`,
      command: 'npm run build',
      link: null,
    });
  });

  it('a pushed branch with no PR: rerun setup to open it', async () => {
    const { step } = await trustRoot({ pushed: true });
    expect(step).toMatchObject({ status: 'waiting-on-you', detail: `${BRANCH} was pushed by an earlier run but has no PR yet — rerun setup to open it`, command: 'ashlr authority setup' });
  });

  it('none of these (or GitHub unreadable): the step reads as before, and nothing but reads ran', async () => {
    const { step, h } = await trustRoot({});
    expect(step.status).toBe('waiting-on-you');
    expect(step.detail).toMatch(/^pass --source|^add this root yourself/);
    expect(h.calls.every((c) => isReadOnlyGhApiCall(c.bin as 'gh', c.args))).toBe(true);
    const offline = harness();
    expect((await dryRunReport(offline)).steps.find((s) => s.id === 'trust-root')?.detail).toMatch(/^pass --source|^add this root yourself/);
  });
});
