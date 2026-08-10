/**
 * Pure-helper unit tests for src/core/integrations/locus.ts.
 * No real spawn — only parse/gate helpers (fail-closed contract).
 */

import { describe, it, expect } from 'vitest';
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
