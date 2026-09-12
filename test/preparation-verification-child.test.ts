/** Actual isolated candidate processes; no providers or production fixtures.
 * Return validation is exercised independently of benchmark expected results. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildPreparationVerificationBridge } from './helpers/preparation-verification-bundle.js';

interface CandidateResult { value?: unknown; error?: 'candidate-threw' | 'invalid-result';
  measurement: { processes: number; blobProcesses: number } }
interface Session { call(method: 'check' | 'metadata', input: unknown): Promise<CandidateResult>; close(): Promise<void> }
type CreateSession = (options: { bridge: unknown; bridgePath: string; candidateRoot: string;
  fixtureRoot: string; workRoot: string; timeoutMs: number }) => Promise<Session>;
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string, bridgePath: string, bridge: unknown, createSession: CreateSession;
let sequence = 0;
const sessions: Session[] = [];
const fixtures: string[] = [];
beforeAll(async () => {
  if (!supported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-child-test-')));
  const packaged = join(root, 'fixed'); mkdirSync(packaged, { mode: 0o700 });
  bridgePath = join(packaged, 'bridge.mjs');
  await buildPreparationVerificationBridge(repository, bridgePath);
  bridge = await import(pathToFileURL(bridgePath).href);
  const controller = await import(pathToFileURL(join(packaged, 'preparation-verification-controller.mjs')).href) as
    { createPreparationCandidateSession: CreateSession };
  createSession = controller.createPreparationCandidateSession;
}, 60000);
afterEach(async () => {
  // Faulted sessions deliberately reject close, but close still awaits actual
  // subprocess settlement. Never delete a fixture before that await finishes.
  for (const session of sessions.splice(0)) { try { await session.close(); } catch { /* Expected for deadline tests. */ } }
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

async function candidate(source: string, timeoutMs = 10000): Promise<Session> {
  // Catch payload syntax errors independently of startup/protocol rejection.
  execFileSync(process.execPath, ['--check', '--input-type=module'], {
    input: source, timeout: 5000, maxBuffer: 16384, encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  const fixture = join(root, `case-${++sequence}`); fixtures.push(fixture); mkdirSync(fixture, { mode: 0o700 });
  const candidateRoot = join(fixture, 'candidate'), workRoot = join(fixture, 'work');
  const target = join(candidateRoot, 'src/core/resources');
  mkdirSync(target, { recursive: true, mode: 0o700 }); mkdirSync(workRoot, { mode: 0o700 });
  const fixtureRoot = join(workRoot, 'readonly'); mkdirSync(fixtureRoot, { mode: 0o700 });
  writeFileSync(join(target, 'engineering-preparation.ts'), source, { mode: 0o600 });
  const session = await createSession({ bridge, bridgePath, candidateRoot, fixtureRoot, workRoot, timeoutMs });
  sessions.push(session); return session;
}

describe.runIf(supported)('actual preparation candidate result boundary', () => {
  it('accepts plain and null-prototype data while preserving the same candidate across calls', async () => {
    const session = await candidate(`let calls = 0;
export function checkResourceEngineeringPreparation(input) {
  const plain = Object.create(null); plain.value = input.value;
  return {calls: ++calls, plain, values: [null, true, false, 0, '雪']};
}
export function readPreparedResourceEngineeringMetadata(){return {calls};}`);
    expect(await session.call('check', { value: 7 })).toEqual({
      value: { calls: 1, plain: { value: 7 }, values: [null, true, false, 0, '雪'] },
      measurement: { processes: 0, blobProcesses: 0 },
    });
    expect((await session.call('check', { value: 9 })).value).toMatchObject({ calls: 2, plain: { value: 9 } });
    expect((await session.call('metadata', null)).value).toEqual({ calls: 2 });
    await Promise.all([session.close(), session.close()]); await session.close();
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
  });

  it.each([
    ['getter', 'return {get value(){touched++; return 1;}};'],
    ['toJSON', 'return {toJSON(){touched++; return {valid:true};}};'],
    ['custom object prototype', 'return Object.assign(Object.create({foreign:true}), {value:1});'],
    ['custom array prototype', 'const value=[1]; Object.setPrototypeOf(value, Object.create(Array.prototype)); return value;'],
    ['sparse array', 'return [,1];'],
    ['cycle', 'const value={}; value.self=value; return value;'],
    ['symbol key', 'return {[Symbol("hidden")]:1, value:2};'],
    ['nonenumerable key', 'return Object.defineProperty({value:1}, "hidden", {value:2});'],
    ['nonfinite number', 'return {value:Infinity};'],
    ['proxy', 'return new Proxy({value:1}, {ownKeys(){touched++; return ["value"];}});'],
    ['promise', 'return Promise.resolve({value:1});'],
  ])('rejects %s before JSON normalization without invoking candidate accessors', async (_name, body) => {
    const session = await candidate(`let touched=0;
export function checkResourceEngineeringPreparation(){${body}}
export function readPreparedResourceEngineeringMetadata(){return {touched};}`);
    expect(await session.call('check', null)).toEqual({ error: 'invalid-result', measurement: { processes: 0, blobProcesses: 0 } });
    expect((await session.call('metadata', null)).value).toEqual({ touched: 0 });
    await session.close();
  });

  it('reports a thrown candidate call separately and retains its module state', async () => {
    const session = await candidate(`let calls=0;
export function checkResourceEngineeringPreparation(){calls++; throw new Error('private candidate error');}
export function readPreparedResourceEngineeringMetadata(){return {calls};}`);
    const result = await session.call('check', null);
    expect(result).toEqual({ error: 'candidate-threw', measurement: { processes: 0, blobProcesses: 0 } });
    expect(JSON.stringify(result)).not.toContain('private candidate error');
    expect((await session.call('metadata', null)).value).toEqual({ calls: 1 });
    await session.close();
  });

  it('settles an infinite-loop call under the original session deadline without replay', async () => {
    const session = await candidate(`import {readFileSync} from 'node:fs';
const childProcess = readFileSync.constructor('return process')();
export function checkResourceEngineeringPreparation(){for(;;){}}
export function readPreparedResourceEngineeringMetadata(){return childProcess.pid;}`, 2000);
    const pid = (await session.call('metadata', null)).value;
    expect(Number.isSafeInteger(pid)).toBe(true);
    const started = performance.now();
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    expect(performance.now() - started).toBeLessThan(6000);
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    await expect(session.close()).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    expect(() => process.kill(pid as number, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 10000);
});
