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
import type { ResourceStrategyReport } from '../core/autonomy/resource-strategy.js';
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
      const resource = b.resource ? `  ${formatBackendResource(b.resource)}` : '';
      lines.push(`  ${name}  dispatches(24h)=${b.dispatchesRecent}  quota=${b.quota}${resource}`);
    }
  }
  lines.push('');

  // Queue
  lines.push(`Queue:     ${s.queue.backlogItems} backlog item(s)`);
  if (s.queue.repos) {
    const repoCoverage = s.queue.repos;
    lines.push(
      `  repos:         ${repoCoverage.withBacklog}/${repoCoverage.existing} active ` +
        `(${repoCoverage.enrolled} enrolled, ${repoCoverage.silent} silent)`,
    );
    if (repoCoverage.top.length > 0) {
      const topRepos = repoCoverage.top
        .slice(0, 3)
        .map((row) => `${row.repo.split('/').pop() ?? row.repo}:${row.items}`)
        .join(', ');
      lines.push(`  top repos:     ${topRepos}`);
    }
    if (repoCoverage.byTier.length > 0) {
      const tierSummary = repoCoverage.byTier
        .map((row) => `${row.tier}:${row.repos}r/${row.items}i`)
        .join(', ');
      lines.push(`  focus tiers:   ${tierSummary}`);
    }
    if (repoCoverage.executionProfiles) {
      const profile = repoCoverage.executionProfiles;
      const managers = profile.packageManagers
        .slice(0, 4)
        .map((row) => `${row.manager}:${row.repos}`)
        .join(', ');
      lines.push(
        `  verify roots:   ${profile.reposWithVerifyCommands}/${repoCoverage.existing} repos ` +
          `(${profile.reposMissingVerifyCommands} missing${managers ? `; ${managers}` : ''})`,
      );
    }
  }
  if (Array.isArray(s.queue.next) && s.queue.next.length > 0) {
    for (const item of s.queue.next.slice(0, 5)) {
      lines.push(`  next:          ${item.title} (${item.source}, score ${item.score})`);
    }
  }
  if (s.queue.shared) {
    const shared = s.queue.shared;
    lines.push(`  shared:        ${formatSharedQueueSummary(shared)}`);
    if (shared.claimsByMachine.length > 0) {
      lines.push(`  machines:      ${formatSharedQueueMachines(shared.claimsByMachine)}`);
    }
    lines.push(`  next expiry:   ${shared.nextLeaseExpiryAt ?? '—'}`);
  }
  lines.push('');

  // Proposals
  lines.push('Proposals:');
  lines.push(`  pending:           ${s.proposals.pending}`);
  lines.push(`  frontier pending:  ${s.proposals.frontierPending}`);
  lines.push(`  applied:           ${s.proposals.applied}`);
  lines.push('');

  // Merges
  lines.push(`Merges:    ${s.merges.recent} auto-merge(s) in last 24h`);
  lines.push('');

  // Guard health
  const guardHealth = s.guardHealth;
  lines.push('Guard health:');
  if (!guardHealth || guardHealth.blocks.length === 0) {
    lines.push('  ok');
  } else {
    lines.push(`  blocked: ${guardHealth.blocks.length} block(s)`);
    for (const block of guardHealth.blocks) {
      lines.push(`  - ${block.id}: ${block.detail}`);
      lines.push(`    path: ${block.path}`);
      if (block.repairCommands.length > 0) {
        lines.push(`    repair: ${block.repairCommands.join(' && ')}`);
      }
    }
  }
  lines.push('');

  // Autonomy evidence
  const autonomy = s.autonomy;
  lines.push('Autonomy evidence:');
  if (!autonomy || autonomy.evidencePacks === 0) {
    lines.push('  no evidence packs yet');
  } else {
    const tiers = Object.entries(autonomy.byTier)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tier, count]) => `${tier}:${count}`)
      .join(', ');
    lines.push(`  packs:     ${autonomy.evidencePacks}`);
    lines.push(`  allowed:   ${autonomy.allowed}`);
    lines.push(`  denied:    ${autonomy.denied}`);
    lines.push(`  latest:    ${autonomy.latestAt ?? '—'}`);
    lines.push(`  tiers:     ${tiers || '—'}`);
  }
  lines.push('');

  // Auto-merge readiness
  const readiness = s.autoMergeReadiness;
  lines.push('Auto-merge readiness:');
  if (!readiness) {
    lines.push('  unavailable');
  } else {
    lines.push(`  enabled:   ${readiness.enabled ? 'yes' : 'no'}`);
    lines.push(`  trust:     ${readiness.trustBasis}`);
    lines.push(
      `  pending:   ${readiness.pending} ` +
        `(preflight ${readiness.preflightReady}, verify ${readiness.needsVerification}, blocked ${readiness.blocked})`,
    );
    if (readiness.knownVerificationFailed > 0) {
      lines.push(`  failed:    ${readiness.knownVerificationFailed} known verification failure(s)`);
    }
    const reasons = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([reason, count]) => `${count}x ${reason}`);
    if (reasons.length > 0) {
      lines.push(`  blockers:  ${reasons.join('; ')}`);
    }
  }
  lines.push('');

  // Autonomy direction
  const direction = s.autonomyDirection;
  lines.push('Autonomy direction:');
  lines.push(`  control:    ${s.autonomyControlMode}`);
  if (!direction) {
    lines.push('  unavailable');
  } else {
    lines.push(`  mode:       ${direction.mode}`);
    lines.push(`  confidence: ${direction.confidence}`);
    lines.push(
      `  resources:  ${direction.resources.posture} ` +
        `(${direction.resources.constrained} constrained, ${direction.resources.depleted} depleted)`,
    );
    lines.push(`  guards:     ${direction.guardHealth.blocked ? `${direction.guardHealth.blocks} block(s)` : 'ok'}`);
    lines.push(`  budget:     ${direction.budgets.daemonBudgetLevel}`);
    if (direction.reasons.length > 0) {
      lines.push(`  reason:     ${direction.reasons[0]}`);
    }
    if (direction.recommendedActions.length > 0) {
      lines.push(`  next:       ${direction.recommendedActions[0]}`);
    }
  }

  return lines.join('\n');
}

function formatBackendResource(resource: NonNullable<FleetStatus['backends'][number]['resource']>): string {
  const parts = [`resource=${resource.availability}`];
  if (typeof resource.usedPct === 'number') {
    parts.push(`used=${Math.round(resource.usedPct)}%`);
  }
  if (resource.resetsAt !== null) {
    parts.push(`reset=${new Date(resource.resetsAt * 1000).toISOString()}`);
  }
  return parts.join(' ');
}

export function formatResourceStrategyReport(report: ResourceStrategyReport): string {
  const lines: string[] = [];
  lines.push('Autonomous direction');
  lines.push(`  mode:        ${report.mode}`);
  lines.push(`  confidence:  ${report.confidence}`);
  lines.push('');

  lines.push('Reasons:');
  if (report.reasons.length === 0) {
    lines.push('  (none)');
  } else {
    for (const reason of report.reasons) lines.push(`  - ${reason}`);
  }
  lines.push('');

  lines.push('Recommended actions:');
  if (report.recommendedActions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const action of report.recommendedActions) lines.push(`  - ${action}`);
  }
  lines.push('');

  lines.push('Signals:');
  lines.push(`  guards:      ${report.guardHealth.blocked ? `${report.guardHealth.blocks.length} block(s)` : 'ok'}`);
  lines.push(`  resources:   ${report.resources.posture} (${report.resources.constrained} constrained, ${report.resources.depleted} depleted)`);
  lines.push(`  backlog:     ${report.fleet.backlogItems}`);
  lines.push(`  proposals:   ${report.fleet.pendingProposals} pending (${report.fleet.frontierPending} frontier)`);
  lines.push(`  outcomes:    ${report.outcomes.records} record(s), ${report.outcomes.readyEvidence} ready, ${report.outcomes.verificationFailures} failed verification`);
  lines.push(`  ecosystem:   ${report.ecosystem.posture} (${report.ecosystem.summary.fail} fail, ${report.ecosystem.summary.warn} warn)`);
  lines.push(`  budget:      daemon ${report.budgets.daemonBudgetLevel} $${report.budgets.daemonSpentTodayUsd.toFixed(4)} spent today`);

  if (report.resources.backends.length > 0) {
    lines.push('');
    lines.push('Resource backends:');
    for (const backend of report.resources.backends.slice(0, 8)) {
      const pct = backend.usedPct === null ? '' : ` used=${backend.usedPct}%`;
      lines.push(`  ${backend.backend}: ${backend.availability} quota=${backend.quota}${pct}`);
    }
  }

  return lines.join('\n');
}

function formatSharedQueueSummary(shared: NonNullable<FleetStatus['queue']['shared']>): string {
  const state = shared.readable ? 'ok' : 'unreadable';
  const parts = [
    state,
    `${shared.activeClaims} active`,
    `${shared.ownedClaims} owned`,
    `${shared.reclaimableClaims} reclaimable`,
    `${shared.cooldownItems} cooling`,
  ];
  if (shared.lock.present) {
    parts.push(shared.lock.stale ? 'stale lock' : 'locked');
  }
  return parts.join(' / ');
}

function formatSharedQueueMachines(
  machines: NonNullable<FleetStatus['queue']['shared']>['claimsByMachine'],
): string {
  return machines
    .slice(0, 6)
    .map((m) => `${m.machineId}:${m.active}${m.expired > 0 ? `(+${m.expired} reclaimable)` : ''}`)
    .join(', ');
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

async function cmdFleetDirection(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cfg = await loadCfg();
  if (!cfg) {
    process.stderr.write(red('error: ') + 'failed to load config.\n');
    return 1;
  }

  try {
    const { buildResourceStrategyReport } = await import('../core/autonomy/resource-strategy.js');
    const report = await buildResourceStrategyReport(cfg);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return 0;
    }
    console.log('');
    console.log(bold('  ashlr fleet direction') + dim(' - read-only autonomy recommendation'));
    console.log('');
    for (const line of formatResourceStrategyReport(report).split('\n')) {
      console.log('  ' + line);
    }
    console.log('');
    return 0;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to build autonomous direction report: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }
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
      fs.queue.shared
        ? `shared ${fs.queue.shared.activeClaims}/${fs.queue.shared.reclaimableClaims}`
        : null,
      `pending ${fs.proposals.pending}`,
      fs.autonomy ? `evidence ${fs.autonomy.evidencePacks}` : null,
      `spent today $${fs.daemon.todaySpentUsd.toFixed(2)}`,
      `last tick ${relTime(fs.daemon.lastTickAt)}`,
    ].filter(Boolean).join(' · ');
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
    case 'direction':
      return cmdFleetDirection(rest);
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
    case 'oversight':
      return cmdFleetOversight(rest);
    case 'judge-traces':
      return cmdFleetJudgeTraces(rest);
    case 'judge-health':
      return cmdFleetJudgeHealth(rest);
    case 'optimize-prompt':
      return cmdFleetOptimizePrompt(rest);
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
  console.log(`    ashlr fleet direction [--json] ${cyan('# read-only autonomous direction report')}`);
  console.log(`    ashlr fleet init [--write]    ${cyan('# print/merge a starter cfg.foundry')}`);
  console.log(`    ashlr fleet pause             ${cyan('# engage kill switch (pause fleet)')}`);
  console.log(`    ashlr fleet resume            ${cyan('# release kill switch (resume fleet)')}`);
  console.log(`    ashlr fleet doctor [--json]   ${cyan('# engine readiness preflight (M81)')}`);
  console.log(`    ashlr fleet scorecard [--window 7d|30d|all] [--by-engine] [--by-repo] [--json]`);
  console.log(`                          ${cyan('# productivity + quality scorecard (M119)')}`);
  console.log(`    ashlr fleet oversight [--json]    ${cyan('# CEO scorecard: quality + manager + vision + goals (M122)')}`);
  console.log(`    ashlr fleet judge-traces [--limit N] [--outcome-only] [--json]`);
  console.log(`                          ` + cyan('# list/inspect judge traces + outcome-link rate (M141)'));
  console.log(`    ashlr fleet judge-health [--degradation] [--json]`);
  console.log(`                          ` + cyan('# judge calibration: kappa + dark-current + degradation (M145)'));
  console.log(`    ashlr fleet optimize-prompt --target judge|strategist [--rounds N] [--dry-run]`);
  console.log(`                          ` + cyan('# GEPA offline prompt optimizer — outputs candidate to ~/.ashlr/optimizer/ (M150)'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Subcommand: oversight (M122 — CEO scorecard)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet oversight [--json]`
 *
 * Builds and prints the CEO oversight snapshot: quality scorecard, manager
 * verdict summary, vision progress, and goals. Pushes to pulse if configured.
 * READ-ONLY. Never throws.
 */
async function cmdFleetOversight(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cfg = await loadCfg();

  let snapshot: import('../core/fleet/oversight-export.js').OversightSnapshot;
  try {
    const { buildOversightSnapshot, exportOversight } = await import('../core/fleet/oversight-export.js');
    snapshot = buildOversightSnapshot(cfg ?? {});

    if (!jsonMode) {
      // Push to pulse if configured (best-effort, fire-and-forget)
      void exportOversight(cfg ?? {}).catch(() => { /* swallow */ });
    }
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to build oversight snapshot: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return 0;
  }

  const pct = (n: number) => `${n.toFixed(1)}%`;

  console.log('');
  console.log(bold('  ashlr fleet oversight') + dim(' — CEO scorecard (M122)'));
  console.log('');

  // Scorecard
  const sc = snapshot.scorecard;
  console.log('  ' + bold('Productivity'));
  console.log(`    proposals:    ${sc.proposalsCreated}  merged: ${sc.merged}  pending: ${sc.pending}`);
  console.log('  ' + bold('Quality'));
  const acceptColor = sc.acceptRate >= 0.5 ? green : sc.acceptRate >= 0.25 ? yellow : red;
  console.log(`    accept rate:  ${acceptColor(pct(sc.acceptRate * 100))}  trivial: ${pct(sc.trivialRatio * 100)}  empty-diff: ${pct(sc.emptyRate * 100)}`);
  console.log('');

  // Manager
  if (snapshot.manager) {
    const m = snapshot.manager;
    console.log('  ' + bold('Manager verdict') + dim(` (as of ${m.generatedAt.slice(0, 10)})`));
    console.log(
      `    ship: ${green(String(m.shipped))}  review: ${yellow(String(m.review))}` +
      `  noise: ${String(m.noise)}  harmful: ${m.harmful > 0 ? red(String(m.harmful)) : String(m.harmful)}`,
    );
    if (m.recommendations.length > 0) {
      console.log('    recommendations:');
      for (const r of m.recommendations) {
        console.log('      · ' + dim(r));
      }
    }
    console.log('');
  }

  // Vision
  if (snapshot.vision) {
    const v = snapshot.vision;
    console.log('  ' + bold('Vision'));
    console.log(`    ${cyan(v.northStar)}`);
    console.log(`    ambition: ${v.ambitionLevel}  progress: ${pct(v.progressPct)}`);
    console.log('');
  }

  // Goals
  const g = snapshot.goals;
  console.log('  ' + bold('Goals'));
  console.log(`    active: ${g.active}  done: ${g.done}  progress: ${pct(g.progressPct)}`);
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: judge-traces (M141 — judge trace inspector)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet judge-traces [--limit N] [--proposal <id>] [--outcome-only] [--json]`
 *
 * Lists judge traces from ~/.ashlr/judge-traces/ with outcome-link rate stats.
 * READ-ONLY. Never throws.
 */
async function cmdFleetJudgeTraces(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const outcomeOnly = args.includes('--outcome-only');

  let limit = 20;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1]!, 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }

  let proposalId: string | undefined;
  const pidIdx = args.indexOf('--proposal');
  if (pidIdx !== -1 && args[pidIdx + 1]) {
    proposalId = args[pidIdx + 1];
  }

  let traces: import('../core/fleet/judge-trace.js').JudgeTrace[];
  let stats: Awaited<ReturnType<typeof import('../core/fleet/judge-trace.js').outcomeStats>>;
  try {
    const { readJudgeTraces, outcomeStats } = await import('../core/fleet/judge-trace.js');
    traces = readJudgeTraces({ limit, proposalId, outcomeOnly });
    stats = outcomeStats();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to read judge traces: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ traces, stats }, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr fleet judge-traces') + dim(' — judge CoT trace store (M141)'));
  console.log('');

  // Stats summary
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const linkRate = stats.outcomeRate;
  const linkColor = linkRate >= 0.5 ? green : linkRate >= 0.2 ? yellow : red;
  console.log(`  ${bold('Traces:')} ${stats.total} total  ${bold('Outcome-linked:')} ${stats.withOutcome} (${linkColor(pct(linkRate))})`);

  if (Object.keys(stats.byVerdict).length > 0) {
    const parts = Object.entries(stats.byVerdict)
      .map(([v, s]) => `${v}:${s.total}`)
      .join('  ');
    console.log(`  ${dim('by verdict:')} ${parts}`);
  }
  if (Object.keys(stats.byOutcome).length > 0) {
    const parts = Object.entries(stats.byOutcome)
      .map(([o, n]) => `${o}:${n}`)
      .join('  ');
    console.log(`  ${dim('by outcome:')} ${parts}`);
  }
  console.log('');

  if (traces.length === 0) {
    console.log('  ' + dim('No traces found.'));
    console.log('');
    return 0;
  }

  // Trace table
  const vW = 8;
  console.log(
    '  ' + dim('ts'.padEnd(24)) +
    dim('proposal'.padEnd(26)) +
    dim('verdict'.padEnd(vW)) +
    dim('v/c/s/a'.padEnd(10)) +
    dim('outcome'.padEnd(10)) +
    dim('reasoning'),
  );
  console.log('  ' + dim('-'.repeat(100)));

  for (const t of traces) {
    const ts = t.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    const pid = t.proposalId.length > 24 ? t.proposalId.slice(0, 23) + '…' : t.proposalId.padEnd(24);
    const verdictStr =
      t.verdict === 'ship' ? green(t.verdict.padEnd(vW)) :
      t.verdict === 'noise' ? dim(t.verdict.padEnd(vW)) :
      t.verdict === 'harmful' ? red(t.verdict.padEnd(vW)) :
      yellow(t.verdict.padEnd(vW));
    const scores = `${t.scores.value}/${t.scores.correctness}/${t.scores.scope}/${t.scores.alignment}`.padEnd(10);
    const outcomeStr = t.outcome
      ? (t.outcome === 'merged' ? green(t.outcome) : t.outcome === 'reverted' ? red(t.outcome) : dim(t.outcome)).padEnd(10)
      : dim('—'.padEnd(10));
    const reasoningSnippet = t.fullReasoning
      ? dim(t.fullReasoning.replace(/\n/g, ' ').slice(0, 40) + (t.fullReasoning.length > 40 ? '…' : ''))
      : dim('(none)');

    console.log(
      '  ' + dim(ts.padEnd(24)) +
      pid.padEnd(26) +
      verdictStr +
      scores +
      outcomeStr +
      reasoningSnippet,
    );
  }

  console.log('');
  if (traces.length === limit) {
    console.log('  ' + dim(`(showing ${limit} traces — use --limit N for more)`));
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: judge-health (M145 — judge calibration + self-health)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet judge-health [--degradation] [--json]`
 *
 * Prints a judge calibration health report:
 *   - Cohen's kappa between judge verdict-intent and realized outcome
 *   - Dark-current baseline (verdict distribution + mean scores per engine)
 *   - Optional degradation-harness recovery rate (--degradation)
 *   - Plain-language flag warnings
 *
 * READ-ONLY (the degradation harness re-runs judgeProposal on corrupted diffs
 * but never persists anything). Never throws.
 */
async function cmdFleetJudgeHealth(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const runDegradation = args.includes('--degradation');
  const cfg = await loadCfg();

  let report: import('../core/fleet/judge-calibration.js').JudgeHealthReport;
  try {
    const { judgeHealth } = await import('../core/fleet/judge-calibration.js');
    report = await judgeHealth(cfg ?? ({} as import('../core/types.js').AshlrConfig), {
      runDegradation,
    });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to compute judge health: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  // ── Human render ────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('  ashlr fleet judge-health') + dim(' — judge calibration + self-health (M145)'));
  console.log('');

  console.log(`  ${bold('Sample size:')} ${report.sampleSize} traces`);
  console.log('');

  // Kappa
  if (report.kappaVsOutcome !== null) {
    const kv = report.kappaVsOutcome;
    const kappaColor = kv >= 0.6 ? green : kv >= 0.4 ? yellow : red;
    console.log(`  ${bold('Cohen\'s kappa vs outcome:')} ${kappaColor(kv.toFixed(3))}`);
    console.log(`  ${dim('  (1.0 = perfect agreement, ~0 = chance, < 0 = systematic disagreement)')}`);
  } else {
    console.log(`  ${bold('Cohen\'s kappa:')} ${dim('N/A (insufficient outcome-linked traces)')}`);
  }
  console.log('');

  // Dark current
  if (report.darkCurrent.length > 0) {
    console.log(`  ${bold('Dark current (judge baseline bias):')}`);
    for (const dc of report.darkCurrent) {
      console.log(`    engine: ${cyan(dc.judgeEngine)}  traces: ${dc.traceCount}`);
      const verdictStr = Object.entries(dc.verdictDistribution)
        .map(([v, r]) => `${v}:${(r * 100).toFixed(0)}%`)
        .join('  ');
      console.log(`      verdict dist:  ${verdictStr}`);
      const ms = dc.meanScores;
      console.log(
        `      mean scores:   v=${ms.value.toFixed(2)}  c=${ms.correctness.toFixed(2)}` +
        `  s=${ms.scope.toFixed(2)}  a=${ms.alignment.toFixed(2)}`,
      );
    }
    console.log('');
  }

  // Degradation harness
  if (runDegradation) {
    if (report.degradationRecoveryRate !== null) {
      const rr = report.degradationRecoveryRate;
      const rrColor = rr >= 0.7 ? green : rr >= 0.5 ? yellow : red;
      console.log(`  ${bold('Degradation harness recovery rate:')} ${rrColor((rr * 100).toFixed(0) + '%')}`);
      console.log(`  ${dim('  (% of corrupted-diff trials where judge scored materially lower / escalated verdict)')}`);
    } else {
      console.log(`  ${bold('Degradation harness:')} ${dim('not run or insufficient merged traces')}`);
    }
    console.log('');
  }

  // Flags
  if (report.flags.length > 0) {
    console.log(`  ${bold('Warnings:')}`);
    for (const flag of report.flags) {
      console.log(`    ${yellow('!')} ${flag}`);
    }
    console.log('');
  } else {
    console.log(`  ${green('No warnings — judge calibration looks healthy.')}`);
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: optimize-prompt (M150 — GEPA offline prompt optimizer)
// ---------------------------------------------------------------------------

/**
 * `ashlr fleet optimize-prompt --target judge|strategist [--rounds N] [--dry-run]`
 *
 * Runs the offline GEPA prompt optimizer against held-out judge traces.
 * Prints base→best score + the candidate prompt to STDOUT and writes a
 * review file to ~/.ashlr/optimizer/<ts>-<target>.json.
 *
 * SAFE: never writes to manager.ts or strategist.ts. Human-in-the-loop only.
 * The --dry-run flag skips the LLM reflection calls and scores only the base prompt.
 *
 * Never throws.
 */
async function cmdFleetOptimizePrompt(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  // --target judge|strategist
  let target: 'judge' | 'strategist' = 'judge';
  const tIdx = args.indexOf('--target');
  if (tIdx !== -1 && args[tIdx + 1]) {
    const tVal = args[tIdx + 1];
    if (tVal === 'judge' || tVal === 'strategist') {
      target = tVal;
    } else {
      process.stderr.write(
        red('error: ') + `--target must be judge or strategist (got ${tVal})\n`,
      );
      return 1;
    }
  }

  // --rounds N
  let rounds = 3;
  const rIdx = args.indexOf('--rounds');
  if (rIdx !== -1 && args[rIdx + 1]) {
    const parsed = parseInt(args[rIdx + 1]!, 10);
    if (!isNaN(parsed) && parsed > 0) rounds = parsed;
  }

  console.log('');
  console.log(bold('  ashlr fleet optimize-prompt') + dim(` — GEPA offline prompt optimizer (M150)`));
  console.log('');
  console.log(`  target: ${cyan(target)}  rounds: ${rounds}${dryRun ? '  ' + yellow('[dry-run]') : ''}`);
  console.log('');

  const cfg = await loadCfg();

  // Load held-out traces
  let traces: import('../core/fleet/judge-trace.js').JudgeTrace[] = [];
  try {
    const { readJudgeTraces } = await import('../core/fleet/judge-trace.js');
    traces = readJudgeTraces({ outcomeOnly: false });
  } catch {
    traces = [];
  }

  console.log(`  Loaded ${traces.length} judge trace(s) for evaluation.`);

  // Build metric (kappa vs outcomes)
  const { buildJudgeKappaMetric, optimizePrompt } = await import('../core/fleet/prompt-optimizer.js');
  const metric = buildJudgeKappaMetric(traces);
  const baseScore = (() => { try { return metric(''); } catch { return 0; } })();

  console.log(`  Base score (kappa vs outcomes): ${baseScore.toFixed(4)}`);

  if (dryRun) {
    console.log('');
    console.log(dim('  [dry-run] skipping LLM reflection calls — no LLM spend.'));
    console.log(dim(`  Review file would be written to ~/.ashlr/optimizer/ on a real run.`));
    console.log('');
    return 0;
  }

  // Build LLM client (mirrors judge-health's client resolution)
  let llmClient: { complete: (system: string, user: string) => Promise<string> } | null = null;
  try {
    const { getActiveClient } = await import('../core/run/provider-client.js');
    const raw = await getActiveClient(cfg ?? ({} as import('../core/types.js').AshlrConfig), {
      allowCloud: true,
    }) as { complete?: (system: string, user: string) => Promise<string> };
    if (typeof raw.complete === 'function') {
      llmClient = { complete: raw.complete.bind(raw) };
    }
  } catch {
    llmClient = null;
  }

  if (!llmClient) {
    process.stderr.write(
      red('error: ') + 'no LLM client available — configure a provider (Anthropic API key or Ollama) to run the optimizer.\n',
    );
    return 1;
  }

  // Base prompt: optimizer accepts any text as starting point.
  // In practice, copy the JUDGE_SYSTEM / STRATEGIST_SYSTEM constant here or pass via stdin.
  // For the CLI we use a placeholder that prints instructions when no export exists.
  const basePrompt = `[${target} base prompt — paste the current ${target === 'judge' ? 'JUDGE_SYSTEM' : 'STRATEGIST_SYSTEM'} constant here before running, or use the programmatic API]`;

  console.log(`  Running ${rounds} GEPA round(s) for target: ${target}...`);
  console.log('');

  let result: import('../core/fleet/prompt-optimizer.js').OptimizePromptResult;
  try {
    result = await optimizePrompt(
      { basePrompt, metric, rounds, candidatesPerRound: 3, target },
      cfg ?? {},
      llmClient,
      traces,
    );
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'optimizer failed: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  // Human render
  const improvementColor = result.improvement > 0 ? green : result.improvement < 0 ? red : dim;
  console.log(`  ${bold('Base score:')}  ${result.baseScore.toFixed(4)}`);
  console.log(`  ${bold('Best score:')}  ${result.bestScore.toFixed(4)}  ${improvementColor(`(${result.improvement >= 0 ? '+' : ''}${result.improvement.toFixed(4)} improvement)`)}`);
  console.log('');

  // Lineage summary
  if (result.lineage.length > 0) {
    console.log(`  ${bold('Round summary:')}`);
    for (const entry of result.lineage) {
      const delta = entry.selectedScore - entry.score;
      const deltaStr = delta >= 0 ? green(`+${delta.toFixed(4)}`) : red(delta.toFixed(4));
      console.log(
        `    round ${entry.round}  score ${entry.score.toFixed(4)} → ${entry.selectedScore.toFixed(4)}  ${deltaStr}  candidates: ${entry.candidates.length}`,
      );
    }
    console.log('');
  }

  // Best prompt snippet
  console.log(`  ${bold('Best candidate prompt')} ${dim('(first 400 chars):')}`);
  const snippet = result.bestPrompt.slice(0, 400) + (result.bestPrompt.length > 400 ? '\n  ...' : '');
  for (const line of snippet.split('\n')) {
    console.log('  ' + dim(line));
  }
  console.log('');

  if (result.outputFile) {
    console.log(`  ${green('Review file written:')} ${result.outputFile}`);
    console.log(dim('  To apply: copy "bestPrompt" from the review file into manager.ts / strategist.ts by hand.'));
  } else {
    console.log(yellow('  Warning: could not write review file to ~/.ashlr/optimizer/.'));
  }
  console.log('');

  return 0;
}
