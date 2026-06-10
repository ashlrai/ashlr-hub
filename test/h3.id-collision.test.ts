/**
 * H3 BUILD 4 — IDS-COLLISION-SAFE.
 *
 * Drives the REAL id-minting paths under same-millisecond bursts, via
 * `collectIds` / `mintProposalIds` / `mintSwarmIds`. Proves ids minted in a
 * tight loop are UNIQUE:
 *   - PROPOSAL ids: the inbox `generateId` `_seq` counter (inbox/store.ts:60-72)
 *     ALREADY guarantees same-ms uniqueness — this suite ASSERTS the existing
 *     counter; it does NOT change it.
 *   - SWARM ids: the pre-fix `makeId` (runner.ts) had ONLY ~24-bit random and no
 *     monotonic counter — THE GAP. The swarm-id sub-suite is RED before the
 *     `makeId` `_seq` fix (THE SINGLE PRODUCTION CHANGE in CONTRACT-H3.md) and
 *     GREEN after. The RED DETECTOR is the per-millisecond `<seq>` COUNTER
 *     ordering (strictly-increasing seq within each `<ts>` bucket), NOT raw
 *     set-uniqueness: a tight JS loop spreads mints across many ms buckets, so a
 *     same-ms 24-bit birthday collision essentially never happens and a bare
 *     `Set.size === N` check would pass even on the broken minter. The seq-counter
 *     ordering, by contrast, is deterministically red for a seq-less PRE-fix id.
 *
 * THE SINGLE PRODUCTION CHANGE (applied in INTEGRATION, not here): mirror the
 * inbox counter in `swarm/runner.ts` `makeId` — `swarm-<ts>-<seq>-<rand>` — AND
 * export `makeId` as a thin test seam. This test file is written to that TARGET
 * behavior; the scaffold/build phase does NOT touch production.
 *
 * SAFETY: isolated tmp HOME (H1 fixture), disposable repos only, no model /
 * subprocess / network, no outward action. See CONTRACT-H3.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { makeFixture } from './helpers/h1-fixture.js';
import {
  collectIds,
  mintProposalIds,
  mintSwarmIds,
  SWARM_ID_SHAPE,
} from './helpers/h3-stress.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';
// STATIC import of the real swarm-id minter (THE SINGLE PRODUCTION CHANGE adds
// the `_seq` counter + exports `makeId`). Imported statically — NOT via a dynamic
// import() inside the helper — so vitest's per-file module isolation binds the
// real exported `makeId` deterministically and a sibling suite that mocks
// `swarm/runner.js` can never pollute what this file observes.
import { makeId } from '../src/core/swarm/runner.js';

/**
 * Same-ms burst size. Large enough that, in a tight loop, MANY ids land within a
 * single millisecond `<ts>` bucket (so the per-ms `<seq>`-counter ordering proof
 * — the actual RED detector — genuinely exercises the counter, and `maxSameMs`
 * is > 1). NOTE: a same-ms 24-bit-random birthday collision is NOT relied upon:
 * the loop spreads mints across many ms buckets, so set-uniqueness alone would
 * NOT reliably go red without the fix — the seq-counter ordering is what does.
 */
const N = 5_000;

/**
 * The store path guard charset (swarmPath / proposalPath: /^[\w.-]+$/). An id
 * that fails this throws "Invalid swarm id" on persist, so every minted id MUST
 * match it to be filename-safe.
 */
const CHARSET_SAFE = /^[\w.-]+$/;

/** Extract the `<ts>` segment from a `<prefix>-<ts>-<seq>-<rand>` id. */
function tsSegment(id: string): string {
  const parts = id.split('-');
  return parts[1] ?? '';
}

/** The max number of ids that share a single millisecond timestamp segment. */
function maxSameMs(ids: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const ts = tsSegment(id);
    counts.set(ts, (counts.get(ts) ?? 0) + 1);
  }
  return Math.max(...counts.values());
}

/** Extract the numeric `<seq>` counter from a `<prefix>-<ts>-<seq>-<rand>` id. */
function seqSegment(id: string): number {
  const parts = id.split('-');
  // parts: [prefix, ts, seq, rand]. The seq is a zero-padded base-36 counter.
  return Number.parseInt(parts[2] ?? '', 36);
}

/**
 * Assert that WITHIN every `<ts>` bucket the `<seq>` counter is strictly
 * increasing across the ids in mint order. This is the property the `_seq`
 * monotonic counter actually guarantees, and it is DETERMINISTICALLY red without
 * the counter (a seq-less PRE-fix id has no `<seq>` segment, so `seqSegment`
 * returns NaN and the strict `>` check fails) — UNLIKE a raw set-uniqueness check,
 * which only catches a same-ms birthday collision (near-zero probability). It is
 * also independent of wall-clock monotonicity (it never compares across `<ts>`
 * buckets), so an NTP/leap-second clock step-back can't make it flake. Returns
 * the number of buckets that actually contained 2+ ids (the real same-ms density
 * the proof exercised).
 */
function assertSeqStrictlyIncreasingWithinTsBuckets(
  ids: readonly string[],
): number {
  const lastSeqForTs = new Map<string, number>();
  let multiIdBuckets = 0;
  const seen = new Set<string>();
  for (const id of ids) {
    const ts = tsSegment(id);
    const seq = seqSegment(id);
    expect(Number.isNaN(seq)).toBe(false); // a seq-less id (PRE-fix) is RED here
    const prev = lastSeqForTs.get(ts);
    if (prev !== undefined) {
      // Strictly increasing within the same millisecond — the counter property.
      expect(seq).toBeGreaterThan(prev);
      if (!seen.has(ts)) {
        multiIdBuckets++;
        seen.add(ts);
      }
    }
    lastSeqForTs.set(ts, seq);
  }
  return multiIdBuckets;
}

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H3 false-green guard (matches h3.budget-cap.test.ts:49 / h3.daily-reset.test.ts):
  // every it() MUST run at least one assertion, so a future emptied body fails
  // loudly instead of passing vacuously.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
});

describe('H3 IDS-COLLISION-SAFE — same-millisecond id bursts stay unique', () => {
  it('minting N proposal ids in a tight loop yields N UNIQUE ids (asserts the EXISTING inbox _seq counter)', () => {
    const ids = mintProposalIds(N, repo.dir);

    // Minted exactly N, and every one is distinct — the existing `_seq` counter
    // guarantees uniqueness even when many land in the same millisecond.
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);

    // Prove the burst really WAS same-millisecond-dense (so this is a real test
    // of the counter, not an artifact of slow wall-clock between mints): at
    // least one timestamp segment must recur across the N ids.
    expect(maxSameMs(ids)).toBeGreaterThan(1);

    // Every id carries the stable `prop-` prefix (the inbox id format).
    expect(ids.every((id) => id.startsWith('prop-'))).toBe(true);
  });

  it('minting N swarm ids in a tight loop yields N ids ordered by a strictly-increasing per-ms `<seq>` counter (RED before the makeId _seq fix, GREEN after)', () => {
    // Mints N ids via the REAL exported `makeId` seam (statically imported).
    //
    // THE RED DETECTOR is the per-ms `<seq>` COUNTER, not raw set-uniqueness.
    // A raw `new Set(ids).size === N` check does NOT reliably go red without the
    // `_seq` fix: a tight JS loop spreads the N mints across many millisecond
    // buckets, so a same-ms 24-bit-random birthday collision essentially never
    // occurs — set-uniqueness would pass GREEN even on the broken minter. The
    // counter property below is what is DETERMINISTICALLY red without the fix: a
    // PRE-fix `swarm-<ts>-<rand>` id has NO `<seq>` segment, so `mintSwarmIds`
    // throws on the shape guard AND `assertSeqStrictlyIncreasingWithinTsBuckets`
    // sees NaN and fails the strict `>` check.
    const ids = mintSwarmIds(N, makeId);

    expect(ids).toHaveLength(N);

    // Uniqueness still holds (a useful corollary of the monotonic counter), but
    // it is NOT the regression detector — see the comment above.
    expect(new Set(ids).size).toBe(N);

    // THE deterministic red-before/green-after detector: within every `<ts>`
    // bucket the `<seq>` counter strictly increases (impossible for a seq-less
    // PRE-fix id). This also proves the burst really WAS same-ms-dense, since it
    // returns the count of buckets that held 2+ ids.
    const multiIdBuckets = assertSeqStrictlyIncreasingWithinTsBuckets(ids);
    expect(multiIdBuckets).toBeGreaterThan(0);

    // Same-ms density cross-check: at least one timestamp segment recurs, so the
    // ordering proof above exercised the counter (not merely the wall clock).
    expect(maxSameMs(ids)).toBeGreaterThan(1);

    // The id FORMAT stays parseable/sortable: the `swarm-` prefix is preserved
    // and the `<seq>` segment is present (THE SINGLE PRODUCTION CHANGE is
    // additive — it inserts a `<seq>` segment; it does NOT drop the prefix).
    expect(ids.every((id) => id.startsWith('swarm-'))).toBe(true);
    expect(ids.every((id) => SWARM_ID_SHAPE.test(id))).toBe(true);
  });

  it('minted ids are charset-safe (/^[\\w.-]+$/) so they are filename-safe under the store path guard', () => {
    const proposalIds = mintProposalIds(N, repo.dir);
    const swarmIds = mintSwarmIds(N, makeId);

    // Every minted id of BOTH kinds must match the store path guard — otherwise
    // proposalPath/swarmPath would throw "Invalid swarm id" on persist.
    for (const id of proposalIds) {
      expect(id).toMatch(CHARSET_SAFE);
    }
    for (const id of swarmIds) {
      expect(id).toMatch(CHARSET_SAFE);
    }

    // Spot-prove there are no path separators or traversal chars that the guard
    // is meant to reject (defense-in-depth on the assertion itself).
    expect(
      proposalIds.some((id) => id.includes('/') || id.includes('..')),
    ).toBe(false);
    expect(swarmIds.some((id) => id.includes('/') || id.includes('..'))).toBe(
      false,
    );
  });

  it('within each millisecond bucket, minted ids order strictly by the monotonic `<seq>` counter (clock-independent most-recent-first tiebreak)', () => {
    // The `<seq>` counter is placed BEFORE the random segment specifically so
    // that, WITHIN a single `<ts>` millisecond, a plain string sort orders by the
    // monotonic counter — the stable most-recent-first tiebreak listProposals /
    // listSwarms rely on. We assert the property the COUNTER guarantees (strictly
    // increasing seq within each `<ts>` bucket) rather than a global string sort
    // over the whole array: a global sort additionally assumes `Date.now()` is
    // NON-DECREASING across the 5000-id loop, but the wall clock can step BACKWARD
    // (NTP correction, leap-second smear, VM clock adjustment), which would make a
    // global-sort assertion flake for reasons unrelated to the id logic. The
    // bucket-local proof never compares across `<ts>` buckets, so it isolates the
    // counter from the non-monotonic clock.
    const proposalIds = mintProposalIds(N, repo.dir);
    const proposalBuckets = assertSeqStrictlyIncreasingWithinTsBuckets(proposalIds);
    expect(proposalBuckets).toBeGreaterThan(0);

    const swarmIds = mintSwarmIds(N, makeId);
    const swarmBuckets = assertSeqStrictlyIncreasingWithinTsBuckets(swarmIds);
    expect(swarmBuckets).toBeGreaterThan(0);

    // Uniqueness across the whole burst still holds (a corollary of the monotonic
    // counter), and is what the persistence-path guard ultimately needs.
    expect(new Set(proposalIds).size).toBe(N);
    expect(new Set(swarmIds).size).toBe(N);

    // `collectIds` is the shared minting primitive both paths use — assert it is
    // wired (a guard against a future refactor silently dropping it).
    expect(typeof collectIds).toBe('function');
  });
});
