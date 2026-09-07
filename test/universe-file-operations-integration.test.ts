import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverUniverseElite, initUniverse, initUniverseCampaign, readUniverseCampaignComparison, readUniverseGraph, readUniverseOverview,
  runUniverse, runUniverseCampaign, traverseUniverseGraph } from '../src/core/universe/index.js';
import { fileOperationsFixture, fixtureSnapshot, PARSER_CASE_COUNT, parserHelper, parserSourcePath,
  sha256, type Operation } from './helpers/universe-file-operations-fixture.js';

type Fixture = Awaited<ReturnType<typeof fileOperationsFixture>>;
const fixtures: Fixture[] = [];
const fixture = async (options: Parameters<typeof fileOperationsFixture>[0] = {}): Promise<Fixture> => {
  const value = await fileOperationsFixture(options); fixtures.push(value); return value;
};
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose(); });

const replacement: Operation[] = [
  { op: 'create', path: 'helper.mjs', content: 'export const value = 1;\n' },
  { op: 'replace', path: 'entry.mjs', content: "import {value} from './helper.mjs'; console.log(value);\n" },
  { op: 'delete', path: 'legacy.mjs' },
];

describe.runIf(process.platform === 'darwin')('native versioned Universe file operations', () => {
  it('builds a new module for the real goal-loop parser, corrects rejected work, and delivers exact selected files', async () => {
    const value = await fixture(); const beforeSource = sha256(readFileSync(parserSourcePath));
    const beforeRepo = fixtureSnapshot(value.repo);
    const final = await runUniverseCampaign(value.definition.id, value);
    expect(final.state, JSON.stringify(final)).toBe('completed'); expect(final.definition).toEqual(value.definition);
    expect(final.progress).toMatchObject({ attempts: 3, completedRuns: 3, admissions: 1, improvements: 0, reportedTokens: 90 });
    const summary = readUniverseOverview(value).universes[0]!;
    expect(summary.sourceState).toBe('healthy'); expect(summary.runs).toHaveLength(3);
    const trials = summary.runs.map((run) => run.trials[0]!);
    expect(trials.map((trial) => trial.status)).toEqual(['failed', 'passed', 'passed']);
    expect(trials.map((trial) => trial.selected)).toEqual([false, true, false]);
    expect(trials.map((trial) => trial.parentTrialId)).toEqual([null, null, trials[1]!.id]);
    expect(trials.map((trial) => trial.delta)).toEqual([null, null, 0]);
    expect(trials[0]!.metrics.casesPassed).toBeLessThan(PARSER_CASE_COUNT);
    expect(trials.slice(1).map((trial) => trial.metrics.casesPassed)).toEqual([PARSER_CASE_COUNT, PARSER_CASE_COUNT]);
    expect(trials.every((trial) => trial.metrics.contextIntact === 1)).toBe(true);
    expect(value.requests).toHaveLength(3);
    const mutableHelper = value.requests.map((prompt) => prompt.files.find((file) => file.path === 'markdown-lines.ts')!.content);
    expect(mutableHelper).toEqual([null, null, parserHelper(true)]);
    expect(value.requests[1]!.feedback!.previousAttemptFiles.find((file) => file.path === 'markdown-lines.ts')!.content).toBe(parserHelper(false));
    expect(value.requests[1]!.fileOperationsContext!.previous!.files.find((file) => file.path === 'markdown-lines.ts')!.contentDigest).toBe(sha256(parserHelper(false)));
    expect(value.requests[1]!.fileOperationsContext!.files.find((file) => file.path === 'markdown-lines.ts')!.contentDigest).toBeNull();
    for (const prompt of value.requests) {
      expect(prompt.fileOperationsContext!.contextFiles).toEqual([{ path: 'types.ts', content: value.types, contentDigest: sha256(value.types) }]);
      expect(prompt.files.some((file) => file.path === 'types.ts' || file.path === 'evaluate.mjs')).toBe(false);
    }
    expect(trials[0]!.generation!.fileOperations!.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'create', path: 'markdown-lines.ts', beforeDigest: null, afterDigest: sha256(parserHelper(false)) }),
      expect.objectContaining({ op: 'replace', path: 'parse.ts' }),
    ]));
    expect(trials[2]!.generation!.fileOperations!.operations).toEqual([]);
    expect(trials[2]!.generation!.changedFiles).toEqual([]);
    expect(fixtureSnapshot(value.repo)).toEqual(beforeRepo); expect(sha256(readFileSync(parserSourcePath))).toBe(beforeSource);
    expect(await runUniverseCampaign(value.definition.id, value)).toEqual(final); expect(value.requests).toHaveLength(3);

    const branch = 'codex/independent-parser-module';
    const delivery = await deliverUniverseElite(value.manifest.id, { ...value, trialId: trials[1]!.id, branch });
    expect(delivery.status).toBe('delivered'); expect(delivery.changedFiles).toEqual(['markdown-lines.ts', 'parse.ts']);
    expect(value.git('rev-parse', `refs/heads/${branch}`)).toBe(delivery.commit);
    expect(value.git('show', `${delivery.commit}:markdown-lines.ts`)).toBe(parserHelper(true).trim());
    expect(value.git('rev-parse', 'HEAD')).toBe(value.manifest.seed.revision);
    expect(readFileSync(join(value.repo, 'parse.ts'), 'utf8')).toBe(value.parser);
    expect(existsSync(join(value.repo, 'markdown-lines.ts'))).toBe(false);
    const graph = readUniverseGraph(value.manifest.id, value);
    expect(graph.sourceState).toBe('healthy'); expect(graph.complete).toBe(true); expect(graph.counts.verifiedDeliveries).toBe(1);
    const node = graph.nodes.find((item) => item.deliveryId === delivery.id)!;
    const trace = traverseUniverseGraph(graph, { nodeId: node.id, direction: 'ancestors' });
    expect(trace.complete).toBe(true);
    expect(graph.nodes.some((item) => item.trialId === trials[1]!.id && item.kind === 'trial' && trace.nodeIds.includes(item.id))).toBe(true);
    const afterDelivery = fixtureSnapshot(value.base);
    expect(await deliverUniverseElite(value.manifest.id, { ...value, trialId: trials[1]!.id, branch })).toEqual(delivery);
    expect(fixtureSnapshot(value.base)).toEqual(afterDelivery);
  });

  it('retains deletion absence, replaces a created file, and rejects a later absent-delete conflict without losing usage', async () => {
    const value = await fixture({ kind: 'delete', respond: (_prompt, index) => index === 0 ? replacement : index === 1
      ? [{ op: 'replace', path: 'helper.mjs', content: 'export const value = 2;\n' }]
      : [{ op: 'delete', path: 'legacy.mjs' }] });
    const final = await runUniverseCampaign(value.definition.id, value);
    expect(final.state).toBe('completed'); expect(final.progress.reportedTokens).toBe(90);
    const summary = readUniverseOverview(value).universes[0]!; const trials = summary.runs.map((run) => run.trials[0]!);
    expect(trials.map((trial) => trial.status)).toEqual(['passed', 'passed', 'failed']);
    expect(trials.map((trial) => trial.selected)).toEqual([true, true, false]);
    expect(summary.elites[0]!.trialId).toBe(trials[1]!.id);
    expect(value.requests[1]!.files.find((file) => file.path === 'legacy.mjs')!.content).toBeNull();
    expect(value.requests[1]!.feedback!.previousAttemptFiles.some((file) => file.path === 'legacy.mjs')).toBe(false);
    expect(value.requests[1]!.fileOperationsContext!.previous!.files.find((file) => file.path === 'legacy.mjs')!.contentDigest).toBeNull();
    expect(trials[0]!.generation!.fileOperations!.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'delete', path: 'legacy.mjs', beforeDigest: sha256('export const value = 0;\n'), afterDigest: null }),
    ]));
    expect(trials[2]!.artifact).toBeNull(); expect(trials[2]!.generation!.fileOperations!.operations).toEqual([]);
    expect(trials[2]!.generation!.usage).toEqual({ state: 'reported', inputTokens: 20, outputTokens: 10 });
    expect(existsSync(join(trials[1]!.artifact!.path, 'legacy.mjs'))).toBe(false);
    expect(readFileSync(join(value.repo, 'legacy.mjs'), 'utf8')).toBe('export const value = 0;\n');
  });

  it.each(['read-only', 'existing-create', 'missing-replace'] as const)('rejects an entire mixed batch for %s conflict and keeps source/context intact', async (conflict) => {
    const invalid: Operation = conflict === 'read-only' ? { op: 'delete', path: 'contract.txt' }
      : conflict === 'existing-create' ? { op: 'create', path: 'legacy.mjs', content: 'export const value = 99;\n' }
        : { op: 'replace', path: 'helper.mjs', content: 'export const value = 99;\n' };
    const value = await fixture({ kind: 'delete', generations: 1, respond: () => [
      { op: 'replace', path: 'entry.mjs', content: 'console.log(99);\n' }, invalid,
    ] });
    const before = fixtureSnapshot(value.repo); const final = await runUniverseCampaign(value.definition.id, value);
    expect(final.progress.reportedTokens).toBe(30); expect(final.progress.admissions).toBe(0);
    const trial = readUniverseOverview(value).universes[0]!.runs[0]!.trials[0]!;
    expect(trial.status).toBe('failed'); expect(trial.artifact).toBeNull(); expect(trial.generation!.changedFiles).toEqual([]);
    expect(trial.generation!.fileOperations!.operations).toEqual([]); expect(value.requests).toHaveLength(1);
    expect(fixtureSnapshot(value.repo)).toEqual(before);
  });

  it('compares matched completed file-operation campaigns without executing requests or changing ledgers', async () => {
    const value = await fixture({ kind: 'delete', generations: 2, respond: (prompt) =>
      prompt.files.find((file) => file.path === 'helper.mjs')!.content === null ? replacement
        : [{ op: 'replace', path: 'helper.mjs', content: 'export const value = 2;\n' }] });
    const other = { ...value.manifest, id: 'file-operations-control' };
    initUniverse(other, value);
    initUniverseCampaign({ ...value.definition, id: 'control-campaign', universeId: other.id, feedback: false }, value);
    await runUniverseCampaign(value.definition.id, value); await runUniverseCampaign('control-campaign', value);
    const before = fixtureSnapshot(value.base);
    const report = readUniverseCampaignComparison('control-campaign', value.definition.id, value);
    expect(report.sourceState, JSON.stringify(report)).toBe('healthy'); expect(report.matching.comparable).toBe(true);
    expect(report.matching.comparator).toBe(true); expect(report.matching.configuration).toBe(true);
    for (const arm of [report.baseline, report.challenger]) {
      expect(arm.counts).toMatchObject({ attempts: 2, completedRuns: 2, admissions: 1, improvements: 1,
        distinctSelectedArtifacts: 2, modelRequestsStarted: 2, reportedModelRequests: 2 });
      expect(arm.usage).toEqual({ reportedTokens: 60, recordedTokens: 60, complete: true });
    }
    expect(report.acceptedChanges).toBeNull(); expect(value.requests).toHaveLength(4); expect(fixtureSnapshot(value.base)).toEqual(before);
  });

  it('cancels an owned file-operation request without admission and reads its interruption without replaying contact', async () => {
    const controller = new AbortController(); let release!: (value: Operation[]) => void;
    const response = new Promise<Operation[]>((resolve) => { release = resolve; });
    const value = await fixture({ kind: 'delete', onRequest: () => controller.abort(), respond: () => response });
    const before = fixtureSnapshot(value.repo);
    const run = await runUniverse(value.manifest.id, { ...value, signal: controller.signal });
    release(replacement);
    expect(run.status).toBe('interrupted'); expect(run.tokensUsed).toBeNull(); expect(run.trials.every((trial) => !trial.selected)).toBe(true);
    expect(run.trials[0]!.generation!.status).toBe('cancelled'); expect(run.trials[0]!.generation!.fileOperations!.operations).toEqual([]);
    expect(readUniverseOverview(value).universes[0]!.runs).toEqual([run]); expect(value.requests).toHaveLength(1);
    const report = readUniverseCampaignComparison('file-campaign', 'missing-campaign', value);
    expect(report.matching.comparable).toBe(false); expect(value.requests).toHaveLength(1);
    expect(fixtureSnapshot(value.repo)).toEqual(before);
  });
});
