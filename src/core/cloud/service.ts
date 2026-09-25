/**
 * Cloud lane orchestration (unit C1): the ONLY entry point other code uses
 * to launch. Order: validate → budget gate → persist `queued` → per-repo
 * launch slot → ensureCloudCheckout(base) → buildCloudPrompt →
 * launchCloudSession → persist `running` (or `failed` with a plain reason).
 */
import type { CloudImproveResponse, CloudLaunchRequest, CloudLaunchResponse, CloudOverviewResponse, CloudSeatStatus } from './types.js';
import type { CloudCheckoutDeps } from './checkout.js';
import type { CloudLaunchDeps } from './launcher.js';
import type { CloudTrackerDeps } from './tracker.js';
import { notImplemented } from './_stub.js';

export interface CloudServiceDeps {
  checkout?: CloudCheckoutDeps;
  launcher?: CloudLaunchDeps;
  tracker?: CloudTrackerDeps;
  now?: () => Date;
}

/** Internal launches (Leader approvals, self-improvement) carry their origin + backlog item. */
export type CloudInternalLaunch = Omit<CloudLaunchRequest, 'origin'> & {
  origin: 'leader' | 'self-improve';
  backlogItemId?: string | null;
  needsYouId?: string | null;
};

export function cloudSeatStatus(): CloudSeatStatus { return notImplemented('cloudSeatStatus'); }
export function launchCloudTask(_req: CloudLaunchRequest | CloudInternalLaunch, _deps?: CloudServiceDeps): Promise<CloudLaunchResponse> { return notImplemented('launchCloudTask'); }
/**
 * Launch up to `count` backlog items (default 1, max 5). `auto: true` is the
 * scheduler path and additionally requires budget.selfImprove.enabled and
 * the canSelfImprove gate; `auto: false` is the operator's "Improve Verse"
 * button (canLaunch gate only).
 */
export function runSelfImprove(_opts: { count?: number; auto: boolean }, _deps?: CloudServiceDeps): Promise<CloudImproveResponse> { return notImplemented('runSelfImprove'); }
export function cloudOverview(_deps?: CloudServiceDeps): Promise<CloudOverviewResponse> { return notImplemented('cloudOverview'); }
