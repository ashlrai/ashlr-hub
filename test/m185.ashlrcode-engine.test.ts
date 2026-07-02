/**
 * M185 (SPEC-V7) — ashlrcode-as-executor adapter tests.
 *
 * Hermetic + deterministic: NO real `ac` spawn, NO network. We mock the two
 * collaborators the adapter calls into engines.js:
 *   - engineInstalled  → control `ac` availability
 *   - spawnEngine      → assert the exact argv handed to `ac`, return canned out
 * and mock node:child_process spawnSync → control the git probes (baseHead +
 * diff capture) without touching a real repo.
 *
 * Covers:
 *   1. Flag OFF (default)            → clean no-op, never spawns ac.
 *   2. Flag ON but `ac` absent       → clean no-op {ok:false,'ac not installed'}.
 *   3. Happy path: invokes `ac --autonomous --goal <task>` and captures the diff.
 *   4. Goal composition: title + detail folded into the --goal arg.
 *   5. spawnEngine reports failure   → {ok:false}, never throws.
 *   6. spawnEngine THROWS            → adapter still returns {ok:false} (contract).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ── Mock the engines.js collaborators ──────────────────────────────────────
const engineInstalledMock = vi.fn<(engine: string, cfg?: AshlrConfig) => boolean>();
const spawnEngineMock = vi.fn();

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: (engine: string, cfg?: AshlrConfig) => engineInstalledMock(engine, cfg),
  spawnEngine: (...args: unknown[]) => spawnEngineMock(...args),
}));

// ── Mock node:child_process spawnSync (the git probes) ──────────────────────
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { runViaAshlrcode } from '../src/core/run/ashlrcode-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {},
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

/** A config with the M185 executor flag flipped on. */
function enabledConfig(over: Record<string, unknown> = {}): AshlrConfig {
  return makeConfig({ foundry: { ashlrcodeExecutor: true, ...over } });
}

const REPO = '/tmp/some-repo';
const ITEM = { title: 'Fix the flaky test', detail: 'It fails 1/10 runs due to a race.' };

/** Drive the git spawnSync mock: rev-parse HEAD → base, diff → patch, name-only. */
function gitOk(opts: { base?: string; patch?: string; names?: string } = {}) {
  spawnSyncMock.mockImplementation((_bin: string, args: string[]) => {
    const sub = args[2]; // ['-C', repoDir, <sub>, ...]
    if (sub === 'rev-parse') return { status: 0, stdout: (opts.base ?? 'abc123') + '\n', error: null };
    if (sub === 'add') return { status: 0, stdout: '', error: null };
    if (sub === 'diff') {
      if (args.includes('--name-only')) return { status: 0, stdout: opts.names ?? '', error: null };
      return { status: 0, stdout: opts.patch ?? '', error: null };
    }
    return { status: 0, stdout: '', error: null };
  });
}

beforeEach(() => {
  engineInstalledMock.mockReset();
  spawnEngineMock.mockReset();
  spawnSyncMock.mockReset();
  // Default: ac installed; git probes benign.
  engineInstalledMock.mockReturnValue(true);
  gitOk();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Flag OFF (default) — clean no-op
// ===========================================================================

describe('M185 runViaAshlrcode — flag gating', () => {
  it('flag absent (default) → clean no-op, never spawns ac', async () => {
    const res = await runViaAshlrcode(ITEM, REPO, makeConfig());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled/i);
    expect(spawnEngineMock).not.toHaveBeenCalled();
  });

  it('flag explicitly false → clean no-op', async () => {
    const res = await runViaAshlrcode(ITEM, REPO, makeConfig({ foundry: { ashlrcodeExecutor: false } }));
    expect(res.ok).toBe(false);
    expect(spawnEngineMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. ac absent — clean no-op
// ===========================================================================

describe('M185 runViaAshlrcode — ac availability', () => {
  it('flag ON but ac not installed → {ok:false,"ac not installed"}, never spawns', async () => {
    engineInstalledMock.mockReturnValue(false);
    const res = await runViaAshlrcode(ITEM, REPO, enabledConfig());
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ac not installed');
    expect(spawnEngineMock).not.toHaveBeenCalled();
  });

  it('availability is probed for the ashlrcode engine', async () => {
    engineInstalledMock.mockReturnValue(false);
    await runViaAshlrcode(ITEM, REPO, enabledConfig());
    expect(engineInstalledMock).toHaveBeenCalledWith('ashlrcode', expect.anything());
  });
});

// ===========================================================================
// 3 + 4. Happy path — invokes `ac --autonomous --goal <task>` + captures diff
// ===========================================================================

describe('M185 runViaAshlrcode — happy path', () => {
  it('invokes `ac --autonomous` with the work item as the --goal and captures the diff', async () => {
    const PATCH = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    gitOk({ base: 'base999', patch: PATCH, names: 'x.ts\ny.ts' });
    spawnEngineMock.mockReturnValue({ ok: true, output: 'done: fixed the race' });

    const res = await runViaAshlrcode(ITEM, REPO, enabledConfig());

    // spawnEngine called exactly once with the `ac` command.
    expect(spawnEngineMock).toHaveBeenCalledTimes(1);
    const [cmd, , spawnOpts] = spawnEngineMock.mock.calls[0] as [
      { bin: string; args: string[]; cwd: string },
      unknown,
      { timeoutMs?: number },
    ];
    expect(cmd.bin).toBe('ac');
    expect(cmd.cwd).toBe(REPO);
    expect(cmd.args).toContain('--autonomous');
    expect(cmd.args).toContain('--goal');
    expect(cmd.args).toContain('--dangerously-skip-permissions');
    // The goal arg immediately follows --goal and carries the title.
    const goalArg = cmd.args[cmd.args.indexOf('--goal') + 1];
    expect(goalArg).toContain(ITEM.title);
    expect(goalArg).toContain(ITEM.detail);
    // Bounded: a positive timeout was passed to the spawn.
    expect(typeof spawnOpts.timeoutMs).toBe('number');
    expect(spawnOpts.timeoutMs).toBeGreaterThan(0);

    // Result carries the captured diff + files + summary. gitTry trims output,
    // so the captured diff is the trimmed patch.
    expect(res.ok).toBe(true);
    expect(res.diff).toBe(PATCH.trim());
    expect(res.files).toEqual(['x.ts', 'y.ts']);
    expect(res.summary).toBe('done: fixed the race');
  });

  it('diff is captured relative to the pre-run HEAD (rev-parse → diff <base>)', async () => {
    gitOk({ base: 'preRunSha', patch: 'patch-body', names: 'a.ts' });
    spawnEngineMock.mockReturnValue({ ok: true, output: 'ok' });

    await runViaAshlrcode(ITEM, REPO, enabledConfig());

    // A `git diff preRunSha` was issued (baseHead-relative capture).
    const diffCall = spawnSyncMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('diff') && (c[1] as string[]).includes('preRunSha'),
    );
    expect(diffCall).toBeDefined();
  });

  it('title-only item (no detail) → goal is just the title', async () => {
    spawnEngineMock.mockReturnValue({ ok: true, output: '' });
    await runViaAshlrcode({ title: 'Just a title' }, REPO, enabledConfig());
    const cmd = spawnEngineMock.mock.calls[0][0] as { args: string[] };
    const goalArg = cmd.args[cmd.args.indexOf('--goal') + 1];
    expect(goalArg).toBe('Just a title');
  });

  it('empty diff → ok:true with no diff/files', async () => {
    gitOk({ base: 'b', patch: '', names: '' });
    spawnEngineMock.mockReturnValue({ ok: true, output: 'nothing to do' });
    const res = await runViaAshlrcode(ITEM, REPO, enabledConfig());
    expect(res.ok).toBe(true);
    expect(res.diff).toBeUndefined();
    expect(res.files).toBeUndefined();
  });

  it('normalizes a file-valued repoDir to its parent directory for ac and git cwd', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ashlr-m185-file-cwd-'));
    try {
      const srcDir = join(tmp, 'src', 'core', 'goals');
      mkdirSync(srcDir, { recursive: true });
      const filePath = join(srcDir, 'store.ts');
      writeFileSync(filePath, 'export const x = 1;\n', 'utf8');
      gitOk({ base: 'base-file', patch: 'patch-body', names: 'store.ts' });
      spawnEngineMock.mockReturnValue({ ok: true, output: 'done' });

      const res = await runViaAshlrcode(ITEM, filePath, enabledConfig());

      expect(res.ok).toBe(true);
      const cmd = spawnEngineMock.mock.calls[0][0] as { cwd: string };
      expect(cmd.cwd).toBe(srcDir);
      for (const call of spawnSyncMock.mock.calls) {
        const args = call[1] as string[];
        expect(args[0]).toBe('-C');
        expect(args[1]).toBe(srcDir);
        expect(args[1]).not.toBe(filePath);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects an explicit opts.timeoutMs / maxIterations', async () => {
    spawnEngineMock.mockReturnValue({ ok: true, output: '' });
    await runViaAshlrcode(ITEM, REPO, enabledConfig(), { timeoutMs: 5000, maxIterations: 7 });
    const [cmd, , spawnOpts] = spawnEngineMock.mock.calls[0] as [
      { args: string[] },
      unknown,
      { timeoutMs?: number },
    ];
    expect(spawnOpts.timeoutMs).toBe(5000);
    expect(cmd.args[cmd.args.indexOf('--max-iterations') + 1]).toBe('7');
    // ac's --timeout is seconds derived from the ms wall-clock (5000ms → 5s).
    expect(cmd.args[cmd.args.indexOf('--timeout') + 1]).toBe('5');
  });
});

// ===========================================================================
// 5 + 6. Failure containment — never throws
// ===========================================================================

describe('M185 runViaAshlrcode — never throws', () => {
  it('spawnEngine reports failure → {ok:false} with the error, no throw', async () => {
    spawnEngineMock.mockReturnValue({ ok: false, output: '', error: 'exit 1' });
    let res: Awaited<ReturnType<typeof runViaAshlrcode>> | undefined;
    await expect(
      (async () => {
        res = await runViaAshlrcode(ITEM, REPO, enabledConfig());
      })(),
    ).resolves.toBeUndefined();
    expect(res!.ok).toBe(false);
    expect(res!.error).toBe('exit 1');
  });

  it('spawnEngine THROWS → adapter still returns {ok:false} (contract)', async () => {
    spawnEngineMock.mockImplementation(() => {
      throw new Error('boom');
    });
    let threw = false;
    let res: Awaited<ReturnType<typeof runViaAshlrcode>> | undefined;
    try {
      res = await runViaAshlrcode(ITEM, REPO, enabledConfig());
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res!.ok).toBe(false);
    expect(res!.error).toMatch(/boom/);
  });

  it('git probe throwing does not break a successful run (diff just omitted)', async () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('git missing');
    });
    spawnEngineMock.mockReturnValue({ ok: true, output: 'done' });
    const res = await runViaAshlrcode(ITEM, REPO, enabledConfig());
    expect(res.ok).toBe(true);
    expect(res.diff).toBeUndefined();
    expect(res.summary).toBe('done');
  });
});
