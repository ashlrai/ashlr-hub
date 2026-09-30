/**
 * core/verse/mcp-scope.ts — MCP scope, as reported by Locus.
 *
 * docs/VERSE-WORKSPACES.md §3: "a server appropriate for a personal account
 * may be wrong for a client's. Locus already models exactly this — principal,
 * tenant, sealed session — so scope should be asked of Locus rather than
 * reinvented in the hub, and the hub should hold opaque references rather
 * than copies of anything sensitive."
 *
 * So this module OWNS NO SCOPE. It asks `src/core/integrations/locus.ts` and
 * projects the answer onto a transport shape. Two rules follow from that:
 *
 *   1. Every field here is an OPAQUE REFERENCE Locus already publishes in its
 *      own `agent report --json` (alias, tenant, binding_id, principal). None
 *      of them is a credential, and none of them is derived, inferred or
 *      cached by the hub. When Locus says nothing, this says nothing — it
 *      never substitutes a hub-local notion of "which account is this".
 *   2. Mutation admission is NOT decided here either. It is decided by the
 *      repo's existing pre-mutate gate (`assertLocusPreMutate`), whose mode
 *      ladder (off | warn | enforce) is already the contract every other
 *      spawn site in this repo obeys — see src/core/run/engines.ts:662. A new
 *      surface inventing a stricter or looser rule than the dispatch path is
 *      exactly the "reinvented in the hub" failure this file exists to avoid.
 *
 * Pure projection + one shell-out through locus.ts. Never throws.
 */

import {
  assertLocusPreMutate,
  assertLocusPreMutateAsync,
  locusAgentReport,
  locusAgentReportAsync,
  type LocusEnforceConfigInput,
  type LocusEnforceMode,
  type LocusProbeResult,
} from '../integrations/locus.js';

// ---------------------------------------------------------------------------
// Transport shape
// ---------------------------------------------------------------------------

/**
 * Why scope is what it is. Machine-readable and verbatim — prose belongs in
 * the web UI, the same split `VerseAccountRecord.reason` already uses.
 */
export type VerseMcpScopeReason =
  /** `locus` is not installed or not on PATH. */
  | 'mcp-scope-locus-unavailable'
  /** Locus answered but reports no pin, so there is no tenant to scope to. */
  | 'mcp-scope-unpinned'
  /** Pinned, but the seal did not verify. */
  | 'mcp-scope-seal-unverified'
  /** Pinned, but the pin has expired. */
  | 'mcp-scope-expired'
  | 'mcp-scope-frozen'
  | 'mcp-scope-not-ready'
  | 'mcp-scope-readiness-unverified'
  /** Pinned and sealed. */
  | 'mcp-scope-pinned';

/**
 * Locus's pin, projected for transport.
 *
 * Every `*Ref` is Locus's own opaque identifier, carried through unchanged so
 * the operator can match it against `locus status` — never a hub-side copy of
 * anything that authenticates.
 */
export interface VerseMcpScope {
  /** False when the locus binary could not be run at all. */
  available: boolean;
  pinned: boolean;
  /** Opaque Locus references. Null whenever Locus did not publish one. */
  aliasRef: string | null;
  tenantRef: string | null;
  principalRef: string | null;
  bindingRef: string | null;
  sealOk: boolean | null;
  expired: boolean | null;
  frozen: boolean | null;
  expiresAt: string | null;
  /** Locus's own `status` and `status --oneline`, verbatim. */
  status: string | null;
  statusOneline: string | null;
  reason: VerseMcpScopeReason;
  /** Closed setup issue codes only; raw doctor findings and locators stay private. */
  setupIssues?: string[];
}

/** The scope a mutation would be written under, plus whether it may proceed. */
export interface VerseMcpScopeGate {
  scope: VerseMcpScope;
  /** The repo-wide pre-mutate mode: off | warn | enforce. */
  mode: LocusEnforceMode;
  /**
   * False only when mode is `enforce` and Locus blocks. Mirrors
   * `assertLocusPreMutate` exactly — this surface does not get its own rule.
   */
  allow: boolean;
  /** Human-readable blockers from Locus. Never secrets. */
  blockers: string[];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const UNAVAILABLE: VerseMcpScope = {
  available: false,
  pinned: false,
  aliasRef: null,
  tenantRef: null,
  principalRef: null,
  bindingRef: null,
  sealOk: null,
  expired: null,
  frozen: null,
  expiresAt: null,
  status: null,
  statusOneline: null,
  reason: 'mcp-scope-locus-unavailable',
};

/** A non-empty string, or null. Locus's optional fields arrive as either. */
function ref(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A boolean, or null when Locus did not report the flag at all. */
function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function setupIssues(report: NonNullable<LocusProbeResult['report']>): string[] {
  const doctor = report.doctor;
  if (!doctor || typeof doctor !== 'object' || Array.isArray(doctor)) return [];
  const value = doctor as Record<string, unknown>;
  const out = new Set<string>();
  if (value.phantom_on_path === false) out.add('phantom_unavailable');
  const runtime = value.runtime;
  if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    && (runtime as Record<string, unknown>).authority_anchor_ok === false) out.add('authority_anchor_unavailable');
  const allowed = new Set(['authority_anchor_unavailable', 'credential_migration_incomplete']);
  const runtimeIssues = runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    ? (runtime as Record<string, unknown>).issues : null;
  for (const codes of [value.issues, runtimeIssues]) {
    if (Array.isArray(codes)) for (const code of codes) {
      if (typeof code === 'string' && allowed.has(code)) out.add(code);
    }
  }
  const findings = Array.isArray(value.findings) ? value.findings : [];
  for (const finding of findings) {
    if (finding && typeof finding === 'object' && !Array.isArray(finding)) {
      const code = (finding as Record<string, unknown>).code;
      if (typeof code === 'string' && allowed.has(code)) out.add(code);
    }
  }
  return [...out];
}

/**
 * Project one `locus agent report --json` probe onto {@link VerseMcpScope}.
 *
 * Pure: pass a canned {@link LocusProbeResult} in tests rather than shelling
 * out. An unavailable probe, a null report and a null pin are three different
 * facts and each gets its own reason.
 */
export function projectVerseMcpScope(probe: LocusProbeResult): VerseMcpScope {
  if (!probe.available || probe.report === null) return UNAVAILABLE;

  const report = probe.report;
  const pin = report.pin ?? null;
  const base = {
    available: true,
    status: ref(report.status),
    statusOneline: ref(report.status_oneline),
    setupIssues: setupIssues(report),
  };

  if (pin === null || pin.pinned !== true) {
    return {
      ...UNAVAILABLE,
      ...base,
      pinned: false,
      reason: 'mcp-scope-unpinned',
    };
  }

  const sealOk = flag(pin.seal_ok);
  const expired = flag(pin.expired);
  const frozen = flag(pin.frozen);

  // Order matters: an expired pin whose seal never verified is reported as
  // seal-unverified, because that is the more fundamental failure and the one
  // the operator has to fix first.
  const reason: VerseMcpScopeReason =
    sealOk === false ? 'mcp-scope-seal-unverified'
      : expired === true ? 'mcp-scope-expired'
        : frozen === true || report.status_oneline === 'frozen' ? 'mcp-scope-frozen'
          : report.ready !== true || report.status !== 'ready' || !probe.gateOk ? 'mcp-scope-not-ready'
            : sealOk !== true || expired !== false ? 'mcp-scope-readiness-unverified'
              : 'mcp-scope-pinned';

  return {
    ...base,
    pinned: true,
    aliasRef: ref(pin.alias),
    tenantRef: ref(pin.tenant),
    principalRef: ref(pin.principal),
    bindingRef: ref(pin.binding_id),
    sealOk,
    expired,
    frozen,
    expiresAt: ref(pin.expires_at),
    reason,
  };
}

/**
 * Ask Locus for the current scope.
 *
 * `read` is the injection seam: production passes nothing and gets the real
 * `locusAgentReport()` shell-out; tests pass a function returning a canned
 * probe and never spawn anything. Never throws — locusAgentReport() already
 * reports failure as `{available: false}` rather than raising.
 */
export function readVerseMcpScope(read: () => LocusProbeResult = locusAgentReport): VerseMcpScope {
  try {
    return projectVerseMcpScope(read());
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * {@link readVerseMcpScope} for the HTTP routes: the Locus probe is awaited
 * (locusAgentReportAsync) instead of blocking the server for up to its 12 s
 * timeout. Same projection. Never rejects.
 */
export async function readVerseMcpScopeAsync(
  read: () => Promise<LocusProbeResult> = locusAgentReportAsync,
): Promise<VerseMcpScope> {
  try {
    return projectVerseMcpScope(await read());
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * {@link readVerseMcpScopeGate} for the HTTP routes (MCP proposal and apply):
 * the scope read and the pre-mutate decision each await their Locus probe
 * instead of spawning it synchronously on the request thread. Same answer,
 * same fail-closed rule. Never rejects.
 */
export async function readVerseMcpScopeGateAsync(options: {
  read?: () => Promise<LocusProbeResult>;
  decide?: () => Promise<{ allow: boolean; mode: LocusEnforceMode; blockers: string[] }>;
  env?: NodeJS.ProcessEnv;
  config?: LocusEnforceConfigInput;
} = {}): Promise<VerseMcpScopeGate> {
  const scope = await readVerseMcpScopeAsync(options.read ?? locusAgentReportAsync);

  let decision: { allow: boolean; mode: LocusEnforceMode; blockers: string[] };
  try {
    decision = options.decide
      ? await options.decide()
      // Argument count carries meaning (see readVerseMcpScopeGate).
      : 'config' in options
        ? await assertLocusPreMutateAsync(options.env, options.config)
        : await assertLocusPreMutateAsync(options.env);
  } catch {
    decision = { allow: false, mode: 'enforce', blockers: ['locus pre-mutate gate could not be evaluated'] };
  }

  return {
    scope,
    mode: decision.mode,
    allow: decision.allow,
    blockers: [...decision.blockers],
  };
}

/**
 * The scope a write would land under, plus the repo's existing admission
 * decision for it.
 *
 * `decide` and `read` are injection seams for tests. In production both shell
 * out to Locus once each.
 */
export function readVerseMcpScopeGate(options: {
  read?: () => LocusProbeResult;
  decide?: () => { allow: boolean; mode: LocusEnforceMode; blockers: string[] };
  env?: NodeJS.ProcessEnv;
  config?: LocusEnforceConfigInput;
} = {}): VerseMcpScopeGate {
  const scope = readVerseMcpScope(options.read ?? locusAgentReport);

  let decision: { allow: boolean; mode: LocusEnforceMode; blockers: string[] };
  try {
    decision = options.decide
      ? options.decide()
      // `arguments.length >= 2` inside assertLocusPreMutate distinguishes
      // "config omitted -> read ~/.ashlr" from "config null -> no config", so
      // the two calls must stay separate rather than passing `undefined`.
      : 'config' in options
        ? assertLocusPreMutate(options.env, options.config)
        : assertLocusPreMutate(options.env);
  } catch {
    // Fail closed on an unexpected throw: an undecidable gate is not an open
    // one for a surface that installs arbitrary code.
    decision = { allow: false, mode: 'enforce', blockers: ['locus pre-mutate gate could not be evaluated'] };
  }

  return {
    scope,
    mode: decision.mode,
    allow: decision.allow,
    blockers: [...decision.blockers],
  };
}
