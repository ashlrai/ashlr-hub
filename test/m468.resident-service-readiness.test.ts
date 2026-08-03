import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { generateServiceDefinition } from '../src/core/daemon/service.js';
import {
  observeResidentServiceDiagnostic,
  residentServiceReleaseManifestPayloadBytes,
  type ResidentServiceDiagnosticDependencies,
  type ResidentServiceDiagnosticOptions,
  type ResidentServiceReleaseManifestPayloadV1,
  type ResidentServiceSignedReleaseManifestBinding,
} from '../src/core/daemon/resident-service-readiness.js';

const TEST_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-suite-')));
const HOME = join(TEST_ROOT, 'home');
mkdirSync(HOME);
const RELEASE_ID = '0123456789abcdef0123456789abcdef01234567';
const TREE_SHA = 'a'.repeat(64);
const INTERPRETER_SHA = 'b'.repeat(64);
const RELEASE_ROOT = `${HOME}/.local/share/ashlr/releases/${RELEASE_ID}`;
const NODE = '/opt/homebrew/bin/node';
const ENTRYPOINT = `${RELEASE_ROOT}/bin/ashlr`;
const PLIST = `${HOME}/Library/LaunchAgents/ai.ashlr.daemon.plist`;
const UID = Number(lstatSync(HOME, { bigint: true }).uid);
const TARGET = `gui/${UID}/ai.ashlr.daemon`;
const ACTUAL_PLATFORM = process.platform;
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const SIGNER = generateKeyPairSync('ed25519');
const ARGS = [
  NODE,
  ENTRYPOINT,
  'daemon',
  'start',
  '--budget',
  '5',
  '--interval',
  '1800000',
  '--parallel',
  '1',
];
const GENERATED_ENVIRONMENT = generateServiceDefinition({
  platform: 'darwin',
  homeDir: HOME,
  nodePath: NODE,
  binPath: ENTRYPOINT,
}).launchdRuntime!.environment;

function signedReleaseManifest(
  overrides: Partial<ResidentServiceReleaseManifestPayloadV1> = {},
): ResidentServiceSignedReleaseManifestBinding {
  const payload: ResidentServiceReleaseManifestPayloadV1 = {
    schemaVersion: 1,
    release: {
      root: RELEASE_ROOT,
      identity: RELEASE_ID,
      treeSha256: TREE_SHA,
      interpreter: { path: NODE, sha256: INTERPRETER_SHA },
    },
    service: {
      label: 'ai.ashlr.daemon',
      platform: 'darwin',
      program: NODE,
      arguments: [...ARGS],
      environment: { ...GENERATED_ENVIRONMENT },
    },
    issuedAt: '2026-08-01T11:30:00.000Z',
    expiresAt: '2026-08-01T12:30:00.000Z',
    ...overrides,
  };
  const payloadBytes = residentServiceReleaseManifestPayloadBytes(payload);
  if (!payloadBytes) throw new Error('invalid signed release fixture');
  return {
    manifest: {
      payload,
      keyId: 'resident-release-test-key',
      signatureAlgorithm: 'Ed25519',
      signature: sign(null, payloadBytes, SIGNER.privateKey).toString('base64'),
    },
    trustKey: {
      keyId: 'resident-release-test-key',
      publicKeyPem: SIGNER.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-08-02T00:00:00.000Z',
    },
  };
}

function options(overrides: Partial<ResidentServiceDiagnosticOptions> = {}): ResidentServiceDiagnosticOptions {
  const defaults: ResidentServiceDiagnosticOptions = {
    platform: 'darwin',
    homeDir: HOME,
    nodePath: NODE,
    release: {
      root: RELEASE_ROOT,
      identity: RELEASE_ID,
      treeSha256: TREE_SHA,
      interpreter: {
        path: NODE,
        sha256: INTERPRETER_SHA,
      },
    },
    signedReleaseManifest: signedReleaseManifest(),
  };
  return { ...defaults, ...overrides };
}

function launchdPrint(
  args: readonly string[] = ARGS,
  target = TARGET,
  state = 'running',
  properties = 'runatload',
  minimumRuntime = 30,
  environment: Record<string, string> | null = GENERATED_ENVIRONMENT,
): string {
  return `${[
    `${target} = {`,
    `\tpath = ${PLIST}`,
    `\tstate = ${state}`,
    `\tprogram = ${args[0]}`,
    '\targuments = {',
    ...args.map((argument) => `\t\t${argument}`),
    '\t}',
    ...(state === 'running' ? ['\tpid = 4242'] : []),
    ...(environment === null ? [] : [
      '\tenvironment = {',
      ...Object.entries(environment).map(([key, value]) => `\t\t${key} => ${value}`),
      '\t}',
    ]),
    `\tminimum runtime = ${minimumRuntime}`,
    `\tproperties = ${properties}`,
    '}',
  ].join('\n')}\n`;
}

function plist(overrides: Record<string, unknown> = {}): string {
  const value: Record<string, unknown> = {
    Label: 'ai.ashlr.daemon',
    ProcessType: 'Background',
    ProgramArguments: ARGS,
    EnvironmentVariables: { ...GENERATED_ENVIRONMENT },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    StandardOutPath: join(HOME, '.ashlr', 'daemon.launchd.out.log'),
    StandardErrorPath: join(HOME, '.ashlr', 'daemon.launchd.err.log'),
    ...overrides,
  };
  if (overrides['EnvironmentVariables'] === null) delete value['EnvironmentVariables'];
  return JSON.stringify(value);
}

function dependencies(overrides: {
  runtime?: { status: number; stdout: string; stderr: string };
  disabled?: { status: number; stdout: string; stderr: string };
  plist?: { status: number; stdout: string; stderr: string };
  kill?: 'absent' | 'present' | 'unknown';
  releasePath?: string;
  releaseSha?: string;
  interpreterPath?: string;
  interpreterSha?: string;
  varySecondRelease?: boolean;
  varyFinalRelease?: boolean;
  varyFinalInterpreter?: boolean;
  varySecondRuntime?: boolean;
  killSequence?: Array<'absent' | 'present' | 'unknown'>;
  wallClockMs?: number;
  expectedHome?: string;
  accountHome?: string;
  uid?: number;
  homeDirectoryIdentityFs?: ResidentServiceDiagnosticDependencies['homeDirectoryIdentityFs'];
} = {}): ResidentServiceDiagnosticDependencies {
  let runtimeReads = 0;
  let killReads = 0;
  return {
    testOnlyTrustedAccountIdentity: () => ({
      uid: overrides.uid ?? UID,
      homeDir: overrides.accountHome ?? overrides.expectedHome ?? HOME,
    }),
    ...(overrides.homeDirectoryIdentityFs
      ? { homeDirectoryIdentityFs: overrides.homeDirectoryIdentityFs }
      : {}),
    testOnlyWallClockMs: () => overrides.wallClockMs ?? NOW,
    releaseTreeBinding: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        return {
          path: overrides.releasePath ?? RELEASE_ROOT,
          sha256: (overrides.varySecondRelease && reads === 2)
            || (overrides.varyFinalRelease && reads === 3)
            ? 'c'.repeat(64)
            : overrides.releaseSha ?? TREE_SHA,
        };
      };
    })(),
    interpreterBinding: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        return {
          path: overrides.interpreterPath ?? NODE,
          sha256: overrides.varyFinalInterpreter && reads === 3
            ? 'd'.repeat(64)
            : overrides.interpreterSha ?? INTERPRETER_SHA,
        };
      };
    })(),
    killSwitchState: (path) => {
      expect(path).toBe(join(overrides.expectedHome ?? HOME, '.ashlr', 'KILL'));
      const observation = overrides.killSequence?.[killReads] ?? overrides.kill ?? 'absent';
      killReads += 1;
      return observation;
    },
    run: (command, args) => {
      if (command === '/bin/launchctl' && args[0] === 'print') {
        runtimeReads += 1;
        if (overrides.varySecondRuntime && runtimeReads === 2) {
          return { status: 0, stdout: launchdPrint([...ARGS, '--changed']), stderr: '' };
        }
        return overrides.runtime ?? { status: 0, stdout: launchdPrint(), stderr: '' };
      }
      if (command === '/bin/launchctl' && args[0] === 'print-disabled') {
        return overrides.disabled ?? {
          status: 0,
          stdout: 'disabled services = {\n\t"ai.ashlr.daemon" => enabled\n}\n',
          stderr: '',
        };
      }
      if (command === '/usr/bin/plutil') {
        expect(args).toEqual([
          '-convert',
          'json',
          '-o',
          '-',
          join(overrides.expectedHome ?? HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'),
        ]);
        return overrides.plist ?? { status: 0, stdout: plist(), stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
}

const realHomeIdentityFs: NonNullable<ResidentServiceDiagnosticDependencies['homeDirectoryIdentityFs']> = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path, flags) => openSync(path, flags),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  close: closeSync,
  realpath: (path) => realpathSync.native(path),
};

function observeRealHomeIdentity(
  home: string,
  overrides: Pick<ResidentServiceDiagnosticDependencies, 'homeDirectoryIdentityFs'> & {
    uid?: number;
    accountHome?: string;
    environmentHome?: string;
  } = {},
) {
  const uid = overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : UID);
  const generatedEnvironment = generateServiceDefinition({
    platform: 'darwin',
    homeDir: home,
    nodePath: NODE,
    binPath: ENTRYPOINT,
  }).launchdRuntime!.environment;
  const environment = {
    ...generatedEnvironment,
    HOME: overrides.environmentHome ?? home,
  };
  return observeResidentServiceDiagnostic(
    options({
      homeDir: home,
      signedReleaseManifest: signedReleaseManifest({
        service: {
          label: 'ai.ashlr.daemon',
          platform: 'darwin',
          program: NODE,
          arguments: [...ARGS],
          environment,
        },
      }),
    }),
    dependencies({
      expectedHome: home,
      accountHome: overrides.accountHome ?? home,
      uid,
      homeDirectoryIdentityFs: overrides.homeDirectoryIdentityFs,
      plist: { status: 0, stdout: plist({ EnvironmentVariables: environment }), stderr: '' },
      runtime: {
        status: 0,
        stdout: launchdPrint(ARGS, `gui/${uid}/ai.ashlr.daemon`, 'running', 'runatload', 30, environment),
        stderr: '',
      },
    }),
  );
}

describe('observeResidentServiceDiagnostic', () => {
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: ACTUAL_PLATFORM });
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('keeps an exact signed environment observation blocked on missing lifecycle authorities', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies());

    expect(diagnostic).toMatchObject({
      schemaVersion: 5,
      scope: 'observation-only-diagnostic',
      diagnosticStatus: 'blocked',
      lifecycleAuthority: 'none',
      operationalAuthority: false,
      declaredReleaseIdentity: RELEASE_ID,
      localChecks: {
        exactLabel: true,
        loaded: true,
        running: true,
        enabled: true,
        localReleaseMatchesDeclaredDigest: true,
        localInterpreterMatchesDeclaredDigest: true,
        observedInvocationMatchesDeclaration: true,
        diskDefinitionRestartPolicyCompatible: true,
        loadedRestartPolicyHintsCompatible: true,
        signedReleaseManifest: 'signature-consistent',
        homeDirectoryIdentity: 'exact',
        homeDirectoryIdentityBasis: 'test-injected',
        installedEnvironment: 'exact',
        loadedEnvironment: 'exact',
        environmentMatchesSignedManifest: true,
        environmentSafe: true,
        invocationSafe: true,
        exactLoadedDefinitionBound: false,
        killSwitchAbsent: true,
        repeatedSnapshotConsistent: true,
        hardDeadlineEnforced: false,
      },
    });
    expect(diagnostic.findings.map(({ code }) => code)).toEqual([
      'immutable-release-trust-root-missing',
      'exact-loaded-definition-binding-missing',
      'atomic-activation-handoff-missing',
      'hard-deadline-worker-missing',
      'native-consumer-evidence-missing',
    ]);
    expect(diagnostic).not.toHaveProperty('ready');
    expect(diagnostic).not.toHaveProperty('state');
    expect(diagnostic).not.toHaveProperty('authority');
    expect(diagnostic).not.toHaveProperty('residentStartAuthorized');
  });

  it.runIf(ACTUAL_PLATFORM === 'darwin')(
    'accepts the real generated launchd plist contract as exact diagnostic evidence',
    () => {
      const definition = generateServiceDefinition({
        platform: 'darwin',
        homeDir: HOME,
        nodePath: NODE,
        binPath: ENTRYPOINT,
      });
      const runtime = definition.launchdRuntime!;
      const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
        input: definition.content,
        encoding: 'utf8',
      });
      expect(converted.status).toBe(0);
      expect(converted.stderr).toBe('');

      const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
        plist: { status: 0, stdout: converted.stdout, stderr: '' },
        runtime: {
          status: 0,
          stdout: launchdPrint(runtime.arguments, TARGET, 'running', 'runatload', 30, runtime.environment),
          stderr: '',
        },
      }));

      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'exact',
        installedEnvironment: 'exact',
        loadedEnvironment: 'exact',
        environmentMatchesSignedManifest: true,
        environmentSafe: true,
        diskDefinitionRestartPolicyCompatible: true,
      });
      expect(diagnostic.operationalAuthority).toBe(false);
      expect(diagnostic.findings.map(({ code }) => code)).toContain('native-consumer-evidence-missing');
    },
  );

  it('binds an exact HOME to a stable descriptor-observed directory identity', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-exact-')));
    try {
      const diagnostic = observeRealHomeIdentity(root);
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'exact',
        installedEnvironment: 'exact',
        loadedEnvironment: 'exact',
        environmentMatchesSignedManifest: true,
        environmentSafe: true,
      });
      expect(diagnostic.operationalAuthority).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a canonical current-user-owned HOME that is not the independently trusted account HOME', () => {
    const alternate = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-override-')));
    try {
      const diagnostic = observeRealHomeIdentity(alternate, { accountHome: HOME });
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'unbound',
        homeDirectoryIdentityBasis: 'test-injected',
        installedEnvironment: 'unbound',
        loadedEnvironment: 'unbound',
        environmentMatchesSignedManifest: null,
        environmentSafe: false,
      });
      expect(diagnostic.findings).toContainEqual(expect.objectContaining({
        code: 'home-directory-identity-unbound',
        severity: 'blocked',
      }));
      expect(diagnostic.operationalAuthority).toBe(false);
    } finally {
      rmSync(alternate, { recursive: true, force: true });
    }
  });

  it('uses the operating-system account HOME when no test identity is injected', () => {
    const alternate = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-production-home-')));
    try {
      const deps = dependencies({ expectedHome: alternate });
      delete deps.testOnlyTrustedAccountIdentity;
      const diagnostic = observeResidentServiceDiagnostic(options({ homeDir: alternate }), deps);
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'unbound',
        homeDirectoryIdentityBasis: 'system-account',
        environmentSafe: false,
      });
      expect(diagnostic.operationalAuthority).toBe(false);
    } finally {
      rmSync(alternate, { recursive: true, force: true });
    }
  });

  it('refuses a lexical parent-segment HOME alias', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-lexical-')));
    const alias = `${root}/../${basename(root)}`;
    try {
      const diagnostic = observeRealHomeIdentity(alias);
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'unbound',
        installedEnvironment: 'unbound',
        loadedEnvironment: 'unbound',
        environmentMatchesSignedManifest: null,
        environmentSafe: false,
      });
      expect(diagnostic.findings).toContainEqual(expect.objectContaining({
        code: 'home-directory-identity-unbound',
        severity: 'blocked',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not bind signed, installed, or loaded HOME aliases to a canonical home identity', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-value-alias-')));
    const alias = `${root}/../${basename(root)}`;
    try {
      const diagnostic = observeRealHomeIdentity(root, { environmentHome: alias });
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'exact',
        installedEnvironment: 'mismatch',
        loadedEnvironment: 'mismatch',
        environmentMatchesSignedManifest: false,
        environmentSafe: false,
      });
      expect(diagnostic.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'service-environment-unsafe', severity: 'blocked' }),
        expect.objectContaining({ code: 'service-environment-mismatch', severity: 'blocked' }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a HOME symlink instead of following its target', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-symlink-')));
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, 'dir');
    try {
      const diagnostic = observeRealHomeIdentity(alias);
      expect(diagnostic.localChecks.homeDirectoryIdentity).toBe('unbound');
      expect(diagnostic.localChecks.environmentSafe).toBe(false);
      expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a case alias whether the host resolves it or reports it missing', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-case-')));
    const canonical = join(root, 'CanonicalHome');
    const alias = join(root, 'canonicalhome');
    mkdirSync(canonical);
    try {
      const diagnostic = observeRealHomeIdentity(alias);
      expect(['unbound', 'degraded']).toContain(diagnostic.localChecks.homeDirectoryIdentity);
      expect(diagnostic.localChecks.environmentSafe).toBe(false);
      expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-NFC Unicode normalization alias', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-unicode-')));
    const canonical = join(root, 'Caf\u00e9Home');
    const alias = join(root, 'Cafe\u0301Home');
    mkdirSync(canonical);
    try {
      const diagnostic = observeRealHomeIdentity(alias);
      expect(diagnostic.localChecks.homeDirectoryIdentity).toBe('unbound');
      expect(diagnostic.localChecks.environmentSafe).toBe(false);
      expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades a missing or unreadable HOME identity', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-unavailable-')));
    const missing = join(root, 'missing');
    try {
      const absent = observeRealHomeIdentity(missing);
      expect(absent.localChecks).toMatchObject({
        homeDirectoryIdentity: 'degraded',
        installedEnvironment: 'degraded',
        loadedEnvironment: 'degraded',
        environmentSafe: false,
      });

      const unreadable = observeRealHomeIdentity(root, {
        homeDirectoryIdentityFs: {
          ...realHomeIdentityFs,
          open: () => {
            const error = new Error('permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          },
        },
      });
      expect(unreadable.localChecks.homeDirectoryIdentity).toBe('degraded');
      expect(unreadable.localChecks.environmentSafe).toBe(false);
      expect(unreadable.findings).toContainEqual(expect.objectContaining({
        code: 'home-directory-identity-unavailable',
        severity: 'degraded',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades a HOME path replaced after the initial descriptor binding', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-race-')));
    const home = join(root, 'home');
    const original = join(root, 'home-original');
    const replacement = join(root, 'replacement');
    mkdirSync(home);
    mkdirSync(replacement);
    let namedReads = 0;
    const racingFs: NonNullable<ResidentServiceDiagnosticDependencies['homeDirectoryIdentityFs']> = {
      ...realHomeIdentityFs,
      lstat: (path) => {
        namedReads += 1;
        if (namedReads === 3) {
          renameSync(home, original);
          symlinkSync(replacement, home, 'dir');
        }
        return lstatSync(path, { bigint: true });
      },
    };
    try {
      const diagnostic = observeRealHomeIdentity(home, { homeDirectoryIdentityFs: racingFs });
      expect(diagnostic.localChecks).toMatchObject({
        homeDirectoryIdentity: 'degraded',
        installedEnvironment: 'degraded',
        loadedEnvironment: 'degraded',
        environmentMatchesSignedManifest: null,
        environmentSafe: false,
      });
      expect(diagnostic.operationalAuthority).toBe(false);
    } finally {
      try {
        if (lstatSync(home).isSymbolicLink()) rmSync(home, { force: true });
      } catch {
        // The path may not have reached the replacement point.
      }
      try {
        realpathSync.native(original);
        renameSync(original, home);
      } catch {
        // The original path was never moved.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a HOME directory not owned by the observed service uid', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m468-home-owner-')));
    const actualUid = typeof process.getuid === 'function' ? process.getuid() : UID;
    try {
      const diagnostic = observeRealHomeIdentity(root, { uid: actualUid + 1 });
      expect(diagnostic.localChecks.homeDirectoryIdentity).toBe('unbound');
      expect(diagnostic.localChecks.environmentSafe).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects NODE_OPTIONS preload injection even when it is signed and exactly observed', () => {
    const environment = { ...GENERATED_ENVIRONMENT, NODE_OPTIONS: '--require /tmp/attacker.js' };
    const diagnostic = observeResidentServiceDiagnostic(
      options({
        signedReleaseManifest: signedReleaseManifest({
          service: {
            label: 'ai.ashlr.daemon',
            platform: 'darwin',
            program: NODE,
            arguments: [...ARGS],
            environment,
          },
        }),
      }),
      dependencies({
        plist: { status: 0, stdout: plist({ EnvironmentVariables: environment }), stderr: '' },
        runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 30, environment), stderr: '' },
      }),
    );

    expect(diagnostic.localChecks).toMatchObject({
      signedReleaseManifest: 'signature-consistent',
      installedEnvironment: 'mismatch',
      loadedEnvironment: 'mismatch',
      environmentMatchesSignedManifest: false,
      environmentSafe: false,
    });
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'service-environment-unsafe',
      severity: 'blocked',
    }));
  });

  it('rejects loaded environment drift from the installed and signed environment', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: {
        status: 0,
        stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 30, { HOME: '/tmp/substituted-home' }),
        stderr: '',
      },
    }));

    expect(diagnostic.localChecks).toMatchObject({
      installedEnvironment: 'exact',
      loadedEnvironment: 'mismatch',
      environmentMatchesSignedManifest: false,
      environmentSafe: false,
    });
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'service-environment-mismatch', severity: 'blocked' }),
      expect.objectContaining({ code: 'service-environment-unsafe', severity: 'blocked' }),
    ]));
  });

  it('distinguishes absent installed and loaded environments', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      plist: { status: 0, stdout: plist({ EnvironmentVariables: null }), stderr: '' },
      runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 30, null), stderr: '' },
    }));

    expect(diagnostic.localChecks.installedEnvironment).toBe('absent');
    expect(diagnostic.localChecks.loadedEnvironment).toBe('absent');
    expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBeNull();
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'installed-service-environment-absent', severity: 'blocked' }),
      expect.objectContaining({ code: 'loaded-service-environment-absent', severity: 'blocked' }),
    ]));
  });

  it('distinguishes unreadable installed and loaded environments', () => {
    const malformedRuntime = launchdPrint().replace(`\t\tHOME => ${HOME}`, '\t\tHOME = malformed');
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      plist: { status: 0, stdout: plist({ EnvironmentVariables: ['not', 'a', 'map'] }), stderr: '' },
      runtime: { status: 0, stdout: malformedRuntime, stderr: '' },
    }));

    expect(diagnostic.localChecks.installedEnvironment).toBe('degraded');
    expect(diagnostic.localChecks.loadedEnvironment).toBe('degraded');
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'installed-service-environment-unavailable', severity: 'degraded' }),
      expect.objectContaining({ code: 'loaded-service-environment-unavailable', severity: 'degraded' }),
    ]));
  });

  it('rejects stale signed release evidence before treating its environment as authoritative', () => {
    const diagnostic = observeResidentServiceDiagnostic(options({
      signedReleaseManifest: signedReleaseManifest({
        issuedAt: '2026-08-01T09:00:00.000Z',
        expiresAt: '2026-08-01T10:00:00.000Z',
      }),
    }), dependencies());

    expect(diagnostic.localChecks.signedReleaseManifest).toBe('stale');
    expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBeNull();
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'signed-release-manifest-stale',
      severity: 'blocked',
    }));
  });

  it('rejects future-dated signed release evidence', () => {
    const diagnostic = observeResidentServiceDiagnostic(options({
      signedReleaseManifest: signedReleaseManifest({
        issuedAt: '2026-08-01T12:05:00.000Z',
        expiresAt: '2026-08-01T12:30:00.000Z',
      }),
    }), dependencies());

    expect(diagnostic.localChecks.signedReleaseManifest).toBe('stale');
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'signed-release-manifest-stale',
      severity: 'blocked',
    }));
  });

  it('degrades duplicate loaded environment blocks instead of choosing one', () => {
    const duplicate = launchdPrint().replace(
      '\tproperties = runatload',
      `\tenvironment = {\n\t\tHOME => ${HOME}\n\t}\n\tproperties = runatload`,
    );
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: { status: 0, stdout: duplicate, stderr: '' },
    }));

    expect(diagnostic.localChecks.loadedEnvironment).toBe('degraded');
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'loaded-service-environment-unavailable',
      severity: 'degraded',
    }));
  });

  it('rejects PATH drift even when installed, loaded, and signed values are exact', () => {
    const environment = { ...GENERATED_ENVIRONMENT, PATH: '/tmp/attacker-bin:/usr/bin:/bin' };
    const diagnostic = observeResidentServiceDiagnostic(
      options({
        signedReleaseManifest: signedReleaseManifest({
          service: {
            label: 'ai.ashlr.daemon',
            platform: 'darwin',
            program: NODE,
            arguments: [...ARGS],
            environment,
          },
        }),
      }),
      dependencies({
        plist: { status: 0, stdout: plist({ EnvironmentVariables: environment }), stderr: '' },
        runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 30, environment), stderr: '' },
      }),
    );

    expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBe(false);
    expect(diagnostic.localChecks.environmentSafe).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-environment-unsafe' }));
  });

  it.each([
    'NODE_PATH',
    'NPM_CONFIG_NODE_OPTIONS',
    'npm_config_node_options',
    'npm_execpath',
    'npm_node_execpath',
    'BASH_ENV',
    'ENV',
    'ZDOTDIR',
    'SHELL',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ])('rejects exact signed runtime influence through %s', (name) => {
    const environment = { ...GENERATED_ENVIRONMENT, [name]: '/tmp/attacker' };
    const diagnostic = observeResidentServiceDiagnostic(
      options({
        signedReleaseManifest: signedReleaseManifest({
          service: {
            label: 'ai.ashlr.daemon',
            platform: 'darwin',
            program: NODE,
            arguments: [...ARGS],
            environment,
          },
        }),
      }),
      dependencies({
        plist: { status: 0, stdout: plist({ EnvironmentVariables: environment }), stderr: '' },
        runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 30, environment), stderr: '' },
      }),
    );

    expect(diagnostic.localChecks.environmentMatchesSignedManifest).toBe(false);
    expect(diagnostic.localChecks.environmentSafe).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-environment-unsafe' }));
  });

  it('distinguishes an absent signed manifest from invalid signed evidence', () => {
    const absent = observeResidentServiceDiagnostic(
      options({ signedReleaseManifest: undefined }),
      dependencies(),
    );
    expect(absent.localChecks.signedReleaseManifest).toBe('absent');
    expect(absent.localChecks.installedEnvironment).toBe('unbound');
    expect(absent.localChecks.loadedEnvironment).toBe('unbound');
    expect(absent.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'trusted-signed-release-evidence-missing', severity: 'blocked' }),
      expect.objectContaining({ code: 'trusted-signed-interpreter-evidence-missing', severity: 'blocked' }),
    ]));

    const invalidBinding = signedReleaseManifest();
    invalidBinding.manifest.signature = Buffer.alloc(64, 7).toString('base64');
    const invalid = observeResidentServiceDiagnostic(
      options({ signedReleaseManifest: invalidBinding }),
      dependencies(),
    );
    expect(invalid.localChecks.signedReleaseManifest).toBe('degraded');
    expect(invalid.localChecks.installedEnvironment).toBe('unbound');
    expect(invalid.localChecks.loadedEnvironment).toBe('unbound');
    expect(invalid.findings).toContainEqual(expect.objectContaining({
      code: 'signed-release-manifest-invalid',
      severity: 'blocked',
    }));
  });

  it('rejects Node loader flags in the signed invocation', () => {
    const argumentsWithLoader = [NODE, '--loader=/tmp/attacker.mjs', ENTRYPOINT, ...ARGS.slice(2)];
    const diagnostic = observeResidentServiceDiagnostic(options({
      signedReleaseManifest: signedReleaseManifest({
        service: {
          label: 'ai.ashlr.daemon',
          platform: 'darwin',
          program: NODE,
          arguments: argumentsWithLoader,
          environment: { ...GENERATED_ENVIRONMENT },
        },
      }),
    }), dependencies());

    expect(diagnostic.localChecks.signedReleaseManifest).toBe('mismatch');
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'signed-release-manifest-mismatch' }),
      expect.objectContaining({ code: 'service-invocation-unsafe' }),
    ]));
  });

  it('blocks an explicitly disabled service', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      disabled: {
        status: 0,
        stdout: 'disabled services = {\n\t"ai.ashlr.daemon" => disabled\n}\n',
        stderr: '',
      },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.enabled).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-disabled' }));
  });

  it('blocks a proven absent loaded service', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: { status: 113, stdout: '', stderr: 'Could not find service' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.loaded).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-not-loaded' }));
  });

  it('blocks a different runtime label and invocation', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: { status: 0, stdout: launchdPrint(ARGS, 'gui/501/ai.attacker.daemon'), stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.exactLabel).toBe(false);
    expect(diagnostic.localChecks.observedInvocationMatchesDeclaration).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-invocation-mismatch' }));
  });

  it('blocks an invocation outside the caller-declared release', () => {
    const foreignArgs = [...ARGS];
    foreignArgs[1] = '/tmp/ashlr/bin/ashlr';
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: { status: 0, stdout: launchdPrint(foreignArgs), stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.observedInvocationMatchesDeclaration).toBe(false);
  });

  it.each(['waiting', 'exited', 'stopped', 'dead'])(
    'diagnoses a loaded launchd job in %s state',
    (state) => {
      const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
        runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, state), stderr: '' },
      }));
      expect(diagnostic.diagnosticStatus).toBe('blocked');
      expect(diagnostic.localChecks.running).toBe(false);
      expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-not-running' }));
    },
  );

  it.each([
    ['missing loaded properties', launchdPrint(ARGS, TARGET, 'running', '')],
    ['automatic keepalive', launchdPrint(ARGS, TARGET, 'running', 'keepalive | runatload')],
    ['missing runatload', launchdPrint(ARGS, TARGET, 'running', 'other')],
    ['launch-only-once', launchdPrint(ARGS, TARGET, 'running', 'runatload | launchonlyonce')],
  ])('blocks when restart policy is not proven from loaded state: %s', (_name, stdout) => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      runtime: { status: 0, stdout, stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.loadedRestartPolicyHintsCompatible).not.toBe(true);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'restart-policy-mismatch' }));
  });

  it('binds the generated throttle while treating launchd minimum-runtime hints as non-authoritative', () => {
    const diagnostic = observeResidentServiceDiagnostic(options({ restartSec: 999 }), dependencies({
      plist: { status: 0, stdout: plist({ ThrottleInterval: 999 }), stderr: '' },
      runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, 'running', 'runatload', 1), stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.lifecycleAuthority).toBe('none');
    expect(diagnostic.localChecks.diskDefinitionRestartPolicyCompatible).toBe(true);
    expect(diagnostic.localChecks.loadedRestartPolicyHintsCompatible).toBe(true);
    expect(diagnostic.findings).not.toContainEqual(expect.objectContaining({ code: 'restart-policy-mismatch' }));
  });

  it('blocks a release tree digest mismatch', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ releaseSha: 'b'.repeat(64) }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localReleaseMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'release-binding-mismatch' }));
  });

  it('blocks an interpreter identity mismatch even when the path is exact', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      interpreterSha: 'e'.repeat(64),
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localInterpreterMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'interpreter-binding-mismatch' }));
  });

  it('blocks before observation when nodePath disagrees with the interpreter contract', () => {
    const deps = dependencies();
    deps.run = () => { throw new Error('must not run'); };
    const diagnostic = observeResidentServiceDiagnostic(options({ nodePath: '/tmp/substituted-node' }), deps);
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localInterpreterMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'interpreter-declaration-invalid' }));
  });

  it('blocks a non-canonical release identity before probing launchd', () => {
    const diagnostic = observeResidentServiceDiagnostic(options({
      release: {
        root: RELEASE_ROOT,
        identity: 'not-a-release',
        treeSha256: TREE_SHA,
        interpreter: { path: NODE, sha256: INTERPRETER_SHA },
      },
    }), dependencies());
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localReleaseMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'release-declaration-invalid' }));
  });

  it.each([
    ['RunAtLoad', { RunAtLoad: false }],
    ['KeepAlive true', { KeepAlive: true }],
    ['KeepAlive false', { KeepAlive: false }],
    ['successful-exit relaunch', { KeepAlive: { SuccessfulExit: true } }],
    ['extra keepalive predicate', { KeepAlive: { SuccessfulExit: false, NetworkState: true } }],
    ['conditional keepalive', { KeepAlive: { NetworkState: true } }],
    ['ThrottleInterval mismatch', { ThrottleInterval: 5 }],
    ['ThrottleInterval above the generated bound', { ThrottleInterval: 3_601 }],
    ['extra launch trigger', { StartInterval: 30 }],
    ['LaunchOnlyOnce', { LaunchOnlyOnce: true }],
    ['Program override', { Program: '/tmp/substituted-node' }],
  ])('blocks incompatible restart policy: %s', (_name, plistOverrides) => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      plist: { status: 0, stdout: plist(plistOverrides), stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.diskDefinitionRestartPolicyCompatible).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'restart-policy-mismatch' }));
  });

  it('blocks a present kill switch without clearing it', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ kill: 'present' }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.killSwitchAbsent).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'kill-switch-present' }));
  });

  it.each([
    ['first snapshot', ['present', 'absent', 'absent']],
    ['second snapshot', ['absent', 'present', 'absent']],
    ['final observation', ['absent', 'absent', 'present']],
  ] as const)('preserves kill-switch presence from the %s as a blocker', (_name, killSequence) => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      killSequence: [...killSequence],
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.killSwitchAbsent).toBe(false);
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'kill-switch-present', severity: 'blocked' }),
      expect.objectContaining({ code: 'observation-changed', severity: 'degraded' }),
    ]));
  });

  it('degrades unknown kill-switch state', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ kill: 'unknown' }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.killSwitchAbsent).toBeNull();
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'kill-switch-state-unavailable' }));
  });

  it('degrades an ambiguous enable observation', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      disabled: { status: 0, stdout: 'disabled services = {}\n', stderr: '' },
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.enabled).toBeNull();
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'service-enable-state-unavailable' }));
  });

  it('keeps a proven blocker dominant when another observation is degraded', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({
      disabled: { status: 0, stdout: 'disabled services = {}\n', stderr: '' },
      kill: 'present',
    }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'service-enable-state-unavailable', severity: 'degraded' }),
      expect.objectContaining({ code: 'kill-switch-present', severity: 'blocked' }),
    ]));
  });

  it('fails closed when state changes between snapshots', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ varySecondRuntime: true }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('fails closed when the release tree changes between snapshots', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ varySecondRelease: true }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localReleaseMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('detects release mutation that occurs only after the final service observation', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ varyFinalRelease: true }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localReleaseMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'release-binding-mismatch' }),
      expect.objectContaining({ code: 'observation-changed' }),
    ]));
  });

  it('detects interpreter mutation that occurs only after the final service observation', () => {
    const diagnostic = observeResidentServiceDiagnostic(options(), dependencies({ varyFinalInterpreter: true }));
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.localInterpreterMatchesDeclaredDigest).toBe(false);
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'interpreter-binding-mismatch' }));
  });

  it('uses only the read-only launchctl and plutil command surface', () => {
    const calls: Array<[string, readonly string[]]> = [];
    const deps = dependencies();
    const baseRun = deps.run!;
    deps.run = (command, args, timeoutMs) => {
      calls.push([command, args]);
      return baseRun(command, args, timeoutMs);
    };
    observeResidentServiceDiagnostic(options(), deps);

    expect(calls).toHaveLength(6);
    expect(calls.filter(([command]) => command.includes('launchctl')).every(([command]) => (
      command === '/bin/launchctl'
    ))).toBe(true);
    expect(calls.every(([command, args]) => (
      (command === '/bin/launchctl' && (args[0] === 'print' || args[0] === 'print-disabled'))
      || (command === '/usr/bin/plutil' && args[0] === '-convert')
    ))).toBe(true);
    expect(calls.flatMap(([, args]) => args)).not.toEqual(expect.arrayContaining([
      'bootstrap', 'enable', 'load', 'kickstart', 'start', 'install', 'rm', 'unlink',
    ]));
  });

  it.each(['linux', 'win32'] as const)('fails closed on %s without probing service state', (platform) => {
    const deps = dependencies();
    deps.run = () => { throw new Error('must not run'); };
    let diagnostic: ReturnType<typeof observeResidentServiceDiagnostic>;
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      diagnostic = observeResidentServiceDiagnostic(options({ platform: 'darwin' }), deps);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    }
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({ code: 'unsupported-platform' }));
  });

  it('uses host platform truth rather than the caller-selected service platform', () => {
    const diagnostic = observeResidentServiceDiagnostic(
      options({ platform: 'linux' }),
      dependencies(),
    );
    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.localChecks.running).toBe(true);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'atomic-activation-handoff-missing',
    }));
  });

  it('never lets the test-only clock mint a production claim', () => {
    const deps = dependencies();
    deps.testOnlyNowMs = () => 1_000;

    const diagnostic = observeResidentServiceDiagnostic(options(), deps);

    expect(diagnostic.diagnosticStatus).toBe('blocked');
    expect(diagnostic.lifecycleAuthority).toBe('none');
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(true);
    expect(diagnostic.localChecks.hardDeadlineEnforced).toBe(false);
    expect(diagnostic.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'hard-deadline-worker-missing', severity: 'blocked' }),
      expect.objectContaining({ code: 'atomic-activation-handoff-missing', severity: 'blocked' }),
    ]));
  });

  it('shares one decreasing deadline across hashing and commands and stops probing when exhausted', () => {
    let now = 0;
    const bindingBudgets: number[] = [];
    const commandBudgets: number[] = [];
    let releaseReads = 0;
    const deps = dependencies();
    deps.testOnlyNowMs = () => now;
    deps.releaseTreeBinding = (_path, timeoutMs) => {
      bindingBudgets.push(timeoutMs);
      now += 4;
      releaseReads += 1;
      return { path: RELEASE_ROOT, sha256: TREE_SHA };
    };
    deps.interpreterBinding = (_path, timeoutMs) => {
      bindingBudgets.push(timeoutMs);
      now += 4;
      return { path: NODE, sha256: INTERPRETER_SHA };
    };
    const baseRun = deps.run!;
    deps.run = (command, args, timeoutMs) => {
      commandBudgets.push(timeoutMs);
      now += 4;
      return baseRun(command, args, timeoutMs);
    };

    const diagnostic = observeResidentServiceDiagnostic(options({ timeoutMs: 10 }), deps);

    expect(bindingBudgets).toEqual([10, 6]);
    expect(commandBudgets).toEqual([2]);
    expect(releaseReads).toBe(1);
    expect(diagnostic.localChecks.repeatedSnapshotConsistent).toBe(false);
    expect(diagnostic.findings).toContainEqual(expect.objectContaining({
      code: 'observation-deadline-exceeded',
    }));
  });
});
