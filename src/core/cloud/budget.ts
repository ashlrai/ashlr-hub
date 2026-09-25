/**
 * Budget view + gates (unit C1). Spend = creditsSpentAdjustmentUsd + sum of
 * estimatedCostUsd over tasks that reached `running` or later (failed
 * launches cost nothing). "Today" = the operator's local calendar day.
 */
import type { CloudBudgetV1, CloudBudgetView, CloudTaskV1 } from './types.js';
import { notImplemented } from './_stub.js';

export function cloudBudgetView(_tasks: readonly CloudTaskV1[], _budget: CloudBudgetV1, _now: Date): CloudBudgetView { return notImplemented('cloudBudgetView'); }
