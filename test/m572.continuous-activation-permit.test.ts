/**
 * M572 — bounded, local-only, enrolled-repo continuous activation.
 *
 * These tests exist to hold one property: the activation gate refuses
 * UNBOUNDED or UNREVIEWED autonomy, and nothing else. Every refusal below must
 * stay a refusal, and the single authorized shape must stay authorized.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeDaemonActivationValue,
  consumeDaemonActivationPermit,
  daemonActivationConfigDigest,
  DAEMON_ACTIVATION_TRUST_ROOTS,
  type DaemonActivationTrustRoot,
} from '../src/core/daemon/activation-permit.js';
import {
  buildContinuousActivationPermitPayload,
  claimContinuousActivationIteration,
  claimContinuousRunIteration,
  classifyContinuousActivationShape,
  consumeContinuousActivationPermit,
  consumeContinuousActivationPermitForVerification,
  continuousActivationEnrollmentDigest,
  continuousRunBudgetExhausted,
  createContinuousRunBudget,
  continuousActivationPermitPath,
  continuousActivationReceiptPath,
  inspectContinuousActivationPermit,
  inspectContinuousActivationPermitForVerification,
  isContinuousActivationCapability,
  parseContinuousActivationPermitEnvelope,
  signContinuousActivationPermit,
  verifyContinuousActivationPermit,
  CONTINUOUS_ACTIVATION_MAX_ITERATIONS,
  CONTINUOUS_ACTIVATION_MAX_REPOS,
  CONTINUOUS_ACTIVATION_MAX_WALL_MS,
  CONTINUOUS_ACTIVATION_POLICY_VERSION,
  CONTINUOUS_ACTIVATION_TRUST_ROOTS,
  type ContinuousActivationPermitEnvelope,
  type ContinuousActivationRequest,
  type ContinuousActivationRuntimeContext,
} from '../src/core/daemon/continuous-activation-permit.js';
import type { AshlrConfig } from '../src/core/types.js';

const MODULE_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'src',
  'core',
  'daemon',
  'continuous-activation-permit.ts',
);

const originalHomeEnvironment = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
};

/** Every environment name an attacker (or a well-meaning operator) might try. */
const INJECTION_ENV_KEYS = [
  'ASHLR_TRUST_ROOT',
  'ASHLR_TRUST_ROOTS',
  'ASHLR_ACTIVATION_TRUST_ROOT',
  'ASHLR_ACTIVATION_TRUST_ROOTS',
  'ASHLR_CONTINUOUS_TRUST_ROOT',
  'ASHLR_CONTINUOUS_TRUST_ROOTS',
  'ASHLR_CONTINUOUS_ACTIVATION_TRUST_ROOTS',
  'ASHLR_DAEMON_TRUST_ROOT_PEM',
  'ASHLR_PERMIT_PUBLIC_KEY',
  'ASHLR_ALLOW_CONTINUOUS',
  'ASHLR_ALLOW_UNBOUNDED',
  'ASHLR_AUTONOMY',
] as const;

const homes: string[] = [];
const injectedEnvKeys = new Set<string>();

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(originalHomeEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of injectedEnvKeys) delete process.env[key];
  injectedEnvKeys.clear();
}

function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ashlr-m572-'));
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
  return home;
}

function config(label = 'default'): AshlrConfig {
  return {
    version: 1,
    roots: [`/${label}`],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

function digest(label: string): string {
  return Buffer.from(label.padEnd(32, '.')).toString('hex').slice(0, 64);
}

const ENROLLED = ['/srv/ashlr/alpha', '/srv/ashlr/beta'] as const;
const NOW = Date.UTC(2026, 8, 23, 12);

function context(
  cfg: AshlrConfig,
  nowMs = NOW,
  enrolledRepos: readonly string[] = ENROLLED,
): ContinuousActivationRuntimeContext {
  return {
    nowMs,
    configDigest: daemonActivationConfigDigest(cfg),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'a'.repeat(40),
      dirty: false,
      provenance: 'git',
    },
    executable: { path: '/opt/ashlr/node', sha256: digest('executable') },
    entrypoint: { path: '/opt/ashlr/dist/cli/index.js', sha256: digest('entrypoint') },
    releaseTree: { path: '/opt/ashlr', sha256: digest('release-tree') },
    authorityStateDigest: digest('authority-state'),
    killSwitchOff: true,
    guardHealthHealthy: true,
    enrolledRepos: [...enrolledRepos],
  };
}

function keys(keyId = 'm572-test-root'): {
  privateKey: KeyObject;
  root: DaemonActivationTrustRoot;
} {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId,
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

/** A well-formed, bounded, local-only, enrolled-repo continuous request. */
function boundedRequest(
  overrides: Partial<ContinuousActivationRequest> = {},
): ContinuousActivationRequest {
  return {
    once: false,
    dryRun: false,
    execution: 'local-only',
    repos: [...ENROLLED],
    bound: { notAfter: new Date(NOW + 60 * 60_000).toISOString(), maxIterations: null },
    automerge: true,
    ...overrides,
  };
}

function signedPermit(
  cfg: AshlrConfig,
  runtime: ContinuousActivationRuntimeContext,
  request: ContinuousActivationRequest = boundedRequest(),
  key = keys(),
  permitId = '1'.repeat(32),
  nonce = '2'.repeat(64),
): { envelope: ContinuousActivationPermitEnvelope; root: DaemonActivationTrustRoot } {
  const shape = classifyContinuousActivationShape(request, {
    nowMs: runtime.nowMs,
    enrolledRepos: runtime.enrolledRepos,
  });
  if (!shape.ok) throw new Error(`test fixture requires an authorizable shape: ${shape.reason}`);
  const payload = buildContinuousActivationPermitPayload({
    permitId,
    nonce,
    keyId: key.root.keyId,
    issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
    expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
    scope: shape.scope,
    context: { ...runtime, configDigest: daemonActivationConfigDigest(cfg) },
  });
  return { envelope: signContinuousActivationPermit(payload, key.privateKey), root: key.root };
}

function installPermit(envelope: ContinuousActivationPermitEnvelope): string {
  const path = continuousActivationPermitPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dirname(path)), 0o700);
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${canonicalizeDaemonActivationValue(envelope)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Plant every runtime "grant me authority" surface an operator could reach. */
function poisonEveryRuntimeAuthoritySurface(
  home: string,
  attacker: DaemonActivationTrustRoot,
): AshlrConfig {
  for (const key of INJECTION_ENV_KEYS) {
    process.env[key] = JSON.stringify([attacker]);
    injectedEnvKeys.add(key);
  }
  const controlDir = join(home, '.ashlr', 'control');
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  for (const candidate of [
    join(home, '.ashlr', 'trust-roots.json'),
    join(home, '.ashlr', 'control', 'trust-roots.json'),
    join(home, '.ashlr', 'control', 'continuous-trust-roots.json'),
    join(home, '.ashlr', 'control', 'activation-trust-roots.json'),
  ]) {
    writeFileSync(candidate, JSON.stringify({ roots: [attacker] }), { mode: 0o600 });
  }
  const cfg = config('poisoned') as AshlrConfig & Record<string, unknown>;
  cfg['trustRoots'] = [attacker];
  cfg['activationTrustRoots'] = [attacker];
  cfg['continuousActivationTrustRoots'] = [attacker];
  (cfg.tools as Record<string, unknown>)['trustRoots'] = [attacker];
  return cfg;
}

afterEach(() => {
  restoreEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The refusals. Each one is a distinct, machine-readable reason.
// ---------------------------------------------------------------------------

describe('M572 continuous activation refusals', () => {
  it('refuses a continuous request with NO bound at all', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ bound: null }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-requires-explicit-bound',
    });
  });

  it('refuses a bound object whose every field is null (runs forever)', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ bound: { notAfter: null, maxIterations: null } }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-requires-explicit-bound',
    });
  });

  it('refuses a deadline beyond the wall-clock ceiling', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({
        bound: {
          notAfter: new Date(NOW + CONTINUOUS_ACTIVATION_MAX_WALL_MS + 60_000).toISOString(),
          maxIterations: null,
        },
      }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-bound-exceeds-ceiling',
    });
  });

  it('refuses an iteration count beyond the ceiling', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({
        bound: { notAfter: null, maxIterations: CONTINUOUS_ACTIVATION_MAX_ITERATIONS + 1 },
      }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-bound-exceeds-ceiling',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a non-positive-integer iteration bound (%s)',
    (maxIterations) => {
      const shape = classifyContinuousActivationShape(
        boundedRequest({ bound: { notAfter: null, maxIterations } }),
        { nowMs: NOW, enrolledRepos: ENROLLED },
      );

      expect(shape.ok).toBe(false);
      expect(shape.ok === false && shape.reason).toBe('continuous-activation-invalid-bound');
    },
  );

  it('refuses a deadline that has already elapsed', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({
        bound: { notAfter: new Date(NOW - 1_000).toISOString(), maxIterations: null },
      }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-bound-already-elapsed',
    });
  });

  it.each(['cloud', 'hybrid'] as const)('refuses %s execution', (execution) => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ execution }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-refuses-nonlocal-execution',
    });
  });

  it('refuses a repo that is not enrolled', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ repos: ['/srv/ashlr/alpha', '/srv/ashlr/not-enrolled'] }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-repo-not-enrolled',
    });
  });

  it('refuses an empty repo list rather than treating it as "all repos"', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ repos: [] }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-requires-enrolled-repos',
    });
  });

  it.each([
    ['relative', 'srv/ashlr/alpha'],
    ['dot-traversal', '/srv/ashlr/../ashlr/alpha'],
    ['trailing slash', '/srv/ashlr/alpha/'],
  ])('refuses a non-canonical repo path (%s)', (_label, repo) => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ repos: [repo] }),
      { nowMs: NOW, enrolledRepos: [...ENROLLED, repo] },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-invalid-repo-path',
    });
  });

  it('refuses more repos than the ceiling allows', () => {
    const repos = Array.from(
      { length: CONTINUOUS_ACTIVATION_MAX_REPOS + 1 },
      (_value, index) => `/srv/ashlr/repo-${index}`,
    );
    const shape = classifyContinuousActivationShape(
      boundedRequest({ repos }),
      { nowMs: NOW, enrolledRepos: repos },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-too-many-repos',
    });
  });

  it('refuses a once-shaped request routed to the continuous gate', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ once: true }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-requires-resident-shape',
    });
  });

  it('refuses a continuous dry run (the dry-run path is permit-free by design)', () => {
    const shape = classifyContinuousActivationShape(
      boundedRequest({ dryRun: true }),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-refuses-dry-run-shape',
    });
  });

  it.each([
    [{ drain: true }, 'drain'],
    [{ drainLimit: 3 }, 'drain limit'],
  ])('refuses a drain-shaped continuous request (%#: %s)', (overrides) => {
    const shape = classifyContinuousActivationShape(
      boundedRequest(overrides),
      { nowMs: NOW, enrolledRepos: ENROLLED },
    );

    expect(shape).toEqual({
      ok: false,
      reason: 'continuous-activation-refuses-drain-shape',
    });
  });
});

// ---------------------------------------------------------------------------
// The signed layer. Even the key holder cannot sign an unbounded permit.
// ---------------------------------------------------------------------------

describe('M572 continuous permit payload validity', () => {
  it('cannot build a payload whose bound is empty', () => {
    const cfg = config();
    const runtime = context(cfg);
    const shape = classifyContinuousActivationShape(boundedRequest(), {
      nowMs: runtime.nowMs,
      enrolledRepos: runtime.enrolledRepos,
    });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;

    expect(() =>
      buildContinuousActivationPermitPayload({
        permitId: '1'.repeat(32),
        nonce: '2'.repeat(64),
        keyId: 'k',
        issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
        expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
        scope: { ...shape.scope, bound: { notAfter: null, maxIterations: null } },
        context: runtime,
      }),
    ).toThrow(/invalid continuous activation permit payload/u);
  });

  it('rejects a hand-forged unbounded envelope even when signed by a trusted key', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    const forged = {
      payload: {
        ...envelope.payload,
        scope: { ...envelope.payload.scope, bound: { notAfter: null, maxIterations: null } },
      },
      signature: envelope.signature,
    };

    expect(parseContinuousActivationPermitEnvelope(forged)).toBeNull();
    expect(verifyContinuousActivationPermit(forged, runtime, [key.root])).toEqual({
      ok: false,
      reason: 'invalid-continuous-permit-schema',
    });
  });

  it('rejects a hand-forged cloud-execution envelope', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    const forged = {
      payload: {
        ...envelope.payload,
        scope: { ...envelope.payload.scope, execution: 'cloud', allowCloud: true },
      },
      signature: envelope.signature,
    };

    expect(verifyContinuousActivationPermit(forged, runtime, [key.root])).toEqual({
      ok: false,
      reason: 'invalid-continuous-permit-schema',
    });
  });

  it.each(['repair', 'deploy', 'install', 'selfTarget', 'allowAnyRepo'] as const)(
    'rejects a forged envelope that enables %s',
    (field) => {
      const cfg = config();
      const runtime = context(cfg);
      const key = keys();
      const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

      const forged = {
        payload: {
          ...envelope.payload,
          scope: { ...envelope.payload.scope, [field]: true },
        },
        signature: envelope.signature,
      };

      expect(verifyContinuousActivationPermit(forged, runtime, [key.root])).toEqual({
        ok: false,
        reason: 'invalid-continuous-permit-schema',
      });
    },
  );

  it('rejects a permit naming a repo the runtime no longer has enrolled', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    const unenrolled = context(cfg, NOW, ['/srv/ashlr/alpha']);
    expect(verifyContinuousActivationPermit(envelope, unenrolled, [key.root])).toEqual({
      ok: false,
      reason: 'continuous-permit-repo-not-enrolled',
    });
  });

  it('rejects a permit whose enrollment digest no longer matches the runtime', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    const widened = context(cfg, NOW, [...ENROLLED, '/srv/ashlr/gamma']);
    expect(verifyContinuousActivationPermit(envelope, widened, [key.root]).ok).toBe(false);
    expect(verifyContinuousActivationPermit(envelope, widened, [key.root]).reason).toBe(
      'continuous-permit-runtime-binding-mismatch',
    );
  });

  it('rejects a permit whose deadline outlives the ceiling measured from issue', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    const forged = {
      payload: {
        ...envelope.payload,
        scope: {
          ...envelope.payload.scope,
          bound: {
            notAfter: new Date(
              Date.parse(envelope.payload.issuedAt) + CONTINUOUS_ACTIVATION_MAX_WALL_MS + 1_000,
            ).toISOString(),
            maxIterations: null,
          },
        },
      },
      signature: envelope.signature,
    };

    expect(verifyContinuousActivationPermit(forged, runtime, [key.root])).toEqual({
      ok: false,
      reason: 'continuous-permit-bound-exceeds-ceiling',
    });
  });

  it('will not accept a daemon proposal-once permit replayed as a continuous permit', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    // Same bytes, different signing domain => the signature must not transfer.
    const crossDomain = {
      payload: { ...envelope.payload, policyVersion: 'm461-proposal-once-v1' },
      signature: envelope.signature,
    };
    expect(parseContinuousActivationPermitEnvelope(crossDomain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-injectability. No env var, config field, flag, or writable file.
// ---------------------------------------------------------------------------

describe('M572 continuous activation authority cannot be injected', () => {
  it('pins the source-provisioned trust root set', () => {
    expect(Object.isFrozen(CONTINUOUS_ACTIVATION_TRUST_ROOTS)).toBe(true);
    expect(CONTINUOUS_ACTIVATION_TRUST_ROOTS).toHaveLength(1);

    const [root] = CONTINUOUS_ACTIVATION_TRUST_ROOTS;
    expect(root).toBeDefined();
    if (!root) return;
    expect(Object.isFrozen(root)).toBe(true);
    expect(root.keyId).toBe('ashlr-continuous-bounded-local-2026-09');
    expect(root.publicKeyPem).toContain('BEGIN PUBLIC KEY');

    // A reviewed source change is the only way to move this digest.
    expect(createHash('sha256').update(root.publicKeyPem).digest('hex')).toBe(
      createHash('sha256')
        .update(
          '-----BEGIN PUBLIC KEY-----\n'
          + 'MCowBQYDK2VwAyEApsrShMeW2GivDqSUWURY47d9nL2QjL4RqFESAiHeaEA=\n'
          + '-----END PUBLIC KEY-----\n',
        )
        .digest('hex'),
    );
  });

  it('refuses to let the frozen root set be mutated at runtime', () => {
    const before = canonicalizeDaemonActivationValue(CONTINUOUS_ACTIVATION_TRUST_ROOTS);
    const attacker = keys('attacker');

    expect(() =>
      (CONTINUOUS_ACTIVATION_TRUST_ROOTS as DaemonActivationTrustRoot[]).push(attacker.root),
    ).toThrow(TypeError);
    expect(() => {
      (CONTINUOUS_ACTIVATION_TRUST_ROOTS as DaemonActivationTrustRoot[])[0] = attacker.root;
    }).toThrow(TypeError);

    expect(canonicalizeDaemonActivationValue(CONTINUOUS_ACTIVATION_TRUST_ROOTS)).toBe(before);
  });

  it('never reads authority from the environment or the config (source property)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    // Prose may discuss process.env; executable code may not touch it.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1');

    expect(code).not.toMatch(/process\.env/u);
    expect(code).not.toMatch(/\bgetenv\b/u);
    // The only trust-root literal in the module is the frozen exported constant.
    expect(code).toMatch(
      /export const CONTINUOUS_ACTIVATION_TRUST_ROOTS[\s\S]{0,200}?Object\.freeze\(\[/u,
    );
    expect(code.match(/Object\.freeze\(\[\s*\n\s*Object\.freeze\(\{/gu)).toHaveLength(1);
    // No runtime path may load roots from a file or the config object.
    expect(code).not.toMatch(/trustRootsFrom(Config|File|Env)/u);
    expect(code).not.toMatch(/readFileSync/u);
    expect(code).not.toMatch(/BEGIN\s+(RSA\s+|EC\s+)?PRIVATE\s+KEY/u);
    // Roots reach the gate only as a parameter, never from cfg or the request.
    expect(code).not.toMatch(/cfg\s*\[\s*['"]trustRoots/u);
    expect(code).not.toMatch(/request\.trustRoots/u);
  });

  it('refuses an attacker-signed permit with every runtime surface poisoned', () => {
    const home = isolateHome();
    const attacker = keys('attacker-root');
    const cfg = poisonEveryRuntimeAuthoritySurface(home, attacker.root);
    const runtime = context(cfg);
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), attacker);

    // The production root set is the only authority; the attacker key is not in it.
    expect(
      verifyContinuousActivationPermit(envelope, runtime, CONTINUOUS_ACTIVATION_TRUST_ROOTS),
    ).toEqual({ ok: false, reason: 'permit-key-not-trusted' });

    // ...and the production consumption entrypoint mints nothing either.
    installPermit(envelope);
    const consumed = consumeContinuousActivationPermit(cfg, boundedRequest());
    expect(consumed.authorized).toBe(false);
    expect(consumed.capability).toBeUndefined();
  });

  it('refuses an unbounded request even with every runtime surface poisoned', () => {
    const home = isolateHome();
    const attacker = keys('attacker-root');
    const cfg = poisonEveryRuntimeAuthoritySurface(home, attacker.root);

    const consumed = consumeContinuousActivationPermit(cfg, boundedRequest({ bound: null }));
    expect(consumed).toEqual({
      authorized: false,
      required: true,
      reason: 'continuous-activation-requires-explicit-bound',
    });

    const inspected = inspectContinuousActivationPermit(cfg, boundedRequest({ bound: null }));
    expect(inspected.state).toBe('blocked');
    expect(inspected.reason).toBe('continuous-activation-requires-explicit-bound');
  });

  it('gains no root when the module is re-evaluated with the environment poisoned', async () => {
    const home = isolateHome();
    const attacker = keys('attacker-root');
    poisonEveryRuntimeAuthoritySurface(home, attacker.root);

    // Re-import with every candidate variable already set, so a module-scope
    // read of the environment would show up here rather than being masked by
    // the constant having been frozen before the test set anything.
    vi.resetModules();
    const reloaded = await import('../src/core/daemon/continuous-activation-permit.js');

    expect(reloaded.CONTINUOUS_ACTIVATION_TRUST_ROOTS).toHaveLength(1);
    expect(reloaded.CONTINUOUS_ACTIVATION_TRUST_ROOTS[0]?.keyId).toBe(
      'ashlr-continuous-bounded-local-2026-09',
    );
    expect(
      reloaded.CONTINUOUS_ACTIVATION_TRUST_ROOTS.some(
        (root) => root.keyId === attacker.root.keyId,
      ),
    ).toBe(false);

    const runtime = context(config('poisoned'));
    const payload = reloaded.buildContinuousActivationPermitPayload({
      permitId: '3'.repeat(32),
      nonce: '4'.repeat(64),
      keyId: attacker.root.keyId,
      issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      scope: (() => {
        const shape = reloaded.classifyContinuousActivationShape(boundedRequest(), {
          nowMs: runtime.nowMs,
          enrolledRepos: runtime.enrolledRepos,
        });
        if (!shape.ok) throw new Error(shape.reason);
        return shape.scope;
      })(),
      context: { ...runtime, configDigest: daemonActivationConfigDigest(config('poisoned')) },
    });
    const forgedEnvelope = reloaded.signContinuousActivationPermit(payload, attacker.privateKey);

    expect(
      reloaded.verifyContinuousActivationPermit(
        forgedEnvelope,
        runtime,
        reloaded.CONTINUOUS_ACTIVATION_TRUST_ROOTS,
      ),
    ).toEqual({ ok: false, reason: 'permit-key-not-trusted' });
  });

  it('reads enrolment from the registry, never from the request or the config', () => {
    const home = isolateHome();
    const ashlrDir = join(home, '.ashlr');
    mkdirSync(join(ashlrDir, 'control'), { recursive: true, mode: 0o700 });
    chmodSync(ashlrDir, 0o700);
    chmodSync(join(ashlrDir, 'control'), 0o700);
    writeFileSync(
      join(ashlrDir, 'enrollment.json'),
      JSON.stringify({ repos: ['/srv/ashlr/alpha'] }),
      { mode: 0o600 },
    );

    // Enrolled: the shape gate passes, and the run is refused later, for the
    // only remaining reason — there is no permit on disk.
    const enrolled = consumeContinuousActivationPermit(
      config(),
      boundedRequest({ repos: ['/srv/ashlr/alpha'] }),
    );
    expect(enrolled.authorized).toBe(false);
    expect(enrolled.reason).toBe('continuous-activation-permit-missing');

    // Not enrolled: refused at the gate, before any permit is even looked for.
    const notEnrolled = consumeContinuousActivationPermit(
      config(),
      boundedRequest({ repos: ['/srv/ashlr/beta'] }),
    );
    expect(notEnrolled).toEqual({
      authorized: false,
      required: true,
      reason: 'continuous-activation-repo-not-enrolled',
    });
  });

  it('ignores a trustRoots field smuggled onto the request object', () => {
    const home = isolateHome();
    const attacker = keys('attacker-root');
    const cfg = config();
    const runtime = context(cfg);
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), attacker);
    installPermit(envelope);
    expect(existsSync(join(home, '.ashlr'))).toBe(true);

    const smuggled = {
      ...boundedRequest(),
      trustRoots: [attacker.root],
      allowUnbounded: true,
      bypassPermit: true,
    } as ContinuousActivationRequest;

    const consumed = consumeContinuousActivationPermit(cfg, smuggled);
    expect(consumed.authorized).toBe(false);
    expect(consumed.capability).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The existing gate must keep behaving exactly as it did.
// ---------------------------------------------------------------------------

describe('M572 leaves the M461 gate untouched', () => {
  it('keeps the daemon proposal-once production roots empty', () => {
    expect(DAEMON_ACTIVATION_TRUST_ROOTS).toEqual([]);
    expect(Object.isFrozen(DAEMON_ACTIVATION_TRUST_ROOTS)).toBe(true);
  });

  it('keeps once+dryRun permit-free', () => {
    const home = isolateHome();
    expect(consumeDaemonActivationPermit(config(), { once: true, dryRun: true })).toEqual({
      authorized: true,
      required: false,
      reason: 'dry-run-once-does-not-require-activation-permit',
    });
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('still refuses a resident start through the M461 daemon permit path', () => {
    isolateHome();
    const result = consumeDaemonActivationPermit(config(), { once: false, dryRun: false });

    expect(result).toEqual({
      authorized: false,
      required: true,
      reason: 'activation-permit-cannot-authorize-requested-start-shape',
    });
  });
});

// ---------------------------------------------------------------------------
// The one authorized shape.
// ---------------------------------------------------------------------------

describe('M572 authorizes a bounded local-only continuous run', () => {
  it('classifies a bounded local-only enrolled-repo request', () => {
    const shape = classifyContinuousActivationShape(boundedRequest(), {
      nowMs: NOW,
      enrolledRepos: ENROLLED,
    });

    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.scope).toMatchObject({
      action: 'daemon-continuous-bounded-local',
      continuous: true,
      once: false,
      dryRun: false,
      execution: 'local-only',
      allowCloud: false,
      allowAnyRepo: false,
      automerge: true,
      proposalOnly: false,
      repair: false,
      deploy: false,
      install: false,
      selfTarget: false,
      drain: false,
      drainLimit: null,
      repos: [...ENROLLED],
    });
    expect(shape.scope.bound.maxIterations).toBeNull();
    expect(shape.scope.bound.notAfter).toBe(new Date(NOW + 60 * 60_000).toISOString());
  });

  it('consumes a bounded deadline permit, mints a capability, and is not replayable', () => {
    const home = isolateHome();
    const cfg = config();
    const runtime = context(cfg);
    const { envelope, root } = signedPermit(cfg, runtime);
    const permitPath = installPermit(envelope);

    const readiness = inspectContinuousActivationPermitForVerification(cfg, boundedRequest(), {
      trustRoots: [root],
      context: runtime,
    });
    expect(readiness.state).toBe('ready');
    expect(readiness.reason).toBe('valid-continuous-bounded-local-permit');
    expect(readiness.policyVersion).toBe(CONTINUOUS_ACTIVATION_POLICY_VERSION);
    expect(existsSync(permitPath)).toBe(true);

    const consumed = consumeContinuousActivationPermitForVerification(cfg, boundedRequest(), {
      trustRoots: [root],
      context: runtime,
    });

    expect(consumed.authorized).toBe(true);
    expect(consumed.required).toBe(true);
    expect(consumed.reason).toBe('continuous-bounded-local-activation-authorized');
    expect(consumed.permitId).toBe('1'.repeat(32));
    expect(existsSync(continuousActivationReceiptPath('1'.repeat(32)))).toBe(true);
    // Single-use: the permit file is gone and a replay is refused.
    expect(existsSync(permitPath)).toBe(false);
    expect(existsSync(join(home, '.ashlr', 'control'))).toBe(true);

    installPermit(envelope);
    const replayed = consumeContinuousActivationPermitForVerification(cfg, boundedRequest(), {
      trustRoots: [root],
      context: runtime,
    });
    expect(replayed.authorized).toBe(false);
    expect(replayed.reason).toBe('continuous-activation-permit-already-consumed');
  });

  it('authorizes an iteration-bounded run without minting test authority', () => {
    isolateHome();
    const cfg = config();
    const runtime = context(cfg);
    const request = boundedRequest({ bound: { notAfter: null, maxIterations: 3 } });
    const { envelope, root } = signedPermit(cfg, runtime, request);
    installPermit(envelope);

    const consumed = consumeContinuousActivationPermitForVerification(cfg, request, {
      trustRoots: [root],
      context: runtime,
    });

    expect(consumed.authorized).toBe(true);
    expect(consumed.reason).toBe('continuous-bounded-local-activation-authorized');
    // Injected roots exercise the protocol; they must never mint live authority.
    expect(consumed.capability).toBeUndefined();
  });

  it('refuses a permit whose scope does not match the requested run', () => {
    isolateHome();
    const cfg = config();
    const runtime = context(cfg);
    const { envelope, root } = signedPermit(cfg, runtime, boundedRequest());
    installPermit(envelope);

    // Same permit, but the caller now asks for a longer run than it authorizes.
    const widened = boundedRequest({
      bound: { notAfter: new Date(NOW + 2 * 60 * 60_000).toISOString(), maxIterations: null },
    });
    const consumed = consumeContinuousActivationPermitForVerification(cfg, widened, {
      trustRoots: [root],
      context: runtime,
    });

    expect(consumed.authorized).toBe(false);
    expect(consumed.reason).toBe('continuous-permit-scope-mismatch');
  });

  it('enforces an iteration bound at claim time and then stays dead', () => {
    const budget = createContinuousRunBudget({ notAfter: null, maxIterations: 3 });

    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: true,
      remainingIterations: 2,
      msRemaining: null,
    });
    expect(claimContinuousRunIteration(budget, NOW).remainingIterations).toBe(1);
    expect(claimContinuousRunIteration(budget, NOW).remainingIterations).toBe(0);
    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: false,
      reason: 'continuous-bound-iterations-exhausted',
    });
    expect(continuousRunBudgetExhausted(budget)).toBe(true);
    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: false,
      reason: 'continuous-capability-revoked',
    });
  });

  it('stops a deadline-bounded run the moment the deadline passes', () => {
    const budget = createContinuousRunBudget({
      notAfter: new Date(NOW + 60 * 60_000).toISOString(),
      maxIterations: null,
    });

    const first = claimContinuousRunIteration(budget, NOW);
    expect(first.ok).toBe(true);
    expect(first.ok === true && first.msRemaining).toBe(60 * 60_000);
    expect(first.ok === true && first.remainingIterations).toBeNull();

    expect(claimContinuousRunIteration(budget, NOW + 60 * 60_000)).toEqual({
      ok: false,
      reason: 'continuous-bound-deadline-passed',
    });
    // Once a bound trips it stays tripped, even if the clock is rewound.
    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: false,
      reason: 'continuous-capability-revoked',
    });
  });

  it('fails closed the moment the permit stops revalidating (kill switch)', () => {
    let healthy = true;
    const budget = createContinuousRunBudget(
      { notAfter: null, maxIterations: 10 },
      { revalidate: () => healthy },
    );

    expect(claimContinuousRunIteration(budget, NOW).ok).toBe(true);
    healthy = false;
    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: false,
      reason: 'continuous-capability-revoked',
    });
  });

  it('fails closed when revalidation throws', () => {
    const budget = createContinuousRunBudget(
      { notAfter: null, maxIterations: 10 },
      {
        revalidate: () => {
          throw new Error('runtime binding vanished');
        },
      },
    );

    expect(claimContinuousRunIteration(budget, NOW)).toEqual({
      ok: false,
      reason: 'continuous-capability-revoked',
    });
  });

  it('cannot create a budget with no bound', () => {
    expect(() =>
      createContinuousRunBudget({ notAfter: null, maxIterations: null }),
    ).toThrow(/requires an explicit bound/u);
    expect(() =>
      createContinuousRunBudget({
        notAfter: null,
        maxIterations: CONTINUOUS_ACTIVATION_MAX_ITERATIONS + 1,
      }),
    ).toThrow(/requires an explicit bound/u);
  });

  it('rejects a forged capability object of the right shape', () => {
    const forged = {
      kind: 'continuous-bounded-local',
      permitId: '1'.repeat(32),
      bound: { notAfter: null, maxIterations: 10 },
      repos: [...ENROLLED],
      automerge: true,
      budget: createContinuousRunBudget({ notAfter: null, maxIterations: 10 }),
    };

    expect(isContinuousActivationCapability(forged)).toBe(false);
    expect(claimContinuousActivationIteration(forged, NOW)).toEqual({
      ok: false,
      reason: 'continuous-capability-not-recognized',
    });
    for (const value of [null, undefined, 'capability', 42, {}]) {
      expect(isContinuousActivationCapability(value)).toBe(false);
      expect(claimContinuousActivationIteration(value, NOW)).toEqual({
        ok: false,
        reason: 'continuous-capability-not-recognized',
      });
    }
  });

  it('binds the enrollment digest it was issued against', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const { envelope } = signedPermit(cfg, runtime, boundedRequest(), key);

    expect(envelope.payload.bindings.enrollmentDigest).toBe(
      continuousActivationEnrollmentDigest(ENROLLED),
    );
    expect(continuousActivationEnrollmentDigest(['/b', '/a'])).toBe(
      continuousActivationEnrollmentDigest(['/a', '/b']),
    );
    expect(verifyContinuousActivationPermit(envelope, runtime, [key.root])).toMatchObject({
      ok: true,
      reason: 'valid-continuous-bounded-local-permit',
      permitId: '1'.repeat(32),
    });
  });

  it('refuses on Windows regardless of an otherwise perfect permit', () => {
    isolateHome();
    const cfg = config();
    const runtime = context(cfg);
    const { root } = signedPermit(cfg, runtime);

    const readiness = inspectContinuousActivationPermitForVerification(cfg, boundedRequest(), {
      trustRoots: [root],
      context: runtime,
      platform: 'win32',
    });

    expect(readiness.state).toBe('blocked');
    expect(readiness.reason).toBe('continuous-activation-v1-unsupported-on-windows');
  });
});
