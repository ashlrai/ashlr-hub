import { useId, useMemo, useState } from 'react';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import styles from './UniverseControllerTopology.module.css';

const NODE_LIMIT = 64;
const EDGE_LIMIT = 256;
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
  const selected = graph.nodes.find((node) => node.campaignId === selectedId);
  const prefix = useId();
  const detailId = `${prefix}-detail`;
  const links = selected ? graph.topology.get(selected.campaignId) : undefined;
  const inherited = links?.prerequisites.filter((id) => !links.dependsOn.includes(id)) ?? [];
  const outcomes = new Map(data.outcomes.map((node) => [node.campaignId, node]));
  const count = (state: Outcome['state']) => data.outcomes.filter((node) => node.state === state).length;
  function relations(ids: string[], empty: string) {
    return ids.length ? <ul className={styles.relationships}>{ids.map((id) => <li key={id}>
      {graph.positions.has(id) ? <button type="button" onClick={() => setSelectedId(id)}>{id}</button> : <span>{id}</span>}
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
      <div className={styles.workspace}>
        <div className={styles.board} role="region" aria-label="Campaign dependency diagram" tabIndex={0}>
          <div className={styles.canvas} style={{ width: graph.width, height: graph.height }}>
            <svg width={graph.width} height={graph.height} className={styles.edges} aria-hidden="true">
              {graph.edges.slice(0, EDGE_LIMIT).map((edge) => {
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
                  aria-label={`Inspect campaign ${node.campaignId}: ${STATE_LABELS[node.state]}`} aria-pressed={selected?.campaignId === node.campaignId}
                  aria-controls={detailId} aria-describedby={`${prefix}-relations-${index}`} onClick={() => setSelectedId(node.campaignId)}>
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
