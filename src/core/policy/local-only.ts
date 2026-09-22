/**
 * local-only.ts — LOCAL-ONLY is a REFUSAL, not a preference.
 *
 * WHY THIS EXISTS
 * ---------------
 * Mason's paid frontier windows (claude / codex / grok seats) are exhausted. A
 * routing policy that merely *deprioritises* cloud engines still spends real
 * money the moment a cascade escalates, a quota check fails open, or a fallback
 * branch picks the "best available" engine. Local-only closes that: when the
 * mode is ON a cloud engine is UNREACHABLE, and the refusal names the engine and
 * the mode instead of surfacing as a mysteriously worse result.
 *
 * THE ONE PREDICATE
 * -----------------
 * `decidePermission()` is the single place that answers "is this subject
 * permitted right now". Every dispatch seam funnels into it through one of the
 * three convenience wrappers:
 *
 *   enginePermitted(engineId, cfg)    — fleet/backend dispatch (routers, sandboxed-engine)
 *   providerPermitted(providerId,cfg) — in-process provider chat (provider-client)
 *   endpointPermitted(baseUrl, cfg)   — raw OpenAI-compatible transport (buildOpenAICompatibleClient)
 *
 * There is deliberately no second mechanism. A new dispatch path that does not
 * call one of these is a BYPASS — that is the failure mode this module exists to
 * make impossible, so `test/local-only-dispatch-paths.test.ts` enumerates every
 * known path and asserts it refuses.
 *
 * MODE RESOLUTION (config + env, env can only ENABLE)
 * --------------------------------------------------
 *   persisted : cfg.foundry.localOnly === true   (canonical)
 *               cfg.models.localOnly === true    (also honoured; loose read)
 *   env       : ASHLR_LOCAL_ONLY
 *
 * The env var may turn local-only ON for a one-off session. It may NEVER turn a
 * persisted local-only OFF — an attempt is refused and reported in
 * `LocalOnlyMode.detail` so the operator can see that their env var did nothing.
 * Failing safe means failing toward local: an env value that is not an explicit
 * OFF token enables the mode.
 *
 * NO NEW RUNTIME DEPENDENCIES. Pure functions plus one documented process latch
 * (see `latchLocalOnly`). No filesystem, no network, no logging of any value.
 */

import type { AshlrConfig, EngineId, EngineTier } from '../types.js';
import { resolveEngineRegistry, resolveEngineSpec } from '../run/engine-registry.js';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/** Environment variable that can turn local-only ON for one session. */
export const LOCAL_ONLY_ENV_VAR = 'ASHLR_LOCAL_ONLY';

/** Where the currently-effective local-only decision came from. */
export type LocalOnlySource = 'off' | 'config' | 'env' | 'config+env' | 'latch';

export interface LocalOnlyMode {
  /** True when cloud dispatch must be refused. */
  enabled: boolean;
  /** Which input produced `enabled`. */
  source: LocalOnlySource;
  /**
   * Operator-facing explanation. When an env var tried and failed to disable a
   * persisted local-only, that refusal is stated here — a silent no-op is
   * exactly the "mysteriously worse result" this module forbids.
   */
  detail: string;
}

/** Env tokens that express "off". Anything else non-empty means "on". */
const ENV_OFF_TOKENS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off', 'disabled', 'disable']);

type EnvIntent = 'on' | 'off' | 'unset';

type EnvLike = Record<string, string | undefined>;

function envIntent(env: EnvLike): { intent: EnvIntent; raw: string | undefined } {
  const raw = env[LOCAL_ONLY_ENV_VAR];
  if (raw === undefined) return { intent: 'unset', raw };
  const token = raw.trim().toLowerCase();
  if (token.length === 0) return { intent: 'unset', raw };
  // FAIL SAFE TOWARD LOCAL: only an explicit off-token disables; a typo enables.
  return { intent: ENV_OFF_TOKENS.has(token) ? 'off' : 'on', raw };
}

/** Loose read of the persisted setting — no types.ts edit required. */
function configLocalOnly(cfg: AshlrConfig | undefined): boolean {
  if (!cfg) return false;
  const root = cfg as unknown as Record<string, unknown>;
  const foundry = root['foundry'] as Record<string, unknown> | undefined;
  if (foundry?.['localOnly'] === true) return true;
  const models = root['models'] as Record<string, unknown> | undefined;
  return models?.['localOnly'] === true;
}

// ---------------------------------------------------------------------------
// Process latch
// ---------------------------------------------------------------------------

/**
 * Some transport seams (notably `buildOpenAICompatibleClient`) are pure builders
 * with no AshlrConfig in hand, yet they are the last gate before bytes leave the
 * machine. Every real dispatch passes through a cfg-aware layer FIRST, so the
 * moment any cfg-aware caller resolves the mode we remember a persisted ON here
 * and the cfg-less seams can consult it.
 *
 * The latch is MONOTONIC on purpose: once a process has learned that the
 * operator wants local-only, nothing short of restarting it can un-learn that.
 * cfg-aware call sites always read the live cfg, so turning the setting off in
 * config takes effect there immediately; only the cfg-less seams stay latched.
 * Erring toward refusal is the whole point.
 */
let latchedConfigLocalOnly = false;

/** Record that a persisted local-only was observed. Monotonic; never unlatches. */
export function latchLocalOnly(enabled: boolean): void {
  if (enabled) latchedConfigLocalOnly = true;
}

/** True when a persisted local-only has been observed by this process. */
export function localOnlyLatched(): boolean {
  return latchedConfigLocalOnly;
}

/** Test-only: clear the monotonic latch so suites stay independent. */
export function __resetLocalOnlyLatchForTests(): void {
  latchedConfigLocalOnly = false;
}

// ---------------------------------------------------------------------------
// resolveLocalOnlyMode
// ---------------------------------------------------------------------------

/**
 * Resolve the effective local-only mode from config + env.
 *
 * Latches a persisted ON (see `latchLocalOnly`) so cfg-less transport seams
 * inherit it. Never throws.
 */
export function resolveLocalOnlyMode(
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyMode {
  const fromConfig = configLocalOnly(cfg);
  if (fromConfig) latchLocalOnly(true);
  const { intent, raw } = envIntent(env);

  if (fromConfig && intent === 'off') {
    return {
      enabled: true,
      source: 'config',
      detail:
        `local-only is ON (persisted: cfg.foundry.localOnly=true). ` +
        `${LOCAL_ONLY_ENV_VAR}=${JSON.stringify(raw ?? '')} asked to DISABLE it and was refused — ` +
        `the environment override can only enable local-only, never disable a persisted one. ` +
        `Set cfg.foundry.localOnly=false in ~/.ashlr/config.json to turn it off.`,
    };
  }
  if (fromConfig && intent === 'on') {
    return {
      enabled: true,
      source: 'config+env',
      detail:
        `local-only is ON (persisted cfg.foundry.localOnly=true, and ${LOCAL_ONLY_ENV_VAR} is set for this process).`,
    };
  }
  if (fromConfig) {
    return {
      enabled: true,
      source: 'config',
      detail: 'local-only is ON (persisted: cfg.foundry.localOnly=true).',
    };
  }
  if (intent === 'on') {
    return {
      enabled: true,
      source: 'env',
      detail:
        `local-only is ON for this process only (${LOCAL_ONLY_ENV_VAR} is set). ` +
        `Set cfg.foundry.localOnly=true to make it persistent.`,
    };
  }
  // The latch answers ONLY for callers with no config in hand. A caller that
  // passed a cfg gets the live answer — turning the setting off in config takes
  // effect immediately for every cfg-aware path.
  if (cfg === undefined && latchedConfigLocalOnly) {
    return {
      enabled: true,
      source: 'latch',
      detail:
        'local-only is ON — this process already observed a persisted cfg.foundry.localOnly=true. ' +
        'Restart the process after changing the setting to clear it.',
    };
  }
  return {
    enabled: false,
    source: 'off',
    detail:
      intent === 'off'
        ? `local-only is OFF (${LOCAL_ONLY_ENV_VAR} explicitly disabled, and no persisted setting enables it).`
        : 'local-only is OFF — cloud engines are reachable when otherwise permitted.',
  };
}

/**
 * Mode for a seam with no AshlrConfig in hand. Reads env + the process latch.
 * Cfg-aware callers MUST pass their cfg to `resolveLocalOnlyMode` instead.
 */
export function ambientLocalOnlyMode(env: EnvLike = process.env): LocalOnlyMode {
  return resolveLocalOnlyMode(undefined, env);
}

/** Convenience boolean. */
export function localOnlyEnabled(cfg?: AshlrConfig, env: EnvLike = process.env): boolean {
  return resolveLocalOnlyMode(cfg, env).enabled;
}

// ---------------------------------------------------------------------------
// Locality classification
// ---------------------------------------------------------------------------

/**
 * Where a subject's inference actually happens.
 *
 * NOTE: this is ORTHOGONAL to `EngineTier` ('local' | 'mid' | 'frontier'), which
 * is a TRUST tier. `local-coder` is tier 'mid' but locality 'local'; `nim` is
 * tier 'mid' but locality 'cloud'. Conflating the two is how money gets spent.
 */
export type EngineLocality = 'local' | 'cloud';

/**
 * CLI-agent engines whose inference runs on this machine. Mirrors the daemon's
 * LOCAL_ONLY_BACKENDS judgement (`src/core/daemon/loop.ts`) minus the non-CLI
 * entries. Everything else with kind 'cli-agent' (claude, codex, hermes,
 * opencode) reaches a vendor over the network and is classified 'cloud'.
 */
const LOCAL_CLI_AGENTS: ReadonlySet<string> = new Set(['ashlrcode', 'aw']);

/** Provider ids served from this machine. Everything else is treated as cloud. */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'ollama',
  'lmstudio',
  'llama-server',
  'llamaserver',
  'local',
  'builtin',
]);

/** The engine that is permitted in every mode: in-process, no model call. */
export const ALWAYS_PERMITTED_ENGINE = 'builtin' as EngineId;

/**
 * True when `baseUrl` points at this machine. Anything unparseable is treated as
 * NOT loopback — an endpoint we cannot understand must not be assumed free.
 */
export function isLoopbackEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return false;
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() keeps IPv6 hosts bracketed.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare === '0.0.0.0' || bare === '::') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * FALLBACK base URL for llama-server when it is not in the resolved registry.
 *
 * The registry entry is authoritative when present — the serving runtime owns
 * where llama-server actually is, and a policy that resolved the endpoint
 * independently could refuse a runtime the dispatcher is happily using, or
 * permit one it is not. This mirrors `run/engines.ts`'s inline resolution for
 * the case where no registry entry exists, and is kept local rather than
 * imported to avoid an import cycle through provider-client.ts.
 */
function llamaServerBaseUrl(cfg: AshlrConfig | undefined, env: EnvLike): string {
  const models = (cfg as unknown as Record<string, unknown> | undefined)?.['models'] as
    | Record<string, unknown>
    | undefined;
  const llamaServer = models?.['llamaServer'] as { baseUrl?: string } | undefined;
  return (
    llamaServer?.baseUrl?.trim() ||
    env['LLAMA_SERVER_BASE_URL']?.trim() ||
    'http://localhost:8080/v1'
  );
}

/**
 * Classify an engine id. Unknown engines are 'cloud' — an engine we cannot
 * account for must not be assumed free.
 */
export function engineLocality(
  engine: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): EngineLocality {
  const id = engine.trim().toLowerCase();
  if (id === ALWAYS_PERMITTED_ENGINE) return 'local';

  const spec = resolveEngineSpec(engine as EngineId, cfg);
  if (!spec) {
    // llama-server is the one engine that may legitimately be absent from the
    // registry (older builds synthesise its spec inline in run/engines.ts).
    if (id === 'llama-server') {
      return isLoopbackEndpoint(llamaServerBaseUrl(cfg, env)) ? 'local' : 'cloud';
    }
    return 'cloud';
  }
  if (spec.kind === 'builtin') return 'local';
  if (spec.kind === 'cli-agent') return LOCAL_CLI_AGENTS.has(id) ? 'local' : 'cloud';

  // api-model: the resolved base URL is the truth. A declared API key env is a
  // strong cloud signal, but a self-hosted endpoint behind a key is still local
  // if it answers on loopback — so the URL decides and the key does not.
  const api = spec.api;
  const fromEnv = api?.baseUrlEnv ? env[api.baseUrlEnv]?.trim() : undefined;
  const baseUrl = (fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ?? api?.defaultBaseUrl;
  return isLoopbackEndpoint(baseUrl) ? 'local' : 'cloud';
}

/** Classify a provider id from `providers.ts` / the plugin provider registry. */
export function providerLocality(providerId: string): EngineLocality {
  return LOCAL_PROVIDER_IDS.has(providerId.trim().toLowerCase()) ? 'local' : 'cloud';
}

/**
 * Resolve the engine id behind an executable name.
 *
 * `spawnEngine` receives an `EngineCommand` that carries only `bin` — the
 * engine id is gone by then. Every CLI-agent subprocess in the hub funnels
 * through that one function, so being able to answer "which engine is this
 * binary?" is what lets the last-resort spawn gate exist at all.
 *
 * Matches on the basename (the bin is resolved to an absolute path before
 * spawning) against each cli-agent spec's declared `bin`/`bins`. Returns
 * undefined for a binary no engine claims.
 */
export function engineIdForBin(bin: string, cfg?: AshlrConfig): string | undefined {
  const raw = bin.trim();
  if (raw.length === 0) return undefined;
  const base = (raw.split(/[\\/]/).pop() ?? raw).toLowerCase().replace(/\.exe$/, '');
  if (base.length === 0) return undefined;
  const registry = resolveEngineRegistry(cfg);
  for (const [id, spec] of Object.entries(registry)) {
    if (spec.kind !== 'cli-agent') continue;
    const names = [spec.bin, ...(spec.bins ?? [])]
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map((n) => (n.split(/[\\/]/).pop() ?? n).toLowerCase().replace(/\.exe$/, ''));
    if (names.includes(base) || id.toLowerCase() === base) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

/** What kind of thing a permission question is about. */
export type LocalOnlySubjectKind = 'engine' | 'provider' | 'endpoint';

export interface LocalOnlySubject {
  kind: LocalOnlySubjectKind;
  /** Engine id, provider id, or base URL — whatever the operator would recognise. */
  id: string;
  locality: EngineLocality;
}

export interface LocalOnlyVerdict {
  /** False means: do not dispatch. Refuse, loudly, naming `reason`. */
  permitted: boolean;
  subject: LocalOnlySubject;
  mode: LocalOnlyMode;
  /** Null iff permitted. Names the subject, the mode, and the remedy. */
  reason: string | null;
}

const SUBJECT_NOUN: Readonly<Record<LocalOnlySubjectKind, string>> = {
  engine: 'engine',
  provider: 'provider',
  endpoint: 'endpoint',
};

/**
 * THE decision. Every dispatch path in the hub reaches cloud inference only by
 * passing through this function and honouring `permitted === false`.
 *
 * Pure. Never throws.
 */
export function decidePermission(
  subject: LocalOnlySubject,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  const mode = resolveLocalOnlyMode(cfg, env);
  if (!mode.enabled || subject.locality === 'local') {
    return { permitted: true, subject, mode, reason: null };
  }
  return { permitted: false, subject, mode, reason: refusalReason(subject, mode) };
}

/**
 * The one refusal sentence. Names the subject, quotes the mode's own account of
 * how it resolved, and says what would change it — so an operator reading a
 * refused run never has to guess whether they hit a policy or a bug.
 */
function refusalReason(subject: LocalOnlySubject, mode: LocalOnlyMode): string {
  const noun = SUBJECT_NOUN[subject.kind];
  return (
    `local-only: refusing to dispatch to cloud ${noun} '${subject.id}'. ${mode.detail} ` +
    `No cloud ${noun} is reachable while local-only is on — ` +
    `run this work on a local engine (builtin, local-coder, llama-server), or turn the mode off with ` +
    `cfg.foundry.localOnly=false (and unset ${LOCAL_ONLY_ENV_VAR}).`
  );
}

/** Is this ENGINE permitted right now? */
export function enginePermitted(
  engine: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  return decidePermission(
    { kind: 'engine', id: engine, locality: engineLocality(engine, cfg, env) },
    cfg,
    env,
  );
}

/** Is this PROVIDER permitted right now? */
export function providerPermitted(
  providerId: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  return decidePermission(
    { kind: 'provider', id: providerId, locality: providerLocality(providerId) },
    cfg,
    env,
  );
}

/** Is this raw OpenAI-compatible ENDPOINT permitted right now? */
export function endpointPermitted(
  baseUrl: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  return decidePermission(
    {
      kind: 'endpoint',
      id: baseUrl,
      locality: isLoopbackEndpoint(baseUrl) ? 'local' : 'cloud',
    },
    cfg,
    env,
  );
}

/**
 * Is the engine behind this EXECUTABLE permitted right now?
 *
 * The last-resort gate for `spawnEngine`, which is handed a bin rather than an
 * engine id. A binary that maps to no known engine is permitted — it is not a
 * hub-managed agent, and refusing every unrecognised executable would break
 * phantom wrapping and local tooling. Every engine the hub can actually route
 * to IS in the registry, so a cloud seat always resolves.
 */
export function binPermitted(
  bin: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  const id = engineIdForBin(bin, cfg);
  if (id === undefined) {
    return {
      permitted: true,
      subject: { kind: 'engine', id: bin, locality: 'local' },
      mode: resolveLocalOnlyMode(cfg, env),
      reason: null,
    };
  }
  return enginePermitted(id, cfg, env);
}

/**
 * Ask about a subject the caller has ALREADY classified as cloud — e.g. a plugin
 * provider whose registry entry declares `tier: 'cloud'`, which no id-based
 * heuristic here could know.
 */
export function cloudSubjectPermitted(
  kind: LocalOnlySubjectKind,
  id: string,
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyVerdict {
  return decidePermission({ kind, id, locality: 'cloud' }, cfg, env);
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/** Thrown by seams whose contract is to throw (provider-client). */
export class LocalOnlyRefusal extends Error {
  /** Stable machine-readable discriminator. */
  readonly code = 'LOCAL_ONLY_REFUSED' as const;
  readonly verdict: LocalOnlyVerdict;

  constructor(verdict: LocalOnlyVerdict) {
    super(verdict.reason ?? 'local-only: refused');
    this.name = 'LocalOnlyRefusal';
    this.verdict = verdict;
  }
}

/** True when `err` is a local-only refusal (works across module realms). */
export function isLocalOnlyRefusal(err: unknown): err is LocalOnlyRefusal {
  if (err instanceof LocalOnlyRefusal) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'LOCAL_ONLY_REFUSED'
  );
}

/** Throw `LocalOnlyRefusal` when `verdict` refuses; otherwise return. */
export function assertPermitted(verdict: LocalOnlyVerdict): void {
  if (!verdict.permitted) throw new LocalOnlyRefusal(verdict);
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** Keep only engines permitted under the current mode. */
export function filterPermittedEngines<T extends string>(
  engines: readonly T[],
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): T[] {
  const mode = resolveLocalOnlyMode(cfg, env);
  if (!mode.enabled) return [...engines];
  return engines.filter((e) => engineLocality(e, cfg, env) === 'local');
}

/**
 * Engines from `candidates` that sit at `tier` AND are permitted right now.
 * Used by the cascade to decide whether an escalation target can ever be
 * reached — an unreachable tier must terminate the cascade cleanly instead of
 * being retried into a wall.
 */
export function permittedEnginesAtTier(
  tier: EngineTier,
  candidates: readonly EngineId[],
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): EngineId[] {
  return candidates.filter((engine) => {
    const resolvedTier = engine === ALWAYS_PERMITTED_ENGINE
      ? 'local'
      : resolveEngineSpec(engine, cfg)?.tier ?? 'local';
    if (resolvedTier !== tier) return false;
    return enginePermitted(engine, cfg, env).permitted;
  });
}

/**
 * Short, log-safe summary for a route reason string. Contains no key material
 * and no endpoint credentials — only the subject id and the mode source.
 */
export function localOnlyReasonTag(verdict: LocalOnlyVerdict): string {
  return `local-only(${verdict.mode.source}): cloud ${SUBJECT_NOUN[verdict.subject.kind]} '${verdict.subject.id}' refused`;
}

// ---------------------------------------------------------------------------
// Operator surface
// ---------------------------------------------------------------------------

/** One engine the policy refuses, paired with the refusal it actually hands back. */
export interface LocalOnlyEngineRefusal {
  engine: string;
  /** The dispatcher's own message — for quoting, never for paraphrasing. */
  reason: string;
}

/**
 * Everything an operator surface needs to render the switch honestly, computed
 * in ONE place so a status panel and the dispatcher can never disagree about
 * which engines are reachable.
 */
export interface LocalOnlyPolicySnapshot {
  enabled: boolean;
  source: LocalOnlySource;
  /**
   * Engines that are unreachable while the mode is on, each with its refusal.
   * Populated whether or not the mode is currently enabled, so a UI can preview
   * the impact of turning it on before anyone commits to it.
   */
  refuses: LocalOnlyEngineRefusal[];
  /**
   * False when the mode is pinned for this process and editing the persisted
   * setting would not change it — i.e. the env enabled it, or the process has
   * latched. Offering an editable switch in that state is a lie.
   */
  mutable: boolean;
  /** The mode's own explanation, including a refused attempt to disable via env. */
  detail: string;
}

/**
 * Build the operator snapshot. Read-only: resolves the mode, classifies every
 * engine in the resolved registry, and returns what each cloud engine would be
 * told. Never throws, never contacts anything.
 */
export function localOnlyPolicySnapshot(
  cfg?: AshlrConfig,
  env: EnvLike = process.env,
): LocalOnlyPolicySnapshot {
  const mode = resolveLocalOnlyMode(cfg, env);
  // For the refusal LIST we want the message an engine WOULD get, so a preview
  // works while the mode is still off.
  const asIfEnabled: LocalOnlyMode = mode.enabled
    ? mode
    : {
        enabled: true,
        source: 'config',
        detail: 'local-only would be ON (preview — the mode is currently off).',
      };

  const ids = new Set<string>(Object.keys(resolveEngineRegistry(cfg)));
  ids.add('llama-server'); // may be synthesised inline rather than registered
  const refuses: LocalOnlyEngineRefusal[] = [];
  for (const id of [...ids].sort()) {
    if (engineLocality(id, cfg, env) !== 'cloud') continue;
    refuses.push({
      engine: id,
      reason: refusalReason({ kind: 'engine', id, locality: 'cloud' }, asIfEnabled),
    });
  }

  return {
    enabled: mode.enabled,
    source: mode.source,
    // 'config' and 'off' are settable by writing the config; the rest are pinned
    // for this process (env-set, or latched) and cannot be edited away.
    mutable: mode.source === 'config' || mode.source === 'off',
    refuses,
    detail: mode.detail,
  };
}
