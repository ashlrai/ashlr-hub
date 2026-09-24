/**
 * Daemon-side capacity publisher — V3.10 review finding c8.
 *
 * Every paid-seat decision the standing daemon makes (tick-hooks-live's
 * seatAllows / route, G6's judge lanes, G5's red team) reads the capacity
 * snapshot at ~/.ashlr/routing/capacity.json, and `assessSeat` treats a
 * reading older than 15 min as UNKNOWN usage (ineligible). Before this module
 * the only writer was the Verse server's `startBudgetCapacityPublisher`, so
 * 15 minutes after Mason quit the desktop app (or after any reboot, where
 * launchd restarts ai.ashlr.daemon but not the app) every paid seat went dark
 * and the "24/7" fleet stopped judging and merging — silently.
 *
 * What this does instead, from inside the daemon process:
 *
 *   - Another publisher's snapshot is FRESH (≤ FOREIGN_FRESH_MS old and not
 *     one we wrote) ⇒ the Verse server is live and publishing: stay dormant.
 *     One writer at a time; the Verse server always wins because it also
 *     serves the UI from the same collector.
 *   - Otherwise (cold, or our own write is due) ⇒ start a SHORT-LIVED account
 *     collector. `startVerseAccountCollector` acquires the existing exclusive
 *     per-root native-metadata lease; we publish ONLY when this process owns
 *     it (mode 'owned') — the lease is what makes us the single native
 *     writer. A refused lease (resource-console, or a Verse that starts in the
 *     same instant) ⇒ no write, fail closed.
 *   - Wait for the collector's first sample cycle, publish through the budget
 *     API's own capacity source (same seat identity, same telemetry, same
 *     snapshot codec), then CLOSE the collector — releasing the lease between
 *     samples, so a Verse server that starts later normally finds it free and
 *     owns live collection itself.
 *
 * Fail closed while cold: nothing here ever writes a reading it did not just
 * observe, and until the first publish lands the snapshot stays stale, so
 * every paid seat stays ineligible. Every probe the collector runs is
 * metadata-only (zero tokens, zero paid quota) — the same probes the Verse
 * server runs every 30 s; here they run at most once per SAMPLE_EVERY_MS.
 *
 * Every snapshot this process sees fresh — its own publish, or the Verse
 * server's while dormant — is also appended to the seat capacity history
 * (routing/capacity-history.ts, 3.10.1) so Command's burn-downs keep the
 * whole window; that write never affects the publisher's state, and the
 * store makes it a no-op under ASHLR_CAPACITY_HISTORY=0.
 *
 * Started lazily (ensureDaemonCapacityPublisher) by the standing merge pass,
 * which runs every standing tick BEFORE beforeTick / dispatch. It refuses to
 * start outside a daemon process (ASHLR_IN_DAEMON=1) and under vitest, so a
 * test or an interactive CLI command never spawns native probes.
 */
import type { AshlrConfig } from '../types.js';
import { readCapacitySnapshot, type CapacitySnapshot } from '../routing/budget-store.js';
import { recordCapacityHistoryFromSnapshot } from '../routing/capacity-history.js';

/** Another publisher (Verse, every 60 s) counts as live while its snapshot is this fresh. */
export const FOREIGN_FRESH_MS = 3 * 60_000;
/** Our own cadence: well inside the 15-minute reading staleness limit (headroom.ts). */
export const SAMPLE_EVERY_MS = 5 * 60_000;
/** How often the publisher re-checks (cheap: one small private-file read). */
export const CHECK_EVERY_MS = 60_000;
/** Longest we hold the lease waiting for one sample cycle (Claude's probe alone may take 20 s). */
export const SAMPLE_TIMEOUT_MS = 90_000;
const SAMPLE_POLL_MS = 2_000;

/** The slice of VerseAccountCollector this module uses (tests inject fakes). */
export interface PublisherCollector {
  status(): { mode: 'owned' | 'read-only' | 'unconfigured'; reasonCode: string | null };
  connections(): { refreshing: boolean } | null;
  close(): Promise<void>;
}

export interface DaemonCapacityPublisherDeps {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  readSnapshot(): CapacitySnapshot | null;
  startCollector(cfg: AshlrConfig): Promise<PublisherCollector>;
  /** Publish through `collector`; resolves to the snapshot's publishedAt. */
  publish(cfg: AshlrConfig, collector: PublisherCollector): Promise<string>;
  log(message: string): void;
  /**
   * Append `snapshot`'s readings to the seat capacity history (3.10.1,
   * routing/capacity-history.ts). Returns why nothing could be written, or
   * null. Optional so a harness without it records nothing.
   */
  recordHistory?(snapshot: CapacitySnapshot): string | null;
}

export type PublisherState =
  | 'idle'
  | 'dormant'
  | 'fresh'
  | 'published'
  | 'lease-held-elsewhere'
  | 'sample-timeout'
  | 'failed';

export interface PublisherStatus {
  state: PublisherState;
  /** Plain sentence; never a path or token. */
  reason: string;
  /** publishedAt of the last snapshot THIS process wrote; null = never. */
  lastPublishedAt: string | null;
}

export interface DaemonCapacityPublisher {
  /** One check (and, when due, one sample + publish). Never throws; single-flight. */
  cycle(): Promise<PublisherStatus>;
  status(): PublisherStatus;
  start(): void;
  stop(): void;
}

function ageMs(iso: string, nowMs: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
}

export function createDaemonCapacityPublisher(cfg: AshlrConfig, deps: DaemonCapacityPublisherDeps): DaemonCapacityPublisher {
  let status: PublisherStatus = { state: 'idle', reason: 'the daemon has not checked the capacity snapshot yet', lastPublishedAt: null };
  let inFlight: Promise<PublisherStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let historyError: string | null = null;

  const set = (state: PublisherState, reason: string): PublisherStatus => {
    status = { state, reason, lastPublishedAt: status.lastPublishedAt };
    return status;
  };

  /**
   * Seat capacity history (3.10.1): every snapshot this process sees fresh —
   * its own publish, or the Verse server's while dormant — goes to the rolling
   * history, so Command's burn-downs survive a reload. The store drops a
   * reading it already holds, so recording the Verse server's snapshot here
   * AND in the Verse server is harmless. Never throws; a failure is logged
   * once per distinct error and never changes the publisher's state.
   */
  function recordHistory(snapshot: CapacitySnapshot): void {
    if (!deps.recordHistory) return;
    let error: string | null;
    try {
      error = deps.recordHistory(snapshot);
    } catch (err) {
      error = err instanceof Error ? err.message : 'unknown error';
    }
    if (error !== null && error !== historyError) {
      try { deps.log(`daemon capacity publisher: capacity history was not recorded (${error})`); } catch { /* never throws */ }
    }
    historyError = error;
  }

  async function waitForFirstSample(collector: PublisherCollector): Promise<boolean> {
    const deadline = deps.nowMs() + SAMPLE_TIMEOUT_MS;
    for (;;) {
      let conn: { refreshing: boolean } | null;
      try {
        conn = collector.connections();
      } catch {
        return false;
      }
      // No connection monitor configured (quota only): nothing to wait for.
      if (conn === null || !conn.refreshing) return true;
      if (stopped || deps.nowMs() >= deadline) return false;
      await deps.sleep(SAMPLE_POLL_MS);
    }
  }

  async function runCycle(): Promise<PublisherStatus> {
    const now = deps.nowMs();
    let snapshot: CapacitySnapshot | null = null;
    try {
      snapshot = deps.readSnapshot();
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const age = ageMs(snapshot.publishedAt, now);
      const ours = status.lastPublishedAt !== null && snapshot.publishedAt === status.lastPublishedAt;
      if (!ours && age <= FOREIGN_FRESH_MS) {
        recordHistory(snapshot);
        return set('dormant', 'another publisher (the Verse server) keeps the capacity snapshot fresh');
      }
      if (ours && age < SAMPLE_EVERY_MS) return set('fresh', 'this daemon published the capacity snapshot recently');
    }

    let collector: PublisherCollector;
    try {
      collector = await deps.startCollector(cfg);
    } catch (error) {
      return set('failed', `the account collector could not start (${error instanceof Error ? error.message : 'unknown error'}); paid seats stay ineligible`);
    }
    try {
      const collectorStatus = collector.status();
      if (collectorStatus.mode !== 'owned') {
        // Without the lease this process is not the native writer. Publishing
        // shared-evidence readings here could race the owner — stay cold.
        return set(
          'lease-held-elsewhere',
          `the native account-metadata lease is not available to the daemon (${collectorStatus.reasonCode ?? collectorStatus.mode}); paid seats stay ineligible until a publisher runs`,
        );
      }
      if (!(await waitForFirstSample(collector))) {
        return set('sample-timeout', 'the account collector did not finish a sample in time; nothing was published');
      }
      if (stopped) return set('idle', 'the publisher stopped before publishing');
      const publishedAt = await deps.publish(cfg, collector);
      status = { state: 'published', reason: 'this daemon published a fresh capacity snapshot (no Verse server was publishing)', lastPublishedAt: publishedAt };
      // Record exactly what was published: re-read it, and only when it is
      // still ours (another writer may have replaced it in between).
      let written: CapacitySnapshot | null = null;
      try {
        written = deps.readSnapshot();
      } catch {
        written = null;
      }
      if (written && written.publishedAt === publishedAt) recordHistory(written);
      return status;
    } catch (error) {
      return set('failed', `the capacity snapshot could not be published (${error instanceof Error ? error.message : 'unknown error'}); paid seats stay ineligible`);
    } finally {
      // Release the lease between samples: a Verse server started later then
      // finds it free and owns live collection (and the UI's readings).
      try {
        await collector.close();
      } catch {
        // An `uncertain` cleanup still releases the lease (accounts.ts close()).
      }
    }
  }

  function cycle(): Promise<PublisherStatus> {
    if (inFlight) return inFlight;
    const previous = status.state;
    inFlight = runCycle()
      .catch(() => set('failed', 'the capacity publisher failed unexpectedly'))
      .then((result) => {
        // Log transitions only (a steady dormant/fresh state is not news).
        if (result.state !== previous && result.state !== 'fresh' && result.state !== 'dormant') {
          deps.log(`daemon capacity publisher: ${result.reason}`);
        }
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    cycle,
    status: () => status,
    start(): void {
      if (timer || stopped) return;
      timer = setInterval(() => { void cycle(); }, CHECK_EVERY_MS);
      timer.unref?.();
      void cycle();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * The production wiring (exported so tests exercise THIS object, not a copy
 * of it — e.g. that `recordHistory` is wired, since the deps field is
 * optional and a missing one would fail silently). Building it has no side
 * effects: the collector and the budget API load only when called.
 */
export function defaultDaemonCapacityPublisherDeps(): DaemonCapacityPublisherDeps {
  return {
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
    readSnapshot: () => readCapacitySnapshot(),
    startCollector: async (cfg) => {
      const [{ startVerseAccountCollector }, { resolveAccountsRoot }] = await Promise.all([
        import('../verse/accounts.js'),
        import('../verse/seats.js'),
      ]);
      return startVerseAccountCollector({
        accountsRoot: resolveAccountsRoot(cfg),
        // Closed right after one cycle; the minimum idle window keeps the
        // collector from suspending mid-sample.
        idleSuspendMs: 60_000,
      });
    },
    publish: async (cfg, collector) => {
      const { publishCapacitySnapshotFrom } = await import('../routing/budget-api.js');
      return publishCapacitySnapshotFrom(cfg, collector as unknown as import('../verse/accounts.js').VerseAccountCollector);
    },
    log: (message) => { console.warn(`[ashlr] ${message}`); },
    recordHistory: (snapshot) => recordCapacityHistoryFromSnapshot(snapshot, 'daemon').error,
  };
}

let singleton: DaemonCapacityPublisher | null = null;

/** Why the daemon-side publisher did not start in this process; null when it did (or may). */
export function daemonCapacityPublisherRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['ASHLR_IN_DAEMON'] !== '1') return 'not a daemon process';
  // Never spawn native probes from a test run, even one that drives runDaemon.
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return 'test process';
  if (env['ASHLR_DAEMON_CAPACITY_PUBLISHER'] === '0') return 'disabled by ASHLR_DAEMON_CAPACITY_PUBLISHER=0';
  return null;
}

/**
 * Start the process-wide daemon publisher once (idempotent, never throws).
 * Returns its current status, or null when this process must not publish.
 */
export function ensureDaemonCapacityPublisher(cfg: AshlrConfig): PublisherStatus | null {
  if (singleton) return singleton.status();
  if (daemonCapacityPublisherRefusal() !== null) return null;
  try {
    // The first standing tick's config is kept: the only thing read from it
    // is the accounts root and seat identity, which do not change mid-run.
    singleton = createDaemonCapacityPublisher(cfg, defaultDaemonCapacityPublisherDeps());
    singleton.start();
    return singleton.status();
  } catch {
    // Stays cold: readers of a stale snapshot fail closed.
    return null;
  }
}

/** Test hook: stop and forget the process singleton. */
export function resetDaemonCapacityPublisherForTest(): void {
  singleton?.stop();
  singleton = null;
}
