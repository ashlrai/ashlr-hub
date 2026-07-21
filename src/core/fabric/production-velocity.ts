/**
 * Production velocity profile helpers.
 *
 * This module is config-only glue: it widens no trust/merge authority and does
 * not dispatch work. The daemon consumes it to opt into the resource-control
 * lane: gateway + resource-aware + concurrent + workhorse routing, explicit
 * local/API caps, and queue selection sized to real slot capacity.
 */

import type { AshlrConfig } from '../types.js';
import type { ResourceSnapshot } from './resource-monitor.js';
import { slotsForBackendState } from './concurrent-dispatch.js';
import {
  productionVelocityRaw,
  resolveProductionVelocityPendingPolicy,
} from './production-velocity-pending.js';

export {
  pendingProposalIsStaleForProductionVelocity,
  type PendingProposalBlockingOptions,
} from './production-velocity-pending.js';

export type ProductionVelocityProfileName = 'off' | 'resource-control';

export interface EffectiveProductionVelocityProfile {
  enabled: boolean;
  profile: ProductionVelocityProfileName;
  fillQueueToSlots: boolean;
  stalePendingTtlHours: number;
  maxSlotsPerBackend: number;
  caps: {
    localMaxConcurrent: number | null;
    nimMaxConcurrent: number | null;
    kimiMaxConcurrent: number | null;
  };
  flags: {
    gateway: boolean;
    resourceAware: boolean;
    concurrentDispatch: boolean;
    workhorseDispatch: boolean;
  };
}

export interface DaemonQueueSelectionInput {
  perTickItems: number;
  remainingBudgetUsd: number;
  backlogItems: number;
  fillQueueToSlots: boolean;
  availableSlots?: number | null;
  minPerItemUsd?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : null;
}

export function resolveProductionVelocityProfile(cfg: AshlrConfig): EffectiveProductionVelocityProfile {
  const foundry = asRecord(cfg.foundry) ?? {};
  const fabric = asRecord(foundry['fabric']) ?? {};
  const local = asRecord(foundry['local']) ?? {};
  const nim = asRecord(foundry['nim']) ?? {};
  const kimi = asRecord(foundry['kimi']) ?? {};
  const raw = productionVelocityRaw(cfg);
  const rawObj = asRecord(raw) ?? {};
  const pendingPolicy = resolveProductionVelocityPendingPolicy(cfg);
  const enabled = pendingPolicy.enabled;

  const maxSlotsPerBackend = positiveInt(
    rawObj['maxSlotsPerBackend'],
    positiveInt(fabric['maxSlotsPerBackend'], 3),
  );

  const localMaxConcurrent = positiveIntOrNull(rawObj['localMaxConcurrent'])
    ?? positiveIntOrNull(local['maxConcurrent'])
    ?? (enabled ? 1 : null);
  const nimMaxConcurrent = positiveIntOrNull(rawObj['nimMaxConcurrent'])
    ?? positiveIntOrNull(nim['maxConcurrent'])
    ?? (enabled ? 2 : null);
  const kimiMaxConcurrent = positiveIntOrNull(rawObj['kimiMaxConcurrent'])
    ?? positiveIntOrNull(kimi['maxConcurrent'])
    ?? (enabled ? 2 : null);

  return {
    enabled,
    profile: enabled ? 'resource-control' : 'off',
    fillQueueToSlots: enabled && rawObj['fillQueueToSlots'] !== false,
    stalePendingTtlHours: pendingPolicy.stalePendingTtlHours,
    maxSlotsPerBackend,
    caps: {
      localMaxConcurrent,
      nimMaxConcurrent,
      kimiMaxConcurrent,
    },
    flags: {
      gateway: enabled || fabric['gateway'] === true,
      resourceAware: enabled || fabric['resourceAware'] === true,
      concurrentDispatch: enabled || fabric['concurrentDispatch'] === true,
      workhorseDispatch: enabled || fabric['workhorseDispatch'] === true,
    },
  };
}

/**
 * Return an effective cfg where the production velocity profile is materialized
 * as ordinary Foundry/Fabric fields. This keeps downstream routing modules
 * simple and preserves flag-off behavior when the profile is absent.
 */
export function applyProductionVelocityProfile(cfg: AshlrConfig): AshlrConfig {
  const profile = resolveProductionVelocityProfile(cfg);
  if (!profile.enabled) return cfg;

  const foundry = cfg.foundry ?? {};
  const fabric = foundry.fabric ?? {};
  const local = foundry.local ?? {};
  const nim = foundry.nim ?? {};
  const foundryRecord = foundry as Record<string, unknown>;
  const kimi = asRecord(foundryRecord['kimi']) ?? {};

  return {
    ...cfg,
    foundry: {
      ...foundry,
      fabric: {
        ...fabric,
        gateway: true,
        resourceAware: true,
        concurrentDispatch: true,
        workhorseDispatch: true,
        maxSlotsPerBackend: profile.maxSlotsPerBackend,
      },
      local: {
        ...local,
        ...(profile.caps.localMaxConcurrent !== null
          ? { maxConcurrent: profile.caps.localMaxConcurrent }
          : {}),
      },
      nim: {
        ...nim,
        ...(profile.caps.nimMaxConcurrent !== null
          ? { maxConcurrent: profile.caps.nimMaxConcurrent }
          : {}),
      },
      kimi: {
        ...kimi,
        ...(profile.caps.kimiMaxConcurrent !== null
          ? { maxConcurrent: profile.caps.kimiMaxConcurrent }
          : {}),
      },
    } as AshlrConfig['foundry'],
  };
}

export function availableSlotsForResourceSnapshot(
  snapshot: ResourceSnapshot,
  maxSlotsPerBackend: number,
): number {
  let total = 0;
  let hasBuiltin = false;
  for (const state of snapshot.backends) {
    if (state.backend === 'builtin') hasBuiltin = true;
    total += slotsForBackendState(state, Math.max(1, Math.floor(maxSlotsPerBackend)));
  }
  if (!hasBuiltin) {
    total += Math.max(1, Math.floor(maxSlotsPerBackend));
  }
  return Math.max(0, total);
}

export function daemonQueueSelectionLimit(input: DaemonQueueSelectionInput): number {
  if (input.backlogItems <= 0) return 0;
  const minPerItemUsd = typeof input.minPerItemUsd === 'number' && input.minPerItemUsd > 0
    ? input.minPerItemUsd
    : 0.01;
  const maxByBudget = Math.max(1, Math.floor(input.remainingBudgetUsd / minPerItemUsd));
  const base = Math.max(1, Math.floor(input.perTickItems));
  const availableSlots = typeof input.availableSlots === 'number' && Number.isFinite(input.availableSlots)
    ? Math.max(0, Math.floor(input.availableSlots))
    : 0;
  const desired = input.fillQueueToSlots && availableSlots > base ? availableSlots : base;
  return Math.min(desired, maxByBudget, input.backlogItems);
}
