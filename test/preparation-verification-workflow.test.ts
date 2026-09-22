/** Real-process candidate substitution and real-store workflow evidence.
 * The supervisor is a disclosed nonexecuting view; manager/owner checks are real.
 * These observations are not a frozen numerical optimization reward. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPreparationVerificationBridge } from './helpers/preparation-verification-bundle.js';
import { preparationManagerFixture } from './helpers/preparation-workflow-manager-fixture.js';
import { preparationSuccessorFixture } from './helpers/preparation-workflow-successor-fixture.js';
import { readPreparedResourceEngineeringBundle, readResourceEngineeringSuccessorBundle } from '../src/core/resources/engineering-preparation.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = 'src/core/resources/engineering-preparation.ts';
const source = readFileSync(join(repository, target), 'utf8');
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
type Counts = { processes: number; blobProcesses: number };
interface Session {
  call(method: string, input: unknown): Promise<{ value?: unknown; error?: string; measurement: Counts }>;
  close(): Promise<void>;
  measurementLedger(): Counts & { requests: Array<Counts & { id: number; method: string }> };
}
let root: string, bridgePath: string, bridge: unknown;
let fixture: Awaited<ReturnType<typeof preparationManagerFixture>>;
let fixtureRoot: string;
let expectedBundle: ReturnType<typeof readPreparedResourceEngineeringBundle>;
let createSession: (options: unknown) => Promise<Session>;
let successor: Awaited<ReturnType<typeof preparationSuccessorFixture>> | undefined;
async function successorFixture() {
  if (successor) return successor;
  const directory = join(root, 'successor-fixture'); mkdirSync(directory, { mode: 0o700 });
  successor = await preparationSuccessorFixture(directory); return successor;
}
/** Match the child's genuinely uncommissioned home without stripping readiness
 * fields or copying signing keys. All paths are private test-owned directories;
 * global test isolation is restored synchronously before any child is started. */
function expectedInEmptyHome<T>(read: () => T): T {
  const home = mkdtempSync(join(root, 'expected-home-'));
  const keys = ['HOME', 'USERPROFILE', 'ASHLR_HOME'] as const;
  const prior = keys.map(key => process.env[key]);
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.ASHLR_HOME = home;
    return read();
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
  }
}
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isDirectory() ? Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))]))
      : createHash('sha256').update(readFileSync(file)).digest('hex') };
}
beforeAll(async () => {
  if (!supported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-workflow-')));
  mkdirSync(join(root, 'work'), { mode: 0o700 });
  const bundle = join(root, 'fixed'); mkdirSync(bundle, { mode: 0o700 });
  bridgePath = join(bundle, 'preparation-bridge.mjs');
  await buildPreparationVerificationBridge(repository, bridgePath);
  bridge = await import(pathToFileURL(bridgePath).href);
  ({ createPreparationCandidateSession: createSession } = await import(pathToFileURL(join(bundle, 'preparation-verification-controller.mjs')).href));
  fixtureRoot = join(root, 'fixture'); mkdirSync(fixtureRoot, { mode: 0o700 });
  fixture = await preparationManagerFixture(fixtureRoot);
  // Setup owners are now closed; a live setup lock must not enter the expected report.
  expectedBundle = expectedInEmptyHome(() => readPreparedResourceEngineeringBundle(fixture.bundleInput));
}, 60000);
afterAll(() => {
  if (!root) return;
  const writable = (file: string): void => {
    if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name));
  };
  writable(root); rmSync(root, { recursive: true, force: true });
});
async function session(text = source, selectedFixture = fixtureRoot) {
  const candidateRoot = mkdtempSync(join(root, 'candidate-'));
  mkdirSync(join(candidateRoot, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(candidateRoot, target), text, { mode: 0o600 });
  // Real manager restoration+replay exceeds the original leaf-only120s ceiling.
  // A complete successor sequence measured231s;300s leaves real-IO headroom.
  // Each fresh session receives one explicit deadline; calls do not renew it.
  return createSession({ bridge, bridgePath, candidateRoot, fixtureRoot: selectedFixture, workRoot: join(root, 'work'), timeoutMs: 300000 });
}
const poisonReads = (after: number, statement = 'throw Error("poisoned candidate reader");') => {
  const anchor = 'return readPreparedBundle(input);'; expect(source).toContain(anchor);
  return 'let workflowReads = 0;\n' + source.replace(anchor, `if (++workflowReads > ${after}) { ${statement} } ${anchor}`);
};

describe.runIf(supported)('candidate-linked preparation workflows', () => {
  it('ignores unrelated exported data while linking the fixed workflow', async () => {
    const child = await session(source + '\nexport const unusedWorkflowControl = 1;\n');
    try {
      expect(await child.call('manager-close', null)).toEqual({ value: null, measurement: { processes: 0, blobProcesses: 0 } });
    } finally { await child.close(); }
  });

  it('refuses a noncallable required workflow import', async () => {
    const anchor = 'export function readPreparedResourceEngineeringBundle(';
    expect(source).toContain(anchor);
    const text = source.replace(anchor, 'function unusedOriginalBundle(') + '\nexport const readPreparedResourceEngineeringBundle = 1;\n';
    const child = await session(text);
    try {
      expect((await child.call('manager-close', null)).error).toBe('candidate-threw');
    } finally { await child.close(); }
  });

  it('restores real registrations, checks and replays in two fresh candidate processes without effects', async () => {
    const counts: Counts[][] = [];
    for (let restart = 0; restart < 2; restart++) {
      const before = tree(fixtureRoot); const child = await session(); const measured: Counts[] = [];
      try {
        const opened = await child.call('manager-open', fixture.options);
        expect(opened.error).toBeUndefined(); expect(opened.value).toEqual({ catalog: fixture.catalog });
        measured.push(opened.measurement);
        const bundle = await child.call('bundle', fixture.bundleInput);
        expect(bundle.error).toBeUndefined(); expect(bundle.value).toEqual(expectedBundle); measured.push(bundle.measurement);
        const checked = await child.call('manager-check', fixture.requests[0]);
        expect(checked.error).toBeUndefined(); expect(checked.value).toEqual(fixture.plans[0]); measured.push(checked.measurement);
        const replay = await child.call('manager-replay', { ...fixture.requests[0], expectedPlanDigest: fixture.plans[0]!.planDigest });
        expect(replay.error).toBeUndefined(); expect(replay.value).toEqual({ ...fixture.prepared[0], disposition: 'replayed' });
        measured.push(replay.measurement);
        for (const count of measured) { expect(count.processes).toBeGreaterThan(0); expect(count.blobProcesses).toBeGreaterThan(0); }
        expect((await child.call('manager-close', null)).value).toBeNull();
        const ledger = child.measurementLedger();
        expect({ processes: ledger.processes, blobProcesses: ledger.blobProcesses }).toEqual(measured.reduce((sum, count) => ({ processes: sum.processes + count.processes,
          blobProcesses: sum.blobProcesses + count.blobProcesses }), { processes: 0, blobProcesses: 0 }));
        expect(ledger.requests.map(row => row.method)).toEqual(['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-close']);
        expect(ledger.requests.map(row => row.id)).toEqual([1, 2, 3, 4, 5]);
        ledger.requests[0]!.processes = -1;
        expect(child.measurementLedger().requests[0]!.processes).toBeGreaterThan(0);
      } finally { await child.close(); }
      expect(tree(fixtureRoot)).toEqual(before); counts.push(measured);
    }
    expect(counts[1]).toEqual(counts[0]);
    if (process.env.ASHLR_VERIFICATION_WORKFLOW_REPORT === '1') console.info('manager-workflow-baseline', JSON.stringify({
      methods: ['manager-open', 'bundle', 'manager-check', 'manager-replay'], counts: counts[0] }));
    expect(existsSync(join(fixture.options.root, 'pool-state.json'))).toBe(false);
  }, 600000);

  it('refuses changed objectives and unregistered replay without creating work', async () => {
    const before = tree(fixtureRoot); const child = await session();
    try {
      expect((await child.call('manager-open', fixture.options)).error).toBeUndefined();
      for (const patch of [{ objective: 'Different objective' }, { name: 'Different name' }, { profileId: 'missing' }]) {
        expect((await child.call('manager-check', { ...fixture.requests[0], ...patch })).error).toBe('candidate-threw');
      }
      expect((await child.call('manager-replay', { ...fixture.requests[0], id: 'unregistered',
        expectedPlanDigest: fixture.plans[0]!.planDigest })).error).toBe('candidate-threw');
      expect(tree(fixtureRoot)).toEqual(before);
    } finally { await child.close(); }
  }, 300000);

  it.each(['profile', 'restoration', 'check', 'replay', 'invalid-result'] as const)(
    'proves candidate substitution independently at %s', async route => {
      let text: string;
      if (route === 'profile') {
        const anchor = 'const first = capture(options); const final = capture(options);'; expect(source).toContain(anchor);
        text = source.replace(anchor, 'throw Error("poisoned candidate profile"); ' + anchor);
      } else text = poisonReads(route === 'restoration' ? 0 : 2,
        route === 'invalid-result' ? 'return {get status(){workflowGetterRuns++;return "prepared";}} as any;' : undefined);
      if (route === 'invalid-result') text = 'let workflowGetterRuns = 0;\n' + text.replace(
        'const first = capture(options); const final = capture(options);',
        'if ((options as any)?.workflowProbe === true) return {getterRuns:workflowGetterRuns} as any; const first = capture(options); const final = capture(options);');
      const before = tree(fixtureRoot); const child = await session(text);
      try {
        const opened = await child.call('manager-open', fixture.options);
        if (route === 'profile' || route === 'restoration') expect(opened.error).toBe('candidate-threw');
        else {
          expect(opened.error).toBeUndefined();
          const result = await child.call(route === 'replay' ? 'manager-replay' : 'manager-check', route === 'replay'
            ? { ...fixture.requests[0], expectedPlanDigest: fixture.plans[0]!.planDigest } : fixture.requests[0]);
          expect(result.error).toBeDefined();
          // This known control has an instrumented getter; an error alone could
          // otherwise mean the consumer invoked an accessor that happened to throw.
          if (route === 'invalid-result') expect((await child.call('check', { workflowProbe: true })).value).toEqual({ getterRuns: 0 });
        }
        expect(tree(fixtureRoot)).toEqual(before);
      } finally { await child.close(); }
    }, 300000);

  it('rechecks runtime after success and refuses restoration of missing evidence', async () => {
    const child = await session(); const runtimeBytes = readFileSync(fixture.options.config.resourceRuntime);
    try {
      expect((await child.call('manager-open', fixture.options)).error).toBeUndefined();
      expect((await child.call('manager-check', fixture.requests[0])).error).toBeUndefined();
      fixture.save(fixture.options.config.resourceRuntime, { ...fixture.runtime, capacityWaitMs: 1000 });
      const changed = tree(fixtureRoot);
      expect((await child.call('manager-check', fixture.requests[0])).error).toBe('candidate-threw');
      expect((await child.call('manager-replay', { ...fixture.requests[0], expectedPlanDigest: fixture.plans[0]!.planDigest })).error).toBe('candidate-threw');
      expect(tree(fixtureRoot)).toEqual(changed);
    } finally { await child.close(); writeFileSync(fixture.options.config.resourceRuntime, runtimeBytes); }
    // Real receipt removal occurs only in this private fixture; no cleanup or repair is authorized in the child.
    const receipt = join(fixture.options.config.outputRoot, fixture.requests[0]!.id, 'receipt.json');
    const bytes = readFileSync(receipt); unlinkSync(receipt); const missing = tree(fixtureRoot);
    const restarted = await session();
    try {
      expect((await restarted.call('manager-open', fixture.options)).error).toBe('candidate-threw');
      expect(tree(fixtureRoot)).toEqual(missing);
    } finally { await restarted.close(); writeFileSync(receipt, bytes, { mode: 0o600 }); }
  }, 300000);

  it('reads real delivered successor evidence in fresh processes, preserving its source and policy', async () => {
    const f = await successorFixture(); const counts: Counts[][] = [];
    const { commissioning: _commissioning, consoleArguments: _arguments, ...metadata } = f.prepared;
    const input = { ...f.options, expectedPlanDigest: f.plan.planDigest };
    const expectedFull = expectedInEmptyHome(() => readResourceEngineeringSuccessorBundle(input));
    for (let restart = 0; restart < 2; restart++) {
      const before = tree(f.base); const child = await session(source, f.base); const measured: Counts[] = [];
      try {
        for (const [method, args, expected] of [
          ['successor-check', f.options, f.plan],
          ['successor-metadata', input, { ...metadata, disposition: 'replayed' }],
          ['successor-bundle', input, expectedFull],
        ] as const) {
          const result = await child.call(method, args);
          expect(result.error).toBeUndefined(); expect(result.value).toEqual(expected);
          expect(result.measurement.processes).toBeGreaterThan(0); measured.push(result.measurement);
          expect(tree(f.base)).toEqual(before);
        }
      } finally { await child.close(); }
      counts.push(measured);
    }
    expect(counts[1]).toEqual(counts[0]);
    if (process.env.ASHLR_VERIFICATION_WORKFLOW_REPORT === '1') console.info('successor-workflow-baseline', JSON.stringify({
      methods: ['successor-check', 'successor-metadata', 'successor-bundle'], counts: counts[0] }));
    expect(f.git('rev-parse', 'HEAD')).toBe(f.revision);
    expect(existsSync(f.ledger)).toBe(false);
  }, 600000);

  it('refuses successor source drift after a successful read and after restart', async () => {
    const f = await successorFixture(); const input = { ...f.options, expectedPlanDigest: f.plan.planDigest };
    const child = await session(source, f.base);
    try {
      expect((await child.call('successor-metadata', input)).error).toBeUndefined();
      f.git('update-ref', 'refs/heads/codex/upstream', f.revision);
      const changed = tree(f.base);
      expect((await child.call('successor-metadata', input)).error).toBe('candidate-threw');
      expect(tree(f.base)).toEqual(changed);
      const restarted = await session(source, f.base);
      try {
        expect((await restarted.call('successor-bundle', input)).error).toBe('candidate-threw');
        expect(tree(f.base)).toEqual(changed);
      } finally { await restarted.close(); }
    } finally { await child.close(); f.git('update-ref', 'refs/heads/codex/upstream', f.receipt.commit); }
  }, 300000);
});
