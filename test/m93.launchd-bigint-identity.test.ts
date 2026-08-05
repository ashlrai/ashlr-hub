import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { IDENTITY_OFFSET, identityControl } = vi.hoisted(() => ({
  IDENTITY_OFFSET: 2n ** 54n + 1n,
  identityControl: { mutationOffset: 0n },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const promoteIdentity = (stat: NodeFs.BigIntStats): NodeFs.BigIntStats => new Proxy(stat, {
    get(target, property, receiver) {
      if (property === 'dev' || property === 'ino') {
        return Reflect.get(target, property, receiver) + IDENTITY_OFFSET + identityControl.mutationOffset;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const wantsBigInt = (options: unknown): boolean =>
    typeof options === 'object' && options !== null &&
    'bigint' in options && (options as { bigint?: unknown }).bigint === true;

  return {
    ...actual,
    lstatSync: vi.fn((filePath: NodeFs.PathLike, options?: unknown) => {
      const stat = actual.lstatSync(filePath, options as never);
      return wantsBigInt(options)
        ? promoteIdentity(stat as NodeFs.BigIntStats)
        : stat;
    }),
    fstatSync: vi.fn((fd: number, options?: unknown) => {
      const stat = actual.fstatSync(fd, options as never);
      return wantsBigInt(options)
        ? promoteIdentity(stat as NodeFs.BigIntStats)
        : stat;
    }),
  };
});

import * as fs from 'node:fs';
import { installLaunchdPlistTransaction } from '../src/core/daemon/launchd-plist-transaction.js';

let root: string;

beforeEach(() => {
  identityControl.mutationOffset = 0n;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-launchd-bigint-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('M93 launchd transaction bigint directory identity', () => {
  it('preserves exact directory identities above Number.MAX_SAFE_INTEGER', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');

    installLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      content: '@echo off\r\nexit /b 0\r\n',
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      load: () => ({ ok: true, stderr: '' }),
    });

    expect(fs.readFileSync(serviceFile, 'utf8')).toBe('@echo off\r\nexit /b 0\r\n');
    expect(IDENTITY_OFFSET).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('fails closed when a high directory identity changes between transaction phases', () => {
    const unload = vi.fn(() => ({ ok: true, stderr: '' }));

    expect(() => installLaunchdPlistTransaction({
      plistPath: path.join(root, 'services', 'ashlr-daemon.cmd'),
      trustedRoot: root,
      content: '@echo off\r\nexit /b 0\r\n',
      lockDir: path.join(root, 'locks'),
      unload,
      load: () => ({ ok: true, stderr: '' }),
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'journal-prepared') identityControl.mutationOffset = 1n;
      },
    })).toThrow('launchd plist parent changed during transaction');
    expect(unload).not.toHaveBeenCalled();
  });
});
