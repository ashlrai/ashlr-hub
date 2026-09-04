import { createHash } from 'node:crypto';
import { lstatSync, type BigIntStats } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { isProxy } from 'node:util/types';

import {
  AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1,
  agentOsLocalContainerCreatePolicyDigestV1,
  inspectAgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerCreatePolicyV1,
} from '../vision/agent-os-local-container-policy.js';

export const AGENT_OS_DOCKER_ENGINE_CLIENT_V1 = 'ashlr-agent-os-docker-engine-client-v1' as const;
export const AGENT_OS_DOCKER_ENGINE_API_VERSION_V1 = '1.54' as const;
export const AGENT_OS_DOCKER_ENGINE_MAX_JSON_BYTES_V1 = 1024 * 1024;
export const AGENT_OS_DOCKER_ENGINE_MAX_SECCOMP_BYTES_V1 = 64 * 1024;
export const AGENT_OS_DOCKER_ENGINE_MAX_STDERR_BYTES_V1 = 64 * 1024;
export const AGENT_OS_DOCKER_ENGINE_MAX_REQUEST_FRAME_BYTES_V1 = 3 * 1024 * 1024;
export const AGENT_OS_DOCKER_ENGINE_CONTROL_TIMEOUT_MS_V1 = 5_000;

const CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const CONTAINER_NAME_RE = /^ashlr-agent-os-[a-f0-9]{32}$/u;
const API_VERSION_RE = /^1\.[0-9]{2}$/u;
const RAW_DIGEST_RE = /^[a-f0-9]{64}$/u;
const MAX_REQUEST_TIMEOUT_MS = 6 * 60_000;

export type AgentOsDockerEngineClientReasonV1 =
  | 'disabled'
  | 'invalid-input'
  | 'unsafe-socket'
  | 'socket-replaced'
  | 'request-failed'
  | 'request-timed-out'
  | 'response-oversized'
  | 'response-invalid'
  | 'engine-mismatch'
  | 'container-not-found'
  | 'container-conflict'
  | 'container-policy-mismatch'
  | 'attach-failed'
  | 'attach-truncated';

export type AgentOsDockerEngineResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AgentOsDockerEngineClientReasonV1 };

export interface AgentOsDockerEngineIdentityV1 {
  engineDigest: string;
  apiVersion: string;
  minApiVersion: string;
  version: string;
  gitCommit: string;
  os: string;
  arch: string;
  socketDevice: string;
  socketInode: string;
}

export interface AgentOsDockerContainerCreateResultV1 {
  containerId: string;
  engineCreateRequestDigest: string;
}

export interface AgentOsDockerContainerInspectionV1 {
  containerId: string;
  containerName: string;
  inspectionDigest: string;
  effectivePolicyMatched: boolean;
  policyMismatchReasons: readonly string[];
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentOsDockerContainerWaitResultV1 {
  statusCode: number;
  waitEvidenceDigest: string;
}

export interface AgentOsDockerAttachCaptureV1 {
  stdout: Uint8Array;
  stderrBytes: number;
  stderrDigest: string;
  transportBytes: number;
  truncated: boolean;
}

export interface AgentOsDockerAttachmentV1 {
  writeAndClose(input: Uint8Array): boolean;
  abort(): void;
  completion: Promise<AgentOsDockerEngineResultV1<AgentOsDockerAttachCaptureV1>>;
}

export interface AgentOsDockerEngineClientDependenciesV1 {
  /** Existing trusted directory containing socketPath directly. */
  anchorPath: string;
  socketPath: string;
  /** Omission is disabled and performs no filesystem or socket I/O. */
  enabled?: boolean;
  apiVersion?: string;
  requestTimeoutMs?: number;
  expectedSocketOwnerUid?: number;
}

interface SocketIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
}

interface HttpResponse {
  statusCode: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export interface AgentOsDockerExpectedInspectionV1 {
  containerId: string;
  containerName: string;
  policy: AgentOsLocalContainerCreatePolicyV1;
  seccompProfile: Uint8Array;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function rawDigest(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update('\0', 'utf8')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function bytesDigest(domain: string, value: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update('\0', 'utf8')
    .update(Buffer.from(value)).digest('hex');
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(bytes: Buffer): Record<string, unknown> | null {
  try { return plainRecord(JSON.parse(bytes.toString('utf8'))); } catch { return null; }
}

function exactSocket(stat: BigIntStats, expectedUid: number): boolean {
  return stat.isSocket() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    stat.uid === BigInt(expectedUid) && (stat.mode & 0o022n) === 0n;
}

function exactDirectory(stat: BigIntStats, expectedUid: number): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.nlink >= 1n &&
    stat.uid === BigInt(expectedUid) && (stat.mode & 0o022n) === 0n;
}

function sameSocket(left: SocketIdentity, right: BigIntStats): boolean {
  return right.dev === left.dev && right.ino === left.ino && right.uid === left.uid &&
    right.mode === left.mode;
}

function timestampOrEmpty(value: unknown): { valid: boolean; value: string | null } {
  if (value === '') return { valid: true, value: null };
  if (typeof value !== 'string') return { valid: false, value: null };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? { valid: true, value }
    : { valid: false, value: null };
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function createRequestBody(
  policy: AgentOsLocalContainerCreatePolicyV1,
  seccompProfile: Uint8Array,
): Record<string, unknown> {
  return {
    Image: policy.image,
    Entrypoint: [AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1],
    Cmd: ['--stdio'],
    User: policy.user,
    WorkingDir: policy.workingDir,
    Env: [],
    Labels: {},
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Healthcheck: { Test: ['NONE'] },
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none',
      PidMode: 'private',
      IpcMode: 'private',
      UtsMode: 'private',
      CgroupnsMode: 'private',
      Privileged: false,
      CapAdd: [],
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges=true', `seccomp=${Buffer.from(seccompProfile).toString('utf8')}`],
      Mounts: [],
      Binds: [],
      PortBindings: {},
      PublishAllPorts: false,
      Devices: [],
      DeviceRequests: [],
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      LogConfig: { Type: 'none', Config: {} },
      NanoCpus: policy.limits.cpuNanoCpus,
      Memory: policy.limits.memoryBytes,
      MemorySwap: policy.limits.memorySwapBytes,
      PidsLimit: policy.limits.pidsLimit,
      AutoRemove: false,
      Init: false,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
}

function seccompAdmitted(profile: Uint8Array, expectedDigest: string): boolean {
  if (!(profile instanceof Uint8Array) || profile.byteLength < 2 ||
    profile.byteLength > AGENT_OS_DOCKER_ENGINE_MAX_SECCOMP_BYTES_V1 || !RAW_DIGEST_RE.test(expectedDigest) ||
    createHash('sha256').update(Buffer.from(profile)).digest('hex') !== expectedDigest) return false;
  try { return plainRecord(JSON.parse(Buffer.from(profile).toString('utf8'))) !== null; } catch { return false; }
}

function inspectEffectivePolicy(
  row: Record<string, unknown>,
  expected: AgentOsDockerExpectedInspectionV1,
): AgentOsDockerContainerInspectionV1 | null {
  const config = plainRecord(row['Config']);
  const host = plainRecord(row['HostConfig']);
  const state = plainRecord(row['State']);
  const network = plainRecord(row['NetworkSettings']);
  if (!config || !host || !state || !network || row['Id'] !== expected.containerId ||
    row['Name'] !== `/${expected.containerName}`) return null;
  const expectedSecurity = [
    'no-new-privileges=true',
    `seccomp=${Buffer.from(expected.seccompProfile).toString('utf8')}`,
  ];
  const mismatches: string[] = [];
  const check = (name: string, actual: unknown, wanted: unknown): void => {
    if (!equal(actual, wanted)) mismatches.push(name);
  };
  check('image', config['Image'], expected.policy.image);
  check('entrypoint', config['Entrypoint'], [AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1]);
  check('command', config['Cmd'], ['--stdio']);
  check('user', config['User'], expected.policy.user);
  check('working-directory', config['WorkingDir'], expected.policy.workingDir);
  check('environment', config['Env'] ?? [], []);
  check('labels', config['Labels'] ?? {}, {});
  check('healthcheck', config['Healthcheck'], { Test: ['NONE'] });
  check('network-disabled', config['NetworkDisabled'], true);
  check('network-mode', host['NetworkMode'], 'none');
  check('pid-mode', host['PidMode'], 'private');
  check('ipc-mode', host['IpcMode'], 'private');
  check('uts-mode', host['UtsMode'], 'private');
  check('cgroupns-mode', host['CgroupnsMode'], 'private');
  check('privileged', host['Privileged'], false);
  check('cap-add', host['CapAdd'] ?? [], []);
  check('cap-drop', host['CapDrop'], ['ALL']);
  check('readonly-rootfs', host['ReadonlyRootfs'], true);
  check('security-options', host['SecurityOpt'], expectedSecurity);
  check('mount-request', host['Mounts'] ?? [], []);
  check('binds', host['Binds'] ?? [], []);
  check('effective-mounts', row['Mounts'] ?? [], []);
  check('port-bindings', host['PortBindings'] ?? {}, {});
  check('published-ports', host['PublishAllPorts'], false);
  check('exposed-ports', config['ExposedPorts'] ?? {}, {});
  check('devices', host['Devices'] ?? [], []);
  check('device-requests', host['DeviceRequests'] ?? [], []);
  check('restart', host['RestartPolicy'], { Name: 'no', MaximumRetryCount: 0 });
  check('logging', host['LogConfig'], { Type: 'none', Config: {} });
  check('cpu', host['NanoCpus'], expected.policy.limits.cpuNanoCpus);
  check('memory', host['Memory'], expected.policy.limits.memoryBytes);
  check('memory-swap', host['MemorySwap'], expected.policy.limits.memorySwapBytes);
  check('pids', host['PidsLimit'], expected.policy.limits.pidsLimit);
  check('auto-remove', host['AutoRemove'], false);
  check('init', host['Init'] ?? false, false);
  const networks = plainRecord(network['Networks']);
  if (!networks || Object.keys(networks).length !== 1 || !Object.hasOwn(networks, 'none')) {
    mismatches.push('effective-networks');
  }
  const running = state['Running'];
  const oomKilled = state['OOMKilled'];
  const exitCode = state['ExitCode'];
  const startedAt = timestampOrEmpty(state['StartedAt']);
  const finishedAt = timestampOrEmpty(state['FinishedAt']);
  if (typeof running !== 'boolean' || typeof oomKilled !== 'boolean' || !startedAt.valid || !finishedAt.valid ||
    !Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255) return null;
  const selected = {
    containerId: expected.containerId,
    containerName: expected.containerName,
    config: {
      image: config['Image'], entrypoint: config['Entrypoint'], command: config['Cmd'],
      user: config['User'], workingDir: config['WorkingDir'], environment: config['Env'] ?? [],
      labels: config['Labels'] ?? {}, healthcheck: config['Healthcheck'],
    },
    host: {
      networkMode: host['NetworkMode'], pidMode: host['PidMode'], ipcMode: host['IpcMode'],
      utsMode: host['UtsMode'], cgroupnsMode: host['CgroupnsMode'], privileged: host['Privileged'],
      capAdd: host['CapAdd'] ?? [], capDrop: host['CapDrop'], readonlyRootfs: host['ReadonlyRootfs'],
      securityOpt: host['SecurityOpt'], mounts: host['Mounts'] ?? [], binds: host['Binds'] ?? [],
      portBindings: host['PortBindings'] ?? {}, devices: host['Devices'] ?? [],
      deviceRequests: host['DeviceRequests'] ?? [], restart: host['RestartPolicy'], log: host['LogConfig'],
      nanoCpus: host['NanoCpus'], memory: host['Memory'], memorySwap: host['MemorySwap'],
      pidsLimit: host['PidsLimit'], autoRemove: host['AutoRemove'], init: host['Init'] ?? false,
    },
    effectiveMounts: row['Mounts'] ?? [],
    networks: networks ?? {},
    state: {
      running, oomKilled, exitCode,
      startedAt: state['StartedAt'], finishedAt: state['FinishedAt'],
    },
  };
  return Object.freeze({
    containerId: expected.containerId,
    containerName: expected.containerName,
    inspectionDigest: rawDigest('ashlr.agent-os.docker-container-inspection.v1', selected),
    effectivePolicyMatched: mismatches.length === 0,
    policyMismatchReasons: Object.freeze([...mismatches]),
    running,
    exitCode: exitCode as number,
    oomKilled,
    startedAt: startedAt.value,
    finishedAt: finishedAt.value,
  });
}

export class AgentOsDockerEngineClientV1 {
  readonly #anchorPath: string;
  readonly #socketPath: string;
  readonly #enabled: boolean;
  readonly #apiVersion: string;
  readonly #requestTimeoutMs: number;
  readonly #expectedUid: number;

  constructor(dependencies: AgentOsDockerEngineClientDependenciesV1) {
    const anchorPath = ownValue(dependencies, 'anchorPath');
    const socketPath = ownValue(dependencies, 'socketPath');
    const enabled = ownValue(dependencies, 'enabled');
    const apiVersion = ownValue(dependencies, 'apiVersion');
    const requestTimeoutMs = ownValue(dependencies, 'requestTimeoutMs');
    const expectedSocketOwnerUid = ownValue(dependencies, 'expectedSocketOwnerUid');
    this.#anchorPath = typeof anchorPath === 'string' ? anchorPath : '';
    this.#socketPath = typeof socketPath === 'string' ? socketPath : '';
    this.#enabled = enabled === true;
    // A caller may restate the protocol version, but cannot widen or swap it.
    this.#apiVersion = apiVersion === undefined || apiVersion === AGENT_OS_DOCKER_ENGINE_API_VERSION_V1
      ? AGENT_OS_DOCKER_ENGINE_API_VERSION_V1
      : '';
    this.#requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs)
      ? Math.max(1, Math.min(AGENT_OS_DOCKER_ENGINE_CONTROL_TIMEOUT_MS_V1, requestTimeoutMs as number))
      : AGENT_OS_DOCKER_ENGINE_CONTROL_TIMEOUT_MS_V1;
    this.#expectedUid = expectedSocketOwnerUid === undefined
      ? (typeof process.getuid === 'function' ? process.getuid() : -1)
      : Number.isSafeInteger(expectedSocketOwnerUid) ? expectedSocketOwnerUid as number : -1;
  }

  #preflightSocket(): AgentOsDockerEngineResultV1<SocketIdentity> {
    if (!this.#enabled) return { ok: false, reason: 'disabled' };
    try {
      if (process.platform === 'win32' || !isAbsolute(this.#anchorPath) ||
        !isAbsolute(this.#socketPath) || resolve(this.#anchorPath) !== this.#anchorPath ||
        resolve(this.#socketPath) !== this.#socketPath || this.#anchorPath === parse(this.#anchorPath).root ||
        dirname(this.#socketPath) !== this.#anchorPath ||
        this.#apiVersion !== AGENT_OS_DOCKER_ENGINE_API_VERSION_V1 ||
        !Number.isSafeInteger(this.#expectedUid) || this.#expectedUid < 0) {
        return { ok: false, reason: 'invalid-input' };
      }
      const anchor = lstatSync(this.#anchorPath, { bigint: true });
      const socket = lstatSync(this.#socketPath, { bigint: true });
      if (!exactDirectory(anchor, this.#expectedUid) || !exactSocket(socket, this.#expectedUid)) {
        return { ok: false, reason: 'unsafe-socket' };
      }
      return { ok: true, value: { dev: socket.dev, ino: socket.ino, uid: socket.uid, mode: socket.mode } };
    } catch {
      return { ok: false, reason: 'unsafe-socket' };
    }
  }

  async #request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: Buffer | null,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<AgentOsDockerEngineResultV1<HttpResponse>> {
    const socket = this.#preflightSocket();
    if (!socket.ok) return socket;
    if (!path.startsWith(`/v${this.#apiVersion}/`) || path.includes('..') || path.includes('\0') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      return { ok: false, reason: 'invalid-input' };
    }
    return new Promise((resolveResult) => {
      let settled = false;
      const finish = (value: AgentOsDockerEngineResultV1<HttpResponse>): void => {
        if (!settled) { settled = true; resolveResult(value); }
      };
      const request = httpRequest({
        socketPath: this.#socketPath,
        method,
        path,
        headers: body ? {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
        } : undefined,
      });
      const timer = setTimeout(() => {
        request.destroy();
        finish({ ok: false, reason: 'request-timed-out' });
      }, timeoutMs);
      request.once('socket', (connected) => {
        connected.once('connect', () => {
          try {
            const current = lstatSync(this.#socketPath, { bigint: true });
            if (!sameSocket(socket.value, current)) {
              request.destroy();
              clearTimeout(timer);
              finish({ ok: false, reason: 'socket-replaced' });
            }
          } catch {
            request.destroy();
            clearTimeout(timer);
            finish({ ok: false, reason: 'socket-replaced' });
          }
        });
      });
      request.once('response', (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > AGENT_OS_DOCKER_ENGINE_MAX_JSON_BYTES_V1) {
            response.destroy();
            clearTimeout(timer);
            finish({ ok: false, reason: 'response-oversized' });
          } else {
            chunks.push(Buffer.from(chunk));
          }
        });
        response.once('end', () => {
          clearTimeout(timer);
          finish({ ok: true, value: {
            statusCode: response.statusCode ?? 0,
            headers: { ...response.headers },
            body: Buffer.concat(chunks),
          } });
        });
        response.once('error', () => {
          clearTimeout(timer);
          finish({ ok: false, reason: 'request-failed' });
        });
      });
      request.once('error', () => {
        clearTimeout(timer);
        finish({ ok: false, reason: 'request-failed' });
      });
      if (body) request.end(body); else request.end();
    });
  }

  async inspectEngine(expectedEngineDigest?: string): Promise<AgentOsDockerEngineResultV1<AgentOsDockerEngineIdentityV1>> {
    const response = await this.#request('GET', `/v${this.#apiVersion}/version`, null);
    if (!response.ok) return response;
    if (response.value.statusCode !== 200) return { ok: false, reason: 'response-invalid' };
    const row = parseJsonRecord(response.value.body);
    const socket = this.#preflightSocket();
    if (!row || !socket.ok || !['ApiVersion', 'MinAPIVersion', 'Version', 'GitCommit', 'Os', 'Arch']
      .every((key) => typeof row[key] === 'string')) return { ok: false, reason: 'response-invalid' };
    const selected = {
      apiVersion: row['ApiVersion'] as string,
      minApiVersion: row['MinAPIVersion'] as string,
      version: row['Version'] as string,
      gitCommit: row['GitCommit'] as string,
      os: row['Os'] as string,
      arch: row['Arch'] as string,
      socketDevice: socket.value.dev.toString(10),
      socketInode: socket.value.ino.toString(10),
    };
    if (selected.apiVersion !== this.#apiVersion || !API_VERSION_RE.test(selected.minApiVersion)) {
      return { ok: false, reason: 'engine-mismatch' };
    }
    const engineDigest = rawDigest('ashlr.agent-os.docker-engine-identity.v1', selected);
    if (expectedEngineDigest !== undefined && expectedEngineDigest !== engineDigest) {
      return { ok: false, reason: 'engine-mismatch' };
    }
    return { ok: true, value: Object.freeze({ engineDigest, ...selected }) };
  }

  async createContainer(
    containerName: string,
    policy: AgentOsLocalContainerCreatePolicyV1,
    seccompProfile: Uint8Array,
  ): Promise<AgentOsDockerEngineResultV1<AgentOsDockerContainerCreateResultV1>> {
    const inspected = inspectAgentOsLocalContainerCreatePolicyV1(policy);
    if (!CONTAINER_NAME_RE.test(containerName) || inspected.state !== 'admitted' ||
      !inspected.policy || agentOsLocalContainerCreatePolicyDigestV1(policy) !== inspected.createConfigDigest ||
      !seccompAdmitted(seccompProfile, policy.seccompProfileDigest)) {
      return { ok: false, reason: 'invalid-input' };
    }
    const bodyValue = createRequestBody(inspected.policy, seccompProfile);
    const body = Buffer.from(JSON.stringify(bodyValue), 'utf8');
    const response = await this.#request(
      'POST',
      `/v${this.#apiVersion}/containers/create?name=${encodeURIComponent(containerName)}`,
      body,
    );
    if (!response.ok) return response;
    if (response.value.statusCode === 409) return { ok: false, reason: 'container-conflict' };
    if (response.value.statusCode !== 201) return { ok: false, reason: 'response-invalid' };
    const row = parseJsonRecord(response.value.body);
    if (!row || typeof row['Id'] !== 'string' || !CONTAINER_ID_RE.test(row['Id']) ||
      !(row['Warnings'] === null || (Array.isArray(row['Warnings']) && row['Warnings'].length === 0))) {
      return { ok: false, reason: 'response-invalid' };
    }
    return { ok: true, value: Object.freeze({
      containerId: row['Id'],
      engineCreateRequestDigest: rawDigest('ashlr.agent-os.docker-create-request.v1', bodyValue),
    }) };
  }

  async inspectContainer(expected: AgentOsDockerExpectedInspectionV1):
  Promise<AgentOsDockerEngineResultV1<AgentOsDockerContainerInspectionV1>> {
    if (!CONTAINER_ID_RE.test(expected.containerId) || !CONTAINER_NAME_RE.test(expected.containerName) ||
      !seccompAdmitted(expected.seccompProfile, expected.policy.seccompProfileDigest)) {
      return { ok: false, reason: 'invalid-input' };
    }
    const response = await this.#request(
      'GET', `/v${this.#apiVersion}/containers/${expected.containerId}/json`, null,
    );
    if (!response.ok) return response;
    if (response.value.statusCode === 404) return { ok: false, reason: 'container-not-found' };
    if (response.value.statusCode !== 200) return { ok: false, reason: 'response-invalid' };
    const row = parseJsonRecord(response.value.body);
    const inspection = row ? inspectEffectivePolicy(row, expected) : null;
    if (!inspection) return { ok: false, reason: 'response-invalid' };
    if (!inspection.effectivePolicyMatched) {
      return { ok: false, reason: 'container-policy-mismatch' };
    }
    return { ok: true, value: inspection };
  }

  async resolveContainerIdByName(containerName: string): Promise<AgentOsDockerEngineResultV1<string>> {
    if (!CONTAINER_NAME_RE.test(containerName)) return { ok: false, reason: 'invalid-input' };
    const response = await this.#request(
      'GET', `/v${this.#apiVersion}/containers/${encodeURIComponent(containerName)}/json`, null,
    );
    if (!response.ok) return response;
    if (response.value.statusCode === 404) return { ok: false, reason: 'container-not-found' };
    if (response.value.statusCode !== 200) return { ok: false, reason: 'response-invalid' };
    const row = parseJsonRecord(response.value.body);
    return row && typeof row['Id'] === 'string' && CONTAINER_ID_RE.test(row['Id']) &&
      row['Name'] === `/${containerName}`
      ? { ok: true, value: row['Id'] }
      : { ok: false, reason: 'response-invalid' };
  }

  async startContainer(containerId: string): Promise<AgentOsDockerEngineResultV1<true>> {
    return this.#emptySuccess('POST', containerId, 'start', 204);
  }

  async killContainer(containerId: string): Promise<AgentOsDockerEngineResultV1<true>> {
    return this.#emptySuccess('POST', containerId, 'kill?signal=KILL', 204);
  }

  async removeContainer(containerId: string): Promise<AgentOsDockerEngineResultV1<true>> {
    return this.#emptySuccess('DELETE', containerId, '?force=true&v=false', 204);
  }

  async #emptySuccess(
    method: 'POST' | 'DELETE',
    containerId: string,
    suffix: string,
    expectedStatus: number,
  ): Promise<AgentOsDockerEngineResultV1<true>> {
    if (!CONTAINER_ID_RE.test(containerId)) return { ok: false, reason: 'invalid-input' };
    const separator = suffix.startsWith('?') ? '' : '/';
    const response = await this.#request(
      method, `/v${this.#apiVersion}/containers/${containerId}${separator}${suffix}`, null,
    );
    if (!response.ok) return response;
    return response.value.statusCode === expectedStatus && response.value.body.byteLength === 0
      ? { ok: true, value: true }
      : { ok: false, reason: response.value.statusCode === 404 ? 'container-not-found' : 'response-invalid' };
  }

  async waitContainer(
    containerId: string,
    timeoutMs: number,
  ): Promise<AgentOsDockerEngineResultV1<AgentOsDockerContainerWaitResultV1>> {
    if (!CONTAINER_ID_RE.test(containerId)) return { ok: false, reason: 'invalid-input' };
    const response = await this.#request(
      'POST', `/v${this.#apiVersion}/containers/${containerId}/wait?condition=not-running`, null, timeoutMs,
    );
    if (!response.ok) return response;
    if (response.value.statusCode !== 200) return { ok: false, reason: 'response-invalid' };
    const row = parseJsonRecord(response.value.body);
    if (!row || !Number.isSafeInteger(row['StatusCode']) || (row['StatusCode'] as number) < 0 ||
      (row['StatusCode'] as number) > 255 || (row['Error'] !== null && row['Error'] !== undefined)) {
      return { ok: false, reason: 'response-invalid' };
    }
    return { ok: true, value: Object.freeze({
      statusCode: row['StatusCode'] as number,
      waitEvidenceDigest: rawDigest('ashlr.agent-os.docker-wait-evidence.v1', {
        containerId, statusCode: row['StatusCode'],
      }),
    }) };
  }

  async confirmContainerAbsent(containerId: string): Promise<AgentOsDockerEngineResultV1<true>> {
    if (!CONTAINER_ID_RE.test(containerId)) return { ok: false, reason: 'invalid-input' };
    const response = await this.#request(
      'GET', `/v${this.#apiVersion}/containers/${containerId}/json`, null,
    );
    if (!response.ok) return response;
    return response.value.statusCode === 404
      ? { ok: true, value: true }
      : { ok: false, reason: 'response-invalid' };
  }

  async openAttachment(
    containerId: string,
    maxStdoutBytes: number,
  ): Promise<AgentOsDockerEngineResultV1<AgentOsDockerAttachmentV1>> {
    if (!CONTAINER_ID_RE.test(containerId) || !Number.isSafeInteger(maxStdoutBytes) ||
      maxStdoutBytes < 1 || maxStdoutBytes > 3 * 1024 * 1024) {
      return { ok: false, reason: 'invalid-input' };
    }
    const socketIdentity = this.#preflightSocket();
    if (!socketIdentity.ok) return socketIdentity;
    return new Promise((resolveResult) => {
      let settled = false;
      const finish = (value: AgentOsDockerEngineResultV1<AgentOsDockerAttachmentV1>): void => {
        if (!settled) { settled = true; resolveResult(value); }
      };
      const request = httpRequest({
        socketPath: this.#socketPath,
        method: 'POST',
        path: `/v${this.#apiVersion}/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const timer = setTimeout(() => {
        request.destroy();
        finish({ ok: false, reason: 'request-timed-out' });
      }, this.#requestTimeoutMs);
      request.once('upgrade', (response, socket, head) => {
        clearTimeout(timer);
        if (response.statusCode !== 101) {
          socket.destroy();
          finish({ ok: false, reason: 'attach-failed' });
          return;
        }
        try {
          if (!sameSocket(socketIdentity.value, lstatSync(this.#socketPath, { bigint: true }))) {
            socket.destroy();
            finish({ ok: false, reason: 'socket-replaced' });
            return;
          }
        } catch {
          socket.destroy();
          finish({ ok: false, reason: 'socket-replaced' });
          return;
        }
        finish({ ok: true, value: this.#captureAttachment(socket, head, maxStdoutBytes) });
      });
      request.once('response', (response) => {
        clearTimeout(timer);
        response.resume();
        finish({ ok: false, reason: 'attach-failed' });
      });
      request.once('error', () => {
        clearTimeout(timer);
        finish({ ok: false, reason: 'request-failed' });
      });
      request.end();
    });
  }

  #captureAttachment(socket: Socket, head: Buffer, maxStdoutBytes: number): AgentOsDockerAttachmentV1 {
    let pending = Buffer.alloc(0);
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrHash = createHash('sha256').update('ashlr.agent-os.docker-stderr.v1\0', 'utf8');
    let transportBytes = 0;
    let truncated = false;
    let completed = false;
    let resolveCompletion!: (value: AgentOsDockerEngineResultV1<AgentOsDockerAttachCaptureV1>) => void;
    const completion = new Promise<AgentOsDockerEngineResultV1<AgentOsDockerAttachCaptureV1>>((resolveValue) => {
      resolveCompletion = resolveValue;
    });
    const finish = (value: AgentOsDockerEngineResultV1<AgentOsDockerAttachCaptureV1>): void => {
      if (!completed) { completed = true; resolveCompletion(value); }
    };
    const consume = (chunk: Buffer): void => {
      if (completed) return;
      transportBytes += chunk.byteLength;
      pending = Buffer.concat([pending, chunk]);
      while (pending.byteLength >= 8) {
        const stream = pending[0];
        const frameBytes = pending.readUInt32BE(4);
        if (![1, 2].includes(stream ?? 0) || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0 ||
          frameBytes > maxStdoutBytes + AGENT_OS_DOCKER_ENGINE_MAX_STDERR_BYTES_V1) {
          truncated = true;
          socket.destroy();
          finish({ ok: false, reason: 'attach-truncated' });
          return;
        }
        if (pending.byteLength < 8 + frameBytes) return;
        const payload = pending.subarray(8, 8 + frameBytes);
        pending = pending.subarray(8 + frameBytes);
        if (stream === 1) {
          if (stdoutBytes + payload.byteLength > maxStdoutBytes) {
            truncated = true;
            socket.destroy();
            finish({ ok: false, reason: 'attach-truncated' });
            return;
          }
          stdoutBytes += payload.byteLength;
          stdout.push(Buffer.from(payload));
        } else {
          stderrBytes += payload.byteLength;
          if (stderrBytes > AGENT_OS_DOCKER_ENGINE_MAX_STDERR_BYTES_V1) {
            truncated = true;
            socket.destroy();
            finish({ ok: false, reason: 'attach-truncated' });
            return;
          }
          stderrHash.update(payload);
        }
      }
    };
    socket.on('data', (chunk: Buffer) => consume(Buffer.from(chunk)));
    socket.once('end', () => {
      if (pending.byteLength !== 0) {
        finish({ ok: false, reason: 'response-invalid' });
      } else {
        finish({ ok: true, value: Object.freeze({
          stdout: Buffer.concat(stdout),
          stderrBytes,
          stderrDigest: stderrHash.digest('hex'),
          transportBytes,
          truncated,
        }) });
      }
    });
    socket.once('error', () => finish({ ok: false, reason: 'attach-failed' }));
    if (head.byteLength > 0) consume(head);
    return Object.freeze({
      writeAndClose: (input: Uint8Array): boolean => {
        if (completed || !(input instanceof Uint8Array) ||
          input.byteLength > AGENT_OS_DOCKER_ENGINE_MAX_REQUEST_FRAME_BYTES_V1) {
          return false;
        }
        socket.end(Buffer.from(input));
        return true;
      },
      abort: (): void => { socket.destroy(); finish({ ok: false, reason: 'attach-failed' }); },
      completion,
    });
  }
}

export function agentOsDockerContainerNameV1(requestNonce: string): string | null {
  if (typeof requestNonce !== 'string' || requestNonce.length < 22 || requestNonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(requestNonce)) return null;
  const suffix = createHash('sha256').update('ashlr.agent-os.container-name.v1\0', 'utf8')
    .update(requestNonce, 'utf8').digest('hex').slice(0, 32);
  return `ashlr-agent-os-${suffix}`;
}

export function agentOsDockerResponseFrameLimitV1(maxOutputBytes: number): number | null {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2 * 1024 * 1024) return null;
  return Math.ceil(maxOutputBytes / 3) * 4 + 64 * 1024;
}

export function agentOsDockerOutputEvidenceDigestV1(value: Uint8Array): string {
  return bytesDigest('ashlr.agent-os.docker-output-evidence.v1', value);
}

export function agentOsDockerEngineCreateRequestDigestV1(
  policy: AgentOsLocalContainerCreatePolicyV1,
  seccompProfile: Uint8Array,
): string | null {
  const inspected = inspectAgentOsLocalContainerCreatePolicyV1(policy);
  return inspected.policy && seccompAdmitted(seccompProfile, inspected.policy.seccompProfileDigest)
    ? rawDigest('ashlr.agent-os.docker-create-request.v1',
      createRequestBody(inspected.policy, seccompProfile))
    : null;
}
