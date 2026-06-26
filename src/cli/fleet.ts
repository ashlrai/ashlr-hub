/**
 * `ashlr fleet` — M49 fleet control plane + observability CLI.
 *
 * Subcommands:
 *   fleet status [--json]
 *       Print a READ-ONLY snapshot of the whole fleet: daemon liveness +
 *       today's spend, per-backend recent dispatches + quota, queue size,
 *       proposal counts (pending / frontier-pending / applied), recent
 *       auto-merges, and the kill-switch (paused) state. Never mutates.
 *   fleet watch [--json]
 *       Glanceable one-screen monitoring summary: one-line health header plus
 *       recent autonomous actions (last 8 from the audit log) and recent daemon
 *       errors (last 5 non-empty lines of ~/.ashlr/daemon.launchd.err.log).
 *       --json emits { fleet, recentActions, recentErrors }. READ-ONLY; never
 *       mutates. Each data source is independently guarded — one failure
 *       degrades only its own slice.
 *   fleet pause
 *       Engage the global kill switch (setKill(true)) — same effect as
 *       `ashlr daemon stop`'s kill: any running loop halts on its next tick and
 *       nothing autonomous dispatches until resumed. Idempotent.
 *   fleet resume
 *       Release the kill switch (setKill(false)). Idempotent.
 *
 * Pause/resume are the ONLY mutations here, and they touch ONLY the kill-switch
 * sentinel (no repo, no spend, no proposals). `fleet status` is fully read-only.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../core/types.js';
import type { AuditEntry } from '../core/types.js';
import type { FleetStatus } from '../core/fleet/status.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, green, red, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Pure formatter — exported for unit testing (no I/O, no color deps).
// ---------------------------------------------------------------------------

/**
 * Render a FleetStatus as a plain (no-color) multi-line string. Pure and
 * deterministic — does no I/O and takes no color dependency, so it is fully
 * unit-testable.
 */
export function formatFleetStatus(s: FleetStatus): string {
  const lines: string[] = [];
  const pausedTag = s.killed ? '  [PAUSED — kill switch engaged]' : '';

  lines.push('Fleet status' + pausedTag);
  lines.push('');

  // Daemon
  lines.push(`Daemon:    ${s.daemon.running ? 'running' : 'stopped'}`);
  lines.push(`  last tick:     ${s.daemon.lastTickAt ?? '—'}`);
  lines.push(`  spend today:   $${s.daemon.todaySpentUsd.toFixed(4)}`);
  lines.push('');

  // Backends
  lines.push('Backends:');
  if (s.backends.length === 0) {
    lines.push('  (none)');
  } else {
    const nameW = Math.max(8, ...s.backends.map((b) => b.backend.length));
    for (const b of s.backends) {
      const name = b.backend + ' '.repeat(Math.max(0, nameW - b.backend.length));
      lines.push(`  ${name}  dispatches(24h)=${b.dispatchesRecent}  quota=${b.quota}`);
    }
  }
  lines.push('');

  // Queue
  lines.push(`Queue:     ${s.queue.backlogItems} backlog item(s)`);
  lines.push('');

  // Proposals
  lines.push('Proposals:');
  lines.push(`  pending:           ${s.proposals.pending}`);
  lines.push(`  frontier pending:  ${s.proposals.frontierPending}`);
  lines.push(`  applied:           ${s.proposals.applied}`);
  lines.push('');

  // Merges
  lines.push(`Merges:    ${s.merges.recent} auto-merge(s) in last 24h`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Config loader (lazy, graceful)
// ---------------------------------------------------------------------------

async function loadCfg(): Promise<AshlrConfig | null> {
  try {
    const { loadConfig } = await import('../core/config.js');
    return loadConfig();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: status (READ-ONLY)
// ---------------------------------------------------------------------------

async function cmdFleetStatus(jsonMode: boolean): Promise<number> {
  const cfg = await loadCfg();
  if (!cfg) {
    process.stderr.write(red('error: ') + 'failed to load config.\n');
    return 1;
  }

  let status: FleetStatus;
  try {
    const { buildFleetStatus } = await import('../core/fleet/status.js');
    status = await buildFleetStatus(cfg);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to build fleet status: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr fleet') + dim(' — control plane + observability'));
  console.log('');
  for (const line of formatFleetStatus(status).split('\n')) {
    // Colorize the paused banner line; leave the rest plain.
    if (line.includes('[PAUSED')) console.log('  ' + yellow(line));
    else console.log('  ' + line);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: watch (READ-ONLY glanceable summary)
// ---------------------------------------------------------------------------

/**
 * Return the last `n` non-empty lines of a file. Pure and synchronous — reads
 * at most `maxBytes` from the end of the file so a huge log never blows memory.
 * Returns [] when the file is absent or unreadable.
 *
 * Exported for unit testing.
 */
export function tailErrLog(filePath: string, n: number, maxBytes = 32_768): string[] {
  try {
    const raw = readFileSync(filePath);
    // Only look at the tail slice to bound memory.
    const slice = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
    const text = slice.toString('utf8');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/** Relative-time label: "Xm ago", "Xs ago", "Xh ago", or the raw ISO string. */
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - Date.parse(iso);
  if (isNaN(diffMs) || diffMs < 0) return iso;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export async function cmdFleetWatch(jsonMode: boolean): Promise<number> {
  const cfg = await loadCfg();

  // 1. Fleet status (never throws — buildFleetStatus is already guarded).
  let fleetStatus: FleetStatus | null = null;
  if (cfg) {
    try {
      const { buildFleetStatus } = await import('../core/fleet/status.js');
      fleetStatus = await buildFleetStatus(cfg);
    } catch {
      // degraded — fleetStatus stays null
    }
  }

  // 2. Recent audit actions (last 8).
  let recentActions: AuditEntry[] = [];
  try {
    const { readAudit } = await import('../core/sandbox/audit.js' as unknown as string) as {
      readAudit: (limit?: number) => AuditEntry[];
    };
    recentActions = readAudit(8);
  } catch {
    recentActions = [];
  }

  // 3. Recent daemon errors (last 5 non-empty lines of the launchd err log).
  const errLogPath = join(homedir(), '.ashlr', 'daemon.launchd.err.log');
  const recentErrors = tailErrLog(errLogPath, 5);

  // ── JSON mode ────────────────────────────────────────────────────────────
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ fleet: fleetStatus, recentActions, recentErrors }, null, 2) + '\n',
    );
    return 0;
  }

  // ── Human render ─────────────────────────────────────────────────────────
  console.log('');

  // One-line health header.
  const fs = fleetStatus;
  if (fs) {
    const state = fs.daemon.running ? (fs.killed ? 'PAUSED' : 'running') : 'idle';
    const header = [
      `fleet: ${state}`,
      `queue ${fs.queue.backlogItems}`,
      `pending ${fs.proposals.pending}`,
      `spent today $${fs.daemon.todaySpentUsd.toFixed(2)}`,
      `last tick ${relTime(fs.daemon.lastTickAt)}`,
    ].join(' · ');
    if (fs.killed) {
      console.log('  ' + yellow(bold(header)));
    } else if (fs.daemon.running) {
      console.log('  ' + green(header));
    } else {
      console.log('  ' + dim(header));
    }
  } else {
    console.log('  ' + yellow('fleet: config unavailable'));
  }

  console.log('');

  // Recent actions.
  console.log('  ' + bold('Recent actions') + dim(' (last 8):'));
  if (recentActions.length === 0) {
    console.log('  ' + dim('  none'));
  } else {
    for (const e of recentActions) {
      const ts = dim(e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
      const ok = e.result === 'ok' ? green('ok') : e.result === 'refused' ? yellow('refused') : red('error');
      const detail = e.summary ? dim('  ' + e.summary.slice(0, 60)) : '';
      console.log(`    ${ts}  [${ok}]  ${bold(e.action)}${detail}`);
    }
  }

  console.log('');

  // Recent daemon errors.
  console.log('  ' + bold('Recent errors') + dim(' (daemon.launchd.err.log, last 5):'));
  if (recentErrors.length === 0) {
    console.log('  ' + dim('  none'));
  } else {
    for (const line of recentErrors) {
      console.log('    ' + red(line.slice(0, 120)));
    }
  }

  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommands: pause / resume (kill-switch only)
// ---------------------------------------------------------------------------

async function setKillSwitch(on: boolean): Promise<number> {
  try {
    const { setKill } = await import('../core/sandbox/policy.js');
    setKill(on);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to toggle kill switch: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  console.log('');
  if (on) {
    console.log(green('  ✓ fleet paused') + dim(' — kill switch engaged.'));
    console.log(dim('  Any running loop halts on its next tick; nothing autonomous dispatches.'));
    console.log(dim('  Resume with `ashlr fleet resume`.'));
  } else {
    console.log(green('  ✓ fleet resumed') + dim(' — kill switch released.'));
    console.log(dim('  The daemon may dispatch again on its next tick (if running).'));
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * M59: a conservative starter `cfg.foundry` block. Installed backends +
 * OS confinement on + auto-merge OFF. No mergeAuthority models are guessed (the
 * user pins those); no API engines are added (they need keys). Adding more is
 * config-only — see docs/FOUNDRY-CONFIG.md.
 */
function starterFoundry(): NonNullable<AshlrConfig['foundry']> {
  return {
    allowedBackends: ['builtin', 'claude', 'codex', 'hermes'],
    confinement: { '*': { mode: 'os', networkEgress: false, onUnsupported: 'fallback' } },
    autoMerge: { enabled: false },
  };
}

/**
 * `ashlr fleet init [--write]` — print (default) or merge (--write, only when
 * absent) a starter cfg.foundry. NEVER overwrites an existing foundry block.
 */
async function cmdFleetInit(args: string[]): Promise<number> {
  const write = args.includes('--write');
  const { loadConfig, saveConfig, CONFIG_PATH } = await import('../core/config.js');
  const cfg = loadConfig();
  const block = { foundry: starterFoundry() };

  if (!write) {
    console.log('');
    console.log(dim('  # Starter cfg.foundry — merge into ' + CONFIG_PATH));
    console.log(dim('  # Full reference: docs/FOUNDRY-CONFIG.md'));
    console.log(JSON.stringify(block, null, 2));
    console.log('');
    console.log(dim('  Re-run `ashlr fleet init --write` to merge it (only when foundry is absent).'));
    return 0;
  }

  if (cfg.foundry) {
    console.error(
      yellow('note: ') +
        'cfg.foundry already present in ' +
        CONFIG_PATH +
        ' — not overwriting. Edit it by hand (see docs/FOUNDRY-CONFIG.md).',
    );
    return 1;
  }

  cfg.foundry = starterFoundry();
  saveConfig(cfg);
  console.log(
    green('✓ ') +
      'wrote a starter cfg.foundry to ' +
      CONFIG_PATH +
      ' (auto-merge OFF; set provider keys + pass --allow-cloud to use API backends).',
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: doctor (engine readiness preflight)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet doctor [--json]`
 *
 * Probes every engine in cfg.foundry.allowedBackends and renders a one-glance
 * readiness table: engine · tier · installed · authed · ready · fix.
 * Color-coded: green = ready, yellow = unknown/warn, red = blocked.
 * Prints a one-line summary at the bottom ("N/M engines ready; X needs action").
 * Never throws; degrades gracefully when cfg is absent.
 */
async function cmdFleetDoctor(jsonMode: boolean): Promise<number> {
  const cfg = await loadCfg();

  const { fleetReadiness } = await import('../core/fleet/engine-readiness.js');
  const results = fleetReadiness(cfg ?? undefined);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return 0;
  }

  const readyCount = results.filter((r) => r.ready).length;
  const total = results.length;

  console.log('');
  console.log(bold('  ashlr fleet doctor') + dim(' — engine readiness preflight (M81)'));
  console.log('');

  // Column widths
  const engineW = Math.max(8, ...results.map((r) => r.engine.length));
  const tierW   = Math.max(5, ...results.map((r) => r.tier.length));

  // Header
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(
    '  ' +
      dim(pad('engine', engineW)) +
      '  ' +
      dim(pad('tier', tierW)) +
      '  ' +
      dim(pad('inst', 5)) +
      '  ' +
      dim(pad('authed', 7)) +
      '  ' +
      dim(pad('ready', 5)),
  );
  console.log('  ' + dim('-'.repeat(engineW + tierW + 30)));

  for (const r of results) {
    const instStr  = r.installed ? green('yes') : red('no ');
    const authedStr =
      r.authed === true
        ? green('yes   ')
        : r.authed === false
          ? red('no    ')
          : yellow('?     ');
    const readyStr = r.ready ? green('yes') : red('no ');

    console.log(
      '  ' +
        pad(r.engine, engineW) +
        '  ' +
        pad(r.tier, tierW) +
        '  ' +
        instStr +
        '    ' +
        authedStr +
        ' ' +
        readyStr,
    );

    // Detail line (always shown for non-ready; shown dimmed for ready)
    if (!r.ready) {
      console.log('  ' + ' '.repeat(engineW) + '  ' + red('detail: ') + r.detail);
      if (r.fix) {
        console.log('  ' + ' '.repeat(engineW) + '  ' + yellow('fix:    ') + r.fix);
      }
    } else if (r.detail) {
      console.log('  ' + ' '.repeat(engineW) + '  ' + dim(r.detail));
    }
  }

  console.log('');

  // Summary line
  const notReadyEngines = results.filter((r) => !r.ready).map((r) => r.engine);
  if (readyCount === total) {
    console.log('  ' + green(`${readyCount}/${total} engines ready.`) + dim(' All systems go.'));
  } else {
    const needsAction = notReadyEngines.join(', ');
    console.log(
      '  ' +
        yellow(`${readyCount}/${total} engines ready`) +
        dim(` — `) +
        red(needsAction) +
        dim(' need' + (notReadyEngines.length === 1 ? 's' : '') + ' attention.'),
    );
  }
  console.log('');

  // Exit 1 when any engine is definitively not ready (authed:false + installed)
  const hardBlocked = results.some((r) => !r.ready && r.installed && r.authed === false);
  return hardBlocked ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Subcommand: scorecard (M119 — quality metrics)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet scorecard [--window 7d|30d|all] [--by-engine] [--by-repo] [--json]`
 *
 * Prints a productivity + quality scorecard derived from proposals + the
 * decisions ledger. READ-ONLY; never mutates. Never throws.
 */
async function cmdFleetScorecard(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const byEngine = args.includes('--by-engine');
  const byRepo = args.includes('--by-repo');

  // --window <value>
  let window: '7d' | '30d' | 'all' = '7d';
  const wIdx = args.indexOf('--window');
  if (wIdx !== -1 && args[wIdx + 1]) {
    const wVal = args[wIdx + 1];
    if (wVal === '7d' || wVal === '30d' || wVal === 'all') {
      window = wVal;
    } else {
      process.stderr.write(
        red('error: ') + `--window must be 7d, 30d, or all (got ${wVal})\n`,
      );
      return 1;
    }
  }

  let metrics: import('../core/types.js').QualityMetrics;
  try {
    const { computeQualityMetrics } = await import('../core/fleet/quality-metrics.js');
    metrics = computeQualityMetrics(window);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to compute quality metrics: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
    return 0;
  }

  // ── Human-readable scorecard ──────────────────────────────────────────────
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log('');
  console.log(bold('  ashlr fleet scorecard') + dim(` — quality metrics (window: ${window})`));
  console.log('');

  // Productivity
  console.log('  ' + bold('Productivity'));
  console.log(`    proposals created:  ${metrics.proposalsCreated}`);
  console.log(`    merged:             ${metrics.merged}`);
  console.log(`    rejected:           ${metrics.rejected}`);
  console.log(`    pending:            ${metrics.pending}`);
  console.log(`    with diff:          ${metrics.withDiff}`);
  console.log('');

  // Quality rates
  console.log('  ' + bold('Quality'));
  const acceptColor = metrics.acceptRate >= 0.5 ? green : metrics.acceptRate >= 0.25 ? yellow : red;
  console.log(`    accept rate:        ${acceptColor(pct(metrics.acceptRate))}`);
  console.log(`    reject rate:        ${pct(metrics.rejectRate)}`);
  if (metrics.verifyPassRate > 0 || metrics.proposalsCreated > 0) {
    console.log(`    verify pass rate:   ${pct(metrics.verifyPassRate)}`);
  }
  console.log(`    trivial ratio:      ${pct(metrics.trivialRatio)}`);
  console.log(`    empty-diff rate:    ${pct(metrics.emptyRate)}`);
  console.log(`    avg diff lines:     ${metrics.avgDiffLines.toFixed(1)}`);
  console.log('');

  // Per-engine breakdown
  if (byEngine && Object.keys(metrics.byEngine).length > 0) {
    console.log('  ' + bold('By engine'));
    const engineW = Math.max(8, ...Object.keys(metrics.byEngine).map((k) => k.length));
    for (const [eng, eq] of Object.entries(metrics.byEngine)) {
      const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
      console.log(
        `    ${pad(eng, engineW)}  created=${eq.created}  merged=${eq.merged}` +
        `  accept=${pct(eq.acceptRate)}  trivial=${pct(eq.trivialRatio)}`,
      );
    }
    console.log('');
  }

  // Per-repo breakdown
  if (byRepo && Object.keys(metrics.byRepo).length > 0) {
    console.log('  ' + bold('By repo'));
    const sorted = Object.entries(metrics.byRepo).sort(([, a], [, b]) => b - a);
    for (const [repo, count] of sorted) {
      console.log(`    ${count.toString().padStart(4)}  ${dim(repo)}`);
    }
    console.log('');
  }

  // Trend
  if (metrics.trend && metrics.trend.length > 0) {
    console.log('  ' + bold('Weekly trend'));
    for (const t of metrics.trend) {
      console.log(`    ${t.period}  merged=${t.merged}  accept=${pct(t.acceptRate)}`);
    }
    console.log('');
  }

  return 0;
}

export async function cmdFleet(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    printFleetHelp();
    return 0;
  }

  switch (sub) {
    case 'status':
      return cmdFleetStatus(rest.includes('--json'));
    case 'watch':
      return cmdFleetWatch(rest.includes('--json'));
    case 'init':
      return cmdFleetInit(rest);
    case 'pause':
      return setKillSwitch(true);
    case 'resume':
      return setKillSwitch(false);
    case 'doctor':
      return cmdFleetDoctor(rest.includes('--json'));
    case 'scorecard':
      return cmdFleetScorecard(rest);
    default:
      process.stderr.write(red('error: ') + `unknown fleet subcommand: ${sub}\n`);
      printFleetHelp();
      return 2;
  }
}

function printFleetHelp(): void {
  console.log('');
  console.log(bold('  ashlr fleet') + dim(' — fleet control plane + observability (M49)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr fleet status [--json]   ${cyan('# read-only fleet snapshot')}`);
  console.log(`    ashlr fleet watch  [--json]   ${cyan('# glanceable monitoring summary (actions + errors)')}`);
  console.log(`    ashlr fleet init [--write]    ${cyan('# print/merge a starter cfg.foundry')}`);
  console.log(`    ashlr fleet pause             ${cyan('# engage kill switch (pause fleet)')}`);
  console.log(`    ashlr fleet resume            ${cyan('# release kill switch (resume fleet)')}`);
  console.log(`    ashlr fleet doctor [--json]   ${cyan('# engine readiness preflight (M81)')}`);
  console.log(`    ashlr fleet scorecard [--window 7d|30d|all] [--by-engine] [--by-repo] [--json]`);
  console.log(`                          ${cyan('# productivity + quality scorecard (M119)')}`);
  console.log('');
}
