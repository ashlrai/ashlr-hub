/* global process, console */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function reportNames(role) {
  if (role === 'web') return ['web.json'];
  const general = /^mac-general-([1-4])$/.exec(role);
  if (general) return [`general-${general[1]}-of-4.json`];
  if (role === 'mac-isolated') return Array.from({ length: 14 }, (_, i) => `isolated-${String(i + 1).padStart(2, '0')}.json`);
  throw new Error('Unknown qualification lane');
}

// Preserve skipped/todo cases: they are evidence, never promoted to a pass.
// The source-owned invocation chooses the full suite or its fixed partition.
export function normalizeReport(raw, root) {
  if (raw.success !== true || raw.numFailedTests !== 0 || raw.numFailedTestSuites !== 0 || !Array.isArray(raw.testResults) || !raw.testResults.length) {
    throw new Error('Failed or empty Vitest report');
  }
  const seen = new Set(); const totals = { passed: 0, skipped: 0, todo: 0 };
  const modules = raw.testResults.map((module) => {
    if (module.status !== 'passed' || !Array.isArray(module.assertionResults) || !module.assertionResults.length || !isAbsolute(module.name)) throw new Error('Failed or empty test module');
    const file = relative(root, module.name).split(sep).join('/');
    if (file.startsWith('../') || !file || isAbsolute(file) || seen.has(file)) throw new Error('Invalid or duplicate test module');
    seen.add(file); const occurrences = new Map();
    const cases = module.assertionResults.map((item) => {
      if (typeof item.fullName !== 'string' || !item.fullName || !Object.hasOwn(totals, item.status) || (item.failureMessages?.length ?? 0) !== 0) throw new Error('Invalid test case result');
      // Parameterized rows can share a full title. Keep every occurrence in
      // reporter order instead of silently discarding those distinct cases.
      const occurrence = occurrences.get(item.fullName) ?? 0;
      occurrences.set(item.fullName, occurrence + 1);
      const id = sha256(`${file}\0${item.fullName}\0${occurrence}`);
      totals[item.status]++;
      return { id, name: item.fullName, state: item.status };
    });
    return { file, cases };
  });
  if (raw.numTotalTests !== totals.passed + totals.skipped + totals.todo || raw.numPassedTests !== totals.passed || raw.numPendingTests !== totals.skipped || raw.numTodoTests !== totals.todo) throw new Error('Vitest case totals disagree');
  return modules;
}

export function collectLane({ role, root, parent, env = process.env, run = spawnSync, now = () => new Date().toISOString() }) {
  const names = reportNames(role);
  if (!isAbsolute(root) || realpathSync(root) !== root || !isAbsolute(parent) || realpathSync(parent) !== parent || typeof process.getuid !== 'function') throw new Error('Canonical POSIX source and temporary paths required');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (revision !== env.ASHLR_CI_SOURCE_SHA || !/^[a-f0-9]{40}$/.test(env.ASHLR_CI_EVENT_SHA ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Missing or dirty CI source identity');
  const directory = realpathSync(mkdtempSync(join(parent, `ashlr-qualification-${role}-`))); chmodSync(directory, 0o700);
  const reports = join(directory, 'reports'); mkdirSync(reports, { mode: 0o700 });
  const startedAt = now();
  const args = role === 'web'
    ? ['run', 'test:web', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${join(reports, names[0])}`]
    : [join(root, 'scripts/test-ci-sharded.mjs'), role === 'mac-isolated' ? '--isolated-only' : `--general-shard=${role.slice(-1)}/4`];
  const childEnv = { ...env };
  delete childEnv.ASHLR_TEST_CI_REPORT_DIRECTORY;
  if (role !== 'web') childEnv.ASHLR_TEST_CI_REPORT_DIRECTORY = reports;
  const child = run(role === 'web' ? 'npm' : process.execPath, args, { cwd: root, env: childEnv, stdio: 'inherit' });
  if (child.error || child.signal || child.status !== 0) throw new Error(`Qualification command failed (${child.status ?? child.signal ?? child.error})`);
  if (JSON.stringify(readdirSync(reports).sort()) !== JSON.stringify([...names].sort())) throw new Error('Missing or extra qualification reports');
  const result = names.map((file) => {
    const path = join(reports, file); const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > 64 * 1024 * 1024 || (before.mode & 0o7000)) throw new Error('Unsafe qualification report');
    const bytes = readFileSync(path); const modules = normalizeReport(JSON.parse(bytes), root); const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Qualification report changed');
    return { file, sha256: sha256(bytes), bytes: bytes.length, modules };
  });
  if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Source changed during qualification');
  const lane = { schemaVersion: 1, role, source: { revision, tree, eventSha: env.ASHLR_CI_EVENT_SHA }, run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT }, nodeVersion: process.version, startedAt, finishedAt: now(), exitCode: 0, reports: result };
  writeFileSync(join(directory, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return directory;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: ci-qualification-lane.mjs web|mac-general-N|mac-isolated');
    const directory = collectLane({ role: process.argv[2], root: realpathSync(process.cwd()), parent: realpathSync(process.env.RUNNER_TEMP) });
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output');
    appendFileSync(process.env.GITHUB_OUTPUT, `lane_dir=${directory}\n`);
    console.log(`Qualification reports: ${directory}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
