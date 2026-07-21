/**
 * M299 — web fleet pause/resume controls.
 *
 * Contract:
 *   - Fleet mutation routes do not exist unless the server was started with
 *     --allow-dispatch.
 *   - When enabled, they use the same token + JSON content-type gate as other
 *     operator mutations.
 *   - Valid pause/resume toggles the kill switch and is reflected by GET
 *     /api/fleet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const serviceMocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  install: vi.fn(),
  serviceStatus: vi.fn(),
}));

vi.mock('../src/core/daemon/service.js', () => ({
  ensureRunning: serviceMocks.ensureRunning,
  install: serviceMocks.install,
  serviceStatus: serviceMocks.serviceStatus,
  serviceStatusCached: serviceMocks.serviceStatus,
}));

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { startServer } from '../src/core/web/server.js';
import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';
import type { WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let openHandles: Array<{ close(): Promise<void> }> = [];
let operationSequence = 0;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${String(operationSequence).padStart(12, '0')}`;
}

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  openHandles = [];
  operationSequence = 0;
  serviceMocks.ensureRunning.mockReset();
  serviceMocks.install.mockReset();
  serviceMocks.serviceStatus.mockReset();
  serviceMocks.ensureRunning.mockResolvedValue({
    installed: true,
    running: true,
    platformSpec: 'launchd',
    serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
  });
  serviceMocks.serviceStatus.mockReturnValue({
    installed: true,
    running: true,
    platformSpec: 'launchd',
    serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
  });
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  try { setKill(false); } catch { /* ignore */ }
  fx.cleanup();
});

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

function request(
  method: string,
  url: string,
  port: number,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(method === 'POST' && headers['x-ashlr-operation-id'] === undefined
            ? { 'x-ashlr-operation-id': operationId() }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('POST /api/fleet/pause|resume', () => {
  it('requires a bounded operation id after the token and JSON gate', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const missing = await request(
      'POST', `${h.url}/api/fleet/pause`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token, 'x-ashlr-operation-id': '' }, '{}',
    );
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: expect.stringContaining('operation-id') });
    expect(killSwitchOn()).toBe(false);
  });

  it('replays one service repair receipt without a second service mutation', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);
    const id = operationId();
    const headers = { ...JSON_HEADERS, 'x-ashlr-token': h.token, 'x-ashlr-operation-id': id };

    const first = await request('POST', `${h.url}/api/daemon/service/repair`, h.port, headers, '{}');
    const replay = await request('POST', `${h.url}/api/daemon/service/repair`, h.port, headers, '{}');

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ replayed: false, receipt: { operationId: id } });
    expect(JSON.parse(replay.body)).toEqual(expect.objectContaining({
      ok: true,
      replayed: true,
      receipt: { operationId: id, route: '/api/daemon/service/repair', statusCode: 200 },
    }));
    expect(serviceMocks.install).toHaveBeenCalledTimes(1);
    expect(serviceMocks.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('rejects an operation-id replay with a different request and stores metadata only', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);
    const id = operationId();
    const headers = { ...JSON_HEADERS, 'x-ashlr-token': h.token, 'x-ashlr-operation-id': id };
    const secretGoal = 'do not persist this private goal';

    const first = await request(
      'POST', `${h.url}/api/daemon/service/repair`, h.port, headers,
      JSON.stringify({ goal: secretGoal, environment: 'private', path: '/private/never-persist' }),
    );
    const conflict = await request('POST', `${h.url}/api/run`, h.port, headers, JSON.stringify({ goal: secretGoal }));

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    const receipts = join(fx.ashlrDir, 'web-operation-receipts');
    expect(existsSync(receipts)).toBe(true);
    const persisted = readdirSync(receipts).map((file) => readFileSync(join(receipts, file), 'utf8')).join('\n');
    expect(persisted).toContain(id);
    expect(persisted).toContain('/api/daemon/service/repair');
    expect(persisted).not.toContain(secretGoal);
    expect(persisted).not.toContain(h.token);
    expect(persisted).not.toContain('{}');
    expect(persisted).not.toContain('/tmp/ai.ashlr.daemon.plist');
    expect(persisted).not.toContain('/private/never-persist');
  });

  it('rejects the same operation id when the JSON body changes', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);
    const id = operationId();
    const headers = { ...JSON_HEADERS, 'x-ashlr-token': h.token, 'x-ashlr-operation-id': id };

    const first = await request('POST', `${h.url}/api/fleet/pause`, h.port, headers, '{"reason":"maintenance"}');
    const conflict = await request('POST', `${h.url}/api/fleet/pause`, h.port, headers, '{"reason":"different"}');

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(killSwitchOn()).toBe(true);
  });

  it('returns 404 when dispatch controls are disabled', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);

    for (const action of ['pause', 'resume']) {
      const res = await request(
        'POST',
        `${h.url}/api/fleet/${action}`,
        h.port,
        { ...JSON_HEADERS, 'x-ashlr-token': h.token },
        '{}',
      );
      expect(res.statusCode).toBe(404);
    }
    expect(killSwitchOn()).toBe(false);
  });

  it('requires the operator token and JSON content type', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const wrongToken = await request(
      'POST',
      `${h.url}/api/fleet/pause`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': 'not-the-token' },
      '{}',
    );
    expect(wrongToken.statusCode).toBe(401);

    const wrongType = await request(
      'POST',
      `${h.url}/api/fleet/pause`,
      h.port,
      { 'Content-Type': 'text/plain', 'x-ashlr-token': h.token },
      '{}',
    );
    expect(wrongType.statusCode).toBe(415);
    expect(killSwitchOn()).toBe(false);
  });

  it('pauses and resumes the fleet and reflects state in GET /api/fleet', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const paused = await request(
      'POST',
      `${h.url}/api/fleet/pause`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token },
      '{}',
    );
    expect(paused.statusCode).toBe(200);
    expect(killSwitchOn()).toBe(true);
    expect((JSON.parse(paused.body) as { ok: boolean; fleet: { killed: boolean } }).fleet.killed).toBe(true);
    expect(serviceMocks.ensureRunning).not.toHaveBeenCalled();

    const fleetPaused = await request('GET', `${h.url}/api/fleet`, h.port);
    expect(fleetPaused.statusCode).toBe(200);
    const pausedFleet = JSON.parse(fleetPaused.body) as {
      killed: boolean;
      autonomyControlMode?: unknown;
      backends?: Array<{ resource?: { availability?: unknown } }>;
      autonomyDirection?: { mode?: unknown; resources?: unknown };
      missionBrief?: {
        directive?: unknown;
        whyNow?: unknown;
        evidence?: { readinessVerdict?: unknown };
      };
    };
    expect(pausedFleet.killed).toBe(true);
    expect(['disabled', 'advisory', 'executable']).toContain(pausedFleet.autonomyControlMode);
    expect(['open', 'near', 'throttled', 'exhausted', 'unreachable', 'unknown', 'not-sensed'])
      .toContain(pausedFleet.backends?.[0]?.resource?.availability);
    expect(typeof pausedFleet.autonomyDirection?.mode).toBe('string');
    expect(typeof pausedFleet.autonomyDirection?.resources).toBe('object');
    expect(pausedFleet.missionBrief?.directive).toBe('Resume the fleet');
    expect(pausedFleet.missionBrief?.evidence?.readinessVerdict).toBe('blocked');
    expect(typeof pausedFleet.missionBrief?.whyNow).toBe('string');

    const resumed = await request(
      'POST',
      `${h.url}/api/fleet/resume`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token },
      '{}',
    );
    expect(resumed.statusCode).toBe(200);
    expect(killSwitchOn()).toBe(false);
    const resumedBody = JSON.parse(resumed.body) as {
      ok: boolean;
      service?: { installed: boolean; running: boolean };
      fleet: { killed: boolean };
    };
    expect(resumedBody.fleet.killed).toBe(false);
    expect(resumedBody.service).toMatchObject({ installed: true, running: true });
    expect(serviceMocks.ensureRunning).toHaveBeenCalledWith({
      budget: 1,
      intervalMs: 100,
      parallel: 2,
      autostart: true,
    });

    const fleetResumed = await request('GET', `${h.url}/api/fleet`, h.port);
    expect(fleetResumed.statusCode).toBe(200);
    const resumedFleet = JSON.parse(fleetResumed.body) as {
      killed: boolean;
      autonomyControlMode?: unknown;
      autonomyDirection?: { mode?: unknown };
      missionBrief?: { directive?: unknown; whyNow?: unknown };
    };
    expect(resumedFleet.killed).toBe(false);
    expect(['disabled', 'advisory', 'executable']).toContain(resumedFleet.autonomyControlMode);
    expect(typeof resumedFleet.autonomyDirection?.mode).toBe('string');
    expect(typeof resumedFleet.missionBrief?.directive).toBe('string');
    expect(typeof resumedFleet.missionBrief?.whyNow).toBe('string');
  });
});

describe('GET/POST /api/daemon/service', () => {
  it('returns read-only daemon OS service health without a token', async () => {
    serviceMocks.serviceStatus.mockReturnValueOnce({
      installed: true,
      running: false,
      platformSpec: 'launchd',
      serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
    });
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/daemon/service`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      installed: boolean;
      running: boolean;
      platformSpec: string;
      serviceFilePath?: string;
    };
    expect(body.installed).toBe(true);
    expect(body.running).toBe(false);
    expect(body.platformSpec).toBe('launchd');
    expect(serviceMocks.install).not.toHaveBeenCalled();
  });

  it('hides daemon service repair unless dispatch controls are enabled', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);

    const res = await request(
      'POST',
      `${h.url}/api/daemon/service/repair`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token },
      '{}',
    );
    expect(res.statusCode).toBe(404);
    expect(serviceMocks.install).not.toHaveBeenCalled();
  });

  it('requires the operator token and JSON content type for service repair', async () => {
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const wrongToken = await request(
      'POST',
      `${h.url}/api/daemon/service/repair`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': 'bad' },
      '{}',
    );
    expect(wrongToken.statusCode).toBe(401);

    const wrongType = await request(
      'POST',
      `${h.url}/api/daemon/service/repair`,
      h.port,
      { 'Content-Type': 'text/plain', 'x-ashlr-token': h.token },
      '{}',
    );
    expect(wrongType.statusCode).toBe(415);
    expect(serviceMocks.install).not.toHaveBeenCalled();
  });

  it('repairs the daemon service using config-derived daemon settings', async () => {
    serviceMocks.serviceStatus.mockReturnValueOnce({
      installed: true,
      running: true,
      platformSpec: 'launchd',
      serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
    });

    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 7,
        intervalMs: 900_000,
        parallel: 3,
      },
    });
    const h = await startServer(cfg, makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const res = await request(
      'POST',
      `${h.url}/api/daemon/service/repair`,
      h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(serviceMocks.install).toHaveBeenCalledWith({
      budget: 7,
      intervalMs: 900_000,
      parallel: 3,
      autostart: true,
    });
    expect(serviceMocks.ensureRunning).toHaveBeenCalledWith({
      budget: 7,
      intervalMs: 900_000,
      parallel: 3,
      autostart: true,
    });
    const body = JSON.parse(res.body) as {
      ok: boolean;
      action: string;
      service: { installed: boolean; running: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe('repair');
    expect(body.service.installed).toBe(true);
    expect(body.service.running).toBe(true);
  });
});
