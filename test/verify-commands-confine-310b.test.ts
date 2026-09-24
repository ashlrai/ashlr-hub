/**
 * V3.10 R3a — G3 confinement at the verification CHOKEPOINT
 * (run/verify-commands.ts runVerifyCommandAsync / runVerifyCommand).
 *
 * INT4 left G3 unconfined for every consumer except the two that open their
 * own sandbox (inbox/merge.ts, fleet/post-merge-watch.ts): the completeness
 * gate, verify-to-green, run-tests, the regression sentinel and self-heal all
 * ran agent-authored suites with Mason's full authority. Now, while a standing
 * policy is live, the chokepoint wraps every command with
 * prepareConfinedVerification's prefix/env; with no policy nothing changes.
 *
 * - Platform-independent cases swap the sandbox for a stand-in prefix
 *   (`/usr/bin/env MARK=1`) to prove the wiring: which calls wrap, what is
 *   granted read-only, fail-closed on a sandbox that cannot be built, and that
 *   a caller-owned runner is never double-wrapped.
 * - The darwin cases run the REAL sandbox-exec on a synthetic suite: writes
 *   inside the worktree succeed, writes outside are denied, a read of
 *   ~/.ashlr/authority is denied (tripwire) and recorded as a violation, and
 *   the linked node_modules is readable but not writable.
 *
 * HOME is the per-test isolated home (test/setup/home.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ policy: null as unknown, throws: false }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => {
    if (standing.throws) throw new Error('authority state unreadable');
    return standing.policy;
  },
}));

const violations = vi.hoisted(() => ({ calls: [] as Array<{ engine: string; operations: readonly string[] }> }));
vi.mock('../src/core/sandbox/autonomous-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/autonomous-run.js')>();
  return {
    ...actual,
    recordAutonomousViolations: async (input: { engine: string; operations: readonly string[] }) => {
      violations.calls.push({ engine: input.engine, operations: [...input.operations] });
    },
  };
});

const verify = await import('../src/core/run/verify-commands.js');
const { runVerifyCommandAsync, runVerifyCommand, runVerifySubprocessAsync, __setVerifyConfinementForTests } = verify;
type AshlrConfig = import('../src/core/types.js').AshlrConfig;
type Opener = Parameters<typeof __setVerifyConfinementForTests>[0];

const cfg = {} as AshlrConfig;
const onDarwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

let root: string;
let worktree: string;
let mirror: string;

beforeEach(() => {
  standing.policy = null;
  standing.throws = false;
  violations.calls = [];
  const home = realpathSync(homedir());
  mkdirSync(join(home, 'work'), { recursive: true });
  root = realpathSync(mkdtempSync(join(home, 'work', 'r3a-')));
  worktree = join(root, 'wt');
  mirror = join(root, 'mirror');
  mkdirSync(worktree, { recursive: true });
  // A "mirror" repo with its own install, symlinked into the worktree exactly
  // as worktree.ts / merge.ts link node_modules into sandboxes.
  mkdirSync(join(mirror, '.git'), { recursive: true });
  mkdirSync(join(mirror, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(mirror, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep-ok";\n');
  symlinkSync(join(mirror, 'node_modules'), join(worktree, 'node_modules'), 'dir');
});

afterEach(() => {
  __setVerifyConfinementForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function nodeCommand(script: string) {
  return { kind: 'test' as const, cmd: ['node', '-e', script], required: true, id: 'r3a-confined' };
}

/** A stand-in "sandbox": prefixes `/usr/bin/env R3A_CONFINED=1` and records what it was asked to grant. */
function fakeOpener(record: { calls: Array<{ worktree: string; readOnly: readonly string[] }>; disposed: number }): Opener {
  return (input) => {
    record.calls.push({ worktree: input.worktree, readOnly: [...input.readOnly] });
    return {
      prefix: ['/usr/bin/env', 'R3A_CONFINED=1'],
      env: { ...input.baseEnv, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
      runDir: root,
      dispose: () => { record.disposed += 1; },
    };
  };
}

const markScript = "require('fs').writeFileSync('mark.txt', process.env.R3A_CONFINED ?? 'unconfined')";

describe('chokepoint wiring (stand-in sandbox)', () => {
  it('no standing policy: the command runs exactly as before (never wrapped)', async () => {
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    const res = await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(res.ok, res.output).toBe(true);
    expect(readFileSync(join(worktree, 'mark.txt'), 'utf8')).toBe('unconfined');
    expect(record.calls).toHaveLength(0);
  });

  it('standing policy live: async runs under the prefix, grants the linked node_modules read-only, disposes the run', async () => {
    standing.policy = { grantId: 'g' };
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    const res = await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, {
      timeoutMs: 30_000,
      confinementReadOnly: ['/opt/extra-read'],
    });
    expect(res.ok, res.output).toBe(true);
    expect(readFileSync(join(worktree, 'mark.txt'), 'utf8')).toBe('1');
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.worktree).toBe(worktree);
    expect(record.calls[0]!.readOnly).toEqual([join(mirror, 'node_modules'), '/opt/extra-read']);
    expect(record.disposed).toBe(1);
  });

  it('standing policy live: the sync runner chain runs under the prefix and grants node + the runner script', () => {
    standing.policy = { grantId: 'g' };
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    const res = runVerifyCommand(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(res.ok, res.output).toBe(true);
    expect(readFileSync(join(worktree, 'mark.txt'), 'utf8')).toBe('1');
    expect(record.calls).toHaveLength(1);
    const granted = record.calls[0]!.readOnly;
    expect(granted).toContain(join(mirror, 'node_modules'));
    expect(granted).toContain(process.execPath);
    expect(granted.some((p) => p.endsWith('scripts/run-verify-command.mjs'))).toBe(true);
    expect(record.disposed).toBe(1);
  });

  it('unknown standing state (the probe throws) confines — never runs unconfined', async () => {
    standing.throws = true;
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    const res = await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(res.ok, res.output).toBe(true);
    expect(readFileSync(join(worktree, 'mark.txt'), 'utf8')).toBe('1');
  });

  it('fails CLOSED when a policy is live and the sandbox cannot be built (async and sync)', async () => {
    standing.policy = { grantId: 'g' };
    __setVerifyConfinementForTests(() => { throw new Error('no sandbox-exec here'); });
    const res = await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(res.ok).toBe(false);
    expect(res.failureCategory).toBe('infra');
    expect(res.output).toContain('fail-closed');
    expect(existsSync(join(worktree, 'mark.txt'))).toBe(false);

    const sync = runVerifyCommand(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(sync.ok).toBe(false);
    expect(sync.failureCategory).toBe('infra');
    expect(existsSync(join(worktree, 'mark.txt'))).toBe(false);
  });

  it('a caller-owned runner is never wrapped again (merge.ts / post-merge-watch already confine)', async () => {
    standing.policy = { grantId: 'g' };
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    const seen: string[][] = [];
    const res = await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, {
      timeoutMs: 30_000,
      _runSubprocess: (argv, o) => { seen.push(argv); return runVerifySubprocessAsync(argv, o); },
    });
    expect(res.ok, res.output).toBe(true);
    expect(record.calls).toHaveLength(0);
    expect(seen[0]![0]).toBe('node');
  });

  it('an agent-planted node_modules symlink to a non-install directory is not granted', async () => {
    standing.policy = { grantId: 'g' };
    rmSync(join(worktree, 'node_modules'));
    const secretDir = join(root, 'secrets');
    mkdirSync(secretDir);
    symlinkSync(secretDir, join(worktree, 'node_modules'), 'dir');
    const record = { calls: [] as Array<{ worktree: string; readOnly: readonly string[] }>, disposed: 0 };
    __setVerifyConfinementForTests(fakeOpener(record));
    await runVerifyCommandAsync(nodeCommand(markScript), worktree, cfg, { timeoutMs: 30_000 });
    expect(record.calls[0]!.readOnly).toEqual([]);
  });
});

describe.skipIf(!onDarwin)('real sandbox-exec on a synthetic suite (darwin)', () => {
  let secret: string;
  let outside: string;

  beforeEach(() => {
    standing.policy = { grantId: 'g' };
    const home = realpathSync(homedir());
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    secret = join(home, '.ashlr', 'authority', 'r3a-secret');
    writeFileSync(secret, 'not-for-verified-code', { mode: 0o600 });
    outside = join(root, 'outside.txt');
  });

  it('async: inside write ok, outside write denied, authority read denied + recorded, linked install read-only', async () => {
    const opts = { timeoutMs: 60_000 };

    const inside = await runVerifyCommandAsync(nodeCommand("require('fs').writeFileSync('inside.txt', 'ok')"), worktree, cfg, opts);
    expect(inside.ok, inside.output).toBe(true);
    expect(readFileSync(join(worktree, 'inside.txt'), 'utf8')).toBe('ok');

    const escape = await runVerifyCommandAsync(nodeCommand(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`), worktree, cfg, opts);
    expect(escape.ok).toBe(false);
    expect(existsSync(outside)).toBe(false);

    const steal = await runVerifyCommandAsync(
      nodeCommand(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))`),
      worktree,
      cfg,
      opts,
    );
    expect(steal.ok).toBe(false);
    expect(steal.output).not.toContain('not-for-verified-code');
    expect(violations.calls.length).toBeGreaterThan(0);
    expect(violations.calls.every((c) => c.engine === 'verification')).toBe(true);

    const readDep = await runVerifyCommandAsync(nodeCommand("process.stdout.write(require('dep'))"), worktree, cfg, opts);
    expect(readDep.ok, readDep.output).toBe(true);
    expect(readDep.output).toContain('dep-ok');

    const plantDep = await runVerifyCommandAsync(
      nodeCommand("require('fs').writeFileSync('node_modules/dep/planted.js', 'x')"),
      worktree,
      cfg,
      opts,
    );
    expect(plantDep.ok).toBe(false);
    expect(existsSync(join(mirror, 'node_modules', 'dep', 'planted.js'))).toBe(false);
  });

  it('sync: the node → runner → command chain runs confined with the same guarantees', () => {
    const opts = { timeoutMs: 60_000 };
    const inside = runVerifyCommand(nodeCommand("require('fs').writeFileSync('inside-sync.txt', 'ok')"), worktree, cfg, opts);
    expect(inside.ok, inside.output).toBe(true);
    expect(readFileSync(join(worktree, 'inside-sync.txt'), 'utf8')).toBe('ok');

    const escape = runVerifyCommand(nodeCommand(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`), worktree, cfg, opts);
    expect(escape.ok).toBe(false);
    expect(existsSync(outside)).toBe(false);

    const steal = runVerifyCommand(
      nodeCommand(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))`),
      worktree,
      cfg,
      opts,
    );
    expect(steal.ok).toBe(false);
    expect(steal.output).not.toContain('not-for-verified-code');
  });

  it('no standing policy: the same outside write succeeds (legacy behaviour unchanged)', async () => {
    standing.policy = null;
    const res = await runVerifyCommandAsync(nodeCommand(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`), worktree, cfg, { timeoutMs: 30_000 });
    expect(res.ok, res.output).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });
});
