import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBuildIdentity,
  javascriptStringLiteral,
  writeBuildIdentity,
} from '../scripts/build-identity.mjs';
import { createSeaShim } from '../scripts/build-sea.mjs';
import { readBuildIdentity } from '../src/core/build-identity.js';

vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: vi.fn(async () => ({ killed: false, queue: [] })),
}));

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-build-identity-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"version":"3.1.0"}\n', 'utf8');
  return root;
}

function initGit(root: string): string {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', 'package.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

afterEach(() => {
  delete process.env.ASHLR_BUILD_IDENTITY;
  Reflect.deleteProperty(globalThis, Symbol.for('ashlr.build-identity.v1'));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('build identity generation', () => {
  it('records a clean full Git revision and then detects dirtiness', () => {
    const root = fixture();
    const revision = initGit(root);
    expect(createBuildIdentity({ repoRoot: root, env: {} })).toEqual({
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision,
      dirty: false,
      provenance: 'git',
    });

    writeFileSync(join(root, 'dirty.txt'), 'changed\n', 'utf8');
    expect(createBuildIdentity({ repoRoot: root, env: {} }).dirty).toBe(true);
  });

  it('uses GITHUB_SHA only when Git metadata is absent', () => {
    const root = fixture();
    const revision = 'A'.repeat(40);
    expect(createBuildIdentity({ repoRoot: root, env: { GITHUB_SHA: revision } })).toMatchObject({
      revision: revision.toLowerCase(),
      dirty: null,
      provenance: 'github-actions',
    });
  });

  it('fails closed for absent or malformed provenance', () => {
    const root = fixture();
    expect(createBuildIdentity({ repoRoot: root, env: {} })).toMatchObject({
      revision: null,
      dirty: null,
      provenance: 'unavailable',
    });
    expect(createBuildIdentity({ repoRoot: root, env: { GITHUB_SHA: 'main; echo unsafe' } })).toMatchObject({
      revision: null,
      provenance: 'unavailable',
    });
    expect(readBuildIdentity({ raw: '{bad json' })).toEqual({
      schemaVersion: 1,
      packageVersion: null,
      revision: null,
      dirty: null,
      provenance: 'unavailable',
    });
    expect(readBuildIdentity({ raw: JSON.stringify({
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'not-a-full-revision',
      dirty: false,
      provenance: 'git',
    }) })).toMatchObject({ revision: null, provenance: 'unavailable' });
  });

  it('roundtrips the generated manifest through the runtime reader', () => {
    const root = fixture();
    initGit(root);
    mkdirSync(join(root, 'dist'));
    const manifestPath = join(root, 'dist', 'build-identity.json');
    const generated = writeBuildIdentity({ repoRoot: root, outputPath: manifestPath, env: {} });
    expect(readBuildIdentity({ manifestPath })).toEqual(generated);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(generated);
  });

  it('prefers the artifact manifest over a conflicting SEA fallback', () => {
    const root = fixture();
    initGit(root);
    mkdirSync(join(root, 'dist'));
    const manifestPath = join(root, 'dist', 'build-identity.json');
    const generated = writeBuildIdentity({ repoRoot: root, outputPath: manifestPath, env: {} });
    Reflect.set(globalThis, Symbol.for('ashlr.build-identity.v1'), JSON.stringify({
      schemaVersion: 1,
      packageVersion: '9.9.9',
      revision: 'f'.repeat(40),
      dirty: false,
      provenance: 'git',
    }));

    expect(readBuildIdentity({ manifestPath })).toEqual(generated);
  });

  it('serializes SEA values without raw executable separators or tags', () => {
    const value = '</script>\u2028\u2029';
    const literal = javascriptStringLiteral(value);
    expect(literal).not.toContain('</script>');
    expect(literal).not.toContain('\u2028');
    expect(literal).not.toContain('\u2029');
    expect(Function(`return ${literal}`)()).toBe(value);
  });

  it('makes the SEA-embedded identity authoritative over external env', () => {
    const root = fixture();
    const embedded = JSON.stringify({
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'a'.repeat(40),
      dirty: false,
      provenance: 'git',
    });
    const conflicting = JSON.stringify({
      schemaVersion: 1,
      packageVersion: '9.9.9',
      revision: 'f'.repeat(40),
      dirty: true,
      provenance: 'git',
    });
    const shimPath = join(root, 'identity-shim.mjs');
    const shim = createSeaShim({ pkgVersion: '3.1.0', buildIdentityJson: embedded })
      .replace(
        "await import('../dist/cli/index.js');",
        "process.stdout.write(Reflect.get(globalThis, Symbol.for('ashlr.build-identity.v1')) ?? '');",
      );
    writeFileSync(shimPath, shim, 'utf8');

    const observed = execFileSync(process.execPath, [shimPath], {
      encoding: 'utf8',
      env: { ...process.env, ASHLR_BUILD_IDENTITY: conflicting },
    });
    expect(observed).toBe(embedded);
  });
});

describe('GET /api/fleet build identity', () => {
  it('returns the canonical FleetStatus object without API-side recomposition', async () => {
    const canonicalFleet = {
      killed: false,
      queue: [],
      buildIdentity: {
        schemaVersion: 1 as const,
        packageVersion: '3.1.0',
        revision: 'b'.repeat(40),
        dirty: false,
        provenance: 'git' as const,
      },
    };
    const { buildFleetStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(buildFleetStatus).mockResolvedValueOnce(canonicalFleet as never);
    const { handleApi } = await import('../src/core/web/api.js');
    const req = { url: '/api/fleet', method: 'GET', headers: {} } as IncomingMessage;
    let body = '';
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((chunk?: string) => { body = chunk ?? ''; }),
    } as unknown as ServerResponse;

    const handled = await handleApi(req, res, {} as never, { token: 'test', allowDispatch: false });
    expect(handled).toBe(true);
    expect(JSON.parse(body)).toEqual(canonicalFleet);
  });

  it('preserves legacy FleetStatus payloads without synthesizing identity', async () => {
    const legacyFleet = { killed: false, queue: [] };
    const { buildFleetStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(buildFleetStatus).mockResolvedValueOnce(legacyFleet as never);
    const { handleApi } = await import('../src/core/web/api.js');
    const req = { url: '/api/fleet', method: 'GET', headers: {} } as IncomingMessage;
    let body = '';
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((chunk?: string) => { body = chunk ?? ''; }),
    } as unknown as ServerResponse;

    const handled = await handleApi(req, res, {} as never, { token: 'test', allowDispatch: false });
    expect(handled).toBe(true);
    expect(JSON.parse(body)).toEqual(legacyFleet);
  });
});
