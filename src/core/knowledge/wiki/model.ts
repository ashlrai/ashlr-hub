/**
 * wiki/model.ts — which model writes wiki pages and answers Ask, and whether
 * this repo's code may leave the machine at all.
 *
 * ROUTING. The wiki reuses the Leader's seat plan (vision/leader-seat.ts
 * `planLeaderSeats`) in CHECK-IN mode, which is the audited "text in, text out,
 * no tools" recipe with the existing budget and grant gates:
 *   - local models (Ollama on loopback) — always candidates, free;
 *   - grok (the SuperGrok CLI seat) — only when the standing grant lists that
 *     seat for the leader role, the router finds headroom in the published
 *     capacity snapshot, and nothing below forces local-only;
 *   - Claude — NEVER: check-in mode excludes it in the planner, and this module
 *     drops any Claude step again (Claude is Mason's reserve);
 *   - codex — never (the Leader's rules).
 * With no local model and no granted grok seat there is no engine, and the
 * wiki falls back to facts-only pages / extractive answers. Nothing silently
 * spends.
 *
 * LOCAL-ONLY (private code never reaches a remote model) is forced when ANY of:
 *   - global local-only mode (cfg.foundry.localOnly / ASHLR_LOCAL_ONLY);
 *   - the budget mode is `reserve`;
 *   - cfg.foundry.wiki.localOnly === true (every repo);
 *   - the repo is listed in cfg.foundry.wiki.localOnlyRepos (path or name);
 *   - the repo's own `.ashlr/wiki.json` says `"localOnly": true`.
 * The grok transport re-checks `enginePermitted('grok-cli')` per call as well.
 */

import path from 'node:path';

import type { AshlrConfig } from '../../types.js';
import { localOnlyEnabled } from '../../policy/local-only.js';

export type WikiEngineKind = 'local' | 'grok' | 'test';

export interface WikiEngine {
  /** e.g. `local:qwen3.8:27b` or `grok:grok-4`. */
  label: string;
  kind: WikiEngineKind;
  /** True when the call never leaves this machine. */
  local: boolean;
  complete(system: string, user: string): Promise<string>;
}

export interface WikiEngineRequest {
  promptChars: number;
  localOnly: boolean;
  purpose: 'page' | 'ask';
}

export interface WikiEngineChoice {
  engines: WikiEngine[];
  /** Why there is no engine (or why some were skipped), for the UI/CLI. */
  note: string | null;
}

export type WikiEngineResolver = (req: WikiEngineRequest) => Promise<WikiEngineChoice>;

/** No engines at all — facts-only pages and extractive answers. */
export const NO_MODEL_RESOLVER: WikiEngineResolver = async () => ({ engines: [], note: 'Model generation was turned off for this run.' });

export interface WikiConfig {
  localOnly: boolean;
  localOnlyRepos: string[];
  pageBudget: number;
  tokenBudget: number;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

/** `cfg.foundry.wiki`, read loosely (the same way the Leader reads `foundry.leader`). */
export function wikiConfig(cfg: AshlrConfig | undefined): WikiConfig {
  const foundry = cfg?.foundry as Record<string, unknown> | undefined;
  const raw = (foundry?.['wiki'] ?? {}) as Record<string, unknown>;
  const repos = Array.isArray(raw['localOnlyRepos']) ? raw['localOnlyRepos'].filter((r): r is string => typeof r === 'string') : [];
  return {
    localOnly: raw['localOnly'] === true || raw['allowRemote'] === false,
    localOnlyRepos: repos.slice(0, 200),
    pageBudget: num(raw['pageBudget'], 8, 1, 60),
    tokenBudget: num(raw['tokenBudget'], 60_000, 2_000, 1_000_000),
    autoRefresh: raw['autoRefresh'] !== false,
    autoRefreshMinutes: num(raw['autoRefreshMinutes'], 30, 5, 24 * 60),
  };
}

/** Must this repo stay on local models? Returns the first reason, or null. */
export function repoLocalOnlyReason(cfg: AshlrConfig | undefined, repo: string, steeringLocalOnly: boolean): string | null {
  try {
    if (localOnlyEnabled(cfg)) return 'Local-only mode is on.';
  } catch {
    return 'Local-only mode could not be read, so remote models are off.';
  }
  const wc = wikiConfig(cfg);
  if (wc.localOnly) return 'The wiki is configured local-only (foundry.wiki.localOnly).';
  const abs = path.resolve(repo);
  const name = path.basename(abs);
  if (wc.localOnlyRepos.some((r) => r === name || path.resolve(r) === abs)) return `${name} is listed in foundry.wiki.localOnlyRepos.`;
  if (steeringLocalOnly) return `${name}'s .ashlr/wiki.json asks for local-only.`;
  return null;
}

/** Output/context caps per purpose: a page is ~1.6k tokens out; an answer less. */
function callLimits(purpose: 'page' | 'ask', promptChars: number): { maxOutputTokens: number; contextTokens: number; timeoutMs: number } {
  const out = purpose === 'page' ? 1_600 : 900;
  const need = Math.ceil(promptChars / 4) + out + 1_024;
  return {
    maxOutputTokens: out,
    contextTokens: Math.min(32_768, Math.max(8_192, Math.ceil(need / 4_096) * 4_096)),
    timeoutMs: purpose === 'page' ? 6 * 60_000 : 3 * 60_000,
  };
}

/**
 * The production resolver: the Leader's seat plan in check-in mode, with the
 * wiki's own output caps and Claude removed. Heavy modules load lazily.
 */
export type SeatModule = Pick<typeof import('../../vision/leader-seat.js'), 'loadDefaultLeaderSeatDeps' | 'planLeaderSeats'>;

export function defaultWikiEngineResolver(
  cfg: AshlrConfig,
  /** Test seam: the seat module (default: vision/leader-seat.js, loaded lazily). */
  loadSeat: () => Promise<SeatModule> = () => import('../../vision/leader-seat.js'),
): WikiEngineResolver {
  return async (req) => {
    let seat: SeatModule;
    try {
      seat = await loadSeat();
    } catch {
      return { engines: [], note: 'Seat routing is unavailable in this build.' };
    }
    let deps: Awaited<ReturnType<typeof seat.loadDefaultLeaderSeatDeps>>;
    try {
      deps = await seat.loadDefaultLeaderSeatDeps(cfg);
    } catch {
      return { engines: [], note: 'Seat discovery failed.' };
    }
    let localOnly = req.localOnly;
    try {
      if (deps.budgetPolicy().mode === 'reserve') localOnly = true;
    } catch {
      localOnly = true;
    }
    const limits = callLimits(req.purpose, req.promptChars);
    const base = deps.transports;
    const wrapped: typeof deps = {
      ...deps,
      // The wiki never uses Claude: no credential hook, so it cannot be admitted.
      claudeCredential: null,
      // Shadow decisions are the Leader's analytics; the wiki does not pollute them.
      recordDecision: () => {},
      transports: {
        local: (url, model, opts) => base.local(url, model, { ...opts, ...limits }),
        grok: (launcher, model, opts) => base.grok(launcher, model, { ...opts, timeoutMs: limits.timeoutMs, maxOutputTokens: limits.maxOutputTokens }),
        claude: () => async () => {
          throw new Error('The wiki never uses Claude.');
        },
      },
    };
    const plan = await seat.planLeaderSeats(wrapped, { deep: false, promptChars: req.promptChars, mode: 'checkin', localOnly });
    if (!plan.ok) return { engines: [], note: plan.reason };
    const engines: WikiEngine[] = plan.steps
      .filter((s) => s.choice.engine === 'local' || (s.choice.engine === 'grok' && !localOnly))
      .map((s) => ({
        label: `${s.choice.engine}:${s.choice.model}`,
        kind: s.choice.engine as WikiEngineKind,
        local: s.choice.engine === 'local',
        complete: s.complete,
      }));
    return { engines, note: engines.length === 0 ? 'No local model is running and no remote seat is granted to the wiki.' : null };
  };
}

export interface ChainResult {
  text: string;
  engine: WikiEngine;
}

/**
 * Try engines in order. A failure moves to the next engine; the first answer
 * wins. After a REMOTE engine has answered nothing else runs, so one call can
 * never spend twice. Returns null when every engine failed.
 */
export async function runEngineChain(engines: readonly WikiEngine[], system: string, user: string, onError?: (engine: WikiEngine, err: unknown) => void): Promise<ChainResult | null> {
  for (const engine of engines) {
    try {
      const text = await engine.complete(system, user);
      if (typeof text === 'string' && text.trim()) return { text, engine };
    } catch (err) {
      try {
        onError?.(engine, err);
      } catch {
        // reporting is best-effort
      }
    }
  }
  return null;
}
