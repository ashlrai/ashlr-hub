import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseGraph, readUniverseOverview,
  runUniverse, runUniverseCampaign, type UniverseFeedback, type UniverseManifest, type UniverseSearchContext } from '../src/core/universe/index.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { runUniverseOwned } from '../src/core/universe/runner.js';
import { appendRecord, newRun, readRecords } from '../src/core/universe/store.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

interface Prompt {
  generation: number;
  parentTrialId: string | null;
  files: Array<{ path: string; content: string }>;
  feedback?: UniverseFeedback;
  searchContext?: UniverseSearchContext;
}

async function fixture(direction: 'maximize' | 'minimize') {
  const requests: Array<{ prompt: Prompt; authorization: string | undefined; tools: unknown }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; tools?: unknown };
      const prompt = JSON.parse(parsed.messages.find((message) => message.role === 'user')!.content) as Prompt;
      requests.push({ prompt, authorization: request.headers.authorization, tools: parsed.tools });
      const context = prompt.searchContext;
      // This deterministic fixture only changes strategy when the new evidence
      // reports two equal attempts against the same retained edit parent.
      const baseline = context?.metric.direction === 'minimize' ? 9 : 1;
      const improvement = context?.metric.direction === 'minimize' ? -1 : 1;
      const value = context?.repetition.matchingArtifactCount !== undefined && context.repetition.matchingArtifactCount >= 2
        ? baseline + improvement : baseline;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant',
        content: JSON.stringify({ edits: [{ path: 'value.json', content: `${value}\n` }] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no loopback address');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-search-native-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.json'), '10\n');
  writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,metrics:{value}}));`);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'evaluate.mjs');
  git('-c', 'user.name=Search Fixture', '-c', 'user.email=search@example.invalid', 'commit', '-qm', 'private fixed evaluator');
  const manifest: UniverseManifest = { schemaVersion: 1, id: `search-${direction}`, name: 'Search fixture', objective: 'Improve the independently evaluated value',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'value', direction, minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: [{ id: 'generator', niche: 'integer', hypothesis: 'Use measured ties to change the proposed value',
      generation: { kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', files: ['value.json'], maxOutputTokens: 256 } }] };
  initUniverse(manifest, { root });
  return { root, manifest, requests };
}

describe.runIf(process.platform === 'darwin')('native versioned Universe search feedback', () => {
  it.each(['maximize', 'minimize'] as const)('corrects repeated ties using explicit %s evidence while retaining the actual parent', async (direction) => {
    const value = await fixture(direction);
    initUniverseCampaign({ schemaVersion: 1, id: 'search-campaign', universeId: value.manifest.id, feedback: true,
      budget: { maxGenerations: 4, maxDurationMs: 30_000, maxModelRequests: 4, maxStagnantGenerations: 3, maxReportedTokens: null } }, value);
    const final = await runUniverseCampaign('search-campaign', value);
    expect(final.state, JSON.stringify(final)).toBe('completed');
    expect(final.progress).toMatchObject({ attempts: 4, completedRuns: 4, admissions: 1, improvements: 1,
      stagnantGenerations: 0, reservedModelRequests: 4, reportedTokens: 120, usageComplete: true });
    expect(value.requests).toHaveLength(4);
    const summary = readUniverseOverview(value).universes[0]!;
    expect(summary.sourceState, JSON.stringify(summary.reasons)).toBe('healthy');
    const trials = summary.runs.map((run) => run.trials[0]!);
    expect(trials.map((trial) => trial.score)).toEqual(direction === 'maximize' ? [1, 1, 1, 2] : [9, 9, 9, 8]);
    expect(trials.map((trial) => trial.selected)).toEqual([true, false, false, true]);
    expect(trials.map((trial) => trial.delta)).toEqual([null, 0, 0, 1]);
    for (const [index, request] of value.requests.entries()) {
      const context = request.prompt.searchContext!;
      expect(context).toMatchObject({ schemaVersion: 2, generation: index + 1, universeId: value.manifest.id,
        variantId: 'generator', niche: 'integer', metric: value.manifest.metric });
      expect(request.authorization).toBeUndefined(); expect(request.tools).toBeUndefined();
      expect(summary.runs[index]!.feedbackVersion).toBe(2);
      expect(trials[index]!.generation?.search).toMatchObject({ schemaVersion: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(Object.keys(trials[index]!.generation!.search!).sort()).toEqual(['digest', 'schemaVersion']);
    }
    const [first, second, third, fourth] = value.requests.map((request) => request.prompt);
    expect(first!.feedback).toBeUndefined();
    expect(first).toMatchObject({ parentTrialId: null, files: [{ path: 'value.json', content: '10\n' }],
      searchContext: { parent: null, previous: null, repetition: { totalAttempts: 0, matchingArtifactCount: 0 } } });
    expect(second!.searchContext!.previous).toMatchObject({ trialId: trials[0]!.id, selected: true, delta: null });
    expect(value.requests.map(({ prompt }) => prompt.searchContext!.repetition.matchingArtifactCount)).toEqual([0, 0, 1, 2]);
    expect(fourth!.searchContext!.repetition.sampledAttempts.map((attempt) => attempt.trialId).sort())
      .toEqual([trials[1]!.id, trials[2]!.id].sort());
    for (const prompt of [second!, third!, fourth!]) {
      expect(prompt.parentTrialId).toBe(trials[0]!.id);
      expect(prompt.searchContext!.parent).toMatchObject({ trialId: trials[0]!.id, generation: 1, score: trials[0]!.score });
      expect(prompt.files[0]!.content).toBe(`${trials[0]!.score}\n`);
    }
    expect(fourth!.searchContext!.previous).toMatchObject({ trialId: trials[2]!.id, selected: false, delta: 0 });
    expect(fourth!.feedback!.source.trialId).toBe(trials[2]!.id);
    expect(trials[3]!.generation!.feedback!.trialId).toBe(trials[2]!.id);
    const graph = readUniverseGraph(value.manifest.id, value);
    const node = (id: string) => graph.nodes.find((item) => item.kind === 'trial' && item.trialId === id)!;
    expect(graph.sourceState).toBe('healthy'); expect(graph.complete).toBe(true);
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'parent', from: node(trials[0]!.id).id, to: node(trials[3]!.id).id }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'feedback', from: node(trials[2]!.id).id, to: node(trials[3]!.id).id }));
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('10\n');
    expect(await runUniverseCampaign('search-campaign', value)).toEqual(final);
    expect(readUniverseCampaign('search-campaign', value)).toEqual(final);
    expect(value.requests).toHaveLength(4);
  });

  it('does not add search context or a new run version when feedback is disabled', async () => {
    const value = await fixture('maximize');
    const run = await runUniverse(value.manifest.id, value);
    expect(run.status).toBe('completed'); expect(value.requests).toHaveLength(1);
    expect(value.requests[0]!.prompt.searchContext).toBeUndefined();
    expect(run.feedbackVersion).toBeUndefined(); expect(run.feedbackEnabled).toBeUndefined();
    expect(run.trials[0]!.generation!.search).toBeUndefined();
    expect(readUniverseOverview(value).sourceState).toBe('healthy');
  });

  it('recovers an old feedback-enabled reserved run without upgrading its version or making a request', async () => {
    const value = await fixture('maximize');
    const directory = join(value.root, 'universes', value.manifest.id);
    const manifest = readRecords(directory).find((record) => record.kind === 'manifest');
    if (!manifest || manifest.kind !== 'manifest') throw new Error('Missing private manifest');
    const legacy = { ...newRun(manifest, 1), feedbackEnabled: true as const };
    appendRecord(directory, { id: `${legacy.id}.start`, kind: 'start', run: legacy,
      ownerPid: process.pid, ownerStart: 'test-owned-previous-session' });
    const recovered = await withUniverseExecution(value.manifest.id, value, (lock) => runUniverseOwned(value.manifest.id,
      { root: value.root, runId: legacy.id, feedback: true }, lock));
    expect(recovered.status).toBe('interrupted'); expect(recovered.feedbackEnabled).toBe(true);
    expect(recovered.feedbackVersion).toBeUndefined(); expect(recovered.trials).toEqual([]);
    expect(value.requests).toEqual([]);
    const final = readRecords(directory).find((record) => record.kind === 'final');
    expect(final?.kind === 'final' ? final.run.feedbackVersion : 'missing final').toBeUndefined();
    expect(readUniverseOverview(value).sourceState).toBe('healthy');
  });
});
