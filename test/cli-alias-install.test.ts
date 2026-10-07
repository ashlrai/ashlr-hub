import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtures: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phantom-cli-alias-'));
  fixtures.push(root);
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('npm installs both real workbench launchers without taking the Secrets phantom command', async () => {
  const root = fixture();
  const hub = join(root, 'hub');
  const secrets = join(root, 'secrets');
  const install = join(root, 'install');
  for (const path of [join(hub, 'bin'), join(hub, 'dist', 'cli'), secrets, install]) mkdirSync(path, { recursive: true });
  const actual = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  writeFileSync(join(hub, 'package.json'), JSON.stringify({ name: actual.name, version: actual.version,
    type: 'module', bin: actual.bin }));
  copyFileSync(join(repo, 'bin', 'ashlr'), join(hub, 'bin', 'ashlr'));
  chmodSync(join(hub, 'bin', 'ashlr'), 0o755);
  // The real shim imports this inert compiled entrypoint: argv preservation,
  // npm bin generation and coexistence are exercised without provider startup.
  writeFileSync(join(hub, 'dist', 'cli', 'index.js'), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(secrets, 'package.json'), JSON.stringify({ name: 'phantom-secrets-alias-fixture',
    version: '1.0.0', bin: { phantom: 'phantom.cjs' } }));
  writeFileSync(join(secrets, 'phantom.cjs'), '#!/usr/bin/env node\nconsole.log("secrets-only");\n');
  chmodSync(join(secrets, 'phantom.cjs'), 0o755);
  for (const path of ['user.npmrc', 'global.npmrc']) writeFileSync(join(root, path), '');
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: root, USERPROFILE: root,
    TMPDIR: root, TMP: root, TEMP: root, SystemRoot: process.env['SystemRoot'] };
  const npmCli = process.env['npm_execpath'];
  expect(npmCli, 'run through the existing npm test:ci harness').toBeTruthy();
  const result = spawnSync(process.execPath, [npmCli!, 'install', '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--install-links', '--prefix', install, '--cache', join(root, 'cache'),
    '--userconfig', join(root, 'user.npmrc'), '--globalconfig', join(root, 'global.npmrc'), hub, secrets],
  { cwd: install, env, encoding: 'utf8', timeout: 4_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const run = async (name: string, args: string[]) => {
    const bin = join(install, 'node_modules', '.bin', name);
    const command = process.platform === 'win32' ? process.env['ComSpec'] ?? 'cmd.exe' : bin;
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `"${bin}.cmd" ${args.join(' ')}`] : args;
    const child = await execute(command, argv, { env, encoding: 'utf8' });
    return child.stdout.trim();
  };
  const args = ['help', '--search', 'fleet'];
  const [phm, ashlr, phantom] = await Promise.all([run('phm', args), run('ashlr', args), run('phantom', [])]);
  expect(JSON.parse(phm)).toEqual(args);
  expect(ashlr).toBe(phm);
  expect(phantom).toBe('secrets-only');
  if (process.platform !== 'win32') {
    expect(readlinkSync(join(install, 'node_modules', '.bin', 'phm')))
      .toBe(readlinkSync(join(install, 'node_modules', '.bin', 'ashlr')));
  }
});

describe.skipIf(process.platform === 'win32')('source installer alias safety (Bash)', () => {
  function installation() {
    const root = fixture();
    const checkout = join(root, 'checkout');
    const home = join(root, 'home');
    const tools = join(root, 'tools');
    const bins = join(home, '.local', 'bin');
    for (const path of [join(checkout, 'bin'), bins, tools]) mkdirSync(path, { recursive: true });
    copyFileSync(join(repo, 'install.sh'), join(checkout, 'install.sh'));
    const source = join(checkout, 'bin', 'ashlr');
    writeFileSync(source, '#!/bin/bash\n[[ "$1" == help ]]\n');
    chmodSync(source, 0o755);
    writeFileSync(join(tools, 'node'), '#!/bin/bash\nif [[ "$1" == -e && "$2" == *process.versions.node* ]]; then echo 1; elif [[ "$1" == --version ]]; then echo v22.23.2; elif [[ -n "${ALIAS_TEST_PRELOAD:-}" ]]; then exec "$ALIAS_TEST_NODE" --require "$ALIAS_TEST_PRELOAD" "$@"; else exec "$ALIAS_TEST_NODE" "$@"; fi\n');
    writeFileSync(join(tools, 'npm'), '#!/bin/bash\nexit 0\n');
    for (const name of ['node', 'npm']) chmodSync(join(tools, name), 0o755);
    // Dependencies/build are controlled stubs; the original installer performs
    // the real destination preflight, link writes and executable help checks.
    writeFileSync(join(bins, 'phantom'), 'existing Secrets command');
    const run = (preload?: string) => spawnSync('/bin/bash', [join(checkout, 'install.sh')], { cwd: checkout,
      env: { PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
        ALIAS_TEST_NODE: process.execPath, ...(preload ? { ALIAS_TEST_PRELOAD: preload } : {}) }, encoding: 'utf8' });
    return { root, bins, source, run };
  }
  it('creates both aliases, reruns without replacing them, and preserves Secrets', () => {
    const { bins, source, run } = installation();
    expect(run().status).toBe(0);
    const before = ['phm', 'ashlr'].map(name => lstatSync(join(bins, name)).ino);
    expect(run().status).toBe(0);
    expect(['phm', 'ashlr'].map(name => readlinkSync(join(bins, name)))).toEqual([source, source]);
    expect(['phm', 'ashlr'].map(name => lstatSync(join(bins, name)).ino)).toEqual(before);
    expect(readFileSync(join(bins, 'phantom'), 'utf8')).toBe('existing Secrets command');
  });
  for (const racedAlias of ['phm', 'ashlr']) {
    it(`refuses a racing ${racedAlias} directory and rolls back its earlier own link`, () => {
      const { root, bins, run } = installation();
      const raced = join(bins, racedAlias);
      const preload = join(root, 'race.cjs');
      // Injection is confined to this child process; parent/global fs is never patched.
      writeFileSync(preload, `const fs = require('node:fs'); const create = fs.symlinkSync;
        fs.symlinkSync = (source, target) => {
          if (target === ${JSON.stringify(raced)}) fs.mkdirSync(target);
          return create(source, target);
        };`);
      const result = run(preload);
      expect(result.status).toBe(1);
      expect(lstatSync(raced).isDirectory()).toBe(true);
      expect(readdirSync(raced)).toEqual([]);
      expect(existsSync(join(bins, racedAlias === 'phm' ? 'ashlr' : 'phm'))).toBe(false);
      expect(readFileSync(join(bins, 'phantom'), 'utf8')).toBe('existing Secrets command');
    });
  }
  it('preserves a concurrently replaced first alias when later creation refuses', () => {
    const { root, bins, run } = installation();
    const first = join(bins, 'phm');
    const later = join(bins, 'ashlr');
    const foreign = join(root, 'foreign-tool');
    writeFileSync(foreign, 'foreign tool');
    const preload = join(root, 'replace-race.cjs');
    writeFileSync(preload, `const fs = require('node:fs'); const create = fs.symlinkSync;
      fs.symlinkSync = (source, target) => {
        if (target === ${JSON.stringify(later)}) {
          fs.unlinkSync(${JSON.stringify(first)});
          create(${JSON.stringify(foreign)}, ${JSON.stringify(first)});
          fs.mkdirSync(target);
        }
        return create(source, target);
      };`);
    expect(run(preload).status).toBe(1);
    expect(readlinkSync(first)).toBe(foreign);
    expect(readFileSync(first, 'utf8')).toBe('foreign tool');
    expect(readdirSync(later)).toEqual([]);
  });
  for (const alias of ['phm', 'ashlr']) {
    for (const conflict of ['file', 'link', 'dangling']) {
      it(`refuses ${alias} ${conflict} before writing either alias`, () => {
        const { root, bins, run } = installation();
        const dest = join(bins, alias);
        const other = join(bins, alias === 'phm' ? 'ashlr' : 'phm');
        const target = join(root, 'other-tool');
        if (conflict === 'file') writeFileSync(dest, 'unrelated tool');
        else {
          if (conflict === 'link') writeFileSync(target, 'unrelated tool');
          symlinkSync(target, dest);
        }
        const before = lstatSync(dest);
        const result = run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('belongs to another file or link');
        expect(lstatSync(dest).ino).toBe(before.ino);
        expect(existsSync(other)).toBe(false);
        if (conflict === 'file') expect(readFileSync(dest, 'utf8')).toBe('unrelated tool');
        else expect(readlinkSync(dest)).toBe(target);
        expect(readFileSync(join(bins, 'phantom'), 'utf8')).toBe('existing Secrets command');
      });
    }
  }
});
