import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  residentServiceReadiness,
  type ResidentServiceReadinessDependencies,
  type ResidentServiceReadinessOptions,
} from '../src/core/daemon/resident-service-readiness.js';

const HOME = '/Users/tester';
const RELEASE_ID = '0123456789abcdef0123456789abcdef01234567';
const TREE_SHA = 'a'.repeat(64);
const INTERPRETER_SHA = 'b'.repeat(64);
const RELEASE_ROOT = `${HOME}/.local/share/ashlr/releases/${RELEASE_ID}`;
const NODE = '/opt/homebrew/bin/node';
const ENTRYPOINT = `${RELEASE_ROOT}/bin/ashlr`;
const PLIST = `${HOME}/Library/LaunchAgents/ai.ashlr.daemon.plist`;
const UID = 501;
const TARGET = `gui/${UID}/ai.ashlr.daemon`;
const ACTUAL_PLATFORM = process.platform;
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
      interpreter: {
        path: NODE,
        sha256: INTERPRETER_SHA,
      },
    },
    ...overrides,
  };
}

function launchdPrint(
  args: readonly string[] = ARGS,
  target = TARGET,
  state = 'running',
  properties = 'keepalive | runatload',
  minimumRuntime = 30,
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
    `\tminimum runtime = ${minimumRuntime}`,
    `\tproperties = ${properties}`,
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
  interpreterPath?: string;
  interpreterSha?: string;
  varySecondRelease?: boolean;
  varyFinalRelease?: boolean;
  varyFinalInterpreter?: boolean;
  varySecondRuntime?: boolean;
  killSequence?: Array<'absent' | 'present' | 'unknown'>;
} = {}): ResidentServiceReadinessDependencies {
  let runtimeReads = 0;
  let killReads = 0;
  return {
    uid: () => UID,
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
      expect(path).toBe(join(HOME, '.ashlr', 'KILL'));
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
        expect(args).toEqual(['-convert', 'json', '-o', '-', PLIST]);
        return overrides.plist ?? { status: 0, stdout: plist(), stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
}

describe('residentServiceReadiness', () => {
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: ACTUAL_PLATFORM });
  });

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
        running: true,
        enabled: true,
        immutableRelease: true,
        interpreterIdentityBound: true,
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

  it.each(['waiting', 'exited', 'stopped', 'dead'])(
    'never admits a loaded launchd job in %s state',
    (state) => {
      const readiness = residentServiceReadiness(options(), dependencies({
        runtime: { status: 0, stdout: launchdPrint(ARGS, TARGET, state), stderr: '' },
      }));
      expect(readiness.state).toBe('blocked');
      expect(readiness.ready).toBe(false);
      expect(readiness.checks.running).toBe(false);
      expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'service-not-running' }));
    },
  );

  it.each([
    ['missing loaded properties', launchdPrint(ARGS, TARGET, 'running', '')],
    ['missing keepalive', launchdPrint(ARGS, TARGET, 'running', 'runatload')],
    ['missing runatload', launchdPrint(ARGS, TARGET, 'running', 'keepalive')],
    ['wrong loaded throttle', launchdPrint(ARGS, TARGET, 'running', 'keepalive | runatload', 5)],
    ['launch-only-once', launchdPrint(ARGS, TARGET, 'running', 'keepalive | runatload | launchonlyonce')],
  ])('blocks when restart policy is not proven from loaded state: %s', (_name, stdout) => {
    const readiness = residentServiceReadiness(options(), dependencies({
      runtime: { status: 0, stdout, stderr: '' },
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.restartPolicyCompatible).not.toBe(true);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'restart-policy-mismatch' }));
  });

  it('blocks a release tree digest mismatch', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ releaseSha: 'b'.repeat(64) }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'release-binding-mismatch' }));
  });

  it('blocks an interpreter identity mismatch even when the path is exact', () => {
    const readiness = residentServiceReadiness(options(), dependencies({
      interpreterSha: 'e'.repeat(64),
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.interpreterIdentityBound).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'interpreter-binding-mismatch' }));
  });

  it('blocks before observation when nodePath disagrees with the interpreter contract', () => {
    const deps = dependencies();
    deps.run = () => { throw new Error('must not run'); };
    const readiness = residentServiceReadiness(options({ nodePath: '/tmp/substituted-node' }), deps);
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.interpreterIdentityBound).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'interpreter-contract-invalid' }));
  });

  it('blocks a non-canonical release identity before probing launchd', () => {
    const readiness = residentServiceReadiness(options({
      release: {
        root: RELEASE_ROOT,
        identity: 'not-a-release',
        treeSha256: TREE_SHA,
        interpreter: { path: NODE, sha256: INTERPRETER_SHA },
      },
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

  it.each([
    ['first snapshot', ['present', 'absent', 'absent']],
    ['second snapshot', ['absent', 'present', 'absent']],
    ['final observation', ['absent', 'absent', 'present']],
  ] as const)('preserves kill-switch presence from the %s as a blocker', (_name, killSequence) => {
    const readiness = residentServiceReadiness(options(), dependencies({
      killSequence: [...killSequence],
    }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.killSwitchAbsent).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'kill-switch-present', severity: 'blocked' }),
      expect.objectContaining({ code: 'observation-changed', severity: 'degraded' }),
    ]));
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

  it('fails closed when state changes between snapshots', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varySecondRuntime: true }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('fails closed when the release tree changes between snapshots', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varySecondRelease: true }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'observation-changed' }));
  });

  it('detects release mutation that occurs only after the final service observation', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varyFinalRelease: true }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.immutableRelease).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'release-binding-mismatch' }),
      expect.objectContaining({ code: 'observation-changed' }),
    ]));
  });

  it('detects interpreter mutation that occurs only after the final service observation', () => {
    const readiness = residentServiceReadiness(options(), dependencies({ varyFinalInterpreter: true }));
    expect(readiness.state).toBe('blocked');
    expect(readiness.checks.interpreterIdentityBound).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'interpreter-binding-mismatch' }));
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

  it('fails closed on non-macOS platforms without probing service state', () => {
    const deps = dependencies();
    deps.run = () => { throw new Error('must not run'); };
    let readiness: ReturnType<typeof residentServiceReadiness>;
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      readiness = residentServiceReadiness(options({ platform: 'darwin' }), deps);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    }
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: 'unsupported-platform' }));
  });

  it('uses host platform truth rather than the caller-selected service platform', () => {
    const readiness = residentServiceReadiness(
      options({ platform: 'linux' }),
      dependencies(),
    );
    expect(readiness.state).toBe('ready');
  });

  it('shares one decreasing deadline across hashing and commands and stops probing when exhausted', () => {
    let now = 0;
    const bindingBudgets: number[] = [];
    const commandBudgets: number[] = [];
    let releaseReads = 0;
    const deps = dependencies();
    deps.nowMs = () => now;
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

    const readiness = residentServiceReadiness(options({ timeoutMs: 10 }), deps);

    expect(bindingBudgets).toEqual([10, 6]);
    expect(commandBudgets).toEqual([2]);
    expect(releaseReads).toBe(1);
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.stableObservation).toBe(false);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({
      code: 'observation-deadline-exceeded',
    }));
  });
});
