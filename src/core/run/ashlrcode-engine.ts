/**
 * ashlrcode-engine.ts — M185 (SPEC-V7): run a fleet work item through the
 * `ashlrcode` agent (`ac` CLI) instead of the raw local model.
 *
 * WHY: `ac` is a real 45-tool coding agent with worktree isolation and a test
 * loop. Routing a local work item through `ac --autonomous` produces far better
 * local-work quality than the raw `runGoal` builtin loop — this is the Tier-1
 * root-cause fix for poor local-work quality.
 *
 * WHAT THIS MODULE IS: a STANDALONE adapter. It shells out to `ac` (via the
 * existing `spawnEngine` helper that sandboxed-engine.ts uses) against an
 * already-prepared `repoDir`, hands it the work item as a headless task, and
 * captures the resulting `git diff` as a string. It NEVER throws — every failure
 * surfaces as `{ ok:false, error }`. It is bounded by a hard timeout.
 *
 * WHAT THIS MODULE IS NOT (deferred to a coordinated orchestrator follow-up):
 *  - It does NOT create a sandbox worktree (the caller owns `repoDir` — pass a
 *    sandbox worktree path here to keep the live tree clean).
 *  - It does NOT file an inbox proposal, sign provenance, or scrub secrets.
 *  - It is NOT wired into dispatch / loop / router yet.
 *
 * THE `ac` INVOCATION
 * -------------------
 *   ac --autonomous --goal "<title>\n\n<detail>" \
 *      --max-iterations <N> --timeout <S> --dangerously-skip-permissions
 *
 *   - `--autonomous --goal` is `ac`'s headless single-shot mode (cli.ts: the
 *     `autonomous` branch). It is the path that engages the full 45-tool agent +
 *     its internal test loop (detectAndRunTests) and milestone iteration, and
 *     exits 0 on success / 1 on failure — exactly what a fleet executor wants.
 *   - `ac` reads its working directory from `process.cwd()` (it has no `--cd`
 *     flag for autonomous mode), so we set the child cwd to `repoDir` via the
 *     spawn options — `spawnEngine` forwards `cmd.cwd` to spawnSync.
 *   - `--dangerously-skip-permissions` runs unattended (no interactive approval
 *     prompts), matching how the fleet drives the other CLI backends.
 *   - `--timeout` is `ac`'s own internal wall-clock (seconds); we ALSO bound the
 *     whole spawn with a hard `timeoutMs` (the spawn timeout is the real wall).
 *
 * DIFF CAPTURE
 * ------------
 * `ac --autonomous` COMMITS its work in-tree (autonomous.ts gitCommit: `git
 * add -A` + `git commit`). So a plain unstaged `git diff` would be empty. We:
 *   1. record `baseHead` (HEAD sha) BEFORE the run,
 *   2. after the run, stage everything (`git add -A`) so any uncommitted
 *      leftovers are visible, then
 *   3. capture `git diff <baseHead>` — baseHead vs the working tree — which
 *      includes BOTH committed-by-ac and any leftover working-tree changes.
 * All git invocations are wrapped (never throw); a capture failure degrades to
 * `diff: undefined` rather than failing the whole run.
 *
 * ZERO new runtime deps. Reuses `spawnEngine` (engines.ts) for the agent spawn
 * and `node:child_process` spawnSync (already a transitive dep) for the cheap
 * git probes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../types.js';
import { engineInstalled, spawnEngine } from './engines.js';

/** Minimal structural shape of a fleet work item this adapter consumes.
 * WorkItem (types.ts) satisfies this — we keep it loose so the adapter is not
 * coupled to the full WorkItem and can be fed a plain {title, detail}. */
export interface AshlrcodeWorkItem {
  /** Short, human-readable task title. */
  title: string;
  /** Optional longer detail / spec / context for the task. */
  detail?: string;
}

export interface RunViaAshlrcodeOptions {
  /** Concrete model id to pass through (currently informational; `ac` picks
   *  its own provider/model from its settings — reserved for future routing). */
  model?: string;
  /** Hard wall-clock for the whole `ac` spawn, in ms. Default 20 min. */
  timeoutMs?: number;
  /** `ac`'s own internal max milestone iterations. Default 200 (ac's default). */
  maxIterations?: number;
  /** Surgical mode (`ac --surgical`): minimal change, no scaffolding/new files.
   *  DEFAULT TRUE — fleet work should be precise; ac over-scaffolds without it.
   *  Pass false only for genuine build-out/invent items that should scaffold. */
  surgical?: boolean;
}

export interface RunViaAshlrcodeResult {
  /** True when `ac` ran and exited 0. */
  ok: boolean;
  /** Unified `git diff` of the work `ac` produced (omitted when empty/uncapturable). */
  diff?: string;
  /** Files touched by the diff (best-effort name list; omitted when none/uncapturable). */
  files?: string[];
  /** `ac`'s stdout summary (trimmed). */
  summary?: string;
  /** Set when ok is false: 'ac not installed' | spawn error | non-zero exit. */
  error?: string;
}

/** Default hard wall-clock for an `ac` autonomous run (20 min) — matches the
 * sandboxed-engine DEFAULT_TIMEOUT_MS so fleet executors share one budget. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Read the M185 gate flag off cfg.foundry.ashlrcodeExecutor (default OFF). */
function executorEnabled(cfg: AshlrConfig): boolean {
  return (cfg.foundry as Record<string, unknown> | undefined)?.['ashlrcodeExecutor'] === true;
}

/** Cheap, never-throws git probe. Returns trimmed stdout or undefined on any
 * failure (git missing, not a repo, non-zero exit). */
function gitTry(repoDir: string, args: string[]): string | undefined {
  try {
    const r = spawnSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    if (r.error || r.status !== 0) return undefined;
    return String(r.stdout ?? '').trim();
  } catch {
    return undefined;
  }
}

function normalizeRepoDir(repoDir: string): string {
  try {
    if (existsSync(repoDir) && statSync(repoDir).isFile()) {
      return dirname(repoDir);
    }
  } catch {
    // Keep the original path; the git/ac probes below are already never-throw.
  }
  return repoDir;
}

/** Build the headless `ac --autonomous` goal string from the work item. */
function buildGoal(item: AshlrcodeWorkItem): string {
  const detail = item.detail?.trim();
  return detail ? `${item.title}\n\n${detail}` : item.title;
}

/**
 * Run `item` through the `ashlrcode` (`ac`) agent against `repoDir`, returning a
 * captured diff/result. NEVER throws.
 *
 * Gating:
 *   - cfg.foundry.ashlrcodeExecutor must be true (default OFF) → else clean no-op
 *     `{ ok:false, error:'ashlrcode executor disabled' }`.
 *   - `ac` must be installed (engineInstalled check) → else
 *     `{ ok:false, error:'ac not installed' }`.
 *
 * @param item    the work item (title + optional detail/spec).
   * @param repoDir absolute path of the repo/worktree to run `ac` against. File
   *                paths are normalized to their parent directory before any
   *                git/ac cwd use. The caller owns isolation — pass a sandbox
   *                worktree to keep the live tree clean.
 * @param cfg     the ashlr config (gate flag + engine resolution).
 * @param opts    optional model / timeout / maxIterations overrides.
 */
export async function runViaAshlrcode(
  item: AshlrcodeWorkItem,
  repoDir: string,
  cfg: AshlrConfig,
  opts?: RunViaAshlrcodeOptions,
): Promise<RunViaAshlrcodeResult> {
  try {
    const runDir = normalizeRepoDir(repoDir);

    // Gate 1: flag (default off).
    if (!executorEnabled(cfg)) {
      return { ok: false, error: 'ashlrcode executor disabled' };
    }

    // Gate 2: `ac` availability (engineInstalled checks bins ['ac','ashlrcode']).
    if (!engineInstalled('ashlrcode', cfg)) {
      return { ok: false, error: 'ac not installed' };
    }

    const timeoutMs = opts?.timeoutMs ?? cfg.foundry?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxIterations = opts?.maxIterations ?? 200;
    // `ac`'s own --timeout is in SECONDS; cap it to the spawn wall-clock.
    const acTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000));
    const goal = buildGoal(item);

    // Record the base HEAD BEFORE the run so we can diff against it afterward
    // (ac --autonomous COMMITS its work, so post-run committed changes are only
    // visible relative to this base). Undefined when repoDir isn't a git repo —
    // we still run, just can't capture a baseHead-relative diff.
    const baseHead = gitTry(runDir, ['rev-parse', 'HEAD']);

    // Build the `ac --autonomous` headless command. We do NOT use
    // buildEngineCommand here because the registry's ashlrcode argv is the
    // legacy `ac --goal <goal>` shape; the autonomous/test-loop path needs the
    // explicit headless flag set, so we construct the EngineCommand directly.
    // Surgical by default (minimal change, no scaffolding) — fleet work is
    // precise; ac over-builds without it. Caller passes surgical:false for
    // genuine build-out/invent items.
    const surgical = opts?.surgical !== false;
    const args: string[] = [
      '--autonomous',
      '--goal',
      goal,
      '--max-iterations',
      String(maxIterations),
      '--timeout',
      String(acTimeoutSec),
      '--dangerously-skip-permissions',
      ...(surgical ? ['--surgical'] : []),
    ];
    const cmd: EngineCommand = { bin: 'ac', args, cwd: runDir };

    // Spawn via the same helper sandboxed-engine.ts uses (never throws; applies
    // the env-bridge allowlist; honours cmd.cwd → ac runs against repoDir).
    const res = await spawnEngine(cmd, cfg, { timeoutMs });

    if (!res.ok) {
      return { ok: false, summary: res.output || undefined, error: res.error ?? 'ac run failed' };
    }

    // Capture the diff: stage leftovers, then diff baseHead vs working tree.
    let diff: string | undefined;
    let files: string[] | undefined;
    if (baseHead) {
      // Best-effort: stage any uncommitted leftovers so new files are visible.
      gitTry(runDir, ['add', '-A']);
      const patch = gitTry(runDir, ['diff', baseHead]);
      if (patch && patch.length > 0) {
        diff = patch;
        const names = gitTry(runDir, ['diff', '--name-only', baseHead]);
        if (names) {
          const list = names.split('\n').map((l) => l.trim()).filter(Boolean);
          if (list.length > 0) files = list;
        }
      }
    }

    return {
      ok: true,
      diff,
      files,
      summary: res.output || undefined,
    };
  } catch (err) {
    // CONTRACT: never throws — any unexpected failure surfaces as ok:false.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
