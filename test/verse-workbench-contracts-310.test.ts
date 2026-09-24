/**
 * V3.10 workbench contracts + mount (unit C0) — workbench-types.ts and the
 * WORKBENCH families mounted by src/core/verse/verse-api.ts.
 *
 * Three promises are under test:
 *
 *   1. ROUTE CLAIMS DO NOT OVERLAP. Each Track B / C family owns exclusive
 *      path prefixes, and none of them can reach a V1 route, a V2 control /
 *      GitHub / MCP route, or a Track A module path. Track B's live fleet is
 *      /api/verse/fleet/live ONLY — it stays off A8's /api/verse/fleet/history
 *      and the V2.2 control route /api/verse/fleet.
 *   2. PARTIAL LANDING NEVER BREAKS THE SERVER. A family whose module has not
 *      landed is a plain 404 that touches nothing else; one that landed but
 *      fails to load is a 503 naming it; a broken family (or a broken A10
 *      module) never takes another family down with it.
 *   3. THE GATES HOLD. Every non-GET meets the V1 dispatch + mutation gate
 *      before a module is even loaded; GETs sit behind the read session.
 *
 * Runs the REAL server under a relocated HOME with recording fakes swapped in
 * through setWorkbenchApiModulesForTest(), the same way the A10 mount test
 * does — the mount is what is under test, not the modules, which their owning
 * units test. The real table is exercised through `load()` only: invoking a
 * landed module's handler here could spawn its probes (Apps runs `--version`
 * on every installed CLI), which is that unit's test to write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import { sendJson } from '../src/core/web/api.js';
import {
  invalidateVerseSeatCache,
  isOwnModuleMissing,
  isVerseApiPath,
  resetVerseEngine,
  setMountedApiModulesForTest,
  setWorkbenchApiModulesForTest,
  workbenchApiModules,
  workbenchImporterIds,
  type MountedApiModule,
  type MountedApiModuleId,
  type WorkbenchApiModule,
} from '../src/core/verse/verse-api.js';
import { isVerseControlPath } from '../src/core/verse/control-api.js';
import { isVerseGithubPath } from '../src/core/verse/github-api.js';
import { isVerseMcpPath } from '../src/core/verse/mcp-control-api.js';
import { VERSE_HEALTH_PATH } from '../src/core/verse/health-types.js';
import { VERSE_BUDGET_PATH } from '../src/core/routing/types.js';
import { REASONING_DIGEST_PATH, REASONING_STEPS_PATH } from '../src/core/reasoning/types.js';
import { FLEET_HISTORY_PATH } from '../src/core/verse/fleet-history.js';
import { VERSE_AUTHORITY_PATH } from '../src/core/authority/types.js';
import { VERSE_FLEET_LIVE_PATH, VERSE_OVERNIGHT_PATH } from '../src/core/fleet/fleet-types.js';
import { VERSE_LEADER_PATH } from '../src/core/vision/leader-types.js';
import { VERSE_LEARNING_PATH } from '../src/core/learn/harness-types.js';
import {
  ENGINE_MONOGRAM,
  isLoopbackPreviewUrl,
  isNeedsYouItem,
  isSafeApiRoute,
  isWorkbenchSectionId,
  LEGACY_SECTION_MIGRATION,
  migrateSectionId,
  NEEDS_YOU_ACTION_KEYS,
  NEEDS_YOU_CATEGORIES,
  NEEDS_YOU_KIND_CATEGORY,
  NEEDS_YOU_KINDS,
  NEEDS_YOU_PROVIDERS,
  routePrefixOwns,
  VERSE_ACTIVITY_PATH,
  VERSE_ACTIVITY_SEEN_PATH,
  VERSE_APPS_PATH,
  VERSE_ATTACHMENTS_PATH,
  VERSE_FILES_PATH,
  VERSE_GIT_DIFF_PATH,
  VERSE_GIT_STATUS_PATH,
  VERSE_PREVIEW_RAW_PATH,
  VERSE_PREVIEW_TARGETS_PATH,
  VERSE_QUEUE_PATH,
  VERSE_SESSION_CONTROL_DEFAULTS_PATH,
  VERSE_SESSION_CONTROLS_PATH,
  VERSE_SESSION_META_PATH,
  VERSE_TERMINAL_PATH,
  WORKBENCH_ROUTE_FAMILIES,
  WORKBENCH_SECTION_IDS,
  WORKBENCH_SURFACES,
  workbenchFamilyFor,
  type NeedsYouItem,
  type WorkbenchRouteFamilyId,
} from '../src/core/verse/workbench-types.js';
import {
  VERSE_DEFAULT_PERMISSION_MODE,
  VERSE_EFFORTS,
  VERSE_PERMISSION_MODES,
  type VerseEngine,
} from '../src/core/verse/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const REPO = path.resolve(__dirname, '..');
const VERSE_API_SOURCE = path.join(REPO, 'src/core/verse/verse-api.ts');
const VERSE_GIT_PATH_FOR_POST = '/api/verse/git/commit';

// ---------------------------------------------------------------------------
// 1. Route claims
// ---------------------------------------------------------------------------

/** Every path a pre-existing handler answers, with a subpath or two where it has them. */
const EXISTING_ROUTES = {
  v1: [
    '/api/verse/bootstrap',
    '/api/verse/seats',
    '/api/verse/sessions',
    '/api/verse/sessions/s-1',
    '/api/verse/sessions/s-1/events',
    '/api/verse/sessions/s-1/turns',
    '/api/verse/workspaces',
    '/api/verse/workspaces/w-1',
    '/api/verse/autonomy-scope',
    '/api/verse/preferences',
    '/api/verse/context-fit',
    '/api/verse/search',
    '/api/verse/memory',
  ],
  control: [
    '/api/verse/control',
    '/api/verse/caps',
    '/api/verse/scope',
    '/api/verse/audit',
    '/api/verse/daemon',
    '/api/verse/safety',
    '/api/verse/accounts',
    '/api/verse/usage-series',
    '/api/verse/local-models',
    '/api/verse/runtime',
    '/api/verse/fleet',
    '/api/verse/local-only',
  ],
  github: ['/api/verse/github', '/api/verse/github/pr-plan'],
  mcp: ['/api/verse/mcp', '/api/verse/mcp/cli-health', '/api/verse/mcp/cli-probe', '/api/verse/mcp/proposal', '/api/verse/mcp/apply'],
  trackA: [
    VERSE_HEALTH_PATH,
    `${VERSE_HEALTH_PATH}/refresh`,
    `${VERSE_HEALTH_PATH}/reconnect`,
    VERSE_BUDGET_PATH,
    FLEET_HISTORY_PATH,
    REASONING_DIGEST_PATH,
    REASONING_STEPS_PATH,
  ],
} as const;

const EXPECTED_HANDLERS: Record<WorkbenchRouteFamilyId, string> = {
  // SPEC-310C §7 route contracts.
  activity: 'handleActivityApi',
  'session-controls': 'handleSessionControlsApi',
  terminal: 'handleTerminalApi',
  preview: 'handlePreviewApi',
  git: 'handleGitApi',
  apps: 'handleAppsApi',
  // SPEC-310B §7 frozen naming: handle{Authority,Overnight,FleetLive,Leader,Learning}Api.
  authority: 'handleAuthorityApi',
  overnight: 'handleOvernightApi',
  'fleet-live': 'handleFleetLiveApi',
  leader: 'handleLeaderApi',
  learning: 'handleLearningApi',
};

const allPrefixes = WORKBENCH_ROUTE_FAMILIES.flatMap((family) => family.prefixes.map((prefix) => ({ family: family.id, prefix })));

describe('workbench route families — claims', () => {
  it('names every family the specs name, with the spec handler names', () => {
    expect(Object.fromEntries(WORKBENCH_ROUTE_FAMILIES.map((f) => [f.id, f.handler]))).toEqual(EXPECTED_HANDLERS);
  });

  it('keeps every prefix under /api/verse/ (so isVerseApiPath already routes it here)', () => {
    for (const { prefix } of allPrefixes) {
      expect(prefix.startsWith('/api/verse/'), prefix).toBe(true);
      expect(prefix.endsWith('/'), prefix).toBe(false);
      expect(isVerseApiPath(prefix), prefix).toBe(true);
    }
  });

  it('gives no two families (or two prefixes) an overlapping claim', () => {
    for (const a of allPrefixes) {
      for (const b of allPrefixes) {
        if (a === b) continue;
        expect(routePrefixOwns(a.prefix, b.prefix), `${a.family} ${a.prefix} owns ${b.family} ${b.prefix}`).toBe(false);
      }
    }
  });

  it.each(Object.entries(EXISTING_ROUTES))('never claims a %s route', (_kind, routes) => {
    for (const route of routes) expect(workbenchFamilyFor(route), route).toBeNull();
  });

  it('never claims a path the V2 control, GitHub or MCP handlers answer first (they run before handleVerseApi)', () => {
    for (const { prefix } of allPrefixes) {
      for (const p of [prefix, `${prefix}/x`]) {
        expect(isVerseControlPath(p), p).toBe(false);
        expect(isVerseGithubPath(p), p).toBe(false);
        expect(isVerseMcpPath(p), p).toBe(false);
      }
    }
  });

  it('keeps Track B off /fleet/history and off the V2.2 /fleet control route', () => {
    expect(workbenchFamilyFor(FLEET_HISTORY_PATH)).toBeNull();
    expect(workbenchFamilyFor('/api/verse/fleet')).toBeNull();
    expect(workbenchFamilyFor('/api/verse/fleet/historyX')).toBeNull();
    expect(workbenchFamilyFor(`${VERSE_FLEET_LIVE_PATH}/lanes`)?.id).toBe('fleet-live');
  });

  it('matches on a segment boundary only', () => {
    expect(workbenchFamilyFor('/api/verse/git')?.id).toBe('git');
    expect(workbenchFamilyFor('/api/verse/git/status')?.id).toBe('git');
    expect(workbenchFamilyFor('/api/verse/github')).toBeNull();
    expect(workbenchFamilyFor('/api/verse/gitx')).toBeNull();
    expect(workbenchFamilyFor('/api/verse/applications')).toBeNull();
    expect(workbenchFamilyFor('/api/verse/activity-log')).toBeNull();
    expect(workbenchFamilyFor('/api/verse/terminals')).toBeNull();
  });

  it("routes every path constant a unit declares to that unit's family", () => {
    const expectations: Array<[string, WorkbenchRouteFamilyId]> = [
      [VERSE_ACTIVITY_PATH, 'activity'],
      [VERSE_ACTIVITY_SEEN_PATH, 'activity'],
      [VERSE_SESSION_META_PATH, 'activity'],
      [`${VERSE_SESSION_META_PATH}/s-1`, 'activity'],
      [`${VERSE_SESSION_CONTROLS_PATH}/s-1`, 'session-controls'],
      [VERSE_SESSION_CONTROL_DEFAULTS_PATH, 'session-controls'],
      [`${VERSE_ATTACHMENTS_PATH}/s-1`, 'session-controls'],
      [`${VERSE_QUEUE_PATH}/s-1`, 'session-controls'],
      [`${VERSE_QUEUE_PATH}/s-1/q-1/delete`, 'session-controls'],
      [VERSE_FILES_PATH, 'session-controls'],
      [VERSE_TERMINAL_PATH, 'terminal'],
      [`${VERSE_TERMINAL_PATH}/t-1/stream`, 'terminal'],
      [VERSE_PREVIEW_TARGETS_PATH, 'preview'],
      [VERSE_PREVIEW_RAW_PATH, 'preview'],
      [VERSE_GIT_STATUS_PATH, 'git'],
      [VERSE_GIT_DIFF_PATH, 'git'],
      ['/api/verse/git/pr/merge', 'git'],
      [VERSE_APPS_PATH, 'apps'],
      [`${VERSE_APPS_PATH}/claude-desktop/toggle`, 'apps'],
      // Track B's own constants (B-U1's frozen contract files).
      [VERSE_AUTHORITY_PATH, 'authority'],
      [VERSE_OVERNIGHT_PATH, 'overnight'],
      [VERSE_FLEET_LIVE_PATH, 'fleet-live'],
      [VERSE_LEADER_PATH, 'leader'],
      [VERSE_LEARNING_PATH, 'learning'],
    ];
    for (const [p, id] of expectations) expect(workbenchFamilyFor(p)?.id, p).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// 2. The real importer table
// ---------------------------------------------------------------------------

describe('the real workbench mount table', () => {
  afterEach(() => setWorkbenchApiModulesForTest(null));

  it('has exactly one importer per family, in contract order', () => {
    expect(workbenchImporterIds()).toEqual(WORKBENCH_ROUTE_FAMILIES.map((f) => f.id));
    expect(workbenchApiModules().map((m) => m.id)).toEqual(WORKBENCH_ROUTE_FAMILIES.map((f) => f.id));
  });

  it("imports each family's OWN module by a literal specifier inside a try (what bun --compile needs)", () => {
    const source = fs.readFileSync(VERSE_API_SOURCE, 'utf8');
    for (const family of WORKBENCH_ROUTE_FAMILIES) {
      const file = path.basename(family.module).replace(/\.ts$/, '.js');
      const literal = `import('./${file}' as string)`;
      expect(source.split(literal).length - 1, `${family.id} must be imported exactly once as ${literal}`).toBe(1);
      expect(source, `${family.id}'s importer must classify ITS OWN file`).toContain(`notLandedOr(err, '${file}')`);
      // The importer line must hold the try around the literal.
      const line = source.split('\n').find((l) => l.includes(literal))!;
      expect(line.trim().startsWith('try {'), `${family.id}: the literal import must sit inside a try`).toBe(true);
    }
  });

  it('resolves a landed module to its named handler, and an absent one to "not landed"', async () => {
    setWorkbenchApiModulesForTest(null);
    for (const entry of workbenchApiModules()) {
      const family = WORKBENCH_ROUTE_FAMILIES.find((f) => f.id === entry.id)!;
      const landed = fs.existsSync(path.join(REPO, family.module));
      const handler = await entry.load();
      if (landed) expect(typeof handler, `${family.id} landed at ${family.module} but did not export ${family.handler}`).toBe('function');
      else expect(handler, `${family.id} has not landed, so it must be a clean "not landed"`).toBeNull();
    }
  });

  it('R1: every landed needs-you producer exports needsYouItems (the stub may throw; it is not called here)', async () => {
    for (const provider of NEEDS_YOU_PROVIDERS) {
      const file = path.join(REPO, provider.module);
      if (!fs.existsSync(file)) continue;
      const mod = (await import(file)) as Record<string, unknown>;
      expect(typeof mod[provider.exportName], `${provider.owner} ${provider.module}`).toBe('function');
      // The provider module is also the family module activity reads it from.
      expect(WORKBENCH_ROUTE_FAMILIES.some((f) => f.module === provider.module), provider.module).toBe(true);
    }
  });
});

describe('isOwnModuleMissing', () => {
  const missing = (message: string, code: unknown = 'ERR_MODULE_NOT_FOUND') => Object.assign(new Error(message), { code });

  it('recognises the module itself missing under node / tsx, vitest and a bun binary', () => {
    expect(isOwnModuleMissing(missing("Cannot find module '/Users/x/repo/dist/core/verse/git-api.js' imported from /Users/x/repo/dist/core/verse/verse-api.js"), 'git-api.js')).toBe(true);
    expect(isOwnModuleMissing(missing("Cannot find module '/git-api.js' imported from /Users/x/repo/src/core/verse/verse-api.ts"), 'git-api.js')).toBe(true);
    expect(isOwnModuleMissing(missing("Cannot find module './git-api.js' from '/$bunfs/root/ashlr'"), 'git-api.js')).toBe(true);
    expect(isOwnModuleMissing(missing("Cannot find module 'C:\\repo\\dist\\core\\verse\\git-api.js' imported from x"), 'git-api.js')).toBe(true);
  });

  it('treats a TRANSITIVE missing import as broken, not as not-landed', () => {
    expect(isOwnModuleMissing(missing("Cannot find module './git-ops.js' imported from /Users/x/repo/src/core/verse/git-api.ts"), 'git-api.js')).toBe(false);
    expect(isOwnModuleMissing(missing("Cannot find module '/Users/x/dist/core/verse/helpers.js' imported from /Users/x/dist/core/verse/git-api.js"), 'git-api.js')).toBe(false);
  });

  it('never matches a lookalike name or a non-resolution error', () => {
    expect(isOwnModuleMissing(missing("Cannot find module '/x/legit-api.js' imported from y"), 'git-api.js')).toBe(false);
    expect(isOwnModuleMissing(new SyntaxError('Unexpected token'), 'git-api.js')).toBe(false);
    expect(isOwnModuleMissing(new TypeError('x is not a function'), 'git-api.js')).toBe(false);
    expect(isOwnModuleMissing(null, 'git-api.js')).toBe(false);
    expect(isOwnModuleMissing('Cannot find module', 'git-api.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Through the real server
// ---------------------------------------------------------------------------

interface Call { id: string; path: string; method: string }

let calls: Call[] = [];
let loads: string[] = [];

type Behaviour = 'answer' | 'decline' | 'throw';

function fakeFamily(id: WorkbenchRouteFamilyId, behaviour: Behaviour = 'answer'): WorkbenchApiModule {
  const handler: ApiModule = async (_ctx, _req, res: ServerResponse, p: string, method: string) => {
    calls.push({ id, path: p, method });
    if (behaviour === 'decline') return false;
    if (behaviour === 'throw') throw new Error(`boom at ${os.homedir()}/secret-path`);
    sendJson(res, 200, { family: id, path: p, method });
    return true;
  };
  return { id, load: async () => { loads.push(id); return handler; } };
}

function absentFamily(id: WorkbenchRouteFamilyId): WorkbenchApiModule {
  return { id, load: async () => { loads.push(id); return null; } };
}

function allAnswering(): WorkbenchApiModule[] {
  return WORKBENCH_ROUTE_FAMILIES.map((f) => fakeFamily(f.id));
}

/** A10 fakes that record, so a test can prove a workbench path never touched them. */
function recordingA10(): MountedApiModule[] {
  const ids: MountedApiModuleId[] = ['health', 'reasoning', 'fleet-history', 'budget'];
  return ids.map((id) => ({
    id,
    load: async () => {
      loads.push(`a10:${id}`);
      return async (_ctx, _req, _res, p, method) => {
        calls.push({ id: `a10:${id}`, path: p, method });
        return false;
      };
    },
  }));
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function emptyEngine(): VerseEngineHandle {
  return {
    listSessions: () => [],
    getSession: () => null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

interface HttpResult { status: number; body: string; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json (or HEAD) */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  return {
    port: handle.port,
    read: readAuthHeaders(handle.port),
    mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' },
  };
}

describe('workbench mount through the real server', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-workbench-mount-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(accountsRoot, { recursive: true });
    fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    cfg = makeConfig(accountsRoot);
    resetVerseEngine(emptyEngine());
    invalidateVerseSeatCache();
    calls = [];
    loads = [];
    setMountedApiModulesForTest(recordingA10());
    setWorkbenchApiModulesForTest(allAnswering());
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    handles = [];
    setWorkbenchApiModulesForTest(null);
    setMountedApiModulesForTest(null);
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('routes each family prefix to its own module only — no other family and no A10 module is loaded', async () => {
    const { port, read } = await boot();
    for (const family of WORKBENCH_ROUTE_FAMILIES) {
      for (const prefix of family.prefixes) {
        calls = [];
        loads = [];
        const res = await request(port, 'GET', `${prefix}/probe?x=1`, read);
        expect(res.status, prefix).toBe(200);
        // The module sees the path WITHOUT the query string, like every V1 route.
        expect(res.json).toEqual({ family: family.id, path: `${prefix}/probe`, method: 'GET' });
        expect(calls.map((c) => c.id)).toEqual([family.id]);
        expect(loads.filter((l) => l.startsWith('a10:'))).toEqual([]);
      }
    }
  });

  it('a family whose module has not landed is a plain 404 — and every other family still serves', async () => {
    setWorkbenchApiModulesForTest(WORKBENCH_ROUTE_FAMILIES.map((f) => (f.id === 'terminal' ? absentFamily('terminal') : fakeFamily(f.id))));
    const { port, read } = await boot();
    const terminal = await request(port, 'GET', `${VERSE_TERMINAL_PATH}/t-1/stream`, read);
    expect(terminal.status).toBe(404);
    expect(terminal.json).toEqual({ error: `not found: GET ${VERSE_TERMINAL_PATH}/t-1/stream` });

    const git = await request(port, 'GET', VERSE_GIT_STATUS_PATH, read);
    expect(git.status).toBe(200);
    expect((git.json as { family: string }).family).toBe('git');
    // A not-landed module is NOT memoized as absent: it is asked again (it lands with the next build).
    await request(port, 'GET', VERSE_TERMINAL_PATH, read);
    expect(loads.filter((l) => l === 'terminal')).toHaveLength(2);
  });

  it('a module that declines a path in its own prefix is a 404 (nothing after it may answer)', async () => {
    setWorkbenchApiModulesForTest(WORKBENCH_ROUTE_FAMILIES.map((f) => (f.id === 'authority' ? fakeFamily('authority', 'decline') : fakeFamily(f.id))));
    const { port, read } = await boot();
    const res = await request(port, 'GET', VERSE_AUTHORITY_PATH, read);
    expect(res.status).toBe(404);
    expect(calls.map((c) => c.id)).toEqual(['authority']);
    expect(loads.filter((l) => l.startsWith('a10:'))).toEqual([]);
  });

  it('a module that landed but fails to load is a 503 naming ONLY that family, with no path leak, and is retried', async () => {
    let healthy = false;
    const flaky: WorkbenchApiModule = {
      id: 'git',
      load: async () => {
        loads.push('git');
        if (!healthy) throw new Error(`Cannot find module '${os.homedir()}/repo/src/core/verse/git-ops.js' imported from x`);
        return (await fakeFamily('git').load())!;
      },
    };
    setWorkbenchApiModulesForTest(WORKBENCH_ROUTE_FAMILIES.map((f) => (f.id === 'git' ? flaky : fakeFamily(f.id))));
    const { port, read } = await boot();

    const git = await request(port, 'GET', VERSE_GIT_STATUS_PATH, read);
    expect(git.status).toBe(503);
    expect(git.json).toEqual({ code: 'API_MODULE_UNAVAILABLE', error: 'a route module failed to load', unavailable: ['git'] });
    expect(git.body).not.toContain('Cannot find module');
    expect(git.body).not.toContain(os.homedir());

    // A broken family never takes a neighbour down.
    expect((await request(port, 'GET', VERSE_APPS_PATH, read)).status).toBe(200);
    expect((await request(port, 'GET', '/api/verse/bootstrap', read)).status).toBe(200);

    healthy = true;
    expect((await request(port, 'GET', VERSE_GIT_STATUS_PATH, read)).status).toBe(200);
  });

  it('a loader resolving to a non-function is a 503, not a crash', async () => {
    setWorkbenchApiModulesForTest([{ id: 'apps', load: async () => ({}) as unknown as ApiModule }]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', VERSE_APPS_PATH, read);
    expect(res.status).toBe(503);
    expect((res.json as { unavailable: string[] }).unavailable).toEqual(['apps']);
  });

  it('a family missing from the table entirely is a 404 (partial tables in tests, or a future family)', async () => {
    setWorkbenchApiModulesForTest([fakeFamily('git')]);
    const { port, read } = await boot();
    expect((await request(port, 'GET', VERSE_LEADER_PATH, read)).status).toBe(404);
    expect((await request(port, 'GET', VERSE_GIT_STATUS_PATH, read)).status).toBe(200);
  });

  it('a broken A10 module cannot 503 a workbench route (prefix routing never consults it)', async () => {
    setMountedApiModulesForTest([{ id: 'health', load: async () => { throw new Error('broken'); } }]);
    const { port, read } = await boot();
    const git = await request(port, 'GET', VERSE_GIT_STATUS_PATH, read);
    expect(git.status).toBe(200);
    // …while A10's own contract is untouched: an unowned path still meets its 503.
    const other = await request(port, 'GET', '/api/verse/no-such-route', read);
    expect(other.status).toBe(503);
  });

  it('a module that throws while handling gets the V1 mapping: a message-free 500', async () => {
    setWorkbenchApiModulesForTest([fakeFamily('preview', 'throw')]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', VERSE_PREVIEW_TARGETS_PATH, read);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ code: 'INTERNAL_ERROR', error: 'internal server error' });
    expect(res.body).not.toContain('secret-path');
  });

  it('memoizes a successful load: one load across many requests', async () => {
    const { port, read } = await boot();
    for (let i = 0; i < 4; i += 1) await request(port, 'GET', VERSE_ACTIVITY_PATH, read);
    expect(loads).toEqual(['activity']);
  });

  it('an unowned /api/verse path never touches a workbench module and stays a 404', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/no-such-route', read);
    expect(res.status).toBe(404);
    expect(loads.filter((l) => !l.startsWith('a10:'))).toEqual([]);
  });

  it('V1 routes never load a workbench module', async () => {
    const { port, read } = await boot();
    for (const p of ['/api/verse/bootstrap', '/api/verse/seats', '/api/verse/sessions']) {
      expect((await request(port, 'GET', p, read)).status, p).toBe(200);
    }
    expect(loads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('GETs sit behind the read-session boundary: 401, module never loaded', async () => {
    const { port } = await boot();
    for (const family of WORKBENCH_ROUTE_FAMILIES) {
      const res = await request(port, 'GET', family.prefixes[0]!);
      expect(res.status, family.id).toBe(401);
    }
    expect(loads).toEqual([]);
  });

  describe('non-GET: the V1 dispatch + mutation gate runs before any module is loaded', () => {
    it('404 when the server does not allow dispatch', async () => {
      const { port, mutate } = await boot({ allowDispatch: false });
      const res = await request(port, 'POST', VERSE_GIT_PATH_FOR_POST, mutate, JSON.stringify({ root: '/x' }));
      expect(res.status).toBe(404);
      expect(loads).toEqual([]);
    });

    it('401 without the mutation token (the read token is not enough)', async () => {
      const { port, read } = await boot();
      const res = await request(port, 'POST', `${VERSE_TERMINAL_PATH}/t-1/input`, { ...read, 'content-type': 'application/json' }, '{}');
      expect(res.status).toBe(401);
      expect(loads).toEqual([]);
    });

    it('415 with the token but a non-JSON body type', async () => {
      const { port, mutate } = await boot();
      const res = await request(port, 'POST', `${VERSE_QUEUE_PATH}/s-1`, { ...mutate, 'content-type': 'text/plain' }, 'x');
      expect(res.status).toBe(415);
      expect(loads).toEqual([]);
    });

    it('reaches the owning module once the gate passes, method intact', async () => {
      const { port, mutate } = await boot();
      const res = await request(port, 'POST', `${VERSE_APPS_PATH}/claude-desktop/toggle`, mutate, JSON.stringify({ enabled: false, confirm: true }));
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ family: 'apps', path: `${VERSE_APPS_PATH}/claude-desktop/toggle`, method: 'POST' });
    });

    it('HEAD counts as non-GET: no read served around the gate', async () => {
      const off = await boot({ allowDispatch: false });
      expect((await request(off.port, 'HEAD', VERSE_ACTIVITY_PATH, off.read)).status).toBe(404);
      const on = await boot();
      expect((await request(on.port, 'HEAD', VERSE_ACTIVITY_PATH)).status).toBe(401);
      expect(loads).toEqual([]);
    });
  });
});


// ---------------------------------------------------------------------------
// 4. Shared contract helpers (workbench-types.ts)
// ---------------------------------------------------------------------------

function validItem(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: 'fleet:owner-hold:ashlrai/binshield',
    source: 'fleet',
    kind: 'owner-hold',
    severity: 'warn',
    title: 'binshield is on owner-hold after 2 quarantines in 7 days',
    detail: null,
    since: '2026-09-24T06:30:00.000Z',
    expiresAt: null,
    subject: { repo: 'ashlrai/binshield', pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'fleet', anchor: 'repos' },
    actions: [
      {
        kind: 'resume',
        label: 'Resume repo',
        request: { method: 'POST', path: '/api/verse/fleet/live/repos/resume', body: { repo: 'ashlrai/binshield' } },
        confirm: { title: 'Resume binshield?', body: 'The fleet may merge here again.', confirmLabel: 'Resume' },
        destructive: false,
      },
    ],
    ...overrides,
  };
}

describe('NeedsYouItem (R1)', () => {
  it('accepts a well-formed item', () => {
    expect(isNeedsYouItem(validItem())).toBe(true);
  });

  it('refuses an action that would aim the mutation token off-origin or outside /api/', () => {
    for (const bad of ['https://evil.example/api/x', '//evil.example/api/x', '/api/../admin', '/apix/verse', '/api/verse/ x', '/api\\verse', 'api/verse']) {
      const item = validItem();
      item.actions[0]!.request = { method: 'POST', path: bad, body: {} };
      expect(isNeedsYouItem(item), bad).toBe(false);
      expect(isSafeApiRoute(bad), bad).toBe(false);
    }
    expect(isSafeApiRoute('/api/verse/fleet/live/repos/resume')).toBe(true);
  });

  it('refuses unknown kinds / sources, bad times, over-long titles, bad PR numbers and non-https URL targets', () => {
    expect(isNeedsYouItem({ ...validItem(), kind: 'mystery' })).toBe(false);
    expect(isNeedsYouItem({ ...validItem(), source: 'daemon' })).toBe(false);
    expect(isNeedsYouItem(validItem({ since: 'yesterday' }))).toBe(false);
    expect(isNeedsYouItem(validItem({ title: 'x'.repeat(121) }))).toBe(false);
    expect(isNeedsYouItem(validItem({ title: '   ' }))).toBe(false);
    expect(isNeedsYouItem(validItem({ subject: { repo: null, pr: 0, seatId: null, sessionId: null, engine: null } }))).toBe(false);
    expect(isNeedsYouItem(validItem({ target: { kind: 'url', url: 'http://github.com/x' } }))).toBe(false);
    expect(isNeedsYouItem(validItem({ target: { kind: 'url', url: 'javascript:alert(1)' } }))).toBe(false);
    expect(isNeedsYouItem(validItem({ target: { kind: 'url', url: 'https://github.com/ashlrai/ashlr-hub/pull/481' } }))).toBe(true);
    expect(isNeedsYouItem(validItem({ actions: Array.from({ length: 7 }, () => validItem().actions[0]!) }))).toBe(false);
  });

  it('files every kind under exactly one drawer split', () => {
    expect(Object.keys(NEEDS_YOU_KIND_CATEGORY).sort()).toEqual([...NEEDS_YOU_KINDS].sort());
    for (const category of Object.values(NEEDS_YOU_KIND_CATEGORY)) expect(NEEDS_YOU_CATEGORIES).toContain(category);
  });

  it('gives the drawer keys (A R V E) to four distinct actions', () => {
    const keys = Object.values(NEEDS_YOU_ACTION_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(['A', 'E', 'R', 'V']);
  });
});

describe('information architecture', () => {
  it('orders the rail ⌘1 Command … ⌘5 Chat', () => {
    expect(WORKBENCH_SURFACES).toEqual(['command', 'fleet', 'growth', 'mind', 'chat']);
  });

  it('migrates every v2 section: autonomy → fleet, approvals → command + drawer, mcp → apps', () => {
    expect(migrateSectionId('autonomy')).toEqual({ section: 'fleet', openNeedsYou: false });
    expect(migrateSectionId('approvals')).toEqual({ section: 'command', openNeedsYou: true });
    expect(migrateSectionId('mcp')).toEqual({ section: 'apps', openNeedsYou: false });
    expect(migrateSectionId('chat')).toEqual({ section: 'chat', openNeedsYou: false });
    for (const legacy of Object.keys(LEGACY_SECTION_MIGRATION)) expect(isWorkbenchSectionId(migrateSectionId(legacy)!.section)).toBe(true);
  });

  it('passes a v3 id through and refuses anything else (the caller keeps its own default)', () => {
    for (const id of WORKBENCH_SECTION_IDS) expect(migrateSectionId(id)).toEqual({ section: id, openNeedsYou: false });
    for (const junk of ['', 'Chat', 'toString', '__proto__', 'hasOwnProperty', 42, null, undefined, {}]) expect(migrateSectionId(junk)).toBeNull();
  });

  it('prints one monogram per engine, never a logo', () => {
    const engines: VerseEngine[] = ['claude', 'codex', 'grok', 'local'];
    expect(engines.map((e) => ENGINE_MONOGRAM[e])).toEqual(['C', 'X', 'G', 'L']);
  });
});

describe('session controls (types.ts additive)', () => {
  it('lists the four permission modes in picker order with accept-edits as the default', () => {
    expect(VERSE_PERMISSION_MODES).toEqual(['plan', 'accept-edits', 'auto', 'bypass']);
    expect(VERSE_DEFAULT_PERMISSION_MODE).toBe('accept-edits');
  });

  it('carries the union of claude and codex efforts', () => {
    expect(VERSE_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('preview URLs', () => {
  it('admits loopback http only — the rule the URL bar, the iframe and frame-src share', () => {
    expect(isLoopbackPreviewUrl('http://127.0.0.1:5173/')).toBe(true);
    expect(isLoopbackPreviewUrl('http://localhost:3000/app?x=1')).toBe(true);
    for (const bad of [
      'https://localhost:3000/',
      'http://127.0.0.1.evil.example/',
      'http://localhost.evil.example/',
      'http://user:pw@localhost:3000/',
      'http://10.0.0.5:3000/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isLoopbackPreviewUrl(bad), bad).toBe(false);
    }
  });
});
