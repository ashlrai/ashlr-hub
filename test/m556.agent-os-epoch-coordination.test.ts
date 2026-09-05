import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireAgentOsEpochCoordinationLeaseV1,
  ownsAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';

const WRITER = `sha256:${'a'.repeat(64)}`;
const OTHER_WRITER = `sha256:${'b'.repeat(64)}`;
const roots: string[] = [];

function temporaryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), 'ashlr-m556-'));
  roots.push(parent);
  return join(parent, 'history');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M556 Agent OS process-resident epoch coordination lease', () => {
  it('acquires one immutable, non-authoritative lease per canonical root', () => {
    const rootPath = temporaryRoot();
    const acquired = acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER });
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') throw new Error('lease unavailable');
    expect(acquired.lease).toMatchObject({
      rootPath: join(realpathSync.native(dirname(rootPath)), 'history'),
      writerProtocolDigest: WRITER,
      durable: false,
      externallyAuthenticated: false,
      rollbackProtected: false,
      effectAuthority: false,
    });
    expect(Object.isFrozen(acquired.lease)).toBe(true);
    expect(ownsAgentOsEpochCoordinationLeaseV1(acquired.lease, {
      rootPath,
      writerProtocolDigest: WRITER,
    })).toBe(true);
    expect(releaseAgentOsEpochCoordinationLeaseV1(acquired.lease)).toBe(true);
  });

  it('suppresses same-process reentrancy until the exact lease is released', () => {
    const rootPath = temporaryRoot();
    const first = acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER });
    expect(first.state).toBe('acquired');
    expect(acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER }).state)
      .toBe('contended');
    if (first.state !== 'acquired') throw new Error('lease unavailable');
    expect(releaseAgentOsEpochCoordinationLeaseV1(first.lease)).toBe(true);
    expect(releaseAgentOsEpochCoordinationLeaseV1(first.lease)).toBe(false);
    const second = acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER });
    expect(second.state).toBe('acquired');
    if (second.state === 'acquired') releaseAgentOsEpochCoordinationLeaseV1(second.lease);
  });

  it('collapses lexical aliases and distinguishes separate roots', () => {
    const rootPath = temporaryRoot();
    const first = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: join(dirname(rootPath), '.', 'history'),
      writerProtocolDigest: WRITER,
    });
    expect(first.state).toBe('acquired');
    expect(acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER }).state)
      .toBe('contended');
    const other = temporaryRoot();
    const independent = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: other,
      writerProtocolDigest: WRITER,
    });
    expect(independent.state).toBe('acquired');
    if (first.state === 'acquired') releaseAgentOsEpochCoordinationLeaseV1(first.lease);
    if (independent.state === 'acquired') releaseAgentOsEpochCoordinationLeaseV1(independent.lease);
  });

  it('requires exact object identity, canonical root, and writer digest to prove ownership', () => {
    const rootPath = temporaryRoot();
    const acquired = acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER });
    if (acquired.state !== 'acquired') throw new Error('lease unavailable');
    const forged = { ...acquired.lease } as AgentOsEpochCoordinationLeaseV1;
    expect(ownsAgentOsEpochCoordinationLeaseV1(forged, { rootPath, writerProtocolDigest: WRITER })).toBe(false);
    expect(releaseAgentOsEpochCoordinationLeaseV1(forged)).toBe(false);
    expect(ownsAgentOsEpochCoordinationLeaseV1(acquired.lease, {
      rootPath,
      writerProtocolDigest: OTHER_WRITER,
    })).toBe(false);
    expect(releaseAgentOsEpochCoordinationLeaseV1(acquired.lease)).toBe(true);
  });

  it('rejects malformed/accessor input, relative paths, root paths, files, and symlink roots', () => {
    const rootPath = temporaryRoot();
    const accessor = {} as { rootPath: string; writerProtocolDigest: string };
    Object.defineProperty(accessor, 'rootPath', { enumerable: true, get: () => rootPath });
    Object.defineProperty(accessor, 'writerProtocolDigest', { enumerable: true, value: WRITER });
    expect(acquireAgentOsEpochCoordinationLeaseV1(accessor).state).toBe('invalid');
    expect(acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: 'relative/history', writerProtocolDigest: WRITER,
    }).state).toBe('invalid');
    expect(acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: '/', writerProtocolDigest: WRITER,
    }).state).toBe('invalid');
    expect(acquireAgentOsEpochCoordinationLeaseV1({
      rootPath, writerProtocolDigest: 'a'.repeat(64),
    }).state).toBe('invalid');

    mkdirSync(rootPath);
    const alias = `${rootPath}-alias`;
    symlinkSync(rootPath, alias);
    expect(acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: alias, writerProtocolDigest: WRITER,
    }).state).toBe('invalid');
  });

  it('pins an absent nested root beneath its nearest real ancestor', () => {
    const rootPath = join(temporaryRoot(), 'nested', 'epochs');
    const acquired = acquireAgentOsEpochCoordinationLeaseV1({ rootPath, writerProtocolDigest: WRITER });
    expect(acquired.state).toBe('acquired');
    if (acquired.state === 'acquired') {
      expect(ownsAgentOsEpochCoordinationLeaseV1(acquired.lease, {
        rootPath,
        writerProtocolDigest: WRITER,
      })).toBe(true);
      releaseAgentOsEpochCoordinationLeaseV1(acquired.lease);
    }
  });
});
