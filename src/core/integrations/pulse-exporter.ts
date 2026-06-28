/**
 * core/integrations/pulse-exporter.ts — Phase E (Pulse Map fleet bridge).
 *
 * The LOCAL half of "cloud orchestrates, local executes". Two responsibilities,
 * both opt-in and both NEVER-throw from their public surface:
 *
 *  1. EXPORT — emit fleet activity as OTLP/HTTP-JSON spans to Pulse:
 *       POST <PULSE_URL>/api/otlp/v1/traces
 *       Authorization: Bearer <PAT>
 *       Body: { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }
 *     Spans carry source 'ashlr-fleet' (via `ashlr.source`) and the fleet
 *     attribute set the Pulse ingest understands (see ashlr-pulse
 *     server/src/lib/otel-genai.ts):
 *       ashlr.fleet.event   ∈ tick | proposal | merge | decline   (+ deps)
 *       ashlr.fleet.outcome   free-form outcome string
 *       ashlr.fleet.owner     teammate identity (cfg.user) — team attribution
 *       ashlr.fleet.repo      repo basename / full name
 *       claude.repo.name      repo full name (so the cloud can resolve a repo node)
 *     Dependency edges (from dep-parser.ts) ship as `deps` spans carrying the
 *     edge as metadata attributes — NEVER file contents.
 *
 *  2. POLL — pull fleet_command work the cloud has queued (no inbound socket):
 *       GET   <PULSE_URL>/api/fleet/commands?status=pending   (read-scoped PAT)
 *       PATCH <PULSE_URL>/api/fleet/commands/<id>             (status writeback)
 *     The cloud only ever REQUESTS/APPROVES; the daemon claims a command,
 *     executes locally, and PATCHes the outcome (metadata-only) back.
 *
 * WIRE SHAPE is modelled on the Rust collector
 *   ashlr-pulse/agent/src/span.rs + otlp.rs
 * and the existing M89 emitter core/fleet/pulse-export.ts — this module is the
 * integration-layer, daemon-wireable entry point (house style: no-throw public
 * API, typed, bounded timeouts) that the daemon loop calls.
 *
 * SAFETY / PRIVACY (non-negotiable):
 *   - NEVER throws from any exported function. Telemetry must never crash the fleet.
 *   - PAT is read from config-supplied value or env ONLY; NEVER hardcoded,
 *     printed, or logged. We log presence, never the value.
 *   - Config-gated + opt-in: no-op (returns a disabled result) when
 *     cfg.pulse?.enabled is falsy or no PAT is available.
 *   - METADATA ONLY: span/command payloads carry ids, counts, names, outcomes —
 *     never prompts, completions, code, file contents, or diffs.
 *   - Bounded fetch timeouts so a hung server never blocks a tick.
 */

import type { DepEdge } from './dep-parser.js';

// ---------------------------------------------------------------------------
// Config surface (structural subset of AshlrConfig — keeps this module
// decoupled from the full types tree, matching the M89 exporter's pattern).
// ---------------------------------------------------------------------------

export interface PulseExporterConfig {
  pulse?: {
    /** Master opt-in. No telemetry or polling happens when falsy. */
    enabled?: boolean;
    /** OTLP/API base URL. Default 'http://localhost:3000'. */
    endpoint?: string;
  };
  /** M109 identity — carried as `ashlr.fleet.owner` for team attribution. */
  user?: {
    id?: string;
    name?: string;
  };
}

// ---------------------------------------------------------------------------
// OTLP wire types (mirrors agent/src/span.rs; intValue is a decimal STRING
// per the OTLP/JSON int64 mapping — the same shape the Pulse ingest expects).
// ---------------------------------------------------------------------------

type OtlpValue = { stringValue: string } | { intValue: string };

interface OtlpAttr {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  /** 32 lowercase hex chars. */
  traceId: string;
  /** 16 lowercase hex chars. */
  spanId: string;
  name: string;
  /** OTLP SpanKind.CLIENT (3) — matches the Rust collector. */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
}

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttr[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Public event model
// ---------------------------------------------------------------------------

/** The fleet event kinds the cloud ingest recognises for `ashlr.fleet.event`. */
export type FleetEvent = 'tick' | 'proposal' | 'merge' | 'decline';

/** A single fleet event to export. METADATA ONLY. */
export interface FleetSpanInput {
  event: FleetEvent;
  /** Stable id for deterministic dedup (proposal id, tick ts, etc.). */
  refId: string;
  /** Outcome string (e.g. 'applied' | 'rejected' | 'pending' | a tick reason). */
  outcome: string;
  /** Repo full name (owner/name) — resolves a repo node in the cloud graph. */
  repo?: string | null;
  /** Engine system label for gen_ai.system (e.g. 'claude' | 'codex' | 'builtin'). */
  engine?: string | null;
  /** ISO start; defaults to now. */
  startTs?: string;
  /** ISO end; defaults to startTs. */
  endTs?: string;
}

// ---------------------------------------------------------------------------
// Fleet command (poller) — mirrors ashlr-pulse graph-types.ts FleetCommand,
// kept structural so this repo never imports the cloud package.
// ---------------------------------------------------------------------------

export type FleetCommandKind =
  | 'assign_goal'
  | 'approve_proposal'
  | 'reject_proposal'
  | 'enroll_repo';

export type FleetCommandStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface FleetCommand {
  id: string;
  orgId: string;
  kind: FleetCommandKind;
  target: string | null;
  payload: Record<string, unknown>;
  status: FleetCommandStatus;
  createdBy: string | null;
  claimedBy: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NAME = 'ashlr-fleet';
const SCOPE_VERSION = '0.1.0';
const DEFAULT_ENDPOINT = 'http://localhost:3000';
const FETCH_TIMEOUT_MS = 10_000;
const SPAN_KIND_CLIENT = 3; // matches agent/src/span.rs

/** Env var that supplies the PAT. NEVER logged or printed. */
const PAT_ENV = 'ASHLR_PULSE_PAT';
/** Optional separate read-scoped PAT for the command poller (falls back to PAT_ENV). */
const READ_PAT_ENV = 'ASHLR_PULSE_READ_PAT';

// ---------------------------------------------------------------------------
// Internal helpers — all no-throw
// ---------------------------------------------------------------------------

function endpointBase(cfg: PulseExporterConfig): string {
  return (cfg.pulse?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/** Resolve the ingest PAT (explicit arg → env). Returns null when absent. */
function resolvePat(explicit?: string): string | null {
  const pat = explicit ?? process.env[PAT_ENV];
  return pat && pat.length > 0 ? pat : null;
}

/** Resolve the read-scoped PAT for polling (READ env → ingest PAT → explicit). */
function resolveReadPat(explicit?: string): string | null {
  const pat = explicit ?? process.env[READ_PAT_ENV] ?? process.env[PAT_ENV];
  return pat && pat.length > 0 ? pat : null;
}

function strAttr(key: string, value: string): OtlpAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpAttr {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { key, value: { intValue: String(n) } };
}

/** ISO → unix-nanoseconds decimal string (OTLP timestamps). Never throws. */
function toNano(iso?: string): string {
  const ms = iso ? Date.parse(iso) : Date.now();
  if (Number.isNaN(ms)) return String(Date.now() * 1_000_000);
  return String(ms * 1_000_000);
}

// ── Deterministic ids (FNV-1a; pure arithmetic — same scheme as the M89
//    emitter so re-exports dedup identically on (user_id, span_id)). ──────────

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function deriveSpanId(refId: string, event: string): string {
  const key = `${event}:${refId}`;
  const lo = fnv1a32(key);
  const hi = fnv1a32(`hi:${key}`);
  return lo.toString(16).padStart(8, '0') + hi.toString(16).padStart(8, '0');
}

function deriveTraceId(spanId: string): string {
  return fnv1a32(`trace:${spanId}`).toString(16).padStart(8, '0').repeat(4);
}

function resolveOwner(cfg: PulseExporterConfig): string | undefined {
  return cfg.user?.id ?? cfg.user?.name ?? undefined;
}

/**
 * Best-effort authenticated fetch with a bounded timeout. Returns the Response
 * on completion (any status) or null on network error / timeout. NEVER throws.
 */
async function safeFetch(
  url: string,
  init: RequestInit & { pat?: string },
): Promise<Response | null> {
  const { pat, headers, ...rest } = init;
  try {
    return await fetch(url, {
      ...rest,
      headers: {
        ...(headers ?? {}),
        ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Span builders (pure)
// ---------------------------------------------------------------------------

/** Wrap spans into a complete, POST-ready OTLP payload. */
function wrapSpans(spans: OtlpSpan[]): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr('service.name', SCOPE_NAME),
            strAttr('telemetry.sdk.language', 'nodejs'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans,
          },
        ],
      },
    ],
  };
}

/** Build one OTLP span for a fleet event. Pure; METADATA ONLY. */
function buildFleetSpan(input: FleetSpanInput, owner?: string): OtlpSpan {
  const spanId = deriveSpanId(input.refId, `fleet.${input.event}`);
  const traceId = deriveTraceId(spanId);
  const startNano = toNano(input.startTs);
  const endNano = input.endTs ? toNano(input.endTs) : startNano;

  const attrs: OtlpAttr[] = [
    strAttr('ashlr.source', 'ashlr-fleet'),
    strAttr('gen_ai.system', input.engine && input.engine.length > 0 ? input.engine : 'builtin'),
    intAttr('gen_ai.usage.input_tokens', 0),
    intAttr('gen_ai.usage.output_tokens', 0),
    strAttr('ashlr.fleet.event', input.event),
    strAttr('ashlr.fleet.outcome', input.outcome),
    strAttr('ashlr.fleet.ref_id', input.refId),
  ];
  if (input.repo) {
    attrs.push(strAttr('ashlr.fleet.repo', input.repo));
    // claude.repo.name lets the cloud resolve a repo node directly.
    attrs.push(strAttr('claude.repo.name', input.repo));
  }
  if (owner) attrs.push(strAttr('ashlr.fleet.owner', owner));

  return {
    traceId,
    spanId,
    name: `fleet.${input.event}`,
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: attrs,
  };
}

/**
 * Build one OTLP span per dependency edge. The edge is encoded as metadata
 * attributes (ashlr.dep.*) carried on a `deps`-event fleet span so it rides the
 * existing OTLP transport. NEVER carries file contents.
 *
 * Span/dedup id is derived from (repo, package name, depKind) so re-shipping the
 * same manifest produces identical span ids.
 */
function buildDepSpan(repoFullName: string, edge: DepEdge, owner?: string): OtlpSpan {
  const refId = `${repoFullName}|${edge.depKind}|${edge.dst}`;
  const spanId = deriveSpanId(refId, 'fleet.deps');
  const traceId = deriveTraceId(spanId);
  const nano = toNano();

  const attrs: OtlpAttr[] = [
    strAttr('ashlr.source', 'ashlr-fleet'),
    strAttr('gen_ai.system', 'builtin'),
    intAttr('gen_ai.usage.input_tokens', 0),
    intAttr('gen_ai.usage.output_tokens', 0),
    strAttr('ashlr.fleet.event', 'deps'),
    strAttr('ashlr.fleet.outcome', 'parsed'),
    strAttr('ashlr.fleet.repo', repoFullName),
    strAttr('claude.repo.name', repoFullName),
    strAttr('ashlr.fleet.ref_id', refId),
    // Edge payload — canonical cloud node ids + metadata. NEVER file contents.
    strAttr('ashlr.dep.src', edge.src),
    strAttr('ashlr.dep.dst', edge.dst),
    strAttr('ashlr.dep.kind', edge.kind), // 'depends_on'
    strAttr('ashlr.dep.ecosystem', edge.ecosystem),
    strAttr('ashlr.dep.name', edge.name),
    strAttr('ashlr.dep.dep_kind', edge.depKind),
  ];
  if (edge.range) attrs.push(strAttr('ashlr.dep.range', edge.range));
  if (owner) attrs.push(strAttr('ashlr.fleet.owner', owner));

  return {
    traceId,
    spanId,
    name: 'fleet.deps',
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: nano,
    endTimeUnixNano: nano,
    attributes: attrs,
  };
}

// ---------------------------------------------------------------------------
// Public: build helpers (pure, exported for dry-run / testing)
// ---------------------------------------------------------------------------

/** Build a POST-ready OTLP payload from fleet events. Pure; NEVER throws. */
export function buildFleetPayload(
  events: FleetSpanInput[],
  cfg: PulseExporterConfig,
): OtlpPayload {
  const owner = resolveOwner(cfg);
  const spans: OtlpSpan[] = [];
  for (const ev of events) {
    try {
      spans.push(buildFleetSpan(ev, owner));
    } catch {
      /* skip a malformed event rather than fail the batch */
    }
  }
  return wrapSpans(spans);
}

/** Build a POST-ready OTLP payload from a dependency edge list. Pure; NEVER throws. */
export function buildDepPayload(
  repoFullName: string,
  edges: DepEdge[],
  cfg: PulseExporterConfig,
): OtlpPayload {
  const owner = resolveOwner(cfg);
  const spans: OtlpSpan[] = [];
  for (const edge of edges) {
    try {
      spans.push(buildDepSpan(repoFullName, edge, owner));
    } catch {
      /* skip a malformed edge */
    }
  }
  return wrapSpans(spans);
}

// ---------------------------------------------------------------------------
// Public: export API (opt-in, no-throw)
// ---------------------------------------------------------------------------

/** Result of an export attempt. `skipped` distinguishes opt-out from failure. */
export interface ExportResult {
  ok: boolean;
  /** true when export was a no-op (disabled / no PAT / no spans / dry-run). */
  skipped: boolean;
  /** HTTP status when a request was made, else null. */
  status: number | null;
  /** Number of spans in the payload. */
  spanCount: number;
  /** Human-readable one-liner (never contains the PAT). */
  detail: string;
}

/** Internal: POST a payload to the OTLP endpoint. */
async function postOtlp(
  cfg: PulseExporterConfig,
  payload: OtlpPayload,
  opts?: { pat?: string; dryRun?: boolean },
): Promise<ExportResult> {
  const spanCount = payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;

  if (!cfg.pulse?.enabled) {
    return { ok: false, skipped: true, status: null, spanCount, detail: 'pulse export disabled (cfg.pulse.enabled is falsy)' };
  }
  if (spanCount === 0) {
    return { ok: true, skipped: true, status: null, spanCount, detail: 'nothing to export (0 spans)' };
  }

  const pat = resolvePat(opts?.pat);
  if (!pat) {
    return { ok: false, skipped: true, status: null, spanCount, detail: `${PAT_ENV} not set — skipping export (set it to enable fleet→pulse telemetry)` };
  }

  if (opts?.dryRun) {
    return { ok: true, skipped: true, status: null, spanCount, detail: `dry-run: ${spanCount} span(s) ready (not sent)` };
  }

  const url = `${endpointBase(cfg)}/api/otlp/v1/traces`;
  const res = await safeFetch(url, {
    method: 'POST',
    pat,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res) {
    return { ok: false, skipped: false, status: null, spanCount, detail: `endpoint unreachable: ${url}` };
  }
  if (res.ok) {
    return { ok: true, skipped: false, status: res.status, spanCount, detail: `exported ${spanCount} span(s) (HTTP ${res.status})` };
  }
  return { ok: false, skipped: false, status: res.status, spanCount, detail: `OTLP ingest returned HTTP ${res.status}` };
}

/**
 * Export a batch of fleet events as OTLP spans to Pulse.
 * Opt-in + no-throw. See {@link ExportResult}.
 */
export async function exportFleetEvents(
  cfg: PulseExporterConfig,
  events: FleetSpanInput[],
  opts?: { pat?: string; dryRun?: boolean },
): Promise<ExportResult> {
  try {
    return await postOtlp(cfg, buildFleetPayload(events, cfg), opts);
  } catch {
    return { ok: false, skipped: false, status: null, spanCount: events.length, detail: 'unexpected error during fleet export' };
  }
}

/**
 * Ship a repo's dependency edge list (from dep-parser.ts) to Pulse as `deps`
 * spans. METADATA ONLY — the edges carry package names + ranges, never file
 * contents. Opt-in + no-throw.
 */
export async function shipDepEdges(
  cfg: PulseExporterConfig,
  repoFullName: string,
  edges: DepEdge[],
  opts?: { pat?: string; dryRun?: boolean },
): Promise<ExportResult> {
  try {
    return await postOtlp(cfg, buildDepPayload(repoFullName, edges, cfg), opts);
  } catch {
    return { ok: false, skipped: false, status: null, spanCount: edges.length, detail: 'unexpected error during dep edge export' };
  }
}

// ---------------------------------------------------------------------------
// Public: connectivity probe
// ---------------------------------------------------------------------------

/**
 * POST a single tiny probe span to verify endpoint + PAT. NEVER throws.
 * exitCode: 0=ok, 1=error, 2=unconfigured — mirrors the M89 `pulse-test` shape.
 */
export async function pingPulse(
  cfg: PulseExporterConfig,
  opts?: { pat?: string },
): Promise<{ ok: boolean; status: number | null; label: string; exitCode: number }> {
  if (!cfg.pulse?.enabled) {
    return { ok: false, status: null, label: 'not configured (set cfg.pulse.enabled + ' + PAT_ENV + ')', exitCode: 2 };
  }
  const pat = resolvePat(opts?.pat);
  if (!pat) {
    return { ok: false, status: null, label: 'not configured (' + PAT_ENV + ' not set)', exitCode: 2 };
  }

  const probe = wrapSpans([
    buildFleetSpan(
      { event: 'tick', refId: 'probe:ashlr-fleet:connectivity', outcome: 'probe' },
      resolveOwner(cfg),
    ),
  ]);

  const url = `${endpointBase(cfg)}/api/otlp/v1/traces`;
  const res = await safeFetch(url, {
    method: 'POST',
    pat,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(probe),
  });

  if (!res) return { ok: false, status: null, label: `endpoint unreachable (${url})`, exitCode: 1 };
  if (res.ok) return { ok: true, status: res.status, label: `connected (HTTP ${res.status})`, exitCode: 0 };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, label: `${res.status} — PAT rejected (check ${PAT_ENV})`, exitCode: 1 };
  }
  return { ok: false, status: res.status, label: `HTTP ${res.status}`, exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Public: command POLLER (cloud queues → local executes)
// ---------------------------------------------------------------------------

/** Result of a poll. `commands` is empty on opt-out / failure (never throws). */
export interface PollResult {
  ok: boolean;
  skipped: boolean;
  commands: FleetCommand[];
  status: number | null;
  detail: string;
}

/**
 * Normalise an unknown server object into a FleetCommand, defensively. Returns
 * null when the object lacks a usable id (we never invent ids). NEVER throws.
 */
function coerceCommand(raw: unknown): FleetCommand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : null;
  if (!id) return null;

  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const obj = (k: string): Record<string, unknown> | null => {
    const v = o[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };

  return {
    id,
    orgId: str('orgId') ?? str('org_id') ?? '',
    kind: (str('kind') as FleetCommandKind) ?? 'assign_goal',
    target: str('target'),
    payload: obj('payload') ?? {},
    status: (str('status') as FleetCommandStatus) ?? 'pending',
    createdBy: str('createdBy') ?? str('created_by'),
    claimedBy: str('claimedBy') ?? str('claimed_by'),
    result: obj('result'),
    error: str('error'),
    createdAt: str('createdAt') ?? str('created_at') ?? new Date().toISOString(),
    claimedAt: str('claimedAt') ?? str('claimed_at'),
    completedAt: str('completedAt') ?? str('completed_at'),
  };
}

/**
 * GET pending fleet commands from the cloud queue with a read-scoped PAT.
 * Opt-in + no-throw — returns an empty command list on disabled / no PAT /
 * unreachable / non-2xx.
 *
 * @param status  Queue status filter (default 'pending').
 */
export async function pollFleetCommands(
  cfg: PulseExporterConfig,
  opts?: { pat?: string; status?: FleetCommandStatus; limit?: number },
): Promise<PollResult> {
  if (!cfg.pulse?.enabled) {
    return { ok: false, skipped: true, commands: [], status: null, detail: 'pulse polling disabled (cfg.pulse.enabled is falsy)' };
  }
  const pat = resolveReadPat(opts?.pat);
  if (!pat) {
    return { ok: false, skipped: true, commands: [], status: null, detail: `${READ_PAT_ENV}/${PAT_ENV} not set — skipping poll` };
  }

  try {
    const params = new URLSearchParams();
    params.set('status', opts?.status ?? 'pending');
    if (opts?.limit && Number.isFinite(opts.limit)) params.set('limit', String(Math.trunc(opts.limit)));
    const url = `${endpointBase(cfg)}/api/fleet/commands?${params.toString()}`;

    const res = await safeFetch(url, { method: 'GET', pat, headers: { Accept: 'application/json' } });
    if (!res) return { ok: false, skipped: false, commands: [], status: null, detail: `endpoint unreachable: ${url}` };
    if (!res.ok) return { ok: false, skipped: false, commands: [], status: res.status, detail: `poll returned HTTP ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, skipped: false, commands: [], status: res.status, detail: 'poll returned invalid JSON' };
    }

    // Accept a bare array OR { commands: [...] } / { data: [...] } wrappers.
    let items: unknown[] = [];
    if (Array.isArray(body)) {
      items = body;
    } else if (body !== null && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      for (const key of ['commands', 'data', 'items']) {
        if (Array.isArray(b[key])) {
          items = b[key] as unknown[];
          break;
        }
      }
    }

    const commands: FleetCommand[] = [];
    for (const it of items) {
      const cmd = coerceCommand(it);
      if (cmd) commands.push(cmd);
    }
    return { ok: true, skipped: false, commands, status: res.status, detail: `fetched ${commands.length} command(s)` };
  } catch {
    return { ok: false, skipped: false, commands: [], status: null, detail: 'unexpected error during poll' };
  }
}

/** Result of a command status writeback. NEVER throws. */
export interface CommandPatchResult {
  ok: boolean;
  skipped: boolean;
  status: number | null;
  detail: string;
}

/**
 * PATCH a fleet command's status back to the cloud (claim / complete / fail).
 * `result` and `error` are METADATA ONLY (e.g. an opened PR url, a short
 * reason) — NEVER code, diffs, or prompts. Opt-in + no-throw.
 */
export async function patchFleetCommand(
  cfg: PulseExporterConfig,
  commandId: string,
  update: {
    status: FleetCommandStatus;
    claimedBy?: string;
    result?: Record<string, unknown>;
    error?: string;
  },
  opts?: { pat?: string },
): Promise<CommandPatchResult> {
  if (!cfg.pulse?.enabled) {
    return { ok: false, skipped: true, status: null, detail: 'pulse polling disabled (cfg.pulse.enabled is falsy)' };
  }
  const pat = resolveReadPat(opts?.pat);
  if (!pat) {
    return { ok: false, skipped: true, status: null, detail: `${READ_PAT_ENV}/${PAT_ENV} not set — skipping writeback` };
  }
  if (!commandId) {
    return { ok: false, skipped: true, status: null, detail: 'missing commandId' };
  }

  try {
    const url = `${endpointBase(cfg)}/api/fleet/commands/${encodeURIComponent(commandId)}`;
    const body: Record<string, unknown> = { status: update.status };
    if (update.claimedBy) body['claimedBy'] = update.claimedBy;
    if (update.result) body['result'] = update.result;
    if (update.error) body['error'] = update.error;

    const res = await safeFetch(url, {
      method: 'PATCH',
      pat,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res) return { ok: false, skipped: false, status: null, detail: `endpoint unreachable: ${url}` };
    if (res.ok) return { ok: true, skipped: false, status: res.status, detail: `command ${commandId} → ${update.status} (HTTP ${res.status})` };
    return { ok: false, skipped: false, status: res.status, detail: `writeback returned HTTP ${res.status}` };
  } catch {
    return { ok: false, skipped: false, status: null, detail: 'unexpected error during writeback' };
  }
}

/**
 * Convenience: atomically claim a command (PATCH status='claimed'), so a
 * second machine polling the same queue does not double-execute it. The cloud
 * is the authority — a 409/non-2xx means another machine won the claim.
 * NEVER throws.
 */
export async function claimFleetCommand(
  cfg: PulseExporterConfig,
  commandId: string,
  claimedBy: string,
  opts?: { pat?: string },
): Promise<CommandPatchResult> {
  return patchFleetCommand(cfg, commandId, { status: 'claimed', claimedBy }, opts);
}
