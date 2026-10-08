/* global process, console */
// Advisory source diagnostics, never a qualification/adoption capability.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, posix } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { sourceBinding } from '../../scripts/hosted-build-artifact.mjs';
import { normalizeReport, reportNames } from './ci-qualification-lane.mjs';
import { IMPACT_POLICY, fullChangeReason } from './ci-impact-policy.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (data) => sha(JSON.stringify(data));
const SHA = /^[a-f0-9]{40}$/;
const MAX = 32 * 1024 * 1024;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const tuple = (s) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => s[key]);
function bytes(path) {
  assert.equal(fs.realpathSync(path), path, 'symlink diagnostic input');
  const before = fs.lstatSync(path);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= MAX, 'unsafe diagnostic input');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    assert.deepEqual(tuple(fs.fstatSync(fd)), tuple(before));
    const value = fs.readFileSync(fd);
    assert.equal(value.length, before.size);
    assert.deepEqual(tuple(fs.fstatSync(fd)), tuple(before));
    assert.deepEqual(tuple(fs.lstatSync(path)), tuple(before));
    return value;
  } finally { fs.closeSync(fd); }
}
function command(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024, ...options });
}
function treeRows(root, revision) {
  return command(root, ['ls-tree', '-rz', '--full-tree', revision]).toString().split('\0').filter(Boolean).map((line) => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);
    assert.ok(match, 'unsupported source tree entry');
    return { path: match[3], mode: match[1], blob: match[2] };
  });
}

// One batch reads immutable Git objects for both trees, shared by blob identity.
// It never imports candidate code, spawns a test/CLI, or executes a child fixture.
function readObjects(root, sources) {
  const ids = [...new Set(sources.flatMap((rows) => rows.filter(({ path }) => CODE.test(path) || IMPACT_POLICY.globalInputs.includes(path)).map(({ blob }) => blob)))].sort();
  const output = command(root, ['cat-file', '--batch'], { input: ids.join('\n') + '\n' });
  const objects = new Map(); let cursor = 0;
  for (const id of ids) {
    const end = output.indexOf(10, cursor); assert.ok(end !== -1, 'missing object header');
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(output.subarray(cursor, end).toString());
    assert.ok(match && match[1] === id, 'missing source blob');
    const size = Number(match[2]); assert.ok(Number.isSafeInteger(size) && size <= MAX, 'oversized diagnostic source');
    cursor = end + 1; assert.ok(cursor + size < output.length && output[cursor + size] === 10, 'truncated source blob');
    objects.set(id, output.subarray(cursor, cursor + size)); cursor += size + 1;
  }
  assert.equal(cursor, output.length, 'extra object bytes');
  return objects;
}

export function analyzeModule(path, text) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const imports = new Set(); const unknown = new Set();
  if (source.parseDiagnostics.length) unknown.add('source-parse-unresolved');
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const edge = (node) => { const value = literal(node); if (value === null) unknown.add('computed-import-or-mock'); else imports.add(value); };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) edge(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) edge(node.moduleReference.expression);
    if (ts.isCallExpression(node)) {
      const exp = node.expression;
      if (exp.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(exp) && exp.text === 'require')) edge(node.arguments[0]);
      if (ts.isPropertyAccessExpression(exp) && ['mock', 'doMock', 'importActual', 'importMock'].includes(exp.name.text)) edge(node.arguments[0]);
      if (ts.isIdentifier(exp) && ['eval', 'Function', 'createRequire'].includes(exp.text)) unknown.add('dynamic-code-loading');
      if (ts.isPropertyAccessExpression(exp) && ['glob', 'resolve'].includes(exp.name.text)) unknown.add('computed-discovery-or-resolution');
    }
    if (ts.isIdentifier(node) && ['process', 'globalThis', '__dirname', '__filename'].includes(node.text)) unknown.add('environment-or-source-identity');
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const spec of imports) {
    if (/^(?:node:)?(?:fs|path)(?:\/|$)/.test(spec)) unknown.add('filesystem-or-data-domain');
    if (/^(?:node:)?child_process$/.test(spec)) unknown.add('child-command-domain');
  }
  return { imports: [...imports].sort(), unknown: [...unknown].sort() };
}

function resolvedImport(path, spec, rows) {
  if (!spec.startsWith('.')) return null;
  const raw = posix.normalize(posix.join(posix.dirname(path), spec));
  if (raw.startsWith('../') || raw.startsWith('/')) return null;
  const names = [raw];
  if (/\.[cm]?js$/.test(raw)) names.push(raw.replace(/\.[cm]?js$/, '.ts'), raw.replace(/\.[cm]?js$/, '.tsx'), raw.replace(/\.mjs$/, '.mts'), raw.replace(/\.cjs$/, '.cts'));
  if (!posix.extname(raw)) for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts']) names.push(raw + ext, `${raw}/index${ext}`);
  const matches = [...new Set(names)].filter((name) => rows.has(name));
  return matches.length === 1 ? matches[0] : null;
}

function graph(rows, objects, parsed) {
  const index = new Map(rows.map((row) => [row.path, row])); const nodes = new Map(); const closures = new Map();
  const build = (path) => {
    if (nodes.has(path)) return;
    const row = index.get(path); const node = { ...row, sha256: null, imports: [], unknown: [] }; nodes.set(path, node);
    if (!row || row.mode === '120000' || !CODE.test(path)) { node.unknown = ['nonmodule-or-link-input']; return; }
    const value = objects.get(row.blob); assert.ok(value, 'missing module bytes'); node.sha256 = sha(value);
    const key = `${path}\0${row.blob}`;
    if (!parsed.has(key)) parsed.set(key, analyzeModule(path, value.toString('utf8')));
    const analysis = parsed.get(key); node.unknown.push(...analysis.unknown);
    for (const spec of analysis.imports) {
      const target = resolvedImport(path, spec, index);
      node.imports.push({ specifier: spec, target });
      if (target) build(target); else node.unknown.push(spec.startsWith('.') ? 'unresolved-relative-input' : 'package-or-runtime-input');
    }
    node.unknown = [...new Set(node.unknown)].sort();
  };
  const closure = (path) => {
    if (closures.has(path)) return closures.get(path);
    build(path); const visited = new Set(); const stack = [path];
    while (stack.length) {
      const next = stack.pop(); if (visited.has(next)) continue; visited.add(next);
      for (const edge of nodes.get(next)?.imports ?? []) if (edge.target) stack.push(edge.target);
    }
    const inputs = [...visited].sort().map((name) => nodes.get(name));
    const result = { inputs, digest: digest(inputs), unknown: [...new Set(inputs.flatMap((node) => node.unknown))].sort() };
    closures.set(path, result); return result;
  };
  return { index, nodes, closure };
}

function readLane(directory, role, source, env) {
  const laneBytes = bytes(join(directory, 'lane.json')); const lane = JSON.parse(laneBytes);
  assert.equal(lane.schemaVersion, 1); assert.equal(lane.role, role); assert.equal(lane.exitCode, 0);
  assert.match(lane.nodeVersion ?? '', /^v22\./);
  assert.ok(Number.isFinite(Date.parse(lane.startedAt)) && Date.parse(lane.finishedAt) >= Date.parse(lane.startedAt), 'invalid lane timestamps');
  assert.deepEqual(lane.source, { revision: source.revision, tree: source.tree, eventSha: env.ASHLR_CI_EVENT_SHA });
  assert.deepEqual(lane.run, { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT });
  assert.match(lane.run.id ?? '', /^[1-9][0-9]*$/); assert.match(lane.run.attempt ?? '', /^[1-9][0-9]*$/);
  assert.deepEqual(lane.reports.map((report) => report.file), reportNames(role));
  const reports = lane.reports.map((report) => {
    const rawBytes = bytes(join(directory, 'reports', report.file)); const raw = JSON.parse(rawBytes);
    assert.equal(sha(rawBytes), report.sha256); assert.equal(rawBytes.length, report.bytes);
    const modules = normalizeReport(raw, source.root);
    assert.deepEqual(modules, report.modules, 'raw case projection differs');
    for (const module of modules) assert.ok(source.tracked.some((row) => row.path === module.file), 'untracked test module');
    return { file: report.file, sha256: report.sha256, bytes: report.bytes, modules };
  });
  return { source: lane.source, run: lane.run, nodeVersion: lane.nodeVersion, startedAt: lane.startedAt,
    finishedAt: lane.finishedAt, sha256: sha(laneBytes), reports };
}

export function collectShadow({ root, revision, baseRevision = null, role, laneDirectory, sourceOnly = false, env = process.env }) {
  assert.ok(IMPACT_POLICY.roles.includes(role), 'unknown shadow role');
  root = fs.realpathSync(root);
  if (!sourceOnly) laneDirectory = fs.realpathSync(laneDirectory);
  const initial = sourceBinding(root, revision); const headRows = initial.tracked;
  const head = sourceOnly ? null : readLane(laneDirectory, role, { ...initial, root }, env);
  let base = { revision: null, tree: null, sourceState: 'unavailable', evidenceState: 'unavailable', caseInventory: null, descriptorState: 'unavailable' };
  let baseRows = [];
  if (baseRevision) {
    assert.match(baseRevision, SHA, 'invalid base revision');
    try {
      command(root, ['merge-base', '--is-ancestor', baseRevision, revision]);
      baseRows = treeRows(root, baseRevision);
      base = { ...base, revision: baseRevision, tree: command(root, ['rev-parse', `${baseRevision}^{tree}`]).toString().trim(), sourceState: 'observed' };
    } catch { /* Missing/non-ancestor local base forces full; never fetch it. */ }
  }
  const before = new Map(baseRows.map((row) => [row.path, row])); const after = new Map(headRows.map((row) => [row.path, row]));
  const changes = base.sourceState === 'observed' ? [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const old = before.get(path) ?? null; const next = after.get(path) ?? null;
    return old?.mode === next?.mode && old?.blob === next?.blob ? [] : [{ path, base: old, head: next }];
  }) : null;
  const objects = readObjects(root, [headRows, baseRows]); const parsed = new Map();
  const headGraph = graph(headRows, objects, parsed); const baseGraph = graph(baseRows, objects, parsed);
  const globalInputs = IMPACT_POLICY.globalInputs.map((path) => ({ path, head: after.get(path) ?? null, base: before.get(path) ?? null }));
  const globalReasons = [...new Set((changes ?? []).map(({ path }) => fullChangeReason(path)).filter(Boolean))].sort();
  // Source candidates are not Vitest collection or exact shard membership.
  const files = sourceOnly ? headRows.map((row) => row.path).filter((path) => role === 'web'
    ? /^src\/web-ui\/.*\.test\.(?:ts|tsx)$/.test(path) : /^test\/.*\.test\.ts$/.test(path)).sort()
    : [...new Set(head.reports.flatMap((report) => report.modules.map((module) => module.file)))].sort();
  const descriptors = files.map((file) => {
    const current = headGraph.closure(file); const prior = before.has(file) ? baseGraph.closure(file) : null;
    return { schemaVersion: 1, role, module: file, roleMembership: sourceOnly ? 'unobserved-source-candidate' : 'observed-in-head-report', complete: false, decision: 'full-required',
      inputComparison: prior ? (prior.digest === current.digest ? 'observed-inputs-unchanged' : 'observed-inputs-changed') : 'unknown',
      headInputDigest: current.digest, baseInputDigest: prior?.digest ?? null,
      // Closure paths are reconstructible from the shared per-tree graph;
      // repeating every transitive list per test makes diagnostics enormous.
      reasons: [...new Set(['reviewed-complete-domain-unavailable', 'baseline-qualified-descriptor-unavailable', 'tool-environment-domain-unverified',
        ...current.unknown, ...globalReasons, ...(globalInputs.some((row) => !row.head) ? ['setup-or-configuration-input-unavailable'] : []),
        ...(base.sourceState === 'unavailable' ? ['base-source-unavailable'] : []), ...(sourceOnly ? ['head-role-and-case-inventory-unobserved'] : [])])].sort() };
  });
  const cases = head?.reports.flatMap((report) => report.modules.flatMap((module) => module.cases)) ?? null;
  const tools = { nodeVersion: process.version, typescriptVersion: ts.version, platform: process.platform, arch: process.arch, osRelease: release(),
    environment: Object.fromEntries(IMPACT_POLICY.environmentInputs.map((key) => [key, env[key] === undefined ? null : sha(env[key])])) };
  if (!sourceOnly) assert.deepEqual(readLane(laneDirectory, role, { ...initial, root }, env), head, 'lane changed during shadow analysis');
  assert.deepEqual(sourceBinding(root, revision), initial, 'source changed during shadow analysis');
  return { schema: 'phantom-ci-impact-shadow/v1', advisoryOnly: true, activationEnabled: false, policy: { ...IMPACT_POLICY, digest: digest(IMPACT_POLICY),
    sourceBlob: after.get('.github/scripts/ci-impact-policy.mjs')?.blob ?? null, analyzerBlob: after.get('.github/scripts/ci-impact-shadow.mjs')?.blob ?? null },
    source: { revision, tree: initial.tree, trackedDigest: digest(headRows) }, base, role, changes, changeDigest: changes ? digest(changes) : null,
    globalInputs, tools, toolDomainDigest: digest(tools), head: head ? { outcome: 'executed-at-head', ...head }
      : { outcome: 'unobserved', source: { revision, tree: initial.tree }, roleMembership: 'unobserved', reports: null, run: null },
    inputs: { head: [...headGraph.nodes.values()].sort((a, b) => a.path.localeCompare(b.path)), base: [...baseGraph.nodes.values()].sort((a, b) => a.path.localeCompare(b.path)) },
    descriptors, summary: { observedModules: sourceOnly ? null : files.length, sourceCandidateModules: sourceOnly ? files.length : null, fullRequiredModules: files.length, eligibleModules: 0,
      headCaseOccurrences: cases?.length ?? null, headPassedOccurrences: cases?.filter((row) => row.state === 'passed').length ?? null,
      headSkippedOccurrences: cases?.filter((row) => row.state === 'skipped').length ?? null, headTodoOccurrences: cases?.filter((row) => row.state === 'todo').length ?? null,
      baseCaseOccurrences: null, inheritedCases: 0 } };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: ci-impact-shadow.mjs ROLE LANE_DIRECTORY');
    const report = collectShadow({ root: process.cwd(), revision: process.env.ASHLR_CI_SOURCE_SHA, baseRevision: process.env.ASHLR_SHADOW_BASE_SHA || null,
      role: process.argv[2], laneDirectory: process.argv[3] });
    const directory = fs.realpathSync(fs.mkdtempSync(join(fs.realpathSync(process.env.RUNNER_TEMP), 'phantom-impact-shadow-'))); fs.chmodSync(directory, 0o700);
    fs.writeFileSync(join(directory, 'shadow.json'), JSON.stringify(report) + '\n', { mode: 0o600, flag: 'wx' });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `shadow_dir=${directory}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Advisory impact shadow: ${report.role}\n\n${report.summary.observedModules} observed whole modules; all require full execution. Baseline qualified descriptors unavailable; zero inherited cases. Full platform gates remain authoritative.\n`);
    console.log(`Advisory shadow: ${report.summary.observedModules} modules, 0 eligible; full-required`);
  } catch (error) { console.error(`Impact shadow unavailable; full qualification remains required: ${error.message}`); process.exitCode = 1; }
}
