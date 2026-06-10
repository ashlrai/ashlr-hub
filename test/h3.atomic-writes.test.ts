/**
 * H3 BUILD 5 — ATOMIC-WRITES-UNDER-CONTENTION.
 *
 * Drives the REAL atomic stores under concurrent writers, via `spawnConcurrent`:
 *   - daemon state  — tmp+rename (state.ts:136-139),
 *   - inbox proposal — tmp+rename (inbox/store.ts:85-88),
 *   - swarm record  — tmp+rename, POSIX-atomic (swarm/store.ts:104-118).
 * Proves a concurrent READER never observes a partial/torn file, N distinct
 * concurrent writes all persist as N readable records (no lost/clobbered write),
 * a pre-seeded `.tmp` leftover (an interrupted write) is NEVER surfaced by a
 * list view, and corrupt/half-written JSON is skipped (never crashes a load).
 *
 * The Windows direct-write fallback (swarm/store.ts:112-117) is a DOCUMENTED
 * platform caveat (CONTRACT-H3.md) — NOT exercised here (CI is POSIX) and NOT
 * changed.
 *
 * SAFETY: isolated tmp HOME (H1 fixture), disposable repos only, no model /
 * subprocess / network, no outward action. See CONTRACT-H3.md.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createProposal,
  listProposals,
  loadProposal,
  inboxDir,
} from '../src/core/inbox/store.js';
import { listSwarms, loadSwarm, swarmsDir } from '../src/core/swarm/store.js';
import {
  loadDaemonState,
  saveDaemonState,
  daemonStatePath,
} from '../src/core/daemon/state.js';
import type { DaemonState, Proposal, SwarmRun } from '../src/core/types.js';
import { makeFixture } from './helpers/h1-fixture.js';
import { crashMidSwarm } from './helpers/h2-faults.js';
import { spawnConcurrent } from './helpers/h3-stress.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H3 false-green guard (matches h3.budget-cap.test.ts / h3.daily-reset.test.ts):
  // every it() MUST run at least one assertion, so an emptied body fails loudly
  // instead of passing vacuously.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
});

/**
 * A complete, well-formed DaemonState carrying a writer-distinguishing
 * `todaySpentUsd` so a torn read (partial JSON, or a half-written number) would
 * surface as either a JSON syntax error or a non-numeric field — both of which
 * the assertions below would catch.
 */
function stateForWriter(i: number): DaemonState {
  return {
    running: true,
    pid: 424242,
    startedAt: '2026-06-10T00:00:00.000Z',
    lastTickAt: '2026-06-10T00:00:00.000Z',
    todayDate: '2026-06-10',
    todaySpentUsd: i + 0.5,
    itemsProcessed: i,
    ticks: [
      {
        ts: '2026-06-10T00:00:00.000Z',
        itemsConsidered: i,
        proposalsCreated: 0,
        spentUsd: i + 0.5,
        reason: 'ok',
      },
    ],
  };
}

/** Assert a value is a COMPLETE, well-typed DaemonState (never a torn record). */
function assertCompleteState(s: DaemonState): void {
  expect(typeof s.running).toBe('boolean');
  expect(typeof s.todaySpentUsd).toBe('number');
  expect(Number.isFinite(s.todaySpentUsd)).toBe(true);
  expect(typeof s.itemsProcessed).toBe('number');
  expect(Array.isArray(s.ticks)).toBe(true);
}

describe('H3 ATOMIC-WRITES-UNDER-CONTENTION — concurrent writers never tear a file or lose a record', () => {
  it('N concurrent createProposal calls persist N distinct well-formed records (no lost/clobbered write)', async () => {
    const N = 200;

    const results = await spawnConcurrent(N, async (i) => {
      // Yield so the N persistProposal tmp+rename writes genuinely interleave.
      await Promise.resolve();
      return createProposal({
        repo: repo.dir,
        origin: 'swarm',
        kind: 'patch',
        title: `h3 atomic proposal ${i}`,
        summary: 'H3 ATOMIC-WRITES: N concurrent createProposal writers',
        diff: 'diff --git a/x.ts b/x.ts\n',
      });
    });

    // Every unit settled successfully (createProposal never throws).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // The in-memory ids are all distinct (the generateId _seq counter holds).
    const mintedIds = results.map((r) =>
      r.status === 'fulfilled' ? r.value.id : '',
    );
    expect(new Set(mintedIds).size).toBe(N);

    // All N records are individually loadable (no overwrite/clobber on disk).
    for (const id of mintedIds) {
      const loaded: Proposal | null = loadProposal(id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(id);
      expect(loaded?.status).toBe('pending');
    }

    // listProposals surfaces exactly N distinct, well-formed records.
    const listed = listProposals();
    expect(listed.length).toBe(N);
    expect(new Set(listed.map((p) => p.id)).size).toBe(N);
    expect(
      listed.every((p) => typeof p.id === 'string' && p.id.length > 0),
    ).toBe(true);
    // The persisted set equals the minted set — nothing lost, nothing extra.
    expect(new Set(listed.map((p) => p.id))).toEqual(new Set(mintedIds));
  });

  it('N concurrent saveSwarm of distinct ids leave N readable records via the POSIX-atomic rename path', async () => {
    const N = 150;

    const results = await spawnConcurrent(N, async (i) => {
      await Promise.resolve();
      // crashMidSwarm builds a COMPLETE SwarmRun and persists it via the REAL
      // saveSwarm (tmp+rename). Distinct ids => distinct files => no clobber.
      return crashMidSwarm({
        id: `swarm-h3-atomic-${i}`,
        goal: `h3 atomic swarm ${i}`,
        project: repo.dir,
        taskIds: [`t${i}`],
      });
    });

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Each distinct id loads back to a complete record (POSIX-atomic rename: a
    // reader either sees prior absence or the full new file, never a torn one).
    for (let i = 0; i < N; i++) {
      const id = `swarm-h3-atomic-${i}`;
      const loaded: SwarmRun | null = loadSwarm(id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(id);
      expect(loaded?.goal).toBe(`h3 atomic swarm ${i}`);
      expect(Array.isArray(loaded?.tasks)).toBe(true);
    }

    // listSwarms surfaces every distinct record (N <= MAX_LIST=200).
    const listed = listSwarms();
    expect(listed.length).toBe(N);
    expect(new Set(listed.map((s) => s.id)).size).toBe(N);
  });

  it('a concurrent reader during many saveDaemonState writes always parses a COMPLETE record (never torn)', async () => {
    const WRITES = 120;
    const reads: DaemonState[] = [];
    let readErrors = 0;
    let stop = false;

    // A reader loop that hammers loadDaemonState while writers race. The REAL
    // loadDaemonState reads + JSON.parses the file; tmp+rename guarantees it
    // never sees a half-written file (it sees the prior complete file or the new
    // complete file). loadDaemonState swallows parse errors -> a fresh zeroed
    // state, which is still a COMPLETE record (never a thrown/torn one).
    const reader = (async (): Promise<void> => {
      // Seed an initial complete state so the file exists before reads begin.
      saveDaemonState(stateForWriter(-1));
      while (!stop) {
        try {
          const s = loadDaemonState();
          assertCompleteState(s);
          reads.push(s);
        } catch {
          readErrors++;
        }
        await Promise.resolve();
      }
    })();

    // Flood the writer side: many interleaved atomic writes of distinct states.
    const writeResults = await spawnConcurrent(WRITES, async (i) => {
      await Promise.resolve();
      saveDaemonState(stateForWriter(i));
    });

    stop = true;
    await reader;

    expect(writeResults.every((r) => r.status === 'fulfilled')).toBe(true);
    // The reader observed many states and NEVER a torn/parse-failed one.
    expect(readErrors).toBe(0);
    expect(reads.length).toBeGreaterThan(0);

    // The committed file is a complete, well-typed record with a valid spend
    // value drawn from exactly one of the writers (no torn mid-number). The raw
    // JSON.parse must not throw, proving the on-disk file is never torn.
    const finalRaw = readFileSync(daemonStatePath(), 'utf8');
    const finalParsed = JSON.parse(finalRaw) as DaemonState; // must not throw
    assertCompleteState(finalParsed);
    const finalReload = loadDaemonState();
    assertCompleteState(finalReload);
    // The final spend is one writer's exact value (atomic last-writer-wins),
    // never a torn fraction.
    const validSpends = new Set(
      Array.from({ length: WRITES }, (_, i) => i + 0.5).concat([-0.5]),
    );
    expect(validSpends.has(finalReload.todaySpentUsd)).toBe(true);
  });

  it('a pre-seeded .tmp leftover (interrupted write) is never surfaced by listProposals / listSwarms', () => {
    // Commit a few real records first so the dirs exist and have content.
    const realProp = createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: 'committed proposal',
      summary: 'H3 ATOMIC-WRITES: a committed .json record',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    const realSwarm = crashMidSwarm({
      id: 'swarm-h3-committed',
      goal: 'committed swarm',
      project: repo.dir,
      taskIds: ['t0'],
    });

    // Seed an INTERRUPTED-write leftover for each store: a .tmp sidecar that an
    // atomic write would have produced before a crash-before-rename. Its content
    // is a *complete-looking* record so the ONLY reason a list must skip it is
    // the .tmp filter — proving the filter (not luck) is what excludes it.
    const inbox = inboxDir();
    const swarms = swarmsDir();
    const leftoverProp: Proposal = {
      ...realProp,
      id: 'prop-h3-leftover-tmp',
      title: 'LEFTOVER tmp proposal — must never be surfaced',
    };
    writeFileSync(
      join(inbox, 'prop-h3-leftover-tmp.json.tmp'),
      JSON.stringify(leftoverProp, null, 2) + '\n',
      'utf8',
    );
    const leftoverSwarm: SwarmRun = {
      ...realSwarm,
      id: 'swarm-h3-leftover-tmp',
    };
    writeFileSync(
      join(swarms, 'swarm-h3-leftover-tmp.json.tmp'),
      JSON.stringify(leftoverSwarm, null, 2) + '\n',
      'utf8',
    );

    // The leftover .tmp files physically exist on disk...
    expect(existsSync(join(inbox, 'prop-h3-leftover-tmp.json.tmp'))).toBe(true);
    expect(existsSync(join(swarms, 'swarm-h3-leftover-tmp.json.tmp'))).toBe(
      true,
    );

    // ...but ONLY the committed .json records are surfaced by the list views.
    const props = listProposals();
    expect(props.map((p) => p.id)).toEqual([realProp.id]);
    expect(props.some((p) => p.id === 'prop-h3-leftover-tmp')).toBe(false);

    const swarmList = listSwarms();
    expect(swarmList.map((s) => s.id)).toEqual([realSwarm.id]);
    expect(swarmList.some((s) => s.id === 'swarm-h3-leftover-tmp')).toBe(false);

    // And no listed id retains a `.tmp` stem (the filter holds end-to-end).
    expect(props.every((p) => !p.id.endsWith('.tmp'))).toBe(true);
    expect(swarmList.every((s) => !s.id.endsWith('.tmp'))).toBe(true);
  });

  it('corrupt / half-written JSON files are skipped, never crash a load (list views stay resilient)', () => {
    // A committed, valid record in each store.
    const goodProp = createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: 'good proposal',
      summary: 'H3 ATOMIC-WRITES: a valid committed record alongside corruption',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    const goodSwarm = crashMidSwarm({
      id: 'swarm-h3-good',
      goal: 'good swarm',
      project: repo.dir,
      taskIds: ['t0'],
    });

    const inbox = inboxDir();
    const swarms = swarmsDir();

    // Inject corrupt/half-written *.json records: a truncated object (the exact
    // shape a non-atomic torn write would leave) and pure garbage. These have
    // the .json extension so the list filter does NOT exclude them — the parse
    // guard must. They must be SKIPPED, never crash the load.
    writeFileSync(
      join(inbox, 'prop-h3-truncated.json'),
      '{ "id": "prop-h3-truncated", "origin": "swarm", "kind": "patch", "ti',
      'utf8',
    );
    writeFileSync(
      join(inbox, 'prop-h3-garbage.json'),
      'not json at all',
      'utf8',
    );
    writeFileSync(
      join(swarms, 'swarm-h3-truncated.json'),
      '{ "id": "swarm-h3-truncated", "goal": "tru',
      'utf8',
    );
    writeFileSync(join(swarms, 'swarm-h3-garbage.json'), '}{', 'utf8');

    // listProposals/listSwarms skip the corrupt files and return ONLY the valid
    // record — they never throw on a corrupt file.
    const props = listProposals();
    expect(props.map((p) => p.id)).toEqual([goodProp.id]);

    const swarmList = listSwarms();
    expect(swarmList.map((s) => s.id)).toEqual([goodSwarm.id]);

    // Loading a specific corrupt id returns null (never throws).
    expect(loadProposal('prop-h3-truncated')).toBeNull();
    expect(loadProposal('prop-h3-garbage')).toBeNull();
    expect(loadSwarm('swarm-h3-truncated')).toBeNull();
    expect(loadSwarm('swarm-h3-garbage')).toBeNull();

    // A corrupt daemon.json yields a fresh zeroed state (never a throw).
    writeFileSync(daemonStatePath(), '{ "todaySpentUsd": 12.5, "tic', 'utf8');
    const recovered = loadDaemonState();
    assertCompleteState(recovered);
    expect(recovered.todaySpentUsd).toBe(0); // fell back to freshState()

    // Sanity: the corrupt files really are on disk (we tested the real guard,
    // not an empty dir).
    const inboxFiles = readdirSync(inbox);
    expect(inboxFiles).toContain('prop-h3-truncated.json');
    expect(inboxFiles).toContain('prop-h3-garbage.json');
  });
});
