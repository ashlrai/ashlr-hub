#!/usr/bin/env node
/**
 * debt-tracker.mjs — D0 of the Debt Rearguard (docs/SPEC-DEBT-REARGUARD.md).
 *
 * Measures the project's "house-tidy" signals at a point in time and appends a
 * snapshot to an append-only ledger so DRIFT is visible over the fleet's churn:
 *
 *   - lint:      eslint error + warning counts (run LIVE — unlike scanLint which
 *                is default-off and only reads a cached report, so debt hides).
 *   - typecheck: `tsc --noEmit` error count.
 *   - ci:        latest CI conclusion on the target branch (via `gh`, optional).
 *
 * The vision-chaser fleet ships ~30-50 milestones/day and leaves debt behind
 * (broken test mocks, stale assertions, lint debt, red CI). This tracker is the
 * SCOREBOARD that answers "is the foundation getting cleaner or dirtier?" — the
 * prerequisite for the rearguard loop that fixes it.
 *
 * Contract: NEVER throws; every probe is independently guarded and degrades to
 * a null/unknown field. Read-only except for appending to the ledger.
 *
 * Usage:
 *   node scripts/debt-tracker.mjs            # measure + append + print snapshot
 *   node scripts/debt-tracker.mjs --json     # machine-readable snapshot
 *   node scripts/debt-tracker.mjs --no-ci    # skip the gh CI probe (offline)
 *   node scripts/debt-tracker.mjs --trend    # print recent ledger history + exit
 *
 * Exit code: 0 always when measuring. With --gate it exits 1 if lint/typecheck
 * errors > 0 or CI is failing (for use as a cheap pre-push / cron gate).
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_DIR = join(ROOT, '.ashlr');
const LEDGER = join(LEDGER_DIR, 'debt-ledger.jsonl');
const CI_BRANCH = 'master';

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const skipCi = args.has('--no-ci');
const gateMode = args.has('--gate');

/**
 * Run a command via the shell, capture stdout; never throw (returns {stdout, code}).
 * Uses execSync with a single command string so npx/gh shims resolve on every
 * platform (Node 24 refuses to spawn .cmd shims without a shell). Every argv is
 * a fixed literal here — no user input — so there is no shell-injection surface.
 */
function run(file, argv, timeoutMs = 180_000) {
  const cmd = [file, ...argv].join(' ');
  try {
    const stdout = execSync(cmd, {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: stdout ?? '', code: 0 };
  } catch (e) {
    // Non-zero exit (e.g. eslint found problems) still yields captured stdout.
    return { stdout: e?.stdout?.toString?.() ?? '', code: e?.status ?? 1 };
  }
}

/** eslint error + warning counts via JSON formatter (authoritative). */
function probeLint() {
  const { stdout } = run('npx', ['eslint', '.', '-f', 'json', '--no-cache']);
  try {
    const report = JSON.parse(stdout);
    let errors = 0;
    let warnings = 0;
    for (const f of report) {
      errors += f.errorCount ?? 0;
      warnings += f.warningCount ?? 0;
    }
    return { errors, warnings, ok: true };
  } catch {
    return { errors: null, warnings: null, ok: false };
  }
}

/** tsc --noEmit error count. */
function probeTypecheck() {
  const { stdout } = run('npx', ['tsc', '--noEmit']);
  const matches = stdout.match(/error TS\d+/g);
  // tsc prints nothing on success; any "error TS" lines are real errors.
  return { errors: matches ? matches.length : 0, ok: true };
}

/** Latest CI conclusion on the target branch via gh (optional). */
function probeCi() {
  if (skipCi) return { conclusion: 'skipped', sha: null, url: null, ok: false };
  const { stdout, code } = run(
    'gh',
    [
      'run',
      'list',
      '--branch',
      CI_BRANCH,
      '--limit',
      '1',
      '--json',
      'conclusion,status,headSha,url',
    ],
    30_000,
  );
  if (code !== 0) return { conclusion: 'unknown', sha: null, url: null, ok: false };
  try {
    const runs = JSON.parse(stdout);
    const r = runs[0];
    if (!r) return { conclusion: 'none', sha: null, url: null, ok: true };
    return {
      conclusion: r.status === 'completed' ? r.conclusion : r.status,
      sha: (r.headSha ?? '').slice(0, 7),
      url: r.url ?? null,
      ok: true,
    };
  } catch {
    return { conclusion: 'unknown', sha: null, url: null, ok: false };
  }
}

function currentCommit() {
  const { stdout } = run('git', ['rev-parse', '--short', 'HEAD'], 10_000);
  return stdout.trim() || null;
}

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  try {
    return readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function printTrend(rows) {
  const recent = rows.slice(-10);
  if (recent.length === 0) {
    console.log('No ledger history yet. Run without --trend to record a snapshot.');
    return;
  }
  console.log('debt trend (most recent last):');
  console.log('  when                 commit   lint(E/W)   tsc(E)   CI');
  for (const r of recent) {
    const when = (r.ts ?? '').slice(0, 19).replace('T', ' ');
    const lint = `${r.lint?.errors ?? '?'}/${r.lint?.warnings ?? '?'}`;
    const tsc = `${r.typecheck?.errors ?? '?'}`;
    const ci = r.ci?.conclusion ?? '?';
    console.log(
      `  ${when}  ${(r.commit ?? '-').padEnd(7)}  ${lint.padEnd(10)}  ${tsc.padEnd(6)}  ${ci}`,
    );
  }
}

function delta(curr, prev, path) {
  const get = (o) => path.reduce((a, k) => (a == null ? a : a[k]), o);
  const c = get(curr);
  const p = get(prev);
  if (typeof c !== 'number' || typeof p !== 'number') return '';
  const d = c - p;
  if (d === 0) return ' (=)';
  return d > 0 ? ` (▲ +${d})` : ` (▼ ${d})`;
}

// --- main ---------------------------------------------------------------------

const ledger = readLedger();

if (args.has('--trend')) {
  printTrend(ledger);
  process.exit(0);
}

const t0 = Date.now();
const snapshot = {
  ts: new Date().toISOString(),
  commit: currentCommit(),
  lint: probeLint(),
  typecheck: probeTypecheck(),
  ci: probeCi(),
};
snapshot.durationMs = Date.now() - t0;

// Append to the ledger (best-effort).
try {
  if (!existsSync(LEDGER_DIR)) mkdirSync(LEDGER_DIR, { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(snapshot) + '\n', 'utf8');
} catch {
  /* ledger is best-effort; still print the snapshot */
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
} else {
  const prev = ledger[ledger.length - 1];
  const ciStatus = snapshot.ci.conclusion;
  const ciIcon = ciStatus === 'success' ? '✅' : ciStatus === 'skipped' ? '·' : '❌';
  const lintIcon = snapshot.lint.errors === 0 ? '✅' : '❌';
  const tscIcon = snapshot.typecheck.errors === 0 ? '✅' : '❌';
  console.log('');
  console.log(`  Debt snapshot @ ${snapshot.commit ?? '(unknown)'}  (${snapshot.durationMs}ms)`);
  console.log('');
  console.log(
    `  ${lintIcon} lint        ${snapshot.lint.errors ?? '?'} errors${prev ? delta(snapshot, prev, ['lint', 'errors']) : ''}, ${snapshot.lint.warnings ?? '?'} warnings`,
  );
  console.log(
    `  ${tscIcon} typecheck   ${snapshot.typecheck.errors ?? '?'} errors${prev ? delta(snapshot, prev, ['typecheck', 'errors']) : ''}`,
  );
  console.log(
    `  ${ciIcon} CI (${CI_BRANCH})  ${ciStatus}${snapshot.ci.sha ? ` @ ${snapshot.ci.sha}` : ''}`,
  );
  console.log('');
  console.log(`  ledger: .ashlr/debt-ledger.jsonl (${ledger.length + 1} entries) — \`--trend\` for history`);
  console.log('');
}

if (gateMode) {
  const dirty =
    (snapshot.lint.errors ?? 0) > 0 ||
    (snapshot.typecheck.errors ?? 0) > 0 ||
    (snapshot.ci.ok && snapshot.ci.conclusion !== 'success' && snapshot.ci.conclusion !== 'skipped');
  process.exit(dirty ? 1 : 0);
}
