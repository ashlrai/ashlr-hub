import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleApi, type WebApiContext } from '../src/core/web/api.js';
import { audit, auditDir, readAudit } from '../src/core/sandbox/audit.js';
import { parseServeArgs } from '../src/cli/serve.js';
import {
  authorizeWebMutation,
  buildLocalWebPrincipal,
  WEB_MUTATION_AUTHORITY_POLICY,
  type WebMutationCapability,
  type WebMutationRole,
} from '../src/core/web/mutation-authority.js';
import {
  canonicalMutationDigest,
  completeWebMutation,
  readWebMutationCompletion,
  reserveWebMutation,
} from '../src/core/web/mutation-journal.js';

const TOKEN = 'm488-local-session-token';

let testHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ashlr-m488-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

function decision(role: WebMutationRole, capability: WebMutationCapability) {
  return authorizeWebMutation({
    expectedToken: TOKEN,
    presentedToken: TOKEN,
    principal: buildLocalWebPrincipal(TOKEN, role),
    capability,
  });
}

interface CapturedResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function fakeRequestResponse(input: {
  url: string;
  token?: string;
  extraHeaders?: Record<string, string>;
}): { req: IncomingMessage; res: ServerResponse; captured: CapturedResponse } {
  const req = new EventEmitter() as IncomingMessage;
  req.method = 'POST';
  req.url = input.url;
  req.headers = {
    'content-type': 'application/json',
    'x-ashlr-token': input.token ?? TOKEN,
    'x-ashlr-idempotency-key': `m488-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...input.extraHeaders,
  };
  queueMicrotask(() => {
    req.emit('data', Buffer.from('{}'));
    req.emit('end');
  });

  const captured: CapturedResponse = { status: 0, body: '', headers: {} };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      for (const [name, value] of Object.entries(headers ?? {})) {
        captured.headers[name.toLowerCase()] = value;
      }
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      captured.body += chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

function context(role: WebMutationRole): WebApiContext {
  return {
    token: TOKEN,
    allowDispatch: true,
    mutationPrincipal: buildLocalWebPrincipal(TOKEN, role),
    requireMutationAuditReceipt: true,
  };
}

describe('M488 closed web mutation roles', () => {
  it('keeps operator and approver capabilities disjoint', () => {
    expect(decision('operator', 'run:dispatch').allowed).toBe(true);
    expect(decision('operator', 'fleet:pause').allowed).toBe(true);
    expect(decision('operator', 'proposal:approve')).toMatchObject({
      allowed: false,
      authenticated: true,
      code: 'role-denied',
      httpStatus: 403,
    });

    expect(decision('approver', 'proposal:approve').allowed).toBe(true);
    expect(decision('approver', 'proposal:reject').allowed).toBe(true);
    expect(decision('approver', 'run:dispatch').allowed).toBe(false);
  });

  it('reserves daemon repair requests and all capabilities for owner', () => {
    expect(decision('observer', 'desktop:open').allowed).toBe(false);
    expect(decision('operator', 'daemon:repair-request').allowed).toBe(false);
    expect(decision('approver', 'daemon:repair-request').allowed).toBe(false);
    expect(decision('owner', 'daemon:repair-request').allowed).toBe(true);
    expect(decision('owner', 'proposal:approve').allowed).toBe(true);
  });

  it('does not expose the token in the server-derived actor id', () => {
    const principal = buildLocalWebPrincipal(TOKEN);
    expect(principal.actorId).toMatch(/^local-system:[0-9a-f]{24}$/);
    expect(principal.actorId).not.toContain(TOKEN);
    expect(principal.actorType).toBe('system');
    expect(buildLocalWebPrincipal('a-different-ephemeral-token').actorId).toBe(principal.actorId);
    expect(buildLocalWebPrincipal(TOKEN, 'operator').actorId)
      .not.toBe(buildLocalWebPrincipal(TOKEN, 'owner').actorId);
  });

  it('refuses a wrong token before role authority is considered', () => {
    const result = authorizeWebMutation({
      expectedToken: TOKEN,
      presentedToken: 'wrong-token',
      principal: buildLocalWebPrincipal(TOKEN, 'owner'),
      capability: 'run:dispatch',
    });
    expect(result).toMatchObject({
      allowed: false,
      authenticated: false,
      code: 'invalid-token',
      httpStatus: 401,
      principal: null,
    });
  });
});

describe('M488 persisted web authority receipts', () => {
  it('ignores caller role headers and records a structured role denial', async () => {
    const { req, res, captured } = fakeRequestResponse({
      url: '/api/inbox/not-loaded/approve',
      extraHeaders: { 'x-ashlr-role': 'owner', 'x-ashlr-actor': 'forged-owner' },
    });

    await handleApi(req, res, {} as never, context('operator'));

    expect(captured.status).toBe(403);
    const [receipt] = readAudit(1);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      eventId: captured.headers['x-ashlr-audit-event'],
      action: 'web:mutation-authority',
      result: 'refused',
      actor: {
        id: buildLocalWebPrincipal(TOKEN, 'operator').actorId,
        type: 'system',
        role: 'operator',
      },
      authority: {
        method: 'scoped-local-session-token',
        capability: 'proposal:approve',
        policyVersion: WEB_MUTATION_AUTHORITY_POLICY,
        decision: 'refused',
        reasonCode: 'role-denied',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('forged-owner');
  });

  it('records unauthenticated attempts without persisting presented tokens', async () => {
    const presented = 'wrong-token-value-that-must-not-persist';
    const { req, res, captured } = fakeRequestResponse({
      url: '/api/fleet/pause',
      token: presented,
    });

    await handleApi(req, res, {} as never, context('owner'));

    expect(captured.status).toBe(401);
    expect(readAudit(1)[0]).toMatchObject({
      actor: { id: 'unauthenticated', type: 'unknown', role: 'none' },
      authority: { decision: 'refused', reasonCode: 'invalid-token' },
    });
    const raw = readdirSync(auditDir())
      .map((name) => readFileSync(join(auditDir(), name), 'utf8'))
      .join('');
    expect(raw).not.toContain(presented);
    expect(raw).not.toContain(TOKEN);
  });

  it('creates private audit storage on POSIX hosts', async () => {
    if (process.platform === 'win32') return;
    const { req, res } = fakeRequestResponse({
      url: '/api/fleet/pause',
      token: 'wrong-token',
    });

    await handleApi(req, res, {} as never, context('owner'));

    expect(statSync(auditDir()).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(auditDir());
    expect(file).toBeDefined();
    expect(statSync(join(auditDir(), file!)).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing permissive audit directory before appending', async () => {
    if (process.platform === 'win32') return;
    mkdirSync(auditDir(), { recursive: true, mode: 0o755 });
    chmodSync(auditDir(), 0o755);
    const existingFile = join(auditDir(), '2000-01-01.jsonl');
    writeFileSync(existingFile, '', { mode: 0o644 });
    chmodSync(existingFile, 0o644);
    const { req, res } = fakeRequestResponse({
      url: '/api/fleet/pause',
      token: 'wrong-token',
    });

    await handleApi(req, res, {} as never, context('owner'));

    expect(statSync(auditDir()).mode & 0o777).toBe(0o700);
    const currentFile = readdirSync(auditDir()).find((file) => file !== '2000-01-01.jsonl');
    expect(currentFile).toBeDefined();
    expect(statSync(join(auditDir(), currentFile!)).mode & 0o777).toBe(0o600);
  });

  it('fails closed before mutation when the reservation store is unavailable', async () => {
    const stableContext = context('owner');
    rmSync(join(testHome, '.ashlr'), { recursive: true, force: true });
    writeFileSync(join(testHome, '.ashlr'), 'blocks audit directory creation', 'utf8');
    const { req, res, captured } = fakeRequestResponse({ url: '/api/fleet/pause' });

    await handleApi(req, res, {} as never, stableContext);

    expect(captured.status).toBe(503);
    expect(JSON.parse(captured.body)).toEqual({ error: 'mutation reservation unavailable' });
  });

  it.runIf(process.platform !== 'win32')('fails closed when the audit filename is a symlink', async () => {
    mkdirSync(auditDir(), { recursive: true, mode: 0o700 });
    chmodSync(join(testHome, '.ashlr'), 0o700);
    chmodSync(auditDir(), 0o700);
    const outside = join(testHome, 'outside-audit-target');
    writeFileSync(outside, 'sentinel\n', { mode: 0o600 });
    const daily = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    symlinkSync(outside, join(auditDir(), daily));
    const { req, res, captured } = fakeRequestResponse({ url: '/api/fleet/pause' });

    await handleApi(req, res, {} as never, context('owner'));

    expect(captured.status).toBe(503);
    expect(JSON.parse(captured.body)).toEqual({ error: 'mutation audit receipt unavailable' });
    expect(readFileSync(outside, 'utf8')).toBe('sentinel\n');
  });

  it('fails closed on partial or corrupt audit tails without returning an unreadable event', () => {
    mkdirSync(auditDir(), { recursive: true, mode: 0o700 });
    chmodSync(join(testHome, '.ashlr'), 0o700);
    chmodSync(auditDir(), 0o700);
    const daily = join(auditDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(daily, '{"partial":', { mode: 0o600 });

    const receipt = audit({
      action: 'web:mutation-authority',
      repo: null,
      sandboxId: null,
      summary: 'must remain unreadable',
      result: 'ok',
    });

    expect(receipt).toBeNull();
    expect(readAudit()).toEqual([]);
    expect(readFileSync(daily, 'utf8')).toBe('{"partial":');

    writeFileSync(daily, '{not-json}\n', { mode: 0o600 });
    expect(audit({
      action: 'web:mutation-authority',
      repo: null,
      sandboxId: null,
      summary: 'corrupt complete tail',
      result: 'ok',
    })).toBeNull();
    expect(readFileSync(daily, 'utf8')).toBe('{not-json}\n');
  });

  it('persists request-bound reservation and completion receipts without the caller key', async () => {
    const callerKey = 'm488-private-caller-idempotency-key';
    const { req, res, captured } = fakeRequestResponse({
      url: '/api/fleet/pause',
      extraHeaders: { 'x-ashlr-idempotency-key': callerKey },
    });

    await handleApi(req, res, {} as never, context('owner'));

    expect(captured.status).toBe(200);
    const receipts = readAudit(10).filter((entry) => entry.action === 'web:mutation-authority');
    expect(receipts.map((entry) => entry.mutation?.phase)).toEqual(['completed', 'reserved']);
    expect(receipts[0]?.mutation).toMatchObject({
      method: 'POST',
      outcome: 'succeeded',
      status: 200,
    });
    expect(receipts[0]?.mutation?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipts)).not.toContain(callerKey);
  });
});

describe('M488 CLI production wiring', () => {
  it('requires mutation receipts whenever serve dispatch is enabled', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'cli', 'serve.ts'),
      'utf8',
    );
    expect(source).toContain('requireMutationAuditReceipts: allowDispatch');
  });

  it('defaults securely to owner and accepts only explicit dispatch-bound roles', () => {
    expect(parseServeArgs(['--allow-dispatch'])).toMatchObject({ mutationRole: 'owner' });
    expect(parseServeArgs(['--allow-dispatch', '--mutation-role', 'operator']))
      .toMatchObject({ allowDispatch: true, mutationRole: 'operator' });
    expect(parseServeArgs(['--mutation-role', 'approver'])).toMatchObject({ code: 2 });
    expect(parseServeArgs(['--allow-dispatch', '--mutation-role', 'admin']))
      .toMatchObject({ code: 2 });
  });
});

describe('M488 authenticated mutation journal', () => {
  it('keeps an exact unfinished reservation fail-closed as recovery-required', () => {
    const bodyTargetDigest = canonicalMutationDigest({ goal: 'recover after crash' })!;
    const input = {
      idempotencyKey: 'm488-recovery-required-reservation',
      actorId: buildLocalWebPrincipal(TOKEN).actorId,
      capability: 'run:dispatch',
      method: 'POST',
      path: '/api/run',
      bodyTargetDigest,
    };
    expect(reserveWebMutation({ ...input, nowMs: 1_000 })).toMatchObject({ ok: true });
    expect(reserveWebMutation({ ...input, nowMs: 1_001 })).toMatchObject({
      ok: false,
      reason: 'replayed',
      replay: { state: 'in-progress' },
    });
    expect(reserveWebMutation({
      ...input,
      nowMs: 1_000 + 15 * 60 * 1_000,
    })).toMatchObject({
      ok: false,
      reason: 'replayed',
      replay: { state: 'recovery-required' },
    });
    expect(reserveWebMutation({
      ...input,
      nowMs: 1_000 + 365 * 24 * 60 * 60 * 1_000,
    })).toMatchObject({
      ok: false,
      reason: 'replayed',
      replay: { state: 'recovery-required' },
    });
  });

  it('never tells an exact uncertain replay to change idempotency keys', async () => {
    const key = 'm488-api-recovery-required';
    expect(reserveWebMutation({
      idempotencyKey: key,
      actorId: buildLocalWebPrincipal(TOKEN, 'owner').actorId,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({})!,
      nowMs: 0,
    }).ok).toBe(true);
    const { req, res, captured } = fakeRequestResponse({
      url: '/api/fleet/pause',
      extraHeaders: { 'x-ashlr-idempotency-key': key },
    });

    await handleApi(req, res, {} as never, context('owner'));

    expect(captured.status).toBe(409);
    expect(JSON.parse(captured.body)).toMatchObject({
      idempotency: { replayed: true, state: 'recovery-required' },
    });
    expect(captured.body).not.toMatch(/new idempotency|new key/i);
    expect(captured.body).toMatch(/reconciliation is required/i);
  });

  it('isolates idempotency namespaces by stable role-bound principal', () => {
    const input = {
      idempotencyKey: 'm488-role-isolated-key',
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({})!,
    };
    expect(reserveWebMutation({
      ...input,
      actorId: buildLocalWebPrincipal('operator-token-a', 'operator').actorId,
    }).ok).toBe(true);
    expect(reserveWebMutation({
      ...input,
      actorId: buildLocalWebPrincipal('owner-token-b', 'owner').actorId,
    }).ok).toBe(true);
  });

  it('admits exact replay at quota but refuses new writes without deleting records', () => {
    const first = reserveWebMutation({
      idempotencyKey: 'm488-quota-first-record',
      actorId: buildLocalWebPrincipal(TOKEN).actorId,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({ private: 'never persisted' })!,
      maxFiles: 1,
    });
    expect(first.ok).toBe(true);
    expect(reserveWebMutation({
      idempotencyKey: 'm488-quota-first-record',
      actorId: buildLocalWebPrincipal('restarted-token').actorId,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({ private: 'never persisted' })!,
      maxFiles: 1,
    })).toMatchObject({ ok: false, reason: 'replayed', replay: { state: 'in-progress' } });
    expect(reserveWebMutation({
      idempotencyKey: 'm488-quota-second-record',
      actorId: buildLocalWebPrincipal(TOKEN).actorId,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({ private: 'different' })!,
      maxFiles: 1,
    })).toEqual({ ok: false, reason: 'unavailable' });
    const recordsDir = join(testHome, '.ashlr', 'web-mutation-reservations', 'records');
    expect(readdirSync(recordsDir)).toHaveLength(1);
    expect(readFileSync(join(recordsDir, readdirSync(recordsDir)[0]!), 'utf8'))
      .not.toContain('never persisted');
  });

  it('fails closed on degraded quota source data and preserves every record', () => {
    const principal = buildLocalWebPrincipal(TOKEN).actorId;
    expect(reserveWebMutation({
      idempotencyKey: 'm488-source-quality-first',
      actorId: principal,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({ request: 1 })!,
      maxFiles: 10,
    }).ok).toBe(true);
    const recordsDir = join(testHome, '.ashlr', 'web-mutation-reservations', 'records');
    const original = readdirSync(recordsDir)[0]!;
    writeFileSync(join(recordsDir, 'unexpected-record.json'), '{}\n', { mode: 0o600 });

    expect(reserveWebMutation({
      idempotencyKey: 'm488-source-quality-second',
      actorId: principal,
      capability: 'fleet:pause',
      method: 'POST',
      path: '/api/fleet/pause',
      bodyTargetDigest: canonicalMutationDigest({ request: 2 })!,
      maxFiles: 10,
    })).toEqual({ ok: false, reason: 'unavailable' });
    expect(readdirSync(recordsDir).sort()).toEqual([original, 'unexpected-record.json'].sort());
  });

  it('rejects a same-account completion rewrite with a stale attestation', () => {
    const bodyTargetDigest = canonicalMutationDigest({ goal: 'metadata-only digest' });
    expect(bodyTargetDigest).toMatch(/^[a-f0-9]{64}$/);
    const reserved = reserveWebMutation({
      idempotencyKey: 'm488-journal-tamper-attempt',
      actorId: 'local-session:test',
      capability: 'run:dispatch',
      method: 'POST',
      path: '/api/run',
      bodyTargetDigest: bodyTargetDigest!,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(completeWebMutation({
      reservation: reserved.reservation,
      outcome: 'succeeded',
      status: 200,
      result: { code: 'completed' },
    })).toBe(true);
    expect(readWebMutationCompletion(reserved.reservation.reservationId)).not.toBeNull();

    const path = join(
      testHome,
      '.ashlr',
      'web-mutation-completions',
      'records',
      `completion-v1-${reserved.reservation.reservationId}.json`,
    );
    const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    row['status'] = 201;
    writeFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });

    expect(readWebMutationCompletion(reserved.reservation.reservationId)).toBeNull();
  });

  it('canonicalizes prototype-shaped JSON keys without changing object identity', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"goal":"safe"}') as unknown;
    expect(canonicalMutationDigest(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
