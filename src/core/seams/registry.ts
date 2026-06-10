/**
 * core/seams/registry.ts — M30 seam registry + endpoint accessor.
 *
 * The single place that:
 *  - reads (defensively) the OPTIONAL per-seam cloud endpoint config, and
 *  - lists every seam with its active impl ('local') and cloud availability
 *    (false | 'gated'), feeding the READ-ONLY `ashlr seams` diagnostic.
 *
 * HARD SAFETY:
 *  - READ-ONLY: building the registry triggers NO I/O — it reads only the
 *    in-memory config and emits metadata. It never instantiates a seam impl,
 *    never calls a local adapter, and never touches disk/network.
 *  - NO ACTIVATION PATH: `seamEndpoint()` only reports whether an endpoint
 *    STRING is present. A present endpoint routes a selector to the GATED stub
 *    (which throws). There is no value of config that yields a functional cloud
 *    backbone.
 *  - NON-REGRESSION: the seam config is read via a cast over an OPTIONAL
 *    property of AshlrConfig (`seamsConfig()`), so AshlrConfig is unmodified and
 *    DEFAULT UNSET => local for every seam.
 */

import type { AshlrConfig } from '../types.js';
import type { SeamId, SeamRegistry, SeamStatus, SeamsConfig } from './types.js';
import { RUN_SWARM_SEAM } from './run-swarm.js';
import { BACKLOG_SEAM } from './backlog.js';
import { INBOX_SEAM } from './inbox.js';
import { DAEMON_COORDINATOR_SEAM } from './daemon-coordinator.js';
import { GENOME_SEAM } from './genome.js';
import { PORTFOLIO_SEAM } from './portfolio.js';
import { IDENTITY_SEAM } from './identity.js';

/**
 * The seam ids that have a GATED cloud stub (so `cloud` reports 'gated'). The
 * `telemetry` reference seam is intentionally NOT here: its opt-in OtlpHttpSink
 * is a real local-network sink (M19), not a gated team backbone — its cloud
 * field is `false`.
 */
const GATED_SEAM_IDS: ReadonlySet<SeamId> = new Set<SeamId>([
  'runSwarm',
  'backlog',
  'inbox',
  'daemonCoordinator',
  'genome',
  'portfolio',
  'identity',
]);

/**
 * Defensively read the OPTIONAL `seams` config block off AshlrConfig WITHOUT
 * modifying the AshlrConfig type (NON-REGRESSION). Returns {} when unset, so
 * every seam DEFAULTS to local.
 */
export function seamsConfig(cfg: AshlrConfig): SeamsConfig {
  const raw = (cfg as { seams?: unknown }).seams;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as SeamsConfig;
  }
  return {};
}

/**
 * Return the explicitly-configured cloud endpoint for a seam, or null when
 * unset. A non-null result routes the seam's selector to the GATED stub (which
 * throws on every method) — it NEVER enables a functional backbone. Only the
 * seven gated seams can have an endpoint; the reference telemetry seam is
 * excluded (it has no gated stub here).
 */
export function seamEndpoint(cfg: AshlrConfig, id: Exclude<SeamId, 'telemetry'>): string | null {
  const sc = seamsConfig(cfg);
  const entry = sc[id];
  const endpoint = entry?.endpoint;
  return typeof endpoint === 'string' && endpoint.trim().length > 0 ? endpoint : null;
}

/** One static seam descriptor row. */
interface SeamDescriptor {
  id: SeamId;
  name: string;
  delegatesTo: string;
  summary: string;
}

/**
 * The static seam descriptors, in display order (telemetry cited last).
 *
 * Built LAZILY inside a function rather than at module top-level: registry.ts
 * and the per-seam modules import each other (each seam pulls `seamEndpoint`
 * from here; here we cite each seam's `*_SEAM` descriptor). Referencing the
 * imported `*_SEAM` bindings at module-evaluation time is order-dependent under
 * ESM and can hit a temporal-dead-zone crash when a seam module is the FIRST
 * entry imported. Deferring the array into a function guarantees every `*_SEAM`
 * binding is fully initialised before it is read, regardless of import order.
 */
function seamDescriptors(): ReadonlyArray<SeamDescriptor> {
  return [
    RUN_SWARM_SEAM,
    BACKLOG_SEAM,
    INBOX_SEAM,
    DAEMON_COORDINATOR_SEAM,
    GENOME_SEAM,
    PORTFOLIO_SEAM,
    IDENTITY_SEAM,
    {
      id: 'telemetry',
      name: 'TelemetrySink',
      delegatesTo: 'core/observability/telemetry-sink.ts',
      summary: 'Reference seam (M19): LocalFileSink default + opt-in OTLP sink. Cited, not rewritten.',
    },
  ];
}

/**
 * Build the READ-ONLY seam registry roll-up for `ashlr seams`. Pure: derives
 * everything from the in-memory config + static descriptors. Triggers NO I/O,
 * instantiates NO seam impl, and never touches disk/network. NEVER throws.
 */
export function buildSeamRegistry(cfg: AshlrConfig): SeamRegistry {
  const seams: SeamStatus[] = seamDescriptors().map((d) => {
    const cloud = GATED_SEAM_IDS.has(d.id) ? ('gated' as const) : (false as const);
    // Only the gated seams can have an endpoint; telemetry never routes here.
    const endpointConfigured =
      d.id !== 'telemetry' && seamEndpoint(cfg, d.id as Exclude<SeamId, 'telemetry'>) !== null;
    // active is 'gated' ONLY when a cloud endpoint is explicitly configured for
    // a gated seam — and that impl refuses. Otherwise ALWAYS 'local'.
    const active = endpointConfigured ? ('gated' as const) : ('local' as const);
    return {
      id: d.id,
      name: d.name,
      active,
      cloud,
      endpointConfigured,
      delegatesTo: d.delegatesTo,
      summary: d.summary,
    };
  });

  const gatedConfigured = seams.filter((s) => s.endpointConfigured).length;
  const allLocal = seams.every((s) => s.active === 'local');

  return {
    generatedAt: new Date().toISOString(),
    seams,
    allLocal,
    gatedConfigured,
  };
}
