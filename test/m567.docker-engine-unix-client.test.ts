import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_OS_DOCKER_ENGINE_API_VERSION_V1,
  AgentOsDockerEngineClientV1,
  agentOsDockerContainerNameV1,
  agentOsDockerOutputEvidenceDigestV1,
  agentOsDockerResponseFrameLimitV1,
} from '../src/core/daemon/agent-os-docker-engine-client.js';
import {
  buildAgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerCreatePolicyV1,
} from '../src/core/vision/agent-os-local-container-policy.js';

const raw = (label: string): string => createHash('sha256').update(`m567-docker\0${label}`).digest('hex');
const CONTAINER_ID = raw('container');
const SECCOMP = Buffer.from('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}', 'utf8');
const SECCOMP_DIGEST = createHash('sha256').update(SECCOMP).digest('hex');

function policy(): AgentOsLocalContainerCreatePolicyV1 {
  const inspected = buildAgentOsLocalContainerCreatePolicyV1({
    image: `ghcr.io/ashlrai/agent-os-observer@sha256:${raw('image')}`,
    producerDigest: raw('producer'),
    allowedProducerDigests: [raw('producer')],
    user: '65532:65532',
    workingDir: '/workspace',
    seccompProfileDigest: SECCOMP_DIGEST,
    limits: {
      cpuNanoCpus: 500_000_000,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      pidsLimit: 1,
      maxDurationMs: 60_000,
      maxOutputBytes: 1024,
      cleanupStartGraceMs: 1_000,
    },
  });
  if (!inspected.policy) throw new Error('policy fixture failed');
  return inspected.policy;
}

interface Fixture {
  root: string;
  socketPath: string;
  server: Server;
  requests: Array<{ method: string; url: string; body: Buffer }>;
  createdBody: Record<string, unknown> | null;
  removed: boolean;
  mismatchEnvironment: boolean;
}

const fixtures: Fixture[] = [];

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.byteLength) });
  response.end(body);
}

function frame(stream: 1 | 2, value: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(value.byteLength, 4);
  return Buffer.concat([header, Buffer.from(value)]);
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m567-docker-'));
  chmodSync(root, 0o700);
  const socketPath = join(root, 'engine.sock');
  const requests: Fixture['requests'] = [];
  const state: Omit<Fixture, 'root' | 'socketPath' | 'server' | 'requests'> = {
    createdBody: null,
    removed: false,
    mismatchEnvironment: false,
  };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? '', url: request.url ?? '', body });
    const prefix = `/v${AGENT_OS_DOCKER_ENGINE_API_VERSION_V1}`;
    if (request.method === 'GET' && request.url === `${prefix}/version`) {
      json(response, 200, {
        ApiVersion: AGENT_OS_DOCKER_ENGINE_API_VERSION_V1,
        MinAPIVersion: '1.40',
        Version: '29.4.0',
        GitCommit: 'fixture',
        Os: 'linux',
        Arch: 'arm64',
      });
      return;
    }
    if (request.method === 'POST' && request.url?.startsWith(`${prefix}/containers/create?name=`)) {
      state.createdBody = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      json(response, 201, { Id: CONTAINER_ID, Warnings: [] });
      return;
    }
    if (request.method === 'GET' && request.url === `${prefix}/containers/${CONTAINER_ID}/json`) {
      if (state.removed) { json(response, 404, { message: 'not found' }); return; }
      const created = state.createdBody;
      if (!created) { json(response, 404, { message: 'not found' }); return; }
      const name = decodeURIComponent(requests.find((entry) => entry.url.includes('/containers/create?name='))!
        .url.split('name=')[1]!);
      json(response, 200, {
        Id: CONTAINER_ID,
        Name: `/${name}`,
        Config: {
          Image: created['Image'], Entrypoint: created['Entrypoint'], Cmd: created['Cmd'],
          User: created['User'], WorkingDir: created['WorkingDir'],
          Env: state.mismatchEnvironment ? ['SECRET=leak'] : created['Env'],
          Labels: created['Labels'], Healthcheck: created['Healthcheck'],
          NetworkDisabled: created['NetworkDisabled'], ExposedPorts: null,
        },
        HostConfig: created['HostConfig'],
        Mounts: [],
        NetworkSettings: { Networks: { none: {} } },
        State: {
          Running: false, OOMKilled: false, ExitCode: 0,
          StartedAt: '2026-09-04T18:00:01.000Z', FinishedAt: '2026-09-04T18:00:02.000Z',
        },
      });
      return;
    }
    if (request.method === 'POST' && request.url === `${prefix}/containers/${CONTAINER_ID}/start`) {
      response.writeHead(204); response.end(); return;
    }
    if (request.method === 'POST' && request.url ===
      `${prefix}/containers/${CONTAINER_ID}/wait?condition=not-running`) {
      json(response, 200, { StatusCode: 0 }); return;
    }
    if (request.method === 'POST' && request.url === `${prefix}/containers/${CONTAINER_ID}/kill?signal=KILL`) {
      response.writeHead(204); response.end(); return;
    }
    if (request.method === 'DELETE' && request.url ===
      `${prefix}/containers/${CONTAINER_ID}?force=true&v=false`) {
      state.removed = true; response.writeHead(204); response.end(); return;
    }
    json(response, 404, { message: 'unexpected endpoint' });
  });
  server.on('upgrade', (request, socket) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', body: Buffer.alloc(0) });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.once('data', () => {
      socket.write(frame(2, Buffer.from('warning', 'utf8')));
      const stdout = Buffer.from('{"ok":true}\n', 'utf8');
      socket.write(frame(1, stdout.subarray(0, 5)));
      socket.end(frame(1, stdout.subarray(5)));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolveListen());
  });
  const value: Fixture = { root, socketPath, server, requests, ...state };
  Object.defineProperties(value, {
    createdBody: { get: () => state.createdBody, set: (next) => { state.createdBody = next; } },
    removed: { get: () => state.removed, set: (next) => { state.removed = next; } },
    mismatchEnvironment: {
      get: () => state.mismatchEnvironment,
      set: (next) => { state.mismatchEnvironment = next; },
    },
  });
  fixtures.push(value);
  return value;
}

function client(value: Fixture, enabled = true): AgentOsDockerEngineClientV1 {
  return new AgentOsDockerEngineClientV1({
    anchorPath: value.root,
    socketPath: value.socketPath,
    enabled,
    requestTimeoutMs: 1_000,
  });
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await new Promise<void>((resolveClose) => value.server.close(() => resolveClose()));
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe('M567 constrained Docker Engine Unix client', () => {
  it('is default-off and rejects socket aliases without connecting', async () => {
    const value = await fixture();
    expect(await client(value, false).inspectEngine()).toEqual({ ok: false, reason: 'disabled' });
    expect(value.requests).toHaveLength(0);
    const alias = join(value.root, 'alias.sock');
    symlinkSync(value.socketPath, alias);
    const unsafe = new AgentOsDockerEngineClientV1({
      anchorPath: value.root, socketPath: alias, enabled: true,
    });
    expect(await unsafe.inspectEngine()).toEqual({ ok: false, reason: 'unsafe-socket' });
    expect(value.requests).toHaveLength(0);
  });

  it('maps only the exact no-effect policy and verifies the effective pre-start state', async () => {
    const value = await fixture();
    const engine = client(value);
    const observed = await engine.inspectEngine();
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(await engine.inspectEngine(observed.value.engineDigest)).toMatchObject({ ok: true });
    expect(await engine.inspectEngine(raw('wrong-engine'))).toEqual({ ok: false, reason: 'engine-mismatch' });
    const name = agentOsDockerContainerNameV1(Buffer.alloc(32, 0x57).toString('base64url'))!;
    const created = await engine.createContainer(name, policy(), SECCOMP);
    expect(created).toMatchObject({ ok: true, value: { containerId: CONTAINER_ID } });
    expect(value.createdBody).toMatchObject({
      Image: policy().image,
      Entrypoint: ['/opt/ashlr/bin/agent-os-observation-producer'],
      Cmd: ['--stdio'], Env: [], Labels: {}, Healthcheck: { Test: ['NONE'] },
      HostConfig: {
        NetworkMode: 'none', PidMode: 'private', IpcMode: 'private', UtsMode: 'private',
        CgroupnsMode: 'private', Privileged: false, CapAdd: [], CapDrop: ['ALL'],
        ReadonlyRootfs: true, Mounts: [], Binds: [], PortBindings: {}, Devices: [],
        DeviceRequests: [], PublishAllPorts: false, AutoRemove: false, Init: false,
      },
    });
    expect(JSON.stringify(value.createdBody)).not.toContain('/var/run/docker.sock');
    expect(JSON.stringify(value.createdBody)).not.toContain('DOCKER_HOST');
    expect(JSON.stringify(value.createdBody)).not.toContain('SECRET=');
    expect(await engine.inspectContainer({
      containerId: CONTAINER_ID, containerName: name, policy: policy(), seccompProfile: SECCOMP,
    })).toMatchObject({ ok: true, value: { effectivePolicyMatched: true, running: false } });
    value.mismatchEnvironment = true;
    expect(await engine.inspectContainer({
      containerId: CONTAINER_ID, containerName: name, policy: policy(), seccompProfile: SECCOMP,
    })).toEqual({ ok: false, reason: 'container-policy-mismatch' });
  });

  it('performs the bounded typed lifecycle without exposing a generic Docker request surface', async () => {
    const value = await fixture();
    const engine = client(value);
    const name = agentOsDockerContainerNameV1(Buffer.alloc(32, 0x41).toString('base64url'))!;
    expect(await engine.createContainer(name, policy(), SECCOMP)).toMatchObject({ ok: true });
    expect(await engine.startContainer(CONTAINER_ID)).toEqual({ ok: true, value: true });
    expect(await engine.waitContainer(CONTAINER_ID, 1_000)).toMatchObject({
      ok: true, value: { statusCode: 0 },
    });
    expect(await engine.killContainer(CONTAINER_ID)).toEqual({ ok: true, value: true });
    expect(await engine.removeContainer(CONTAINER_ID)).toEqual({ ok: true, value: true });
    expect(await engine.confirmContainerAbsent(CONTAINER_ID)).toEqual({ ok: true, value: true });
    expect(value.requests.map(({ method, url }) => `${method} ${url}`)).toEqual(expect.arrayContaining([
      `POST /v1.54/containers/${CONTAINER_ID}/start`,
      `POST /v1.54/containers/${CONTAINER_ID}/wait?condition=not-running`,
      `POST /v1.54/containers/${CONTAINER_ID}/kill?signal=KILL`,
      `DELETE /v1.54/containers/${CONTAINER_ID}?force=true&v=false`,
      `GET /v1.54/containers/${CONTAINER_ID}/json`,
    ]));
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(engine))).not.toContain('request');
  });

  it('parses fragmented Docker multiplex frames and bounds stdout/stderr transport', async () => {
    const value = await fixture();
    const engine = client(value);
    const attached = await engine.openAttachment(CONTAINER_ID, 1024);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value.writeAndClose(Buffer.from('{"request":true}\n'))).toBe(true);
    const captured = await attached.value.completion;
    expect(captured).toMatchObject({
      ok: true,
      value: { stderrBytes: 7, transportBytes: 43, truncated: false },
    });
    if (captured.ok) {
      expect(Buffer.from(captured.value.stdout).toString('utf8')).toBe('{"ok":true}\n');
      expect(captured.value.stderrDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(agentOsDockerOutputEvidenceDigestV1(captured.value.stdout)).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(agentOsDockerResponseFrameLimitV1(2 * 1024 * 1024)).toBeLessThan(3 * 1024 * 1024);
    expect(agentOsDockerResponseFrameLimitV1(0)).toBeNull();
  });

  it('rejects invalid names, mismatched seccomp bytes, identifiers, and wait bounds before I/O', async () => {
    const value = await fixture();
    const engine = client(value);
    expect(await engine.createContainer('not-ashlr', policy(), SECCOMP)).toEqual({
      ok: false, reason: 'invalid-input',
    });
    expect(await engine.createContainer(
      agentOsDockerContainerNameV1(Buffer.alloc(32, 0x33).toString('base64url'))!,
      policy(),
      Buffer.from('{}'),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(await engine.startContainer('bad')).toEqual({ ok: false, reason: 'invalid-input' });
    expect(await engine.waitContainer(CONTAINER_ID, 0)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(value.requests).toHaveLength(0);
  });
});
