/**
 * 3.14 — repos whose package.json installs `file:../<sibling>` (ashlrai/
 * ashlrcode's four `@ashlr/*` packages) can be worked on by the fleet.
 * src/core/fleet/mirrors.ts "SIBLING DEPENDENCIES".
 *
 *   A · resolution happy path: an enrolled, current sibling mirror is pinned
 *       (immutable snapshot under ~/.ashlr/fleet/sibling-pins), `../<dir>` is
 *       laid out next to the mirrors, package.json / lockfile untouched, and
 *       a REAL frozen `npm ci` installs through it; siblings sync first.
 *   B · refusal paths: not enrolled (a checkout never counts), not current,
 *       wrong package, unlayable shapes, a foreign entry at `../<dir>`, a
 *       symlink that leaves the sibling.
 *   C · the proof: pins are in the install key, the verify binding and G3's
 *       digest; a sibling that moves invalidates them.
 *   D · nothing outside the fleet root is created, linked or granted.
 *
 * Every "GitHub" is a local bare repo (allowLocalOrigin); isolated tmp HOME
 * (h1 fixture); REAL-IO (real git, one real npm ci).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Confinement opens only under a standing policy; null (the default) keeps
// every other test here on the unconfined path.
const standing = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => standing.policy,
}));

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { fixtureGit, makeBareOrigin, makeSourceCheckout, type BareOrigin } from './helpers/throughput-310b.js';
import {
  ensureMirror,
  fleetMirrorsRoot,
  mirrorPathFor,
  mirrorSiblingPins,
  planMirrorDependencies,
  prepareMirrorsForTick,
  readMirrorState,
  siblingDependenciesOf,
  siblingLinkPath,
  siblingPinPath,
  siblingPinsDigest,
  siblingPinsRoot,
  type MirrorDependencyInstallPlan,
  type MirrorDeps,
  type SiblingPin,
} from '../src/core/fleet/mirrors.js';
import { enroll } from '../src/core/sandbox/policy.js';
import { evaluateG3 } from '../src/core/fleet/merge-gates.js';
import { hasCurrentVerificationBinding, linkVerifyNodeModules, openStandingVerificationConfinement, verifyProposal } from '../src/core/inbox/merge.js';
import { runVerifyCommandAsync } from '../src/core/run/verify-commands.js';
import { hashDiff } from '../src/core/foundry/provenance.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const REAL_IO_TIMEOUT = 90_000;

let fx: H1Fixture;
const origins = new Map<string, BareOrigin>();
const disposers: Array<() => void> = [];

function origin(nameWithOwner: string, files: Record<string, string>): BareOrigin {
  const made = makeBareOrigin(files);
  origins.set(nameWithOwner, made);
  disposers.push(() => made.destroy());
  return made;
}

function deps(extra: Partial<MirrorDeps> = {}): MirrorDeps {
  return {
    originUrlFor: (nameWithOwner) => origins.get(nameWithOwner)?.bareDir ?? `/nonexistent/${nameWithOwner}.git`,
    allowLocalOrigin: true,
    githubToken: async () => null,
    siblingLeaseWaitMs: 5_000,
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

/** The shape npm writes for `"@acme/lib": "file:../lib"` (a link, no registry). */
function linkedNpmLock(name: string, dep: string, dir: string): string {
  return `${JSON.stringify({
    name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name, version: '1.0.0', dependencies: { [dep]: `file:../${dir}` } },
      [`../${dir}`]: { name: dep, version: '1.0.0' },
      [`node_modules/${dep}`]: { resolved: `../${dir}`, link: true },
    },
  }, null, 2)}\n`;
}

function libFiles(version: string, name = '@acme/lib'): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({ name, version: '1.0.0', main: 'index.js' })}\n`,
    'index.js': `module.exports = ${JSON.stringify(version)};\n`,
    '.gitignore': 'node_modules\n',
  };
}

function appFiles(spec = 'file:../lib', dep = '@acme/lib'): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { [dep]: spec } })}\n`,
    'package-lock.json': linkedNpmLock('app', dep, 'lib'),
    '.gitignore': 'node_modules\n',
  };
}

/** Records every install; checks the sibling is reachable at `../lib` exactly as a manager would resolve it. */
function recordingInstaller() {
  const calls: { plan: MirrorDependencyInstallPlan; path: string; sawLib: string | null }[] = [];
  const install = async (plan: MirrorDependencyInstallPlan, path: string) => {
    let sawLib: string | null = null;
    try {
      sawLib = readFileSync(join(path, '..', 'lib', 'index.js'), 'utf8');
    } catch { /* not laid out */ }
    calls.push({ plan, path, sawLib });
    mkdirSync(join(path, 'node_modules', '.bin'), { recursive: true });
    return { ok: true, reason: 'installed' };
  };
  return { calls, install };
}

async function mirrorAndEnroll(nameWithOwner: string, extra: Partial<MirrorDeps> = {}): Promise<void> {
  const synced = await ensureMirror({ nameWithOwner }, deps(extra));
  expect(synced.ok, synced.reason).toBe(true);
  expect(enroll(mirrorPathFor(nameWithOwner)).ok).toBe(true);
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

const onDarwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

beforeEach(() => {
  standing.policy = null;
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  origins.clear();
});

// ---------------------------------------------------------------------------
// A. Resolution happy path
// ---------------------------------------------------------------------------

describe('A · an enrolled sibling mirror is pinned and laid out at ../<dir>', () => {
  it('pins the sibling at its HEAD, links ../lib to the snapshot, records the pin, and leaves package.json alone', async () => {
    const lib = origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const installer = recordingInstaller();
    const app = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }));
    expect(app.ok, app.reason).toBe(true);

    const pin: SiblingPin = { dir: 'lib', nameWithOwner: 'acme/lib', headSha: lib.head(), dependencies: ['@acme/lib'] };
    expect(readMirrorState('acme/app')?.deps).toMatchObject({ status: 'installed', siblings: [pin] });
    expect(installer.calls).toHaveLength(1);
    expect(installer.calls[0]!.sawLib).toContain('v1');
    expect(installer.calls[0]!.plan.siblings).toEqual([pin]);

    // ../lib is a relative link inside the fleet root to an immutable snapshot.
    const link = siblingLinkPath('lib');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(`../sibling-pins/acme__lib/${pin.headSha}`);
    expect(realpathSync(link)).toBe(realpathSync(siblingPinPath(pin)));
    expect(readdirSync(siblingPinPath(pin)).sort()).toEqual(['.gitignore', 'index.js', 'package.json']); // no .git, no node_modules

    // Laid out, not rewritten: the mirror is still origin's tree.
    expect(fixtureGit(mirrorPathFor('acme/app'), ['status', '--porcelain'])).toBe('');
    expect(siblingDependenciesOf(mirrorPathFor('acme/app'))).toEqual([{ dependency: '@acme/lib', spec: 'file:../lib', dir: 'lib' }]);

    // Unchanged sibling ⇒ unchanged key ⇒ no reinstall.
    const again = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }));
    expect(again.ok, again.reason).toBe(true);
    expect(installer.calls).toHaveLength(1);
  }, REAL_IO_TIMEOUT);

  it('a real frozen npm ci installs through ../lib; a sibling that moves means a reinstall against the new pin', async () => {
    const lib = origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const first = await ensureMirror({ nameWithOwner: 'acme/app' }, deps()); // production installer: real npm
    expect(first.ok, first.reason).toBe(true);
    const installed = join(mirrorPathFor('acme/app'), 'node_modules', '@acme', 'lib', 'index.js');
    expect(readFileSync(installed, 'utf8')).toContain('v1');
    expect(isUnder(realpathSync(installed), realpathSync(siblingPinsRoot()))).toBe(true);
    const lockBefore = readFileSync(join(mirrorPathFor('acme/app'), 'package-lock.json'), 'utf8');

    lib.push({ 'index.js': 'module.exports = "v2";\n' }, 'v2');
    await ensureMirror({ nameWithOwner: 'acme/lib' }, deps());
    const moved = await ensureMirror({ nameWithOwner: 'acme/app' }, deps());
    expect(moved.ok, moved.reason).toBe(true);
    expect(readFileSync(installed, 'utf8')).toContain('v2');
    expect(readMirrorState('acme/app')?.deps?.siblings?.[0]?.headSha).toBe(lib.head());
    expect(readFileSync(join(mirrorPathFor('acme/app'), 'package-lock.json'), 'utf8')).toBe(lockBefore);
  }, REAL_IO_TIMEOUT);

  it('tick prep syncs the sibling first, so the dependent pins its fresh HEAD', async () => {
    const lib = origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const installer = recordingInstaller();
    const d = deps({ installDependencies: installer.install });
    expect((await ensureMirror({ nameWithOwner: 'acme/app' }, d)).ok).toBe(true);
    expect(enroll(mirrorPathFor('acme/app')).ok).toBe(true);

    const fresh = lib.push({ 'index.js': 'module.exports = "v2";\n' }, 'v2');
    // The dependent is listed FIRST; the order must still put its sibling first.
    const prep = await prepareMirrorsForTick(policyOf('acme/app', 'acme/lib'), { ...d, concurrency: 2 });
    expect(prep.failed).toEqual([]);
    expect(prep.ready.map((row) => row.nameWithOwner)).toEqual(['acme/app', 'acme/lib']);
    expect(readMirrorState('acme/app')?.deps?.siblings?.[0]?.headSha).toBe(fresh);
    expect(installer.calls.at(-1)!.sawLib).toContain('v2');
    // The old pin is no longer referenced by anything and is pruned.
    expect(readdirSync(join(siblingPinsRoot(), 'acme__lib'))).toEqual([fresh]);
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// B. Refusal paths
// ---------------------------------------------------------------------------

describe('B · anything but an enrolled, current, matching sibling mirror keeps refusing', () => {
  it('a sibling that is not an enrolled mirror is refused — a checkout of it never counts, and is never linked', async () => {
    const libOrigin = origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    // A Mason-style checkout of the sibling, enrolled: must not be used.
    const checkout = makeSourceCheckout(libOrigin);
    disposers.push(() => checkout.destroy());
    expect(enroll(checkout.dir).ok).toBe(true);
    // The sibling's mirror exists but is NOT enrolled.
    expect((await ensureMirror({ nameWithOwner: 'acme/lib' }, deps())).ok).toBe(true);

    const installer = recordingInstaller();
    const app = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }));
    expect(app.ok).toBe(false);
    expect(app.reason).toMatch(/depends on \.\.\/lib which is not enrolled — enroll it or vendor it/);
    expect(installer.calls).toHaveLength(0);
    expect(existsSync(siblingLinkPath('lib'))).toBe(false);
    expect(existsSync(siblingPinsRoot())).toBe(false);
    const prep = await prepareMirrorsForTick(policyOf('acme/app'), deps({ installDependencies: installer.install }));
    expect(prep.failed[0]!.reason).toMatch(/^prep failed: dependencies cannot be installed: .*not enrolled — enroll it or vendor it/);
  }, REAL_IO_TIMEOUT);

  it('refuses a sibling whose mirror is not current, and one whose package is not the dependency', async () => {
    origin('acme/lib', libFiles('v1', '@other/lib'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const installer = recordingInstaller();
    const wrongName = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }));
    expect(wrongName.ok).toBe(false);
    expect(wrongName.reason).toMatch(/acme\/lib's package\.json is named "@other\/lib", not "@acme\/lib"/);

    // A sibling whose last sync failed is not current.
    origins.get('acme/lib')!.destroy();
    origins.delete('acme/lib');
    expect((await ensureMirror({ nameWithOwner: 'acme/lib' }, deps())).ok).toBe(false);
    const stale = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }));
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/acme\/lib's fleet mirror is not current/);
    expect(installer.calls).toHaveLength(0);
  }, REAL_IO_TIMEOUT);

  it('never replaces an entry at ../<dir> the fleet did not make', async () => {
    origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    mkdirSync(siblingLinkPath('lib'));
    writeFileSync(join(siblingLinkPath('lib'), 'keep.txt'), 'mine');
    const app = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: recordingInstaller().install }));
    expect(app.ok).toBe(false);
    expect(app.reason).toMatch(/exists and is not a link the fleet made/);
    expect(readFileSync(join(siblingLinkPath('lib'), 'keep.txt'), 'utf8')).toBe('mine');
  }, REAL_IO_TIMEOUT);

  it('refuses a sibling snapshot with a symlink that leaves the repository', async () => {
    const lib = origin('acme/lib', libFiles('v1'));
    symlinkSync('../../../../../etc', join(lib.pusherDir, 'escape'));
    lib.push({}, 'add an escaping link');
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const app = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: recordingInstaller().install }));
    expect(app.ok).toBe(false);
    expect(app.reason).toMatch(/escape is a symlink that leaves the repository/);
    expect(readdirSync(siblingPinsRoot()).filter((entry) => entry.startsWith('.staging-'))).toEqual([]);
    expect(existsSync(siblingLinkPath('lib'))).toBe(false);
  }, REAL_IO_TIMEOUT);

  it('the plan refuses every shape that is not a direct sibling, and any sibling without a pin', () => {
    const dir = join(fx.home, 'plan');
    mkdirSync(dir, { recursive: true });
    const write = (dependencies: Record<string, string>) => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies }));
      writeFileSync(join(dir, 'bun.lock'), '{}');
    };
    for (const spec of ['file:../../x', 'file:../x/sub', 'link:/opt/x', 'file:~/x', 'file:..']) {
      write({ x: spec });
      expect(siblingDependenciesOf(dir)).toEqual([]);
      expect(planMirrorDependencies(dir)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/a path outside the repository/) });
    }
    write({ '@ashlr/auth': 'file:../ashlr-auth' });
    expect(siblingDependenciesOf(dir)).toEqual([{ dependency: '@ashlr/auth', spec: 'file:../ashlr-auth', dir: 'ashlr-auth' }]);
    expect(planMirrorDependencies(dir)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/\.\.\/ashlr-auth was not resolved to one/) });
    // A pin for a DIFFERENT sibling does not cover it.
    const other: SiblingPin = { dir: 'ashlr-cost', nameWithOwner: 'ashlrai/ashlr-cost', headSha: 'a'.repeat(40), dependencies: ['@ashlr/cost'] };
    expect(planMirrorDependencies(dir, [other]).kind).toBe('refuse');
  });

  it('a sibling name that could read as a mirror slug is never laid out', async () => {
    origin('acme/app', {
      'package.json': `${JSON.stringify({ name: 'app', dependencies: { x: 'file:../evil__slug' } })}\n`,
      'package-lock.json': '{}\n',
    });
    const app = await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: recordingInstaller().install }));
    expect(app.ok).toBe(false);
    expect(app.reason).toMatch(/not a plain repository name the fleet can lay out/);
    expect(existsSync(join(fleetMirrorsRoot(), 'evil__slug'))).toBe(false);
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// C. The proof binds the pins
// ---------------------------------------------------------------------------

describe('C · sibling pins are part of the install key, the verify binding and the G3 digest', () => {
  it('the key moves with the pin; repos without siblings keep their key; the digest is null without pins', () => {
    const dir = join(fx.home, 'keyed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@acme/lib': 'file:../lib' } }));
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    const pin = (sha: string): SiblingPin => ({ dir: 'lib', nameWithOwner: 'acme/lib', headSha: sha, dependencies: ['@acme/lib'] });
    const k1 = planMirrorDependencies(dir, [pin('1'.repeat(40))]);
    const k2 = planMirrorDependencies(dir, [pin('2'.repeat(40))]);
    expect(k1.kind === 'install' && k2.kind === 'install' && k1.key !== k2.key).toBe(true);
    expect(siblingPinsDigest([])).toBeNull();
    expect(siblingPinsDigest([pin('1'.repeat(40))])).not.toBe(siblingPinsDigest([pin('2'.repeat(40))]));

    // No siblings: identical key with or without (irrelevant) pins.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { zod: '^3.0.0' } }));
    const plain = planMirrorDependencies(dir);
    const plainWithPins = planMirrorDependencies(dir, [pin('1'.repeat(40))]);
    expect(plain.kind === 'install' && plainWithPins.kind === 'install' && plain.key === plainWithPins.key).toBe(true);
    expect(plain).not.toHaveProperty('siblings');
  });

  it('G3 hashes the pins only when present, so a moved sibling is a different proof', () => {
    const base = { ok: true, detail: 'green', baseBranch: 'main', baseHead: 'b'.repeat(40), commandKinds: ['test'] };
    const g3 = (siblingPins?: string) => evaluateG3({
      verify: { ...base, ...(siblingPins ? { siblingPins } : {}) },
      parity: null,
      tree: { ok: true, treeSha: 't'.repeat(40) },
      diffHash: 'd'.repeat(64),
    });
    expect(g3().inputs).not.toHaveProperty('siblingPins');
    expect(g3('p1').inputs).toMatchObject({ siblingPins: 'p1' });
    expect(JSON.stringify(g3('p1').inputs)).not.toBe(JSON.stringify(g3('p2').inputs));
  });

  it('a verification bound to the old pins is no longer current once the sibling moves; a moved link fails verification as infra', async () => {
    const lib = origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    const installer = recordingInstaller();
    expect((await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }))).ok).toBe(true);
    const appPath = mirrorPathFor('acme/app');
    const pins = mirrorSiblingPins(appPath);
    expect(pins.ok).toBe(true);
    const digest = pins.ok ? pins.digest! : '';
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const diff = 'diff --git a/x b/x\n';
    const proposal = (siblingPins?: string): Proposal => ({
      id: 'p-sibling',
      repo: appPath,
      diff,
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: fixtureGit(appPath, ['rev-parse', 'HEAD']),
        diffHash: hashDiff(diff),
        ...(siblingPins ? { siblingPins } : {}),
      },
    } as unknown as Proposal);
    expect(hasCurrentVerificationBinding(proposal(digest))).toBe(true);
    expect(hasCurrentVerificationBinding(proposal())).toBe(false); // verified before the pins existed

    // Another dependent re-pins ../lib to a newer commit: the install is no
    // longer the pinned tree, and verification refuses to run on it.
    const v2 = lib.push({ 'index.js': 'module.exports = "v2";\n' }, 'v2');
    await ensureMirror({ nameWithOwner: 'acme/lib' }, deps());
    rmSync(siblingLinkPath('lib'));
    symlinkSync(`../sibling-pins/acme__lib/${v2}`, siblingLinkPath('lib'));
    expect(mirrorSiblingPins(appPath)).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer resolves to acme\/lib@/) });
    expect(hasCurrentVerificationBinding(proposal(digest))).toBe(false);
    const verified = await verifyProposal(proposal(digest), {} as AshlrConfig);
    expect(verified).toMatchObject({ ok: false, failureCategory: 'infra', detail: expect.stringMatching(/sibling dependencies are not at their pinned commits/) });

    // The dependent's next sync reinstalls against the new pin: a new digest.
    expect((await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: installer.install }))).ok).toBe(true);
    const repinned = mirrorSiblingPins(appPath);
    expect(repinned.ok && repinned.digest !== digest && repinned.pins[0]!.headSha === v2).toBe(true);
    expect(hasCurrentVerificationBinding(proposal(digest))).toBe(false);
    expect(hasCurrentVerificationBinding(proposal(repinned.ok ? repinned.digest! : ''))).toBe(true);
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// D. Nothing outside the fleet root
// ---------------------------------------------------------------------------

describe('D · everything sibling resolution creates, links or grants is under ~/.ashlr/fleet', () => {
  it('links, pins and verification read grants all resolve inside the fleet root', async () => {
    origin('acme/lib', libFiles('v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    expect((await ensureMirror({ nameWithOwner: 'acme/app' }, deps({ installDependencies: recordingInstaller().install }))).ok).toBe(true);
    const fleetRoot = realpathSync(join(fx.home, '.ashlr', 'fleet'));

    const pins = mirrorSiblingPins(mirrorPathFor('acme/app'));
    expect(pins.ok).toBe(true);
    for (const path of pins.ok ? pins.readPaths : []) {
      expect(isUnder(realpathSync(path), fleetRoot), path).toBe(true);
      expect(isUnder(path, join(realpathSync(fx.home), '.ashlr', 'fleet')) || isUnder(path, join(fx.home, '.ashlr', 'fleet')), path).toBe(true);
    }
    expect(isUnder(realpathSync(join(mirrorPathFor('acme/app'), '..', 'lib')), fleetRoot)).toBe(true);

    // The confined suite's grants: the mirror's install plus the pin — nothing else.
    const wt = join(fx.home, 'wt');
    mkdirSync(wt);
    const grants = linkVerifyNodeModules(mirrorPathFor('acme/app'), wt);
    expect(grants.length).toBe(3);
    for (const grant of grants) expect(isUnder(realpathSync(grant), fleetRoot), grant).toBe(true);

    // A repo that is not a mirror has no pins and gets no extra grants.
    expect(mirrorSiblingPins(fx.home)).toEqual({ ok: true, pins: [], digest: null, readPaths: [] });
  }, REAL_IO_TIMEOUT);
});

describe('D · confined verification reads the pinned sibling through ../<dir> (darwin sandbox)', () => {
  it.skipIf(!onDarwin)('with the pin grants an npm-linked sibling is readable confined; without them it is not', async () => {
    origin('acme/lib', libFiles('pinned-v1'));
    origin('acme/app', appFiles());
    await mirrorAndEnroll('acme/lib');
    expect((await ensureMirror({ nameWithOwner: 'acme/app' }, deps())).ok).toBe(true); // real npm: a link through ../lib
    const home = realpathSync(fx.home);
    mkdirSync(join(home, '.ashlr', 'tmp'), { recursive: true, mode: 0o700 });
    const wt = join(home, '.ashlr', 'tmp', 'sibling-wt');
    mkdirSync(wt, { recursive: true });
    const grants = linkVerifyNodeModules(mirrorPathFor('acme/app'), wt);
    standing.policy = { grantId: 'g' };
    const cfg = {} as AshlrConfig;
    const read = { kind: 'test' as const, cmd: ['cat', 'node_modules/@acme/lib/index.js'], required: true };

    const confined = await openStandingVerificationConfinement(wt, { readOnlyPaths: grants });
    expect(confined).not.toBeNull();
    try {
      const run = await runVerifyCommandAsync(read, wt, cfg, { _runSubprocess: confined!.runSubprocess, timeoutMs: 30_000 });
      expect(run.ok, run.output).toBe(true);
      expect(run.output).toContain('pinned-v1');
    } finally {
      confined!.close();
    }

    const installOnly = await openStandingVerificationConfinement(wt, { readOnlyPaths: [join(mirrorPathFor('acme/app'), 'node_modules')] });
    try {
      const run = await runVerifyCommandAsync(read, wt, cfg, { _runSubprocess: installOnly!.runSubprocess, timeoutMs: 30_000 });
      expect(run.ok).toBe(false);
    } finally {
      installOnly!.close();
    }
  }, REAL_IO_TIMEOUT);
});
