/** Unit seam only: execute the unchanged owner function with synthetic clocks,
 * identity/artifact transports, compiler execution and activity bookkeeping.
 * This proves owner ordering, not native compiler qualification or settlement.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('preparation-score.mjs', readFileSync(new URL(
  '../scripts/evaluators/preparation-score.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const owner = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'runPreparationScore');
if (!owner) throw new Error('Fixed scoring owner function missing');
const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'exact' ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && ['sha', 'fail', 'failed'].includes(item.name.text)));
// Only remove the export modifier and rewrite module syntax. All owner guard,
// timer, lifecycle, result and finally statements are the production AST.
const transformed = ts.transform(owner, [context => root => {
  const visit: ts.Visitor = node => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return context.factory.createIdentifier('__meta');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return context.factory.updateCallExpression(node, context.factory.createIdentifier('__load'), undefined, node.arguments);
    }
    return ts.visitEachChild(node, visit, context);
  };
  const result = ts.visitNode(root, visit) as ts.FunctionDeclaration;
  return context.factory.updateFunctionDeclaration(result, result.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
    result.asteriskToken, result.name, result.typeParameters, result.parameters, result.type, result.body);
}]);
const printer = ts.createPrinter();
const code = [...helpers, transformed.transformed[0]!].map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n');
transformed.dispose();
const invoke = compileFunction(`const {process,performance,createHash,dirname,join,fileURLToPath,openBuiltinActivityTracker,
  inspectPreparationScoreIdentity,readArtifactSnapshot,summarizePreparationProcessArtifact,assertPreparationProcessScope,
  PREPARATION_TYPECHECK_TARGET,runVerifySubprocessAsync,setTimeout,clearTimeout,scorePreparationProcesses}=deps;
  ${code}\nreturn runPreparationScore();`, ['deps', '__load', '__meta', 'globalThis', 'Date']);

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const TARGET = 'src/core/resources/engineering-preparation.ts';
const ENTRY = '/fixed/score/preparation-score.mjs';
type Trigger = 'success' | 'before-reservation' | 'reservation' | 'return' | 'cancel-reservation' |
  'cancel-running' | 'outer-timer' | 'runner-throw' | 'timed-out' | 'unconfirmed';
interface Options { trigger?: Trigger; clock?: 'wall' | 'mono'; duration?: number; setupElapsed?: number }
async function run(options: Options = {}) {
  let wall = NOW, mono = 1000, pending = false, launches = 0;
  const duration = options.duration ?? 120_000, trigger = options.trigger ?? 'success';
  const listeners = new Map<string, () => void>(), timers = new Map<number, () => void>();
  const events: string[] = [];
  const advance = () => { if (options.clock === 'wall') wall += Math.min(duration, 60_000); else mono += Math.min(duration, 60_000); };
  const stop = () => listeners.get('SIGTERM')?.();
  const settled = vi.fn((state: string) => { events.push(`settled:${state}`); if (state !== 'unconfirmed') pending = false; });
  const prepare = vi.fn(() => {
    pending = true; events.push('reservation');
    if (trigger === 'reservation') advance();
    if (trigger === 'cancel-reservation') stop();
    return { spawned: vi.fn(), settled };
  });
  const complete = vi.fn(() => { events.push('complete'); if (pending) throw new Error('Synthetic unresolved activity'); });
  const git = { path: '/fixed/git', digest: 'a'.repeat(64) };
  const identity = { digest: 'b'.repeat(64), git, calibrationJson: '{}', workload: {}, typecheckProjectSha256: 'c'.repeat(64) };
  const snapshot = { digest: 'd'.repeat(64), entries: [{ path: TARGET, data: Buffer.from('export const fixed = 1;') }] };
  const process = { execPath: '/fixed/node', argv: ['/fixed/node', ENTRY, '/fixed/score/measurement/preparation-bridge.mjs'],
    env: { HOME: '/private/scratch', ASHLR_UNIVERSE_BUILTIN_ACTIVITY: '/private/activity',
      ASHLR_UNIVERSE_BUILTIN_GIT: JSON.stringify(git), ASHLR_UNIVERSE_CANDIDATE: '/private/candidate' },
    on: vi.fn((name: string, callback: () => void) => listeners.set(name, callback)),
    removeListener: vi.fn((name: string) => listeners.delete(name)), stdout: { write: vi.fn() } };
  const timer = vi.fn((callback: () => void, timeout: number) => {
    events.push(`timer:${timeout}`); timers.set(1, callback); return 1;
  });
  const clear = vi.fn((id: number) => { events.push('clear'); timers.delete(id); });
  const runner = vi.fn(async (_argv: string[], settings: { input: string; signal: AbortSignal; timeoutMs: number;
    requireProcessGroupExit: boolean; processGroupLifecycle: { prepare(): ReturnType<typeof prepare> } }) => {
    events.push('runner'); expect(timers.size).toBe(1); expect(settings.requireProcessGroupExit).toBe(true);
    if (trigger === 'before-reservation') advance();
    const reservation = settings.processGroupLifecycle.prepare();
    launches++; events.push('spawn'); reservation.spawned();
    if (trigger === 'return') advance();
    if (trigger === 'cancel-running') stop();
    if (trigger === 'outer-timer') timers.get(1)!();
    if (trigger === 'runner-throw') throw new Error('Synthetic lost return');
    reservation.settled(trigger === 'unconfirmed' ? 'unconfirmed' : 'group-exit-confirmed');
    const request = JSON.parse(settings.input) as { sourceSha256: string; projectSha256: string };
    return { stdout: JSON.stringify({ schemaVersion: 1, kind: 'preparation-typecheck-result', passed: true,
      sourceSha256: request.sourceSha256, projectSha256: request.projectSha256, diagnosticCodes: [] }),
      stderr: '', exitCode: 0, signal: null, timedOut: trigger === 'timed-out', cancelled: settings.signal.aborted,
      processGroupSettlement: trigger === 'unconfirmed' ? 'unconfirmed' : 'group-exit-confirmed' };
  });
  const workload = vi.fn(async () => { events.push('workload'); expect(timers.size).toBe(0); return {}; });
  const load = vi.fn(async (specifier: string) => {
    expect(specifier).toBe('./measurement/preparation-verification.mjs'); return { runPreparationWorkload: workload };
  });
  const score = vi.fn(() => ({ passed: true, score: 150, metrics: { improved: 0 } }));
  class Clock extends Date { static override now() { return wall; } }
  const result = await invoke({ process, performance: { now: () => mono }, createHash, dirname, join, fileURLToPath,
    openBuiltinActivityTracker: async () => ({ owner: { deadlineAt: new Date(NOW + duration).toISOString(), implementationDigest: identity.digest },
      lifecycle: (kind: string) => { expect(kind).toBe('tool'); return { prepare }; }, complete }),
    inspectPreparationScoreIdentity: () => identity, readArtifactSnapshot: () => snapshot,
    summarizePreparationProcessArtifact: () => ({ digest: snapshot.digest }),
    assertPreparationProcessScope: () => { const elapsed = options.setupElapsed ?? 0; wall += elapsed; mono += elapsed; },
    PREPARATION_TYPECHECK_TARGET: TARGET, runVerifySubprocessAsync: runner, setTimeout: timer, clearTimeout: clear,
    scorePreparationProcesses: score,
  }, load, { url: pathToFileURL(ENTRY).href }, { AbortController, TextDecoder }, Clock) as {
    passed: boolean; score: number; diagnostics?: Array<{ code: string }> };
  expect(listeners.size).toBe(0); expect(timers.size).toBe(0); expect(process.stdout.write).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(1);
  if (timer.mock.calls.length) expect(clear).toHaveBeenCalledExactlyOnceWith(1);
  return { result, events, launches, prepare, settled, runner, workload, load, timer, clear, score };
}

describe('fixed score owner compiler deadline and lifecycle seam', () => {
  it.each(['wall', 'mono'] as const)('settles not-started when reservation consumes the 60s %s compiler allowance', async clock => {
    const r = await run({ trigger: 'reservation', clock });
    expect(r.result).toMatchObject({ passed: false, diagnostics: [{ code: 'PREPARATION_SCORE_TYPECHECK_FAILED' }] });
    expect(r.launches).toBe(0); expect(r.settled).toHaveBeenCalledExactlyOnceWith('not-started');
    expect(r.workload).not.toHaveBeenCalled(); expect(r.events).toEqual(['timer:60000', 'runner', 'reservation', 'settled:not-started', 'clear', 'complete']);
  });
  it.each(['wall', 'mono'] as const)('retains the shorter original %s deadline during reservation', async clock => {
    const r = await run({ trigger: 'reservation', clock, duration: 10_000 });
    expect(r.result).toMatchObject({ passed: false, diagnostics: [{ code: 'PREPARATION_SCORE_CANCELLED_OR_EXPIRED' }] });
    expect(r.timer.mock.calls[0]?.[1]).toBe(10_000); expect(r.launches).toBe(0);
    expect(r.settled).toHaveBeenCalledExactlyOnceWith('not-started'); expect(r.workload).not.toHaveBeenCalled();
  });
  it.each(['wall', 'mono'] as const)('refuses a delayed successful compiler return after its %s phase cap', async clock => {
    const r = await run({ trigger: 'return', clock });
    expect(r.result.passed).toBe(false); expect(r.launches).toBe(1);
    expect(r.settled).toHaveBeenCalledExactlyOnceWith('group-exit-confirmed'); expect(r.load).not.toHaveBeenCalled();
  });
  it('does not even reserve if runner setup consumes the compiler deadline', async () => {
    const r = await run({ trigger: 'before-reservation' });
    expect(r.result.passed).toBe(false); expect(r.prepare).not.toHaveBeenCalled(); expect(r.launches).toBe(0); expect(r.workload).not.toHaveBeenCalled();
  });
  it('records not-started for cancellation during reservation', async () => {
    const r = await run({ trigger: 'cancel-reservation' });
    expect(r.result.passed).toBe(false); expect(r.launches).toBe(0);
    expect(r.settled).toHaveBeenCalledExactlyOnceWith('not-started'); expect(r.workload).not.toHaveBeenCalled();
  });
  it.each(['cancel-running', 'outer-timer', 'timed-out', 'runner-throw', 'unconfirmed'] as const)('does not invoke workload after %s and clears the outer timer', async trigger => {
    const r = await run({ trigger }); expect(r.result.passed).toBe(false); expect(r.launches).toBe(1);
    expect(r.workload).not.toHaveBeenCalled(); expect(r.score).not.toHaveBeenCalled(); expect(r.clear).toHaveBeenCalledTimes(1);
    if (trigger === 'runner-throw' || trigger === 'unconfirmed') expect(r.result.diagnostics?.[0]?.code).toBe('PROCESS_SETTLEMENT_UNCONFIRMED');
  });
  it('subtracts original setup time and clears compiler timer before the synthetic workload', async () => {
    const r = await run({ duration: 30_000, setupElapsed: 7000 });
    expect(r.result).toMatchObject({ passed: true, score: 150 }); expect(r.runner.mock.calls[0]?.[1].timeoutMs).toBe(23_000);
    expect(r.events).toEqual(['timer:23000', 'runner', 'reservation', 'spawn', 'settled:group-exit-confirmed', 'clear', 'workload', 'complete']);
  });
});
