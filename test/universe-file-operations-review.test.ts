import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readUniverseOverview, runUniverseCampaign, type UniverseTrial } from '../src/core/universe/index.js';
import { buildUniverseFileOperationsContext, fileOperationsContextDigest } from '../src/core/universe/file-operations-context.js';
import { newGenerationReceipt, validGenerationReceipt } from '../src/core/universe/generation.js';
import { manifestRecord, projectUniverse, readRecords, universePath, type UniverseRecord } from '../src/core/universe/store.js';
import { fileOperationsFixture, fixtureSnapshot, sha256 } from './helpers/universe-file-operations-fixture.js';

describe.runIf(process.platform === 'darwin')('independent file-operation evidence review', () => {
  let fixture: Awaited<ReturnType<typeof fileOperationsFixture>>;
  let records: UniverseRecord[];
  let directory: string;
  let before: Record<string, string>;
  beforeAll(async () => {
    fixture = await fileOperationsFixture({ kind: 'delete', generations: 2, respond: (_prompt, index) => index === 0 ? [
      { op: 'create', path: 'helper.mjs', content: 'export const value = 1;\n' },
      { op: 'replace', path: 'entry.mjs', content: "import {value} from './helper.mjs'; console.log(value);\n" },
      { op: 'delete', path: 'legacy.mjs' },
    ] : [{ op: 'replace', path: 'helper.mjs', content: 'export const value = 2;\n' }] });
    const result = await runUniverseCampaign(fixture.definition.id, fixture);
    expect(result.state, JSON.stringify(result)).toBe('completed');
    directory = universePath(fixture.root, fixture.manifest.id); records = readRecords(directory);
    expect(projectUniverse(directory, records).sourceState).toBe('healthy');
    before = fixtureSnapshot(fixture.base);
  });
  afterAll(async () => { if (fixture) await fixture.dispose(); });

  function mutateTrial(index: number, change: (trial: UniverseTrial) => void): UniverseRecord[] {
    const copy = structuredClone(records);
    const run = readUniverseOverview(fixture).universes[0]!.runs[index]!;
    for (const record of copy) {
      if (record.kind === 'trial' && record.runId === run.id) change(record.trial);
      if (record.kind === 'final' && record.run.id === run.id) record.run.trials.forEach(change);
    }
    return copy;
  }

  it('replays completed operations repeatedly without source mutation, contact, or protocol upgrades', () => {
    const first = projectUniverse(directory, records);
    expect(projectUniverse(directory, records)).toEqual(first);
    expect(first.runs.map((run) => run.tokensUsed)).toEqual([30, 30]);
    expect(first.runs.map((run) => run.trials[0]!.generation!.fileOperations!.schemaVersion)).toEqual([1, 1]);
    expect(fixture.requests).toHaveLength(2); expect(fixtureSnapshot(fixture.base)).toEqual(before);
  });

  it.each(['missing', 'wrong-context', 'wrong-create-digest', 'wrong-delete-digest', 'omitted-change', 'read-only-path'] as const)(
    'rejects matching raw/final evidence with %s operation provenance', (change) => {
      const altered = mutateTrial(0, (trial) => {
        const generation = trial.generation!; const receipt = generation.fileOperations!;
        if (change === 'missing') delete generation.fileOperations;
        if (change === 'wrong-context') receipt.contextDigest = 'f'.repeat(64);
        if (change === 'wrong-create-digest') receipt.operations.find((operation) => operation.op === 'create')!.afterDigest = 'e'.repeat(64);
        if (change === 'wrong-delete-digest') receipt.operations.find((operation) => operation.op === 'delete')!.beforeDigest = 'e'.repeat(64);
        if (change === 'omitted-change') {
          receipt.operations = receipt.operations.filter((operation) => operation.op !== 'delete');
          generation.changedFiles = receipt.operations.map((operation) => operation.path);
        }
        if (change === 'read-only-path') {
          receipt.operations[0]!.path = 'contract.txt'; generation.changedFiles = receipt.operations.map((operation) => operation.path);
        }
      });
      expect(() => projectUniverse(directory, altered)).toThrow(/file|scope|generation|context|outcome|change/i);
      expect(fixture.requests).toHaveLength(2); expect(fixtureSnapshot(fixture.base)).toEqual(before);
    });

  it.each(['parent-absence-as-empty', 'previous-deletion-as-empty', 'read-only-context'] as const)(
    'binds the prompt receipt to exact %s source state', (change) => {
      const index = change === 'parent-absence-as-empty' ? 0 : 1;
      const summary = projectUniverse(directory, records); const prefix = { ...summary, runs: summary.runs.slice(0, index),
        elites: index === 0 ? [] : [{ ...summary.elites[0]!, trialId: summary.runs[0]!.trials[0]!.id, runId: summary.runs[0]!.id,
          generation: 1, score: 1, artifact: summary.runs[0]!.trials[0]!.artifact! }] };
      const pinned = manifestRecord(directory, records);
      const context = buildUniverseFileOperationsContext(prefix, fixture.manifest.variants[0]!, directory, pinned.seedArtifact, { feedback: true });
      if (change === 'parent-absence-as-empty') context.files.find((file) => file.path === 'helper.mjs')!.contentDigest = sha256('');
      if (change === 'previous-deletion-as-empty') context.previous!.files.find((file) => file.path === 'legacy.mjs')!.contentDigest = sha256('');
      if (change === 'read-only-context') {
        context.contextFiles[0]!.content = 'Other requirements'; context.contextFiles[0]!.contentDigest = sha256('Other requirements');
      }
      const altered = mutateTrial(index, (trial) => { trial.generation!.fileOperations!.contextDigest = fileOperationsContextDigest(context); });
      expect(() => projectUniverse(directory, altered)).toThrow(/file-state context/i);
    });

  it('keeps legacy receipt shape unchanged and requires opt-in context only with a constructed prompt', () => {
    const modern = fixture.manifest.variants[0]!.generation!;
    const { fileOperations: _fileOperations, ...legacy } = modern;
    const legacyReceipt = newGenerationReceipt(legacy);
    expect(legacyReceipt).not.toHaveProperty('fileOperations'); expect(validGenerationReceipt(legacyReceipt)).toBe(true);
    const fresh = newGenerationReceipt(modern);
    expect(fresh.fileOperations).toEqual({ schemaVersion: 1, contextDigest: null, operations: [] });
    expect(validGenerationReceipt(fresh)).toBe(true);
    fresh.fileOperations!.contextDigest = 'a'.repeat(64);
    expect(validGenerationReceipt(fresh)).toBe(false);
  });

  it('rejects unknown receipt versions and claimed byte-identical changes at the receipt codec', () => {
    const run = projectUniverse(directory, records).runs[1]!;
    const receipt = structuredClone(run.trials[0]!.generation!);
    Object.assign(receipt.fileOperations!, { schemaVersion: 2 }); expect(validGenerationReceipt(receipt)).toBe(false);
    receipt.fileOperations!.schemaVersion = 1;
    receipt.fileOperations!.operations[0]!.afterDigest = receipt.fileOperations!.operations[0]!.beforeDigest;
    expect(validGenerationReceipt(receipt)).toBe(false);
  });
});
