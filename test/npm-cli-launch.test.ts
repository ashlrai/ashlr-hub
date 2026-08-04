import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
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
    const replacementMarker = join(fixtureRoot, 'transitive-replacement-ran');
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
        write(transitiveCli, [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'unsafe');`,
          "process.stdout.write('forged runtime');",
        ].join('\n'));
      },
    })).toThrow('npm runtime closure changed during execution');
    expect(existsSync(replacementMarker)).toBe(false);
  });

  it('isolates execution from an npm runtime ABA even when the original bytes are restored', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-runtime-aba-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const transitiveCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'lib', 'cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    const replacementMarker = join(fixtureRoot, 'aba-replacement-ran');
    const original = "process.stdout.write('validated runtime');\n";
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "require('../lib/cli.js');\n");
    write(transitiveCli, original);
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');

    const run = () => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
      beforeSpawn: () => {
        write(transitiveCli, [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'unsafe');`,
          "process.stdout.write('forged runtime');",
        ].join('\n'));
        write(transitiveCli, original);
      },
    });
    if (process.platform === 'win32') {
      expect(run).not.toThrow();
    } else {
      expect(run).toThrow('npm runtime closure changed during execution');
    }
    expect(existsSync(replacementMarker)).toBe(false);
  });

  it('rejects an enclosing-directory ABA that restores the validated npm closure', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-ancestor-aba-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const nodeModules = join(fixtureRoot, 'lib', 'node_modules');
    const displaced = join(fixtureRoot, 'lib', 'node_modules.validated');
    const forged = join(fixtureRoot, 'lib', 'node_modules.forged');
    const trustedCli = join(nodeModules, 'npm', 'bin', 'npm-cli.js');
    const transitiveCli = join(nodeModules, 'npm', 'lib', 'cli.js');
    const packageJson = join(nodeModules, 'npm', 'package.json');
    const replacementMarker = join(fixtureRoot, 'ancestor-replacement-ran');
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
        renameSync(nodeModules, displaced);
        write(join(nodeModules, 'npm', 'lib', 'cli.js'), [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'unsafe');`,
          `fs.renameSync(${JSON.stringify(nodeModules)}, ${JSON.stringify(forged)});`,
          `fs.renameSync(${JSON.stringify(displaced)}, ${JSON.stringify(nodeModules)});`,
          "process.stdout.write('forged runtime');",
        ].join('\n'));
      },
    })).toThrow(/(?:npm (?:CLI|runtime ancestor) changed during execution|EPERM:.*rename)/u);
    expect(existsSync(replacementMarker)).toBe(false);
  });

  it('does not resolve npm modules from an unmeasured ancestor package', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-ancestor-module-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const nodeModules = join(fixtureRoot, 'lib', 'node_modules');
    const trustedCli = join(nodeModules, 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(nodeModules, 'npm', 'package.json');
    const escapeMarker = join(fixtureRoot, 'ancestor-module-ran');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "require('unmeasured-escape');\n");
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');
    write(join(nodeModules, 'unmeasured-escape', 'index.js'), [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(escapeMarker)}, 'unsafe');`,
    ].join('\n'));

    const result = runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(escapeMarker)).toBe(false);
  });

  it('rejects unbounded npm child timeouts before spawning', () => {
    expect(() => runTrustedNpmCli([], { timeout: 0 })).toThrow('npm CLI timeout is invalid');
    expect(() => runTrustedNpmCli([], { timeout: 180_001 })).toThrow('npm CLI timeout is invalid');
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
