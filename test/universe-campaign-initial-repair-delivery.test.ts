/** Real local campaign/evaluator/Git delivery. No provider, account or host changes. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initUniverse, initUniverseCampaign, runUniverseCampaign, readUniverseCampaign, deliverCompletedUniverseCampaign,
  validateUniverseCampaignDeliveryPlan, readUniverseDeliveries, type UniverseManifest } from '../src/core/universe/index.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { projectUniverse } from '../src/core/universe/store.js';
import * as deliveryGitModule from '../src/core/universe/delivery-git.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

async function fixture(options: { direction?: 'maximize' | 'minimize'; baseline?: 'unmeasured' | 'changed'; minImprovement?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-initial-repair-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'worker.mjs'), "import {writeFileSync} from 'node:fs';\n" +
    `const generation=Number(process.env.ASHLR_UNIVERSE_GENERATION);if(generation>=2)writeFileSync('value.json','1\\n');` +
    (options.baseline === 'changed' ? "else writeFileSync('value.json','-1\\n');" : ''));
  writeFileSync(join(repo, 'evaluate.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';\n" +
    "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));\n" +
    (options.baseline === 'unmeasured' ? "if(value===0)console.log('not an evaluation');else " : '') +
    `console.log(JSON.stringify({passed:value===1,score:${options.direction === 'minimize' ? 'value===1?0:1' : 'value===1?1:0'},metrics:{value}}));\n`);
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const revision = git('rev-parse', 'HEAD');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'repair', name: 'Initial repair fixture', objective: 'Repair a measured failing seed',
    seed: { repo, revision }, metric: { name: 'quality', direction: options.direction ?? 'maximize', minImprovement: options.minImprovement ?? 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 3000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Pass the fixed evaluator', command: [process.execPath, 'worker.mjs'] }] };
  initUniverse(manifest, { root });
  initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 2, maxDurationMs: 30_000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  const summary = await runUniverseCampaign('campaign', { root });
  expect(summary.sourceState).toBe('healthy'); expect(summary.state).toBe('completed');
  const directory = join(root, 'universes', manifest.id); const universe = projectUniverse(directory);
  expect(universe.runs).toHaveLength(2);
  const baseline = universe.runs[0]!.trials[0]!; const repair = universe.runs[1]!.trials[0]!;
  expect(baseline.status).toBe('failed');
  expect(repair).toMatchObject({ status: 'passed', selected: true, parentTrialId: null, delta: null });
  const delivery = { branch: 'codex/initial-repair', baseCommit: revision };
  return { root, repo, git, revision, manifest, summary, baseline, repair, delivery };
}

describe('initial repair delivery policy is an explicit closed opt-in', () => {
  const target = { campaignId: 'campaign', branch: 'codex/repair', baseCommit: 'a'.repeat(40) };
  it('preserves absent policy and retains true in the detached plan', () => {
    const legacy = { schemaVersion: 1, deliveries: [{ ...target }] };
    expect(validateUniverseCampaignDeliveryPlan(legacy, ['campaign'])).toEqual(legacy);
    const selected = { schemaVersion: 1, deliveries: [{ ...target, allowInitialRepair: true }] };
    const checked = validateUniverseCampaignDeliveryPlan(selected, ['campaign']);
    expect(checked).toEqual(selected); selected.deliveries[0]!.allowInitialRepair = false;
    expect(checked.deliveries[0]).toMatchObject({ allowInitialRepair: true });
  });
  it.each([false, undefined, null, 1, 'true'])('rejects non-true explicit policy %s', (allowInitialRepair) => {
    expect(() => validateUniverseCampaignDeliveryPlan({ schemaVersion: 1, deliveries: [{ ...target, allowInitialRepair }] }, ['campaign'])).toThrow();
  });
  it('rejects getters, inherited authority and unknown fields without invoking accessors', () => {
    const getter = vi.fn(() => true); const accessor = { ...target };
    Object.defineProperty(accessor, 'allowInitialRepair', { enumerable: true, get: getter });
    const inherited = Object.assign(Object.create({ allowInitialRepair: true }), target);
    for (const row of [accessor, inherited, { ...target, allowInitialRepair: true, bypass: true }]) {
      expect(() => validateUniverseCampaignDeliveryPlan({ schemaVersion: 1, deliveries: [row] }, ['campaign'])).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('measured failed seed to first passing repair local delivery', () => {
  it.each(['maximize', 'minimize'] as const)('requires opt-in for %s and preserves honest null lineage on replay/recovery', async (direction) => {
    const f = await fixture({ direction });
    const before = readUniverseCampaign('campaign', { root: f.root });
    const index = readFileSync(join(f.repo, '.git', 'index'));
    expect(await deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery: f.delivery })).toMatchObject({
      delivery: { status: 'withheld', reason: 'no-strict-improvement' },
    });
    expect(f.git('branch', '--list', f.delivery.branch)).toBe('');
    const delivery = { ...f.delivery, allowInitialRepair: true as const };
    const result = await deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery });
    expect(result.delivery.status).toBe('delivered'); if (result.delivery.status !== 'delivered') throw new Error('Expected opt-in delivery');
    expect(result.delivery.receipt.trialId).toBe(f.repair.id);
    expect(readCompletedCampaignDelivery(before, f.delivery, { root: f.root })).toBeNull();
    expect(readCompletedCampaignDelivery(before, delivery, { root: f.root })).toEqual(result.delivery.receipt);
    expect(await deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery })).toEqual(result);
    await expect(deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery: f.delivery })).rejects.toThrow();
    expect(readUniverseCampaign('campaign', { root: f.root })).toEqual(before);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.revision); expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(f.git('show', `${f.delivery.branch}:value.json`)).toBe('1');
  });

  it.each(['unmeasured', 'changed'] as const)('does not promote an %s failing trial as the measured seed', async (baseline) => {
    const f = await fixture({ baseline });
    expect(await deliverCompletedUniverseCampaign('campaign', { root: f.root,
      delivery: { ...f.delivery, allowInitialRepair: true } })).toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(f.git('branch', '--list', f.delivery.branch)).toBe('');
  });

  it('honors the fixed minimum improvement instead of only testing pass/fail labels', async () => {
    const f = await fixture({ minImprovement: 2 });
    expect(await deliverCompletedUniverseCampaign('campaign', { root: f.root,
      delivery: { ...f.delivery, allowInitialRepair: true } })).toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(f.git('branch', '--list', f.delivery.branch)).toBe('');
  });

  it('rejects changed baseline bytes before publication and in read-only receipt recovery', async () => {
    const f = await fixture(); const delivery = { ...f.delivery, allowInitialRepair: true as const };
    const first = await deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery });
    expect(first.delivery.status).toBe('delivered'); if (first.delivery.status !== 'delivered') throw new Error('Expected initial delivery');
    const file = join(f.baseline.artifact!.path, 'value.json'); chmodSync(file, 0o600); writeFileSync(file, '999\n');
    expect(readCompletedCampaignDelivery(f.summary, delivery, { root: f.root })).toBeNull();
    const other = { ...delivery, branch: 'codex/tampered-baseline' };
    // A changed archive may make the whole overview unavailable; either fixed
    // refusal form is valid, but publishing another branch is never valid.
    const outcome = await deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery: other }).catch(() => null);
    expect(outcome?.delivery.status ?? 'refused').not.toBe('delivered');
    expect(f.git('branch', '--list', other.branch)).toBe('');
    expect(f.git('rev-parse', `refs/heads/${delivery.branch}`)).toBe(first.delivery.receipt.commit);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toHaveLength(1);
  });

  it('rechecks baseline bytes under the final prepared Git ref lock', async () => {
    const f = await fixture(); const delivery = { ...f.delivery, allowInitialRepair: true as const };
    const original = deliveryGitModule.deliveryGit; let finalChecks = 0;
    vi.spyOn(deliveryGitModule, 'deliveryGit').mockImplementation((repo, deadline) => {
      const git = original(repo, deadline);
      return { ...git, createRef: (branch, commit, beforeCommit) => git.createRef(branch, commit, () => {
        finalChecks++;
        const file = join(f.baseline.artifact!.path, 'value.json'); chmodSync(file, 0o600); writeFileSync(file, '999\n');
        beforeCommit?.();
      }) };
    });
    await expect(deliverCompletedUniverseCampaign('campaign', { root: f.root, delivery })).rejects.toThrow(/baseline.*changed/i);
    expect(finalChecks).toBe(1); expect(f.git('branch', '--list', delivery.branch)).toBe('');
    expect(readCompletedCampaignDelivery(f.summary, delivery, { root: f.root })).toBeNull();
    const receipts = readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries;
    expect(receipts).toHaveLength(1); expect(receipts[0]!.status).toBe('pending');
    expect(f.git('rev-parse', 'HEAD')).toBe(f.revision);
  });
});
