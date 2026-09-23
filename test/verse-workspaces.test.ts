/**
 * test/verse-workspaces.test.ts — multi-folder workspaces (docs/VERSE-WORKSPACES.md §1).
 *
 * Four things are being defended here, in order of how much damage each would
 * do if it broke:
 *
 *  1. THE ENROLLMENT BOUNDARY. A workspace decides what an INTERACTIVE chat
 *     can reach. It must never put a path into `~/.ashlr/enrollment.json`, and
 *     the ranked autonomy view must be derivable only as a SUBSET of what that
 *     registry already carries. Sections and priorities order; they never admit.
 *  2. BACKWARD COMPATIBILITY. A session record written before workspaces
 *     existed has no `extraRoots` key. It must still load, still run, and
 *     still produce byte-identical argv.
 *  3. THE ADAPTER FLAGS. Every flag asserted below was read off the installed
 *     CLI's own `--help`, never recalled — see the adapter docblocks for the
 *     exact commands and their output. An invented flag fails the turn before
 *     inference, which is how the invented Grok model ids failed.
 *  4. SANDBOX SYMMETRY. Turn 1 and a resumed turn must grant the SAME write
 *     set, or the agent edits a file on turn 1 that it cannot edit on turn 3
 *     and produces a diff that will not apply.
 *
 * HOME is relocated by test/setup/home.ts, so nothing here can reach the real
 * ~/.ashlr. The enrollment-registry assertions rely on that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { adapterFor } from '../src/core/verse/adapters/index.js';
import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { createVerseSessionStore } from '../src/core/verse/session-store.js';
import {
  createVerseWorkspaceStore,
  describeRoots,
  engineSupportsExtraRoots,
  rankAutonomyScope,
  resolveWorkspaceRoots,
  rootNotes,
  VerseWorkspaceError,
  type VerseWorkspaceStore,
} from '../src/core/verse/workspaces.js';
import {
  verseSessionRoots,
  VERSE_MAX_WORKSPACE_ROOTS,
  type VerseSession,
} from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;
let repoA: string;
let repoB: string;
let repoC: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'verse-ws-')));
  repoA = join(tmpRoot, 'service');
  repoB = join(tmpRoot, 'shared-lib');
  repoC = join(tmpRoot, 'third');
  for (const dir of [repoA, repoB, repoC]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SEAT = {
  id: 'claude-max',
  engine: 'claude' as const,
  label: 'Claude Max',
  accountId: 'claude-max',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'unknown' as const, summary: null, windows: [], observedAt: null },
};

function session(overrides: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'sess-1',
    title: 'x',
    projectPath: repoA,
    engine: 'claude',
    accountId: 'claude-max',
    seatId: 'claude-max',
    model: 'claude-opus-5',
    nativeSessionId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000,
    },
    lastError: null,
    ...overrides,
  };
}

function launch(overrides: Partial<VerseSeatLaunch> = {}): VerseSeatLaunch {
  return {
    seat: SEAT,
    launcher: ['/usr/local/bin/node', '/home/u/.ashlr/native-profiles/claude-max/launcher.mjs'],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ...overrides,
  };
}

/** Values following every occurrence of `flag` in argv. */
function valuesFor(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((part, index) => {
    if (part === flag && typeof argv[index + 1] === 'string') out.push(argv[index + 1]!);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. The pure root helper — the backward-compatibility hinge
// ---------------------------------------------------------------------------

describe('verseSessionRoots', () => {
  it('a record with no extraRoots key yields exactly the primary', () => {
    // This is every session written before workspaces existed.
    const pre = session();
    expect('extraRoots' in pre).toBe(false);
    expect(verseSessionRoots(pre)).toEqual([repoA]);
  });

  it('puts the primary first and drops a duplicate of it', () => {
    expect(verseSessionRoots(session({ extraRoots: [repoB, repoA, repoC] })))
      .toEqual([repoA, repoB, repoC]);
  });

  it('ignores malformed entries rather than throwing on a hand-edited record', () => {
    const rough = session({ extraRoots: ['', repoB] as string[] });
    expect(verseSessionRoots(rough)).toEqual([repoA, repoB]);
  });
});

// ---------------------------------------------------------------------------
// 2. Adapter argv — every flag verified against the real CLI's --help
// ---------------------------------------------------------------------------

describe('claude adapter — extra roots', () => {
  it('emits one --add-dir per extra root and keeps the prompt positional last', () => {
    // VERIFIED `claude --help` (2.1.280):
    //   --add-dir <directories...>  Additional directories to allow tool access to
    const turn = adapterFor('claude').buildLaunch(
      session({ extraRoots: [repoB, repoC] }), 'hello', launch(),
    );
    expect(valuesFor(turn.argv, '--add-dir')).toEqual([repoB, repoC]);
    // One directory per flag, never `--add-dir a b`: the option is variadic and
    // would otherwise swallow the following words.
    expect(turn.argv.filter((p) => p === '--add-dir')).toHaveLength(2);
    expect(turn.argv.slice(-2)).toEqual(['--', 'hello']);
    expect(turn.cwd).toBe(repoA);
  });

  it('a single-root session emits argv byte-identical to the pre-workspace build', () => {
    const before = adapterFor('claude').buildLaunch(session(), 'hi', launch());
    const after = adapterFor('claude').buildLaunch(session({ extraRoots: [] }), 'hi', launch());
    expect(before.argv).toEqual(after.argv);
    expect(before.argv).not.toContain('--add-dir');
  });

  it('grants the same roots on a resumed turn as on turn 1', () => {
    const a = adapterFor('claude');
    const first = a.buildLaunch(session({ extraRoots: [repoB] }), 'one', launch());
    const later = a.buildLaunch(session({ extraRoots: [repoB], turnCount: 3 }), 'two', launch());
    expect(valuesFor(first.argv, '--add-dir')).toEqual([repoB]);
    expect(valuesFor(later.argv, '--add-dir')).toEqual([repoB]);
    expect(later.argv).toContain('--resume');
  });

  it('local seats take the same flag (same binary)', () => {
    const turn = adapterFor('local').buildLaunch(
      session({ engine: 'local', extraRoots: [repoB] }), 'hi', launch({ launcher: null }),
    );
    expect(valuesFor(turn.argv, '--add-dir')).toEqual([repoB]);
  });
});

describe('codex adapter — extra roots', () => {
  const OVERRIDE = (roots: string[]) =>
    `sandbox_workspace_write.writable_roots=[${roots.map((r) => JSON.stringify(r)).join(',')}]`;

  it('turn 1 passes the writable-roots override alongside --cd and the sandbox mode', () => {
    const turn = adapterFor('codex').buildLaunch(
      session({ engine: 'codex', nativeSessionId: null, extraRoots: [repoB, repoC] }),
      'hello', launch(),
    );
    expect(valuesFor(turn.argv, '-c')).toEqual([OVERRIDE([repoB, repoC])]);
    expect(valuesFor(turn.argv, '--cd')).toEqual([repoA]);
    expect(valuesFor(turn.argv, '--sandbox')).toEqual(['workspace-write']);
  });

  it('a RESUMED turn grants the identical write set', () => {
    // `codex exec resume --help` has neither --add-dir nor --cd, but does have
    // -c/--config. Turn 1 and turn N must agree or the agent produces a diff
    // against a root it can no longer write.
    const a = adapterFor('codex');
    const first = a.buildLaunch(
      session({ engine: 'codex', nativeSessionId: null, extraRoots: [repoB] }), 'one', launch(),
    );
    const resumed = a.buildLaunch(
      session({ engine: 'codex', nativeSessionId: 'thread-1', turnCount: 2, extraRoots: [repoB] }),
      'two', launch(),
    );
    expect(valuesFor(resumed.argv, '-c')).toEqual(valuesFor(first.argv, '-c'));
    expect(resumed.argv).toContain('resume');
  });

  it('a single-root codex session emits no config override at all', () => {
    const turn = adapterFor('codex').buildLaunch(
      session({ engine: 'codex', nativeSessionId: null }), 'hi', launch(),
    );
    expect(turn.argv).not.toContain('-c');
    expect(turn.argv).not.toContain('writable_roots');
  });

  it('TOML-escapes a root containing a quote or a backslash', () => {
    // The value is parsed AS TOML by codex, so an unescaped quote would change
    // the shape of the array rather than sitting inside it.
    const nasty = '/tmp/we"ird\\path';
    const turn = adapterFor('codex').buildLaunch(
      session({ engine: 'codex', nativeSessionId: null, extraRoots: [nasty] }), 'hi', launch(),
    );
    const override = valuesFor(turn.argv, '-c')[0]!;
    expect(override).toBe('sandbox_workspace_write.writable_roots=["/tmp/we\\"ird\\\\path"]');
    // And it must carry no RAW control characters into argv.
    const codes = [...override].map((c) => c.codePointAt(0) ?? 0);
    expect(codes.some((c) => c < 0x20 || c === 0x7f)).toBe(false);
  });
});

describe('grok adapter — no multi-root flag exists', () => {
  it('emits no directory flag and no invented equivalent', () => {
    // `grok --help` and `grok agent --help` (0.2.118) expose --cwd and a
    // --sandbox PROFILE NAME. There is no --add-dir and no writable-roots
    // option anywhere, so none is emitted.
    const turn = adapterFor('grok').buildLaunch(
      session({ engine: 'grok', extraRoots: [repoB, repoC] }), 'hi', launch(),
    );
    for (const invented of ['--add-dir', '--add-directory', '--allow-dir', '--writable-root', '-c']) {
      expect(turn.argv).not.toContain(invented);
    }
    expect(valuesFor(turn.argv, '--cwd')).toEqual([repoA]);
    expect(turn.argv.join(' ')).not.toContain(repoB);
  });

  it('is reported as unable to reach the extras rather than silently dropping them', () => {
    expect(engineSupportsExtraRoots('grok')).toBe(false);
    for (const engine of ['claude', 'local', 'codex']) {
      expect(engineSupportsExtraRoots(engine)).toBe(true);
    }
    const statuses = describeRoots([repoA, repoB], { engine: 'grok' });
    expect(statuses.map((r) => r.reachable)).toEqual([true, false]);
    expect(rootNotes(statuses, 'grok').join(' ')).toContain('not reachable');
  });
});

// ---------------------------------------------------------------------------
// 3. Session engine — pinning, validation, and old records
// ---------------------------------------------------------------------------

describe('session engine — workspace roots', () => {
  let engine: VerseEngineHandle;
  let engineRoot: string;

  beforeEach(() => {
    engineRoot = join(tmpRoot, 'engine');
    engine = createVerseEngine({ root: engineRoot });
  });

  afterEach(() => {
    engine.close();
  });

  it('pins extra roots on the record and leaves projectPath as the primary', () => {
    const created = engine.createSession(
      { projectPath: repoA, seatId: 'claude-max', extraRoots: [repoB] }, launch(),
    );
    expect(created.projectPath).toBe(repoA);
    expect(created.extraRoots).toEqual([repoB]);
    expect(verseSessionRoots(created)).toEqual([repoA, repoB]);
  });

  it('writes NO extraRoots key for an ordinary single-folder chat', () => {
    const created = engine.createSession({ projectPath: repoA, seatId: 'claude-max' }, launch());
    const raw = JSON.parse(
      // The on-disk record is the compatibility contract, not the in-memory object.
      require('node:fs').readFileSync(join(engineRoot, 'sessions', `${created.id}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect('extraRoots' in raw).toBe(false);
    expect('workspaceId' in raw).toBe(false);
  });

  it('drops an extra root that is just the primary spelled differently', () => {
    const link = join(tmpRoot, 'service-link');
    symlinkSync(repoA, link);
    const created = engine.createSession(
      { projectPath: repoA, seatId: 'claude-max', extraRoots: [link, repoB] }, launch(),
    );
    // The symlink resolves to the primary, so it is not granted twice.
    expect(created.extraRoots).toEqual([repoB]);
  });

  it('refuses a relative, missing or over-long root set', () => {
    const bad: Array<[unknown, RegExp]> = [
      [['relative/path'], /absolute/],
      [[join(tmpRoot, 'nope')], /existing directory/],
      ['not-an-array', /must be an array/],
      [Array.from({ length: VERSE_MAX_WORKSPACE_ROOTS }, () => repoB), /at most/],
    ];
    for (const [extraRoots, pattern] of bad) {
      expect(() => engine.createSession(
        { projectPath: repoA, seatId: 'claude-max', extraRoots: extraRoots as string[] }, launch(),
      )).toThrow(pattern);
    }
  });

  it('loads a session record written before workspaces existed', () => {
    // Hand-write the exact V1 shape: no extraRoots, no workspaceId.
    const store = createVerseSessionStore(join(tmpRoot, 'legacy'));
    const legacy = session({ id: 'legacy-session' });
    delete (legacy as Partial<VerseSession>).extraRoots;
    store.save(legacy);

    const reread = createVerseSessionStore(join(tmpRoot, 'legacy')).get('legacy-session');
    expect(reread).not.toBeNull();
    expect(reread!.projectPath).toBe(repoA);
    expect(verseSessionRoots(reread!)).toEqual([repoA]);
    // And it still builds a runnable turn.
    expect(adapterFor('claude').buildLaunch(reread!, 'hi', launch()).argv).not.toContain('--add-dir');
  });

  it('rejects a record whose extraRoots is not an array of strings', () => {
    const store = createVerseSessionStore(join(tmpRoot, 'corrupt'));
    mkdirSync(join(tmpRoot, 'corrupt', 'sessions'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'corrupt', 'sessions', 'bad.json'),
      JSON.stringify({ ...session({ id: 'bad' }), extraRoots: [1, 2] }),
    );
    expect(store.get('bad')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The registry
// ---------------------------------------------------------------------------

describe('workspace registry', () => {
  let store: VerseWorkspaceStore;

  beforeEach(() => {
    store = createVerseWorkspaceStore({ root: join(tmpRoot, 'verse') });
  });

  it('creates a named set with exactly one primary, in order', () => {
    const ws = store.create('Ashlr Verse', [repoA, repoB, repoC]);
    expect(ws.name).toBe('Ashlr Verse');
    expect(ws.roots.map((r) => r.path)).toEqual([repoA, repoB, repoC]);
    expect(ws.roots.filter((r) => r.primary)).toHaveLength(1);
    expect(ws.roots[0]!.primary).toBe(true);
    expect(ws.section).toBe(false);
  });

  it('round-trips through disk and survives a reopen', () => {
    const ws = store.create('svc', [repoA, repoB]);
    const reopened = createVerseWorkspaceStore({ root: join(tmpRoot, 'verse') });
    expect(reopened.get(ws.id)?.roots.map((r) => r.path)).toEqual([repoA, repoB]);
  });

  it('deduplicates two spellings of one directory', () => {
    const link = join(tmpRoot, 'lib-link');
    symlinkSync(repoB, link);
    expect(store.create('dup', [repoA, repoB, link]).roots.map((r) => r.path)).toEqual([repoA, repoB]);
  });

  it('updates, re-primaries and deletes', () => {
    const ws = store.create('one', [repoA, repoB]);
    const moved = store.update(ws.id, { roots: [repoB, repoA], name: 'two' });
    expect(moved.name).toBe('two');
    expect(moved.roots[0]).toMatchObject({ path: repoB, primary: true });
    expect(store.remove(ws.id)).toBe(true);
    expect(store.get(ws.id)).toBeNull();
    expect(store.remove(ws.id)).toBe(false);
  });

  it('refuses the forbidden roots enrollment refuses', () => {
    for (const forbidden of ['/', homedir(), join(homedir(), '.ashlr')]) {
      expect(() => store.create('bad', [forbidden])).toThrow(VerseWorkspaceError);
    }
    expect(() => store.create('bad', [])).toThrow(/at least one root/);
    expect(() => store.create('bad', Array.from({ length: 9 }, () => repoA))).toThrow(/at most/);
    expect(() => store.create('', [repoA])).toThrow(/name is required/);
  });

  it('refuses a symlink whose target is inside a forbidden root', () => {
    const escape = join(tmpRoot, 'looks-innocent');
    const ashlr = join(homedir(), '.ashlr');
    mkdirSync(ashlr, { recursive: true });
    symlinkSync(ashlr, escape);
    expect(() => store.create('escape', [escape])).toThrow(VerseWorkspaceError);
  });

  it('resolveWorkspaceRoots names the primary explicitly', () => {
    expect(resolveWorkspaceRoots([repoA, repoB])).toEqual({ primary: repoA, extra: [repoB] });
  });

  it('stores and clears a per-repo priority', () => {
    expect(store.priorities()).toEqual({});
    store.setPriority(repoA, 'critical');
    expect(store.priorities()[repoA]).toBe('critical');
    // `normal` is the default, so it is stored as ABSENCE rather than a value.
    store.setPriority(repoA, 'normal');
    expect(repoA in store.priorities()).toBe(false);
    expect(() => store.setPriority(repoA, 'urgent' as never)).toThrow(/priority must be one of/);
  });

  it('focuses only a real section, and unfocuses when it stops being one', () => {
    const plain = store.create('plain', [repoA]);
    const section = store.create('section', [repoB], true);
    expect(() => store.setFocusSection(plain.id)).toThrow(/not a section/);
    expect(() => store.setFocusSection('nope')).toThrow(/not found/);
    expect(store.setFocusSection(section.id)).toBe(section.id);
    store.update(section.id, { section: false });
    expect(store.focusSectionId()).toBeNull();
  });

  it('reads a corrupt registry as empty rather than taking Verse down', () => {
    mkdirSync(join(tmpRoot, 'broken'), { recursive: true });
    writeFileSync(join(tmpRoot, 'broken', 'workspaces.json'), '{ not json');
    expect(createVerseWorkspaceStore({ root: join(tmpRoot, 'broken') }).list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. THE SECURITY INVARIANT — a workspace never widens autonomous scope
// ---------------------------------------------------------------------------

describe('enrollment boundary', () => {
  it('no workspace operation writes the enrollment registry', () => {
    const registry = join(homedir(), '.ashlr', 'enrollment.json');
    const before = existsSync(registry);
    const store = createVerseWorkspaceStore({ root: join(tmpRoot, 'verse') });
    const ws = store.create('everything', [repoA, repoB, repoC], true);
    store.setPriority(repoA, 'critical');
    store.setFocusSection(ws.id);
    store.update(ws.id, { roots: [repoB, repoA] });
    store.remove(ws.id);
    // Membership, ranking and focus are all ordering; none of them enrol.
    expect(existsSync(registry)).toBe(before);
  });

  it('roots report enrollment as read, and an unenrolled root is said so plainly', () => {
    const statuses = describeRoots([repoA, repoB], { engine: 'claude' });
    // Nothing is enrolled under the isolated HOME.
    expect(statuses.map((r) => r.enrolled)).toEqual([false, false]);
    const notes = rootNotes(statuses, 'claude').join(' ');
    expect(notes).toContain('Not enrolled');
    expect(notes).toContain('autonomous lane refuses them');
  });

  it('a section can only ORDER repos enrollment already carries', () => {
    const view = rankAutonomyScope({
      workspaces: [{
        id: 'w1', name: 'Ashlr Verse',
        roots: [
          { path: repoA, name: 'service', primary: true },
          { path: repoB, name: 'shared-lib', primary: false },
        ],
        section: true,
        createdAt: 'x', updatedAt: 'x',
      }],
      priorities: { [repoB]: 'critical' },
      focusSectionId: null,
      // Only repoA is enrolled. repoB is in the section and ranked `critical`.
      enrolledRepos: [repoA],
    });
    expect(view.entries.map((e) => e.path)).toEqual([repoA]);
    // The highest possible priority on an unenrolled repo admits nothing.
    expect(view.entries.some((e) => e.path === repoB)).toBe(false);
    expect(view.unenrolledSectionRoots).toEqual([repoB]);
  });

  it('ranks by priority, and a focused section outranks everything outside it', () => {
    const view = rankAutonomyScope({
      workspaces: [{
        id: 'w1', name: 'Website',
        roots: [{ path: repoC, name: 'third', primary: true }],
        section: true, createdAt: 'x', updatedAt: 'x',
      }],
      priorities: { [repoA]: 'critical', [repoC]: 'low' },
      focusSectionId: 'w1',
      enrolledRepos: [repoA, repoB, repoC],
    });
    // repoC is `low` but inside the focus, so it leads; repoA is `critical`
    // but outside it, so it follows — focus is the outer sort key.
    expect(view.entries.map((e) => e.path)).toEqual([repoC, repoA, repoB]);
    expect(view.entries[0]).toMatchObject({ outsideFocus: false, priority: 'low' });
    expect(view.entries[1]).toMatchObject({ outsideFocus: true, priority: 'critical' });
    expect(view.focusSectionName).toBe('Website');
  });

  it('with no focus, priority alone orders and every enrolled repo is present', () => {
    const view = rankAutonomyScope({
      workspaces: [],
      priorities: { [repoC]: 'critical', [repoA]: 'low' },
      focusSectionId: null,
      enrolledRepos: [repoA, repoB, repoC],
    });
    expect(view.entries.map((e) => e.path)).toEqual([repoC, repoB, repoA]);
    // An unranked repo defaults to `normal`, which is how it behaved before.
    expect(view.entries[1]).toMatchObject({ path: repoB, priority: 'normal' });
    expect(view.entries.every((e) => e.outsideFocus === false)).toBe(true);
  });

  it('reports section membership per repo so the blast radius is legible', () => {
    const view = rankAutonomyScope({
      workspaces: [
        {
          id: 'w1', name: 'Verse',
          roots: [{ path: repoA, name: 'a', primary: true }],
          section: true, createdAt: 'x', updatedAt: 'x',
        },
        {
          id: 'w2', name: 'Site',
          roots: [{ path: repoA, name: 'a', primary: true }],
          section: true, createdAt: 'x', updatedAt: 'x',
        },
        {
          id: 'w3', name: 'Not a section',
          roots: [{ path: repoA, name: 'a', primary: true }],
          section: false, createdAt: 'x', updatedAt: 'x',
        },
      ],
      priorities: {},
      focusSectionId: null,
      enrolledRepos: [repoA],
    });
    // A repo can sit in several sections; a non-section workspace is not one.
    expect(view.entries[0]!.sections.map((s) => s.name)).toEqual(['Verse', 'Site']);
  });
});

// ---------------------------------------------------------------------------
// 6. Per-root git identity
// ---------------------------------------------------------------------------

describe('per-root git identity', () => {
  it('is null for a plain directory and present for a repo', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: repoB, stdio: 'pipe', timeout: 10_000 });
    run(['init', '-q', '-b', 'feature/two-repos']);
    run(['config', 'user.email', 't@example.com']);
    run(['config', 'user.name', 'T']);
    writeFileSync(join(repoB, 'a.txt'), 'x');
    run(['add', 'a.txt']);
    run(['commit', '-qm', 'init']);
    writeFileSync(join(repoB, 'b.txt'), 'dirty');

    const [plain, repo] = describeRoots([repoA, repoB], { engine: 'claude' });
    expect(plain!.git).toBeNull();
    expect(repo!.git).toMatchObject({ branch: 'feature/two-repos', ahead: 0, behind: 0 });
    // One untracked file.
    expect(repo!.git!.dirty).toBe(1);
    // A non-GitHub (here: absent) origin reports null rather than a raw URL,
    // because an https remote can carry credentials in its userinfo.
    expect(repo!.git!.remote).toBeNull();
  });

  it('marks a root that has gone missing without throwing', () => {
    rmSync(repoC, { recursive: true, force: true });
    const statuses = describeRoots([repoA, repoC], { engine: 'claude' });
    expect(statuses[1]).toMatchObject({ exists: false, git: null });
  });
});
