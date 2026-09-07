import { useId, useMemo, useState } from 'react';
import type { UniverseGraph as GraphReport, UniverseGraphNode, UniverseGraphEdge } from '../../../core/universe/graph-types.js';
import { traverseUniverseGraph } from '../../../core/universe/graph-query.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { universeGraphQuery } from '../../data/queries.js';
import styles from './UniverseGraph.module.css';

const DISPLAY_LIMIT = 60;
const DISPLAY_EDGE_LIMIT = 240;
type InspectTrial = (runId: string, trialId: string) => boolean;
const KIND_LABELS: Record<UniverseGraphNode['kind'], string> = {
  universe: 'Universe', seed: 'Seed', comparator: 'Evaluator', campaign: 'Campaign',
  reservation: 'Reservation', run: 'Run', trial: 'Trial', artifact: 'Artifact', delivery: 'Delivery',
};
const EDGE_LABELS: Record<UniverseGraphEdge['kind'], string> = {
  contains: 'Contains', 'seed-parent': 'Seed parent', parent: 'Candidate parent', feedback: 'Evaluator feedback',
  evaluates: 'Evaluates', produced: 'Produced artifact', reserved: 'Reserved work',
  'executed-as': 'Executed as', 'delivered-as': 'Delivered as',
};
const evidenceLabel = (node: UniverseGraphNode): string => node.evidence === 'verified-local-delivery'
  ? 'Local delivery checked' : node.evidence === 'recorded' ? 'Recorded evidence'
    : node.evidence === 'pending' ? 'Pending evidence' : 'Evidence unavailable';
const short = (value: string, length: number): string => value.length > length ? `${value.slice(0, length - 1)}…` : value;

/** Bounded, deterministic columns; the full text node list remains usable without the SVG. */
function GraphDiagram({ nodes, edges, selectedId, select }: {
  nodes: UniverseGraphNode[]; edges: UniverseGraphEdge[]; selectedId?: string;
  select: (id: string) => void;
}) {
  const marker = `universe-arrow-${useId().replaceAll(':', '')}`;
  const columns = [...new Set(nodes.map((node) => node.generation ?? 0))].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  let rows = 1;
  columns.forEach((generation, column) => {
    const members = nodes.filter((node) => (node.generation ?? 0) === generation);
    rows = Math.max(rows, members.length);
    members.forEach((node, row) => positions.set(node.id, { x: 24 + column * 225, y: 32 + row * 76 }));
  });
  return (
    <div className={styles.diagram}>
      <svg width={Math.max(260, columns.length * 225 + 24)} height={rows * 76 + 40} role="group" aria-label="Evidence relationship diagram">
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" className={styles.arrow} /></marker></defs>
        {columns.map((generation, column) => <text key={generation} x={24 + column * 225} y={18} className={styles.columnLabel}>{generation === 0 ? 'Experiment context' : `Generation ${generation}`}</text>)}
        {edges.map((edge) => {
          const from = positions.get(edge.from); const to = positions.get(edge.to);
          if (!from || !to) return null;
          const sameColumn = from.x === to.x;
          const startX = from.x + 180; const endX = sameColumn ? to.x + 180 : to.x;
          const mid = sameColumn ? startX + 28 : (startX + endX) / 2;
          return <path key={edge.id} d={`M ${startX} ${from.y + 27} C ${mid} ${from.y + 27}, ${mid} ${to.y + 27}, ${endX} ${to.y + 27}`} fill="none" markerEnd={`url(#${marker})`} className={`${styles.edge} ${edge.kind === 'feedback' ? styles.feedback : ''}`}><title>{EDGE_LABELS[edge.kind]}</title></path>;
        })}
        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          return <g key={node.id} transform={`translate(${position.x},${position.y})`} role="button" tabIndex={0} aria-label={`Select ${KIND_LABELS[node.kind].toLowerCase()}: ${node.label}`} aria-pressed={node.id === selectedId}
            onClick={() => select(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); } }}>
            <title>{`${node.label}: ${node.state}. ${evidenceLabel(node)}`}</title>
            <rect width="180" height="54" rx="5" className={node.id === selectedId ? styles.selectedBox : styles.nodeBox} />
            <text x="10" y="20" className={styles.nodeLabel}>{short(node.label, 24)}</text>
            <text x="10" y="39" className={styles.nodeKind}>{KIND_LABELS[node.kind]} · {short(node.state, 18)}</text>
          </g>;
        })}
      </svg>
    </div>
  );
}

function NodeInspector({ node, graph, byId, select, onInspectTrial }: {
  node: UniverseGraphNode; graph: GraphReport; byId: Map<string, UniverseGraphNode>;
  select: (id: string) => void; onInspectTrial: InspectTrial;
}) {
  const [unavailableTrial, setUnavailableTrial] = useState<string | null>(null);
  const relationships = graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  return <section className={styles.inspector} aria-label="Selected graph evidence">
    <h3>{node.label}</h3>
    <dl className={styles.properties}>
      <div><dt>Entity</dt><dd>{KIND_LABELS[node.kind]}</dd></div>
      <div><dt>State</dt><dd>{node.state}</dd></div>
      <div><dt>Evidence</dt><dd>{evidenceLabel(node)}</dd></div>
      {node.generation !== undefined ? <div><dt>Generation</dt><dd>{node.generation}</dd></div> : null}
      {node.niche ? <div><dt>Niche</dt><dd>{node.niche}</dd></div> : null}
      {node.score !== undefined ? <div><dt>Evaluator score</dt><dd>{node.score === null ? 'Unavailable' : node.score}</dd></div> : null}
      {node.currentElite ? <div><dt>Archive</dt><dd>Current local elite</dd></div> : null}
      {node.admitted && !node.currentElite ? <div><dt>Archive</dt><dd>Historical admission; not the current elite</dd></div> : null}
    </dl>
    <p className={styles.note}>The graph observes saved evidence. It does not rerun evaluation or establish accepted production value.</p>
    {node.runId && node.trialId ? <button type="button" className={styles.link} onClick={() => setUnavailableTrial(onInspectTrial(node.runId!, node.trialId!) ? null : node.id)}>Inspect exact trial evidence</button> : null}
    {unavailableTrial === node.id ? <p className={styles.notice} role="status">This exact trial is not present in the current overview. Refresh Universe before inspecting it; no other trial was selected.</p> : null}
    <h4>Direct relationships</h4>
    {relationships.length ? <ul className={styles.relations}>{relationships.slice(0, DISPLAY_LIMIT).map((edge) => {
      const incoming = edge.to === node.id;
      const other = byId.get(incoming ? edge.from : edge.to);
      return <li key={edge.id}>{EDGE_LABELS[edge.kind]} {incoming ? 'from' : 'to'}{' '}{other
        ? <button type="button" className={styles.link} onClick={() => select(other.id)}>{other.label}</button>
        : <span>unavailable source</span>}</li>;
    })}</ul> : <p className={styles.note}>No direct relationships in this observation.</p>}
    {relationships.length > DISPLAY_LIMIT ? <p className={styles.note}>{relationships.length - DISPLAY_LIMIT} additional relationships omitted from this panel. Inspect the CLI graph for the full observation.</p> : null}
    <details className={styles.exact}><summary>Record identity</summary>
      <dl className={styles.properties}>
        <div><dt>Graph node</dt><dd><code>{node.id}</code></dd></div>
        {node.runId ? <div><dt>Run</dt><dd><code>{node.runId}</code></dd></div> : null}
        {node.trialId ? <div><dt>Trial</dt><dd><code>{node.trialId}</code></dd></div> : null}
        {node.variantId ? <div><dt>Variant</dt><dd><code>{node.variantId}</code></dd></div> : null}
        {node.campaignId ? <div><dt>Campaign</dt><dd><code>{node.campaignId}</code></dd></div> : null}
        {node.branch ? <div><dt>Local branch</dt><dd><code>{node.branch}</code></dd></div> : null}
        {node.commit ? <div><dt>Commit</dt><dd><code>{node.commit}</code></dd></div> : null}
        {node.manifestDigest ? <div><dt>Manifest digest</dt><dd><code>{node.manifestDigest === '[REDACTED]' ? 'Hidden by the console privacy filter' : node.manifestDigest}</code></dd></div> : null}
        {node.comparatorDigest ? <div><dt>Comparator digest</dt><dd><code>{node.comparatorDigest === '[REDACTED]' ? 'Hidden by the console privacy filter' : node.comparatorDigest}</code></dd></div> : null}
        {node.artifactDigest ? <div><dt>Artifact digest</dt><dd><code>{node.artifactDigest === '[REDACTED]' ? 'Hidden by the console privacy filter' : node.artifactDigest}</code></dd></div> : null}
      </dl>
      <p>Read exact local provenance with <code>ashlr universe graph {graph.universeId} --json</code>.</p>
    </details>
  </section>;
}

function GraphExplorer({ graph, onInspectTrial }: { graph: GraphReport; onInspectTrial: InspectTrial }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kind, setKind] = useState('all');
  const [niche, setNiche] = useState('all');
  const [direction, setDirection] = useState<'all' | 'ancestors' | 'descendants'>('all');
  const [depth, setDepth] = useState(2);
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const selected = selectedId === null ? graph.nodes.find((node) => node.kind === 'trial' && node.currentElite) ?? graph.nodes.find((node) => node.kind === 'trial') ?? graph.nodes[0] : byId.get(selectedId);
  const traversal = useMemo(() => selected && direction !== 'all' ? traverseUniverseGraph(graph, { nodeId: selected.id, direction, maxDepth: depth }) : null, [graph, selected, direction, depth]);
  const traversedIds = useMemo(() => traversal ? new Set(traversal.nodeIds) : null, [traversal]);
  const matching = graph.nodes.filter((node) => (!traversedIds || traversedIds.has(node.id)) && (kind === 'all' || node.kind === kind) && (niche === 'all' || node.niche === niche));
  const pageCount = Math.max(1, Math.ceil(matching.length / DISPLAY_LIMIT));
  const selectedPage = Math.floor(Math.max(0, matching.findIndex((node) => node.id === selected?.id)) / DISPLAY_LIMIT);
  const page = Math.min(requestedPage ?? selectedPage, pageCount - 1);
  const nodes = matching.slice(page * DISPLAY_LIMIT, (page + 1) * DISPLAY_LIMIT);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const select = (id: string) => { setSelectedId(id); setKind('all'); setNiche('all'); setRequestedPage(null); };
  const niches = [...new Set(graph.nodes.flatMap((node) => node.niche ? [node.niche] : []))].sort();
  return <>
    <div className={styles.facts}><span>Source: {graph.sourceState}</span><span>{graph.complete ? 'Source graph complete' : 'Source graph incomplete'}</span><span>{graph.counts.trials} trial records included</span><span>{graph.counts.verifiedDeliveries} checked local deliveries included</span></div>
    {!graph.complete || graph.sourceState === 'degraded' ? <p className={styles.notice} role="status">Graph evidence is incomplete. Missing relationships are not proof that no work or delivery occurred.</p> : null}
    {graph.issues.length ? <details className={styles.note}><summary>Source issues ({graph.issues.length})</summary><ul>{graph.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.code}</code>: {issue.message}</li>)}</ul></details> : null}
    {graph.findings.length ? <section className={styles.findings} aria-label="Graph observations"><h3>Useful observations</h3><ul>{graph.findings.slice(0, DISPLAY_LIMIT).map((finding) => <li key={finding.id}>
      <strong>{finding.kind === 'repeated-output' ? 'Repeated artifact output' : 'Current elite without recorded delivery'}</strong>
      {finding.kind === 'repeated-output' ? <p>{finding.trialCount} trials share a recorded artifact digest. {finding.usageComplete ? `Reported generation tokens: ${finding.reportedTokens ?? 'unavailable'}.` : `Total generation tokens unavailable; recorded subtotal: ${finding.recordedTokens}.`}</p> : <p>No verified delivery is linked to this current local elite in the observation.</p>}
      <div className={styles.findingLinks}>{finding.nodeIds.slice(0, 8).map((id) => { const node = byId.get(id); return node ? <button type="button" className={styles.link} key={id} onClick={() => select(id)}>Inspect {node.label}</button> : null; })}</div>
      {finding.nodeIds.length > 8 ? <p>{finding.nodeIds.length - 8} additional nodes in this group; inspect CLI JSON for all identities.</p> : null}
    </li>)}</ul><p>These are evidence patterns, not cost savings, automatic delivery instructions or proof of business value.</p>{graph.findings.length > DISPLAY_LIMIT ? <p>{graph.findings.length - DISPLAY_LIMIT} additional observations omitted from this panel.</p> : null}</section> : null}
    {graph.nodes.length ? <>
      <div className={styles.filters}>
        <label>Entity type<select value={kind} onChange={(event) => { setKind(event.target.value); setRequestedPage(null); }}><option value="all">All entity types</option>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Niche<select value={niche} onChange={(event) => { setNiche(event.target.value); setRequestedPage(null); }}><option value="all">All niches</option>{niches.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Trace from selection<select value={direction} onChange={(event) => { setDirection(event.target.value as typeof direction); setRequestedPage(null); }} disabled={!selected}><option value="all">All nodes</option><option value="ancestors">Ancestors</option><option value="descendants">Descendants</option></select></label>
        <label>Traversal depth<select value={depth} onChange={(event) => { setDepth(Number(event.target.value)); setRequestedPage(null); }} disabled={direction === 'all'}>{[1, 2, 3, 4, 8, 16, 32, 64].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <p className={styles.note} role="status">Showing {nodes.length} of {matching.length} matching nodes ({graph.nodes.length} in source). {direction !== 'all' ? `Trace is bounded to ${depth} relationship hops. ` : ''}{matching.length > DISPLAY_LIMIT ? `Diagram shows at most ${DISPLAY_LIMIT} nodes per page; relationships crossing pages remain in the inspector. ` : ''}{traversal && !traversal.complete ? 'Traversal is incomplete; the depth bound or source evidence limits this trace.' : ''}</p>
      {pageCount > 1 ? <nav className={styles.pagination} aria-label="Graph node pages"><button type="button" className={styles.button} disabled={page === 0} onClick={() => setRequestedPage(page - 1)}>Previous node page</button><span>Page {page + 1} of {pageCount}</span><button type="button" className={styles.button} disabled={page + 1 === pageCount} onClick={() => setRequestedPage(page + 1)}>Next node page</button></nav> : null}
      {selectedId !== null && !selected ? <p className={styles.notice} role="status">The selected node is no longer present in the current graph. Select another recorded node; no substitute has been chosen.</p> : null}
      {nodes.length ? <><GraphDiagram nodes={nodes} edges={edges.slice(0, DISPLAY_EDGE_LIMIT)} selectedId={selected?.id} select={select} /><div className={styles.legend}><span>Recorded relationship</span><span className={styles.feedbackLegend}>Evaluator feedback (not candidate ancestry)</span></div>{edges.length > DISPLAY_EDGE_LIMIT ? <p className={styles.note}>Diagram shows {DISPLAY_EDGE_LIMIT} of {edges.length} relationships on this page. Select a node to inspect its direct relationships.</p> : null}</> : <p className={styles.notice}>No nodes match these filters. Broaden the entity type, niche or trace direction.</p>}
      <div className={styles.workspace}>
        <div className={styles.nodeList} role="group" aria-label="Graph nodes">{nodes.map((node) => <button type="button" key={node.id} className={styles.nodeButton} aria-label={`Inspect ${KIND_LABELS[node.kind].toLowerCase()}: ${node.label}`} aria-pressed={node.id === selected?.id} onClick={() => setSelectedId(node.id)}><span>{node.label}</span><small>{KIND_LABELS[node.kind]} · {node.state}{node.generation !== undefined ? ` · generation ${node.generation}` : ''}</small></button>)}</div>
        {selected ? <NodeInspector node={selected} graph={graph} byId={byId} select={select} onInspectTrial={onInspectTrial} /> : null}
      </div>
    </> : <p>{graph.sourceState === 'missing' ? 'No recorded graph source is available for this universe.' : graph.complete ? 'This observation contains no graph nodes.' : 'Graph nodes could not be established from incomplete evidence.'}</p>}
  </>;
}

function LoadedGraph({ universeId, onInspectTrial }: { universeId: string; onInspectTrial: InspectTrial }) {
  const definition = useMemo(() => universeGraphQuery(universeId), [universeId]);
  const query = useQuery(definition);
  const refresh = useRefetch(definition);
  return <div className={styles.body}>
    <div className={styles.toolbar}><p className={styles.note}>{query.data ? `Observed ${query.data.sampledAt}${query.status === 'error' ? ' · Last successful read' : ''}` : 'Read-only graph observation; no work is started.'}</p><button type="button" className={styles.button} onClick={refresh} disabled={query.status === 'loading' || query.status === 'refreshing'}>{query.status === 'refreshing' ? 'Refreshing graph…' : 'Refresh graph'}</button></div>
    {query.status === 'loading' ? <p role="status">Loading graph evidence…</p> : null}
    {query.status === 'error' ? <p className={styles.notice} role="alert">Graph records unavailable. {query.error?.message} Refresh graph to retry.{query.data ? ' The graph below is the last successful observation.' : ''}</p> : null}
    {query.data ? <GraphExplorer graph={query.data} onInspectTrial={onInspectTrial} /> : null}
  </div>;
}

/** Mounting this section does not fetch: only opening the inspector mounts its query. */
export function UniverseGraph({ universeId, onInspectTrial }: { universeId: string; onInspectTrial: InspectTrial }) {
  const [open, setOpen] = useState(false);
  const panelId = `universe-graph-${useId().replaceAll(':', '')}`;
  return <section className={styles.section} aria-label="Evidence graph">
    <div className={styles.header}><div><h2>Evidence graph</h2><p>Trace candidate ancestry, evaluator feedback and local delivery back to recorded trials.</p></div><button type="button" className={styles.button} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>{open ? 'Close graph' : 'Open graph'}</button></div>
    <div id={panelId}>{open ? <LoadedGraph universeId={universeId} onInspectTrial={onInspectTrial} /> : null}</div>
  </section>;
}
