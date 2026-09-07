import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseOverview, requestUniverseCampaignControl, runUniverse, runUniverseCampaign,
  type UniverseManifest, type UniverseSearchContext } from '../src/core/universe/index.js';
import { readUniverseCampaignComparison } from '../src/core/universe/comparison-reader.js';
import { cmdUniverseCompare } from '../src/cli/universe-compare.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const relative = `${prefix}${name}`; const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected nonregular private fixture file');
        files[relative] = `${stat.mode & 0o777}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
      }
    }
  };
  visit(root, ''); return files;
}

async function fixture(direction: 'maximize' | 'minimize' = 'maximize', generations = 4, missingUsage = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-compare-native-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'seed'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.json'), '10\n');
  writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,metrics:{value}}));`);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'evaluate.mjs');
  git('-c', 'user.name=Comparison Fixture', '-c', 'user.email=comparison@example.invalid', 'commit', '-qm', 'private shared comparator');
  const requests: unknown[] = []; let forced: number | undefined;
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', (data: string) => { body += data; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const prompt = JSON.parse(parsed.messages.find((message) => message.role === 'user')!.content) as { generation: number; searchContext?: UniverseSearchContext };
      requests.push(prompt);
      const baseline = direction === 'minimize' ? 9 : 1;
      const corrective = prompt.searchContext?.previous?.status === 'passed' && prompt.searchContext.previous.delta === 0;
      const value = forced ?? (prompt.generation === 1 ? -1 : corrective ? baseline + (direction === 'minimize' ? -1 : 1) : baseline);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ edits: [{ path: 'value.json', content: `${value}\n` }] }) } }],
        ...(missingUsage && prompt.generation === 1 ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10 } }) }));
    });
  });
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture endpoint missing');
  const manifests: UniverseManifest[] = [];
  for (const arm of ['baseline', 'challenger']) {
    const manifest: UniverseManifest = { schemaVersion: 1, id: `compare-${arm}`, name: `Comparison ${arm}`, objective: 'Improve the fixed measured value',
      seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'value', direction, minImprovement: 1 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15000, trialTimeoutMs: 5000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
      variants: [{ id: 'generator', niche: 'integer', hypothesis: 'Use measured feedback to improve the candidate',
        generation: { kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', files: ['value.json'], maxOutputTokens: 256 } }] };
    initUniverse(manifest, { root }); manifests.push(manifest);
    initUniverseCampaign({ schemaVersion: 1, id: arm, universeId: manifest.id, feedback: arm === 'challenger',
      budget: { maxGenerations: generations, maxDurationMs: 30000, maxModelRequests: generations, maxStagnantGenerations: 4, maxReportedTokens: null } }, { root });
  }
  const runPair = async () => {
    for (const arm of ['baseline', 'challenger']) {
      const result = await runUniverseCampaign(arm, { root }); expect(result.state, JSON.stringify(result)).toBe('completed');
    }
  };
  return { base, root, repo, manifests, requests, runPair, force: (value: number) => { forced = value; } };
}
function stable<T extends { sampledAt: string }>(value: T): Omit<T, 'sampledAt'> { const { sampledAt: _sampledAt, ...rest } = value; return rest; }

describe.runIf(process.platform === 'darwin')('native read-only Universe campaign comparison', () => {
  it.each(['maximize', 'minimize'] as const)('compares %s campaign outcomes using all requests and preserves native evidence', async (direction) => {
    const value = await fixture(direction); await value.runPair();
    const before = snapshot(value.base); const requestCount = value.requests.length;
    const report = readUniverseCampaignComparison('baseline', 'challenger', value);
    expect(report.sourceState, JSON.stringify(report)).toBe('healthy');
    expect(report.matching).toMatchObject({ comparator: true, configuration: true, workload: true, comparable: true });
    expect(report.feedbackContrast).toBe('feedback-bundle-v2');
    expect(report.baseline.feedback.observed).toBe('disabled'); expect(report.challenger.feedback.observed).toBe('search-v2');
    expect(report.baseline.counts).toMatchObject({ attempts: 4, completedRuns: 4, passedTrials: 3, admissions: 1, improvements: 0,
      distinctSelectedArtifacts: 1, modelRequestsStarted: 4, reportedModelRequests: 4, reservedModelRequests: 4 });
    expect(report.challenger.counts).toMatchObject({ attempts: 4, completedRuns: 4, passedTrials: 3, admissions: 1, improvements: 1,
      distinctSelectedArtifacts: 2, modelRequestsStarted: 4, reportedModelRequests: 4, reservedModelRequests: 4 });
    expect(report.baseline.usage).toEqual({ reportedTokens: 120, recordedTokens: 120, complete: true });
    expect(report.challenger.usage).toEqual({ reportedTokens: 120, recordedTokens: 120, complete: true });
    expect(report.challenger.rates.improvementsPerMillionTokens).toBeCloseTo(1_000_000 / 120);
    expect(report.baseline.rates.improvementsPerMillionTokens).toBe(0);
    expect(report.challenger.rates.distinctSelectedArtifactsPerMillionTokens).toBeCloseTo(2_000_000 / 120);
    expect(report.scoreDeltas).toEqual([{ niche: 'integer', baselineScore: direction === 'maximize' ? 1 : 9,
      challengerScore: direction === 'maximize' ? 2 : 8, directionAdjustedDelta: 1 }]);
    const overview = readUniverseOverview(value);
    for (const arm of [report.baseline, report.challenger]) {
      const runs = overview.universes.find((universe) => universe.manifest.id === arm.universeId)!.runs;
      expect(arm.timing.recordedRunDurationMs).toBeCloseTo(runs.reduce((total, run) => total + run.durationMs, 0));
      expect(arm.rates.improvementsPerHour).toBeCloseTo(arm.counts.improvements * 3_600_000 / arm.timing.recordedRunDurationMs!);
      expect(arm.acceptedChanges).toBeNull(); expect(arm.counts.verifiedDeliveryBranches).toBe(0);
    }
    expect(report.acceptedChanges).toBeNull(); expect(report.authority).toBe('observation-only');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdUniverseCompare(['baseline', 'challenger', '--root', value.root, '--json'])).toBe(0);
      expect(output).toHaveBeenCalledOnce();
      expect(stable(JSON.parse(output.mock.calls[0]![0] as string))).toEqual(stable(report));
    } finally { output.mockRestore(); }
    expect(stable(readUniverseCampaignComparison('baseline', 'challenger', value))).toEqual(stable(report));
    expect(value.requests).toHaveLength(requestCount); expect(requestCount).toBe(8);
    expect(snapshot(value.base)).toEqual(before);
  });

  it('withholds token rates when one failed request omitted usage without losing its recorded attempt', async () => {
    const value = await fixture('maximize', 2, true); await value.runPair();
    const report = readUniverseCampaignComparison('baseline', 'challenger', value);
    for (const arm of [report.baseline, report.challenger]) {
      expect(arm.counts.modelRequestsStarted).toBe(2); expect(arm.counts.reportedModelRequests).toBe(1);
      expect(arm.usage).toEqual({ reportedTokens: null, recordedTokens: 30, complete: false });
      expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.rates.distinctSelectedArtifactsPerMillionTokens).toBeNull();
    }
    expect(value.requests).toHaveLength(4);
  });

  it('flags prior history and never credits a later standalone elite to the compared campaign', async () => {
    const value = await fixture('maximize', 2);
    await runUniverse('compare-baseline', value); // Legitimate work before this campaign's window.
    await value.runPair();
    const before = readUniverseCampaignComparison('baseline', 'challenger', value);
    expect(before.baseline.fresh).toBe(false); expect(before.matching.comparable).toBe(false);
    const campaignNiches = before.challenger.niches;
    value.force(50); await runUniverse('compare-challenger', value);
    expect(readUniverseOverview(value).universes.find((universe) => universe.manifest.id === 'compare-challenger')!.elites[0]!.score).toBe(50);
    const after = readUniverseCampaignComparison('baseline', 'challenger', value);
    expect(after.challenger.niches).toEqual(campaignNiches);
    expect(after.challenger.counts.attempts).toBe(2); expect(after.challenger.counts.modelRequestsStarted).toBe(2);
    expect(after.challenger.fullyAttributed).toBe(false); expect(after.matching.comparable).toBe(false);
    expect(after.challenger.rates.improvementsPerMillionTokens).toBeNull();
  });

  it('does not resume paused or ready arms, or create absent stores while comparing', async () => {
    const value = await fixture();
    requestUniverseCampaignControl('baseline', 'pause', value);
    const before = snapshot(value.base);
    const report = readUniverseCampaignComparison('baseline', 'challenger', value);
    expect(report.baseline.campaignState).toBe('paused'); expect(report.challenger.campaignState).toBe('ready');
    expect(report.matching.comparable).toBe(false);
    for (const arm of [report.baseline, report.challenger]) {
      expect(arm.completed).toBe(false); expect(arm.nonempty).toBe(false); expect(arm.counts.attempts).toBe(0);
      expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.rates.improvementsPerHour).toBeNull();
    }
    const absent = join(value.base, 'not-created');
    const missing = readUniverseCampaignComparison('baseline', 'challenger', { root: absent });
    expect(missing.sourceState).toBe('missing'); expect(existsSync(absent)).toBe(false);
    expect(value.requests).toEqual([]); expect(snapshot(value.base)).toEqual(before);
  });
});
