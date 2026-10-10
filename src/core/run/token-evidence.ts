/** Fixed metadata-only provenance; never a budget, billing or contact permission. */
import type { RunStep, RunTokenEvidence, RunTokenBasis, RunUsage } from '../types.js';

const BASES = ['reported', 'estimated', 'reserved', 'unknown'] as const;
const REQUESTS = [...BASES, 'noContact'] as const;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function data(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return;
      out[key] = descriptor.value;
    }
    return out;
  } catch { return undefined; }
}

/** Accessors and inherited fields are not provider evidence. */
export function reportedTokenPair(value: unknown): { tokensIn: number; tokensOut: number } | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const input = Object.getOwnPropertyDescriptor(value, 'tokensIn');
    const output = Object.getOwnPropertyDescriptor(value, 'tokensOut');
    if (!input || !output || !Object.hasOwn(input, 'value') || !Object.hasOwn(output, 'value') || !count(input.value) || !count(output.value)) return;
    return { tokensIn: input.value, tokensOut: output.value };
  } catch { return undefined; }
}

export function neutralTokenEvidence(): RunTokenEvidence {
  return { schemaVersion: 1, scope: 'recorded-model-requests',
    input: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
    output: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
    requests: { reported: 0, estimated: 0, reserved: 0, unknown: 0, noContact: 0 }, unclassified: false };
}

/** A single known logical boundary. A zero no-contact observation is not generation. */
export function requestTokenEvidence(basis: RunTokenBasis, tokensIn: number, tokensOut: number): RunTokenEvidence | undefined {
  if (![...BASES, 'no-contact'].includes(basis) || !count(tokensIn) || !count(tokensOut) || !Number.isSafeInteger(tokensIn + tokensOut)) return;
  const out = neutralTokenEvidence();
  if (basis === 'no-contact') {
    if (tokensIn !== 0 || tokensOut !== 0) return;
    out.requests.noContact = 1;
  } else {
    out.input[basis] = tokensIn; out.output[basis] = tokensOut; out.requests[basis] = 1;
  }
  return out;
}

/** Original unclassified totals remain visible without guessing logical request counts. */
function unknownEvidence(tokensIn: number, tokensOut: number): RunTokenEvidence | undefined {
  if (!count(tokensIn) || !count(tokensOut) || !Number.isSafeInteger(tokensIn + tokensOut)) return;
  const out = neutralTokenEvidence(); out.input.unknown = tokensIn; out.output.unknown = tokensOut; out.unclassified = true;
  return out;
}

/** Strict cold-reader and writer gate, including equality to accounted totals. */
export function validateTokenEvidence(value: unknown, tokensIn: unknown, tokensOut: unknown): RunTokenEvidence | undefined {
  if (!count(tokensIn) || !count(tokensOut) || !Number.isSafeInteger(tokensIn + tokensOut)) return;
  const row = data(value, ['schemaVersion', 'scope', 'input', 'output', 'requests', 'unclassified']);
  if (!row || row['schemaVersion'] !== 1 || row['scope'] !== 'recorded-model-requests' || typeof row['unclassified'] !== 'boolean') return;
  const input = data(row['input'], BASES); const output = data(row['output'], BASES); const requests = data(row['requests'], REQUESTS);
  if (!input || !output || !requests || [...Object.values(input), ...Object.values(output), ...Object.values(requests)].some(value => !count(value))) return;
  const sum = (values: Record<string, unknown>) => Object.values(values).reduce<number>((n, value) => n + (value as number), 0);
  if (sum(input) !== tokensIn || sum(output) !== tokensOut || !Number.isSafeInteger(sum(requests))) return;
  for (const basis of BASES) if ((input[basis] as number) + (output[basis] as number) > 0 && requests[basis] === 0 && !(basis === 'unknown' && row['unclassified'])) return;
  return { schemaVersion: 1, scope: 'recorded-model-requests', input, output, requests, unclassified: row['unclassified'] } as RunTokenEvidence;
}

/** V2 ledger envelopes are an explicit downgrade hold, never a token permission. */
export function tokenEnvelopeCurrent(event: Record<string, unknown>, cold: boolean): boolean {
  const summaryDescriptor = Object.getOwnPropertyDescriptor(event, 'runEventSummary');
  if (!summaryDescriptor) return event['schemaVersion'] !== 2;
  if (!Object.hasOwn(summaryDescriptor, 'value')) return false;
  const summary = summaryDescriptor.value;
  const descriptor = summary && typeof summary === 'object'
    ? Object.getOwnPropertyDescriptor(summary, 'tokenEvidence') : undefined;
  if (!descriptor) return event['schemaVersion'] !== 2;
  if (!Object.hasOwn(descriptor, 'value')) return false;
  const pair = reportedTokenPair(summary);
  return !!pair && validateTokenEvidence(descriptor.value, pair.tokensIn, pair.tokensOut) !== undefined &&
    (!cold || event['schemaVersion'] === 2);
}

export function mergeTokenEvidence(a: Pick<RunUsage, 'tokensIn' | 'tokensOut' | 'tokenEvidence'>,
  b: Pick<RunUsage, 'tokensIn' | 'tokensOut' | 'tokenEvidence'>): RunTokenEvidence | undefined {
  const left = validateTokenEvidence(a.tokenEvidence, a.tokensIn, a.tokensOut) ?? unknownEvidence(a.tokensIn, a.tokensOut);
  const right = validateTokenEvidence(b.tokenEvidence, b.tokensIn, b.tokensOut) ?? unknownEvidence(b.tokensIn, b.tokensOut);
  if (!left || !right) return;
  const out = neutralTokenEvidence();
  for (const basis of BASES) { out.input[basis] = left.input[basis] + right.input[basis]; out.output[basis] = left.output[basis] + right.output[basis]; }
  for (const basis of REQUESTS) out.requests[basis] = left.requests[basis] + right.requests[basis];
  out.unclassified = left.unclassified || right.unclassified;
  return validateTokenEvidence(out, a.tokensIn + b.tokensIn, a.tokensOut + b.tokensOut);
}

/** Owned producer reconciliation, never called while reading or migrating old runs. */
export function tokenEvidenceFromSteps(usage: RunUsage, steps: readonly RunStep[]): RunTokenEvidence | undefined {
  let total: Pick<RunUsage, 'tokensIn' | 'tokensOut' | 'tokenEvidence'> = { tokensIn: 0, tokensOut: 0, tokenEvidence: neutralTokenEvidence() };
  for (const step of steps) if (step.kind !== 'tool' && step.usage) {
    const tokenEvidence = mergeTokenEvidence(total, step.usage);
    total = { tokensIn: total.tokensIn + step.usage.tokensIn, tokensOut: total.tokensOut + step.usage.tokensOut, ...(tokenEvidence ? { tokenEvidence } : {}) };
  }
  if (total.tokensIn > usage.tokensIn || total.tokensOut > usage.tokensOut) return;
  if (total.tokensIn === usage.tokensIn && total.tokensOut === usage.tokensOut) return validateTokenEvidence(total.tokenEvidence, usage.tokensIn, usage.tokensOut);
  return mergeTokenEvidence(total, { tokensIn: usage.tokensIn - total.tokensIn, tokensOut: usage.tokensOut - total.tokensOut });
}

export function completeReportedTokens(usage: Pick<RunUsage, 'tokensIn' | 'tokensOut' | 'tokenEvidence'>): boolean {
  const value = validateTokenEvidence(usage.tokenEvidence, usage.tokensIn, usage.tokensOut);
  return !!value && !value.unclassified && value.requests.reported > 0 && BASES.slice(1).every(basis => value.requests[basis] === 0);
}

/** Small shared UI projection; original accounted amounts are never rounded here. */
export function tokenEvidenceLabel(usage: Pick<RunUsage, 'tokensIn' | 'tokensOut' | 'tokenEvidence'>,
  formatCount: (value: number) => string = value => value.toLocaleString()): string {
  const value = validateTokenEvidence(usage.tokenEvidence, usage.tokensIn, usage.tokensOut);
  if (!value) return 'Token provenance unknown';
  const labels: string[] = [];
  for (const basis of BASES) if (value.requests[basis] > 0 || value.input[basis] + value.output[basis] > 0) {
    const amount = formatCount(value.input[basis] + value.output[basis]);
    labels.push(`${basis === 'reported' && !completeReportedTokens(usage) ? 'Partial reported' : basis[0]!.toUpperCase() + basis.slice(1)} ${amount}`);
  }
  if (value.unclassified && !labels.some(label => label.startsWith('Unknown'))) labels.push('Unknown provenance');
  if (value.requests.noContact > 0) labels.push(`${formatCount(value.requests.noContact)} no-contact`);
  return labels.join(' · ') || 'No model requests recorded';
}
