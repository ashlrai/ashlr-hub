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

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
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
import { killSwitchOn } from '../sandbox/policy.js';
import { newUsage, estCostUsd } from './budget.js';
import { withToolEnv } from '../env-bridge.js';
import { scrubSecrets } from '../knowledge/index.js';
import { selectInboxStore } from '../seams/inbox.js';
import { hashDiff, signProvenance } from '../foundry/provenance.js';
// M249: RunCache shadow mode — key construction + store (import lazy so flag-off path
// incurs zero module load cost; the dynamic import is cached by Node after first call).
import { buildCacheKeyInput, buildCacheKey } from '../fabric/cache/key.js';
// M275: completeness + self-verify gate (additive, flag-off byte-identical).
import { runCompletenessGate } from './completeness-gate.js';
import { lookup as cacheLookup, write as cacheWrite } from '../fabric/cache/store.js';
import type { CacheEntry } from '../fabric/cache/store.js';
// M195: resolve api-model keys (e.g. NVIDIA_NIM_API_KEY) via the engine-auth
// mechanism — phantom vault first, then process.env. Never logs the value.
import { resolveProviderKey } from '../integrations/secrets.js';
// M264: elite context injection for local api-model engines (local-coder, local-agent).
// Frontier engines (claude, codex) are never modified. Flag-off → no-op.
import {
  buildLocalContextBundle,
  renderLocalContextBundle,
  isLocalContextEnabled,
} from './local-context.js';

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

type SpawnEngineResult = {
  ok: boolean;
  output: string;
  usage?: { tokensIn: number; tokensOut: number };
  error?: string;
  terminationReason?: TerminationReason;
};

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

const TRANSIENT_ABORT_RE =
  /\b(aborted_streaming|error_during_execution|stream aborted|network error|econnreset|socket hang up|fetch failed|etimedout)\b/i;

export function isTransientAbort(res: SpawnEngineResult, hasDiff: boolean): boolean {
  if (res.ok) return false;
  if (hasDiff) return false;
  if (
    res.terminationReason === 'idle-stall' ||
    res.terminationReason === 'loop-stall' ||
    res.terminationReason === 'no-diff-stall' ||
    res.terminationReason === 'backstop-timeout'
  ) {
    return false;
  }
  return TRANSIENT_ABORT_RE.test(`${res.error ?? ''}\n${res.output ?? ''}`);
}

function dispatchMaxAttempts(cfg: AshlrConfig): number {
  const raw = (cfg.foundry as { dispatchRetries?: number } | undefined)?.dispatchRetries;
  const retries = Number.isFinite(raw) ? Math.max(0, Math.floor(raw as number)) : 2;
  return 1 + Math.min(retries, 5);
}

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
 * M127/M260 — resolve a concrete model string for `engine`.
 *
 * Priority:
 *   1. cfg.foundry?.models?.[engine]   (operator-configured concrete model)
 *   2. capturedModel                    (model the run actually used, e.g. from
 *                                        opts.model when the caller captured it)
 *   3. process.env.ASHLR_MODEL          (runtime override)
 *   4. spec.defaultModel                (M260: registry canonical default for this
 *                                        engine — resolves cli-agent entries like
 *                                        claude/codex that have no api.defaultModel.
 *                                        Makes `codex:default` → `codex:gpt-5.5` so
 *                                        frontier proposals can pass evaluateMergeAuthority
 *                                        even when no explicit model was configured.)
 *   5. spec.api?.defaultModel           (api-model registry default — e.g. local-coder)
 *   6. 'default'                        (genuinely unknown — still REJECTED by
 *                                        evaluateMergeAuthority, by design)
 *
 * The merge-authority gate still rejects ':default'. Priorities 4–5 ensure that
 * frontier cli-agent engines (claude, codex) resolve to their authorised concrete
 * model rather than falling through to ':default' when opts.model is absent.
 * Non-frontier engines (local-coder, nim, etc.) are unaffected — their tier
 * check in evaluateMergeAuthority refuses them regardless of the model string.
 */
export function resolveConcreteModel(
  engine: EngineId,
  cfg: AshlrConfig,
  capturedModel?: string,
): string {
  const spec = resolveEngineSpec(engine, cfg);
  return (
    cfg.foundry?.models?.[engine] ||
    capturedModel ||
    process.env.ASHLR_MODEL ||
    spec?.defaultModel ||
    spec?.api?.defaultModel ||
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

  // M289: the ashlr plugin installs global PreToolUse hooks (HOME→~/.claude) that,
  // in the default 'redirect' mode, intercept/redirect (and for some tools BLOCK)
  // the agent's NATIVE Read/Grep/Edit/Bash in favor of ashlr__ MCP equivalents.
  // The fleet's NESTED claude agent inherits these hooks — and the redirect failed
  // in the sandbox context, BLOCKING its native Read calls → permission_denials →
  // aborted_streaming → ZERO edits → empty diffs → 0 proposals (root cause of the
  // substantial-task failure, found via M288 observability). Set 'nudge' so the
  // hooks DON'T block the nested agent's native tools — it must be able to WORK
  // (the token-saving redirect is irrelevant for a one-shot autonomous run). The
  // agent still has the ashlr__ MCP tools available (M248) and may use them.
  env.ASHLR_HOOK_MODE = 'nudge';

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

// ---------------------------------------------------------------------------
// M248: ashlr-plugin MCP config injection
// ---------------------------------------------------------------------------

/**
 * Resolve the ashlr binary path (used as the MCP server command).
 * Returns the absolute path when found on PATH, or null when absent.
 * Pure, best-effort — never throws.
 */
function resolveAshlrBin(): string | null {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probe, ['ashlr'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Write a minimal `.mcp.json` into the worktree so the fleet's claude instance
 * always has ashlr__ MCP tools regardless of the user's global settings.
 *
 * GUARD: only writes when `ashlr` is on PATH — CI/CD environments without the
 * plugin are completely unaffected (returns null → caller skips --mcp-config).
 *
 * M283 PRE-EXISTING GUARD: if `.mcp.json` already exists in the worktree before
 * the fleet writes it, we skip writing entirely and return null. This means the
 * agent can legitimately edit a pre-existing `.mcp.json` (it is NOT fleet-written)
 * and that edit will appear in the proposal diff as expected.
 *
 * M283 DIFF EXCLUSION: after writing, registers `.mcp.json` in the worktree's
 * `.git/info/exclude` file so `git add -A` never stages the fleet-written file.
 * This guarantees the fleet-infra file NEVER leaks into any proposal diff, which
 * previously caused the judge to return 'review' instead of 'ship' (M283).
 * Best-effort — a failure in exclude registration is silently suppressed; the
 * sandboxDiff pathspec filter (worktree.ts) is an independent belt-and-suspenders.
 *
 * Returns the path to the written file, or null when the plugin is absent.
 * Never throws — any failure is silently suppressed so it never breaks dispatch.
 */
export function writeMcpConfigIfAvailable(worktreePath: string): string | null {
  try {
    const ashlrBin = resolveAshlrBin();
    if (!ashlrBin) return null;

    const mcpConfigPath = join(worktreePath, '.mcp.json');
    // Only write if the worktree path exists (sanity check).
    if (!existsSync(worktreePath)) return null;

    // M283: if .mcp.json already exists (the target repo has its own), skip
    // writing — the agent may legitimately edit it, and we must not clobber it
    // or add an exclude entry that would suppress that legitimate edit.
    if (existsSync(mcpConfigPath)) return null;

    const mcpConfig = {
      mcpServers: {
        ashlr: {
          command: ashlrBin,
          args: ['mcp'],
          env: {
            ASHLR_MCP_HOST: 'ashlr-fleet-engine',
            ASHLR_HOOK_MODE: 'redirect',
            ASHLR_SESSION_LOG: '0',
          },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    // M283: register .mcp.json in the worktree's git exclude file so `git add -A`
    // never stages the fleet-written infra file. The worktree's gitdir is found via
    // `git rev-parse --git-dir` run inside the worktree — for a linked worktree this
    // resolves to the per-worktree gitdir (e.g. <source>/.git/worktrees/<id>), NOT
    // the main .git directory, so this never affects the source repo's exclude.
    // Best-effort: failure is silently suppressed — sandboxDiff's pathspec filter
    // is an independent second layer.
    try {
      const gitdirRaw = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      if (gitdirRaw) {
        // gitdir may be relative (e.g. ".git") or absolute (worktree gitdir).
        const gitdir = gitdirRaw.startsWith('/') ? gitdirRaw : join(worktreePath, gitdirRaw);
        const infoDir = join(gitdir, 'info');
        const excludePath = join(infoDir, 'exclude');
        mkdirSync(infoDir, { recursive: true });
        // Only append if not already excluded (idempotent).
        const existing = existsSync(excludePath)
          ? readFileSync(excludePath, 'utf8')
          : '';
        if (!existing.split('\n').some((l) => l.trim() === '.mcp.json')) {
          appendFileSync(excludePath, '\n# ashlr M283: fleet-infra file — excluded from proposal diff\n.mcp.json\n', 'utf8');
        }
      }
    } catch {
      // Exclude registration is best-effort — never fails the run.
    }

    return mcpConfigPath;
  } catch {
    // Best-effort: never fail the run if MCP config can't be written.
    return null;
  }
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

  if (killSwitchOn() || (cfg.foundry as { killSwitch?: boolean } | undefined)?.killSwitch === true) {
    return { state: mk({ status: 'failed', result: 'autonomy kill-switch is ON' }) };
  }

  const wt = await import('../sandbox/worktree.js');

  // Acquire a worktree (reuse the caller's when provided).
  let sb: Sandbox;
  let createdHere = false;
  if (opts.existingWorktree) {
    sb = opts.existingWorktree;
  } else {
    try {
      sb = wt.createSandbox(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
      createdHere = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: mk({ status: 'failed', result: `sandbox unavailable: ${msg}` }) };
    }
  }

  const hooksDir = installPrePushBlocker();
  const env = buildContainedEnv(cfg, hooksDir);

  // M248: inject CLAUDE_SESSION_ID so fleet savings land under nameable
  // ashlr-fleet-* keys in ~/.ashlr/stats.json — visible in ashlr__savings.
  env.CLAUDE_SESSION_ID = `ashlr-fleet-${id}`;

  let proposalId: string | undefined;

  // M248: write .mcp.json to worktree (guarded: only when ashlr is on PATH).
  // fleetMcp defaults to true (on) — set cfg.foundry.fleetMcp = false to opt out.
  const fleetMcpEnabled = (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;
  let mcpConfigPath: string | null = null;
  if (fleetMcpEnabled) {
    mcpConfigPath = writeMcpConfigIfAvailable(sb.worktreePath);
  }

  // M154: prepend repo-map + localization context to goal when flags are ON.
  // Flag-OFF → contextPrefix is '' → goalWithContext === goal (byte-identical).
  const contextPrefix = buildM154ContextPrefix(goal, opts.sourceRepo, cfg);
  const goalWithContext = contextPrefix ? contextPrefix + goal : goal;

  try {
    let cmd = buildEngineCommand(engine, goalWithContext, cfg, {
      cwd: sb.worktreePath,
      model,
      autonomous: true,
    });

    // M248: inject --mcp-config into the claude argv when .mcp.json was written.
    // Codex does not support --mcp-config (no equivalent flag) — skip silently.
    // Any other cli-agent: skip (safe no-op fallback).
    if (cmd && mcpConfigPath && engine === 'claude') {
      cmd = { ...cmd, args: [...cmd.args, '--mcp-config', mcpConfigPath] };
    }
    if (!cmd) {
      return { state: mk({ status: 'failed', result: `no command for engine "${engine}"` }) };
    }

    // M249: RunCache SHADOW MODE — compute the key and log would-hit/would-miss.
    // SAFETY INVARIANT: this block NEVER short-circuits the spawn. It is purely
    // observational. The spawn always proceeds regardless of hit/miss.
    // Flag-off (default): the entire block is skipped → byte-identical behavior.
    let _shadowCacheKey: string | undefined;
    try {
      const fabricCfg = (cfg.foundry as Record<string, unknown> | undefined)?.['fabric'] as
        Record<string, unknown> | undefined;
      if (fabricCfg?.['cacheShadow'] === true) {
        const _keyInput = buildCacheKeyInput(engine, engineModel, tier, goalWithContext, opts.sourceRepo, cfg);
        _shadowCacheKey = buildCacheKey(_keyInput);
        const _hit = cacheLookup(cfg, _shadowCacheKey, opts.sourceRepo);
        // Log to decisions ledger (best-effort, fire-and-forget, never throws).
        try {
          const { recordDecision } = await import('../fleet/decisions-ledger.js');
          recordDecision({
            ts: new Date().toISOString(),
            proposalId: `shadow-${id}`,
            action: 'proposed',
            engine,
            model: engineModel,
            detail: JSON.stringify({
              event: 'fabric.shadow',
              cacheKey: _shadowCacheKey,
              wouldHit: _hit !== null,
              repoTreeSha: _keyInput.repoTreeSha,
              dirtyHash: _keyInput.dirtyHash,
            }),
          });
        } catch { /* telemetry is best-effort */ }
        // NEVER short-circuit here — always fall through to spawn below.
      }
    } catch { /* shadow hook is best-effort — never affects run */ }

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
    // M246: capture wall-clock duration for durationMs telemetry.
    // M297: retry only empty-diff transient aborts. Partial work, stall
    // terminations, and non-transient failures fall through to the existing
    // capture/proposal path.
    const maxAttempts = dispatchMaxAttempts(cfg);
    let res: SpawnEngineResult = { ok: false, output: '', error: 'engine did not run' };
    let _spawnDurationMs = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const _spawnStart = Date.now();
      res = await spawnEngine(cmd, cfg, {
        env,
        timeoutMs: cfg.foundry?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        launcher: launcher ?? undefined,
      });
      _spawnDurationMs += Date.now() - _spawnStart;

      if (res.ok) break;

      let hasDiff = false;
      try {
        const diff = wt.sandboxDiff(sb);
        hasDiff = diff.files > 0 && diff.patch.trim().length > 0;
      } catch {
        hasDiff = false;
      }

      if (attempt < maxAttempts && isTransientAbort(res, hasDiff)) {
        continue;
      }
      break;
    }

    const terminationReason: TerminationReason | undefined = res.terminationReason;

    // M288: DISPATCH OBSERVABILITY — persist the agent's stdout + outcome to a
    // durable per-run log (survives sandbox cleanup) so empty-diff dispatches are
    // debuggable. Previously res.output was discarded (only kept transiently as the
    // RunState.result), making it impossible to see WHY an agent produced no edits.
    // Best-effort, never-throws, additive — does not affect run behavior.
    try {
      const _logDir = join(process.env.HOME ?? process.env.USERPROFILE ?? tmpdir(), '.ashlr', 'agent-logs');
      mkdirSync(_logDir, { recursive: true });
      writeFileSync(
        join(_logDir, `${id}.log`),
        `=== ${engine} (${engineModel}) sandbox=${sb.id} worktree=${sb.worktreePath} ===\n` +
          `ok=${res.ok} terminationReason=${terminationReason ?? '-'} durationMs=${_spawnDurationMs}\n` +
          `error=${res.error ?? '-'}\n` +
          `tokensIn=${res.usage?.tokensIn ?? '?'} tokensOut=${res.usage?.tokensOut ?? '?'}\n` +
          `cmd=${cmd.bin} ${cmd.args.join(' ').slice(0, 400)}\n` +
          `--- agent output (truncated 40k) ---\n${String(res.output ?? '').slice(0, 40_000)}\n`,
        'utf8',
      );
    } catch {
      // observability is best-effort — never affects the run
    }

    const _resUsage = res.usage;
    const _computedCost = _resUsage
      ? estCostUsd(engine, _resUsage.tokensIn, _resUsage.tokensOut)
      : 0;
    const usage = _resUsage
      ? {
          tokensIn: _resUsage.tokensIn,
          tokensOut: _resUsage.tokensOut,
          steps: 1,
          estCostUsd: _computedCost,
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
            // M275: completeness gate — partial runs are always blocked by default.
            // Flag-off (completenessGate === false) → skip gate, preserve pre-M275 behavior.
            if (cfg.foundry?.completenessGate !== false) {
              const _gateResult = await runCompletenessGate({
                worktreePath: sb.worktreePath,
                diff,
                goal,
                cfg,
                isPartial: true,
              });
              if (!_gateResult.pass) {
                console.log(`[M275] completeness gate blocked partial proposal: ${_gateResult.reason}`);
                // Partial run with blocked gate — do not file as proposal.
              } else {
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
            } else {
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
          // M275: completeness + self-verify gate. Runs typecheck/test in the
          // sandbox worktree before filing. Flag-off → byte-identical to pre-M275.
          let _m275ShouldFile = true;
          if (cfg.foundry?.completenessGate !== false) {
            const _gateResult = await runCompletenessGate({
              worktreePath: sb.worktreePath,
              diff,
              goal,
              cfg,
            });
            if (!_gateResult.pass) {
              console.log(`[M275] completeness gate blocked proposal: ${_gateResult.reason}`);
              _m275ShouldFile = false;
            }
          }
          if (_m275ShouldFile) {
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
          // M246: record telemetry fields on the decision entry (additive, never-throws).
          try {
            const { recordDecision } = await import('../fleet/decisions-ledger.js');
            recordDecision({
              ts: new Date().toISOString(),
              proposalId: proposal.id,
              action: 'proposed',
              engine,
              model: engineModel,
              costUsd: _computedCost,
              tokensIn: _resUsage?.tokensIn,
              tokensOut: _resUsage?.tokensOut,
              durationMs: _spawnDurationMs,
              cacheHit: _resUsage ? (_resUsage.tokensIn === 0 && _computedCost === 0) : false,
            });
          } catch {
            // telemetry is best-effort — never fails the run
          }
          // M249: RunCache shadow write — record the (key → outcome) entry for
          // measurement. Fire-and-forget, never throws, never changes run behavior.
          // Flag-off (default cacheShadow === false) → cacheWrite is a no-op.
          try {
            if (_shadowCacheKey) {
              const _entry: CacheEntry = {
                key: _shadowCacheKey,
                patch: scrubbed,
                provenanceSig,
                engineModel,
                tier,
                diffHash,
                repoTreeSha: (() => {
                  try {
                    return execSync('git rev-parse HEAD:', {
                      cwd: opts.sourceRepo,
                      encoding: 'utf8',
                      stdio: ['pipe', 'pipe', 'pipe'],
                    }).trim();
                  } catch { return 'unknown'; }
                })(),
                verdictAtWrite: 'unknown',
                shipOutcomes: { ship: 0, reject: 0 },
                createdAt: new Date().toISOString(),
                lastHit: new Date().toISOString(),
                hits: 0,
                schemaVersion: 1,
              };
              cacheWrite(cfg, _entry, opts.sourceRepo);
            }
          } catch { /* shadow write is best-effort */ }
          } // end if (_m275ShouldFile)
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
      sb = wt.createSandbox(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
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

    // M264: build elite context bundle for local engines (flag-gated, never-throws).
    // Frontier engines are excluded by isLocalContextEnabled. Flag-off → systemPrefix
    // is undefined → runTask system prompt is byte-identical to pre-M264.
    let m264SystemPrefix: string | undefined;
    if (isLocalContextEnabled(engine, cfg)) {
      try {
        const bundle = await buildLocalContextBundle(goal, sb.worktreePath, cfg);
        const rendered = renderLocalContextBundle(bundle);
        if (rendered.length > 0) m264SystemPrefix = rendered;
      } catch {
        // Context injection is best-effort — never fails the run.
      }
    }

    await runTask(task, client, {
      tools,
      budget,
      usage,
      onStep: () => { /* steps are not persisted for sandboxed api-model runs */ },
      systemPrefix: m264SystemPrefix,
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
