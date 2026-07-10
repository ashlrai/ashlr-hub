/**
 * Deterministic, observe-only retrieval for verified skill cards.
 *
 * This module is observe-only: it mutates no route and has no active/injection
 * mode. Eligibility verifies host-local attestations (which may read the
 * provenance key); ranking itself is deterministic and output is rebuilt from
 * a small metadata allowlist.
 */

import { createHash } from 'node:crypto';
import type { SkillCard } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { verifyAttestedSkillCard } from './skill-attestation.js';

export const SKILL_RETRIEVAL_POLICY_VERSION = 'verified-skills-v1';
export const MAX_SELECTED_SKILLS = 2;

const MAX_ID_CHARS = 240;
const MAX_NAME_CHARS = 120;
const MAX_SUMMARY_CHARS = 320;
const MAX_QUERY_TEXT_CHARS = 640;
const MAX_LIST_ITEMS = 16;
const MAX_LIST_ITEM_CHARS = 80;
const MAX_QUERY_TERMS = 48;
const MAX_TOKEN_CHARS = 32;

const RAW_PAYLOAD_MARKER = /\bRAW_[A-Z0-9_]*(?:PROMPT|DIFF|STDOUT|STDERR|ENV|FILE_CONTENTS?|ARGV|COMMAND_OUTPUT)[A-Z0-9_]*\b/gi;
const RAW_PAYLOAD_LABEL = /\b(?:raw\s+)?(?:prompts?|diffs?|stdout|stderr|env(?:ironment)?|file\s+contents?|argv|command\s+outputs?)\b\s*(?:(?:contained|included|was)\s+|[=:]\s*)[^,;}\]\n]*/gi;
const DIFF_PAYLOAD_START = /(?:\bdiff --git |(?:^|\n)(?:--- [ab]\/|\+\+\+ [ab]\/|@@ ))/m;

const CARD_STATUSES = new Set(['candidate', 'verified', 'deprecated', 'revoked']);
const CARD_SOURCES = new Set(['verified-proposal', 'manual', 'imported']);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'redacted',
]);

const QUERY_FIELD_WEIGHTS = {
  title: 6,
  tags: 5,
  source: 3,
  detail: 2,
  route: 1,
} as const;

const CARD_FIELD_WEIGHTS = {
  taskKinds: 6,
  tags: 5,
  name: 4,
  summary: 2,
  commandKinds: 1,
} as const;

export interface SkillRetrievalQuery {
  /** Work-item-shaped metadata. */
  title?: string;
  detail?: string;
  source?: string;
  tags?: readonly string[];
  /** Final route metadata; retrieval never modifies it. */
  route?: {
    backend?: string | null;
    tier?: string | null;
    model?: string | null;
    reason?: string;
  };
}

export type SkillMatchField = keyof typeof CARD_FIELD_WEIGHTS;

export interface ShadowSkillSummary {
  skillId: string;
  revision: number;
  rank: number;
  score: number;
  name: string;
  summary: string;
  matchedFields: SkillMatchField[];
  status: 'verified';
  source: 'verified-proposal';
}

export interface ShadowSkillSelection {
  mode: 'shadow';
  policyVersion: typeof SKILL_RETRIEVAL_POLICY_VERSION;
  consideredCount: number;
  eligibleCount: number;
  selectedSkillIds: string[];
  selected: ShadowSkillSummary[];
}

interface SafeText {
  value: string;
  tainted: boolean;
  truncated: boolean;
}

interface ParsedCard {
  skillId: string;
  revision: number;
  ts: string;
  name: string;
  summary: string;
  status: string;
  source: string;
  tags: string[];
  taskKinds: string[];
  commandKinds: string[];
  verificationEligible: boolean;
  tainted: boolean;
  fingerprint: string;
}

interface ScoredCard {
  card: ParsedCard;
  score: number;
  matchedFields: SkillMatchField[];
}

function emptySelection(consideredCount = 0): ShadowSkillSelection {
  return {
    mode: 'shadow',
    policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
    consideredCount,
    eligibleCount: 0,
    selectedSkillIds: [],
    selected: [],
  };
}

function replaceControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code <= 31 || code === 127 ? ' ' : character;
  }
  return output;
}

function safeText(value: unknown, maxChars: number): SafeText {
  if (typeof value !== 'string') return { value: '', tainted: false, truncated: false };

  const markerRedacted = value.replace(RAW_PAYLOAD_MARKER, '[REDACTED]');
  const labelRedacted = markerRedacted.replace(RAW_PAYLOAD_LABEL, '[REDACTED]');
  const diffStart = labelRedacted.search(DIFF_PAYLOAD_START);
  const payloadRedacted = diffStart >= 0
    ? `${labelRedacted.slice(0, diffStart)} [REDACTED]`
    : labelRedacted;
  const scrubbed = scrubSecrets(payloadRedacted);
  const normalized = replaceControlCharacters(scrubbed).replace(/\s+/g, ' ').trim();
  const truncated = normalized.length > maxChars;
  return {
    value: truncated ? normalized.slice(0, maxChars) : normalized,
    tainted: payloadRedacted !== value || scrubbed !== payloadRedacted,
    truncated,
  };
}

function safeList(value: unknown, maxItems = MAX_LIST_ITEMS): { values: string[]; tainted: boolean } | null {
  if (value === undefined) return { values: [], tainted: false };
  if (!Array.isArray(value)) return null;

  const values = new Set<string>();
  let tainted = false;
  try {
    for (const entry of value.slice(0, maxItems * 2)) {
      const safe = safeText(entry, MAX_LIST_ITEM_CHARS);
      tainted ||= safe.tainted;
      if (safe.value) values.add(safe.value);
      if (values.size >= maxItems) break;
    }
  } catch {
    return null;
  }
  return { values: [...values].sort(asciiCompare), tainted };
}

function asciiCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataChecksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseCard(value: unknown): ParsedCard | null {
  if (!isObject(value)) return null;
  try {
    if (!verifyAttestedSkillCard(value as unknown as SkillCard)) return null;
    if (value['schemaVersion'] !== 1) return null;
    const revision = value['revision'];
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) return null;

    const rawTs = value['ts'];
    if (typeof rawTs !== 'string' || !Number.isFinite(Date.parse(rawTs))) return null;
    const ts = new Date(rawTs).toISOString();

    const skillId = safeText(value['skillId'], MAX_ID_CHARS);
    const name = safeText(value['name'], MAX_NAME_CHARS);
    const summary = safeText(value['summary'], MAX_SUMMARY_CHARS);
    if (!skillId.value || skillId.tainted || skillId.truncated || !name.value) return null;
    if (typeof value['summary'] !== 'string') return null;

    const status = value['status'];
    const source = value['source'];
    if (
      typeof status !== 'string'
      || !CARD_STATUSES.has(status)
      || typeof source !== 'string'
      || !CARD_SOURCES.has(source)
    ) return null;

    const tags = safeList(value['tags']);
    const taskKinds = safeList(value['taskKinds']);
    const topLevelCommandKinds = safeList(value['commandKinds'], 12);
    if (!tags || !taskKinds || !topLevelCommandKinds) return null;

    const verification = value['verification'];
    const verificationPassed = isObject(verification) && verification['passed'] === true;
    const verificationCommandKinds = isObject(verification)
      ? safeList(verification['commandKinds'], 12)
      : { values: [], tainted: false };
    if (!verificationCommandKinds) return null;

    const proposalId = safeText(value['proposalId'], MAX_ID_CHARS);
    const rawDiffHash = isObject(verification) ? verification['diffHash'] : undefined;
    const evidenceCount = isObject(verification) ? verification['evidenceCount'] : undefined;
    const diffHashValid = typeof rawDiffHash === 'string' && /^[a-f0-9]{64}$/.test(rawDiffHash);
    const evidenceCountValid = Number.isSafeInteger(evidenceCount) && (evidenceCount as number) > 0;
    const proposalIdValid = proposalId.value.length > 0 && !proposalId.tainted && !proposalId.truncated;

    const routeSnapshot = value['routeSnapshot'];
    const routeSnapshotValid = routeSnapshot === undefined || isObject(routeSnapshot);
    const hasSelectedSkillIds = isObject(routeSnapshot)
      && Object.prototype.hasOwnProperty.call(routeSnapshot, 'selectedSkillIds');

    const commandKinds = [...new Set([
      ...topLevelCommandKinds.values,
      ...verificationCommandKinds.values,
    ])].sort(asciiCompare).slice(0, 12);
    const tainted = name.tainted
      || summary.tainted
      || tags.tainted
      || taskKinds.tainted
      || topLevelCommandKinds.tainted
      || verificationCommandKinds.tainted
      || proposalId.tainted;
    const verificationEligible = verificationPassed
      && topLevelCommandKinds.values.length > 0
      && verificationCommandKinds.values.length > 0
      && diffHashValid
      && evidenceCountValid
      && proposalIdValid
      && routeSnapshotValid
      && !hasSelectedSkillIds;

    const parsed = {
      skillId: skillId.value,
      revision: revision as number,
      ts,
      name: name.value,
      summary: summary.value,
      status,
      source,
      tags: tags.values,
      taskKinds: taskKinds.values,
      commandKinds,
      verificationEligible,
      tainted,
    };
    return {
      ...parsed,
      fingerprint: JSON.stringify({
        ...parsed,
        proposalId: proposalId.value,
        evidenceCount: evidenceCountValid ? evidenceCount : null,
        verificationRef: diffHashValid
          ? metadataChecksum(`${proposalId.value}\0${rawDiffHash}`)
          : null,
        hasSelectedSkillIds,
      }),
    };
  } catch {
    return null;
  }
}

function tokenize(value: string): string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.filter((token) => (
    token.length >= 2
    && token.length <= MAX_TOKEN_CHARS
    && !STOP_WORDS.has(token)
  ));
}

function addQueryTerms(
  terms: Map<string, number>,
  rawValue: unknown,
  weight: number,
  maxChars = MAX_QUERY_TEXT_CHARS,
): void {
  if (terms.size >= MAX_QUERY_TERMS) return;
  const value = safeText(rawValue, maxChars).value;
  for (const token of tokenize(value)) {
    terms.set(token, Math.max(weight, terms.get(token) ?? 0));
    if (terms.size >= MAX_QUERY_TERMS) break;
  }
}

function queryTerms(query: SkillRetrievalQuery | null | undefined): Map<string, number> {
  const terms = new Map<string, number>();
  if (!isObject(query)) return terms;
  try {
    addQueryTerms(terms, query.title, QUERY_FIELD_WEIGHTS.title);
    if (Array.isArray(query.tags)) {
      for (const tag of query.tags.slice(0, MAX_LIST_ITEMS)) {
        addQueryTerms(terms, tag, QUERY_FIELD_WEIGHTS.tags, MAX_LIST_ITEM_CHARS);
      }
    }
    addQueryTerms(terms, query.source, QUERY_FIELD_WEIGHTS.source, MAX_LIST_ITEM_CHARS);
    addQueryTerms(terms, query.detail, QUERY_FIELD_WEIGHTS.detail);
    if (isObject(query.route)) {
      addQueryTerms(terms, query.route.backend, QUERY_FIELD_WEIGHTS.route, MAX_LIST_ITEM_CHARS);
      addQueryTerms(terms, query.route.tier, QUERY_FIELD_WEIGHTS.route, MAX_LIST_ITEM_CHARS);
      addQueryTerms(terms, query.route.model, QUERY_FIELD_WEIGHTS.route, MAX_LIST_ITEM_CHARS);
      addQueryTerms(terms, query.route.reason, QUERY_FIELD_WEIGHTS.route);
    }
  } catch {
    return new Map();
  }
  return terms;
}

function termSet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    for (const token of tokenize(value)) out.add(token);
  }
  return out;
}

function scoreCard(card: ParsedCard, terms: ReadonlyMap<string, number>): ScoredCard | null {
  const fields: Array<[SkillMatchField, Set<string>, number]> = [
    ['taskKinds', termSet(card.taskKinds), CARD_FIELD_WEIGHTS.taskKinds],
    ['tags', termSet(card.tags), CARD_FIELD_WEIGHTS.tags],
    ['name', termSet([card.name]), CARD_FIELD_WEIGHTS.name],
    ['summary', termSet([card.summary]), CARD_FIELD_WEIGHTS.summary],
    ['commandKinds', termSet(card.commandKinds), CARD_FIELD_WEIGHTS.commandKinds],
  ];
  const matchedFields = new Set<SkillMatchField>();
  let numerator = 0;
  let denominator = 0;

  for (const [term, queryWeight] of terms) {
    denominator += queryWeight * CARD_FIELD_WEIGHTS.taskKinds;
    let bestCardWeight = 0;
    for (const [field, tokens, cardWeight] of fields) {
      if (!tokens.has(term)) continue;
      matchedFields.add(field);
      bestCardWeight = Math.max(bestCardWeight, cardWeight);
    }
    numerator += queryWeight * bestCardWeight;
  }
  if (numerator === 0 || denominator === 0) return null;

  return {
    card,
    score: Math.round((numerator / denominator) * 1_000_000) / 1_000_000,
    matchedFields: [...matchedFields].sort((left, right) => (
      Object.keys(CARD_FIELD_WEIGHTS).indexOf(left) - Object.keys(CARD_FIELD_WEIGHTS).indexOf(right)
    )),
  };
}

function latestUnambiguousCards(cards: readonly unknown[]): { consideredCount: number; cards: ParsedCard[] } {
  const bySkill = new Map<string, ParsedCard[]>();
  let consideredCount = 0;
  for (const rawCard of cards) {
    const card = parseCard(rawCard);
    if (!card) continue;
    consideredCount += 1;
    const revisions = bySkill.get(card.skillId);
    if (revisions) revisions.push(card);
    else bySkill.set(card.skillId, [card]);
  }

  const latest: ParsedCard[] = [];
  for (const revisions of bySkill.values()) {
    const maxRevision = Math.max(...revisions.map((card) => card.revision));
    const current = revisions.filter((card) => card.revision === maxRevision);
    if (new Set(current.map((card) => card.fingerprint)).size !== 1) continue;
    latest.push(current[0]!);
  }
  return { consideredCount, cards: latest };
}

/**
 * Select up to two relevant cards for shadow telemetry.
 *
 * Conflicting rows for the same latest revision quarantine that skill. A newer
 * revoked/deprecated/candidate or non-proposal revision suppresses older rows,
 * so retrieval never falls back across an explicit lifecycle update.
 */
export function selectVerifiedSkills(
  cards: readonly SkillCard[] | readonly unknown[] | null | undefined,
  query: SkillRetrievalQuery | null | undefined,
): ShadowSkillSelection {
  if (!Array.isArray(cards)) return emptySelection();
  try {
    const terms = queryTerms(query);
    const latest = latestUnambiguousCards(cards);
    if (terms.size === 0) return emptySelection(latest.consideredCount);

    const eligible = latest.cards.filter((card) => (
      card.status === 'verified'
      && card.source === 'verified-proposal'
      && card.verificationEligible
      && !card.tainted
    ));
    const scored = eligible
      .map((card) => scoreCard(card, terms))
      .filter((card): card is ScoredCard => card !== null)
      .sort((left, right) => (
        right.score - left.score
        || asciiCompare(left.card.skillId, right.card.skillId)
        || right.card.revision - left.card.revision
      ))
      .slice(0, MAX_SELECTED_SKILLS);

    const selected = scored.map<ShadowSkillSummary>((entry, index) => ({
      skillId: entry.card.skillId,
      revision: entry.card.revision,
      rank: index + 1,
      score: entry.score,
      name: entry.card.name,
      summary: entry.card.summary,
      matchedFields: entry.matchedFields,
      status: 'verified',
      source: 'verified-proposal',
    }));
    return {
      mode: 'shadow',
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
      consideredCount: latest.consideredCount,
      eligibleCount: eligible.length,
      selectedSkillIds: selected.map((card) => card.skillId),
      selected,
    };
  } catch {
    return emptySelection();
  }
}

/** Explicit alias for callers naming the rollout mode rather than the policy. */
export const selectShadowSkills = selectVerifiedSkills;
