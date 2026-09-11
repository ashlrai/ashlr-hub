/** Real private bundle metadata reads; no worker or evaluator during inspection. */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse } from '../src/core/universe/store.js';
import { initUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { runUniverseCampaign } from '../src/core/universe/campaign.js';
import { deliverCompletedUniverseCampaign } from '../src/core/universe/campaign-delivery.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringBundle,
  readPreparedResourceEngineeringMetadata, type ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle,
  readResourceEngineeringSuccessorMetadata } from '../src/core/resources/engineering-successor-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';
import * as runtimeCheck from '../src/core/universe/resource-runtime-check.js';
import * as engineering from '../src/core/resources/console-engineering.js';
import * as handoff from '../src/core/universe/campaign-handoff.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700);
    for (const name of readdirSync(file)) writable(join(file, name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-metadata-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const ledger = join(base, 'ledger');
  for (const dir of [workspace, transport]) { mkdirSync(dir, { mode: 0o700 }); git(dir, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const score=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:true,score,metrics:{value:score}}));");
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolPath = join(base, 'pool.json'); const bindingsPath = join(base, 'bindings.json'); const observationsPath = join(base, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]); save(observationsPath, []);
  const resourceRuntime = join(base, 'runtime.json'); const runtime = { schemaVersion: 1, root: ledger, workspace: transport, poolPath, bindingsPath, observationsPath };
  save(resourceRuntime, runtime); const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'repair', name: 'Bounded repair', objective: 'Improve a measured value', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 45_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/prepared' },
    execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 90_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  return { base, ledger, runtime, options: { recipe, workspace, resourceRuntime, projectsFile, output: join(base, 'bundle') } };
}
function prepared() {
  const f = fixture(); const plan = checkResourceEngineeringPreparation(f.options);
  const input = { ...f.options, expectedPlanDigest: plan.planDigest };
  return { ...f, input, report: prepareResourceEngineeringBundle(input) };
}

describe('verified preparation metadata inspection', () => {
  it('retains both runtime captures and enrollment validation, without computing commissioning or writing', () => {
    const f = prepared(); const before = tree(f.base);
    const commission = vi.spyOn(commissioning, 'checkResourceConsoleEngineering');
    const runtime = vi.spyOn(runtimeCheck, 'checkResourceGenerationRuntime');
    const enrollment = vi.spyOn(engineering, 'prepareResourceConsoleEngineeringEnrollments');
    const metadata = readPreparedResourceEngineeringMetadata(f.input);
    const { commissioning: _commission, consoleArguments: _arguments, ...expected } = f.report;
    expect(metadata).toEqual({ ...expected, disposition: 'replayed' });
    expect(runtime).toHaveBeenCalledTimes(2); expect(enrollment).toHaveBeenCalledTimes(1); expect(commission).not.toHaveBeenCalled();
    expect(tree(f.base)).toEqual(before);
    metadata.paths.receipt = '/caller-only';
    expect(readPreparedResourceEngineeringMetadata(f.input).paths.receipt).toBe(f.report.paths.receipt);
    expect(runtime).toHaveBeenCalledTimes(4); expect(enrollment).toHaveBeenCalledTimes(2); expect(commission).not.toHaveBeenCalled();
    expect(readPreparedResourceEngineeringBundle(f.input)).toEqual({ ...f.report, disposition: 'replayed' });
    expect(commission).toHaveBeenCalledTimes(1); expect(tree(f.base)).toEqual(before);
  });
  it.each(['runtime', 'project', 'comparator', 'receipt'] as const)('refuses %s drift within the same metadata inspection', kind => {
    const f = prepared(); const original = engineering.prepareResourceConsoleEngineeringEnrollments;
    let changed = false;
    vi.spyOn(engineering, 'prepareResourceConsoleEngineeringEnrollments').mockImplementation(input => {
      const result = original(input);
      if (!changed) {
        changed = true;
        if (kind === 'runtime') save(f.options.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
        else if (kind === 'project') { const retained = join(f.base, 'retained-project'); renameSync(f.options.workspace, retained); cpSync(retained, f.options.workspace, { recursive: true }); }
        else if (kind === 'comparator') { const file = join(f.report.paths.universeRoot, 'universes', 'repair', 'seed', 'evaluate.mjs'); chmodSync(file, 0o600); writeFileSync(file, 'throw Error("changed");'); }
        else save(f.report.paths.receipt, { ...JSON.parse(readFileSync(f.report.paths.receipt, 'utf8')), enrollmentDigest: 'f'.repeat(64) });
      }
      return result;
    });
    const commission = vi.spyOn(commissioning, 'checkResourceConsoleEngineering');
    expect(() => readPreparedResourceEngineeringMetadata(f.input)).toThrow(); expect(changed).toBe(true);
    expect(commission).not.toHaveBeenCalled();
    const afterFault = tree(f.base); expect(() => readPreparedResourceEngineeringMetadata(f.input)).toThrow(); expect(tree(f.base)).toEqual(afterFault);
  });
  it('rejects accessor and inherited options without invoking getters or touching storage', () => {
    const getter = vi.fn(); const input = { recipe: {}, output: '/missing', resourceRuntime: '/missing/runtime', workspace: '/missing/project',
      projectsFile: '/missing/projects', expectedPlanDigest: 'a'.repeat(64) };
    expect(() => readPreparedResourceEngineeringMetadata({ ...input, get recipe() { return getter(); } })).toThrow();
    expect(() => readPreparedResourceEngineeringMetadata(Object.create(input))).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('retains fresh successor source checks including the final return guard without commissioning', async () => {
    const f = fixture(); const root = join(f.base, 'source'); mkdirSync(root, { mode: 0o700 });
    initUniverse({ schemaVersion: 1, id: 'upstream', name: 'Upstream', objective: 'Improve fixed value',
      seed: { repo: f.options.workspace, revision: f.options.recipe.seedRevision }, metric: f.options.recipe.metric,
      budget: f.options.recipe.trialBudget, evaluation: f.options.recipe.evaluation,
      variants: [{ id: 'improve', niche: 'value', hypothesis: 'Improve value', command: [process.execPath, '-e',
        "require('node:fs').writeFileSync('value.json',process.env.ASHLR_UNIVERSE_GENERATION+'\\n')"] }] }, { root });
    initUniverseCampaign({ schemaVersion: 1, id: 'upstream-campaign', universeId: 'upstream', feedback: true,
      budget: { ...f.options.recipe.campaignBudget, maxModelRequests: 0 } }, { root });
    const campaign = await runUniverseCampaign('upstream-campaign', { root }); expect(campaign.state).toBe('completed');
    const delivery = { branch: 'codex/upstream', baseCommit: f.options.recipe.seedRevision };
    const delivered = await deliverCompletedUniverseCampaign('upstream-campaign', { root, delivery });
    if (delivered.delivery.status !== 'delivered') throw Error('Fixture requires actual delivered improvement');
    const { seedRevision: _seed, ...recipe } = f.options.recipe;
    const options = { ...f.options, recipe, source: { root, campaignId: campaign.definition.id,
      expectedDefinitionDigest: campaign.definitionDigest, expectedManifestDigest: campaign.manifestDigest,
      expectedComparatorDigest: campaign.comparatorDigest, delivery, expectedDeliveryDigest: digest(canonical(delivered.delivery.receipt)) } };
    const plan = checkResourceEngineeringSuccessorPreparation(options); const input = { ...options, expectedPlanDigest: plan.planDigest };
    const report = await prepareResourceEngineeringSuccessorBundle(input);
    const commission = vi.spyOn(commissioning, 'checkResourceConsoleEngineering');
    const original = handoff.readUniverseCampaignDeliverySource; const source = vi.spyOn(handoff, 'readUniverseCampaignDeliverySource');
    const before = tree(f.base); const metadata = readResourceEngineeringSuccessorMetadata(input);
    const { commissioning: _commission, consoleArguments: _arguments, ...expected } = report;
    expect(metadata).toEqual({ ...expected, disposition: 'replayed' }); expect(source).toHaveBeenCalledTimes(6);
    expect(commission).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
    const bundleBefore = tree(options.output); let reads = 0;
    source.mockImplementation((...args) => {
      if (++reads === 6) git(f.options.workspace, 'update-ref', 'refs/heads/codex/upstream', delivery.baseCommit);
      return original(...args);
    });
    expect(() => readResourceEngineeringSuccessorMetadata(input)).toThrow(); expect(reads).toBe(6);
    expect(commission).not.toHaveBeenCalled(); expect(tree(options.output)).toEqual(bundleBefore);
  });
});
