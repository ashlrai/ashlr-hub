/** Real campaign delivery and successor registration. No provider or successor execution. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse, manifestRecord, projectUniverse } from '../src/core/universe/store.js';
import { initUniverseCampaign, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { runUniverseCampaign } from '../src/core/universe/campaign.js';
import { deliverCompletedUniverseCampaign } from '../src/core/universe/campaign-delivery.js';
import { validateUniverseCampaignDeliverySource } from '../src/core/universe/campaign-handoff.js';
import { readPreparedResourceEngineeringBundle } from '../src/core/resources/engineering-preparation.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle, readResourceEngineeringSuccessorBundle,
  type ResourceEngineeringSuccessorPreparationOptions, type ResourceEngineeringSuccessorRecipe } from '../src/core/resources/engineering-successor-preparation.js';
import * as privateFiles from '../src/core/util/private-file-write.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as handoff from '../src/core/universe/campaign-handoff.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-successor-'))); roots.push(base);
  const repo = join(base, 'repo'); const sourceRoot = join(base, 'source'); const transport = join(base, 'transport');
  for (const directory of [repo, sourceRoot, transport]) mkdirSync(directory, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main');
  execFileSync('git', ['init', '-q', '--template=', '--initial-branch=main', transport]);
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'worker.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('value.json',process.env.ASHLR_UNIVERSE_GENERATION+'\\n');");
  writeFileSync(join(repo, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';" +
    "const score=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));" +
    'console.log(JSON.stringify({passed:true,score,metrics:{value:score}}));');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const revision = git('rev-parse', 'HEAD');
  initUniverse({ schemaVersion: 1, id: 'upstream', name: 'Upstream', objective: 'Improve fixed value', seed: { repo, revision },
    metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5000 },
    variants: [{ id: 'improve', niche: 'value', hypothesis: 'Increase value', command: [process.execPath, 'worker.mjs'] }] }, { root: sourceRoot });
  initUniverseCampaign({ schemaVersion: 1, id: 'upstream-campaign', universeId: 'upstream', feedback: true,
    budget: { maxGenerations: 2, maxDurationMs: 45_000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root: sourceRoot });
  const campaign = await runUniverseCampaign('upstream-campaign', { root: sourceRoot }); expect(campaign.state).toBe('completed');
  const delivery = { branch: 'codex/upstream', baseCommit: revision };
  const delivered = await deliverCompletedUniverseCampaign('upstream-campaign', { root: sourceRoot, delivery });
  if (delivered.delivery.status !== 'delivered') throw new Error('Fixture requires real delivered improvement: ' + JSON.stringify({
    delivery: delivered.delivery, runs: projectUniverse(join(sourceRoot, 'universes', 'upstream')).runs.map(run => ({
      status: run.status, trials: run.trials.map(trial => ({ status: trial.status, score: trial.score, parent: trial.parentTrialId, delta: trial.delta, error: trial.error })) })) }));
  const receipt = delivered.delivery.receipt;
  const ledger = join(base, 'ledger'); const poolPath = join(base, 'pool.json'); const bindingsPath = join(base, 'bindings.json');
  const observationsPath = join(base, 'observations.json'); const resourceRuntime = join(base, 'runtime.json'); const projectsFile = join(base, 'projects.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 8, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  save(observationsPath, []); save(projectsFile, { schemaVersion: 1, projects: [] });
  save(resourceRuntime, { schemaVersion: 1, root: ledger, workspace: transport, poolPath, bindingsPath, observationsPath });
  const recipe: ResourceEngineeringSuccessorRecipe = { schemaVersion: 1, id: 'successor', name: 'Successor', objective: 'Improve the delivered value', projectId: 'default',
    metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 45_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve again' }] }, delivery: { branch: 'codex/successor' },
    execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 90_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const options: ResourceEngineeringSuccessorPreparationOptions = { recipe, output: join(base, 'successor'), resourceRuntime, projectsFile, workspace: repo,
    source: { root: sourceRoot, campaignId: campaign.definition.id, expectedDefinitionDigest: campaign.definitionDigest,
      expectedManifestDigest: campaign.manifestDigest, expectedComparatorDigest: campaign.comparatorDigest, delivery, expectedDeliveryDigest: digest(canonical(receipt)) } };
  return { base, options, recipe, git, receipt, ledger, sourceRoot, revision };
}

describe('campaign-delivery successor preparation', () => {
  it('pins a distinct successor to the delivered commit, records honest origin, and replays without effects', async () => {
    const f = await fixture(); const before = tree(f.base); const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
    const plan = checkResourceEngineeringSuccessorPreparation(f.options); expect(tree(f.base)).toEqual(before);
    expect(plan.seedRevision).toBe(f.receipt.commit); expect(plan.campaignDeliveryOrigin).toMatchObject({ campaignId: 'upstream-campaign',
      universeId: 'upstream', runId: f.receipt.runId, trialId: f.receipt.trialId, artifactDigest: f.receipt.artifactDigest });
    const prepared = await prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest });
    const directory = join(prepared.paths.universeRoot, 'universes', 'successor'); const record = manifestRecord(directory);
    expect(record.campaignDeliveryOrigin).toEqual(plan.campaignDeliveryOrigin); expect(record.integrationOrigin).toBeUndefined();
    expect(record.seedArtifact.digest).toBe(f.receipt.artifactDigest); expect(readFileSync(join(record.seedArtifact.path, 'value.json'), 'utf8')).toBe('2\n');
    expect(projectUniverse(directory).runs).toEqual([]); expect(readUniverseCampaign('successor', { root: prepared.paths.universeRoot }).steps).toEqual([]);
    const saved = tree(f.base);
    expect(readResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toEqual({ ...prepared, disposition: 'replayed' });
    expect(await prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toEqual({ ...prepared, disposition: 'replayed' });
    expect(tree(f.base)).toEqual(saved); expect(evaluations).not.toHaveBeenCalled(); expect(existsSync(f.ledger)).toBe(false);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.revision); expect(f.git('status', '--porcelain=v1')).toBe('');
    const { source: _source, ...ordinary } = f.options;
    expect(() => readPreparedResourceEngineeringBundle({ ...ordinary,
      recipe: { ...f.recipe, seedRevision: f.receipt.commit }, expectedPlanDigest: plan.planDigest })).toThrow();
    unlinkSync(prepared.paths.receipt); const incomplete = tree(f.base);
    await expect(prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).rejects.toThrow('Incomplete preparation');
    expect(tree(f.base)).toEqual(incomplete);
  });

  it('rejects changed source pins and recipe-supplied seed identity without destination writes', async () => {
    const f = await fixture(); const before = tree(f.base);
    for (const key of ['expectedDefinitionDigest', 'expectedManifestDigest', 'expectedComparatorDigest', 'expectedDeliveryDigest'] as const) {
      expect(() => checkResourceEngineeringSuccessorPreparation({ ...f.options, source: { ...f.options.source, [key]: '0'.repeat(64) } })).toThrow();
    }
    expect(() => checkResourceEngineeringSuccessorPreparation({ ...f.options, recipe: { ...f.recipe, seedRevision: f.revision } })).toThrow();
    expect(() => checkResourceEngineeringSuccessorPreparation({ ...f.options, recipe: { ...f.recipe, id: 'upstream' } })).toThrow();
    const getter = vi.fn(() => f.options.source.root);
    expect(() => validateUniverseCampaignDeliverySource({ ...f.options.source, get root() { return getter(); } })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
  });

  it('rechecks source after destination manifest staging and retains incomplete output on refusal', async () => {
    const f = await fixture(); const plan = checkResourceEngineeringSuccessorPreparation(f.options);
    const original = privateFiles.writePrivateFileAtomically; let changed = false;
    vi.spyOn(privateFiles, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!changed && target.includes('/successor/universe/universes/successor/ledger/staging/') && target.endsWith('.stage')) {
        changed = true; f.git('update-ref', 'refs/heads/codex/upstream', f.revision);
      }
    });
    await expect(prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(changed).toBe(true); expect(existsSync(plan.paths.receipt)).toBe(false);
    expect(existsSync(join(plan.paths.universeRoot, 'universes', 'successor', 'ledger', 'records', 'manifest.json'))).toBe(false);
    expect(existsSync(f.options.output)).toBe(true); expect(existsSync(f.ledger)).toBe(false);
  });

  it('refuses replay after the source branch is replaced instead of trusting retained origin alone', async () => {
    const f = await fixture(); const plan = checkResourceEngineeringSuccessorPreparation(f.options);
    await prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest });
    f.git('update-ref', 'refs/heads/codex/upstream', f.revision); const changed = tree(f.base);
    expect(() => readResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow();
    await expect(prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(changed);
  });

  it.each(['source', 'stage'] as const)('refuses %s replacement during the final receipt source check', async kind => {
    const f = await fixture(); const plan = checkResourceEngineeringSuccessorPreparation(f.options);
    const original = handoff.readUniverseCampaignDeliverySource; let changed = false; const stage = join(f.options.output, '.receipt.stage');
    vi.spyOn(handoff, 'readUniverseCampaignDeliverySource').mockImplementation((source, requestDigest) => {
      if (!changed && existsSync(stage)) {
        changed = true;
        if (kind === 'source') f.git('update-ref', 'refs/heads/codex/upstream', f.revision);
        else { unlinkSync(stage); save(stage, { replaced: true }); }
      }
      return original(source, requestDigest);
    });
    await expect(prepareResourceEngineeringSuccessorBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(changed).toBe(true); expect(existsSync(plan.paths.receipt)).toBe(false); expect(existsSync(stage)).toBe(true);
    expect(existsSync(f.ledger)).toBe(false);
  });
});
