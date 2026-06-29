/**
 * sandboxed-engine.ts — M45: run an external agent CLI (Claude Code / Codex)
 * INSIDE a throwaway git worktree and capture ONLY its diff as a PENDING inbox
 * proposal. This is the keystone that lets the autonomous fleet drive frontier
 * backends without ever touching the live tree.
 *
 * SECURITY MODEL (external CLIs are black boxes):
 *  - Edits are confined to an M21 sandbox worktree (cwd = worktreePath). The
 *    worktree shares the source repo's .git, so it inherits remotes — therefore
 *    we sever git's PUSH credential channel (see buildContainedEnv): no token
 *    env vars, no ssh-agent, GIT_TERMINAL_PROMPT=0, and a per-invocation
 *    `core.hooksPath` (via GIT_CONFIG_* env — NO shared-config mutation) whose
 *    `pre-push` hook hard-fails every push.
 *  - The agent still authenticates to ITS OWN vendor (Claude/Codex subscription)
 *    via its on-disk session reached through the preserved real HOME — a
 *    different credential channel from git push, which we cut.
 *  - We consume ONLY the captured worktree diff. The agent's own commits land on
 *    the throwaway scratch branch and are discarded with the sandbox.
 *  - RESIDUAL (documented): the filesystem is not jailed — the agent can READ
 *    outside the worktree. True OS isolation (container/VM) is a later milestone.
 *
 * ENTIRELY GATED: only reached when cfg.foundry opts in (or opts.sandboxEngine).
 * Default builtin-only behavior is unaffected.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M154: repo-map + localization pre-pass (flag-gated, zero-dep)
import { buildRepoMap, renderRepoMap } from './repo-map.js';
import { localize, renderLocalization } from './localize.js';

import type {
  AshlrConfig,
  EngineId,
  EngineTier,
  RunBudget,
  RunState,
  RunTask,
  RunUsage,
  Sandbox,
} from '../types.js';
import { buildEngineCommand, spawnEngine } from './engines.js';
import type { TerminationReason } from './run-monitor.js';
import { resolveEngineSpec } from './engine-registry.js';
import { buildOpenAICompatibleClient } from './provider-client.js';
import { runTask } from './agent-loop.js';
import {
  buildEngineerToolSpecs,
  type EngineerContext,
} from '../mcp-native-engineer.js';
import { buildSandboxLauncher, confinementProfileFor } from '../sandbox/confine.js';
import { audit as auditConfinement } from '../sandbox/audit.js';
import { newUsage, estCostUsd } from './budget.js';
import { withToolEnv } from '../env-bridge.js';
import { scrubSecrets } from '../knowledge/index.js';
import { selectInboxStore } from '../seams/inbox.js';
import { hashDiff, signProvenance } from '../foundry/provenance.js';
// M195: resolve api-model keys (e.g. NVIDIA_NIM_API_KEY) via the engine-auth
// mechanism — phantom vault first, then process.env. Never logs the value.
import { resolveProviderKey } from '../integrations/secrets.js';

export interface SandboxedEngineResult {
  /** Delegated RunState (status/usage/engineModel/engineTier). */
  state: RunState;
  /** Inbox proposal id when a non-empty diff was captured. */
  proposalId?: string;
}

export interface RunEngineSandboxedOptions {
  /** Absolute source repo the worktree forks from. */
  sourceRepo: string;
  /** Model id for the backend (else cfg.foundry.models[engine]). */
  model?: string;
  /** Budget hints recorded on the RunState. */
  budget?: Partial<RunBudget>;
  /** File the diff as a PENDING proposal (default true). */
  propose?: boolean;
  /** Reuse an existing worktree (e.g. the swarm's) instead of creating one. */
  existingWorktree?: Sandbox;
  /** Pre-generated run id (else one is generated). */
  runId?: string;
}

/**
 * Default hard wall-clock for an autonomous external run (10 min).
 * M233: lowered from 20 min — bounds the run while still allowing real agent
 * work; env/config-override (cfg.foundry.timeoutMs) still wins.
 */
// Generous backstop ONLY — real frontier agents (Claude Code/Codex) legitimately
// work for long periods on substantial features, so we do NOT impose an aggressive
// wall-clock kill. This 2h cap is a runaway-cost safety net; the proper termination
// is STALL-based (no-progress detection, M234) + async dispatch so a long run never
// blocks the loop. cfg.foundry.timeoutMs overrides. Partial work is captured (M233).
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;

// ---------------------------------------------------------------------------
// M154: repo-map + localization context prefix (flag-gated)
// ---------------------------------------------------------------------------

/**
 * Build a repo-map + localization context prefix for the given goal/repo.
 * Returns '' (empty string) when either flag is OFF — byte-identical to
 * the pre-M154 behaviour for all flag-off callers.
 *
 * Never throws.
 */
function buildM154ContextPrefix(
  goal: string,
  sourceRepo: string,
  cfg: AshlrConfig,
  hintedFiles?: string[],
): string {
  try {
    const repoMapOn = (cfg.foundry as Record<string, unknown> | undefined)?.['repoMap'] === true;
    const localizeOn = (cfg.foundry as Record<string, unknown> | undefined)?.['localization'] === true;
    if (!repoMapOn && !localizeOn) return '';

    const parts: string[] = [];

    if (repoMapOn) {
      const map = buildRepoMap(sourceRepo);
      const rendered = renderRepoMap(map);
      if (rendered) parts.push(rendered);

      if (localizeOn) {
        const loc = localize(
          { title: goal, files: hintedFiles },
          map,
        );
        const rendered2 = renderLocalization(loc);
        if (rendered2) parts.push(rendered2);
      }
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  } catch {
    return '';
  }
}

/** Credential-shaped env var names that must never reach the agent subprocess.
 * M107 (P2): broadened to cover PAT, API-key, OAuth, and generic credentials
 * variants that the original regex missed (e.g. GITHUB_PAT, X_API_KEY,
 * MY_OAUTH_TOKEN, DB_CREDS). ENGINE_AUTH_ALLOW still exempts the engine CLIs'
 * own subscription tokens so CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_AUTH_TOKEN survive.
 */
const CRED_ENV_DENY =
  /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;

/** The agent CLIs' OWN headless auth tokens. These ARE the engine's subscription
 * credential (e.g. `claude setup-token` exports CLAUDE_CODE_OAUTH_TOKEN) — not a
 * third-party secret — so they must survive CRED_ENV_DENY and reach the engine.
 *
 * M195 (NVIDIA NIM / Kimi K2): NVIDIA_NIM_API_KEY is DELIBERATELY NOT listed here.
 * NIM is an api-model engine driven IN-PROCESS by runApiModelSandboxed (below) —
 * it never spawns a CLI subprocess, so its bearer key must never be exported into
 * a subprocess env. The key is resolved in-process at dispatch time via the
 * engine-auth mechanism resolveProviderKey() (phantom vault → process.env), used
 * over the wire as an `Authorization: Bearer` header by buildOpenAICompatibleClient
 * and never logged. CRED_ENV_DENY correctly STRIPS NVIDIA_NIM_API_KEY from every
 * spawned cli-agent subprocess — that is the intended containment, not a gap. */
const ENGINE_AUTH_ALLOW = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);

/**
 * Trust tier of a backend. M50: read from the declarative engine registry (single
 * source of truth) rather than a hardcoded set — so a config-added backend is
 * tiered by its declared `tier`. An unknown engine is 'local' (never implicitly
 * frontier). The builtin registry maps {claude, codex} → 'frontier', all else →
 * 'local', identical to the pre-M50 FRONTIER_ENGINES behavior.
 */
export function engineTierOf(engine: EngineId, cfg?: AshlrConfig): EngineTier {
  return resolveEngineSpec(engine, cfg)?.tier ?? 'local';
}

/**
 * M127 — resolve a concrete model string for `engine`.
 *
 * Priority:
 *   1. cfg.foundry?.models?.[engine]   (operator-configured concrete model)
 *   2. capturedModel                    (model the run actually used, e.g. from
 *                                        opts.model when the caller captured it)
 *   3. process.env.ASHLR_MODEL          (runtime override)
 *   4. 'default'                        (genuinely unknown — still REJECTED by
 *                                        evaluateMergeAuthority, by design)
 *
 * The merge-authority gate still rejects ':default'. This helper CAPTURES the
 * real model so frontier proposals built with a configured/captured model can
 * actually pass the gate.
 */
export function resolveConcreteModel(
  engine: EngineId,
  cfg: AshlrConfig,
  capturedModel?: string,
): string {
  return (
    cfg.foundry?.models?.[engine] ||
    capturedModel ||
    process.env.ASHLR_MODEL ||
    'default'
  );
}

const PRE_PUSH_BLOCK =
  '#!/bin/sh\n' +
  '# ashlr M45: pushes are forbidden from a sandboxed-engine worktree.\n' +
  'echo "ashlr: git push is blocked inside the sandbox" >&2\n' +
  'exit 1\n';

/**
 * Build the contained env for an external agent subprocess. Preserves the agent's
 * OWN auth (real HOME + its config-home overrides) while severing git push creds.
 * `hooksDir` holds the pre-push blocker installed via per-invocation git config.
 */
export function buildContainedEnv(cfg: AshlrConfig, hooksDir: string): NodeJS.ProcessEnv {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const base: NodeJS.ProcessEnv = {};
  base.PATH = process.env.PATH ?? process.env.Path ?? '';
  if (realHome) base.HOME = realHome;
  base.LANG = process.env.LANG ?? 'C';
  if (process.env.TERM) base.TERM = process.env.TERM;
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR;

  // M230: USER + LOGNAME are required for macOS Keychain access. The Security
  // framework uses the OS username to locate the login keychain
  // (~/Library/Keychains/login.keychain-db). Without them, `claude` fails with
  // "Not logged in · Please run /login" even with HOME set and ~/.claude present,
  // because the Keychain lookup for "Claude Code-credentials" silently fails.
  //
  // USER and LOGNAME are IDENTITY vars — the OS username — NOT credentials.
  // Passing them does NOT weaken any security boundary: no secret value is
  // transmitted, git-push remains severed (GIT_TERMINAL_PROMPT=0 + pre-push hook
  // + no SSH_AUTH_SOCK remain in force), and the worktree containment is unchanged.
  if (process.env.USER) base.USER = process.env.USER;
  if (process.env.LOGNAME) base.LOGNAME = process.env.LOGNAME;

  if (process.platform === 'win32') {
    if (realHome) base.USERPROFILE = realHome;
    for (const k of ['SystemRoot', 'windir', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
      const v = process.env[k];
      if (v) base[k] = v;
    }
  }

  // Preserve the agent CLIs' OWN config homes — their subscription auth lives here.
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    const v = process.env[k];
    if (v) base[k] = v;
  }

  // Preserve the agent CLIs' OWN headless auth tokens (claude's CLAUDE_CODE_OAUTH_TOKEN
  // etc.) — the engine's subscription credential, which must reach the engine.
  for (const k of ENGINE_AUTH_ALLOW) {
    const v = process.env[k];
    if (v) base[k] = v;
  }

  // Layer ashlr non-secret config (OLLAMA_HOST, provider chain, paths, …).
  const env = withToolEnv(cfg, base);

  // Defensive: strip any credential-shaped var that slipped through.
  for (const k of Object.keys(env)) {
    if (CRED_ENV_DENY.test(k) && !ENGINE_AUTH_ALLOW.has(k)) delete env[k];
  }

  // Sever git's PUSH credential channels (the agent's vendor auth via HOME is untouched).
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  delete env.SSH_AUTH_SOCK;
  env.GIT_CONFIG_NOSYSTEM = '1';
  // Per-invocation core.hooksPath (no shared-config mutation) → pre-push blocker.
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = hooksDir;
  return env;
}

/** Create a temp hooks dir containing a pre-push blocker. Returns its path. */
function installPrePushBlocker(): string {
  const hooksDir = mkdtempSync(join(tmpdir(), 'ashlr-hooks-'));
  writeFileSync(join(hooksDir, 'pre-push'), PRE_PUSH_BLOCK, { mode: 0o755 });
  return hooksDir;
}

/**
 * Run `engine` on `goal` inside a sandbox worktree of `opts.sourceRepo`, capturing
 * the diff as a PENDING proposal. Never throws; failures surface as a 'failed'
 * RunState. Does NOT fall back to a raw (unsandboxed) run — that would defeat the
 * containment, so a sandbox-creation failure is terminal here.
 */
export async function runEngineSandboxed(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts: RunEngineSandboxedOptions,
): Promise<SandboxedEngineResult> {
  const model = opts.model ?? cfg.foundry?.models?.[engine];
  const engineModel = `${engine}:${resolveConcreteModel(engine, cfg, model)}`;
  const tier = engineTierOf(engine, cfg);
  const id =
    opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const mk = (over: Partial<RunState>): RunState => ({
    id,
    goal,
    engine,
    provider: 'external',
    engineModel,
    engineTier: tier,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: {
      maxTokens: opts.budget?.maxTokens ?? 0,
      maxSteps: opts.budget?.maxSteps ?? 0,
      allowCloud: opts.budget?.allowCloud ?? false,
    },
    usage: newUsage(),
    tasks: [],
    steps: [],
    status: 'running',
    ...over,
  });

  const wt = await import('../sandbox/worktree.js');

  // Acquire a worktree (reuse the caller's when provided).
  let sb: Sandbox;
  let createdHere = false;
  if (opts.existingWorktree) {
    sb = opts.existingWorktree;
  } else {
    try {
      sb = wt.createSandbox(opts.sourceRepo);
      createdHere = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: mk({ status: 'failed', result: `sandbox unavailable: ${msg}` }) };
    }
  }

  const hooksDir = installPrePushBlocker();
  const env = buildContainedEnv(cfg, hooksDir);
  let proposalId: string | undefined;

  // M154: prepend repo-map + localization context to goal when flags are ON.
  // Flag-OFF → contextPrefix is '' → goalWithContext === goal (byte-identical).
  const contextPrefix = buildM154ContextPrefix(goal, opts.sourceRepo, cfg);
  const goalWithContext = contextPrefix ? contextPrefix + goal : goal;

  try {
    const cmd = buildEngineCommand(engine, goalWithContext, cfg, {
      cwd: sb.worktreePath,
      model,
      autonomous: true,
    });
    if (!cmd) {
      return { state: mk({ status: 'failed', result: `no command for engine "${engine}"` }) };
    }

    // M52: compute the OS-level sandbox launcher for this engine.
    // confinementProfileFor is pure; buildSandboxLauncher may throw when
    // onUnsupported:'fail' and the platform has no jail binary — that
    // propagates as a failed run (caught in spawnEngine's never-throw wrapper).
    // buildContainedEnv, the pre-push hook, and the diff/provenance logic are
    // all unchanged — the launcher wraps the final spawn only.
    const confinementProfile = confinementProfileFor(engine, cfg);
    const launcher = buildSandboxLauncher(confinementProfile, {
      worktree: sb.worktreePath,
      home: process.env.HOME ?? process.env.USERPROFILE,
      env: env,
    });

    // Emit confinement audit event (append-only, never throws).
    auditConfinement({
      action: 'confinement.run',
      repo: sb.worktreePath,
      sandboxId: sb.id,
      summary: `engine=${engine} mode=${confinementProfile.mode ?? 'off'} platform=${process.platform} launched=${launcher !== null} networkEgress=${confinementProfile.networkEgress ?? false}`,
      result: 'ok',
    });

    // M236: spawnEngine is now async + streaming. The stall monitor is wired
    // inside spawnEngineInner (engines.ts) and terminates the child on stall
    // conditions (idle / loop / no-diff). terminationReason surfaces here via
    // the return value and is recorded on the RunState.
    const res = await spawnEngine(cmd, cfg, {
      env,
      timeoutMs: cfg.foundry?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      launcher: launcher ?? undefined,
    });

    const terminationReason: TerminationReason | undefined = res.terminationReason;

    const usage = res.usage
      ? {
          tokensIn: res.usage.tokensIn,
          tokensOut: res.usage.tokensOut,
          steps: 1,
          estCostUsd: estCostUsd(engine, res.usage.tokensIn, res.usage.tokensOut),
        }
      : newUsage();

    if (!res.ok) {
      // M233: even on timeout/non-zero exit, attempt to capture a partial diff.
      // If the agent did real work before the cap, save it as a PENDING proposal
      // marked isPartial:true so the judge/reviewer knows it may be incomplete.
      // A truly-empty diff (agent made no edits) is not filed — no-op run stays blocked.
      if (opts.propose !== false) {
        try {
          const diff = wt.sandboxDiff(sb);
          if (diff.files > 0 && diff.patch.trim().length > 0) {
            const scrubbed = scrubSecrets(diff.patch);
            const diffHash = hashDiff(scrubbed);
            const provenanceSig = signProvenance(engineModel, tier, diffHash);
            const proposal = selectInboxStore(cfg).create({
              repo: sb.sourceRepo,
              origin: 'agent',
              kind: 'patch',
              title: `[partial] ${engine} run: ${goal.slice(0, 78)}`,
              summary:
                `Partial ${engineModel} run (timed-out / non-zero exit) produced ` +
                `${diff.files} file(s) (+${diff.insertions}/-${diff.deletions}). ` +
                `Engine error: ${res.error ?? 'unknown'}. Review before applying.`,
              diff: scrubbed,
              diffHash,
              provenanceSig,
              sandboxId: sb.id,
              engineModel,
              engineTier: tier,
              isPartial: true,
            });
            proposalId = proposal.id;
          }
        } catch {
          // diff/proposal capture is best-effort — never fail the run on it.
        }
      }
      return {
        state: mk({ status: 'failed', result: `engine "${engine}" failed: ${res.error ?? 'unknown error'}`, usage, terminationReason }),
        proposalId,
      };
    }

    // Capture the worktree diff (best-effort) and file it as a PENDING proposal.
    if (opts.propose !== false) {
      try {
        const diff = wt.sandboxDiff(sb);
        if (diff.files > 0 && diff.patch.trim().length > 0) {
          // M47.1 (H3): scrub ONCE and reuse the same scrubbed string for BOTH
          // the stored diff and the signed hash — so the merge gate recomputes
          // an identical hash. Bind {engineModel, tier, diffHash} with an HMAC
          // so a forged on-disk record cannot claim frontier merge-authority.
          const scrubbed = scrubSecrets(diff.patch);
          const diffHash = hashDiff(scrubbed);
          const provenanceSig = signProvenance(engineModel, tier, diffHash);
          const proposal = selectInboxStore(cfg).create({
            repo: sb.sourceRepo,
            origin: 'agent',
            kind: 'patch',
            title: `${engine} run: ${goal.slice(0, 80)}`,
            summary:
              `Sandboxed ${engineModel} run produced ${diff.files} file(s) ` +
              `(+${diff.insertions}/-${diff.deletions}). Review before applying.`,
            diff: scrubbed,
            diffHash,
            provenanceSig,
            sandboxId: sb.id,
            engineModel,
            engineTier: tier,
          });
          proposalId = proposal.id;
        }
      } catch {
        // diff/proposal capture is best-effort — never fail the run on it.
      }
    }

    return { state: mk({ status: 'done', result: res.output, usage }), proposalId };
  } finally {
    try {
      rmSync(hooksDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    if (createdHere) {
      try {
        wt.removeSandbox(sb);
      } catch {
        // removal is idempotent
      }
    }
  }
}

// ---------------------------------------------------------------------------
// M117: runApiModelSandboxed — in-process api-model dispatch
// ---------------------------------------------------------------------------

/**
 * Run an api-model engine (e.g. local-coder / Ollama) IN-PROCESS inside a
 * sandbox worktree, capturing the resulting diff as a PENDING inbox proposal.
 *
 * Unlike runEngineSandboxed (which spawns a CLI subprocess), this function:
 *   1. Builds a ProviderClient for the engine's api config (openai-compat →
 *      Ollama at http://localhost:11434/v1, or whatever baseUrl is configured).
 *   2. Gives the agent-loop engineer write-tools (read_file / write_file /
 *      edit_file / bash) scoped to the sandbox worktree so every edit lands
 *      ONLY in the throwaway branch.
 *   3. Captures the worktree diff and files it as a PENDING proposal — identical
 *      provenance/scrub/sign path as runEngineSandboxed.
 *
 * Security model: identical to runEngineSandboxed for filesystem containment
 * (edits go into the worktree only). Network is NOT OS-jailed (the in-process
 * agent makes fetch calls directly) — the same residual as cli-agent sandbox,
 * and intentional: Ollama runs at localhost:11434 which must be reachable.
 */
export async function runApiModelSandboxed(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts: RunEngineSandboxedOptions,
): Promise<SandboxedEngineResult> {
  const spec = resolveEngineSpec(engine, cfg);
  if (!spec || spec.kind !== 'api-model' || !spec.api) {
    return {
      state: {
        id: `run-${Date.now().toString(36)}`,
        goal,
        engine,
        provider: 'none',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        budget: { maxTokens: 0, maxSteps: 0, allowCloud: false },
        usage: newUsage(),
        tasks: [],
        steps: [],
        status: 'failed',
        result: `engine "${engine}" is not an api-model — cannot run in-process`,
      },
    };
  }

  const modelFromCfg = opts.model ?? cfg.foundry?.models?.[engine] ?? spec.api.defaultModel ?? '';
  const model = modelFromCfg || (spec.api.defaultModel ?? '');
  const engineModel = `${engine}:${resolveConcreteModel(engine, cfg, model || undefined)}`;
  const tier = engineTierOf(engine, cfg);
  const id = opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const mk = (over: Partial<RunState>): RunState => ({
    id,
    goal,
    engine,
    provider: spec.api!.protocol ?? 'openai-compat',
    engineModel,
    engineTier: tier,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: {
      maxTokens: opts.budget?.maxTokens ?? 50_000,
      maxSteps: opts.budget?.maxSteps ?? 40,
      allowCloud: opts.budget?.allowCloud ?? false,
    },
    usage: newUsage(),
    tasks: [],
    steps: [],
    status: 'running',
    ...over,
  });

  const wt = await import('../sandbox/worktree.js');

  // Acquire sandbox worktree (reuse caller's when provided).
  let sb: Sandbox;
  let createdHere = false;
  if (opts.existingWorktree) {
    sb = opts.existingWorktree;
  } else {
    try {
      sb = wt.createSandbox(opts.sourceRepo);
      createdHere = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: mk({ status: 'failed', result: `sandbox unavailable: ${msg}` }) };
    }
  }

  let proposalId: string | undefined;

  try {
    // Build baseUrl — honour env override, then spec default, then Ollama fallback.
    const baseUrlEnv = spec.api.baseUrlEnv;
    const baseUrl = (baseUrlEnv && process.env[baseUrlEnv]?.trim()) ||
      spec.api.defaultBaseUrl ||
      'http://localhost:11434/v1';
    // M195: source the bearer key via the engine-auth mechanism (phantom vault
    // first, then process.env) so NVIDIA_NIM_API_KEY etc. work whether stored in
    // the phantom vault or the raw env. The VALUE is never logged or returned.
    const apiKey = (spec.api.envKey && resolveProviderKey(spec.api.envKey, cfg)?.trim()) || '';

    // qwen2.5:72b confirms tool_calls — treat all local-coder models as tool-capable.
    const supportsTools = true;

    const client = buildOpenAICompatibleClient(baseUrl, apiKey, model, supportsTools);

    // Engineer tools scoped to the sandbox worktree — write/exec enabled so the
    // model can make real file edits inside the throwaway branch.
    const engCtx: EngineerContext = {
      workspaceRoot: sb.worktreePath,
      sourceRepo: sb.sourceRepo,
      allowWrite: true,
      allowExec: false, // exec disabled: keep blast radius minimal for local model
    };
    const tools = buildEngineerToolSpecs(engCtx);

    const budget = {
      maxTokens: opts.budget?.maxTokens ?? 50_000,
      maxSteps: opts.budget?.maxSteps ?? 40,
      allowCloud: false,
    };
    const usage: RunUsage = newUsage();

    // M154: prepend repo-map + localization context to goal when flags are ON.
    // Flag-OFF → contextPrefix2 is '' → task.goal === goal (byte-identical).
    const contextPrefix2 = buildM154ContextPrefix(goal, opts.sourceRepo, cfg);
    const goalWithContext2 = contextPrefix2 ? contextPrefix2 + goal : goal;

    const task: RunTask = {
      id: 't1',
      goal: goalWithContext2,
      deps: [],
      status: 'pending',
    };

    await runTask(task, client, {
      tools,
      budget,
      usage,
      onStep: () => { /* steps are not persisted for sandboxed api-model runs */ },
    });

    const finalUsage: RunUsage = {
      ...usage,
      estCostUsd: estCostUsd(engine, usage.tokensIn, usage.tokensOut),
    };

    if (task.status === 'failed') {
      return {
        state: mk({
          status: 'failed',
          result: task.error ?? 'api-model run failed',
          usage: finalUsage,
        }),
      };
    }

    // Capture worktree diff and file as PENDING proposal.
    if (opts.propose !== false) {
      try {
        const diff = wt.sandboxDiff(sb);
        if (diff.files > 0 && diff.patch.trim().length > 0) {
          const scrubbed = scrubSecrets(diff.patch);
          const diffHash = hashDiff(scrubbed);
          const provenanceSig = signProvenance(engineModel, tier, diffHash);
          const proposal = selectInboxStore(cfg).create({
            repo: sb.sourceRepo,
            origin: 'agent',
            kind: 'patch',
            title: `${engine} run: ${goal.slice(0, 80)}`,
            summary:
              `In-process ${engineModel} run produced ${diff.files} file(s) ` +
              `(+${diff.insertions}/-${diff.deletions}). Review before applying.`,
            diff: scrubbed,
            diffHash,
            provenanceSig,
            sandboxId: sb.id,
            engineModel,
            engineTier: tier,
          });
          proposalId = proposal.id;
        }
      } catch {
        // diff/proposal capture is best-effort
      }
    }

    return {
      state: mk({ status: 'done', result: task.result ?? '', usage: finalUsage }),
      proposalId,
    };
  } finally {
    if (createdHere) {
      try {
        wt.removeSandbox(sb!);
      } catch {
        // removal is idempotent
      }
    }
  }
}
