/**
 * src/core/integrations/locus.ts — Locus identity-plane probe for ashlr-hub.
 *
 * Landed from Locus `integrations/ashlr-hub/locus.ts`. Shells out to the
 * `locus` CLI; never reimplements seal/pin.
 *
 * SECURITY:
 *   - Never parse or persist secret VALUES from locus/phantom output.
 *   - Credential locators are private configuration; consume only presence/source metadata.
 *   - Prefer REQUIRED_SERVERS = ["locus","phantom"] (agent-report plane names) —
 *     never ambient supabase MCP. MCP config discovery keys use "phantom-secrets"
 *     for the Phantom server entry; do not conflate the two layers.
 *   - withLocusSession uses `ci mint` (ephemeral); does not mutate active.json.
 *   - Mint child env is scrubbed (no ambient credentials) + validateMintEnv allowlist.
 *
 * Pure (unit-testable) exports — no spawn / no FS:
 *   parseStatusOneline, isStatusOnelineHealthy, canMutate,
 *   parseRequiredServers, hasRequiredServers, parseAgentReportJson,
 *   blockersFromAgentReport, evaluateFleetGate, decidePreMutateGate,
 *   parseLocusEnforceToken, resolveLocusEnforceMode, decideLocusSessionRun,
 *   scrubbedChildEnv, validateMintEnv, applyLocusSessionEnv, parseMcpConfigJson,
 *   mergeLocusIntoMcpConfig, locusServerSpec
 *
 * Shell-out / FS: locusAvailable, locusAgentReport, ensureLocusReady, locusFleetGate,
 *   assertLocusPreMutate, applyLocusPreMutateGate, withLocusSession,
 *   runWithLocusSessionIfConfigured, locusDoctorLine, registerLocusInMcpConfig
 *
 * Pre-mutate enforcement (opt-in — never always-on):
 *   Resolution order for mode (see resolveLocusEnforceMode):
 *     1. env LOCUS_ENFORCE when set (wins over config, including LOCUS_ENFORCE=off)
 *     2. ~/.ashlr/config.json → locus.enforce ("off"|"warn"|"enforce")
 *     3. off (monorepo-safe default when both unset)
 *
 *   Tokens (env or config):
 *     1|true|yes|enforce|block → enforce (fail closed when fleet gate blocks)
 *     warn|log                 → warn (log blockers, allow dispatch)
 *     unset / 0 / false / no / off / "" → off (no CLI probe)
 *     unknown non-empty env token → enforce (fail closed; do not soft-allow typos)
 *
 *   Firm mode example (~/.ashlr/config.json):
 *     { "locus": { "enforce": "enforce" } }
 *   Soft roll-out:
 *     { "locus": { "enforce": "warn" } }
 *   Local override without editing config:
 *     LOCUS_ENFORCE=off
 *
 * CI session isolation (runWithLocusSessionIfConfigured):
 *   LOCUS_CI_BINDING / LOCUS_BINDING → ephemeral `ci mint` (no ambient active.json)
 *   enforce mode without binding → refuse (LocusSessionConfigError)
 *   warn mode without binding → warn + pass-through
 *   LOCUS_SESSION_ID already set → already-session (skip re-mint)
 *   otherwise → pass-through (monorepo-safe default)
 *
 * Call sites (opt-in only — never always-on):
 *   - spawnEngine / runSwarmInternal / runApiModelSandboxed — pre-mutate gate
 *   - runSwarm / runTask — CI session mint overlay (fleet + single-task paths)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfigReadOnly } from "../config.js";
import type { AshlrConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCUS_BIN = process.env.LOCUS_BIN ?? "locus";
const TIMEOUT_MS = 12_000;

/** Identity plane + secret plane — the Ashlr agent safety pair. */
export const REQUIRED_SERVERS = ["locus", "phantom"] as const;
export type RequiredServer = (typeof REQUIRED_SERVERS)[number];

/** MCP multiplexor binary — never raw provider MCPs. */
export const MCP_COMMAND = "locus-mcp" as const;

export type LocusAgentExitCode = 0 | 1 | 2;
export type AgentStatus = "ready" | "protected" | "unsafe";
export type DoctorVerdict = "SAFE" | "WARN" | "UNSAFE";

/**
 * Tokens from `locus status --oneline`:
 *   unpinned | require_pin | frozen | invalid | alias:tenant
 */
export type StatusOnelineKind =
  | "unpinned"
  | "require_pin"
  | "frozen"
  | "invalid"
  | "pinned";

// ---------------------------------------------------------------------------
// Types (keep aligned with schema/agent-report.schema.json + hub-gate.schema.json)
// ---------------------------------------------------------------------------

export interface LocusAgentReport {
  version: string;
  ready: boolean;
  status: AgentStatus;
  status_oneline: string;
  home: string;
  pin: {
    pinned?: boolean;
    alias?: string | null;
    tenant?: string | null;
    binding_id?: string | null;
    seal_ok?: boolean;
    expired?: boolean;
    frozen?: boolean;
    expires_at?: string | null;
    principal?: string | null;
    client?: string | null;
  } | null;
  mcp_registered: {
    claude: boolean;
    cursor: boolean;
    codex: boolean;
  };
  doctor: unknown;
  commands: Record<string, string>;
  required_servers: string[];
  mcp_command: string;
  exit_code?: number;
  findings?: string[];
  next_steps?: string[];
  env_session_id?: string | null;
}

export interface LocusProbeResult {
  available: boolean;
  report: LocusAgentReport | null;
  exitCode: LocusAgentExitCode | number;
  error?: string;
  /** true when status is ready and oneline is not unpinned/frozen/invalid */
  gateOk: boolean;
}

/** Parsed form of `locus status --oneline`. */
export interface ParsedStatusOneline {
  kind: StatusOnelineKind;
  raw: string;
  alias?: string;
  tenant?: string;
  /** Healthy pin: `alias:tenant` (not frozen/invalid/unpinned/require_pin). */
  healthy: boolean;
}

/**
 * Fleet pre-dispatch gate result.
 * @see schema/hub-gate.schema.json
 * @see integrations/ashlr-hub/fleet-preflight.md
 */
export interface LocusFleetGateResult {
  /** True only when every preflight check passes (fail closed). */
  allowDispatch: boolean;
  /** Human-readable blockers; empty iff allowDispatch. */
  blockers: string[];
  /** Agent report when available; null if CLI missing / parse failure. */
  report: LocusAgentReport | null;
  /** Echo of probe availability (CLI on PATH). */
  available?: boolean;
  /** Echo of canMutate/gateOk when report present. */
  gateOk?: boolean;
  status?: AgentStatus | string;
  status_oneline?: string;
}

/** Output of `locus ci mint -b <alias> --json` (secrets only if --resolve + env allow). */
export interface LocusCiMint {
  session_id: string;
  binding: string;
  binding_id: string;
  tenant: string;
  expires_at: string;
  seal: string;
  path: string;
  worker_home: string;
  secrets_resolved: boolean;
  env: Record<string, string>;
}

export interface WithLocusSessionOptions {
  /** Session TTL passed to `ci mint` (default 15m). */
  ttl?: string;
  /** Allow bindings outside workspace allowlist. */
  force?: boolean;
  /** Explicitly authorized env merged into the scrubbed child handle. */
  env?: NodeJS.ProcessEnv;
  /** Override LOCUS_HOME for mint + handle. */
  home?: string;
  /** Spawn timeout for mint (ms). */
  timeoutMs?: number;
}

/** How the hub should treat locus fleet-gate blockers before mutate/dispatch. */
export type LocusEnforceMode = "off" | "warn" | "enforce";

/**
 * Optional config slice consulted by {@link resolveLocusEnforceMode} after env.
 * Accepts either `cfg.locus`, a bare `{ enforce }`, or a full {@link AshlrConfig}.
 */
export type LocusEnforceConfigInput =
  | Pick<AshlrConfig, "locus">
  | NonNullable<AshlrConfig["locus"]>
  | AshlrConfig
  | null
  | undefined;

/**
 * Decision from the pre-mutate gate wrapper.
 * Pure when built via `decidePreMutateGate`; shell-out when via `assertLocusPreMutate`.
 */
export interface LocusPreMutateDecision {
  /** False only when mode=enforce and fleet gate would block. */
  allow: boolean;
  mode: LocusEnforceMode;
  /** Human-readable blockers (never secrets). Empty when healthy or mode=off. */
  blockers: string[];
  gateOk?: boolean;
  status_oneline?: string;
  status?: AgentStatus | string;
  available?: boolean;
  /** True when mode is warn and blockers present (caller may log). */
  shouldWarn: boolean;
}

export interface LocusSessionHandle {
  sessionId: string;
  binding: string;
  tenant: string;
  expiresAt: string;
  /** Env for children: LOCUS_HOME + LOCUS_SESSION_ID + mint env map. */
  env: NodeJS.ProcessEnv;
  mint: LocusCiMint;
}

/** Claude / Cursor style MCP config root. */
export interface McpConfigJson {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface MergeLocusMcpOptions {
  /** Effective LOCUS_HOME injected into server env. */
  locusHome?: string;
  /** LOCUS_CLIENT value (default ashlr-hub). */
  client?: string;
  /** Optional LOCUS_SESSION_ID for ephemeral pin. */
  sessionId?: string;
  /** Server name key (default "locus"). */
  name?: string;
  /** Binary (default locus-mcp). */
  command?: string;
}

export interface MergeLocusMcpResult {
  config: McpConfigJson;
  /** True when mcpServers.locus (or name) was inserted or materially changed. */
  changed: boolean;
  serverName: string;
}

export interface RegisterLocusMcpResult extends MergeLocusMcpResult {
  path: string;
  /** True when the file was written. */
  written: boolean;
  created: boolean;
}

export class LocusNotReadyError extends Error {
  readonly probe: LocusProbeResult;

  constructor(message: string, probe: LocusProbeResult) {
    super(message);
    this.name = "LocusNotReadyError";
    this.probe = probe;
  }
}

export class LocusMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocusMintError";
  }
}

export class LocusMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocusMcpConfigError";
  }
}

/** Thrown when LOCUS_ENFORCE requires a CI binding but none is configured. */
export class LocusSessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocusSessionConfigError";
  }
}

/**
 * Pure decision for {@link runWithLocusSessionIfConfigured}.
 * Never shells out; never throws.
 */
export type LocusSessionRunDecision =
  | {
      /** Mint ephemeral session via `locus ci mint -b <binding>`. */
      kind: "mint";
      binding: string;
      /** Env key that supplied the binding alias. */
      source: "LOCUS_CI_BINDING" | "LOCUS_BINDING";
    }
  | {
      /** Already under a sealed session id — skip re-mint. */
      kind: "already-session";
      sessionId: string;
    }
  | {
      /** No binding and enforce mode — fail closed. */
      kind: "refuse";
      reason: string;
      mode: LocusEnforceMode;
    }
  | {
      /** No binding and warn mode — allow ambient env with a warning. */
      kind: "warn";
      reason: string;
      mode: LocusEnforceMode;
    }
  | {
      /** No binding and enforce off — monorepo-safe pass-through. */
      kind: "pass-through";
      mode: LocusEnforceMode;
    };

export interface RunWithLocusSessionOptions extends WithLocusSessionOptions {
  /** Env consulted for LOCUS_CI_BINDING / LOCUS_BINDING / LOCUS_ENFORCE. */
  env?: NodeJS.ProcessEnv;
  /** Called once when decision is warn (default: stderr). */
  onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Env / process helpers
// ---------------------------------------------------------------------------

/** True when `locus` is on PATH. Never throws. */
export function locusAvailable(): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where" : "which",
      [LOCUS_BIN],
      { stdio: "ignore", timeout: TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

function locusEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCUS_HOME: process.env.LOCUS_HOME ?? join(homedir(), ".locus"),
    LOCUS_NOTIFY: "0",
    LOCUS_QUIET: "1",
    ...extra,
  };
}

const CHILD_RUNTIME_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "ComSpec",
]);

const MINT_SCOPE_ENV = new Set([
  "GH_CONFIG_DIR",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
]);

const MINT_IDENTITY_ENV = new Set([
  "LOCUS_SESSION_ID",
  "LOCUS_BINDING",
  "LOCUS_BINDING_ID",
  "LOCUS_TENANT",
  "LOCUS_PRINCIPAL",
  "LOCUS_SEAL",
  "LOCUS_WORKER_HOME",
  "LOCUS_EXPIRES_AT",
  "LOCUS_PROVIDERS",
]);

function isAllowedMintEnvKey(key: string): boolean {
  return (
    MINT_IDENTITY_ENV.has(key) ||
    MINT_SCOPE_ENV.has(key) ||
    /^LOCUS_[A-Z0-9_]+_(?:ACCOUNT|CREDENTIAL_RESOLVED|PROJECT_REF|TEAM_ID|ACCOUNT_ID|READ_ONLY|ORGS|REPOS|PROJECTS)$/.test(
      key,
    )
  );
}

/** Build a child baseline without inheriting ambient credentials. */
export function scrubbedChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  explicit?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (CHILD_RUNTIME_ENV.has(key) || key.startsWith("LC_")) {
      clean[key] = value;
    }
  }
  return { ...clean, ...explicit };
}

/** Validate the non-secret identity/scope environment emitted by `ci mint`. */
export function validateMintEnv(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LocusMintError("ci mint JSON has invalid env map");
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !isAllowedMintEnvKey(key) ||
      typeof value !== "string" ||
      /(?:phm|env|test):/i.test(value)
    ) {
      throw new LocusMintError("ci mint JSON contains disallowed env metadata");
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Merge sealed-session identity/scope keys from a mint handle into `target`.
 * Pure: mutates and returns `target`. Never copies secrets (allowlist only).
 *
 * Also accepts LOCUS_HOME / LOCUS_NOTIFY / LOCUS_QUIET from withLocusSession.
 */
export function applyLocusSessionEnv(
  target: NodeJS.ProcessEnv,
  sessionEnv: NodeJS.ProcessEnv | Record<string, string>,
): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (typeof value !== "string") continue;
    if (
      key === "LOCUS_HOME" ||
      key === "LOCUS_NOTIFY" ||
      key === "LOCUS_QUIET" ||
      isAllowedMintEnvKey(key)
    ) {
      target[key] = value;
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Status oneline helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Parse `locus status --oneline` tokens.
 *
 * | raw | kind | healthy |
 * |-----|------|---------|
 * | unpinned | unpinned | false |
 * | require_pin | require_pin | false |
 * | frozen | frozen | false |
 * | invalid | invalid | false |
 * | acme:acme-corp | pinned | true |
 */
export function parseStatusOneline(raw: string): ParsedStatusOneline {
  const s = (raw ?? "").trim() || "unpinned";
  if (s === "unpinned") {
    return { kind: "unpinned", raw: s, healthy: false };
  }
  if (s === "require_pin") {
    return { kind: "require_pin", raw: s, healthy: false };
  }
  if (s === "frozen") {
    return { kind: "frozen", raw: s, healthy: false };
  }
  if (s === "invalid") {
    return { kind: "invalid", raw: s, healthy: false };
  }
  const colon = s.indexOf(":");
  if (colon > 0 && colon < s.length - 1) {
    return {
      kind: "pinned",
      raw: s,
      alias: s.slice(0, colon),
      tenant: s.slice(colon + 1),
      healthy: true,
    };
  }
  // Unknown token → treat as invalid (fail closed)
  return { kind: "invalid", raw: s, healthy: false };
}

/** True when oneline is a healthy `alias:tenant` pin. */
export function isStatusOnelineHealthy(raw: string): boolean {
  return parseStatusOneline(raw).healthy;
}

/**
 * Hub mutate gate: ready status + healthy oneline.
 * Soft-blocks protected; hard-blocks unsafe / unpinned / frozen / invalid.
 */
export function canMutate(
  status: AgentStatus | string,
  statusOneline: string,
): boolean {
  if (status === "unsafe") return false;
  if (status !== "ready") return false;
  return isStatusOnelineHealthy(statusOneline);
}

// ---------------------------------------------------------------------------
// Required servers + report parse helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize unknown JSON into a string[] of server names.
 * Non-arrays / non-strings are dropped (fail closed → empty).
 */
export function parseRequiredServers(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  const out: string[] = [];
  for (const s of servers) {
    if (typeof s === "string" && s.trim()) {
      out.push(s.trim());
    }
  }
  return out;
}

/**
 * True when the list includes both REQUIRED_SERVERS entries (`locus` + `phantom`).
 */
export function hasRequiredServers(
  servers: string[] | readonly string[] | null | undefined,
): boolean {
  if (!servers || servers.length === 0) return false;
  const set = new Set(
    [...servers].map((s) => String(s).trim().toLowerCase()).filter(Boolean),
  );
  return REQUIRED_SERVERS.every((r) => set.has(r));
}

/**
 * Parse agent-report JSON text. Throws on invalid JSON / non-object.
 * Does not validate every schema field — hub may tolerate extra keys.
 */
export function parseAgentReportJson(raw: string): LocusAgentReport {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new Error("empty agent report JSON");
  }
  const v = JSON.parse(text) as unknown;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("agent report root is not an object");
  }
  return v as LocusAgentReport;
}

/**
 * Stable keys every hub consumer should see on agent report JSON.
 * Keep aligned with AGENT_REPORT_JSON_KEYS in locus-core.
 */
export const AGENT_REPORT_STABLE_KEYS = [
  "version",
  "ready",
  "status",
  "mcp_registered",
  "doctor",
  "commands",
  "exit_code",
  "status_oneline",
  "home",
  "required_servers",
  "mcp_command",
] as const;

/** Return missing stable keys (empty when complete). */
export function missingAgentReportKeys(report: unknown): string[] {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return ["root is not an object"];
  }
  const obj = report as Record<string, unknown>;
  return AGENT_REPORT_STABLE_KEYS.filter((k) => !(k in obj));
}

// ---------------------------------------------------------------------------
// Fleet gate (pure evaluation + shell-out wrapper)
// ---------------------------------------------------------------------------

export interface EvaluateFleetGateOptions {
  /**
   * When true (default), also require required_servers ⊇ {locus, phantom}
   * and mcp_command === locus-mcp.
   */
  requireHubContract?: boolean;
}

/**
 * Pure: compute human-readable blockers from an agent report (or null).
 * Never throws. Fail closed when report is missing.
 */
export function blockersFromAgentReport(
  report: LocusAgentReport | null | undefined,
  opts?: EvaluateFleetGateOptions,
): string[] {
  const requireContract = opts?.requireHubContract !== false;
  const blockers: string[] = [];

  if (!report) {
    blockers.push("no agent report");
    return blockers;
  }

  const status = report.status ?? "unknown";
  const oneline = report.status_oneline ?? "unpinned";
  const parsed = parseStatusOneline(oneline);

  if (status === "unsafe") {
    blockers.push("status=unsafe");
  } else if (status !== "ready") {
    blockers.push(`status=${status} (not ready)`);
  }

  if (report.ready !== true) {
    blockers.push("ready=false");
  }

  const doctor =
    report.doctor && typeof report.doctor === "object"
      ? (report.doctor as { findings?: unknown })
      : null;
  const doctorFindings = Array.isArray(doctor?.findings) ? doctor.findings : [];
  if (
    doctorFindings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        (finding as { code?: unknown }).code === "credential_migration_incomplete",
    )
  ) {
    blockers.push("credential migration reconciliation incomplete");
  }

  if (!parsed.healthy) {
    blockers.push(`pin unhealthy: ${parsed.kind} (${parsed.raw})`);
  }

  if (report.pin?.seal_ok === false) {
    blockers.push("pin.seal_ok=false");
  }
  if (report.pin?.expired === true) {
    blockers.push("pin.expired=true");
  }
  if (report.pin?.frozen === true) {
    blockers.push("pin.frozen=true");
  }

  if (requireContract) {
    const servers = parseRequiredServers(report.required_servers);
    if (!hasRequiredServers(servers)) {
      blockers.push(
        `required_servers missing locus and/or phantom (got: ${JSON.stringify(servers)})`,
      );
    }
    const cmd = (report.mcp_command ?? "").trim();
    if (cmd && cmd !== MCP_COMMAND) {
      blockers.push(`mcp_command must be ${MCP_COMMAND} (got: ${cmd})`);
    } else if (!cmd) {
      blockers.push(`mcp_command missing (expected ${MCP_COMMAND})`);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(blockers)];
}

/**
 * Pure fleet gate evaluation from a parsed report.
 * `allowDispatch` is true only when blockers is empty.
 */
export function evaluateFleetGate(
  report: LocusAgentReport | null | undefined,
  opts?: EvaluateFleetGateOptions,
): Pick<LocusFleetGateResult, "allowDispatch" | "blockers" | "report" | "gateOk" | "status" | "status_oneline"> {
  const blockers = blockersFromAgentReport(report ?? null, opts);
  const status = report?.status;
  const status_oneline = report?.status_oneline;
  const gateOk =
    !!report &&
    report.ready === true &&
    report.status === "ready" &&
    isStatusOnelineHealthy(report.status_oneline ?? "");

  // allowDispatch requires no blockers (stricter than gateOk when contract checks on)
  const allowDispatch = blockers.length === 0;

  return {
    allowDispatch,
    blockers,
    report: report ?? null,
    gateOk,
    status,
    status_oneline,
  };
}

/**
 * Shell out to `locus agent report --json` and evaluate fleet pre-dispatch gate.
 *
 * Fail closed: missing CLI, empty/invalid report, status≠ready, unhealthy
 * oneline, or broken hub contract (required_servers / mcp_command).
 *
 * @see integrations/ashlr-hub/fleet-preflight.md
 * @see schema/hub-gate.schema.json
 */
export function locusFleetGate(env?: NodeJS.ProcessEnv): LocusFleetGateResult {
  const probe = locusAgentReport(env);
  if (!probe.available) {
    return {
      allowDispatch: false,
      blockers: [probe.error ?? "locus CLI not found on PATH"],
      report: null,
      available: false,
      gateOk: false,
    };
  }
  if (!probe.report) {
    return {
      allowDispatch: false,
      blockers: [probe.error ?? "locus agent report failed"],
      report: null,
      available: true,
      gateOk: false,
      status: undefined,
      status_oneline: undefined,
    };
  }

  const evaluated = evaluateFleetGate(probe.report);
  // Surface report findings as soft context only when already blocked
  if (!evaluated.allowDispatch && probe.report.next_steps?.length) {
    const hint = `next: ${probe.report.next_steps[0]}`;
    if (!evaluated.blockers.includes(hint)) {
      evaluated.blockers = [...evaluated.blockers, hint];
    }
  }

  return {
    ...evaluated,
    available: true,
  };
}

// ---------------------------------------------------------------------------
// Pre-mutate gate (opt-in enforce via LOCUS_ENFORCE and/or config.locus)
// ---------------------------------------------------------------------------

/**
 * Parse a single enforce token from env or config into a mode.
 *
 * | value | mode |
 * |-------|------|
 * | empty, 0, false, no, off | off |
 * | warn, log | warn |
 * | 1, true, yes, enforce, block | enforce |
 *
 * Unknown non-empty values fail closed to `enforce`.
 */
export function parseLocusEnforceToken(raw: unknown): LocusEnforceMode {
  if (raw === undefined || raw === null) return "off";
  const v = String(raw).trim().toLowerCase();
  if (!v || v === "0" || v === "false" || v === "no" || v === "off") {
    return "off";
  }
  if (v === "warn" || v === "log") return "warn";
  if (
    v === "1" ||
    v === "true" ||
    v === "yes" ||
    v === "enforce" ||
    v === "block"
  ) {
    return "enforce";
  }
  // Unknown token → enforce (fail closed; do not soft-allow typoed policy)
  return "enforce";
}

/**
 * Extract `locus.enforce` from a config slice / full AshlrConfig / bare
 * `{ enforce }` object. Returns undefined when the field is absent.
 */
export function extractLocusConfigEnforce(
  config?: LocusEnforceConfigInput,
): string | undefined {
  if (config == null || typeof config !== "object") return undefined;
  // Bare { enforce: ... }
  if (
    "enforce" in config &&
    !("locus" in config) &&
    (config as { enforce?: unknown }).enforce !== undefined &&
    (config as { enforce?: unknown }).enforce !== null
  ) {
    return String((config as { enforce: unknown }).enforce);
  }
  // AshlrConfig or { locus?: { enforce?: ... } }
  if ("locus" in config) {
    const locus = (config as { locus?: { enforce?: unknown } | null }).locus;
    if (
      locus != null &&
      typeof locus === "object" &&
      locus.enforce !== undefined &&
      locus.enforce !== null
    ) {
      return String(locus.enforce);
    }
  }
  return undefined;
}

/**
 * Best-effort read of `locus` from ~/.ashlr/config.json.
 * Never throws; returns undefined on missing/unreadable config.
 * Used only by production wrappers (assert / session run) — pure resolvers
 * take an explicit config argument so unit tests stay hermetic.
 */
export function readLocusConfigFromAshlr():
  | NonNullable<AshlrConfig["locus"]>
  | undefined {
  try {
    const cfg = loadConfigReadOnly();
    const locus = cfg?.locus;
    if (locus == null || typeof locus !== "object") return undefined;
    return locus;
  } catch {
    return undefined;
  }
}

/**
 * Resolve Locus enforce mode.
 *
 * Order (first match wins):
 *   1. env `LOCUS_ENFORCE` when the key is present (including empty → off)
 *   2. config `locus.enforce` when provided / present
 *   3. `off` (monorepo-safe default — never always-on)
 *
 * Pure when `config` is passed explicitly (or omitted for env-only). Does not
 * load ~/.ashlr itself; use {@link readLocusConfigFromAshlr} at call sites.
 */
export function resolveLocusEnforceMode(
  env?: NodeJS.ProcessEnv,
  config?: LocusEnforceConfigInput,
): LocusEnforceMode {
  const e = env ?? process.env;
  const rawEnv = e.LOCUS_ENFORCE;
  // Env wins whenever the key is set (including "" / "off" overriding config).
  if (rawEnv !== undefined && rawEnv !== null) {
    return parseLocusEnforceToken(rawEnv);
  }
  const rawCfg = extractLocusConfigEnforce(config);
  if (rawCfg !== undefined) {
    return parseLocusEnforceToken(rawCfg);
  }
  return "off";
}

/**
 * Pure: map a fleet-gate result + enforce mode into a pre-mutate decision.
 * Never throws. Never probes the CLI.
 */
export function decidePreMutateGate(
  gate: Pick<
    LocusFleetGateResult,
    "allowDispatch" | "blockers" | "gateOk" | "status" | "status_oneline" | "available"
  >,
  mode: LocusEnforceMode,
): LocusPreMutateDecision {
  if (mode === "off") {
    return {
      allow: true,
      mode,
      blockers: [],
      shouldWarn: false,
      gateOk: gate.gateOk,
      status: gate.status,
      status_oneline: gate.status_oneline,
      available: gate.available,
    };
  }

  const blockers = [...(gate.blockers ?? [])];
  const blocked = !gate.allowDispatch || blockers.length > 0;

  if (mode === "warn") {
    return {
      allow: true,
      mode,
      blockers: blocked ? blockers : [],
      shouldWarn: blocked,
      gateOk: gate.gateOk,
      status: gate.status,
      status_oneline: gate.status_oneline,
      available: gate.available,
    };
  }

  // enforce
  return {
    allow: !blocked,
    mode,
    blockers: blocked ? blockers : [],
    shouldWarn: false,
    gateOk: gate.gateOk,
    status: gate.status,
    status_oneline: gate.status_oneline,
    available: gate.available,
  };
}

/**
 * Pre-mutate gate for hub dispatch (fleet/run engines).
 *
 * - mode=off: returns allow without shelling out (monorepo-safe default).
 * - mode=warn|enforce: shells to `locusFleetGate` and decides.
 *
 * Mode resolution: env LOCUS_ENFORCE wins; else `config` / ~/.ashlr
 * `locus.enforce`; else off. Pass `config` explicitly in tests to avoid
 * reading the real home config (or pass `null` to disable config).
 *
 * Prefer this over bare `ensureLocusReady` at shared spawn sites so opt-in
 * enforcement does not break CI that lacks a Locus pin.
 */
export function assertLocusPreMutate(
  env?: NodeJS.ProcessEnv,
  config?: LocusEnforceConfigInput,
): LocusPreMutateDecision {
  // When the second arg is omitted, consult ~/.ashlr (firm-mode config path).
  // Explicit null/object skips the FS read so unit tests stay hermetic.
  const cfg =
    arguments.length >= 2 ? config : readLocusConfigFromAshlr();
  const mode = resolveLocusEnforceMode(env, cfg);
  if (mode === "off") {
    return {
      allow: true,
      mode,
      blockers: [],
      shouldWarn: false,
    };
  }
  const gate = locusFleetGate(env);
  return decidePreMutateGate(gate, mode);
}

/**
 * Format a pre-mutate decision for stderr / job UI (never includes secrets).
 */
export function formatPreMutateBlockers(decision: LocusPreMutateDecision): string {
  if (!decision.blockers.length) return "";
  return `locus pre-mutate ${decision.mode}: ${decision.blockers.join("; ")}`;
}

/**
 * Shared call-site helper: probe (when enforce mode is on via env or config),
 * log warn/block to stderr, return the decision. Callers refuse when
 * `!decision.allow`.
 *
 * Keeps spawnEngine / runSwarm / runApiModelSandboxed on one logging contract.
 * Never throws. Never logs secrets.
 *
 * When `config` is omitted, loads `locus` from ~/.ashlr/config.json (same as
 * {@link assertLocusPreMutate}). Pass `null` or an explicit object in tests.
 */
export function applyLocusPreMutateGate(
  env?: NodeJS.ProcessEnv,
  config?: LocusEnforceConfigInput,
): LocusPreMutateDecision {
  // Preserve "config omitted → load ~/.ashlr" vs "config null → no config".
  const decision =
    arguments.length >= 2
      ? assertLocusPreMutate(env, config)
      : assertLocusPreMutate(env);
  if (!decision.allow) {
    const msg =
      formatPreMutateBlockers(decision) ||
      "locus pre-mutate enforce: blocked (no detail)";
    try {
      process.stderr.write(`[ashlr] ${msg}\n`);
    } catch {
      // stderr may be closed in tests; ignore
    }
    return decision;
  }
  if (decision.shouldWarn) {
    const msg = formatPreMutateBlockers(decision);
    if (msg) {
      try {
        process.stderr.write(`[ashlr] ${msg}\n`);
      } catch {
        // ignore
      }
    }
  }
  return decision;
}

// ---------------------------------------------------------------------------
// CI / job session isolation (opt-in via LOCUS_CI_BINDING)
// ---------------------------------------------------------------------------

/**
 * Pure: decide how a mutating CI/job entry should obtain a Locus pin.
 *
 * | condition | kind |
 * |-----------|------|
 * | LOCUS_SESSION_ID set | already-session (skip re-mint) |
 * | LOCUS_CI_BINDING set | mint (prefer CI binding) |
 * | LOCUS_BINDING set | mint |
 * | enforce mode, no binding | refuse |
 * | warn mode, no binding | warn |
 * | otherwise | pass-through |
 *
 * Mode uses {@link resolveLocusEnforceMode} (env wins, then config, then off).
 * Never shells out. Never throws. Does not load ~/.ashlr — pass `config`
 * (or rely on {@link runWithLocusSessionIfConfigured} which loads it).
 */
export function decideLocusSessionRun(
  env?: NodeJS.ProcessEnv,
  config?: LocusEnforceConfigInput,
): LocusSessionRunDecision {
  const e = env ?? process.env;
  const sessionId = (e.LOCUS_SESSION_ID ?? "").trim();
  if (sessionId) {
    return { kind: "already-session", sessionId };
  }

  const ciBinding = (e.LOCUS_CI_BINDING ?? "").trim();
  if (ciBinding) {
    return {
      kind: "mint",
      binding: ciBinding,
      source: "LOCUS_CI_BINDING",
    };
  }

  const binding = (e.LOCUS_BINDING ?? "").trim();
  if (binding) {
    return { kind: "mint", binding, source: "LOCUS_BINDING" };
  }

  const mode = resolveLocusEnforceMode(e, config);
  if (mode === "enforce") {
    return {
      kind: "refuse",
      mode,
      reason:
        "LOCUS_ENFORCE requires LOCUS_CI_BINDING or LOCUS_BINDING for isolated CI sessions (no ambient ~/.locus pin)",
    };
  }
  if (mode === "warn") {
    return {
      kind: "warn",
      mode,
      reason:
        "LOCUS_ENFORCE=warn but LOCUS_CI_BINDING/LOCUS_BINDING unset — using ambient process env (may share ~/.locus pin)",
    };
  }
  return { kind: "pass-through", mode: "off" };
}

/**
 * Run `fn` under an ephemeral Locus CI session when configured.
 *
 * - Binding set (`LOCUS_CI_BINDING` or `LOCUS_BINDING`) → {@link withLocusSession}
 * - Enforce without binding → throws {@link LocusSessionConfigError}
 * - Warn without binding → logs and pass-through (`handle = null`)
 * - Otherwise → pass-through (monorepo-safe default)
 *
 * Prefer this at fleet/CI job entries so parallel agents do not share the
 * human shell pin (`~/.locus/active.json`). Callers that spawn children should
 * merge `handle.env` (via {@link applyLocusSessionEnv}) into child env.
 *
 * @example
 * ```ts
 * await runWithLocusSessionIfConfigured(async (handle) => {
 *   const env = { ...process.env };
 *   if (handle) applyLocusSessionEnv(env, handle.env);
 *   return spawnEngine(cmd, cfg, { env });
 * });
 * ```
 */
export async function runWithLocusSessionIfConfigured<T>(
  fn: (handle: LocusSessionHandle | null) => Promise<T> | T,
  opts?: RunWithLocusSessionOptions,
): Promise<T> {
  const env = opts?.env ?? process.env;
  // Consult ~/.ashlr locus.enforce when env LOCUS_ENFORCE is unset (firm mode).
  const decision = decideLocusSessionRun(env, readLocusConfigFromAshlr());

  if (decision.kind === "mint") {
    return withLocusSession(
      decision.binding,
      (handle) => fn(handle),
      opts,
    );
  }

  if (decision.kind === "refuse") {
    throw new LocusSessionConfigError(decision.reason);
  }

  if (decision.kind === "warn") {
    const msg = `[ashlr] locus session: ${decision.reason}`;
    if (opts?.onWarn) {
      opts.onWarn(msg);
    } else {
      try {
        process.stderr.write(`${msg}\n`);
      } catch {
        // stderr may be closed in tests
      }
    }
  }

  // already-session | pass-through | warn
  return await fn(null);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Run `locus agent report --json`.
 * Preferred hub readiness entrypoint.
 */
export function locusAgentReport(env?: NodeJS.ProcessEnv): LocusProbeResult {
  if (!locusAvailable()) {
    return {
      available: false,
      report: null,
      exitCode: 2,
      error: "locus CLI not found on PATH",
      gateOk: false,
    };
  }
  try {
    const r = spawnSync(LOCUS_BIN, ["agent", "report", "--json"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: locusEnv(env),
      maxBuffer: 4 * 1024 * 1024,
    });
    const exitCode = typeof r.status === "number" ? r.status : 2;
    const stdout = (r.stdout ?? "").trim();
    if (!stdout) {
      return {
        available: true,
        report: null,
        exitCode,
        error: r.stderr?.trim() || "empty agent report",
        gateOk: false,
      };
    }
    const report = parseAgentReportJson(stdout);
    const oneline = report.status_oneline ?? "";
    const gateOk =
      report.ready === true &&
      report.status === "ready" &&
      isStatusOnelineHealthy(oneline);
    return { available: true, report, exitCode, gateOk };
  } catch (e) {
    return {
      available: true,
      report: null,
      exitCode: 2,
      error: e instanceof Error ? e.message : String(e),
      gateOk: false,
    };
  }
}

/** `locus status --oneline` — never throws. */
export function locusStatusOneline(env?: NodeJS.ProcessEnv): string {
  try {
    const r = spawnSync(LOCUS_BIN, ["status", "--oneline"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: locusEnv(env),
    });
    return (r.stdout ?? "").trim() || "unpinned";
  } catch {
    return "unpinned";
  }
}

/**
 * Throw unless the identity plane is ready for mutating work.
 *
 * Fail closed: missing CLI, empty report, status≠ready, or unhealthy oneline.
 * Use before hub jobs that call tools / deploy / mutate infra.
 */
export function ensureLocusReady(env?: NodeJS.ProcessEnv): LocusAgentReport {
  const probe = locusAgentReport(env);
  if (!probe.available) {
    throw new LocusNotReadyError(
      probe.error ?? "locus CLI not found on PATH",
      probe,
    );
  }
  if (!probe.report) {
    throw new LocusNotReadyError(
      probe.error ?? "locus agent report failed",
      probe,
    );
  }
  const r = probe.report;
  const oneline = r.status_oneline ?? "unknown";
  if (r.status === "unsafe" || !probe.gateOk) {
    const hint =
      r.next_steps?.[0] ??
      "locus enter <alias> && locus agent setup --apply --client all";
    throw new LocusNotReadyError(
      `locus not ready: status=${r.status} pin=${oneline} — ${hint}`,
      probe,
    );
  }
  return r;
}

// ---------------------------------------------------------------------------
// CI mint / ephemeral session
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived sealed CI session (`locus ci mint -b <binding>`).
 * Does not touch `active.json`. Never resolves secrets unless the CLI is
 * invoked with env that allows it (this helper does not pass `--resolve`).
 */
export function locusCiMint(
  binding: string,
  opts?: WithLocusSessionOptions,
): LocusCiMint {
  if (!binding?.trim()) {
    throw new LocusMintError("binding alias is required");
  }
  if (!locusAvailable()) {
    throw new LocusMintError("locus CLI not found on PATH");
  }
  const args = ["ci", "mint", "-b", binding.trim(), "--json"];
  if (opts?.ttl) {
    args.push("--ttl", opts.ttl);
  }
  if (opts?.force) {
    args.push("--force");
  }
  const env = locusEnv({
    ...opts?.env,
    ...(opts?.home ? { LOCUS_HOME: opts.home } : {}),
  });
  const r = spawnSync(LOCUS_BIN, args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? TIMEOUT_MS,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error) {
    throw new LocusMintError(`ci mint failed: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new LocusMintError(
      `ci mint exit ${r.status}: ${(r.stderr ?? r.stdout ?? "").trim() || "unknown"}`,
    );
  }
  const stdout = (r.stdout ?? "").trim();
  if (!stdout) {
    throw new LocusMintError("ci mint returned empty stdout");
  }
  let mint: LocusCiMint;
  try {
    mint = JSON.parse(stdout) as LocusCiMint;
  } catch (e) {
    throw new LocusMintError(
      `ci mint JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!mint.session_id || !mint.env) {
    throw new LocusMintError("ci mint JSON missing session_id or env");
  }
  if (mint.secrets_resolved) {
    throw new LocusMintError("ci mint unexpectedly returned resolved secrets");
  }
  mint.env = validateMintEnv(mint.env);
  return mint;
}

/**
 * Run `fn` under an ephemeral Locus pin (`ci mint` → LOCUS_SESSION_ID).
 *
 * Use for hub job isolation so parallel agents do not share/mutate the human
 * shell pin (`active.json`). Parent credentials are scrubbed; the handle gets
 * runtime basics, caller-explicit env, and validated identity/scope metadata.
 *
 * @example
 * ```ts
 * await withLocusSession("acme", async ({ env, sessionId }) => {
 *   ensureLocusReady(env);
 *   // spawn workers / locus-mcp children with `env`
 *   return sessionId;
 * });
 * ```
 */
export async function withLocusSession<T>(
  binding: string,
  fn: (handle: LocusSessionHandle) => Promise<T> | T,
  opts?: WithLocusSessionOptions,
): Promise<T> {
  const mint = locusCiMint(binding, opts);
  const home =
    opts?.home ??
    process.env.LOCUS_HOME ??
    mint.env.LOCUS_HOME ??
    join(homedir(), ".locus");

  const env: NodeJS.ProcessEnv = {
    ...scrubbedChildEnv(process.env, opts?.env),
    ...mint.env,
    LOCUS_HOME: home,
    LOCUS_SESSION_ID: mint.session_id,
    LOCUS_NOTIFY: "0",
    LOCUS_QUIET: "1",
  };

  const handle: LocusSessionHandle = {
    sessionId: mint.session_id,
    binding: mint.binding,
    tenant: mint.tenant,
    expiresAt: mint.expires_at,
    env,
    mint,
  };

  return await fn(handle);
}

// ---------------------------------------------------------------------------
// MCP config merge (pure + path helper)
// ---------------------------------------------------------------------------

/**
 * Build the locus MCP server entry (names/paths only — never secrets).
 */
export function locusServerSpec(opts?: MergeLocusMcpOptions): McpServerEntry {
  const home =
    opts?.locusHome ?? process.env.LOCUS_HOME ?? join(homedir(), ".locus");
  const env: Record<string, string> = {
    LOCUS_HOME: home,
    LOCUS_NOTIFY: "0",
    LOCUS_CLIENT: opts?.client ?? "ashlr-hub",
  };
  if (opts?.sessionId) {
    env.LOCUS_SESSION_ID = opts.sessionId;
  }
  return {
    command: opts?.command ?? MCP_COMMAND,
    args: [],
    env,
  };
}

/**
 * Parse MCP JSON text into an object. Empty/invalid → `{ mcpServers: {} }`.
 * Pure; never throws.
 */
export function parseMcpConfigJson(raw: string): McpConfigJson {
  const text = (raw ?? "").trim();
  if (!text) {
    return { mcpServers: {} };
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return { mcpServers: {} };
    }
    return v as McpConfigJson;
  } catch {
    return { mcpServers: {} };
  }
}

function serverEntryEqual(a: unknown, b: McpServerEntry): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Pure: merge locus server into an MCP config object under `mcpServers`.
 * Does not write the filesystem. Preserves other servers and top-level keys.
 */
export function mergeLocusIntoMcpConfig(
  config: McpConfigJson | Record<string, unknown> | null | undefined,
  opts?: MergeLocusMcpOptions,
): MergeLocusMcpResult {
  const serverName = opts?.name ?? "locus";
  const entry = locusServerSpec(opts);
  const base: McpConfigJson =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...(config as McpConfigJson) }
      : { mcpServers: {} };

  const existingServers =
    base.mcpServers &&
    typeof base.mcpServers === "object" &&
    !Array.isArray(base.mcpServers)
      ? { ...base.mcpServers }
      : {};

  const prev = existingServers[serverName];
  const changed = !serverEntryEqual(prev, entry);
  existingServers[serverName] = entry;

  return {
    config: { ...base, mcpServers: existingServers },
    changed,
    serverName,
  };
}

/**
 * Read MCP JSON at `path`, merge locus server, write if changed.
 * Creates parent directories. Safe for project `.mcp.json` / `.cursor/mcp.json`.
 *
 * @example
 * ```ts
 * registerLocusInMcpConfig(".mcp.json", { client: "ashlr-hub" });
 * ```
 */
export function registerLocusInMcpConfig(
  path: string,
  opts?: MergeLocusMcpOptions,
): RegisterLocusMcpResult {
  if (!path?.trim()) {
    throw new LocusMcpConfigError("path is required");
  }
  const created = !existsSync(path);
  let raw = "";
  if (!created) {
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new LocusMcpConfigError(
        `failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const parsed = parseMcpConfigJson(raw);
  const merged = mergeLocusIntoMcpConfig(parsed, opts);

  if (!merged.changed && !created) {
    return {
      ...merged,
      path,
      written: false,
      created: false,
    };
  }

  try {
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, `${JSON.stringify(merged.config, null, 2)}\n`, "utf8");
  } catch (e) {
    throw new LocusMcpConfigError(
      `failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    ...merged,
    path,
    written: true,
    created,
  };
}

// ---------------------------------------------------------------------------
// MCP / doctor integration helpers
// ---------------------------------------------------------------------------

/**
 * MCP server specs hub should register (names only — values never here).
 */
export function locusMcpServerSpecs(locusHome?: string): Record<
  string,
  { command: string; args: string[]; env: Record<string, string> }
> {
  const home = locusHome ?? process.env.LOCUS_HOME ?? join(homedir(), ".locus");
  const locus = locusServerSpec({ locusHome: home });
  return {
    locus: {
      command: locus.command,
      args: locus.args ?? [],
      env: locus.env ?? {},
    },
    // phantom registered by hub's ecosystem probe separately
  };
}

/**
 * Doctor line for `ashlr doctor` — names only, never secrets.
 * @see integrations/ashlr-hub/doctor-check.md
 */
export function locusDoctorLine(): {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
} {
  const probe = locusAgentReport();
  if (!probe.available) {
    return {
      id: "locus",
      ok: false,
      detail: "locus CLI not installed",
      fix: "cargo install --git https://github.com/ashlrai/locus --package locus-cli --locked",
    };
  }
  if (!probe.report) {
    return {
      id: "locus",
      ok: false,
      detail: probe.error ?? "agent report failed",
      fix: "locus agent setup --apply --client all",
    };
  }
  const r = probe.report;
  const detail = `status=${r.status} pin=${r.status_oneline} ready=${r.ready}`;
  return {
    id: "locus",
    ok: probe.gateOk,
    detail,
    fix: probe.gateOk
      ? undefined
      : (r.next_steps?.[0] ?? "locus enter <alias> && locus agent setup --apply"),
  };
}

/** True when ~/.locus exists (initialized). */
export function locusHomeInitialized(): boolean {
  const home = process.env.LOCUS_HOME ?? join(homedir(), ".locus");
  return existsSync(home);
}
