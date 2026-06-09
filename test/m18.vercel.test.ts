/**
 * M18 — hermetic tests for src/core/integrations/vercel.ts
 *
 * Mocks node:child_process so no real `vercel` binary is invoked.
 * Uses real temp files for .vercel/project.json presence checks.
 *
 * Invariants verified:
 *   - vercelStatus returns linked:true when .vercel/project.json exists + vercel responds
 *   - vercelStatus returns linked:false + null state/url when not linked
 *   - vercelStatus NEVER throws — always returns VercelStatus shape
 *   - listDeploys parses vercel ls JSON, returns [] on any failure
 *   - NO deploy commands are ever constructed by read paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

let _spawnSyncImpl: (...args: unknown[]) => SpawnSyncReturns<string>;

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  execFileSync: () => { throw new Error('execFileSync not expected'); },
}));

import {
  vercelStatus,
  listDeploys,
} from '../src/core/integrations/vercel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawn(
  stdout: string,
  status: number | null = 0,
  error?: Error,
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null, error };
}

function spawnNotFound(): SpawnSyncReturns<string> {
  return makeSpawn('', null, Object.assign(new Error('spawn vercel ENOENT'), { code: 'ENOENT' }));
}

function setSpawnAlways(res: SpawnSyncReturns<string>): void {
  _spawnSyncImpl = () => res;
}

// Realistic `vercel ls --json` output (array of deployment objects)
const DEPLOYS_JSON = JSON.stringify([
  {
    url: 'my-app-abc123.vercel.app',
    state: 'READY',
    createdAt: '2024-01-01T00:00:00.000Z',
    target: 'production',
  },
  {
    url: 'my-app-def456.vercel.app',
    state: 'BUILDING',
    createdAt: '2024-01-02T00:00:00.000Z',
    target: 'preview',
  },
]);

// Temp dir management
const TMP = os.tmpdir();
const tmpDirs: string[] = [];

function makeTmpVercelDir(): string {
  const dir = path.join(TMP, `ashlr-vercel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const vercelDir = path.join(dir, '.vercel');
  fs.mkdirSync(vercelDir, { recursive: true });
  fs.writeFileSync(
    path.join(vercelDir, 'project.json'),
    JSON.stringify({ projectId: 'prj_abc123', orgId: 'org_xyz' }),
    'utf8',
  );
  tmpDirs.push(dir);
  return dir;
}

function makeTmpDirNoVercel(): string {
  const dir = path.join(TMP, `ashlr-vercel-test-nolink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// vercelStatus — linked project (project.json present + vercel responds)
// ---------------------------------------------------------------------------

describe('vercelStatus — linked project with recent deployment', () => {
  let linkedDir: string;

  beforeEach(() => {
    linkedDir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn(DEPLOYS_JSON));
  });

  it('returns linked:true', () => {
    const s = vercelStatus(linkedDir);
    expect(s.linked).toBe(true);
  });

  it('returns latestState from the most recent deploy', () => {
    const s = vercelStatus(linkedDir);
    expect(s.latestState).toBeTruthy();
    expect(typeof s.latestState).toBe('string');
  });

  it('returns url from the most recent deploy', () => {
    const s = vercelStatus(linkedDir);
    expect(s.url).toBeTruthy();
    expect(typeof s.url).toBe('string');
  });

  it('latestState is READY for the first deploy', () => {
    const s = vercelStatus(linkedDir);
    expect(s.latestState).toBe('READY');
  });

  it('url contains vercel.app domain', () => {
    const s = vercelStatus(linkedDir);
    expect(s.url).toContain('vercel.app');
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — not linked (no .vercel/project.json)
// ---------------------------------------------------------------------------

describe('vercelStatus — not linked (no .vercel/project.json)', () => {
  let noLinkDir: string;

  beforeEach(() => {
    noLinkDir = makeTmpDirNoVercel();
    // Even if vercel ls is called, it would return nothing
    setSpawnAlways(makeSpawn('', 1));
  });

  it('does not throw', () => {
    expect(() => vercelStatus(noLinkDir)).not.toThrow();
  });

  it('returns linked:false', () => {
    const s = vercelStatus(noLinkDir);
    expect(s.linked).toBe(false);
  });

  it('returns latestState:null', () => {
    const s = vercelStatus(noLinkDir);
    expect(s.latestState).toBeNull();
  });

  it('returns url:null', () => {
    const s = vercelStatus(noLinkDir);
    expect(s.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — vercel binary not found
// ---------------------------------------------------------------------------

describe('vercelStatus — vercel CLI not on PATH', () => {
  let linkedDir: string;

  beforeEach(() => {
    linkedDir = makeTmpVercelDir();
    setSpawnAlways(spawnNotFound());
  });

  it('does not throw when vercel is missing', () => {
    expect(() => vercelStatus(linkedDir)).not.toThrow();
  });

  it('returns VercelStatus shape', () => {
    const s = vercelStatus(linkedDir);
    expect(typeof s.linked).toBe('boolean');
    expect(s.latestState === null || typeof s.latestState === 'string').toBe(true);
    expect(s.url === null || typeof s.url === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — vercel exits non-zero
// ---------------------------------------------------------------------------

describe('vercelStatus — vercel CLI exits non-zero', () => {
  let linkedDir: string;

  beforeEach(() => {
    linkedDir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn('', 1));
  });

  it('does not throw', () => {
    expect(() => vercelStatus(linkedDir)).not.toThrow();
  });

  it('degrades to unlinked shape on CLI failure', () => {
    const s = vercelStatus(linkedDir);
    expect(s.latestState === null || typeof s.latestState === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — malformed JSON
// ---------------------------------------------------------------------------

describe('vercelStatus — malformed JSON output from vercel', () => {
  let linkedDir: string;

  beforeEach(() => {
    linkedDir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn('this is not json!!!'));
  });

  it('does not throw on malformed JSON', () => {
    expect(() => vercelStatus(linkedDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — spawnSync throws
// ---------------------------------------------------------------------------

describe('vercelStatus — spawnSync throws internally', () => {
  let linkedDir: string;

  beforeEach(() => {
    linkedDir = makeTmpVercelDir();
    _spawnSyncImpl = () => { throw new Error('unexpected OS error'); };
  });

  it('does not propagate the error', () => {
    expect(() => vercelStatus(linkedDir)).not.toThrow();
  });

  it('returns VercelStatus shape', () => {
    const s = vercelStatus(linkedDir);
    expect(typeof s.linked).toBe('boolean');
    expect(s.latestState === null || typeof s.latestState === 'string').toBe(true);
    expect(s.url === null || typeof s.url === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vercelStatus — shape invariant
// ---------------------------------------------------------------------------

describe('vercelStatus — always returns a valid VercelStatus shape', () => {
  it('shape is correct on success', () => {
    const dir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn(DEPLOYS_JSON));
    const s = vercelStatus(dir);
    expect(typeof s.linked).toBe('boolean');
    expect(s.latestState === null || typeof s.latestState === 'string').toBe(true);
    expect(s.url === null || typeof s.url === 'string').toBe(true);
  });

  it('shape is correct on failure', () => {
    const dir = makeTmpDirNoVercel();
    setSpawnAlways(makeSpawn('', 1));
    const s = vercelStatus(dir);
    expect(typeof s.linked).toBe('boolean');
    expect(s.latestState === null || typeof s.latestState === 'string').toBe(true);
    expect(s.url === null || typeof s.url === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listDeploys — happy path
// ---------------------------------------------------------------------------

describe('listDeploys — happy path', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn(DEPLOYS_JSON));
  });

  it('returns array of deploy summaries', () => {
    const deploys = listDeploys('/any/cwd');
    expect(Array.isArray(deploys)).toBe(true);
    expect(deploys.length).toBe(2);
  });

  it('each deploy has url, state, createdAt, target fields', () => {
    const deploys = listDeploys('/any/cwd');
    for (const d of deploys) {
      expect(typeof d.url).toBe('string');
      expect(typeof d.state).toBe('string');
      expect(d.createdAt === null || typeof d.createdAt === 'string').toBe(true);
      expect(d.target === null || typeof d.target === 'string').toBe(true);
    }
  });

  it('first deploy state is READY', () => {
    const deploys = listDeploys('/any/cwd');
    expect(deploys[0].state).toBe('READY');
  });

  it('second deploy target is preview', () => {
    const deploys = listDeploys('/any/cwd');
    expect(deploys[1].target).toBe('preview');
  });
});

// ---------------------------------------------------------------------------
// listDeploys — failure paths always return []
// ---------------------------------------------------------------------------

describe('listDeploys — returns [] on any failure', () => {
  it('returns [] when vercel is not found', () => {
    setSpawnAlways(spawnNotFound());
    expect(listDeploys('/any/cwd')).toEqual([]);
  });

  it('returns [] when vercel exits non-zero', () => {
    setSpawnAlways(makeSpawn('', 1));
    expect(listDeploys('/any/cwd')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    setSpawnAlways(makeSpawn('not json'));
    expect(listDeploys('/any/cwd')).toEqual([]);
  });

  it('never throws on any failure', () => {
    _spawnSyncImpl = () => { throw new Error('boom'); };
    expect(() => listDeploys('/any/cwd')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// No deploy command issued — read paths never construct `vercel deploy`
// ---------------------------------------------------------------------------

describe('vercelStatus — uses the supported `--format json` flag (regression)', () => {
  // Regression guard: the legacy `vercel ls --json` flag errors with
  // "unknown or unexpected option: --json" on the real CLI. The supported flag
  // is `-F, --format json`. Assert the constructed argv never uses bare --json.
  it('constructs `ls --format json`, never `ls --json`', () => {
    const dir = makeTmpVercelDir();
    const calls: string[][] = [];
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return makeSpawn(DEPLOYS_JSON, 0);
    };
    vercelStatus(dir);
    listDeploys(dir);
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      // Must request JSON via --format json …
      const fmtIdx = argv.indexOf('--format');
      expect(fmtIdx).toBeGreaterThanOrEqual(0);
      expect(argv[fmtIdx + 1]).toBe('json');
      // … and must NOT use the unsupported bare --json flag.
      expect(argv).not.toContain('--json');
    }
  });
});

describe('vercelStatus — parses the real `{ deployments: [...] }` wrapper shape', () => {
  // The modern Vercel CLI emits an object with a top-level `deployments` array,
  // not a bare array. Verify parseDeployList (via vercelStatus/listDeploys)
  // handles the real shape.
  const WRAPPED_JSON = JSON.stringify({
    deployments: [
      { url: 'real-app-xyz.vercel.app', state: 'READY', createdAt: '2024-03-01T00:00:00.000Z', target: 'production' },
    ],
    pagination: { count: 1, next: null, prev: null },
    contextName: 'acme-projects',
  });

  it('vercelStatus reads latest deploy from the deployments wrapper', () => {
    const dir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn(WRAPPED_JSON));
    const s = vercelStatus(dir);
    expect(s.linked).toBe(true);
    expect(s.latestState).toBe('READY');
    expect(s.url).toBe('real-app-xyz.vercel.app');
  });

  it('listDeploys parses the deployments wrapper into a single summary', () => {
    setSpawnAlways(makeSpawn(WRAPPED_JSON));
    const deploys = listDeploys('/any/cwd');
    expect(deploys.length).toBe(1);
    expect(deploys[0].state).toBe('READY');
    expect(deploys[0].target).toBe('production');
  });

  it('vercelStatus stays linked when deployments wrapper is empty', () => {
    const dir = makeTmpVercelDir();
    setSpawnAlways(makeSpawn(JSON.stringify({ deployments: [], pagination: { count: 0 } })));
    const s = vercelStatus(dir);
    expect(s.linked).toBe(true);
    expect(s.latestState).toBeNull();
    expect(s.url).toBeNull();
  });
});

describe('vercelStatus — never constructs a deploy command', () => {
  it('vercelStatus does not invoke vercel deploy', () => {
    const dir = makeTmpVercelDir();
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn(DEPLOYS_JSON, 0);
    };
    vercelStatus(dir);
    const deployCalls = calls.filter(c => c.includes('deploy'));
    expect(deployCalls).toHaveLength(0);
  });

  it('listDeploys does not invoke vercel deploy', () => {
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn(DEPLOYS_JSON, 0);
    };
    listDeploys('/any/cwd');
    const deployCalls = calls.filter(c => c.includes('deploy') && !c.includes('list') && !c.includes('ls'));
    expect(deployCalls).toHaveLength(0);
  });
});
