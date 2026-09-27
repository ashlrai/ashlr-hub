/**
 * decide/retro.ts — root-cause CATEGORIES for retros (#535).
 *
 * The retro extractor assigns an exact machine code from structured evidence
 * (`gate:test-tamper`, `verify:typecheck`, `revert:ci-red`, …). Those stay
 * deterministic and untouched. But a large share of failures land on GENERIC
 * codes whose only signal is free text — `fleet:failed` "Run failed" with a
 * close reason, `closed:by-fleet`, `cloud:unknown`, `leader:failed:*`. For those,
 * Jev reads the detail and names a category; for every other code a fixed
 * table maps code → category. Every rooted retro therefore gets one
 * `category` from ONE vocabulary (RETRO_ROOT_CAUSES), so the Lessons chart can
 * aggregate "why things fail" across fleet, cloud and Leader.
 *
 * One batched call per 10 generic retros; never on a gate; never throws.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decideEach } from './decide.js';
import { RETRO_ROOT_CAUSES } from './registry.js';
import type { DecideOptions } from './types.js';

export type RetroCauseCategory = (typeof RETRO_ROOT_CAUSES)[number];

/** Structural subset of learn/retro RetroV1 — keeps this module free of learn imports. */
export interface RetroForLabel {
  readonly id: string;
  readonly asked?: string | null;
  readonly happened?: string | null;
  readonly rootCause: { readonly code: string; readonly label: string; readonly detail: string } | null;
}

export interface RetroCauseLabel {
  readonly category: RetroCauseCategory;
  readonly source: 'jev' | 'rule';
  readonly confidence: number;
}

/** Codes whose deterministic label says nothing about WHY. */
export function isGenericRootCause(code: string): boolean {
  return code === 'fleet:failed'
    || code === 'closed:by-fleet'
    || code === 'closed:unreviewed'
    || code === 'cloud:unknown'
    || code === 'cloud:unparsed'
    || code === 'cloud:blocked'
    || code === 'verify:failed'
    || code === 'gate:unknown'
    || code.startsWith('leader:failed:');
}

/** Pure, offline, never throws: code (and detail) → category. */
export function rootCauseCategoryHeuristic(code: string, detail = ''): RetroCauseCategory {
  const c = code.toLowerCase();
  const d = detail.toLowerCase();
  if (c === 'verify:test' || c === 'revert:suite-failed' || c === 'gate:test-tamper') return 'test-failure';
  if (c === 'verify:typecheck') return 'type-error';
  if (c === 'verify:lint') return 'lint-failure';
  if (c === 'verify:build') return 'build-failure';
  if (c === 'revert:ci-red' || c === 'revert:post-merge-red' || c === 'gate:required-check-failed') return 'test-failure';
  if (c === 'verify:timeout' || c === 'cloud:timeout' || c === 'gate:checks-timeout') return 'timeout';
  if (c === 'cloud:auth' || c === 'cloud:rate-limited' || c === 'cloud:budget' || c === 'cloud:seat-unavailable') return 'auth-or-quota';
  if (c === 'gate:diff-does-not-apply' || c === 'cloud:checkout-failed') return 'stale-base';
  if (/^gate:(risk-|files-over|lines-over|local-author|local-enforcement|protected-path|tree-protected|tree-paths-unexpected)/.test(c)) return 'scope-too-large';
  if (c === 'gate:judge-rejected' || c === 'gate:judge-no-merge-intent' || c === 'closed:by-mason' || c.startsWith('leader:vetoed')) return 'unwanted';
  if (c === 'cloud:no-change') return 'no-change-needed';
  if (c === 'closed:owner-lane-ttl') return 'unwanted';
  if (c.startsWith('leader:refused')) return 'scope-too-large';
  if (/^(gate:(no-verification|provenance|diff-un|tamper-un|verify-unbound|claim-check|no-required|no-checks|no-verify|server-enforcement)|cloud:(not-enabled|no-remote)|verify:(invalid-command|unavailable))/.test(c)) return 'flaky-or-infra';
  // Generic codes: a light read of the detail, else 'other'.
  if (/\b(timed? ?out|deadline)\b/.test(d)) return 'timeout';
  if (/\b(rate.?limit|quota|429|unauthori[sz]ed|forbidden|credential)\b/.test(d)) return 'auth-or-quota';
  if (/\b(conflict|does not apply|stale|rebase)\b/.test(d)) return 'stale-base';
  if (/\b(test|assert|expect)\w*\b.*\b(fail|red)\w*/.test(d)) return 'test-failure';
  if (/\b(tsc|type error|ts\d{4})\b/.test(d)) return 'type-error';
  if (/\b(econn|network|enotfound|flaky|infra)\b/.test(d)) return 'flaky-or-infra';
  return 'other';
}

const CRITERIA: Readonly<Record<RetroCauseCategory, string>> = {
  'test-failure': 'Tests or CI checks failed because the change was wrong or incomplete.',
  'type-error': 'Type checking failed.',
  'lint-failure': 'Lint or formatting checks failed.',
  'build-failure': 'The build or compile step failed.',
  'flaky-or-infra': 'The environment failed, not the change: flaky tests, network, missing tooling, CI infrastructure.',
  timeout: 'The work or its checks ran out of time.',
  'auth-or-quota': 'Credentials, permissions, rate limits, seat availability, or budget stopped it.',
  'stale-base': 'The change no longer applied: merge conflicts, a moved base branch.',
  'scope-too-large': 'The change was too big, too risky, or touched areas it should not.',
  'wrong-approach': 'The agent solved the wrong problem or chose an approach the reviewer rejected on substance.',
  'missing-context': 'The agent lacked information it needed: unclear requirements, unknown conventions, missing access to context.',
  'no-change-needed': 'Nothing needed changing, or the work was already done.',
  unwanted: 'The operator or a reviewer did not want this change at all.',
  other: 'None of the above.',
};

const QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions: 'What is the most likely root cause of this failed engineering task, judged from what happened?',
  criteria: CRITERIA,
};

export type LabelRetroRootCausesOptions = Omit<DecideOptions<RetroCauseCategory>, 'fallback' | 'interpret' | 'escalateOnly'>;

/**
 * Categorize every rooted retro: generic codes via one batched Jev call per 10
 * (with the rule as fallback), all others via the rule. Never throws. Returns
 * a map keyed by retro id; retros without a root cause are absent.
 */
export async function labelRetroRootCauses(
  retros: readonly RetroForLabel[],
  opts: LabelRetroRootCausesOptions = {},
): Promise<Map<string, RetroCauseLabel>> {
  const out = new Map<string, RetroCauseLabel>();
  const generic: RetroForLabel[] = [];
  for (const r of retros) {
    if (!r.rootCause) continue;
    if (isGenericRootCause(r.rootCause.code)) generic.push(r);
    else out.set(r.id, { category: rootCauseCategoryHeuristic(r.rootCause.code, r.rootCause.detail), source: 'rule', confidence: 1 });
  }
  if (generic.length === 0) return out;
  try {
    const decisions = await decideEach<RetroCauseCategory>(
      'retro-root-cause',
      generic.map((r) => ({
        id: r.id,
        text: [
          r.asked ? `Asked: ${r.asked.slice(0, 300)}` : '',
          r.happened ? `Happened: ${r.happened.slice(0, 500)}` : '',
          `Recorded cause: ${r.rootCause!.label} — ${r.rootCause!.detail.slice(0, 500)}`,
        ].filter(Boolean).join('\n'),
        fallback: () => rootCauseCategoryHeuristic(r.rootCause!.code, r.rootCause!.detail),
      })),
      QUESTION,
      { ...opts, preamble: 'Each item below is one engineering task that did not land.' },
    );
    generic.forEach((r, i) => {
      const d = decisions[i];
      if (!d) return;
      out.set(r.id, { category: d.value, source: d.path === 'jev' ? 'jev' : 'rule', confidence: d.confidence });
    });
  } catch {
    for (const r of generic) {
      out.set(r.id, { category: rootCauseCategoryHeuristic(r.rootCause!.code, r.rootCause!.detail), source: 'rule', confidence: 1 });
    }
  }
  return out;
}
