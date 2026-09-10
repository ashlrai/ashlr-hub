import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initUniverse, initUniverseCampaign, requestUniverseCampaignControl,
  requestUniversePortfolioControllerControl, runUniversePortfolioController,
  readUniverseCampaign, readUniverseOverview } from '../src/core/universe/index.js';
import { startUniverseConsoleServer } from '../src/core/web/universe-console-server.js';

type Handle = Awaited<ReturnType<typeof startUniverseConsoleServer>>;
interface Response { status: number; headers: IncomingHttpHeaders; body: string }
const scratch: string[] = [];
const handles: Handle[] = [];
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const UNIVERSE_ID = 'same-console-universe';

function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-console-acceptance-')));
  scratch.push(path); return path;
}

function fixture(marker: string) {
  const base = temporary(); const repo = join(base, 'seed'); const root = join(base, 'universe');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'never-run.mjs'), `throw new Error(${JSON.stringify(`Never execute ${marker}`)});\n`, { mode: 0o600 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'never-run.mjs');
  git('-c', 'user.name=Console Acceptance', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Private inert console seed');
  const revision = git('rev-parse', 'HEAD');
  initUniverse({ schemaVersion: 1, id: UNIVERSE_ID, name: marker, objective: `Observe ${marker} without running work`,
    seed: { repo, revision }, metric: { name: 'measured', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 1_000 },
    evaluation: { command: [process.execPath, 'never-run.mjs'], timeoutMs: 1_000 },
    variants: [{ id: 'inert', niche: 'scope', hypothesis: marker, command: [process.execPath, 'never-run.mjs'] }] }, { root });
  initUniverseCampaign({ schemaVersion: 1, id: 'same-console-campaign', universeId: UNIVERSE_ID, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 10_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  return { base, root, repo, marker, revision };
}

function snapshot(root: string): string {
  const entries: Array<[string, string]> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else { if (!entry.isFile()) throw new Error('Unexpected fixture entry'); entries.push([relative(root, path), sha256(readFileSync(path))]); }
    }
  };
  visit(root); return sha256(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b))));
}

async function start(root: string, port = 0): Promise<Handle> {
  const handle = await startUniverseConsoleServer({ root, port }); handles.push(handle); return handle;
}

function http(handle: Pick<Handle, 'port'>, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET',
      headers: { Host: `127.0.0.1:${handle.port}`, ...options.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(new Error('Console acceptance response exceeded bound')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Console acceptance request timed out')));
    req.on('error', reject); req.end();
  });
}

const authorized = (handle: Handle, extra: Record<string, string> = {}) => ({ 'x-ashlr-token': handle.readToken, ...extra });
async function session(handle: Handle) {
  const proof = randomBytes(32).toString('hex');
  const response = await http(handle, '/api/session', { method: 'POST',
    headers: authorized(handle, { 'x-ashlr-read-client': proof, Origin: handle.url }) });
  expect(response.status).toBe(204);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('Path=/api/'); expect(setCookie).toContain('Max-Age=');
  const cookie = setCookie.split(';', 1)[0]!;
  return { cookie, proof, headers: { Cookie: cookie, 'x-ashlr-read-client': proof } };
}

let alpha: ReturnType<typeof fixture>; let beta: ReturnType<typeof fixture>;
let a: Handle; let b: Handle; let beforeAlpha: string; let beforeBeta: string;

beforeAll(async () => {
  alpha = fixture('CONSOLE_SCOPE_ALPHA'); beta = fixture('CONSOLE_SCOPE_BETA');
  beforeAlpha = snapshot(alpha.base); beforeBeta = snapshot(beta.base);
  a = await start(alpha.root); b = await start(beta.root);
});

afterAll(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  const writable = (path: string) => {
    const entry = lstatSync(path); if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

describe('independent scoped Universe console HTTP acceptance', () => {
  it('reads requested and acknowledged controller drain through the real worker without touching persisted evidence', async () => {
    const value = fixture('INERT_CONTROLLER_INSPECTOR'); const options = { root: value.root };
    const campaignId = 'same-console-campaign'; const controllerId = 'same-console-controller';
    expect(requestUniverseCampaignControl(campaignId, 'pause', options).state).toBe('paused');
    const definition = { schemaVersion: 1 as const, id: controllerId, maxParallel: 1, maxDurationMs: 60_000,
      tasks: [{ campaignId, dependsOn: [] }] };
    const initial = await runUniversePortfolioController(definition, options);
    expect(initial.status).toBe('incomplete'); expect(initial.outcomes[0]).toMatchObject({ state: 'held', attempted: false });
    const receipt = requestUniversePortfolioControllerControl(controllerId, 'drain', options);
    const handle = await start(value.root); const path = `/api/universe/controller-status?controllerId=${controllerId}`;
    const requestedBytes = snapshot(value.base);
    const requested = await http(handle, path, { headers: authorized(handle) });
    expect(requested.status).toBe(200); expect(requested.headers['cache-control']).toContain('no-store');
    expect(JSON.parse(requested.body)).toMatchObject({ controllerId, sourceState: 'healthy', status: 'draining',
      topology: [{ campaignId, dependsOn: [], prerequisites: [] }],
      createdAt: initial.createdAt, deadlineAt: initial.deadlineAt,
      control: { mode: 'drain', sequence: receipt.sequence, requestedAt: receipt.requestedAt, acknowledgedAt: null } });
    expect(snapshot(value.base)).toBe(requestedBytes);

    // Setup acknowledgement explicitly; subsequent HTTP reads have no mutation authority.
    const drained = await runUniversePortfolioController(definition, options);
    expect(drained.status).toBe('drained'); const acknowledgedBytes = snapshot(value.base);
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await http(handle, path, { headers: authorized(handle) });
      expect(response.status).toBe(200); const result = JSON.parse(response.body);
      expect(result).toMatchObject({ schemaVersion: 1, controllerId, sourceState: 'healthy', status: 'drained',
        createdAt: initial.createdAt, deadlineAt: initial.deadlineAt, control: drained.control,
        outcomes: [{ campaignId, state: 'held', attempted: false, reasonCode: initial.outcomes[0]!.reasonCode }] });
      expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
      for (const withheld of ['definitionDigest', 'campaignDigest', 'deliveryDigest', value.root, value.repo]) {
        expect(response.body).not.toContain(withheld);
      }
    }
    expect(readUniverseCampaign(campaignId, options)).toMatchObject({ state: 'paused', owner: null });
    expect(readUniverseOverview(options).universes[0]!.runs).toEqual([]);
    expect(snapshot(value.base)).toBe(acknowledgedBytes);
    await handle.close(); expect(snapshot(value.base)).toBe(acknowledgedBytes);
  });

  it('does not discover another root or initialize missing controller evidence', async () => {
    const root = join(temporary(), 'missing-controller-store'); const handle = await start(root);
    const response = await http(handle, '/api/universe/controller-status?controllerId=same-console-controller', { headers: authorized(handle) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ controllerId: 'same-console-controller', sourceState: 'missing',
      status: 'unavailable', createdAt: null, deadlineAt: null, outcomes: [] });
    expect(JSON.parse(response.body)).not.toHaveProperty('control');
    expect(JSON.parse(response.body)).not.toHaveProperty('topology');
    await handle.close(); expect(existsSync(root)).toBe(false);
  });

  it('reports degraded controller scope without repairing it or claiming active work', async () => {
    const root = join(temporary(), 'invalid-controller-store'); const bytes = Buffer.from('Inert invalid controller scope');
    writeFileSync(root, bytes, { mode: 0o600, flag: 'wx' }); const handle = await start(root);
    const response = await http(handle, '/api/universe/controller-status?controllerId=one', { headers: authorized(handle) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ controllerId: 'one', sourceState: 'degraded', status: 'unavailable', outcomes: [] });
    expect(JSON.parse(response.body)).not.toHaveProperty('control');
    await handle.close(); expect(readFileSync(root)).toEqual(bytes);
  });

  it('advertises a loopback-only ephemeral URL with no token and exposes content-free public health', async () => {
    expect(a.url).toBe(`http://127.0.0.1:${a.port}`); expect(a.port).toBeGreaterThan(0);
    expect(a.consoleUrl).toBe(`${a.url}/universe/`); expect(a.consoleUrl).not.toContain(a.readToken);
    expect(a.readToken).toMatch(/^[a-f0-9]{64}$/); expect(b.readToken).not.toBe(a.readToken);
    const health = await http(a, '/health'); expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    expect(health.body).not.toContain(alpha.root); expect(health.body).not.toContain(a.readToken);
    expect(health.headers['cache-control']).toContain('no-store');
    const head = await http(a, '/health', { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.body).toBe('');
  });

  it.each(['/api/universe/console', '/api/universe', `/api/universe/graph?universeId=${UNIVERSE_ID}`,
    '/api/universe/controller-status?controllerId=same-console-controller',
    '/api/universe/campaign-readiness?campaignId=same-console-campaign'])(
    'requires read authority for %s', async (path) => {
      expect((await http(a, path)).status).toBe(401);
      expect((await http(a, path, { headers: { 'x-ashlr-token': 'wrong' } })).status).toBe(401);
      expect((await http(a, path, { headers: authorized(b) })).status).toBe(401);
      expect((await http(a, path, { headers: authorized(a) })).status).toBe(200);
    });

  it('pins metadata and same-id observations to the selected store across two live servers', async () => {
    const metadata = await http(a, '/api/universe/console', { headers: authorized(a) });
    expect(JSON.parse(metadata.body)).toEqual({ schemaVersion: 1, mode: 'universe', root: alpha.root, readOnly: true });
    for (const [handle, own, other] of [[a, alpha, beta], [b, beta, alpha]] as const) {
      const result = await http(handle, '/api/universe', { headers: authorized(handle) });
      expect(result.status).toBe(200); expect(result.body).toContain(own.marker); expect(result.body).not.toContain(other.marker);
      const overview = JSON.parse(result.body);
      expect(overview.sourceState).toBe('healthy'); expect(overview.universes).toHaveLength(1);
      expect(overview.universes[0].runs).toEqual([]); expect(overview.universes[0].activeRun).toBeNull();
      expect(overview.campaigns).toHaveLength(1); expect(overview.campaigns[0].state).toBe('ready');
      const graph = await http(handle, `/api/universe/graph?universeId=${UNIVERSE_ID}`, { headers: authorized(handle) });
      expect(graph.status).toBe(200); expect(graph.body).toContain(own.revision); expect(graph.body).not.toContain(other.revision);
      expect(JSON.parse(graph.body)).toMatchObject({ sourceState: 'healthy', complete: true, universeId: UNIVERSE_ID });
    }
  });

  it.each(['/api/universe?root=other', '/api/universe/console?root=other', '/health?root=other',
    `/api/universe/graph?universeId=${UNIVERSE_ID}&root=other`,
    `/api/universe/graph?universeId=${UNIVERSE_ID}&universeId=${UNIVERSE_ID}`,
    '/api/universe/graph', '/api/universe/graph?universeId='])('rejects undeclared or repeated scope selectors: %s', async (path) => {
    const result = await http(a, path, { headers: authorized(a) });
    expect(result.status).toBe(400); expect(result.body).not.toContain(alpha.marker); expect(result.body).not.toContain(beta.marker);
  });

  it('reads recorded campaign readiness through the real worker with no private witnesses or execution authority', async () => {
    for (const handle of [a, b]) {
      const response = await http(handle, '/api/universe/campaign-readiness?campaignId=same-console-campaign', { headers: authorized(handle) });
      expect(response.status).toBe(200); expect(response.headers['cache-control']).toContain('no-store');
      const result = JSON.parse(response.body);
      expect(result).toEqual({ schemaVersion: 1, readinessScope: 'recorded-campaign-evidence',
        campaignId: 'same-console-campaign', universeId: UNIVERSE_ID, observedState: 'ready',
        sourceState: 'healthy', disposition: 'startable', reasonCode: 'never-started',
        resourceRuntimeRequired: false, sampledAt: expect.any(String) });
      expect(Number.isFinite(Date.parse(result.sampledAt))).toBe(true);
      for (const withheld of ['automaticAction', 'expectedIdentity', 'recordsDigest', alpha.root, beta.root, alpha.repo, beta.repo]) {
        expect(response.body).not.toContain(withheld);
      }
    }
    expect(snapshot(alpha.base)).toBe(beforeAlpha); expect(snapshot(beta.base)).toBe(beforeBeta);
  });

  it('never finds a campaign outside its pinned store or initializes a missing store', async () => {
    const root = join(temporary(), 'missing-readiness-store'); const handle = await start(root);
    const response = await http(handle, '/api/universe/campaign-readiness?campaignId=same-console-campaign', { headers: authorized(handle) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ campaignId: 'same-console-campaign', universeId: null,
      sourceState: 'missing', disposition: 'unavailable', reasonCode: 'campaign-missing', resourceRuntimeRequired: null });
    expect(existsSync(root)).toBe(false);
    await handle.close(); expect(existsSync(root)).toBe(false);
  });

  it.each(['/api/snapshot', '/api/config/effective', '/api/control', '/api/events', '/api/models', '/api/inbox',
    '/api/fleet', '/api/daemon-observation', '/api/run', '/api/health'])('withholds broader dashboard route %s even with read authority', async (path) => {
    const result = await http(a, path, { headers: authorized(a) });
    expect(result.status).toBe(404); expect(result.body).not.toContain(alpha.root); expect(result.body).not.toContain(a.readToken);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('never exposes a %s Universe mutation route', async (method) => {
    const result = await http(a, '/api/universe', { method, headers: authorized(a, { Origin: a.url }) });
    expect([404, 405]).toContain(result.status); expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['POST', 'DELETE', 'OPTIONS'])('withholds %s on the static console shell', async (method) => {
    const result = await http(a, '/universe/', { method, headers: authorized(a, { Origin: a.url }) });
    expect([404, 405]).toContain(result.status); expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['/', '/next', '/next/', '/next/index.html'])('withholds alternate general-dashboard HTML entry %s', async (path) => {
    expect((await http(a, path)).status).toBe(404);
  });

  it('requires the exact bound Host and present Origin while retaining native header reads', async () => {
    expect((await http(a, '/api/universe', { headers: authorized(a, { Host: `127.0.0.1:${b.port}` }) })).status).toBe(403);
    expect((await http(a, '/api/universe', { headers: authorized(a, { Origin: b.url }) })).status).toBe(403);
    expect((await http(a, '/api/universe', { headers: authorized(a, { Origin: 'null' }) })).status).toBe(403);
    expect((await http(a, '/api/universe', { headers: authorized(a, { Origin: 'https://example.invalid' }) })).status).toBe(403);
    expect((await http(a, '/api/universe', { headers: authorized(a, { Origin: a.url }) })).status).toBe(200);
    expect((await http(a, '/api/universe', { headers: authorized(a) })).status).toBe(200);
  });

  it('uses independent cookie names and signer/client bindings for simultaneous consoles', async () => {
    const one = await session(a); const two = await session(b);
    expect(one.cookie.split('=')[0]).not.toBe(two.cookie.split('=')[0]);
    expect((await http(a, '/api/universe', { headers: one.headers })).status).toBe(200);
    expect((await http(b, '/api/universe', { headers: two.headers })).status).toBe(200);
    expect((await http(a, '/api/universe', { headers: two.headers })).status).toBe(401);
    expect((await http(b, '/api/universe', { headers: one.headers })).status).toBe(401);
    expect((await http(a, '/api/universe', { headers: { Cookie: one.cookie } })).status).toBe(401);
    expect((await http(a, '/api/universe', { headers: { ...one.headers, 'x-ashlr-read-client': two.proof } })).status).toBe(401);
    const combined = `${one.cookie}; ${two.cookie}`;
    expect((await http(a, '/api/universe', { headers: { Cookie: combined, 'x-ashlr-read-client': one.proof } })).status).toBe(200);
    expect((await http(b, '/api/universe', { headers: { Cookie: combined, 'x-ashlr-read-client': two.proof } })).status).toBe(200);
  });

  it('revokes a logged-out read session without invalidating a separate session', async () => {
    const loggedOut = await session(a); const retained = await session(a);
    const response = await http(a, '/api/session', { method: 'DELETE', headers: { ...loggedOut.headers, Origin: a.url } });
    expect(response.status).toBe(204); expect(response.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect((await http(a, '/api/universe', { headers: loggedOut.headers })).status).toBe(401);
    expect((await http(a, '/api/universe', { headers: retained.headers })).status).toBe(200);
  });

  it('does not let a browser exchange a session from a different Origin', async () => {
    const result = await http(a, '/api/session', { method: 'POST', headers: authorized(a, {
      'x-ashlr-read-client': randomBytes(32).toString('hex'), Origin: b.url,
    }) });
    expect(result.status).toBe(403); expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('reads an absent explicit root without creating it or falling back to another store', async () => {
    const root = join(temporary(), 'missing'); const handle = await start(root);
    const result = await http(handle, '/api/universe', { headers: authorized(handle) });
    expect(result.status).toBe(200); expect(JSON.parse(result.body)).toMatchObject({ sourceState: 'missing', universes: [] });
    const graph = await http(handle, `/api/universe/graph?universeId=${UNIVERSE_ID}`, { headers: authorized(handle) });
    expect(graph.status).toBe(200); expect(JSON.parse(graph.body).sourceState).toBe('missing');
    await handle.close(); expect(existsSync(root)).toBe(false);
  });

  it('reports invalid existing scope as degraded without repairing or replacing it', async () => {
    const root = join(temporary(), 'not-a-store'); const bytes = Buffer.from('Private inert non-directory fixture');
    writeFileSync(root, bytes, { mode: 0o600, flag: 'wx' });
    const handle = await start(root);
    const response = await http(handle, '/api/universe', { headers: authorized(handle) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sourceState: 'degraded', universes: [] });
    expect(response.body).not.toContain(alpha.marker); expect(response.body).not.toContain(beta.marker);
    await handle.close(); expect(readFileSync(root)).toEqual(bytes);
  });

  it('settles close, permits same-port restart, and rejects old process credentials', async () => {
    const root = join(temporary(), 'missing'); const previous = await start(root); const credentials = await session(previous);
    await previous.close(); await previous.close();
    await expect(http(previous, '/health')).rejects.toThrow();
    const next = await start(root, previous.port);
    expect(next.readToken).not.toBe(previous.readToken);
    expect((await http(next, '/api/universe', { headers: authorized(previous) })).status).toBe(401);
    expect((await http(next, '/api/universe', { headers: credentials.headers })).status).toBe(401);
    expect((await http(next, '/api/universe', { headers: authorized(next) })).status).toBe(200);
    await next.close(); expect(existsSync(root)).toBe(false);
  });

  it('fails an occupied-port bind without creating the explicit missing root', async () => {
    const root = join(temporary(), 'missing'); const blocker: TcpServer = createTcpServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
      const address = blocker.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
      await expect(startUniverseConsoleServer({ root, port: address.port })).rejects.toThrow();
      expect(existsSync(root)).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())); }
  });

  it.each(['relative-universe', '/', '/private/tmp/invalid\nconsole-root'])('rejects an invalid root before binding: %j', async (root) => {
    await expect(startUniverseConsoleServer({ root, port: 0 })).rejects.toThrow();
  });

  it('leaves both fixture stores, ledgers and seed repositories byte-for-byte unchanged', async () => {
    await http(a, '/api/universe', { headers: authorized(a) });
    await http(b, '/api/universe', { headers: authorized(b) });
    expect(snapshot(alpha.base)).toBe(beforeAlpha); expect(snapshot(beta.base)).toBe(beforeBeta);
  });
});
