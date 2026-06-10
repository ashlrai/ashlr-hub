/**
 * M30 seams CLI tests — hermetic, tmp HOME. NEVER touches the real ~/.ashlr,
 * NEVER mutates anything, NEVER makes a remote call.
 *
 * `ashlr seams` is a READ-ONLY diagnostic: it loads the in-memory config, builds
 * the seam registry from static descriptors, and renders a table (or JSON). It
 * instantiates NO seam impl and performs NO I/O beyond reading config.
 *
 * Invariants under test (the M30 HARD safety invariants, at the CLI surface):
 *   1. INTERFACES + LOCAL ONLY: every seam lists active=local on the default
 *      path (no cloud endpoint configured), and the seven v2 seams report
 *      cloud=gated (the telemetry reference seam reports cloud=false).
 *   2. NO ACTIVATION PATH: with the DEFAULT config (no `seams` block) every seam
 *      is local and `endpointConfigured` is false for all of them.
 *   4. NOTHING PUBLIC: the command makes ZERO network connections (fetch is
 *      stubbed to reject and must never be called).
 *   5. READ-ONLY: a default run writes NOTHING under ~/.ashlr beyond what
 *      loadConfig() may seed (the config dir/file) — it creates no seam state,
 *      inbox, swarm, quality, or genome dirs.
 *
 * Also covers: --json emits a valid SeamRegistry; --help prints usage; unknown
 * flags/args are usage errors (exit 2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SeamRegistry, SeamStatus } from '../src/core/seams/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — every ~/.ashlr access is redirected to a tmp dir
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
let tmpHome: string;

function ashlrDir(...p: string[]): string {
  return path.join(tmpHome, '.ashlr', ...p);
}

/** Capture stdout during `fn`; silence stderr. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await fn();
    return { code, out };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Recursively list every file under a dir (relative paths), or [] if absent. */
function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const acc: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else acc.push(childRel);
    }
  };
  walk(root, '');
  return acc.sort();
}

let cmdSeams: (args: string[]) => Promise<number>;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m30-cli-home-'));
  process.env['HOME'] = tmpHome;

  vi.resetModules();
  // Re-import after resetModules so config/registry resolve under the tmp HOME.
  const mod = await import('../src/cli/seams.js');
  cmdSeams = mod.cmdSeams;

  // NOTHING PUBLIC: block EVERY network connection. A read-only diagnostic must
  // never fetch — even when building the registry for a "gated" seam.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch blocked in m30 cli test')));
});

afterEach(() => {
  process.env['HOME'] = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default + status: lists every seam with active=local + cloud=gated
// ---------------------------------------------------------------------------

describe('seams — default / status table', () => {
  it('lists all seams with active=local and the v2 seams as cloud=gated (exit 0)', async () => {
    const { code, out } = await capture(() => cmdSeams([]));

    expect(code).toBe(0);
    expect(out).toContain('Seams');
    // Header columns.
    expect(out).toContain('SEAM');
    expect(out).toContain('ACTIVE');
    expect(out).toContain('CLOUD');

    // Every v2 seam name is present in the rendered table.
    for (const name of [
      'RunSwarmStore',
      'BacklogSource',
      'InboxStore',
      'DaemonCoordinator',
      'GenomeSync',
      'PortfolioSync',
      'IdentityProvider',
      'TelemetrySink',
    ]) {
      expect(out).toContain(name);
    }

    // On the default path EVERY seam is local; the cloud/team backbone is gated.
    expect(out).toContain('local');
    expect(out).toContain('gated');
    expect(out).toContain('All seams are serving their LOCAL implementation.');
    expect(out).toContain('GATED on Mason');
  });

  it('`seams status` is equivalent to the default invocation', async () => {
    const def = await capture(() => cmdSeams([]));
    const status = await capture(() => cmdSeams(['status']));
    expect(status.code).toBe(0);
    expect(def.code).toBe(0);
    // Strip the per-run ISO timestamp differences out of human output (there is
    // none in the human table) — the rendered bodies should be identical.
    expect(status.out).toBe(def.out);
  });
});

// ---------------------------------------------------------------------------
// --json emits a valid SeamRegistry of the whole registry
// ---------------------------------------------------------------------------

describe('seams --json — registry shape', () => {
  it('emits a valid SeamRegistry with every seam local + the v2 seams gated', async () => {
    const { code, out } = await capture(() => cmdSeams(['--json']));
    expect(code).toBe(0);

    const reg = JSON.parse(out.trim()) as SeamRegistry;
    expect(typeof reg.generatedAt).toBe('string');
    expect(Array.isArray(reg.seams)).toBe(true);
    expect(reg.seams).toHaveLength(8);

    // INVARIANT 1 + 2: every seam active=local on the default config; nothing
    // is configured to route to a (gated) cloud stub.
    expect(reg.allLocal).toBe(true);
    expect(reg.gatedConfigured).toBe(0);
    for (const s of reg.seams) {
      expect(s.active).toBe('local');
      expect(s.endpointConfigured).toBe(false);
    }

    // The seven v2 seams expose a GATED cloud stub; telemetry is cited as a
    // local-network reference seam (cloud=false), NEVER true for any seam.
    const byId = new Map<string, SeamStatus>(reg.seams.map((s) => [s.id, s]));
    for (const id of [
      'runSwarm',
      'backlog',
      'inbox',
      'daemonCoordinator',
      'genome',
      'portfolio',
      'identity',
    ]) {
      expect(byId.get(id)?.cloud).toBe('gated');
    }
    expect(byId.get('telemetry')?.cloud).toBe(false);
    // NEVER `true` for any seam in M30.
    for (const s of reg.seams) expect(s.cloud).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 4 + 5: READ-ONLY / NOTHING PUBLIC — no write, no network
// ---------------------------------------------------------------------------

describe('seams — READ-ONLY + no outward call', () => {
  it('a default run makes ZERO network connections', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network in seams diagnostic'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await capture(() => cmdSeams([]));
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the --json run likewise never fetches', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network in seams diagnostic'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await capture(() => cmdSeams(['--json']));
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates NO seam/inbox/swarm/quality/genome state under ~/.ashlr', async () => {
    await capture(() => cmdSeams([]));
    await capture(() => cmdSeams(['--json']));

    // The diagnostic instantiates no seam impl, so none of the wrapped stores'
    // state directories may appear. (loadConfig may seed the config dir/file;
    // that is the only thing allowed to exist.)
    for (const sub of ['seams', 'inbox', 'swarm', 'quality', 'genome', 'daemon']) {
      expect(fs.existsSync(ashlrDir(sub))).toBe(false);
    }
    // Whatever loadConfig seeded, no JSON state file beyond config.json/index.json.
    const files = listFiles(ashlrDir());
    for (const f of files) {
      expect(['config.json', 'index.json']).toContain(path.basename(f));
    }
  });
});

// ---------------------------------------------------------------------------
// Usage: --help, unknown flag/arg
// ---------------------------------------------------------------------------

describe('seams — usage', () => {
  it('--help prints usage and returns 0', async () => {
    const { code, out } = await capture(() => cmdSeams(['--help']));
    expect(code).toBe(0);
    expect(out).toContain('ashlr seams');
    expect(out).toContain('--json');
  });

  it('returns 2 on an unknown flag', async () => {
    const { code } = await capture(() => cmdSeams(['--frobnicate']));
    expect(code).toBe(2);
  });

  it('returns 2 on an unknown positional argument', async () => {
    const { code } = await capture(() => cmdSeams(['bogus']));
    expect(code).toBe(2);
  });
});
