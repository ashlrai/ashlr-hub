/**
 * decide/verdict.ts — typed EXTRACTION of reviewer verdicts from free text.
 *
 * The judges stay exactly as they are (same prompts, same models, same
 * cache). What changes is the parser: when a judge's reply defeats the local
 * parse chain, Jev reads the reply and answers typed questions about what the
 * reviewer SAID — a schema guarantee instead of brace repair, multi-value
 * scans, a paid reprompt round-trip, and a synthetic verdict.
 *
 * Jev is an extractor here, never a judge. Guards, all deterministic:
 *   - A `states_verdict` Noul must say the text actually states a verdict.
 *   - An extracted `ship` requires the literal word "ship" in the reply and
 *     the same completeness rule the manager applies (value >= 3,
 *     correctness >= 4). Jev can never invent a merge-eligible verdict.
 *   - Red-team extraction is escalate-only: it can add a finding, never
 *     remove one.
 * Below threshold (0.9 for judge/taste) every caller keeps its existing path.
 */

import type { TypeSafeAnswer, TypeSafeChoiceQuestion, TypeSafeNoulQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { JUDGE_VERDICTS, RED_TEAM_SEVERITIES, TASTE_VERDICTS } from './registry.js';
import type { DecideOptions, Decision } from './types.js';

export type JudgeVerdictLabel = (typeof JUDGE_VERDICTS)[number];
export type TasteVerdictLabel = (typeof TASTE_VERDICTS)[number];
export type RedTeamSeverityLabel = (typeof RED_TEAM_SEVERITIES)[number];

type ExtractOptions<T> = Omit<DecideOptions<T>, 'fallback' | 'interpret' | 'escalateOnly'>;

/** Judge replies can be long transcripts; the verdict lives at the end. */
const MAX_REPLY_CHARS = 6_000;

function scaleQuestion(dimension: string, meaning: string): TypeSafeChoiceQuestion {
  return {
    type: 'choice',
    instructions: `What 1-5 score does the reviewer give for ${dimension} (${meaning})? Report the reviewer's own score, not your opinion.`,
    criteria: {
      '1': 'The reviewer scores it 1 (very poor).',
      '2': 'The reviewer scores it 2.',
      '3': 'The reviewer scores it 3 (middling).',
      '4': 'The reviewer scores it 4.',
      '5': 'The reviewer scores it 5 (excellent).',
    },
  };
}

const STATES_VERDICT: TypeSafeNoulQuestion = {
  type: 'noul',
  instructions: 'Does this reviewer text explicitly state a final verdict and scores (rather than being cut off, empty, or only partial reasoning)?',
};

function choiceScore(answers: Readonly<Record<string, TypeSafeAnswer>>, name: string): { score: number; confidence: number } | undefined {
  const a = answers[name];
  if (!a || a.type !== 'choice') return undefined;
  const n = Number(a.choice);
  if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
  return { score: n, confidence: a.confidence };
}

function choiceOf<K extends string>(answers: Readonly<Record<string, TypeSafeAnswer>>, name: string, allowed: readonly K[]): { label: K; confidence: number } | undefined {
  const a = answers[name];
  if (!a || a.type !== 'choice' || !(allowed as readonly string[]).includes(a.choice)) return undefined;
  return { label: a.choice as K, confidence: a.confidence };
}

function decisiveYes(answers: Readonly<Record<string, TypeSafeAnswer>>, name: string): number | undefined {
  const a = answers[name];
  if (!a || a.type !== 'noul') return undefined;
  // Only a "yes" counts; its strength is the confidence.
  return a.noul >= 0.5 ? a.noul : undefined;
}

/** Deterministic rationale recovery — never sent anywhere, never invented. */
export function recoverRationale(raw: string): string {
  const line = raw.match(/RATIONALE\s*[:=]\s*(.+)/i)?.[1]
    ?? raw.match(/"rationale"\s*:\s*"((?:[^"\\]|\\.){1,400})"/i)?.[1];
  const cleaned = (line ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned.slice(0, 200);
  return 'verdict extracted from unstructured judge output';
}

function tail(raw: string): string {
  return raw.length > MAX_REPLY_CHARS ? raw.slice(-MAX_REPLY_CHARS) : raw;
}

// ---------------------------------------------------------------------------
// Manager judge
// ---------------------------------------------------------------------------

export interface ExtractedJudgeRubric {
  readonly verdict: JudgeVerdictLabel;
  readonly value: number;
  readonly correctness: number;
  readonly scope: number;
  readonly alignment: number;
  readonly rationale: string;
}

/**
 * Extract the manager judge's rubric from a reply the local parser could not
 * read. `value === null` means "keep your existing path" (the reprompt).
 */
export async function extractJudgeRubric(
  raw: string,
  opts: ExtractOptions<ExtractedJudgeRubric | null> = {},
): Promise<Decision<ExtractedJudgeRubric | null>> {
  const text = typeof raw === 'string' ? tail(raw) : '';
  return decide<ExtractedJudgeRubric | null>('judge-verdict', text, {
    states_verdict: STATES_VERDICT,
    verdict: {
      type: 'choice',
      instructions: 'Which final verdict does this code-review text state for the proposed change? Report the reviewer\'s verdict, not your own.',
      criteria: {
        ship: 'The reviewer says it should ship / be merged.',
        review: 'The reviewer says a human should review it before merging.',
        noise: 'The reviewer says it is low-value noise that should not merge.',
        harmful: 'The reviewer says it is harmful or wrong.',
      },
    },
    value: scaleQuestion('VALUE', 'how much the change is worth'),
    correctness: scaleQuestion('CORRECTNESS', 'how likely it is correct'),
    scope: scaleQuestion('SCOPE', 'how well-scoped it is'),
    alignment: scaleQuestion('ALIGNMENT', 'how well it fits the goal'),
  }, {
    ...opts,
    fallback: null,
    interpret: (answers) => {
      const stated = decisiveYes(answers, 'states_verdict');
      const verdict = choiceOf(answers, 'verdict', JUDGE_VERDICTS);
      const dims = (['value', 'correctness', 'scope', 'alignment'] as const).map((d) => choiceScore(answers, d));
      if (stated === undefined || !verdict || dims.some((d) => d === undefined)) return undefined;
      const [value, correctness, scope, alignment] = dims.map((d) => d!.score) as [number, number, number, number];
      // Deterministic guards on what Jev extracted (see module header).
      if (verdict.label === 'ship' && (!/\bship\b/i.test(text) || value < 3 || correctness < 4)) return undefined;
      const confidence = Math.min(stated, verdict.confidence, ...dims.map((d) => d!.confidence));
      return {
        value: { verdict: verdict.label, value, correctness, scope, alignment, rationale: recoverRationale(text) },
        confidence,
        label: verdict.label,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Taste critic
// ---------------------------------------------------------------------------

export interface ExtractedTasteScore {
  readonly verdict: TasteVerdictLabel;
  readonly alignment: number;
  readonly ambition: number;
  readonly design: number;
}

/**
 * Extract the taste critic's verdict (and axes) from its reply. Used both when
 * the reply is unparseable and when it parsed but carried no valid verdict —
 * replacing "derive the verdict from the numeric score", the silent
 * degradation the integration contract calls out.
 */
export async function extractTasteScore(
  raw: string,
  opts: ExtractOptions<ExtractedTasteScore | null> = {},
): Promise<Decision<ExtractedTasteScore | null>> {
  const text = typeof raw === 'string' ? tail(raw) : '';
  return decide<ExtractedTasteScore | null>('taste-verdict', text, {
    states_verdict: STATES_VERDICT,
    verdict: {
      type: 'choice',
      instructions: 'Which overall taste verdict does this critique give the change? Report the critic\'s verdict.',
      criteria: {
        gold: 'Exemplary: the critic rates it excellent / top quality.',
        solid: 'Good, unremarkable: the critic rates it fine / acceptable.',
        mediocre: 'Weak: the critic rates it poor / below the bar.',
      },
    },
    alignment: scaleQuestion('ALIGNMENT', 'fit with the project vision'),
    ambition: scaleQuestion('AMBITION', 'how ambitious the change is'),
    design: scaleQuestion('DESIGN', 'quality of the design'),
  }, {
    ...opts,
    fallback: null,
    interpret: (answers) => {
      const stated = decisiveYes(answers, 'states_verdict');
      const verdict = choiceOf(answers, 'verdict', TASTE_VERDICTS);
      const dims = (['alignment', 'ambition', 'design'] as const).map((d) => choiceScore(answers, d));
      if (stated === undefined || !verdict || dims.some((d) => d === undefined)) return undefined;
      const [alignment, ambition, design] = dims.map((d) => d!.score) as [number, number, number];
      return {
        value: { verdict: verdict.label, alignment, ambition, design },
        confidence: Math.min(stated, verdict.confidence, ...dims.map((d) => d!.confidence)),
        label: verdict.label,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Red team
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<RedTeamSeverityLabel, number>> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * The most severe finding an unparseable red-team reply reports. Escalate-only
 * against `none`: the only thing this can do is ADD a finding.
 */
export async function extractRedTeamSeverity(
  raw: string,
  opts: ExtractOptions<RedTeamSeverityLabel> = {},
): Promise<Decision<RedTeamSeverityLabel>> {
  const text = typeof raw === 'string' ? tail(raw) : '';
  return decide<RedTeamSeverityLabel>('red-team-verdict', text, {
    severity: {
      type: 'choice',
      instructions:
        'This is a security/correctness red-team review of a code change. What is the MOST severe concrete problem it reports?',
      criteria: {
        high: 'It reports a concrete exploitable vulnerability, data loss, or a change that clearly breaks correctness.',
        medium: 'It reports a real but bounded problem worth fixing.',
        low: 'It reports only minor nits or hardening suggestions.',
        none: 'It reports no problems, or says the change survives.',
      },
    },
  }, {
    ...opts,
    fallback: 'none',
    escalateOnly: (v) => SEVERITY_RANK[v],
  });
}
