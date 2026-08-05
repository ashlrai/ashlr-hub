import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { COLLIDING_A, COLLIDING_B, IDENTITY_OFFSET, identityControl } = vi.hoisted(() => ({
  COLLIDING_A: 2n ** 54n,
  COLLIDING_B: 2n ** 54n + 1n,
  IDENTITY_OFFSET: 2n ** 55n,
  identityControl: {
    mutationOffset: 0n,
    lstatOverrides: new Map<string, { dev: bigint; ino: bigint }>(),
    fstatOverrides: new Map<string, { dev: bigint; ino: bigint }>(),
    fdPaths: new Map<number, string>(),
    temporaryPrefix: undefined as string | undefined,
    temporaryIdentity: undefined as { dev: bigint; ino: bigint } | undefined,
    journalTemporaryIdentity: undefined as { dev: bigint; ino: bigint } | undefined,
    journalIdentity: undefined as { dev: bigint; ino: bigint } | undefined,
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const promoteIdentity = (
    stat: NodeFs.BigIntStats,
    override?: { dev: bigint; ino: bigint },
  ): NodeFs.BigIntStats => new Proxy(stat, {
    get(target, property, receiver) {
      if (property === 'dev') return override?.dev ?? target.dev + IDENTITY_OFFSET + identityControl.mutationOffset;
      if (property === 'ino') return override?.ino ?? target.ino + IDENTITY_OFFSET + identityControl.mutationOffset;
      return Reflect.get(target, property, receiver);
    },
  });
  const wantsBigInt = (options: unknown): boolean =>
    typeof options === 'object' && options !== null &&
    'bigint' in options && (options as { bigint?: unknown }).bigint === true;

  return {
    ...actual,
    closeSync: vi.fn((fd: number) => {
      actual.closeSync(fd);
      identityControl.fdPaths.delete(fd);
    }),
    lstatSync: vi.fn((filePath: NodeFs.PathLike, options?: unknown) => {
      const stat = actual.lstatSync(filePath, options as never);
      const target = String(filePath);
      const override = identityControl.lstatOverrides.get(target) ??
        (target.endsWith('.journal.json') ? identityControl.journalIdentity : undefined);
      return wantsBigInt(options)
        ? promoteIdentity(stat as NodeFs.BigIntStats, override)
        : stat;
    }),
    fstatSync: vi.fn((fd: number, options?: unknown) => {
      const stat = actual.fstatSync(fd, options as never);
      const target = identityControl.fdPaths.get(fd);
      const override = target
        ? identityControl.fstatOverrides.get(target) ??
          (identityControl.temporaryPrefix && target.startsWith(identityControl.temporaryPrefix)
            ? identityControl.temporaryIdentity
            : target.includes('.journal.json.tmp.') ? identityControl.journalTemporaryIdentity
            : target.endsWith('.journal.json') ? identityControl.journalIdentity : undefined)
        : undefined;
      return wantsBigInt(options)
        ? promoteIdentity(stat as NodeFs.BigIntStats, override)
        : stat;
    }),
    openSync: vi.fn((filePath: NodeFs.PathLike, flags: NodeFs.OpenMode, mode?: NodeFs.Mode) => {
      const fd = actual.openSync(filePath, flags, mode);
      identityControl.fdPaths.set(fd, String(filePath));
      return fd;
    }),
  };
});

import * as fs from 'node:fs';
import {
  installLaunchdPlistTransaction,
  removeLaunchdPlistTransaction,
} from '../src/core/daemon/launchd-plist-transaction.js';

let root: string;

beforeEach(() => {
  identityControl.mutationOffset = 0n;
  identityControl.lstatOverrides.clear();
  identityControl.fstatOverrides.clear();
  identityControl.fdPaths.clear();
  identityControl.temporaryPrefix = undefined;
  identityControl.temporaryIdentity = undefined;
  identityControl.journalTemporaryIdentity = undefined;
  identityControl.journalIdentity = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-launchd-bigint-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('M93 launchd transaction bigint identity authority', () => {
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

  it('rejects colliding snapshot and opened-file identities', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, 'prior', { mode: 0o600 });
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });
    identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_B, ino: COLLIDING_B });

    expect(() => installLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      content: 'next',
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      load: () => ({ ok: true, stderr: '' }),
    })).toThrow('changed while opening');
  });

  it('rejects colliding temporary and installed identities during atomic replacement', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    identityControl.temporaryPrefix = `${serviceFile}.tmp.`;
    identityControl.temporaryIdentity = { dev: COLLIDING_A, ino: COLLIDING_A };
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_B, ino: COLLIDING_B });

    expect(() => installLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      content: 'next',
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      load: () => ({ ok: true, stderr: '' }),
    })).toThrow('atomic replacement ownership check failed');
  });

  it('rejects a colliding journal generation before replacing it', () => {
    identityControl.journalIdentity = { dev: COLLIDING_A, ino: COLLIDING_A };
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    const lockDir = path.join(root, 'locks');
    identityControl.journalTemporaryIdentity = { dev: COLLIDING_A, ino: COLLIDING_A };

    expect(() => installLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      content: 'next',
      lockDir,
      unload: () => ({ ok: true, stderr: '' }),
      load: () => ({ ok: true, stderr: '' }),
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'journal-prepared') {
          identityControl.journalIdentity = { dev: COLLIDING_B, ino: COLLIDING_B };
        }
      },
    })).toThrow('active plist changed during transaction');
  });

  it('does not unlink a colliding replacement generation during removal', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, 'prior', { mode: 0o600 });
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });
    identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });

    expect(() => removeLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      recover: () => ({ ok: true, stderr: '' }),
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'removal-journal-stopped') {
          identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_B, ino: COLLIDING_B });
        }
      },
    })).toThrow();
    expect(fs.existsSync(serviceFile)).toBe(true);
  });

  it('rejects a colliding generation introduced during activation', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    identityControl.temporaryPrefix = `${serviceFile}.tmp.`;
    identityControl.temporaryIdentity = { dev: COLLIDING_A, ino: COLLIDING_A };
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });
    identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });

    expect(() => installLaunchdPlistTransaction({
      plistPath: serviceFile,
      trustedRoot: root,
      content: 'next',
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      load: () => {
        identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_B, ino: COLLIDING_B });
        identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_B, ino: COLLIDING_B });
        return { ok: true, stderr: '' };
      },
      rollback: () => ({ ok: true, stderr: '' }),
    })).toThrow('active plist changed during launchctl load');
  });

  it('recovers a crash with exact high identities intact', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    identityControl.temporaryPrefix = `${serviceFile}.tmp.`;
    identityControl.temporaryIdentity = { dev: COLLIDING_A, ino: COLLIDING_A };
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });
    identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_A });
    const common = {
      plistPath: serviceFile,
      trustedRoot: root,
      content: 'next',
      lockDir: path.join(root, 'locks'),
      unload: () => ({ ok: true, stderr: '' }),
      load: () => ({ ok: true, stderr: '' }),
      rollback: () => ({ ok: true, stderr: '' }),
    };

    expect(() => installLaunchdPlistTransaction({
      ...common,
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'plist-replaced') throw new Error('simulated crash');
      },
    })).toThrow('simulated crash');
    expect(() => installLaunchdPlistTransaction(common)).not.toThrow();
    expect(fs.readFileSync(serviceFile, 'utf8')).toBe('next');
  });

  it('round-trips high removal identities as canonical decimal strings', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    const lockDir = path.join(root, 'locks');
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, 'prior', { mode: 0o600 });
    identityControl.lstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_B });
    identityControl.fstatOverrides.set(serviceFile, { dev: COLLIDING_A, ino: COLLIDING_B });
    const common = {
      plistPath: serviceFile,
      trustedRoot: root,
      lockDir,
      unload: () => ({ ok: true, stderr: '' }),
      recover: () => ({ ok: true, stderr: '' }),
    };

    expect(() => removeLaunchdPlistTransaction({
      ...common,
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'removal-journal-prepared') throw new Error('simulated crash');
      },
    })).toThrow('simulated crash');
    const journalPath = path.join(lockDir, fs.readdirSync(lockDir).find((name) =>
      name.endsWith('.removal.journal.json'))!);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    expect(journal).toMatchObject({
      schemaVersion: 2,
      priorDev: COLLIDING_A.toString(10),
      priorIno: COLLIDING_B.toString(10),
    });
    expect(() => removeLaunchdPlistTransaction(common)).not.toThrow();
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('accepts and upgrades a legacy safe-number removal journal', () => {
    const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
    const lockDir = path.join(root, 'locks');
    const legacyIdentity = { dev: 101n, ino: 103n };
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, 'prior', { mode: 0o600 });
    identityControl.lstatOverrides.set(serviceFile, legacyIdentity);
    identityControl.fstatOverrides.set(serviceFile, legacyIdentity);
    const common = {
      plistPath: serviceFile,
      trustedRoot: root,
      lockDir,
      unload: () => ({ ok: true, stderr: '' }),
      recover: () => ({ ok: true, stderr: '' }),
    };

    expect(() => removeLaunchdPlistTransaction({
      ...common,
      checkpointHook: (checkpoint) => {
        if (checkpoint === 'removal-journal-prepared') throw new Error('simulated crash');
      },
    })).toThrow('simulated crash');
    const journalPath = path.join(lockDir, fs.readdirSync(lockDir).find((name) =>
      name.endsWith('.removal.journal.json'))!);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.schemaVersion = 1;
    journal.priorDev = Number.MAX_SAFE_INTEGER + 1;
    journal.priorIno = Number(legacyIdentity.ino);
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    expect(() => removeLaunchdPlistTransaction(common)).toThrow(
      'invalid launchd removal transaction journal prior snapshot',
    );

    journal.priorDev = Number(legacyIdentity.dev);
    journal.priorIno = Number(legacyIdentity.ino);
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    expect(() => removeLaunchdPlistTransaction(common)).not.toThrow();
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});
