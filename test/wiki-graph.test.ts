import { describe, expect, it } from 'vitest';
import { graphFromFacts } from '../src/core/knowledge/wiki/graph.js';
import type { ModuleInfo } from '../src/core/knowledge/wiki/facts.js';

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
});
