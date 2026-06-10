/**
 * CLI handler for `ashlr reflect` — M26 self-improvement / meta-learning.
 *
 * Scores the org's OWN past swarms/usage/genome, distills playbooks, and
 * proposes routing/policy/prompt tuning. The DEFAULT path is a deterministic,
 * local-only, READ-ONLY report — it writes nothing outside ~/.ashlr/learn/ and
 * makes ZERO non-localhost connections.
 *
 * Usage:
 *   ashlr reflect [--since <7d|30d>] [--json] [--allow-cloud]
 *   ashlr reflect playbooks [--persist] [--allow-cloud]  # distill (report-only); --persist writes to genome
 *   ashlr reflect propose                      # emit tuning PROPOSALS (pending)
 *
 * HARD SAFETY INVARIANTS (M26) enforced by this surface:
 *  - READ-ONLY history; writes ONLY under ~/.ashlr/learn/ (and, on `propose`,
 *    PENDING inbox proposals). NEVER writes config.json / router / prompts.
 *  - PROPOSAL-ONLY tuning: `propose` routes to createProposal (status pending).
 *  - LOCAL-FIRST: metrics need no model; optional narrative/playbook text routes
 *    through getActiveClient(local-only unless --allow-cloud + key), mirroring ask.ts.
 *  - BOUNDED: --since window / capped maxRuns; no unbounded loops.
 *  - NO OUTWARD ACTION: no push/PR/deploy/merge.
 *
 * NOTE (integration — owned by the Build/Integrate phase, NOT this scaffold):
 *   src/cli/index.ts must add a `loadReflectCmd = lazyCmd(() => import('./reflect.js'),
 *   (m) => m.cmdReflect as Cmd, 'reflect command requires src/cli/reflect.ts (M26 …)')`,
 *   a `case 'reflect':` in the dispatch switch, and a cmdHelp entry.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */

import { pad, makeColors, isTty } from './ui.js';
import type {
  AshlrConfig,
  ReflectionOptions,
  ReflectionReport,
} from '../core/types.js';

// ─── Lazy imports (graceful degradation if M26 core not yet built) ───────────

type BuildReflectionFn = (
  cfg: AshlrConfig,
  opts?: ReflectionOptions,
) => ReflectionReport;
type SaveReportFn = (report: ReflectionReport) => string | null;
type DistillAndPersistFn = (
  cfg: AshlrConfig,
  opts?: { maxRuns?: number; narrative?: boolean; allowCloud?: boolean; persist?: boolean },
) => Promise<import('../core/learn/playbooks.js').PlaybookResult>;
type DeriveTuningFn = (
  report: ReflectionReport,
) => import('../core/types.js').TuningProposal[];
type EmitTuningFn = (
  suggestions: import('../core/types.js').TuningProposal[],
) => import('../core/types.js').Proposal[];

interface ReflectCore {
  buildReflection: BuildReflectionFn;
  saveReport: SaveReportFn;
  distillAndPersist: DistillAndPersistFn;
  deriveTuning: DeriveTuningFn;
  emitTuningProposals: EmitTuningFn;
  loadConfig: () => AshlrConfig;
}

let _core: ReflectCore | null | undefined = undefined;

async function importCore(): Promise<ReflectCore | null> {
  if (_core === undefined) {
    try {
      const [reflect, store, playbooks, tuning, config] = await Promise.all([
        import('../core/learn/reflect.js'),
        import('../core/learn/store.js'),
        import('../core/learn/playbooks.js'),
        import('../core/learn/tuning.js'),
        import('../core/config.js'),
      ]);
      _core = {
        buildReflection: reflect.buildReflection as BuildReflectionFn,
        saveReport: store.saveReport as SaveReportFn,
        distillAndPersist: playbooks.distillAndPersist as DistillAndPersistFn,
        deriveTuning: tuning.deriveTuning as DeriveTuningFn,
        emitTuningProposals: tuning.emitTuningProposals as EmitTuningFn,
        loadConfig: config.loadConfig as () => AshlrConfig,
      };
    } catch {
      _core = null;
    }
  }
  return _core ?? null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

type ReflectSub = 'report' | 'playbooks' | 'propose';

interface ParsedReflectArgs {
  sub: ReflectSub;
  /** Epoch-ms lower bound derived from --since, or undefined for no window. */
  sinceMs: number | undefined;
  /** The raw --since label (e.g. '7d'/'30d'), or null. */
  window: string | null;
  json: boolean;
  allowCloud: boolean;
  /** Only meaningful for `playbooks`: actually write distilled playbooks to the
   *  genome hub. Default false => report-only (no genome write). */
  persist: boolean;
  help: boolean;
  error: string | undefined;
}

/** Convert a --since label ('7d'|'30d'|'1d'|'all') to epoch-ms lower bound. */
function sinceToMs(label: string): number | undefined {
  const t = label.trim().toLowerCase();
  // 'all' is an explicit no-window sentinel (analyze everything within maxRuns).
  if (t === 'all') return 0;
  const m = /^(\d+)d$/.exec(t);
  if (!m) return undefined;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Date.now() - days * 86_400_000;
}

function parseReflectArgs(args: string[]): ParsedReflectArgs {
  let sub: ReflectSub = 'report';
  let sinceMs: number | undefined;
  let window: string | null = null;
  let json = false;
  let allowCloud = false;
  let persist = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--allow-cloud') {
      allowCloud = true;
    } else if (a === '--persist') {
      persist = true;
    } else if (a === '--since') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        error = '--since requires a window argument (e.g. 7d, 30d, or all)';
        break;
      }
      const ms = sinceToMs(next);
      if (ms === undefined) {
        error = `invalid --since window: ${next} (expected Nd, e.g. 7d, or all)`;
        break;
      }
      // '--since all' (ms === 0) is the explicit "scan all history" opt-in: it
      // sets sinceMs=0 (a sentinel buildReflection treats as explicitAll) and
      // window='all'. An Nd window records its epoch lower bound + label. A
      // missing --since leaves sinceMs undefined => buildReflection applies the
      // bounded DEFAULT_USAGE_LOOKBACK_MS.
      sinceMs = ms;
      window = ms > 0 ? next : 'all';
    } else if (a === 'playbooks' || a === 'propose') {
      sub = a;
    } else if (!a.startsWith('--')) {
      error = `Unknown subcommand: ${a}`;
      break;
    } else {
      error = `Unknown flag: ${a}`;
      break;
    }
  }

  return { sub, sinceMs, window, json, allowCloud, persist, help, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr reflect') + dim(' — score past runs, distill playbooks, propose tuning'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr reflect')} [--since <7d|30d|all>] [--json] [--allow-cloud]`);
  out(`    ${cyan('ashlr reflect playbooks')} [--persist] [--allow-cloud]`);
  out(`    ${cyan('ashlr reflect propose')}`);
  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--since <Nd|all>', 'Restrict analysis to the last N days (e.g. 7d, 30d) or all.'],
    ['--json', 'Emit the ReflectionReport as JSON instead of human-readable output.'],
    ['--persist', 'playbooks: WRITE distilled playbooks to the genome (auto-injects into future agents). Off by default (report-only).'],
    ['--allow-cloud', 'Allow a CLOUD model for optional narrative/playbook text. Off by default.'],
    ['--help', 'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) out(`    ${cyan(pad(flag, w))}  ${desc}`);
  out('');
  out('  ' + bold('Subcommands:'));
  out(`    ${cyan('playbooks')}  Distill recurring SUCCESSFUL patterns (report-only). Add ${cyan('--persist')} to write them to the genome.`);
  out(`    ${cyan('propose')}    Emit derived routing/policy/prompt tuning as PENDING inbox proposals.`);
  out('');
  out('  ' + gray('Metrics are deterministic and local-only. Tuning is proposal-only — nothing auto-applies.'));
  out('');
}

// ─── Human-readable report output ────────────────────────────────────────────

/** Format a 0..1 ratio as a whole-percentage string. */
function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Format a signed percentage-point / percent delta with an arrow. */
function signedDelta(n: number | null, unit: 'pp' | '%'): string {
  if (n === null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}${unit === 'pp' ? ' pts' : '%'}`;
}

function printReportHuman(report: ReflectionReport): void {
  const tty = isTty();
  const { bold, cyan, dim, green, yellow, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  // 'all' is the no-window sentinel (see buildReflection); render it as
  // 'all history' rather than a literal 1970 epoch.
  const sinceLabel = report.since === 'all' ? 'all history' : report.since;
  const windowLabel = report.window && report.window !== 'all' ? ` · ${report.window}` : '';
  out('');
  out(bold('  Reflection') + gray(` [since ${sinceLabel}${windowLabel}]`));
  out('');

  // Headline (week-over-week delta) — the load-bearing summary line.
  out('  ' + bold(report.delta.headline));
  out('');

  // Core metrics table.
  const rows: [string, string][] = [
    ['Swarms analyzed', String(report.swarmsAnalyzed)],
    ['Success rate', `${pct(report.successRate)} (${report.swarmsDone} done / ${report.swarmsFailed} failed)`],
    ['Avg cost / swarm', `$${report.avgCostUsd.toFixed(4)}`],
    ['Avg tokens / swarm', String(Math.round(report.avgTokens))],
    ['Total cost', `$${report.totalCostUsd.toFixed(4)}`],
    ['Local share', pct(report.localShare)],
    ['Genome entries', `${report.genome.totalEntries} (${report.genome.hubEntries} hub)`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`    ${cyan(pad(k, w))}  ${v}`);
  out('');

  // Week-over-week deltas (when a prior snapshot exists).
  if (report.delta.previousAt) {
    out('  ' + bold('Week-over-week') + gray(` (vs ${report.delta.previousAt})`));
    out(`    ${cyan(pad('Effectiveness', w))}  ${signedDelta(report.delta.effectivenessPct, 'pp')}`);
    out(`    ${cyan(pad('Cost', w))}  ${signedDelta(report.delta.costPct, '%')}`);
    out(`    ${cyan(pad('Local share', w))}  ${signedDelta(report.delta.localSharePct, 'pp')}`);
    out('');
  } else {
    out(dim('  No prior snapshot yet — week-over-week deltas appear from the next run.'));
    out('');
  }

  // Top failure modes.
  if (report.topFailures.length > 0) {
    out('  ' + bold('Top failure modes'));
    for (const f of report.topFailures.slice(0, 5)) {
      const phaseStr = f.phases.length ? gray(` [${f.phases.join(', ')}]`) : '';
      out(`    ${yellow(`×${f.count}`)}  ${f.label}${phaseStr}`);
    }
    out('');
  } else {
    out(green('  No failures in the analyzed window.'));
    out('');
  }

  // Most-expensive goal categories.
  if (report.goalCategories.length > 0) {
    out('  ' + bold('Cost by goal category') + gray(' (most-expensive first)'));
    const catW = Math.max(...report.goalCategories.map((c) => c.category.length), 8);
    for (const c of report.goalCategories.slice(0, 6)) {
      out(
        `    ${cyan(pad(c.category, catW))}  ` +
        `$${c.avgCostUsd.toFixed(4)}/swarm  ` +
        gray(`${c.swarms} swarm(s), ${pct(c.successRate)} success`),
      );
    }
    out('');
  }

  // NOTE: buildReflection() is the deterministic, LOCAL-ONLY report path and
  // never produces an LLM narrative — narrative/playbook synthesis lives in
  // core/learn/playbooks.ts behind --allow-cloud. There is intentionally NO
  // narrative branch here, so the report path has zero egress surface.
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr reflect [--since <Nd>] [--json] [--allow-cloud]`
 * `ashlr reflect playbooks [--allow-cloud]`
 * `ashlr reflect propose`
 *
 * Default path: deterministic, local-only, READ-ONLY report persisted under
 * ~/.ashlr/learn/. `playbooks` distills + persists to the genome. `propose`
 * emits PENDING tuning proposals into the inbox. Nothing auto-applies; no
 * config/router/prompt is ever mutated.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */
export async function cmdReflect(args: string[]): Promise<number> {
  const parsed = parseReflectArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr reflect --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red, yellow, green, cyan, dim, bold, gray } = makeColors(tty);

  const core = await importCore();
  if (!core) {
    process.stderr.write(
      red('error: ') +
        'reflect command requires src/core/learn/* (M26 modules not yet built).\n',
    );
    return 1;
  }

  // Privacy warning for --allow-cloud (mirrors ask.ts), only relevant to the
  // optional narrative/playbook synthesis paths.
  if (parsed.allowCloud && !parsed.json) {
    process.stderr.write(
      yellow('warning: ') +
        '--allow-cloud is set — playbook/narrative text MAY be synthesized by a cloud model.\n' +
        '         Metrics are always computed locally. Omit --allow-cloud to stay fully on-machine.\n',
    );
  }

  const cfg = core.loadConfig();
  const reflectOpts: ReflectionOptions = {
    ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
    window: parsed.window,
  };

  // ── Subcommand: playbooks ─────────────────────────────────────────────────
  if (parsed.sub === 'playbooks') {
    let result: import('../core/learn/playbooks.js').PlaybookResult;
    try {
      result = await core.distillAndPersist(cfg, {
        narrative: parsed.allowCloud, // narrative polish only when cloud was opted-in
        allowCloud: parsed.allowCloud,
        persist: parsed.persist, // report-only unless the user passes --persist
      });
    } catch (err) {
      process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      return 1;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }

    const out = (s = '') => process.stdout.write(s + '\n');
    out('');
    out(
      bold('  Playbooks') +
        dim(
          ` — ${result.playbooks.length} distilled` +
            (result.didPersist
              ? `, ${result.persisted.length} persisted to genome`
              : ' (report-only)'),
        ),
    );
    out('');
    if (result.playbooks.length === 0) {
      out(dim('  No recurring SUCCESSFUL patterns found yet. Run more swarms, then retry.'));
      out('');
      return 0;
    }
    for (const pb of result.playbooks) {
      out(`    ${green('✓')} ${bold(pb.title)} ${dim(`(×${pb.supportCount} ${pb.category})`)}`);
    }
    out('');
    if (result.didPersist) {
      out('  ' + gray('Persisted to the genome hub (hubOnly) — auto-injects into future agents.'));
    } else {
      out('  ' + gray('Report-only — nothing written. Re-run with ') + cyan('--persist') + gray(' to write these to the genome (they then auto-inject into future agents).'));
    }
    out('');
    return 0;
  }

  // ── Subcommand: propose ───────────────────────────────────────────────────
  if (parsed.sub === 'propose') {
    let report: ReflectionReport;
    try {
      report = core.buildReflection(cfg, reflectOpts);
    } catch (err) {
      process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      return 1;
    }

    const suggestions = core.deriveTuning(report);
    const proposals = core.emitTuningProposals(suggestions);

    if (parsed.json) {
      process.stdout.write(JSON.stringify({ suggestions, proposals }) + '\n');
      return 0;
    }

    const out = (s = '') => process.stdout.write(s + '\n');
    out('');
    out(bold('  Tuning proposals') + dim(` — ${proposals.length} created (status: pending)`));
    out('');
    if (proposals.length === 0) {
      out(dim('  No tuning suggestions from the current metrics. Nothing proposed.'));
      out('');
      return 0;
    }
    for (const p of proposals) {
      out(`    ${yellow('•')} ${bold(p.title)}`);
    }
    out('');
    out('  ' + gray('These are PROPOSALS only — nothing was applied. Review them with ') + cyan('ashlr inbox') + gray('.'));
    out('');
    return 0;
  }

  // ── Default: report ───────────────────────────────────────────────────────
  let report: ReflectionReport;
  try {
    report = core.buildReflection(cfg, reflectOpts);
  } catch (err) {
    process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }

  // Persist a snapshot so deltas accumulate week-over-week. Best-effort: a
  // failed save never blocks the report (the store never throws and returns null).
  core.saveReport(report);

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    printReportHuman(report);
  }

  return 0;
}
