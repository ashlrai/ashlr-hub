#!/usr/bin/env node
// Offline advice only: this command neither executes tests nor selects coverage.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectShadow } from '../.github/scripts/ci-impact-shadow.mjs';
import { IMPACT_POLICY, fullChangeReason } from '../.github/scripts/ci-impact-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const WHOLE_TEST = /\.test\.(?:[cm]?[jt]sx?)$/;
const usage = 'Usage: node scripts/test-smoke-preview.mjs --root ROOT --base FULL_SHA --head FULL_SHA --changed [REPO_PATH ...]';
const sorted = (items) => [...new Set(items)].sort();

function changedPath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
    ![...path].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127) &&
    !path.startsWith('/') && path.split('/').every((part) => part && part !== '.' && part !== '..'), 'expected a repository-relative changed path');
  return path;
}

export function parseArguments(args) {
  assert.equal(args[0], '--root', usage); assert.equal(args[2], '--base', usage);
  assert.equal(args[4], '--head', usage); assert.equal(args[6], '--changed', usage);
  assert.ok(args[1] && args[3] && args[5], usage);
  return { root: args[1], baseRevision: args[3], revision: args[5], changedPaths: args.slice(7) };
}

// Walk each immutable graph separately: combining edges first could invent a
// path that never existed in either revision. A removed edge still matters.
function reverseWitnesses(nodes, changed, candidates, side) {
  const reverse = new Map();
  for (const node of nodes) for (const edge of node.imports) if (edge.target) {
    if (!reverse.has(edge.target)) reverse.set(edge.target, new Set());
    reverse.get(edge.target).add(node.path);
  }
  const witnesses = new Map();
  for (const path of changed) {
    const queue = [[path]]; const visited = new Set([path]);
    for (let i = 0; i < queue.length; i++) {
      const chain = queue[i]; const at = chain[chain.length - 1];
      if (chain.length > 1 && candidates.has(at)) {
        if (!witnesses.has(at)) witnesses.set(at, []);
        witnesses.get(at).push({ changedPath: path, side, importChain: [...chain].reverse() });
      }
      for (const importer of sorted(reverse.get(at) ?? [])) if (!visited.has(importer)) {
        visited.add(importer); queue.push([...chain, importer]);
      }
    }
  }
  return witnesses;
}

function unknownDomains(nodes) {
  const counts = new Map();
  for (const node of nodes) for (const reason of node.unknown) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return counts;
}

export function previewSmoke({ root, baseRevision, revision, changedPaths }) {
  assert.match(baseRevision, SHA, 'base must be an immutable full Git SHA');
  assert.match(revision, SHA, 'head must be an immutable full Git SHA');
  assert.ok(Array.isArray(changedPaths), 'explicit changed paths required');
  changedPaths.forEach(changedPath);
  assert.equal(new Set(changedPaths).size, changedPaths.length, 'duplicate changed paths refused');
  // Existing sourceOnly mode reads Git blobs, not candidate modules or reports.
  const core = collectShadow({ root, baseRevision, revision, role: 'mac-general-1', sourceOnly: true });
  assert.equal(core.base.sourceState, 'observed', 'base is unavailable or not a local ancestor; no smoke scope can be established');
  assert.deepEqual([...changedPaths].sort(), core.changes.map((row) => row.path), 'changed paths differ from the complete immutable base/head diff');
  const web = collectShadow({ root, baseRevision, revision, role: 'web', sourceOnly: true });
  assert.deepEqual(web.source, core.source, 'source changed between graph observations');
  assert.deepEqual(web.base, core.base, 'base changed between graph observations');
  assert.deepEqual(web.changes, core.changes, 'changes differ between graph observations');
  const merged = (side) => {
    const byPath = new Map();
    for (const node of [...core.inputs[side], ...web.inputs[side]]) {
      if (byPath.has(node.path)) assert.deepEqual(node, byPath.get(node.path), 'graph identity differs');
      byPath.set(node.path, node);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  const headNodes = merged('head'); const baseNodes = merged('base');
  const headIndex = new Map(headNodes.map((node) => [node.path, node]));
  const regular = (mode) => mode === '100644' || mode === '100755';
  const candidates = new Set([...core.descriptors, ...web.descriptors]
    .filter((row) => regular(headIndex.get(row.module)?.mode)).map((row) => row.module));
  const observedChanges = core.changes.map((row) => row.path);
  const baseWitnesses = reverseWitnesses(baseNodes, observedChanges, candidates, 'base');
  const headWitnesses = reverseWitnesses(headNodes, observedChanges, candidates, 'head');
  const direct = core.changes.filter((row) => row.head && regular(row.head.mode) && WHOLE_TEST.test(row.path)).map((row) => row.path);
  const modules = sorted([...direct, ...baseWitnesses.keys(), ...headWitnesses.keys()]).map((module) => ({
    module, runScope: 'whole-module', directlyChanged: direct.includes(module),
    suggestionBasis: candidates.has(module) ? 'core-or-web-source-imports' : 'direct-change-only',
    membership: 'unobserved', cases: null, result: 'unobserved',
    witnesses: [...(baseWitnesses.get(module) ?? []), ...(headWitnesses.get(module) ?? [])],
  }));
  const knownHead = unknownDomains(headNodes); const knownBase = unknownDomains(baseNodes);
  const unresolved = sorted([...knownHead.keys(), ...knownBase.keys()]).map((reason) => ({
    reason, headSourceNodes: knownHead.get(reason) ?? 0, baseSourceNodes: knownBase.get(reason) ?? 0,
  }));
  const warnings = [];
  const missingGlobalInputs = {
    head: core.globalInputs.filter((row) => !row.head).map((row) => row.path),
    base: core.globalInputs.filter((row) => !row.base).map((row) => row.path),
  };
  if (missingGlobalInputs.head.length || missingGlobalInputs.base.length) {
    warnings.push({ code: 'global-inputs-unavailable', missing: missingGlobalInputs });
  }
  const global = core.changes.flatMap(({ path }) => {
    const reason = fullChangeReason(path);
    return reason || IMPACT_POLICY.globalInputs.includes(path) ? [{ path, reason: reason ?? 'global-configuration-input-change' }] : [];
  });
  if (global.length) warnings.push({ code: 'full-qualification-domain-changed', changes: global });
  if (unresolved.length) warnings.push({ code: 'unresolved-source-inputs', domains: unresolved });
  const matched = new Set([...direct, ...modules.flatMap((row) => row.witnesses.map((witness) => witness.changedPath))]);
  const unmatched = observedChanges.filter((path) => !matched.has(path));
  if (unmatched.length) warnings.push({ code: 'changed-paths-without-resolved-test-suggestion', paths: unmatched });
  const deleted = core.changes.filter((row) => !row.head && WHOLE_TEST.test(row.path)).map((row) => row.path);
  if (deleted.length) warnings.push({ code: 'deleted-tests-are-not-runnable-suggestions', paths: deleted });
  const nonregular = core.changes.filter((row) => row.head && !regular(row.head.mode) && WHOLE_TEST.test(row.path)).map((row) => row.path);
  if (nonregular.length) warnings.push({ code: 'changed-tests-are-not-regular-modules', paths: nonregular });
  const fanout = observedChanges.flatMap((path) => {
    const count = modules.filter((row) => row.witnesses.some((witness) => witness.changedPath === path)).length;
    return count > 1 ? [{ path, suggestedWholeModules: count }] : [];
  });
  if (fanout.length) warnings.push({ code: 'multiple-test-importers', changes: fanout });
  return {
    schema: 'phantom-local-smoke-preview/v1', advisoryOnly: true, activationEnabled: false,
    source: core.source, base: { revision: core.base.revision, tree: core.base.tree },
    changes: core.changes, changeDigest: core.changeDigest,
    analysis: { source: 'ci-impact-shadow/sourceOnly', policyDigest: core.policy.digest,
      headRepositoryAnalyzerBlob: core.policy.analyzerBlob, headRepositoryPolicyBlob: core.policy.sourceBlob,
      nodeVersion: core.tools.nodeVersion, typescriptVersion: core.tools.typescriptVersion,
      reverseImportScope: ['test/**/*.test.ts', 'src/web-ui/**/*.test.ts', 'src/web-ui/**/*.test.tsx'],
      otherTestScope: 'direct-change-only', inventory: 'source-candidates-not-collected-tests' },
    suggestedWholeModules: modules, warnings,
    qualification: { fullExecutionRequired: true, fullCoverage: 'unobserved', executedCases: null,
      inheritedCases: 0, note: 'Smoke suggestions do not replace full qualification. Empty suggestions do not establish an unaffected change.' },
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(previewSmoke(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`Smoke preview unavailable; full qualification remains required: ${error.message}`); process.exitCode = 1; }
}
