/**
 * core/lifecycle/ship.ts — pre-ship gate + optional deploy for `ashlr ship`.
 *
 * `runShipGate` is READ-ONLY: it scans, runs scripts, and reports.
 * `deploy` is the ONLY place an outward action can happen, and ONLY when
 * opts.confirm === true. Default is always dry-run.
 *
 * Both functions NEVER throw — errors are captured in ShipCheck / detail strings.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ShipCheck, ShipGate } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max ms to wait for test / lint / build scripts. */
const SCRIPT_TIMEOUT_MS = 120_000;

/** Max ms to wait for binshield scan. */
const BINSHIELD_TIMEOUT_MS = 60_000;

/** Max ms to wait for deploy commands. */
const DEPLOY_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(
  id: string,
  label: string,
  status: ShipCheck['status'],
  detail: string,
  fix?: string,
): ShipCheck {
  const c: ShipCheck = { id, label, status, detail };
  if (fix !== undefined) c.fix = fix;
  return c;
}

/** Run a command synchronously, returning { stdout, stderr, exitCode, error }. */
function runSync(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; error?: string } {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024, // 4 MB
    });
    const timedOut = result.signal === 'SIGTERM' || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      exitCode: result.status,
      timedOut,
      error: result.error ? result.error.message : undefined,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Detect a tool on PATH by running `which <tool>`. Returns path or null. */
function whichSync(tool: string): string | null {
  try {
    const result = spawnSync('which', [tool], { encoding: 'utf8', timeout: 5_000 });
    if (result.status === 0) {
      const out = (result.stdout ?? '').trim();
      return out.length > 0 ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read and parse package.json in a project directory. Returns null on any failure. */
function readPackageJson(projectPath: string): Record<string, unknown> | null {
  try {
    const pkgPath = join(projectPath, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract the scripts map from a parsed package.json. */
function getScripts(pkg: Record<string, unknown>): Record<string, string> {
  const scripts = pkg['scripts'];
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    return scripts as Record<string, string>;
  }
  return {};
}

/** Check whether an npm script exists. */
function hasScript(scripts: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(scripts, name) && typeof scripts[name] === 'string';
}

// ---------------------------------------------------------------------------
// Check 1: Supply-chain (binshield or built-in fallback)
// ---------------------------------------------------------------------------

/** Patterns that suggest a risky dep value (git/http URLs in package.json). */
const RISKY_DEP_PATTERNS: RegExp[] = [
  /^git\+https?:\/\//i,
  /^git:\/\//i,
  /^https?:\/\//i,
  /^github:/i,
  /^bitbucket:/i,
  /^gitlab:/i,
];

function isRiskyDepValue(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  return RISKY_DEP_PATTERNS.some((re) => re.test(val));
}

/** Built-in dependency sanity check (used when binshield is absent). */
function builtInSupplyChainCheck(projectPath: string): ShipCheck {
  const id = 'supply-chain';
  const label = 'Supply-chain check';

  const pkg = readPackageJson(projectPath);
  if (pkg === null) {
    // No package.json — skip (might be a non-Node project)
    return makeCheck(id, label, 'skip', 'No package.json found — skipping dependency check');
  }

  const warnings: string[] = [];

  // 1. Check for git/http URL deps in dependencies + devDependencies
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[depField];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const [name, val] of Object.entries(deps as Record<string, unknown>)) {
        if (isRiskyDepValue(val)) {
          warnings.push(`${depField}.${name}: remote URL dep "${val as string}"`);
        }
      }
    }
  }

  // 2. Check for install scripts in the project's own package.json
  const scripts = getScripts(pkg);
  for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (hasScript(scripts, scriptName)) {
      warnings.push(`install script "${scriptName}" present: ${scripts[scriptName]}`);
    }
  }

  // 3. Check for a lockfile
  const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
  const hasLockfile = lockfiles.some((f) => existsSync(join(projectPath, f)));
  if (!hasLockfile) {
    warnings.push('no lockfile found (package-lock.json / yarn.lock / pnpm-lock.yaml / bun.lockb)');
  }

  if (warnings.length === 0) {
    return makeCheck(
      id,
      label,
      'pass',
      'Built-in dep check: no risky patterns found, lockfile present',
    );
  }

  const detail = `Built-in dep check — ${warnings.length} warning(s): ${warnings.join('; ')}`;
  const fix = warnings.some((w) => w.includes('install script'))
    ? 'Review install scripts and remote URL deps before shipping'
    : 'Consider pinning dependencies to exact versions and committing a lockfile';

  return makeCheck(id, label, 'warn', detail, fix);
}

/** Supply-chain check: binshield if installed, else built-in fallback. */
function checkSupplyChain(projectPath: string): ShipCheck {
  const id = 'supply-chain';
  const label = 'Supply-chain check';

  const binshieldPath = whichSync('binshield');
  if (binshieldPath !== null) {
    // Run binshield scan (read-only)
    const result = runSync('binshield', ['scan', '.'], projectPath, BINSHIELD_TIMEOUT_MS);

    if (result.timedOut) {
      return makeCheck(id, label, 'warn', 'binshield scan timed out', 'Run binshield scan manually');
    }
    if (result.error) {
      return makeCheck(id, label, 'warn', `binshield error: ${result.error}`, 'Check binshield installation');
    }
    if (result.exitCode === 0) {
      const detail = result.stdout
        ? `binshield: ${result.stdout.split('\n')[0]}`
        : 'binshield scan passed';
      return makeCheck(id, label, 'pass', detail);
    }

    // Non-zero exit — extract useful detail
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const firstLine = combined.split('\n')[0] ?? 'scan found issues';
    return makeCheck(
      id,
      label,
      'fail',
      `binshield: ${firstLine}`,
      'Review binshield findings and remediate before shipping',
    );
  }

  // No binshield — fall back to built-in check
  return builtInSupplyChainCheck(projectPath);
}

// ---------------------------------------------------------------------------
// Check 2-4: npm script runners (test, lint, build)
// ---------------------------------------------------------------------------

function runScriptCheck(
  checkId: string,
  label: string,
  scriptName: string,
  projectPath: string,
  scripts: Record<string, string>,
): ShipCheck {
  if (!hasScript(scripts, scriptName)) {
    return makeCheck(checkId, label, 'skip', `No "${scriptName}" script in package.json`);
  }

  const result = runSync('npm', ['run', scriptName, '--silent'], projectPath, SCRIPT_TIMEOUT_MS);

  if (result.timedOut) {
    return makeCheck(
      checkId,
      label,
      'fail',
      `"${scriptName}" script timed out after ${SCRIPT_TIMEOUT_MS / 1000}s`,
      `Investigate slow ${scriptName} or increase timeout`,
    );
  }
  if (result.error) {
    return makeCheck(
      checkId,
      label,
      'fail',
      `Failed to run "${scriptName}": ${result.error}`,
      'Ensure npm is installed and package.json is valid',
    );
  }
  if (result.exitCode === 0) {
    // Summarize output: first non-empty line or generic success
    const firstLine = (result.stdout || result.stderr).split('\n').find((l) => l.trim()) ?? '';
    const detail = firstLine
      ? `"${scriptName}" passed: ${firstLine.slice(0, 120)}`
      : `"${scriptName}" passed`;
    return makeCheck(checkId, label, 'pass', detail);
  }

  // Script failed — capture relevant output
  const errOutput = (result.stderr || result.stdout).split('\n').slice(0, 5).join(' | ').slice(0, 300);
  return makeCheck(
    checkId,
    label,
    'fail',
    `"${scriptName}" failed (exit ${result.exitCode ?? 'null'}): ${errOutput}`,
    `Fix failing ${scriptName} before shipping`,
  );
}

// ---------------------------------------------------------------------------
// Check 5: Secrets scan
// ---------------------------------------------------------------------------

/** Obvious key patterns to flag in tracked file contents. */
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'AWS access key',        re: /AKIA[0-9A-Z]{16}/ },
  { label: 'AWS secret key',        re: /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i },
  { label: 'generic API key',       re: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}["']?/i },
  { label: 'Bearer token',          re: /bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
  { label: 'private key header',    re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { label: 'GitHub token',          re: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}/ },
  { label: 'Stripe secret key',     re: /sk_(live|test)_[A-Za-z0-9]{20,}/ },
  { label: 'Anthropic API key',     re: /sk-ant-[A-Za-z0-9\-_]{20,}/ },
  { label: 'OpenAI API key',        re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: 'password assignment',   re: /password\s*[:=]\s*["'][^"']{8,}["']/i },
];

/** Check for committed .env files or obvious secret patterns in tracked files. */
function checkSecrets(projectPath: string): ShipCheck {
  const id = 'secrets';
  const label = 'Secrets scan';

  // Check if this is a git repo
  const gitResult = runSync('git', ['rev-parse', '--git-dir'], projectPath, 5_000);
  if (gitResult.exitCode !== 0) {
    return makeCheck(id, label, 'skip', 'Not a git repository — skipping secrets scan');
  }

  const findings: string[] = [];

  // 1. Check for .env files tracked by git.
  // List candidates directly (NUL-separated) WITHOUT --error-unmatch: that flag
  // exits 1 whenever ANY pathspec has no match, which would skip the whole
  // branch even when a real .env / .env.production IS tracked. Any non-empty
  // output here is a finding.
  const lsFilesResult = runSync(
    'git',
    ['ls-files', '-z', '--', '*.env', '.env', '.env.*'],
    projectPath,
    10_000,
  );
  if (lsFilesResult.exitCode === 0 && lsFilesResult.stdout.length > 0) {
    const envFiles = lsFilesResult.stdout.split('\0').filter(Boolean);
    for (const line of envFiles) {
      findings.push(`.env file tracked by git: ${line}`);
    }
  }

  // 2. Scan tracked files for obvious key patterns (bounded: only text-ish files, skip binaries)
  // Get list of tracked files (limit to a reasonable count to avoid huge scans)
  const trackedResult = runSync(
    'git',
    ['ls-files', '--cached', '-z'],
    projectPath,
    15_000,
  );

  if (trackedResult.exitCode === 0 && trackedResult.stdout.length > 0) {
    // Split on NUL (git -z output)
    const files = trackedResult.stdout.split('\0').filter(Boolean).slice(0, 500);

    // Extensions we'll scan (skip known binary types)
    const TEXT_EXTS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.json', '.yaml', '.yml', '.toml', '.env',
      '.sh', '.bash', '.zsh', '.fish',
      '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
      '.txt', '.md', '.mdx', '.html', '.css', '.scss',
      '.conf', '.cfg', '.ini', '.config',
    ]);

    // Any tracked env-family file (.env, .env.local, .env.production, foo.env,
    // config/secrets.env) is text-scannable regardless of its trailing
    // extension, which would otherwise be e.g. '.production' and miss the
    // allowlist.
    const ENV_FAMILY_RE = /(^|\/)\.env($|\.)|\.env$/;

    const scannedPaths = new Set<string>();
    for (const relPath of files) {
      const ext = relPath.includes('.') ? `.${relPath.split('.').pop()!.toLowerCase()}` : '';
      if (!TEXT_EXTS.has(ext) && !ENV_FAMILY_RE.test(relPath)) continue;

      const absPath = join(projectPath, relPath);
      if (scannedPaths.has(absPath)) continue;
      scannedPaths.add(absPath);

      try {
        if (!existsSync(absPath)) continue;
        const content = readFileSync(absPath, 'utf8');
        for (const { label: patLabel, re } of SECRET_PATTERNS) {
          if (re.test(content)) {
            // Don't add duplicates for same file + pattern
            const key = `${relPath}:${patLabel}`;
            if (!findings.some((f) => f.includes(key))) {
              findings.push(`${relPath}: possible ${patLabel}`);
            }
            break; // one warning per file is enough
          }
        }
      } catch {
        // Unreadable file — skip silently
      }
    }
  }

  if (findings.length === 0) {
    return makeCheck(id, label, 'pass', 'No committed .env files or obvious key patterns found');
  }

  const detail = `${findings.length} finding(s): ${findings.slice(0, 3).join('; ')}${findings.length > 3 ? ` (+${findings.length - 3} more)` : ''}`;
  return makeCheck(
    id,
    label,
    'warn',
    detail,
    'Remove secrets from tracked files; add to .gitignore; use phantom or env vars',
  );
}

// ---------------------------------------------------------------------------
// runShipGate
// ---------------------------------------------------------------------------

/**
 * Run all pre-ship gate checks for the project at `projectPath`.
 *
 * READ-ONLY: scans files and runs npm scripts. Never deploys or pushes.
 * Never throws — all errors are captured as ShipCheck fail/warn/skip entries.
 *
 * Checks run in order:
 *   1. supply-chain  — binshield (if installed) else built-in dep sanity check
 *   2. test          — npm run test (if script exists)
 *   3. lint          — npm run lint (if script exists)
 *   4. build         — npm run build (if script exists)
 *   5. secrets       — git-tracked .env files + obvious key patterns
 *
 * `passed` is true when no check has status 'fail'.
 */
export async function runShipGate(
  projectPath: string,
  opts: { strict: boolean },
): Promise<ShipGate> {
  void opts; // strict is only consumed by the CLI (exit code); gate itself just reports

  const absPath = resolve(projectPath);
  const checks: ShipCheck[] = [];

  // Read package.json once — shared by script checks
  const pkg = readPackageJson(absPath);
  const scripts = pkg ? getScripts(pkg) : {};

  // 1. Supply-chain
  try {
    checks.push(checkSupplyChain(absPath));
  } catch (err) {
    checks.push(makeCheck(
      'supply-chain',
      'Supply-chain check',
      'warn',
      `Check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 2. Test
  try {
    checks.push(runScriptCheck('test', 'Tests', 'test', absPath, scripts));
  } catch (err) {
    checks.push(makeCheck(
      'test',
      'Tests',
      'warn',
      `Test check threw: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 3. Lint
  try {
    checks.push(runScriptCheck('lint', 'Lint', 'lint', absPath, scripts));
  } catch (err) {
    checks.push(makeCheck(
      'lint',
      'Lint',
      'warn',
      `Lint check threw: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 4. Build
  try {
    checks.push(runScriptCheck('build', 'Build', 'build', absPath, scripts));
  } catch (err) {
    checks.push(makeCheck(
      'build',
      'Build',
      'warn',
      `Build check threw: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 5. Secrets
  try {
    checks.push(checkSecrets(absPath));
  } catch (err) {
    checks.push(makeCheck(
      'secrets',
      'Secrets scan',
      'warn',
      `Secrets check threw: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // Build summary
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) {
    summary[c.status]++;
  }

  const passed = summary.fail === 0;

  return { checks, summary, passed };
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

/** Guidance strings for tools that are absent. */
const ABSENT_GUIDANCE: Record<string, string> = {
  morphkit: 'morphkit not installed — run: npm i -g morphkit-cli (see morphkit.dev)',
  binshield: 'binshield not installed — see binshield.dev',
};

/** The deploy command to run for each supported target. */
function buildDeployCommand(target: string, projectPath: string): string {
  switch (target) {
    case 'vercel':
      // `vercel` deploys from the project directory; --prod for production
      return `vercel --cwd ${JSON.stringify(projectPath)}`;
    case 'stack':
      return `stack deploy`;
    case 'morphkit':
      // morphkit has no 'deploy' command; 'generate' is the correct pipeline command
      return `morphkit generate ${JSON.stringify(projectPath)} -o ${JSON.stringify(join(projectPath, 'ios-app'))}`;
    case 'gh':
      // gh pages deploy (common gh-pages pattern)
      return `gh workflow run deploy.yml`;
    default:
      return `${target} deploy`;
  }
}

/**
 * Optionally deploy the project to the named target.
 *
 * DRY-RUN BY DEFAULT: only runs the real deploy command when `opts.confirm`
 * is true. This is the ONLY function in the codebase that may execute an
 * outward action.
 *
 * Supported targets: vercel | stack | morphkit | gh
 * Detect every tool at runtime via `which`. If the tool is not installed,
 * return a guidance string instead of failing.
 *
 * Never throws.
 */
export async function deploy(
  projectPath: string,
  target: string,
  opts: { confirm: boolean },
): Promise<{ ran: boolean; dryRun: boolean; detail: string }> {
  const absPath = resolve(projectPath);

  // Check for absent-with-guidance tools first
  if (Object.prototype.hasOwnProperty.call(ABSENT_GUIDANCE, target)) {
    const known = ABSENT_GUIDANCE[target];
    if (known !== undefined) {
      // Still check if it happens to be installed (e.g. user installed morphkit later)
      const toolPath = whichSync(target);
      if (toolPath === null) {
        return { ran: false, dryRun: false, detail: known };
      }
    }
  }

  const toolPath = whichSync(target);
  if (toolPath === null) {
    const guidance = ABSENT_GUIDANCE[target] ?? `${target} not installed — install it to use this deploy target`;
    return { ran: false, dryRun: false, detail: guidance };
  }

  const cmd = buildDeployCommand(target, absPath);

  // Dry-run: report what would run without executing
  if (!opts.confirm) {
    return {
      ran: false,
      dryRun: true,
      detail: `DRY RUN: would run: ${cmd}`,
    };
  }

  // --- CONFIRM path: actually run the deploy ---
  // Build the argv array for spawnSync
  let spawnCmd: string;
  let spawnArgs: string[];

  switch (target) {
    case 'vercel':
      spawnCmd = 'vercel';
      spawnArgs = ['--cwd', absPath];
      break;
    case 'stack':
      spawnCmd = 'stack';
      spawnArgs = ['deploy'];
      break;
    case 'morphkit':
      spawnCmd = 'morphkit';
      spawnArgs = ['generate', absPath, '-o', join(absPath, 'ios-app')];
      break;
    case 'gh':
      spawnCmd = 'gh';
      spawnArgs = ['workflow', 'run', 'deploy.yml'];
      break;
    default:
      spawnCmd = target;
      spawnArgs = ['deploy'];
  }

  try {
    const result = runSync(spawnCmd, spawnArgs, absPath, DEPLOY_TIMEOUT_MS);

    if (result.timedOut) {
      return {
        ran: false,
        dryRun: false,
        detail: `Deploy command timed out after ${DEPLOY_TIMEOUT_MS / 1000}s: ${cmd}`,
      };
    }
    if (result.error) {
      return {
        ran: false,
        dryRun: false,
        detail: `Deploy failed to launch: ${result.error}`,
      };
    }
    if (result.exitCode === 0) {
      const firstLine = (result.stdout || result.stderr).split('\n').find((l) => l.trim()) ?? '';
      const detail = firstLine
        ? `Deploy succeeded: ${firstLine.slice(0, 200)}`
        : 'Deploy succeeded';
      return { ran: true, dryRun: false, detail };
    }

    // Non-zero exit
    const errOutput = (result.stderr || result.stdout).split('\n').slice(0, 5).join(' | ').slice(0, 300);
    return {
      ran: false,
      dryRun: false,
      detail: `Deploy failed (exit ${result.exitCode ?? 'null'}): ${errOutput}`,
    };
  } catch (err) {
    return {
      ran: false,
      dryRun: false,
      detail: `Deploy threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
