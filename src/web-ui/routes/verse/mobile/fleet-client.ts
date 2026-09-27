/**
 * routes/verse/mobile/fleet-client.ts — the fleet WRITES the phone makes,
 * behind one small interface.
 *
 * Today every verb is an existing route the workbench already uses:
 *
 *   start / stop / pause / resume   POST /api/verse/daemon      (autonomy/control-queries.ts runDaemonAction)
 *   budget mode                     POST /api/verse/budget      (budget/budget-queries.ts updateBudget)
 *
 * The Fleet tab's own control routes are being built alongside this app; when
 * they land, `setMobileFleetClient` swaps the implementation in one place and
 * no screen changes. Reads stay on the shared query cache (the same keys the
 * workbench uses), so a write here refreshes the Mac's own view too.
 *
 * The implementations are dynamic imports: a Pause from Home is rare, and the
 * control and budget modules have no business in the first-paint bundle.
 */
import type { BudgetMode } from '../../../../core/routing/types.js';
import type { DaemonVerb } from './fleet-state.js';

export interface FleetActionResult {
  /** The server's own sentence about what happened ("Paused dispatch."), or null. */
  note: string | null;
}

export interface MobileFleetClient {
  daemon(verb: DaemonVerb): Promise<FleetActionResult>;
  setBudgetMode(mode: BudgetMode): Promise<FleetActionResult>;
}

export const defaultFleetClient: MobileFleetClient = {
  async daemon(verb) {
    const { runDaemonAction } = await import('../autonomy/control-queries.js');
    const result = await runDaemonAction(verb);
    return { note: typeof result?.note === 'string' && result.note ? result.note : null };
  },
  async setBudgetMode(mode) {
    const { updateBudget } = await import('../budget/budget-queries.js');
    await updateBudget({ mode });
    return { note: null };
  },
};

let client: MobileFleetClient = defaultFleetClient;

export function getMobileFleetClient(): MobileFleetClient {
  return client;
}

/** Swap the implementation (the Fleet tab's routes, or a test fake). Null restores the default. */
export function setMobileFleetClient(next: MobileFleetClient | null): void {
  client = next ?? defaultFleetClient;
}
