import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as privateRecords from '../src/core/util/immutable-private-record-store.js';
import * as engineering from '../src/core/universe/firm-engineering-control-handler.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { signDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import { readControlGraph, runControlGraph, type ControlGraphDefinition, type ControlGraphHandler,
  type ControlHandlerResult } from '../src/core/universe/control-graph.js';

let root: string;
const traceKeys = { testKey: Buffer.alloc(32, 73) };
const metadata = { constitutionVersion: 'recovery-fixture', policyEpoch: 1, bindingDigest: 'a'.repeat(64) };
const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'recovery-guards', maxConcurrent: 1, maxDurationMs: 60_000,
  nodes: [{ id: 'work', kind: 'explore', requires: [], input: {} }, { id: 'consumer', kind: 'plan', requires: ['work'], input: {} }] };
beforeEach(() => { root = realpathSync(mkdtempSync(join(homedir(), 'control-recovery-guards-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function records(): string[] {
  const directory = join(root, 'control-graph', 'records');
  return readdirSync(directory).sort().map((name) => readFileSync(join(directory, name), 'utf8'));
}
const completed = (): ControlHandlerResult => ({ artifact: 'must-not-be-adopted', outcome: 'completed',
  verifier: { id: 'untrusted-callback', verdict: 'pass', independent: true } });

describe('graph recovery remains exclusive to the concrete engineering factory', () => {
  it('derives parent linkage from the exact already-persisted signed intent and canonical graph root', async () => {
    const run = vi.fn<ControlGraphHandler>(async (context) => {
      const persisted = records().map((text) => JSON.parse(text));
      expect(persisted.at(-1)).toMatchObject({ kind: 'intent', nodeId: 'work' });
      expect(context.graphDispatch).toEqual({ schemaVersion: 1, graphRootDigest: digest(canonical(root)),
        graphId: definition.id, definitionDigest: digest(canonical(definition)), nodeId: 'work',
        intentDigest: digest(canonical(persisted.at(-1))) });
      return completed();
    });
    const report = await runControlGraph(definition, { root, traceKeys, handlers: {
      explore: { ...metadata, effectClass: 'resource-completion', run }, plan: async () => ({ artifact: 'consumed' }),
    } });
    expect(report.status).toBe('completed'); expect(run).toHaveBeenCalledOnce();
  });

  it.each(['legacy', 'resource'] as const)('never retries an unresolved %s handler or invokes an attached recovery hook', async (kind) => {
    const run = vi.fn<ControlGraphHandler>(async () => { throw new Error('Fixture lost settlement'); });
    const recover = vi.fn(async () => completed());
    Object.assign(run, { recover });
    const handler = kind === 'legacy' ? run : { ...metadata, effectClass: 'resource-completion' as const, run };
    const consumer = vi.fn(async () => ({ artifact: 'must-not-consume' }));
    const options = { root, traceKeys, handlers: { explore: handler, plan: consumer } };
    expect((await runControlGraph(definition, options)).nodes.map((row) => row.state)).toEqual(['unresolved', 'pending']);
    const before = records(); run.mockImplementation(async () => completed());
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await runControlGraph(definition, options)).nodes.map((row) => row.state)).toEqual(['unresolved', 'pending']);
    }
    expect(run).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled(); expect(consumer).not.toHaveBeenCalled();
    expect(records()).toEqual(before);
  });

  it.each(['unbranded', 'publication-kill'] as const)('withholds signed unresolved engineering recovery for %s', async (boundary) => {
    const graph: ControlGraphDefinition = { ...definition, nodes: [{ id: 'work', kind: 'deliver', requires: [], input: {
      bindingDigest: metadata.bindingDigest, requestDigest: 'b'.repeat(64),
    } }] };
    const run = vi.fn<ControlGraphHandler>(async () => completed()); const recover = vi.fn(() => completed());
    Object.assign(run, { recover });
    const execution = { ...metadata, effectClass: 'engineering-portfolio-local-delivery' as const };
    const copied = { ...execution, run };
    const options = { root, traceKeys, handlers: { deliver: copied } };
    expect((await runControlGraph(graph, options)).nodes[0]!.state).toBe('pending');
    // A test-key-signed intent isolates the registration/recovery boundary. It
    // is not a fabricated campaign, delivery receipt, or provider completion.
    const created = JSON.parse(records()[0]!);
    const body = { sequence: 1, previousDigest: digest(canonical(created)), kind: 'intent', nodeId: 'work',
      definitionDigest: digest(canonical(graph)), data: { inputDigests: [], execution } };
    const trace = signDecisionTraceV1({ id: `${graph.id}:1`, ts: new Date().toISOString(),
      entities: [`graph:${graph.id}`, 'node:work'], action: 'graph-intent', constitutionVersion: metadata.constitutionVersion,
      policyEpoch: metadata.policyEpoch, inputsDigest: digest(canonical(body)),
      verifier: { id: 'pending', verdict: 'unavailable', independent: false },
      authority: { effectClass: execution.effectClass }, spend: { unknown: true }, conflicts: [] }, traceKeys);
    expect(trace).not.toBeNull();
    writeFileSync(join(root, 'control-graph', 'records', '00000001.json'), `${canonical({ ...body, trace })}\n`, { mode: 0o600 });
    expect(readControlGraph(root, traceKeys)).toMatchObject({ sourceState: 'healthy', nodes: [{ state: 'unresolved' }] });
    const before = records();
    let publicationVetoes = 0;
    if (boundary === 'publication-kill') {
      // Kernel-only injected trusted registration: this is not engineering
      // proof acceptance. The real factory/crash path is tested separately.
      vi.spyOn(engineering, 'isFirmEngineeringControlHandler').mockImplementation((value) => value === copied);
      vi.spyOn(engineering, 'firmEngineeringControlRecovery').mockImplementation((value) => value === copied ? recover : undefined);
      const write = privateRecords.writeImmutablePrivateRecord;
      vi.spyOn(privateRecords, 'writeImmutablePrivateRecord').mockImplementation((configuration, row, writeOptions) => {
        if ((row as { kind: string }).kind === 'settled') {
          const prepublish = writeOptions!.prepublish!;
          expect(prepublish).toBeTypeOf('function');
          return write(configuration, row, { ...writeOptions, prepublish: () => {
            // Allow the writer's earlier checks; stop only after real staging
            // I/O, immediately before its no-clobber publication link.
            if (readdirSync(join(root, 'control-graph', 'staging')).length > 0) {
              publicationVetoes++;
              writeFileSync(join(root, 'KILL'), 'fixture publication stop\n', { mode: 0o600 });
            }
            return prepublish();
          } });
        }
        return write(configuration, row, writeOptions);
      });
    }
    const report = await runControlGraph(graph, options);
    expect(report.nodes[0]!.state).toBe('unresolved');
    if (boundary === 'publication-kill') expect(report.status).toBe('stopped');
    expect(run).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledTimes(boundary === 'unbranded' ? 0 : 1);
    expect(publicationVetoes).toBe(boundary === 'unbranded' ? 0 : 1);
    expect(records()).toEqual(before);
  });
});
