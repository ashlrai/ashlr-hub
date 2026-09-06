import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, readUniverseOverview, runUniverse, type UniverseManifest } from '../src/core/universe/index.js';
import { artifactDigest, canonical } from '../src/core/universe/artifacts.js';

const roots: string[] = [];
const servers: Server[] = [];
const PRIVATE_NOTE = 'fixture-only unselected source content';
const EVALUATOR = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,metrics:{value}}));
`;

afterEach(async () => {
  // Every listener and path is unique to these fixtures, including interrupted
  // HTTP responses and readonly archived directories from native execution.
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
  const restoreDirectoryWrites = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) restoreDirectoryWrites(join(path, name));
  };
  for (const root of roots.splice(0)) {
    restoreDirectoryWrites(root);
    rmSync(root, { recursive: true, force: true });
  }
});

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  max_tokens: number;
  tools?: unknown;
  tool_choice?: unknown;
}
interface RequestEvidence { path: string; headers: IncomingHttpHeaders; body: RequestBody }
interface CandidatePrompt {
  objective: string;
  hypothesis: string;
  generation: number;
  parentTrialId: string | null;
  files: Array<{ path: string; content: string }>;
}

function prompt(request: RequestEvidence): CandidatePrompt {
  const message = request.body.messages.find((entry) => entry.role === 'user');
  expect(message).toBeDefined();
  return JSON.parse(message!.content) as CandidatePrompt;
}

function completion(content: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

function edits(value: number): { edits: Array<{ path: string; content: string }> } {
  return { edits: [{ path: 'value.json', content: `${value}\n` }] };
}

async function fixture(respond: (request: RequestEvidence, index: number, response: ServerResponse) => unknown,
  variantCount = 1): Promise<{ root: string; directory: string; manifest: UniverseManifest; requests: RequestEvidence[]; requestStarted: Promise<void> }> {
  const requests: RequestEvidence[] = [];
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try {
        const evidence = { path: request.url ?? '', headers: request.headers, body: JSON.parse(body) as RequestBody };
        requests.push(evidence);
        markRequestStarted();
        const result = respond(evidence, requests.length - 1, response);
        // Undefined deliberately leaves the fixture request open for timeout or
        // cancellation. Teardown closes that exact test-owned connection.
        if (result !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        }
      } catch {
        response.writeHead(500);
        response.end('Fixture request could not be handled');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP address');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-model-integration-')));
  roots.push(base);
  const root = join(base, 'store');
  const repo = join(base, 'repository');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'private-note.txt'), PRIVATE_NOTE);
  writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Universe Test', '-c', 'user.email=universe@example.invalid', 'commit', '-qm', 'model integration fixture']);
  const manifest: UniverseManifest = {
    schemaVersion: 1, id: 'local-generation', name: 'Local model integration', objective: 'Increase the fixed fixture score',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: variantCount, maxDurationMs: 30_000, trialTimeoutMs: 8_000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: Array.from({ length: variantCount }, (_, index) => ({
      id: `model-${index + 1}`, niche: 'value', hypothesis: `Try fixture alternative ${index + 1}`,
      generation: { kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1`, model: `fixture-${index + 1}`,
        files: ['value.json'], maxOutputTokens: 256 },
    })),
  };
  return { root, directory: join(root, 'universes', manifest.id), manifest, requests, requestStarted };
}

describe.runIf(process.platform === 'darwin')('Universe local model native integration', () => {
  it('generates two native generations, independently scores frozen artifacts, and reuses the niche elite with reported usage', async () => {
    const value = await fixture((_request, index) => completion(edits(index + 1), { prompt_tokens: 10 + index, completion_tokens: 5 }), 2);
    initUniverse(value.manifest, { root: value.root });
    const first = await runUniverse(value.manifest.id, { root: value.root });
    expect(first.status, JSON.stringify(first)).toBe('completed');
    expect(first.trials.map((trial) => trial.score), JSON.stringify(first)).toEqual([1, 2]);
    const firstElite = first.trials.find((trial) => trial.selected)!;
    expect(firstElite.score).toBe(2);
    expect(first.tokensUsed).toBe(31);
    expect(first.generationUsage).toEqual({ scope: 'model-generation', trials: 2, requestsStarted: 2, reportedRequests: 2, inputTokens: 21, outputTokens: 10 });
    const second = await runUniverse(value.manifest.id, { root: value.root });
    expect(second.status, JSON.stringify(second)).toBe('completed');
    expect(second.trials.map((trial) => trial.score)).toEqual([3, 4]);
    expect(second.trials.map((trial) => trial.parentTrialId)).toEqual([firstElite.id, firstElite.id]);
    expect(second.trials.find((trial) => trial.selected)?.delta).toBe(2);
    expect(second.tokensUsed).toBe(35);
    expect(second.costUsd).toBeNull();
    expect(value.requests).toHaveLength(4);
    for (const [index, request] of value.requests.entries()) {
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.body.tools).toBeUndefined();
      expect(request.body.tool_choice).toBeUndefined();
      expect(request.body.stream).toBe(false);
      expect(request.body.max_tokens).toBe(256);
      expect(request.body.model).toBe(`fixture-${(index % 2) + 1}`);
      const context = prompt(request);
      expect(context.files).toEqual([{ path: 'value.json', content: index < 2 ? '0\n' : '2\n' }]);
      expect(context.generation).toBe(index < 2 ? 1 : 2);
      expect(context.parentTrialId).toBe(index < 2 ? null : firstElite.id);
      expect(context.objective).toBe(value.manifest.objective);
      expect(JSON.stringify(request.body)).not.toContain(PRIVATE_NOTE);
      expect(JSON.stringify(request.body)).not.toContain('evaluate.mjs');
    }
    for (const trial of [...first.trials, ...second.trials]) {
      expect(trial.generation).toMatchObject({ requestStarted: true, usage: { state: 'reported' }, changedFiles: ['value.json'] });
      expect(trial.generation?.promptDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(trial.generation?.responseDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    }
    expect(readFileSync(join(value.directory, 'seed', 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    const overview = readUniverseOverview({ root: value.root });
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    expect(overview.universes[0]!.elites[0]!.score).toBe(4);
    expect(overview.universes[0]!.runs[1]!.generationUsage).toEqual(second.generationUsage);
  }, 15_000);

  it('rejects an undeclared replacement without losing the separately reported model usage', async () => {
    const value = await fixture(() => completion({ edits: [
      { path: 'value.json', content: '3\n' },
      { path: 'private-note.txt', content: 'not a declared replacement' },
    ] }, { prompt_tokens: 17, completion_tokens: 3 }));
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials[0], JSON.stringify(run)).toMatchObject({ status: 'failed', selected: false, score: null, artifact: null,
      generation: { requestStarted: true, usage: { state: 'reported', inputTokens: 17, outputTokens: 3 }, changedFiles: [] } });
    expect(run.tokensUsed).toBe(20);
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    const overview = readUniverseOverview({ root: value.root });
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    expect(overview.universes[0]!.elites).toEqual([]);
  });

  it('keeps totals unavailable when only some requests report usage', async () => {
    const value = await fixture((_request, index) => completion(edits(index + 1), index === 0 ? { prompt_tokens: 12, completion_tokens: 3 } : undefined), 2);
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials.map((trial) => trial.status), JSON.stringify(run)).toEqual(['passed', 'passed']);
    expect(run.trials[0]!.generation?.usage).toEqual({ state: 'reported', inputTokens: 12, outputTokens: 3 });
    expect(run.trials[1]!.generation?.usage).toEqual({ state: 'unavailable', inputTokens: null, outputTokens: null });
    expect(run.tokensUsed).toBeNull();
    expect(run.costUsd).toBeNull();
    expect(run.generationUsage).toEqual({ scope: 'model-generation', trials: 2, requestsStarted: 2, reportedRequests: 1, inputTokens: null, outputTokens: null });
    expect(readUniverseOverview({ root: value.root }).sourceState).toBe('healthy');
  });

  it('retains model spend and artifact evidence when the fixed evaluator rejects the generated candidate', async () => {
    const value = await fixture(() => completion(edits(-1), { prompt_tokens: 11, completion_tokens: 4 }));
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials[0], JSON.stringify(run)).toMatchObject({ status: 'failed', score: -1, selected: false,
      error: 'Fixed evaluator rejected the candidate', generation: { status: 'succeeded', changedFiles: ['value.json'] } });
    expect(run.trials[0]!.artifact).not.toBeNull();
    expect(run.tokensUsed).toBe(15);
    const overview = readUniverseOverview({ root: value.root });
    expect(overview.sourceState).toBe('healthy');
    expect(overview.universes[0]!.elites).toEqual([]);
    expect(overview.universes[0]!.runs[0]!.trials[0]!.generation?.usage).toEqual({ state: 'reported', inputTokens: 11, outputTokens: 4 });
  });

  it('preserves a reported zero rather than confusing it with missing usage', async () => {
    const value = await fixture(() => completion(edits(1), { prompt_tokens: 0, completion_tokens: 0 }));
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials[0]!.status, JSON.stringify(run)).toBe('passed');
    expect(run.trials[0]!.generation?.usage).toEqual({ state: 'reported', inputTokens: 0, outputTokens: 0 });
    expect(run.tokensUsed).toBe(0);
    expect(run.costUsd).toBeNull();
  });

  it('withholds a candidate when the server reports an output-budget overrun and preserves the spent tokens', async () => {
    const value = await fixture(() => completion(edits(1), { prompt_tokens: 10, completion_tokens: 257 }));
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(value.requests[0]!.body.max_tokens).toBe(256);
    expect(run.trials[0], JSON.stringify(run)).toMatchObject({ status: 'failed', score: null, artifact: null, selected: false,
      generation: { status: 'failed', requestStarted: true, changedFiles: [],
        usage: { state: 'reported', inputTokens: 10, outputTokens: 257 } } });
    expect(run.tokensUsed).toBe(267);
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    const overview = readUniverseOverview({ root: value.root });
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    expect(overview.universes[0]!.elites).toEqual([]);
  });

  it('cancels an in-flight model request without evaluating or admitting a candidate', async () => {
    const value = await fixture(() => undefined);
    initUniverse(value.manifest, { root: value.root });
    const controller = new AbortController();
    const pending = runUniverse(value.manifest.id, { root: value.root, signal: controller.signal });
    await Promise.race([value.requestStarted, pending.then((run) => {
      throw new Error(`Generation finished before its model request started: ${JSON.stringify(run)}`);
    })]);
    controller.abort();
    const run = await pending;
    expect(run.status).toBe('interrupted');
    expect(run.trials[0]).toMatchObject({ status: 'cancelled', score: null, artifact: null, selected: false,
      generation: { requestStarted: true, usage: { state: 'unavailable', inputTokens: null, outputTokens: null } } });
    expect(run.tokensUsed).toBeNull();
    const overview = readUniverseOverview({ root: value.root });
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    expect(overview.universes[0]!.elites).toEqual([]);
    expect(overview.universes[0]!.activeRun).toBeNull();
  });

  it('records model timeouts without claiming evaluator acceptance or zero token usage', async () => {
    const value = await fixture(() => undefined);
    value.manifest.budget.trialTimeoutMs = 1_500;
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(value.requests).toHaveLength(1);
    expect(run.trials[0]).toMatchObject({ status: 'timed-out', score: null, artifact: null, selected: false,
      generation: { requestStarted: true, usage: { state: 'unavailable' } } });
    expect(run.tokensUsed).toBeNull();
    expect(readUniverseOverview({ root: value.root }).universes[0]!.elites).toEqual([]);
  });

  it('withholds a summary whose model totals disagree with the durable trial receipt', async () => {
    const value = await fixture(() => completion(edits(1), { prompt_tokens: 8, completion_tokens: 2 }));
    initUniverse(value.manifest, { root: value.root });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.tokensUsed).toBe(10);
    const finalPath = join(value.directory, 'ledger', 'records', `${run.id}.final.json`);
    const final = JSON.parse(readFileSync(finalPath, 'utf8'));
    final.run.tokensUsed = 9;
    writeFileSync(finalPath, `${canonical(final)}\n`);
    expect(readUniverseOverview({ root: value.root }).sourceState).toBe('degraded');
    await expect(runUniverse(value.manifest.id, { root: value.root })).rejects.toThrow();
    expect(value.requests).toHaveLength(1);
  });

  it('withholds incomplete generation totals across abandoned-run recovery while preserving recorded trial usage', async () => {
    const value = await fixture((_request, index) => completion(edits(index + 1), { prompt_tokens: 14, completion_tokens: 2 }));
    initUniverse(value.manifest, { root: value.root });
    const first = await runUniverse(value.manifest.id, { root: value.root });
    expect(first.tokensUsed, JSON.stringify(first)).toBe(16);
    const records = join(value.directory, 'ledger', 'records');
    // This exact disposable fixture models a process disappearing before its
    // final record becomes durable. No real worker or provider is terminated.
    rmSync(join(records, `${first.id}.final.json`));
    const startPath = join(records, `${first.id}.start.json`);
    const start = JSON.parse(readFileSync(startPath, 'utf8'));
    start.ownerPid = 2_147_000_000;
    start.ownerStart = 'a'.repeat(64);
    writeFileSync(startPath, `${canonical(start)}\n`);

    const beforeRecovery = readUniverseOverview({ root: value.root });
    expect(beforeRecovery.sourceState, JSON.stringify(beforeRecovery.reasons)).toBe('healthy');
    const interrupted = beforeRecovery.universes[0]!.runs[0]!;
    expect(interrupted).toMatchObject({ status: 'interrupted', tokensUsed: null, costUsd: null,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: null, outputTokens: null } });
    expect(interrupted.trials[0]!.generation?.usage).toEqual({ state: 'reported', inputTokens: 14, outputTokens: 2 });
    expect(beforeRecovery.universes[0]!.elites).toEqual([]);

    const next = await runUniverse(value.manifest.id, { root: value.root });
    expect(next).toMatchObject({ status: 'completed', generation: 2, tokensUsed: 16 });
    expect(next.trials[0]).toMatchObject({ status: 'passed', parentTrialId: null, score: 2 });
    expect(prompt(value.requests[1]!).files).toEqual([{ path: 'value.json', content: '0\n' }]);
    const afterRecovery = readUniverseOverview({ root: value.root });
    expect(afterRecovery.sourceState, JSON.stringify(afterRecovery.reasons)).toBe('healthy');
    expect(afterRecovery.universes[0]!.runs[0]).toMatchObject({ status: 'interrupted', tokensUsed: null,
      generationUsage: { requestsStarted: 1, reportedRequests: 1, inputTokens: null, outputTokens: null } });
    const recoveredFinal = JSON.parse(readFileSync(join(records, `${first.id}.final.json`), 'utf8'));
    expect(recoveredFinal.run.tokensUsed).toBeNull();
    expect(recoveredFinal.run.generationUsage.inputTokens).toBeNull();
    expect(recoveredFinal.run.trials[0].generation.usage).toEqual({ state: 'reported', inputTokens: 14, outputTokens: 2 });
    expect(afterRecovery.universes[0]!.elites[0]!.score).toBe(2);
  }, 15_000);
});
