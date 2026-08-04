import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveNpmCliLaunch,
  runTrustedNpmCli,
} from '../scripts/build-release-dependency-inventory.mjs';

const tempDirs: string[] = [];

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o644 });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('shell-free npm CLI launch', () => {
  it('uses only the npm CLI rooted in the active Node toolchain', () => {
    const launch = resolveNpmCliLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.npmCliPath).toBe(realpathSync(process.env['npm_execpath']!));
    closeLaunch(launch);

    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-cli-')));
    tempDirs.push(fixtureRoot);
    const maliciousCli = join(fixtureRoot, 'npm', 'bin', 'npm-cli.js');
    write(maliciousCli, 'process.exit(0);\n');
    write(
      join(fixtureRoot, 'npm', 'package.json'),
      '{"name":"npm","version":"10.0.0"}\n',
    );

    expect(() => resolveNpmCliLaunch({ npm_execpath: maliciousCli }))
      .toThrow('npm_execpath does not match the trusted Node toolchain');
    expect(() => resolveNpmCliLaunch({ npm_execpath: 'npm-cli.js' }))
      .toThrow('npm_execpath does not match the trusted Node toolchain');
    expect(() => resolveNpmCliLaunch({ npm_execpath: `${maliciousCli}\n--eval` }))
      .toThrow('npm_execpath does not match the trusted Node toolchain');
  });

  it('rejects replacement after validation without executing the replacement path', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-race-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    const replacementMarker = join(fixtureRoot, 'replacement-ran');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "process.stdout.write('validated launcher');\n");
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');

    expect(() => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
      beforeSpawn: () => {
        write(
          trustedCli,
          `require('node:fs').writeFileSync(${JSON.stringify(replacementMarker)}, 'unsafe');\n`,
        );
      },
    })).toThrow('npm CLI changed during execution');
    expect(existsSync(replacementMarker)).toBe(false);
  });

  it('rejects transitive npm runtime replacement after validation', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-runtime-race-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const transitiveCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'lib', 'cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "require('../lib/cli.js');\n");
    write(transitiveCli, "process.stdout.write('validated runtime');\n");
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');

    expect(() => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
      beforeSpawn: () => {
        write(transitiveCli, "process.stdout.write('forged runtime');\n");
      },
    })).toThrow('npm runtime closure changed during execution');
  });

  it('rejects an npm runtime ABA mutation even when the original bytes are restored', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-runtime-aba-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const transitiveCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'lib', 'cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    const original = "process.stdout.write('validated runtime');\n";
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "require('../lib/cli.js');\n");
    write(transitiveCli, original);
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');

    expect(() => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
      beforeSpawn: () => {
        write(transitiveCli, "process.stdout.write('forged runtime');\n");
        write(transitiveCli, original);
      },
    })).toThrow('npm runtime closure changed during execution');
  });
});

function closeLaunch(launch: ReturnType<typeof resolveNpmCliLaunch>): void {
  const descriptors = [launch.npmCli.descriptor, launch.packageJson.descriptor];
  for (const descriptor of descriptors) {
    try {
      // resolveNpmCliLaunch exposes handles so execution never reopens validated bytes.
      closeSync(descriptor);
    } catch {
      // Already closed by an assertion failure.
    }
  }
}
