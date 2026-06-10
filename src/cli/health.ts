/**
 * CLI handler for `ashlr health` — M27 quality & standards enforcement.
 *
 * Continuous portfolio-wide quality review. For each ENROLLED repo it computes a
 * per-repo HEALTH SCORE (weighted 0-100 + letter grade) across dimensions
 * (tests, docs, deps, security, code-debt, issues/CI, conventions), tracks the
 * score over time (trend snapshots under ~/.ashlr/quality/), and — on explicit
 * `propose` — emits safe-fix PENDING proposals into the M23 Approval Inbox.
 *
 * Usage:
 *   ashlr health [--json]                  # score all enrolled repos, ranked worst-first
 *   ashlr health <repo> [--json]           # one-repo detail w/ dimension breakdown
 *   ashlr health propose [<repo>] [--json] # emit safe-fix NOTE proposals into the inbox
 *
 * HARD SAFETY INVARIANTS (M27) enforced by this surface:
 *  - READ-ONLY: scores via the M22 read-only scanners + read-only convention
 *    probes; writes ONLY under ~/.ashlr/quality/ (snapshots) and — on `propose`
 *    — PENDING inbox proposals. NEVER mutates a user repo working tree.
 *  - ENROLLMENT-SCOPED: a positional <repo> is resolve()'d and filtered through
 *    isEnrolled() HERE (CLI layer) AND again in core/quality/health.ts (core
 *    layer); a non-enrolled path HARD-ERRORS. Default repo set is listEnrolled()
 *    (DEFAULT EMPTY => reports nothing, no disk scan). This is the exact gap the
 *    M25 review caught — enforced at BOTH layers.
 *  - PROPOSAL-ONLY: `propose` routes safe fixes to createProposal (status
 *    pending, kind 'note', origin 'manual'); nothing auto-applies. M27 does NOT
 *    apply patches and does NOT mutate working trees.
 *  - LOCAL-FIRST: scoring is fully deterministic and needs NO model. M27 ships
 *    no LLM narrative path, so this command makes ZERO non-localhost connections
 *    beyond what the M22 scanners already do.
 *  - BOUNDED: reuses the scanners' bounds; caps repos/work per run.
 *
 * NOTE (integration — owned by the Build/Integrate phase, NOT this scaffold):
 *   src/cli/index.ts must add a `loadHealthCmd = lazyCmd(() => import('./health.js'),
 *   (m) => m.cmdHealth as Cmd, 'health command requires src/cli/health.ts (M27 …)')`,
 *   a `case 'health':` in the dispatch switch, and cmdHelp entries.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */

import { resolve } from 'node:path';

import { pad, makeColors, isTty } from './ui.js';
import type {
  HealthOptions,
  HealthReport,
  HealthScore,
  Proposal,
  SafeFix,
} from '../core/types.js';

// ─── Lazy imports (graceful degradation if M27 core not yet built) ───────────

type ComputeHealthFn = (repo: string) => Promise<HealthScore>;
type ComputeReportFn = (opts?: HealthOptions) => Promise<HealthReport>;
type SaveReportFn = (report: HealthReport) => string | null;
type LoadPreviousReportFn = (before?: string) => HealthReport | null;
type DeriveSafeFixesFn = (score: HealthScore) => SafeFix[];
type EmitFixProposalsFn = (fixes: SafeFix[]) => Proposal[];
type IsEnrolledFn = (repo: string) => boolean;

interface HealthCore {
  computeHealth: ComputeHealthFn;
  computeReport: ComputeReportFn;
  saveReport: SaveReportFn;
  loadPreviousReport: LoadPreviousReportFn;
  deriveSafeFixes: DeriveSafeFixesFn;
  emitFixProposals: EmitFixProposalsFn;
  isEnrolled: IsEnrolledFn;
}

let _core: HealthCore | null | undefined = undefined;

async function importCore(): Promise<HealthCore | null> {
  if (_core === undefined) {
    try {
      const [health, store, fixes, policy] = await Promise.all([
        import('../core/quality/health.js'),
        import('../core/quality/store.js'),
        import('../core/quality/fixes.js'),
        import('../core/sandbox/policy.js'),
      ]);
      _core = {
        computeHealth: health.computeHealth as ComputeHealthFn,
        computeReport: health.computeReport as ComputeReportFn,
        saveReport: store.saveReport as SaveReportFn,
        loadPreviousReport: store.loadPreviousReport as LoadPreviousReportFn,
        deriveSafeFixes: fixes.deriveSafeFixes as DeriveSafeFixesFn,
        emitFixProposals: fixes.emitFixProposals as EmitFixProposalsFn,
        isEnrolled: policy.isEnrolled as IsEnrolledFn,
      };
    } catch {
      _core = null;
    }
  }
  return _core ?? null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

type HealthSub = 'report' | 'detail' | 'propose';

interface ParsedHealthArgs {
  sub: HealthSub;
  /** Positional repo path (for `detail` / scoped `propose`), or null. */
  repo: string | null;
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parseHealthArgs(args: string[]): ParsedHealthArgs {
  let sub: HealthSub = 'report';
  let repo: string | null = null;
  let json = false;
  let help = false;
  let error: string | undefined;
  let sawPropose = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === 'propose') {
      sawPropose = true;
    } else if (a.startsWith('--')) {
      error = `Unknown flag: ${a}`;
      break;
    } else {
      // First positional non-flag is treated as a repo path.
      if (repo !== null) {
        error = `Unexpected extra argument: ${a}`;
        break;
      }
      repo = a;
    }
  }

  // Derive the subcommand: propose wins; else a positional repo => detail.
  if (error === undefined) {
    if (sawPropose) sub = 'propose';
    else if (repo !== null) sub = 'detail';
    else sub = 'report';
  }

  return { sub, repo, json, help, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr health') + dim(' — portfolio-wide quality review (read-only)'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr health')} [--json]`);
  out(`    ${cyan('ashlr health <repo>')} [--json]`);
  out(`    ${cyan('ashlr health propose')} [<repo>] [--json]`);
  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--json', 'Emit the HealthReport / HealthScore as JSON instead of human-readable output.'],
    ['--help', 'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) out(`    ${cyan(pad(flag, w))}  ${desc}`);
  out('');
  out('  ' + bold('Subcommands:'));
  out(`    ${cyan('<repo>')}    Show a single ENROLLED repo's detail with the per-dimension breakdown.`);
  out(`    ${cyan('propose')}   Emit deterministic safe-fix advisories as PENDING inbox proposals (never auto-applies).`);
  out('');
  out('  ' + gray('Scoring is deterministic, local-only, and READ-ONLY. Only ENROLLED repos are scored.'));
  out('  ' + gray('Snapshots persist under ~/.ashlr/quality/ for trend; fixes are proposal-only.'));
  out('');
}

// ─── Human-readable output ─────────────────────────────────────────────────────

/** Short basename-ish label for a repo path (last path segment). */
function repoLabel(repo: string): string {
  const parts = repo.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : repo;
}

/**
 * Format a per-repo score delta vs the previous snapshot. Returns a signed
 * arrow string ('▲ +5', '▼ -3', '· 0') or '—' when there is no prior snapshot
 * (absent delta key).
 */
function formatDelta(delta: number | undefined): string {
  if (delta === undefined) return '—';
  const rounded = Math.round(delta);
  if (rounded > 0) return `▲ +${rounded}`;
  if (rounded < 0) return `▼ ${rounded}`;
  return '· 0';
}

/**
 * Render a portfolio HealthReport (ranked worst-first), with a ranked table of
 * repo -> score/grade + the score delta vs the previous snapshot, plus the
 * portfolio average + grade.
 */
function printReportHuman(report: HealthReport): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');
  out('');
  out(bold('  Health') + gray(` [${report.repos.length} enrolled repo(s)]`));
  out('');
  if (report.scores.length === 0) {
    out(dim('  No enrolled repos to score. Enroll repos with `ashlr enroll` first.'));
    out('');
    return;
  }

  // Ranked table (worst-first; report.scores is already sorted by the core).
  const labels = report.scores.map((s) => repoLabel(s.repo));
  const repoW = Math.max(4, ...labels.map((l) => l.length));
  out(
    '  ' +
      gray(pad('REPO', repoW)) +
      '  ' + gray(pad('SCORE', 7, 'right')) +
      '  ' + gray('GR') +
      '  ' + gray(pad('Δ', 6, 'right')) +
      '  ' + gray('TOP ISSUES'),
  );
  for (let i = 0; i < report.scores.length; i++) {
    const s = report.scores[i];
    if (s === undefined) continue;
    const label = labels[i] as string;
    const top = s.worstOffenders.slice(0, 2).map((w) => w.title).join('; ');
    out(
      '  ' +
        cyan(pad(label, repoW)) +
        '  ' + pad(`${s.score}/100`, 7, 'right') +
        '  ' + bold(s.grade) +
        '  ' + pad(formatDelta(report.delta[s.repo]), 6, 'right') +
        '  ' + dim(top || 'no findings'),
    );
  }
  out('');
  out(
    '  ' + bold('Portfolio average') +
      `  ${report.averageScore}/100 (${report.averageGrade})`,
  );
  out('');
  out('  ' + gray('Scores are deterministic + local-only. Snapshots persist under ~/.ashlr/quality/ for trend.'));
  out('');
}

/**
 * Render a single repo's HealthScore detail: a per-dimension breakdown (score /
 * weight / finding-count), the worst offenders dragging the grade down, and the
 * failed convention probes.
 */
function printDetailHuman(score: HealthScore): void {
  const tty = isTty();
  const { bold, cyan, dim, gray, yellow } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');
  out('');
  out(bold(`  Health · ${repoLabel(score.repo)}`) + gray(` — ${score.score}/100 (${score.grade})`));
  out(gray(`  ${score.repo}`));
  out('');

  // Per-dimension breakdown.
  if (score.dimensions.length > 0) {
    out('  ' + bold('Dimensions'));
    const dimW = Math.max(...score.dimensions.map((d) => d.dimension.length), 9);
    for (const d of score.dimensions) {
      out(
        '    ' +
          cyan(pad(d.dimension, dimW)) +
          '  ' + pad(`${d.score}/100`, 7, 'right') +
          '  ' + gray(`w${d.weight}`) +
          '  ' + dim(d.summary),
      );
    }
    out('');
  }

  // Worst offenders (top findings dragging the grade down).
  if (score.worstOffenders.length > 0) {
    out('  ' + bold('Worst offenders'));
    for (const w of score.worstOffenders) {
      out(`    ${yellow('•')} ${w.title}` + (w.detail ? gray(` — ${w.detail}`) : ''));
    }
    out('');
  }

  // Failed convention probes (ok=false).
  const failedConventions = score.conventions.filter((c) => !c.ok);
  if (failedConventions.length > 0) {
    out('  ' + bold('Convention gaps'));
    for (const c of failedConventions) {
      out(`    ${yellow('✗')} ${c.label}` + gray(` — ${c.detail}`));
    }
    out('');
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr health [--json]`
 * `ashlr health <repo> [--json]`
 * `ashlr health propose [<repo>] [--json]`
 *
 * Default path: deterministic, local-only, READ-ONLY portfolio report persisted
 * under ~/.ashlr/quality/. A positional <repo> shows one repo's detail.
 * `propose` emits PENDING safe-fix proposals into the inbox. Nothing
 * auto-applies; no repo working tree is ever mutated.
 *
 * ENROLLMENT-SCOPING (M25 lesson): a positional <repo> is resolve()'d and
 * checked via core.isEnrolled() HERE before any scan; a non-enrolled path
 * HARD-ERRORS with exit code 1. The core (computeReport/computeHealth callers)
 * enforces the same scoping again as defense-in-depth.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */
export async function cmdHealth(args: string[]): Promise<number> {
  const parsed = parseHealthArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr health --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red, yellow, bold, dim, cyan, gray } = makeColors(tty);

  const core = await importCore();
  if (!core) {
    process.stderr.write(
      red('error: ') +
        'health command requires src/core/quality/* (M27 modules not yet built).\n',
    );
    return 1;
  }

  // ENROLLMENT GATE (CLI layer) — a positional repo MUST be enrolled.
  // resolve() first, then isEnrolled(); HARD-ERROR on a non-enrolled path.
  if (parsed.repo !== null) {
    const abs = resolve(parsed.repo);
    if (!core.isEnrolled(abs)) {
      process.stderr.write(
        red('error: ') + `repo not enrolled for health review: ${abs}\n` +
          '       Enroll it first with `ashlr enroll` (health only reads ENROLLED repos).\n',
      );
      return 1;
    }
  }

  // ── Subcommand: propose ───────────────────────────────────────────────────
  if (parsed.sub === 'propose') {
    // Compute the score(s) to derive fixes from: a single scoped repo (already
    // enrollment-gated above) or every enrolled repo. The core re-enforces
    // enrollment-scoping (defense-in-depth).
    let scores: HealthScore[];
    try {
      if (parsed.repo !== null) {
        scores = [await core.computeHealth(resolve(parsed.repo))];
      } else {
        const report = await core.computeReport();
        scores = report.scores;
      }
    } catch (err) {
      process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      return 1;
    }

    // Derive deterministic advisory fixes per repo and emit them as PENDING
    // 'note' proposals (PROPOSAL-ONLY — nothing auto-applies, no diff written).
    const fixes: SafeFix[] = [];
    for (const score of scores) {
      for (const fix of core.deriveSafeFixes(score)) fixes.push(fix);
    }
    const proposals = core.emitFixProposals(fixes);

    if (parsed.json) {
      process.stdout.write(JSON.stringify({ fixes, proposals }) + '\n');
      return 0;
    }

    const out = (s = '') => process.stdout.write(s + '\n');
    out('');
    out(bold('  Safe-fix proposals') + dim(` — ${proposals.length} created (status: pending)`));
    out('');
    if (proposals.length === 0) {
      out(dim('  No safe fixes to propose — the enrolled repos look healthy, or nothing is enrolled.'));
      out('');
      return 0;
    }
    for (const p of proposals) {
      out(`    ${yellow('•')} ${bold(p.title)}` + (p.repo ? gray(`  (${repoLabel(p.repo)})`) : ''));
    }
    out('');
    out('  ' + gray('These are PROPOSALS only — nothing was applied. Review them with ') + cyan('ashlr inbox') + gray('.'));
    out('');
    return 0;
  }

  // ── Subcommand: detail (single repo) ──────────────────────────────────────
  if (parsed.sub === 'detail' && parsed.repo !== null) {
    let score: HealthScore;
    try {
      score = await core.computeHealth(resolve(parsed.repo));
    } catch (err) {
      process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      return 1;
    }
    if (parsed.json) {
      process.stdout.write(JSON.stringify(score) + '\n');
    } else {
      printDetailHuman(score);
    }
    return 0;
  }

  // ── Default: portfolio report ─────────────────────────────────────────────
  let report: HealthReport;
  try {
    report = await core.computeReport();
  } catch (err) {
    process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }

  // Fill per-repo deltas from the prior snapshot (the newest report strictly
  // BEFORE this one, so we never diff a just-saved report against itself), then
  // persist this one so the trend accumulates. Best-effort: a failed load/save
  // never blocks the report.
  try {
    const previous = core.loadPreviousReport(report.generatedAt);
    if (previous) {
      const priorByRepo = new Map<string, number>();
      for (const s of previous.scores) priorByRepo.set(s.repo, s.score);
      for (const s of report.scores) {
        const prior = priorByRepo.get(s.repo);
        if (prior !== undefined) report.delta[s.repo] = s.score - prior;
      }
    }
  } catch {
    // Delta is advisory; never let a comparison failure block the report.
  }
  // Only persist a snapshot when there is something to track — an empty
  // enrollment (no scored repos) should not litter ~/.ashlr/quality with
  // empty reports that would pollute the trend history.
  if (report.scores.length > 0) core.saveReport(report);

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    printReportHuman(report);
  }

  return 0;
}
