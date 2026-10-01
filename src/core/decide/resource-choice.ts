/** Advice over an already admitted closed set, never a new admission or spend policy.
 * Provider sees ordinals and bounded task/timing metadata, not task/account IDs or text.
 * API/request bounds fall back for the whole set; eligible inventory is never truncated. */
import { createHash } from 'node:crypto';
import { forecastFit } from '../routing/reset-pressure.js';
import type { AshlrConfig } from '../types.js';
import type { ResourceChoiceCandidate } from '../routing/scheduling-types.js';
import { decide, effectiveThreshold, jevReady } from './decide.js';
import { TASK_CLASSES } from './registry.js';

interface AdviceOptions {
  digest: string;
  signal?: AbortSignal;
  /** Existing transport seams for fake-only tests / self-hosted deployments. */
  cfg?: AshlrConfig;
  endpoint?: string;
  timeoutMs?: number;
}
interface Memo { choice: string | null; expiresAt: number }
const memo = new Map<string, Memo>();
const inflight = new Map<string, Promise<string | null>>();
const CACHE_MS = 6 * 60 * 60 * 1000; // Same TTL / entry budget as the shared Jev cache.
const MAX_ENTRIES = 1000;
const MAX_CHOICES = 255; // Official choice cardinality: https://docs.typesafe.ai/api.
const MAX_STATE_CHARS = 6000; // Existing client bound. Refuse rather than its head/tail truncation.
const TASK_KINDS = new Set<string>([...TASK_CLASSES, 'issue', 'todo', 'test', 'dep', 'doc', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent']);
const NON_ATTEMPTS = new Set(['no-key', 'disabled', 'killed', 'kind-disabled', 'no-input', 'budget-exhausted', 'cancelled']);

function normalize(candidates: readonly ResourceChoiceCandidate[], now: number) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > MAX_CHOICES) return null;
  const ids = new Set<string>();
  let expiresAt = now + CACHE_MS;
  const rows = [];
  for (const c of candidates) {
    if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 512 || ids.has(c.id)) return null;
    ids.add(c.id);
    if (c.headroomPercent !== null && !(typeof c.headroomPercent === 'number' && Number.isFinite(c.headroomPercent) && c.headroomPercent >= 0 && c.headroomPercent <= 100)) return null;
    if (c.durationP75Ms !== null && !(typeof c.durationP75Ms === 'number' && Number.isFinite(c.durationP75Ms) && c.durationP75Ms > 0 && c.durationP75Ms <= Number.MAX_SAFE_INTEGER)) return null;
    const p25 = c.durationP25Ms ?? null;
    if (p25 !== null && !(typeof p25 === 'number' && Number.isFinite(p25) && p25 > 0 && p25 <= Number.MAX_SAFE_INTEGER && c.durationP75Ms !== null && p25 <= c.durationP75Ms)) return null;
    const reset = c.resetAt === null ? null : typeof c.resetAt === 'string' && c.resetAt.length <= 64 ? Date.parse(c.resetAt) : NaN;
    if (reset !== null && !Number.isFinite(reset)) return null;
    if (reset !== null && reset > now) expiresAt = Math.min(expiresAt, reset);
    const duration = c.durationP75Ms;
    rows.push({
      choice: `c${rows.length}`,
      taskKind: TASK_KINDS.has(c.taskKind) ? c.taskKind : 'other',
      headroomPercent: c.headroomPercent,
      resetAt: reset === null ? null : new Date(reset).toISOString(),
      resetPending: reset === null ? null : reset > now,
      durationP25Ms: p25, durationP75Ms: duration,
      fit: forecastFit(p25 === null || duration === null ? null : {durationMs:{p25,p75:duration}}, reset === null ? null : new Date(reset).toISOString(), now),
    });
  }
  const state = JSON.stringify(rows);
  if (state.length > MAX_STATE_CHARS) return null;
  return { ids: [...ids], state, expiresAt, fits:rows.map(row=>row.fit) };
}

export async function adviseResourceChoice(candidates: readonly ResourceChoiceCandidate[], options: AdviceOptions): Promise<string | null> {
  try {
    if (!options || !/^[a-f0-9]{64}$/.test(options.digest) || options.signal?.aborted) return null;
    const input = normalize(candidates, Date.now());
    if (!input || !(await jevReady('resource-choice', options.cfg))) return null;
    const threshold = effectiveThreshold('resource-choice');
    const key = createHash('sha256').update(JSON.stringify([
      process.env['ASHLR_HOME'] ?? process.env['HOME'] ?? '', options.digest, input.ids, input.state, threshold,
    ])).digest('hex');
    const prior = memo.get(key);
    if (prior && prior.expiresAt > Date.now()) return options.signal?.aborted ? null : prior.choice;
    memo.delete(key);
    // Bound concurrent bookkeeping as well as completed cache. No roster truncation.
    let pending = inflight.get(key);
    if (!pending) {
      if (inflight.size >= MAX_ENTRIES) return null;
      pending = (async () => {
        const criteria = Object.fromEntries(input.ids.map((_, i) => [`c${i}`, 'This eligible pair best fits the task, available headroom and observed reset timing.']));
        const result = await decide<string | null>('resource-choice', input.state, {
          resource_choice: {
            type: 'choice', criteria,
            instructions: 'Choose one already eligible pair using only observed metadata. Unknown is not zero. Prefer likely time fit; this advice cannot admit accounts, override limits or promise completion.',
          },
        }, {
          fallback: null, cacheSalt: createHash('sha256').update(JSON.stringify([options.digest, input.ids])).digest('hex'), threshold,
          ...(options.cfg ? { cfg: options.cfg } : {}),
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const index = result.path === 'jev' && typeof result.value === 'string' && /^c\d+$/.test(result.value) ? Number(result.value.slice(1)) : -1;
        const choice = Number.isSafeInteger(index) && index >= 0 && index < input.ids.length && input.fits[index] !== 'unlikely-before-reset' ? input.ids[index] : null;
        // Remember attempted failures too, so a timed-out selected batch doesn't become a per-poll paid call.
        // No-key/disabled/budget/cancellation remain immediately recoverable on a new operator choice.
        if (!options.signal?.aborted && !NON_ATTEMPTS.has(result.reason ?? '')) {
          if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
          memo.set(key, { choice, expiresAt: input.expiresAt });
        }
        return choice;
      })();
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    const choice = await pending;
    return options.signal?.aborted || !(await jevReady('resource-choice', options.cfg)) ? null : choice;
  } catch {
    return null;
  }
}

/** Fake-only test reset; no persistent state or runtime configuration is changed. */
export function resetResourceChoiceCacheForTests(): void { memo.clear(); inflight.clear(); }
