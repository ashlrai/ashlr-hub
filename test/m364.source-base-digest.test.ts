import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSourceBaseDigest,
  sanitizeSourceBaseDigest,
  verifySourceBaseDigest,
  type BuildSourceBaseDigestInput,
} from '../src/core/fleet/source-base-digest.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

const baseInput: BuildSourceBaseDigestInput = {
  repo: '/tmp/ashlr-source-base',
  scannerId: 'merge-verify-contract',
  scannerRevision: 1,
  sourceKind: 'git-tree',
  consistency: 'immutable',
  dirty: 'clean',
  sourceSnapshot: { commands: [{ argv: ['npm', 'test'], required: true }] },
  requirementSnapshot: { detectedCommands: [['npm', 'test']] },
  scannerConfig: { profiles: ['merge'], cap: 20 },
};

beforeEach(() => {
  fx = makeFixture();
  const path = provenanceKeyPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(32, 7), { mode: 0o600 });
});

afterEach(() => {
  fx.cleanup();
});

describe('M364 source-base digest foundation', () => {
  it('builds only the metadata-only exact schema', () => {
    const digest = buildSourceBaseDigest(baseInput);

    expect(digest).toEqual({
      schemaVersion: 1,
      algorithm: 'hmac-sha256',
      sourceKind: 'git-tree',
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      requirementDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      baseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      scannerRevision: 1,
      consistency: 'immutable',
      dirty: 'clean',
    });
    expect(JSON.stringify(digest)).not.toContain('npm');
    expect(JSON.stringify(digest)).not.toContain('/tmp/ashlr-source-base');
  });

  it('recursively sorts object keys, normalizes strings to NFC, and preserves array order', () => {
    const first = buildSourceBaseDigest({
      ...baseInput,
      sourceSnapshot: { z: { b: 'Cafe\u0301', a: 1 }, a: ['first', 'second'] },
      scannerConfig: { z: true, nested: { y: 'Cafe\u0301', x: null } },
    });
    const reordered = buildSourceBaseDigest({
      ...baseInput,
      sourceSnapshot: { a: ['first', 'second'], z: { a: 1, b: 'Caf\u00e9' } },
      scannerConfig: { nested: { x: null, y: 'Caf\u00e9' }, z: true },
    });
    const arrayChanged = buildSourceBaseDigest({
      ...baseInput,
      sourceSnapshot: { a: ['second', 'first'], z: { a: 1, b: 'Caf\u00e9' } },
      scannerConfig: { nested: { x: null, y: 'Caf\u00e9' }, z: true },
    });

    expect(reordered).toEqual(first);
    expect(arrayChanged?.sourceDigest).not.toBe(first?.sourceDigest);
  });

  it('separately invalidates source, requirements, config, scanner revision, and repo identity', () => {
    const initial = buildSourceBaseDigest(baseInput)!;
    const sourceChanged = buildSourceBaseDigest({ ...baseInput, sourceSnapshot: { commands: [] } })!;
    const configChanged = buildSourceBaseDigest({ ...baseInput, scannerConfig: { profiles: ['quick'] } })!;
    const requirementChanged = buildSourceBaseDigest({ ...baseInput, requirementSnapshot: { detectedCommands: [] } })!;
    const revisionChanged = buildSourceBaseDigest({ ...baseInput, scannerRevision: 2 })!;
    const repoChanged = buildSourceBaseDigest({ ...baseInput, repo: '/tmp/other-source-base' })!;

    expect(sourceChanged.sourceDigest).not.toBe(initial.sourceDigest);
    expect(sourceChanged.configDigest).toBe(initial.configDigest);
    expect(configChanged.sourceDigest).toBe(initial.sourceDigest);
    expect(configChanged.configDigest).not.toBe(initial.configDigest);
    expect(requirementChanged.requirementDigest).not.toBe(initial.requirementDigest);
    expect(requirementChanged.sourceDigest).toBe(initial.sourceDigest);
    expect(revisionChanged.baseDigest).not.toBe(initial.baseDigest);
    expect(repoChanged.sourceDigest).toBe(initial.sourceDigest);
    expect(repoChanged.configDigest).toBe(initial.configDigest);
    expect(repoChanged.baseDigest).not.toBe(initial.baseDigest);
  });

  it('uses an existing key only and rejects malformed inputs', () => {
    const keyPath = provenanceKeyPath();
    writeFileSync(keyPath, Buffer.from([1]), { mode: 0o600 });
    expect(buildSourceBaseDigest(baseInput)).toBeNull();
    expect(readFileSync(keyPath)).toEqual(Buffer.from([1]));

    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(buildSourceBaseDigest({ ...baseInput, sourceSnapshot: cyclic })).toBeNull();
    expect(buildSourceBaseDigest({ ...baseInput, scannerRevision: 0 })).toBeNull();
    expect(buildSourceBaseDigest({ ...baseInput, scannerConfig: { value: Number.NaN } })).toBeNull();
  });

  it('sanitizes by exact reconstruction and rejects every malformed contract field', () => {
    const digest = buildSourceBaseDigest(baseInput)!;
    expect(sanitizeSourceBaseDigest({
      ...digest,
      sourceSnapshot: { raw: 'github_pat_1234567890abcdefghijklmnop' },
      repo: '/private/repo',
      extra: true,
    })).toEqual(digest);

    for (const patch of [
      { schemaVersion: 2 },
      { algorithm: 'sha256' },
      { sourceKind: 'worktree' },
      { sourceDigest: 'A'.repeat(64) },
      { requirementDigest: 'A'.repeat(64) },
      { configDigest: 'a'.repeat(63) },
      { baseDigest: 'not-a-digest' },
      { scannerRevision: 0 },
      { scannerRevision: 1.5 },
      { consistency: 'racy' },
      { dirty: false },
    ]) {
      expect(sanitizeSourceBaseDigest({ ...digest, ...patch })).toBeNull();
    }
    expect(sanitizeSourceBaseDigest(null)).toBeNull();
  });

  it('authenticates the complete envelope for its exact repo and scanner tuple', () => {
    const digest = buildSourceBaseDigest(baseInput)!;
    expect(verifySourceBaseDigest(baseInput.repo, baseInput.scannerId, digest)).toEqual(digest);
    expect(verifySourceBaseDigest('/tmp/other', baseInput.scannerId, digest)).toBeNull();
    expect(verifySourceBaseDigest(baseInput.repo, 'other-scanner', digest)).toBeNull();
    expect(verifySourceBaseDigest(baseInput.repo, baseInput.scannerId, {
      ...digest,
      sourceDigest: 'f'.repeat(64),
    })).toBeNull();
    expect(verifySourceBaseDigest(baseInput.repo, baseInput.scannerId, {
      ...digest,
      consistency: 'stable-double-read',
    })).toBeNull();
    expect(verifySourceBaseDigest(baseInput.repo, baseInput.scannerId, {
      ...digest,
      dirty: 'tracked',
    })).toBeNull();
  });
});
