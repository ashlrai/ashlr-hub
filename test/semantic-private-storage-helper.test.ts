import { describe, expect, it } from 'vitest';

import type { PrivateStorageInvocation } from '../src/core/util/private-storage.js';
import {
  createSemanticPrivateStorageHarness,
  type SemanticPrivateStoragePathFact,
} from './helpers/semantic-private-storage.js';

const SINGLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.operation -ne 'assure-private-path') { exit 1 }
`;
const BATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.operation -ne 'assure-private-paths') { exit 1 }
`;

function invocation(overrides: Partial<PrivateStorageInvocation> = {}): PrivateStorageInvocation {
  return {
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(SINGLE_SCRIPT, 'utf16le').toString('base64'),
    ],
    input: JSON.stringify({
      schemaVersion: 1,
      operation: 'assure-private-path',
      nonce: 'a'.repeat(32),
      path: 'C:\\fixture\\private.key',
      anchorPath: 'C:\\fixture',
      kind: 'file',
      mode: 'inspect-existing',
    }),
    timeoutMs: 5_000,
    maxBuffer: 4 * 1_024,
    ...overrides,
  };
}

function inspector(overrides: Record<string, SemanticPrivateStoragePathFact> = {}) {
  return (path: string): SemanticPrivateStoragePathFact => overrides[path] ?? {
    inspectable: true,
    exists: true,
    kind: path === 'C:\\fixture' ? 'directory' : 'file',
    reparse: false,
  };
}

function batchInvocation(): PrivateStorageInvocation {
  return invocation({
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(BATCH_SCRIPT, 'utf16le').toString('base64'),
    ],
    input: JSON.stringify({
      schemaVersion: 1,
      operation: 'assure-private-paths',
      nonce: 'b'.repeat(32),
      paths: ['C:\\fixture\\first.json', 'C:\\fixture\\second.json'],
      anchorPath: 'C:\\fixture',
      kind: 'file',
    }),
    timeoutMs: 15_000,
  });
}

describe('semantic private-storage harness', () => {
  it('captures only a fully validated request', () => {
    const harness = createSemanticPrivateStorageHarness({ pathInspector: inspector() });
    expect(harness.runner(invocation())).toMatchObject({ status: 0 });
    expect(harness.requests).toEqual([{
      operation: 'assure-private-path',
      anchorPath: 'C:\\fixture',
      paths: ['C:\\fixture\\private.key'],
      kind: 'file',
      mode: 'inspect-existing',
    }]);
  });

  it('validates and captures the bounded batch operation', () => {
    const harness = createSemanticPrivateStorageHarness({ pathInspector: inspector() });
    expect(harness.runner(batchInvocation())).toMatchObject({ status: 0 });
    expect(harness.requests).toEqual([{
      operation: 'assure-private-paths',
      anchorPath: 'C:\\fixture',
      paths: ['C:\\fixture\\first.json', 'C:\\fixture\\second.json'],
      kind: 'file',
    }]);
  });

  it.each([
    ['malformed JSON', { input: '{' }],
    ['unexpected executable', { executable: 'C:\\Windows\\System32\\cmd.exe' }],
    ['unexpected argv', { args: ['-EncodedCommand', 'AAAA'] }],
    ['wrong encoded operation', {
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(BATCH_SCRIPT, 'utf16le').toString('base64'),
      ],
    }],
    ['invalid bounds', { timeoutMs: 60_000 }],
  ])('refuses %s without capturing it', (_label, override) => {
    const harness = createSemanticPrivateStorageHarness({ pathInspector: inspector() });
    expect(() => harness.runner(invocation(override))).toThrow(/semantic private-storage refusal/u);
    expect(harness.requests).toEqual([]);
  });

  it.each([
    ['schema', { schemaVersion: 2 }],
    ['operation', { operation: 'unexpected' }],
    ['path', { path: '..\\private.key' }],
    ['kind', { kind: 'socket' }],
    ['mode', { mode: 'trust-me' }],
    ['shape', { extra: true }],
  ])('refuses an unexpected request %s', (_label, requestOverride) => {
    const base = JSON.parse(invocation().input) as Record<string, unknown>;
    const harness = createSemanticPrivateStorageHarness({ pathInspector: inspector() });
    expect(() => harness.runner(invocation({
      input: JSON.stringify({ ...base, ...requestOverride }),
    }))).toThrow(/semantic private-storage refusal/u);
    expect(harness.requests).toEqual([]);
  });

  it.each([
    ['missing target', 'C:\\fixture\\private.key', { inspectable: true, exists: false }],
    ['reparse target', 'C:\\fixture\\private.key', {
      inspectable: true, exists: true, kind: 'file', reparse: true,
    }],
    ['missing anchor', 'C:\\fixture', { inspectable: true, exists: false }],
    ['reparse anchor', 'C:\\fixture', {
      inspectable: true, exists: true, kind: 'directory', reparse: true,
    }],
    ['reparse ancestor', 'C:\\fixture\\nested', {
      inspectable: true, exists: true, kind: 'directory', reparse: true,
    }],
  ] as const)('refuses a %s', (_label, path, fact) => {
    const request = path.endsWith('nested')
      ? invocation({
          input: JSON.stringify({
            ...JSON.parse(invocation().input) as Record<string, unknown>,
            path: 'C:\\fixture\\nested\\private.key',
          }),
        })
      : invocation();
    const harness = createSemanticPrivateStorageHarness({
      pathInspector: inspector({ [path]: fact }),
    });
    expect(() => harness.runner(request)).toThrow(/semantic private-storage refusal/u);
    expect(harness.requests).toEqual([]);
  });
});
