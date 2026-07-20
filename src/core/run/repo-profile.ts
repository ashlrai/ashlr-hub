/**
 * Shared, read-only repo execution profile.
 *
 * This module is deliberately observational: it reads manifests and common
 * build files, but never spawns package managers, installs dependencies, or
 * writes state. Verification, self-heal, ecosystem doctor, and future fleet
 * routing can all ask one question here instead of re-learning package roots.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { VerifyCommand, VerifyCommandProfile } from './verify-commands.js';

export type RepoPackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'cargo'
  | 'make'
  | 'just'
  | 'bats'
  | 'python'
  | 'brew'
  | 'custom';
export type RepoProjectKind =
  | 'node'
  | 'rust'
  | 'python'
  | 'homebrew-formula'
  | 'make'
  | 'just'
  | 'bats'
  | 'verify-contract';
export type RepoVerifyContractMode = 'replace-detected' | 'augment-detected';

export interface RepoVerifyContractSummary {
  present: boolean;
  valid: boolean;
  schemaVersion?: 1;
  mode?: RepoVerifyContractMode;
  commandCount: number;
  requiredCount: number;
  profileCounts: Partial<Record<VerifyCommandProfile, number>>;
  mergeProfileCommandCount: number;
  requiredMergeProfileCommandCount: number;
  mergeGradeExplicit: boolean;
  /** Every distinct non-root detected ecosystem has a required merge command rooted at it. */
  mergeCoverageComplete: boolean;
  uncoveredMergeProjects: Array<{
    relativeRoot: string;
    kind: RepoProjectKind;
  }>;
  mergeGradeReason: string;
  errors: string[];
}

export interface RepoProjectProfile {
  root: string;
  relativeRoot: string;
  kind: RepoProjectKind;
  packageManager: RepoPackageManager;
  scripts: string[];
  manifests: string[];
  verifyCommands: VerifyCommand[];
}

export interface RepoExecutionProfile {
  repoRoot: string;
  projects: RepoProjectProfile[];
  primaryProject: RepoProjectProfile | null;
  verifyCommands: VerifyCommand[];
  verifyCommandSource: 'none' | 'detected' | 'contract' | 'mixed';
  detectedVerifyCommandCount: number;
  contractVerifyCommandCount: number;
  verifyContract?: RepoVerifyContractSummary;
  noVerifyReason: string | null;
  /** Canonical metadata consumed by the merge-verify-contract scanner digest. */
  mergeVerifyContractSource: MergeVerifyContractScannerSource;
}

export interface CanonicalVerifyCommand {
  kind: VerifyCommand['kind'];
  cmd: string[];
  id?: string;
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  profiles?: VerifyCommandProfile[];
}

export interface MergeVerifyContractScannerSource {
  inputState: 'complete' | 'malformed' | 'unreadable';
  detector: {
    maxDepth: number;
    verifyContractFile: typeof VERIFY_CONTRACT_FILE;
  };
  projectKinds: RepoProjectKind[];
  detectedVerifyCommands: CanonicalVerifyCommand[];
  verifyContract: null | {
    summary: RepoVerifyContractSummary;
    commands: CanonicalVerifyCommand[];
  };
}

/**
 * A present contract that lacks merge coverage must never be treated as
 * merge-grade verification. Repositories without a contract retain their
 * legacy detection behavior; rollout policy decides whether that is eligible.
 */
export function mergeContractCoverageFailure(profile: RepoExecutionProfile): string | null {
  const contract = profile.verifyContract;
  if (!contract?.present) return null;
  // Advisory-only contracts retain the existing command-level refusal so the
  // caller can distinguish "no required verifier" from missing nested scope.
  if (!contract.mergeGradeExplicit || contract.mergeCoverageComplete) return null;
  return contract.mergeGradeReason;
}

function packageJsonInputState(projectRoots: readonly string[]): MergeVerifyContractScannerSource['inputState'] {
  for (const projectRoot of projectRoots) {
    const path = join(projectRoot, 'package.json');
    if (!hasFile(projectRoot, 'package.json')) continue;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return 'unreadable';
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed';
    } catch {
      return 'malformed';
    }
  }
  return 'complete';
}

interface PackageJsonSubset {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  packageManager?: unknown;
}

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const VERIFY_CONTRACT_FILE = 'ashlr.verify.json';
const CONTRACT_MAX_TIMEOUT_MS = 600_000;
const VERIFY_COMMAND_KINDS = new Set<VerifyCommand['kind']>(['typecheck', 'lint', 'build', 'test']);
const VERIFY_CONTRACT_MODES = new Set<RepoVerifyContractMode>(['replace-detected', 'augment-detected']);
const VERIFY_COMMAND_PROFILES = new Set<VerifyCommandProfile>(['quick', 'merge', 'deep']);

function readPackageJson(root: string): PackageJsonSubset | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonSubset;
  } catch {
    return null;
  }
}

function scriptsOf(pkg: PackageJsonSubset | null): Record<string, string> {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function hasDep(pkg: PackageJsonSubset | null, dep: string): boolean {
  if (!pkg) return false;
  return (
    (pkg.dependencies !== undefined && dep in pkg.dependencies) ||
    (pkg.devDependencies !== undefined && dep in pkg.devDependencies)
  );
}

function hasConfigFile(root: string, prefix: string): boolean {
  try {
    return readdirSync(root).some((file) => file === prefix || file.startsWith(`${prefix}.`));
  } catch {
    return false;
  }
}

function hasFile(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

function readText(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), 'utf8');
  } catch {
    return null;
  }
}

function hasTomlTool(root: string, tool: string): boolean {
  const raw = readText(root, 'pyproject.toml');
  if (!raw) return false;
  return new RegExp(`^\\s*\\[tool\\.${tool}(?:\\.|\\])`, 'm').test(raw);
}

function hasIniSection(root: string, fileName: string, section: string): boolean {
  const raw = readText(root, fileName);
  if (!raw) return false;
  return new RegExp(`^\\s*\\[${section}\\]`, 'm').test(raw);
}

function safeRelative(root: string, child: string): string | null {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel.replace(/\\/g, '/');
}

function safeContractCwd(repoRoot: string, cwd: unknown, errors: string[], label: string): string | null {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    if (cwd !== undefined) {
      errors.push(`${label}.cwd must be a non-empty string when provided`);
      return null;
    }
  }
  const requestedCwd = cwd === undefined ? '.' : cwd;
  const lexicalRoot = resolve(repoRoot);
  const lexicalResolved = resolve(lexicalRoot, requestedCwd);
  const lexicalRelative = relative(lexicalRoot, lexicalResolved);
  if (lexicalRelative !== '' && (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative))) {
    errors.push(`${label}.cwd must stay inside the repo`);
    return null;
  }

  let physicalRoot: string;
  let physicalResolved: string;
  try {
    physicalRoot = realpathSync(repoRoot);
    physicalResolved = realpathSync(lexicalResolved);
  } catch {
    errors.push(`${label}.cwd must resolve to an existing directory inside the repo`);
    return null;
  }
  if (!lstatSync(physicalResolved).isDirectory()) {
    errors.push(`${label}.cwd must resolve to a directory inside the repo`);
    return null;
  }
  const rel = relative(physicalRoot, physicalResolved);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    errors.push(`${label}.cwd must stay inside the repo`);
    return null;
  }
  return lexicalResolved;
}

function parseContractProfiles(raw: unknown, errors: string[], label: string): VerifyCommandProfile[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${label}.profiles must be an array`);
    return undefined;
  }
  const profiles: VerifyCommandProfile[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== 'string' || !VERIFY_COMMAND_PROFILES.has(value as VerifyCommandProfile)) {
      errors.push(`${label}.profiles[${index}] must be quick, merge, or deep`);
      continue;
    }
    profiles.push(value as VerifyCommandProfile);
  }
  return profiles.length > 0 ? [...new Set(profiles)] : undefined;
}

interface ParsedVerifyContract {
  mode: RepoVerifyContractMode;
  commands: VerifyCommand[];
  summary: RepoVerifyContractSummary;
}

function summarizeVerifyContract(
  opts: {
    present: boolean;
    valid: boolean;
    schemaVersion?: 1;
    mode?: RepoVerifyContractMode;
    commands: VerifyCommand[];
    errors: string[];
  },
): RepoVerifyContractSummary {
  const requiredCount = opts.commands.filter((command) => command.required !== false).length;
  const profileCounts: Partial<Record<VerifyCommandProfile, number>> = {};
  for (const command of opts.commands) {
    for (const profile of command.profiles ?? []) {
      profileCounts[profile] = (profileCounts[profile] ?? 0) + 1;
    }
  }
  const mergeProfileCommandCount = opts.commands.filter((command) => command.profiles?.includes('merge')).length;
  const requiredMergeProfileCommandCount = opts.commands.filter(
    (command) => command.required !== false && command.profiles?.includes('merge'),
  ).length;
  const mergeGradeExplicit = opts.valid && requiredMergeProfileCommandCount > 0;
  let mergeGradeReason = `${requiredMergeProfileCommandCount} required merge-profile command(s)`;
  if (!opts.valid) {
    mergeGradeReason = `invalid ${VERIFY_CONTRACT_FILE}: ${opts.errors[0] ?? 'contract validation failed'}`;
  } else if (opts.commands.length === 0) {
    mergeGradeReason = 'contract has no commands';
  } else if (mergeProfileCommandCount === 0) {
    mergeGradeReason = 'no command declares the merge profile';
  } else if (requiredMergeProfileCommandCount === 0) {
    mergeGradeReason = 'merge-profile commands are optional';
  }

  return {
    present: opts.present,
    valid: opts.valid,
    ...(opts.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    commandCount: opts.commands.length,
    requiredCount,
    profileCounts,
    mergeProfileCommandCount,
    requiredMergeProfileCommandCount,
    mergeGradeExplicit,
    mergeCoverageComplete: mergeGradeExplicit,
    uncoveredMergeProjects: [],
    mergeGradeReason,
    errors: opts.errors,
  };
}

function summarizeMergeCoverage(
  repoRoot: string,
  projects: RepoProjectProfile[],
  summary: RepoVerifyContractSummary,
  commands: VerifyCommand[],
): RepoVerifyContractSummary {
  if (!summary.mergeGradeExplicit) return summary;
  const requiredMergeCommands = commands.filter((command) =>
    command.required !== false && (command.profiles === undefined || command.profiles.includes('merge')),
  );
  const projectsPerRoot = new Map<string, number>();
  for (const project of projects) {
    if (project.kind === 'verify-contract') continue;
    projectsPerRoot.set(project.root, (projectsPerRoot.get(project.root) ?? 0) + 1);
  }
  const commandCoversProject = (command: VerifyCommand, project: RepoProjectProfile): boolean => {
    if (resolve(command.cwd ?? repoRoot) !== project.root) return false;
    // A shared working directory alone cannot prove which verifier runs when
    // several ecosystems coexist there. Bind those commands to the detector's
    // argv/kind signature instead of silently certifying every ecosystem.
    if ((projectsPerRoot.get(project.root) ?? 0) <= 1) return true;
    return project.verifyCommands.some((detected) =>
      detected.kind === command.kind &&
      detected.cmd.length === command.cmd.length &&
      detected.cmd.every((part, index) => part === command.cmd[index]),
    );
  };
  const uncoveredMergeProjects = projects
    .filter((project) =>
      project.kind !== 'verify-contract' &&
      (project.root !== repoRoot || (projectsPerRoot.get(project.root) ?? 0) > 1) &&
      !requiredMergeCommands.some((command) => commandCoversProject(command, project)),
    )
    .map((project) => ({ relativeRoot: project.relativeRoot, kind: project.kind }));
  if (uncoveredMergeProjects.length === 0) return summary;
  const rendered = uncoveredMergeProjects
    .map((project) => `${project.kind}@${project.relativeRoot}`)
    .join(', ');
  return {
    ...summary,
    mergeCoverageComplete: false,
    uncoveredMergeProjects,
    mergeGradeReason: `${summary.mergeGradeReason}; missing required merge coverage for ${rendered}`,
  };
}

function parseVerifyContract(repoRoot: string): ParsedVerifyContract | null {
  const path = join(repoRoot, VERIFY_CONTRACT_FILE);
  if (!existsSync(path)) return null;

  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      mode: 'augment-detected',
      commands: [],
      summary: summarizeVerifyContract({
        present: true,
        valid: false,
        commands: [],
        errors: [`invalid JSON: ${msg}`],
      }),
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('contract root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['schemaVersion'] !== 1) {
    errors.push('schemaVersion must be 1');
  }
  const mode = obj['mode'];
  if (typeof mode !== 'string' || !VERIFY_CONTRACT_MODES.has(mode as RepoVerifyContractMode)) {
    errors.push('mode must be replace-detected or augment-detected');
  }

  const commandsRaw = obj['commands'];
  if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) {
    errors.push('commands must be a non-empty array');
  }

  const commands: VerifyCommand[] = [];
  if (Array.isArray(commandsRaw)) {
    for (const [index, commandRaw] of commandsRaw.entries()) {
      const label = `commands[${index}]`;
      if (!commandRaw || typeof commandRaw !== 'object' || Array.isArray(commandRaw)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      const command = commandRaw as Record<string, unknown>;
      const id = command['id'];
      const kind = command['kind'];
      const cmd = command['cmd'];

      if (typeof id !== 'string' || id.trim().length === 0) {
        errors.push(`${label}.id must be a non-empty string`);
        continue;
      }
      if (typeof kind !== 'string' || !VERIFY_COMMAND_KINDS.has(kind as VerifyCommand['kind'])) {
        errors.push(`${label}.kind must be typecheck, lint, build, or test`);
        continue;
      }
      if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((part) => typeof part === 'string' && part.length > 0)) {
        errors.push(`${label}.cmd must be a non-empty argv array of strings`);
        continue;
      }

      const cwd = safeContractCwd(repoRoot, command['cwd'], errors, label);
      if (!cwd) continue;

      const timeoutRaw = command['timeoutMs'];
      let timeoutMs: number | undefined;
      if (timeoutRaw !== undefined) {
        if (
          typeof timeoutRaw !== 'number' ||
          !Number.isFinite(timeoutRaw) ||
          timeoutRaw <= 0 ||
          timeoutRaw > CONTRACT_MAX_TIMEOUT_MS
        ) {
          errors.push(`${label}.timeoutMs must be a positive number at or below ${CONTRACT_MAX_TIMEOUT_MS}`);
          continue;
        }
        timeoutMs = Math.floor(timeoutRaw);
      }

      const requiredRaw = command['required'];
      if (requiredRaw !== undefined && typeof requiredRaw !== 'boolean') {
        errors.push(`${label}.required must be a boolean when provided`);
        continue;
      }
      const profiles = parseContractProfiles(command['profiles'], errors, label);
      const vc: VerifyCommand = {
        id,
        kind: kind as VerifyCommand['kind'],
        cmd: [...cmd] as string[],
      };
      const rel = safeRelative(repoRoot, cwd);
      if (rel !== null) vc.cwd = cwd;
      if (timeoutMs !== undefined) vc.timeoutMs = timeoutMs;
      if (typeof requiredRaw === 'boolean') vc.required = requiredRaw;
      if (profiles) vc.profiles = profiles;
      commands.push(vc);
    }
  }

  const valid = errors.length === 0;
  const contractMode = VERIFY_CONTRACT_MODES.has(mode as RepoVerifyContractMode)
    ? mode as RepoVerifyContractMode
    : 'augment-detected';
  return {
    mode: contractMode,
    commands: valid ? commands : [],
    summary: summarizeVerifyContract({
      present: true,
      valid,
      ...(obj['schemaVersion'] === 1 ? { schemaVersion: 1 as const } : {}),
      ...(VERIFY_CONTRACT_MODES.has(mode as RepoVerifyContractMode) ? { mode: contractMode } : {}),
      commands: valid ? commands : [],
      errors,
    }),
  };
}

export function detectPackageManager(root: string): RepoPackageManager {
  const declared = detectDeclaredNodePackageManager(root);
  if (declared) return declared;
  if (hasFile(root, 'Cargo.toml')) return 'cargo';
  if (hasFile(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasFile(root, 'yarn.lock')) return 'yarn';
  if (hasFile(root, 'bun.lock') || hasFile(root, 'bun.lockb')) return 'bun';
  if (hasFile(root, 'justfile') || hasFile(root, 'Justfile')) return 'just';
  if (hasFile(root, 'Makefile') || hasFile(root, 'makefile')) return 'make';
  return 'npm';
}

function detectDeclaredNodePackageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' | null {
  const pkg = readPackageJson(root);
  if (typeof pkg?.packageManager !== 'string') return null;
  const [name] = pkg.packageManager.split('@');
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null;
}

function detectNodePackageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const declared = detectDeclaredNodePackageManager(root);
  if (declared) return declared;
  if (hasFile(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasFile(root, 'yarn.lock')) return 'yarn';
  if (hasFile(root, 'bun.lock') || hasFile(root, 'bun.lockb')) return 'bun';
  return 'npm';
}

function runScriptArgv(pm: string, script: string): string[] {
  return [pm, 'run', script];
}

function projectCwd(repoRoot: string, projectRoot: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(projectRoot));
  return rel && rel !== '' ? projectRoot : undefined;
}

/** Normalize verifier metadata so equivalent repositories hash identically. */
export function canonicalizeVerifyCommands(
  repoRoot: string,
  commands: readonly VerifyCommand[],
): CanonicalVerifyCommand[] {
  const root = resolve(repoRoot);
  return commands
    .map((command): CanonicalVerifyCommand => {
      const cwd = command.cwd ? relative(root, resolve(command.cwd)).replace(/\\/g, '/') || '.' : undefined;
      return {
        kind: command.kind,
        cmd: [...command.cmd],
        ...(command.id ? { id: command.id } : {}),
        ...(cwd ? { cwd } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.required !== undefined ? { required: command.required } : {}),
        ...(command.profiles ? { profiles: [...new Set(command.profiles)].sort() } : {}),
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function commandWithCwd(
  repoRoot: string,
  projectRoot: string,
  kind: VerifyCommand['kind'],
  cmd: string[],
): VerifyCommand {
  const cwd = projectCwd(repoRoot, projectRoot);
  return cwd ? { kind, cmd, cwd } : { kind, cmd };
}

function nodeProject(repoRoot: string, root: string): RepoProjectProfile | null {
  const hasPackage = hasFile(root, 'package.json');
  const hasTsconfig = hasFile(root, 'tsconfig.json');
  const hasVitestConfig = hasConfigFile(root, 'vitest.config');
  if (!hasPackage && !hasTsconfig && !hasVitestConfig) return null;
  const pkg = readPackageJson(root);
  const scripts = scriptsOf(pkg);
  const pm = detectNodePackageManager(root);
  const commands: VerifyCommand[] = [];

  if (scripts.typecheck) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', runScriptArgv(pm, 'typecheck')));
  } else if (scripts.check) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', runScriptArgv(pm, 'check')));
  } else if (hasTsconfig) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', ['npx', 'tsc', '--noEmit']));
  }

  if (scripts.lint) {
    commands.push(commandWithCwd(repoRoot, root, 'lint', runScriptArgv(pm, 'lint')));
  }

  if (scripts.build) {
    commands.push(commandWithCwd(repoRoot, root, 'build', runScriptArgv(pm, 'build')));
  }

  if (scripts.test) {
    commands.push(commandWithCwd(repoRoot, root, 'test', runScriptArgv(pm, 'test')));
  } else if (hasDep(pkg, 'vitest') || hasVitestConfig) {
    commands.push(commandWithCwd(repoRoot, root, 'test', ['npx', 'vitest', 'run']));
  }

  return {
    root,
    relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.', // M341b: posix in profiles/ledgers
    kind: 'node',
    packageManager: pm,
    scripts: Object.keys(scripts).sort(),
    manifests: [
      ...(hasPackage ? ['package.json'] : []),
      ...(hasTsconfig ? ['tsconfig.json'] : []),
      ...(hasVitestConfig ? ['vitest.config'] : []),
    ],
    verifyCommands: commands,
  };
}

function rustProject(repoRoot: string, root: string): RepoProjectProfile | null {
  if (!hasFile(root, 'Cargo.toml')) return null;
  return {
    root,
    relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.', // M341b: posix in profiles/ledgers
    kind: 'rust',
    packageManager: 'cargo',
    scripts: [],
    manifests: ['Cargo.toml'],
    verifyCommands: [
      commandWithCwd(repoRoot, root, 'typecheck', ['cargo', 'check']),
      commandWithCwd(repoRoot, root, 'test', ['cargo', 'test']),
    ],
  };
}

function pythonTestFiles(root: string): string[] {
  try {
    const testsDir = join(root, 'tests');
    if (!safeDir(testsDir)) return [];
    return readdirSync(testsDir)
      .filter((file) => /^test_.*\.py$/.test(file))
      .sort()
      .map((file) => join('tests', file));
  } catch {
    return [];
  }
}

function hasRuffConfig(root: string): boolean {
  return hasFile(root, 'ruff.toml') || hasFile(root, '.ruff.toml') || hasTomlTool(root, 'ruff');
}

function hasMypyConfig(root: string): boolean {
  return (
    hasFile(root, 'mypy.ini') ||
    hasFile(root, '.mypy.ini') ||
    hasIniSection(root, 'setup.cfg', 'mypy') ||
    hasTomlTool(root, 'mypy')
  );
}

function pythonProject(repoRoot: string, root: string): RepoProjectProfile | null {
  const hasPyproject = hasFile(root, 'pyproject.toml');
  const hasPytestIni = hasFile(root, 'pytest.ini');
  const hasToxIni = hasFile(root, 'tox.ini');
  const testFiles = pythonTestFiles(root);
  const ruffConfigured = hasRuffConfig(root);
  const mypyConfigured = hasMypyConfig(root);
  const hasPytestSignal = hasPyproject || hasPytestIni || hasToxIni || testFiles.length > 0;

  if (!hasPytestSignal && !ruffConfigured && !mypyConfigured) return null;

  const commands: VerifyCommand[] = [];
  if (mypyConfigured) commands.push(commandWithCwd(repoRoot, root, 'typecheck', ['python', '-m', 'mypy', '.']));
  if (hasPytestSignal) commands.push(commandWithCwd(repoRoot, root, 'test', ['python', '-m', 'pytest', '-q']));
  if (ruffConfigured) commands.push(commandWithCwd(repoRoot, root, 'lint', ['python', '-m', 'ruff', 'check', '.']));

  return {
    root,
    relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.',
    kind: 'python',
    packageManager: 'python',
    scripts: [
      ...(mypyConfigured ? ['mypy'] : []),
      ...(hasPytestSignal ? ['pytest'] : []),
      ...(ruffConfigured ? ['ruff'] : []),
    ],
    manifests: [
      ...(hasPyproject ? ['pyproject.toml'] : []),
      ...(hasPytestIni ? ['pytest.ini'] : []),
      ...(hasToxIni ? ['tox.ini'] : []),
      ...(hasFile(root, 'ruff.toml') ? ['ruff.toml'] : []),
      ...(hasFile(root, '.ruff.toml') ? ['.ruff.toml'] : []),
      ...(hasFile(root, 'mypy.ini') ? ['mypy.ini'] : []),
      ...(hasFile(root, '.mypy.ini') ? ['.mypy.ini'] : []),
      ...(hasFile(root, 'setup.cfg') ? ['setup.cfg'] : []),
      ...testFiles,
    ],
    verifyCommands: commands,
  };
}

function formulaFiles(root: string): string[] {
  try {
    const formulaDir = join(root, 'Formula');
    if (!safeDir(formulaDir)) return [];
    return readdirSync(formulaDir)
      .filter((file) => file.endsWith('.rb'))
      .sort()
      .map((file) => join('Formula', file));
  } catch {
    return [];
  }
}

function homebrewFormulaProject(repoRoot: string, root: string): RepoProjectProfile | null {
  const formulas = formulaFiles(root);
  if (formulas.length === 0) return null;

  const commands: VerifyCommand[] = [];
  for (const formula of formulas) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', ['ruby', '-c', formula]));
  }

  return {
    root,
    relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.',
    kind: 'homebrew-formula',
    packageManager: 'brew',
    scripts: ['ruby-syntax'],
    manifests: formulas,
    verifyCommands: commands,
  };
}

function fileHasTarget(root: string, fileName: string, target: string): boolean {
  try {
    const raw = readFileSync(join(root, fileName), 'utf8');
    const pattern = new RegExp(`^${target}:`, 'm');
    return pattern.test(raw);
  } catch {
    return false;
  }
}

function batsFiles(root: string): string[] {
  try {
    const testsDir = join(root, 'tests');
    if (!safeDir(testsDir)) return [];
    return readdirSync(testsDir)
      .filter((file) => file.endsWith('.bats'))
      .sort()
      .map((file) => join('tests', file));
  } catch {
    return [];
  }
}

function shellProject(repoRoot: string, root: string): RepoProjectProfile | null {
  const makeFile = hasFile(root, 'Makefile') ? 'Makefile' : hasFile(root, 'makefile') ? 'makefile' : null;
  const justFile = hasFile(root, 'justfile') ? 'justfile' : hasFile(root, 'Justfile') ? 'Justfile' : null;
  const bats = batsFiles(root);
  if (!makeFile && !justFile && bats.length === 0) return null;

  if (!makeFile && !justFile && bats.length > 0) {
    return {
      root,
      relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.', // M341b: posix in profiles/ledgers
      kind: 'bats',
      packageManager: 'bats',
      scripts: ['test'],
      manifests: bats,
      verifyCommands: [commandWithCwd(repoRoot, root, 'test', ['bats', ...bats])],
    };
  }

  const useJust = justFile !== null;
  const manifest = useJust ? justFile : makeFile;
  const runner = useJust ? 'just' : 'make';
  const scripts = ['check', 'test', 'lint'].filter((target) =>
    manifest ? fileHasTarget(root, manifest, target) : false,
  );
  if (scripts.length === 0 && bats.length > 0) {
    return {
      root,
      relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.', // M341b: posix in profiles/ledgers
      kind: 'bats',
      packageManager: 'bats',
      scripts: ['test'],
      manifests: bats,
      verifyCommands: [commandWithCwd(repoRoot, root, 'test', ['bats', ...bats])],
    };
  }
  const commands: VerifyCommand[] = [];
  if (scripts.includes('check')) commands.push(commandWithCwd(repoRoot, root, 'typecheck', [runner, 'check']));
  if (scripts.includes('test')) commands.push(commandWithCwd(repoRoot, root, 'test', [runner, 'test']));
  if (scripts.includes('lint')) commands.push(commandWithCwd(repoRoot, root, 'lint', [runner, 'lint']));

  return {
    root,
    relativeRoot: relative(repoRoot, root).replace(/\\/g, '/') || '.', // M341b: posix in profiles/ledgers
    kind: useJust ? 'just' : 'make',
    packageManager: useJust ? 'just' : 'make',
    scripts,
    manifests: manifest ? [manifest] : [],
    verifyCommands: commands,
  };
}

function verifyContractProject(repoRoot: string, commands: VerifyCommand[]): RepoProjectProfile {
  return {
    root: repoRoot,
    relativeRoot: '.',
    kind: 'verify-contract',
    packageManager: 'custom',
    scripts: commands.map((command) => command.id ?? command.kind).sort(),
    manifests: [VERIFY_CONTRACT_FILE],
    verifyCommands: commands,
  };
}

function projectWithVerifyContract(project: RepoProjectProfile, commands: VerifyCommand[]): RepoProjectProfile {
  return {
    ...project,
    manifests: [...new Set([...project.manifests, VERIFY_CONTRACT_FILE])],
    verifyCommands: [...project.verifyCommands, ...commands],
  };
}

function projectWithReplacedVerifyCommands(project: RepoProjectProfile, commands: VerifyCommand[]): RepoProjectProfile {
  return {
    ...project,
    manifests: [...new Set([...project.manifests, VERIFY_CONTRACT_FILE])],
    verifyCommands: commands,
  };
}

function projectsAt(repoRoot: string, root: string): RepoProjectProfile[] {
  return [
    nodeProject(repoRoot, root),
    rustProject(repoRoot, root),
    pythonProject(repoRoot, root),
    homebrewFormulaProject(repoRoot, root),
    shellProject(repoRoot, root),
  ].filter((project): project is RepoProjectProfile => project !== null);
}

function safeDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function discoverProjectRoots(repoRoot: string, maxDepth: number): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (seen.has(dir) || depth > maxDepth) return;
    seen.add(dir);
    if (projectsAt(repoRoot, dir).length > 0) roots.push(dir);
    if (depth === maxDepth) return;

    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      if (!safeDir(child)) continue;
      walk(child, depth + 1);
    }
  };
  walk(repoRoot, 0);
  return roots;
}

export function detectRepoExecutionProfile(
  repoRoot: string,
  opts?: { maxDepth?: number },
): RepoExecutionProfile {
  const root = resolve(repoRoot);
  const maxDepth = Math.max(0, Math.min(3, opts?.maxDepth ?? 2));
  const projectRoots = discoverProjectRoots(root, maxDepth);
  const inputState = packageJsonInputState(projectRoots);
  let projects = projectRoots
    .flatMap((projectRoot) => projectsAt(root, projectRoot))
    .sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot) || a.kind.localeCompare(b.kind));

  const detectedPrimaryProject = projects.find((project) => project.root === root) ?? projects[0] ?? null;
  const rootCommands = projects
    .filter((project) => project.root === root)
    .flatMap((project) => project.verifyCommands);
  const detectedCommands = rootCommands.length > 0
    ? rootCommands
    : projects.flatMap((project) => project.verifyCommands);
  const detectedProjectKinds = [...new Set(projects.map((project) => project.kind))].sort();
  let contract = parseVerifyContract(root);
  if (contract) {
    const coverageCommands = contract.mode === 'augment-detected'
      ? [...detectedCommands, ...contract.commands]
      : contract.commands;
    contract = {
      ...contract,
      summary: summarizeMergeCoverage(root, projects, contract.summary, coverageCommands),
    };
  }
  let verifyCommands = detectedCommands;
  let effectiveDetectedVerifyCommandCount = detectedCommands.length;
  let effectiveContractVerifyCommandCount = 0;

  if (contract?.summary.valid) {
    const rootIndex = projects.findIndex((project) => project.root === root);
    if (contract.mode === 'replace-detected') {
      verifyCommands = contract.commands;
      effectiveDetectedVerifyCommandCount = 0;
      effectiveContractVerifyCommandCount = contract.commands.length;
      if (rootIndex >= 0) projects[rootIndex] = projectWithReplacedVerifyCommands(projects[rootIndex], contract.commands);
      else projects = [verifyContractProject(root, contract.commands), ...projects];
    } else {
      verifyCommands = [...detectedCommands, ...contract.commands];
      effectiveContractVerifyCommandCount = contract.commands.length;
      if (rootIndex >= 0) projects[rootIndex] = projectWithVerifyContract(projects[rootIndex], contract.commands);
      else projects = [verifyContractProject(root, contract.commands), ...projects];
    }
    projects = projects.sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot) || a.kind.localeCompare(b.kind));
  } else if (contract?.summary.present && projects.length === 0) {
    projects = [verifyContractProject(root, [])];
  }

  const primaryProject = projects.find((project) => project.root === root) ?? projects[0] ?? null;
  const verifyCommandSource =
    effectiveDetectedVerifyCommandCount > 0 && effectiveContractVerifyCommandCount > 0
      ? 'mixed'
      : effectiveContractVerifyCommandCount > 0
        ? 'contract'
        : effectiveDetectedVerifyCommandCount > 0
          ? 'detected'
          : 'none';

  return {
    repoRoot: root,
    projects,
    primaryProject,
    verifyCommands,
    verifyCommandSource,
    detectedVerifyCommandCount: detectedCommands.length,
    contractVerifyCommandCount: contract?.summary.valid ? contract.commands.length : 0,
    ...(contract ? { verifyContract: contract.summary } : {}),
    noVerifyReason: describeNoVerifyCommandReason(projects, verifyCommands, contract?.summary),
    mergeVerifyContractSource: {
      inputState,
      detector: { maxDepth, verifyContractFile: VERIFY_CONTRACT_FILE },
      projectKinds: detectedProjectKinds,
      detectedVerifyCommands: canonicalizeVerifyCommands(root, detectedCommands),
      verifyContract: contract
        ? {
            summary: contract.summary,
            commands: canonicalizeVerifyCommands(root, contract.commands),
          }
        : null,
    },
  };
}

function describeNoVerifyCommandReason(
  projects: RepoProjectProfile[],
  commands: VerifyCommand[],
  contract?: RepoVerifyContractSummary,
): string | null {
  if (commands.length > 0) return null;
  if (contract?.present && !contract.valid) {
    const detail = contract.errors[0] ?? 'contract validation failed';
    return `invalid ${VERIFY_CONTRACT_FILE}: ${detail}`;
  }
  if (projects.length === 0) return `no recognized project manifests or ${VERIFY_CONTRACT_FILE}`;
  const kinds = [...new Set(projects.map((project) => project.kind))].sort();
  return `detected ${kinds.join(', ')} project(s), but no verify command is configured`;
}

export function summarizeRepoExecutionProfile(profile: RepoExecutionProfile): {
  projectCount: number;
  verifyCommandCount: number;
  packageManagers: RepoPackageManager[];
} {
  return {
    projectCount: profile.projects.length,
    verifyCommandCount: profile.verifyCommands.length,
    packageManagers: [...new Set(profile.projects.map((project) => project.packageManager))],
  };
}

export function repoLabelForCommand(repoRoot: string, vc: VerifyCommand): string {
  if (!vc.cwd) return basename(repoRoot);
  const rel = relative(resolve(repoRoot), resolve(vc.cwd));
  return rel && !rel.startsWith('..') ? `${basename(repoRoot)}/${rel}` : basename(repoRoot);
}
