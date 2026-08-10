/**
 * Pure-helper unit tests for src/core/integrations/locus.ts.
 * No real spawn — only parse/gate helpers (fail-closed contract).
 * Site-wiring tests mock applyLocusPreMutateGate so LOCUS_ENFORCE is exercised
 * without a real locus CLI (monorepo-safe).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  REQUIRED_SERVERS,
  parseStatusOneline,
  isStatusOnelineHealthy,
  canMutate,
  parseRequiredServers,
  hasRequiredServers,
  parseAgentReportJson,
  evaluateFleetGate,
  blockersFromAgentReport,
  mergeLocusIntoMcpConfig,
  locusServerSpec,
  missingAgentReportKeys,
  scrubbedChildEnv,
  validateMintEnv,
  applyLocusSessionEnv,
  parseLocusEnforceToken,
  extractLocusConfigEnforce,
  resolveLocusEnforceMode,
  decidePreMutateGate,
  decideLocusSessionRun,
  formatPreMutateBlockers,
  applyLocusPreMutateGate,
  assertLocusPreMutate,
  LocusMintError,
} from '../src/core/integrations/locus.js';

describe('REQUIRED_SERVERS', () => {
  it('is the identity + secret safety pair', () => {
    expect([...REQUIRED_SERVERS]).toEqual(['locus', 'phantom']);
  });
});

describe('parseStatusOneline', () => {
  it('marks healthy alias:tenant pins', () => {
    const p = parseStatusOneline('acme:acme-corp');
    expect(p.kind).toBe('pinned');
    expect(p.healthy).toBe(true);
    expect(p.alias).toBe('acme');
    expect(p.tenant).toBe('acme-corp');
  });

  it.each(['unpinned', 'require_pin', 'frozen', 'invalid', ''])(
    'fails closed for %s',
    (raw) => {
      const p = parseStatusOneline(raw);
      expect(p.healthy).toBe(false);
    },
  );

  it('treats unknown tokens as invalid', () => {
    const p = parseStatusOneline('weird-token');
    expect(p.kind).toBe('invalid');
    expect(p.healthy).toBe(false);
  });
});

describe('canMutate / isStatusOnelineHealthy', () => {
  it('allows only ready + healthy oneline', () => {
    expect(canMutate('ready', 'personal:personal')).toBe(true);
    expect(canMutate('ready', 'unpinned')).toBe(false);
    expect(canMutate('protected', 'personal:personal')).toBe(false);
    expect(canMutate('unsafe', 'personal:personal')).toBe(false);
    expect(isStatusOnelineHealthy('personal:personal')).toBe(true);
  });
});

describe('required servers helpers', () => {
  it('parseRequiredServers drops non-strings', () => {
    expect(parseRequiredServers(['locus', 1, 'phantom', null])).toEqual([
      'locus',
      'phantom',
    ]);
    expect(parseRequiredServers('nope')).toEqual([]);
  });

  it('hasRequiredServers requires both locus and phantom', () => {
    expect(hasRequiredServers(['locus', 'phantom'])).toBe(true);
    expect(hasRequiredServers(['LOCUS', 'Phantom'])).toBe(true);
    expect(hasRequiredServers(['locus'])).toBe(false);
    expect(hasRequiredServers(['ashlr', 'phantom-secrets'])).toBe(false);
    expect(hasRequiredServers(null)).toBe(false);
  });
});

describe('parseAgentReportJson / fleet gate', () => {
  const sample = {
    version: '1',
    ready: true,
    status: 'ready',
    status_oneline: 'acme:acme',
    home: '/tmp',
    pin: { seal_ok: true, expired: false, frozen: false },
    mcp_registered: { claude: true, cursor: false, codex: false },
    doctor: {},
    commands: {},
    required_servers: ['locus', 'phantom'],
    mcp_command: 'locus-mcp',
    exit_code: 0,
  };

  it('parses report JSON', () => {
    const r = parseAgentReportJson(JSON.stringify(sample));
    expect(r.status).toBe('ready');
    expect(missingAgentReportKeys(r)).toEqual([]);
  });

  it('evaluateFleetGate allows healthy ready reports', () => {
    const g = evaluateFleetGate(sample as never);
    expect(g.allowDispatch).toBe(true);
    expect(g.blockers).toEqual([]);
    expect(g.gateOk).toBe(true);
  });

  it('blockersFromAgentReport fails closed without report', () => {
    expect(blockersFromAgentReport(null)).toContain('no agent report');
  });

  it('blocks unpinned / missing servers', () => {
    const bad = {
      ...sample,
      ready: false,
      status: 'protected',
      status_oneline: 'unpinned',
      required_servers: ['locus'],
    };
    const blockers = blockersFromAgentReport(bad as never);
    expect(blockers.some((b) => b.includes('not ready') || b.includes('status='))).toBe(true);
    expect(blockers.some((b) => b.includes('unhealthy') || b.includes('unpinned'))).toBe(true);
    expect(blockers.some((b) => b.includes('required_servers'))).toBe(true);
  });

  it('blocks credential migration incomplete doctor finding', () => {
    const bad = {
      ...sample,
      doctor: {
        findings: [{ code: 'credential_migration_incomplete', severity: 'error' }],
      },
    };
    const blockers = blockersFromAgentReport(bad as never);
    expect(blockers).toContain('credential migration reconciliation incomplete');
    expect(evaluateFleetGate(bad as never).allowDispatch).toBe(false);
  });
});

describe('scrubbedChildEnv', () => {
  it('drops ambient credentials and keeps runtime basics', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      AWS_PROFILE: 'personal',
      GH_TOKEN: 'gho_secret',
      SUPABASE_SERVICE_ROLE_KEY: 'srk',
      VERCEL_TOKEN: 'v',
      ANTHROPIC_API_KEY: 'sk-ant',
      LOCUS_HOME: '/should/not/inherit',
      CUSTOM: 'nope',
    };
    const clean = scrubbedChildEnv(parent, { LOCUS_SESSION_ID: 'sess-1' });
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.HOME).toBe('/home/u');
    expect(clean.LANG).toBe('en_US.UTF-8');
    expect(clean.LC_ALL).toBe('C');
    expect(clean.LOCUS_SESSION_ID).toBe('sess-1');
    expect(clean.AWS_PROFILE).toBeUndefined();
    expect(clean.GH_TOKEN).toBeUndefined();
    expect(clean.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(clean.VERCEL_TOKEN).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.LOCUS_HOME).toBeUndefined();
    expect(clean.CUSTOM).toBeUndefined();
  });

  it('lets explicit overrides win over parent runtime keys', () => {
    const clean = scrubbedChildEnv(
      { PATH: '/old', HOME: '/old-home' },
      { PATH: '/new' },
    );
    expect(clean.PATH).toBe('/new');
    expect(clean.HOME).toBe('/old-home');
  });
});

describe('validateMintEnv', () => {
  it('accepts identity + scope keys with plain string values', () => {
    const env = validateMintEnv({
      LOCUS_SESSION_ID: 'abc',
      LOCUS_BINDING: 'acme',
      LOCUS_TENANT: 'acme-corp',
      GH_CONFIG_DIR: '/tmp/gh',
      SUPABASE_PROJECT_REF: 'xyz',
      LOCUS_SUPABASE_PROJECT_REF: 'xyz',
      LOCUS_GITHUB_ORGS: 'ashlrai',
    });
    expect(env.LOCUS_SESSION_ID).toBe('abc');
    expect(env.SUPABASE_PROJECT_REF).toBe('xyz');
  });

  it('rejects non-objects, credential-ref values, and disallowed keys', () => {
    expect(() => validateMintEnv(null)).toThrow(LocusMintError);
    expect(() => validateMintEnv([])).toThrow(LocusMintError);
    expect(() =>
      validateMintEnv({ LOCUS_SESSION_ID: 'phm:NAME' }),
    ).toThrow(/disallowed env metadata/);
    expect(() =>
      validateMintEnv({ LOCUS_SESSION_ID: 'env:FOO' }),
    ).toThrow(/disallowed env metadata/);
    expect(() =>
      validateMintEnv({ AWS_SECRET_ACCESS_KEY: 'x' }),
    ).toThrow(/disallowed env metadata/);
    expect(() =>
      validateMintEnv({ LOCUS_SESSION_ID: 1 as never }),
    ).toThrow(/disallowed env metadata/);
  });
});

describe('pre-mutate gate decisions (LOCUS_ENFORCE)', () => {
  const blockedGate = {
    allowDispatch: false,
    blockers: ['pin unhealthy: unpinned (unpinned)'],
    gateOk: false,
    status: 'protected',
    status_oneline: 'unpinned',
    available: true,
  };
  const openGate = {
    allowDispatch: true,
    blockers: [] as string[],
    gateOk: true,
    status: 'ready',
    status_oneline: 'acme:acme',
    available: true,
  };

  it('resolveLocusEnforceMode maps env tokens', () => {
    expect(resolveLocusEnforceMode({})).toBe('off');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: '' })).toBe('off');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: '0' })).toBe('off');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'off' })).toBe('off');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'warn' })).toBe('warn');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'log' })).toBe('warn');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: '1' })).toBe('enforce');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'true' })).toBe('enforce');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'yes' })).toBe('enforce');
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'enforce' })).toBe('enforce');
    // Unknown → fail closed to enforce
    expect(resolveLocusEnforceMode({ LOCUS_ENFORCE: 'maybe' })).toBe('enforce');
  });

  it('resolveLocusEnforceMode: env wins over config, then config, then off', () => {
    // Both unset → monorepo-safe default off (never always-on)
    expect(resolveLocusEnforceMode({}, null)).toBe('off');
    expect(resolveLocusEnforceMode({}, undefined)).toBe('off');
    expect(resolveLocusEnforceMode({}, {})).toBe('off');
    expect(resolveLocusEnforceMode({}, { locus: {} })).toBe('off');

    // Config alone
    expect(resolveLocusEnforceMode({}, { enforce: 'warn' })).toBe('warn');
    expect(resolveLocusEnforceMode({}, { locus: { enforce: 'enforce' } })).toBe(
      'enforce',
    );
    expect(resolveLocusEnforceMode({}, { locus: { enforce: 'off' } })).toBe(
      'off',
    );
    expect(resolveLocusEnforceMode({}, { locus: { enforce: 'warn' } })).toBe(
      'warn',
    );

    // Full AshlrConfig-shaped object
    expect(
      resolveLocusEnforceMode({}, { version: 1, locus: { enforce: 'enforce' } } as never),
    ).toBe('enforce');

    // Env wins — including explicit off overriding firm config
    expect(
      resolveLocusEnforceMode(
        { LOCUS_ENFORCE: 'off' },
        { locus: { enforce: 'enforce' } },
      ),
    ).toBe('off');
    expect(
      resolveLocusEnforceMode(
        { LOCUS_ENFORCE: '0' },
        { locus: { enforce: 'enforce' } },
      ),
    ).toBe('off');
    expect(
      resolveLocusEnforceMode(
        { LOCUS_ENFORCE: 'warn' },
        { locus: { enforce: 'enforce' } },
      ),
    ).toBe('warn');
    expect(
      resolveLocusEnforceMode(
        { LOCUS_ENFORCE: 'enforce' },
        { locus: { enforce: 'off' } },
      ),
    ).toBe('enforce');
    // Empty env string is set → off (wins over config)
    expect(
      resolveLocusEnforceMode(
        { LOCUS_ENFORCE: '' },
        { locus: { enforce: 'enforce' } },
      ),
    ).toBe('off');
  });

  it('parseLocusEnforceToken + extractLocusConfigEnforce helpers', () => {
    expect(parseLocusEnforceToken(undefined)).toBe('off');
    expect(parseLocusEnforceToken('WARN')).toBe('warn');
    expect(parseLocusEnforceToken('block')).toBe('enforce');
    expect(extractLocusConfigEnforce(null)).toBeUndefined();
    expect(extractLocusConfigEnforce({ enforce: 'warn' })).toBe('warn');
    expect(extractLocusConfigEnforce({ locus: { enforce: 'enforce' } })).toBe(
      'enforce',
    );
    expect(extractLocusConfigEnforce({ locus: {} })).toBeUndefined();
  });

  it('decideLocusSessionRun consults config when env unset', () => {
    expect(
      decideLocusSessionRun({}, { locus: { enforce: 'enforce' } }),
    ).toMatchObject({ kind: 'refuse', mode: 'enforce' });
    expect(
      decideLocusSessionRun({}, { locus: { enforce: 'warn' } }),
    ).toMatchObject({ kind: 'warn', mode: 'warn' });
    // Env off beats firm config
    expect(
      decideLocusSessionRun(
        { LOCUS_ENFORCE: 'off' },
        { locus: { enforce: 'enforce' } },
      ),
    ).toEqual({ kind: 'pass-through', mode: 'off' });
  });

  it('mode=off always allows without surfacing blockers', () => {
    const d = decidePreMutateGate(blockedGate, 'off');
    expect(d.allow).toBe(true);
    expect(d.blockers).toEqual([]);
    expect(d.shouldWarn).toBe(false);
  });

  it('mode=warn allows but surfaces unpinned blockers', () => {
    const d = decidePreMutateGate(blockedGate, 'warn');
    expect(d.allow).toBe(true);
    expect(d.shouldWarn).toBe(true);
    expect(d.blockers).toContain('pin unhealthy: unpinned (unpinned)');
    expect(formatPreMutateBlockers(d)).toMatch(/unpinned/);
  });

  it('mode=enforce refuses unpinned / unhealthy gate', () => {
    const d = decidePreMutateGate(blockedGate, 'enforce');
    expect(d.allow).toBe(false);
    expect(d.shouldWarn).toBe(false);
    expect(d.blockers.length).toBeGreaterThan(0);
    expect(d.status_oneline).toBe('unpinned');
  });

  it('mode=enforce allows healthy ready gate', () => {
    const d = decidePreMutateGate(openGate, 'enforce');
    expect(d.allow).toBe(true);
    expect(d.blockers).toEqual([]);
    expect(d.shouldWarn).toBe(false);
  });

  it('evaluateFleetGate + decidePreMutateGate refuse unpinned report under enforce', () => {
    const unpinned = {
      version: '1',
      ready: false,
      status: 'protected',
      status_oneline: 'unpinned',
      home: '/tmp',
      pin: null,
      mcp_registered: { claude: false, cursor: false, codex: false },
      doctor: {},
      commands: {},
      required_servers: ['locus', 'phantom'],
      mcp_command: 'locus-mcp',
    };
    const gate = evaluateFleetGate(unpinned as never);
    expect(gate.allowDispatch).toBe(false);
    const decision = decidePreMutateGate(
      { ...gate, available: true },
      'enforce',
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockers.some((b) => /unpinned|not ready|ready=false/.test(b))).toBe(
      true,
    );
  });

  it('assertLocusPreMutate mode=off never shells (allow without blockers)', () => {
    // Explicit null config: hermetic (do not read ~/.ashlr).
    const d = assertLocusPreMutate({ LOCUS_ENFORCE: 'off' }, null);
    expect(d.allow).toBe(true);
    expect(d.mode).toBe('off');
    expect(d.blockers).toEqual([]);
    expect(d.shouldWarn).toBe(false);
  });

  it('assertLocusPreMutate uses config when env unset', () => {
    const d = assertLocusPreMutate({}, { locus: { enforce: 'off' } });
    expect(d.allow).toBe(true);
    expect(d.mode).toBe('off');
    expect(d.blockers).toEqual([]);
  });

  it('applyLocusPreMutateGate mode=off allows without CLI probe', () => {
    const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: '0' }, null);
    expect(d.allow).toBe(true);
    expect(d.mode).toBe('off');
  });

  it('applyLocusPreMutateGate mode=enforce fails closed when locus CLI missing', () => {
    // locusAvailable() uses process.env.PATH (not the env arg) for `which`.
    const prevPath = process.env.PATH;
    const prevPathWin = process.env.Path;
    process.env.PATH = '/nonexistent-locus-bin-path';
    process.env.Path = '/nonexistent-locus-bin-path';
    try {
      const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: '1' }, null);
      expect(d.mode).toBe('enforce');
      expect(d.allow).toBe(false);
      expect(d.blockers.length).toBeGreaterThan(0);
      expect(formatPreMutateBlockers(d)).toMatch(/locus pre-mutate enforce/);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevPathWin === undefined) delete process.env.Path;
      else process.env.Path = prevPathWin;
    }
  });

  it('applyLocusPreMutateGate mode=warn allows when locus CLI missing', () => {
    const prevPath = process.env.PATH;
    const prevPathWin = process.env.Path;
    process.env.PATH = '/nonexistent-locus-bin-path';
    process.env.Path = '/nonexistent-locus-bin-path';
    try {
      const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: 'warn' }, null);
      expect(d.mode).toBe('warn');
      expect(d.allow).toBe(true);
      expect(d.shouldWarn).toBe(true);
      expect(d.blockers.length).toBeGreaterThan(0);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevPathWin === undefined) delete process.env.Path;
      else process.env.Path = prevPathWin;
    }
  });
});

/**
 * Call-site wiring: runApiModelSandboxed + runSwarm refuse under enforce.
 * Mocks applyLocusPreMutateGate so we never depend on a real pin in CI.
 */
describe('pre-mutate gate call sites (LOCUS_ENFORCE)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/core/integrations/locus.js');
    vi.doUnmock('../src/core/fleet/agent-action-ledger.js');
  });

  it('runApiModelSandboxed refuses when enforce blocks (bypasses spawnEngine)', async () => {
    vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/integrations/locus.js')>();
      return {
        ...actual,
        applyLocusPreMutateGate: () => ({
          allow: false,
          mode: 'enforce' as const,
          blockers: ['pin unhealthy: unpinned (unpinned)'],
          shouldWarn: false,
          gateOk: false,
          status_oneline: 'unpinned',
        }),
      };
    });
    // Avoid ledger FS writes when recording the failed action.
    vi.doMock('../src/core/fleet/agent-action-ledger.js', async (importOriginal) => {
      const actual = await importOriginal<
        typeof import('../src/core/fleet/agent-action-ledger.js')
      >();
      return {
        ...actual,
        recordAgentAction: () => {},
      };
    });

    const mod = await import(
      '../src/core/run/sandboxed-engine.js?locus-gate=' + randomUUID()
    );
    const result = await mod.runApiModelSandboxed(
      'local-coder',
      'test goal',
      {} as never,
      { sourceRepo: '/tmp/fake-locus-gate' },
    );
    expect(result.state.status).toBe('failed');
    expect(result.state.result).toMatch(/locus pre-mutate|unpinned/);
    expect(result.proposalOutcome?.kind).toBe('engine-failed-no-diff');
  });

  it('runApiModelSandboxed proceeds past gate when mode=off (mock allow)', async () => {
    vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/integrations/locus.js')>();
      return {
        ...actual,
        applyLocusPreMutateGate: () => ({
          allow: true,
          mode: 'off' as const,
          blockers: [],
          shouldWarn: false,
        }),
      };
    });
    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: () => {
        throw new Error('no git repo here');
      },
      removeSandbox: () => {},
      sandboxDiff: () => ({ files: 0, patch: '', insertions: 0, deletions: 0 }),
    }));
    vi.doMock('../src/core/fleet/agent-action-ledger.js', async (importOriginal) => {
      const actual = await importOriginal<
        typeof import('../src/core/fleet/agent-action-ledger.js')
      >();
      return { ...actual, recordAgentAction: () => {} };
    });

    const mod = await import(
      '../src/core/run/sandboxed-engine.js?locus-gate-off=' + randomUUID()
    );
    const result = await mod.runApiModelSandboxed(
      'local-coder',
      'test goal',
      {} as never,
      { sourceRepo: '/tmp/fake-locus-gate-off' },
    );
    // Gate allowed; failure is sandbox (proves we did not refuse at locus).
    expect(result.state.status).toBe('failed');
    expect(result.state.result).toMatch(/sandbox unavailable/);
    expect(result.state.result).not.toMatch(/locus pre-mutate/);
    vi.doUnmock('../src/core/sandbox/worktree.js');
  });

  it('runSwarm refuses when enforce blocks before nested work', async () => {
    vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/integrations/locus.js')>();
      return {
        ...actual,
        applyLocusPreMutateGate: () => ({
          allow: false,
          mode: 'enforce' as const,
          blockers: ['pin unhealthy: unpinned (unpinned)'],
          shouldWarn: false,
        }),
      };
    });

    // Keep swarm away from real planner/orchestrator: it should refuse at gate
    // before setting ASHLR_IN_SWARM or planning.
    const prevInSwarm = process.env['ASHLR_IN_SWARM'];
    delete process.env['ASHLR_IN_SWARM'];
    try {
      const mod = await import('../src/core/swarm/runner.js?locus-gate=' + randomUUID());
      const run = await mod.runSwarm(
        { goal: 'locus gate test' },
        {} as never,
        { noCapture: true },
        () => {},
      );
      expect(run.status).toBe('failed');
      expect(run.result).toMatch(/locus pre-mutate|unpinned|Refused/);
      expect(run.tasks).toEqual([]);
    } finally {
      if (prevInSwarm === undefined) delete process.env['ASHLR_IN_SWARM'];
      else process.env['ASHLR_IN_SWARM'] = prevInSwarm;
    }
  });
});


describe('decideLocusSessionRun (CI job isolation)', () => {
  it('mints when LOCUS_CI_BINDING is set (preferred over LOCUS_BINDING)', () => {
    const d = decideLocusSessionRun({
      LOCUS_CI_BINDING: 'ci-acme',
      LOCUS_BINDING: 'other',
    });
    expect(d).toEqual({
      kind: 'mint',
      binding: 'ci-acme',
      source: 'LOCUS_CI_BINDING',
    });
  });

  it('mints from LOCUS_BINDING when CI binding unset', () => {
    const d = decideLocusSessionRun({ LOCUS_BINDING: 'personal' });
    expect(d).toEqual({
      kind: 'mint',
      binding: 'personal',
      source: 'LOCUS_BINDING',
    });
  });

  it('skips re-mint when LOCUS_SESSION_ID already set', () => {
    const d = decideLocusSessionRun({
      LOCUS_SESSION_ID: 'sess-abc',
      LOCUS_CI_BINDING: 'would-mint',
    });
    expect(d).toEqual({ kind: 'already-session', sessionId: 'sess-abc' });
  });

  it('pass-through when no binding and LOCUS_ENFORCE off (monorepo default)', () => {
    expect(decideLocusSessionRun({})).toEqual({
      kind: 'pass-through',
      mode: 'off',
    });
    expect(decideLocusSessionRun({ LOCUS_ENFORCE: '0' })).toEqual({
      kind: 'pass-through',
      mode: 'off',
    });
  });

  it('warns when LOCUS_ENFORCE=warn without a binding', () => {
    const d = decideLocusSessionRun({ LOCUS_ENFORCE: 'warn' });
    expect(d.kind).toBe('warn');
    if (d.kind === 'warn') {
      expect(d.mode).toBe('warn');
      expect(d.reason).toMatch(/LOCUS_CI_BINDING|ambient/);
    }
  });

  it('refuses when LOCUS_ENFORCE=enforce without a binding', () => {
    const d = decideLocusSessionRun({ LOCUS_ENFORCE: '1' });
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') {
      expect(d.mode).toBe('enforce');
      expect(d.reason).toMatch(/LOCUS_CI_BINDING/);
    }
  });

  it('trims whitespace on binding aliases', () => {
    const d = decideLocusSessionRun({ LOCUS_CI_BINDING: '  acme  ' });
    expect(d).toEqual({
      kind: 'mint',
      binding: 'acme',
      source: 'LOCUS_CI_BINDING',
    });
  });

  it('empty binding strings fall through to enforce/pass-through', () => {
    expect(
      decideLocusSessionRun({ LOCUS_CI_BINDING: '  ', LOCUS_BINDING: '' }),
    ).toEqual({
      kind: 'pass-through',
      mode: 'off',
    });
    expect(
      decideLocusSessionRun({
        LOCUS_CI_BINDING: '',
        LOCUS_ENFORCE: 'enforce',
      }).kind,
    ).toBe('refuse');
  });
});

describe('applyLocusSessionEnv', () => {
  it('copies LOCUS identity + scope keys only', () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin', KEEP: 'yes' };
    applyLocusSessionEnv(target, {
      LOCUS_SESSION_ID: 's1',
      LOCUS_BINDING: 'acme',
      LOCUS_HOME: '/tmp/locus',
      LOCUS_NOTIFY: '0',
      GH_CONFIG_DIR: '/tmp/gh',
      AWS_PROFILE: 'should-not-copy',
      GH_TOKEN: 'secret',
      PATH: '/evil',
    });
    expect(target.PATH).toBe('/usr/bin');
    expect(target.KEEP).toBe('yes');
    expect(target.LOCUS_SESSION_ID).toBe('s1');
    expect(target.LOCUS_BINDING).toBe('acme');
    expect(target.LOCUS_HOME).toBe('/tmp/locus');
    expect(target.LOCUS_NOTIFY).toBe('0');
    expect(target.GH_CONFIG_DIR).toBe('/tmp/gh');
    expect(target.AWS_PROFILE).toBeUndefined();
    expect(target.GH_TOKEN).toBeUndefined();
  });
});

/**
 * runTask CI session wiring: refuse maps to task.status (never throws);
 * pass-through when enforce off; mint handle overlays process.env for the body.
 */
describe('runTask CI session isolation (LOCUS_CI_BINDING / LOCUS_ENFORCE)', () => {
  const LOCUS_ENV_KEYS = [
    'LOCUS_ENFORCE',
    'LOCUS_CI_BINDING',
    'LOCUS_BINDING',
    'LOCUS_SESSION_ID',
  ] as const;

  function snapshotLocusEnv(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of LOCUS_ENV_KEYS) out[k] = process.env[k];
    return out;
  }

  function restoreLocusEnv(prev: Record<string, string | undefined>): void {
    for (const k of LOCUS_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/core/integrations/locus.js');
  });

  it('refuses as task.status=failed when LOCUS_ENFORCE without binding (never throws)', async () => {
    const prev = snapshotLocusEnv();
    try {
      process.env.LOCUS_ENFORCE = '1';
      delete process.env.LOCUS_CI_BINDING;
      delete process.env.LOCUS_BINDING;
      delete process.env.LOCUS_SESSION_ID;

      const { runTask } = await import(
        '../src/core/run/agent-loop.js?locus-session-refuse=' + randomUUID()
      );
      const task = {
        id: 't-locus-refuse',
        goal: 'should not run model',
        deps: [] as string[],
        status: 'pending' as const,
      };
      const chat = vi.fn(async () => ({
        content: 'should not be called',
        usage: { tokensIn: 1, tokensOut: 1 },
      }));
      const returned = await runTask(
        task,
        {
          id: 'mock',
          supportsTools: false,
          chat,
        },
        {
          budget: { maxTokens: 1000, maxSteps: 5, allowCloud: false },
          usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
          onStep: () => {},
        },
      );
      expect(returned).toBe(task);
      expect(task.status).toBe('failed');
      expect(task.error).toMatch(/LOCUS_CI_BINDING|LOCUS_BINDING|LOCUS_ENFORCE/);
      expect(chat).not.toHaveBeenCalled();
    } finally {
      restoreLocusEnv(prev);
    }
  });

  it('pass-through when enforce off and no binding (model runs)', async () => {
    const prev = snapshotLocusEnv();
    try {
      delete process.env.LOCUS_ENFORCE;
      delete process.env.LOCUS_CI_BINDING;
      delete process.env.LOCUS_BINDING;
      delete process.env.LOCUS_SESSION_ID;

      const { runTask } = await import(
        '../src/core/run/agent-loop.js?locus-session-passthrough=' + randomUUID()
      );
      const task = {
        id: 't-locus-pass',
        goal: '2+2?',
        deps: [] as string[],
        status: 'pending' as const,
      };
      const returned = await runTask(
        task,
        {
          id: 'mock',
          supportsTools: false,
          chat: async () => ({
            content: '4',
            usage: { tokensIn: 2, tokensOut: 1 },
          }),
        },
        {
          budget: { maxTokens: 1000, maxSteps: 5, allowCloud: false },
          usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
          onStep: () => {},
        },
      );
      expect(returned.status).toBe('done');
      expect(returned.result).toBe('4');
    } finally {
      restoreLocusEnv(prev);
    }
  });

  it('overlays mint handle env on process.env for the task body only', async () => {
    const prev = snapshotLocusEnv();
    const seen: { sessionId?: string } = {};
    try {
      delete process.env.LOCUS_SESSION_ID;
      vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
        const actual = await importOriginal<
          typeof import('../src/core/integrations/locus.js')
        >();
        return {
          ...actual,
          runWithLocusSessionIfConfigured: async (
            fn: (handle: {
              sessionId: string;
              binding: string;
              env: NodeJS.ProcessEnv;
            } | null) => Promise<unknown>,
          ) =>
            fn({
              sessionId: 'sess-mint-test',
              binding: 'ci-acme',
              env: {
                LOCUS_SESSION_ID: 'sess-mint-test',
                LOCUS_BINDING: 'ci-acme',
                LOCUS_HOME: '/tmp/locus-mint-test',
              },
            }),
        };
      });

      const { runTask } = await import(
        '../src/core/run/agent-loop.js?locus-session-mint=' + randomUUID()
      );
      const task = {
        id: 't-locus-mint',
        goal: 'observe env',
        deps: [] as string[],
        status: 'pending' as const,
      };
      await runTask(
        task,
        {
          id: 'mock',
          supportsTools: false,
          chat: async () => {
            seen.sessionId = process.env.LOCUS_SESSION_ID;
            return {
              content: 'ok',
              usage: { tokensIn: 1, tokensOut: 1 },
            };
          },
        },
        {
          budget: { maxTokens: 1000, maxSteps: 5, allowCloud: false },
          usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
          onStep: () => {},
        },
      );
      expect(task.status).toBe('done');
      expect(seen.sessionId).toBe('sess-mint-test');
      // Restored after body — must not leak mint session into ambient env.
      expect(process.env.LOCUS_SESSION_ID).toBeUndefined();
    } finally {
      restoreLocusEnv(prev);
    }
  });

  it('maps LocusMintError to task.status=failed without throwing', async () => {
    const prev = snapshotLocusEnv();
    try {
      vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
        const actual = await importOriginal<
          typeof import('../src/core/integrations/locus.js')
        >();
        return {
          ...actual,
          runWithLocusSessionIfConfigured: async () => {
            throw new actual.LocusMintError('ci mint failed: simulated');
          },
        };
      });

      const { runTask } = await import(
        '../src/core/run/agent-loop.js?locus-session-mint-err=' + randomUUID()
      );
      const task = {
        id: 't-locus-mint-err',
        goal: 'fail mint',
        deps: [] as string[],
        status: 'pending' as const,
      };
      const chat = vi.fn();
      const returned = await runTask(
        task,
        { id: 'mock', supportsTools: false, chat },
        {
          budget: { maxTokens: 1000, maxSteps: 5, allowCloud: false },
          usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
          onStep: () => {},
        },
      );
      expect(returned).toBe(task);
      expect(task.status).toBe('failed');
      expect(task.error).toMatch(/ci mint failed/);
      expect(chat).not.toHaveBeenCalled();
    } finally {
      restoreLocusEnv(prev);
    }
  });
});


describe('MCP merge helpers', () => {

  it('locusServerSpec uses locus-mcp and LOCUS_* env only', () => {
    const s = locusServerSpec({ locusHome: '/tmp/locus-home', client: 'ashlr-hub' });
    expect(s.command).toBe('locus-mcp');
    expect(s.env?.LOCUS_HOME).toBe('/tmp/locus-home');
    expect(s.env?.LOCUS_CLIENT).toBe('ashlr-hub');
    expect(s.env?.LOCUS_NOTIFY).toBe('0');
  });

  it('mergeLocusIntoMcpConfig inserts locus without clobbering others', () => {
    const { config, changed, serverName } = mergeLocusIntoMcpConfig(
      { mcpServers: { other: { command: 'x' } } },
      { locusHome: '/tmp/l' },
    );
    expect(serverName).toBe('locus');
    expect(changed).toBe(true);
    expect(config.mcpServers?.other?.command).toBe('x');
    expect(config.mcpServers?.locus?.command).toBe('locus-mcp');
  });
});
