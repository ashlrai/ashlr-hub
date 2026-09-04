import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import type { AgentOsReadModelV1 } from '../src/core/vision/agent-os-read-model.js';
import type {
  AgentOsSnapshotEnvelopeV1,
  AgentOsSnapshotReadResultV1,
} from '../src/core/vision/agent-os-snapshot-store.js';

const runtimeReadMocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('../src/core/vision/agent-os-runtime-read.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/agent-os-runtime-read.js')>(),
  readAgentOsRuntimeSnapshotV1: runtimeReadMocks.read,
}));

import {
  buildAgentOsRuntimeReadResultV1,
  type AgentOsRuntimeReadResultV1,
} from '../src/core/vision/agent-os-runtime-read.js';
import { handleApi } from '../src/core/web/api.js';
import { startServer } from '../src/core/web/server.js';

const DIGESTS = {
  previous: '0'.repeat(64),
  producer: '1'.repeat(64),
  key: '2'.repeat(64),
  source: '3'.repeat(64),
  kernel: '4'.repeat(64),
  capability: '5'.repeat(64),
  portfolio: '6'.repeat(64),
  snapshot: '7'.repeat(64),
  payload: '8'.repeat(64),
  envelope: '9'.repeat(64),
  authenticator: 'a'.repeat(64),
} as const;

const SNAPSHOT: AgentOsReadModelV1 = {
  sourceState: 'healthy',
  livingEndState: {
    northStar: 'Build verified customer value.',
    currentBottleneck: 'Outcome evidence remains pending.',
    revisionLabel: 'Vision v1',
    evidenceState: 'complete',
  },
  capabilitySpectrum: [{
    lane: 'codex',
    label: 'Codex',
    state: 'ready',
    headroom: 'usable',
    resetUrgency: 'soon',
    resetLabel: 'Reset window verified',
    allocationLabel: 'One value bet ready',
  }],
  activeValueBets: [{
    key: 'verified-bet',
    title: 'Verified value bet',
    valueCase: 'Acceptance and outcome evidence are bound.',
    allocationLabel: 'Bound allocation',
    decision: 'continue',
    assurance: 'targeted',
    outcome: { state: 'pending', label: 'Observation window open' },
    evidence: { state: 'complete', label: 'Preverified' },
  }],
  nextAction: {
    kind: 'attention',
    title: 'Collect the next outcome observation',
    reason: 'The bound observation window remains open.',
    evidenceState: 'complete',
  },
};

const AUTHORITY = {
  authority: 'observation-only' as const,
  sameUserTamperResistant: false as const,
  rollbackProtected: false as const,
  historicalAuthority: false as const,
  executionAuthority: false as const,
  proposalAuthority: false as const,
  mergeAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  externalMutationAuthority: false as const,
};

function envelope(): AgentOsSnapshotEnvelopeV1 {
  return {
    schemaVersion: 1,
    protocol: 'agent-os-snapshot-envelope-v1',
    recordType: 'agent-os-snapshot',
    ...AUTHORITY,
    sequence: 1,
    previousEnvelopeDigest: DIGESTS.previous,
    observedAt: '2026-09-03T12:00:00.000Z',
    producerIdentityDigest: DIGESTS.producer,
    keyId: DIGESTS.key,
    sourceDigest: DIGESTS.source,
    kernelCycleDigest: DIGESTS.kernel,
    capabilityProjectionDigest: DIGESTS.capability,
    portfolioDigest: DIGESTS.portfolio,
    payload: { snapshot: SNAPSHOT, snapshotDigest: DIGESTS.snapshot },
    payloadDigest: DIGESTS.payload,
    envelopeDigest: DIGESTS.envelope,
    authenticator: DIGESTS.authenticator,
  };
}

function readResult(
  overrides: Partial<AgentOsSnapshotReadResultV1> = {},
): AgentOsSnapshotReadResultV1 {
  const current = envelope();
  return {
    sourceState: 'healthy',
    availability: 'available',
    sourcePresent: true,
    complete: true,
    envelopes: [current],
    current,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 4_096,
    invalidFiles: 0,
    limitExceeded: false,
    ...AUTHORITY,
    ...overrides,
  };
}

function publicResult(
  overrides: Partial<AgentOsRuntimeReadResultV1> = {},
): AgentOsRuntimeReadResultV1 {
  return {
    sourceState: 'healthy',
    complete: true,
    reason: null,
    snapshot: SNAPSHOT,
    authentication: 'authenticated',
    ...AUTHORITY,
    ...overrides,
  };
}

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function request(method = 'GET'): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: { status: number; body: string };
} {
  const captured = { status: 0, body: '' };
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = '/api/agent-os';
  req.headers = {};
  process.nextTick(() => req.emit('end'));
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.status = status; this.headersSent = true; },
    end(data?: string) { if (data) captured.body += data; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

function serverRequest(
  handle: WebServerHandle,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: handle.port,
      path: '/api/agent-os',
      method: 'GET',
      headers: { Host: `127.0.0.1:${handle.port}`, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Agent OS runtime read projection', () => {
  beforeEach(() => runtimeReadMocks.read.mockReset());

  it('publishes only the snapshot from a complete authenticated observation-only chain', () => {
    const result = buildAgentOsRuntimeReadResultV1(readResult());

    expect(result).toEqual(publicResult());
    expect(result.sameUserTamperResistant).toBe(false);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      DIGESTS.producer,
      DIGESTS.key,
      DIGESTS.source,
      DIGESTS.envelope,
      DIGESTS.authenticator,
      '/Users/private/agent-os-snapshots-v1',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('fails closed for missing, invalid, incomplete, or unexpectedly authoritative reads', () => {
    expect(buildAgentOsRuntimeReadResultV1(readResult({
      sourceState: 'missing',
      availability: 'unavailable',
      sourcePresent: false,
      complete: false,
      envelopes: [],
      current: null,
      filesRead: 0,
      bytesRead: 0,
    }))).toEqual(publicResult({
      sourceState: 'missing',
      complete: false,
      reason: 'snapshot-store-missing',
      snapshot: null,
      authentication: 'unavailable',
    }));

    expect(buildAgentOsRuntimeReadResultV1(readResult({
      sourceState: 'degraded',
      availability: 'unavailable',
      complete: false,
      envelopes: [],
      current: null,
      stopReasons: ['invalid-file'],
      invalidFiles: 1,
    }))).toMatchObject({
      sourceState: 'degraded', complete: false, snapshot: null,
      reason: 'invalid-file', authentication: 'invalid',
    });

    expect(buildAgentOsRuntimeReadResultV1(readResult({
      sourceState: 'degraded',
      availability: 'unavailable',
      complete: false,
      envelopes: [],
      current: null,
      stopReasons: ['broken-predecessor'],
    }))).toMatchObject({
      sourceState: 'degraded', complete: false, snapshot: null,
      reason: 'broken-predecessor', authentication: 'authenticated',
    });

    const authoritative = readResult() as unknown as AgentOsSnapshotReadResultV1 & {
      executionAuthority: boolean;
    };
    authoritative.executionAuthority = true;
    expect(buildAgentOsRuntimeReadResultV1(authoritative)).toMatchObject({
      sourceState: 'degraded', complete: false, snapshot: null,
      authentication: 'authenticated', authority: 'observation-only', executionAuthority: false,
    });
  });
});

describe('GET /api/agent-os', () => {
  it('is default-denied by the server read-auth boundary', async () => {
    const body = publicResult();
    runtimeReadMocks.read.mockReturnValue(body);
    const handle = await startServer(config(), { port: 0, open: false, allowDispatch: false });
    try {
      const missing = await serverRequest(handle);
      const wrong = await serverRequest(handle, { 'x-ashlr-token': 'wrong' });
      const authorized = await serverRequest(handle, { 'x-ashlr-token': handle.readToken });

      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(authorized.status).toBe(200);
      expect(JSON.parse(authorized.body)).toEqual(body);
      expect(runtimeReadMocks.read).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it.each([
    publicResult(),
    publicResult({
      sourceState: 'missing', complete: false, reason: 'snapshot-store-missing',
      snapshot: null, authentication: 'unavailable',
    }),
    publicResult({
      sourceState: 'degraded', complete: false, reason: 'broken-predecessor',
      snapshot: null, authentication: 'authenticated',
    }),
  ])('returns the bounded read envelope with HTTP 200', async (body) => {
    runtimeReadMocks.read.mockReturnValue(body);
    const { req, res, captured } = request();

    await expect(handleApi(req, res, config(), {
      token: 'not-used-for-reads',
      allowDispatch: false,
    })).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual(body);
  });

  it('does not expose a mutation route', async () => {
    const { req, res, captured } = request('POST');
    await handleApi(req, res, config(), { token: 'test', allowDispatch: true });

    expect(captured.status).toBe(404);
    expect(runtimeReadMocks.read).not.toHaveBeenCalled();
  });
});
