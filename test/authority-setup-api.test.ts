/**
 * GET /api/verse/authority/setup — Verse's live setup checklist
 * (src/core/verse/authority-api.ts → src/cli/authority.ts planAuthoritySetup).
 *
 *   - answers the dry run's AuthoritySetupReportV1 (the same planning path
 *     `ashlr authority setup --dry-run --json` prints), read-only
 *   - GET only, no query; anything else is refused
 *   - cached 30 s, one probe shared by concurrent readers, dropped when an
 *     authority action succeeds; a failing probe is 503 and is retried
 *
 * The planner runs the REAL planning path with injected fakes (custody, gh):
 * no helper, no network, no prompt. HOME-isolated.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This Mac's identity, as the custody fake reports it (no ioreg in tests).
vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

import { isReadOnlyGhApiCall, planAuthoritySetup, type AuthorityCliDeps, type GhResult } from '../src/cli/authority.js';
import { STANDING_GRANT_TRUST_ROOTS } from '../src/core/authority/trust-roots.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import { invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import type { AuthoritySetupReportV1 } from '../src/core/authority/types.js';
import { handleAuthorityApi, resetAuthorityApiCachesForTest, setAuthoritySetupPlannerForTest } from '../src/core/verse/authority-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

const TOKEN = 'setup-api-test-token';
let restore: () => void;
let ctx: VerseApiContext;

beforeEach(() => {
  restore = withTempHome('setup-api-').restore;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  resetAuthorityApiCachesForTest();
});

afterEach(() => {
  resetAuthorityApiCachesForTest();
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  restore();
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0;
  let payload = '';
  const fake = { headersSent: false };
  const res = Object.assign(fake, {
    writeHead(code: number) {
      status = code;
      fake.headersSent = true;
      return fake;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return fake;
    },
    setHeader() {
      return fake;
    },
  }) as unknown as ServerResponse;
  const handled = await handleAuthorityApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  if (!handled) return null;
  return { status, body: JSON.parse(payload || 'null') as Record<string, unknown> };
}

/** A fresh Mac: no custody helper yet. Every external effect is a fake that records what it was asked. */
function freshMacPlanner() {
  const gh: string[][] = [];
  const custody = {
    custodyStatus: async () => ({ installed: false, version: null, keyInitialized: null, keyId: null, githubApp: null, claudeToken: null, checkedAt: new Date().toISOString(), reasons: [] }),
    custodyHostBinding: vi.fn(async () => { throw new Error('not in this test'); }),
    custodyPublicKey: vi.fn(async () => { throw new Error('not in this test'); }),
    custodyInit: vi.fn(async () => { throw new Error('never'); }),
    signGrant: vi.fn(async () => { throw new Error('never'); }),
    githubToken: vi.fn(async () => { throw new Error('never'); }),
    keyIdForPublicKeyPem,
  } as unknown as AuthorityCliDeps['custody'];
  const planner = vi.fn(() => planAuthoritySetup({
    custody,
    run: async (_bin, args): Promise<GhResult> => {
      gh.push([...args]);
      return { status: 1, stdout: '', stderr: 'offline' };
    },
    daemonService: async () => 'not-loaded',
  }));
  return { planner, gh, custody };
}

describe('GET /api/verse/authority/setup', () => {
  it('answers the dry run’s checklist: every step, what each needs, the one next step and its command', async () => {
    const { planner, gh, custody } = freshMacPlanner();
    setAuthoritySetupPlannerForTest(planner);
    const res = await call('GET', '/api/verse/authority/setup');
    expect(res?.status).toBe(200);
    const report = res!.body as unknown as AuthoritySetupReportV1;
    expect(report).toMatchObject({ schema: 'ashlr.authority-setup.v1', dryRun: true, complete: false, next: 'custody-helper' });
    expect(report.steps).toHaveLength(15);
    expect(report.steps[0]).toMatchObject({ id: 'custody-helper', status: 'waiting-on-you', needs: ['sudo', 'terminal'], command: 'sudo scripts/install-custody.sh' });
    expect(report.steps.at(-1)).toMatchObject({ id: 'resident-runtime', status: 'blocked', command: 'ashlr authority grant' });
    // A fresh Mac plans past the missing helper without touching custody or GitHub.
    expect(gh).toEqual([]);
    expect(custody.signGrant).not.toHaveBeenCalled();
    expect(custody.custodyInit).not.toHaveBeenCalled();
  });

  it('is GET-only with no query, and does not swallow neighbouring paths', async () => {
    setAuthoritySetupPlannerForTest(freshMacPlanner().planner);
    expect((await call('GET', '/api/verse/authority/setup?refresh=1'))?.status).toBe(400);
    expect((await call('POST', '/api/verse/authority/setup', {}))?.status).toBe(404);
    expect((await call('PUT', '/api/verse/authority/setup', {}))?.status).toBe(404);
    expect(await call('GET', '/api/verse/authority/setupx')).toBeNull();
  });

  it('is cached, shares one probe between concurrent readers, and forgets after an authority action', async () => {
    const { planner } = freshMacPlanner();
    setAuthoritySetupPlannerForTest(planner);
    const [a, b] = await Promise.all([call('GET', '/api/verse/authority/setup'), call('GET', '/api/verse/authority/setup')]);
    expect([a?.status, b?.status]).toEqual([200, 200]);
    expect(planner).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/api/verse/authority/setup'))?.status).toBe(200);
    expect(planner).toHaveBeenCalledTimes(1);
    // Lowering never needs anything; a successful action drops the cached checklist.
    expect((await call('POST', '/api/verse/authority', { action: 'switch', to: 'off' }))?.status).toBe(200);
    expect((await call('GET', '/api/verse/authority/setup'))?.status).toBe(200);
    expect(planner).toHaveBeenCalledTimes(2);
  });

  it('a probe that fails is 503 (no internals), and the next read tries again', async () => {
    const planner = vi.fn()
      .mockRejectedValueOnce(new Error('gh exploded at /Users/someone/secret'))
      .mockImplementation(freshMacPlanner().planner);
    setAuthoritySetupPlannerForTest(planner);
    const failed = await call('GET', '/api/verse/authority/setup');
    expect(failed).toEqual({ status: 503, body: { code: 'setup-unavailable', error: 'the setup checklist could not be read' } });
    expect((await call('GET', '/api/verse/authority/setup'))?.status).toBe(200);
    expect(planner).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/verse/authority/setup — the trust-root PR, found with gh api reads', () => {
  const BRANCH = `authority/trust-root-${TEST_ROOT.keyId}`;
  const PR = 'https://github.com/ashlrai/ashlr-hub/pull/512';

  /** A Mac with the helper and key in place, the key not yet compiled in; GitHub answers only `gh api` reads. */
  function keyNotCompiledIn(state: { open?: boolean; merged?: boolean; pushed?: boolean }) {
    const calls: string[][] = [];
    const custody = {
      custodyStatus: async () => ({ installed: true, version: '1.0', keyInitialized: true, keyId: TEST_ROOT.keyId, githubApp: false, claudeToken: false, checkedAt: new Date().toISOString(), reasons: [] }),
      custodyHostBinding: async () => 'a'.repeat(64),
      custodyPublicKey: async () => ({ keyId: TEST_ROOT.keyId, publicKeyPem: TEST_ROOT.publicKeyPem }),
      custodyInit: vi.fn(async () => { throw new Error('never'); }),
      signGrant: vi.fn(async () => { throw new Error('never'); }),
      githubToken: vi.fn(async () => { throw new Error('never'); }),
      keyIdForPublicKeyPem,
    } as unknown as AuthorityCliDeps['custody'];
    const run = async (bin: 'gh' | 'git', args: readonly string[]): Promise<GhResult> => {
      calls.push([bin, ...args]);
      if (!isReadOnlyGhApiCall(bin, args)) return { status: 1, stdout: '', stderr: 'refused' };
      const path = args[1]!;
      const ok = (value: unknown): GhResult => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
      if (path.startsWith('repos/ashlrai/ashlr-hub/pulls?')) return ok(state.open ? [{ html_url: PR }] : []);
      if (path === 'repos/ashlrai/ashlr-hub') return ok({ default_branch: 'master' });
      if (path.startsWith('repos/ashlrai/ashlr-hub/contents/src/core/authority/trust-roots.ts?ref=master')) {
        const source = state.merged ? `keyId: '${TEST_ROOT.keyId}',` : 'Object.freeze([]);';
        return ok({ encoding: 'base64', content: Buffer.from(source).toString('base64') });
      }
      if (path === `repos/ashlrai/ashlr-hub/git/ref/heads/${BRANCH}` && state.pushed) return ok({ ref: `refs/heads/${BRANCH}` });
      return { status: 1, stdout: '', stderr: 'HTTP 404' };
    };
    setAuthoritySetupPlannerForTest(() => planAuthoritySetup({ custody, run, daemonService: async () => 'not-loaded' }));
    return { calls, custody };
  }

  const trustRootStep = async (): Promise<AuthoritySetupReportV1['steps'][number]> => {
    const res = await call('GET', '/api/verse/authority/setup');
    expect(res?.status).toBe(200);
    const report = res!.body as unknown as AuthoritySetupReportV1;
    expect(report.next).toBe('trust-root');
    return report.steps.find((s) => s.id === 'trust-root')!;
  };

  it('this build carries no trust root for the test key (the premise of these cases)', () => {
    expect(STANDING_GRANT_TRUST_ROOTS.some((root) => root.keyId === TEST_ROOT.keyId)).toBe(false);
  });

  it('an open PR: the step links it', async () => {
    const { calls, custody } = keyNotCompiledIn({ open: true, merged: true, pushed: true });
    expect(await trustRootStep()).toMatchObject({ status: 'waiting-on-you', detail: `${PR} is already open — review and merge it yourself`, link: PR, command: null });
    expect(calls.every(([bin, ...args]) => isReadOnlyGhApiCall(bin as 'gh', args))).toBe(true);
    expect(custody.signGrant).not.toHaveBeenCalled();
  });

  it('a merged key: install a release built after it', async () => {
    keyNotCompiledIn({ merged: true });
    expect(await trustRootStep()).toMatchObject({ status: 'waiting-on-you', command: 'npm run build', detail: expect.stringMatching(/is merged on master, but this release was built before it — install a release built after it$/) });
  });

  it('a pushed branch with no PR: rerun setup', async () => {
    const { calls } = keyNotCompiledIn({ pushed: true });
    expect(await trustRootStep()).toMatchObject({ status: 'waiting-on-you', command: 'ashlr authority setup', detail: `${BRANCH} was pushed by an earlier run but has no PR yet — rerun setup to open it` });
    expect(calls.every(([bin, ...args]) => isReadOnlyGhApiCall(bin as 'gh', args))).toBe(true);
  });
});
