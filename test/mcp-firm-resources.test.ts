import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FIRM_GRAPH_URI, FIRM_TRACES_URI, MAX_FIRM_RESOURCE_BYTES, listFirmResources, listFirmResourceTemplates, readFirmResource } from '../src/core/mcp-firm-resources.js';
import * as graph from '../src/core/universe/firm-graph.js';
import { runControlGraph, type ControlGraphDefinition } from '../src/core/universe/control-graph.js';
import * as provenance from '../src/core/foundry/provenance.js';

let home: string;
let root: string;
let configPath: string;
const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'mcp-custom-graph', maxConcurrent: 1, maxDurationMs: 60_000,
  nodes: [{ id: 'first', kind: 'plan', requires: [], input: {} }, { id: 'second', kind: 'plan', requires: ['first'], input: {} }] };

beforeEach(() => {
  // Nest inside the standard worker's isolated HOME; no real user state is read.
  home = realpathSync(mkdtempSync(join(homedir(), 'firm-mcp-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  root = join(home, 'graph');
  mkdirSync(root, { mode: 0o700 });
  configPath = join(home, '.ashlr', 'config.json');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function configure(firm: unknown = { graphRoot: root }) {
  mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({ version: 1, firm }), { mode: 0o600 });
}
function value(uri: unknown = FIRM_GRAPH_URI) { return JSON.parse(readFirmResource(uri).contents[0]!.text); }
function snapshot(path = home): unknown {
  return readdirSync(path).sort().map((name) => {
    const target = join(path, name); const stat = lstatSync(target);
    return [name, stat.mode, stat.ino, stat.mtimeMs, stat.isDirectory() ? snapshot(target) : readFileSync(target).toString('hex')];
  });
}
async function fixture(incomplete = false) {
  configure();
  provenance.loadOrCreateKey(); // Only fixture setup creates a key in the isolated HOME.
  return runControlGraph(definition, { root, handlers: incomplete ? {} : { plan: async ({ node }) => {
    const prior = graph.readFirmGraph({ root }).graph.traces.find((trace) => trace.action === 'graph-settled');
    return { artifact: { node: node.id }, conflicts: prior ? [{ otherId: prior.id, reason: 'value' }] : [] };
  } } });
}

describe('configured firm MCP resources', () => {
  it('does not discover or bootstrap an unconfigured root, config, audit, or key', () => {
    const before = snapshot();
    const create = vi.spyOn(provenance, 'loadOrCreateKey');
    expect(listFirmResources()).toEqual({ resources: [] });
    expect(listFirmResourceTemplates()).toEqual({ resourceTemplates: [] });
    expect(value()).toMatchObject({ status: 'unavailable', reason: 'firm-configuration-unavailable' });
    expect(snapshot()).toEqual(before);
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
  });

  it.each([null, {}, { graphRoot: 'relative' }, { graphRoot: '' }, { graphRoot: '/missing-firm-root' }, { graphRoot: '/tmp/../tmp' },
    { graphRoot: '/tmp', traceKeys: 'not-accepted' }])('fails closed for invalid configuration %j', (firm) => {
    configure(firm);
    const before = snapshot();
    expect(listFirmResources().resources).toEqual([]);
    expect(value()).toMatchObject({ status: 'unavailable', reason: 'firm-configuration-unavailable' });
    expect(snapshot()).toEqual(before);
  });

  it('fails closed for malformed config and non-private or symlink roots without path leakage', () => {
    configure();
    writeFileSync(configPath, '{broken');
    expect(value()).toMatchObject({ reason: 'firm-configuration-unavailable' });
    configure();
    if (process.platform !== 'win32') {
      chmodSync(root, 0o755);
      expect(value()).toMatchObject({ reason: 'firm-configuration-unavailable' });
      chmodSync(root, 0o700);
    }
    const alias = join(home, 'alias');
    symlinkSync(root, alias, 'dir');
    configure({ graphRoot: alias });
    expect(value()).toMatchObject({ reason: 'firm-configuration-unavailable' });
    expect(JSON.stringify(readFirmResource(FIRM_GRAPH_URI))).not.toContain(home);
  });

  it('advertises only fixed URIs and a filter-only template', () => {
    configure();
    const before = snapshot();
    expect(listFirmResources().resources.map((resource) => resource.uri)).toEqual([FIRM_GRAPH_URI, FIRM_TRACES_URI]);
    expect(listFirmResourceTemplates().resourceTemplates[0]!.uriTemplate).toBe(`${FIRM_TRACES_URI}{?entity,action,since,until,limit}`);
    expect(JSON.stringify(listFirmResources())).not.toContain(root);
    expect(snapshot()).toEqual(before);
  });

  it.each(['file:///etc/passwd', 'ashlr://firm/../graph', 'ashlr://firm/graph?root=/tmp', 'ashlr://firm/traces?root=/tmp',
    'ashlr://firm/traces?traceKeys=abc', 'ashlr://firm/traces#root', 'ashlr://firm/traces?',
    'ashlr://firm/traces?entity=a&entity=b', 'ashlr://firm/traces?entity=%zz', 'ashlr://firm/traces?limit=0',
    'ashlr://firm/traces?limit=257', 'ashlr://firm/traces?limit=1.5', 'ashlr://firm/traces?since=yesterday',
    'ashlr://firm/traces?since=2026-09-10T00:00:00Z&until=2026-09-09T00:00:00Z',
    'ashlr://firm/traces?entity=/tmp', null, {}])('rejects caller paths, keys, and malformed URI/filter %j before reading evidence', (uri) => {
    configure();
    const read = vi.spyOn(graph, 'readFirmGraph');
    const query = vi.spyOn(graph, 'queryFirmGraph');
    const before = snapshot();
    expect(value(uri)).toMatchObject({ reason: 'invalid-firm-resource-uri' });
    expect(read).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('returns exact signed history and filtered conflicts without redaction or writes', async () => {
    const history = await fixture();
    const final = history.traces.at(-1)!;
    const before = snapshot();
    const create = vi.spyOn(provenance, 'loadOrCreateKey');
    expect(value()).toEqual(graph.readFirmGraph({ root }));
    const query = new URLSearchParams({ entity: 'node:second', action: 'graph-settled', since: final.ts, until: final.ts, limit: '1' });
    const selected = value(`${FIRM_TRACES_URI}?${query}`);
    expect(selected).toMatchObject({ status: 'available', signatureVerification: 'verified-history', keyScope: 'existing-host-key',
      query: { total: 1, truncated: false, traces: [final] } });
    expect(selected.query.traces[0].conflicts).toHaveLength(1);
    expect(snapshot()).toEqual(before); expect(create).not.toHaveBeenCalled();
  });

  it('keeps healthy incomplete history readable under KILL', async () => {
    await fixture(true);
    writeFileSync(join(home, '.ashlr', 'KILL'), 'fixture');
    const before = snapshot();
    expect(value()).toMatchObject({ status: 'available', integrityVerified: true, graph: { status: 'incomplete' } });
    expect(snapshot()).toEqual(before);
  });

  it.each(['signature', 'missing-key'])('withholds evidence on %s failure and never repairs it', async (damage) => {
    await fixture();
    if (damage === 'missing-key') unlinkSync(provenance.provenanceKeyPath());
    else {
      const path = join(root, 'control-graph', 'records', '00000002.json');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.trace.provenanceSig = '0'.repeat(64);
      writeFileSync(path, JSON.stringify(record));
    }
    const before = snapshot();
    expect(value()).toMatchObject({ status: 'unavailable', signatureVerification: 'not-verified', graph: { traces: [] } });
    expect(value(FIRM_TRACES_URI)).toMatchObject({ query: { traces: [], total: 0 } });
    expect(snapshot()).toEqual(before);
  });

  it('returns valid bounded JSON with explicit failure instead of truncating oversized evidence', () => {
    configure();
    const report = graph.readFirmGraph({ root });
    vi.spyOn(graph, 'readFirmGraph').mockReturnValue({ ...report, scope: 'é'.repeat(MAX_FIRM_RESOURCE_BYTES) });
    const text = readFirmResource(FIRM_GRAPH_URI).contents[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_FIRM_RESOURCE_BYTES);
    expect(JSON.parse(text)).toMatchObject({ status: 'unavailable', integrityVerified: false, reason: 'firm-resource-output-limit-exceeded' });
  });

  it('serves resources through the actual source CLI stdio protocol with zero downstreams', async () => {
    const history = await fixture();
    const before = snapshot(root);
    const client = new Client({ name: 'firm-resource-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/cli/index.ts', 'mcp'], cwd: process.cwd(), stderr: 'pipe',
      env: { HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'),
        ASHLR_MCP_HOST: 'ashlr-fleet-engine', PATH: process.env.PATH ?? '' } });
    // Drain diagnostics without exposing paths or interfering with JSON-RPC stdout.
    transport.stderr?.on('data', () => undefined);
    try {
      await client.connect(transport, { timeout: 30_000 });
      expect(client.getServerCapabilities()?.resources).toBeDefined();
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([FIRM_GRAPH_URI, FIRM_TRACES_URI]);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
      const reply = await client.readResource({ uri: `${FIRM_TRACES_URI}?limit=1` });
      const content = reply.contents[0]!;
      expect('text' in content && JSON.parse(content.text as string)).toMatchObject({ status: 'available',
        query: { total: history.traces.length, truncated: true, traces: [history.traces[0]] } });
      expect(snapshot(root)).toEqual(before);
    } finally { await client.close(); await transport.close(); }
  }, 60_000);
});
