/**
 * Durable, metadata-only idempotency receipts for local web mutations.
 *
 * Receipts intentionally never retain a request body, token, goal, environment,
 * filesystem path, or route response. A per-operation exclusive create is the
 * concurrency fence: a retry can replay a completed receipt but can never run
 * a second mutation while the original request is in progress.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_OPERATION_ID_LENGTH = 64;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OperationReceipt {
  schemaVersion: 1;
  operationId: string;
  route: string;
  requestDigest: string;
  createdAt: string;
  state: 'pending' | 'completed';
  statusCode?: number;
}

export type BeginOperationResult =
  | { kind: 'started'; receipt: OperationReceipt }
  | { kind: 'replay'; receipt: OperationReceipt }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'unavailable' };

export function parseOperationId(value: string): string | null {
  const id = value.trim();
  return id.length <= MAX_OPERATION_ID_LENGTH && OPERATION_ID.test(id) ? id.toLowerCase() : null;
}

export function operationRequestDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function receiptDir(): string {
  return join(homedir(), '.ashlr', 'web-operation-receipts');
}

function receiptPath(operationId: string): string {
  return join(receiptDir(), `${operationId}.json`);
}

function loadReceipt(operationId: string): OperationReceipt | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(receiptPath(operationId), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Partial<OperationReceipt>;
    if (row.schemaVersion !== 1 || row.operationId !== operationId || typeof row.route !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.requestDigest ?? '') || typeof row.createdAt !== 'string' ||
      (row.state !== 'pending' && row.state !== 'completed')) return null;
    if (row.state === 'completed' && (!Number.isInteger(row.statusCode) || row.statusCode! < 100 || row.statusCode! > 599)) return null;
    return row as OperationReceipt;
  } catch {
    return null;
  }
}

function writeReceipt(receipt: OperationReceipt): boolean {
  const dest = receiptPath(receipt.operationId);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, dest);
    return true;
  } catch {
    try { if (existsSync(tmp)) writeFileSync(tmp, '', 'utf8'); } catch { /* best effort */ }
    return false;
  }
}

export function beginOperationReceipt(operationId: string, route: string, requestDigest: string): BeginOperationResult {
  const existing = loadReceipt(operationId);
  if (existing) {
    if (existing.route !== route || existing.requestDigest !== requestDigest) return { kind: 'conflict' };
    return existing.state === 'completed' ? { kind: 'replay', receipt: existing } : { kind: 'in-progress' };
  }
  try {
    mkdirSync(receiptDir(), { recursive: true, mode: 0o700 });
    const receipt: OperationReceipt = { schemaVersion: 1, operationId, route, requestDigest, createdAt: new Date().toISOString(), state: 'pending' };
    const fd = openSync(receiptPath(operationId), 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8'); } finally { closeSync(fd); }
    return { kind: 'started', receipt };
  } catch {
    const raced = loadReceipt(operationId);
    if (raced) {
      if (raced.route !== route || raced.requestDigest !== requestDigest) return { kind: 'conflict' };
      return raced.state === 'completed' ? { kind: 'replay', receipt: raced } : { kind: 'in-progress' };
    }
    return { kind: 'unavailable' };
  }
}

export function completeOperationReceipt(receipt: OperationReceipt, statusCode: number): boolean {
  if (receipt.state !== 'pending' || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return false;
  return writeReceipt({ ...receipt, state: 'completed', statusCode });
}

