/** Real generic evaluator/worker/Git/selection/delivery. This is not native
 * preparation scoring evidence; only the test's KILL observation is substituted. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readKillSwitch } from '../src/core/sandbox/policy.js';
import { initUniverse, manifestRecord, projectUniverse, readRecords, universePath } from '../src/core/universe/store.js';
import { campaignDirectory, initUniverseCampaign, readCampaignEvents, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { runUniverseCampaignAndDeliver } from '../src/core/universe/campaign-delivery.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { verifiedCampaignPassedSeedImprovement, verifiedInitialCampaignSeedImprovement } from '../src/core/universe/campaign-improvement.js';
import { readUniverseDeliveries } from '../src/core/universe/delivery.js';

vi.mock('../src/core/sandbox/policy.js', async original => ({ ...await original<object>(), readKillSwitch: vi.fn() }));
let root: string | undefined;
let preserve = false;
afterEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks();
  if (!root) return;
  if (preserve) {
    console.warn(`Passed-seed acceptance retained unconfirmed private fixture: ${root}`);
    root = undefined; return;
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root); rmSync(root, { recursive: true, force: true }); root = undefined;
});

describe.runIf(process.platform === 'darwin')('passed measured seed delivery acceptance', () => {
  it.each([
    { name: 'first candidate improvement', seed: 150, values: [149], delivered: true },
    { name: 'parent improvement that still regresses from seed', seed: 140, values: [145, 144], delivered: false },
    { name: 'descendant improvement beyond seed', seed: 140, values: [145, 139], delivered: true },
  ])('$name with real workers, evaluation and replay', async ({ seed, values, delivered }) => {
    const generations = values.length, finalScore = values.at(-1)!;
    vi.mocked(readKillSwitch).mockReturnValue({ state: 'inactive', sourceState: 'healthy', reason: 'missing', path: '/fixture/KILL' });
    preserve = false;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-passed-seed-acceptance-')));
    const repo = join(root, 'repo'), store = join(root, 'store'); mkdirSync(repo, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }).trim();
    writeFileSync(join(repo, 'value.json'), `${seed}\n`);
    writeFileSync(join(repo, 'worker.mjs'), "import {readFileSync,writeFileSync} from 'node:fs';\n" +
      `const values=${JSON.stringify(values)}, seed=${seed}, generation=Number(process.env.ASHLR_UNIVERSE_GENERATION);\n` +
      "if(!Number.isInteger(generation)||generation<1||generation>values.length||JSON.parse(readFileSync('value.json','utf8'))!==(generation===1?seed:values[generation-2]))process.exit(3);\n" +
      "writeFileSync('value.json',JSON.stringify(values[generation-1])+'\\n');\n");
    writeFileSync(join(repo, 'evaluate.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';\n" +
      "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));\n" +
      `console.log(JSON.stringify({passed:${JSON.stringify([seed, ...values])}.includes(value),score:value,metrics:{value,seed:process.env.ASHLR_UNIVERSE_EVALUATION_CONTEXT==='campaign-seed-v1'?1:0}}));\n`);
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Passed measured seed');
    const revision = git('rev-parse', 'HEAD'), index = readFileSync(join(repo, '.git', 'index'));
    initUniverse({ schemaVersion: 1, id: 'fixture', name: 'Passed-seed delivery', objective: 'Improve a passing seed',
      seed: { repo, revision }, metric: { name: 'value', direction: 'minimize', minImprovement: 1 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 20_000, trialTimeoutMs: 10_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 5000 },
      variants: [{ id: 'candidate', niche: 'value', hypothesis: 'Explore then reduce value', command: [process.execPath, 'worker.mjs'] }] }, { root: store });
    initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false, measureSeed: true,
      budget: { maxGenerations: generations, maxDurationMs: 40_000 * generations, maxModelRequests: 0,
        maxStagnantGenerations: generations, maxReportedTokens: null } }, { root: store });
    const delivery = { branch: 'codex/first-passed-seed-improvement', baseCommit: revision };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 40_000 * generations + 5000);
    preserve = true;
    try {
      const result = await runUniverseCampaignAndDeliver('campaign', { root: store, delivery, signal: controller.signal });
      const directory = universePath(store, 'fixture'), universe = projectUniverse(directory);
      expect(result.campaign).toMatchObject({ state: 'completed', sourceState: 'healthy',
        seedEvaluation: { result: { status: 'measured', processGroupSettlement: 'group-exit-confirmed', reason: null,
          measurement: { passed: true, score: seed, metrics: { value: seed, seed: 1 } } } },
        progress: { attempts: generations, completedRuns: generations, reservedModelRequests: 0, admissions: 1, improvements: generations - 1 } });
      expect(universe.runs).toHaveLength(generations);
      for (const [ordinal, run] of universe.runs.entries()) {
        expect(run.trials).toHaveLength(1);
        expect(run.trials[0]).toMatchObject({ status: 'passed', selected: true, score: values[ordinal],
          metrics: { value: values[ordinal], seed: 0 }, parentTrialId: ordinal === 0 ? null : universe.runs[ordinal - 1]!.trials[0]!.id,
          delta: ordinal === 0 ? null : values[ordinal - 1]! - values[ordinal]! });
      }
      const trial = universe.runs.at(-1)!.trials[0]!;
      // The trusted fixture children have completed successfully; subsequent
      // read-only assertions may fail without implying unresolved execution.
      preserve = false;
      expect(result.delivery.status).toBe(delivered ? 'delivered' : 'withheld');
      const receipt = result.delivery.status === 'delivered' ? result.delivery.receipt : null;
      const proof = verifiedCampaignPassedSeedImprovement(universe, result.campaign, trial, manifestRecord(directory).seedArtifact.digest);
      if (delivered) {
        expect(receipt).not.toBeNull(); expect(receipt!.trialId).toBe(trial.id);
        expect(proof).toMatchObject({ kind: 'passed-seed-evaluation', delta: seed - finalScore });
        if (generations === 1) expect(verifiedInitialCampaignSeedImprovement(universe, result.campaign, trial,
          manifestRecord(directory).seedArtifact.digest)).toEqual(proof);
        expect(git('show', `${receipt!.commit}:value.json`)).toBe(String(finalScore));
        expect(git('rev-list', '--count', receipt!.commit)).toBe('2');
      } else {
        expect(proof).toBeNull(); expect(result.delivery).toEqual({ status: 'withheld', reason: 'no-strict-improvement' });
        expect(git('branch', '--list', delivery.branch)).toBe('');
      }
      expect(readCompletedCampaignDelivery(result.campaign, delivery, { root: store })).toEqual(receipt);
      expect(git('rev-parse', 'HEAD')).toBe(revision); expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index);
      expect(readFileSync(join(repo, 'value.json'), 'utf8')).toBe(`${seed}\n`);
      const events = readCampaignEvents(campaignDirectory('campaign', { root: store })), records = readRecords(directory);
      expect(events.filter(event => event.kind === 'seed-evaluation-intent')).toHaveLength(1);
      expect(events.filter(event => event.kind === 'seed-evaluation-result')).toHaveLength(1);
      preserve = true;
      const replay = await runUniverseCampaignAndDeliver('campaign', { root: store, delivery, signal: controller.signal });
      expect(replay).toEqual(result);
      preserve = false;
      expect(readCampaignEvents(campaignDirectory('campaign', { root: store }))).toEqual(events);
      expect(readRecords(directory)).toEqual(records);
      expect(readUniverseCampaign('campaign', { root: store }).deadlineAt).toBe(result.campaign.deadlineAt);
      expect(projectUniverse(directory).runs).toHaveLength(generations);
      expect(readUniverseDeliveries('fixture', { root: store }).deliveries).toEqual(receipt ? [receipt] : []);
      if (receipt) expect(git('rev-parse', `refs/heads/${delivery.branch}`)).toBe(receipt.commit);
      else expect(git('branch', '--list', delivery.branch)).toBe('');
    } finally { clearTimeout(timer); controller.abort(); }
  }, 100_000);
});
