import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNpmCliLaunch } from '../scripts/build-release-dependency-inventory.mjs';

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
  it('uses the current Node process only after strict npm_execpath validation', () => {
    const launch = resolveNpmCliLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.npmCliPath).toBe(realpathSync(process.env['npm_execpath']!));

    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-npm-cli-')));
    tempDirs.push(fixtureRoot);
    const maliciousCli = join(fixtureRoot, 'npm', 'bin', 'npm-cli.js');
    write(maliciousCli, 'process.exit(0);\n');
    write(
      join(fixtureRoot, 'npm', 'package.json'),
      '{"name":"not-npm","version":"1.0.0"}\n',
    );

    expect(() => resolveNpmCliLaunch({ npm_execpath: maliciousCli }))
      .toThrow('npm package identity is invalid');
    expect(() => resolveNpmCliLaunch({ npm_execpath: 'npm-cli.js' }))
      .toThrow('npm_execpath is missing or invalid');
    expect(() => resolveNpmCliLaunch({ npm_execpath: `${maliciousCli}\n--eval` }))
      .toThrow('npm_execpath is missing or invalid');
  });
});
