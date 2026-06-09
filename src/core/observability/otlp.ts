/**
 * core/observability/otlp.ts — M19 OTLP/HTTP-JSON trace builder.
 *
 * Pure, dependency-free helpers that turn a completed run/swarm into:
 *   - GenAiSpan[]  (spansFromRun / spansFromSwarm) — METADATA ONLY
 *   - an OTLP/HTTP-JSON trace payload (buildGenAiTrace) following the
 *     resourceSpans -> scopeSpans -> spans nesting, with GenAI
 *     semantic-convention attributes.
 *
 * PRIVACY INVARIANT (enforced here, asserted by m19.otlp.test.ts):
 *   Span attributes carry ONLY metadata — model id, token counts, cost, ids,
 *   provider, tier, status, duration. NEVER prompt/response text, sub-goal
 *   text, tool args, file contents, project paths, or secrets. The span
 *   `name` is the task id (a stable metadata identifier), never the goal.
 *
 * This module is imported statically by telemetry-sink.ts (buildGenAiTrace)
 * and dynamically by orchestrator.ts / swarm/runner.ts (spansFromRun /
 * spansFromSwarm). It must stay free of side effects and runtime deps.
 */

import { randomBytes } from 'node:crypto';
import type { GenAiSpan, RunState, SwarmRun } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Instrumentation scope advertised in scopeSpans[].scope. */
const SCOPE_NAME = 'ashlr-hub';
const SCOPE_VERSION = '0.1.0';

/** Nanoseconds per millisecond (OTLP timestamps are unix-nanoseconds). */
const NS_PER_MS = 1_000_000n;

// ---------------------------------------------------------------------------
// OTLP value wrappers (typed by JSON value kind)
// ---------------------------------------------------------------------------

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  /** 32 lowercase hex chars (16 random bytes). Required by the OTLP data model. */
  traceId: string;
  /** 16 lowercase hex chars (8 random bytes). Required by the OTLP data model. */
  spanId: string;
  /** OTLP span kind. 1=INTERNAL — GenAI calls are internal work units. */
  kind: number;
  name: string;
  /** Decimal string of unix-nanoseconds. */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** OTLP status object. code 0=unset, 1=ok(unused), 2=error. */
  status: { code: number };
  attributes: OtlpAttribute[];
}

interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: OtlpScopeSpans[];
}

export interface OtlpTrace {
  resourceSpans: OtlpResourceSpans[];
}

// ---------------------------------------------------------------------------
// Internal attribute helpers
// ---------------------------------------------------------------------------

function strAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** Integer attribute — OTLP intValue is a decimal string per the JSON mapping. */
function intAttr(key: string, value: number): OtlpAttribute {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { key, value: { intValue: String(n) } };
}

function doubleAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: Number.isFinite(value) ? value : 0 } };
}

/**
 * Convert an ISO timestamp to a unix-nanosecond decimal string. Invalid or
 * missing timestamps fall back to 0 so the builder never throws.
 */
function isoToUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '0';
  return (BigInt(ms) * NS_PER_MS).toString();
}

/** Map a terminal status string to an OTLP status code (2=error else unset). */
function statusCode(status: string): number {
  return status === 'failed' || status === 'aborted' ? 2 : 0;
}

/** OTLP SpanKind.INTERNAL — these are internal work units, not RPC client spans. */
const SPAN_KIND_INTERNAL = 1;

/** Random 16-byte trace id as 32 lowercase hex chars (OTLP-required identifier). */
function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Random 8-byte span id as 16 lowercase hex chars (OTLP-required identifier). */
function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Public: buildGenAiTrace
// ---------------------------------------------------------------------------

/**
 * Build a valid OTLP/HTTP-JSON trace from GenAiSpan metadata.
 *
 * Shape: { resourceSpans: [ { resource, scopeSpans: [ { scope, spans } ] } ] }.
 * Every span carries GenAI semantic-convention attributes plus ashlr.* ids.
 * Handles an empty `spans` array gracefully (one resourceSpans entry with an
 * empty spans list). METADATA ONLY — never content.
 */
export function buildGenAiTrace(spans: GenAiSpan[]): OtlpTrace {
  // One trace id per emitted batch; per-span ids below. Random bytes carry no
  // content — still METADATA ONLY. Required by the OTLP data model and by
  // backends (Tempo/Jaeger/Honeycomb) that drop zero/empty-id spans.
  const traceId = newTraceId();

  const otlpSpans: OtlpSpan[] = spans.map((s) => {
    const start = isoToUnixNano(s.startTs);
    let end = isoToUnixNano(s.endTs);
    // Guarantee end >= start even if timestamps are equal/inverted.
    if (BigInt(end) < BigInt(start)) end = start;

    return {
      traceId,
      spanId: newSpanId(),
      kind: SPAN_KIND_INTERNAL,
      // name is the task id (metadata identifier) — never goal/result text.
      name: s.name,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      status: { code: statusCode(s.status) },
      attributes: [
        strAttr('gen_ai.system', s.provider),
        strAttr('gen_ai.request.model', s.model),
        intAttr('gen_ai.usage.input_tokens', s.tokensIn),
        intAttr('gen_ai.usage.output_tokens', s.tokensOut),
        doubleAttr('gen_ai.usage.cost_usd', s.estCostUsd),
        strAttr('ashlr.run.id', s.runId),
        strAttr('ashlr.provider', s.provider),
        strAttr('ashlr.tier', s.tier),
        strAttr('ashlr.status', s.status),
      ],
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr('service.name', SCOPE_NAME),
            strAttr('telemetry.sdk.name', SCOPE_NAME),
            strAttr('telemetry.sdk.language', 'nodejs'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Provider/model/tier derivation (metadata only)
// ---------------------------------------------------------------------------

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'bedrock', 'azure']);

/** Cloud vs local tier, inferred from the provider id (metadata only). */
function tierForProvider(provider: string): string {
  return CLOUD_PROVIDERS.has(provider.toLowerCase()) ? 'cloud' : 'local';
}

/**
 * A coarse model label derived from the provider — we never expose the actual
 * routed model name when it isn't tracked per-task, only a metadata stand-in.
 * The provider itself is metadata and safe to surface.
 */
function modelForProvider(provider: string): string {
  return provider || 'unknown';
}

// ---------------------------------------------------------------------------
// Public: spansFromRun
// ---------------------------------------------------------------------------

/**
 * Derive one GenAiSpan per RunTask that has usage. Pure — does not mutate the
 * run. Span name is the task id (metadata), NEVER the sub-goal text. No
 * result/goal text is read into the span. Timestamps fall back to the run's
 * createdAt/updatedAt window (per-task timestamps are not tracked).
 */
export function spansFromRun(run: RunState): GenAiSpan[] {
  const provider = run.provider || 'unknown';
  const model = modelForProvider(provider);
  const tier = tierForProvider(provider);
  const startTs = run.createdAt;
  const endTs = run.updatedAt;

  const spans: GenAiSpan[] = [];
  for (const task of run.tasks) {
    if (!task.usage) continue;
    spans.push({
      name: task.id, // metadata id, NOT task.goal
      runId: run.id,
      model,
      provider,
      tier,
      tokensIn: task.usage.tokensIn,
      tokensOut: task.usage.tokensOut,
      estCostUsd: task.usage.estCostUsd,
      status: task.status,
      startTs,
      endTs,
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Public: spansFromSwarm
// ---------------------------------------------------------------------------

/**
 * Derive one GenAiSpan per SwarmTaskRun that has usage. Pure — does not mutate
 * the swarm. Span name is the task id (metadata), NEVER goal/result/project
 * text. SwarmRun has no per-run provider, so provider/model/tier use neutral
 * metadata defaults. Timestamps fall back to the swarm's createdAt/updatedAt.
 */
export function spansFromSwarm(swarm: SwarmRun): GenAiSpan[] {
  const provider = 'ashlr-swarm';
  const model = 'swarm';
  const tier = 'local';
  const startTs = swarm.createdAt;
  const endTs = swarm.updatedAt;

  const spans: GenAiSpan[] = [];
  for (const task of swarm.tasks) {
    if (!task.usage) continue;
    spans.push({
      name: task.id, // metadata id, NOT goal/result/project
      runId: swarm.id,
      model,
      provider,
      tier,
      tokensIn: task.usage.tokensIn,
      tokensOut: task.usage.tokensOut,
      estCostUsd: task.usage.estCostUsd,
      status: task.status,
      startTs,
      endTs,
    });
  }
  return spans;
}
