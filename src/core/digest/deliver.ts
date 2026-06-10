/**
 * core/digest/deliver.ts — M29 digest rendering + delivery.
 *
 * renderDigestText(report) produces the human-readable (markdown) body.
 * deliverDigest(report, cfg, opts) ALWAYS writes the local artifact (via the
 * store) and calls notify() ONLY when opts.notify === true (opt-in).
 *
 * HARD SAFETY INVARIANTS (M29) enforced here:
 *  - NO OUTWARD ACTION BY DEFAULT: deliverDigest writes a LOCAL file by default.
 *    The ONLY outward path is notify(), reached ONLY when opts.notify === true.
 *    notify() is itself a strict no-op unless a Slack/Discord webhook is
 *    configured — so the default path makes ZERO outward network calls. The
 *    verifier proves it by asserting notify is NEVER invoked unless notify:true.
 *  - READ-ONLY AGGREGATION: the only write is the digest artifact under
 *    ~/.ashlr/digests/ (delegated to saveDigest). Never mutates a repo, never
 *    writes config, never applies/approves a proposal, never pushes/PRs/deploys.
 *  - BOUNDED + NEVER-THROWS: rendering + delivery are wrapped; a failed write or
 *    a failed notify degrades to a result flagging what happened, never throws.
 */

import { notify } from '../integrations/notify.js';
import { saveDigest } from './store.js';
import type {
  AshlrConfig,
  DigestDeliveryResult,
  DigestReport,
  PortfolioTodayDelta,
} from '../types.js';

// ---------------------------------------------------------------------------
// Render helpers (pure, deterministic — no I/O, no model, no secrets)
// ---------------------------------------------------------------------------

/** Format a USD figure with two decimals, e.g. `$12.34`. */
function usd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(2)}`;
}

/** Format a 0..1 fraction as a whole-percent string, e.g. `73%`. */
function pct(frac: number): string {
  const v = Number.isFinite(frac) ? frac : 0;
  return `${Math.round(v * 100)}%`;
}

/**
 * Render one signed "today" delta line, or null to omit it when the prior is
 * missing (null delta) or the movement is zero (suppress noise). `digits`
 * controls fractional precision; `money` renders the magnitude as USD.
 */
function deltaLine(
  label: string,
  value: number | null,
  opts?: { money?: boolean; digits?: number },
): string | null {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  const digits = opts?.digits ?? 0;
  const sign = value > 0 ? '+' : '-';
  const mag = Math.abs(value);
  const body = opts?.money ? usd(mag) : mag.toFixed(digits);
  return `- ${label}: ${sign}${body}`;
}

/** Render the "today" delta block, or a single line when there is no prior. */
function renderToday(today: PortfolioTodayDelta): string[] {
  if (!today.previousAt) {
    return ['## Today', '', '- No prior digest to compare against yet.'];
  }
  const lines: (string | null)[] = [
    deltaLine('Pending proposals', today.pendingProposalsDelta),
    deltaLine('Dirty repos', today.dirtyReposDelta),
    deltaLine('Window spend', today.spendUsdDelta, { money: true }),
    deltaLine('Avg health score', today.healthScoreDelta, { digits: 1 }),
    deltaLine('In-flight goals', today.goalsInFlightDelta),
  ];
  const movements = lines.filter((l): l is string => l !== null);
  const body =
    movements.length > 0 ? movements : ['- No material change since the prior digest.'];
  return ['## Today', `_since ${today.previousAt}_`, '', ...body];
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render a DigestReport as a deterministic markdown body. Pure function — no
 * I/O, no model, no secrets. Used both for the persisted `<stem>.md` artifact
 * and as the notify() payload when delivery is opted in.
 *
 * Sections: headline; repos roll-up; pending proposals; health summary (avg +
 * worst repos); in-flight goals; top backlog; cost + forecast; effectiveness
 * headline; the "today" day-over-day delta block; optional narrative.
 *
 * METADATA ONLY — every field rendered is a count/score/title/path label that
 * already lives in the (secret-free) DigestReport. Lists are bounded upstream.
 */
export function renderDigestText(report: DigestReport): string {
  const p = report.portfolio;
  const out: string[] = [];

  // Header + headline.
  out.push(`# Ashlr Digest — ${report.date}`);
  out.push('');
  out.push(report.headline || 'Daily portfolio digest.');
  out.push('');

  // Repos roll-up + pending proposals + operator.
  out.push('## Overview');
  out.push('');
  out.push(
    `- Repos: ${report.repos.total} total, ${report.repos.dirty} dirty, ${report.repos.stale} stale`,
  );
  out.push(`- Pending proposals: ${report.pendingProposals}`);
  if (report.daemon) {
    out.push(
      `- Daemon: ${report.daemon.running ? 'running' : 'stopped'} (today spend ${usd(report.daemon.todaySpentUsd)})`,
    );
  }
  out.push('');

  // Health summary.
  out.push('## Health');
  out.push('');
  if (p.health.reposScored > 0) {
    out.push(
      `- ${p.health.reposScored} repos scored — avg ${Math.round(p.health.averageScore)} (${p.health.averageGrade})`,
    );
    if (p.health.worstRepos.length > 0) {
      out.push('- Lowest scoring:');
      for (const r of p.health.worstRepos) {
        out.push(`  - ${r.repo}: ${Math.round(r.score)} (${r.grade})`);
      }
    }
  } else {
    out.push('- No enrolled repos scored.');
  }
  out.push('');

  // In-flight goals.
  out.push('## Goals in flight');
  out.push('');
  if (p.goalsInFlight.length > 0) {
    for (const g of p.goalsInFlight) {
      const next = g.nextActionable ? ` — next: ${g.nextActionable}` : '';
      out.push(
        `- ${g.objective} [${g.status}] ${pct(g.fractionDone)} (${g.proposed}/${g.totalMilestones} proposed)${next}`,
      );
    }
  } else {
    out.push('- No active goals.');
  }
  out.push('');

  // Top backlog.
  out.push('## Backlog (top)');
  out.push('');
  if (p.backlogTop.length > 0) {
    for (const b of p.backlogTop) {
      const repo = b.repo ? ` (${b.repo})` : '';
      out.push(`- [${b.score}] ${b.title}${repo}`);
    }
  } else {
    out.push('- Backlog empty.');
  }
  out.push('');

  // Cost + forecast.
  out.push('## Cost');
  out.push('');
  out.push(`- Spend (${p.cost.window}): ${usd(p.cost.spentUsd)}`);
  out.push(`- Local savings: ${usd(p.cost.localSavingsUsd)}`);
  out.push(`- Projected monthly: ${usd(p.cost.projectedMonthlyUsd)}`);
  out.push('');

  // Effectiveness headline (only when a reflection report exists).
  if (p.effectiveness) {
    out.push('## Effectiveness');
    out.push('');
    const delta =
      p.effectiveness.effectivenessDeltaPct === null
        ? ''
        : ` (${p.effectiveness.effectivenessDeltaPct >= 0 ? '+' : ''}${p.effectiveness.effectivenessDeltaPct.toFixed(1)} pts)`;
    out.push(`- Success rate: ${pct(p.effectiveness.successRate)}${delta}`);
    out.push(`- ${p.effectiveness.headline}`);
    out.push('');
  }

  // Today day-over-day deltas.
  out.push(...renderToday(p.today));
  out.push('');

  // Optional narrative (already produced by a model upstream; metadata-free text).
  if (report.narrative) {
    out.push('## Summary');
    out.push('');
    out.push(report.narrative);
    if (report.narrativeLocal === false) {
      out.push('');
      out.push('_(narrative generated by a cloud model)_');
    }
    out.push('');
  }

  // Trim trailing blank lines for a clean artifact.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Deliver
// ---------------------------------------------------------------------------

/**
 * Deliver a digest. ALWAYS writes the local JSON + markdown artifact (via
 * saveDigest). Calls notify() ONLY when opts.notify === true (opt-in) — that is
 * the SINGLE outward path; everything else stops at local disk.
 *
 * Contract:
 *  - NEVER throws — failures degrade into the returned DigestDeliveryResult.
 *  - Default (no opts.notify) => `notified:false`, ZERO outward network calls.
 *  - notify() is itself a no-op unless a webhook is configured, so even with
 *    opts.notify:true `notified` is false when nothing is configured.
 */
export async function deliverDigest(
  report: DigestReport,
  cfg: AshlrConfig,
  opts?: { notify?: boolean },
): Promise<DigestDeliveryResult> {
  // 1. Render the deterministic markdown body (pure; no I/O, no model, no secrets).
  let markdown = '';
  try {
    markdown = renderDigestText(report);
  } catch {
    // Degrade to an empty body rather than throwing; the artifact still persists.
    markdown = '';
  }

  // 2. ALWAYS write the local artifact. The store writes ONLY under digestsDir()
  //    (~/.ashlr/digests/) via atomic tmp+rename, and is contractually non-throwing.
  let jsonPath: string | null = null;
  let markdownPath: string | null = null;
  try {
    const paths = saveDigest(report, markdown);
    jsonPath = paths.jsonPath;
    markdownPath = paths.markdownPath;
  } catch {
    // Belt-and-suspenders: saveDigest already degrades internally.
    jsonPath = null;
    markdownPath = null;
  }

  // 3. Outward delivery is OPT-IN ONLY. The default path NEVER references notify(),
  //    so it makes ZERO outward network calls. notify() is itself a strict no-op
  //    unless a Slack/Discord webhook is configured, so even with notify:true
  //    `notified` stays false when nothing is configured.
  let notified = false;
  if (opts?.notify === true) {
    try {
      notified = await notify(markdown, cfg);
    } catch {
      // notify() never throws, but degrade defensively to a false outcome.
      notified = false;
    }
  }

  return { jsonPath, markdownPath, notified };
}
