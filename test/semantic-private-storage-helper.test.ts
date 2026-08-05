import { describe, expect, it } from 'vitest';

import {
  assurePrivateStoragePath,
  assurePrivateStoragePaths,
  type PrivateStorageInvocation,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import {
  createSemanticPrivateStorageHarness,
  type SemanticPrivateStoragePathFact,
} from './helpers/semantic-private-storage.js';

const SYSTEM_ROOT = 'C:\\Windows';

function captureCanonicalInvocation(operation: 'single' | 'batch'): PrivateStorageInvocation {
  let captured: PrivateStorageInvocation | undefined;
  const runner: PrivateStorageRunner = (value) => {
    captured = { ...value, args: [...value.args] };
    const request = JSON.parse(value.input) as {
      nonce: string;
      operation: string;
      mode?: string;
    };
    return {
      status: 0,
      stdout: JSON.stringify({
        nonce: request.nonce,
        operation: request.operation,
        ok: true,
        reason: request.operation === 'assure-private-paths'
          ? 'owned-safe-paths'
          : request.mode === 'inspect-owned'
            ? 'owned-safe-path'
            : 'exact-private-dacl',
      }),
    };
  };
  if (operation === 'single') {
    assurePrivateStoragePath('C:\\fixture\\private.key', 'file', 'inspect-existing', {
      platform: 'win32',
      systemRoot: SYSTEM_ROOT,
      anchorPath: 'C:\\fixture',
      runner,
    });
  } else {
    assurePrivateStoragePaths(
      ['C:\\fixture\\first.json', 'C:\\fixture\\second.json'],
      {
        platform: 'win32',
        systemRoot: SYSTEM_ROOT,
        anchorPath: 'C:\\fixture',
        runner,
      },
    );
  }
  if (!captured) throw new Error(`production did not emit a canonical ${operation} invocation`);
  return captured;
}

function invocation(overrides: Partial<PrivateStorageInvocation> = {}): PrivateStorageInvocation {
  return {
    ...captureCanonicalInvocation('single'),
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
  return captureCanonicalInvocation('batch');
}

function harness(pathInspector = inspector()) {
  return createSemanticPrivateStorageHarness({
    systemRoot: SYSTEM_ROOT,
    pathInspector,
  });
}

function encodedAttack(script: string): string[] {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

describe('semantic private-storage harness', () => {
  it('captures only a fully validated request', () => {
    const semanticStorage = harness();
    expect(semanticStorage.runner(invocation())).toMatchObject({ status: 0 });
    expect(semanticStorage.requests).toEqual([{
      operation: 'assure-private-path',
      anchorPath: 'C:\\fixture',
      paths: ['C:\\fixture\\private.key'],
      kind: 'file',
      mode: 'inspect-existing',
    }]);
  });

  it('validates and captures the bounded batch operation', () => {
    const semanticStorage = harness();
    expect(semanticStorage.runner(batchInvocation())).toMatchObject({ status: 0 });
    expect(semanticStorage.requests).toEqual([{
      operation: 'assure-private-paths',
      anchorPath: 'C:\\fixture',
      paths: ['C:\\fixture\\first.json', 'C:\\fixture\\second.json'],
      kind: 'file',
    }]);
  });

  it.each([
    ['malformed JSON', { input: '{' }],
    ['unexpected executable', { executable: 'C:\\Windows\\System32\\cmd.exe' }],
    ['attacker SystemRoot suffix', {
      executable: 'C:\\attacker\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }],
    ['unexpected argv', { args: ['-EncodedCommand', 'AAAA'] }],
    ['no-op encoded script', { args: encodedAttack('exit 0') }],
    ['substring encoded script', {
      args: encodedAttack("$ErrorActionPreference; ConvertFrom-Json; $request.operation -ne 'assure-private-path'"),
    }],
    ['wrong encoded operation', { args: batchInvocation().args }],
    ['altered canonical script', {
      args: (() => {
        const args = [...invocation().args];
        const encoded = args.at(-1)!;
        args[args.length - 1] = `${encoded.slice(0, -1)}${encoded.endsWith('A') ? 'B' : 'A'}`;
        return args;
      })(),
    }],
    ['altered canonical args', {
      args: invocation().args.map((argument) => argument === 'Bypass' ? 'RemoteSigned' : argument),
    }],
    ['invalid bounds', { timeoutMs: 60_000 }],
  ])('refuses %s without capturing it', (_label, override) => {
    const semanticStorage = harness();
    expect(() => semanticStorage.runner(invocation(override)))
      .toThrow(/semantic private-storage refusal/u);
    expect(semanticStorage.requests).toEqual([]);
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
    const semanticStorage = harness();
    expect(() => semanticStorage.runner(invocation({
      input: JSON.stringify({ ...base, ...requestOverride }),
    }))).toThrow(/semantic private-storage refusal/u);
    expect(semanticStorage.requests).toEqual([]);
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
    const semanticStorage = harness(inspector({ [path]: fact }));
    expect(() => semanticStorage.runner(request)).toThrow(/semantic private-storage refusal/u);
    expect(semanticStorage.requests).toEqual([]);
  });
});
