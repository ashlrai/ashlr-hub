#!/usr/bin/env node
/**
 * Guard: a test file that clearly does REAL subprocess/filesystem/network
 * work (spawns a real child process, binds a real network server, or writes
 * a large real fixture) should be a member of the `real-io` vitest lane
 * (test/config/realio-lane-membership.mjs), not the fast, parallel `unit` lane —
 * otherwise it becomes the next `Test timed out in 5000ms` flake under
 * parallel load.
 *
 * This is a best-effort heuristic, not a proof: it greps for markers rather
 * than tracing data flow, so it can both miss real-io files that use an
 * unusual pattern and — before the mock check below — flag files that merely
 * assert on what WOULD be passed to a fully mocked `child_process`. The goal
 * per M3xx is that the *next* heavy suite lands in the right lane by default,
 * not perfect classification of every file that exists today.
 *
 * Run via `npm run lint:realio-lane` (wired into `npm run lint`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// test/config/, not scripts/ — see the comment in vitest.config.ts: M457's
// artifact-firewall guard scans every scripts/ and bin/ file's literal text
// for certain test names, and this list's comments name several of them.
import { REAL_IO_TEST_FILES } from '../test/config/realio-lane-membership.mjs';
import { KNOWN_FAST_SPAWN_FILES } from './realio-lane-known-fast-spawns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const testDir = join(repoRoot, 'test');

// All classifier identities are repository-relative POSIX paths, independent
// of the runner's native separator. Without this normalization Windows emits
// paths such as `test/setup\\home.test.ts`, which cannot match the canonical
// lane and measured-fast manifests and creates contradictory classifications.
function canonicalTestPath(value) {
  return value.replaceAll('\\', '/');
}

const realIoSet = new Set(REAL_IO_TEST_FILES.map(canonicalTestPath));
const knownFastSpawnSet = new Set(KNOWN_FAST_SPAWN_FILES.map(canonicalTestPath));

// Real subprocess spawn: execFileSync/execSync/spawnSync/spawn/execFile.
const SPAWN_MARKER = /\b(?:execFileSync|execSync|spawnSync|execFile|spawn)\s*\(/;
// A file that mocks node's child_process module (via vi.mock or vi.spyOn on
// the module namespace) routes ALL of the above through the mock, not a real
// process — skip the spawn marker entirely for files that do this (avoids
// flagging assertions on mocked call args, e.g.
// `expect(opts).toMatchObject({ timeout: 2000 })` against a mocked spawn).
const CHILD_PROCESS_MOCK = /vi\.mock\(\s*['"](?:node:)?child_process['"]|vi\.spyOn\(\s*(?:cp|childProcess|child_process)\b/;
// A describe/it block gated to a platform this machine isn't running (e.g.
// `describe.runIf(process.platform === 'win32')`) never executes its real
// spawn here — CI's dedicated Windows/macOS jobs cover it with their own
// generous ASHLR_VITEST_TEST_TIMEOUT_MS, independent of this lane split.
const PLATFORM_GATED = /\b(?:runIf|skipIf)\(process\.platform\b/;
// Real local network server bind (e.g. a real HTTP capture server in a test).
const SERVER_BIND_MARKER = /\bcreateServer\s*\([\s\S]{0,200}?\.listen\s*\(|\.listen\s*\(\s*0\s*[,)]/;
// Large real fixture write: an explicit multi-hundred-KB+ buffer allocation,
// or an explicit MiB/MB callout near a real writeFileSync — soft signal only
// (reported, not gate-failing on its own — too easy to false-positive on an
// unrelated large constant).
const LARGE_FIXTURE_MARKER = /Buffer\.alloc\(\s*\d{6,}\s*\)|\b\d+\s*(?:MiB|MB)\b/i;

function findTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relPath(absPath) {
  return canonicalTestPath(`test/${absPath.slice(testDir.length + 1)}`);
}

const files = findTestFiles(testDir);
const missing = [];
const softSignals = [];

const unrecognizedAllowlistEntries = new Set(knownFastSpawnSet);

for (const absPath of files) {
  const rel = relPath(absPath);
  if (realIoSet.has(rel)) continue; // already a member — nothing to flag

  const source = readFileSync(absPath, 'utf8');
  const mocksChildProcess = CHILD_PROCESS_MOCK.test(source);
  const platformGated = PLATFORM_GATED.test(source);

  const hasSpawnMarker = !mocksChildProcess && !platformGated && SPAWN_MARKER.test(source);
  const hasServerBind = SERVER_BIND_MARKER.test(source);

  if (hasSpawnMarker || hasServerBind) {
    if (knownFastSpawnSet.has(rel)) {
      unrecognizedAllowlistEntries.delete(rel);
      continue; // measured fast in the quiet baseline (see the allowlist file) — not contention-prone
    }
    missing.push({
      file: rel,
      reason: hasSpawnMarker ? 'spawns a real child process (execFileSync/execSync/spawnSync/spawn/execFile)' : 'binds a real local network server',
    });
    continue;
  }

  if (LARGE_FIXTURE_MARKER.test(source)) {
    softSignals.push(rel);
  }
}

if (missing.length > 0) {
  console.error('\n[check-realio-lane-membership] The following test files use a real-io marker');
  console.error('but are not in REAL_IO_TEST_FILES (test/config/realio-lane-membership.mjs):\n');
  for (const { file, reason } of missing) {
    console.error(`  ${file}`);
    console.error(`    ${reason}`);
  }
  console.error('\nEither add them to REAL_IO_TEST_FILES with a comment explaining why, or — if this');
  console.error('is a false positive (e.g. the spawn call is exercised through a mock this script');
  console.error("didn't recognize) — leave a short comment near the match explaining why it's safe");
  console.error('in the fast lane, so the next reader (or the next run of this guard) isn\'t confused.\n');
}

if (softSignals.length > 0) {
  console.error('[check-realio-lane-membership] soft signal only (not gate-failing) — large fixture');
  console.error('marker found outside the real-io lane, worth a second look:');
  for (const file of softSignals) console.error(`  ${file}`);
  console.error('');
}

if (unrecognizedAllowlistEntries.size > 0) {
  console.error('[check-realio-lane-membership] stale KNOWN_FAST_SPAWN_FILES entries (no longer');
  console.error('matched, or file no longer exists) — remove from scripts/realio-lane-known-fast-spawns.mjs:');
  for (const file of unrecognizedAllowlistEntries) console.error(`  ${file}`);
  console.error('');
}

if (missing.length > 0 || unrecognizedAllowlistEntries.size > 0) {
  process.exitCode = 1;
} else {
  console.log(`[check-realio-lane-membership] ok — ${realIoSet.size} real-io files, ${files.length - realIoSet.size} unit files, no unclassified real-io markers found.`);
}
