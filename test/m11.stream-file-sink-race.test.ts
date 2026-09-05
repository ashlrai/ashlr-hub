import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  afterOpen: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  beforeExclusiveCreate: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  openedFlags: [] as number[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(filePath: import('node:fs').PathLike, flags: import('node:fs').OpenMode, mode?: import('node:fs').Mode) {
      const target = String(filePath);
      const numericFlags = Number(flags);
      if (target === race.target) {
        race.openedFlags.push(numericFlags);
        if ((numericFlags & actual.constants.O_CREAT) !== 0 &&
          (numericFlags & actual.constants.O_EXCL) !== 0) {
          race.beforeExclusiveCreate?.(target, actual);
          race.beforeExclusiveCreate = undefined;
        }
      }
      const fd = actual.openSync(filePath, flags, mode);
      if (target === race.target && (numericFlags & actual.constants.O_APPEND) !== 0 && race.afterOpen) {
        const hook = race.afterOpen;
        race.afterOpen = undefined;
        hook(target, actual);
      }
      return fd;
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  endStreamSink,
  fileSink,
  runStreamFilePath,
  runStreamsDir,
} from '../src/core/run/streaming.js';

const originalHome = process.env.HOME;
let tmpHome: string;

function prepareStreamDirectory(): void {
  const dir = runStreamsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.dirname(dir), 0o700);
    fs.chmodSync(dir, 0o700);
  }
}

function streamPath(runId: string): string {
  const result = runStreamFilePath(runId);
  if (!result) throw new Error('test run id was rejected');
  return result;
}

function persist(runId: string, text = 'new stream text'): void {
  const sink = fileSink(runId);
  sink({ kind: 'model-delta', ts: new Date().toISOString(), text });
  endStreamSink(sink);
}

beforeEach(() => {
  race.target = undefined;
  race.afterOpen = undefined;
  race.beforeExclusiveCreate = undefined;
  race.openedFlags.length = 0;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-stream-race-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  race.target = undefined;
  race.afterOpen = undefined;
  race.beforeExclusiveCreate = undefined;
  race.openedFlags.length = 0;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('fileSink — descriptor-bound append/create races', () => {
  it('creates an absent stream only with O_EXCL and O_NOFOLLOW', () => {
    const target = streamPath('exclusive-create');
    race.target = target;

    persist('exclusive-create');

    const createFlags = race.openedFlags.find((flags) =>
      (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0);
    expect(createFlags).toBeDefined();
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      expect(createFlags! & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
    expect(fs.readFileSync(target, 'utf8')).toContain('new stream text');
  });

  it.runIf(process.platform !== 'win32')('refuses a symlink without touching its referent', () => {
    prepareStreamDirectory();
    const target = streamPath('symlink-target');
    const outside = path.join(tmpHome, 'outside-stream');
    fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
    fs.symlinkSync(outside, target);

    persist('symlink-target');

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('refuses a hardlink without touching its referent', () => {
    prepareStreamDirectory();
    const target = streamPath('hardlink-target');
    const outside = path.join(tmpHome, 'outside-hardlink');
    fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
    fs.linkSync(outside, target);

    persist('hardlink-target');

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(fs.lstatSync(outside).nlink).toBe(2);
  });

  it.runIf(process.platform !== 'win32')('refuses an existing stream with widened permissions', () => {
    prepareStreamDirectory();
    const target = streamPath('wide-mode-target');
    fs.writeFileSync(target, 'existing\n', { mode: 0o600 });
    fs.chmodSync(target, 0o644);

    persist('wide-mode-target');

    expect(fs.readFileSync(target, 'utf8')).toBe('existing\n');
  });

  it('rejects a pathname replacement after descriptor open and before append', () => {
    prepareStreamDirectory();
    const target = streamPath('post-open-replacement');
    const displaced = path.join(tmpHome, 'displaced-stream');
    const replacement = path.join(tmpHome, 'replacement-stream');
    fs.writeFileSync(target, 'original\n', { mode: 0o600 });
    fs.writeFileSync(replacement, 'replacement\n', { mode: 0o600 });
    race.target = target;
    race.afterOpen = (openedPath, actual) => {
      actual.renameSync(openedPath, displaced);
      actual.renameSync(replacement, openedPath);
    };

    persist('post-open-replacement');

    expect(fs.readFileSync(displaced, 'utf8')).toBe('original\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement\n');
  });

  it('rejects parent-directory replacement after descriptor open and before append', () => {
    prepareStreamDirectory();
    const dir = runStreamsDir();
    const displacedDir = `${dir}.displaced`;
    const target = streamPath('parent-replacement');
    fs.writeFileSync(target, 'original\n', { mode: 0o600 });
    race.target = target;
    race.afterOpen = (_openedPath, actual) => {
      actual.renameSync(dir, displacedDir);
      actual.mkdirSync(dir, { mode: 0o700 });
      actual.writeFileSync(target, 'replacement\n', { mode: 0o600 });
    };

    persist('parent-replacement');

    expect(fs.readFileSync(path.join(displacedDir, path.basename(target)), 'utf8')).toBe('original\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement\n');
  });

  it.runIf(process.platform !== 'win32')('rejects storage-root replacement with a parent symlink after descriptor open', () => {
    prepareStreamDirectory();
    const root = path.dirname(runStreamsDir());
    const displacedRoot = `${root}.displaced`;
    const externalRoot = path.join(tmpHome, 'external-root');
    const externalDir = path.join(externalRoot, 'run-streams');
    const target = streamPath('root-symlink-replacement');
    fs.mkdirSync(externalDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(externalRoot, 0o700);
    fs.chmodSync(externalDir, 0o700);
    fs.writeFileSync(target, 'original\n', { mode: 0o600 });
    fs.writeFileSync(path.join(externalDir, path.basename(target)), 'replacement\n', { mode: 0o600 });
    race.target = target;
    race.afterOpen = (_openedPath, actual) => {
      actual.renameSync(root, displacedRoot);
      actual.symlinkSync(externalRoot, root);
    };

    persist('root-symlink-replacement');

    expect(fs.readFileSync(path.join(displacedRoot, 'run-streams', path.basename(target)), 'utf8'))
      .toBe('original\n');
    expect(fs.readFileSync(path.join(externalDir, path.basename(target)), 'utf8')).toBe('replacement\n');
  });

  it.runIf(process.platform !== 'win32')('loses an exclusive-create race to a symlink without following it', () => {
    prepareStreamDirectory();
    const target = streamPath('exclusive-symlink-race');
    const outside = path.join(tmpHome, 'exclusive-race-outside');
    fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
    race.target = target;
    race.beforeExclusiveCreate = (createdPath, actual) => {
      actual.symlinkSync(outside, createdPath);
    };

    persist('exclusive-symlink-race');

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('continues safely when another writer wins exclusive creation with a private file', () => {
    prepareStreamDirectory();
    const target = streamPath('exclusive-file-race');
    race.target = target;
    race.beforeExclusiveCreate = (createdPath, actual) => {
      actual.writeFileSync(createdPath, 'competitor\n', { mode: 0o600, flag: 'wx' });
    };

    persist('exclusive-file-race');

    expect(fs.readFileSync(target, 'utf8')).toContain('competitor\n');
    expect(fs.readFileSync(target, 'utf8')).toContain('new stream text');
  });
});
