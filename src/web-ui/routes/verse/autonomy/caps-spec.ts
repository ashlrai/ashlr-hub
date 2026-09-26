/**
 * routes/verse/autonomy/caps-spec.ts — one table describing every editable
 * cap, mirroring the server-side ranges in docs/VERSE-CONTRACT-V2.md so the
 * operator gets the error BEFORE the round trip, not after it.
 *
 * The table is the single source of truth for: the label, the unit shown next
 * to the number, the accepted range, whether the value must be whole, the
 * display transform (tick interval is edited in minutes, stored in ms), the
 * one-line explanation under the control, and how a committed value turns
 * into a `POST /api/verse/caps` partial body. Adding a cap is one entry here
 * and nothing else.
 *
 * If these ranges ever disagree with the server the server still wins — this
 * is a courtesy gate, never an authority. That is why `applyCapPatch` builds
 * a PARTIAL body and the panel re-reads the server's `applied` snapshot.
 */
import { VERSE_CAPS_BOUNDS, type VerseCaps, type VerseCapsPatch } from './control-types.js';

export type CapKey =
  | 'dailyBudgetUsd'
  | 'perTickItems'
  | 'parallel'
  | 'intervalMs'
  | 'maxConcurrent'
  | 'concurrency.local'
  | 'concurrency.cloud'
  | 'concurrency.total'
  | 'subscriptionMaxPercent';

export interface CapFieldSpec {
  key: CapKey;
  label: string;
  /** Shown after the input; also read aloud as part of the accessible name. */
  unit: string;
  /** Inclusive bounds, expressed in DISPLAY units. */
  min: number;
  max: number;
  /** Display values must be whole numbers (tick interval is the exception). */
  integer: boolean;
  step: number;
  help: string;
  /** Stored value -> what the operator types. */
  toDisplay: (stored: number) => number;
  /** What the operator typed -> what the server stores. */
  fromDisplay: (display: number) => number;
}

const identity = (n: number) => n;

/** Tick interval is stored in ms and edited in minutes — 30s..24h. */
const MS_PER_MINUTE = 60_000;

export const CAP_FIELDS: readonly CapFieldSpec[] = [
  {
    key: 'dailyBudgetUsd',
    label: 'Daily budget',
    unit: 'USD / day',
    min: 0,
    max: 1000,
    integer: false,
    step: 1,
    help: 'Hard ceiling on what the loop may spend in a calendar day. 0 stops the loop.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'perTickItems',
    label: 'Items per tick',
    unit: 'items',
    min: 1,
    max: 50,
    integer: true,
    step: 1,
    help: 'How many backlog items one tick may pick up.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'parallel',
    label: 'Parallel swarms',
    unit: 'swarms',
    min: 1,
    max: 16,
    integer: true,
    step: 1,
    help: 'Sandboxed swarms run simultaneously inside one tick (batch mode).',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'intervalMs',
    label: 'Tick interval',
    unit: 'minutes',
    min: 0.5,
    max: 1440,
    integer: false,
    step: 0.5,
    help: 'Gap between ticks in loop mode. 30 seconds minimum, 24 hours maximum.',
    toDisplay: (stored) => Math.round((stored / MS_PER_MINUTE) * 100) / 100,
    fromDisplay: (display) => Math.round(display * MS_PER_MINUTE),
  },
  {
    key: 'maxConcurrent',
    label: 'Max concurrent',
    unit: 'dispatches',
    min: 1,
    max: 32,
    integer: true,
    step: 1,
    help: 'Absolute ceiling on in-flight dispatches in continuous mode. Takes precedence over the per-tier totals.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'concurrency.local',
    label: 'Local tier',
    unit: 'slots',
    min: 1,
    max: 32,
    integer: true,
    step: 1,
    help: 'On-device engines. GPU/RAM bound — keep this low.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'concurrency.cloud',
    label: 'Cloud tier',
    unit: 'slots',
    min: 1,
    max: 32,
    integer: true,
    step: 1,
    help: 'Subscription cloud agents. I/O bound — many can run at once.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'concurrency.total',
    label: 'All tiers',
    unit: 'slots',
    min: 1,
    max: 32,
    integer: true,
    step: 1,
    help: 'Hard cap across every tier combined.',
    toDisplay: identity,
    fromDisplay: identity,
  },
  {
    key: 'subscriptionMaxPercent',
    label: 'Subscription ceiling',
    unit: '% of window',
    min: 1,
    max: 100,
    integer: true,
    step: 1,
    help: 'How much of a flat-fee provider window the fleet may consume before it backs off.',
    toDisplay: identity,
    fromDisplay: identity,
  },
] as const;

export function capFieldByKey(key: CapKey): CapFieldSpec {
  const found = CAP_FIELDS.find((f) => f.key === key);
  /* istanbul ignore next -- CapKey is closed; this is a type-level guarantee. */
  if (!found) throw new Error(`unknown cap field: ${key}`);
  return found;
}

/** Current stored value for a cap, or null when the server did not send it. */
export function readCap(caps: VerseCaps | undefined, key: CapKey): number | null {
  if (!caps) return null;
  const raw =
    key === 'concurrency.local'
      ? caps.concurrency?.local
      : key === 'concurrency.cloud'
        ? caps.concurrency?.cloud
        : key === 'concurrency.total'
          ? caps.concurrency?.total
          : (caps as unknown as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export type CapValidation =
  | { ok: true; stored: number; display: number }
  | { ok: false; error: string };

/**
 * A number with its unit, as a sentence writes it: "50 items", but "100% of
 * window" — a percent sign hugs its number ("100 % of window" read as a typo).
 */
function withUnit(value: number, unit: string): string {
  return unit.startsWith('%') ? `${value}${unit}` : `${value} ${unit}`;
}

/**
 * Validate what the operator typed against the spec's DISPLAY range, then
 * convert to the stored unit. Rejects blanks, non-numbers, fractions on
 * whole-number caps, and anything outside the range the server enforces.
 */
export function validateCap(spec: CapFieldSpec, raw: string): CapValidation {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: `${spec.label} cannot be blank.` };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: `${spec.label} must be a number.` };
  if (spec.integer && !Number.isInteger(parsed)) {
    // "a whole number of % of window" is not a phrase; a percentage cap says so plainly.
    const whole = spec.unit.startsWith('%') ? 'a whole percentage' : `a whole number of ${spec.unit}`;
    return { ok: false, error: `${spec.label} must be ${whole}.` };
  }
  if (parsed < spec.min || parsed > spec.max) {
    return { ok: false, error: `${spec.label} must be between ${spec.min} and ${withUnit(spec.max, spec.unit)}.` };
  }
  return { ok: true, stored: spec.fromDisplay(parsed), display: parsed };
}

/** Build the smallest `POST /api/verse/caps` body that applies one cap. */
export function capPatch(key: CapKey, stored: number): VerseCapsPatch {
  switch (key) {
    case 'concurrency.local':
      return { concurrency: { local: stored } };
    case 'concurrency.cloud':
      return { concurrency: { cloud: stored } };
    case 'concurrency.total':
      return { concurrency: { total: stored } };
    default:
      return { [key]: stored } as VerseCapsPatch;
  }
}

/**
 * Inclusive display range for a per-engine foundry limit `max`. Read straight
 * off the server's own bound so the courtesy gate cannot drift from the 400
 * (`bounded(entry['max'], …, VERSE_CAPS_BOUNDS.foundryLimitMax)` in
 * control-api.ts). It is not a `CAP_FIELDS` entry, so the drift test that
 * iterates that table never reached it — hence the explicit export.
 */
export const FOUNDRY_LIMIT_MAX_RANGE = VERSE_CAPS_BOUNDS.foundryLimitMax;

/** Per-engine foundry limit `max` — bounded exactly as the server bounds it. */
export function validateFoundryMax(raw: string, engine: string): CapValidation {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: `${engine} limit cannot be blank.` };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: `${engine} limit must be a number.` };
  if (!Number.isInteger(parsed)) return { ok: false, error: `${engine} limit must be a whole number of dispatches.` };
  if (parsed < FOUNDRY_LIMIT_MAX_RANGE.min) return { ok: false, error: `${engine} limit cannot be negative.` };
  if (parsed > FOUNDRY_LIMIT_MAX_RANGE.max) {
    return {
      ok: false,
      error: `${engine} limit must be at most ${FOUNDRY_LIMIT_MAX_RANGE.max} dispatches.`,
    };
  }
  return { ok: true, stored: parsed, display: parsed };
}
