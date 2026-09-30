/**
 * 3.14 — private repos without rulesets use local enforcement with ashlr/verify.
 *
 * On GitHub Free a PRIVATE repo has neither rulesets nor classic branch
 * protection: every read answers 403 "Upgrade to GitHub Pro or make this
 * repository public to enable this feature." (verified live 2026-09-26). This
 * suite pins:
 *
 *   - the failure classifier (plan limit ≠ permission ≠ transient),
 *   - the enforcement probe and what a draft / re-approval does with it,
 *   - G7: a plan-gated `server` repo goes to the owner lane with a reason
 *     that says to re-approve (never weaker than before), a `local` one needs
 *     the App's ashlr/verify, and readRequiredChecks no longer calls a
 *     plan-gated read "unreadable" (which left PRs waiting forever) while any
 *     other 403 still is,
 *   - `protect` and `status` say precisely what is going on, and never change
 *     the signed grant.
 *
 * HOME-isolated; GitHub is always a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `status` builds its header from the Verse status (custody, ledger, …); only
// the enforcement lines are under test here, so that part is a fixed stand-in.
vi.mock('../src/core/verse/authority-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/verse/authority-api.js')>()),
  buildAuthorityStatus: async () => ({
    status: {
      effectiveSwitch: 'autonomous',
      switch: 'autonomous',
      kill: false,
      effectiveReason: null,
      grant: { state: 'active', grantSeq: 1, expiresAt: null, reason: null },
      rollout: null,
      policy: null,
      ledger: { state: 'ok', head: null, reason: null },
      custody: { installed: true, keyInitialized: true, githubApp: true, claudeToken: true },
    },
  }),
}));

import { readFileSync, writeFileSync } from 'node:fs';

// Loaded (mocked) at collection time: the CLI imports it lazily, and its module
// graph is large enough that a cold first import would eat a test's timeout.
import '../src/core/verse/authority-api.js';

import { runAuthorityCli, type AuthorityCliDeps, type GhResult } from '../src/cli/authority.js';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { ensureAuthorityDir } from '../src/core/authority/ledger.js';
import {
  classifyGithubReadFailure,
  countRequiredChecks,
  defaultGithubGet,
  draftEnforcementFor,
  enforcementMismatch,
  probeServerEnforcement,
  reapprovalDowngrades,
  type ServerEnforcementProbe,
} from '../src/core/authority/server-enforcement.js';
import { buildReapprovalGrantPayload, installedGrantPath, parseStandingGrantPayload } from '../src/core/authority/standing-grant.js';
import type { StandingGrantV1 } from '../src/core/authority/types.js';
import { readRequiredChecks, type HostMergeDeps } from '../src/core/fleet/host-merge.js';
import { evaluateG7Checks } from '../src/core/fleet/merge-gates.js';
import { editGrant, makeGrant, signGrant, TEST_SURFACE, withTempHome } from './helpers/authority-310b.js';

const PLAN_403 = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
const PLAN_MESSAGE = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';

let restore: () => void;
beforeEach(() => {
  ({ restore } = withTempHome('server-enforcement-314-'));
});
afterEach(() => restore());

const ok = (body: unknown): GhResult => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
const no = (stderr: string): GhResult => ({ status: 1, stdout: '', stderr });

/** A GitHub of named repos: `enforced` (a required check), `bare` (readable, nothing required), `plan` (private on Free), `denied`. */
function fakeGithub(repos: Record<string, 'enforced' | 'bare' | 'plan' | 'denied' | 'classic'>) {
  return (path: string): GhResult => {
    for (const [name, kind] of Object.entries(repos)) {
      if (kind === 'denied' && path.startsWith(`repos/${name}`)) return no('gh: Resource not accessible by integration (HTTP 403)');
      if (path === `repos/${name}`) return ok({ private: kind === 'plan', default_branch: 'main' });
      if (path.startsWith(`repos/${name}/rules/branches/main`)) {
        if (kind === 'plan') return no(PLAN_403);
        return ok(kind === 'enforced'
          ? [{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ashlr/verify', integration_id: 4242 }] } }]
          : [{ type: 'deletion' }]);
      }
      if (path === `repos/${name}/branches/main`) {
        return ok({ name: 'main', protection: kind === 'classic'
          ? { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['ci'], checks: [] } }
          : { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: ['ignored'], checks: [] } } });
      }
      if (path === `repos/${name}/rulesets`) return kind === 'plan' ? no(PLAN_403) : ok([]);
      if (path.startsWith(`repos/${name}/commits/main/check-runs`)) return ok({ total_count: 1, check_runs: [{ name: 'ci', app: { id: 15368 }, head_sha: 'a'.repeat(40), details_url: `https://github.com/${name}/actions/runs/101/job/1` }] });
      if (path.startsWith(`repos/${name}/contents/.github/workflows/ci.yml?ref=`)) return ok({ type: 'file', path: '.github/workflows/ci.yml', encoding: 'base64', content: Buffer.from('on: [pull_request, push]\n').toString('base64'), size: Buffer.byteLength('on: [pull_request, push]\n'), sha: 'c'.repeat(40) });
      if (path === `repos/${name}/actions/runs/101`) return ok({ id: 101, event: 'pull_request', path: '.github/workflows/ci.yml', head_sha: 'a'.repeat(40), repository: { full_name: name } });
    }
    return no(`gh: Not Found (HTTP 404) ${path}`);
  };
}

describe('classifyGithubReadFailure', () => {
  it('tells a plan limit from a permission problem, a missing repo and a transient failure', () => {
    expect(classifyGithubReadFailure({ message: PLAN_403 })).toBe('plan-unavailable');
    expect(classifyGithubReadFailure({ status: 403, message: PLAN_MESSAGE })).toBe('plan-unavailable');
    expect(classifyGithubReadFailure({ message: 'gh: Resource not accessible by integration (HTTP 403)' })).toBe('no-permission');
    expect(classifyGithubReadFailure({ status: 403, message: 'Must have admin rights to Repository.' })).toBe('no-permission');
    expect(classifyGithubReadFailure({ message: 'gh: API rate limit exceeded for user. (HTTP 403)' })).toBe('transient');
    expect(classifyGithubReadFailure({ message: 'gh: Server Error (HTTP 502)' })).toBe('transient');
    expect(classifyGithubReadFailure({ message: 'error connecting to api.github.com: dial tcp: i/o timeout' })).toBe('transient');
    expect(classifyGithubReadFailure({ message: 'gh: Not Found (HTTP 404)' })).toBe('not-found');
    expect(classifyGithubReadFailure({ status: 422, message: 'Validation Failed' })).toBe('unknown');
  });
});

describe('probeServerEnforcement', () => {
  const get = fakeGithub({ 'ashlrai/pub': 'enforced', 'ashlrai/bare': 'bare', 'ashlrai/measurably': 'plan', 'ashlrai/hidden': 'denied', 'ashlrai/legacy': 'classic' });

  it('enforced / no-required-checks / unavailable / unreadable, as G7 would see it', async () => {
    expect(await probeServerEnforcement('ashlrai/pub', get)).toMatchObject({ state: 'enforced', private: false, failure: null });
    // Classic protection counts only when it is enforced (enforcement_level "off" lists contexts it ignores).
    expect(await probeServerEnforcement('ashlrai/legacy', get)).toMatchObject({ state: 'enforced' });
    expect(await probeServerEnforcement('ashlrai/bare', get)).toMatchObject({ state: 'no-required-checks' });
    expect(await probeServerEnforcement('ashlrai/measurably', get)).toMatchObject({
      state: 'unavailable', private: true, failure: 'plan-unavailable',
      detail: 'GitHub rulesets are unavailable on this plan for private repo ashlrai/measurably',
    });
    expect(await probeServerEnforcement('ashlrai/hidden', get)).toMatchObject({ state: 'unreadable', failure: 'no-permission' });
    expect(await probeServerEnforcement('ashlrai/gone', get)).toMatchObject({ state: 'unreadable', failure: 'not-found' });
    expect(await probeServerEnforcement('not a repo', get)).toMatchObject({ state: 'unreadable' });
    // A reader that throws is an unreadable probe, never an exception.
    expect(await probeServerEnforcement('ashlrai/pub', () => { throw new Error('boom'); })).toMatchObject({ state: 'unreadable' });
  });

  it('countRequiredChecks unions rulesets and enforced classic protection', () => {
    const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } }];
    expect(countRequiredChecks(rules, { protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['b', 'c'] } } })).toBe(3);
    expect(countRequiredChecks([], { protection: { required_status_checks: { enforcement_level: 'off', contexts: ['b'] } } })).toBe(0);
    expect(countRequiredChecks(null, null)).toBe(0);
  });

  it('the default reader never reaches GitHub under tests', async () => {
    expect(await defaultGithubGet('repos/ashlrai/measurably')).toMatchObject({ status: 1, stderr: expect.stringMatching(/disabled under tests/) });
  });
});

describe('what a draft and a re-approval do with a probe', () => {
  it('a new grant names server only where GitHub enforces required checks', () => {
    expect(draftEnforcementFor({ state: 'enforced' })).toBe('server');
    for (const state of ['no-required-checks', 'unavailable', 'unreadable'] as const) expect(draftEnforcementFor({ state })).toBe('local');
    expect(draftEnforcementFor(null)).toBe('local');
    expect(draftEnforcementFor(undefined)).toBe('local');
  });

  it('a re-approval downgrades only on definitive evidence', () => {
    expect(reapprovalDowngrades({ state: 'unavailable' })).toBe(true);
    expect(reapprovalDowngrades({ state: 'no-required-checks' })).toBe(true);
    expect(reapprovalDowngrades({ state: 'unreadable' })).toBe(false);
    expect(reapprovalDowngrades({ state: 'enforced' })).toBe(false);
    expect(reapprovalDowngrades(null)).toBe(false);
  });

  it('buildReapprovalGrantPayload switches a plan-gated server repo to local at the local ceilings, and nothing else', () => {
    const current = editGrant(makeGrant(), (g) => {
      g.repos[1] = { ...g.repos[1]!, enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 }; // ashlrcode
      g.repos[2] = { nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 };
    });
    const input = { nowMs: Date.now(), grantId: 'e'.repeat(32), grantSeq: 2, keyId: current.keyId, hostBinding: current.hostBinding, authoritySurfaceDigest: TEST_SURFACE };
    const next = buildReapprovalGrantPayload(current, 0, {
      ...input,
      serverEnforcement: new Map([
        ['ashlrai/measurably', 'unavailable'],
        ['ashlrai/ashlrcode', 'unreadable'],
        ['ashlrai/fleet-canary', 'enforced'],
      ]),
    });
    expect(parseStandingGrantPayload(next).ok).toBe(true);
    const byName = new Map(next.repos.map((r) => [r.nameWithOwner, r]));
    expect(byName.get('ashlrai/measurably')).toEqual({ nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 });
    expect(byName.get('ashlrai/ashlrcode')).toEqual(current.repos[1]); // unreadable: the signed choice stands
    expect(byName.get('ashlrai/fleet-canary')).toEqual(current.repos[0]);
    // The current grant object itself was not touched.
    expect(current.repos[2]!.enforcement).toBe('server');
    // Without probes a re-approval is exactly the old scope.
    expect(buildReapprovalGrantPayload(current, 0, input).repos).toEqual(current.repos);
  });

  it('enforcementMismatch names the fix, and says nothing when the grant is local or the probe could not tell', () => {
    const probe = (state: ServerEnforcementProbe['state'], isPrivate: boolean | null = true): ServerEnforcementProbe =>
      ({ nameWithOwner: 'ashlrai/measurably', state, private: isPrivate, failure: null, detail: '' });
    expect(enforcementMismatch({ nameWithOwner: 'ashlrai/measurably', enforcement: 'server' }, probe('unavailable'), 1)).toBe(
      'grant #1 says server enforcement for ashlrai/measurably, but GitHub rulesets are unavailable on this plan for this private repo ' +
      '— G7 sends its PRs to the owner lane; re-approve (`ashlr authority re-approve`) to switch it to local enforcement with ashlr/verify',
    );
    expect(enforcementMismatch({ nameWithOwner: 'ashlrai/measurably', enforcement: 'server' }, probe('no-required-checks', false)))
      .toMatch(/^the grant says server enforcement .* requires no check .* `ashlr authority protect --apply`/);
    expect(enforcementMismatch({ nameWithOwner: 'ashlrai/measurably', enforcement: 'local' }, probe('unavailable'))).toBeNull();
    expect(enforcementMismatch({ nameWithOwner: 'ashlrai/measurably', enforcement: 'server' }, probe('unreadable'))).toBeNull();
    expect(enforcementMismatch({ nameWithOwner: 'ashlrai/measurably', enforcement: 'server' }, probe('enforced'))).toBeNull();
  });
});

describe('G7 on a repo GitHub cannot protect', () => {
  const base = { runs: [], statuses: [], pendingSinceMs: Date.now(), nowMs: Date.now() };
  const verifyRun = { id: 9, name: 'ashlr/verify', appId: '4242', status: 'completed', conclusion: 'success' };

  it('server enforcement + plan-gated rulesets: owner lane, with a reason that says to re-approve — never a pass', () => {
    const g7 = evaluateG7Checks({ ...base, enforcement: 'server', required: [], rulesetsUnavailable: true, runs: [verifyRun], fleetAppId: '4242' });
    expect(g7).toMatchObject({ verdict: 'owner-lane', code: 'server-enforcement-unavailable', state: 'none' });
    expect(g7.reason).toMatch(/rulesets are unavailable on this plan .* re-approve the grant to switch the repo to local enforcement/);
    // Without the flag: the same verdict it always had.
    expect(evaluateG7Checks({ ...base, enforcement: 'server', required: [], runs: [verifyRun], fleetAppId: '4242' }))
      .toMatchObject({ verdict: 'owner-lane', code: 'no-required-checks' });
    // The flag never relaxes a server repo that does have required checks.
    expect(evaluateG7Checks({ ...base, enforcement: 'server', required: [{ context: 'ci', appId: null }], rulesetsUnavailable: true, runs: [verifyRun], fleetAppId: '4242' }))
      .toMatchObject({ verdict: 'wait', code: 'checks-pending' });
  });

  it('local enforcement on the same repo needs the App\'s green ashlr/verify (and every other check green)', () => {
    expect(evaluateG7Checks({ ...base, enforcement: 'local', required: [], rulesetsUnavailable: true, runs: [verifyRun], fleetAppId: '4242' }))
      .toMatchObject({ verdict: 'pass', code: 'checks-green' });
    expect(evaluateG7Checks({ ...base, enforcement: 'local', required: [], rulesetsUnavailable: true, runs: [verifyRun], fleetAppId: null }))
      .toMatchObject({ verdict: 'owner-lane', code: 'no-verify-check' });
    // A same-named run from another App is just one more check, not the proof.
    expect(evaluateG7Checks({ ...base, enforcement: 'local', required: [], runs: [{ ...verifyRun, appId: '999' }], fleetAppId: '4242' }))
      .toMatchObject({ verdict: 'wait', code: 'checks-pending' });
  });

  it('readRequiredChecks: a plan-gated 403 is "no rules" (flagged); any other 403 is still unreadable', async () => {
    const deps = (rules: { status: number; body: unknown }): HostMergeDeps => ({
      token: async () => ({ token: 'ghs_test', expiresAt: null }),
      transport: async (call: { path: string }) => (call.path.includes('/rules/branches/')
        ? rules
        : { status: 200, body: { name: 'main', protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } } }),
    }) as unknown as HostMergeDeps;
    expect(await readRequiredChecks('ashlrai/measurably', 'main', deps({ status: 403, body: { message: PLAN_MESSAGE } })))
      .toMatchObject({ required: [], rulesetsUnavailable: true });
    expect(await readRequiredChecks('ashlrai/measurably', 'main', deps({ status: 403, body: { message: 'Resource not accessible by integration' } })))
      .toMatch(/^rulesets: GitHub answered HTTP 403/);
    expect(await readRequiredChecks('ashlrai/measurably', 'main', deps({ status: 404, body: { message: 'Not Found' } })))
      .toMatchObject({ required: [], rulesetsUnavailable: false });
    expect(await readRequiredChecks('ashlrai/measurably', 'main', deps({ status: 0, body: null }))).toMatch(/^rulesets: /);
  });
});

describe('protect and status report the mismatch and never change the grant', () => {
  function installGrant(grant: StandingGrantV1): string {
    ensureAuthorityDir();
    const text = `${canonicalJson(signGrant(grant))}\n`;
    writeFileSync(installedGrantPath(), text, { mode: 0o600 });
    return text;
  }
  const grant = (): StandingGrantV1 => editGrant(makeGrant(), (g) => {
    g.repos = [
      { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 6 },
      { nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxMergesPerDay: 4 },
      { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge', enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 },
    ];
    g.rollout.stages = g.rollout.stages.map((stage) => ({ ...stage, repos: stage.repos.filter((r) => g.repos.some((repo) => repo.nameWithOwner === r.nameWithOwner)) }));
  });

  function deps(run: (path: string) => GhResult) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[][] = [];
    const injected: Partial<AuthorityCliDeps> = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => false,
      run: (bin, args) => {
        calls.push([bin, ...args]);
        if (bin !== 'gh' || args[0] !== 'api' || args.includes('--method')) return no('unexpected write');
        return run(args[1]!);
      },
    };
    return { injected, out, err, calls };
  }

  it('protect --print: plan-gated repos are named precisely; a grant that says server gets the re-approve instruction', async () => {
    const before = installGrant(grant());
    const h = deps(fakeGithub({ 'ashlrai/fleet-canary': 'bare', 'ashlrai/measurably': 'plan', 'ashlrai/ashlr-cortex': 'plan', 'ashlrai/hidden': 'denied' }));
    expect(await runAuthorityCli(['protect', '--print'], h.injected)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('ashlrai/measurably: skipped — grant #1 says server enforcement for ashlrai/measurably, but GitHub rulesets are unavailable on this plan for this private repo');
    expect(text).toContain('re-approve (`ashlr authority re-approve`) to switch it to local enforcement with ashlr/verify');
    expect(text).toMatch(/ashlrai\/ashlrcode: skipped — local enforcement in the grant .* ashlr\/verify/);
    expect(text).toMatch(/ashlrai\/fleet-canary: create; required checks: ci/);

    h.out.length = 0;
    expect(await runAuthorityCli(['protect', '--print', '--repo', 'ashlrai/ashlr-cortex', '--repo', 'ashlrai/hidden'], h.injected)).toBe(0);
    expect(h.out.join('\n')).toContain('ashlrai/ashlr-cortex: skipped — rulesets unavailable on this plan for private repo ashlrai/ashlr-cortex — using local enforcement with ashlr/verify');
    expect(h.out.join('\n')).toMatch(/ashlrai\/hidden: skipped — could not read it from GitHub \(your gh auth has no access/);
    // Read-only, and the signed grant is byte-for-byte what was installed.
    expect(h.calls.every((c) => !c.includes('--method'))).toBe(true);
    expect(readFileSync(installedGrantPath(), 'utf8')).toBe(before);
  });

  it('status lists each mismatch between the grant and GitHub', async () => {
    installGrant(grant());
    const h = deps(fakeGithub({ 'ashlrai/fleet-canary': 'enforced', 'ashlrai/measurably': 'plan' }));
    expect(await runAuthorityCli(['status'], h.injected)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/^Enforcement: 1\/2 server-enforced repo\(s\) protected by GitHub — 1 mismatch:$/m);
    expect(text).toMatch(/^ {2}grant #1 says server enforcement for ashlrai\/measurably, but GitHub rulesets are unavailable/m);
    // Local repos are not read at all.
    expect(h.calls.some((c) => c.some((a) => a.includes('ashlrcode')))).toBe(false);

    const offline = deps(() => no('error connecting to api.github.com'));
    expect(await runAuthorityCli(['status'], offline.injected)).toBe(0);
    expect(offline.out.join('\n')).toMatch(/^Enforcement: 0\/2 server-enforced repo\(s\) protected by GitHub; could not check ashlrai\/fleet-canary, ashlrai\/measurably$/m);
  });
});
