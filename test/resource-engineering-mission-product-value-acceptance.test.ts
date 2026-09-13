/** Actual Hub parser behavior -> immutable command evaluation -> mission delivery.
 * Only the local model's answers/usage are deterministic fixture data. This is
 * not provider judgment, installed-runtime promotion, or production acceptance. */
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ onSpawn: null as null | ((child: import('node:child_process').ChildProcess) => void) }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args); if (args[2]?.detached) native.onSpawn?.(child); return child;
  } };
});
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical } from '../src/core/universe/artifacts.js';
import * as fixedEvaluator from '../src/core/universe/fixed-evaluator.js';
import * as campaignDelivery from '../src/core/universe/campaign-delivery.js';
import { projectUniverse, universePath } from '../src/core/universe/store.js';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceEngineeringAutonomousSetup, prepareResourceEngineeringAutonomousSetup } from '../src/core/resources/engineering-autonomous-setup.js';
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import { readEngineeringMissionRecords, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import type { EngineeringMissionFeedback } from '../src/core/resources/engineering-mission-feedback.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { fixtureSnapshot, parserCandidate, parserHelper, parserSourcePath, parserTypesPath, sha256 } from './helpers/universe-file-operations-fixture.js';

const source = readFileSync(parserSourcePath, 'utf8'), types = readFileSync(parserTypesPath, 'utf8');
const nextObjective = 'Preserve the four passing CLI behavior cases and add tilde-fence handling for both roadmap and milestone commands.';
const roadmap = '# Roadmap\n- [M0](M0-first.md)\n- M1: M1-second.md\n';
const milestone = '# Real milestone\n- [ ] M0.1: Implement feature\n  Done when: passes the real check\n\n## Acceptance checklist (gate)\n- stable output\n';
const cases = [
  { kind: 'roadmap', text: roadmap, expected: ['M0', 'M1'] },
  { kind: 'milestone', text: milestone, expected: { title: 'Real milestone', steps: ['M0.1'], gate: ['stable output'] } },
  { kind: 'roadmap', text: '```\n- [M99](example.md)\n```\n' + roadmap, expected: ['M0', 'M1'] },
  { kind: 'milestone', text: '```\n# Fake title\n- [ ] M9.9: Example\n```\n' + milestone,
    expected: { title: 'Real milestone', steps: ['M0.1'], gate: ['stable output'] } },
  { kind: 'roadmap', text: '~~~\n- [M99](example.md)\n~~~\n' + roadmap, expected: ['M0', 'M1'] },
  { kind: 'milestone', text: '~~~\n# Fake title\n- [ ] M9.9: Example\n~~~\n' + milestone,
    expected: { title: 'Real milestone', steps: ['M0.1'], gate: ['stable output'] } },
];
// Fixed product CLI adapter. Candidate modules receive a command and input file,
// not expected output or the evaluator's scoring logic.
const cli = `import {dirname} from 'node:path';import {parseRoadmap,parseMilestone} from './parse.js';
const [kind,file]=process.argv.slice(2);let value;
if(kind==='roadmap')value=parseRoadmap(dirname(file),file).milestones.map(row=>row.id);
else if(kind==='milestone'){const doc=parseMilestone(file,'M0');value={title:doc.title,steps:doc.steps.map(row=>row.id),gate:doc.gate};}
else throw new Error('Unsupported fixture command');
console.log(JSON.stringify(value));\n`;
const evaluator = `import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';import {isDeepStrictEqual} from 'node:util';
const root=process.env.ASHLR_UNIVERSE_CANDIDATE,scratch=join(process.env.TMPDIR,'parser-product');
mkdirSync(scratch,{recursive:true});writeFileSync(join(scratch,'package.json'),'{"type":"module"}');
const tests=${JSON.stringify(cases)},ok=[];let loaded=false;
try{for(const name of ['parse.ts','markdown-lines.ts'])if(existsSync(join(root,name)))writeFileSync(join(scratch,name.replace(/\\.ts$/,'.js')),stripTypeScriptTypes(readFileSync(join(root,name),'utf8')));
writeFileSync(join(scratch,'cli.mjs'),readFileSync(join(root,'cli.mjs')));
for(let i=0;i<tests.length;i++){const file=join(scratch,'case-'+i+'.md');writeFileSync(file,tests[i].text);
const value=JSON.parse(execFileSync(process.execPath,[join(scratch,'cli.mjs'),tests[i].kind,file],{cwd:scratch,env:process.env,encoding:'utf8',timeout:1500,maxBuffer:65536,stdio:['ignore','pipe','pipe']}));ok.push(isDeepStrictEqual(value,tests[i].expected));}loaded=true;}catch{}
const hash=name=>createHash('sha256').update(readFileSync(join(root,name))).digest('hex');
const protectedIntact=hash('types.ts')===${JSON.stringify(sha256(types))}&&hash('cli.mjs')===${JSON.stringify(sha256(cli))};
const score=ok.filter(Boolean).length,passed=loaded&&protectedIntact&&ok[0]===true&&ok[1]===true;
console.log(JSON.stringify({passed,score,metrics:{featureCasesPassed:score,featureCasesTotal:tests.length,legacyCasesPassed:Number(ok[0]===true)+Number(ok[1]===true),protectedIntact:Number(protectedIntact)},diagnostics:[]}));\n`;

function candidate(stage: 0 | 1 | 2 | 3 | 'neutral'): Record<string, string> {
  if (stage === 0) return { 'parse.ts': source };
  if (stage === 'neutral') return { 'parse.ts': source + '\n// Behavior-neutral formatting fixture.\n' };
  let next = parserCandidate(source);
  if (stage === 1) {
    next = source;
    for (const [before, after] of [["import { readFileSync } from 'node:fs';", "import { readFileSync } from 'node:fs';\nimport { markdownLines } from './markdown-lines.js';"],
      ['for (const rawLine of splitLines(content)) {', 'for (const rawLine of markdownLines(splitLines(content))) {']]) {
      expect(next.split(before!)).toHaveLength(2); next = next.replace(before!, after!);
    }
  }
  return { 'parse.ts': next, 'markdown-lines.ts': parserHelper(stage === 3) };
}
const roots: string[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async ({ task }) => {
  let retain = task.result?.state === 'fail';
  const failures: unknown[] = [];
  for (const close of closers.splice(0).reverse()) { try { await close(); } catch (error) { retain = true; failures.push(error); } }
  for (const root of roots.splice(0)) {
    if (retain) { console.warn('PRODUCT_MISSION_RETAINED_FIXTURE', root); continue; }
    const writable = (path: string): void => { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error('Unsafe cleanup');
      if (stat.isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); } };
    writable(root); rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Product mission fixture cleanup was not confirmed; evidence retained');
});
function root() { const value = realpathSync(mkdtempSync(join(tmpdir(), 'mission-parser-product-'))); roots.push(value); return value; }
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function seed(project: string) {
  for (const [name, text] of Object.entries({ 'parse.ts': source, 'types.ts': types, 'cli.mjs': cli, 'evaluate.mjs': evaluator })) writeFileSync(join(project, name), text, { mode: 0o600 });
}
async function fixture(neutral = false) {
  expect(process.env.ASHLR_VITEST_REAL_HOME).toBeTruthy(); expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = root(), project = join(base, 'project'), transport = join(base, 'transport'), ledgerRoot = join(base, 'ledger');
  const output = join(base, 'initial'), missionRoot = join(base, 'mission');
  for (const dir of [project, transport, output, missionRoot]) mkdirSync(dir, { mode: 0o700 });
  for (const dir of [project, transport]) git(dir, 'init', '-q', '--template=', '--initial-branch=main');
  seed(project); git(project, 'add', '.'); git(project, '-c', 'user.name=Product Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed parser product contract');
  const revision = git(project, 'rev-parse', 'HEAD'), calls = { generation: 0, successor: 0, mission: 0 };
  const errors: string[] = [], generationSeeds: Array<{ score: number; objective: string; files: Record<string, string | null> }> = [];
  const evaluations: Array<{ root: string; universeId: string; settlement: string | undefined }> = [];
  const deliveries: campaignDelivery.UniverseCampaignDeliveryResult[] = [];
  const deliver = campaignDelivery.deliverCompletedUniverseCampaign;
  const deliveryObserver = vi.spyOn(campaignDelivery, 'deliverCompletedUniverseCampaign').mockImplementation(async (...args) => {
    const result = await deliver(...args); deliveries.push(result); return result;
  });
  const children: ChildProcess[] = [];
  native.onSpawn = child => { children.push(child); };
  closers.push(async () => {
    native.onSpawn = null; deliveryObserver.mockRestore();
    for (const child of children) if (child.pid !== undefined) {
      let absent = false; try { process.kill(-child.pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!absent) throw new Error('Native fixture group absence is not confirmed');
    }
  });
  const evaluate = fixedEvaluator.runFixedUniverseEvaluator;
  const evaluatorObserver = vi.spyOn(fixedEvaluator, 'runFixedUniverseEvaluator').mockImplementation(async (...args) => {
    const result = await evaluate(...args);
    evaluations.push({ root: args[1], universeId: args[0].manifest.id, settlement: result.processGroupSettlement });
    return result;
  });
  // A call-through observer checks real evaluator custody, never supplies results.
  closers.push(async () => {
    // Ordinary command trials do not request the optional runner receipt. Their
    // groups are independently checked above, without signals or cleanup retry.
    const complete = evaluatorObserver.mock.calls.length === evaluations.length && evaluations.every(row => row.settlement === undefined || row.settlement === 'group-exit-confirmed');
    evaluatorObserver.mockRestore(); if (!complete) throw new Error('Evaluator custody unresolved');
  });
  const proposals: Array<{ measuredFeedback: EngineeringMissionFeedback; delivered: { commit: string } }> = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 256 * 1024) chunks.push(chunk); });
    req.on('end', () => {
      try {
        expect(bytes).toBeLessThanOrEqual(256 * 1024); expect(req.headers.authorization).toBeUndefined();
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); expect(body.tools).toBeUndefined();
        const raw = JSON.parse(body.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find(row => row.role === 'user').content) : raw;
        let content: unknown;
        if (context.seedContext) {
          calls.generation++;
          const files = Object.fromEntries(context.files.map((row: { path: string; content: string | null }) => [row.path, row.content]));
          generationSeeds.push({ score: context.seedContext.measurement.score, objective: context.objective, files });
          expect(context.seedContext.measurement.passed).toBe(true);
          const stage = neutral ? 'neutral' : calls.generation as 1 | 2 | 3;
          if (!neutral) { expect(calls.generation).toBeLessThanOrEqual(3); expect(context.seedContext.measurement.score).toBe([2, 3, 4][calls.generation - 1]); }
          content = { operations: Object.entries(candidate(stage)).map(([path, text]) => ({ op: files[path] === null ? 'create' : 'replace', path, content: text })) };
        } else if (context.kind === 'engineering-successor-proposal') {
          calls.successor++;
          content = calls.successor === 1 ? { action: 'propose', name: 'Ignore milestone examples', objective: 'Make the actual milestone CLI ignore backtick fenced example steps while preserving legacy output.' } : { action: 'stop' };
        } else {
          expect(context.kind).toBe('engineering-mission-proposal'); expect(context.feedbackVersion).toBe('measured-outcomes-v1');
          expect(calls.generation).toBe(2); calls.mission++; proposals.push(context);
          const feedback = context.measuredFeedback as EngineeringMissionFeedback;
          expect(feedback).toMatchObject({ availability: 'available', scope: 'latest-delivered-enrollment', authority: 'observation-only', productionAccepted: null,
            campaigns: [{ seed: { score: 3, passed: true }, selected: [{ score: 4, deltaFromSeed: 1 }], stages: { verifiedLocalDeliveries: 1 } }] });
          expect(feedback.source.commit).toBe(context.delivered.commit);
          content = { action: 'propose', name: 'Support tilde examples', objective: nextObjective };
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch { errors.push('Fixed local model protocol mismatch'); res.writeHead(500); res.end('Fixture refused'); }
    });
  });
  await new Promise<void>(done => worker.listen(0, '127.0.0.1', done));
  closers.push(async () => { worker.closeAllConnections(); await new Promise<void>(done => worker.close(() => done())); });
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'parser-product', workers: ['builder', 'reserved'].map(id => ({ id, provider: 'local', model: 'deterministic-fixture',
    maxConcurrent: 1, maxTasksPerWindow: 12, taskWindowMs: 3600_000, reservePercent: 25, priority: 1 })) });
  const bindings = validateResourceBindings(pool.workers.map(w => ({ workerId: w.id, capacityKey: w.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(w => ({ workerId: w.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }));
  const paths = { pool: join(base, 'pool.json'), bindings: join(base, 'bindings.json'), observations: join(base, 'observations.json'), projects: join(base, 'projects.json'), runtime: join(base, 'runtime.json') };
  save(paths.pool, pool); save(paths.bindings, bindings); save(paths.observations, observations); save(paths.projects, { schemaVersion: 1, projects: [] });
  const refresh = setInterval(() => { if (!worker.listening) return;
    for (const row of observations) { row.observedAt = new Date(Date.now() - 1000).toISOString(); row.expiresAt = new Date(Date.now() + 240_000).toISOString(); }
    writePrivateFileAtomically(join(base, 'observations-next.json'), paths.observations, canonical(observations) + '\n', { anchorPath: base, label: 'Fixture local health' });
  }, 60_000);
  closers.push(async () => { clearInterval(refresh); });
  save(paths.runtime, { schemaVersion: 1, root: ledgerRoot, workspace: transport, poolPath: paths.pool, bindingsPath: paths.bindings, observationsPath: paths.observations, capacityWaitMs: 1000 });
  const prior = await createResourcePoolSupervisor({ root: ledgerRoot, pool, bindings, workspace: project, projects: [], readObservations: () => observations }); await prior.close();
  const allocation = setResourcePoolAllocation(ledgerRoot, pool, bindings, 75, 0), access = setResourceWorkerAccess(ledgerRoot, pool, bindings, ['reserved'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'parser-first', name: 'Ignore roadmap examples',
    objective: 'Make the actual roadmap CLI ignore backtick fenced examples without changing real milestone order.', projectId: 'default', seedRevision: revision,
    metric: { name: 'featureCasesPassed', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 10_000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 45_000, trialTimeoutMs: 25_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 90_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
    generation: { files: ['parse.ts', 'markdown-lines.ts'], contextFiles: ['types.ts'], allowedWorkerIds: ['builder'], maxOutputTokens: 8192,
      hypotheses: [{ id: 'fences', niche: 'parser-correctness', hypothesis: 'Mask Markdown examples without deleting source lines or changing legacy parsing.' }] },
    delivery: { branch: 'codex/parser-first' }, execution: { maxDurationMs: 120_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 360_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  const setup = { recipe, policy: { schemaVersion: 1 as const, id: 'parser-queue', registrationScope: 'parser-scope', profileId: 'parser', label: 'Fixed parser product',
    acceptance: 'Legacy CLI cases must pass; independently count correct feature cases. Evaluator, CLI wrapper and types are immutable.', maxEnrollments: 2, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['builder'], maxOutputTokens: 512, proposalTimeoutMs: 60_000, maxSuccessors: 1, pollIntervalMs: 100 } },
    output, resourceRuntime: paths.runtime, workspace: project, projectsFile: paths.projects };
  const plan = checkResourceEngineeringAutonomousSetup(setup); prepareResourceEngineeringAutonomousSetup({ ...setup, expectedPlanDigest: plan.planDigest });
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: neutral ? 'neutral-product' : 'parser-product', root: missionRoot,
    initial: { setup, expectedPlanDigest: plan.planDigest }, deadlineAt: new Date(Date.now() + (neutral ? 240_000 : 720_000)).toISOString(),
    maxScopes: neutral ? 1 : 2, pollIntervalMs: 100, proposalFeedback: 'measured-outcomes-v1' };
  return { base, project, ledgerRoot, revision, config, calls, errors, generationSeeds, proposals, allocation, access, evaluations, deliveries, children,
    ledger: () => resourcePoolStatus(ledgerRoot, pool, bindings, observations) };
}

describe.runIf(process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24)('mission product-value acceptance', () => {
  it('measures actual parser CLI behavior with fixed cases and rejects protected-file tampering', () => {
    const base = root();
    for (const stage of [0, 'neutral', 1, 2, 3] as const) {
      const project = join(base, String(stage)), scratch = join(base, `scratch-${stage}`); mkdirSync(project); mkdirSync(scratch); seed(project);
      for (const [name, text] of Object.entries(candidate(stage))) writeFileSync(join(project, name), text);
      const run = () => JSON.parse(execFileSync(process.execPath, [join(project, 'evaluate.mjs')], { cwd: project, encoding: 'utf8', timeout: 12_000,
        maxBuffer: 65536, env: { PATH: process.env.PATH, TMPDIR: scratch, ASHLR_UNIVERSE_CANDIDATE: project }, stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(run()).toMatchObject({ passed: true, score: stage === 0 || stage === 'neutral' ? 2 : stage === 1 ? 3 : stage === 2 ? 4 : 6 });
      if (stage === 3) { writeFileSync(join(project, 'types.ts'), types + '\n// changed\n'); expect(run().passed).toBe(false); }
    }
  }, 75_000);

  it('delivers three independently measured parser increments across two scopes, then replays without work', async () => {
    const f = await fixture(); const report = await runResourceEngineeringMission(f.config, { onProgress(value) { console.info('PRODUCT_MISSION_PHASE', value.scope, value.phase); } });
    expect(report, JSON.stringify({ report, calls: f.calls, errors: f.errors, fixture: f.base })).toMatchObject({ state: 'completed', reason: 'stop-requested', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 }); expect(f.errors).toEqual([]);
    expect(f.children.length).toBeGreaterThan(0);
    expect(f.generationSeeds.map(row => row.score)).toEqual([2, 3, 4]); expect(f.proposals).toHaveLength(1);
    const rows = readEngineeringMissionRecords(f.config), scopes = rows.filter(row => row.kind === 'reserved'); expect(scopes).toHaveLength(2);
    const first = rows.find(row => row.kind === 'settled' && row.index === 1)!.payload as { tip: { commit: string; enrollmentId: string } };
    const next = scopes[1]!.payload as { setup: { recipe: ResourceEngineeringRecipe } };
    expect(next.setup.recipe.seedRevision).toBe(first.tip.commit); expect(next.setup.recipe.generation).toEqual((f.config.initial.setup.recipe as ResourceEngineeringRecipe).generation);
    expect(next.setup.recipe.objective).toBe(nextObjective); expect(f.generationSeeds[2]!.objective).toBe(nextObjective);
    expect(f.proposals[0]!.measuredFeedback.source).toMatchObject(first.tip);
    expect(f.proposals[0]!.measuredFeedback.campaigns[0]!.usage).toMatchObject({ coverage: 'complete', attempts: 1, totalTokens: 30 });
    expect(git(f.project, 'show', `${report.tip!.commit}:parse.ts`)).toBe(parserCandidate(source).trim());
    expect(git(f.project, 'show', `${report.tip!.commit}:markdown-lines.ts`)).toBe(parserHelper(true).trim());
    for (const name of ['types.ts', 'cli.mjs', 'evaluate.mjs']) expect(git(f.project, 'show', `${report.tip!.commit}:${name}`)).toBe(readFileSync(join(f.project, name), 'utf8').trim());
    // Independently execute bytes read from the delivered Git commit, not the
    // worker response or a preconstructed expected candidate.
    const published = join(f.base, 'published'), scratch = join(f.base, 'published-scratch'); mkdirSync(published); mkdirSync(scratch);
    for (const name of ['parse.ts', 'markdown-lines.ts', 'types.ts', 'cli.mjs', 'evaluate.mjs']) writeFileSync(join(published, name), execFileSync('git', ['-C', f.project, 'show', `${report.tip!.commit}:${name}`], { timeout: 10_000, maxBuffer: 256 * 1024 }));
    const finalBehavior = JSON.parse(execFileSync(process.execPath, [join(published, 'evaluate.mjs')], { cwd: published, encoding: 'utf8', timeout: 12_000,
      maxBuffer: 65536, env: { PATH: process.env.PATH, TMPDIR: scratch, ASHLR_UNIVERSE_CANDIDATE: published }, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(finalBehavior).toMatchObject({ passed: true, score: 6 });
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.project, 'status', '--porcelain=v1')).toBe('');
    const ledger = f.ledger(); expect(ledger.attempts).toHaveLength(6); expect(ledger.attempts.every(row => row.status === 'completed' && row.workerId === 'builder')).toBe(true);
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.access);
    expect(existsSync(join(f.ledgerRoot, '.resource-console.lock'))).toBe(false);
    const refs = git(f.project, 'for-each-ref', '--format=%(refname):%(objectname)'), before = fixtureSnapshot(f.project);
    const evaluated = structuredClone(f.evaluations); expect(evaluated.length).toBeGreaterThanOrEqual(6);
    const stopped = new AbortController(); stopped.abort();
    expect(await runResourceEngineeringMission(f.config, { signal: stopped.signal })).toEqual(report);
    expect(readEngineeringMissionRecords(f.config)).toEqual(rows); expect(f.ledger().attempts).toEqual(ledger.attempts);
    expect(git(f.project, 'for-each-ref', '--format=%(refname):%(objectname)')).toBe(refs); expect(fixtureSnapshot(f.project)).toEqual(before);
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 });
    expect(f.evaluations).toEqual(evaluated);
  }, 900_000);

  it('withholds a behavior-neutral changed candidate through the real one-generation campaign', async () => {
    const f = await fixture(true), report = await runResourceEngineeringMission(f.config);
    expect(report, JSON.stringify({ report, calls: f.calls, fixture: f.base })).toMatchObject({ state: 'held', scopesReserved: 1 });
    expect(f.calls).toEqual({ generation: 1, successor: 0, mission: 0 }); expect(f.errors).toEqual([]);
    expect(f.generationSeeds[0]!.score).toBe(2);
    const evaluation = f.evaluations[0]!;
    const universe = projectUniverse(universePath(evaluation.root, evaluation.universeId));
    const trials = universe.runs.flatMap(run => run.trials);
    expect(trials).toHaveLength(1); expect(trials[0]).toMatchObject({ status: 'passed', score: 2 });
    expect(trials[0]!.artifact).not.toBeNull(); expect(f.evaluations.length).toBeGreaterThanOrEqual(2);
    expect(f.deliveries).toHaveLength(1); expect(f.deliveries[0]).toMatchObject({ campaign: { state: 'completed' }, delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(git(f.project, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(readEngineeringMissionRecords(f.config).some(row => row.kind === 'settled' || row.kind === 'proposal')).toBe(false);
    const ledger = f.ledger(); expect(ledger.attempts).toHaveLength(1); expect(ledger.attempts[0]).toMatchObject({ status: 'completed', workerId: 'builder' });
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.access);
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.project, 'status', '--porcelain=v1')).toBe('');
  }, 300_000);
});
