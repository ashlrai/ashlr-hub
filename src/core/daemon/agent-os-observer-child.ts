/** Isolated runtime entrypoint for one bounded Agent OS observation attempt. */

import { fileURLToPath } from 'node:url';

import { loadConfigReadOnlyStrict } from '../config.js';
import { canonicalFilesystemPathIdentity, killSwitchOn } from '../sandbox/policy.js';
import type { DaemonTick } from '../types.js';
import { loadDaemonStateStrict } from './state.js';
import {
  completeAgentOsObserverAttemptV1,
  defaultAgentOsObserverAttemptStoreDependenciesV1,
} from '../vision/agent-os-observer-attempt-store.js';
import {
  observeAgentOsSourceBundleV1,
  type AgentOsObserverDependenciesV1,
} from '../vision/agent-os-observer.js';
import {
  defaultAgentOsSnapshotStoreDependenciesV1,
} from '../vision/agent-os-snapshot-store.js';
import {
  defaultAgentOsSourceBundleStoreDependenciesV1,
  readAgentOsSourceBundleStoreV1,
  withCurrentAgentOsSourceBundleLeaseV1,
  type AgentOsCurrentSourceLeaseResultV1,
  type AgentOsSourceBundleStoreDependenciesV1,
  type AgentOsSourceBundleStoreReadResultV1,
} from '../vision/agent-os-source-bundle-store.js';
import { agentOsSourceTrustPolicyDigestV1 } from '../vision/agent-os-source-bundle.js';
import {
  agentOsDurableTickDigestV1,
  agentOsObserverAttemptIdForTickV1,
  resolveAgentOsObserverConfigV1,
} from './agent-os-observer-scheduler.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export interface AgentOsObserverChildDependenciesV1 {
  loadConfig?: typeof loadConfigReadOnlyStrict;
  killSwitchOn?: () => boolean;
  observe?: typeof observeAgentOsSourceBundleV1;
  completeAttempt?: typeof completeAgentOsObserverAttemptV1;
  attemptStore?: () => ReturnType<typeof defaultAgentOsObserverAttemptStoreDependenciesV1>;
  snapshotStore?: () => ReturnType<typeof defaultAgentOsSnapshotStoreDependenciesV1>;
  sourceStore?: () => ReturnType<typeof defaultAgentOsSourceBundleStoreDependenciesV1>;
  readSource?: (
    dependencies: AgentOsSourceBundleStoreDependenciesV1,
  ) => AgentOsSourceBundleStoreReadResultV1;
  readDurableTicks?: () => readonly DaemonTick[] | null;
  withCurrentSource?: <T>(
    expectedBundleDigest: string,
    dependencies: AgentOsSourceBundleStoreDependenciesV1,
    consume: (current: AgentOsSourceBundleStoreReadResultV1['current']) => T,
  ) => AgentOsCurrentSourceLeaseResultV1<T>;
  clock?: () => Date;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/**
 * Read, verify, and observe only the current signed bundle. No source is
 * synthesized when the registry, trust policy, or current envelope is absent.
 */
export function runAgentOsObserverChildV1(
  args: readonly string[] = process.argv.slice(2),
  dependencies: AgentOsObserverChildDependenciesV1 = {},
  signal?: AbortSignal,
): number {
  try {
    const [attemptId, tickDigest, tickAt, deadlineAt, expectedBundleDigest, expectedPolicyDigest] = args;
    if (!attemptId || !UUID_V4_RE.test(attemptId) || !tickDigest || !DIGEST_RE.test(tickDigest) ||
      !timestamp(tickAt) || !timestamp(deadlineAt) || Date.parse(tickAt) >= Date.parse(deadlineAt) ||
      !expectedBundleDigest || !DIGEST_RE.test(expectedBundleDigest) ||
      !expectedPolicyDigest || !DIGEST_RE.test(expectedPolicyDigest) ||
      agentOsObserverAttemptIdForTickV1(tickDigest) !== attemptId) return 1;

    const load = dependencies.loadConfig ?? loadConfigReadOnlyStrict;
    const config = load();
    const resolved = resolveAgentOsObserverConfigV1(config);
    if (!resolved.enabled || !resolved.valid || !resolved.trustPolicy ||
      resolved.trustPolicyDigest !== expectedPolicyDigest) return 1;
    const clock = dependencies.clock ?? (() => new Date());
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return 1;
    const killIsOn = dependencies.killSwitchOn ?? killSwitchOn;
    if (signal?.aborted || killIsOn()) return 1;

    const sourceBase = (dependencies.sourceStore ?? defaultAgentOsSourceBundleStoreDependenciesV1)();
    const attemptStore = (dependencies.attemptStore ?? (() =>
      defaultAgentOsObserverAttemptStoreDependenciesV1('write')))();
    if (!sourceBase || !attemptStore) return 1;
    const durableTicks = dependencies.readDurableTicks
      ? dependencies.readDurableTicks()
      : (() => {
          const loaded = loadDaemonStateStrict();
          return loaded.ok ? loaded.state.ticks : null;
        })();
    const durableTickPresent = durableTicks?.some((tick) =>
      tick.ts === tickAt && tick.reason === 'ok' && tick.dryRun !== true &&
      agentOsDurableTickDigestV1(tick) === tickDigest) === true;
    // Attempt receipts record lifecycle state; they deliberately grant no tick
    // admission authority. If the exact successful non-dry tick has aged out of
    // bounded daemon history, recovery degrades instead of upgrading a generic
    // authenticated start receipt into provenance.
    if (!durableTickPresent) return 1;
    const source = (dependencies.readSource ?? readAgentOsSourceBundleStoreV1)({
      ...sourceBase,
      trustPolicy: resolved.trustPolicy,
      clock,
    });
    const currentEnvelope = source.bundles.at(-1);
    const expectedEnvelope = source.bundles.find((entry) => entry.bundleDigest === expectedBundleDigest);
    if (source.sourceState !== 'healthy' || !source.complete || !source.current || !currentEnvelope ||
      !expectedEnvelope || currentEnvelope.bundleDigest !== source.current.bundleDigest) return 1;

    // A crash-left start can outlive the source that initiated it. Close that
    // exact authenticated binding before considering current-source work; never
    // synthesize a replacement deadline or publish a snapshot from stale input.
    if (source.current.bundleDigest !== expectedBundleDigest) {
      const completedAt = now.getTime() >= Date.parse(deadlineAt)
        ? now
        : new Date(Math.max(now.getTime(), Date.parse(tickAt)));
      const recovered = (dependencies.completeAttempt ?? completeAgentOsObserverAttemptV1)({
        attemptId,
        initiatingTickDigest: tickDigest,
        initiatingTickAt: tickAt,
        bundleDigest: expectedBundleDigest,
        startedAt: tickAt,
        deadlineAt,
        outcome: now.getTime() >= Date.parse(deadlineAt)
          ? 'deadline-before-commit'
          : 'cancelled-before-commit',
        snapshotDigest: null,
        snapshotEnvelopeDigest: null,
        snapshotEnvelopeSequence: null,
        completedAt: completedAt.toISOString(),
      }, attemptStore);
      return recovered.disposition === 'recorded' || recovered.disposition === 'replayed' ? 0 : 1;
    }

    const snapshotStore = (dependencies.snapshotStore ?? (() =>
      defaultAgentOsSnapshotStoreDependenciesV1('write')))();
    if (!snapshotStore) return 1;

    const stillAuthorizedToObserve = (): boolean => {
      if (signal?.aborted || killIsOn()) return false;
      try {
        const fresh = resolveAgentOsObserverConfigV1(load());
        if (!fresh.enabled || !fresh.valid || fresh.trustPolicy === null ||
          fresh.trustPolicyDigest !== expectedPolicyDigest ||
          agentOsSourceTrustPolicyDigestV1(fresh.trustPolicy) !== expectedPolicyDigest) return false;
        const current = (dependencies.readSource ?? readAgentOsSourceBundleStoreV1)({
          ...sourceBase,
          trustPolicy: fresh.trustPolicy,
          clock,
        });
        const envelope = current.bundles.at(-1);
        return current.sourceState === 'healthy' && current.complete && current.current !== null &&
          envelope !== undefined && current.current.bundleDigest === expectedBundleDigest &&
          envelope.bundleDigest === expectedBundleDigest;
      } catch {
        return false;
      }
    };
    const observerDependencies: AgentOsObserverDependenciesV1 = {
      sourceTrustPolicy: resolved.trustPolicy,
      attemptStore,
      snapshotStore,
      clock,
      killCheck: () => !stillAuthorizedToObserve(),
      ...(signal ? { signal } : {}),
    };
    const leased = (dependencies.withCurrentSource ?? withCurrentAgentOsSourceBundleLeaseV1)(
      expectedBundleDigest,
      { ...sourceBase, trustPolicy: resolved.trustPolicy, clock },
      () => (dependencies.observe ?? observeAgentOsSourceBundleV1)({
        attemptId,
        initiatingTickDigest: tickDigest,
        initiatingTickAt: tickAt,
        deadlineAt,
        sourceBundle: currentEnvelope,
      }, observerDependencies),
    );
    if (leased.state !== 'held') return 1;
    const observed = leased.value;
    return (observed.disposition === 'completed' || observed.disposition === 'replayed') &&
      observed.terminalPersisted
      ? 0
      : 1;
  } catch {
    return 1;
  }
}

function invokedAsEntrypoint(invokedEntry: string | undefined): boolean {
  if (!invokedEntry || process.env['ASHLR_AGENT_OS_OBSERVER_CHILD'] !== '1') return false;
  try {
    const invokedIdentity = canonicalFilesystemPathIdentity(invokedEntry);
    const moduleIdentity = canonicalFilesystemPathIdentity(fileURLToPath(import.meta.url));
    return invokedIdentity !== null && moduleIdentity !== null && invokedIdentity === moduleIdentity;
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint(process.argv[1])) {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  process.exitCode = runAgentOsObserverChildV1(process.argv.slice(2), {}, controller.signal);
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
