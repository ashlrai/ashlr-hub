import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawn, execFileSync: vi.fn(), execFile: vi.fn() }));

import {
  reconstructLocusProviderScopeEnv, validateExistingLocusSession,
  type LocusCiMint, type LocusProviderScope,
} from '../src/core/integrations/locus.js';

const standardSelectors = [
  'SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID', 'VERCEL_ORG_ID', 'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID', 'AWS_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID',
];

describe('live Locus ProviderView selector reconstruction', () => {
  it('maps every provable standard selector alongside provider-local frozen fields', () => {
    const env = reconstructLocusProviderScopeEnv([
      { provider: 'supabase', account: 'supabase-account', project_ref: 'project-ref', read_only: true },
      { provider: 'vercel', account: 'vercel-account', team_id: 'team-id', project_ref: 'generic-project-ref' },
      { provider: 'aws', account: 'aws-account', account_id: 'aws-account-id' },
      { provider: 'cloudflare', account: 'cloudflare-account', account_id: 'cloudflare-account-id' },
      { provider: 'github', account: 'github-account', orgs: ['org-a', 'org-b'], repos: ['org-a/repo'] },
    ]);
    expect(env).toMatchObject({
      SUPABASE_PROJECT_REF: 'project-ref', SUPABASE_PROJECT_ID: 'project-ref',
      VERCEL_ORG_ID: 'team-id', VERCEL_TEAM_ID: 'team-id',
      AWS_ACCOUNT_ID: 'aws-account-id', CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
      LOCUS_SUPABASE_PROJECT_REF: 'project-ref', LOCUS_SUPABASE_READ_ONLY: 'true',
      LOCUS_VERCEL_PROJECT_REF: 'generic-project-ref', LOCUS_VERCEL_TEAM_ID: 'team-id',
      LOCUS_AWS_ACCOUNT_ID: 'aws-account-id', LOCUS_CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
      LOCUS_GITHUB_ORGS: 'org-a,org-b', LOCUS_GITHUB_REPOS: 'org-a/repo',
    });
    for (const provider of ['SUPABASE', 'VERCEL', 'AWS', 'CLOUDFLARE', 'GITHUB']) {
      expect(env[`LOCUS_${provider}_CREDENTIAL_RESOLVED`]).toBe('0');
    }
    expect(env.VERCEL_PROJECT_ID).toBeUndefined();
    expect(env.LOCUS_VERCEL_PROJECTS).toBeUndefined();
  });

  it.each([
    ['SuPaBaSe', { project_ref: 'project' }, 'SUPABASE_PROJECT_REF', 'project'],
    ['VERCEL', { team_id: 'team' }, 'VERCEL_ORG_ID', 'team'],
    ['AWS', { account_id: 'account' }, 'AWS_ACCOUNT_ID', 'account'],
    ['CloudFlare', { account_id: 'account' }, 'CLOUDFLARE_ACCOUNT_ID', 'account'],
  ])('matches Locus case-insensitive mapping for %s', (provider, scope, key, value) => {
    const env = reconstructLocusProviderScopeEnv([{ provider, account: 'label', ...scope }]);
    expect(env[key]).toBe(value);
  });

  it('omits absent selectors and preserves an explicit false read-only scope', () => {
    const env = reconstructLocusProviderScopeEnv([
      { provider: 'supabase', account: 'a', project_ref: null, read_only: false, orgs: [], repos: [] },
      { provider: 'vercel', account: 'b', team_id: null },
      { provider: 'aws', account: 'c', account_id: null },
      { provider: 'cloudflare', account: 'd' },
    ]);
    for (const key of standardSelectors) expect(env[key]).toBeUndefined();
    expect(env.LOCUS_SUPABASE_READ_ONLY).toBe('false');
    expect(env.LOCUS_SUPABASE_ORGS).toBeUndefined();
    expect(env.LOCUS_SUPABASE_REPOS).toBeUndefined();
  });

  it('never interprets generic project_ref as Vercel scope.projects[0]', () => {
    const provider = {
      provider: 'vercel', account: 'label', project_ref: 'wrong-semantics',
      projects: ['unverified-project'], env: { VERCEL_PROJECT_ID: 'unverified-project' },
    };
    const env = reconstructLocusProviderScopeEnv([provider]);
    expect(env.LOCUS_VERCEL_PROJECT_REF).toBe('wrong-semantics');
    expect(env.VERCEL_PROJECT_ID).toBeUndefined();
    expect(env.LOCUS_VERCEL_PROJECTS).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('unverified-project');
  });

  it('does not assign other providers’ selectors from lookalike scope fields', () => {
    const env = reconstructLocusProviderScopeEnv([
      { provider: 'github', account: 'github', project_ref: 'project', team_id: 'team', account_id: 'account' },
    ]);
    for (const key of standardSelectors) expect(env[key]).toBeUndefined();
    expect(env.LOCUS_GITHUB_PROJECT_REF).toBe('project');
    expect(env.LOCUS_GITHUB_TEAM_ID).toBe('team');
    expect(env.LOCUS_GITHUB_ACCOUNT_ID).toBe('account');
  });

  it('is pure and creates independent output maps', () => {
    const provider = Object.freeze({ provider: 'aws', account: 'label', account_id: 'account' });
    const providers = Object.freeze([provider]);
    const first = reconstructLocusProviderScopeEnv(providers);
    first.AWS_ACCOUNT_ID = 'changed';
    expect(reconstructLocusProviderScopeEnv(providers).AWS_ACCOUNT_ID).toBe('account');
    expect(provider.account_id).toBe('account');
  });
});

describe('verified session uses only live provider selectors', () => {
  let home: string;
  const session = 'ses_012abc';
  const executor = 'a'.repeat(64);
  const providers: LocusProviderScope[] = [
    { provider: 'supabase', account: 'a', project_ref: 'live-project' },
    { provider: 'vercel', account: 'b', team_id: 'live-team', project_ref: 'generic-project-ref' },
    { provider: 'aws', account: 'c', account_id: 'live-aws' },
    { provider: 'cloudflare', account: 'd', account_id: 'live-cloudflare' },
  ];
  function identity() {
    return {
      session_id: session, binding_alias: 'scoped', binding_id: 'binding-scoped', tenant: 'tenant-scoped',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      worker_home: join(home, 'workers', session), seal: 'synthetic-seal',
      seal_ok: true, authority_anchor_ok: true, authority: 'delegated', backing_type: 'ci',
      backing_path: join(home, 'sessions', 'ci-012abc.json'), frozen: false, providers,
    };
  }
  function parent(info = identity()): NodeJS.ProcessEnv {
    return {
      LOCUS_HOME: home, LOCUS_SESSION_ID: session, LOCUS_EXECUTOR_CAPABILITY: executor,
      LOCUS_BINDING: info.binding_alias, LOCUS_BINDING_ID: info.binding_id, LOCUS_TENANT: info.tenant,
      LOCUS_SEAL: info.seal, LOCUS_WORKER_HOME: info.worker_home, LOCUS_EXPIRES_AT: info.expires_at,
      LOCUS_PROVIDERS: info.providers.map(provider => provider.provider).join(','),
      SUPABASE_PROJECT_REF: 'ambient-project', SUPABASE_PROJECT_ID: 'ambient-project',
      VERCEL_ORG_ID: 'ambient-team', VERCEL_TEAM_ID: 'ambient-team', VERCEL_PROJECT_ID: 'unverified-project',
      AWS_ACCOUNT_ID: 'ambient-aws', CLOUDFLARE_ACCOUNT_ID: 'ambient-cloudflare',
      LOCUS_VERCEL_PROJECTS: 'unverified-project', LOCUS_SUPABASE_PROJECT_REF: 'ambient-project',
      GH_TOKEN: 'synthetic-credential-canary', VERCEL_TOKEN: 'synthetic-credential-canary',
    };
  }
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'locus-provider-scope-')));
    mkdirSync(join(home, 'workers', session), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'sessions'), { mode: 0o700 });
    writeFileSync(join(home, 'sessions', 'ci-012abc.json'), 'synthetic metadata only', { mode: 0o600 });
    mocked.spawn.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  it('reconstructs standard selectors and discards stale inherited scopes and credentials', () => {
    const info = identity();
    mocked.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify(info), stderr: '' });
    const handle = validateExistingLocusSession(parent(info));
    expect(handle.env).toMatchObject({
      SUPABASE_PROJECT_REF: 'live-project', SUPABASE_PROJECT_ID: 'live-project',
      VERCEL_ORG_ID: 'live-team', VERCEL_TEAM_ID: 'live-team',
      AWS_ACCOUNT_ID: 'live-aws', CLOUDFLARE_ACCOUNT_ID: 'live-cloudflare',
      LOCUS_SUPABASE_PROJECT_REF: 'live-project', LOCUS_VERCEL_PROJECT_REF: 'generic-project-ref',
    });
    expect(handle.env.VERCEL_PROJECT_ID).toBeUndefined();
    expect(handle.env.LOCUS_VERCEL_PROJECTS).toBeUndefined();
    expect(handle.env.GH_TOKEN).toBeUndefined();
    expect(handle.env.VERCEL_TOKEN).toBeUndefined();
    expect(JSON.stringify(handle.env)).not.toContain('ambient-');
    expect(JSON.stringify(handle.env)).not.toContain('synthetic-credential-canary');
    expect(Object.isFrozen(handle.env)).toBe(true);
    expect(mocked.spawn.mock.calls[0][1]).toEqual(['whoami', '--json']);
  });

  it('does not restore unattested project lists from mint env or extra whoami fields', () => {
    const info = identity();
    const response = { ...info, providers: info.providers.map(provider => ({ ...provider, projects: ['unverified-project'] })) };
    mocked.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify(response), stderr: '' });
    const mint: LocusCiMint = {
      session_id: info.session_id, binding: info.binding_alias, binding_id: info.binding_id,
      tenant: info.tenant, expires_at: info.expires_at, seal: info.seal, path: info.backing_path,
      worker_home: info.worker_home, secrets_resolved: false,
      env: { VERCEL_PROJECT_ID: 'unverified-project', LOCUS_VERCEL_PROJECTS: 'unverified-project' },
    };
    const handle = validateExistingLocusSession(parent(info), mint);
    expect(handle.env.VERCEL_PROJECT_ID).toBeUndefined();
    expect(handle.env.LOCUS_VERCEL_PROJECTS).toBeUndefined();
    expect(JSON.stringify(handle.env)).not.toContain('unverified-project');
  });

  it.each([
    ['project_ref', 'bad\nproject'], ['team_id', 'env:UNTRUSTED'], ['account_id', 'test:UNTRUSTED'],
  ])('rejects malformed live %s instead of emitting a selector', (key, value) => {
    const info = identity();
    mocked.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({
      ...info, providers: [{ provider: 'supabase', account: 'a', [key]: value }],
    }), stderr: '' });
    expect(() => validateExistingLocusSession({ ...parent(info), LOCUS_PROVIDERS: 'supabase' })).toThrow(/invalid providers/);
  });
});
