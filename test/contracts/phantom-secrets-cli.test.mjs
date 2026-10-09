/**
 * Real Secrets CLI grammar checks. Opt in with an absolute PHANTOM_CONTRACT_BIN.
 * Only help/version and syntactically invalid commands are permitted below.
 * Never add a valid vault, reveal, exec, init, env, or unwrap invocation here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const selectedBinary = process.env.PHANTOM_CONTRACT_BIN;
const syntheticKey = 'PHANTOM_CONTRACT_SYNTHETIC_KEY';
const helpCommands = ['env', 'unwrap', 'reveal', 'list', 'exec'];
const rejectedCommands = [
  ['env', syntheticKey],
  ['unwrap', syntheticKey],
  // This unknown flag forces parser rejection, even when --yes is supported.
  ['reveal', syntheticKey, '--phantom-contract-invalid-option'],
];

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshot(directory, relative = '') {
  const entries = [];
  for (const name of readdirSync(join(directory, relative)).sort()) {
    const child = join(relative, name);
    const stats = statSync(join(directory, child));
    entries.push(stats.isDirectory() ? [child, 'directory'] : [child, hashFile(join(directory, child))]);
    if (stats.isDirectory()) entries.push(...snapshot(directory, child));
  }
  return entries;
}

describe('Phantom Secrets real CLI grammar', {
  skip: !selectedBinary && 'Set PHANTOM_CONTRACT_BIN to an explicitly reviewed Secrets executable; no PATH discovery.',
  concurrency: false,
}, () => {
  let binary;
  let root;
  let environment;
  let initialSnapshot;
  let initialBinaryHash;
  let reportedVersion;
  const reviewedGrammars = new Set();

  function invoke(args) {
    // Keep the invocation set closed: future edits cannot silently run a valid
    // credential operation through this helper.
    const permitted = [
      ['--version'],
      ...helpCommands.map((command) => [command, '--help']),
      ...rejectedCommands,
    ].some((candidate) => JSON.stringify(candidate) === JSON.stringify(args));
    assert.ok(permitted, 'Only the reviewed help/version/parser-rejection command set may run');
    if (rejectedCommands.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args))) {
      assert.ok(reviewedGrammars.has('env') && reviewedGrammars.has('unwrap'),
        'Both exact no-positional grammars must pass preflight before any negative probe');
      assert.equal(hashFile(binary), initialBinaryHash,
        'Binary changed after grammar review; refusing negative probe');
    }
    const result = spawnSync(binary, args, {
      cwd: join(root, 'project'),
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, 'The explicit CLI must execute within the bounded timeout/output limit');
    assert.equal(result.signal, null, 'The explicit CLI must exit normally');
    assert.deepEqual(snapshot(root), initialSnapshot, 'Help/parser rejection must not mutate the disposable fixture');
    return result;
  }

  before(() => {
    assert.ok(isAbsolute(selectedBinary), 'PHANTOM_CONTRACT_BIN must be an absolute executable path');
    binary = realpathSync(selectedBinary);
    assert.ok(statSync(binary).isFile(), 'The explicitly selected binary must be a file');
    initialBinaryHash = hashFile(binary);
    root = mkdtempSync(join(tmpdir(), 'phantom-cli-contract-'));
    for (const directory of ['project', 'home', 'config', 'data', 'state', 'cache', 'tmp', 'empty-path']) {
      mkdirSync(join(root, directory));
    }
    // No .phantom.toml, real secrets, or vault is created. These files expose
    // accidental dispatch to env/unwrap because their hashes would change.
    writeFileSync(join(root, 'project', '.env'), 'PUBLIC_CONTRACT_MARKER=synthetic-fixture-only\n');
    writeFileSync(join(root, 'project', 'package.json'), JSON.stringify({
      private: true,
      scripts: { fixture: 'phantom exec -- node fixture.js', 'fixture:raw': 'node fixture.js' },
    }, null, 2));
    // Reconstruct rather than spread process.env: no ambient credentials,
    // session bearers, proxy settings, loader hooks, or user config paths.
    environment = {
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      APPDATA: join(root, 'config'),
      LOCALAPPDATA: join(root, 'data'),
      TMPDIR: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      TEMP: join(root, 'tmp'),
      PATH: join(root, 'empty-path'),
      LANG: 'C',
      LC_ALL: 'C',
      TERM: 'dumb',
      NO_COLOR: '1',
      PHANTOM_NO_UPDATE_CHECK: '1',
    };
    if (process.platform === 'win32' && process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
    initialSnapshot = snapshot(root);
    const version = invoke(['--version']);
    assert.equal(version.status, 0, 'The explicit CLI must support --version');
    assert.match(version.stdout.trim(), /^phantom \d+\.\d+\.\d+\S*$/, 'Expected Secrets CLI version identity');
    reportedVersion = version.stdout.trim();
    // A before-hook failure cancels the entire suite. Also gate invoke() so a
    // future test cannot bypass this preflight or continue after a help error.
    for (const command of ['env', 'unwrap']) {
      const help = invoke([command, '--help']);
      assert.equal(help.status, 0, 'Grammar preflight help must succeed');
      const usageLines = help.stdout.split('\n').filter((line) => line.startsWith('Usage:'));
      assert.equal(usageLines.length, 1, 'Grammar preflight requires exactly one Usage line');
      assert.ok(
        usageLines[0] === `Usage: phantom ${command} [OPTIONS]` || usageLines[0] === `Usage: phantom ${command}`,
        'Grammar changed: review the new contract before invoking a key-shaped argument',
      );
      reviewedGrammars.add(command);
    }
  });

  it('records the exact tested binary provenance', (context) => {
    context.diagnostic(`binary=${binary}`);
    context.diagnostic(`sha256=${initialBinaryHash}; version=${reportedVersion}; node=${process.version}`);
  });

  after(() => {
    try {
      if (initialSnapshot) assert.deepEqual(snapshot(root), initialSnapshot, 'Fixture must remain unchanged');
      if (initialBinaryHash) assert.equal(hashFile(binary), initialBinaryHash, 'Selected binary changed during the run; repeat with stable provenance');
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  for (const command of helpCommands) {
    it(`${command} --help exposes its grammar without dispatching`, () => {
      const result = invoke([command, '--help']);
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`Usage: phantom ${command}\\b`));
      if (command === 'env') {
        assert.match(result.stdout, /Generate \.env\.example/);
        assert.match(result.stdout, /--output/);
        assert.doesNotMatch(result.stdout, /<(?:KEY|NAME)>/);
      }
      if (command === 'unwrap') {
        assert.match(result.stdout, /package\.json scripts/);
        assert.doesNotMatch(result.stdout, /<(?:KEY|NAME)>/);
      }
      if (command === 'list') assert.match(result.stdout, /--json/);
    });
  }

  for (const args of rejectedCommands) {
    it(`${args.join(' ')} is rejected before command dispatch`, () => {
      const result = invoke(args);
      assert.equal(result.status, 2, 'Expected clap argument rejection, not a vault/config/handler error');
      assert.equal(result.stdout, '', 'Parser failure must not return any value');
      assert.match(result.stderr, /unexpected argument/i);
      assert.match(result.stderr, /Usage: phantom /);
      assert.match(result.stderr, new RegExp(args.at(-1)));
    });
  }
});
