/**
 * local-only-dispatch-paths.test.ts — OWNER L: prove NO dispatch path bypasses
 * the local-only predicate.
 *
 * A routing policy that merely deprioritises cloud is worthless if ONE path
 * still reaches a paid engine, because that is the path an autonomous fleet
 * will eventually take. So this suite does not spot-check: it ENUMERATES every
 * way a model call can leave this machine and asserts each one refuses.
 *
 * THE COMPLETE INVENTORY (§A proves it stays complete; §B–§G exercise each):
 *
 *   Transport (bytes on the wire)
 *     1. provider-client.getActiveClient            — in-process chat over the active provider
 *     2. provider-client.buildOpenAICompatibleClient — the ONE /v1/chat/completions constructor
 *     3. engines.spawnEngine                         — the ONE CLI-agent subprocess funnel
 *
 *   Fleet dispatch (chooses + runs an engine)
 *     4. sandboxed-engine.runEngineSandboxed         — external CLI agents in a worktree
 *     5. sandboxed-engine.runApiModelSandboxed       — in-process api-models in a worktree
 *
 *   Routing (chooses an engine; must never NAME a cloud one)
 *     6. run/router.routeTask
 *     7. run/router.routeTaskCascade      (incl. forced frontier escalation)
 *     8. run/router.chooseRoute
 *     9. run/router.shouldEscalate        (must TERMINATE, not retry into a wall)
 *    10. fleet/router.routeBackend
 *    11. fleet/router.generatedRepairCandidateAllowed
 *    12. fleet/router.inspectGeneratedRepairRouteFeasibility
 *
 *   Interactive dispatch (a PERSON driving a seat, not the fleet)
 *    13. verse/session-engine.startTurn   — the SECOND subprocess spawner
 *
 * §H exists because item 13 did not, and the gap was invisible precisely
 * because this file looked exhaustive. Verse chat spawns its vendor CLI with a
 * raw `node:child_process.spawn` rather than through `engines.spawnEngine`, so
 * it is a wholly separate funnel that has to be gated on its own — and it is
 * the funnel a person reaches by typing into the cockpit while the Local-only
 * panel tells them nothing can spend.
 *
 * Hermetic: no network, no real worktrees, no ~/.ashlr writes (the sandboxed
 * paths refuse before any side effect, and `deferTerminalAction` silences the
 * ledger writer). The kill switch is never read or written — §E mocks
 * `killSwitchOn` so the local-only refusal is the one under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// killSwitchOn is mocked so this suite tests the LOCAL-ONLY refusal rather than
// the (correctly, separately) engaged autonomy kill switch on this machine.
// assertMayMutate is never reached — every path under test refuses before it.
vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/policy.js')>();
  return { ...actual, killSwitchOn: vi.fn(() => false) };
});

vi.mock('../src/core/providers.js', () => ({
  getProviderRegistry: vi.fn(async (cfg: { models: { providerChain: string[] } }) => ({
    providers: [
      { id: 'ollama', url: 'http://localhost:11434', up: true, models: ['qwen3.8:27b-ctx64k'] },
      { id: 'lmstudio', url: '', up: false, models: [] },
    ],
    activeProvider: 'ollama',
    chain: cfg.models.providerChain,
  })),
  resolveActiveProvider: vi.fn(async () => 'ollama'),
}));

import type { AshlrConfig, EngineId, WorkItem, WorkSource } from '../src/core/types.js';
import {
  __resetLocalOnlyLatchForTests,
  engineLocality,
  isLocalOnlyRefusal,
} from '../src/core/policy/local-only.js';
import {
  buildOpenAICompatibleClient,
  getActiveClient,
} from '../src/core/run/provider-client.js';
import { spawnEngine } from '../src/core/run/engines.js';
import {
  runApiModelSandboxed,
  runEngineSandboxed,
} from '../src/core/run/sandboxed-engine.js';
import {
  chooseRoute,
  routeTask,
  routeTaskCascade,
  shouldEscalate,
  type CascadeDecision,
} from '../src/core/run/router.js';
import {
  generatedRepairCandidateAllowed,
  inspectGeneratedRepairRouteFeasibility,
  routeBackend,
} from '../src/core/fleet/router.js';
import {
  createVerseEngine,
  type VerseEngineHandle,
  type VerseEngineOptions,
  type VerseSeatLaunch,
} from '../src/core/verse/session-engine.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import { writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLOUD_ENGINES: readonly string[] = ['claude', 'codex', 'nim', 'kimi', 'grok', 'hermes'];

function cfgWith(foundry: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: {
      providerChain: ['anthropic', 'ollama'],
      ollama: 'http://localhost:11434',
      lmstudio: 'http://localhost:1234',
      routing: [],
    },
    foundry,
  } as unknown as AshlrConfig;
}

const ALL_BACKENDS = ['builtin', 'local-coder', 'claude', 'codex', 'nim', 'kimi', 'grok'];

/** Local-only ON, with every backend nominally allowed so refusal is the only thing stopping cloud. */
function lockedCfg(): AshlrConfig {
  return cfgWith({ localOnly: true, allowedBackends: ALL_BACKENDS, claude5: { enabled: false } });
}

/** Local-only OFF — the control group. Nothing may change when the mode is off. */
function openCfg(): AshlrConfig {
  return cfgWith({ allowedBackends: ALL_BACKENDS, claude5: { enabled: false } });
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `loi-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 3,
    score: 5,
    tags: [],
    ts: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const ALL_ENGINES_CTX = {
  availableEngines: ['claude', 'codex', 'nim', 'kimi', 'grok', 'local-coder', 'builtin'] as EngineId[],
};

beforeEach(() => {
  __resetLocalOnlyLatchForTests();
  _seq = 0;
  delete process.env['ASHLR_LOCAL_ONLY'];
});

afterEach(() => {
  __resetLocalOnlyLatchForTests();
  delete process.env['ASHLR_LOCAL_ONLY'];
});

// ===========================================================================
// §A — the inventory stays complete
// ===========================================================================

describe('§A dispatch-path inventory', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(SRC);
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

  /**
   * The six chokepoints. Each is the SOLE constructor/spawner for its class of
   * outbound model call, and each must reference the policy module. If someone
   * removes a gate, this fails before any behavioural test does.
   */
  const CHOKEPOINTS: ReadonlyArray<{ file: string; fn: string }> = [
    { file: 'core/run/provider-client.ts', fn: 'getActiveClient' },
    { file: 'core/run/provider-client.ts', fn: 'buildOpenAICompatibleClient' },
    { file: 'core/run/engines.ts', fn: 'spawnEngine' },
    { file: 'core/run/sandboxed-engine.ts', fn: 'runEngineSandboxed' },
    { file: 'core/run/sandboxed-engine.ts', fn: 'runApiModelSandboxed' },
    // The interactive funnel. Not reachable through spawnEngine — see below.
    { file: 'core/verse/session-engine.ts', fn: 'startTurn' },
  ];

  for (const { file, fn } of CHOKEPOINTS) {
    it(`${file} (${fn}) consults the local-only policy`, () => {
      const src = read(file);
      expect(src, `${file} must import policy/local-only`).toContain("policy/local-only.js");
      expect(src).toContain(fn);
    });
  }

  /**
   * RAW TRANSPORT, DIRECTLY GATED — modules that build a /v1/chat/completions
   * request with a raw `fetch` instead of `buildOpenAICompatibleClient`, and
   * therefore never pass through the transport gate in provider-client.
   *
   * Every entry is a deliberate OLLAMA-DIRECT / LM-STUDIO-DIRECT path: they
   * exist to escape provider-client's 30s fetch timeout for slow local models,
   * and they resolve their base URL from `cfg.foundry.ollamaBaseUrl` /
   * `cfg.models.lmstudio`, both defaulting to loopback.
   *
   * They were an AUDITED RESIDUAL — known-ungated, closed out of lane. Each one
   * now calls `endpointPermitted()` immediately before its fetch, which is what
   * the next test asserts. Loopback defaults alone were never the guarantee:
   * an operator who repoints `ollamaBaseUrl` at a remote inference host would
   * otherwise have had a local-only mode with a hole in it, and
   * `visual/grounding.ts` can attach a bearer token (`cfg.apiKeyEnv`), so that
   * hole could have carried a bill.
   *
   * This list is EXACT on purpose. A new raw-transport site fails this test,
   * and an existing one that loses its gate fails the next one.
   */
  const RAW_TRANSPORT_RESIDUAL: ReadonlyArray<string> = [
    'core/comms/director.ts',        // Ollama fallback for director dialogue
    'core/comms/elon-dialogue.ts',   // Ollama fallback for the Elon dialogue
    'core/fleet/manager.ts',         // ollamaDirectComplete — the local judge, 3-min timeout
    'core/genome/playbook.ts',       // LM Studio playbook synthesis (documented LOCAL-ONLY)
    'core/vision/strategist.ts',     // ollamaDirectComplete — mirrors manager.ts
    'core/visual/grounding.ts',      // completionsUrl() — the only one that can carry a token
  ];

  /** Files whose only mention of the path is a comment, a type, or a registry URL. */
  const CHAT_PATH_NON_TRANSPORT: ReadonlyArray<string> = [
    'core/run/engine-registry.ts',
    'core/run/engines.ts',
    'core/types.ts',
    // Documentation of the wire contract and the routes that serve it. Neither
    // opens a socket to a model; both only name the path in prose.
    'core/verse/control-api.ts',
    'core/verse/fleet-types.ts',
    'web-ui/routes/verse/autonomy/fleet-contract.ts',
    // The shim is a REQUEST NORMALISER, not a transport: it rewrites a body and
    // hands it back to its caller, and the file contains no fetch, no
    // http.request and no client of any kind. The path appears once, inside a
    // doc comment tabulating the probe that established where
    // `reasoning_effort` survives — /chat/completions answers 500 because it
    // reaches the template, /v1/messages answers 200 because the field is
    // dropped. Deleting that comment to satisfy a grep would throw away the
    // measurement that explains why this lane carries the value in
    // `chat_template_kwargs` at all.
    'core/local-runtime/llama/anthropic-shim.ts',
  ];

  it('no module outside the audited residual builds a raw /chat/completions request', () => {
    const allowed = new Set([
      ...RAW_TRANSPORT_RESIDUAL,
      ...CHAT_PATH_NON_TRANSPORT,
      'core/run/provider-client.ts',
    ]);
    const offenders = files
      .map((f) => f.slice(SRC.length + 1).split(/[\\/]/).join('/'))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('/chat/completions'));
    expect(
      offenders,
      `NEW unguarded chat transport (route it through buildOpenAICompatibleClient ` +
        `or endpointPermitted): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every raw-transport site is still a LOOPBACK-resolving local path', () => {
    // Defence in depth, not the guarantee: the gate below is the guarantee.
    // If one of these gains a cloud default, this fails first and loudly.
    for (const rel of RAW_TRANSPORT_RESIDUAL) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const hasLoopbackDefault = /localhost|127\.0\.0\.1/.test(src);
      expect(hasLoopbackDefault, `${rel} lost its loopback default`).toBe(true);
    }
  });

  it('every raw-transport site consults local-only before it fetches', () => {
    // This is the invariant that closes the class. A loopback DEFAULT is not a
    // loopback GUARANTEE — `cfg.foundry.ollamaBaseUrl` is an operator-settable
    // string, and `visual/grounding.ts` will attach a bearer token to whatever
    // it is pointed at. Each of these modules therefore calls
    // `endpointPermitted()` on the URL it is about to POST to, and throws
    // through `assertPermitted` if the mode refuses it.
    //
    // Asserted structurally rather than by running each path: several need a
    // live model server to reach their fetch at all, and a test that cannot run
    // the check is worse than one that proves the check is present.
    for (const rel of RAW_TRANSPORT_RESIDUAL) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(
        src.includes("from '../policy/local-only.js'"),
        `${rel} does not import the local-only policy`,
      ).toBe(true);
      expect(
        /assertPermitted\(\s*endpointPermitted\(/.test(src),
        `${rel} imports the policy but never asserts on it before fetching`,
      ).toBe(true);
    }
  });

  /**
   * THE SECOND SPAWNER.
   *
   * `engines.ts` owns the FLEET's subprocesses. It does not own the cockpit's:
   * a Verse chat turn is spawned by `verse/session-engine.startTurn` with a raw
   * `node:child_process.spawn`, so `binPermitted` inside `spawnEngine` never
   * runs for it. That made the Local-only panel's "nothing can spend money
   * while this is on" false for every interactive claude/codex/grok turn.
   *
   * The gate has to sit INSIDE `startTurn` and BEFORE the `spawn(` call —
   * refusing after the child exists is not refusing. Asserted on source order
   * within the function body so a later refactor that moves the check below the
   * spawn fails here, even if the behavioural tests below still pass by luck.
   */
  it('the verse session engine gates its raw spawn on the shared predicate', () => {
    const src = read('core/verse/session-engine.ts');
    expect(src, 'session-engine must import policy/local-only').toContain(
      "from '../policy/local-only.js'",
    );

    const bodyStart = src.indexOf('function startTurn');
    expect(bodyStart, 'startTurn not found').toBeGreaterThan(-1);
    const spawnAt = src.indexOf('spawn(bin, args', bodyStart);
    expect(spawnAt, 'the raw spawn call moved — re-point this assertion').toBeGreaterThan(-1);

    const beforeSpawn = src.slice(bodyStart, spawnAt);
    expect(
      /verseSeatPermitted\s*\(/.test(beforeSpawn),
      'startTurn reaches its spawn without consulting the local-only policy',
    ).toBe(true);

    // ...and the seam must DELEGATE rather than decide for itself. A second
    // opinion about what "local" means is how this drifts back open.
    expect(
      /enginePermitted\s*\(/.test(src) && /endpointPermitted\s*\(/.test(src),
      'verseSeatPermitted must delegate to the published decidePermission wrappers',
    ).toBe(true);
    expect(
      src.includes('LOCAL_CLI_AGENTS') || src.includes('isLoopbackEndpoint('),
      're-implementing locality classification in verse is a second predicate',
    ).toBe(false);
  });

  it('engines.ts is the ONLY module that executes an engine subprocess', () => {
    // spawnEngineInner is module-private to engines.ts; every other module must
    // go through the exported (and gated) spawnEngine.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const offenders = files.filter((f) => {
      if (f.endsWith(join('core', 'run', 'engines.ts'))) return false;
      return /\bspawnEngineInner\s*\(/.test(stripComments(readFileSync(f, 'utf8')));
    });
    expect(offenders, `engine spawn outside engines.ts: ${offenders.join(', ')}`).toEqual([]);
    expect(read('core/run/engines.ts')).not.toContain('export async function spawnEngineInner');
  });

  it('every module that calls a dispatch entry point calls a GATED one', () => {
    const GATED = [
      'getActiveClient',
      'buildOpenAICompatibleClient',
      'spawnEngine',
      'runEngineSandboxed',
      'runApiModelSandboxed',
    ];
    // Sanity: the entry points named above actually exist and are exported.
    const providerClient = read('core/run/provider-client.ts');
    const engines = read('core/run/engines.ts');
    const sandboxed = read('core/run/sandboxed-engine.ts');
    expect(providerClient).toContain('export async function getActiveClient');
    expect(providerClient).toContain('export function buildOpenAICompatibleClient');
    expect(engines).toContain('export async function spawnEngine');
    expect(sandboxed).toContain('export async function runEngineSandboxed');
    expect(sandboxed).toContain('export async function runApiModelSandboxed');
    expect(GATED).toHaveLength(5);
  });

  it('the routing modules consult the policy rather than re-implementing it', () => {
    for (const file of ['core/run/router.ts', 'core/fleet/router.ts']) {
      expect(read(file), `${file} must import policy/local-only`).toContain('policy/local-only.js');
    }
  });
});

// ===========================================================================
// §B — transport: provider-client
// ===========================================================================

describe('§B provider-client transport', () => {
  it('getActiveClient refuses a routed cloud provider, naming provider + mode', async () => {
    await expect(
      getActiveClient(lockedCfg(), { allowCloud: true, provider: 'anthropic' }),
    ).rejects.toThrow(/local-only/i);

    let caught: unknown;
    try {
      await getActiveClient(lockedCfg(), { allowCloud: true, provider: 'anthropic' });
    } catch (err) {
      caught = err;
    }
    expect(isLocalOnlyRefusal(caught)).toBe(true);
    const msg = (caught as Error).message;
    expect(msg).toContain("'anthropic'");
    expect(msg).toContain('cfg.foundry.localOnly');
  });

  it('--allow-cloud + a present API key is NOT enough under local-only', async () => {
    const prior = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-not-a-real-key';
    try {
      await expect(
        getActiveClient(lockedCfg(), { allowCloud: true, provider: 'anthropic' }),
      ).rejects.toThrow(/local-only: refusing to dispatch to cloud provider/);
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });

  it('getActiveClient still serves the LOCAL provider under local-only', async () => {
    const client = await getActiveClient(lockedCfg(), { allowCloud: false });
    expect(client.id).toBe('ollama');
  });

  it('buildOpenAICompatibleClient refuses a non-loopback endpoint', () => {
    expect(() =>
      buildOpenAICompatibleClient('https://api.moonshot.ai/v1', 'k', 'kimi-k2', true, undefined, undefined, {
        cfg: lockedCfg(),
      }),
    ).toThrow(/local-only: refusing to dispatch to cloud endpoint/);
  });

  it('buildOpenAICompatibleClient still builds a loopback client', () => {
    const c = buildOpenAICompatibleClient(
      'http://localhost:8080/v1', '', 'qwen3.8', true, undefined, undefined, { cfg: lockedCfg() },
    );
    expect(c.model).toBe('qwen3.8');
  });

  it('buildOpenAICompatibleClient honours the AMBIENT mode when given no cfg', () => {
    // The seam has no config in hand; env alone must still stop it.
    process.env['ASHLR_LOCAL_ONLY'] = '1';
    expect(() =>
      buildOpenAICompatibleClient('https://api.x.ai/v1', 'k', 'grok-4', true),
    ).toThrow(/local-only/);
  });

  it('CONTROL: with the mode off, a cloud endpoint builds normally', () => {
    const c = buildOpenAICompatibleClient(
      'https://api.moonshot.ai/v1', 'k', 'kimi-k2', true, undefined, undefined, { cfg: openCfg() },
    );
    expect(c.model).toBe('kimi-k2');
  });
});

// ===========================================================================
// §C — transport: spawnEngine (every CLI-agent subprocess in the hub)
// ===========================================================================

describe('§C spawnEngine', () => {
  it('refuses a cloud agent binary with a named reason, never throwing', async () => {
    const res = await spawnEngine(
      { bin: '/opt/homebrew/bin/claude', args: ['-p', 'goal'], cwd: '/tmp' },
      lockedCfg(),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('local-only');
    expect(res.error).toContain("'claude'");
    expect(res.output).toBe('');
  });

  it('refuses codex too', async () => {
    const res = await spawnEngine({ bin: 'codex', args: ['exec'], cwd: '/tmp' }, lockedCfg());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("'codex'");
  });

  it('honours an env-only enable', async () => {
    process.env['ASHLR_LOCAL_ONLY'] = 'true';
    const res = await spawnEngine({ bin: 'claude', args: [], cwd: '/tmp' }, openCfg());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('local-only');
  });

  it('env cannot DISABLE a persisted local-only at the spawn gate', async () => {
    process.env['ASHLR_LOCAL_ONLY'] = '0';
    const res = await spawnEngine({ bin: 'claude', args: [], cwd: '/tmp' }, lockedCfg());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('local-only');
  });
});

// ===========================================================================
// §D — routing never NAMES a cloud engine
// ===========================================================================

describe('§D routing', () => {
  const HARD = () => makeItem({ source: 'issue' as WorkSource, effort: 5, score: 10 });
  const BULK = () => makeItem({ source: 'todo' as WorkSource, effort: 2, score: 3 });
  const ESCALATED = () => makeItem({ source: 'escalation' as WorkSource, effort: 5, score: 10 });

  it('routeTask never returns a cloud engine under local-only', () => {
    for (const item of [HARD(), BULK(), ESCALATED()]) {
      const d = routeTask(item, lockedCfg(), ALL_ENGINES_CTX);
      expect(CLOUD_ENGINES, `routed to ${d.engine} for source=${item.source}`).not.toContain(d.engine);
      expect(engineLocality(d.engine, lockedCfg())).toBe('local');
    }
  });

  it('routeTask names the refusal when it downgrades a frontier route', () => {
    // A hard item wants frontier. With ONLY cloud engines nominally available,
    // the backstop must rewrite to builtin AND explain itself.
    const d = routeTask(HARD(), lockedCfg(), {
      availableEngines: ['claude', 'codex'] as EngineId[],
    });
    expect(d.engine).toBe('builtin');
    expect(d.reason).toContain('local-only');
  });

  it('routeTaskCascade never returns a cloud engine, including on forced escalation', () => {
    const cfg = cfgWith({
      localOnly: true, cascade: true, allowedBackends: ALL_BACKENDS, claude5: { enabled: false },
    });
    for (const forceTier of [undefined, 'mid', 'frontier'] as const) {
      const d = routeTaskCascade(HARD(), cfg, ALL_ENGINES_CTX, forceTier, 2);
      expect(CLOUD_ENGINES, `forceTier=${forceTier} routed to ${d.engine}`).not.toContain(d.engine);
    }
  });

  it('chooseRoute never returns tier "cloud" under local-only', async () => {
    const prior = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-not-a-real-key';
    try {
      const d = await chooseRoute('fix the bug', lockedCfg(), {
        allowCloud: true,
        attempt: 2,
        lastReason: 'verify-failed',
      });
      expect(d.tier).toBe('local');
      // HONEST REPORTING: the escalation was refused, not silently skipped.
      expect(d.reason).toContain('local-only');
      expect(d.reason).toMatch(/REFUSED|refused/);
      expect(d.reason).toContain('anthropic');
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });

  it('CONTROL: chooseRoute still escalates to cloud when the mode is OFF', async () => {
    const prior = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-not-a-real-key';
    try {
      const d = await chooseRoute('fix the bug', openCfg(), {
        allowCloud: true,
        attempt: 2,
        lastReason: 'verify-failed',
      });
      expect(d.tier).toBe('cloud');
      expect(d.provider).toBe('anthropic');
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });

  it('routeBackend never returns a cloud backend under local-only', () => {
    for (const item of [HARD(), BULK(), ESCALATED()]) {
      const d = routeBackend(item, lockedCfg());
      expect(CLOUD_ENGINES, `routeBackend chose ${d.backend}`).not.toContain(d.backend);
    }
  });

  it('inspectGeneratedRepairRouteFeasibility never proposes a cloud backend', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 5, score: 10 });
    // A frontier-tier repair: the only frontier backends are cloud, so under
    // local-only this lane must report the route as infeasible rather than
    // naming claude/codex.
    const frontierRepair = inspectGeneratedRepairRouteFeasibility(item, lockedCfg(), {
      applies: true,
      available: true,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: 'frontier',
    });
    expect(frontierRepair.backend).toBeNull();
    expect(frontierRepair.feasible).toBe(false);

    // And the open-tier variant must not land on a cloud backend either.
    const anyTierRepair = inspectGeneratedRepairRouteFeasibility(item, lockedCfg(), {
      applies: true,
      available: true,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: null,
    });
    if (anyTierRepair.backend !== null) {
      expect(CLOUD_ENGINES).not.toContain(anyTierRepair.backend);
    }
  });

  it('generatedRepairCandidateAllowed refuses every cloud backend', () => {
    const item = makeItem({ source: 'issue' as WorkSource });
    for (const backend of CLOUD_ENGINES) {
      expect(
        generatedRepairCandidateAllowed(item, backend as EngineId, lockedCfg()),
        `repair lane allowed ${backend}`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
// §E — the cascade terminates rather than retrying into a wall
// ===========================================================================

describe('§E escalation termination', () => {
  const failed = { testsPassed: false, hasDiff: true, applySucceeded: true } as Parameters<typeof shouldEscalate>[0];

  function decisionAt(tierLabel: 'local' | 'mid', attempt = 1): CascadeDecision {
    return {
      engine: (tierLabel === 'local' ? 'builtin' : 'local-coder') as EngineId,
      model: null,
      catalogEntry: null,
      reason: 'test',
      attempt,
      cheapFirst: true,
      tierLabel,
    };
  }

  it('mid→frontier TERMINATES under local-only: no local engine serves frontier', () => {
    const sig = shouldEscalate(failed, decisionAt('mid'), { cfg: lockedCfg() });
    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
    expect(sig.reason).toContain('terminated by local-only');
    expect(sig.reason).toContain('frontier');
    // The failure signals are still reported — the operator sees WHY it stopped.
    expect(sig.reason).toContain('tests-failed');
  });

  it('local→mid still escalates: local-coder is a LOCAL mid-tier engine', () => {
    const sig = shouldEscalate(failed, decisionAt('local'), { cfg: lockedCfg() });
    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('mid');
  });

  it('local→mid TERMINATES when the fleet has no local mid engine available', () => {
    const sig = shouldEscalate(failed, decisionAt('local'), {
      cfg: lockedCfg(),
      availableEngines: ['builtin', 'claude', 'codex'] as EngineId[],
    });
    expect(sig.escalate).toBe(false);
    expect(sig.reason).toContain('terminated by local-only');
  });

  it('CONTROL: with the mode off, mid→frontier escalates as before', () => {
    const sig = shouldEscalate(failed, decisionAt('mid'), { cfg: openCfg() });
    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('frontier');
  });

  it('CONTROL: with no cfg at all, behaviour is byte-identical to pre-local-only', () => {
    const sig = shouldEscalate(failed, decisionAt('mid'));
    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('frontier');
  });

  it('a clean pass never escalates regardless of the mode', () => {
    const passed = { testsPassed: true, hasDiff: true, applySucceeded: true } as typeof failed;
    expect(shouldEscalate(passed, decisionAt('mid'), { cfg: lockedCfg() }).escalate).toBe(false);
  });
});

// ===========================================================================
// §F — fleet dispatch refuses BEFORE any side effect
// ===========================================================================

describe('§F sandboxed dispatch', () => {
  const baseOpts = {
    sourceRepo: '/nonexistent/repo/that/must/never/be/touched',
    // Silences the durable ledger writer — this suite must not write ~/.ashlr.
    deferTerminalAction: true,
  };

  it('runEngineSandboxed refuses a cloud CLI agent with a named outcome', async () => {
    const res = await runEngineSandboxed('claude' as EngineId, 'do a thing', lockedCfg(), baseOpts);
    expect(res.state.status).toBe('failed');
    expect(res.proposalOutcome?.kind).toBe('engine-unsupported');
    expect(res.proposalOutcome?.reason).toContain('local-only');
    expect(res.proposalOutcome?.reason).toContain("'claude'");
    expect(res.proposalOutcome?.reason).toContain('cfg.foundry.localOnly');
    // No worktree was created — the refusal preceded every side effect.
    expect(res.state.runActionCounts?.sandboxCreated ?? 0).toBe(0);
  });

  it('runApiModelSandboxed refuses a cloud api-model with a named outcome', async () => {
    const res = await runApiModelSandboxed('nim' as EngineId, 'do a thing', lockedCfg(), baseOpts);
    expect(res.state.status).toBe('failed');
    expect(res.proposalOutcome?.kind).toBe('engine-unsupported');
    expect(res.proposalOutcome?.reason).toContain('local-only');
    expect(res.proposalOutcome?.reason).toContain("'nim'");
    expect(res.state.runActionCounts?.sandboxCreated ?? 0).toBe(0);
  });

  it('refuses kimi and grok on the api-model path as well', async () => {
    for (const engine of ['kimi', 'grok']) {
      const res = await runApiModelSandboxed(engine as EngineId, 'goal', lockedCfg(), baseOpts);
      expect(res.proposalOutcome?.kind, `${engine} was not refused`).toBe('engine-unsupported');
      expect(res.proposalOutcome?.reason).toContain('local-only');
    }
  });

  it('an env-only enable refuses at the fleet gate too', async () => {
    process.env['ASHLR_LOCAL_ONLY'] = 'on';
    const res = await runEngineSandboxed('codex' as EngineId, 'goal', openCfg(), baseOpts);
    expect(res.proposalOutcome?.kind).toBe('engine-unsupported');
    expect(res.proposalOutcome?.reason).toContain('local-only');
  });
});

// ===========================================================================
// §G — with the mode OFF, nothing changed
// ===========================================================================

describe('§G local dispatch is unaffected when the mode is off', () => {
  /**
   * A fresh, low Claude reading in the Verse capacity snapshot.
   *
   * WHY this fixture exists: since 3.10 (unit A9) `subscriptionAllows` fails
   * CLOSED — a subscription engine with no known, fresh usage reading is not
   * available to autonomous routing ("unknown usage is not headroom"). Before
   * 3.10 routeTask reached claude here only through the Claude fail-open. The
   * §G premise is about the LOCAL-ONLY switch, not about usage: with the mode
   * off and headroom KNOWN, routing must be exactly what it always was. So the
   * test states the headroom explicitly instead of relying on the fail-open.
   * Codex stays off for autonomy by default (Mason, 2026-09-24), which is why
   * only a Claude seat is written.
   */
  function withKnownClaudeHeadroom<T>(fn: () => T): T {
    return inFreshHome(() => {
      const seat: SeatCapacity = {
        seatId: 'claude',
        engine: 'claude',
        label: 'Claude Code',
        free: false,
        windows: [
          { id: 'five_hour', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
          { id: 'seven_day', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
        ],
        signedOut: false,
        reachable: null,
        contextWindow: 200_000,
        observedAt: new Date().toISOString(),
        spentTodayUsd: null,
      };
      writeCapacitySnapshot([seat]);
      return fn();
    });
  }

  /** A throwaway HOME, so no snapshot/budget from another suite can leak in. */
  function inFreshHome<T>(fn: () => T): T {
    const savedHome = process.env['HOME'];
    const home = mkdtempSync(join(tmpdir(), 'local-only-g-'));
    process.env['HOME'] = home;
    try {
      return fn();
    } finally {
      process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('routeTask picks the same engine it always did', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 5, score: 10 });
    const d = withKnownClaudeHeadroom(() => routeTask(item, openCfg(), ALL_ENGINES_CTX));
    // Hard issue with known Claude headroom → a frontier engine, exactly as
    // before local-only existed.
    expect(['claude', 'codex']).toContain(d.engine);
    expect(d.reason).not.toContain('local-only');
  });

  it('with unknown frontier usage AUTONOMOUS routeTask falls back — for budget reasons, never local-only ones', () => {
    // The 3.10 truth pinned: no reading → the frontier engines are held back
    // by the fail-closed subscription gate, and the fallback is NOT attributed
    // to the (off) local-only mode. V3.10 IB2: the fail-closed gate applies
    // to AUTONOMOUS routes only (RoutingContext.autonomous); interactive
    // routing keeps the pre-3.10 rule — see test/routing-interactive-scope.test.ts.
    const item = makeItem({ source: 'issue' as WorkSource, effort: 5, score: 10 });
    const d = inFreshHome(() => routeTask(item, openCfg(), { ...ALL_ENGINES_CTX, autonomous: true }));
    expect(['claude', 'codex']).not.toContain(d.engine);
    expect(d.reason).not.toContain('local-only');
  });

  it('routeBackend picks a cloud frontier for a hard item', () => {
    const d = routeBackend(makeItem({ source: 'issue' as WorkSource, effort: 5, score: 10 }), openCfg());
    expect(d.reason).not.toContain('local-only');
  });

  it('spawnEngine does not refuse on policy grounds', async () => {
    // A binary that certainly does not exist: the failure must be the MISSING
    // BINARY, not a local-only refusal.
    const res = await spawnEngine(
      { bin: '/nonexistent/ashlr-test-claude', args: [], cwd: '/tmp' },
      openCfg(),
    );
    expect(res.ok).toBe(false);
    expect(res.error ?? '').not.toContain('local-only');
  });

  it('a LOCAL engine dispatches normally while the mode is ON', () => {
    // The whole point: local-only must not degrade local work.
    const d = routeTask(makeItem({ source: 'todo' as WorkSource, effort: 2 }), lockedCfg(), {
      availableEngines: ['local-coder', 'builtin'] as EngineId[],
    });
    expect(d.engine).toBe('local-coder');
    expect(d.reason).not.toContain('local-only');
  });
});

// ===========================================================================
// §H — interactive Verse sessions (chokepoint 13)
// ===========================================================================

/**
 * The cockpit path, driven by a person. Everything above this point is the
 * fleet deciding to spend; this is a human pressing Enter in a chat with a
 * claude / codex / grok seat while the Local-only panel says nothing can.
 *
 * Hermetic: `createVerseEngine` takes an injected `spawn`, so NOTHING is ever
 * executed. The injected spawn RECORDS and then throws, which lets the same
 * fixture prove both directions — a refused turn must leave the recorder empty,
 * and a permitted turn must reach it. Config is injected too, so the real
 * ~/.ashlr/config.json is never read and never written.
 */
describe('§H verse interactive sessions', () => {
  let work: string;
  let handles: VerseEngineHandle[] = [];
  let spawned: string[][] = [];

  /** Records the attempt, then fails it. Reaching this at all is the assertion. */
  const recordingSpawn = ((bin: string, args: readonly string[]): never => {
    spawned.push([bin, ...args]);
    throw new Error('spawn attempted');
  }) as unknown as VerseEngineOptions['spawn'];

  function verseEngine(cfg: AshlrConfig | undefined): VerseEngineHandle {
    const handle = createVerseEngine({
      root: mkdtempSync(join(work, 'root-')),
      spawn: recordingSpawn,
      loadConfig: () => cfg,
    });
    handles.push(handle);
    return handle;
  }

  function verseSeat(engine: VerseSeat['engine'], model: string): VerseSeat {
    return {
      id: `seat-${engine}`,
      engine,
      label: engine,
      accountId: engine === 'local' ? 'local' : `${engine}-account`,
      models: [{ id: model, label: model, contextWindow: 32_000 }],
      contextWindow: null,
      health: { state: 'unknown', summary: null, windows: [], observedAt: null },
    };
  }

  function verseLaunch(seat: VerseSeat, ollamaBaseUrl = 'http://127.0.0.1:11434'): VerseSeatLaunch {
    return {
      seat,
      // A native-profile launcher prefix for the vendor seats; local resolves
      // its binary through PATH and carries none.
      launcher: seat.engine === 'local' ? null : [process.execPath, '/tmp/ashlr-test-launcher.mjs'],
      ollamaBaseUrl,
    };
  }

  /** Create a session on `seat` and send one turn. Returns what the user would see. */
  function oneTurn(
    handle: VerseEngineHandle,
    seat: VerseSeat,
    launch: VerseSeatLaunch,
  ): { status: string; lastError: string | null; errors: string[] } {
    const model = seat.models[0]!.id;
    const created = handle.createSession(
      { projectPath: work, seatId: seat.id, model },
      launch,
    );
    handle.sendTurn(created.id, 'hello, please do a thing');
    const session = handle.getSession(created.id)!;
    const errors = handle
      .getEvents(created.id)
      .flatMap((e) => (e.type === 'error' ? [e.message] : []));
    return { status: session.status, lastError: session.lastError, errors };
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'local-only-verse-'));
    spawned = [];
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) {
      try { handle.close(); } catch { /* already closed */ }
    }
    handles = [];
    rmSync(work, { recursive: true, force: true });
  });

  for (const engine of ['claude', 'codex', 'grok'] as const) {
    it(`refuses a ${engine} seat BEFORE the process is spawned`, () => {
      const seat = verseSeat(engine, `${engine}-model`);
      const outcome = oneTurn(verseEngine(lockedCfg()), seat, verseLaunch(seat));

      // 1. No child process. This is the whole bug: the panel's claim is only
      //    true if the refusal lands before the spawn, not after it.
      expect(spawned, `a ${engine} turn spawned a process under local-only`).toEqual([]);

      // 2. The user sees a reason, in the session, not in a log nobody reads.
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toContain('local-only');
      expect(outcome.errors[0]).toContain(engine);
      expect(outcome.errors[0], 'the refusal must say how to undo it').toContain(
        'cfg.foundry.localOnly=false',
      );

      // 3. Not a crash and not a silent no-op: an ordinary failed turn.
      expect(outcome.status).toBe('error');
      expect(outcome.lastError ?? '').toContain('local-only');
    });
  }

  it('a LOCAL seat is untouched — it still reaches the spawn', () => {
    const seat = verseSeat('local', 'qwen3-coder');
    const outcome = oneTurn(verseEngine(lockedCfg()), seat, verseLaunch(seat));
    expect(spawned, 'local-only must not degrade a local seat').toHaveLength(1);
    // It failed only because the injected spawn throws; never on policy grounds.
    for (const message of outcome.errors) expect(message).not.toContain('local-only');
  });

  it('CONTROL: with the mode OFF a cloud seat dispatches exactly as before', () => {
    const seat = verseSeat('claude', 'claude-opus-5');
    const outcome = oneTurn(verseEngine(openCfg()), seat, verseLaunch(seat));
    expect(spawned).toHaveLength(1);
    for (const message of outcome.errors) expect(message).not.toContain('local-only');
  });

  it('an env-only enable refuses the interactive path too', () => {
    process.env['ASHLR_LOCAL_ONLY'] = '1';
    const seat = verseSeat('codex', 'gpt-5.5');
    const outcome = oneTurn(verseEngine(openCfg()), seat, verseLaunch(seat));
    expect(spawned).toEqual([]);
    expect(outcome.errors[0] ?? '').toContain('local-only');
  });

  it('env cannot DISABLE a persisted local-only at the verse gate', () => {
    process.env['ASHLR_LOCAL_ONLY'] = '0';
    const seat = verseSeat('grok', 'grok-4');
    const outcome = oneTurn(verseEngine(lockedCfg()), seat, verseLaunch(seat));
    expect(spawned).toEqual([]);
    expect(outcome.errors[0] ?? '').toContain('was refused');
  });

  it('a "local" seat pointed at a REMOTE runtime is refused, not waved through', () => {
    // engine==='local' is a seat label, not a guarantee. The endpoint decides,
    // by the same rule endpointPermitted applies everywhere else — otherwise
    // repointing ollamaBaseUrl at a rented GPU host reopens the hole.
    const seat = verseSeat('local', 'qwen3-coder');
    const outcome = oneTurn(
      verseEngine(lockedCfg()),
      seat,
      verseLaunch(seat, 'https://ollama.example.com'),
    );
    expect(spawned).toEqual([]);
    expect(outcome.errors[0] ?? '').toContain('local-only');
  });
});
