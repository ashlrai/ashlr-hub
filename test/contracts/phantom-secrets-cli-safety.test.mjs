import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';

const harness = fileURLToPath(new URL('./phantom-secrets-cli.test.mjs', import.meta.url));

// These executables are synthetic Node fixtures. They never implement a vault
// or credential operation; their only writes are disposable invocation records.
for (const [changedCommand, positional, helpStatus = 0] of [
  ['env', '<KEY>'],
  ['unwrap', '<TARGET>'],
  ['env', '[SECRET]'],
  ['env', '', 1],
]) {
  test(`${changedCommand} help ${helpStatus ? 'failure' : `grammar ${positional}`} cancels all negative probes`, {
    skip: process.platform === 'win32' && 'Executable shebang fixture requires POSIX; real CLI grammar lane remains portable.',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'phantom-grammar-safety-'));
    try {
      const executable = join(root, 'synthetic-phantom.cjs');
      const record = join(root, 'invocations.jsonl');
      writeFileSync(executable, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  console.log('phantom 0.0.0-synthetic');
} else if (args.length === 2 && args[1] === '--help') {
  const positional = args[0] === ${JSON.stringify(changedCommand)} ? ' ' + ${JSON.stringify(positional)} : '';
  console.log('Usage: phantom ' + args[0] + ' [OPTIONS]' + positional);
  process.exitCode = args[0] === ${JSON.stringify(changedCommand)} ? ${helpStatus} : 0;
} else {
  // This branch is an invocation detector, not a real command handler.
  process.exitCode = 99;
}
`, { mode: 0o700 });
      const result = spawnSync(process.execPath, ['--test', harness], {
        cwd: root,
        env: { PHANTOM_CONTRACT_BIN: executable, HOME: root, TMPDIR: root, LANG: 'C' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, 'Changed grammar must fail the real-CLI suite');
      assert.match(result.stdout, /hookFailed/);
      assert.match(result.stdout, helpStatus ? /Grammar preflight help must succeed/ : /Grammar changed: review the new contract/);
      const invocations = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const expected = [['--version'], ['env', '--help']];
      if (changedCommand === 'unwrap') expected.push(['unwrap', '--help']);
      assert.deepEqual(invocations, expected, 'Only version/help may run; no negative command reaches the executable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
