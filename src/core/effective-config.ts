/**
 * Read-only effective config snapshot for operator visibility.
 *
 * This deliberately projects a curated subset of autonomy/daemon/foundry/backend
 * settings instead of dumping arbitrary config. Secret-like values are omitted;
 * API credentials are represented only by env var names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AshlrConfig,
  AutoMergeTrustBasis,
  EngineId,
  EngineKind,
  EngineTier,
  ProtectedRemoteRequiredCheckExpectation,
} from './types.js';
import { defaultConfig, loadConfig } from './config.js';
import { resolveAutonomyControlMode } from './fleet/status.js';
import { resolveSelectionCanary, type SelectionCanaryDisabledReason } from './fabric/selection-canary.js';
import { resolveEngineRegistry } from './run/engine-registry.js';

export type EffectiveConfigSource = 'configured' | 'default' | 'derived';

export interface EffectiveConfigValue<T> {
  value: T;
  source: EffectiveConfigSource;
  path?: string;
}

export interface EffectiveBackendConfig {
  backend: string;
  allowed: boolean;
  kind: EngineKind | 'unknown';
  tier: EngineTier | 'unknown';
  model: EffectiveConfigValue<string | null>;
  apiKeyEnvName?: string;
  baseUrlEnvName?: string;
  defaultBaseUrl?: string;
  source: EffectiveConfigSource;
}

export interface EffectiveConfigSnapshot {
  generatedAt: string;
  configPath: string;
  configFile: {
    exists: boolean;
    parsed: boolean;
  };
  autonomy: {
    controlMode: EffectiveConfigValue<ReturnType<typeof resolveAutonomyControlMode>>;
    controlLoop: EffectiveConfigValue<boolean>;
    routingPolicy: EffectiveConfigValue<string>;
    learnedRouting: EffectiveConfigValue<boolean>;
    resourceAwareDispatch: EffectiveConfigValue<boolean>;
    killSwitch: EffectiveConfigValue<boolean>;
  };
  daemon: {
    dailyBudgetUsd: EffectiveConfigValue<number>;
    perTickItems: EffectiveConfigValue<number>;
    parallel: EffectiveConfigValue<number>;
    intervalMs: EffectiveConfigValue<number>;
    mode: EffectiveConfigValue<'batch' | 'continuous'>;
    maxConcurrent: EffectiveConfigValue<number>;
    concurrency: {
      local: EffectiveConfigValue<number>;
      cloud: EffectiveConfigValue<number>;
      total: EffectiveConfigValue<number>;
    };
    idleBackoffMs: EffectiveConfigValue<number>;
    contextRollup: {
      enabled: EffectiveConfigValue<boolean>;
      cadenceHours: EffectiveConfigValue<number>;
      minTerminalTrajectories: EffectiveConfigValue<number>;
    };
  };
  foundry: {
    enabled: EffectiveConfigValue<boolean>;
    allowedBackends: EffectiveConfigValue<string[]>;
    sandboxExternal: EffectiveConfigValue<boolean>;
    completenessGate: EffectiveConfigValue<boolean>;
    fleetMcp: EffectiveConfigValue<boolean>;
    minItemValue: EffectiveConfigValue<number>;
    scanners: {
      todos: EffectiveConfigValue<boolean>;
      deps: EffectiveConfigValue<boolean>;
      dependencyBumps: EffectiveConfigValue<boolean>;
      lint: EffectiveConfigValue<boolean>;
      hygiene: EffectiveConfigValue<boolean>;
    };
    autoMerge: {
      enabled: EffectiveConfigValue<boolean>;
      trustBasis: EffectiveConfigValue<AutoMergeTrustBasis>;
      maxRisk: EffectiveConfigValue<'low' | 'medium' | 'high'>;
      pushToRemote: EffectiveConfigValue<boolean>;
      protectedRemote: {
        branchProtection: EffectiveConfigValue<boolean>;
        requiredChecks: EffectiveConfigValue<ProtectedRemoteRequiredCheckExpectation[]>;
        requiredCheckIdentity: EffectiveConfigValue<'exact' | 'legacy' | 'invalid' | 'missing'>;
      };
      midToBranch: EffectiveConfigValue<boolean>;
      allowWithoutVerification: EffectiveConfigValue<boolean>;
    };
    fabric: {
      gateway: EffectiveConfigValue<boolean>;
      cacheShadow: EffectiveConfigValue<boolean>;
      cache: EffectiveConfigValue<boolean>;
      resourceAware: EffectiveConfigValue<boolean>;
      concurrentDispatch: EffectiveConfigValue<boolean>;
      maxSlotsPerBackend: EffectiveConfigValue<number>;
      workhorseDispatch: EffectiveConfigValue<boolean>;
      selectionCanary: {
        requested: EffectiveConfigValue<boolean>;
        protocol: EffectiveConfigValue<'binary-uniform-v1' | null>;
        configEligible: EffectiveConfigValue<boolean>;
        enabled: EffectiveConfigValue<boolean>;
        disabledReason: EffectiveConfigValue<SelectionCanaryDisabledReason | 'producer-unavailable'>;
      };
    };
    local: {
      maxConcurrent: EffectiveConfigValue<number>;
      baseUrl: EffectiveConfigValue<string>;
    };
  };
  backends: EffectiveBackendConfig[];
  warnings: string[];
}

interface RawConfigRead {
  exists: boolean;
  parsed: boolean;
  raw?: Record<string, unknown>;
}

interface ResolvedDaemonConfig {
  dailyBudgetUsd: number;
  perTickItems: number;
  parallel: number;
  intervalMs: number;
  mode: 'batch' | 'continuous';
  maxConcurrent: number;
  concurrency: { local: number; cloud: number; total: number };
  idleBackoffMs: number;
  contextRollup: {
    enabled: boolean;
    cadenceHours: number;
    minTerminalTrajectories: number;
  };
}

const CONFIG_PATH_AT_RUNTIME = () => join(homedir(), '.ashlr', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRawConfig(configPath: string): RawConfigRead {
  if (!existsSync(configPath)) return { exists: false, parsed: false };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    return isRecord(parsed)
      ? { exists: true, parsed: true, raw: parsed }
      : { exists: true, parsed: false };
  } catch {
    return { exists: true, parsed: false };
  }
}

function rawHas(raw: Record<string, unknown> | undefined, path: string): boolean {
  if (!raw) return false;
  let cur: unknown = raw;
  for (const part of path.split('.')) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part];
  }
  return true;
}

function value<T>(
  raw: Record<string, unknown> | undefined,
  path: string,
  resolved: T,
  fallbackSource: EffectiveConfigSource = 'default',
): EffectiveConfigValue<T> {
  return {
    value: resolved,
    source: rawHas(raw, path) ? 'configured' : fallbackSource,
    path,
  };
}

function boolValue(
  raw: Record<string, unknown> | undefined,
  path: string,
  resolved: boolean,
  fallbackSource: EffectiveConfigSource = 'default',
): EffectiveConfigValue<boolean> {
  return value(raw, path, resolved, fallbackSource);
}

function positiveNumber(input: unknown, fallback: number, integer = false): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return fallback;
  return integer ? Math.floor(input) : input;
}

function resolveDaemon(cfg: AshlrConfig): ResolvedDaemonConfig {
  const o = cfg.daemon ?? {};
  const concLocal = positiveNumber(o.concurrency?.local, 2, true);
  const concCloud = positiveNumber(o.concurrency?.cloud, 6, true);
  const concTotal = positiveNumber(o.concurrency?.total, 8, true);
  const maxConcurrent = positiveNumber(
    o.maxConcurrent,
    typeof o.concurrency?.total === 'number' && o.concurrency.total > 0 ? Math.floor(o.concurrency.total) : 8,
    true,
  );
  return {
    dailyBudgetUsd: positiveNumber(o.dailyBudgetUsd, 1.0),
    perTickItems: positiveNumber(o.perTickItems, 3, true),
    parallel: typeof o.parallel === 'number' && Number.isFinite(o.parallel) && o.parallel > 0
      ? Math.min(Math.floor(o.parallel), 8)
      : 2,
    intervalMs: positiveNumber(o.intervalMs, 5 * 60_000),
    mode: o.mode === 'continuous' ? 'continuous' : 'batch',
    maxConcurrent,
    concurrency: { local: concLocal, cloud: concCloud, total: concTotal },
    idleBackoffMs: positiveNumber(o.idleBackoffMs, 5_000),
    contextRollup: {
      enabled: o.contextRollup?.enabled !== false,
      cadenceHours: Math.min(168, Math.max(1, positiveNumber(o.contextRollup?.cadenceHours, 24))),
      minTerminalTrajectories: Math.min(
        5_000,
        Math.max(25, positiveNumber(o.contextRollup?.minTerminalTrajectories, 50, true)),
      ),
    },
  };
}

function sourceFor(raw: Record<string, unknown> | undefined, path: string): EffectiveConfigSource {
  return rawHas(raw, path) ? 'configured' : 'default';
}

function effectiveBackends(
  cfg: AshlrConfig,
  raw: Record<string, unknown> | undefined,
  allowedBackends: string[],
  warnings: string[],
): EffectiveBackendConfig[] {
  const registry = resolveEngineRegistry(cfg);
  return allowedBackends.map((backend) => {
    const spec = registry[backend];
    if (!spec) {
      warnings.push(`Allowed backend "${backend}" has no resolved engine registry entry.`);
      return {
        backend,
        allowed: true,
        kind: 'unknown',
        tier: 'unknown',
        model: { value: null, source: 'default', path: `foundry.models.${backend}` },
        source: sourceFor(raw, 'foundry.allowedBackends'),
      };
    }
    const modelPath = `foundry.models.${backend}`;
    const model = cfg.foundry?.models?.[backend as EngineId] ??
      spec.defaultModel ??
      spec.api?.defaultModel ??
      null;
    return {
      backend,
      allowed: true,
      kind: spec.kind,
      tier: spec.tier,
      model: value(raw, modelPath, model, model === null ? 'default' : 'derived'),
      ...(spec.api?.envKey ? { apiKeyEnvName: spec.api.envKey } : {}),
      ...(spec.api?.baseUrlEnv ? { baseUrlEnvName: spec.api.baseUrlEnv } : {}),
      ...(spec.api?.defaultBaseUrl ? { defaultBaseUrl: spec.api.defaultBaseUrl } : {}),
      source: sourceFor(raw, 'foundry.allowedBackends'),
    };
  });
}

function requiredCheckIdentityMode(
  checks: ProtectedRemoteRequiredCheckExpectation[] | undefined,
): 'exact' | 'legacy' | 'invalid' | 'missing' {
  if (!Array.isArray(checks) || checks.length === 0) return 'missing';
  if (checks.every((check) => typeof check === 'string' && check.trim().length > 0)) return 'legacy';
  if (checks.some((check) => typeof check === 'string')) return 'invalid';

  const contexts = new Set<string>();
  for (const check of checks) {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) return 'invalid';
    const context = typeof check.context === 'string' ? check.context.trim() : '';
    const appId = check.appId;
    const validAppId =
      (typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0) ||
      (typeof appId === 'string' && /^[1-9]\d*$/.test(appId));
    if (!context || !validAppId || contexts.has(context)) return 'invalid';
    contexts.add(context);
  }
  return 'exact';
}

/**
 * M340: every foundry key this version reads — union of the types.ts foundry
 * interface members and the dynamic `foundry[...]` / `foundry?.x` reads across
 * src/. INCLUSIVE list: a stray entry only suppresses a warning, never causes
 * one. Regenerate when adding foundry keys:
 *   grep -rhoE "foundry\??\.[a-zA-Z]+|foundry[^;]{0,60}\[['\"][a-zA-Z]+['\"]\]" src/
 */
const KNOWN_FOUNDRY_KEYS: ReadonlySet<string> = new Set([
  // M340a: three keys the first mechanical extraction missed (they are read
  // via `(cfg.foundry as Record<string, unknown> | undefined)?.['key']`
  // casts) — confirmed consumed by an agent sweep: acePlaybook
  // (strategist.ts:812, manager.ts), localization (sandboxed-engine.ts:170),
  // redTeam (automerge-pass.ts:660).
  'acePlaybook', 'localization', 'redTeam',
  'allowedBackends', 'antiClog', 'ashlrcodeExecutor', 'askBorderlineReview',
  'autoArchiveAfterRejects', 'autoMerge', 'autonomyControlLoop', 'bestOfN',
  'bestOfNCandidates', 'bestOfNMinItemScore', 'blastRadius', 'browserVerify',
  'cascade', 'claude5', 'claudeResource', 'completenessGate', 'confinement',
  'counterfactual', 'counterfactualSampleCap', 'diffSafety', 'dispatchRetries',
  'edvUnverifiedWeight', 'edvVerify', 'engineFallbackOrder', 'engines',
  'eventBus', 'fabric', 'feedbackEnabled', 'fleetMcp', 'generative',
  'goalFocusActiveThreshold', 'goalFocusMode', 'goalPlanning', 'grok', 'intelligence', 'inventPerCycle',
  'judgeAllowedBackends', 'judgePerPass', 'killSwitch', 'kimi',
  'learnedRouting', 'limits', 'local', 'localContext', 'localModel',
  'managerJudgeEngine', 'managerJudgeModel', 'mergeAuthority', 'minItemValue',
  'modelGranularRouting', 'modelRacing', 'models', 'nim', 'ollamaBaseUrl',
  'outcomeWatcher', 'proposalTtlDays', 'pulseEmit', 'regressionSentinel',
  'repoMap', 'resourceAwareDispatch', 'resourceOverrides', 'routingPolicy',
  'sandboxExternal', 'scanDependencyBumps', 'scanDeps', 'scanHygiene',
  'scanLint', 'scanTodos', 'selfHeal', 'selfImprove', 'simpleConductor',
  'skillLibrary', 'specContract', 'stallIdleMs', 'strategistModel',
  'subscriptionMaxPercent', 'tasteCritic', 'timeoutMs', 'usePhantom',
  'verifyToGreen', 'visualGrounding',
]);

export function buildEffectiveConfigSnapshot(
  cfg: AshlrConfig,
  opts: {
    rawConfig?: Record<string, unknown>;
    configPath?: string;
    configExists?: boolean;
    configParsed?: boolean;
    now?: Date;
  } = {},
): EffectiveConfigSnapshot {
  const raw = opts.rawConfig;
  const warnings: string[] = [];
  const daemon = resolveDaemon(cfg);
  const foundryEnabled = cfg.foundry !== undefined;
  const allowedBackends = cfg.foundry?.allowedBackends?.length
    ? cfg.foundry.allowedBackends.map(String)
    : ['builtin'];
  const autoMerge = cfg.foundry?.autoMerge;
  const fabric = cfg.foundry?.fabric;
  const selectionCanary = resolveSelectionCanary(fabric?.selectionCanary, {
    gateway: fabric?.gateway === true,
    concurrentDispatch: fabric?.concurrentDispatch === true,
  });
  const local = cfg.foundry?.local;

  if (!opts.configExists) warnings.push('No config file existed when the snapshot was requested; loadConfig will bootstrap defaults.');
  if (opts.configExists && opts.configParsed === false) warnings.push('Config file could not be parsed as a JSON object; effective values come from defaults.');
  if (!rawHas(raw, 'daemon')) warnings.push('cfg.daemon is missing; daemon caps are hard-coded defaults.');
  if (!foundryEnabled) warnings.push('cfg.foundry is missing; fleet routing is effectively builtin-only and Foundry-only features are off.');
  if (foundryEnabled && !rawHas(raw, 'foundry.allowedBackends')) warnings.push('cfg.foundry.allowedBackends is missing; backend routing defaults to builtin only.');
  if (
    autoMerge?.enabled === true &&
    !cfg.foundry?.mergeAuthority?.length &&
    autoMerge.trustBasis !== 'verification' &&
    autoMerge.trustBasis !== 'evidence'
  ) {
    warnings.push('autoMerge.enabled is true but mergeAuthority is empty; tier-based main auto-merge will not authorize proposals.');
  }
  // M320: Sonnet 5 becomes the routing workhorse (M321) — if auto-merge is on
  // and an explicit mergeAuthority exists without a sonnet-5 entry, Sonnet 5
  // proposals verify + judge but silently never auto-merge. Surface it.
  if (
    autoMerge?.enabled === true &&
    (cfg.foundry?.mergeAuthority?.length ?? 0) > 0 &&
    cfg.foundry?.claude5?.enabled !== false &&
    !cfg.foundry?.mergeAuthority?.some(
      (e) => String(e.engine) === 'claude' && String(e.model).includes('sonnet-5'),
    )
  ) {
    warnings.push(
      'claude5 is enabled but mergeAuthority has no claude-sonnet-5 entry; Sonnet 5 proposals will never auto-merge. Add {engine:"claude",model:"claude-sonnet-5"} (and optionally claude-fable-5).',
    );
  }
  // M324: config-consistency — an explicit Fable pin with the fable flag off
  // means the explicit model STILL wins (strategistModel/managerJudgeModel
  // always override the default resolver), so the operator pays Fable costs
  // they believed they disabled. Surface the contradiction.
  {
    const claude5Cfg = cfg.foundry?.claude5;
    const fableOff = claude5Cfg?.enabled === false || claude5Cfg?.fable === false;
    const foundryRaw = cfg.foundry as Record<string, unknown> | undefined;
    const explicitFable = [foundryRaw?.['strategistModel'], foundryRaw?.['managerJudgeModel']].some(
      (m) => typeof m === 'string' && m.includes('fable'),
    );
    if (fableOff && explicitFable) {
      warnings.push(
        'strategistModel/managerJudgeModel pins a Fable model while claude5.fable is off; the explicit pin still wins — remove the pin or re-enable claude5.fable.',
      );
    }
  }
  // M340: unknown foundry keys. The JSON schema is not enforced at load time,
  // so a typo'd key (e.g. modelGranularRoutng) silently disables its feature
  // with zero feedback. Warn (never fatal) on keys this version does not
  // recognize — they are typos, keys removed in an upgrade, or config
  // consumed by an external tool.
  {
    const fRaw = cfg.foundry as Record<string, unknown> | undefined;
    if (fRaw) {
      const unknown = Object.keys(fRaw)
        .filter((k) => !KNOWN_FOUNDRY_KEYS.has(k))
        .sort();
      if (unknown.length > 0) {
        warnings.push(
          `foundry keys not recognized by this ashlr version (typo, removed, or consumed by an external tool?): ${unknown.join(', ')}`,
        );
      }
    }
  }

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    configPath: opts.configPath ?? CONFIG_PATH_AT_RUNTIME(),
    configFile: {
      exists: opts.configExists ?? false,
      parsed: opts.configParsed ?? false,
    },
    autonomy: {
      controlMode: { value: resolveAutonomyControlMode(cfg), source: 'derived' },
      controlLoop: boolValue(raw, 'foundry.autonomyControlLoop', foundryEnabled ? cfg.foundry?.autonomyControlLoop !== false : false),
      routingPolicy: value(raw, 'foundry.routingPolicy', cfg.foundry?.routingPolicy ?? 'balanced'),
      learnedRouting: boolValue(raw, 'foundry.learnedRouting', cfg.foundry?.learnedRouting !== false),
      resourceAwareDispatch: boolValue(raw, 'foundry.resourceAwareDispatch', cfg.foundry?.resourceAwareDispatch !== false),
      killSwitch: boolValue(raw, 'foundry.killSwitch', cfg.foundry?.killSwitch === true),
    },
    daemon: {
      dailyBudgetUsd: value(raw, 'daemon.dailyBudgetUsd', daemon.dailyBudgetUsd),
      perTickItems: value(raw, 'daemon.perTickItems', daemon.perTickItems),
      parallel: value(raw, 'daemon.parallel', daemon.parallel),
      intervalMs: value(raw, 'daemon.intervalMs', daemon.intervalMs),
      mode: value(raw, 'daemon.mode', daemon.mode),
      maxConcurrent: value(raw, 'daemon.maxConcurrent', daemon.maxConcurrent, rawHas(raw, 'daemon.concurrency.total') ? 'derived' : 'default'),
      concurrency: {
        local: value(raw, 'daemon.concurrency.local', daemon.concurrency.local),
        cloud: value(raw, 'daemon.concurrency.cloud', daemon.concurrency.cloud),
        total: value(raw, 'daemon.concurrency.total', daemon.concurrency.total),
      },
      idleBackoffMs: value(raw, 'daemon.idleBackoffMs', daemon.idleBackoffMs),
      contextRollup: {
        enabled: boolValue(
          raw,
          'daemon.contextRollup.enabled',
          daemon.contextRollup.enabled,
        ),
        cadenceHours: value(
          raw,
          'daemon.contextRollup.cadenceHours',
          daemon.contextRollup.cadenceHours,
        ),
        minTerminalTrajectories: value(
          raw,
          'daemon.contextRollup.minTerminalTrajectories',
          daemon.contextRollup.minTerminalTrajectories,
        ),
      },
    },
    foundry: {
      enabled: { value: foundryEnabled, source: foundryEnabled ? 'configured' : 'default', path: 'foundry' },
      allowedBackends: value(raw, 'foundry.allowedBackends', allowedBackends),
      sandboxExternal: boolValue(raw, 'foundry.sandboxExternal', foundryEnabled ? cfg.foundry?.sandboxExternal !== false : false),
      completenessGate: boolValue(raw, 'foundry.completenessGate', cfg.foundry?.completenessGate !== false),
      fleetMcp: boolValue(raw, 'foundry.fleetMcp', cfg.foundry?.fleetMcp !== false),
      minItemValue: value(raw, 'foundry.minItemValue', typeof cfg.foundry?.minItemValue === 'number' ? cfg.foundry.minItemValue : 2),
      scanners: {
        todos: boolValue(raw, 'foundry.scanTodos', cfg.foundry?.scanTodos === true),
        deps: boolValue(raw, 'foundry.scanDeps', cfg.foundry?.scanDeps === true),
        dependencyBumps: boolValue(raw, 'foundry.scanDependencyBumps', cfg.foundry?.scanDependencyBumps === true),
        lint: boolValue(raw, 'foundry.scanLint', cfg.foundry?.scanLint === true),
        hygiene: boolValue(raw, 'foundry.scanHygiene', cfg.foundry?.scanHygiene === true),
      },
      autoMerge: {
        enabled: boolValue(raw, 'foundry.autoMerge.enabled', autoMerge?.enabled === true),
        trustBasis: value(
          raw,
          'foundry.autoMerge.trustBasis',
          autoMerge?.trustBasis === 'verification' || autoMerge?.trustBasis === 'evidence'
            ? autoMerge.trustBasis
            : 'tier',
        ),
        maxRisk: value(raw, 'foundry.autoMerge.maxRisk', autoMerge?.maxRisk ?? 'low'),
        pushToRemote: boolValue(raw, 'foundry.autoMerge.pushToRemote', autoMerge?.pushToRemote === true),
        protectedRemote: {
          branchProtection: boolValue(
            raw,
            'foundry.autoMerge.protectedRemote.branchProtection',
            autoMerge?.protectedRemote?.branchProtection === true,
          ),
          requiredChecks: value(
            raw,
            'foundry.autoMerge.protectedRemote.requiredChecks',
            autoMerge?.protectedRemote?.requiredChecks ?? [],
          ),
          requiredCheckIdentity: value(
            raw,
            'foundry.autoMerge.protectedRemote.requiredChecks',
            requiredCheckIdentityMode(autoMerge?.protectedRemote?.requiredChecks),
            'derived',
          ),
        },
        midToBranch: boolValue(raw, 'foundry.autoMerge.midToBranch', autoMerge?.midToBranch === true),
        allowWithoutVerification: boolValue(raw, 'foundry.autoMerge.allowWithoutVerification', autoMerge?.allowWithoutVerification === true),
      },
      fabric: {
        gateway: boolValue(raw, 'foundry.fabric.gateway', fabric?.gateway === true),
        cacheShadow: boolValue(raw, 'foundry.fabric.cacheShadow', fabric?.cacheShadow === true),
        cache: boolValue(raw, 'foundry.fabric.cache', fabric?.cache === true),
        resourceAware: boolValue(raw, 'foundry.fabric.resourceAware', fabric?.resourceAware === true),
        concurrentDispatch: boolValue(raw, 'foundry.fabric.concurrentDispatch', fabric?.concurrentDispatch === true),
        maxSlotsPerBackend: value(raw, 'foundry.fabric.maxSlotsPerBackend', typeof fabric?.maxSlotsPerBackend === 'number' ? fabric.maxSlotsPerBackend : 3),
        workhorseDispatch: boolValue(raw, 'foundry.fabric.workhorseDispatch', fabric?.workhorseDispatch === true),
        selectionCanary: {
          requested: boolValue(raw, 'foundry.fabric.selectionCanary.enabled', selectionCanary.requested),
          protocol: value(
            raw,
            'foundry.fabric.selectionCanary.protocol',
            selectionCanary.protocol,
            selectionCanary.protocol === null ? 'derived' : undefined,
          ),
          configEligible: { value: selectionCanary.eligible, source: 'derived', path: 'foundry.fabric.selectionCanary' },
          // No caller consumes this config yet: receipt-bound execution remains
          // mandatory before a canary can become active.
          enabled: { value: false, source: 'derived', path: 'foundry.fabric.selectionCanary' },
          disabledReason: {
            value: selectionCanary.eligible ? 'producer-unavailable' : selectionCanary.disabledReason!,
            source: 'derived',
            path: 'foundry.fabric.selectionCanary',
          },
        },
      },
      local: {
        maxConcurrent: value(raw, 'foundry.local.maxConcurrent', typeof local?.maxConcurrent === 'number' ? local.maxConcurrent : 1),
        baseUrl: value(raw, 'foundry.local.baseUrl', local?.baseUrl ?? 'http://localhost:11434'),
      },
    },
    backends: effectiveBackends(cfg, raw, allowedBackends, warnings),
    warnings,
  };
}

export function loadEffectiveConfigSnapshot(): EffectiveConfigSnapshot {
  const configPath = CONFIG_PATH_AT_RUNTIME();
  const rawRead = readRawConfig(configPath);
  const cfg = rawRead.exists ? loadConfig() : defaultConfig();
  return buildEffectiveConfigSnapshot(cfg, {
    rawConfig: rawRead.raw,
    configPath,
    configExists: rawRead.exists,
    configParsed: rawRead.parsed,
  });
}
