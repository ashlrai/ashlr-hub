import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTrace, type TraceHandle } from '../src/core/local-eval/trace.js';

const transport = vi.hoisted(() => ({ request: vi.fn<(options: RequestOptions, response: (up: IncomingMessage) => void) => ClientRequest>() }));
vi.mock('node:https', () => ({ request: transport.request }));
const handles: TraceHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  transport.request.mockReset();
});
async function tracer(): Promise<TraceHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'trace-tls-fixture-')); dirs.push(dir);
  const handle = await startTrace({ upstream: 'https://fixture.invalid:9443', captureDir: dir });
  handles.push(handle); return handle;
}

describe('HTTPS tracing uses native TLS without making external requests', () => {
  it('selects HTTPS with the exact protocol/host/port/path and keeps certificate defaults', async () => {
    let received = '';
    const body = 'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n';
    transport.request.mockImplementation((_options, respond) => {
      const request = new EventEmitter() as EventEmitter & { end(data?: Buffer): void; destroy(): void };
      request.destroy = vi.fn();
      request.end = (data) => {
        received = data?.toString() ?? '';
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: 200, complete: true, headers: { 'content-type': 'text/event-stream' } });
          respond(response as unknown as IncomingMessage); response.end(body);
        });
      };
      return request as unknown as ClientRequest;
    });
    const handle = await tracer();
    const response = await fetch(handle.baseUrl + '/v1/messages', { method: 'POST', body: '{"fixture":true}', signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200); expect(await response.text()).toBe(body); expect(received).toBe('{"fixture":true}');
    const options = transport.request.mock.calls[0]![0];
    expect(options).toMatchObject({ protocol: 'https:', hostname: 'fixture.invalid', port: '9443', path: '/v1/messages', method: 'POST' });
    expect(options).not.toHaveProperty('rejectUnauthorized'); expect(options).not.toHaveProperty('checkServerIdentity');
    expect(options.headers).not.toHaveProperty('authorization');
    expect(handle.snapshot().streams[0]).toMatchObject({ status: 200, ended: 'upstream-end', sawTerminator: true });
  });
  it('turns TLS connection failure into a recorded upstream error and502, never a pass', async () => {
    transport.request.mockImplementation(() => {
      const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      request.destroy = vi.fn();
      request.end = () => queueMicrotask(() => request.emit('error', new Error('fixture TLS verification failure')));
      return request as unknown as ClientRequest;
    });
    const handle = await tracer();
    const response = await fetch(handle.baseUrl + '/v1/messages', { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(502); await response.text();
    expect(handle.snapshot().streams[0]).toMatchObject({ status: null, ended: 'upstream-error', sawTerminator: false });
    await handle.close(); handles.pop();
    expect(await readFile(join(dirs[0]!, 'wire.jsonl'), 'utf8')).toContain('connect-error');
  });
  it('rejects unsupported protocols before binding or selecting a transport', async () => {
    await expect(startTrace({ upstream: 'ftp://fixture.invalid', captureDir: '/never-used-fixture-dir' })).rejects.toThrow('HTTP(S)');
    expect(transport.request).not.toHaveBeenCalled();
  });
});
