/** Local module map over the wiki's existing bounded scanner. No model calls. */
import { extractFacts, MAX_IMPORT_CITATIONS, MAX_IMPORT_CITATIONS_PER_EDGE, type RepoFacts } from './facts.js';
import { checkedCitation } from './citations.js';
import { scanRepo, isWikiReadable } from './scan.js';
import { readWikiSteering } from './steering.js';
import { wikiKey } from './store.js';
import type { WikiGraphEdge, WikiGraphView } from './types.js';

export function graphFromFacts(repoKey: string, facts: Pick<RepoFacts, 'name' | 'head' | 'fileCount' | 'truncated' | 'modules' | 'lineIndex' | 'importEvidence'>, generatedAt = new Date().toISOString()): WikiGraphView {
  const ids = new Set(facts.modules.map((m) => m.key));
  let checkedCitations = 0; let droppedCitations = 0; let omittedCitations = 0; let omittedModuleImports = 0;
  const edges: WikiGraphEdge[] = [];
  for (const m of facts.modules) {
    for (const [to, imports] of Object.entries(m.importsFrom)) {
      if (!Number.isInteger(imports) || imports < 1 || to === m.key) continue;
      if (!ids.has(to)) { omittedModuleImports += imports; continue; }
      const edge: WikiGraphEdge = { from: m.key, to, imports, confidence: 'inferred' };
      if (m.importCitations !== undefined) {
        const citations = [];
        let dropped = 0;
        const seen = new Set<string>();
        // Defend the response bounds too, including manually supplied/older facts.
        for (const candidate of (m.importCitations[to] ?? []).slice(0, MAX_IMPORT_CITATIONS_PER_EDGE)) {
          if (checkedCitations >= MAX_IMPORT_CITATIONS) break;
          const cite = isWikiReadable(candidate.file) && m.files.includes(candidate.file)
            ? checkedCitation(candidate, facts.lineIndex[candidate.file] ?? null) : null;
          if (!cite) { dropped++; continue; }
          const key = `${cite.file}:${cite.line}`;
          if (seen.has(key)) continue;
          seen.add(key); citations.push(cite); checkedCitations++;
        }
        const omitted = Math.max(0, imports - citations.length - dropped);
        Object.assign(edge, { citations, omittedCitations: omitted, droppedCitations: dropped });
        droppedCitations += dropped; omittedCitations += omitted;
      }
      edges.push(edge);
    }
  }
  const nodes = facts.modules.map((m) => {
    // Import evidence may come from a source beyond the top-file sample. Keep
    // its read-index metadata so the existing editor-open gate can check it.
    const files = [...new Set([...m.topFiles, ...m.exports.map((e) => e.file), ...edges.filter((e) => e.from === m.key).flatMap((e) => e.citations?.map((c) => c.file) ?? [])])]
      .filter((file) => isWikiReadable(file) && checkedCitation({ file, line: 1 }, facts.lineIndex[file] ?? null))
      .map((file) => ({ file, line: 1, lines: facts.lineIndex[file]! }));
    const known = new Set(files.map((f) => f.file));
    return {
      id: m.key, sourceFiles: m.sourceFiles, testFiles: m.testFiles, bytes: m.bytes, files,
      exports: m.exports.filter((e) => known.has(e.file) && e.line > 0 && e.line <= facts.lineIndex[e.file]!)
        .map((e) => ({ name: e.name, kind: e.kind, cite: { file: e.file, line: e.line } })),
    };
  });
  const readFiles = Object.keys(facts.lineIndex).length;
  return {
    repoKey, repoName: facts.name, commit: facts.head, generatedAt, nodes, edges,
    coverage: {
      listedFiles: facts.fileCount, readFiles, unreadFiles: Math.max(0, facts.fileCount - readFiles),
      omittedModuleFiles: Math.max(0, facts.fileCount - facts.modules.reduce((n, m) => n + m.files.length, 0)),
      listingTruncated: facts.truncated,
      ...(facts.importEvidence ? { importEvidence: { ...facts.importEvidence, checkedCitations, droppedCitations, omittedCitations, omittedModuleImports } } : {}),
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
    if (scan.listingIncomplete) {
      graph.coverage.listingIncomplete = true;
      if (graph.coverage.readFiles === 0) delete graph.coverage.importEvidence;
    }
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(repo, { at: Date.now(), policy, graph });
    return graph;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}
