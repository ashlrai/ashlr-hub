/**
 * Read-only rollout planning for explicit merge verification contracts.
 *
 * Detector candidates are suggestions, never verified policy. This module
 * deliberately has no command execution or filesystem writes.
 */
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import type { RepoExecutionProfile, RepoProjectKind } from '../run/repo-profile.js';
import type { VerifyCommand } from '../run/verify-commands.js';

const MAX_PROJECTS_PER_REPO = 64;
const MAX_COMMANDS_PER_REPO = 64;

export interface VerificationRolloutCandidate {
  kind: VerifyCommand['kind'];
  cmd: string[];
  cwd: string;
  required: true;
  profiles: ['merge'];
}

export interface VerificationRolloutProject {
  root: string;
  kind: RepoProjectKind;
  candidates: VerificationRolloutCandidate[];
  blockers: Array<{ code: 'no-detected-command' | 'commands-truncated' }>;
}

export interface VerificationRolloutRepo {
  name: string;
  state: 'coverage-incomplete' | 'detector-blocked' | 'discovery-incomplete';
  sourceDigest: string;
  projects: VerificationRolloutProject[];
  truncated: boolean;
}

export interface VerificationRollout {
  version: 1;
  sourceState: 'complete' | 'degraded';
  totals: {
    reposReady: number;
    reposBlocked: number;
    uncoveredProjects: number;
    candidateCommands: number;
  };
  repos: VerificationRolloutRepo[];
}

function relativeCwd(repoRoot: string, cwd: string | undefined, projectRoot: string): string | null {
  const target = resolve(cwd ?? projectRoot);
  const value = relative(repoRoot, target);
  if (value === '..' || value.startsWith(`..${sep}`)) return null;
  return value.length === 0 ? '.' : value;
}

function candidate(
  repoRoot: string,
  project: { root: string; verifyCommands: VerifyCommand[] },
  command: VerifyCommand,
): VerificationRolloutCandidate | null {
  const cwd = relativeCwd(repoRoot, command.cwd, project.root);
  if (cwd === null) return null;
  return {
    kind: command.kind,
    cmd: [...command.cmd],
    cwd,
    required: true,
    profiles: ['merge'],
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Converts one already-scanned profile into metadata-only candidate coverage. */
export function buildVerificationRollout(profiles: ReadonlyArray<{ name: string; profile: RepoExecutionProfile }>): VerificationRollout {
  const repos: VerificationRolloutRepo[] = [];
  let uncoveredProjects = 0;
  let candidateCommands = 0;
  let reposReady = 0;
  let sourceState: VerificationRollout['sourceState'] = 'complete';

  for (const { name, profile } of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    const contract = profile.verifyContract;
    if (contract?.mergeGradeExplicit && contract.mergeCoverageComplete && !profile.projectDiscoveryTruncated) {
      reposReady++;
      continue;
    }
    const gaps = contract?.uncoveredMergeProjects ?? [];
    const projects: VerificationRolloutProject[] = [];
    let commandCount = 0;
    let truncated = false;
    for (const gap of gaps.slice(0, MAX_PROJECTS_PER_REPO)) {
      const project = profile.projects.find((entry) =>
        entry.relativeRoot === gap.relativeRoot && entry.kind === gap.kind,
      );
      const candidates = project
        ? project.verifyCommands.slice(0, Math.max(0, MAX_COMMANDS_PER_REPO - commandCount))
          .map((command) => candidate(profile.repoRoot, project, command))
          .filter((command): command is VerificationRolloutCandidate => command !== null)
        : [];
      commandCount += candidates.length;
      const commandsTruncated = Boolean(project && candidates.length < project.verifyCommands.length);
      truncated ||= commandsTruncated;
      projects.push({
        root: gap.relativeRoot,
        kind: gap.kind,
        candidates,
        blockers: [
          ...(candidates.length === 0 ? [{ code: 'no-detected-command' as const }] : []),
          ...(commandsTruncated ? [{ code: 'commands-truncated' as const }] : []),
        ],
      });
    }
    if (gaps.length > MAX_PROJECTS_PER_REPO) truncated = true;
    uncoveredProjects += gaps.length;
    candidateCommands += commandCount;
    const state: VerificationRolloutRepo['state'] = profile.projectDiscoveryTruncated
      ? 'discovery-incomplete'
      : projects.some((project) => project.blockers.some((blocker) => blocker.code === 'no-detected-command')) || truncated
        ? 'detector-blocked'
        : 'coverage-incomplete';
    if (profile.projectDiscoveryTruncated || truncated) sourceState = 'degraded';
    repos.push({
      name,
      state,
      sourceDigest: digest({
        input: profile.mergeVerifyContractSource,
        projects: projects.map(({ root, kind, candidates, blockers }) => ({ root, kind, candidates, blockers })),
      }),
      projects,
      truncated,
    });
  }

  return {
    version: 1,
    sourceState,
    totals: {
      reposReady,
      reposBlocked: repos.length,
      uncoveredProjects,
      candidateCommands,
    },
    repos,
  };
}
