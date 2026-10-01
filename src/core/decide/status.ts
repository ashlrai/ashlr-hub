/**
 * decide/status.ts — the numbers behind `ashlr jev status`, the Resources
 * "Jev" card and the Usage panel: decisions today by kind, average
 * confidence, fallback rate, estimated cost, latency. Reads the ledger only;
 * never calls the API; never throws.
 */

import type { AshlrConfig } from '../types.js';
import { typeSafeAvailable, TYPESAFE_DISABLE_ENV } from '../classify/typesafe-client.js';
import { JEV_DISABLE_ENV, jevKilledByEnv, localDay, readJevConfig, readLedger, summarizeByKind, calledSum, validTokenCount } from './ledger.js';
import type { DecisionRecord, JevStatus } from './types.js';

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function classifierKilled(): boolean {
  const raw = process.env[TYPESAFE_DISABLE_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function jevStatusFromRecords(
  records: readonly DecisionRecord[],
  meta: { enabled: boolean; keyed: boolean; disabledBy?: string; day: string; dailyCallBudget: number | null; disabledKinds: JevStatus['disabledKinds'] },
): JevStatus {
  const called = records.filter((r) => r.called);
  const answered = records.filter((r) => typeof r.jevConfidence === 'number');
  const jev = records.filter((r) => r.path === 'jev').length;
  return {
    enabled: meta.enabled,
    keyed: meta.keyed,
    ...(meta.disabledBy ? { disabledBy: meta.disabledBy } : {}),
    day: meta.day,
    decisionsToday: records.length,
    callsToday: called.length,
    dailyCallBudget: meta.dailyCallBudget,
    inputTokensToday: calledSum(records, 'inputTokens'),
    outputTokensToday: calledSum(records, 'outputTokens'),
    estCostUsdToday: calledSum(records, 'estCostUsd'),
    usageCoverage: {
      reportedCalls: called.filter((r) => validTokenCount(r.inputTokens) && validTokenCount(r.outputTokens)).length,
      unknownCalls: called.filter((r) => !validTokenCount(r.inputTokens) || !validTokenCount(r.outputTokens)).length,
    },
    costCoverage: {
      pricedCalls: called.filter((r) => typeof r.estCostUsd === 'number' && Number.isFinite(r.estCostUsd) && r.estCostUsd >= 0).length,
      unknownCalls: called.filter((r) => typeof r.estCostUsd !== 'number' || !Number.isFinite(r.estCostUsd) || r.estCostUsd < 0).length,
      source: 'recorded-estimates',
    },
    lastSuccessfulCallAt: called.filter((r) => typeof r.jevConfidence === 'number' && Number.isFinite(Date.parse(r.ts)))
      .map((r) => r.ts).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    fallbackRateToday: records.length ? (records.length - jev) / records.length : 0,
    avgConfidenceToday: mean(answered.map((r) => r.jevConfidence!)),
    avgLatencyMsToday: mean(called.map((r) => r.durationMs)),
    byKind: summarizeByKind(records),
    disabledKinds: meta.disabledKinds,
  };
}

/** Status for one local day (default today). */
export function jevStatus(cfg: AshlrConfig = {} as AshlrConfig, day: string = localDay()): JevStatus {
  const jc = readJevConfig();
  let disabledBy: string | undefined;
  if (jevKilledByEnv()) disabledBy = `${JEV_DISABLE_ENV} is set`;
  else if (classifierKilled()) disabledBy = `${TYPESAFE_DISABLE_ENV} is set`;
  else if (!jc.enabled) disabledBy = 'jev/config.json enabled=false';
  let keyed = false;
  try {
    keyed = !classifierKilled() && typeSafeAvailable(cfg);
  } catch {
    keyed = false;
  }
  return jevStatusFromRecords(readLedger(day), {
    enabled: disabledBy === undefined,
    keyed,
    ...(disabledBy ? { disabledBy } : {}),
    day,
    dailyCallBudget: jc.dailyCallBudget,
    disabledKinds: jc.disabledKinds,
  });
}
