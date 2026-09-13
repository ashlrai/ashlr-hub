import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cmdUniverseFirm } from '../src/cli/universe-firm.js';
import { readFirmGraph, queryFirmGraph, type FirmGraphReadOptions } from '../src/core/universe/firm-graph.js';
import { readControlGraph, runControlGraph, type ControlGraphDefinition } from '../src/core/universe/control-graph.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import * as provenance from '../src/core/foundry/provenance.js';

let root: string;
let options: FirmGraphReadOptions;
const exec = promisify(execFile);
const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'custom-research', maxConcurrent: 1, maxDurationMs: 60_000,
  nodes: [{ id: 'outline', kind: 'plan', requires: [], input: {} },
    { id: 'alternative', kind: 'plan', requires: ['outline'], input: {} }] };

beforeEach(() => {
  // The standard test HOME fixture isolates all root and provenance paths.
  root = realpathSync(mkdtempSync(join(homedir(), 'firm-graph-query-')));
  options = { root, traceKeys: { testKey: randomBytes(32) } };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function fixture(config = options) {
  return runControlGraph(definition, { ...config, handlers: { plan: async ({ node }) => {
    const prior = readControlGraph(root, config.traceKeys).traces.find((trace) => trace.action === 'graph-settled');
    return { artifact: { node: node.id }, conflicts: prior ? [{ otherId: prior.id, reason: 'value' }] : [] };
  } } });
}
function snapshot(path = root): unknown {
  return readdirSync(path).sort().map((name) => {
    const target = join(path, name); const stat = lstatSync(target);
    return [name, stat.mode, stat.mtimeMs, stat.ino, stat.isDirectory() ? snapshot(target) : readFileSync(target).toString('hex')];
  });
}
async function cli(command: string, ...args: string[]) {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = await cmdUniverseFirm([command, '--root', root, '--json', ...args]);
  const text = output.mock.calls.map(([line]) => String(line)).join('\n');
  return { code, text, value: text ? JSON.parse(text) : null };
}
async function subprocessCli(command: string, ...args: string[]) {
  // Inherit the standard isolated fixture HOME so source CLI processes can
  // read its existing signing key without accessing the developer's key.
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'universe', 'firm', command,
      '--root', root, '--json', ...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return { code: 0, value: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean };
    // Timeouts and launch errors must fail the test rather than resemble a
    // deliberate nonzero evidence-verification exit.
    if (failure.killed || typeof failure.code !== 'number' || typeof failure.stdout !== 'string') throw error;
    return { code: failure.code, value: JSON.parse(failure.stdout), stderr: failure.stderr };
  }
}

describe('general signed firm graph inspection', () => {
  it('reads a non-demo graph with explicit integrity semantics and detached results', async () => {
    const history = await fixture();
    expect(history.status).toBe('completed');
    const report = readFirmGraph(options);
    expect(report).toMatchObject({ status: 'available', integrityVerified: true, signatureVerification: 'verified-history',
      keyScope: 'injected-fixture-key', graph: { graphId: definition.id, status: 'completed', sourceState: 'healthy' } });
    expect(report.graph.edges).toEqual(history.edges);
    report.graph.traces[0]!.entities.push('changed');
    expect(readFirmGraph(options).graph.traces).toEqual(history.traces);
  });

  it('keeps healthy unfinished graphs available for inspection', async () => {
    await runControlGraph(definition, { ...options, handlers: {} });
    expect(readFirmGraph(options)).toMatchObject({ status: 'available', integrityVerified: true,
      graph: { status: 'incomplete', nodes: [{ state: 'pending' }, { state: 'pending' }] } });
  });

  it('filters entity, action and inclusive UTC times while retaining out-of-filter conflict links', async () => {
    const history = await fixture();
    const final = history.traces.at(-1)!;
    const report = queryFirmGraph(options, { entity: 'node:alternative', action: 'graph-settled', since: final.ts, until: final.ts, limit: 1 });
    expect(report).toMatchObject({ integrityVerified: true, signatureVerification: 'verified-history',
      query: { total: 1, truncated: false, signatureVerification: 'not-performed', traces: [final] } });
    expect(final.conflicts).toHaveLength(1);
    expect(report.query.traces.some((trace) => trace.id === final.conflicts[0]!.otherId)).toBe(false);
    expect(queryFirmGraph(options, { limit: 1 }).query).toMatchObject({ total: 5, truncated: true, traces: [history.traces[0]] });
    expect(queryFirmGraph(options, { entity: 'node:absent' }).query).toMatchObject({ total: 0, truncated: false, traces: [] });
  });

  it.each(['signature', 'gap', 'wrong-key'])('suppresses the entire result when history has %s damage', async (damage) => {
    await fixture();
    const path = join(root, 'control-graph', 'records', '00000002.json');
    if (damage === 'signature') {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.trace.provenanceSig = '0'.repeat(64);
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    } else if (damage === 'gap') unlinkSync(path);
    else options.traceKeys = { testKey: randomBytes(32) };
    const before = snapshot();
    expect(readFirmGraph(options)).toMatchObject({ status: 'unavailable', integrityVerified: false,
      signatureVerification: 'not-verified', graph: { sourceState: 'degraded', traces: [], nodes: [], edges: [] } });
    expect(queryFirmGraph(options)).toMatchObject({ sourceState: 'degraded', query: { traces: [], total: 0 } });
    expect(snapshot()).toEqual(before);
  });

  it('does not create missing evidence or provenance keys', async () => {
    const path = provenance.provenanceKeyPath();
    const keyExisted = existsSync(path);
    const create = vi.spyOn(provenance, 'loadOrCreateKey');
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(null);
    const report = await cli('traces');
    expect(report.code).toBe(1);
    expect(report.value).toMatchObject({ status: 'missing', integrityVerified: false, sourceState: 'missing', query: { traces: [] } });
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(path)).toBe(keyExisted);
    expect(create).not.toHaveBeenCalled();
  });

  it('withholds existing evidence when its verification key is unavailable without creating a replacement', async () => {
    await fixture();
    const before = snapshot();
    const create = vi.spyOn(provenance, 'loadOrCreateKey');
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(null);
    const report = await cli('traces');
    expect(report.code).toBe(1);
    expect(report.value).toMatchObject({ status: 'unavailable', integrityVerified: false,
      sourceState: 'degraded', signatureVerification: 'not-verified', query: { traces: [], total: 0 } });
    expect(create).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('reads existing history despite an execution owner and KILL without writing or dispatching', async () => {
    await fixture();
    writeFileSync(join(root, 'KILL'), 'fixture stop', { mode: 0o600 });
    const ownership = acquireLocalStoreLockWithOutcome(join(root, '.control-execution.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(ownership.state).toBe('acquired');
    try {
      const before = snapshot();
      expect(readFirmGraph(options).status).toBe('available');
      expect(queryFirmGraph(options).query.total).toBe(5);
      expect(snapshot()).toEqual(before);
    } finally { if (ownership.state === 'acquired') releaseLocalStoreLock(ownership.lock); }
  });

  it('exposes general graph and traces through the CLI with the existing fixture host key', async () => {
    // This key belongs to the standard isolated test HOME, never the user's home.
    provenance.loadOrCreateKey();
    await fixture({ root });
    const before = snapshot();
    const graph = await cli('graph');
    expect(graph.code).toBe(0);
    expect(graph.value).toMatchObject({ status: 'available', keyScope: 'existing-host-key', graph: { graphId: definition.id } });
    const traces = await cli('traces', '--action', 'graph-settled', '--entity', 'node:alternative', '--limit', '1');
    expect(traces.code).toBe(0);
    expect(traces.value.query).toMatchObject({ total: 1, truncated: false });
    expect(traces.value.query.traces[0].conflicts).toHaveLength(1);
    expect(snapshot()).toEqual(before);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdUniverseFirm(['graph', '--root', root])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('Node alternative: plan, completed');
  });

  it('routes graph and traces in real CLI processes and exits 1 without partial evidence after damage', async () => {
    provenance.loadOrCreateKey();
    const history = await fixture({ root });
    expect(history.status).toBe('completed');
    const final = history.traces.at(-1)!;
    const before = snapshot();

    const graph = await subprocessCli('graph');
    expect(graph.code).toBe(0);
    expect(graph.value).toMatchObject({ status: 'available', integrityVerified: true,
      signatureVerification: 'verified-history', keyScope: 'existing-host-key',
      graph: { graphId: definition.id, sourceState: 'healthy', status: 'completed', traces: history.traces } });
    const traces = await subprocessCli('traces', '--entity', 'node:alternative', '--action', 'graph-settled',
      '--since', final.ts, '--until', final.ts, '--limit', '1');
    expect(traces.code).toBe(0);
    expect(traces.value).toMatchObject({ integrityVerified: true, signatureVerification: 'verified-history',
      query: { traces: [final], total: 1, truncated: false, signatureVerification: 'not-performed' } });
    expect(traces.value.query.traces[0].conflicts).toEqual([{ otherId: history.traces[2]!.id, reason: 'value' }]);
    expect(traces.value.query.traces.map((trace: { id: string }) => trace.id)).not.toContain(history.traces[2]!.id);
    expect(snapshot()).toEqual(before);

    const path = join(root, 'control-graph', 'records', '00000002.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.trace.provenanceSig = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    const damaged = snapshot();
    const damagedGraph = await subprocessCli('graph');
    expect(damagedGraph.code).toBe(1);
    expect(damagedGraph.value).toMatchObject({ status: 'unavailable', integrityVerified: false,
      signatureVerification: 'not-verified', graph: { sourceState: 'degraded', nodes: [], edges: [], traces: [] } });
    const damagedTraces = await subprocessCli('traces', '--entity', 'node:alternative', '--limit', '1');
    expect(damagedTraces.code).toBe(1);
    expect(damagedTraces.value).toMatchObject({ status: 'unavailable', integrityVerified: false,
      sourceState: 'degraded', query: { traces: [], total: 0, truncated: false } });
    expect(snapshot()).toEqual(damaged);
  }, 60_000);

  it.each([
    ['--limit', '0'], ['--limit', '257'], ['--limit', '1.5'], ['--limit', '1', '--limit', '2'],
    ['--entity', 'bad entity'], ['--action', 'bad/action'], ['--since', '2026-02-30T00:00:00Z'],
    ['--since', '2026-09-10T00:00:00Z', '--until', '2026-09-09T00:00:00Z'],
    ['--until', 'yesterday'], ['--key', 'secret'], ['--action'],
  ])('rejects invalid trace options %j before reading evidence', async (...args) => {
    expect((await cli('traces', ...args)).code).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });

  it('redacts invalid root failures and rejects query flags on graph', async () => {
    const invalid = await cli('graph', '--entity', 'node:outline');
    expect(invalid.code).toBe(2);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdUniverseFirm(['traces', '--root', '/absent-sensitive-fixture-path', '--json'])).toBe(1);
    expect(output.mock.calls.flat().join('\n')).not.toContain('/absent-sensitive-fixture-path');
    expect(() => readFirmGraph({ root: '.' })).toThrow('Invalid firm graph root');
    expect(() => queryFirmGraph(options, { limit: 257 })).toThrow();
  });
});
