/**
 * 3.10 Track B unit U7 — engines & judges (SPEC-310B §3, §7 U7).
 *
 * Key tests: grok-cli argv snapshot · xai family · Grok judges only through
 * grok-cli · same-family judge refused · Claude judge runs restricted ·
 * verdict cache. Plus the seat resolution behind grok-cli, the catalog, the
 * best-of-N plan, and the grok stream parser.
 *
 * NO PAID CALL, EVER. The grok "seat" here is a real native profile prepared by
 * `prepareResourceNativeProfile` in a tmp dir, pinned to an INERT executable
 * that records its argv/env/cwd and prints a canned NDJSON answer — so the
 * whole path (registry fold → node launcher.mjs → execve with GROK_HOME →
 * stream parse → verdict) runs for real without inference. Claude is never
 * spawned: its spawn is intercepted and the argv/env inspected.
 * HOME stays the per-worker tmp HOME (test/setup/home.ts); fixtures live in
 * their own mkdtemp dirs.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, EngineCommand, EngineId, Proposal } from '../src/core/types.js';

const hoisted = vi.hoisted(() => ({
  engineInstalled: null as null | ((engine: string) => boolean),
  spawn: null as null | ((cmd: unknown, cfg: unknown, opts: unknown) => unknown),
}));

// Real engines.js, with two switchable seams: which CLIs "are installed" and
// who handles a spawn. Default = the real implementation.
vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return {
    ...real,
    engineInstalled: (engine: string, cfg: AshlrConfig) =>
      hoisted.engineInstalled ? hoisted.engineInstalled(engine) : real.engineInstalled(engine as EngineId, cfg),
    spawnEngine: (cmd: EngineCommand, cfg: AshlrConfig, opts?: Parameters<typeof real.spawnEngine>[2]) =>
      hoisted.spawn ? hoisted.spawn(cmd, cfg, opts) : real.spawnEngine(cmd, cfg, opts),
  };
});

import { buildEngineCommand, engineInstalled } from '../src/core/run/engines.js';
import {
  BUILTIN_ENGINE_REGISTRY,
  CLAUDE_RESTRICTED_ARGS,
  GROK_CLI_HEADLESS_ARGV,
  __resetGrokCliSeatCacheForTests,
  compileArgv,
  extractGrokStreamText,
  isRestrictedClaudeCommand,
  registryEngineForFleetEngine,
  resolveEngineRegistry,
  resolveEngineSpec,
  restrictClaudeCommand,
} from '../src/core/run/engine-registry.js';
import { prepareResourceNativeProfile, resolveNativeSeatLaunch } from '../src/core/resources/native-profile.js';
import { GROK_CLI_DEFAULT_MODEL, canonicalModelTag, pickModel } from '../src/core/run/model-catalog.js';
import { planAutonomousBestOfN } from '../src/core/run/best-of-n-policy.js';
import {
  evaluateJudgeEligibility,
  evaluateReviewerIndependence,
  isFrontierJudgeId,
  judgeLanePreference,
  producerModelFamily,
  reviewModelFamily,
} from '../src/core/fleet/reviewer-independence.js';
import { agentSemanticModelFamily, defineAgentSemanticEvents } from '../src/core/learning/agent-semantic-events.js';
import {
  JUDGE_PROMPT_VERSION,
  clearJudgeVerdictCache,
  judgeProposal,
  judgeVerdictCacheKey,
  managerSemanticEvents,
  resolveFrontierJudgeClient,
  setJudgeCredentialSource,
  type FrontierJudgeClient,
} from '../src/core/fleet/manager.js';
import { __resetLocalOnlyLatchForTests, engineMeteredness, enginePermitted } from '../src/core/policy/local-only.js';
import { hashDiff } from '../src/core/foundry/provenance.js';

const SUPPORTS_PROFILES = process.platform !== 'win32' && typeof process.execve === 'function';

// ---------------------------------------------------------------------------
// Fixture: a private accounts roster + a prepared grok native profile
// ---------------------------------------------------------------------------

/** Inert "grok": records argv/env/cwd into GROK_HOME, prints GROK_HOME/response.ndjson. */
function inertGrokSource(): string {
  return `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const home = process.env.GROK_HOME;
fs.writeFileSync(path.join(home, 'last-call.json'), JSON.stringify({
  args: process.argv.slice(2), env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()),
}));
const response = path.join(home, 'response.ndjson');
if (fs.existsSync(response)) process.stdout.write(fs.readFileSync(response, 'utf8'));
`;
}

interface SeatFixture {
  base: string;
  accountsRoot: string;
  profileDir: string;
  nativeStatePath: string;
  command: [string, string];
  cfg: AshlrConfig;
}

let fixtures: string[] = [];

function writeRoster(accountsRoot: string, accounts: Array<{ id: string; provider: string; command: string[] }>, mode = 0o600): void {
  const file = join(accountsRoot, 'connections.json');
  rmSync(file, { force: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, intervalMs: 30_000,
    accounts: accounts.map((a) => ({ ...a, label: a.id })) }, null, 2), { mode });
  chmodSync(file, mode);
}

function makeSeatFixture(opts: { seatId?: string } = {}): SeatFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'u7-seat-')));
  fixtures.push(base);
  const binary = join(base, 'grok-inert');
  writeFileSync(binary, inertGrokSource(), { mode: 0o700 });
  const accountsRoot = join(base, 'account-connections');
  mkdirSync(accountsRoot, { mode: 0o700 });
  const profiles = join(base, 'native-profiles');
  mkdirSync(profiles, { mode: 0o700 });
  const profile = prepareResourceNativeProfile({ provider: 'grok', directory: join(profiles, 'grok-a'), executable: binary });
  const command = profile.command as [string, string];
  writeRoster(accountsRoot, [{ id: opts.seatId ?? 'grok', provider: 'grok', command }]);
  // `models` is present in every real config; spawnEngine's tool env reads it.
  const cfg = { models: { ollama: 'http://127.0.0.1:9' }, foundry: { grokCli: { accountsRoot } } } as unknown as AshlrConfig;
  return { base, accountsRoot, profileDir: profile.directory, nativeStatePath: profile.nativeStatePath, command, cfg };
}

function lastCall(seat: SeatFixture): { args: string[]; env: Record<string, string>; cwd: string; cwdEntries: string[] } {
  return JSON.parse(readFileSync(join(seat.nativeStatePath, 'last-call.json'), 'utf8'));
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-u7-1',
    repo: '/nonexistent/u7-repo',
    origin: 'backlog',
    kind: 'patch',
    title: 'u7 fixture proposal',
    summary: 'a small change',
    status: 'pending',
    createdAt: '2026-09-24T00:00:00.000Z',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
    engineModel: 'local-coder:qwen3.8:27b-ctx64k',
    engineTier: 'mid',
    ...over,
  } as Proposal;
}

const SHIP = { verdict: 'ship', value: 4, correctness: 4, scope: 1, alignment: 4, rationale: 'small, correct change' };

beforeEach(() => {
  __resetGrokCliSeatCacheForTests();
  clearJudgeVerdictCache();
  setJudgeCredentialSource(null);
  hoisted.engineInstalled = null;
  hoisted.spawn = null;
});

afterEach(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
  __resetGrokCliSeatCacheForTests();
  __resetLocalOnlyLatchForTests();
  setJudgeCredentialSource(null);
});

// ===========================================================================
// grok-cli argv snapshot
// ===========================================================================

describe('grok-cli engine — argv snapshot (SPEC-310B §3)', () => {
  it('the builtin spec is a frontier cli-agent with the exact seat argv template', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['grok-cli']!;
    expect(spec).toMatchObject({ id: 'grok-cli', kind: 'cli-agent', tier: 'frontier', defaultModel: 'grok-4.7' });
    expect(spec.argv).toEqual([
      '--no-auto-update',
      '--output-format', 'streaming-messages-json',
      '--cwd', '$CWD',
      // INT4: optional (never `--model ''`); the sandboxed producer names the default.
      { optModel: ['--model', '$MODEL'] },
      '--permission-mode', 'dontAsk',
      { join: ['--single=', '$GOAL'] },
    ]);
    // The per-token API engine is unchanged: mid tier, not a seat.
    expect(BUILTIN_ENGINE_REGISTRY['grok']).toMatchObject({ kind: 'api-model', tier: 'mid' });
  });

  it('{join} glues substituted parts into ONE element and never expands inside a value', () => {
    expect(compileArgv([{ join: ['--single=', '$GOAL'] }, '$CWD'], { goal: '-rf $CWD; `x`', cwd: '/w' }))
      .toEqual(['--single=-rf $CWD; `x`', '/w']);
    expect(compileArgv([{ join: ['--m=', '$MODEL'] }], { goal: 'g', cwd: '/w', model: 'grok-4.7' })).toEqual(['--m=grok-4.7']);
  });

  it.skipIf(!SUPPORTS_PROFILES)('resolves through the grok-a native profile: node + launcher.mjs, exact argv', () => {
    const seat = makeSeatFixture();
    const cmd = buildEngineCommand('grok-cli' as EngineId, '- fix the bug', seat.cfg, { cwd: '/tmp/wt', model: 'grok-4.7' });
    expect(cmd).toEqual({
      bin: seat.command[0],
      args: [
        seat.command[1],
        '--no-auto-update',
        '--output-format', 'streaming-messages-json',
        '--cwd', '/tmp/wt',
        '--model', 'grok-4.7',
        '--permission-mode', 'dontAsk',
        '--single=- fix the bug',
      ],
      cwd: '/tmp/wt',
    });
    expect(engineInstalled('grok-cli' as EngineId, seat.cfg)).toBe(true);
  });

  it.skipIf(!SUPPORTS_PROFILES)('end to end: the launcher execs the pinned binary with GROK_HOME = the seat state and a scrubbed env', () => {
    const seat = makeSeatFixture();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'u7-wt-')));
    fixtures.push(cwd);
    const cmd = buildEngineCommand('grok-cli' as EngineId, 'hello', seat.cfg, { cwd, model: 'grok-4.7' })!;
    // Run exactly what the fleet would spawn (no sandbox wrapper here).
    execFileSync(cmd.bin, cmd.args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, XAI_API_KEY: 'must-not-pass', GROK_HOME: '/ambient' } });
    const call = lastCall(seat);
    expect(call.args).toEqual(['--no-auto-update', '--output-format', 'streaming-messages-json', '--cwd', cwd,
      '--model', 'grok-4.7', '--permission-mode', 'dontAsk', '--single=hello']);
    expect(call.env['GROK_HOME']).toBe(seat.nativeStatePath);
    expect(call.env).not.toHaveProperty('XAI_API_KEY');
  });

  it('with no resolvable seat the spec has NO argv (no fallback to the ambient grok login)', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'u7-empty-')));
    fixtures.push(empty);
    const cfg = { foundry: { grokCli: { accountsRoot: empty } } } as unknown as AshlrConfig;
    const spec = resolveEngineSpec('grok-cli', cfg)!;
    expect(spec.argv).toBeUndefined();
    expect(spec.bins).toEqual([]);
    expect(buildEngineCommand('grok-cli' as EngineId, 'x', cfg, { cwd: '/w', model: 'grok-4.7' })).toBeNull();
    expect(engineInstalled('grok-cli' as EngineId, cfg)).toBe(false);
  });

  it.skipIf(!SUPPORTS_PROFILES)('config cannot redefine grok-cli (a frontier-judge identity)', () => {
    const seat = makeSeatFixture();
    const cfg = { foundry: { ...(seat.cfg.foundry as object), engines: {
      'grok-cli': { id: 'grok-cli', kind: 'cli-agent', tier: 'frontier', bin: '/bin/sh', argv: ['-c', '$GOAL'] },
    } } } as unknown as AshlrConfig;
    const spec = resolveEngineRegistry(cfg)['grok-cli']!;
    expect(spec.bin).toBe(seat.command[0]);
    expect(spec.argv?.[0]).toBe(seat.command[1]);
  });

  it('is metered, cloud, and refused under local-only', () => {
    expect(engineMeteredness('grok-cli', {} as AshlrConfig, {})).toBe('metered');
    const local = { foundry: { localOnly: true } } as unknown as AshlrConfig;
    expect(enginePermitted('grok-cli', local, {}).permitted).toBe(false);
  });

  it('maps fleet lanes to registry engines', () => {
    expect(registryEngineForFleetEngine('grok-cli')).toBe('grok-cli');
    expect(registryEngineForFleetEngine('claude-cli')).toBe('claude');
    expect(registryEngineForFleetEngine('local')).toBe('llama-server');
    expect(registryEngineForFleetEngine('local', 'local-coder')).toBe('local-coder');
  });
});

// ===========================================================================
// Seat resolution (native-profile.ts)
// ===========================================================================

describe.skipIf(!SUPPORTS_PROFILES)('resolveNativeSeatLaunch — fails closed', () => {
  it('resolves the single grok seat with its GROK_HOME', () => {
    const seat = makeSeatFixture();
    const result = resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' });
    expect(result).toEqual({ ok: true, launch: { seatId: 'grok', provider: 'grok', command: seat.command,
      nativeStatePath: seat.nativeStatePath, executable: join(seat.base, 'grok-inert') } });
  });

  it('refuses a missing or non-private roster', () => {
    const seat = makeSeatFixture();
    writeRoster(seat.accountsRoot, [{ id: 'grok', provider: 'grok', command: seat.command }], 0o644);
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' })).toMatchObject({ ok: false, reason: 'roster-unreadable' });
    rmSync(join(seat.accountsRoot, 'connections.json'));
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' })).toMatchObject({ ok: false, reason: 'roster-unreadable' });
  });

  it('refuses an ambiguous roster unless the seat is named', () => {
    const seat = makeSeatFixture();
    writeRoster(seat.accountsRoot, [
      { id: 'grok', provider: 'grok', command: seat.command },
      { id: 'grok-b', provider: 'grok', command: seat.command },
    ]);
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' })).toMatchObject({ ok: false, reason: 'ambiguous-seat' });
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok', seatId: 'grok-b' })).toMatchObject({ ok: true });
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok', seatId: 'nope' })).toMatchObject({ ok: false, reason: 'no-seat' });
  });

  it('refuses a command that is not a profile launcher, and a tampered profile', () => {
    const seat = makeSeatFixture();
    writeRoster(seat.accountsRoot, [{ id: 'grok', provider: 'grok', command: [seat.command[0], join(seat.base, 'other.mjs')] }]);
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' })).toMatchObject({ ok: false, reason: 'not-a-profile-launcher' });
    writeRoster(seat.accountsRoot, [{ id: 'grok', provider: 'grok', command: seat.command }]);
    const launcher = seat.command[1];
    writeFileSync(launcher, readFileSync(launcher, 'utf8') + '\n// tampered\n');
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' })).toMatchObject({ ok: false, reason: 'profile-invalid' });
    // A profile under the wrong provider is refused too.
    expect(resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'codex' })).toMatchObject({ ok: false, reason: 'no-seat' });
  });

  it('never leaks a private path in a failure', () => {
    const seat = makeSeatFixture();
    rmSync(join(seat.accountsRoot, 'connections.json'));
    const result = resolveNativeSeatLaunch({ accountsRoot: seat.accountsRoot, provider: 'grok' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(seat.base);
  });
});

// ===========================================================================
// xai family
// ===========================================================================

describe('xai family (SPEC-310B §3 Judge families)', () => {
  it('grok / xai / grok-cli are their own family, local stays local', () => {
    expect(agentSemanticModelFamily('grok-4.7')).toBe('xai');
    expect(agentSemanticModelFamily('xai/grok-4')).toBe('xai');
    expect(agentSemanticModelFamily('grok-cli')).toBe('xai');
    expect(agentSemanticModelFamily('qwen3.8:27b')).toBe('unknown');
    expect(agentSemanticModelFamily('ollama/qwen3')).toBe('local');
    expect(agentSemanticModelFamily('kimi-k2')).toBe('local');
    expect(reviewModelFamily('grok-cli:grok-4.7')).toBe('xai');
    expect(reviewModelFamily('grok:grok-4')).toBe('xai');
    expect(producerModelFamily('grok-cli:grok-4.7-build-fast')).toBe('xai');
    expect(producerModelFamily('llama-server:qwen3.8:27b-ctx64k')).toBe('local');
  });

  it('the semantic-event validator accepts an xai producer', () => {
    const events = defineAgentSemanticEvents({
      subjectRef: 'run:u7-run', producerRole: 'agent', producerModelFamily: 'xai', producerVersion: 'agent-semantic-v1',
    }, [{ kind: 'intent', predicate: 'agent.intent.execute', objectiveCode: 'work.execute' }]);
    expect(events[0]!.producerModelFamily).toBe('xai');
    const judged = managerSemanticEvents({ proposalId: 'prop-u7abcd-abcdef-0123456789abcdef01234567', verdict: 'ship', value: 4,
      correctness: 4, scope: 1, alignment: 4, wouldMerge: true }, 'grok-cli:grok-4.7');
    expect(judged[0]!.producerModelFamily).toBe('xai');
  });

  it('a Grok producer and a local judge are now independent families (and vice versa)', () => {
    expect(evaluateReviewerIndependence('grok-cli:grok-4.7', 'qwen3.8').independent).toBe(false); // qwen3.8 alone is unknown
    expect(evaluateReviewerIndependence('grok-cli:grok-4.7', 'local-coder:qwen3').independent).toBe(true);
    expect(evaluateReviewerIndependence('local-coder:qwen3', 'grok-cli:grok-4.7').independent).toBe(true);
  });
});

// ===========================================================================
// Grok judges only through grok-cli · same-family judge refused
// ===========================================================================

describe('Grok judges only through grok-cli', () => {
  it.each([
    ['grok-cli:grok-4.7', true],
    ['grok-cli:grok-4.7-build-fast', true],
    ['GROK-CLI:grok-4.6', true],
    ['grok-4.7', false],              // bare: could be the API, an Ollama tag, a relabelled run
    ['grok:grok-4', false],           // the per-token API engine
    ['xai:grok-4.7', false],
    ['grok-cli/grok-4.7', false],     // judge ids use ':' only
    ['grok-cli:', false],
    ['grok-cli:claude-opus-4-8', false],
    ['grok-cli:qwen3', false],
    ['local:grok-cli:grok-4.7', false],
    ['local-coder:claude-distill', false],
    ['local:claude-opus-4-8', false],
    ['claude-opus-4-8', true],        // legacy recorded forms keep working
    ['claude-fable-5', true],
    ['anthropic/claude-opus-4-8', true],
    ['claude-cli:claude-opus-4-8', true],
    ['gpt-5.5', true],
    ['codex:gpt-5.5', true],
    ['gpt-4', false],
    ['qwen2.5:72b-instruct-q4_K_M', false],
    ['local', false],
    ['unknown', false],
    [undefined, false],
  ] as const)('isFrontierJudgeId(%s) = %s', (id, expected) => {
    expect(isFrontierJudgeId(id)).toBe(expected);
  });

  it('G6: local work → grok-cli; Grok work → Claude; never same family, never local', () => {
    expect(evaluateJudgeEligibility('local-coder:qwen3', 'grok-cli:grok-4.7').eligible).toBe(true);
    expect(evaluateJudgeEligibility('grok-cli:grok-4.7', 'claude-opus-4-8').eligible).toBe(true);
    const same = evaluateJudgeEligibility('grok-cli:grok-4.7', 'grok-cli:grok-4.7-build-fast');
    expect(same).toMatchObject({ eligible: false, frontier: true });
    expect(same.reason).toContain('both xai family');
    expect(evaluateJudgeEligibility('claude:claude-sonnet-4-6', 'claude-opus-4-8').eligible).toBe(false);
    expect(evaluateJudgeEligibility('local-coder:qwen3', 'llama-server:qwen3.8').eligible).toBe(false);
    expect(evaluateJudgeEligibility('grok:grok-4', 'grok-4.7').eligible).toBe(false);
    expect(judgeLanePreference('local')).toEqual(['grok-cli', 'claude-cli', 'codex']);
    expect(judgeLanePreference('xai')).toEqual(['claude-cli', 'codex']);
    expect(judgeLanePreference('unknown')).toEqual([]);
  });

  it.skipIf(!SUPPORTS_PROFILES)('the resolver picks the grok-cli seat for local work', () => {
    const seat = makeSeatFixture();
    hoisted.engineInstalled = (engine) => engine === 'claude';
    const client = resolveFrontierJudgeClient(seat.cfg, { producerModel: 'local-coder:qwen3', requireIndependent: true });
    expect(client?.model).toBe('grok-cli:grok-4.7');
  });

  it.skipIf(!SUPPORTS_PROFILES)('the resolver never gives Grok work to a Grok judge', () => {
    const seat = makeSeatFixture();
    hoisted.engineInstalled = (engine) => engine === 'claude';
    const toClaude = resolveFrontierJudgeClient(seat.cfg, { producerModel: 'grok-cli:grok-4.7', requireIndependent: true });
    expect(reviewModelFamily(toClaude?.model)).toBe('claude');
    // Router admits only the Grok lane → nothing qualifies (no same-family fallback).
    expect(resolveFrontierJudgeClient(seat.cfg, { producerModel: 'grok-cli:grok-4.7', requireIndependent: true,
      allowedJudgeEngines: ['grok-cli'] })).toBeNull();
    // Explicitly configured grok-cli judge still refused for Grok work.
    const explicit = { foundry: { ...(seat.cfg.foundry as object), managerJudgeEngine: 'grok-cli' } } as unknown as AshlrConfig;
    hoisted.engineInstalled = () => false;
    expect(resolveFrontierJudgeClient(explicit, { producerModel: 'grok-cli:grok-4.7', requireIndependent: true })).toBeNull();
  });

  it('with no seat, the router-restricted Grok lane yields no judge (fail closed)', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'u7-empty-')));
    fixtures.push(empty);
    const cfg = { foundry: { grokCli: { accountsRoot: empty } } } as unknown as AshlrConfig;
    expect(resolveFrontierJudgeClient(cfg, { producerModel: 'local-coder:qwen3', requireIndependent: true,
      allowedJudgeEngines: ['grok-cli'] })).toBeNull();
  });

  it('a local judge is never recorded under a frontier identity', () => {
    const cfg = { foundry: { managerJudgeEngine: 'local', managerJudgeModel: 'grok-cli:grok-4.7' } } as unknown as AshlrConfig;
    const client = resolveFrontierJudgeClient(cfg);
    expect(client?.model).toBe('local:grok-cli:grok-4.7');
    expect(isFrontierJudgeId(client?.model)).toBe(false);
    const claudeNamed = resolveFrontierJudgeClient({ foundry: { managerJudgeEngine: 'local', managerJudgeModel: 'claude-opus-4-8' } } as unknown as AshlrConfig);
    expect(claudeNamed?.model).toBe('local:claude-opus-4-8');
    const plain = resolveFrontierJudgeClient({ foundry: { managerJudgeEngine: 'local' } } as unknown as AshlrConfig);
    expect(plain?.model).toBe('qwen3.8:27b-ctx64k');
  });

  it.skipIf(!SUPPORTS_PROFILES)('END TO END: a grok-cli judge runs text-only through the seat and returns a considered verdict', async () => {
    const seat = makeSeatFixture();
    writeFileSync(join(seat.nativeStatePath, 'response.ndjson'), [
      JSON.stringify({ type: 'message_start', message: { model: 'grok-4.7', usage: { input_tokens: 900 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'weighing it' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(SHIP) } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 40 } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(SHIP) }),
    ].join('\n') + '\n');
    const client = resolveFrontierJudgeClient(seat.cfg, { producerModel: 'local-coder:qwen3', requireIndependent: true })!;
    expect(client.model).toBe('grok-cli:grok-4.7');
    const verdict = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(verdict.considered).toBe(true);
    expect(verdict).toMatchObject({ verdict: 'ship', value: 4, correctness: 4 });
    expect(client.stats).toMatchObject({ model: 'grok-cli:grok-4.7', tokensIn: 900, tokensOut: 40 });
    expect(client.stats?.costUsd).toBeUndefined();
    const call = lastCall(seat);
    // Text-only flags, the seat's GROK_HOME, and an EMPTY private cwd that is gone afterwards.
    expect(call.args.slice(0, 13)).toEqual(['--no-auto-update', '--output-format', 'streaming-messages-json', '--cwd', call.cwd,
      '--model', 'grok-4.7', '--permission-mode', 'default', '--tools=', '--disable-web-search', '--no-subagents', '--no-memory']);
    expect(call.args).toHaveLength(14);
    expect(call.args[13]).toMatch(/^--single=You are a code-proposal judge/);
    expect(call.args).not.toContain('dontAsk');
    expect(call.env['GROK_HOME']).toBe(seat.nativeStatePath);
    expect(call.cwdEntries).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  });

  it.skipIf(!SUPPORTS_PROFILES)('a failed grok turn fails closed to review', async () => {
    const seat = makeSeatFixture();
    writeFileSync(join(seat.nativeStatePath, 'response.ndjson'),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }) + '\n');
    const client = resolveFrontierJudgeClient(seat.cfg, { producerModel: 'local-coder:qwen3', requireIndependent: true })!;
    const verdict = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(verdict).toMatchObject({ verdict: 'review', wouldMerge: false });
    expect(verdict.considered).toBeUndefined();
  });

  it('the headless argv is text-only by construction', () => {
    const argv = compileArgv([...GROK_CLI_HEADLESS_ARGV], { goal: 'p', cwd: '/c', model: GROK_CLI_DEFAULT_MODEL });
    expect(argv).toEqual(['--no-auto-update', '--output-format', 'streaming-messages-json', '--cwd', '/c', '--model', 'grok-4.7',
      '--permission-mode', 'default', '--tools=', '--disable-web-search', '--no-subagents', '--no-memory', '--single=p']);
  });
});

// ===========================================================================
// Claude judge runs restricted
// ===========================================================================

describe('Claude judge runs restricted (SPEC-310B §1)', () => {
  const RESTRICTED = ['--restricted', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--no-session-persistence'];

  it('restricts the registry claude command, and refuses to restrict an autonomous one', () => {
    expect([...CLAUDE_RESTRICTED_ARGS]).toEqual(RESTRICTED);
    const base = buildEngineCommand('claude', 'judge this', {} as AshlrConfig, { model: 'claude-opus-4-8', cwd: '/c' })!;
    expect(restrictClaudeCommand(base)).toEqual({ bin: 'claude', cwd: '/c',
      args: ['-p', 'judge this', '--model', 'claude-opus-4-8', '--output-format', 'json', ...RESTRICTED] });
    const autonomous = buildEngineCommand('claude', 'x', {} as AshlrConfig, { cwd: '/c', autonomous: true })!;
    expect(restrictClaudeCommand(autonomous)).toBeNull();
    expect(isRestrictedClaudeCommand(base)).toBe(false);
    expect(isRestrictedClaudeCommand({ bin: 'claude', args: ['-p', 'x', ...RESTRICTED, '--mcp-config', '/m.json'] })).toBe(false);
    expect(isRestrictedClaudeCommand({ bin: 'claude', args: ['-p', 'x', ...RESTRICTED.slice(0, 5)] })).toBe(false);
  });

  function claudeClient(): FrontierJudgeClient {
    hoisted.engineInstalled = (engine) => engine === 'claude';
    const client = resolveFrontierJudgeClient({ models: { ollama: 'http://127.0.0.1:9' }, foundry: { claude5: { fable: false } } } as unknown as AshlrConfig,
      { producerModel: 'grok-cli:grok-4.7', requireIndependent: true });
    expect(client?.model).toBe('claude-opus-4-8');
    return client!;
  }

  function captureSpawns(): Array<{ cmd: EngineCommand; opts: { env?: NodeJS.ProcessEnv } | undefined }> {
    const calls: Array<{ cmd: EngineCommand; opts: { env?: NodeJS.ProcessEnv } | undefined }> = [];
    hoisted.spawn = (cmd, _cfg, opts) => {
      calls.push({ cmd: cmd as EngineCommand, opts: opts as { env?: NodeJS.ProcessEnv } | undefined });
      return Promise.resolve({ ok: true, output: JSON.stringify({ result: JSON.stringify(SHIP), usage: { input_tokens: 5, output_tokens: 5 } }) });
    };
    return calls;
  }

  it('every Claude judge spawn carries the restricted sequence and no credential by default', async () => {
    const client = claudeClient();
    const calls = captureSpawns();
    const verdict = await judgeProposal(proposal({ engineModel: 'grok-cli:grok-4.7' }), {} as AshlrConfig, client, { recordTrace: false });
    expect(verdict.considered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(isRestrictedClaudeCommand(calls[0]!.cmd)).toBe(true);
    expect(calls[0]!.cmd.args.slice(-RESTRICTED.length)).toEqual(RESTRICTED);
    expect(calls[0]!.opts?.env).toBeUndefined();
  });

  it('a registered claude-a credential reaches ONLY the restricted spawn env', async () => {
    const client = claudeClient();
    const calls = captureSpawns();
    setJudgeCredentialSource(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }));
    await judgeProposal(proposal({ engineModel: 'grok-cli:grok-4.7' }), {} as AshlrConfig, client, { recordTrace: false });
    expect(calls[0]!.opts?.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fixture-token');
    expect(isRestrictedClaudeCommand(calls[0]!.cmd)).toBe(true);
  });

  it.each([
    ['a throwing source', async (): Promise<Record<string, string>> => { throw new Error('custody helper missing'); }],
    ['an unexpected key', async () => ({ ANTHROPIC_API_KEY: 'x' })],
    ['a multi-line value', async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'a\nb' })],
  ])('%s refuses the call — never falls back to the personal login', async (_label, source) => {
    const client = claudeClient();
    const calls = captureSpawns();
    setJudgeCredentialSource(source);
    const verdict = await judgeProposal(proposal({ id: `prop-u7-${_label.length}`, engineModel: 'grok-cli:grok-4.7' }),
      {} as AshlrConfig, client, { recordTrace: false });
    expect(calls).toHaveLength(0);
    expect(verdict).toMatchObject({ verdict: 'review', wouldMerge: false });
  });
});

// ===========================================================================
// Verdict cache
// ===========================================================================

describe('verdict cache — (proposalId, diffDigest, promptVersion)', () => {
  function countingClient(model: string, answer: () => string = () => JSON.stringify(SHIP)) {
    const complete = vi.fn(async () => answer());
    return { complete, model, stats: {} as Record<string, unknown> };
  }

  it('the same judge on the same prompt + diff is answered once', async () => {
    const client = countingClient('claude-opus-4-8');
    const first = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    const second = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ verdict: first.verdict, value: first.value, rationale: first.rationale });
    expect(second.considered).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(first.cacheHit).toBeUndefined();
    expect(Object.keys(second)).not.toContain('cacheHit'); // non-enumerable: CLI JSON unchanged
  });

  it('a different diff, judge, or opt-out is a miss', async () => {
    const client = countingClient('claude-opus-4-8');
    await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    await judgeProposal(proposal({ diff: proposal().diff + '+more\n' }), {} as AshlrConfig, client, { recordTrace: false });
    await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false, cache: false });
    expect(client.complete).toHaveBeenCalledTimes(3);
    const other = countingClient('gpt-5.5');
    await judgeProposal(proposal(), {} as AshlrConfig, other, { recordTrace: false });
    expect(other.complete).toHaveBeenCalledTimes(1);
  });

  it('a failed judgment is never cached', async () => {
    let good = false;
    const client = countingClient('claude-opus-4-8', () => (good ? JSON.stringify(SHIP) : 'I cannot judge this.'));
    const failed = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(failed.judgeFailure).toBe('parse');
    good = true;
    const ok = await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(ok.considered).toBe(true);
    expect(ok.cacheHit).toBeUndefined();
  });

  it('a hit reports the ORIGINAL answering model and spends nothing', async () => {
    const complete = vi.fn(async () => JSON.stringify(SHIP));
    const stats: Record<string, unknown> = {};
    const client = { model: 'claude-fable-5', stats, complete: async (s: string, u: string) => {
      const out = await complete(s, u); stats['model'] = 'claude-opus-4-8'; stats['costUsd'] = 0.02; return out; } };
    await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    stats['costUsd'] = 0.02;
    await judgeProposal(proposal(), {} as AshlrConfig, client, { recordTrace: false });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ model: 'claude-opus-4-8' });
  });

  it('the key is (proposalId, diffDigest, promptVersion, judge)', () => {
    const key = JSON.parse(judgeVerdictCacheKey(proposal(), 'grok-cli:grok-4.7', 'SYS', 'USER')) as string[];
    expect(key[0]).toBe('prop-u7-1');
    expect(key[1]).toBe(hashDiff(proposal().diff!));
    expect(key[2]!.startsWith(`${JUDGE_PROMPT_VERSION}:`)).toBe(true);
    expect(key[3]).toBe('grok-cli:grok-4.7');
    expect(judgeVerdictCacheKey(proposal(), 'grok-cli:grok-4.7', 'SYS', 'USER2')).not.toBe(judgeVerdictCacheKey(proposal(), 'grok-cli:grok-4.7', 'SYS', 'USER'));
  });
});

// ===========================================================================
// Grok stream text
// ===========================================================================

describe('extractGrokStreamText', () => {
  it('prefers the terminal result, never doubles envelope + deltas, ignores thinking and CLI chatter', () => {
    const lines = [
      'Checking for updates…',
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } } }),
      JSON.stringify({ type: 'assistant', message: { model: 'grok-4.7', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'AB' }] } }),
    ];
    expect(extractGrokStreamText(lines.join('\n'))).toMatchObject({ text: 'AB', error: null, model: 'grok-4.7' });
    expect(extractGrokStreamText(lines.slice(0, 3).join('\n')).text).toBe('AB');
    expect(extractGrokStreamText([...lines, JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL' })].join('\n')).text).toBe('FINAL');
  });

  it('reports a failed turn with no text', () => {
    const out = extractGrokStreamText([
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
    ].join('\n'));
    expect(out).toMatchObject({ text: '', error: 'error_during_execution' });
  });
});

// ===========================================================================
// Catalog + best-of-N
// ===========================================================================

describe('model catalog — grok-cli is seat-routed', () => {
  it('never wins a capability sort by accident; reachable by naming the engine', () => {
    expect(pickModel({})?.engine).not.toBe('grok-cli');
    expect(pickModel({ capability: 'coder', preferCheap: true })?.engine).not.toBe('grok-cli');
    expect(pickModel({ capability: 'reasoning', preferStrong: true, excludeIds: new Set() })?.engine).not.toBe('grok-cli');
    expect(pickModel({ engine: 'grok-cli' })?.id).toBe('grok-cli:grok-4.7');
    expect(pickModel({ engine: 'grok-cli', maxEffort: 1 })?.id).toBe('grok-cli:grok-4.7-build-fast');
    expect(canonicalModelTag('grok-cli', 'grok-cli:grok-4.7')).toBe('grok-4.7');
  });
});

describe('planAutonomousBestOfN — Grok + 2 local, engine diversity required', () => {
  const local = { engine: 'llama-server' as const, model: 'qwen3.8:27b-ctx64k' };
  const base = { difficulty: 'high' as const, priorFailures: 0, mode: 'balanced' as const, grokEligible: true, local, claudeEligible: true };

  it('runs only for hard or already-failed work', () => {
    expect(planAutonomousBestOfN({ ...base, difficulty: 'medium' })).toMatchObject({ run: false, reason: 'not-needed' });
    expect(planAutonomousBestOfN({ ...base, difficulty: 'low', priorFailures: 1 }).run).toBe(true);
  });

  it('balanced: grok-cli + two local; Claude stays reserved', () => {
    expect(planAutonomousBestOfN(base)).toEqual({ run: true, reason: 'planned', candidates: [
      { engine: 'grok-cli' }, { engine: 'llama-server', model: 'qwen3.8:27b-ctx64k' }, { engine: 'llama-server', model: 'qwen3.8:27b-ctx64k' },
    ] });
  });

  it('declines without a frontier candidate instead of sampling one local model twice', () => {
    expect(planAutonomousBestOfN({ ...base, grokEligible: false })).toMatchObject({ run: false, reason: 'no-engine-diversity' });
    expect(planAutonomousBestOfN({ ...base, local: null })).toMatchObject({ run: false, reason: 'no-local-lane' });
  });

  it('all-in: Claude substitutes for an ineligible Grok, or joins as an extra candidate', () => {
    expect(planAutonomousBestOfN({ ...base, mode: 'all-in', grokEligible: false, claudeModel: 'claude-sonnet-5' }).candidates.map((c) => c.engine))
      .toEqual(['claude', 'llama-server', 'llama-server']);
    expect(planAutonomousBestOfN({ ...base, mode: 'all-in' }).candidates.map((c) => c.engine))
      .toEqual(['grok-cli', 'claude', 'llama-server', 'llama-server']);
  });
});
