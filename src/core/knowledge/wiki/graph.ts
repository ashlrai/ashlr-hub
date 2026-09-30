/** Local module map over the wiki's existing bounded scanner. No model calls. */
import { extractFacts, type RepoFacts } from './facts.js';
import { scanRepo, isWikiReadable } from './scan.js';
import { readWikiSteering } from './steering.js';
import { wikiKey } from './store.js';
import type { WikiGraphView } from './types.js';

export function graphFromFacts(repoKey: string, facts: Pick<RepoFacts, 'name' | 'head' | 'fileCount' | 'truncated' | 'modules' | 'lineIndex'>, generatedAt = new Date().toISOString()): WikiGraphView {
  const ids = new Set(facts.modules.map((m) => m.key));
  const nodes = facts.modules.map((m) => {
    const files = [...new Set([...m.topFiles, ...m.exports.map((e) => e.file)])]
      .filter((file) => isWikiReadable(file) && (facts.lineIndex[file] ?? 0) > 0)
      .map((file) => ({ file, line: 1, lines: facts.lineIndex[file]! }));
    const known = new Set(files.map((f) => f.file));
    return {
      id: m.key, sourceFiles: m.sourceFiles, testFiles: m.testFiles, bytes: m.bytes, files,
      exports: m.exports.filter((e) => known.has(e.file) && e.line > 0 && e.line <= facts.lineIndex[e.file]!)
        .map((e) => ({ name: e.name, kind: e.kind, cite: { file: e.file, line: e.line } })),
    };
  });
  const edges = facts.modules.flatMap((m) => Object.entries(m.importsFrom)
    .filter(([to, imports]) => ids.has(to) && to !== m.key && Number.isInteger(imports) && imports > 0)
    .map(([to, imports]) => ({ from: m.key, to, imports, confidence: 'inferred' as const })));
  const readFiles = Object.keys(facts.lineIndex).length;
  return {
    repoKey, repoName: facts.name, commit: facts.head, generatedAt, nodes, edges,
    coverage: {
      listedFiles: facts.fileCount, readFiles, unreadFiles: Math.max(0, facts.fileCount - readFiles),
      omittedModuleFiles: Math.max(0, facts.fileCount - facts.modules.reduce((n, m) => n + m.files.length, 0)),
      listingTruncated: facts.truncated,
    },
  };
}

// Coalesce simultaneous UI reads. Retain only public metadata, never source text.
const inFlight = new Map<string, Promise<WikiGraphView>>();
const cache = new Map<string, { at: number; policy: string; graph: WikiGraphView }>();
const CACHE_MS = 15_000;
const CACHE_SIZE = 8;

export async function buildWikiGraph(repo: string): Promise<WikiGraphView> {
  const steering = await readWikiSteering(repo);
  const policy = JSON.stringify(steering.ignorePaths);
  const key = `${repo}\0${policy}`;
  const cached = cache.get(repo);
  if (cached && cached.policy === policy && Date.now() - cached.at < CACHE_MS) return cached.graph;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const scan = await scanRepo(repo, steering.ignorePaths);
    const graph = graphFromFacts(wikiKey(repo), await extractFacts(scan));
    if (scan.listingIncomplete) graph.coverage.listingIncomplete = true;
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(repo, { at: Date.now(), policy, graph });
    return graph;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}
