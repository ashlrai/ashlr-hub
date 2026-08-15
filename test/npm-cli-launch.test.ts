import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveNpmCliLaunch,
  removeExactEmptySnapshotContainer,
  runTrustedNpmCli,
} from '../scripts/build-release-dependency-inventory.mjs';
import {
  _setPrivateStorageTestControlForTest,
  assurePrivateStoragePath,
  PRIVATE_STORAGE_TEST_CONTROL,
} from '../src/core/util/private-storage.js';
import { canSymlink } from './helpers/platform.js';

const tempDirs: string[] = [];

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o644 });
}

afterEach(() => {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
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

  it('constructs a private npm environment and rejects ambient overrides', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-hermetic-env-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, 'process.stdout.write(JSON.stringify(process.env));\n');
    write(
      join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json'),
      '{"name":"npm","version":"10.0.0"}\n',
    );
    const hostileUserConfig = join(fixtureRoot, 'hostile-user.npmrc');
    write(hostileUserConfig, 'registry=https://hostile.invalid/\n');

    const result = runTrustedNpmCli([], {
      environment: {
        HOME: join(fixtureRoot, 'hostile-home'),
        NODE_OPTIONS: '--import=hostile',
        NPM_CONFIG_REGISTRY: 'https://hostile.invalid/',
        PATH: join(fixtureRoot, 'hostile-path'),
        Path: join(fixtureRoot, 'hostile-case-path'),
        npm_config_cache: join(fixtureRoot, 'hostile-cache'),
        npm_config_userconfig: hostileUserConfig,
        npm_execpath: trustedCli,
      },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    });
    expect(result.status).toBe(0);
    const childEnvironment = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnvironment).not.toHaveProperty('NODE_OPTIONS');
    expect(childEnvironment).not.toHaveProperty('NPM_CONFIG_REGISTRY');
    const controlledPathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const controlledPathEntries = Object.entries(childEnvironment).filter(
      ([key]) => key.toLowerCase() === 'path',
    );
    expect(controlledPathEntries).toEqual([
      [controlledPathKey, dirname(realpathSync(process.execPath))],
    ]);
    expect(controlledPathEntries[0]?.[1]).not.toContain('node_modules');
    expect(controlledPathEntries[0]?.[1]).not.toContain('hostile');
    expect(childEnvironment['HOME']).not.toBe(join(fixtureRoot, 'hostile-home'));
    expect(childEnvironment['npm_config_cache']).not.toBe(join(fixtureRoot, 'hostile-cache'));
    expect(childEnvironment['npm_config_userconfig']).not.toBe(hostileUserConfig);
    expect(childEnvironment).toMatchObject({
      HOME: childEnvironment['USERPROFILE'],
      TEMP: childEnvironment['TMP'],
      TMP: childEnvironment['TMPDIR'],
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
      npm_node_execpath: process.execPath,
    });

    expect(() => runTrustedNpmCli([], {
      env: { npm_config_registry: 'https://hostile.invalid/' },
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    })).toThrow('npm CLI environment overrides are unsupported');

  });

  it('intrinsically ignores a project npmrc created immediately before spawn', () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-project-race-')));
    tempDirs.push(projectRoot);
    write(join(projectRoot, 'package.json'), '{"name":"project-race","version":"1.0.0"}\n');
    let injected = false;
    const result = runTrustedNpmCli(['config', 'get', 'registry'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }, {
      beforeSpawn: () => {
        injected = true;
        write(join(projectRoot, '.npmrc'), 'registry=https://hostile.invalid/\n');
      },
    });
    expect(injected).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('https://registry.npmjs.org/');
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

  it.runIf(canSymlink())('keeps install-generated npm runtime bin links outside the trusted closure', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-runtime-link-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const npmRoot = join(fixtureRoot, 'lib', 'node_modules', 'npm');
    const trustedCli = join(npmRoot, 'bin', 'npm-cli.js');
    const packageJson = join(npmRoot, 'package.json');
    const arborist = join(npmRoot, 'node_modules', '@npmcli', 'arborist', 'bin', 'index.js');
    const runtimeLink = join(npmRoot, 'node_modules', '.bin', 'arborist');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "process.stdout.write('must not run');\n");
    write(packageJson, '{"name":"npm","version":"11.19.0"}\n');
    write(arborist, "process.stdout.write('arborist');\n");
    mkdirSync(dirname(runtimeLink), { recursive: true });
    symlinkSync('../@npmcli/arborist/bin/index.js', runtimeLink);

    expect(() => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    })).toThrow('npm runtime closure contains a symbolic link');
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
    let result: ReturnType<typeof run> | undefined;
    let failure: Error | undefined;
    try {
      result = run();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== undefined) {
      expect(failure.message).toContain('npm runtime closure changed during execution');
    } else {
      expect(result).toBeDefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('validated runtime');
    }
    expect(existsSync(replacementMarker)).toBe(false);
  });

  it('removes only an exact pinned empty pre-authority snapshot container', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-empty-refusal-')));
    tempDirs.push(fixtureRoot);

    const empty = join(fixtureRoot, 'empty');
    mkdirSync(empty);
    removeExactEmptySnapshotContainer(empty, lstatSync(empty));
    expect(existsSync(empty)).toBe(false);

    const populated = join(fixtureRoot, 'populated');
    const populatedFile = join(populated, 'sentinel');
    mkdirSync(populated);
    writeFileSync(populatedFile, 'preserve');
    expect(() => removeExactEmptySnapshotContainer(populated, lstatSync(populated)))
      .toThrow('unauthoritative npm snapshot container is not empty');
    expect(readFileSync(populatedFile, 'utf8')).toBe('preserve');

    const replaced = join(fixtureRoot, 'replaced');
    const displaced = join(fixtureRoot, 'displaced');
    mkdirSync(replaced);
    const replacedIdentity = lstatSync(replaced);
    renameSync(replaced, displaced);
    mkdirSync(replaced);
    expect(() => removeExactEmptySnapshotContainer(replaced, replacedIdentity))
      .toThrow('unauthoritative npm snapshot container changed before refusal');
    expect(existsSync(replaced)).toBe(true);
    expect(existsSync(displaced)).toBe(true);
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

  it('does not import an absolute ESM module outside the npm snapshot', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-esm-escape-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    const outsideModule = join(fixtureRoot, 'outside.mjs');
    const escapeMarker = join(fixtureRoot, 'esm-escape-ran');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, `import(${JSON.stringify(pathToFileURL(outsideModule).href)});\n`);
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');
    write(outsideModule, [
      "import fs from 'node:fs';",
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
    expect(result.stderr).toMatch(/npm module escaped snapshot/u);
    expect(existsSync(escapeMarker)).toBe(false);
  });

  it('does not import an ESM package from an unmeasured ancestor', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-esm-ancestor-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const nodeModules = join(fixtureRoot, 'lib', 'node_modules');
    const trustedCli = join(nodeModules, 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(nodeModules, 'npm', 'package.json');
    const escapeMarker = join(fixtureRoot, 'esm-ancestor-ran');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "import('unmeasured-esm');\n");
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');
    const result = runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string }) => {
        const ancestorPackage = join(snapshot.cleanupRoot, 'node_modules', 'unmeasured-esm');
        write(join(ancestorPackage, 'package.json'),
          '{"name":"unmeasured-esm","type":"module","main":"index.mjs"}\n');
        write(join(ancestorPackage, 'index.mjs'), [
          "import fs from 'node:fs';",
          `fs.writeFileSync(${JSON.stringify(escapeMarker)}, 'unsafe');`,
        ].join('\n'));
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/npm module escaped snapshot/u);
    expect(existsSync(escapeMarker)).toBe(false);
  });

  it('imports a relative ESM module from inside the npm snapshot', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-esm-inside-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const npmRoot = join(fixtureRoot, 'lib', 'node_modules', 'npm');
    const trustedCli = join(npmRoot, 'bin', 'npm-cli.js');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "import('../lib/inside.mjs');\n");
    write(join(npmRoot, 'lib', 'inside.mjs'), "process.stdout.write('inside esm');\n");
    write(join(npmRoot, 'package.json'), '{"name":"npm","version":"10.0.0"}\n');

    const result = runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('inside esm');
  });

  it('does not require an absolute CommonJS module outside the npm snapshot', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-cjs-escape-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    const outsideModule = join(fixtureRoot, 'outside.cjs');
    const escapeMarker = join(fixtureRoot, 'cjs-escape-ran');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, `require(${JSON.stringify(outsideModule)});\n`);
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');
    write(outsideModule, `require('node:fs').writeFileSync(${JSON.stringify(escapeMarker)}, 'unsafe');\n`);

    const result = runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/npm module escaped snapshot/u);
    expect(existsSync(escapeMarker)).toBe(false);
  });

  it('does not import a data URL outside the npm snapshot', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-data-url-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const trustedCli = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packageJson = join(fixtureRoot, 'lib', 'node_modules', 'npm', 'package.json');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, "import('data:text/javascript,process.stdout.write(%22unsafe%22)');\n");
    write(packageJson, '{"name":"npm","version":"10.0.0"}\n');

    const result = runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/npm module escaped snapshot/u);
  });

  it.runIf(process.platform === 'win32')('uses an exact private Windows snapshot DACL', () => {
    let assurance: ReturnType<typeof assurePrivateStoragePath> | undefined;
    const timeouts: number[] = [];
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      observeInvocation: (invocation) => timeouts.push(invocation.timeoutMs),
    });
    const result = runTrustedNpmCli(['--version'], {}, {
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string }) => {
        assurance = assurePrivateStoragePath(
          snapshot.cleanupRoot,
          'directory',
          'inspect-existing',
          { anchorPath: dirname(snapshot.cleanupRoot), timeoutMs: 30_000 },
        );
      },
    });
    expect(result.status).toBe(0);
    expect(assurance).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    expect(timeouts).toEqual(timeouts.map(() => 30_000));
  });

  it.runIf(process.platform === 'win32')('rejects a permissive snapshot DACL before spawning', () => {
    expect(() => runTrustedNpmCli(['--version'], {}, {
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string }) => {
        const changed = spawnSync(
          'icacls.exe',
          [snapshot.cleanupRoot, '/grant', '*S-1-1-0:(OI)(CI)M'],
          { encoding: 'utf8', windowsHide: true },
        );
        expect(changed.status).toBe(0);
      },
    })).toThrow(/npm snapshot storage changed/u);
  });

  it('refuses to traverse a hostile snapshot cleanup reparse entry', () => {
    let cleanupRoot = '';
    let reparsePath = '';
    let outsideDirectory = '';
    let outsideSentinel = '';
    let sentinelBefore: ReturnType<typeof lstatSync> | undefined;
    expect(() => runTrustedNpmCli(['--version'], {}, {
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string; root: string }) => {
        cleanupRoot = snapshot.cleanupRoot;
        outsideDirectory = `${cleanupRoot}.outside`;
        outsideSentinel = join(outsideDirectory, 'sentinel');
        mkdirSync(outsideDirectory);
        writeFileSync(outsideSentinel, 'outside sentinel', { mode: 0o400 });
        sentinelBefore = lstatSync(outsideSentinel);
        reparsePath = join(snapshot.root, 'zzz-cleanup-reparse');
        chmodSync(snapshot.root, 0o700);
        symlinkSync(
          outsideDirectory,
          reparsePath,
          process.platform === 'win32' ? 'junction' : undefined,
        );
      },
    })).toThrow(/npm snapshot cleanup contains (?:a reparse entry|an unsafe directory)/u);
    expect(cleanupRoot).not.toBe('');
    expect(existsSync(cleanupRoot)).toBe(true);
    const sentinelAfter = lstatSync(outsideSentinel);
    expect(readFileSync(outsideSentinel, 'utf8')).toBe('outside sentinel');
    expect(sentinelAfter.dev).toBe(sentinelBefore!.dev);
    expect(sentinelAfter.ino).toBe(sentinelBefore!.ino);
    expect(sentinelAfter.mode).toBe(sentinelBefore!.mode);
    unlinkSync(reparsePath);
    rmSync(cleanupRoot, { recursive: true, force: true });
    rmSync(outsideDirectory, { recursive: true, force: true });
    expect(existsSync(cleanupRoot)).toBe(false);
  });

  it('refuses a snapshot hard link without mutating its external inode', () => {
    let cleanupRoot = '';
    let hardLinkPath = '';
    let outsideFile = '';
    let outsideBefore: ReturnType<typeof lstatSync> | undefined;
    expect(() => runTrustedNpmCli(['--version'], {}, {
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string; root: string }) => {
        cleanupRoot = snapshot.cleanupRoot;
        outsideFile = `${cleanupRoot}.outside-file`;
        writeFileSync(outsideFile, 'outside hard-link sentinel', { mode: 0o400 });
        outsideBefore = lstatSync(outsideFile);
        hardLinkPath = join(snapshot.root, 'zzz-cleanup-hardlink');
        chmodSync(snapshot.root, 0o700);
        linkSync(outsideFile, hardLinkPath);
      },
    })).toThrow('npm snapshot cleanup contains a hard-linked file');
    const outsideAfter = lstatSync(outsideFile);
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside hard-link sentinel');
    expect(outsideAfter.dev).toBe(outsideBefore!.dev);
    expect(outsideAfter.ino).toBe(outsideBefore!.ino);
    expect(outsideAfter.mode).toBe(outsideBefore!.mode);
    unlinkSync(hardLinkPath);
    rmSync(cleanupRoot, { recursive: true, force: true });
    unlinkSync(outsideFile);
    expect(existsSync(cleanupRoot)).toBe(false);
  });

  it('removes the private snapshot after successful execution', () => {
    let cleanupRoot = '';
    const result = runTrustedNpmCli(['--version'], {}, {
      beforeSpawn: (_launch: unknown, snapshot: { cleanupRoot: string }) => {
        cleanupRoot = snapshot.cleanupRoot;
      },
    });
    expect(result.status).toBe(0);
    expect(cleanupRoot).not.toBe('');
    expect(existsSync(cleanupRoot)).toBe(false);
  });

  it('rejects a persistent snapshot mutation performed during child execution', () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-child-mutation-')));
    tempDirs.push(fixtureRoot);
    const fakeNode = join(fixtureRoot, 'bin', 'node');
    const npmRoot = join(fixtureRoot, 'lib', 'node_modules', 'npm');
    const trustedCli = join(npmRoot, 'bin', 'npm-cli.js');
    write(fakeNode, 'fixture node identity\n');
    write(trustedCli, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const target = path.join(__dirname, '../lib/mutable.js');",
      'fs.chmodSync(target, 0o600);',
      "fs.writeFileSync(target, 'mutated');",
    ].join('\n'));
    write(join(npmRoot, 'lib', 'mutable.js'), "module.exports = 'validated';\n");
    write(join(npmRoot, 'package.json'), '{"name":"npm","version":"10.0.0"}\n');

    expect(() => runTrustedNpmCli([], {
      environment: { npm_execpath: trustedCli },
    }, {
      command: process.execPath,
      execPath: fakeNode,
      platform: 'linux',
    })).toThrow('npm snapshot changed during execution');
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
