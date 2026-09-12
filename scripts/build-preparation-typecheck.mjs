/** Trusted source-authoring only: capture a closed whole-project typecheck input.
 * No candidate code is imported, no compiler output is emitted, and no snapshot
 * is published here. The caller separately pins the returned JSON in its bundle.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import ts from 'typescript';
import { build } from 'esbuild';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'src/core/resources/engineering-preparation.ts';
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TEXT = 64 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_PROBES = 65_536;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Preparation typecheck authoring inputs unavailable, invalid or changed'); };
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => a[key] === b[key]);
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const LOADED_COMPILER_PATH = realpathSync(createRequire(import.meta.url).resolve('typescript'));
const LOADED_COMPILER = boundedRead(LOADED_COMPILER_PATH, 16 * 1024 * 1024);

function boundedRead(path, maximum = MAX_FILE) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(maximum) ||
      realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) {
      const got = readSync(fd, bytes, count, bytes.length - count, count);
      if (!Number.isSafeInteger(got) || got < 0 || got > bytes.length - count) fail();
      if (!got) break;
      count += got;
    }
    if (count !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))) fail();
    return { bytes: bytes.subarray(0, count), stat: before };
  } finally { closeSync(fd); }
}

/** Load only the two fixed authoring sources, never a caller-selected checker.
 * The runtime score child bundles the same compiler; this tiny in-memory bundle
 * merely permits authoring before a dist build without installing loader hooks.
 */
async function checker() {
  const paths = ['preparation-typecheck.ts', 'preparation-typecheck-project.ts'].map(name => join(SOURCE_ROOT, 'src/core/universe', name));
  const compilerPath = LOADED_COMPILER_PATH;
  const compiler = LOADED_COMPILER;
  const sources = paths.map(path => ({ path, ...boundedRead(path, 256 * 1024) }));
  const assertUnchanged = () => {
    for (const row of [...sources, { path: compilerPath, ...compiler }]) {
      const current = boundedRead(row.path, row.path === compilerPath ? 16 * 1024 * 1024 : 256 * 1024);
      if (!same(row.stat, current.stat) || !row.bytes.equals(current.bytes)) fail();
    }
  };
  assertUnchanged();
  const compilerUrl = pathToFileURL(compilerPath).href;
  const result = await build({ absWorkingDir: SOURCE_ROOT, entryPoints: [paths[0]], bundle: true, write: false,
    platform: 'node', target: 'node24', format: 'esm', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'fixed-authoring-compiler', setup(builder) {
      builder.onResolve({ filter: /^typescript$/ }, () => ({ path: compilerUrl, external: true }));
    } }] });
  const inputs = Object.keys(result.metafile.inputs).map(path => resolve(SOURCE_ROOT, path)).sort();
  if (JSON.stringify(inputs) !== JSON.stringify([...paths].sort()) || result.outputFiles.length !== 1 ||
      result.outputFiles[0].contents.length > 512 * 1024 ||
      Object.values(result.metafile.outputs).flatMap(output => output.imports).some(row => row.path !== compilerUrl && !isBuiltin(row.path))) fail();
  assertUnchanged();
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assertUnchanged();
  if (typeof loaded.verifyPreparationTypes !== 'function') fail();
  return { verify: loaded.verifyPreparationTypes, assertUnchanged, compilerSha256: sha(compiler.bytes) };
}

export async function authorPreparationTypecheckProject({ repository, expectedSourceSha256 }) {
  try {
    if (typeof repository !== 'string' || !isAbsolute(repository) || resolve(repository) !== repository ||
        realpathSync(repository) !== repository || typeof expectedSourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSourceSha256)) fail();
    const rootIdentity = lstatSync(repository, { bigint: true });
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) fail();
    const runtime = await checker();
    const observations = new Map(); const files = new Map(); let textBytes = 0;
    const within = path => path === repository || path.startsWith(`${repository}${sep}`);
    const observe = path => {
      path = resolve(path);
      if (!within(path)) return null;
      if (observations.has(path)) return observations.get(path);
      if (observations.size >= MAX_PROBES) fail();
      if (path !== repository && !observe(dirname(path))?.isDirectory()) return null;
      let stat;
      try { stat = lstatSync(path, { bigint: true }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; observations.set(path, null); return null; }
      if (stat.isSymbolicLink() || realpathSync(path) !== path) fail();
      observations.set(path, stat); return stat;
    };
    const read = path => {
      path = resolve(path);
      const stat = observe(path);
      if (!stat?.isFile()) return undefined;
      if (files.has(path)) return files.get(path);
      if (files.size >= 8192) fail();
      const captured = boundedRead(path);
      if (!same(stat, captured.stat)) fail();
      const text = decode(captured.bytes); textBytes += captured.bytes.length;
      if (textBytes > MAX_TEXT) fail();
      files.set(path, text); return text;
    };
    const system = {
      useCaseSensitiveFileNames: true,
      fileExists: path => observe(path)?.isFile() === true,
      readFile: read,
      readDirectory(path, extensions, excludes, includes, depth) {
        path = resolve(path);
        if (!observe(path)?.isDirectory()) return [];
        // Observe every directory used by TypeScript's include/exclude walk,
        // including empty ones: adding a new root there must invalidate capture.
        const names = ts.matchFiles(path, extensions, excludes, includes, true, repository, depth, directory => {
          if (!observe(directory)?.isDirectory()) return { files: [], directories: [] };
          const entries = readdirSync(directory, { withFileTypes: true });
          if (entries.length > 8192 || entries.some(entry => entry.isSymbolicLink())) fail();
          return { files: entries.filter(entry => entry.isFile()).map(entry => entry.name).sort(),
            directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort() };
        }, system.realpath);
        if (names.length > 8192 || names.some(name => !observe(name)?.isFile())) fail();
        return names;
      },
      directoryExists: path => observe(path)?.isDirectory() === true,
      getDirectories(path) {
        path = resolve(path);
        if (!observe(path)?.isDirectory()) return [];
        const names = ts.sys.getDirectories(path);
        if (names.length > 8192 || names.some(name => !observe(join(path, name))?.isDirectory())) fail();
        return names;
      },
      realpath(path) { path = resolve(path); if (!observe(path)) return path; return path; },
      getCurrentDirectory: () => repository,
    };
    const configPath = join(repository, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, read);
    if (config.error || !config.config || !Object.hasOwn(config.config, 'compilerOptions')) fail();
    // Extends/references would create another mutable authority boundary. This
    // authoring contract deliberately captures the current single-root config.
    if (Object.hasOwn(config.config, 'extends') || Object.hasOwn(config.config, 'references')) fail();
    for (const key of ['files', 'include', 'exclude']) {
      const patterns = config.config[key];
      if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some(value => typeof value !== 'string' ||
          !value || isAbsolute(value) || /[\\:]/u.test(value) || [...value].some(character => character.charCodeAt(0) < 32) ||
          value.split('/').includes('..')))) fail();
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, system, repository, undefined, configPath);
    if (parsed.errors.length || !parsed.fileNames.length || parsed.fileNames.length > 4096 || !parsed.fileNames.includes(join(repository, TARGET))) fail();
    const packagePath = join(repository, 'node_modules/typescript/package.json');
    const compilerPackage = JSON.parse(read(packagePath) ?? 'null');
    if (compilerPackage?.version !== ts.version) fail();
    const suppliedCompiler = join(repository, 'node_modules/typescript/lib/typescript.js');
    const compilerStat = observe(suppliedCompiler);
    const compiler = boundedRead(suppliedCompiler, 16 * 1024 * 1024);
    if (!compilerStat || !same(compilerStat, compiler.stat) || sha(compiler.bytes) !== runtime.compilerSha256) fail();
    const options = { ...parsed.options, noEmit: true, incremental: false };
    const host = { ...ts.createCompilerHost(options, true), ...system,
      getCanonicalFileName: path => path,
      useCaseSensitiveFileNames: () => true,
      getDefaultLibFileName: values => join(repository, 'node_modules/typescript/lib', ts.getDefaultLibFileName(values)),
      getDefaultLibLocation: () => join(repository, 'node_modules/typescript/lib'),
      writeFile: () => fail(),
      getSourceFile(path, languageVersion) {
        const text = read(path); return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true);
      },
    };
    const program = ts.createProgram(parsed.fileNames, options, host);
    if (ts.getPreEmitDiagnostics(program).length) fail();
    const baseline = files.get(join(repository, TARGET));
    if (baseline === undefined || sha(Buffer.from(baseline)) !== expectedSourceSha256) fail();
    const snapshot = { schemaVersion: 1, kind: 'preparation-typecheck-project', compilerVersion: ts.version,
      baselineSourceSha256: expectedSourceSha256,
      rootNames: parsed.fileNames.map(path => relative(repository, path).split(sep).join('/')).sort((a, b) => a.localeCompare(b)),
      compilerOptions: config.config.compilerOptions,
      files: [...files].map(([path, text]) => ({ path: relative(repository, path).split(sep).join('/'), text })).sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_JSON) fail();
    // This second compile is intentionally closed: success from the discovery
    // host is insufficient if a package/lib/consumer was omitted from capture.
    const checked = runtime.verify(snapshot, baseline);
    if (!checked.passed) fail();
    for (const [path, before] of observations) {
      let current;
      try { current = lstatSync(path, { bigint: true }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; current = null; }
      if (before === null ? current !== null : current === null || !same(before, current) || realpathSync(path) !== path) fail();
    }
    if (!same(rootIdentity, lstatSync(repository, { bigint: true }))) fail();
    runtime.assertUnchanged();
    return snapshot;
  } catch { throw new Error('Preparation typecheck authoring inputs unavailable, invalid or changed'); }
}
