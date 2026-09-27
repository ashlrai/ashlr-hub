/**
 * `ashlr jev` — the Jev (TypeSafe AI System One) decision layer (3.15).
 *
 *   ashlr jev status [--json] [--day YYYY-MM-DD]
 *       Is Jev keyed and on, today's decisions by kind, avg confidence,
 *       fallback rate, est. cost, latency. Reads the local ledger only.
 *   ashlr jev test "<text>" [--kind <kind>] [--json]
 *       Run one live decision on <text> and show which path won (Jev or the
 *       deterministic rule), the label, confidence and latency. Makes ONE paid
 *       call when keyed (never cached, so it reflects the live model).
 *
 * The key is never read or printed here: it is resolved inside the TypeSafe
 * client (phantom vault, TYPESAFE_API_KEY, or the 0600
 * ~/.ashlr/secrets/typesafe.env) and used for one Authorization header.
 */

import type { AshlrConfig } from '../core/types.js';
import type { Decision, JevStatus } from '../core/decide/types.js';

export const JEV_TEST_KINDS = ['intent', 'task-class', 'engine-error', 'lane', 'claim', 'triage'] as const;
export type JevTestKind = (typeof JEV_TEST_KINDS)[number];

export interface JevCliDeps {
  loadConfig(): AshlrConfig;
  status(cfg: AshlrConfig, day?: string): JevStatus;
  test(kind: JevTestKind, text: string, cfg: AshlrConfig): Promise<Decision<unknown>>;
  out(line: string): void;
  err(line: string): void;
}

class UsageError extends Error {}

const HELP = [
  'Usage: ashlr jev <status|test|help>',
  '  status [--json] [--day YYYY-MM-DD]       Jev on/keyed, today\'s decisions by kind, confidence, fallback rate, est. cost.',
  `  test "<text>" [--kind ${JEV_TEST_KINDS.join('|')}] [--json]`,
  '                                           One live decision (one paid call when keyed); shows which path won.',
  'Kill switch: ASHLR_JEV_DISABLE=1, or {"enabled": false} in ~/.ashlr/jev/config.json.',
].join('\n');

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
  args.splice(i, 2);
  return value;
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function conf(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(2);
}

function usd(v: number): string {
  return v <= 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}

function ms(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}ms`;
}

export function renderJevStatus(s: JevStatus): string[] {
  const state = !s.enabled ? `OFF (${s.disabledBy ?? 'kill switch'})` : s.keyed ? 'ON' : 'NOT SET UP (no TypeSafe key — every decision uses its deterministic rule)';
  const lines = [
    `Jev: ${state}`,
    `Today (${s.day}): ${s.decisionsToday} decisions · ${s.callsToday}/${s.dailyCallBudget} paid calls · ${pct(s.fallbackRateToday)} fell back · avg confidence ${conf(s.avgConfidenceToday)} · avg latency ${ms(s.avgLatencyMsToday)} · est. ${usd(s.estCostUsdToday)} (${s.inputTokensToday} in / ${s.outputTokensToday} out tokens)`,
  ];
  if (s.disabledKinds.length > 0) lines.push(`Disabled kinds: ${s.disabledKinds.join(', ')}`);
  if (s.byKind.length > 0) {
    lines.push('', 'kind                  decisions  jev  fallback  avg-conf  latency  est-cost  top fallback reasons');
    for (const k of s.byKind) {
      lines.push([
        k.kind.padEnd(21),
        String(k.decisions).padStart(9),
        String(k.jev).padStart(4),
        pct(k.fallbackRate).padStart(9),
        conf(k.avgConfidence).padStart(9),
        ms(k.avgLatencyMs).padStart(8),
        usd(k.estCostUsd).padStart(9),
        ` ${k.topFallbackReasons.map((r) => `${r.reason}×${r.count}`).join(', ')}`,
      ].join(' '));
    }
  }
  lines.push('', 'Cost is an estimate at placeholder per-token rates; set real ones in ~/.ashlr/jev/config.json.');
  return lines;
}

export function renderDecision(d: Decision<unknown>): string[] {
  const value = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);
  const lines = [
    `decision: ${d.kind} → ${value}`,
    `path: ${d.path === 'jev' ? 'jev (cleared the gate)' : `fallback — ${d.reason ?? 'deterministic'}`}`,
    `confidence: ${conf(d.confidence)} (threshold ${conf(d.threshold)})`,
  ];
  if (d.jevLabel !== undefined) lines.push(`jev said: ${d.jevLabel} @ ${conf(d.jevConfidence)}`);
  if (d.model) lines.push(`model: ${d.model}`);
  lines.push(`latency: ${d.durationMs}ms${d.cached ? ' (cached)' : ''}`);
  return lines;
}

async function defaultDeps(): Promise<JevCliDeps> {
  const [{ loadConfigReadOnly }, status, intent, taskClass, lane, triage, engine, claims] = await Promise.all([
    import('../core/config.js'),
    import('../core/decide/status.js'),
    import('../core/decide/intent.js'),
    import('../core/decide/task-class.js'),
    import('../core/decide/lane.js'),
    import('../core/decide/triage.js'),
    import('../core/classify/engine-errors.js'),
    import('../core/classify/completion-claims.js'),
  ]);
  return {
    loadConfig: () => loadConfigReadOnly(),
    status: (cfg, day) => status.jevStatus(cfg, day),
    test: async (kind, text, cfg) => {
      const base = { cfg, cache: false } as const;
      switch (kind) {
        case 'intent': return intent.classifyOperatorIntent(text, {}, base);
        case 'task-class': return taskClass.labelTaskClass(text, base);
        case 'lane': return lane.chooseLane({ title: text }, {}, base);
        case 'triage': return triage.triageTrigger({ source: 'issue', title: text }, {}, base);
        case 'engine-error': {
          const c = await engine.classifyEngineError(text, cfg);
          return {
            kind: 'engine-error', value: c.kind, path: c.source === 'classifier' ? 'jev' : 'fallback',
            confidence: c.confidence, threshold: engine.ENGINE_ERROR_CONFIDENCE_THRESHOLD, cached: false,
            ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
            ...(c.classifierKind ? { jevLabel: c.classifierKind } : {}),
            ...(c.classifierConfidence !== undefined ? { jevConfidence: c.classifierConfidence } : {}),
            ...(c.model ? { model: c.model } : {}),
            durationMs: c.classifierMs,
          } as Decision<unknown>;
        }
        case 'claim': {
          const c = await claims.classifyCompletionClaim(text, cfg);
          return {
            kind: 'completion-claim', value: c.claim, path: c.source === 'classifier' ? 'jev' : 'fallback',
            confidence: c.confidence, threshold: claims.COMPLETION_CLAIM_CONFIDENCE_THRESHOLD, cached: false,
            ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
            durationMs: c.classifierMs,
          } as Decision<unknown>;
        }
      }
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

export async function runJevCli(argv: readonly string[], injected?: Partial<JevCliDeps>): Promise<number> {
  const args = [...argv];
  const sub = args.shift() ?? 'status';
  const deps: JevCliDeps = injected && typeof injected.status === 'function' && typeof injected.test === 'function'
    && typeof injected.loadConfig === 'function' && typeof injected.out === 'function' && typeof injected.err === 'function'
    ? injected as JevCliDeps
    : { ...(await defaultDeps()), ...injected };
  try {
    switch (sub) {
      case 'help':
      case '--help':
      case '-h':
        deps.out(HELP);
        return 0;
      case 'status': {
        const json = takeFlag(args, '--json');
        const day = takeOption(args, '--day');
        if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UsageError('--day must be YYYY-MM-DD.');
        if (args.length > 0) throw new UsageError(`unexpected: ${args.join(' ')}`);
        const s = deps.status(deps.loadConfig(), day);
        if (json) deps.out(JSON.stringify(s, null, 2));
        else for (const line of renderJevStatus(s)) deps.out(line);
        return 0;
      }
      case 'test': {
        const json = takeFlag(args, '--json');
        const kindRaw = takeOption(args, '--kind') ?? 'intent';
        if (!(JEV_TEST_KINDS as readonly string[]).includes(kindRaw)) {
          throw new UsageError(`--kind must be one of ${JEV_TEST_KINDS.join(', ')}.`);
        }
        const text = args.join(' ').trim();
        if (!text) throw new UsageError('ashlr jev test "<text>" [--kind …] — the text to classify is required.');
        const d = await deps.test(kindRaw as JevTestKind, text, deps.loadConfig());
        if (json) {
          // `answers` can be large and is not needed to judge the path; omit it.
          const { answers: _answers, ...rest } = d;
          deps.out(JSON.stringify(rest, null, 2));
        } else {
          for (const line of renderDecision(d)) deps.out(line);
        }
        return 0;
      }
      default:
        throw new UsageError(`unknown verb "${sub}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`ashlr jev: ${error.message}`);
      deps.err(HELP);
      return 2;
    }
    deps.err(`ashlr jev: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
