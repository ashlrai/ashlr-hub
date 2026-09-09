import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initUniverse, initUniverseCampaign, readUniverseOverview, readUniverseCampaign,
  requestUniverseCampaignControl, runUniverse, runUniverseCampaign, runUniverseCampaignAndDeliver,
  type UniverseCampaignDefinition, type UniverseFeedback, type UniverseManifest } from '../src/core/universe/index.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { runUniverseOwned } from '../src/core/universe/runner.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';
import { readUniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';

const roots: string[] = [];
const servers: Server[] = [];
const EVALUATOR = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,
metrics:{value},diagnostics:value<0?[{code:'NONNEGATIVE',message:'Value must be nonnegative',path:'value.json',line:1}]:[]}));`;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
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
}

async function fixture(respond: (prompt: Prompt, index: number) =>
  { value: number; usage?: boolean; content?: string } | { httpStatus: number } | undefined,
  variantCount = 1, trialTimeoutMs = 5_000) {
  const requests: Prompt[] = [];
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const prompt = JSON.parse(parsed.messages.find((message) => message.role === 'user')!.content) as Prompt;
      requests.push(prompt);
      started();
      const result = respond(prompt, requests.length - 1);
      if (!result) return; // Test-owned pending request, closed during teardown.
      if ('httpStatus' in result) {
        response.writeHead(result.httpStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Test-owned local service unavailable' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant',
        content: result.content ?? JSON.stringify({ edits: [{ path: 'value.json', content: `${result.value}\n` }] }) }, finish_reason: 'stop' }],
      ...(result.usage === false ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10 } }) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-campaign-native-')));
  roots.push(base);
  const repo = join(base, 'repo');
  const root = join(base, 'store');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Universe Test', '-c', 'user.email=universe@example.invalid', 'commit', '-qm', 'campaign fixture']);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'native-campaign', name: 'Campaign fixture', objective: 'Increase a fixed independently evaluated value',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: variantCount, maxDurationMs: 15_000, trialTimeoutMs, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: Array.from({ length: variantCount }, (_, index) => ({ id: `model-${index}`, niche: 'value', hypothesis: 'Use evaluator feedback to improve the value',
      generation: { kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', files: ['value.json'], maxOutputTokens: 256 } })),
  };
  initUniverse(manifest, { root });
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 30_000, maxModelRequests: 12, maxStagnantGenerations: 3, maxReportedTokens: null } };
  return { root, manifest, definition, requests, requestStarted };
}

describe.runIf(process.platform === 'darwin')('Universe campaigns through native execution', () => {
  it('pauses a local outage without consuming the remaining campaign and resumes with its original budgets', async () => {
    let restored = false;
    const value = await fixture((_prompt, index) => restored ? { value: index } : { httpStatus: 503 });
    initUniverseCampaign(value.definition, value);
    const paused = await runUniverseCampaign('campaign', value);
    expect(paused.state, JSON.stringify(paused)).toBe('paused');
    expect(paused.reason).toMatch(/Local generation did not receive a completion/);
    expect(paused.progress).toMatchObject({ attempts: 1, completedRuns: 1, reservedModelRequests: 1 });
    expect(value.requests).toHaveLength(1);
    expect(readUniverseOverview(value).universes[0]!.runs[0]!.trials[0]!.generation)
      .toMatchObject({ status: 'failed', requestStarted: true, responseDigest: null });
    expect(readUniverseCampaignReadiness('campaign', value)).toMatchObject({ sourceState: 'healthy',
      disposition: 'attention-required', reasonCode: 'generation-attention-required', automaticAction: 'none' });
    restored = true;
    const resumed = await runUniverseCampaign('campaign', value);
    expect(resumed.state, JSON.stringify(resumed)).toBe('completed');
    expect(resumed.startedAt).toBe(paused.startedAt);
    expect(resumed.deadlineAt).toBe(paused.deadlineAt);
    expect(resumed.progress).toMatchObject({ attempts: 3, completedRuns: 3, reservedModelRequests: 3,
      reportedTokens: null, usageComplete: false, recordedTokens: 60 });
    expect(value.requests).toHaveLength(3);
  }, 20_000);

  it('pauses after a local completion timeout instead of repeating the timed-out request', async () => {
    const value = await fixture(() => undefined, 1, 2_000);
    initUniverseCampaign(value.definition, value);
    const result = await runUniverseCampaign('campaign', value);
    expect(result.state, JSON.stringify(result)).toBe('paused');
    expect(result.reason).toMatch(/Local generation did not receive a completion/);
    expect(result.progress).toMatchObject({ attempts: 1, reservedModelRequests: 1 });
    expect(value.requests).toHaveLength(1);
    expect(readUniverseOverview(value).universes[0]!.runs[0]!.trials[0]!.generation)
      .toMatchObject({ status: 'timed-out', requestStarted: true, responseDigest: null });
  }, 15_000);

  it('preserves caller cancellation when local generation also fails', async () => {
    const controller = new AbortController();
    const value = await fixture(() => { controller.abort(); return { httpStatus: 503 }; });
    initUniverseCampaign(value.definition, value);
    const result = await runUniverseCampaign('campaign', { ...value, signal: controller.signal });
    expect(result.state, JSON.stringify(result)).toBe('paused');
    expect(result.reason).toMatch(/caller cancellation/);
    expect(value.requests).toHaveLength(1);
  }, 15_000);

  it('continues correcting malformed edits when a local model completion was recorded', async () => {
    const value = await fixture((_prompt, index) => index === 0
      ? { value: 0, content: 'not valid JSON edits' } : { value: index });
    initUniverseCampaign(value.definition, value);
    const result = await runUniverseCampaign('campaign', value);
    expect(result.state, JSON.stringify(result)).toBe('completed');
    expect(result.progress).toMatchObject({ attempts: 3, reservedModelRequests: 3, reportedTokens: 90, usageComplete: true });
    expect(value.requests).toHaveLength(3);
    const first = readUniverseOverview(value).universes[0]!.runs[0]!.trials[0]!;
    expect(first.generation?.status).toBe('failed');
    expect(first.generation?.responseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(value.requests[1]!.parentTrialId).toBeNull();
    expect(value.requests[1]!.feedback?.diagnostics).toContainEqual(expect.objectContaining({ code: 'generation-failed' }));
  }, 20_000);

  it.each(['pause', 'stop'] as const)('preserves explicit owner %s when local generation also fails', async (action) => {
    const value = await fixture(() => {
      requestUniverseCampaignControl('campaign', action, value);
      return { httpStatus: 503 };
    });
    initUniverseCampaign(value.definition, value);
    const result = await runUniverseCampaign('campaign', value);
    expect(result.state, JSON.stringify(result)).toBe(action === 'pause' ? 'paused' : 'stopped');
    expect(result.reason).not.toMatch(/Local generation did not receive a completion/);
    expect(value.requests).toHaveLength(1);
  }, 15_000);

  it('does not renew an outage-paused campaign after its original deadline expires', async () => {
    const value = await fixture(() => ({ httpStatus: 503 }));
    initUniverseCampaign(value.definition, value);
    const paused = await runUniverseCampaign('campaign', value);
    expect(paused.state).toBe('paused');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(paused.deadlineAt!) + 1);
    try {
      const final = await runUniverseCampaign('campaign', value);
      expect(final.state).toBe('completed');
      expect(final.reason).toMatch(/duration budget/);
      expect(final.deadlineAt).toBe(paused.deadlineAt);
      expect(final.progress.reservedModelRequests).toBe(1);
      expect(value.requests).toHaveLength(1);
    } finally { clock.mockRestore(); }
  }, 15_000);

  it('runs from ready through evaluated improvement to a local branch without another model request on replay', async () => {
    const value = await fixture((_prompt, index) => ({ value: index + 1 }));
    initUniverseCampaign(value.definition, value);
    const options = { root: value.root, delivery: { branch: 'codex/verified-output', baseCommit: value.manifest.seed.revision } };
    const result = await runUniverseCampaignAndDeliver('campaign', options);
    expect(result.campaign).toMatchObject({ state: 'completed', sourceState: 'healthy', progress: { improvements: 2 } });
    expect(result.delivery.status).toBe('delivered');
    if (result.delivery.status !== 'delivered') throw new Error('Expected local delivery');
    const output = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', value.manifest.seed.repo,
      'show', `${result.delivery.receipt.commit}:value.json`], { encoding: 'utf8' });
    expect(output).toBe('3\n');
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(await runUniverseCampaignAndDeliver('campaign', options)).toEqual(result);
    expect(value.requests).toHaveLength(3);
  }, 20_000);

  it('continues past a passing artifact, feeding rejection evidence without promoting failed code to parent', async () => {
    const value = await fixture((_prompt, index) => ({ value: [-1, 2, 3][index]! }));
    initUniverseCampaign(value.definition, value);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.sourceState, JSON.stringify(final)).toBe('healthy');
    expect(final.state).toBe('completed');
    expect(final.reason).toMatch(/generation budget/);
    expect(final.progress).toMatchObject({ attempts: 3, completedRuns: 3, admissions: 1, improvements: 1,
      reservedModelRequests: 3, reportedTokens: 90, usageComplete: true });
    expect(value.requests).toHaveLength(3);
    expect(value.requests[0]!.feedback).toBeUndefined();
    expect(value.requests[1]).toMatchObject({ parentTrialId: null, files: [{ path: 'value.json', content: '0\n' }],
      feedback: { status: 'failed', score: -1, diagnostics: [{ code: 'NONNEGATIVE', message: 'Value must be nonnegative' }],
        previousAttemptFiles: [{ path: 'value.json', content: '-1\n' }] } });
    const overview = readUniverseOverview(value);
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    const runs = overview.universes[0]!.runs;
    expect(value.requests[2]).toMatchObject({ parentTrialId: runs[1]!.trials[0]!.id,
      files: [{ path: 'value.json', content: '2\n' }], feedback: { status: 'passed', score: 2 } });
    expect(runs.map((run) => run.campaign?.ordinal)).toEqual([1, 2, 3]);
    expect(runs[1]!.trials[0]!.generation?.feedback?.trialId).toBe(runs[0]!.trials[0]!.id);
    expect(overview.universes[0]!.elites[0]!.score).toBe(3);
    for (const trial of runs.flatMap((run) => run.trials)) expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
    expect(readFileSync(join(value.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(await runUniverseCampaign('campaign', value)).toEqual(final);
    expect(value.requests).toHaveLength(3);
  }, 20_000);

  it('stops stagnation only after completed generations fail to improve the archive', async () => {
    const value = await fixture(() => ({ value: 1 }));
    value.definition.budget.maxGenerations = 8;
    value.definition.budget.maxStagnantGenerations = 2;
    initUniverseCampaign(value.definition, value);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.reason, JSON.stringify(final)).toMatch(/stagnation/);
    expect(final.progress).toMatchObject({ attempts: 3, admissions: 1, improvements: 0, stagnantGenerations: 2 });
    expect(value.requests).toHaveLength(3);
  }, 20_000);

  it('reserves a prefix that cannot overshoot the model-request budget', async () => {
    const value = await fixture((_prompt, index) => ({ value: index + 1 }), 3);
    value.definition.budget.maxModelRequests = 2;
    initUniverseCampaign(value.definition, value);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.sourceState, JSON.stringify(final)).toBe('healthy');
    expect(final.reason).toMatch(/model-request/);
    expect(final.steps[0]!.variantIds).toEqual(['model-0', 'model-1']);
    expect(final.progress.reservedModelRequests).toBe(2);
    expect(value.requests).toHaveLength(2);
  });

  it('stops before further contact when token-budgeted usage is unavailable', async () => {
    const value = await fixture(() => ({ value: 1, usage: false }));
    value.definition.budget.maxReportedTokens = 100;
    initUniverseCampaign(value.definition, value);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.state, JSON.stringify(final)).toBe('failed');
    expect(final.reason).toMatch(/usage is unavailable/);
    expect(final.progress).toMatchObject({ reportedTokens: null, recordedTokens: 0, usageComplete: false, reservedModelRequests: 1 });
    expect(value.requests).toHaveLength(1);
  });

  it('treats reported tokens as an observed threshold, not an invented hard token ceiling', async () => {
    const value = await fixture((_prompt, index) => ({ value: index + 1 }));
    value.definition.budget.maxReportedTokens = 40;
    initUniverseCampaign(value.definition, value);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.reason, JSON.stringify(final)).toMatch(/observed-token/);
    expect(final.progress.reportedTokens).toBe(60);
    expect(value.requests).toHaveLength(2);
  });

  it('acknowledges pause after cancellation and resumes without refunding the interrupted attempt or deadline', async () => {
    const value = await fixture((_prompt, index) => index === 0 ? undefined : { value: index });
    initUniverseCampaign(value.definition, value);
    const running = runUniverseCampaign('campaign', value);
    await value.requestStarted;
    const requested = requestUniverseCampaignControl('campaign', 'pause', value);
    expect(requested.state).toBe('pause-requested');
    const paused = await running;
    expect(paused.state, JSON.stringify(paused)).toBe('paused');
    expect(paused.steps[0]!.state).toBe('interrupted');
    expect(paused.progress.reservedModelRequests).toBe(1);
    const final = await runUniverseCampaign('campaign', value);
    expect(final.state, JSON.stringify(final)).toBe('completed');
    expect(final.startedAt).toBe(paused.startedAt);
    expect(final.deadlineAt).toBe(paused.deadlineAt);
    expect(final.progress).toMatchObject({ attempts: 3, completedRuns: 2, interruptedRuns: 1, reservedModelRequests: 3,
      usageComplete: false, reportedTokens: null, recordedTokens: 60 });
    expect(value.requests[1]!.feedback).toBeUndefined();
    expect(value.requests).toHaveLength(3);
  }, 20_000);

  it('excludes standalone and competing campaign execution for the same Universe', async () => {
    const value = await fixture(() => undefined);
    initUniverseCampaign(value.definition, value);
    initUniverseCampaign({ ...value.definition, id: 'other' }, value);
    const running = runUniverseCampaign('campaign', value);
    await value.requestStarted;
    await expect(runUniverse(value.manifest.id, value)).rejects.toThrow(/active execution owner/);
    await expect(runUniverseCampaign('other', value)).rejects.toThrow(/active execution owner/);
    expect(requestUniverseCampaignControl('campaign', 'stop', value).state).toBe('stop-requested');
    const final = await running;
    expect(final.state, JSON.stringify(final)).toBe('stopped');
    expect((await runUniverseCampaign('campaign', value)).state).toBe('stopped');
    expect(readUniverseCampaign('other', value).progress.attempts).toBe(0);
    expect(value.requests).toHaveLength(1);
  }, 15_000);

  it('does not replenish an elapsed deadline during a paused campaign', async () => {
    const value = await fixture(() => undefined);
    value.definition.budget.maxDurationMs = 30_000;
    initUniverseCampaign(value.definition, value);
    const running = runUniverseCampaign('campaign', value);
    await Promise.race([value.requestStarted, running.then(() => { throw new Error('Campaign ended before its request started'); })]);
    requestUniverseCampaignControl('campaign', 'pause', value);
    const paused = await running;
    expect(paused.state, JSON.stringify(paused)).toBe('paused');
    // Advance the observed wall clock only after actual native cancellation.
    // A subsecond setup deadline depends on machine load, not resume semantics.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(paused.deadlineAt!) + 1);
    try {
      const final = await runUniverseCampaign('campaign', value);
      expect(final.reason, JSON.stringify(final)).toMatch(/duration budget/);
      expect(final.deadlineAt).toBe(paused.deadlineAt);
      expect(value.requests).toHaveLength(1);
    } finally { clock.mockRestore(); }
  }, 15_000);

  it('returns an exact already-finished owned run without replaying its request', async () => {
    const value = await fixture(() => ({ value: 1 }));
    const runId = randomUUID();
    await withUniverseExecution(value.manifest.id, value, async (lock) => {
      const first = await runUniverseOwned(value.manifest.id, { root: value.root, runId, feedback: true }, lock);
      const second = await runUniverseOwned(value.manifest.id, { root: value.root, runId, feedback: true }, lock);
      expect(second).toEqual(first);
      await expect(runUniverseOwned(value.manifest.id, { root: value.root, runId }, lock)).rejects.toThrow(/context changed/);
    });
    expect(value.requests).toHaveLength(1);
    expect(readUniverseOverview(value).universes[0]!.runs).toHaveLength(1);
  });
});
