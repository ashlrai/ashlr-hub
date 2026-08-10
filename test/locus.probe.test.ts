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
  resolveLocusEnforceMode,
  decidePreMutateGate,
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
    const d = assertLocusPreMutate({ LOCUS_ENFORCE: 'off' });
    expect(d.allow).toBe(true);
    expect(d.mode).toBe('off');
    expect(d.blockers).toEqual([]);
    expect(d.shouldWarn).toBe(false);
  });

  it('applyLocusPreMutateGate mode=off allows without CLI probe', () => {
    const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: '0' });
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
      const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: '1' });
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
      const d = applyLocusPreMutateGate({ LOCUS_ENFORCE: 'warn' });
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
