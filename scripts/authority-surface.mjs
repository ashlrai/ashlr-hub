#!/usr/bin/env node
/**
 * authority-surface.mjs — V3.10 Track B (unit B-U1). Build step, runs right
 * after `tsc` in `npm run build`. CODEOWNERS-protected (Tier-1 tooling).
 *
 * Walks the RUNTIME import closure of the authority roots in the compiled
 * release and writes dist/authority-surface.json: every file's sha256, the
 * bare packages the closure imports (with the installed version) and one
 * digest over all of it. A standing grant pins that digest
 * (`authoritySurfaceDigest`), so a deploy that changes any file in the
 * closure pauses the grant until Mason re-approves (src/core/authority/
 * surface.ts re-hashes the listed files at runtime).
 *
 * WHY THE COMPILED JS AND NOT src/: type-only imports vanish in the output,
 * so this is exactly the code that runs. WHY THE TYPESCRIPT PARSER AND NOT A
 * REGEX: comments and strings that look like imports must not count, and
 * every real form must — static, side-effect, `export … from`, `export * as
 * ns from`, literal dynamic `import()`, `require()`. A dynamic import with a
 * COMPUTED specifier cannot be followed; it is recorded in `unresolved`
 * (part of the digest) so a reviewer sees it instead of it silently widening
 * the surface.
 *
 * Deterministic: no timestamps, sorted everything — rebuilding the same code
 * yields the same digest.
 *
 * Usage:
 *   node scripts/authority-surface.mjs                 write dist/authority-surface.json
 *   node scripts/authority-surface.mjs --check         recompute and compare (exit 1 on drift)
 *   node scripts/authority-surface.mjs --out <file>    write elsewhere (inspection)
 *   node scripts/authority-surface.mjs --package-root <dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The authority roots: every runtime module that DECIDES whether autonomy may
 * act or how far — verification, the capability, the gates and the merge,
 * post-merge reverts, confinement, routing under the grant, the Leader's
 * actions and harness adoption (SPEC-310B §2 Tier-1 source modules).
 * Package-root relative; a trailing `/` means every .js/.mjs file below that
 * directory. A root that does not exist yet (a unit not landed) is recorded
 * in `missingRoots` — part of the digest, so its later arrival changes it.
 *
 * Integration additions (cross-unit requests): run/engine-registry and
 * resources/native-profile (U7 — engine mapping and the confined grok-cli
 * launch), learn/experiments and local-eval/tasks-heldout (U9 — the adoption
 * yardstick). U4's fleet/{post-merge-watch,quarantine} and
 * daemon/post-merge-halt were already roots. Listing a module that the
 * closure already reaches changes nothing in the digest; listing it anyway
 * keeps it in the surface if an import refactor ever drops the path to it.
 *
 * NOT roots, deliberately: daemon/loop.js and fleet/tick-hooks-live.js. They
 * ORCHESTRATE — every decision they make is a call into a module listed here
 * (mint / claim of the capability, currentStandingPolicy, the gates,
 * confinement) — but each drags in the whole daemon, the Verse server and
 * Universe (≈590 files, measured 2026-09-24, vs ≈356 without them). As roots
 * they would pause the grant on nearly every deploy, which is exactly the
 * human bottleneck the addendum removes. They stay Tier-1 protected paths,
 * so the fleet can never change them; only Mason's own deploys can.
 */
export const AUTHORITY_SURFACE_ROOTS = Object.freeze([
  'dist/core/authority/',
  'dist/core/daemon/activation-permit.js',
  'dist/core/daemon/tick-hooks.js',
  'dist/core/daemon/post-merge-halt.js',
  'dist/core/daemon/liveness.js',
  'dist/core/inbox/merge.js',
  'dist/core/fleet/automerge-pass.js',
  'dist/core/fleet/merge-gates.js',
  'dist/core/fleet/standing-merge-pass.js',
  'dist/core/fleet/fleet-merge-state.js',
  'dist/core/fleet/host-merge.js',
  'dist/core/fleet/post-merge-watch.js',
  'dist/core/fleet/quarantine.js',
  'dist/core/fleet/regression-sentinel.js',
  'dist/core/fleet/dispatch-router.js',
  'dist/core/fleet/backpressure.js',
  'dist/core/fleet/mirrors.js',
  'dist/core/fleet/manager.js',
  'dist/core/fleet/reviewer-independence.js',
  'dist/core/sandbox/',
  'dist/core/policy/',
  'dist/core/routing/policy.js',
  'dist/core/routing/router.js',
  'dist/core/routing/headroom.js',
  'dist/core/routing/budget-store.js',
  'dist/core/routing/types.js',
  'dist/core/foundry/provenance.js',
  'dist/core/run/sandboxed-engine.js',
  'dist/core/run/engine-registry.js',
  'dist/core/resources/native-profile.js',
  'dist/core/vision/leader-apply.js',
  'dist/core/learn/harness-registry.js',
  'dist/core/learn/experiments.js',
  'dist/core/local-eval/tasks-heldout.js',
  'dist/core/autonomy/host-merge-revocation-protocol.js',
  'dist/core/learning/agent-semantic-events.js',
  'scripts/run-verify-command.mjs',
]);

export const AUTHORITY_SURFACE_MANIFEST = 'dist/authority-surface.json';
export const AUTHORITY_SURFACE_DIGEST_DOMAIN = 'ashlr:authority-surface:v1\0';

const MODULE_FILE = /\.(?:js|mjs|cjs)$/u;
const MAX_FILES = 5_000;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Byte-identical copy of src/core/authority/canonical-json.ts (this script
 * runs where no TypeScript is loadable). test/authority-surface-310b.test.ts
 * builds a manifest with THIS file and verifies it with surface.ts, so the
 * two encoders cannot drift apart unnoticed.
 */
export function canonicalJson(value) {
  const stack = new Set();
  const encode = (current) => {
    if (current === null) return 'null';
    if (typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('canonical JSON rejects non-finite numbers');
      return JSON.stringify(current);
    }
    if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') return undefined;
    if (typeof current !== 'object') throw new Error('canonical JSON rejects unsupported values');
    if (stack.has(current)) throw new Error('canonical JSON rejects cycles');
    stack.add(current);
    try {
      if (Array.isArray(current)) return `[${current.map((entry) => encode(entry) ?? 'null').join(',')}]`;
      const entries = Object.keys(current).sort().flatMap((key) => {
        const encoded = encode(current[key]);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
      return `{${entries.join(',')}}`;
    } finally {
      stack.delete(current);
    }
  };
  const encoded = encode(value);
  if (encoded === undefined) throw new Error('canonical JSON requires a value');
  return encoded;
}

export function authoritySurfaceDigest(core) {
  return createHash('sha256')
    .update(AUTHORITY_SURFACE_DIGEST_DOMAIN + canonicalJson({
      v: core.v,
      roots: core.roots,
      missingRoots: core.missingRoots,
      files: core.files,
      packages: core.packages,
      unresolved: core.unresolved,
    }), 'utf8')
    .digest('hex');
}

function toPosix(rel) {
  return rel.split(sep).join('/');
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function listModuleFiles(dir) {
  const out = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`authority root contains a symlink: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && MODULE_FILE.test(entry.name)) out.push(path);
    }
  }
  return out;
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Every module specifier a compiled file references, via the TypeScript AST.
 * `computed` counts `import(expr)` calls whose specifier is not a literal.
 */
export function moduleSpecifiers(ts, fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const specifiers = [];
  let computed = 0;
  const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const spec = literal(node.arguments[0]);
        if (spec !== null) specifiers.push(spec);
        else if (isDynamicImport) computed += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, computed };
}

function sha256File(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/**
 * Compute the manifest for the release at `packageRoot`. `ts` is the
 * TypeScript module (injected by tests; loaded from node_modules otherwise).
 */
export async function computeAuthoritySurface({ packageRoot, roots = AUTHORITY_SURFACE_ROOTS, ts } = {}) {
  const root = realpathSync(packageRoot);
  const typescript = ts ?? (await import('typescript')).default;
  const missingRoots = [];
  const queue = [];
  for (const rootSpec of roots) {
    const absolute = join(root, ...rootSpec.split('/').filter(Boolean));
    if (!existsSync(absolute)) {
      missingRoots.push(rootSpec);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`authority root is a symlink: ${rootSpec}`);
    if (rootSpec.endsWith('/')) {
      if (!stat.isDirectory()) throw new Error(`authority root ${rootSpec} is not a directory`);
      queue.push(...listModuleFiles(absolute));
    } else {
      if (!stat.isFile()) throw new Error(`authority root ${rootSpec} is not a file`);
      queue.push(absolute);
    }
  }

  const seen = new Set();
  const packages = new Map();
  const unresolved = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > MAX_FILES) throw new Error(`authority closure exceeds ${MAX_FILES} files`);
    const rel = toPosix(relative(root, file));
    const { specifiers, computed } = moduleSpecifiers(typescript, file, readFileSync(file, 'utf8'));
    if (computed > 0) unresolved.add(`${rel} -> import(<computed>) x${computed}`);
    for (const spec of specifiers) {
      if (BUILTINS.has(spec)) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolve(dirname(file), spec);
        if (!inside(root, target) || !existsSync(target) || !lstatSync(target).isFile()) {
          unresolved.add(`${rel} -> ${spec}`);
          continue;
        }
        const targetRel = toPosix(relative(root, target));
        if (!MODULE_FILE.test(target) || !(targetRel.startsWith('dist/') || targetRel.startsWith('scripts/'))) {
          // e.g. createRequire(...)('../../package.json'): data outside the surface, named but not hashed.
          unresolved.add(`${rel} -> ${spec} (outside the surface)`);
          continue;
        }
        queue.push(realpathSync(target));
        continue;
      }
      if (spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(spec)) {
        unresolved.add(`${rel} -> ${spec}`);
        continue;
      }
      const name = packageNameOf(spec);
      if (!packages.has(name)) {
        const pkgJson = join(root, 'node_modules', ...name.split('/'), 'package.json');
        if (!existsSync(pkgJson)) throw new Error(`authority closure imports ${name}, which is not installed under node_modules`);
        const version = JSON.parse(readFileSync(pkgJson, 'utf8')).version;
        if (typeof version !== 'string') throw new Error(`package ${name} has no version`);
        packages.set(name, version);
      }
    }
  }

  const files = [...seen]
    .map((file) => ({ path: toPosix(relative(root, file)), ...sha256File(file) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const core = {
    v: 1,
    roots: [...roots],
    missingRoots,
    files,
    packages: [...packages.entries()].map(([name, version]) => ({ name, version })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    unresolved: [...unresolved].sort(),
  };
  return { ...core, digest: authoritySurfaceDigest(core) };
}

function writeManifest(path, manifest) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  renameSync(temp, path);
}

async function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const value = args[i + 1];
    if (!value) throw new Error(`${flag} needs a value`);
    args.splice(i, 2);
    return value;
  };
  const check = args.includes('--check');
  if (check) args.splice(args.indexOf('--check'), 1);
  const out = take('--out');
  const packageRoot = resolve(take('--package-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (args.length > 0) throw new Error(`unknown arguments: ${args.join(' ')}`);
  const manifest = await computeAuthoritySurface({ packageRoot });
  const summary = `authority-surface: ${manifest.files.length} files, ${manifest.packages.length} packages, `
    + `${manifest.missingRoots.length} missing roots, ${manifest.unresolved.length} unresolved — digest ${manifest.digest}`;
  if (check) {
    const existing = join(packageRoot, AUTHORITY_SURFACE_MANIFEST);
    const current = existsSync(existing) ? JSON.parse(readFileSync(existing, 'utf8')) : null;
    if (!current || current.digest !== manifest.digest) {
      console.error(`${summary}\nauthority-surface: ${existing} is ${current ? `stale (${current.digest})` : 'missing'}`);
      return 1;
    }
    console.log(summary);
    return 0;
  }
  writeManifest(out ? resolve(out) : join(packageRoot, AUTHORITY_SURFACE_MANIFEST), manifest);
  console.log(summary);
  if (manifest.missingRoots.length > 0) console.log(`authority-surface: roots not built yet: ${manifest.missingRoots.join(', ')}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`authority-surface: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
