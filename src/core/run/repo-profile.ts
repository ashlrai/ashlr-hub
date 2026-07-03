/**
 * Shared, read-only repo execution profile.
 *
 * This module is deliberately observational: it reads manifests and common
 * build files, but never spawns package managers, installs dependencies, or
 * writes state. Verification, self-heal, ecosystem doctor, and future fleet
 * routing can all ask one question here instead of re-learning package roots.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { VerifyCommand } from './verify-commands.js';

export type RepoPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'make' | 'just' | 'bats';
export type RepoProjectKind = 'node' | 'rust' | 'make' | 'just' | 'bats';

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
  } else if (scripts.build) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', runScriptArgv(pm, 'build')));
  } else if (hasTsconfig) {
    commands.push(commandWithCwd(repoRoot, root, 'typecheck', ['npx', 'tsc', '--noEmit']));
  }

  if (scripts.test) {
    commands.push(commandWithCwd(repoRoot, root, 'test', runScriptArgv(pm, 'test')));
  } else if (hasDep(pkg, 'vitest') || hasVitestConfig) {
    commands.push(commandWithCwd(repoRoot, root, 'test', ['npx', 'vitest', 'run']));
  }

  if (scripts.lint) {
    commands.push(commandWithCwd(repoRoot, root, 'lint', runScriptArgv(pm, 'lint')));
  }

  return {
    root,
    relativeRoot: relative(repoRoot, root) || '.',
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
    relativeRoot: relative(repoRoot, root) || '.',
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
      relativeRoot: relative(repoRoot, root) || '.',
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
      relativeRoot: relative(repoRoot, root) || '.',
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
    relativeRoot: relative(repoRoot, root) || '.',
    kind: useJust ? 'just' : 'make',
    packageManager: useJust ? 'just' : 'make',
    scripts,
    manifests: manifest ? [manifest] : [],
    verifyCommands: commands,
  };
}

function projectAt(repoRoot: string, root: string): RepoProjectProfile | null {
  return nodeProject(repoRoot, root) ?? rustProject(repoRoot, root) ?? shellProject(repoRoot, root);
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
    if (projectAt(repoRoot, dir)) roots.push(dir);
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
  const projects = projectRoots
    .map((projectRoot) => projectAt(root, projectRoot))
    .filter((project): project is RepoProjectProfile => project !== null)
    .sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot));

  const primaryProject = projects.find((project) => project.root === root) ?? projects[0] ?? null;
  const rootCommands = primaryProject?.root === root ? primaryProject.verifyCommands : [];
  const fallbackCommands = rootCommands.length > 0
    ? rootCommands
    : projects.flatMap((project) => project.verifyCommands);

  return {
    repoRoot: root,
    projects,
    primaryProject,
    verifyCommands: fallbackCommands,
  };
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
