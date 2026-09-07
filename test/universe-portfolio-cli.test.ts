import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition, UniversePortfolioPlan } from '../src/core/universe/portfolio-types.js';
import type { UniversePortfolioResult } from '../src/core/universe/index.js';

const core = vi.hoisted(() => ({ readUniversePortfolioPlan: vi.fn(), runUniversePortfolio: vi.fn() }));
vi.mock('../src/core/universe/index.js', async () => {
  const { validateUniversePortfolioDefinition } = await import('../src/core/universe/portfolio-plan.js');
  return { ...core, validateUniversePortfolioDefinition };
});
import { cmdUniversePortfolio } from '../src/cli/universe-portfolio.js';

function definition(): UniversePortfolioDefinition {
  return { schemaVersion: 1, id: 'portfolio', tasks: [{ campaignId: 'first', dependsOn: [] },
    { campaignId: 'second', dependsOn: ['first'] }], maxParallel: 2, maxDurationMs: 60_000 };
}

function campaign(): UniverseCampaignSummary {
  return {
    definition: { schemaVersion: 1, id: 'first', universeId: 'calendar', feedback: true,
      budget: { maxGenerations: 5, maxDurationMs: 90_000, maxModelRequests: 5, maxStagnantGenerations: 3, maxReportedTokens: null } },
    definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
    createdAt: '2026-09-07T01:00:00.000Z', startedAt: null, deadlineAt: null, finishedAt: null,
    state: 'ready', reason: null, steps: [], owner: null, sourceState: 'healthy', reasons: [],
    progress: { attempts: 1, completedRuns: 1, interruptedRuns: 0, reservedModelRequests: 1,
      reportedTokens: null, recordedTokens: 42, usageComplete: false, admissions: 1, improvements: 0, stagnantGenerations: 0 },
  };
}

function plan(): UniversePortfolioPlan {
  const value = definition();
  return { schemaVersion: 1, definition: value, definitionDigest: 'd'.repeat(64),
    sampledAt: '2026-09-07T01:00:00.000Z', measurementScope: 'local-experiment', sourceState: 'healthy', reasons: [],
    topologicalOrder: ['first', 'second'], nodes: value.tasks.map((task, index) => ({ ...task,
      universeId: index === 0 ? 'calendar' : 'compiler', campaign: campaign(), definitionDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), state: index === 0 ? 'ready' : 'waiting', reason: null })) };
}

function result(status: UniversePortfolioResult['status'] = 'completed'): UniversePortfolioResult {
  return { schemaVersion: 1, definitionDigest: 'd'.repeat(64), measurementScope: 'local-experiment', status,
    startedAt: '2026-09-07T01:00:00.000Z', deadlineAt: '2026-09-07T01:01:00.000Z', finishedAt: '2026-09-07T01:00:10.000Z',
    plan: plan(), reasons: [], outcomes: definition().tasks.map((task) => ({ campaignId: task.campaignId,
      status: status === 'completed' ? 'completed' : 'cancelled', attempted: true, reason: null, campaign: campaign() })) };
}

describe('Universe portfolio CLI', () => {
  let root: string;
  let manifest: string;
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    root = mkdtempSync(join(tmpdir(), 'ashlr-portfolio-cli-'));
    manifest = join(root, 'portfolio.json');
    writeFileSync(manifest, JSON.stringify(definition()));
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.readUniversePortfolioPlan.mockReturnValue(plan());
    core.runUniversePortfolio.mockResolvedValue(result());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [], ['unknown'], ['plan'], ['run'], ['plan', 'portfolio.json'], ['run', 'campaign-id'],
    ['plan', '--manifest'], ['plan', '--manifest', '--json'], ['plan', '--manifest', ''],
    ['plan', '--manifest', '\0'], ['run', '--manifest', 'a\nb'], ['plan', '--root', '\x85'],
    ['plan', '--root', '-h'], ['plan', '--manifest', 'x'.repeat(4_097)],
    ['plan', '--manifest', 'first', '--manifest', 'second'], ['plan', '--root', 'first', '--root', 'second'],
    ['plan', '--unknown'], ['plan', '--json'], ['plan', '--help', '-h'],
    ['plan', '--help', '--unknown'], ['help', 'extra'], ['run', '--depth', '1'],
  ])('rejects invalid arguments %j before reading campaign evidence or executing', async (...args) => {
    expect(await cmdUniversePortfolio([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it.each([
    '{}', '{broken', 'null', '[]', '',
    JSON.stringify({ ...definition(), unknown: true }),
    JSON.stringify({ ...definition(), id: '../escape' }),
    JSON.stringify({ ...definition(), id: 'with\ncontrol' }),
    JSON.stringify({ ...definition(), maxParallel: 0 }),
    JSON.stringify({ ...definition(), maxParallel: 9 }),
    JSON.stringify({ ...definition(), maxDurationMs: 0 }),
    JSON.stringify({ ...definition(), maxDurationMs: 86_400_001 }),
    JSON.stringify({ ...definition(), tasks: [] }),
    JSON.stringify({ ...definition(), tasks: [{ campaignId: 'first', dependsOn: ['first'] }] }),
    JSON.stringify({ ...definition(), tasks: [{ campaignId: 'first', dependsOn: ['missing'] }] }),
    JSON.stringify({ ...definition(), tasks: [{ campaignId: 'first', dependsOn: [] }, { campaignId: 'first', dependsOn: [] }] }),
    JSON.stringify({ ...definition(), tasks: [{ campaignId: 'first', dependsOn: ['second'] }, { campaignId: 'second', dependsOn: ['first'] }] }),
  ])('rejects malformed or invalid manifest before effects (%#)', async (contents) => {
    writeFileSync(manifest, contents);
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest, '--json'])).toBe(2);
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it('rejects a manifest over the byte limit without contacting the planner', async () => {
    writeFileSync(manifest, Buffer.alloc(256 * 1024 + 1, 32));
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string).error).toContain('256 KiB');
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
  });

  it('accepts a full bounded DAG larger than 128 KiB', async () => {
    const ids = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, '0')}${'a'.repeat(62)}`);
    const value = { ...definition(), maxParallel: 8, tasks: ids.map((campaignId, index) => ({ campaignId, dependsOn: ids.slice(0, index) })) };
    const bytes = JSON.stringify(value);
    expect(Buffer.byteLength(bytes)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(bytes)).toBeLessThan(256 * 1024);
    writeFileSync(manifest, bytes);
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.readUniversePortfolioPlan).toHaveBeenCalledWith(value, { root: undefined });
  });

  it('rejects invalid UTF-8 without echoing manifest contents', async () => {
    writeFileSync(manifest, Buffer.from([0xc3, 0x28]));
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Manifest must contain valid UTF-8 JSON' });
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it('rejects directories, missing files and symbolic links before planning', async () => {
    const directory = join(root, 'directory');
    mkdirSync(directory);
    const link = join(root, 'linked.json');
    symlinkSync(manifest, link);
    for (const path of [directory, join(root, 'missing.json'), link]) {
      expect(await cmdUniversePortfolio(['plan', '--manifest', path, '--json'])).toBe(2);
    }
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
  });

  it('reads a validated detached definition for planning without running or attaching signal handlers', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--root', 'private store', '--json'])).toBe(0);
    expect(core.readUniversePortfolioPlan).toHaveBeenCalledWith(definition(), { root: resolve('private store') });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each(['ready', 'waiting', 'completed'] as const)('returns success for a healthy %s plan', async (state) => {
    const value = plan(); value.nodes.forEach((node) => { node.state = state; });
    core.readUniversePortfolioPlan.mockReturnValue(value);
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--json'])).toBe(0);
  });

  it.each(['blocked', 'busy', 'unavailable'] as const)('returns nonzero for a healthy plan containing %s work', async (state) => {
    const value = plan(); value.nodes[1]!.state = state;
    core.readUniversePortfolioPlan.mockReturnValue(value);
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it('preserves degraded planning evidence and does not report successful readiness', async () => {
    const value = plan(); value.sourceState = 'degraded'; value.reasons = ['Campaign evidence unavailable'];
    core.readUniversePortfolioPlan.mockReturnValue(value);
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
  });

  it('renders dependency and budget scope without claiming accepted artifacts or zero unknown tokens', async () => {
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('second · waiting');
    expect(text).toContain('Depends on: first');
    expect(text).toContain('Invocation limits: 2 concurrent campaigns · 60000 ms');
    expect(text).toContain('Model-generation tokens: unavailable · recorded subtotal: 42');
    expect(text).toContain('not artifact acceptance or production success');
  });

  it('does not render degraded campaign progress as trusted measurements', async () => {
    const value = plan(); value.nodes[0]!.campaign!.sourceState = 'degraded';
    core.readUniversePortfolioPlan.mockReturnValue(value);
    await cmdUniversePortfolio(['plan', '--manifest', manifest]);
    expect(output.mock.calls[0]![0]).toContain('Campaign progress: unavailable');
  });

  it('passes an AbortSignal to the awaited foreground runner and restores listeners', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest, '--root', root, '--json'])).toBe(0);
    expect(core.runUniversePortfolio).toHaveBeenCalledWith(definition(), { root, signal: expect.any(AbortSignal) });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result());
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('requests %s cancellation and waits for runner settlement', async (signalName) => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    let signal: AbortSignal | undefined;
    let finish!: (value: UniversePortfolioResult) => void;
    core.runUniversePortfolio.mockImplementation((_definition, options) => {
      signal = options.signal;
      return new Promise<UniversePortfolioResult>((resolveResult) => { finish = resolveResult; });
    });
    let settled = false;
    const invocation = cmdUniversePortfolio(['run', '--manifest', manifest, '--json']).then((code) => { settled = true; return code; });
    expect(signal?.aborted).toBe(false);
    process.emit(signalName);
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(result('cancelled'));
    expect(await invocation).toBe(1);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each(['incomplete', 'cancelled', 'timed-out', 'failed'] as const)('returns nonzero for %s execution', async (status) => {
    core.runUniversePortfolio.mockResolvedValue(result(status));
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).status).toBe(status);
  });

  it('renders initial dependencies separately from final campaign outcomes', async () => {
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Initial dependency plan:');
    expect(text).toContain('second · waiting · depends on first');
    expect(text).toContain('Final campaign outcomes:');
    expect(text).toContain('second · completed · attempted');
    expect(text).toContain('existing campaign budgets and deadlines remain unchanged');
    expect(text).toContain('no artifact transfer, automatic delivery, push, merge, deployment, or production acceptance');
    expect(text).not.toContain('$');
  });

  it('cleans up signal listeners after a runner exception without retrying', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    core.runUniversePortfolio.mockRejectedValue(new Error('Execution ownership unavailable'));
    expect(await cmdUniversePortfolio(['run', '--manifest', manifest, '--json'])).toBe(1);
    expect(core.runUniversePortfolio).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Execution ownership unavailable' });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('reports planner read failure on stderr', async () => {
    core.readUniversePortfolioPlan.mockImplementation(() => { throw new Error('Source unavailable'); });
    expect(await cmdUniversePortfolio(['plan', '--manifest', manifest])).toBe(1);
    expect(errors).toHaveBeenCalledWith('universe portfolio: Source unavailable');
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it.each([['help'], ['--help'], ['run', '-h']])('prints help for %j without reading any manifest', async (...args) => {
    expect(await cmdUniversePortfolio(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('at most 256 KiB');
    expect(output.mock.calls[0]![0]).toContain('A new invocation gets');
    expect(core.readUniversePortfolioPlan).not.toHaveBeenCalled();
    expect(core.runUniversePortfolio).not.toHaveBeenCalled();
  });

  it('routes through the existing Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['portfolio', 'plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.readUniversePortfolioPlan).toHaveBeenCalledOnce();
  });

  it('classifies planning as read-only and execution as an explicit append action in agent help', async () => {
    const { AGENT_COMMANDS } = await import('../src/cli/help.js');
    expect(AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe portfolio plan'))).toMatchObject({ safety: 'read', jsonShape: 'UniversePortfolioPlan' });
    expect(AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe portfolio run'))).toMatchObject({ safety: 'append', jsonShape: 'UniversePortfolioResult' });
  });

  it.each(['bash', 'zsh'])('includes portfolio in %s completions', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([text]) => text).join('')).toMatch(/universe\).*portfolio/);
  });
});
