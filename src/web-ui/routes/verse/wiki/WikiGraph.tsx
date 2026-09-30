import { useMemo, useState } from 'react';
import type { WikiCitation, WikiGraphEdge, WikiGraphView } from '../../../../core/knowledge/wiki/types.js';
import { citationLabel } from '../../../../core/knowledge/wiki/citations.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError } from '../context/use-token-gate.js';
import { wikiGraphQuery } from './wiki-queries.js';
import styles from './WikiGraph.module.css';

export function WikiGraph({ repoKey, onCite }: { repoKey: string; onCite: (cite: WikiCitation, commit: string | null) => void }) {
  const def = useMemo(() => wikiGraphQuery(repoKey), [repoKey]);
  const q = useQuery(def, { freshMs: 15_000 });
  const refetch = useRefetch(def);
  if (!q.data && !q.error) return <p role="status">Mapping local modules…</p>;
  if (q.error || !q.data) return <div role="alert"><p>{q.error ? describeContextError(q.error) : 'The module map could not be read.'}</p><button type="button" onClick={refetch}>Retry map</button></div>;
  return <WikiGraphCanvas graph={q.data} onCite={onCite} onRefresh={refetch} />;
}

/** A navigable overview plus an explicit list of dependencies for keyboard users. */
export function WikiGraphCanvas({ graph, onCite, onRefresh }: {
  graph: WikiGraphView;
  onCite: (cite: WikiCitation, commit: string | null) => void;
  onRefresh?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const nodes = graph.nodes.filter((n) => `${n.id} ${n.files.map((f) => f.file).join(' ')} ${n.exports.map((e) => e.name).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = nodes.find((n) => n.id === chosen) ?? nodes[0] ?? null;
  const positions = new Map(nodes.map((n, index) => [n.id, { x: 120 + (index % 3) * 240, y: 60 + Math.floor(index / 3) * 110 }]));
  const height = Math.max(130, Math.ceil(nodes.length / 3) * 110 + 20);
  const outgoing = graph.edges.filter((e) => e.from === selected?.id);
  const incoming = graph.edges.filter((e) => e.to === selected?.id);
  const related = new Set([...outgoing.map((e) => e.to), ...incoming.map((e) => e.from)]);
  const selectRelated = (id: string) => { setSearch(''); setChosen(id); };
  const evidence = graph.coverage.importEvidence;
  const incomplete = graph.coverage.listingIncomplete || graph.coverage.listingTruncated || graph.coverage.unreadFiles > 0 || graph.coverage.omittedModuleFiles > 0
    || (evidence ? evidence.unresolvedLocalImports > 0 || evidence.unsupportedSourceFiles > 0 || evidence.droppedCitations > 0 || evidence.omittedCitations > 0 || evidence.omittedModuleImports > 0 : graph.edges.length > 0);
  const dependency = (edge: WikiGraphEdge, id: string) => <li key={id} className={styles.edge}>
    <div className={styles.edgeHeading}><button type="button" onClick={() => selectRelated(id)}>{id}</button><span>{edge.imports} imports · inferred</span></div>
    <div className={styles.evidence}>
      {edge.citations?.length ? edge.citations.map((cite) => <button type="button" key={`${cite.file}:${cite.line}`} aria-label={`Open import ${citationLabel(cite)}`} onClick={() => onCite(cite, graph.commit)}>{citationLabel(cite)}</button>) : <span>{edge.citations === undefined ? 'Import line evidence unavailable; refresh the map.' : 'No checked import lines in this sample.'}</span>}
      {edge.omittedCitations ? <span>{edge.omittedCitations} additional import references are outside the citation sample.</span> : null}
      {edge.droppedCitations ? <span>{edge.droppedCitations} import citations failed the file or line check.</span> : null}
    </div>
  </li>;
  return (
    <section className={styles.root} aria-label="Codebase module map">
      <div className={styles.toolbar}>
        <label>Find a module<input type="search" aria-label="Find a module" placeholder="Module, file or symbol…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <span>{nodes.length} of {graph.nodes.length} modules</span>
        {onRefresh ? <button type="button" onClick={onRefresh}>Refresh map</button> : null}
      </div>
      <p className={styles.caption}>Select a module to trace what it uses and what depends on it. This map is built locally without a model.</p>
      {evidence?.unresolvedLocalImports ? <p className={styles.caption} role="status">{evidence.unresolvedLocalImports} detected local import references could not be resolved in the listed files. Some dependencies may be missing.</p> : null}
      {nodes.length === 0 ? <p role="status">{graph.nodes.length ? 'No matching modules. Try a file name or clear the search.' : graph.coverage.listingIncomplete ? 'The repo listing could not be completed. Check local access and refresh the map.' : 'No readable modules were found in this repo.'}</p> : (
        <div className={styles.layout}>
          <div className={styles.viewport} tabIndex={0} aria-label="Scrollable dependency map">
            <div className={styles.canvas} style={{ height }}>
              <svg width="720" height={height} aria-hidden="true">
                {[...outgoing, ...incoming].map((edge) => {
                  const from = positions.get(edge.from); const to = positions.get(edge.to);
                  return from && to ? <path key={`${edge.from}:${edge.to}`} d={`M${from.x},${from.y} C${from.x},${from.y + 55} ${to.x},${to.y - 55} ${to.x},${to.y}`} /> : null;
                })}
              </svg>
              {nodes.map((node) => {
                const point = positions.get(node.id)!;
                return <button type="button" key={node.id} className={styles.node} style={{ left: point.x, top: point.y }} aria-pressed={selected?.id === node.id} data-related={related.has(node.id) || undefined} onClick={() => setChosen(node.id)}>
                  <span>{node.id}</span><small>{node.sourceFiles} source files{node.testFiles ? `, ${node.testFiles} tests` : ''}</small>
                </button>;
              })}
            </div>
          </div>
          {selected ? <aside className={styles.detail} aria-label="Selected module">
            <h3>{selected.id}</h3>
            <p>{selected.sourceFiles} source files and {selected.testFiles} tests</p>
            <h4>Uses</h4>
            {outgoing.length ? <ul>{outgoing.map((e) => dependency(e, e.to))}</ul> : <p>No cross-module imports found in the files read.</p>}
            <h4>Used by</h4>
            {incoming.length ? <ul>{incoming.map((e) => dependency(e, e.from))}</ul> : <p>No incoming imports found in the files read.</p>}
            <h4>Start reading</h4>
            {selected.files.length ? <ul>{selected.files.map((f) => <li key={f.file}><button type="button" onClick={() => onCite({ file: f.file, line: 1 }, graph.commit)}>{f.file}:1</button></li>)}</ul> : <p>No source files from this module were read.</p>}
            {selected.exports.length ? <><h4>Exports</h4><ul>{selected.exports.map((e) => <li key={`${e.cite.file}:${e.cite.line}:${e.name}`}><button type="button" onClick={() => onCite(e.cite, graph.commit)}>{e.name}</button><span>{e.kind}</span></li>)}</ul></> : null}
          </aside> : null}
        </div>
      )}
      <details className={styles.coverage}>
        <summary>{incomplete ? 'Partial coverage' : 'Coverage and evidence'}: {graph.coverage.readFiles} of {graph.coverage.listedFiles} listed files read</summary>
        <p>File names are extracted from the repo listing. Module groups and dependency links are inferred from directory structure and resolved import statements using pattern matching; they are not a complete runtime call graph.</p>
        <p>{graph.coverage.unreadFiles} listed files were not read; {graph.coverage.omittedModuleFiles} listed files are outside the displayed modules.{graph.coverage.listingTruncated ? ' The file listing reached its scan limit.' : ''}{graph.coverage.listingIncomplete ? ' Some directories could not be listed or reached the depth limit; this is not complete coverage.' : ''} Secrets, ignored paths, symlinks, binaries and generated dependencies are excluded.</p>
        {evidence ? <p>Detected local imports in read sources: {evidence.unresolvedLocalImports} unresolved. {evidence.unsupportedSourceFiles} read source files use languages without supported local import resolution. {evidence.checkedCitations} source-line citations passed the file and line checks; {evidence.droppedCitations} failed and were removed; {evidence.omittedCitations} additional references are outside the citation sample; {evidence.omittedModuleImports} resolved imports point outside the displayed modules. Citation samples retain at most four lines per dependency and 512 lines in total. Pattern matches can include comments or strings and do not prove runtime dependency behavior.</p> : <p>Import-resolution and source-line evidence is unavailable in this sample. Missing evidence does not mean zero unresolved imports. Refresh the map to check the read sources.</p>}
        <p>Sampled {new Date(graph.generatedAt).toLocaleString()}. Current working files, listed against {graph.commit ? graph.commit.slice(0, 8) : 'a local directory scan'}. Refreshes may reuse a sample for up to 15 seconds.</p>
      </details>
    </section>
  );
}
