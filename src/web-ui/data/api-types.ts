/**
 * data/api-types.ts — the ONLY place the web UI touches backend type
 * definitions. Everything here is a type-only re-export of the real
 * backend interfaces — never a hand-copied shape.
 *
 * Why this works: `import type` is fully erased by both tsc and esbuild/
 * Vite's transform, so importing straight from src/core/**.ts costs zero
 * runtime bytes and can never drift from the backend, unlike a generated
 * snapshot that goes stale the next time someone edits DashboardSnapshot.
 * The backend files themselves are off-limits to edit (owned by the API/
 * server work) but perfectly fine to read types from — that boundary is
 * about behavior, not about who's allowed to `import type` them.
 *
 * If `tsc --noEmit -p src/web-ui/tsconfig.json` ever fails because one of
 * these files pulls in something it shouldn't, that is a real signal: the
 * backend type surface changed in a way the frontend needs to know about,
 * not a bug in this file.
 */
export type {
  DashboardSnapshot,
  ProductionSummary,
  IntelligenceSummary,
} from '../../core/types.js';

export type { ControlSnapshot } from '../../core/web/control.js';
export type { VisibilitySnapshot } from '../../core/web/visibility.js';

/**
 * Structural shape shared by every "we might not actually know this"
 * field across the backend (daemon observation, control sections, goal
 * progress, …). Every real occurrence in src/core matches this shape —
 * `{ sourceState, complete, reason? }` — even though it isn't hoisted to
 * one named exported type on the backend. Modeled structurally here so the
 * epistemic-honesty primitive (see components/primitives/Epistemic.tsx)
 * can key off it wherever it appears without importing a dozen individual
 * one-off types.
 */
export interface SourceQuality {
  sourceState: 'healthy' | 'degraded' | 'missing' | 'unknown';
  complete: boolean;
  reason?: string;
}

/** The envelope every `snapshot` SSE frame carries (see api.ts handleSseEvents). */
export interface SnapshotEventPayload {
  dispatchEnabled: boolean;
  [key: string]: unknown;
}
