import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set([
  'accessToken', 'apiKey', 'authToken', 'content', 'credential', 'cwd', 'metadata',
  'password', 'path', 'privateKey', 'prompt', 'providerResourceId', 'repo', 'scopes',
  'secret', 'secretName', 'secretRef', 'secretValue', 'sessionId', 'token', 'toolInput',
  'toolOutput', 'url',
]);

function bytes(value) {
  return Buffer.from(String(value ?? ''), 'base64');
}

function safeProtocol(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function safeVersion(value) {
  return typeof value === 'string' && value.length <= 80 && SEMVER.test(value) ? value : null;
}

function safeDigest(value) {
  return typeof value === 'string' && DIGEST.test(value) ? value : null;
}

function sameBytes(left, right) {
  return left instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right));
}

function privacySafe(value, seen = new Set()) {
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

function parseFixture(encoded) {
  try {
    const fixtureBytes = bytes(encoded);
    return { fixtureBytes, value: JSON.parse(fixtureBytes.toString('utf8')) };
  } catch {
    return null;
  }
}

async function inspectCore(module, data) {
  const fixture = parseFixture(data.coreFixtureBase64);
  const allowed = ['ashlr-external-efficiency-receipt-v1'];
  const producerProtocol = safeProtocol(module.CORE_EFFICIENCY_RECEIPT_PROTOCOL, allowed);
  const interfaceCompatible = typeof module.canonicalCoreEfficiencyReceiptBytesV1 === 'function' &&
    typeof module.digestCoreEfficiencyReceiptV1 === 'function' &&
    typeof module.validateCoreEfficiencyReceiptV1 === 'function';
  if (!fixture || !interfaceCompatible) {
    return {
      buildPresent: true,
      fixturePresent: Boolean(fixture),
      interfaceCompatible,
      producerProtocol,
      fixtureProtocol: null,
      sourceVersion: null,
      versionCompatible: false,
      producerAccepted: false,
      fixtureByteIdentical: false,
      digestValid: false,
      privacySafe: false,
      digest: null,
    };
  }
  const value = fixture.value;
  const fixtureProtocol = safeProtocol(value?.protocol, allowed);
  const sourceVersion = safeVersion(value?.sourceVersion);
  let canonical = null;
  let validation = { valid: false };
  let expectedDigest = null;
  try {
    canonical = module.canonicalCoreEfficiencyReceiptBytesV1(value);
    validation = module.validateCoreEfficiencyReceiptV1(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const unsigned = { ...value };
      delete unsigned.receiptDigest;
      expectedDigest = module.digestCoreEfficiencyReceiptV1(unsigned);
    }
  } catch {
    canonical = null;
  }
  return {
    buildPresent: true,
    fixturePresent: true,
    interfaceCompatible,
    producerProtocol,
    fixtureProtocol,
    sourceVersion,
    versionCompatible: validation?.valid === true,
    producerAccepted: validation?.valid === true,
    fixtureByteIdentical: sameBytes(canonical, fixture.fixtureBytes),
    digestValid: safeDigest(expectedDigest) !== null && expectedDigest === value?.receiptDigest,
    privacySafe: privacySafe(value),
    digest: safeDigest(value?.receiptDigest),
  };
}

async function inspectPlugin(module, data) {
  const fixture = parseFixture(data.pluginFixtureBase64);
  const allowed = ['ashlr-external-efficiency-receipt-v1'];
  const producerProtocol = safeProtocol(module.EFFICIENCY_RECEIPT_PROTOCOL, allowed);
  const interfaceCompatible = typeof module.canonicalEfficiencyReceiptBytesV1 === 'function' &&
    typeof module.digestEfficiencyReceiptV1 === 'function' &&
    typeof module.parseCanonicalEfficiencyReceiptV1 === 'function';
  if (!fixture || !interfaceCompatible) {
    return {
      buildPresent: true,
      fixturePresent: Boolean(fixture),
      interfaceCompatible,
      producerProtocol,
      fixtureProtocol: null,
      sourceVersion: null,
      versionCompatible: false,
      producerAccepted: false,
      fixtureByteIdentical: false,
      digestValid: false,
      privacySafe: false,
      digest: null,
    };
  }
  const value = fixture.value;
  const fixtureProtocol = safeProtocol(value?.protocol, allowed);
  const sourceVersion = safeVersion(value?.sourceVersion);
  let canonical = null;
  let validation = null;
  let expectedDigest = null;
  try {
    canonical = module.canonicalEfficiencyReceiptBytesV1(value);
    validation = module.parseCanonicalEfficiencyReceiptV1(fixture.fixtureBytes);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const unsigned = { ...value };
      delete unsigned.receiptDigest;
      expectedDigest = module.digestEfficiencyReceiptV1(unsigned);
    }
  } catch {
    canonical = null;
  }
  const versionCompatible = value?.sourceProduct === 'ashlr-plugin' && sourceVersion !== null &&
    /^1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)/u.test(sourceVersion);
  return {
    buildPresent: true,
    fixturePresent: true,
    interfaceCompatible,
    producerProtocol,
    fixtureProtocol,
    sourceVersion,
    versionCompatible,
    producerAccepted: validation !== null,
    fixtureByteIdentical: sameBytes(canonical, fixture.fixtureBytes),
    digestValid: safeDigest(expectedDigest) !== null && expectedDigest === value?.receiptDigest,
    privacySafe: privacySafe(value),
    digest: safeDigest(value?.receiptDigest),
  };
}

async function inspectStack(module, data) {
  const observation = parseFixture(data.stackObservationFixtureBase64);
  const effect = parseFixture(data.stackEffectFixtureBase64);
  const observationAllowed = ['ashlr-stack-observation-manifest-v1'];
  const effectAllowed = ['ashlr-stack-planned-effect-manifest-v1'];
  const producerObservationProtocol = safeProtocol(
    module.STACK_OBSERVATION_MANIFEST_PROTOCOL,
    observationAllowed,
  );
  const producerEffectProtocol = safeProtocol(
    module.STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL,
    effectAllowed,
  );
  const interfaceCompatible =
    typeof module.canonicalStackObservationManifestBytesV1 === 'function' &&
    typeof module.canonicalStackPlannedEffectManifestBytesV1 === 'function' &&
    typeof module.stackObservationManifestDigestV1 === 'function' &&
    typeof module.stackPlannedEffectManifestDigestV1 === 'function' &&
    typeof module.validateStackObservationManifestV1 === 'function' &&
    typeof module.validateStackPlannedEffectManifestV1 === 'function';
  if (!observation || !effect || !interfaceCompatible) {
    return {
      buildPresent: true,
      fixturePresent: Boolean(observation && effect),
      interfaceCompatible,
      producerObservationProtocol,
      producerEffectProtocol,
      fixtureObservationProtocol: null,
      fixtureEffectProtocol: null,
      sourceVersion: null,
      versionCompatible: false,
      producerAccepted: false,
      observationByteIdentical: false,
      effectByteIdentical: false,
      observationDigestValid: false,
      effectDigestValid: false,
      observationToEffectBound: false,
      privacySafe: false,
      observationDigest: null,
      effectDigest: null,
    };
  }
  const observationValue = observation.value;
  const effectValue = effect.value;
  const now = new Date(String(data.stackNow));
  let observationCanonical = null;
  let effectCanonical = null;
  let observationValid = false;
  let effectValid = false;
  let expectedObservationDigest = null;
  let expectedEffectDigest = null;
  try {
    observationCanonical = module.canonicalStackObservationManifestBytesV1(observationValue);
    effectCanonical = module.canonicalStackPlannedEffectManifestBytesV1(effectValue);
    observationValid = module.validateStackObservationManifestV1(observationValue, now) === true;
    effectValid = module.validateStackPlannedEffectManifestV1(effectValue, now) === true;
    expectedObservationDigest = module.stackObservationManifestDigestV1(observationValue);
    expectedEffectDigest = module.stackPlannedEffectManifestDigestV1(effectValue);
  } catch {
    observationCanonical = null;
    effectCanonical = null;
  }
  const observationVersion = safeVersion(observationValue?.source?.version);
  const effectVersion = safeVersion(effectValue?.source?.version);
  return {
    buildPresent: true,
    fixturePresent: true,
    interfaceCompatible,
    producerObservationProtocol,
    producerEffectProtocol,
    fixtureObservationProtocol: safeProtocol(observationValue?.protocol, observationAllowed),
    fixtureEffectProtocol: safeProtocol(effectValue?.protocol, effectAllowed),
    sourceVersion: observationVersion === effectVersion ? observationVersion : null,
    versionCompatible: observationVersion !== null && observationVersion === effectVersion &&
      /^0\.2\.(?:0|[1-9][0-9]*)$/u.test(observationVersion),
    producerAccepted: observationValid && effectValid,
    observationByteIdentical: sameBytes(observationCanonical, observation.fixtureBytes),
    effectByteIdentical: sameBytes(effectCanonical, effect.fixtureBytes),
    observationDigestValid: safeDigest(expectedObservationDigest) !== null &&
      expectedObservationDigest === observationValue?.manifestDigest,
    effectDigestValid: safeDigest(expectedEffectDigest) !== null &&
      expectedEffectDigest === effectValue?.manifestDigest,
    observationToEffectBound: effectValue?.observationManifestDigest === observationValue?.manifestDigest,
    privacySafe: privacySafe(observationValue) && privacySafe(effectValue),
    observationDigest: safeDigest(observationValue?.manifestDigest),
    effectDigest: safeDigest(effectValue?.manifestDigest),
  };
}

async function main() {
  try {
    if (!workerData || typeof workerData !== 'object' ||
      (workerData.kind !== 'core-efficiency' && workerData.kind !== 'plugin' &&
        workerData.kind !== 'stack') ||
      typeof workerData.entryPath !== 'string') {
      parentPort?.postMessage({ buildPresent: false, unavailable: true });
      return;
    }
    const module = await import(pathToFileURL(workerData.entryPath).href);
    const result = workerData.kind === 'core-efficiency'
      ? await inspectCore(module, workerData)
      : workerData.kind === 'plugin'
        ? await inspectPlugin(module, workerData)
        : await inspectStack(module, workerData);
    parentPort?.postMessage(result);
  } catch {
    parentPort?.postMessage({ buildPresent: false, unavailable: true });
  }
}

await main();
