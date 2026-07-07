/**
 * CLI handler for `ashlr roadmap` — the Goal Loop runner
 * (see docs/MILESTONE-CONTRACT.md).
 *
 * M86: ported from the 0.1.0 line and adapted to v3 — adds `--engine <id>`
 * (else ASHLR_ENGINE, else claude) and `--allow-cloud` (api-model engines are
 * refused without it: the local-first hard rule).
 *
 * Executes a roadmap of milestones one at a time, each in a FRESH agent process
 * (the per-milestone context reset), pausing cleanly the moment a milestone needs
 * a human / is blocked, and resumable cold from state.json.
 *
 * Usage:
 *   ashlr roadmap run    [--dir <d>] [--roadmap <file>] [--engine <id>] [--allow-cloud] [--dry-run] [--json]
 *   ashlr roadmap resume [...same]                                       # alias for run
 *   ashlr roadmap status [--dir <d>] [--roadmap <file>] [--json]         # read-only
 *
 * `run`/`resume` are the same operation — the loop always resumes from state.json
 * and skips already-complete milestones. `status` only reads state and mutates
 * nothing. Exit codes: 0 success (incl. a clean pause), 1 runtime error, 2 bad usage.
 */

import { resolve } from 'node:path';
import { makeColors, isTty } from './ui.js';
import { loadConfig } from '../core/config.js';
import type { EngineId } from '../core/types.js';
import { parseRoadmap } from '../core/goal-loop/parse.js';
import { loadState } from '../core/goal-loop/state.js';
import { runGoalLoop } from '../core/goal-loop/runner.js';

interface ParsedFlags {
  dir: string;
  roadmapFile?: string;
  engine?: EngineId;
  allowCloud: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  let dir = process.cwd();
  let roadmapFile: string | undefined;
  let engine: EngineId | undefined;
  let allowCloud = false;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') dir = resolve(args[++i] ?? '.');
    else if (a === '--roadmap') roadmapFile = args[++i];
    else if (a === '--engine') engine = args[++i] as EngineId;
    else if (a === '--allow-cloud') allowCloud = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
  }
  return { dir, roadmapFile, engine, allowCloud, dryRun, json };
}

export const cmdRoadmap = async (args: string[]): Promise<number> => {
  const c = makeColors(isTty());
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(
      'Usage: ashlr roadmap <run|resume|status> [--dir <d>] [--roadmap <f>] [--engine <id>] [--allow-cloud] [--dry-run] [--json]',
    );
    return sub ? 0 : 2;
  }

  if (sub !== 'run' && sub !== 'resume' && sub !== 'status') {
    console.error(c.red(`Unknown subcommand: ${sub}`));
    console.error(c.dim('Run `ashlr roadmap help` for usage.'));
    return 2;
  }

  const flags = parseFlags(rest);

  try {
    if (sub === 'status') {
      const index = parseRoadmap(flags.dir, flags.roadmapFile);
      const state = loadState(index.dir, index.path);
      if (flags.json) {
        console.log(JSON.stringify({ roadmap: index.path, state }, null, 2));
        return 0;
      }
      console.log(c.bold(`Roadmap: ${index.path}`));
      for (const m of index.milestones) {
        const e = state.milestones[m.id];
        const status = e ? e.status : 'pending';
        const mark = e?.status === 'done' && e.gate_passed ? c.green('✓') : c.dim('·');
        const tail = e?.blocked_on ? c.yellow(`  ← ${e.blocked_on}`) : '';
        console.log(`  ${mark} ${m.id.padEnd(6)} ${status.padEnd(12)} ${m.title}${tail}`);
      }
      return 0;
    }

    // run / resume
    const cfg = loadConfig();
    const summary = await runGoalLoop({
      dir: flags.dir,
      cfg,
      roadmapFile: flags.roadmapFile,
      dryRun: flags.dryRun,
      engine: flags.engine,
      allowCloud: flags.allowCloud,
    });

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }

    for (const o of summary.outcomes) {
      const mark =
        o.outcome === 'done' ? c.green('✓') : o.outcome === 'skipped' ? c.dim('–') : c.yellow('⏸');
      console.log(`  ${mark} ${o.milestone.padEnd(6)} ${o.outcome.padEnd(12)} ${o.summary}`);
    }
    if (summary.allComplete) {
      console.log(c.green('\nAll milestones complete.'));
    } else if (summary.stoppedAt) {
      console.log(c.yellow(`\nPaused at ${summary.stoppedAt}: ${summary.stopReason ?? 'see above'}`));
      console.log(c.dim('Resolve the blocker, then `ashlr roadmap resume` to continue.'));
    } else {
      console.log(c.dim('\nNothing to do.'));
    }
    return 0;
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    return 1;
  }
};
