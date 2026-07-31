import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';

import type {
  PrivateStorageInvocation,
  PrivateStorageKind,
  PrivateStorageMode,
  PrivateStorageRunner,
} from '../../src/core/util/private-storage.js';

type SemanticPrivateStorageOperation = 'assure-private-path' | 'assure-private-paths';

export interface SemanticPrivateStorageRequest {
  operation: SemanticPrivateStorageOperation;
  anchorPath: string;
  paths: readonly string[];
  kind: PrivateStorageKind;
  mode?: PrivateStorageMode;
}

export interface SemanticPrivateStoragePathFact {
  inspectable: boolean;
  exists?: boolean;
  kind?: PrivateStorageKind;
  reparse?: boolean;
}

export type SemanticPrivateStoragePathInspector = (
  path: string,
) => SemanticPrivateStoragePathFact;

export interface SemanticPrivateStorageHarness {
  readonly runner: PrivateStorageRunner;
  readonly requests: readonly SemanticPrivateStorageRequest[];
  reset(): void;
}

interface ParsedSingleRequest {
  schemaVersion: 1;
  operation: 'assure-private-path';
  nonce: string;
  path: string;
  anchorPath: string;
  kind: PrivateStorageKind;
  mode: PrivateStorageMode;
}

interface ParsedBatchRequest {
  schemaVersion: 1;
  operation: 'assure-private-paths';
  nonce: string;
  paths: string[];
  anchorPath: string;
  kind: 'file';
}

type ParsedRequest = ParsedSingleRequest | ParsedBatchRequest;

const SINGLE_KEYS = 'anchorPath,kind,mode,nonce,operation,path,schemaVersion';
const BATCH_KEYS = 'anchorPath,kind,nonce,operation,paths,schemaVersion';
const POWERSHELL_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
] as const;
const NONCE_RE = /^[a-f0-9]{32}$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
// SHA-256 over the exact base64 argv payload emitted by private-storage.ts.
// A production script change must update these fixtures through explicit review.
const CANONICAL_ENCODED_COMMAND_SHA256: Record<SemanticPrivateStorageOperation, string> = {
  'assure-private-path': '6d15f1551b0c198b05f11ec3e1979860f7f880b01703545b066b0fec14a97246',
  'assure-private-paths': '3504f98ec2d564707a15d9ab1f2bb42b0c97a5271819f4be4e617c5b33f241db',
};

function defaultPathInspector(path: string): SemanticPrivateStoragePathFact {
  if (process.platform !== 'win32') return { inspectable: false };
  try {
    const stat = lstatSync(path);
    return {
      inspectable: true,
      exists: true,
      kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : undefined,
      reparse: stat.isSymbolicLink(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { inspectable: true, exists: false };
    }
    throw error;
  }
}

function fail(message: string): never {
  throw new Error(`semantic private-storage refusal: ${message}`);
}

function exactKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}

function localWindowsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 ||
    [...value].some((character) => character.charCodeAt(0) < 32)) {
    fail('invalid path');
  }
  const normalized = win32.normalize(value);
  if (!/^[A-Za-z]:\\/u.test(normalized)) fail('path must be drive-absolute');
  return normalized;
}

export function trustedWindowsSystemRootForTest(): string {
  const configured = process.platform === 'win32' ? process.env.SystemRoot : 'C:\\Windows';
  if (!configured) fail('trusted SystemRoot is unavailable');
  return localWindowsPath(configured);
}

function validateNestedPath(anchorPath: string, path: string): void {
  const relative = win32.relative(anchorPath.toLowerCase(), path.toLowerCase());
  if (relative === '..' || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) {
    fail('path escapes anchor');
  }
}

function inspectPath(
  path: string,
  expectedKind: PrivateStorageKind,
  inspector: SemanticPrivateStoragePathInspector,
  label: string,
): void {
  const fact = inspector(path);
  if (!fact.inspectable) return;
  if (!fact.exists) fail(`${label} does not exist`);
  if (fact.reparse) fail(`${label} is a reparse path`);
  if (fact.kind !== expectedKind) fail(`${label} has wrong kind`);
}

function inspectAncestors(
  anchorPath: string,
  path: string,
  inspector: SemanticPrivateStoragePathInspector,
): void {
  let cursor = win32.dirname(path);
  const expectedAnchor = anchorPath.toLowerCase();
  for (;;) {
    inspectPath(cursor, 'directory', inspector, 'ancestor');
    if (cursor.toLowerCase() === expectedAnchor) return;
    const parent = win32.dirname(cursor);
    if (parent === cursor) fail('anchor was not reached');
    cursor = parent;
  }
}

function validateInvocationContract(
  invocation: PrivateStorageInvocation,
  operation: SemanticPrivateStorageOperation,
  trustedSystemRoot: string,
): void {
  const executable = win32.normalize(invocation.executable);
  const expectedExecutable = win32.join(
    trustedSystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (executable !== expectedExecutable) {
    fail('unexpected executable');
  }
  if (invocation.args.length !== POWERSHELL_ARGS.length + 1 ||
    POWERSHELL_ARGS.some((argument, index) => invocation.args[index] !== argument)) {
    fail('unexpected argv');
  }
  const encodedCommand = invocation.args.at(-1);
  if (!encodedCommand || encodedCommand.length % 4 !== 0 || !BASE64_RE.test(encodedCommand)) {
    fail('invalid encoded command');
  }
  const encodedDigest = createHash('sha256').update(encodedCommand, 'utf8').digest('hex');
  if (encodedDigest !== CANONICAL_ENCODED_COMMAND_SHA256[operation]) {
    fail('unexpected encoded command identity');
  }
  if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs < 100 ||
    invocation.timeoutMs > 15_000 || invocation.maxBuffer !== 4 * 1_024) {
    fail('unexpected execution bounds');
  }
}

function parseRequest(input: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    fail('malformed JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid request');
  const request = raw as Record<string, unknown>;
  if (request['schemaVersion'] !== 1 || !NONCE_RE.test(String(request['nonce'] ?? ''))) {
    fail('invalid schema or nonce');
  }
  if (request['operation'] === 'assure-private-path') {
    if (exactKeys(request) !== SINGLE_KEYS) fail('invalid single-path request shape');
    if (request['kind'] !== 'file' && request['kind'] !== 'directory') fail('invalid kind');
    if (request['mode'] !== 'secure-created' && request['mode'] !== 'inspect-existing' &&
      request['mode'] !== 'inspect-owned') fail('invalid mode');
    return request as unknown as ParsedSingleRequest;
  }
  if (request['operation'] === 'assure-private-paths') {
    if (exactKeys(request) !== BATCH_KEYS) fail('invalid batch request shape');
    if (request['kind'] !== 'file') fail('invalid batch kind');
    if (!Array.isArray(request['paths']) || request['paths'].length < 1 ||
      request['paths'].length > 512) fail('invalid batch paths');
    return request as unknown as ParsedBatchRequest;
  }
  fail('unexpected operation');
}

function validateRequest(
  request: ParsedRequest,
  inspector: SemanticPrivateStoragePathInspector,
): SemanticPrivateStorageRequest {
  const anchorPath = localWindowsPath(request.anchorPath);
  inspectPath(anchorPath, 'directory', inspector, 'anchor');
  if (request.operation === 'assure-private-path') {
    const path = localWindowsPath(request.path);
    validateNestedPath(anchorPath, path);
    inspectPath(path, request.kind, inspector, 'target');
    inspectAncestors(anchorPath, path, inspector);
    return Object.freeze({
      operation: request.operation,
      anchorPath,
      paths: Object.freeze([path]),
      kind: request.kind,
      mode: request.mode,
    });
  }
  const paths = request.paths.map(localWindowsPath);
  for (const path of paths) {
    validateNestedPath(anchorPath, path);
    inspectPath(path, 'file', inspector, 'target');
    inspectAncestors(anchorPath, path, inspector);
  }
  return Object.freeze({
    operation: request.operation,
    anchorPath,
    paths: Object.freeze(paths),
    kind: 'file',
  });
}

/**
 * Exercise the authenticated adapter protocol without launching PowerShell.
 * Only fully validated requests are captured or answered successfully.
 */
export function createSemanticPrivateStorageHarness(options: {
  systemRoot: string;
  pathInspector?: SemanticPrivateStoragePathInspector;
}): SemanticPrivateStorageHarness {
  const captured: SemanticPrivateStorageRequest[] = [];
  const inspector = options.pathInspector ?? defaultPathInspector;
  const trustedSystemRoot = localWindowsPath(options.systemRoot);
  const runner: PrivateStorageRunner = (invocation) => {
    const request = parseRequest(invocation.input);
    validateInvocationContract(invocation, request.operation, trustedSystemRoot);
    const metadata = validateRequest(request, inspector);
    captured.push(metadata);
    const reason = request.operation === 'assure-private-paths'
      ? 'owned-safe-paths'
      : request.mode === 'inspect-owned'
        ? 'owned-safe-path'
        : 'exact-private-dacl';
    return {
      status: 0,
      stdout: JSON.stringify({
        nonce: request.nonce,
        operation: request.operation,
        ok: true,
        reason,
      }),
    };
  };
  return {
    runner,
    get requests() {
      return captured.map((request) => ({ ...request, paths: [...request.paths] }));
    },
    reset() {
      captured.length = 0;
    },
  };
}
