/**
 * V3.10 U6 — fleet mirrors (src/core/fleet/mirrors.ts, src/cli/mirror.ts).
 * SPEC-310B §2 "Mirrors" and the §7 key test "Mirrors never touch source
 * checkouts".
 *
 * Every "GitHub" here is a local bare repo (allowLocalOrigin — the production
 * path is https://github.com only, which one test pins); no network, no
 * custody helper, isolated tmp HOME. REAL-IO: real git (see
 * test/helpers/throughput-310b.ts).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import {
  fixtureGit,
  makeBareOrigin,
  makeSourceCheckout,
  snapshotCheckout,
  type BareOrigin,
} from './helpers/throughput-310b.js';
import {
  ensureMirror,
  fleetMirrorsRoot,
  githubOriginUrl,
  isMirrorPath,
  listMirrors,
  mirrorLeaseKey,
  mirrorNameForPath,
  mirrorPathFor,
  mirrorSlug,
  parseNameWithOwner,
  narrowToAutonomousLane,
  planAutonomousEnrollment,
  planAutonomousRelease,
  prepareMirrorsForTick,
  readMirrorState,
  reconcileAutonomousEnrollment,
  releaseAutonomousEnrollment,
  removeMirror,
  runInAutonomousLane,
  type MirrorDeps,
} from '../src/core/fleet/mirrors.js';
import { acquireRepoLease } from '../src/core/sandbox/execution-leases.js';
import {
  activeEnrollmentLenses,
  assertMayMutate,
  enroll,
  enrollmentPath,
  isEnrolled,
  listEnrolled,
  setKill,
  withEnrollmentScope,
} from '../src/core/sandbox/policy.js';
import { runMirrorCli } from '../src/cli/mirror.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';

const REAL_IO_TIMEOUT = 60_000;

let fx: H1Fixture;
const origins = new Map<string, BareOrigin>();
const disposers: Array<() => void> = [];

function origin(nameWithOwner: string, files?: Record<string, string>): BareOrigin {
  const made = makeBareOrigin(files ?? { 'README.md': `# ${nameWithOwner}\n`, 'src/index.ts': 'export const v = 1;\n' });
  origins.set(nameWithOwner, made);
  disposers.push(() => made.destroy());
  return made;
}

/** Test deps: each owner/name maps to its local bare origin; never a token. */
function deps(extra: Partial<MirrorDeps> = {}): MirrorDeps {
  return {
    originUrlFor: (nameWithOwner) => origins.get(nameWithOwner)?.bareDir ?? `/nonexistent/${nameWithOwner}.git`,
    allowLocalOrigin: true,
    githubToken: async () => null,
    ...extra,
  };
}

function policyOf(...repos: string[]): Pick<EffectivePolicy, 'repos'> {
  return {
    repos: repos.map((nameWithOwner) => ({
      nameWithOwner,
      stage: 'merge' as const,
      enforcement: 'server' as const,
      maxRisk: 'low' as const,
      maxFiles: 4,
      maxLines: 150,
      maxMergesPerDay: 6,
      selfRepo: null,
    })),
  };
}

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  try { setKill(false, { waitMs: 500 }); } catch { /* cleanup below */ }
  fx.cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  origins.clear();
});

describe('identity and paths', () => {
  it('accepts GitHub names and refuses every path trick', () => {
    expect(parseNameWithOwner('ashlrai/ashlr-hub')).toEqual({ owner: 'ashlrai', name: 'ashlr-hub', nameWithOwner: 'ashlrai/ashlr-hub' });
    expect(parseNameWithOwner('ashlrai/fleet-canary.git')?.nameWithOwner).toBe('ashlrai/fleet-canary');
    expect(parseNameWithOwner('a/b.c_d-e')?.name).toBe('b.c_d-e');
    for (const bad of ['', 'x', 'a/b/c', '../x', 'a/..', 'a/.', '-a/b', 'a-/b', 'a/-b', 'a_b/c', 'a/b c', 'a/b\\c', '/a/b', 42]) {
      expect(parseNameWithOwner(bad)).toBeNull();
    }
  });

  it('maps owner/name to ~/.ashlr/fleet/mirrors/owner__name and back, and nothing else back', () => {
    const path = mirrorPathFor('ashlrai/binshield');
    expect(path).toBe(join(fx.home, '.ashlr', 'fleet', 'mirrors', 'ashlrai__binshield'));
    expect(mirrorSlug('ashlrai/binshield')).toBe('ashlrai__binshield');
    expect(mirrorNameForPath(path)).toBe('ashlrai/binshield');
    expect(isMirrorPath(path)).toBe(true);
    expect(mirrorNameForPath(join(path, 'src'))).toBeNull();
    expect(mirrorNameForPath(fleetMirrorsRoot())).toBeNull();
    expect(mirrorNameForPath(join(fleetMirrorsRoot(), '.trash'))).toBeNull();
    expect(mirrorNameForPath('/Users/someone/Desktop/github/binshield')).toBeNull();
    expect(githubOriginUrl('ashlrai/binshield')).toBe('https://github.com/ashlrai/binshield.git');
  });

  it('production origins are https://github.com only', async () => {
    const refused = await ensureMirror(
      { nameWithOwner: 'acme/widget' },
      { originUrlFor: () => '/tmp/not-github.git', githubToken: async () => null },
    );
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/not an allowed https:\/\/github\.com URL/);
    expect(existsSync(mirrorPathFor('acme/widget'))).toBe(false);
  });
});

describe('ensureMirror', () => {
  it('clones into a private mirror, pins base to the remote default branch, and hardens .git', async () => {
    const remote = origin('acme/widget');
    const result = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    expect(result).toMatchObject({
      ok: true,
      created: true,
      changed: true,
      base: 'main',
      headSha: remote.head(),
      auth: 'anonymous',
      quarantinedTo: null,
    });
    const path = mirrorPathFor('acme/widget');
    expect(result.path).toBe(path);
    expect(lstatSync(fleetMirrorsRoot()).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    const config = readFileSync(join(path, '.git', 'config'), 'utf8');
    expect(config).toContain('hooksPath = /dev/null');
    expect(config).toContain('fsmonitor = false');
    expect(config).toContain(`url = ${remote.bareDir}`);
    expect(readdirSync(join(path, '.git')).includes('hooks') ? readdirSync(join(path, '.git', 'hooks')) : []).toEqual([]);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    const state = readMirrorState('acme/widget');
    expect(state).toMatchObject({ lastSyncOk: true, headSha: remote.head(), base: 'main', lastError: null });
    const statePath = join(fx.home, '.ashlr', 'fleet', 'mirror-state', 'acme__widget.json');
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
  }, REAL_IO_TIMEOUT);

  it('resets to origin/<base> every sync: new commits land, local dirt is gone', async () => {
    const remote = origin('acme/widget');
    await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    const path = mirrorPathFor('acme/widget');

    const unchanged = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    expect(unchanged).toMatchObject({ ok: true, created: false, changed: false });

    const next = remote.push({ 'src/next.ts': 'export const next = 2;\n' }, 'advance');
    writeFileSync(join(path, 'README.md'), 'dirty tracked edit\n');
    writeFileSync(join(path, 'untracked.txt'), 'junk\n');
    mkdirSync(join(path, 'nested'));
    fixtureGit(join(path, 'nested'), ['init', '--quiet']);
    fixtureGit(path, ['checkout', '--quiet', '-b', 'agent-branch']);

    const synced = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    expect(synced).toMatchObject({ ok: true, created: false, changed: true, headSha: next });
    expect(fixtureGit(path, ['status', '--porcelain', '--ignored'])).toBe('');
    expect(fixtureGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(existsSync(join(path, 'nested'))).toBe(false);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# acme/widget\n');
  }, REAL_IO_TIMEOUT);

  it('planted config, filters and hooks never execute and are wiped', async () => {
    origin('acme/widget');
    await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    const path = mirrorPathFor('acme/widget');
    const marker = join(fx.home, 'PWNED');
    const script = join(fx.home, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    // What an agent in a linked worktree could write into the shared git dir.
    writeFileSync(join(path, '.git', 'config'),
      `${readFileSync(join(path, '.git', 'config'), 'utf8')}` +
      `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${join(path, '.git', 'evil-hooks')}\n` +
      `[filter "evil"]\n\tsmudge = ${script}\n\tclean = ${script}\n` +
      `[alias]\n\tfetch = !${script}\n` +
      `[remote "exfil"]\n\turl = ext::sh -c ${script}\n`);
    mkdirSync(join(path, '.git', 'info'), { recursive: true });
    writeFileSync(join(path, '.git', 'info', 'attributes'), '* filter=evil\n');
    mkdirSync(join(path, '.git', 'hooks'), { recursive: true });
    for (const hook of ['post-checkout', 'reference-transaction', 'post-merge']) {
      writeFileSync(join(path, '.git', 'hooks', hook), `#!/bin/sh\necho hook >> "${marker}"\n`);
      chmodSync(join(path, '.git', 'hooks', hook), 0o755);
    }
    writeFileSync(join(path, 'README.md'), 'force a checkout of this file\n');

    const synced = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    expect(synced.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const config = readFileSync(join(path, '.git', 'config'), 'utf8');
    expect(config).not.toMatch(/evil|exfil|alias|ext::/);
    expect(readdirSync(join(path, '.git', 'hooks'))).toEqual([]);
  }, REAL_IO_TIMEOUT);

  it('moves a non-mirror directory at the mirror path aside instead of trusting or deleting it', async () => {
    origin('acme/widget');
    const path = mirrorPathFor('acme/widget');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep-me.txt'), 'not a repo\n');
    const result = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.quarantinedTo).toMatch(/\.trash\/acme__widget-/);
    expect(readFileSync(join(result.quarantinedTo!, 'keep-me.txt'), 'utf8')).toBe('not a repo\n');
  }, REAL_IO_TIMEOUT);

  it('tracks an explicit base branch', async () => {
    const remote = origin('acme/widget');
    fixtureGit(remote.pusherDir, ['checkout', '--quiet', '-b', 'release']);
    writeFileSync(join(remote.pusherDir, 'RELEASE.md'), 'release line\n');
    fixtureGit(remote.pusherDir, ['add', '-A']);
    fixtureGit(remote.pusherDir, ['commit', '--quiet', '-m', 'release']);
    fixtureGit(remote.pusherDir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release']);
    const result = await ensureMirror({ nameWithOwner: 'acme/widget', base: 'release' }, deps());
    expect(result).toMatchObject({ ok: true, base: 'release' });
    expect(existsSync(join(mirrorPathFor('acme/widget'), 'RELEASE.md'))).toBe(true);
    // The recorded base is reused on the next plain sync.
    expect(await ensureMirror({ nameWithOwner: 'acme/widget' }, deps())).toMatchObject({ ok: true, base: 'release' });
    const bad = await ensureMirror({ nameWithOwner: 'acme/widget', base: '--upload-pack=x' }, deps());
    expect(bad).toMatchObject({ ok: false });
  }, REAL_IO_TIMEOUT);

  it('a token goes to git through the environment only and is never recorded', async () => {
    origin('acme/private');
    const token = 'ghs_TOPSECRET0123456789abcdefghijklmnopq';
    const result = await ensureMirror({ nameWithOwner: 'acme/private' }, deps({ githubToken: async () => token }));
    expect(result).toMatchObject({ ok: true, auth: 'token' });
    expect(JSON.stringify(result)).not.toContain(token);
    const state = readFileSync(join(fx.home, '.ashlr', 'fleet', 'mirror-state', 'acme__private.json'), 'utf8');
    expect(state).not.toContain(token);
    expect(readFileSync(join(mirrorPathFor('acme/private'), '.git', 'config'), 'utf8')).not.toContain(token);
  }, REAL_IO_TIMEOUT);

  it('fetches anonymously when the custody helper is unavailable', async () => {
    origin('acme/public');
    const { githubToken: _omit, ...noToken } = deps();
    const result = await ensureMirror({ nameWithOwner: 'acme/public' }, noToken);
    expect(result).toMatchObject({ ok: true, auth: 'anonymous' });
  }, REAL_IO_TIMEOUT);

  it('fails with a specific, recorded reason when the origin is unreachable', async () => {
    const result = await ensureMirror({ nameWithOwner: 'acme/ghost' }, deps());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/default branch/);
    expect(existsSync(mirrorPathFor('acme/ghost'))).toBe(false);
  }, REAL_IO_TIMEOUT);

  it('waits for the mirror repo lease (an agent creating a worktree, a push)', async () => {
    origin('acme/widget');
    const held = await acquireRepoLease(mirrorLeaseKey(mirrorPathFor('acme/widget')));
    expect(held.ok).toBe(true);
    try {
      const busy = await ensureMirror({ nameWithOwner: 'acme/widget' }, deps({ leaseWaitMs: 200 }));
      expect(busy).toMatchObject({ ok: false });
      expect(busy.reason).toMatch(/mirror busy: repo lease busy/);
    } finally {
      if (held.ok) held.lease.release();
    }
    expect((await ensureMirror({ nameWithOwner: 'acme/widget' }, deps())).ok).toBe(true);
  }, REAL_IO_TIMEOUT);
});

describe('mirrors never touch source checkouts (SPEC-310B §7 key test)', () => {
  it('clone, sync, tick preparation and enrollment reconcile leave Mason’s checkout byte-identical', async () => {
    const remote = origin('acme/widget');
    const checkout = makeSourceCheckout(remote);
    disposers.push(checkout.destroy);
    enroll(checkout.dir);
    const before = snapshotCheckout(checkout.dir);

    await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    remote.push({ 'src/more.ts': 'export const more = 3;\n' }, 'more');
    const tick = await prepareMirrorsForTick(policyOf('acme/widget'), deps());
    expect(tick.ready.map((row) => row.nameWithOwner)).toEqual(['acme/widget']);

    const plan = planAutonomousEnrollment(policyOf('acme/widget'), listEnrolled());
    // R3f: Mason's checkout is reported, never unenrolled.
    expect(plan.unenroll).toEqual([]);
    expect(plan.untouched).toEqual([checkout.dir]);
    expect(plan.enroll).toEqual([mirrorPathFor('acme/widget')]);
    const applied = await reconcileAutonomousEnrollment(policyOf('acme/widget'), { apply: true, drainMs: 1_000 });
    expect(applied.errors).toEqual([]);
    expect(applied.unenrolled).toEqual([]);
    expect(isEnrolled(checkout.dir)).toBe(true);
    expect(isEnrolled(mirrorPathFor('acme/widget'))).toBe(true);
    // …and the autonomous lane cannot see it at all.
    runInAutonomousLane(() => {
      expect(listEnrolled()).toEqual([mirrorPathFor('acme/widget')]);
      expect(isEnrolled(checkout.dir)).toBe(false);
      expect(() => assertMayMutate(checkout.dir)).toThrow(/outside|narrowed to: autonomous lane/);
    });

    expect(snapshotCheckout(checkout.dir)).toEqual(before);
    // The mirror is not linked to the checkout in either direction.
    expect(fixtureGit(mirrorPathFor('acme/widget'), ['worktree', 'list', '--porcelain'])).not.toContain(checkout.dir);
    expect(fixtureGit(mirrorPathFor('acme/widget'), ['config', '--get', 'remote.origin.url'])).toBe(remote.bareDir);
  }, REAL_IO_TIMEOUT);
});

describe('tick preparation and enrollment', () => {
  it('reports repos whose mirror is not current for pausing', async () => {
    origin('acme/good');
    const prepared = await prepareMirrorsForTick(policyOf('acme/good', 'acme/missing'), deps());
    expect(prepared.ready.map((row) => row.nameWithOwner)).toEqual(['acme/good']);
    expect(prepared.failed.map((row) => row.nameWithOwner)).toEqual(['acme/missing']);
    expect(prepared.pausedRepoPaths).toEqual([mirrorPathFor('acme/missing')]);
  }, REAL_IO_TIMEOUT);

  it('does nothing under KILL and pauses everything', async () => {
    origin('acme/good');
    setKill(true, { waitMs: 500 });
    const prepared = await prepareMirrorsForTick(policyOf('acme/good'), deps());
    expect(prepared.ready).toEqual([]);
    expect(prepared.failed[0]?.reason).toMatch(/kill switch/);
    expect(existsSync(mirrorPathFor('acme/good'))).toBe(false);
  });

  it('plans exactly the grant’s mirrors, never Mason’s checkouts; no policy means no plan', () => {
    const mirrorA = mirrorPathFor('acme/a');
    const dropped = mirrorPathFor('acme/dropped');
    const plan = planAutonomousEnrollment(
      policyOf('acme/a', 'acme/b'),
      ['/Users/m/checkouts/a', mirrorA, dropped, '/Users/m/checkouts/zz'],
      (path) => path === mirrorA,
    );
    expect(plan).toEqual({
      desired: [mirrorA, mirrorPathFor('acme/b')].sort(),
      enroll: [],
      // Only a fleet mirror the grant dropped leaves the registry.
      unenroll: [dropped],
      pendingMirrors: [mirrorPathFor('acme/b')],
      untouched: ['/Users/m/checkouts/a', '/Users/m/checkouts/zz'],
    });
    expect(planAutonomousEnrollment(null, ['/x'])).toEqual({ desired: [], enroll: [], unenroll: [], pendingMirrors: [], untouched: [] });
  });

  it('a grant change unenrolls the dropped mirror and keeps every checkout (registry file checked)', async () => {
    origin('acme/a');
    origin('acme/b');
    await ensureMirror({ nameWithOwner: 'acme/a' }, deps());
    await ensureMirror({ nameWithOwner: 'acme/b' }, deps());
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    enroll(checkout);
    expect((await reconcileAutonomousEnrollment(policyOf('acme/a', 'acme/b'), { apply: true, drainMs: 1_000 })).errors).toEqual([]);
    const narrowed = await reconcileAutonomousEnrollment(policyOf('acme/a'), { apply: true, drainMs: 1_000 });
    expect(narrowed.unenrolled).toEqual([mirrorPathFor('acme/b')]);
    const registry = JSON.parse(readFileSync(enrollmentPath(), 'utf8')) as { repos: string[] };
    expect(registry.repos).toContain(checkout);
    expect(isEnrolled(checkout)).toBe(true);
    expect(isEnrolled(mirrorPathFor('acme/a'))).toBe(true);
    expect(isEnrolled(mirrorPathFor('acme/b'))).toBe(false);
    // The clone itself stays (removeMirror deletes clones; reconcile never does).
    expect(existsSync(join(mirrorPathFor('acme/b'), '.git'))).toBe(true);
  }, REAL_IO_TIMEOUT);

  it('release unenrolls every fleet mirror and nothing else', async () => {
    origin('acme/a');
    await ensureMirror({ nameWithOwner: 'acme/a' }, deps());
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    enroll(checkout);
    enroll(mirrorPathFor('acme/a'));
    expect(planAutonomousRelease(listEnrolled()).unenroll).toEqual([mirrorPathFor('acme/a')]);
    const dry = await releaseAutonomousEnrollment({ apply: false });
    expect(dry.applied).toBe(false);
    expect(isEnrolled(mirrorPathFor('acme/a'))).toBe(true);
    const released = await releaseAutonomousEnrollment({ apply: true, drainMs: 1_000 });
    expect(released.errors).toEqual([]);
    expect(released.unenrolled).toEqual([mirrorPathFor('acme/a')]);
    expect(isEnrolled(mirrorPathFor('acme/a'))).toBe(false);
    expect(isEnrolled(checkout)).toBe(true);
    expect(listEnrolled()).toHaveLength(1);
  }, REAL_IO_TIMEOUT);
});

describe('the autonomous lane (R3f): a read-only lens, never a registry rewrite', () => {
  it('narrows every enrolled read inside the lane and leaves the registry and the caller alone', async () => {
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    const mirror = mirrorPathFor('acme/lane');
    mkdirSync(mirror, { recursive: true });
    enroll(checkout);
    enroll(mirror);
    const before = readFileSync(enrollmentPath(), 'utf8');

    const seen = await runInAutonomousLane(async () => {
      await new Promise((r) => setTimeout(r, 5));
      // Async continuations stay in the lane.
      return { list: listEnrolled(), checkout: isEnrolled(checkout), mirror: isEnrolled(mirror), lenses: activeEnrollmentLenses() };
    });
    expect(seen.list).toHaveLength(1);
    expect(seen.list[0]).toMatch(/acme__lane$/);
    expect(seen.checkout).toBe(false);
    expect(seen.mirror).toBe(true);
    expect(seen.lenses).toEqual([expect.stringMatching(/autonomous lane/)]);

    // Outside the lane — and after it — everything is visible again, and the file never changed.
    expect(listEnrolled()).toHaveLength(2);
    expect(isEnrolled(checkout)).toBe(true);
    expect(activeEnrollmentLenses()).toEqual([]);
    expect(readFileSync(enrollmentPath(), 'utf8')).toBe(before);
  });

  it('a registry write from inside the lane never drops entries the lane cannot see', async () => {
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    enroll(checkout);
    const mirror = mirrorPathFor('acme/lane');
    mkdirSync(mirror, { recursive: true });
    await runInAutonomousLane(async () => {
      expect(enroll(mirror).ok).toBe(true);
      expect(listEnrolled()).toHaveLength(1);
    });
    expect(isEnrolled(checkout)).toBe(true);
    expect(isEnrolled(mirror)).toBe(true);
  });

  it('narrowToAutonomousLane narrows only its own scope, refuses without one, and does not leak to the caller', async () => {
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    enroll(checkout);
    expect(narrowToAutonomousLane()).toBe(false);
    expect(activeEnrollmentLenses()).toEqual([]);

    let concurrentSawCheckout: boolean | null = null;
    const scoped = withEnrollmentScope(async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(isEnrolled(checkout)).toBe(true);
      expect(narrowToAutonomousLane()).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      return isEnrolled(checkout);
    });
    // A concurrent, unrelated async context (a Verse request, say) is unaffected.
    const concurrent = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      concurrentSawCheckout = isEnrolled(checkout);
    })();
    expect(await scoped).toBe(false);
    await concurrent;
    expect(concurrentSawCheckout).toBe(true);
    expect(isEnrolled(checkout)).toBe(true);
    expect(activeEnrollmentLenses()).toEqual([]);
  });
});

describe('tick preparation and enrollment (continued)', () => {
  it('reconcile run inside the lane only ever sees — and so only ever changes — mirrors', async () => {
    origin('acme/a');
    await ensureMirror({ nameWithOwner: 'acme/a' }, deps());
    const checkout = join(fx.home, 'code', 'mine');
    mkdirSync(checkout, { recursive: true });
    enroll(checkout);
    const result = await runInAutonomousLane(() => reconcileAutonomousEnrollment(policyOf('acme/a'), { apply: true, drainMs: 1_000 }));
    expect(result.enrolled).toEqual([mirrorPathFor('acme/a')]);
    expect(result.plan.untouched).toEqual([]);
    expect(isEnrolled(checkout)).toBe(true);
  }, REAL_IO_TIMEOUT);
});

describe('listing and removal', () => {
  it('lists mirrors and removes one, refusing while a worktree is linked', async () => {
    origin('acme/widget');
    await ensureMirror({ nameWithOwner: 'acme/widget' }, deps());
    const path = mirrorPathFor('acme/widget');
    expect(listMirrors()).toEqual([
      expect.objectContaining({ nameWithOwner: 'acme/widget', path, present: true, problem: null }),
    ]);

    enroll(path);
    const linked = join(fx.home, 'linked-worktree');
    fixtureGit(path, ['worktree', 'add', '--quiet', '-b', 'sbx', linked]);
    const refused = await removeMirror('acme/widget', { drainMs: 500 });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/1 sandbox worktree/);
    expect(refused.unenrolled).toBe(true);
    expect(isEnrolled(path)).toBe(false);

    const forced = await removeMirror('acme/widget', { force: true });
    expect(forced.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readMirrorState('acme/widget')).toBeNull();
    expect(listMirrors()).toEqual([]);
  }, REAL_IO_TIMEOUT);
});

describe('ashlr mirror CLI', () => {
  function capture(): { out: () => string; err: () => string; restore: () => void } {
    let out = '';
    let err = '';
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out += String(chunk); return true; }) as never);
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err += String(chunk); return true; }) as never);
    return { out: () => out, err: () => err, restore: () => { o.mockRestore(); e.mockRestore(); } };
  }

  it('prints paths, lists as JSON, and refuses bad input without touching the network', async () => {
    const io = capture();
    try {
      expect(await runMirrorCli(['path', 'ashlrai/binshield'])).toBe(0);
      expect(io.out()).toContain(mirrorPathFor('ashlrai/binshield'));
      expect(await runMirrorCli(['list', '--json'])).toBe(0);
      expect(await runMirrorCli(['add', '../etc'])).toBe(2);
      expect(await runMirrorCli(['add'])).toBe(2);
      expect(await runMirrorCli(['sync'])).toBe(2);
      expect(await runMirrorCli(['frobnicate'])).toBe(2);
      expect(await runMirrorCli(['list', '--bogus'])).toBe(2);
      expect(await runMirrorCli(['reconcile'])).toBe(1);
      expect(io.out()).toMatch(/no standing policy is in force/);
    } finally {
      io.restore();
    }
    expect(existsSync(fleetMirrorsRoot())).toBe(false);
  });
});
