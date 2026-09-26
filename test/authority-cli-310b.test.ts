/**
 * V3.10 Track B unit B-U1 — `ashlr authority …` (src/cli/authority.ts).
 *
 * Every external effect is injected: `gh` / `git` are a recorded fake, the
 * browser is a fake that follows the loopback page, GitHub's manifest
 * conversion is a fake fetch, and custody never prompts. Nothing here can
 * create an App, apply a ruleset, open a PR or sign anything for real.
 * HOME-isolated.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

vi.mock('../src/core/authority/custody-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/custody-client.js')>()),
  custodyStatus: async () => ({ installed: false, version: null, keyInitialized: null, keyId: null, githubApp: null, claudeToken: null, checkedAt: new Date().toISOString(), reasons: ['not installed'] }),
}));

// Stop / Revoke cancel armed host merges through U3's module (lazily loaded
// by clamp.ts); faked so the CLI output about it can be asserted.
const merges = vi.hoisted(() => ({ revoked: 0, calls: [] as string[] }));
vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: (reason: string) => {
    merges.calls.push(reason);
    return { revoked: merges.revoked, failed: [] };
  },
}));

import {
  buildFleetRuleset,
  buildGithubAppManifest,
  manifestFormPage,
  renderTrustRootsWithKey,
  runAuthorityCli,
  runGithubAppFlow,
  validateCustodyRoot,
  type AuthorityCliDeps,
  type GhResult,
} from '../src/cli/authority.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { resetAuthorityApiCachesForTest } from '../src/core/verse/authority-api.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import { killSwitchOn } from '../src/core/sandbox/policy.js';
import { ed25519RootPem, editGrant, makeGrant, TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

let home: string;
let restore: () => void;

beforeEach(() => {
  ({ home, restore } = withTempHome('bu1-cli-'));
  merges.revoked = 0;
  merges.calls.length = 0;
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  resetAuthorityApiCachesForTest();
});

afterEach(() => {
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  resetAuthorityApiCachesForTest();
  restore();
});

interface Harness {
  deps: Partial<AuthorityCliDeps>;
  out: string[];
  err: string[];
  calls: { bin: string; args: readonly string[]; input?: string }[];
}

function harness(opts: { confirm?: boolean; gh?: (args: readonly string[]) => GhResult; custody?: Partial<AuthorityCliDeps['custody']> } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness['calls'] = [];
  const custody = {
    custodyStatus: async () => ({ installed: false, version: null, keyInitialized: null, keyId: null, githubApp: null, claudeToken: null, checkedAt: new Date().toISOString(), reasons: [] }),
    custodyInit: vi.fn(async () => { throw new Error('custodyInit must not run in this test'); }),
    signGrant: vi.fn(async () => { throw new Error('signGrant must not run in this test'); }),
    storeGithubApp: vi.fn(async () => undefined),
    storeClaudeToken: vi.fn(async () => undefined),
    ...opts.custody,
  } as unknown as AuthorityCliDeps['custody'];
  return {
    out,
    err,
    calls,
    deps: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => opts.confirm ?? false,
      readSecret: async () => '',
      run: (bin, args, runOpts) => {
        calls.push({ bin, args, ...(runOpts?.input !== undefined ? { input: runOpts.input } : {}) });
        return opts.gh ? opts.gh(args) : { status: 1, stdout: '', stderr: 'no gh in tests' };
      },
      openBrowser: () => { throw new Error('no browser in tests'); },
      fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
      custody,
    },
  };
}

describe('basic commands', () => {
  it('prints usage and exits 2 without a command', async () => {
    const h = harness();
    expect(await runAuthorityCli([], h.deps)).toBe(2);
    expect(h.out.join('\n')).toMatch(/ashlr authority <command>/);
    expect(await runAuthorityCli(['help'], h.deps)).toBe(0);
    expect(await runAuthorityCli(['bogus'], h.deps)).toBe(2);
  });

  it('status, switch (refused past the grant), stop / clear-stop and ledger verify', async () => {
    const h = harness();
    expect(await runAuthorityCli(['status', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ grant: { state: 'none' }, effectiveSwitch: 'off' });
    expect(await runAuthorityCli(['switch', 'autonomous'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/grant/);
    expect(await runAuthorityCli(['switch', 'sideways'], h.deps)).toBe(2);
    merges.revoked = 2;
    expect(await runAuthorityCli(['stop'], h.deps)).toBe(0);
    expect(killSwitchOn()).toBe(true);
    // Stop drained (nothing was running) and cancelled the armed merges U3 reported.
    expect(h.out.some((line) => /^No agent is running/.test(line))).toBe(true);
    expect(h.out).toContain('Cancelled 2 armed merges before GitHub was called.');
    expect(merges.calls).toEqual(['ashlr authority stop']);
    expect(await runAuthorityCli(['clear-stop'], h.deps)).toBe(0);
    expect(killSwitchOn()).toBe(false);
    expect(await runAuthorityCli(['ledger', 'verify'], h.deps)).toBe(0);
    expect(h.out.some((line) => /^Ledger OK: 3 entries/.test(line))).toBe(true);
    expect(await runAuthorityCli(['ledger', 'tail', '--kind', 'bogus'], h.deps)).toBe(2);
    expect(await runAuthorityCli(['ledger', 'tail', '--limit', '2'], h.deps)).toBe(0);
  });

  it('revoke engages Stop too, and --no-wait answers without draining', async () => {
    const h = harness();
    expect(await runAuthorityCli(['revoke', '--reason', 'test', '--no-wait'], h.deps)).toBe(0);
    expect(killSwitchOn()).toBe(true);
    expect(h.out.join('\n')).toMatch(/Revoked and stopped\. Resuming needs a new grant \(Touch ID\), then clearing Stop\./);
    // The instant variant starts the merge revocation without awaiting it; let it run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(merges.calls).toEqual(['revoked: test']);
    expect(await runAuthorityCli(['clear-stop'], h.deps)).toBe(0);
    expect(await runAuthorityCli(['revoke'], h.deps)).toBe(0);
    expect(killSwitchOn()).toBe(true);
    expect(merges.calls).toHaveLength(2);
  });

  it('refuses a custom payload that the verifier would refuse, before any signing', async () => {
    const h = harness();
    const file = join(home, 'payload.json');
    writeFileSync(file, JSON.stringify(editGrant(makeGrant(), (g) => { g.merge.maxFiles = 50; })));
    expect(await runAuthorityCli(['grant', '--payload', file, '--yes'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/would be refused/);
    expect(h.deps.custody!.signGrant).not.toHaveBeenCalled();
  });
});

describe('protect — rulesets', () => {
  const gh = (args: readonly string[]): GhResult => {
    const path = args[args.length - 1] === '-' ? args[3] : args[1];
    if (path === 'repos/ashlrai/binshield') return { status: 0, stdout: JSON.stringify({ default_branch: 'main', private: false }), stderr: '' };
    if (path?.startsWith('repos/ashlrai/binshield/commits/main/check-runs')) {
      return { status: 0, stdout: JSON.stringify({ check_runs: [{ name: 'test' }, { name: 'lint' }, { name: 'test' }] }), stderr: '' };
    }
    if (path === 'repos/ashlrai/binshield/rulesets') return { status: 0, stdout: '[]', stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };

  it('--print shows the exact ruleset and changes nothing', async () => {
    const h = harness({ gh });
    expect(await runAuthorityCli(['protect', '--print', '--repo', 'ashlrai/binshield'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/required checks: lint, test/);
    expect(text).toMatch(/"actor_type": "RepositoryRole"/);
    expect(h.calls.every((c) => !c.args.includes('--method'))).toBe(true);
  });

  it('--apply asks first; declining applies nothing, --yes applies it', async () => {
    const declined = harness({ gh, confirm: false });
    expect(await runAuthorityCli(['protect', '--apply', '--repo', 'ashlrai/binshield'], declined.deps)).toBe(1);
    expect(declined.calls.some((c) => c.args.includes('POST'))).toBe(false);
    const applied = harness({ gh });
    expect(await runAuthorityCli(['protect', '--apply', '--yes', '--repo', 'ashlrai/binshield'], applied.deps)).toBe(0);
    const post = applied.calls.find((c) => c.args.includes('POST'))!;
    expect(post.args).toContain('repos/ashlrai/binshield/rulesets');
    expect(JSON.parse(post.input!)).toEqual(buildFleetRuleset(['lint', 'test']));
  });

  it('the ruleset: required checks, no force-push, no deletion, code-owner review — only the admin role bypasses', () => {
    const ruleset = buildFleetRuleset(['test', 'lint']) as { bypass_actors: unknown[]; rules: { type: string; parameters?: Record<string, unknown> }[] };
    expect(ruleset.bypass_actors).toEqual([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
    expect(ruleset.rules.map((r) => r.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    expect(ruleset.rules[2]!.parameters).toMatchObject({ require_code_owner_review: true, required_approving_review_count: 0 });
    expect(ruleset.rules[3]!.parameters).toMatchObject({ required_status_checks: [{ context: 'lint' }, { context: 'test' }] });
    expect((buildFleetRuleset([]) as { rules: { type: string }[] }).rules.map((r) => r.type)).not.toContain('required_status_checks');
  });

  it('requires heads to be up to date and pins each check to the App that reports it (U3)', () => {
    const ruleset = buildFleetRuleset([
      { context: 'test', integrationId: 15368 },
      { context: 'lint', integrationId: null },
      // The same name from a second App is ambiguous: left unpinned rather than guessed.
      { context: 'build', integrationId: 15368 },
      { context: 'build', integrationId: 999 },
    ]) as { rules: { type: string; parameters?: Record<string, unknown> }[] };
    expect(ruleset.rules[3]!.parameters).toEqual({
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'build' }, { context: 'lint' }, { context: 'test', integration_id: 15368 }],
    });
  });

  it('--print discovers the reporting App of each check from the check runs', async () => {
    const pinned = (args: readonly string[]): GhResult => {
      const path = args[1];
      if (path === 'repos/ashlrai/binshield') return { status: 0, stdout: JSON.stringify({ default_branch: 'main', private: false }), stderr: '' };
      if (path?.startsWith('repos/ashlrai/binshield/commits/main/check-runs')) {
        return { status: 0, stdout: JSON.stringify({ check_runs: [{ name: 'test', app: { id: 15368 } }, { name: 'lint', app: { id: 'x' } }] }), stderr: '' };
      }
      if (path === 'repos/ashlrai/binshield/rulesets') return { status: 0, stdout: '[]', stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    };
    const h = harness({ gh: pinned });
    expect(await runAuthorityCli(['protect', '--print', '--repo', 'ashlrai/binshield'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/"integration_id": 15368/);
    expect(text).toMatch(/"strict_required_status_checks_policy": true/);
    expect(h.calls.every((c) => !c.args.includes('--method'))).toBe(true);
  });
});

describe('github-app — the manifest flow', () => {
  it('asks for contents + PRs + checks read/write (3.13: ashlr/verify), never workflows or administration', () => {
    const manifest = buildGithubAppManifest('http://127.0.0.1:1234/callback') as { default_permissions: Record<string, string>; hook_attributes: { active: boolean }; public: boolean };
    expect(manifest.default_permissions).toEqual({ contents: 'write', pull_requests: 'write', checks: 'write', statuses: 'read', metadata: 'read' });
    expect(manifest.default_permissions).not.toHaveProperty('workflows');
    expect(manifest.default_permissions).not.toHaveProperty('administration');
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.public).toBe(false);
    const page = manifestFormPage({ ...manifest, name: 'a"b<c>' }, 'ashlrai', 'f'.repeat(32));
    expect(page).toContain('https://github.com/organizations/ashlrai/settings/apps/new?state=ffffffffffffffffffffffffffffffff');
    expect(page).toContain('&quot;');
    expect(page).not.toContain('a"b<c>');
  });

  it('receives the code on loopback, exchanges it, and hands the key straight to custody', async () => {
    const stored: { appId: string; privateKeyPem: string }[] = [];
    const h = harness({ custody: { storeGithubApp: async (c: { appId: string; privateKeyPem: string }) => { stored.push(c); } } as never });
    let exchanged = '';
    h.deps.fetch = (async (url: string) => {
      exchanged = String(url);
      return { ok: true, status: 201, json: async () => ({ id: 42, slug: 'ashlr-fleet', pem: '-----BEGIN RSA PRIVATE KEY-----\nTESTKEY\n-----END RSA PRIVATE KEY-----\n' }) };
    }) as unknown as typeof fetch;
    h.deps.openBrowser = (url: string) => {
      void (async () => {
        const page = await (await fetch(url)).text();
        const state = /state=([a-f0-9]{32})/.exec(page)![1]!;
        const wrong = await fetch(`${url}callback?code=abc&state=${'0'.repeat(32)}`);
        expect(wrong.status).toBe(400);
        await fetch(`${url}callback?code=the-code&state=${state}`);
      })();
    };
    const result = await runGithubAppFlow(h.deps as AuthorityCliDeps, { org: 'ashlrai', timeoutMs: 10_000 });
    expect(result).toEqual({ appId: '42', slug: 'ashlr-fleet', installUrl: 'https://github.com/apps/ashlr-fleet/installations/new' });
    expect(exchanged).toBe('https://api.github.com/app-manifests/the-code/conversions');
    expect(stored).toEqual([{ appId: '42', privateKeyPem: expect.stringContaining('TESTKEY') }]);
    expect([...h.out, ...h.err].join('\n')).not.toMatch(/PRIVATE KEY|TESTKEY/);
  });
});

describe('setup and the trust-root PR', () => {
  it('renders trust-roots.ts with the custody key (valid TypeScript), exactly once', () => {
    // The live file carries Mason's committed root, which setup must never
    // overwrite; render against the same file with the roots emptied, as it
    // stood before Phase 0.
    const live = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'authority', 'trust-roots.ts'), 'utf8');
    expect(renderTrustRootsWithKey(live, TEST_ROOT)).toBeNull();
    const source = live.replace(
      /export const STANDING_GRANT_TRUST_ROOTS: readonly Readonly<StandingGrantTrustRoot>\[\] = Object\.freeze\(\[[\s\S]*?\n\]\);/u,
      'export const STANDING_GRANT_TRUST_ROOTS: readonly Readonly<StandingGrantTrustRoot>[] = Object.freeze([]);',
    );
    const rendered = renderTrustRootsWithKey(source, TEST_ROOT);
    expect(rendered).not.toBeNull();
    expect(rendered).toContain(`keyId: '${TEST_ROOT.keyId}'`);
    const out = ts.transpileModule(rendered!, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    expect(out.diagnostics ?? []).toEqual([]);
    const pemLiteral = /publicKeyPem: '([^']+)'/.exec(rendered!)![1]!;
    expect(pemLiteral.replace(/\\n/g, '\n')).toBe(`${TEST_ROOT.publicKeyPem.trim()}\n`);
    expect(renderTrustRootsWithKey(rendered!, TEST_ROOT)).toBeNull();
  });

  it('only a P-256 key whose id is derived from it can be proposed', () => {
    expect(validateCustodyRoot(TEST_ROOT, keyIdForPublicKeyPem)).toBeNull();
    expect(validateCustodyRoot({ ...TEST_ROOT, publicKeyPem: ed25519RootPem() }, keyIdForPublicKeyPem)).toMatch(/P-256/);
    expect(validateCustodyRoot({ ...TEST_ROOT, keyId: 'mason-workstation' }, keyIdForPublicKeyPem)).toMatch(/burned/);
    expect(validateCustodyRoot({ ...TEST_ROOT, keyId: '../x' }, keyIdForPublicKeyPem)).toMatch(/malformed/);
    // A well-formed id that is not the key's own derivation is refused (the verifier would refuse the root).
    expect(validateCustodyRoot({ ...TEST_ROOT, keyId: 'se-p256-0000000000000000' }, keyIdForPublicKeyPem)).toMatch(/does not match the key/);
  });

  it('setup --dry-run on a fresh Mac prints the WHOLE plan past the missing sudo step, and runs nothing (3.10 review c20)', async () => {
    const h = harness();
    expect(await runAuthorityCli(['setup', '--dry-run'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/… custody helper: run `sudo scripts\/install-custody\.sh`/);
    // Every later step is described, marked as planned (·), never as done (✓).
    for (const step of ['host binding', 'signing key', 'trust root', 'deploy', 'GitHub App', 'Claude token', 'canary repo', 'rulesets', 'provenance key', 'standing grant', 'autonomy switch', 'daemon service']) {
      expect(text, step).toMatch(new RegExp(`^· ${step}: `, 'm'));
    }
    expect(text).toMatch(/^× resident runtime: blocked until a grant is active/m);
    // The only ✓ is a real local fact (the temp HOME has no ~/.ashlr/activation).
    expect(text.match(/^✓ .*/gm) ?? []).toEqual(['✓ old activation state: nothing to retire']);
    expect(text).toMatch(/Setup: 0 done, 1 already in place, 1 waiting on you, 1 blocked on a prerequisite, 0 failed, 12 planned \(dry run: nothing was asked or changed\)\./);
    expect(h.calls).toEqual([]);
    expect(h.deps.custody!.custodyInit).not.toHaveBeenCalled();
  });

  it('a REAL setup still stops at the missing sudo step', async () => {
    const h = harness({ confirm: true });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/custody helper: run `sudo/);
    expect(text).not.toMatch(/GitHub App|standing grant/);
    expect(h.calls).toEqual([]);
  });

  it('setup with a key that is not compiled in reads its public half back, waits for Mason’s PR and signs nothing', async () => {
    const custodyPublicKey = vi.fn(async () => ({ keyId: TEST_ROOT.keyId, publicKeyPem: TEST_ROOT.publicKeyPem }));
    const h = harness({
      custody: {
        custodyStatus: async () => ({ installed: true, version: '1.0', keyInitialized: true, keyId: TEST_ROOT.keyId, githubApp: false, claudeToken: false, checkedAt: new Date().toISOString(), reasons: [] }),
        custodyHostBinding: async () => 'a'.repeat(64),
        custodyPublicKey,
        keyIdForPublicKeyPem,
      } as never,
    });
    expect(await runAuthorityCli(['setup', '--dry-run'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/host binding: this Mac is aaaaaaaaaaaa/);
    expect(custodyPublicKey).toHaveBeenCalledTimes(1);
    // --dry-run never opens the PR: it stops at the trust root, waiting on Mason.
    expect(text).toMatch(/… trust root: /);
    expect(text).toMatch(/… deploy: after you merge that PR/);
    // ...and still shows the rest of the plan after the trust-root wait (c20).
    expect(text).toMatch(/^· GitHub App: /m);
    expect(text).toMatch(/^· standing grant: would sign the first standing grant/m);
    expect(h.calls.filter((c) => c.bin === 'git' || c.args[0] === 'pr')).toEqual([]);
    expect(h.deps.custody!.signGrant).not.toHaveBeenCalled();
  });

  it('setup refuses to go on when ashlr-custody and this release disagree on the host binding', async () => {
    const custodyPublicKey = vi.fn(async () => ({ keyId: TEST_ROOT.keyId, publicKeyPem: TEST_ROOT.publicKeyPem }));
    const h = harness({
      custody: {
        custodyStatus: async () => ({ installed: true, version: '1.0', keyInitialized: true, keyId: TEST_ROOT.keyId, githubApp: false, claudeToken: false, checkedAt: new Date().toISOString(), reasons: [] }),
        custodyHostBinding: async () => 'f'.repeat(64),
        custodyPublicKey,
        keyIdForPublicKeyPem,
      } as never,
    });
    expect(await runAuthorityCli(['setup', '--dry-run'], h.deps)).toBe(1);
    expect(h.out.join('\n')).toMatch(/✗ host binding: ashlr-custody and this release disagree/);
    expect(custodyPublicKey).not.toHaveBeenCalled();
    expect(h.deps.custody!.custodyInit).not.toHaveBeenCalled();
    expect(h.deps.custody!.signGrant).not.toHaveBeenCalled();
  });

  it('rotate-provenance asks first, then moves the old key aside', async () => {
    const declined = harness({ confirm: false });
    expect(await runAuthorityCli(['rotate-provenance'], declined.deps)).toBe(1);
    const h = harness();
    expect(await runAuthorityCli(['rotate-provenance', '--yes'], h.deps)).toBe(0);
    const keyPath = join(home, '.ashlr', 'foundry', 'provenance.key');
    const first = readFileSync(keyPath);
    expect(await runAuthorityCli(['rotate-provenance', '--yes'], h.deps)).toBe(0);
    expect(readFileSync(keyPath).equals(first)).toBe(false);
    expect(h.out.join('\n')).toMatch(/old key was moved/);
  });
});
