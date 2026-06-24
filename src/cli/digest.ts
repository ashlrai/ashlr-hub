/**
 * CLI handler for `ashlr digest` — M29 portfolio daily digest (Ashlr v2 pillar G).
 *
 * Builds a deterministic DAILY DIGEST from the read-only org-level portfolio
 * snapshot + day-over-day deltas, ALWAYS writes a LOCAL artifact under
 * ~/.ashlr/digests/, prints it, and — ONLY with an explicit `--notify` — sends
 * it outward via the opt-in notify() webhook.
 *
 * Usage:
 *   ashlr digest                       # build + write local + print (default)
 *   ashlr digest --json                # emit the DigestReport as JSON
 *   ashlr digest --window <7d|30d>     # cost/forecast window (default 7d)
 *   ashlr digest --notify              # ALSO send via configured webhook (opt-in)
 *   ashlr digest --narrative           # OPT-IN: attempt an optional LLM narrative (local-first)
 *   ashlr digest --narrative --allow-cloud  # permit a CLOUD model for that narrative
 *
 * HARD SAFETY INVARIANTS (M29) enforced by this surface:
 *  - READ-ONLY AGGREGATION: the digest only READS local state (via buildDigest
 *    -> buildSnapshot) and WRITES only under ~/.ashlr/digests/ (via
 *    deliverDigest -> saveDigest). NEVER mutates a repo, writes config, applies
 *    a proposal, pushes, opens a PR, or deploys.
 *  - NO OUTWARD ACTION BY DEFAULT: the default path writes a LOCAL file and
 *    makes ZERO outward network calls. `--notify` is the ONLY outward path and
 *    is OPT-IN; notify() is itself a no-op unless a webhook is configured.
 *  - LOCAL-FIRST: aggregation + rendering are deterministic with NO LLM. The
 *    optional narrative routes through getActiveClient (local-only unless
 *    --allow-cloud + key); default path is fully on-machine.
 *
 * NOTE (integration — owned by the Build/Integrate phase, NOT this scaffold):
 *   src/cli/index.ts must add a `loadDigestCmd = lazyCmd(() => import('./digest.js'),
 *   (m) => m.cmdDigest as Cmd, 'digest command requires src/cli/digest.ts (M29 …)')`,
 *   a `case 'digest':` in the dispatch switch, and cmdHelp + help-text entries.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */

import { makeColors, isTty, pad } from './ui.js';
import type { DigestReport, DigestWindow } from '../core/types.js';
import type { FleetDigest } from '../core/fleet/digest.js';

// ---------------------------------------------------------------------------
// M70: ashlr-md render seam (lazy — degrades when ashlr-md not installed)
// ---------------------------------------------------------------------------

type PresentMarkdownFn = (
  title: string,
  body: string,
) => { rendered: boolean; path?: string; detail: string };

let _presentMarkdownDigest: PresentMarkdownFn | null | undefined;

async function loadMarkdownModule(): Promise<PresentMarkdownFn | null> {
  if (_presentMarkdownDigest === undefined) {
    try {
      const mod = await import('../core/integrations/markdown.js') as {
        presentMarkdown: PresentMarkdownFn;
      };
      _presentMarkdownDigest = mod.presentMarkdown;
    } catch {
      _presentMarkdownDigest = null;
    }
  }
  return _presentMarkdownDigest ?? null;
}

/**
 * Build a Markdown body for a DigestReport suitable for ashlr-md.
 * Pure function — no side effects, safe to unit-test directly.
 */
export function buildDigestMarkdown(report: DigestReport): string {
  const lines: string[] = [];
  const p = report.portfolio;

  lines.push(`> ${report.date} · window: ${report.window}`);
  lines.push(``);

  lines.push(`## Headline\n`);
  lines.push(report.headline || '_No activity to report._');
  lines.push(``);

  lines.push(`## Overview\n`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Repos | ${report.repos.total} total · ${report.repos.dirty} dirty · ${report.repos.stale} stale |`);
  lines.push(`| Pending proposals | ${report.pendingProposals} |`);
  lines.push(`| Cost (${p.cost.window}) | $${p.cost.spentUsd.toFixed(4)} · ~$${p.cost.projectedMonthlyUsd.toFixed(2)}/mo |`);
  lines.push(`| Local savings | $${p.cost.localSavingsUsd.toFixed(4)} |`);
  if (report.daemon) {
    lines.push(`| Operator | ${report.daemon.running ? 'running' : 'stopped'} · $${report.daemon.todaySpentUsd.toFixed(4)} today |`);
  }
  lines.push(``);

  if (p.health.reposScored > 0) {
    lines.push(`## Health\n`);
    lines.push(`Average: **${p.health.averageScore}/100** (${p.health.averageGrade}) across ${p.health.reposScored} repo(s)\n`);
    if (p.health.worstRepos.length > 0) {
      lines.push(`| Repo | Score | Grade |`);
      lines.push(`|------|-------|-------|`);
      for (const r of p.health.worstRepos) {
        const label = r.repo ? r.repo.split('/').filter(Boolean).slice(-1)[0] ?? r.repo : '—';
        lines.push(`| ${label} | ${r.score}/100 | **${r.grade}** |`);
      }
    }
    lines.push(``);
  }

  if (p.goalsInFlight.length > 0) {
    lines.push(`## Goals In Flight\n`);
    for (const g of p.goalsInFlight) {
      const pct = Math.round(g.fractionDone * 100);
      const next = g.nextActionable ? ` → _${g.nextActionable}_` : '';
      lines.push(`- **${pct}%** ${g.objective}${next}`);
    }
    lines.push(``);
  }

  if (p.backlogTop.length > 0) {
    lines.push(`## Top Backlog\n`);
    for (const item of p.backlogTop) {
      const where = item.repo ? ` _(${item.repo.split('/').filter(Boolean).slice(-1)[0] ?? item.repo})_` : '';
      lines.push(`- [${item.score}] ${item.title}${where}`);
    }
    lines.push(``);
  }

  if (p.effectiveness) {
    lines.push(`## Effectiveness\n`);
    lines.push(p.effectiveness.headline);
    lines.push(``);
  }

  const t = p.today;
  if (t.previousAt) {
    lines.push(`## Day-over-Day (vs ${t.previousAt})\n`);
    lines.push(`| Metric | Delta |`);
    lines.push(`|--------|-------|`);
    const fmt = (n: number | null, d = 0) => {
      if (n === null) return '—';
      const v = d > 0 ? Number(n.toFixed(d)) : Math.round(n);
      if (v > 0) return `▲ +${d > 0 ? v.toFixed(d) : v}`;
      if (v < 0) return `▼ ${d > 0 ? v.toFixed(d) : v}`;
      return '· 0';
    };
    lines.push(`| Pending proposals | ${fmt(t.pendingProposalsDelta)} |`);
    lines.push(`| Dirty repos | ${fmt(t.dirtyReposDelta)} |`);
    lines.push(`| Spend | ${fmt(t.spendUsdDelta, 4)} |`);
    lines.push(`| Health score | ${fmt(t.healthScoreDelta)} |`);
    lines.push(`| Goals in flight | ${fmt(t.goalsInFlightDelta)} |`);
    lines.push(``);
  }

  if (report.fleet) {
    const fl = report.fleet;
    lines.push(`## Fleet Activity\n`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Fleet | ${fl.running ? 'running' : 'stopped'} · $${fl.todaySpentUsd.toFixed(4)} today · ${fl.itemsProcessed} items |`);
    lines.push(`| Proposed (window) | ${fl.totalProposed} |`);
    lines.push(`| Auto-merged | ${fl.totalAutoMerged} |`);
    lines.push(`| Pending review | ${fl.totalPending} |`);
    lines.push(`| Declined | ${fl.totalDeclined} |`);
    if (fl.repos.length > 0) {
      lines.push(``);
      lines.push(`| Repo | Proposed | Merged | Pending | Declined |`);
      lines.push(`|------|----------|--------|---------|----------|`);
      for (const r of fl.repos) {
        const label = r.repo.split('/').filter(Boolean).slice(-1)[0] ?? r.repo;
        lines.push(`| ${label} | ${r.proposed} | ${r.autoMerged} | ${r.pending} | ${r.declined} |`);
      }
    }
    lines.push(``);
  }

  if (report.narrative) {
    lines.push(`## Summary${report.narrativeLocal ? ' _(local model)_' : ''}\n`);
    lines.push(report.narrative);
    lines.push(``);
  }

  return lines.join('\n');
}

// ─── Lazy imports (graceful degradation if M29 core not yet built) ───────────

type BuildDigestFn = (
  cfg: import('../core/types.js').AshlrConfig,
  opts?: { window?: DigestWindow; narrative?: boolean; allowCloud?: boolean },
) => Promise<DigestReport>;
type RenderDigestTextFn = (report: DigestReport) => string;
type DeliverDigestFn = (
  report: DigestReport,
  cfg: import('../core/types.js').AshlrConfig,
  opts?: { notify?: boolean },
) => Promise<import('../core/types.js').DigestDeliveryResult>;
type LoadConfigFn = () => import('../core/types.js').AshlrConfig;

interface DigestCore {
  buildDigest: BuildDigestFn;
  renderDigestText: RenderDigestTextFn;
  deliverDigest: DeliverDigestFn;
  loadConfig: LoadConfigFn;
}

let _core: DigestCore | null | undefined = undefined;

async function importCore(): Promise<DigestCore | null> {
  if (_core === undefined) {
    try {
      const [build, deliver, config] = await Promise.all([
        import('../core/digest/build.js'),
        import('../core/digest/deliver.js'),
        import('../core/config.js'),
      ]);
      _core = {
        buildDigest: build.buildDigest as BuildDigestFn,
        renderDigestText: deliver.renderDigestText as RenderDigestTextFn,
        deliverDigest: deliver.deliverDigest as DeliverDigestFn,
        loadConfig: config.loadConfig as LoadConfigFn,
      };
    } catch {
      _core = null;
    }
  }
  return _core ?? null;
}

// ─── Fleet digest builder (lazy, graceful degradation) ───────────────────────

type BuildFleetDigestFn = (
  window: DigestWindow,
  opts?: { now?: Date },
) => Promise<FleetDigest>;

let _buildFleetDigest: BuildFleetDigestFn | null | undefined = undefined;

async function importFleetDigest(): Promise<BuildFleetDigestFn | null> {
  if (_buildFleetDigest === undefined) {
    try {
      const mod = await import('../core/fleet/digest.js') as {
        buildFleetDigest: BuildFleetDigestFn;
      };
      _buildFleetDigest = mod.buildFleetDigest;
    } catch {
      _buildFleetDigest = null;
    }
  }
  return _buildFleetDigest ?? null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface ParsedDigestArgs {
  json: boolean;
  notify: boolean;
  narrative: boolean;
  allowCloud: boolean;
  window: DigestWindow;
  help: boolean;
  open: boolean;
  error: string | undefined;
}

function parseDigestArgs(args: string[]): ParsedDigestArgs {
  let json = false;
  let notify = false;
  let narrative = false;
  let allowCloud = false;
  let window: DigestWindow = '7d';
  let help = false;
  let open = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--notify') {
      notify = true;
    } else if (a === '--narrative') {
      narrative = true;
    } else if (a === '--allow-cloud') {
      allowCloud = true;
    } else if (a === '--open' || a === '--md') {
      // M70: open the digest in the ashlr-md viewer
      open = true;
    } else if (a === '--window') {
      const v = args[i + 1];
      if (v === '7d' || v === '30d') {
        window = v;
        i++;
      } else {
        error = `--window expects 7d or 30d (got: ${v ?? '<missing>'})`;
        break;
      }
    } else if (a.startsWith('--')) {
      error = `Unknown flag: ${a}`;
      break;
    } else {
      error = `Unexpected argument: ${a}`;
      break;
    }
  }

  return { json, notify, narrative, allowCloud, window, help, open, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr digest') + dim(' — org-level daily portfolio digest (read-only; local by default)'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr digest')} [--window <7d|30d>] [--json] [--notify] [--narrative] [--allow-cloud] [--open]`);
  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--window <7d|30d>', 'Cost/forecast window for the digest. Default 7d.'],
    ['--json', 'Emit the DigestReport as JSON instead of human-readable output.'],
    ['--notify', 'ALSO send the digest via a configured Slack/Discord webhook (OPT-IN; the only outward path).'],
    ['--narrative', 'Attempt an OPTIONAL LLM narrative (local-first). Off by default (deterministic-only).'],
    ['--allow-cloud', 'With --narrative, permit a CLOUD model. Off by default (local-only). No effect without --narrative.'],
    ['--open', 'Open the digest in the ashlr-md viewer (--md is an alias). Falls back to terminal when ashlr-md is not installed.'],
    ['--help', 'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) out(`    ${cyan(pad(flag, w))}  ${desc}`);
  out('');
  out('  ' + gray('The digest ALWAYS writes a LOCAL artifact under ~/.ashlr/digests/ and prints it.'));
  out('  ' + gray('It makes ZERO outward network calls unless you pass --notify AND a webhook is configured.'));
  out('  ' + gray('Aggregation + rendering are deterministic and local-only; the narrative is opt-in via --narrative.'));
  out('');
}

// ─── Human-readable output ─────────────────────────────────────────────────────

/** Short basename-ish label for a repo path (last non-empty path segment). */
function repoLabel(repo: string | null): string {
  if (!repo) return '—';
  const parts = repo.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : repo;
}

/**
 * Format a signed numeric delta with an arrow ('▲ +5', '▼ -3', '· 0'), or '—'
 * when there is no prior digest to compare against (null). `digits` controls
 * fixed-point precision for non-integer figures (e.g. spend in USD).
 */
function signedDelta(n: number | null, digits = 0): string {
  if (n === null) return '—';
  const v = digits > 0 ? Number(n.toFixed(digits)) : Math.round(n);
  if (v > 0) return `▲ +${digits > 0 ? v.toFixed(digits) : v}`;
  if (v < 0) return `▼ ${digits > 0 ? v.toFixed(digits) : v}`;
  return '· 0';
}

/**
 * Render a DigestReport for the terminal. Deterministic, READ-ONLY display of
 * the already-built digest (mirrors the health/reflect human output). Prints
 * the headline, the repo roll-up + pending proposals, the portfolio health /
 * in-flight goals / top backlog / cost+forecast / effectiveness sections, the
 * "today" day-over-day delta block, and an optional narrative when present.
 */
function printDigestHuman(report: DigestReport): void {
  const tty = isTty();
  const { bold, cyan, dim, gray, green, yellow } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  const p = report.portfolio;

  out('');
  out(bold('  Digest') + gray(` [${report.date} · ${report.window}]`));
  out('');

  // Headline — the load-bearing one-line summary.
  out('  ' + bold(report.headline || 'No activity to report.'));
  out('');

  // Repos + pending + daemon roll-up.
  const rows: [string, string][] = [
    ['Repos', `${report.repos.total} total · ${report.repos.dirty} dirty · ${report.repos.stale} stale`],
    ['Pending proposals', String(report.pendingProposals)],
    [
      'Cost',
      `$${p.cost.spentUsd.toFixed(4)} (${p.cost.window}) · ~$${p.cost.projectedMonthlyUsd.toFixed(2)}/mo · saved $${p.cost.localSavingsUsd.toFixed(4)} local`,
    ],
  ];
  if (report.daemon) {
    rows.push([
      'Operator',
      `${report.daemon.running ? 'running' : 'stopped'} · $${report.daemon.todaySpentUsd.toFixed(4)} today`,
    ]);
  }
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`    ${cyan(pad(k, w))}  ${v}`);
  out('');

  // Health summary (ENROLLMENT-SCOPED — empty when nothing enrolled).
  if (p.health.reposScored > 0) {
    out('  ' + bold('Health') + gray(` — ${p.health.averageScore}/100 (${p.health.averageGrade}) over ${p.health.reposScored} repo(s)`));
    for (const r of p.health.worstRepos) {
      out(`    ${yellow('•')} ${cyan(repoLabel(r.repo))}  ${pad(`${r.score}/100`, 7, 'right')}  ${bold(r.grade)}`);
    }
    out('');
  }

  // In-flight goals (M28).
  if (p.goalsInFlight.length > 0) {
    out('  ' + bold('Goals in flight') + gray(` (${p.goalsInFlight.length})`));
    for (const g of p.goalsInFlight) {
      const next = g.nextActionable ? gray(` → ${g.nextActionable}`) : '';
      out(`    ${green(`${Math.round(g.fractionDone * 100)}%`)}  ${g.objective}${next}`);
    }
    out('');
  }

  // Top backlog (M22).
  if (p.backlogTop.length > 0) {
    out('  ' + bold('Top backlog'));
    for (const item of p.backlogTop) {
      const where = item.repo ? gray(`  (${repoLabel(item.repo)})`) : '';
      out(`    ${dim(pad(String(item.score), 4, 'right'))}  ${item.title}${where}`);
    }
    out('');
  }

  // Effectiveness headline (M26).
  if (p.effectiveness) {
    out('  ' + bold('Effectiveness') + gray(` — ${p.effectiveness.headline}`));
    out('');
  }

  // "Today" day-over-day deltas vs the previous digest.
  const t = p.today;
  if (t.previousAt) {
    out('  ' + bold('Today') + gray(` (vs ${t.previousAt})`));
    out(`    ${cyan(pad('Pending', 14))}  ${signedDelta(t.pendingProposalsDelta)}`);
    out(`    ${cyan(pad('Dirty repos', 14))}  ${signedDelta(t.dirtyReposDelta)}`);
    out(`    ${cyan(pad('Spend', 14))}  ${signedDelta(t.spendUsdDelta, 4)}`);
    out(`    ${cyan(pad('Health score', 14))}  ${signedDelta(t.healthScoreDelta)}`);
    out(`    ${cyan(pad('Goals', 14))}  ${signedDelta(t.goalsInFlightDelta)}`);
    out('');
  } else {
    out(dim('  No prior digest yet — day-over-day deltas appear from the next run.'));
    out('');
  }

  // Fleet activity section (M88).
  if (report.fleet) {
    const fl = report.fleet;
    const status = fl.running ? green('running') : dim('stopped');
    out('  ' + bold('Fleet') + gray(` — ${status}${fl.lastTickAt ? gray(` · last tick ${fl.lastTickAt.slice(0, 19).replace('T', ' ')}`) : ''}`));
    const flRows: [string, string][] = [
      ['Proposed', String(fl.totalProposed)],
      ['Auto-merged', String(fl.totalAutoMerged)],
      ['Pending review', String(fl.totalPending)],
      ['Declined', String(fl.totalDeclined)],
      ['Today spend', `$${fl.todaySpentUsd.toFixed(4)}`],
      ['Items processed', String(fl.itemsProcessed)],
    ];
    const fw = Math.max(...flRows.map(([k]) => k.length));
    for (const [k, v] of flRows) out(`    ${cyan(pad(k, fw))}  ${v}`);
    if (fl.repos.length > 0) {
      out('');
      out('  ' + bold('Fleet by repo'));
      for (const r of fl.repos) {
        const label = repoLabel(r.repo);
        const parts: string[] = [];
        if (r.proposed > 0) parts.push(`${r.proposed} proposed`);
        if (r.autoMerged > 0) parts.push(green(`${r.autoMerged} merged`));
        if (r.pending > 0) parts.push(yellow(`${r.pending} pending`));
        if (r.declined > 0) parts.push(dim(`${r.declined} declined`));
        out(`    ${cyan(pad(label, 24))}  ${parts.join(' · ')}`);
      }
    }
    out('');
  }

  // Optional narrative (present only when explicitly requested + reachable).
  if (report.narrative) {
    out('  ' + bold('Summary') + (report.narrativeLocal ? gray(' (local model)') : ''));
    for (const line of report.narrative.split('\n')) out('    ' + line);
    out('');
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr digest [--window <7d|30d>] [--json] [--notify] [--allow-cloud]`
 *
 * Default path: build the digest (deterministic, read-only), ALWAYS write the
 * local artifact under ~/.ashlr/digests/, and print it. `--notify` is the ONLY
 * outward path and is OPT-IN. `--allow-cloud` permits a CLOUD model for the
 * optional narrative (off by default; local-only otherwise).
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */
export async function cmdDigest(args: string[]): Promise<number> {
  const parsed = parseDigestArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr digest --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red, yellow, green, dim, gray, cyan } = makeColors(tty);

  const core = await importCore();
  if (!core) {
    process.stderr.write(
      red('error: ') +
        'digest command requires src/core/digest/* (M29 modules not yet built).\n',
    );
    return 1;
  }

  // Privacy notice for --allow-cloud (mirrors reflect.ts / health.ts). Only the
  // OPTIONAL narrative can ever touch a model; all digest numbers are local.
  // Suppressed under --json so the JSON payload on stdout stays clean (the
  // warning goes to stderr regardless, but we keep parity with reflect.ts).
  if (parsed.narrative && parsed.allowCloud && !parsed.json) {
    process.stderr.write(
      yellow('warning: ') +
        '--narrative + --allow-cloud are set — the OPTIONAL digest narrative MAY be synthesized by a cloud model.\n' +
        '         All digest figures are always computed locally. Omit --allow-cloud to keep the narrative on-machine.\n',
    );
  }

  const cfg = core.loadConfig();

  // 1. Build the digest — deterministic, READ-ONLY aggregation. buildDigest
  //    never throws (degrades to a zeroed report), but guard defensively so a
  //    surprise rejection surfaces as exit 1 rather than an unhandled rejection.
  let report: DigestReport;
  try {
    report = await core.buildDigest(cfg, {
      window: parsed.window,
      narrative: parsed.narrative,
      allowCloud: parsed.allowCloud,
    });
  } catch (err) {
    process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }

  // 1b. Augment with fleet activity (M88). Best-effort — never blocks the digest.
  const buildFleet = await importFleetDigest();
  if (buildFleet) {
    try {
      const fleet = await buildFleet(parsed.window);
      // Only attach when there is meaningful fleet data (at least one proposal
      // or a daemon that has ever ticked) — keeps the report clean for fresh installs.
      const hasActivity =
        fleet.totalProposed > 0 ||
        fleet.totalPending > 0 ||
        fleet.totalAutoMerged > 0 ||
        fleet.totalDeclined > 0 ||
        fleet.itemsProcessed > 0 ||
        fleet.running;
      if (hasActivity) {
        (report as DigestReport & { fleet: typeof fleet }).fleet = fleet;
      }
    } catch {
      // Best-effort — fleet section silently absent on error.
    }
  }

  // 2. Deliver — ALWAYS writes the LOCAL artifact under ~/.ashlr/digests/. The
  //    notify() webhook is the SINGLE outward path and is reached ONLY when the
  //    user explicitly passed --notify (opt-in). deliverDigest never throws.
  let result: import('../core/types.js').DigestDeliveryResult;
  try {
    result = await core.deliverDigest(report, cfg, { notify: parsed.notify });
  } catch (err) {
    process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }

  // 3. Output the report itself.
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else if (parsed.open) {
    // M70: open in ashlr-md when --open / --md is set.
    // Try the viewer first; fall back to terminal if absent or if the write fails.
    let openedInViewer = false;
    const presentFn = await loadMarkdownModule();
    if (presentFn) {
      const mdBody = buildDigestMarkdown(report);
      const mdTitle = `ashlr digest — ${report.date} (${report.window})`;
      const mdResult = presentFn(mdTitle, mdBody);
      if (mdResult.rendered && mdResult.path) {
        process.stdout.write(cyan('  opened in ashlr-md: ') + mdResult.path + '\n');
        openedInViewer = true;
      }
    }
    if (!openedInViewer) {
      // ashlr-md not installed or write failed — terminal fallback (unchanged)
      printDigestHuman(report);
    }
  } else {
    printDigestHuman(report);
  }

  // 4. Surface what delivery actually did (human mode only — JSON callers read
  //    `result` is not part of the report payload, so we keep stdout clean).
  if (!parsed.json) {
    const out = (s = '') => process.stdout.write(s + '\n');
    if (result.jsonPath) {
      out('  ' + gray('Saved ') + cyan(result.jsonPath));
    } else {
      out('  ' + yellow('warning: ') + dim('could not write the local digest artifact.'));
    }
    if (parsed.notify) {
      // --notify was opted in. notify() is itself a strict no-op (returns false,
      // ZERO network calls) when no webhook is configured — surface that plainly
      // so the user knows nothing went outward.
      if (result.notified) {
        out('  ' + green('✓ ') + dim('delivered via the configured webhook.'));
      } else {
        out('  ' + dim('--notify was set but no webhook is configured — nothing was sent (local-only).'));
      }
    } else {
      out('  ' + dim('Local only — pass ') + cyan('--notify') + dim(' to also send via a configured webhook.'));
    }
    out('');
  }

  return 0;
}
