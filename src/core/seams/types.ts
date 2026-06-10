/**
 * core/seams/types.ts — M30 seam types (single-sourced).
 *
 * Defines the shared types for the M30 "cloud-ready seams" layer: the read-only
 * diagnostic shape (`SeamStatus`), the registry roll-up (`SeamRegistry`), and a
 * defensive, OPTIONAL config augmentation (`SeamsConfig`) describing where a
 * cloud/team backbone endpoint WOULD be configured per seam.
 *
 * HARD SAFETY NOTE: the presence of an endpoint string here NEVER activates a
 * working cloud backbone. Every cloud impl is a GATED STUB that THROWS before
 * any I/O. A configured endpoint only changes which (throwing) stub a selector
 * returns; it can never perform a remote call. There is NO config flag and NO
 * code path that activates a functional cloud/team backbone — that remains a
 * Mason GATE (explicit opt-in, not implemented). Local-first + self-hostable;
 * nothing public.
 *
 * This block is kept OUT of the monolithic core/types.ts on purpose so the M30
 * additions are purely additive and cannot perturb any existing type. The
 * `SeamsConfig` shape is read defensively off `AshlrConfig` via `seamsConfig()`
 * in registry.ts (a cast over an optional property) so AshlrConfig itself is
 * unchanged — preserving the M30 NON-REGRESSION invariant at the type level.
 */

/**
 * Stable identifiers for every v2 seam. Used as the key in the registry and in
 * the `ashlr seams` diagnostic. `telemetry` is the pre-existing M19 reference
 * seam (core/observability/telemetry-sink.ts) — it is CITED here, not rewritten.
 */
export type SeamId =
  | 'runSwarm'
  | 'backlog'
  | 'inbox'
  | 'daemonCoordinator'
  | 'genome'
  | 'portfolio'
  | 'identity'
  | 'telemetry';

/**
 * Which implementation a seam is actively serving. The default path is ALWAYS
 * `'local'`. `'gated'` is only ever surfaced when a cloud endpoint is explicitly
 * configured for that seam — and that impl REFUSES (throws) on every method.
 */
export type SeamImpl = 'local' | 'gated';

/**
 * Whether a cloud/team impl exists for a seam. It is NEVER `true` in M30:
 *  - `false`  — no cloud impl exists at all (e.g. the reference telemetry seam,
 *               whose opt-in OTLP sink is a real local-network sink, not a
 *               gated team backbone).
 *  - `'gated'`— a cloud STUB exists but is gated on Mason and THROWS; it can be
 *               referenced (when an endpoint is configured) but never does I/O.
 */
export type SeamCloud = false | 'gated';

/**
 * Read-only diagnostic record for one seam — the row rendered by `ashlr seams`.
 * Pure metadata; contains NO endpoint secrets and triggers NO I/O to produce.
 */
export interface SeamStatus {
  /** Stable seam identifier. */
  id: SeamId;
  /** Human-readable seam name (e.g. 'RunSwarmStore'). */
  name: string;
  /** The active implementation. ALWAYS 'local' on the default path. */
  active: SeamImpl;
  /** Cloud availability: false (none) or 'gated' (stub exists, throws). */
  cloud: SeamCloud;
  /**
   * Whether a cloud endpoint is explicitly configured for this seam. When true,
   * `active` is 'gated' and the seam REFUSES to operate (throws). Default false.
   */
  endpointConfigured: boolean;
  /** The existing local module this seam delegates to (for the diagnostic). */
  delegatesTo: string;
  /** One-line description of the seam's responsibility. */
  summary: string;
}

/** The full read-only registry roll-up consumed by the `ashlr seams` command. */
export interface SeamRegistry {
  /** ISO timestamp the registry snapshot was produced. */
  generatedAt: string;
  /** One row per seam. */
  seams: SeamStatus[];
  /**
   * Convenience roll-up flags for the diagnostic header.
   * `allLocal` is true when EVERY seam is serving its local impl (the only
   * state reachable without an explicitly-configured cloud endpoint).
   */
  allLocal: boolean;
  /** Count of seams with an explicitly-configured (but gated) cloud endpoint. */
  gatedConfigured: number;
}

/**
 * OPTIONAL, defensively-read config augmentation describing where a cloud/team
 * backbone endpoint WOULD live per seam. DEFAULT UNSET => local for every seam.
 *
 * Read off `AshlrConfig` via a cast in registry.ts; AshlrConfig itself is NOT
 * modified (NON-REGRESSION). An endpoint string here only routes a selector to
 * the GATED (throwing) stub — it can never enable a functional backbone.
 */
export interface SeamsConfig {
  /** Per-seam cloud endpoint. Presence => route to the gated stub (throws). */
  runSwarm?: { endpoint?: string };
  backlog?: { endpoint?: string };
  inbox?: { endpoint?: string };
  daemonCoordinator?: { endpoint?: string };
  genome?: { endpoint?: string };
  portfolio?: { endpoint?: string };
  identity?: { endpoint?: string };
}

/**
 * Canonical gated-error message thrown by EVERY cloud stub method. Centralised
 * so the message is identical across seams and easy for the verifier to assert.
 */
export const CLOUD_GATED_MESSAGE =
  'cloud/team backbone gated on Mason — not implemented (requires Mason\'s explicit opt-in)';

/**
 * Construct the canonical gated Error for a seam + method. The cloud stubs call
 * this and THROW it as the FIRST statement of every method, before any I/O.
 */
export function cloudGatedError(seam: string, method: string): Error {
  return new Error(`[ashlr seams] ${seam}.${method}: ${CLOUD_GATED_MESSAGE}`);
}
