/** Fixed trusted real two-generation source delivery. No model/provider calls and no successor execution. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest } from '../../src/core/universe/artifacts.js';
import { initUniverse, manifestRecord, projectUniverse } from '../../src/core/universe/store.js';
import { initUniverseCampaign, readUniverseCampaign } from '../../src/core/universe/campaign-store.js';
import { runUniverseCampaign } from '../../src/core/universe/campaign.js';
import { deliverCompletedUniverseCampaign } from '../../src/core/universe/campaign-delivery.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle,
  type ResourceEngineeringSuccessorPreparationOptions, type ResourceEngineeringSuccessorRecipe } from '../../src/core/resources/engineering-successor-preparation.js';

/** Caller owns an already-private, empty base and cleans it after every child has settled. */
export async function preparationSuccessorFixture(base: string, signal?: AbortSignal, deadlineMonotonicMs?: number) {
  const stat = lstatSync(base);
  assert.equal(realpathSync(base), base); assert.ok(stat.isDirectory()); assert.equal(stat.mode & 0o077, 0);
  const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
  const repo = join(base, 'repo'), sourceRoot = join(base, 'source'), transport = join(base, 'transport');
  for (const directory of [repo, sourceRoot, transport]) mkdirSync(directory, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main');
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '--template=', '--initial-branch=main', transport], {
    timeout: 10000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
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
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15000, trialTimeoutMs: 5000 },
    variants: [{ id: 'improve', niche: 'value', hypothesis: 'Increase value', command: [process.execPath, 'worker.mjs'] }] }, { root: sourceRoot });
  initUniverseCampaign({ schemaVersion: 1, id: 'upstream-campaign', universeId: 'upstream', feedback: true,
    budget: { maxGenerations: 2, maxDurationMs: 45000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root: sourceRoot });
  const campaign = await runUniverseCampaign('upstream-campaign', { root: sourceRoot, signal });
  assert.equal(campaign.state, 'completed');
  const runs = projectUniverse(join(sourceRoot, 'universes', 'upstream')).runs;
  assert.equal(runs.length, 2); assert.deepEqual(runs.map(run => run.trials[0]?.score), [1, 2]);
  const delivery = { branch: 'codex/upstream', baseCommit: revision };
  signal?.throwIfAborted();
  const delivered = await deliverCompletedUniverseCampaign('upstream-campaign', { root: sourceRoot, delivery, signal, deadlineMonotonicMs });
  assert.equal(delivered.delivery.status, 'delivered');
  if (delivered.delivery.status !== 'delivered') throw new Error('Fixture requires a verified delivered improvement');
  const receipt = delivered.delivery.receipt;
  const ledger = join(base, 'ledger'), poolPath = join(base, 'pool.json'), bindingsPath = join(base, 'bindings.json');
  const observationsPath = join(base, 'observations.json'), resourceRuntime = join(base, 'runtime.json'), projectsFile = join(base, 'projects.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 8, taskWindowMs: 60000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  save(observationsPath, []); save(projectsFile, { schemaVersion: 1, projects: [] });
  const runtime = { schemaVersion: 1, root: ledger, workspace: transport, poolPath, bindingsPath, observationsPath };
  save(resourceRuntime, runtime);
  const recipe: ResourceEngineeringSuccessorRecipe = { schemaVersion: 1, id: 'successor', name: 'Successor', objective: 'Improve the delivered value', projectId: 'default',
    metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 45000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve again' }] }, delivery: { branch: 'codex/successor' },
    execution: { maxDurationMs: 60000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 90000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const options: ResourceEngineeringSuccessorPreparationOptions = { recipe, output: join(base, 'successor'), resourceRuntime, projectsFile, workspace: repo,
    source: { root: sourceRoot, campaignId: campaign.definition.id, expectedDefinitionDigest: campaign.definitionDigest,
      expectedManifestDigest: campaign.manifestDigest, expectedComparatorDigest: campaign.comparatorDigest, delivery, expectedDeliveryDigest: digest(canonical(receipt)) } };
  const plan = checkResourceEngineeringSuccessorPreparation(options);
  const prepared = await prepareResourceEngineeringSuccessorBundle({ ...options, expectedPlanDigest: plan.planDigest });
  const universeDirectory = join(prepared.paths.universeRoot, 'universes', 'successor');
  const record = manifestRecord(universeDirectory);
  assert.equal(plan.seedRevision, receipt.commit); assert.equal(record.seedArtifact.digest, receipt.artifactDigest);
  assert.equal(readFileSync(join(record.seedArtifact.path, 'value.json'), 'utf8'), '2\n');
  assert.deepEqual(projectUniverse(universeDirectory).runs, []);
  assert.deepEqual(readUniverseCampaign('successor', { root: prepared.paths.universeRoot }).steps, []);
  assert.equal(git('rev-parse', 'HEAD'), revision); assert.equal(git('status', '--porcelain=v1'), '');
  return { base, repo, options, plan, prepared, receipt, revision, git, sourceRoot, ledger, runtime, save, record };
}
