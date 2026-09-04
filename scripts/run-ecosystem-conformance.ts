import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  compileExternalEfficiencyReceipt,
  EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL,
} from '../src/core/fabric/external-efficiency-receipt.js';
import {
  compileExternalStackEffectPlanV1,
  STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
} from '../src/core/fabric/external-stack-effect-plan.js';
import {
  compileExternalStackObservationV1,
  STACK_OBSERVATION_MANIFEST_PROTOCOL,
} from '../src/core/fabric/external-stack-observation.js';

export const ECOSYSTEM_CONFORMANCE_PROTOCOL = 'ashlr-ecosystem-conformance-v1' as const;

const WORKER_TIMEOUT_MS = 5_000;
const MAX_CORE_FIXTURE_FILE_BYTES = 64 * 1024;
const MAX_PLUGIN_FIXTURE_FILE_BYTES = 64 * 1024;
const MAX_STACK_OBSERVATION_FILE_BYTES = 128 * 1024;
const MAX_STACK_EFFECT_FILE_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set([
  'accessToken', 'apiKey', 'authToken', 'content', 'credential', 'cwd', 'metadata',
  'password', 'path', 'privateKey', 'prompt', 'providerResourceId', 'repo', 'scopes',
  'secret', 'secretName', 'secretRef', 'secretValue', 'sessionId', 'token', 'toolInput',
  'toolOutput', 'url',
]);

export type EcosystemConformanceCheckState = 'pass' | 'fail' | 'unavailable';

export interface EcosystemConformanceChecksV1 {
  'producer-build-present': EcosystemConformanceCheckState;
  'protocol-compatible': EcosystemConformanceCheckState;
  'fixture-byte-identical': EcosystemConformanceCheckState;
  'Hub-accepted': EcosystemConformanceCheckState;
  'authority=false': EcosystemConformanceCheckState;
  'current-freshness': EcosystemConformanceCheckState;
}

export type FixtureProvenanceV1 = 'synthetic-test-vector' | 'released-source';
export type AcceptanceClockV1 = 'live' | 'explicit-historical';

export interface EcosystemConformanceOptionsV1 {
  coreEntryPath: string;
  coreFixturePath: string;
  coreFixtureFormat?: 'json' | 'hex';
  coreFixtureProvenance?: FixtureProvenanceV1;
  pluginEntryPath: string;
  pluginFixturePath: string;
  pluginFixtureFormat?: 'json' | 'hex';
  pluginFixtureProvenance?: FixtureProvenanceV1;
  stackEntryPath: string;
  stackObservationFixturePath: string;
  stackEffectFixturePath: string;
  stackFixtureProvenance?: FixtureProvenanceV1;
  stackNow?: Date;
}

interface ProducerInspection {
  buildPresent?: boolean;
  fixturePresent?: boolean;
  interfaceCompatible?: boolean;
  producerProtocol?: string | null;
  fixtureProtocol?: string | null;
  producerObservationProtocol?: string | null;
  producerEffectProtocol?: string | null;
  fixtureObservationProtocol?: string | null;
  fixtureEffectProtocol?: string | null;
  sourceVersion?: string | null;
  versionCompatible?: boolean;
  producerAccepted?: boolean;
  fixtureByteIdentical?: boolean;
  observationByteIdentical?: boolean;
  effectByteIdentical?: boolean;
  digestValid?: boolean;
  observationDigestValid?: boolean;
  effectDigestValid?: boolean;
  observationToEffectBound?: boolean;
  privacySafe?: boolean;
  digest?: string | null;
  observationDigest?: string | null;
  effectDigest?: string | null;
}

interface ExplicitFixture {
  available: boolean;
  bytes: Buffer | null;
  privacySafe: boolean;
}

interface ProductConformanceResult {
  state: EcosystemConformanceCheckState;
  checks: EcosystemConformanceChecksV1;
  evidence: Record<string, boolean | string | null>;
  acceptanceClock: AcceptanceClockV1;
  fixtureProvenance: FixtureProvenanceV1;
  currentFreshness: boolean | null;
  releaseReady: boolean;
}

export interface EcosystemConformanceReportV1 {
  schemaVersion: 1;
  protocol: typeof ECOSYSTEM_CONFORMANCE_PROTOCOL;
  mode: 'explicit-caller-paths';
  evaluatedAt: string;
  state: EcosystemConformanceCheckState;
  releaseReady: boolean;
  authority: false;
  effectAuthority: false;
  planningAuthority: false;
  executionAuthority: false;
  promotionAuthority: false;
  products: {
    coreEfficiency: ProductConformanceResult;
    plugin: ProductConformanceResult;
    stack: ProductConformanceResult;
  };
}

function unavailableReport(reason: 'explicit-inputs-required' | 'invalid-stack-now'):
EcosystemConformanceReportV1 & { reason: typeof reason } {
  const product = (): ProductConformanceResult => ({
    state: 'unavailable',
    checks: unavailableChecks(),
    evidence: {},
    acceptanceClock: 'live',
    fixtureProvenance: 'synthetic-test-vector',
    currentFreshness: null,
    releaseReady: false,
  });
  return {
    schemaVersion: 1,
    protocol: ECOSYSTEM_CONFORMANCE_PROTOCOL,
    mode: 'explicit-caller-paths',
    evaluatedAt: new Date().toISOString(),
    state: 'unavailable',
    releaseReady: false,
    authority: false,
    effectAuthority: false,
    planningAuthority: false,
    executionAuthority: false,
    promotionAuthority: false,
    products: { coreEfficiency: product(), plugin: product(), stack: product() },
    reason,
  };
}

function unavailableChecks(): EcosystemConformanceChecksV1 {
  return {
    'producer-build-present': 'unavailable',
    'protocol-compatible': 'unavailable',
    'fixture-byte-identical': 'unavailable',
    'Hub-accepted': 'unavailable',
    'authority=false': 'unavailable',
    'current-freshness': 'unavailable',
  };
}

function stateOf(checks: EcosystemConformanceChecksV1): EcosystemConformanceCheckState {
  const values = Object.values(checks);
  if (values.includes('fail')) return 'fail';
  if (values.includes('unavailable')) return 'unavailable';
  return 'pass';
}

function privacySafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') {
    return !/^(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:[\\/])/u.test(value) &&
      !/^session(?:id)?[_:-]/iu.test(value);
  }
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => privacySafe(entry, seen));
    return Object.entries(value).every(([key, entry]) =>
      !FORBIDDEN_KEYS.has(key) && privacySafe(entry, seen));
  } finally {
    seen.delete(value);
  }
}

function parsePrivacySafe(bytes: Uint8Array): boolean {
  try {
    return privacySafe(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
  } catch {
    return false;
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer | null> {
  if (!isAbsolute(path)) return null;
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) return null;
    const bytes = await handle.readFile();
    return bytes.length <= maximum ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function explicitFixture(
  path: string,
  maximum: number,
  format: 'json' | 'hex' = 'json',
): Promise<ExplicitFixture> {
  const encoded = await readBounded(path, format === 'hex' ? maximum * 3 : maximum);
  if (!encoded) return { available: false, bytes: null, privacySafe: false };
  let bytes = encoded;
  if (format === 'hex') {
    const text = encoded.toString('ascii').trim();
    if (text.length < 2 || text.length % 2 !== 0 || !/^[a-f0-9]+$/u.test(text)) {
      return { available: false, bytes: null, privacySafe: false };
    }
    bytes = Buffer.from(text, 'hex');
  }
  if (bytes.length > maximum) return { available: false, bytes: null, privacySafe: false };
  return { available: true, bytes, privacySafe: parsePrivacySafe(bytes) };
}

async function inspectInWorker(workerData: Record<string, unknown>): Promise<ProducerInspection> {
  const requestedEntryPath = typeof workerData['entryPath'] === 'string'
    ? workerData['entryPath']
    : '';
  let entryPath: string;
  try {
    entryPath = await realpath(requestedEntryPath);
  } catch {
    return { buildPresent: false };
  }
  const resolvedWorkerData = { ...workerData, entryPath };
  return new Promise((resolve) => {
    const workerUrl = new URL('./ecosystem-conformance-producer-worker.mjs', import.meta.url);
    const worker = new Worker(
      workerUrl,
      {
        workerData: resolvedWorkerData,
        env: {},
        argv: [],
        // The producer adapter can read only its own source and the one caller-supplied
        // compiled entry. Node's permission model denies filesystem writes and child
        // processes inside the producer isolation boundary.
        execArgv: [
          '--permission',
          `--allow-fs-read=${fileURLToPath(workerUrl)}`,
          `--allow-fs-read=${entryPath}`,
        ],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      },
    );
    let settled = false;
    const finish = (value: ProducerInspection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ buildPresent: false }), WORKER_TIMEOUT_MS);
    worker.once('message', (message: unknown) => {
      finish(message && typeof message === 'object' ? message as ProducerInspection : { buildPresent: false });
    });
    worker.once('error', () => finish({ buildPresent: false }));
    worker.once('exit', (code) => {
      if (code !== 0) finish({ buildPresent: false });
    });
  });
}

function falseAuthority(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  for (const [key, entry] of entries) {
    if (key === 'authority') {
      if (entry !== false && entry !== 'observation-only') return false;
      continue;
    }
    if (/(?:Authority|Eligible)$/u.test(key) ||
      ['approved', 'authenticated', 'effectPerformed', 'performed', 'trusted'].includes(key)) {
      if (entry !== false) return false;
      continue;
    }
    if (key === 'effects' && entry && typeof entry === 'object') {
      if (!Object.values(entry).every((flag) => flag === false)) return false;
    }
  }
  return true;
}

function coreResult(
  producer: ProducerInspection,
  fixture: ExplicitFixture,
  provenance: FixtureProvenanceV1,
): ProductConformanceResult {
  if (producer.buildPresent !== true || !fixture.available || !fixture.bytes) {
    const checks = unavailableChecks();
    if (producer.buildPresent === true) checks['producer-build-present'] = 'pass';
    return { state: stateOf(checks), checks, acceptanceClock: 'live',
      fixtureProvenance: provenance, currentFreshness: null, releaseReady: false, evidence: {
      producerProtocol: producer.producerProtocol ?? null,
      HubProtocol: EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL,
      sourceVersion: producer.sourceVersion ?? null,
      versionCompatible: null,
      digest: null,
      privacySafe: null,
    } };
  }
  const hub = compileExternalEfficiencyReceipt(fixture.bytes);
  const protocolCompatible = producer.interfaceCompatible === true &&
    producer.producerProtocol === EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL &&
    producer.fixtureProtocol === EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL &&
    producer.versionCompatible === true;
  const byteIdentical = producer.fixtureByteIdentical === true &&
    producer.digestValid === true && producer.privacySafe === true && fixture.privacySafe;
  const hubAccepted = hub.state === 'accepted';
  const authorityFalse = hubAccepted && falseAuthority(hub);
  const checks: EcosystemConformanceChecksV1 = {
    'producer-build-present': 'pass',
    'protocol-compatible': protocolCompatible ? 'pass' : 'fail',
    'fixture-byte-identical': byteIdentical ? 'pass' : 'fail',
    'Hub-accepted': hubAccepted ? 'pass' : 'fail',
    'authority=false': authorityFalse ? 'pass' : 'unavailable',
    'current-freshness': hubAccepted ? 'pass' : 'fail',
  };
  const state = stateOf(checks);
  return {
    state,
    checks,
    acceptanceClock: 'live',
    fixtureProvenance: provenance,
    currentFreshness: hubAccepted,
    releaseReady: state === 'pass' && provenance === 'released-source',
    evidence: {
      producerProtocol: producer.producerProtocol ?? null,
      HubProtocol: EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL,
      sourceVersion: producer.sourceVersion ?? null,
      versionCompatible: producer.versionCompatible === true,
      digest: producer.digest ?? null,
      digestValid: producer.digestValid === true,
      producerAccepted: producer.producerAccepted === true,
      privacySafe: producer.privacySafe === true && fixture.privacySafe,
    },
  };
}

function pluginResult(
  producer: ProducerInspection,
  fixture: ExplicitFixture,
  provenance: FixtureProvenanceV1,
): ProductConformanceResult {
  if (producer.buildPresent !== true || !fixture.available || !fixture.bytes) {
    const checks = unavailableChecks();
    if (producer.buildPresent === true) checks['producer-build-present'] = 'pass';
    return { state: stateOf(checks), checks, acceptanceClock: 'live',
      fixtureProvenance: provenance, currentFreshness: null, releaseReady: false, evidence: {
        producerProtocol: producer.producerProtocol ?? null,
        HubProtocol: EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL,
        sourceVersion: producer.sourceVersion ?? null,
        versionCompatible: null,
        digest: null,
        privacySafe: null,
      } };
  }
  const hub = compileExternalEfficiencyReceipt(fixture.bytes);
  const protocolCompatible = producer.interfaceCompatible === true &&
    producer.producerProtocol === EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL &&
    producer.fixtureProtocol === EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL &&
    producer.versionCompatible === true;
  const byteIdentical = producer.fixtureByteIdentical === true &&
    producer.digestValid === true && producer.privacySafe === true && fixture.privacySafe;
  const hubAccepted = hub.state === 'accepted' && hub.sourceProduct === 'ashlr-plugin';
  const authorityFalse = hubAccepted && falseAuthority(hub);
  const checks: EcosystemConformanceChecksV1 = {
    'producer-build-present': 'pass',
    'protocol-compatible': protocolCompatible ? 'pass' : 'fail',
    'fixture-byte-identical': byteIdentical ? 'pass' : 'fail',
    'Hub-accepted': hubAccepted ? 'pass' : 'fail',
    'authority=false': authorityFalse ? 'pass' : 'unavailable',
    'current-freshness': hubAccepted ? 'pass' : 'fail',
  };
  const state = stateOf(checks);
  return {
    state,
    checks,
    acceptanceClock: 'live',
    fixtureProvenance: provenance,
    currentFreshness: hubAccepted,
    releaseReady: state === 'pass' && provenance === 'released-source',
    evidence: {
      producerProtocol: producer.producerProtocol ?? null,
      HubProtocol: EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL,
      sourceVersion: producer.sourceVersion ?? null,
      versionCompatible: producer.versionCompatible === true,
      digest: producer.digest ?? null,
      digestValid: producer.digestValid === true,
      producerAccepted: producer.producerAccepted === true,
      privacySafe: producer.privacySafe === true && fixture.privacySafe,
    },
  };
}

function stackResult(
  producer: ProducerInspection,
  observationFixture: ExplicitFixture,
  effectFixture: ExplicitFixture,
  acceptanceNow: Date,
  evaluatedAt: Date,
  acceptanceClock: AcceptanceClockV1,
  provenance: FixtureProvenanceV1,
): ProductConformanceResult {
  if (producer.buildPresent !== true || !observationFixture.available || !observationFixture.bytes ||
    !effectFixture.available || !effectFixture.bytes) {
    const checks = unavailableChecks();
    if (producer.buildPresent === true) checks['producer-build-present'] = 'pass';
    return { state: stateOf(checks), checks, acceptanceClock,
      fixtureProvenance: provenance, currentFreshness: null, releaseReady: false, evidence: {
      producerObservationProtocol: producer.producerObservationProtocol ?? null,
      HubObservationProtocol: STACK_OBSERVATION_MANIFEST_PROTOCOL,
      producerEffectProtocol: producer.producerEffectProtocol ?? null,
      HubEffectProtocol: STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
      sourceVersion: producer.sourceVersion ?? null,
      versionCompatible: null,
      observationToEffectBound: null,
      privacySafe: null,
    } };
  }
  const observation = compileExternalStackObservationV1(observationFixture.bytes, acceptanceNow);
  const effect = compileExternalStackEffectPlanV1(effectFixture.bytes, acceptanceNow);
  const currentObservation = compileExternalStackObservationV1(observationFixture.bytes, evaluatedAt);
  const currentEffect = compileExternalStackEffectPlanV1(effectFixture.bytes, evaluatedAt);
  const protocolCompatible = producer.interfaceCompatible === true &&
    producer.producerObservationProtocol === STACK_OBSERVATION_MANIFEST_PROTOCOL &&
    producer.fixtureObservationProtocol === STACK_OBSERVATION_MANIFEST_PROTOCOL &&
    producer.producerEffectProtocol === STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL &&
    producer.fixtureEffectProtocol === STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL &&
    producer.versionCompatible === true;
  const byteIdentical = producer.observationByteIdentical === true &&
    producer.effectByteIdentical === true && producer.observationDigestValid === true &&
    producer.effectDigestValid === true && producer.privacySafe === true &&
    observationFixture.privacySafe && effectFixture.privacySafe;
  const hubBound = observation.ok && effect.ok && producer.observationToEffectBound === true &&
    effect.plan.observationManifestDigest === observation.observation.manifestDigest &&
    effect.plan.source.version === observation.observation.source.version &&
    effect.plan.source.commit === observation.observation.source.commit;
  const hubAccepted = observation.ok && effect.ok && hubBound;
  const currentBound = currentObservation.ok && currentEffect.ok &&
    currentEffect.plan.observationManifestDigest === currentObservation.observation.manifestDigest &&
    currentEffect.plan.source.version === currentObservation.observation.source.version &&
    currentEffect.plan.source.commit === currentObservation.observation.source.commit;
  const currentFreshness = currentObservation.ok && currentEffect.ok && currentBound;
  const authorityFalse = hubAccepted && falseAuthority(observation.observation) && falseAuthority(effect.plan);
  const checks: EcosystemConformanceChecksV1 = {
    'producer-build-present': 'pass',
    'protocol-compatible': protocolCompatible ? 'pass' : 'fail',
    'fixture-byte-identical': byteIdentical ? 'pass' : 'fail',
    'Hub-accepted': hubAccepted ? 'pass' : 'fail',
    'authority=false': authorityFalse ? 'pass' : 'unavailable',
    'current-freshness': currentFreshness ? 'pass' : 'fail',
  };
  const state = stateOf(checks);
  return {
    state,
    checks,
    acceptanceClock,
    fixtureProvenance: provenance,
    currentFreshness,
    releaseReady: state === 'pass' && acceptanceClock === 'live' &&
      provenance === 'released-source',
    evidence: {
      producerObservationProtocol: producer.producerObservationProtocol ?? null,
      HubObservationProtocol: STACK_OBSERVATION_MANIFEST_PROTOCOL,
      producerEffectProtocol: producer.producerEffectProtocol ?? null,
      HubEffectProtocol: STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
      sourceVersion: producer.sourceVersion ?? null,
      versionCompatible: producer.versionCompatible === true,
      observationDigest: producer.observationDigest ?? null,
      effectDigest: producer.effectDigest ?? null,
      observationToEffectBound: hubBound,
      producerAccepted: producer.producerAccepted === true,
      privacySafe: producer.privacySafe === true && observationFixture.privacySafe &&
        effectFixture.privacySafe,
    },
  };
}

export async function runEcosystemConformanceV1(
  options: EcosystemConformanceOptionsV1,
): Promise<EcosystemConformanceReportV1> {
  const evaluatedAt = new Date();
  const stackNow = options.stackNow ?? evaluatedAt;
  const stackAcceptanceClock: AcceptanceClockV1 = options.stackNow
    ? 'explicit-historical'
    : 'live';
  const coreProvenance = options.coreFixtureProvenance ?? 'synthetic-test-vector';
  const pluginProvenance = options.pluginFixtureProvenance ?? 'synthetic-test-vector';
  const stackProvenance = options.stackFixtureProvenance ?? 'synthetic-test-vector';
  const validEntryPaths = isAbsolute(options.coreEntryPath) &&
    isAbsolute(options.pluginEntryPath) && isAbsolute(options.stackEntryPath);
  const [coreFixture, pluginFixture, stackObservationFixture, stackEffectFixture] = await Promise.all([
    explicitFixture(
      options.coreFixturePath,
      MAX_CORE_FIXTURE_FILE_BYTES,
      options.coreFixtureFormat ?? 'json',
    ),
    explicitFixture(
      options.pluginFixturePath,
      MAX_PLUGIN_FIXTURE_FILE_BYTES,
      options.pluginFixtureFormat ?? 'json',
    ),
    explicitFixture(options.stackObservationFixturePath, MAX_STACK_OBSERVATION_FILE_BYTES),
    explicitFixture(options.stackEffectFixturePath, MAX_STACK_EFFECT_FILE_BYTES),
  ]);
  const [coreProducer, pluginProducer, stackProducer] = validEntryPaths
    ? await Promise.all([
      inspectInWorker({
        kind: 'core-efficiency',
        entryPath: options.coreEntryPath,
        coreFixtureBase64: coreFixture.bytes?.toString('base64') ?? '',
      }),
      inspectInWorker({
        kind: 'plugin',
        entryPath: options.pluginEntryPath,
        pluginFixtureBase64: pluginFixture.bytes?.toString('base64') ?? '',
      }),
      inspectInWorker({
        kind: 'stack',
        entryPath: options.stackEntryPath,
        stackObservationFixtureBase64: stackObservationFixture.bytes?.toString('base64') ?? '',
        stackEffectFixtureBase64: stackEffectFixture.bytes?.toString('base64') ?? '',
        stackNow: stackNow.toISOString(),
      }),
    ])
    : [{ buildPresent: false }, { buildPresent: false }, { buildPresent: false }];
  const coreEfficiency = coreResult(coreProducer, coreFixture, coreProvenance);
  const plugin = pluginResult(pluginProducer, pluginFixture, pluginProvenance);
  const stack = stackResult(
    stackProducer,
    stackObservationFixture,
    stackEffectFixture,
    stackNow,
    evaluatedAt,
    stackAcceptanceClock,
    stackProvenance,
  );
  const state = coreEfficiency.state === 'fail' || plugin.state === 'fail' || stack.state === 'fail'
    ? 'fail'
    : coreEfficiency.state === 'unavailable' || plugin.state === 'unavailable' ||
        stack.state === 'unavailable'
      ? 'unavailable'
      : 'pass';
  const releaseReady = state === 'pass' && coreEfficiency.releaseReady &&
    plugin.releaseReady && stack.releaseReady;
  return {
    schemaVersion: 1,
    protocol: ECOSYSTEM_CONFORMANCE_PROTOCOL,
    mode: 'explicit-caller-paths',
    evaluatedAt: evaluatedAt.toISOString(),
    state,
    releaseReady,
    authority: false,
    effectAuthority: false,
    planningAuthority: false,
    executionAuthority: false,
    promotionAuthority: false,
    products: { coreEfficiency, plugin, stack },
  };
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

async function main(args: string[]): Promise<number> {
  const coreEntryPath = option(args, '--core-entry');
  const coreFixturePath = option(args, '--core-fixture');
  const pluginEntryPath = option(args, '--plugin-entry');
  const pluginFixturePath = option(args, '--plugin-fixture');
  const stackEntryPath = option(args, '--stack-entry');
  const stackObservationFixturePath = option(args, '--stack-observation-fixture');
  const stackEffectFixturePath = option(args, '--stack-effect-fixture');
  const stackNowValue = option(args, '--stack-now');
  const coreFixtureFormat = option(args, '--core-fixture-format');
  const pluginFixtureFormat = option(args, '--plugin-fixture-format');
  const coreFixtureProvenance = option(args, '--core-fixture-provenance');
  const pluginFixtureProvenance = option(args, '--plugin-fixture-provenance');
  const stackFixtureProvenance = option(args, '--stack-fixture-provenance');
  const validFormat = (value: string | null): boolean =>
    value === null || value === 'json' || value === 'hex';
  const validProvenance = (value: string | null): value is FixtureProvenanceV1 | null =>
    value === null || value === 'synthetic-test-vector' || value === 'released-source';
  if (!coreEntryPath || !coreFixturePath || !pluginEntryPath || !pluginFixturePath ||
    !stackEntryPath ||
    !stackObservationFixturePath || !stackEffectFixturePath ||
    !validFormat(coreFixtureFormat) || !validFormat(pluginFixtureFormat) ||
    !validProvenance(coreFixtureProvenance) || !validProvenance(pluginFixtureProvenance) ||
    !validProvenance(stackFixtureProvenance)) {
    process.stdout.write(`${JSON.stringify(unavailableReport('explicit-inputs-required'))}\n`);
    return 2;
  }
  const stackNow = stackNowValue ? new Date(stackNowValue) : new Date();
  if (!Number.isFinite(stackNow.getTime())) {
    process.stdout.write(`${JSON.stringify(unavailableReport('invalid-stack-now'))}\n`);
    return 2;
  }
  const report = await runEcosystemConformanceV1({
    coreEntryPath,
    coreFixturePath,
    coreFixtureFormat: coreFixtureFormat === 'hex' ? 'hex' : 'json',
    coreFixtureProvenance: coreFixtureProvenance ?? 'synthetic-test-vector',
    pluginEntryPath,
    pluginFixturePath,
    pluginFixtureFormat: pluginFixtureFormat === 'hex' ? 'hex' : 'json',
    pluginFixtureProvenance: pluginFixtureProvenance ?? 'synthetic-test-vector',
    stackEntryPath,
    stackObservationFixturePath,
    stackEffectFixturePath,
    stackFixtureProvenance: stackFixtureProvenance ?? 'synthetic-test-vector',
    stackNow: stackNowValue ? stackNow : undefined,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.state === 'pass' ? 0 : 2;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
