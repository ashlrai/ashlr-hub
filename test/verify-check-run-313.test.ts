/**
 * 3.13 — the host-verified required check `ashlr/verify`
 * (core/fleet/verify-check-run.ts) and what trusts it:
 *
 *   - the App posts `success` ONLY when G3 passed and the PR head GitHub
 *     holds is exactly the verified tree on exactly the verified base;
 *     anything else is `failure` (never neutral / skipped, which G7 counts
 *     as green);
 *   - idempotent per head SHA: an unchanged decision makes no GitHub call, a
 *     changed one PATCHes the same run, a new head gets a new run;
 *   - a 403 is a permission problem (the App lacks checks:write), not retried;
 *   - G7 on a local-enforcement repo refuses a deploy-only (Vercel) green and
 *     accepts the App's own green `ashlr/verify`; a same-named run from any
 *     other App never counts;
 *   - `ashlr authority protect` requires `ashlr/verify` pinned to the App for
 *     grant repos the fleet can verify, even when master has no runs.
 *
 * Every GitHub call goes through an in-memory fake transport. HOME-isolated.
 */
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The protect cases import the CLI's lazy modules on first use (slow on a loaded machine).
vi.setConfig({ testTimeout: 30_000 });

const grant = vi.hoisted(() => ({ repos: [] as { nameWithOwner: string; enforcement: string }[] }));
vi.mock('../src/core/authority/standing-grant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/standing-grant.js')>()),
  readInstalledGrant: () => (grant.repos.length > 0
    ? { state: 'ok', envelope: { payload: { repos: grant.repos } } }
    : { state: 'none' }),
}));
const detect = vi.hoisted(() => ({ commands: [{ kind: 'test', cmd: ['npm', 'test'], required: true }] as unknown[] }));
vi.mock('../src/core/run/verify-commands.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/run/verify-commands.js')>()),
  detectVerifyCommands: () => detect.commands,
}));

import { buildFleetRuleset, fleetAppPermissionUrls, readFleetApp, runAuthorityCli, type AuthorityCliDeps, type GhResult } from '../src/cli/authority.js';
import { newFleetMergeState, type FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';
import type { GithubCall, GithubReply } from '../src/core/fleet/host-merge.js';
import { evaluateG7Checks, type CheckRunObservation } from '../src/core/fleet/merge-gates.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import {
  ASHLR_VERIFY_CHECK_NAME,
  decideVerifyCheck,
  ensureFleetVerifyCheck,
  postVerifyCheckRun,
  type VerifiedBinding,
} from '../src/core/fleet/verify-check-run.js';
import { withTempHome } from './helpers/authority-310b.js';

let restore: () => void;
beforeEach(() => {
  ({ restore } = withTempHome('verify-check-313-'));
  grant.repos = [];
  detect.commands = [{ kind: 'test', cmd: ['npm', 'test'], required: true }];
});
afterEach(() => restore());

const REPO = 'ashlrai/ashlr-hub';
const FLEET_APP = 424242;
const VERCEL_APP = 8329;
const sha = (c: string) => c.repeat(40);
const HEAD = sha('a');
const BASE = sha('b');
const TREE = sha('c');
const NOW = Date.parse('2026-09-26T12:00:00Z');

const verified = (over: Partial<VerifiedBinding> = {}): VerifiedBinding => ({
  g3: { verdict: 'pass', code: 'verified' },
  verifyDigest: 'd'.repeat(64),
  baseSha: BASE,
  treeSha: TREE,
  commands: [{ kind: 'test', cmd: ['npm', 'test'] }, { kind: 'typecheck', cmd: ['npx', 'tsc', '--noEmit'] }],
  ...over,
});

/** An in-memory GitHub: one head commit, check runs attributed to whatever App the token belongs to. */
function fakeGithub(opts: { tree?: string; parents?: string[]; status?: number; appId?: number } = {}) {
  const calls: GithubCall[] = [];
  const runs: { id: number; head: string; conclusion: string; appId: number; body: Record<string, unknown> }[] = [];
  let nextId = 1;
  const transport = async (call: GithubCall): Promise<GithubReply> => {
    calls.push(call);
    const path = call.path.replace(`/repos/${REPO}`, '');
    if (call.method === 'GET' && path === `/git/commits/${HEAD}`) {
      return { status: 200, body: { sha: HEAD, tree: { sha: opts.tree ?? TREE }, parents: (opts.parents ?? [BASE]).map((p) => ({ sha: p })) } };
    }
    if (opts.status !== undefined && /\/check-runs/.test(path)) return { status: opts.status, body: { message: 'Resource not accessible by integration' } };
    const body = call.body as Record<string, unknown>;
    if (call.method === 'POST' && path === '/check-runs') {
      const run = { id: nextId++, head: String(body['head_sha']), conclusion: String(body['conclusion']), appId: opts.appId ?? FLEET_APP, body };
      runs.push(run);
      return { status: 201, body: { id: run.id, name: body['name'], head_sha: run.head, conclusion: run.conclusion, app: { id: run.appId } } };
    }
    const patch = /^\/check-runs\/(\d+)$/.exec(path);
    if (call.method === 'PATCH' && patch) {
      const run = runs.find((r) => r.id === Number(patch[1]));
      if (!run) return { status: 404, body: { message: 'Not Found' } };
      run.conclusion = String(body['conclusion']);
      return { status: 200, body: { id: run.id, name: ASHLR_VERIFY_CHECK_NAME, head_sha: run.head, conclusion: run.conclusion, app: { id: run.appId } } };
    }
    return { status: 404, body: { message: `no route ${call.method} ${path}` } };
  };
  const deps = { transport, token: async () => ({ token: 'ghs_test_installation_token', expiresAt: null }), nowMs: () => NOW };
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { calls, runs, deps, writes };
}

describe('decideVerifyCheck — success only for G3 pass on the exact verified tree and base', () => {
  const head = { tree: TREE, parents: [BASE] };
  it('success when G3 passed and the head is the verified tree on the verified base', () => {
    const decision = decideVerifyCheck({ headSha: HEAD, head, verified: verified() });
    expect(decision.conclusion).toBe('success');
    expect(decision.text).toContain(TREE);
    expect(decision.text).toContain(BASE);
    expect(decision.text).toContain('d'.repeat(64));
    expect(decision.text).toContain('`npm test`');
    expect(decision.text).toContain('`npx tsc --noEmit`');
  });

  it.each([
    ['G3 never ran (owner lane)', { g3: null }, { tree: TREE, parents: [BASE] }],
    ['G3 waiting', { g3: { verdict: 'wait', code: 'verify-infra' } }, { tree: TREE, parents: [BASE] }],
    ['G3 refused', { g3: { verdict: 'refuse', code: 'verify-failed' } }, { tree: TREE, parents: [BASE] }],
    ['no verify digest', { verifyDigest: null }, { tree: TREE, parents: [BASE] }],
    ['no command recorded', { commands: [] }, { tree: TREE, parents: [BASE] }],
    ['no verified tree', { treeSha: null }, { tree: TREE, parents: [BASE] }],
    ['head tree differs', {}, { tree: sha('e'), parents: [BASE] }],
    ['head parent differs', {}, { tree: TREE, parents: [sha('f')] }],
    ['head is a merge commit', {}, { tree: TREE, parents: [BASE, sha('f')] }],
  ])('failure: %s', (_label, over, headCommit) => {
    const decision = decideVerifyCheck({ headSha: HEAD, head: headCommit, verified: verified(over as Partial<VerifiedBinding>) });
    expect(decision.conclusion).toBe('failure');
    expect(decision.title).toBe('Not host-verified');
  });
});

describe('postVerifyCheckRun — through the App transport', () => {
  it('creates a completed ashlr/verify run on the head and remembers the App GitHub attributed it to', async () => {
    const gh = fakeGithub();
    const result = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: null }, gh.deps);
    expect(result).toMatchObject({ ok: true, action: 'created', memo: { headSha: HEAD, appId: String(FLEET_APP), conclusion: 'success', runId: 1 } });
    const post = gh.writes()[0]!;
    expect(post).toMatchObject({ method: 'POST', path: `/repos/${REPO}/check-runs` });
    expect(post.body).toMatchObject({ name: 'ashlr/verify', head_sha: HEAD, status: 'completed', conclusion: 'success' });
    expect(JSON.stringify(post.body)).toContain(TREE);
    // The token only ever travels in the transport's token field.
    expect(JSON.stringify(post.body)).not.toContain('ghs_');
  });

  it('posts failure when the head tree is not the verified tree, and when G3 did not pass', async () => {
    const drifted = fakeGithub({ tree: sha('e') });
    expect(await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: null }, drifted.deps))
      .toMatchObject({ ok: true, memo: { conclusion: 'failure' } });
    const unverified = fakeGithub();
    expect(await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified({ g3: { verdict: 'wait', code: 'verify-infra' } }), prior: null }, unverified.deps))
      .toMatchObject({ ok: true, memo: { conclusion: 'failure' } });
    for (const gh of [drifted, unverified]) {
      for (const write of gh.writes()) expect(['success', 'failure']).toContain((write.body as Record<string, unknown>)['conclusion']);
    }
  });

  it('is idempotent per head: unchanged ⇒ no call, changed binding ⇒ PATCH the same run, new head ⇒ new run', async () => {
    const gh = fakeGithub();
    const first = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: null }, gh.deps);
    if (!first.ok) throw new Error(first.reason);
    const callsAfterFirst = gh.calls.length;
    const again = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: first.memo }, gh.deps);
    expect(again).toMatchObject({ ok: true, action: 'unchanged', memo: first.memo });
    expect(gh.calls.length).toBe(callsAfterFirst);

    const changed = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified({ g3: { verdict: 'refuse', code: 'verify-failed' } }), prior: first.memo }, gh.deps);
    expect(changed).toMatchObject({ ok: true, action: 'updated', memo: { runId: first.memo.runId, conclusion: 'failure' } });
    expect(gh.writes().at(-1)).toMatchObject({ method: 'PATCH', path: `/repos/${REPO}/check-runs/${first.memo.runId}` });
    expect(gh.runs).toHaveLength(1);

    const moved = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: { ...first.memo, headSha: sha('9') } }, gh.deps);
    expect(moved).toMatchObject({ ok: true, action: 'created', memo: { runId: 2 } });
  });

  it('a 403 means the App lacks checks:write — reported, not retried; a network failure is retryable', async () => {
    const forbidden = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: null }, fakeGithub({ status: 403 }).deps);
    expect(forbidden).toMatchObject({ ok: false, code: 'permission', retryable: false });
    expect(!forbidden.ok && forbidden.reason).toMatch(/Checks: Read and write/);
    const offline = await postVerifyCheckRun({ repo: REPO, headSha: HEAD, verified: verified(), prior: null }, fakeGithub({ status: 0 }).deps);
    expect(offline).toMatchObject({ ok: false, code: 'github', retryable: true });
  });

  it('refuses malformed input without calling GitHub', async () => {
    const gh = fakeGithub();
    expect(await postVerifyCheckRun({ repo: 'not a repo', headSha: HEAD, verified: verified(), prior: null }, gh.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await postVerifyCheckRun({ repo: REPO, headSha: 'HEAD', verified: verified(), prior: null }, gh.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(gh.calls).toHaveLength(0);
  });

  it('ensureFleetVerifyCheck binds the check to the state\'s own G3 row and verified tree, and stores the memo', async () => {
    const state: FleetMergeStateV1 = {
      ...newFleetMergeState({ key: 'p-313', kind: 'change', proposalId: 'p-313', revertsLandingId: null, repo: REPO, repoPath: '/tmp/m', enforcement: 'local', nowIso: new Date(NOW).toISOString() }),
      gates: { G3: { digest: 'd'.repeat(64), verdict: 'pass', code: 'verified', headSha: null, at: new Date(NOW).toISOString() } },
      baseSha: BASE,
      treeSha: TREE,
      verifyDigest: 'd'.repeat(64),
      verifyCommands: [{ kind: 'test', cmd: ['npm', 'test'] }],
    };
    expect(await ensureFleetVerifyCheck(state, fakeGithub().deps)).toMatchObject({ ok: false, code: 'invalid' });
    state.pr = {
      number: 7, nodeId: 'PR_x', repositoryId: 'R_x', branch: 'ashlr/fleet/p-313', baseBranch: 'master', baseSha: BASE, headSha: HEAD, treeSha: TREE,
      ownerLane: false, ownerLaneReason: null, openedAt: new Date(NOW).toISOString(), ledgered: true, state: 'open', closedBy: null,
      nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null,
    };
    const result = await ensureFleetVerifyCheck(state, fakeGithub().deps);
    expect(result).toMatchObject({ ok: true, memo: { conclusion: 'success', appId: String(FLEET_APP) } });
    expect(state.pr.verifyCheck).toMatchObject({ headSha: HEAD, appId: String(FLEET_APP) });
    // Without a passed G3 the same head is reported red.
    state.gates['G3'] = { digest: 'e'.repeat(64), verdict: 'wait', code: 'verify-infra', headSha: null, at: new Date(NOW).toISOString() };
    expect(await ensureFleetVerifyCheck(state, fakeGithub().deps)).toMatchObject({ ok: true, memo: { conclusion: 'failure' } });
  });
});

describe('G7 trusts ashlr/verify only from the fleet App', () => {
  const run = (name: string, conclusion: string | null, appId: number, id: number, status = 'completed'): CheckRunObservation =>
    ({ id, name, appId: String(appId), status, conclusion });
  const local = { enforcement: 'local' as const, required: [], statuses: [], pendingSinceMs: NOW - 60_000, nowMs: NOW };

  it('a Vercel-only green never passes a local-enforcement repo', () => {
    const vercel = [run('Vercel', 'success', VERCEL_APP, 1), run('Vercel Preview Comments', 'success', VERCEL_APP, 2)];
    expect(evaluateG7Checks({ ...local, runs: vercel })).toMatchObject({ verdict: 'owner-lane', code: 'no-verify-check' });
    // Posted but not yet listed: wait (under the 24 h timeout), never pass.
    expect(evaluateG7Checks({ ...local, runs: vercel, fleetAppId: String(FLEET_APP) })).toMatchObject({ verdict: 'wait', code: 'checks-pending' });
    expect(evaluateG7Checks({ ...local, runs: vercel, fleetAppId: String(FLEET_APP), pendingSinceMs: NOW - 25 * 3_600_000 }))
      .toMatchObject({ verdict: 'refuse', code: 'checks-timeout' });
  });

  it('a same-named ashlr/verify from another App does not count', () => {
    const spoof = [run(ASHLR_VERIFY_CHECK_NAME, 'success', VERCEL_APP, 1)];
    expect(evaluateG7Checks({ ...local, runs: spoof }).verdict).toBe('owner-lane');
    expect(evaluateG7Checks({ ...local, runs: spoof, fleetAppId: String(FLEET_APP) }).verdict).toBe('wait');
  });

  it('accepts the App\'s green ashlr/verify (with every other check green) and refuses a red one', () => {
    const green = [run('Vercel', 'success', VERCEL_APP, 1), run(ASHLR_VERIFY_CHECK_NAME, 'success', FLEET_APP, 2)];
    expect(evaluateG7Checks({ ...local, runs: green, fleetAppId: String(FLEET_APP) })).toMatchObject({ verdict: 'pass', code: 'checks-green', state: 'green' });
    const red = [run('Vercel', 'success', VERCEL_APP, 1), run(ASHLR_VERIFY_CHECK_NAME, 'failure', FLEET_APP, 2)];
    expect(evaluateG7Checks({ ...local, runs: red, fleetAppId: String(FLEET_APP) })).toMatchObject({ verdict: 'refuse', code: 'required-check-failed' });
    const otherRed = [run('Vercel', 'failure', VERCEL_APP, 1), run(ASHLR_VERIFY_CHECK_NAME, 'success', FLEET_APP, 2)];
    expect(evaluateG7Checks({ ...local, runs: otherRed, fleetAppId: String(FLEET_APP) }).verdict).toBe('refuse');
    // The newest App run wins (a re-verification after a red one).
    const rerun = [run(ASHLR_VERIFY_CHECK_NAME, 'failure', FLEET_APP, 2), run(ASHLR_VERIFY_CHECK_NAME, 'success', FLEET_APP, 3)];
    expect(evaluateG7Checks({ ...local, runs: rerun, fleetAppId: String(FLEET_APP) }).verdict).toBe('pass');
  });

  it('server-enforced repos: a ruleset requiring ashlr/verify@App passes on the App run, waits on a spoof', () => {
    const server = { ...local, enforcement: 'server' as const, required: [{ context: ASHLR_VERIFY_CHECK_NAME, appId: String(FLEET_APP) }] };
    expect(evaluateG7Checks({ ...server, runs: [run(ASHLR_VERIFY_CHECK_NAME, 'success', FLEET_APP, 1)] }).verdict).toBe('pass');
    expect(evaluateG7Checks({ ...server, runs: [run(ASHLR_VERIFY_CHECK_NAME, 'success', VERCEL_APP, 1)] }).verdict).toBe('wait');
    // No required checks at all is still the owner lane.
    expect(evaluateG7Checks({ ...server, required: [], runs: [run('Vercel', 'success', VERCEL_APP, 1)] }).code).toBe('no-required-checks');
  });
});

describe('ashlr authority protect / github-app — ashlr/verify pinned to the App', () => {
  const appJson = (checks: string) => JSON.stringify({ id: FLEET_APP, slug: 'ashlr-fleet', owner: { login: 'ashlrai', type: 'Organization' }, permissions: { checks } });

  function harness(gh: (args: readonly string[]) => GhResult) {
    const out: string[] = [];
    const calls: { args: readonly string[]; input?: string }[] = [];
    const deps: Partial<AuthorityCliDeps> = {
      out: (line) => out.push(line),
      err: (line) => out.push(line),
      confirm: async () => false,
      readSecret: async () => '',
      run: (_bin, args, opts) => {
        calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
        return gh(args);
      },
      openBrowser: () => { throw new Error('no browser in tests'); },
      fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
    };
    return { deps, out, calls };
  }

  /** ashlr-hub today: Actions off, so master has zero check runs. */
  const noCi = (args: readonly string[]): GhResult => {
    if (args.includes('--method')) return { status: 0, stdout: '{}', stderr: '' };
    const path = args[1];
    if (path === `repos/${REPO}`) return { status: 0, stdout: JSON.stringify({ default_branch: 'master', private: false }), stderr: '' };
    if (path?.startsWith(`repos/${REPO}/commits/master/check-runs`)) return { status: 0, stdout: JSON.stringify({ check_runs: [] }), stderr: '' };
    if (path === `repos/${REPO}/rulesets`) return { status: 0, stdout: '[]', stderr: '' };
    if (path === 'apps/ashlr-fleet') return { status: 0, stdout: appJson('write'), stderr: '' };
    return { status: 1, stdout: '', stderr: 'no route' };
  };

  it('requires ashlr/verify@App for a grant repo the fleet can verify, even with no runs on master', async () => {
    grant.repos = [{ nameWithOwner: REPO, enforcement: 'server' }];
    mkdirSync(mirrorPathFor(REPO), { recursive: true });
    const h = harness(noCi);
    expect(await runAuthorityCli(['protect', '--print', '--repo', REPO], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/required checks: ashlr\/verify/);
    expect(text).toContain(`"integration_id": ${FLEET_APP}`);
    expect(text).toMatch(/admin bypass/);
    expect(h.calls.every((c) => !c.args.includes('--method'))).toBe(true);
  });

  it('a same-named run on master from another App never replaces the pin', async () => {
    grant.repos = [{ nameWithOwner: REPO, enforcement: 'server' }];
    mkdirSync(mirrorPathFor(REPO), { recursive: true });
    const h = harness((args) => (args[1]?.startsWith(`repos/${REPO}/commits/master/check-runs`)
      ? { status: 0, stdout: JSON.stringify({ check_runs: [{ name: 'ashlr/verify', app: { id: VERCEL_APP } }] }), stderr: '' }
      : noCi(args)));
    expect(await runAuthorityCli(['protect', '--apply', '--yes', '--repo', REPO], h.deps)).toBe(0);
    const post = h.calls.find((c) => c.args.includes('POST'))!;
    expect(JSON.parse(post.input!)).toEqual(buildFleetRuleset([{ context: 'ashlr/verify', integrationId: FLEET_APP }]));
  });

  it('not required outside the grant, without a verifiable mirror, or when the App cannot be read', async () => {
    const outside = harness(noCi);
    expect(await runAuthorityCli(['protect', '--print', '--repo', REPO], outside.deps)).toBe(0);
    expect(outside.out.join('\n')).toMatch(/required checks: none found/);

    grant.repos = [{ nameWithOwner: REPO, enforcement: 'server' }];
    const noMirror = harness(noCi);
    expect(await runAuthorityCli(['protect', '--print', '--repo', REPO], noMirror.deps)).toBe(0);
    expect(noMirror.out.join('\n')).toMatch(/ashlr\/verify not required: the fleet mirror has no verify command/);

    mkdirSync(mirrorPathFor(REPO), { recursive: true });
    detect.commands = [];
    const noCommands = harness(noCi);
    expect(await runAuthorityCli(['protect', '--print', '--repo', REPO], noCommands.deps)).toBe(0);
    expect(noCommands.out.join('\n')).toMatch(/ashlr\/verify not required/);

    detect.commands = [{ kind: 'test', cmd: ['npm', 'test'], required: true }];
    const noApp = harness((args) => (args[1] === 'apps/ashlr-fleet' ? { status: 1, stdout: '', stderr: 'Not Found' } : noCi(args)));
    expect(await runAuthorityCli(['protect', '--print', '--repo', REPO], noApp.deps)).toBe(0);
    expect(noApp.out.join('\n')).toMatch(/could not be read/);
    expect(noApp.out.join('\n')).not.toMatch(/"integration_id"/);
  });

  it('readFleetApp reads the App\'s checks permission; the settings links are exact', async () => {
    expect(await readFleetApp(harness(() => ({ status: 0, stdout: appJson('read'), stderr: '' })).deps as AuthorityCliDeps))
      .toEqual({ id: FLEET_APP, slug: 'ashlr-fleet', ownerLogin: 'ashlrai', ownerIsOrg: true, checks: 'read' });
    expect(await readFleetApp(harness(() => ({ status: 1, stdout: '', stderr: 'x' })).deps as AuthorityCliDeps)).toBeNull();
    expect(fleetAppPermissionUrls({ slug: 'ashlr-fleet', ownerLogin: 'ashlrai', ownerIsOrg: true })).toEqual({
      permissions: 'https://github.com/organizations/ashlrai/settings/apps/ashlr-fleet/permissions',
      installations: 'https://github.com/organizations/ashlrai/settings/installations',
    });
    expect(fleetAppPermissionUrls({ slug: 'ashlr-fleet', ownerLogin: 'masonwyatt23', ownerIsOrg: false }).permissions)
      .toBe('https://github.com/settings/apps/ashlr-fleet/permissions');
  });
});
