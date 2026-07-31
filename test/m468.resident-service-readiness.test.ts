import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  residentServiceReadiness,
  type ResidentServiceReadinessDependencies,
  type ResidentServiceReadinessOptions,
} from '../src/core/daemon/resident-service-readiness.js';

const HOME = '/Users/tester';
const RELEASE_ID = '0123456789abcdef0123456789abcdef01234567';
const TREE_SHA = 'a'.repeat(64);
const RELEASE_ROOT = `${HOME}/.local/share/ashlr/releases/${RELEASE_ID}`;
const NODE = '/opt/homebrew/bin/node';
const ENTRYPOINT = `${RELEASE_ROOT}/bin/ashlr`;
const PLIST = `${HOME}/Library/LaunchAgents/ai.ashlr.daemon.plist`;
const UID = 501;
const TARGET = `gui/${UID}/ai.ashlr.daemon`;
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

function options(overrides: Partial<ResidentServiceReadinessOptions> = {}): ResidentServiceReadinessOptions {
  return {
    platform: 'darwin',
    homeDir: HOME,
    nodePath: NODE,
    release: {
      root: RELEASE_ROOT,
      identity: RELEASE_ID,
      treeSha256: TREE_SHA,
    },
    ...overrides,
  };
}

function launchdPrint(args: readonly string[] = ARGS, target = TARGET): string {
  return `${[
    `${target} = {`,
    `\tpath = ${PLIST}`,
    '\tstate = waiting',
    `\tprogram = ${args[0]}`,
    '\targuments = {',
    ...args.map((argument) => `\t\t${argument}`),
    '\t}',
    '}',
  ].join('\n')}\n`;
}

function plist(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Label: 'ai.ashlr.daemon',
    ProgramArguments: ARGS,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    ...overrides,
  });
}

function dependencies(overrides: {
  runtime?: { status: number; stdout: string; stderr: string };
  disabled?: { status: number; stdout: string; stderr: string };
  plist?: { status: number; stdout: string; stderr: string };
  kill?: 'absent' | 'present' | 'unknown';
  releasePath?: string;
  releaseSha?: string;
  varySecondRelease?: boolean;
  varySecondRuntime?: boolean;
} = {}): ResidentServiceReadinessDependencies {
  let runtimeReads = 0;
  return {
    uid: () => UID,
    releaseTreeBinding: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        return {
          path: overrides.releasePath ?? RELEASE_ROOT,
          sha256: overrides.varySecondRelease && reads === 2
            ? 'c'.repeat(64)
            : overrides.releaseSha ?? TREE_SHA,
        };
      };
    })(),
    killSwitchState: (path) => {
      expect(path).toBe(join(HOME, '.ashlr', 'KILL'));
      return overrides.kill ?? 'absent';
    },
    run: (command, args) => {
      if (command === 'launchctl' && args[0] === 'print') {
        runtimeReads += 1;
        if (overrides.varySecondRuntime && runtimeReads === 2) {
          return { status: 0, stdout: launchdPrint([...ARGS, '--changed']), stderr: '' };
        }
        return overrides.runtime ?? { status: 0, stdout: launchdPrint(), stderr: '' };
      }
      if (command === 'launchctl' && args[0] === 'print-disabled') {
        return overrides.disabled ?? {
          status: 0,
          stdout: 'disabled services = {\n\t"ai.ashlr.daemon" => enabled\n}\n',
          stderr: '',
        };
      }
      if (command === '/usr/bin/plutil') {
        expect(args).toEqual(['-convert', 'json', '-o', '-', PLIST]);
        return overrides.plist ?? { status: 0, stdout: plist(), stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
}

describe('residentServiceReadiness', () => {
  it('admits only a stable exact resident observation and grants no authority', () => {
    const readiness = residentServiceReadiness(options(), dependencies());

    expect(readiness).toMatchObject({
      authority: 'observation-only',
      state: 'ready',
      ready: true,
      residentStartAuthorized: false,
      installAuthorized: false,
      enableAuthorized: false,
      loadAuthorized: false,
      kickstartAuthorized: false,
      killSwitchClearAuthorized: false,
      checks: {
        exactLabel: true,
        loaded: true,
        enabled: true,
        immutableRelease: true,
        exactInvocation: true,
        restartPolicyCompatible: true,
        killSwitchAbsent: true,
        stableObservation: true,
      },
      reasons: [],
    });
  });

  it('blocks an explicitly disabled service', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      disabled: {
        status: 0,
        stdout: 'disabled services = {\n\t"ai.ashlr.daemon" => disabled\n}\n',
        stderr: '',
      },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.enabled).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'service-disabled' }));
  });

  it('blocks a proven absent loaded service', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      runtime: { status: 113, stdout: '', stderr: 'Could not find service' },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.loaded).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'service-not-loaded' }));
  });

  it('blocks a different runtime label and invocation', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      runtime: { status: 0, stdout: launchdPrint(ARGS, 'gui/501/ai.attacker.daemon'), stderr: '' },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.exactLabel).toBe(false);
    expect(readiness.checks.exactInvocation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'service-invocation-mismatch' }));
  });

  it('blocks an invocation outside the admitted immutable release', () => {
    const foreignArgs = [...ARGS];
    foreignArgs[1] = '/tmp/ashlr/bin/ashlr';
    const readiness = residentServiceReadiness(options(), dependencies({
      runtime: { status: 0, stdout: launchdPrint(foreignArgs), stderr: '' },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.exactInvocation).toBe(false);
  });

  it('blocks a release tree digest mismatch', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ releaseSha: 'b'.repeat(64) }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'release-binding-mismatch' }));
  });

  it('blocks a non-canonical release identity before probing launchd', () => {
    const readiness = residentServiceReadiness(options({
      release: { root: RELEASE_ROOT, identity: 'not-a-release', treeSha256: TREE_SHA },
    }), dependencies());
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'release-contract-invalid' }));
  });

  it.each([
    ['RunAtLoad', { RunAtLoad: false }],
    ['SuccessfulExit', { KeepAlive: { SuccessfulExit: true } }],
    ['extra keepalive condition', { KeepAlive: { SuccessfulExit: false, NetworkState: true } }],
    ['ThrottleInterval', { ThrottleInterval: 5 }],
    ['LaunchOnlyOnce', { LaunchOnlyOnce: true }],
    ['Program override', { Program: '/tmp/substituted-node' }],
  ])('blocks incompatible restart policy: %s', (_name, plistOverrides) => {
    const readiness = residentServiceReadiness(options(), dependencies({
      plist: { status: 0, stdout: plist(plistOverrides), stderr: '' },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.restartPolicyCompatible).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'restart-policy-mismatch' }));
  });

  it('blocks a present kill switch without clearing it', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ kill: 'present' }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.killSwitchAbsent).toBe(false);
    expect(readiness.killSwitchClearAuthorized).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'kill-switch-present' }));
  });

  it('degrades unknown kill-switch state', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ kill: 'unknown' }));
    expect(readiness.state).toBe('degraded');
    expect(readiness.checks.killSwitchAbsent).toBeNull();
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'kill-switch-state-unavailable' }));
  });

  it('degrades an ambiguous enable observation', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      disabled: { status: 0, stdout: 'disabled services = {}\n', stderr: '' },
    }));
    expect(readiness.state).toBe('degraded');
    expect(readiness.checks.enabled).toBeNull();
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'service-enable-state-unavailable' }));
  });

  it('keeps a proven blocker dominant when another observation is degraded', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      disabled: { status: 0, stdout: 'disabled services = {}\n', stderr: '' },
      kill: 'present',
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'service-enable-state-unavailable', severity: 'degraded' }),
      expect.objectContaining({ code: 'kill-switch-present', severity: 'blocked' }),
    ]));
  });

  it('degrades when state changes between snapshots', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varySecondRuntime: true }));
    expect(readiness.state).toBe('degraded');
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('degrades when the release tree changes between snapshots', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varySecondRelease: true }));
    expect(readiness.state).toBe('degraded');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('uses only the read-only launchctl and plutil command surface', () => {
    const calls: Array<[string, readonly string[]]> = [];
    const deps = dependencies();
    const baseRun = deps.run!;
    deps.run = (command, args, timeoutMs) => {
      calls.push([command, args]);
      return baseRun(command, args, timeoutMs);
    };
    residentServiceReadiness(options(), deps);

    expect(calls).toHaveLength(6);
    expect(calls.every(([command, args]) => (
      (command === 'launchctl' && (args[0] === 'print' || args[0] === 'print-disabled'))
      || (command === '/usr/bin/plutil' && args[0] === '-convert')
    ))).toBe(true);
    expect(calls.flatMap(([, args]) => args)).not.toEqual(expect.arrayContaining([
      'bootstrap', 'enable', 'load', 'kickstart', 'start', 'install', 'rm', 'unlink',
    ]));
  });

  it('fails closed on non-macOS platforms without probing service state', () => {
    const deps = dependencies();
    deps.run = () => { throw new Error('must not run'); };
    const readiness = residentServiceReadiness(options({ platform: 'linux' }), deps);
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'unsupported-platform' }));
  });
});
