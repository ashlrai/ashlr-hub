import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { observeLaunchdRelease } from '../src/core/daemon/launchd-release-observation.js';

const RELEASE = 'a'.repeat(40);

describe('M472 canonical launchd release observation', () => {
  let home: string;
  let releaseRoot: string;
  let supervisorPath: string;
  let childPath: string;
  let priorHome: string | undefined;
  let priorArgvEntry: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-launchd-release-'));
    chmodSync(home, 0o700);
    releaseRoot = join(home, '.local', 'share', 'ashlr', 'releases', RELEASE);
    supervisorPath = join(releaseRoot, 'dist', 'cli', 'launchd-supervisor.js');
    childPath = join(releaseRoot, 'dist', 'cli', 'launchd-daemon-child.js');
    mkdirSync(join(releaseRoot, 'dist', 'cli'), { recursive: true, mode: 0o700 });
    writeFileSync(supervisorPath, 'export const supervisor = true;\n', { mode: 0o500 });
    writeFileSync(childPath, 'export const child = true;\n', { mode: 0o500 });
    writeFileSync(join(releaseRoot, 'dist', 'build-identity.json'), JSON.stringify({
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: RELEASE,
      dirty: false,
      provenance: 'git',
    }), { mode: 0o400 });
    releaseRoot = realpathSync(releaseRoot);
    supervisorPath = realpathSync(supervisorPath);
    childPath = realpathSync(childPath);
    priorHome = process.env.HOME;
    priorArgvEntry = process.argv[1];
    process.env.HOME = home;
    process.argv[1] = supervisorPath;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorArgvEntry === undefined) process.argv.splice(1, 1);
    else process.argv[1] = priorArgvEntry;
    rmSync(home, { recursive: true, force: true });
  });

  it('binds canonical node, supervisor, and child paths and content identities', () => {
    const supervisor = observeLaunchdRelease('supervisor');
    process.argv[1] = childPath;
    const child = observeLaunchdRelease('child');

    expect(supervisor.releaseRevision).toBe(RELEASE);
    expect(supervisor.supervisor.path).toBe(realpathSync(supervisorPath));
    expect(supervisor.child.path).toBe(realpathSync(childPath));
    expect(supervisor.node.path).toBe(realpathSync(process.execPath));
    expect(supervisor.observationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(child).toEqual(supervisor);
  });

  it('changes the observation when executable content changes', () => {
    const before = observeLaunchdRelease('supervisor');
    chmodSync(childPath, 0o600);
    writeFileSync(childPath, 'export const child = false;\n', { mode: 0o500 });
    chmodSync(childPath, 0o500);
    const after = observeLaunchdRelease('supervisor');
    expect(after.child.sha256).not.toBe(before.child.sha256);
    expect(after.observationDigest).not.toBe(before.observationDigest);
  });

  it('rejects release paths outside the canonical revision-addressed store', () => {
    const outside = join(home, 'caller-selected', 'dist', 'cli', 'launchd-supervisor.js');
    mkdirSync(join(home, 'caller-selected', 'dist', 'cli'), { recursive: true, mode: 0o700 });
    writeFileSync(outside, 'export {};\n', { mode: 0o500 });
    process.argv[1] = realpathSync(outside);
    expect(() => observeLaunchdRelease('supervisor')).toThrow(
      'launchd release directory is not revision-addressed',
    );
  });

  it('rejects a caller-selected symlink alias to the canonical supervisor', () => {
    const alias = join(home, 'caller-selected-supervisor.js');
    symlinkSync(supervisorPath, alias);
    process.argv[1] = alias;
    expect(() => observeLaunchdRelease('supervisor')).toThrow(
      'launchd release entrypoint path is not canonical',
    );
  });

  it('rejects a build manifest that does not bind the release directory revision', () => {
    chmodSync(join(releaseRoot, 'dist', 'build-identity.json'), 0o600);
    writeFileSync(join(releaseRoot, 'dist', 'build-identity.json'), JSON.stringify({
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'b'.repeat(40),
      dirty: false,
      provenance: 'git',
    }), { mode: 0o400 });
    expect(() => observeLaunchdRelease('supervisor')).toThrow(
      'launchd release build identity is not immutable',
    );
  });
});
