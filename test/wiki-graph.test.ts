import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWikiGraph, graphFromFacts } from '../src/core/knowledge/wiki/graph.js';
import { extractImportReferences, extractFacts, MAX_IMPORT_CITATIONS, MAX_IMPORT_CITATIONS_PER_EDGE, type ModuleInfo } from '../src/core/knowledge/wiki/facts.js';
import { scanRepo } from '../src/core/knowledge/wiki/scan.js';

function module(key: string, patch: Partial<ModuleInfo> = {}): ModuleInfo {
  return { key, files: [`${key}/index.ts`], sourceFiles: 1, testFiles: 0, lines: 5, bytes: 100, topFiles: [`${key}/index.ts`], exports: [], importsFrom: {}, importedBy: {}, packages: [], entry: null, ...patch };
}

describe('wiki module graph', () => {
  it('derives directed inferred edges and bounded read coverage without source text', () => {
    const graph = graphFromFacts('key', {
      name: 'repo', head: null, fileCount: 6, truncated: true,
      modules: [module('src/api', { importsFrom: { 'src/store': 2, 'src/api': 1, missing: 3, bad: -1 } }), module('src/store')],
      lineIndex: { 'src/api/index.ts': 5, 'src/store/index.ts': 6 },
    }, '2026-09-29T00:00:00Z');
    expect(graph.edges).toEqual([{ from: 'src/api', to: 'src/store', imports: 2, confidence: 'inferred' }]);
    expect(graph.nodes[0]?.files).toEqual([{ file: 'src/api/index.ts', line: 1, lines: 5 }]);
    expect(graph.coverage).toEqual({ listedFiles: 6, readFiles: 2, unreadFiles: 4, omittedModuleFiles: 4, listingTruncated: true });
  });

  it('publishes citations only to read safe files and valid lines', () => {
    const graph = graphFromFacts('key', {
      name: 'repo', head: 'a'.repeat(40), fileCount: 3, truncated: false,
      modules: [module('src', { topFiles: ['.env', '../escape.ts', 'src/unread.ts', 'src/index.ts'], exports: [
        { name: 'ok', kind: 'function', file: 'src/index.ts', line: 2 },
        { name: 'outside', kind: 'function', file: 'src/index.ts', line: 99 },
        { name: 'secret', kind: 'const', file: '.env', line: 1 },
      ] })], lineIndex: { 'src/index.ts': 3, '.env': 1, '../escape.ts': 1 },
    });
    expect(graph.nodes[0]?.files).toEqual([{ file: 'src/index.ts', line: 1, lines: 3 }]);
    expect(graph.nodes[0]?.exports).toEqual([{ name: 'ok', kind: 'function', cite: { file: 'src/index.ts', line: 2 } }]);
  });

  it('checks edge evidence, adds non-top source files to editor metadata, and discloses failed citations', () => {
    const graph = graphFromFacts('key', {
      name: 'repo', head: null, fileCount: 3, truncated: false,
      modules: [module('app', { files: ['app/index.ts', 'app/other.ts'], importsFrom: { lib: 5, omitted: 2 }, importCitations: { lib: [
        { file: 'app/other.ts', line: 3 }, { file: '../escape.ts', line: 1 },
        { file: 'app/index.ts', line: 99 }, { file: 'lib/index.ts', line: 2 },
      ] } }), module('lib')],
      lineIndex: { 'app/index.ts': 4, 'app/other.ts': 5, 'lib/index.ts': 3, '../escape.ts': 1 },
      importEvidence: { unresolvedLocalImports: 2, unsupportedSourceFiles: 1 },
    });
    expect(graph.edges[0]).toEqual({ from: 'app', to: 'lib', imports: 5, confidence: 'inferred', citations: [{ file: 'app/other.ts', line: 3 }], omittedCitations: 1, droppedCitations: 3 });
    expect(graph.nodes[0]?.files).toContainEqual({ file: 'app/other.ts', line: 1, lines: 5 });
    expect(graph.coverage.importEvidence).toEqual({ unresolvedLocalImports: 2, unsupportedSourceFiles: 1, checkedCitations: 1, droppedCitations: 3, omittedCitations: 1, omittedModuleImports: 2 });
    expect(JSON.stringify(graph)).not.toContain('../escape');
  });

  it('bounds per-edge and total citation samples without truncating dependency counts', () => {
    const modules = Array.from({ length: 24 }, (_, i) => module(`m${i}`));
    for (const m of modules) {
      m.importsFrom = Object.fromEntries(modules.filter((n) => n.key !== m.key).map((n) => [n.key, 8]));
      m.importCitations = Object.fromEntries(Object.keys(m.importsFrom).map((key) => [key, Array.from({ length: 8 }, (_, i) => ({ file: m.files[0]!, line: i + 1 }))]));
    }
    const graph = graphFromFacts('key', { name: 'repo', head: null, fileCount: 24, truncated: false, modules, lineIndex: Object.fromEntries(modules.map((m) => [m.files[0]!, 10])), importEvidence: { unresolvedLocalImports: 0, unsupportedSourceFiles: 0 } });
    expect(graph.edges).toHaveLength(24 * 23);
    expect(graph.edges.every((e) => e.imports === 8 && e.citations!.length <= MAX_IMPORT_CITATIONS_PER_EDGE)).toBe(true);
    expect(graph.edges.reduce((n, e) => n + e.citations!.length, 0)).toBe(MAX_IMPORT_CITATIONS);
    expect(graph.coverage.importEvidence?.omittedCitations).toBe(24 * 23 * 8 - MAX_IMPORT_CITATIONS);
  });

  it('extracts exact first statement lines, retaining existing per-file specifier deduplication', () => {
    const text = '// heading\nimport type {\n  T\n} from "../lib/types.js";\nexport { T } from "../lib/types.js";\nconst x = require("../lib/value");\nimport("../lib/lazy");';
    expect(extractImportReferences(text, 'app/index.ts')).toEqual([
      { specifier: '../lib/types.js', line: 2 }, { specifier: '../lib/value', line: 6 }, { specifier: '../lib/lazy', line: 7 },
    ]);
    expect(extractImportReferences('\n\n use crate::store;', 'src/lib.rs')).toEqual([{ specifier: 'crate::store', line: 3 }]);
  });

  it('keeps unresolved/excluded references visible as partial counts while excluding symlink targets and source text', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wiki-import-evidence-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'wiki-import-outside-'));
    try {
      mkdirSync(path.join(dir, 'app')); mkdirSync(path.join(dir, 'lib'));
      writeFileSync(path.join(dir, 'app', 'index.ts'), 'import { value } from "../lib/index.js";\nimport "../missing";\nimport "../../escape";\nimport "../lib/link";\nimport "react";\n');
      writeFileSync(path.join(dir, 'lib', 'index.ts'), 'export const value = 42;\n');
      writeFileSync(path.join(dir, 'lib', 'other.py'), 'from .missing import value\n');
      writeFileSync(path.join(outside, 'private.ts'), 'PRIVATE_OUTSIDE_SOURCE');
      symlinkSync(path.join(outside, 'private.ts'), path.join(dir, 'lib', 'link.ts'));
      const facts = await extractFacts(await scanRepo(dir));
      expect(facts.importEvidence).toEqual({ unresolvedLocalImports: 4, unsupportedSourceFiles: 1 });
      const graph = await buildWikiGraph(dir);
      expect(graph.edges).toContainEqual({ from: 'app', to: 'lib', imports: 1, confidence: 'inferred', citations: [{ file: 'app/index.ts', line: 1 }], omittedCitations: 0, droppedCitations: 0 });
      expect(graph.coverage.importEvidence?.unresolvedLocalImports).toBe(4);
      expect(JSON.stringify(graph)).not.toContain('PRIVATE_OUTSIDE_SOURCE');
      expect(JSON.stringify(graph)).not.toContain('import {');
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it('does not convert unavailable legacy evidence or failed listings into zero unresolved imports', async () => {
    const graph = graphFromFacts('key', { name: 'repo', head: null, fileCount: 1, truncated: false, modules: [module('app')], lineIndex: { 'app/index.ts': 1 } });
    expect(graph.coverage.importEvidence).toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), 'wiki-missing-imports-'));
    try {
      const unavailable = await buildWikiGraph(path.join(dir, 'missing'));
      expect(unavailable.coverage.listingIncomplete).toBe(true);
      expect(unavailable.coverage.importEvidence).toBeUndefined();
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
