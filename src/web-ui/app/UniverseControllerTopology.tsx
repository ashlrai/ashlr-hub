import { useId, useMemo, useRef, useState } from 'react';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { matchControllerCampaigns, prioritizeControllerEdges, type ControllerCampaignStateFilter } from '../data/controller-navigation.js';
import styles from './UniverseControllerTopology.module.css';

const NODE_LIMIT = 64;
const EDGE_LIMIT = 256;
const RESULT_PAGE_SIZE = 8;
type Outcome = UniversePortfolioControllerView['outcomes'][number];
const STATE_LABELS: Record<Outcome['state'], string> = {
  pending: 'Pending', 'in-flight': 'Unresolved intent', completed: 'Completed', held: 'Held',
};
const STATE_MEANINGS: Record<Outcome['state'], string> = {
  pending: 'No settled outcome is recorded. Pending does not mean ready to run.',
  'in-flight': 'A durable dispatch intent remains unresolved. This is not proof of a live worker.',
  completed: 'The controller recorded completion, including any required local delivery. This is not a production deployment claim.',
  held: 'Work remains held for the recorded reason. This view does not retry or release it.',
};

/** Layout follows declared dependencies, never a guessed worker schedule or execution priority. */
function layoutCampaigns(data: UniversePortfolioControllerView) {
  const nodes = data.outcomes.slice(0, NODE_LIMIT);
  const topology = new Map(data.topology?.map((node) => [node.campaignId, node]));
  const visible = new Set(nodes.map((node) => node.campaignId));
  const levels = new Map<string, number>();
  if (data.topology) {
    for (let pass = 0; pass < nodes.length; pass++) {
      for (const node of nodes) {
        const links = topology.get(node.campaignId);
        if (levels.has(node.campaignId) || !links || links.dependsOn.some((id) => !levels.has(id))) continue;
        levels.set(node.campaignId, links.dependsOn.length ? Math.max(...links.dependsOn.map((id) => levels.get(id)!)) + 1 : 0);
      }
    }
  }
  const knownLevels = [...new Set(levels.values())].sort((a, b) => a - b);
  const columns = knownLevels.map((level) => ({ label: `Dependency layer ${level + 1}`, nodes: nodes.filter((node) => levels.get(node.campaignId) === level) }));
  const unplaced = nodes.filter((node) => !levels.has(node.campaignId));
  if (unplaced.length) columns.push({ label: data.topology ? 'Layer unavailable' : 'Recorded campaigns', nodes: unplaced });
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, index) => column.nodes.forEach((node, row) => positions.set(node.campaignId, { x: 24 + index * 244, y: 56 + row * 108 })));
  const edges = nodes.flatMap((node) => (topology.get(node.campaignId)?.dependsOn ?? []).filter((id) => visible.has(id)).map((from) => ({ from, to: node.campaignId })));
  return { nodes, topology, columns, positions, edges, width: Math.max(256, columns.length * 244 + 8), height: 64 + Math.max(1, ...columns.map((column) => column.nodes.length)) * 108 };
}

function ControllerTopology({ data }: { data: UniversePortfolioControllerView }) {
  const graph = useMemo(() => layoutCampaigns(data), [data]);
  const [selectedId, setSelectedId] = useState(graph.nodes[0]?.campaignId ?? null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<ControllerCampaignStateFilter>('all');
  const [resultPage, setResultPage] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const selected = graph.nodes.find((node) => node.campaignId === selectedId);
  const matching = useMemo(() => matchControllerCampaigns(graph.nodes, query, stateFilter), [graph.nodes, query, stateFilter]);
  const filtering = query.trim().length > 0 || stateFilter !== 'all';
  const pageCount = Math.max(1, Math.ceil(matching.length / RESULT_PAGE_SIZE));
  const page = Math.min(resultPage, pageCount - 1);
  const visibleResults = matching.slice(page * RESULT_PAGE_SIZE, (page + 1) * RESULT_PAGE_SIZE);
  const selectedExcluded = selected && filtering && !matching.some((node) => node.campaignId === selected.campaignId);
  const visibleEdges = useMemo(() => prioritizeControllerEdges(graph.edges, selected?.campaignId ?? null, EDGE_LIMIT), [graph.edges, selected?.campaignId]);
  const prefix = useId();
  const detailId = `${prefix}-detail`;
  const links = selected ? graph.topology.get(selected.campaignId) : undefined;
  const inherited = links?.prerequisites.filter((id) => !links.dependsOn.includes(id)) ?? [];
  const outcomes = new Map(data.outcomes.map((node) => [node.campaignId, node]));
  const count = (state: Outcome['state']) => data.outcomes.filter((node) => node.state === state).length;
  function revealCampaign(id: string, focus = false) {
    const board = boardRef.current; const position = graph.positions.get(id);
    if (!board || !position) return;
    // Only the diagram viewport moves; scrollIntoView would also move the page.
    const left = Math.max(0, position.x + 96 - board.clientWidth / 2);
    const top = Math.max(0, position.y + 40 - board.clientHeight / 2);
    if (typeof board.scrollTo === 'function') board.scrollTo({ left, top, behavior: 'auto' });
    else { board.scrollLeft = left; board.scrollTop = top; }
    if (focus) nodeRefs.current.get(id)?.focus({ preventScroll: true });
  }
  function selectCampaign(id: string) { setSelectedId(id); revealCampaign(id); }
  function relations(ids: string[], empty: string) {
    return ids.length ? <ul className={styles.relationships}>{ids.map((id) => <li key={id}>
      {graph.positions.has(id) ? <button type="button" onClick={() => selectCampaign(id)}>{id}</button> : <span>{id}</span>}
      <span>{outcomes.has(id) ? STATE_LABELS[outcomes.get(id)!.state] : 'Outcome unavailable'}</span>
    </li>)}</ul> : <p className={styles.note}>{empty}</p>;
  }
  return <section className={styles.topology} aria-label="Controller mission topology">
    <header className={styles.header}><div><h3>Mission topology</h3><p>Follow the declared work graph. Select a campaign to inspect its recorded state and prerequisites.</p></div><span className={styles.snapshot}>Recorded snapshot</span></header>
    <dl className={styles.counts} aria-label="Recorded campaign counts">
      <div><dt>Campaigns</dt><dd>{data.outcomes.length}</dd></div>
      {(['completed', 'in-flight', 'held', 'pending'] as const).map((state) => <div key={state} data-state={state}><dt>{STATE_LABELS[state]}</dt><dd>{count(state)}</dd></div>)}
    </dl>
    {!data.topology ? <p className={styles.notice}>Dependency information is unavailable in this observation. Campaign placement does not imply independence or readiness.</p> : null}
    {data.outcomes.length > NODE_LIMIT ? <p className={styles.notice}>Showing the first {NODE_LIMIT} of {data.outcomes.length} campaigns. Counts include all recorded outcomes; relationships outside this diagram remain in the selected campaign detail.</p> : null}
    {graph.nodes.length ? <>
      <section className={styles.finder} aria-label="Campaign navigator">
        <div className={styles.finderControls}>
          <label className={styles.searchLabel} htmlFor={`${prefix}-search`}>Search campaigns
            <input id={`${prefix}-search`} type="search" value={query} maxLength={192} placeholder="Campaign ID or recorded reason" aria-describedby={`${prefix}-finder-hint`}
              onChange={(event) => { setQuery(event.target.value); setResultPage(0); }} />
          </label>
          <label htmlFor={`${prefix}-state`}>Recorded state
            <select id={`${prefix}-state`} value={stateFilter} onChange={(event) => { setStateFilter(event.target.value as ControllerCampaignStateFilter); setResultPage(0); }}>
              <option value="all">All recorded states</option>
              {(['pending', 'in-flight', 'completed', 'held'] as const).map((state) => <option key={state} value={state}>{STATE_LABELS[state]}</option>)}
            </select>
          </label>
          <button type="button" className={styles.utilityButton} disabled={!selected} onClick={() => { if (selected) revealCampaign(selected.campaignId, true); }}>Locate selected</button>
          {filtering ? <button type="button" className={styles.utilityButton} onClick={() => { setQuery(''); setStateFilter('all'); setResultPage(0); }}>Reset filters</button> : null}
        </div>
        <div className={styles.finderMeta}><p id={`${prefix}-finder-hint`}>Search covers the {graph.nodes.length} diagram campaigns. Filters narrow this index, not the graph or its dependency layers.</p>
          <span aria-live="polite" aria-atomic="true">{filtering ? `${matching.length} matching campaign${matching.length === 1 ? '' : 's'}` : `${graph.nodes.length} campaigns in diagram`}</span></div>
        {filtering ? <>
          {matching.length ? <ul className={styles.results} aria-label="Matching campaigns">{visibleResults.map((node) => <li key={node.campaignId}>
            <button type="button" className={styles.result} aria-label={`Select campaign ${node.campaignId}`} aria-describedby={`${prefix}-result-state-${node.campaignId} ${prefix}-result-reason-${node.campaignId}`} aria-pressed={selected?.campaignId === node.campaignId} aria-controls={detailId} onClick={() => selectCampaign(node.campaignId)}>
              <span className={styles.resultName}>{node.campaignId}</span><span id={`${prefix}-result-state-${node.campaignId}`} className={styles.resultState} data-state={node.state}>{STATE_LABELS[node.state]}</span><span id={`${prefix}-result-reason-${node.campaignId}`} className={styles.resultReason}>{node.reasonCode}</span>
            </button>
          </li>)}</ul> : <p className={styles.noResults}>No diagram campaigns match. Try another campaign ID or recorded reason, or reset filters.</p>}
          {pageCount > 1 ? <nav className={styles.pagination} aria-label="Campaign result pages"><span>Page {page + 1} of {pageCount}</span>
            <button type="button" className={styles.utilityButton} disabled={page === 0} onClick={() => setResultPage(page - 1)}>Previous results</button>
            <button type="button" className={styles.utilityButton} disabled={page + 1 === pageCount} onClick={() => setResultPage(page + 1)}>Next results</button>
          </nav> : null}
        </> : null}
      </section>
      <div className={styles.workspace}>
        <div ref={boardRef} className={styles.board} role="region" aria-label="Campaign dependency diagram" tabIndex={0}>
          <div className={styles.canvas} style={{ width: graph.width, height: graph.height }}>
            <svg width={graph.width} height={graph.height} className={styles.edges} aria-hidden="true">
              {visibleEdges.map((edge) => {
                const from = graph.positions.get(edge.from)!; const to = graph.positions.get(edge.to)!;
                const x = from.x + 192; const end = to.x; const mid = (x + end) / 2;
                return <path key={`${edge.from}-${edge.to}`} className={selected && (edge.from === selected.campaignId || edge.to === selected.campaignId) ? styles.selectedEdge : styles.edge}
                  d={`M ${x} ${from.y + 40} C ${mid} ${from.y + 40}, ${mid} ${to.y + 40}, ${end} ${to.y + 40}`} />;
              })}
            </svg>
            {graph.columns.map((column, index) => <span key={column.label} className={styles.column} style={{ left: 24 + index * 244 }}>{column.label}</span>)}
            {graph.nodes.map((node, index) => {
              const position = graph.positions.get(node.campaignId)!;
              const dependencies = graph.topology.get(node.campaignId);
              return <div key={node.campaignId}>
                <button type="button" className={styles.node} data-state={node.state} style={{ left: position.x, top: position.y }}
                  ref={(element) => { if (element) nodeRefs.current.set(node.campaignId, element); else nodeRefs.current.delete(node.campaignId); }}
                  aria-label={`Inspect campaign ${node.campaignId}: ${STATE_LABELS[node.state]}`} aria-pressed={selected?.campaignId === node.campaignId}
                  aria-controls={detailId} aria-describedby={`${prefix}-relations-${index}`} onClick={() => selectCampaign(node.campaignId)}>
                  <span className={styles.nodeName}>{node.campaignId}</span><span className={styles.nodeState}>{STATE_LABELS[node.state]}</span>
                </button>
                <span id={`${prefix}-relations-${index}`} className={styles.srOnly}>{dependencies
                  ? `Direct dependencies: ${dependencies.dependsOn.join(', ') || 'none declared'}. Additional inherited delivery prerequisites: ${dependencies.prerequisites.filter((id) => !dependencies.dependsOn.includes(id)).join(', ') || 'none recorded'}.`
                  : 'Dependency information unavailable.'}</span>
              </div>;
            })}
          </div>
        </div>
        <section id={detailId} className={styles.detail} aria-label="Selected campaign detail">
          {selected ? <><span className={styles.detailState} data-state={selected.state}>{STATE_LABELS[selected.state]}</span><h4>{selected.campaignId}</h4>
          {selectedExcluded ? <p className={styles.selectionNote}>The selected campaign is outside the current filters. Its recorded detail remains available.</p> : null}
          <p>{STATE_MEANINGS[selected.state]}</p>
          <dl className={styles.facts}><div><dt>Recorded reason</dt><dd>{selected.reasonCode}</dd></div><div><dt>Campaign-call intent</dt><dd>{selected.attempted ? 'Recorded' : 'Not recorded'}</dd></div></dl>
          <p className={styles.note}>A call intent is not proof of worker execution, model requests or successful evaluation.</p>
          <h5>Direct dependencies</h5>{links ? relations(links.dependsOn, 'None declared for this campaign.') : <p className={styles.note}>Dependency information unavailable.</p>}
          <h5>Additional inherited delivery prerequisites</h5>{links ? relations(inherited, 'None recorded beyond the direct dependencies.') : <p className={styles.note}>Delivery prerequisite information unavailable.</p>}
          <p className={styles.note}>Inherited prerequisites are ancestor delivery gates, not additional declared dependency edges. A state badge alone does not verify the delivery receipt.</p></>
            : <p className={styles.note}>{selectedId ? `Selected campaign ${selectedId} is no longer present in this diagram. No substitute has been selected. Choose another campaign to inspect its evidence.` : 'Select a campaign to inspect its recorded evidence.'}</p>}
        </section>
      </div>
      <p className={styles.legend}>Lines show declared dependencies, from earlier to later layers. Layer placement does not change declared priority or establish execution readiness.</p>
      {graph.edges.length > EDGE_LIMIT ? <p className={styles.note}>Showing {EDGE_LIMIT} of {graph.edges.length} visible dependency lines. Every campaign’s complete relationships remain available in its detail and accessible description.</p> : null}
    </> : <p className={styles.empty}>No campaign outcomes are available in this observation. Inspect a registered controller with recorded campaigns to see its mission topology.</p>}
  </section>;
}

/** Controller identity remounts selection; same-controller refreshes retain a still-present campaign. */
export function UniverseControllerTopology({ data }: { data: UniversePortfolioControllerView }) {
  return <ControllerTopology key={data.controllerId} data={data} />;
}
