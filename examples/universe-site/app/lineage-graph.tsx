/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The named overflow region must support keyboard scrolling at narrow widths and zoom. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The native SVG chart needs image semantics; it cannot be replaced with a raster img. */
import type { Evidence } from './experiment';

export function LineageGraph({
  evidence,
  selectedId,
  onSelect,
}: {
  evidence: Evidence;
  selectedId?: string;
  onSelect: (id: string, generation: number) => void;
}) {
  const nodes = evidence.generations.flatMap((generation, column) =>
    generation.trials.map((trial, row) => ({
      ...trial,
      generation: generation.generation,
      x: 310 + column * 380,
      y: 74 + row * 126,
    })),
  );
  const chosen = nodes.find((node) => node.id === selectedId);
  return (
    <figure className="lineage-map">
      <figcaption>
        <strong>The search frontier</strong>
        <span>
          Choose a node to inspect its evidence. Lines show recorded parentage.
        </span>
      </figcaption>
      <section
        className="map-scroll"
        tabIndex={0}
        aria-label="Scrollable experiment lineage"
      >
        <div className="map-canvas">
          <svg
            viewBox="0 0 840 410"
            role="img"
            aria-labelledby="lineage-title lineage-desc"
          >
            <title id="lineage-title">Recorded experiment lineage</title>
            <desc id="lineage-desc">
              A pinned seed leads to three first-generation trials. Recorded
              parents connect second-generation trials. Labeled buttons provide
              the outcomes and selection controls.
            </desc>
            <defs>
              <pattern
                id="map-grid"
                width="24"
                height="24"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="1" cy="1" r=".6" fill="#71849a" opacity=".2" />
              </pattern>
            </defs>
            <rect width="840" height="410" fill="url(#map-grid)" />
            <path
              className="generation-boundary"
              d="M 174 24 Q 226 200 174 376 M 544 24 Q 596 200 544 376"
            />
            {nodes.map((node) => {
              const parent = nodes.find(
                (candidate) => candidate.id === node.parentTrialId,
              );
              const start = parent
                ? { x: parent.x + 68, y: parent.y }
                : { x: 116, y: 200 };
              const end = { x: node.x - 68, y: node.y };
              const focus =
                node.id === selectedId || node.id === chosen?.parentTrialId;
              return (
                <path
                  key={node.id}
                  className={`lineage-edge ${focus ? 'edge-selected' : ''} ${node.selected ? '' : 'edge-rejected'}`}
                  d={`M ${start.x} ${start.y} C ${start.x + 55} ${start.y}, ${end.x - 55} ${end.y}, ${end.x} ${end.y}`}
                />
              );
            })}
          </svg>
          <div className="seed-node">
            <span className="seed-glyph" aria-hidden="true">
              ✳
            </span>
            <strong>Pinned seed</strong>
            <span>Shared starting point</span>
          </div>
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`map-node ${node.selected ? 'retained-node' : 'rejected-node'}`}
              style={{ left: `${node.x / 8.4}%`, top: `${node.y / 4.1}%` }}
              aria-label={`Select ${node.variant} lineage, generation ${node.generation}`}
              aria-pressed={selectedId === node.id}
              onClick={() => onSelect(node.id, node.generation)}
            >
              <span>{node.variant}</span>
              <strong>
                {node.selected ? `${node.artifactBytes} B` : 'Rejected'}
              </strong>
              <small>Generation {node.generation}</small>
            </button>
          ))}
        </div>
      </section>
      <p className="map-legend">
        <span>Retained after evaluation</span>
        <span>Rejected by evaluator</span>
        <span>Recorded data · not live agents</span>
      </p>
    </figure>
  );
}
