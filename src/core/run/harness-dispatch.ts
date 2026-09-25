/**
 * core/run/harness-dispatch.ts — the adopted harness's effort and sampling,
 * applied to ONE engine invocation (closes the 3.10 known gap: "harness
 * effort / sampling are chosen but never reach a dispatch").
 *
 * The harness registry (learn/harness-registry.ts) pins `effort` and
 * `sampling` per FLEET ENGINE (lane). The fleet tick reads the active version
 * once (tick-hooks-live.ts `dispatchHarness`), loop.ts forwards it on
 * `RunOptions.harness` / best-of-N's `harness`, the orchestrator hands it to
 * the sandboxed producers, and THIS module turns it into the one
 * engine-specific form each producer understands:
 *
 *   lane        engine id                effort                                   sampling
 *   claude-cli  claude                   `--effort <level>`                       — (no CLI flag)
 *   codex       codex                    `-c model_reasoning_effort="<level>"`    — (no CLI flag)
 *   grok-cli    grok-cli                 `--reasoning-effort=<level>`             — (no CLI flag)
 *   local       llama-server             request `reasoning_effort`               temperature, top_p, max_tokens
 *   local       local-coder (Ollama)     — (carrier unverified)                   temperature, top_p, max_tokens
 *
 * Every flag spelling is the one verse/session-controls.ts verified against
 * the pinned binaries' `--help` (2026-09-24); the llama-server effort set is
 * the one local-runtime/llama/config.ts measured against the live template.
 *
 * WHY "withheld" RATHER THAN APPROXIMATED OR GUESSED: every CLI here rejects
 * an unknown flag or value before any inference (commander / clap exit 2),
 * and llama-server's template raises on an unknown effort — so a guessed
 * spelling would fail EVERY dispatch on that lane, not degrade one. A setting
 * an engine cannot carry is listed in `withheld` with the reason, never sent.
 * The two documented clamps (a level above an engine's ceiling runs at that
 * ceiling) keep the harness's direction ("think more") without an invalid
 * value.
 *
 * No harness (default hooks, a non-standing run) or a baseline harness (empty
 * effort / sampling) applies NOTHING: the argv and request are byte-identical
 * to the compiled defaults.
 *
 * PURE: no I/O, no clock.
 */
import type { FleetEngine } from '../fleet/fleet-types.js';
import type { HarnessEffort, HarnessSampling } from '../learn/harness-types.js';
import type { EngineCommand } from '../types.js';

/** The slice of an active harness a dispatch carries (per fleet lane). */
export interface DispatchHarness {
  /** The harness version (null = baseline). Recorded, never interpreted here. */
  versionId: string | null;
  effort: Partial<Record<FleetEngine, HarnessEffort>>;
  sampling: Partial<Record<FleetEngine, HarnessSampling>>;
}

/** What one engine invocation should run with; null fields = engine default. */
export interface EngineHarnessTuning {
  versionId: string | null;
  lane: FleetEngine;
  effort: HarnessEffort | null;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
}

/** The harness settings that reached (or could not reach) one invocation. */
export interface HarnessApplication {
  /** e.g. `effort=high`, `temperature=0.2`, `effort=xhigh (requested max)`. */
  applied: string[];
  /** e.g. `temperature: claude has no sampling flag`. */
  withheld: string[];
}

/**
 * The lane an engine id's harness settings live under, or null when the
 * engine is no fleet lane (then nothing applies). Mirrors
 * engine-registry.ts `registryEngineForFleetEngine` in reverse; restated
 * rather than imported from fleet/dispatch-router.ts so the run layer does
 * not pull the router's policy graph into every producer.
 */
export function harnessLaneOf(engine: string): FleetEngine | null {
  switch (engine) {
    case 'claude': return 'claude-cli';
    case 'codex': return 'codex';
    case 'grok-cli': return 'grok-cli';
    case 'llama-server':
    case 'local-coder':
    case 'builtin':
      return 'local';
    default:
      return null;
  }
}

/**
 * The tuning for one engine under `harness`, or null when the harness sets
 * nothing for that engine's lane (the compiled defaults apply).
 */
export function harnessTuningFor(engine: string, harness: DispatchHarness | null | undefined): EngineHarnessTuning | null {
  if (!harness) return null;
  const lane = harnessLaneOf(engine);
  if (lane === null) return null;
  const effort = harness.effort?.[lane] ?? null;
  const sampling = harness.sampling?.[lane] ?? null;
  const tuning: EngineHarnessTuning = {
    versionId: harness.versionId,
    lane,
    effort,
    temperature: sampling?.temperature ?? null,
    topP: sampling?.topP ?? null,
    maxOutputTokens: sampling?.maxOutputTokens ?? null,
  };
  const empty = tuning.effort === null && tuning.temperature === null && tuning.topP === null && tuning.maxOutputTokens === null;
  return empty ? null : tuning;
}

// ---------------------------------------------------------------------------
// CLI engines — argv
// ---------------------------------------------------------------------------

/** Codex models whose API accepts `xhigh` (engines.ts codexReasoningConfigRecovery uses the same test). */
function codexSupportsXHigh(model: string | undefined): boolean {
  const m = model?.trim().toLowerCase();
  return m !== undefined && /^gpt-5\.(?:4|5|6)(?:$|[-.])/.test(m);
}

function modelOfArgs(args: readonly string[]): string | undefined {
  const i = args.findIndex((a) => a === '--model' || a === '-m');
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith('--model='))?.slice('--model='.length);
}

function sets(args: readonly string[], prefix: string): boolean {
  return args.some((a) => a === prefix || a.startsWith(`${prefix}=`));
}

function withholdSampling(t: EngineHarnessTuning, engine: string, out: HarnessApplication): void {
  const why = `${engine} has no sampling flag`;
  if (t.temperature !== null) out.withheld.push(`temperature: ${why}`);
  if (t.topP !== null) out.withheld.push(`topP: ${why}`);
  if (t.maxOutputTokens !== null) out.withheld.push(`maxOutputTokens: ${why}`);
}

/**
 * Apply a tuning to a CLI engine command. Returns the SAME command object
 * when nothing applies (so callers and tests can tell "untouched" by
 * identity). A flag the command already carries is never duplicated or
 * overridden — an explicit per-run choice outranks the harness.
 */
export function applyHarnessToEngineCommand(
  engine: string,
  cmd: EngineCommand,
  tuning: EngineHarnessTuning | null,
): { cmd: EngineCommand; application: HarnessApplication } {
  const application: HarnessApplication = { applied: [], withheld: [] };
  if (!tuning) return { cmd, application };
  let args: string[] | null = null;
  const effort = tuning.effort;

  if (engine === 'claude') {
    if (effort !== null) {
      // claude --effort accepts all five harness levels (session-controls CLAUDE_EFFORTS).
      if (sets(cmd.args, '--effort')) application.withheld.push('effort: the command already sets --effort');
      else {
        args = [...cmd.args, '--effort', effort];
        application.applied.push(`effort=${effort}`);
      }
    }
    withholdSampling(tuning, engine, application);
  } else if (engine === 'codex') {
    if (effort !== null) {
      if (cmd.args.some((a) => /^model_reasoning_effort\s*=/.test(a))) {
        application.withheld.push('effort: the command already sets model_reasoning_effort');
      } else {
        // Codex accepts minimal|low|medium|high|xhigh; xhigh only on gpt-5.4+.
        // `max` (and xhigh on an older model) runs at the model's ceiling.
        const ceiling = codexSupportsXHigh(modelOfArgs(cmd.args)) ? 'xhigh' : 'high';
        const level = effort === 'max' || effort === 'xhigh' ? ceiling : effort;
        // `-c` is an `exec` option: insert right after the subcommand (the
        // goal is the last positional and must stay last).
        const execAt = cmd.args.indexOf('exec');
        const at = execAt >= 0 ? execAt + 1 : 0;
        args = [...cmd.args];
        args.splice(at, 0, '-c', `model_reasoning_effort="${level}"`);
        application.applied.push(level === effort ? `effort=${level}` : `effort=${level} (requested ${effort})`);
      }
    }
    withholdSampling(tuning, engine, application);
  } else if (engine === 'grok-cli') {
    if (effort !== null) {
      if (cmd.args.some((a) => a.startsWith('--reasoning-effort'))) {
        application.withheld.push('effort: the command already sets --reasoning-effort');
      } else {
        // grok 0.2.118 lists low|medium|high. The `=` spelling is the one clap
        // always binds; order is free (the goal is the one `--single=` element).
        const level = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
        args = [...cmd.args, `--reasoning-effort=${level}`];
        application.applied.push(level === effort ? `effort=${level}` : `effort=${level} (requested ${effort})`);
      }
    }
    withholdSampling(tuning, engine, application);
  } else {
    if (effort !== null) application.withheld.push(`effort: ${engine} has no effort flag`);
    withholdSampling(tuning, engine, application);
  }

  return { cmd: args ? { ...cmd, args } : cmd, application };
}

// ---------------------------------------------------------------------------
// In-process api-model engines (the local lane) — request fields
// ---------------------------------------------------------------------------

/** Request fields for the OpenAI-compatible client; absent = provider default. */
export interface ApiModelHarnessRequest {
  temperature?: number;
  topP?: number;
  /** Per-call output cap; the caller still takes the MIN with its own governed cap. */
  maxOutputTokens?: number;
  /** Top-level `reasoning_effort` on the OpenAI-compatible chat endpoint. */
  reasoningEffort?: 'low' | 'medium' | 'xhigh';
}

/**
 * The request fields an api-model engine sends under a tuning.
 *
 * Effort reaches only llama-server: its Qwen template accepts exactly
 * low|medium|xhigh (and raises on `high` BEFORE inference — measured, see
 * local-runtime/llama/config.ts), and top-level `reasoning_effort` on
 * the OpenAI-compatible chat endpoint is the carrier measured to reach it
 * (anthropic-shim.ts tabulates the probe). So `max` runs at
 * `xhigh` (the template's ceiling) and `high` is withheld: neither neighbour
 * is what was asked for, and sending it is fatal. Ollama's carrier for the
 * same model is unverified, so local-coder withholds effort too.
 */
export function harnessApiModelRequest(
  engine: string,
  tuning: EngineHarnessTuning | null,
): { request: ApiModelHarnessRequest; application: HarnessApplication } {
  const request: ApiModelHarnessRequest = {};
  const application: HarnessApplication = { applied: [], withheld: [] };
  if (!tuning) return { request, application };
  const openAiCompatible = engine === 'llama-server' || engine === 'local-coder';

  if (tuning.effort !== null) {
    if (engine !== 'llama-server') {
      application.withheld.push(`effort: ${engine} has no verified effort carrier`);
    } else if (tuning.effort === 'high') {
      application.withheld.push('effort: the local template rejects "high" (accepts low, medium, xhigh)');
    } else {
      const level = tuning.effort === 'max' ? 'xhigh' : tuning.effort;
      request.reasoningEffort = level;
      application.applied.push(level === tuning.effort ? `effort=${level}` : `effort=${level} (requested ${tuning.effort})`);
    }
  }
  const sampling: [keyof ApiModelHarnessRequest & ('temperature' | 'topP' | 'maxOutputTokens'), number | null][] = [
    ['temperature', tuning.temperature],
    ['topP', tuning.topP],
    ['maxOutputTokens', tuning.maxOutputTokens],
  ];
  for (const [key, value] of sampling) {
    if (value === null) continue;
    if (!openAiCompatible) {
      application.withheld.push(`${key}: ${engine} has no sampling carrier`);
      continue;
    }
    request[key] = value;
    application.applied.push(`${key}=${value}`);
  }
  return { request, application };
}

/** One human line for the run log, or null when the harness touched nothing. */
export function describeHarnessApplication(engine: string, tuning: EngineHarnessTuning | null, application: HarnessApplication): string | null {
  if (!tuning || (application.applied.length === 0 && application.withheld.length === 0)) return null;
  const parts = [
    application.applied.length > 0 ? `applied ${application.applied.join(', ')}` : 'applied nothing',
    ...(application.withheld.length > 0 ? [`withheld ${application.withheld.join('; ')}`] : []),
  ];
  return `harness ${tuning.versionId ?? 'baseline'} on ${engine}: ${parts.join('; ')}`;
}
