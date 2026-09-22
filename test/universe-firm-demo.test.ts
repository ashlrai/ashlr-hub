import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirmDemo, readFirmDemo, queryFirmDemo, type FirmDemoOptions } from '../src/core/universe/firm-demo.js';
import { cmdUniverseFirm } from '../src/cli/universe-firm.js';
import { runControlGraph } from '../src/core/universe/control-graph.js';
import { verifyDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import * as provenance from '../src/core/foundry/provenance.js';

let root: string;
let config: FirmDemoOptions;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-firm-demo-test-'))); chmodSync(root, 0o700);
  config = { root, traceKeys: { testKey: randomBytes(32) } };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function records() {
  return readdirSync(join(root, 'control-graph', 'records')).filter((name) => /^\d{8}\.json$/.test(name)).sort()
    .map((name) => JSON.parse(readFileSync(join(root, 'control-graph', 'records', name), 'utf8')));
}

describe('runnable inert firm demo', () => {
  it('runs the actual artifact-bearing plan, implementation and cold-check path with an expected negative fixture', async () => {
    const result = await runFirmDemo(config);
    expect(result.status).toBe('accepted-fixture');
    expect(result.graph.status).toBe('incomplete'); // Intentional rejection is not all-nodes-completed.
    expect(result.checks).toEqual({ positiveVerified: true, intentionalLiarRejected: true, plantedConflictPreserved: true });
    expect(result.counts).toEqual({ completedNodes: 4, rejectedNodes: 1, traces: 11, conflictLinks: 1 });
    expect(result.graph.traces.every((trace) => verifyDecisionTraceV1(trace, config.traceKeys))).toBe(true);
    expect(result.graph.traces.every((trace) => trace.spend.unknown && trace.spend.tokens === undefined)).toBe(true);
    expect(result.graph.edges.map(({ from, to }) => [from, to])).toEqual([
      ['plan', 'implement'], ['implement', 'verify'], ['plan', 'implement-liar'], ['verify', 'implement-liar'], ['implement-liar', 'verify-liar'],
    ]);
    const settled = records().filter((row) => row.kind === 'settled');
    const plan = settled.find((row) => row.nodeId === 'plan').data.artifact;
    expect(plan.alternatives).toHaveLength(2);
    expect(new Set(plan.alternatives.map((row: { description: string }) => row.description)).size).toBe(2);
    expect(plan.selected).toBe('sum-of-products');
    for (const id of ['verify', 'verify-liar']) {
      const check = settled.find((row) => row.nodeId === id).data.artifact;
      expect(check.checkedRows).toBe(4);
      expect(check.result.reason).toBe('verified');
      expect(check.result.builderExecutionId).not.toBe(check.result.verifierExecutionId);
      expect(check.independenceScope).toContain('not process isolation');
    }
    const lie = settled.find((row) => row.nodeId === 'implement-liar').data.artifact;
    expect(lie.rows.at(-1)).toEqual([true, true, true]);
    expect(lie.testLog).toContain('4 of 4 rows pass');
    expect(settled.find((row) => row.nodeId === 'verify-liar').trace.verifier.verdict).toBe('fail');
  });

  it('retains a planted conflict even when its target is outside the query filter', async () => {
    const report = await runFirmDemo(config);
    const prior = report.graph.traces.find((trace) => trace.action === 'graph-settled' && trace.entities.includes('node:verify'))!;
    const query = queryFirmDemo(config, { entity: 'node:verify-liar', limit: 2 });
    expect(query.integrityVerified).toBe(true);
    expect(query.keyScope).toBe('injected-fixture-key');
    expect(query.query.traces).toHaveLength(2);
    expect(query.query.traces.some((trace) => trace.id === prior.id)).toBe(false);
    expect(query.query.traces[1]!.conflicts).toEqual([{ otherId: prior.id, reason: 'value' }]);
    expect(query.query.signatureVerification).toBe('not-performed'); // Query itself is structural; reader authenticated first.
  });

  it('replays the same settled graph without creating fresh traces or renewing its deadline', async () => {
    const first = await runFirmDemo(config);
    expect(await runFirmDemo(config)).toEqual(first);
    expect(readFirmDemo(config)).toEqual(first);
    expect(records()).toHaveLength(11);
  });

  it('returns detached plan and trace snapshots', async () => {
    const first = await runFirmDemo(config);
    first.declaredAlternatives[0]!.description = 'mutated';
    first.graph.traces[0]!.entities.push('mutated');
    const second = readFirmDemo(config);
    expect(second.declaredAlternatives[0]!.description).not.toBe('mutated');
    expect(second.graph.traces[0]!.entities).not.toContain('mutated');
    expect(second.status).toBe('accepted-fixture');
  });

  it('reports missing evidence without writing a directory', () => {
    expect(readFirmDemo(config)).toMatchObject({ status: 'incomplete', graph: { sourceState: 'missing', traces: [] } });
    expect(queryFirmDemo(config)).toMatchObject({ integrityVerified: false, query: { traces: [], total: 0 } });
    expect(readdirSync(root)).toEqual([]);
  });

  it('never creates a missing production provenance key or executes fixture work without it', async () => {
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(null);
    const keyPath = provenance.provenanceKeyPath();
    const before = existsSync(keyPath);
    const result = await runFirmDemo({ root });
    expect(result.status).toBe('unavailable');
    expect(result.counts.traces).toBe(0);
    expect(existsSync(keyPath)).toBe(before);
    expect(existsSync(join(root, 'control-graph'))).toBe(false);
  });

  it('refuses tampered signatures and exposes no unverified traces', async () => {
    await runFirmDemo(config);
    const path = join(root, 'control-graph', 'records', '00000002.json');
    const row = JSON.parse(readFileSync(path, 'utf8'));
    row.trace.provenanceSig = '0'.repeat(64); writeFileSync(path, JSON.stringify(row), { mode: 0o600 });
    expect(readFirmDemo(config)).toMatchObject({ status: 'unavailable', graph: { sourceState: 'degraded', traces: [] } });
    expect(queryFirmDemo(config)).toMatchObject({ integrityVerified: false, query: { traces: [] } });
    expect((await runFirmDemo(config)).status).toBe('unavailable');
  });

  it('does not authenticate history under a different test key', async () => {
    await runFirmDemo(config);
    expect(readFirmDemo({ root, traceKeys: { testKey: randomBytes(32) } }).status).toBe('unavailable');
  });

  it('never reports a different authenticated graph as this demo', async () => {
    await runControlGraph({ schemaVersion: 1, id: 'other', maxConcurrent: 1, maxDurationMs: 1000,
      nodes: [{ id: 'p', kind: 'plan', requires: [], input: {} }] }, { ...config, handlers: { plan: async () => ({ artifact: 'other' }) } });
    expect(readFirmDemo(config).status).toBe('unavailable');
    expect(queryFirmDemo(config)).toMatchObject({ integrityVerified: false, query: { traces: [] } });
  });

  it('honors a local kill marker before enrollment', async () => {
    writeFileSync(join(root, 'KILL'), 'stop', { mode: 0o600 });
    expect(await runFirmDemo(config)).toMatchObject({ status: 'stopped', counts: { traces: 0 } });
    expect(existsSync(join(root, 'control-graph'))).toBe(false);
  });

  it('honors a pre-cancelled caller without enrollment', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await runFirmDemo({ ...config, signal: controller.signal })).toMatchObject({ status: 'stopped', counts: { traces: 0 } });
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects nonprivate, missing and symlinked roots without creating them', async () => {
    chmodSync(root, 0o755);
    await expect(runFirmDemo(config)).rejects.toThrow();
    chmodSync(root, 0o700);
    await expect(runFirmDemo({ ...config, root: join(root, 'missing') })).rejects.toThrow();
    expect(existsSync(join(root, 'missing'))).toBe(false);
    symlinkSync(root, join(root, 'alias'));
    await expect(runFirmDemo({ ...config, root: join(root, 'alias') })).rejects.toThrow();
  });

  it.each(['.', '', '/', 'relative/path', 'x/../y'])('requires an explicit absolute canonical private root: %s', async (invalidRoot) => {
    await expect(runFirmDemo({ ...config, root: invalidRoot })).rejects.toThrow();
  });

  it('rejects absolute root normalization rather than silently changing the selected root', async () => {
    await expect(runFirmDemo({ ...config, root: `${root}/` })).rejects.toThrow();
    await expect(runFirmDemo({ ...config, root: `${root}/../${root.split('/').at(-1)}` })).rejects.toThrow();
  });

  it('rejects unknown options, accessor fields and malformed injected keys without running getters', async () => {
    const getter = vi.fn(() => root);
    const invalid = Object.defineProperty({}, 'root', { get: getter });
    await expect(runFirmDemo(invalid as FirmDemoOptions)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    await expect(runFirmDemo({ ...config, command: 'unsafe' } as FirmDemoOptions)).rejects.toThrow();
    await expect(runFirmDemo({ root, traceKeys: { testKey: Buffer.alloc(0) } })).rejects.toThrow();
    await expect(runFirmDemo({ ...config, signal: {} as AbortSignal })).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('firm CLI boundary', () => {
  it.each([[], ['--help'], ['demo', '--help'], ['query', '--help'], ['status', '-h']].map((args) => [args]))('supports help without a root: %j', async (args) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdUniverseFirm(args)).toBe(0);
    expect(out.mock.calls.flat().join(' ')).toContain('existing-private-dir');
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([['demo'], ['demo', '--root'], ['demo', '--root', 'x', '--test-key', 'secret'],
    ['demo', '--root', 'x', '--root', 'y'], ['query', '--root', 'x', '--limit', '257'],
    ['status', '--root', 'x', '--entity', 'node:plan'], ['execute', '--root', 'x']].map((args) => [args]))('rejects unsupported authority or malformed arguments: %j', async (args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdUniverseFirm(args)).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });

  it('returns machine-readable unavailable for a missing key, without creating one', async () => {
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(null);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await cmdUniverseFirm(['demo', '--root', root, '--json'])).toBe(1);
    expect(JSON.parse(String(out.mock.calls[0]![0])).status).toBe('unavailable');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('runs demo, status and a filtered query with an inert mocked existing-key loader', async () => {
    // No host credential is read or created: the default loader is replaced only in this test.
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(randomBytes(32));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await cmdUniverseFirm(['demo', '--root', root, '--json'])).toBe(0);
    const first = JSON.parse(String(out.mock.calls.at(-1)![0]));
    expect(first.status).toBe('accepted-fixture');
    expect(await cmdUniverseFirm(['status', '--root', root, '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toEqual(first);
    expect(await cmdUniverseFirm(['query', '--root', root, '--entity', 'node:verify-liar', '--limit', '2', '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toMatchObject({ integrityVerified: true, query: { total: 2 } });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('redacts root failures and keeps status read-only', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdUniverseFirm(['status', '--root', join(root, 'private-missing'), '--json'])).toBe(1);
    expect(out.mock.calls.flat().join(' ')).not.toContain(root);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ status: 'unavailable' });
    expect(readdirSync(root)).toEqual([]);
  });
});
