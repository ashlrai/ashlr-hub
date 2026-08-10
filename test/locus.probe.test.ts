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
