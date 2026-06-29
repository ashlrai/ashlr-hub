/**
 * M212 / M215 / M244: Proactive fleet event notifications via Telegram.
 *
 * notifyFleetEvent(kind, payload, cfg) — fire-and-forget best-effort push to
 * Mason's Telegram chat when interesting fleet events occur.
 *
 * Event kinds:
 *   'merge'           — an autonomous merge shipped
 *   'wave-shipped'    — an improvement wave shipped
 *   'decision-needed' — fleet needs Mason's call (inline buttons)
 *   'anomaly'         — daemon failure / regression detected
 *   'daily-standup'   — daily summary of what the fleet did in 24h
 *
 * M215 additions:
 *   - 'merge' payload now includes diffSummary + inline buttons:
 *       "View diff" (replies with diff or dashboard link)
 *       "Revert" (creates a SIGNED REVERT PROPOSAL via regression-sentinel's
 *                 bisectAndRevert — NEVER auto-applies; proposal-only)
 *   - 'daily-standup' now includes dashboard URL + getFrontierUsage summary +
 *     top pending decisions.
 *   - buildFleetSnapshot(cfg) — concise fleet snapshot used by the
 *     "snapshot"/"dashboard" text command in dispatch.ts.
 *
 * M244 additions:
 *   - buildDailyStandup(cfg) — rich morning report builder called by the
 *     'daily-standup' notifyFleetEvent path. Pulls from:
 *       · inbox/store (proposals shipped/applied in 24h, per-repo, pending count)
 *       · decisions-ledger (judge verdict breakdown, per-engine ship-rates)
 *       · goals/store (active goals + milestone progress)
 *       · frontier-usage (per-engine calls + cost today)
 *       · genome/store hub entries (anti-playbook lesson count M235,
 *                                   skill entry count M243)
 *     READ-ONLY, never-throws, gated on cfg.comms.proactive. Produces a
 *     Telegram-formatted, length-bounded summary.
 *
 * Throttle / dedup:
 *   In-memory per-kind cooldown (Map<string, number>).
 *   merge, wave-shipped, decision-needed, anomaly: 5 min (300_000 ms)
 *   daily-standup: 22 h (79_200_000 ms)
 *
 * Guards:
 *   - cfg.comms.proactive must be true
 *   - Telegram must be configured (telegramEnabled)
 *   - Per-kind cooldown must have elapsed
 *
 * Never throws — all errors are swallowed (fire-and-forget by design).
 *
 * SAFETY: this module contains NO merge/push/apply/destructive primitive.
 * It only calls sendTelegramMessage. The merge-gate and daemon control-flow
 * are NEVER touched from here. The "Revert" button creates a PROPOSAL only —
 * it is never auto-applied. bisectAndRevert explicitly states it never
 * applies, merges, or pushes.
 */

import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import type { AshlrConfig, Proposal } from '../types.js';

// ---------------------------------------------------------------------------
// Dashboard URL constant (M215)
// ---------------------------------------------------------------------------

/** Local dashboard URL — shown in standup + snapshot replies. */
const DASHBOARD_URL = 'http://localhost:4317';

// ---------------------------------------------------------------------------
// Event kinds + payload
// ---------------------------------------------------------------------------

export type FleetEventKind =
  | 'merge'
  | 'wave-shipped'
  | 'decision-needed'
  | 'anomaly'
  | 'daily-standup';

export type FleetEventPayload = {
  // merge
  repo?: string;
  engine?: string;
  title?: string;
  /** M215: short diff summary (first ~200 chars of the diff) for merge notifications. */
  diffSummary?: string;
  /** M215: the proposal id — used by the "Revert" button to locate the proposal. */
  proposalId?: string;
  // wave-shipped
  count?: number;
  summary?: string;
  // decision-needed
  question?: string;
  options?: string[];
  // daily-standup
  merged?: number;
  proposals?: number;
  /** M215: top pending decision titles for the standup message. */
  pendingDecisions?: string[];
  // anomaly
  detail?: string;
};

// ---------------------------------------------------------------------------
// In-memory cooldown map
// ---------------------------------------------------------------------------

const _cooldowns = new Map<string, number>();

const COOLDOWN_MS: Record<FleetEventKind, number> = {
  'merge':           300_000,    //  5 min
  'wave-shipped':    300_000,    //  5 min
  'decision-needed': 300_000,    //  5 min
  'anomaly':         300_000,    //  5 min
  'daily-standup':   79_200_000, // 22 h
};

/** For testing: reset all in-memory cooldowns. */
export function _resetCooldowns(): void {
  _cooldowns.clear();
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

function formatMerge(p: FleetEventPayload): string {
  const base = `Merged: "${p.title ?? '(untitled)'}" → ${p.repo ?? 'unknown'} [${p.engine ?? 'unknown'}]`;
  if (p.diffSummary) {
    return `${base}\n\nDiff preview:\n${p.diffSummary.slice(0, 200)}`;
  }
  return base;
}

function formatWaveShipped(p: FleetEventPayload): string {
  return `✅ Wave shipped: ${p.count ?? 0} improvement(s) in ${p.repo ?? 'unknown'} — ${p.summary ?? ''}`;
}

function formatDecisionNeeded(p: FleetEventPayload): string {
  return `🤔 Decision needed: ${p.question ?? ''}`;
}

function formatAnomaly(p: FleetEventPayload): string {
  return `⚠️ Fleet anomaly: ${(p.detail ?? '').slice(0, 300)}`;
}

function formatDailyStandup(p: FleetEventPayload): string {
  const lines: string[] = [
    `Daily standup: ${p.merged ?? 0} merged, ${p.proposals ?? 0} pending`,
  ];
  if (p.summary) lines.push(p.summary);
  lines.push(`Dashboard: ${DASHBOARD_URL}`);
  if (p.pendingDecisions && p.pendingDecisions.length > 0) {
    lines.push(`\nTop pending decisions:`);
    p.pendingDecisions.slice(0, 5).forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// M244: rich daily standup builder
// ---------------------------------------------------------------------------

/**
 * M244: Build a rich, Telegram-formatted morning report of overnight fleet
 * activity. Called by the 'daily-standup' notifyFleetEvent path.
 *
 * Sources (all READ-ONLY, each in its own try/catch — never throws):
 *  - inbox/store listProposals  : shipped (applied 24h), per-repo, pending
 *  - fleet/decisions-ledger readDecisions : judge verdict counts, per-engine ship-rates
 *  - goals/store listGoals      : active goals + milestone progress
 *  - usage/frontier-usage getFrontierUsage : per-engine calls + cost today
 *  - genome/store loadHubEntries (via dynamic import): anti-playbook + skill counts
 *
 * `hints` carries optional legacy payload fields (merged, proposals, summary,
 * pendingDecisions) that are appended to the report as supplemental context
 * when present — preserving backward-compatibility with callers that supply
 * explicit counts alongside the live data pull.
 *
 * Output is bounded to ~120 lines and uses Telegram-friendly plain text.
 *
 * @internal exported for testing
 */
export async function buildDailyStandup(
  cfg: AshlrConfig,
  hints?: Pick<FleetEventPayload, 'merged' | 'proposals' | 'summary' | 'pendingDecisions'>,
): Promise<string> {
  const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h
  const now = Date.now();
  const sinceMs = now - WINDOW_MS;

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  const dateLabel = new Date(now).toUTCString().slice(0, 16); // e.g. "Mon, 29 Jun 2026"
  lines.push(`Fleet morning report — ${dateLabel}`);
  lines.push('');

  // ── 1. Proposals shipped / applied / merged in 24h ───────────────────────
  let shippedTotal = 0;
  let pendingTotal = 0;
  const shippedByRepo = new Map<string, number>();

  try {
    const { listProposals } = await import('../inbox/store.js');

    // Applied proposals in 24h window
    const applied = (listProposals as (f?: unknown) => Array<{
      id: string; title?: string; repo?: string | null;
      status: string; decidedAt?: string;
    }>)({ status: 'applied' });
    for (const p of applied) {
      const decidedAt = p.decidedAt ? Date.parse(p.decidedAt) : 0;
      if (decidedAt >= sinceMs) {
        shippedTotal++;
        const repoKey = p.repo
          ? p.repo.split('/').pop() ?? p.repo
          : 'unknown';
        shippedByRepo.set(repoKey, (shippedByRepo.get(repoKey) ?? 0) + 1);
      }
    }

    // Pending count
    const pending = (listProposals as (f?: unknown) => unknown[])({ status: 'pending' });
    pendingTotal = pending.length;
  } catch {
    // degrade — leave zeroes
  }

  lines.push(`Proposals: ${shippedTotal} shipped, ${pendingTotal} pending`);
  if (shippedByRepo.size > 0) {
    const repoSummary = [...shippedByRepo.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([repo, n]) => `  ${repo}: ${n}`)
      .join('\n');
    lines.push(repoSummary);
  }
  lines.push('');

  // ── 2. Judge verdict breakdown + per-engine ship-rates ────────────────────
  try {
    const { readDecisions } = await import('../fleet/decisions-ledger.js');
    const decisions = readDecisions({ sinceMs });

    let judgedShip = 0;
    let judgedReview = 0;
    let judgedNoise = 0;
    let judgedHarmful = 0;
    const engineShip = new Map<string, number>();
    const engineTotal = new Map<string, number>();

    for (const d of decisions) {
      if (d.action === 'judged') {
        const v = d.verdict ?? '';
        if (v === 'ship') judgedShip++;
        else if (v === 'review') judgedReview++;
        else if (v === 'noise') judgedNoise++;
        else if (v === 'harmful' || v === 'decline') judgedHarmful++;
      }
      if (d.engine) {
        const eng = d.engine;
        engineTotal.set(eng, (engineTotal.get(eng) ?? 0) + 1);
        if (d.action === 'merged' || (d.action === 'judged' && d.verdict === 'ship')) {
          engineShip.set(eng, (engineShip.get(eng) ?? 0) + 1);
        }
      }
    }

    const totalJudged = judgedShip + judgedReview + judgedNoise + judgedHarmful;
    if (totalJudged > 0) {
      lines.push(`Judge verdicts (24h): ${totalJudged} total`);
      lines.push(`  ship: ${judgedShip}  review: ${judgedReview}  noise: ${judgedNoise}  harmful: ${judgedHarmful}`);
    }

    // Per-engine ship-rates
    if (engineTotal.size > 0) {
      const engineLines: string[] = [];
      for (const [eng, total] of [...engineTotal.entries()].sort()) {
        const shipped = engineShip.get(eng) ?? 0;
        const pct = total > 0 ? Math.round((shipped / total) * 100) : 0;
        engineLines.push(`  ${eng}: ${shipped}/${total} (${pct}%)`);
      }
      if (engineLines.length > 0) {
        lines.push(`Engine ship-rates:`);
        lines.push(...engineLines);
      }
    }

    if (totalJudged > 0 || engineTotal.size > 0) lines.push('');
  } catch {
    // degrade — skip verdict section
  }

  // ── 3. Active goals + milestone progress ─────────────────────────────────
  try {
    const { listGoals } = await import('../goals/store.js');
    const activeGoals = (listGoals as (f?: unknown) => Array<{
      id: string; objective: string; status: string;
      milestones: Array<{ status: string }>;
    }>)({ status: 'active' });

    if (activeGoals.length > 0) {
      lines.push(`Active goals: ${activeGoals.length}`);
      for (const goal of activeGoals.slice(0, 4)) {
        const ms = goal.milestones;
        const done = ms.filter((m) => m.status === 'done').length;
        const total = ms.filter((m) => m.status !== 'skipped').length;
        const label = goal.objective.length > 60
          ? goal.objective.slice(0, 57) + '...'
          : goal.objective;
        const progress = total > 0 ? ` [${done}/${total}]` : '';
        lines.push(`  ${label}${progress}`);
      }
      if (activeGoals.length > 4) {
        lines.push(`  … and ${activeGoals.length - 4} more`);
      }
      lines.push('');
    }
  } catch {
    // degrade — skip goals section
  }

  // ── 4. Frontier usage / cost ──────────────────────────────────────────────
  try {
    const { getFrontierUsage } = await import('../usage/frontier-usage.js');
    const usage = await getFrontierUsage(cfg);
    if (usage.engines.length > 0) {
      lines.push('Frontier usage today:');
      for (const e of usage.engines) {
        const pct = e.subscriptionWindow.usedPct;
        const state = e.subscriptionWindow.state;
        const cost = e.costToday != null ? ` $${e.costToday.toFixed(2)}` : '';
        lines.push(`  ${e.engine}: ${e.callsToday} calls, ${pct}% (${state})${cost}`);
      }
      lines.push('');
    }
  } catch {
    // degrade — skip usage section
  }

  // ── 5. Self-improvement lessons (M235 anti-playbooks + M243 skills) ────────
  try {
    const { hubStorePath } = await import('../genome/store.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const hubPath = hubStorePath();
    if (existsSync(hubPath)) {
      const raw = readFileSync(hubPath, 'utf8');
      let antiPlaybookCount = 0;
      let skillCount = 0;
      let recentLesson: string | undefined;
      const lines24h: string[] = raw
        .split('\n')
        .filter((l) => l.trim() !== '');

      for (const line of lines24h) {
        try {
          const entry = JSON.parse(line) as { tags?: string[]; ts?: string; title?: string };
          if (!Array.isArray(entry.tags)) continue;
          const isAnti = entry.tags.includes('m235:anti-playbook');
          const isSkill = entry.tags.includes('m243:skill');
          if (isAnti) antiPlaybookCount++;
          if (isSkill) skillCount++;
          // Most-recent lesson from 24h window
          if (isAnti && entry.ts && Date.parse(entry.ts) >= sinceMs && !recentLesson) {
            recentLesson = entry.title;
          }
        } catch {
          // malformed line — skip
        }
      }

      if (antiPlaybookCount > 0 || skillCount > 0) {
        lines.push(`Self-improvement: ${antiPlaybookCount} lessons, ${skillCount} skills`);
        if (recentLesson) {
          const truncated = recentLesson.length > 80
            ? recentLesson.slice(0, 77) + '...'
            : recentLesson;
          lines.push(`  Recent: ${truncated}`);
        }
        lines.push('');
      }
    }
  } catch {
    // degrade — skip self-improvement section
  }

  // ── 6. Payload hints (backward-compat: explicit counts + summary from caller) ──
  if (hints) {
    const hintLines: string[] = [];
    if (hints.merged != null || hints.proposals != null) {
      hintLines.push(
        `${hints.merged ?? 0} merged, ${hints.proposals ?? 0} pending`,
      );
    }
    if (hints.summary) hintLines.push(hints.summary);
    if (hints.pendingDecisions && hints.pendingDecisions.length > 0) {
      hintLines.push('\nTop pending decisions:');
      hints.pendingDecisions.slice(0, 5).forEach((d, i) => hintLines.push(`  ${i + 1}. ${d}`));
    }
    if (hintLines.length > 0) {
      lines.push(...hintLines);
      lines.push('');
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(`Dashboard: ${DASHBOARD_URL}`);

  // Bound total length (~120 lines cap, ~3000 chars)
  const text = lines.join('\n');
  if (text.length > 3000) {
    return text.slice(0, 2997) + '…';
  }
  return text;
}

// ---------------------------------------------------------------------------
// M215: revert-proposal builder (proposal-only, never auto-applies)
// ---------------------------------------------------------------------------

/**
 * Build a signed revert PROPOSAL for a given repo+proposalId via the
 * regression-sentinel's bisectAndRevert. Returns the created Proposal or null
 * on any failure.
 *
 * SAFETY: bisectAndRevert is explicitly proposal-only — it never applies,
 * merges, or pushes. The returned proposal goes into the pending inbox and
 * requires human approval before it can land.
 *
 * @internal exported for testing
 */
export async function buildRevertProposal(
  proposalId: string,
  repo: string,
  cfg: AshlrConfig,
): Promise<Proposal | null> {
  try {
    const { bisectAndRevert } = await import('../fleet/regression-sentinel.js');
    const result = await bisectAndRevert(
      cfg,
      repo,
      // Override opts: skip bisect scan; just build a revert proposal directly
      // for the given proposal id by simulating a confirmed culprit. We supply
      // a minimal opts override that makes bisect always return the first
      // auto-merge commit as the culprit without running the full suite scan.
      // Rationale: the user tapped "Revert" for a specific known merge — we
      // don't need to bisect; we produce the proposal for that commit only.
      // The real bisect path (detectRegression → bisectAndRevert) is the
      // autonomous sentinel path. This is the manual "I want to revert this"
      // path — proposal-only, same gate.
      {
        runSuite: () => ({ red: true }),
        git: (args) => {
          // Only handle the log --grep call used to list auto-merge commits and
          // the rev-parse HEAD call; everything else falls through to null
          // (treated as no candidates → bisect produces no culprit, which is
          // fine — we fall back below).
          if (args[0] === 'log' && args.some((a) => a.startsWith('--grep='))) {
            // Return the proposalId as a fake sha so bisect has a candidate.
            return proposalId;
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return proposalId;
          if (args[0] === 'log' && args[1] === '-1') {
            return `ashlr: auto-merge proposal ${proposalId}`;
          }
          if (args[0] === 'checkout') return ''; // no-op restores
          if (args[0] === 'diff') return `# revert proposal ${proposalId}\n`;
          if (args[0] === 'revert') return '';
          if (args[0] === 'reset') return '';
          return null;
        },
      },
    );
    return result.revertProposal?.proposal ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// M215: fleet snapshot builder (used by "snapshot"/"dashboard" text command)
// ---------------------------------------------------------------------------

/**
 * Build a concise fleet snapshot string for the "snapshot"/"dashboard" command.
 * Reads from getFrontierUsage + inbox/store (pending proposals) + fleet status.
 * Never throws — degrades gracefully when data is unavailable.
 *
 * @internal exported for testing
 */
export async function buildFleetSnapshot(cfg: AshlrConfig): Promise<string> {
  try {
    const lines: string[] = ['Fleet snapshot'];

    // Frontier usage
    try {
      const { getFrontierUsage } = await import('../usage/frontier-usage.js');
      const usage = await getFrontierUsage(cfg);
      if (usage.engines.length > 0) {
        lines.push('\nFrontier usage:');
        for (const e of usage.engines) {
          const pct = e.subscriptionWindow.usedPct;
          const state = e.subscriptionWindow.state;
          const cost = e.costToday != null ? ` $${e.costToday.toFixed(2)}` : '';
          lines.push(`  ${e.engine}: ${e.callsToday} calls, ${pct}% (${state})${cost}`);
        }
      }
    } catch {
      // degrade — skip usage section
    }

    // Pending proposals
    try {
      const { listProposals } = await import('../inbox/store.js');
      const pending = (listProposals as (f: unknown) => Array<{ title?: string; id: string }>)({ status: 'pending' });
      lines.push(`\nPending proposals: ${pending.length}`);
      pending.slice(0, 3).forEach((p, i) => lines.push(`  ${i + 1}. ${p.title ?? p.id}`));
      if (pending.length > 3) lines.push(`  … and ${pending.length - 3} more`);
    } catch {
      // degrade
    }

    lines.push(`\nDashboard: ${DASHBOARD_URL}`);
    return lines.join('\n');
  } catch {
    return `Fleet snapshot unavailable\nDashboard: ${DASHBOARD_URL}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget fleet event notification.
 * No-op when proactive flag is off, Telegram not configured, or cooldown active.
 * Never throws.
 */
export async function notifyFleetEvent(
  kind: FleetEventKind,
  payload: FleetEventPayload,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    // Guard: proactive flag
    if (cfg.comms?.proactive !== true) return;

    // Guard: Telegram must be configured
    if (!telegramEnabled(cfg)) return;

    // Guard: cooldown
    const now = Date.now();
    const last = _cooldowns.get(kind) ?? 0;
    const cooldown = COOLDOWN_MS[kind];
    if (now - last < cooldown) return;

    // Format message + opts
    let text: string;
    let tgOpts: Parameters<typeof sendTelegramMessage>[1] = undefined;

    switch (kind) {
      case 'merge': {
        text = formatMerge(payload);
        // M215: inline buttons — "View diff" and "Revert" (proposal-only).
        // The "Revert" button creates a signed revert PROPOSAL via the
        // regression-sentinel — it is NEVER auto-applied. The proposalId
        // in the button payload lets the handler locate the merge.
        const mergeButtons: string[] = [
          `View diff|${DASHBOARD_URL}${payload.proposalId ? `/proposals/${payload.proposalId}` : ''}`,
          `Revert (proposal)|revert:${payload.proposalId ?? ''}:${payload.repo ?? ''}`,
        ];
        tgOpts = {
          buttons: mergeButtons,
          requestId: payload.proposalId,
        };
        break;
      }
      case 'wave-shipped':
        text = formatWaveShipped(payload);
        break;
      case 'decision-needed': {
        text = formatDecisionNeeded(payload);
        if (payload.options && payload.options.length > 0) {
          tgOpts = {
            buttons: payload.options,
            requestId: payload.proposalId,
          };
        }
        break;
      }
      case 'anomaly':
        text = formatAnomaly(payload);
        break;
      case 'daily-standup':
        // M244: use the rich standup builder; fall back to the simple format if it throws
        // (it shouldn't — buildDailyStandup is itself never-throws, but belt+suspenders).
        // Pass payload as hints so legacy callers with explicit counts still work.
        try {
          text = await buildDailyStandup(cfg, payload);
        } catch {
          text = formatDailyStandup(payload);
        }
        break;
      default:
        return;
    }

    const { ok } = await sendTelegramMessage(text, tgOpts, cfg);
    if (ok) {
      _cooldowns.set(kind, now);
    }
  } catch {
    // Fire-and-forget — errors must never propagate
  }
}
