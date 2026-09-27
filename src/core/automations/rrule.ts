/**
 * A small, strict RFC 5545 RRULE subset for automation schedules, evaluated
 * in the machine's LOCAL time (the operator's calendar, like the budgets'
 * "today").
 *
 *   FREQ=HOURLY|DAILY|WEEKLY|MONTHLY   (required)
 *   INTERVAL=n                          1–366 (default 1)
 *   BYDAY=MO,TU,…                       weekdays (no ordinals); WEEKLY defaults to MO
 *   BYMONTHDAY=1..31                    MONTHLY only (default 1)
 *   BYHOUR=0..23                        default: every hour for HOURLY, else 0
 *   BYMINUTE=0..59                      default 0
 *
 * An optional leading `RRULE:` is accepted. Anything else (COUNT, UNTIL,
 * BYSETPOS, ordinals like 1MO, DTSTART) is REFUSED with a plain sentence —
 * a schedule that silently means something else would fire work at the
 * wrong time. INTERVAL is anchored to fixed epochs (hours since the Unix
 * epoch, days/weeks since Monday 1970-01-05 local, months since Jan 1970),
 * so the same rule always yields the same occurrences — no hidden DTSTART.
 *
 * Pure: no clock; the caller passes `after`.
 */

export type RruleFreq = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface ParsedRrule {
  freq: RruleFreq;
  interval: number;
  /** 0 = Sunday … 6 = Saturday (Date#getDay). */
  byDay: number[] | null;
  byMonthDay: number[] | null;
  byHour: number[];
  byMinute: number[];
}

export type RruleParse = { ok: true; rule: ParsedRrule } | { ok: false; error: string };

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const FREQS: readonly RruleFreq[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];
const KNOWN = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE']);
const MAX_RULE_CHARS = 200;
/** Days scanned for the next occurrence: covers MONTHLY;INTERVAL=12;BYMONTHDAY=31 twice over. */
const SCAN_DAYS = 800;

function intList(raw: string, min: number, max: number, name: string): number[] | string {
  const out: number[] = [];
  for (const part of raw.split(',')) {
    if (!/^\d{1,3}$/.test(part)) return `${name} must be a comma list of whole numbers.`;
    const n = Number(part);
    if (n < min || n > max) return `${name} values must be between ${min} and ${max}.`;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export function parseRrule(input: unknown): RruleParse {
  if (typeof input !== 'string') return { ok: false, error: 'The schedule must be an RRULE string, e.g. FREQ=DAILY;BYHOUR=2.' };
  let text = input.trim();
  if (text.length === 0 || text.length > MAX_RULE_CHARS) return { ok: false, error: 'The schedule must be an RRULE of at most 200 characters.' };
  if (/^RRULE:/i.test(text)) text = text.slice(6);
  const parts: Record<string, string> = {};
  for (const piece of text.split(';')) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) return { ok: false, error: `"${piece.slice(0, 40)}" is not a KEY=VALUE part.` };
    const key = piece.slice(0, eq).toUpperCase();
    const value = piece.slice(eq + 1).toUpperCase();
    if (!KNOWN.has(key)) return { ok: false, error: `${key} is not supported here (use FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE).` };
    if (key in parts) return { ok: false, error: `${key} appears twice.` };
    parts[key] = value;
  }
  const freq = parts['FREQ'] as RruleFreq | undefined;
  if (!freq || !FREQS.includes(freq)) return { ok: false, error: 'FREQ must be HOURLY, DAILY, WEEKLY or MONTHLY.' };

  let interval = 1;
  if (parts['INTERVAL'] !== undefined) {
    if (!/^\d{1,3}$/.test(parts['INTERVAL'])) return { ok: false, error: 'INTERVAL must be a whole number.' };
    interval = Number(parts['INTERVAL']);
    if (interval < 1 || interval > 366) return { ok: false, error: 'INTERVAL must be between 1 and 366.' };
  }

  let byDay: number[] | null = null;
  if (parts['BYDAY'] !== undefined) {
    if (freq === 'MONTHLY') return { ok: false, error: 'BYDAY is not supported with FREQ=MONTHLY (use BYMONTHDAY).' };
    const days: number[] = [];
    for (const code of parts['BYDAY'].split(',')) {
      const idx = (DAY_CODES as readonly string[]).indexOf(code);
      if (idx === -1) return { ok: false, error: `BYDAY "${code.slice(0, 8)}" must be one of ${DAY_CODES.join(', ')} (no ordinals).` };
      if (!days.includes(idx)) days.push(idx);
    }
    byDay = days.sort((a, b) => a - b);
  } else if (freq === 'WEEKLY') {
    byDay = [1];
  }

  let byMonthDay: number[] | null = null;
  if (parts['BYMONTHDAY'] !== undefined) {
    if (freq !== 'MONTHLY') return { ok: false, error: 'BYMONTHDAY needs FREQ=MONTHLY.' };
    const list = intList(parts['BYMONTHDAY'], 1, 31, 'BYMONTHDAY');
    if (typeof list === 'string') return { ok: false, error: list };
    byMonthDay = list;
  } else if (freq === 'MONTHLY') {
    byMonthDay = [1];
  }

  let byHour: number[];
  if (parts['BYHOUR'] !== undefined) {
    const list = intList(parts['BYHOUR'], 0, 23, 'BYHOUR');
    if (typeof list === 'string') return { ok: false, error: list };
    byHour = list;
  } else {
    byHour = freq === 'HOURLY' ? Array.from({ length: 24 }, (_, i) => i) : [0];
  }

  let byMinute = [0];
  if (parts['BYMINUTE'] !== undefined) {
    const list = intList(parts['BYMINUTE'], 0, 59, 'BYMINUTE');
    if (typeof list === 'string') return { ok: false, error: list };
    byMinute = list;
  }

  return { ok: true, rule: { freq, interval, byDay, byMonthDay, byHour, byMinute } };
}

/** Monday 1970-01-05, local midnight — the anchor for DAILY/WEEKLY intervals. */
function localDayIndex(d: Date): number {
  const anchor = new Date(1970, 0, 5);
  // Round, not floor: DST days are 23 or 25 hours long.
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - anchor.getTime()) / 86_400_000);
}

function dayMatches(rule: ParsedRrule, day: Date): boolean {
  if (rule.byDay && !rule.byDay.includes(day.getDay())) return false;
  if (rule.byMonthDay && !rule.byMonthDay.includes(day.getDate())) return false;
  if (rule.interval === 1) return true;
  switch (rule.freq) {
    case 'DAILY':
      return ((localDayIndex(day) % rule.interval) + rule.interval) % rule.interval === 0;
    case 'WEEKLY':
      return ((Math.floor(localDayIndex(day) / 7) % rule.interval) + rule.interval) % rule.interval === 0;
    case 'MONTHLY':
      return ((day.getFullYear() - 1970) * 12 + day.getMonth()) % rule.interval === 0;
    case 'HOURLY':
      return true;
  }
}

/** The first occurrence strictly after `after`, or null when none within ~2 years. */
export function nextOccurrence(rule: ParsedRrule, after: Date): Date | null {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) return null;
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let offset = 0; offset < SCAN_DAYS; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!dayMatches(rule, day)) continue;
    for (const hour of rule.byHour) {
      for (const minute of rule.byMinute) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
        // A wall time skipped by DST lands an hour off; keep it only when it is still that day.
        if (at.getDate() !== day.getDate()) continue;
        if (rule.freq === 'HOURLY' && rule.interval > 1 && Math.floor(at.getTime() / 3_600_000) % rule.interval !== 0) continue;
        if (at.getTime() > afterMs) return at;
      }
    }
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Operator language: "Every day at 02:00", "Every Monday at 06:00", "Every 2 hours at :15". */
export function describeRrule(rule: ParsedRrule): string {
  const times = rule.freq === 'HOURLY'
    ? `at ${rule.byMinute.map((m) => `:${pad(m)}`).join(', ')}`
    : `at ${joinWords(rule.byHour.flatMap((h) => rule.byMinute.map((m) => `${pad(h)}:${pad(m)}`)).slice(0, 6))}`;
  const every = (unit: string, units: string): string => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${units}`);
  switch (rule.freq) {
    case 'HOURLY': {
      const hours = rule.byHour.length === 24 ? '' : ` during ${joinWords(rule.byHour.map((h) => `${pad(h)}h`))}`;
      return `${every('hour', 'hours')} ${times}${hours}`;
    }
    case 'DAILY': {
      const days = rule.byDay ? ` on ${joinWords(rule.byDay.map((d) => DAY_NAMES[d]!))}` : '';
      return `${every('day', 'days')}${days} ${times}`;
    }
    case 'WEEKLY':
      return `${every('week', 'weeks')} on ${joinWords((rule.byDay ?? [1]).map((d) => DAY_NAMES[d]!))} ${times}`;
    case 'MONTHLY':
      return `${every('month', 'months')} on day ${joinWords((rule.byMonthDay ?? [1]).map(String))} ${times}`;
  }
}
