/**
 * V3.10 Track B unit B-U1 — the authority surface.
 *
 * scripts/authority-surface.mjs (build) and src/core/authority/surface.ts
 * (runtime) must agree byte for byte: a manifest the script writes verifies
 * at runtime, and ANY change to a file in the closure, to a pinned package or
 * to the manifest itself is caught. The closure walker follows every real
 * import form (including `export * as ns from` and literal dynamic imports)
 * and ignores imports that only appear in comments or strings.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// confinementAvailable() now delegates to U2's real self-test; faked here so
// the verdict mapping can be pinned without spawning sandbox-exec.
const confine = vi.hoisted(() => ({ result: { ok: true, checkedAt: 'now' } as { ok: true; checkedAt: string } | { ok: false; reason: string; checkedAt: string }, calls: 0 }));
vi.mock('../src/core/sandbox/confine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/sandbox/confine.js')>()),
  probeAutonomousConfinement: () => {
    confine.calls += 1;
    return confine.result;
  },
}));

import { canonicalJson } from '../src/core/authority/canonical-json.js';
import {
  authoritySurfaceDigest,
  hostBindingForPlatformUuid,
  parseIoregPlatformUuid,
  resetSurfaceCachesForTest,
  runningPackageRoot,
  verifyAuthoritySurfaceAt,
  type AuthoritySurfaceManifestV1,
} from '../src/core/authority/surface.js';

interface SurfaceScript {
  AUTHORITY_SURFACE_ROOTS: readonly string[];
  canonicalJson(value: unknown): string;
  authoritySurfaceDigest(core: Omit<AuthoritySurfaceManifestV1, 'digest'>): string;
  moduleSpecifiers(tsModule: typeof ts, fileName: string, text: string): { specifiers: string[]; computed: number };
  packageNameOf(specifier: string): string;
  computeAuthoritySurface(opts: { packageRoot: string; roots?: readonly string[]; ts?: typeof ts }): Promise<AuthoritySurfaceManifestV1>;
}

const script = (await import(pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'authority-surface.mjs')).href)) as SurfaceScript;

let root: string;

function put(rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const ROOTS = ['dist/core/authority/', 'dist/core/daemon/missing.js'];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bu1-surface-')));
  resetSurfaceCachesForTest();
  put('package.json', '{"name":"@ashlr/hub","version":"9.9.9"}\n');
  put('node_modules/fakepkg/package.json', '{"name":"fakepkg","version":"1.2.3"}\n');
  put('node_modules/@scope/lib/package.json', '{"name":"@scope/lib","version":"0.1.0"}\n');
  put('dist/core/authority/a.js', [
    "import { b } from './b.js';",
    "export * as ns from '../x/ns.js';",
    "import 'node:fs';",
    "import fs from 'fs';",
    "import pkg from 'fakepkg';",
    "import { y } from '@scope/lib/sub/y.js';",
    "// import './commented.js';",
    "const s = \"import './in-string.js'\";",
    "const lazy = await import('../lazy/l.js');",
    'const computed = import(globalThis.x);',
    'export const a = b + fs.constants.O_RDONLY + pkg + y + lazy + computed + s;',
  ].join('\n'));
  put('dist/core/authority/b.js', 'export const b = 1;\n');
  put('dist/core/x/ns.js', 'export const n = 1;\n');
  put('dist/core/lazy/l.js', "const pj = require('../../../package.json');\nexport default pj;\n");
  put('dist/core/unrelated.js', 'export const u = 1;\n');
  put('dist/core/authority/commented.js', '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetSurfaceCachesForTest();
});

async function build(): Promise<AuthoritySurfaceManifestV1> {
  const manifest = await script.computeAuthoritySurface({ packageRoot: root, roots: ROOTS, ts });
  writeFileSync(join(root, 'dist', 'authority-surface.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

describe('the build script', () => {
  it('walks exactly the runtime closure', async () => {
    const manifest = await build();
    expect(manifest.files.map((f) => f.path)).toEqual([
      'dist/core/authority/a.js',
      'dist/core/authority/b.js',
      // A root directory contributes every module file in it, imported or not.
      'dist/core/authority/commented.js',
      'dist/core/lazy/l.js',
      'dist/core/x/ns.js',
    ]);
    expect(manifest.packages).toEqual([{ name: '@scope/lib', version: '0.1.0' }, { name: 'fakepkg', version: '1.2.3' }]);
    expect(manifest.missingRoots).toEqual(['dist/core/daemon/missing.js']);
    expect(manifest.unresolved).toEqual([
      'dist/core/authority/a.js -> import(<computed>) x1',
      'dist/core/lazy/l.js -> ../../../package.json (outside the surface)',
    ]);
    expect(manifest.digest).toBe(authoritySurfaceDigest(manifest));
  });

  it('is deterministic and changes when anything in the closure changes', async () => {
    const first = await build();
    expect((await build()).digest).toBe(first.digest);
    put('dist/core/unrelated.js', 'export const u = 2;\n');
    expect((await build()).digest).toBe(first.digest);
    put('dist/core/x/ns.js', 'export const n = 2;\n');
    expect((await build()).digest).not.toBe(first.digest);
  });

  it('follows every import form and nothing in comments or strings', () => {
    const { specifiers, computed } = script.moduleSpecifiers(ts, 'x.js', [
      "import a from './a.js'; import * as b from './b.js'; import './c.js';",
      "export { d } from './d.js'; export * from './e.js'; export * as f from './f.js';",
      "const g = await import('./g.js'); const h = require('./h.js'); const i = import(expr);",
      "// import './no.js'\n/* import('./no2.js') */ const t = `import('./no3.js')`;",
    ].join('\n'));
    expect(specifiers.sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js', './h.js']);
    expect(computed).toBe(1);
    expect(script.packageNameOf('@modelcontextprotocol/sdk/client/index.js')).toBe('@modelcontextprotocol/sdk');
    expect(script.packageNameOf('marked')).toBe('marked');
  });

  it('the production roots cover every authority-deciding module family, including the spend / engine deciders', () => {
    for (const rootSpec of [
      'dist/core/authority/',
      'dist/core/daemon/activation-permit.js',
      'dist/core/inbox/merge.js',
      'dist/core/sandbox/',
      'dist/core/policy/',
      'dist/core/fleet/automerge-pass.js',
      'dist/core/fleet/host-merge.js',
      'dist/core/fleet/post-merge-watch.js',
      'dist/core/vision/leader-apply.js',
      'dist/core/learn/harness-registry.js',
    ]) {
      expect(script.AUTHORITY_SURFACE_ROOTS).toContain(rootSpec);
    }
    // 3.10 review d4: tick-hooks-live clamps the stored budget to the grant and
    // switches Codex seats on under the reserve floor itself; loop picks the
    // standing Codex seat; best-of-n and the Leader choose engines / seats. A
    // deploy that changes any of them must pause the grant (I2), so they are
    // roots — no longer excluded as "orchestrators".
    for (const decider of [
      'dist/core/fleet/tick-hooks-live.js',
      'dist/core/daemon/loop.js',
      'dist/core/run/best-of-n.js',
      'dist/core/vision/leader.js',
      'dist/core/fleet/subscription-usage.js',
      'dist/core/vision/leader-seat.js',
    ]) {
      expect(script.AUTHORITY_SURFACE_ROOTS, decider).toContain(decider);
    }
  });

  it('shares the canonical encoding with the runtime byte for byte', () => {
    const samples: unknown[] = [
      { b: 1, a: [true, null, 'x/y', { z: undefined, y: 'é ' }], c: -0.5 },
      ['\u0000', { '': 1, 'a b': [] }],
      'plain',
      { nested: { deeper: { deepest: [1, 2, 3] } } },
    ];
    for (const sample of samples) expect(script.canonicalJson(sample)).toBe(canonicalJson(sample));
  });
});

describe('runtime verification (surface.ts)', () => {
  it('verifies a manifest the script wrote, with the same digest', async () => {
    const manifest = await build();
    const verified = verifyAuthoritySurfaceAt(root, 'installed', { fresh: true });
    expect(verified).toMatchObject({ ok: true, digest: manifest.digest, fileCount: 5 });
  });

  it('catches a changed file, a changed package and an edited manifest', async () => {
    const manifest = await build();
    put('dist/core/authority/b.js', 'export const b = 2;\n');
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true })).toMatchObject({ ok: false, code: 'file-changed' });
    put('dist/core/authority/b.js', 'export const b = 1;\n');
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true }).ok).toBe(true);

    put('node_modules/fakepkg/package.json', '{"name":"fakepkg","version":"1.2.4"}\n');
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true })).toMatchObject({ ok: false, code: 'package-changed' });
    put('node_modules/fakepkg/package.json', '{"name":"fakepkg","version":"1.2.3"}\n');

    // Dropping a file from the manifest without fixing the digest is detected…
    const dropped = { ...manifest, files: manifest.files.slice(1) };
    writeFileSync(join(root, 'dist', 'authority-surface.json'), JSON.stringify(dropped));
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true })).toMatchObject({ ok: false, code: 'manifest-digest-mismatch' });
    // …and fixing the digest yields a DIFFERENT digest, which no signed grant names.
    const refixed = { ...dropped, digest: authoritySurfaceDigest(dropped) };
    writeFileSync(join(root, 'dist', 'authority-surface.json'), JSON.stringify(refixed));
    const reverified = verifyAuthoritySurfaceAt(root, 'installed', { fresh: true });
    expect(reverified.ok).toBe(true);
    if (reverified.ok) expect(reverified.digest).not.toBe(manifest.digest);
  });

  it('refuses a missing manifest, a missing file and a symlinked file', async () => {
    expect(verifyAuthoritySurfaceAt(root, 'installed')).toMatchObject({ ok: false, code: 'manifest-missing' });
    await build();
    unlinkSync(join(root, 'dist/core/x/ns.js'));
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true })).toMatchObject({ ok: false, code: 'file-missing' });
    put('dist/core/elsewhere.js', 'export const n = 1;\n');
    symlinkSync(join(root, 'dist/core/elsewhere.js'), join(root, 'dist/core/x/ns.js'));
    expect(verifyAuthoritySurfaceAt(root, 'installed', { fresh: true })).toMatchObject({ ok: false, code: 'file-unsafe' });
  });
});

describe('host binding and the running release', () => {
  it('binds to sha256 of the uppercase IOPlatformUUID', () => {
    const uuid = parseIoregPlatformUuid('  |   "IOPlatformUUID" = "12345678-abcd-ABCD-1234-1234567890ab"\n');
    expect(uuid).toBe('12345678-ABCD-ABCD-1234-1234567890AB');
    expect(hostBindingForPlatformUuid(uuid!)).toMatch(/^[a-f0-9]{64}$/);
    expect(hostBindingForPlatformUuid('12345678-abcd-abcd-1234-1234567890ab')).toBe(hostBindingForPlatformUuid(uuid!));
    expect(parseIoregPlatformUuid('no uuid here')).toBeNull();
  });

  it('only a compiled release has a running surface', () => {
    expect(runningPackageRoot(pathToFileURL(join(root, 'src/core/authority/surface.ts')).href)).toBeNull();
    expect(runningPackageRoot('file:///$bunfs/root/ashlr')).toBeNull();
    put('dist/core/authority/surface.js', '');
    expect(runningPackageRoot(pathToFileURL(join(root, 'dist/core/authority/surface.js')).href)).toBe(root);
  });
});

describe('confinement availability (U2 self-test)', () => {
  it('is the real autonomous-profile probe, not just "sandbox-exec exists"', async () => {
    const { confinementAvailable } = await import('../src/core/authority/surface.js');
    confine.calls = 0;
    confine.result = { ok: true, checkedAt: 'now' };
    expect(confinementAvailable()).toEqual(process.platform === 'darwin' ? { ok: true } : { ok: false, reason: expect.stringMatching(/macOS/) });
    confine.result = { ok: false, reason: 'a confined process could read a protected authority file', checkedAt: 'now' };
    const refused = confinementAvailable();
    expect(refused.ok).toBe(false);
    if (process.platform === 'darwin') {
      expect(refused).toEqual({ ok: false, reason: 'Agents cannot be confined here: a confined process could read a protected authority file' });
      expect(confine.calls).toBe(2);
    }
  });
});
