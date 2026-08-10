import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CandidateRepoAdmissionDeps } from '../../src/core/portfolio/candidate-admission.js';
import type { TrustedExecutablePin } from '../../src/core/util/trusted-executable.js';

export interface CandidateAdmissionTestOnlyGitFixture {
  pin: TrustedExecutablePin;
  dependencies: Pick<CandidateRepoAdmissionDeps, 'resolveGitCli' | 'verifyGitCli'>;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findTestHostGit(): string {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const rawRoot of (process.env['PATH'] ?? '').split(delimiter)) {
    const root = rawRoot.trim().replace(/^"|"$/g, '');
    if (!root) continue;
    for (const name of names) {
      try {
        const candidate = realpathSync(join(root, name));
        accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        if (isAbsolute(candidate)) return candidate;
      } catch {
        // Continue through the test host's initial PATH snapshot.
      }
    }
  }
  throw new Error('M489 test host has no executable Git fixture');
}

/**
 * Test-only dependency fixture. This file is outside src/ and excluded from the
 * published package, so its PATH bootstrap and synthetic pin cannot exist in a
 * production runtime or satisfy production custody verification.
 */
export function createCandidateAdmissionTestOnlyGitFixture(): CandidateAdmissionTestOnlyGitFixture {
  const executable = findTestHostGit();
  const pin = Object.freeze({
    canonicalPath: executable,
    executable,
    digest: '0'.repeat(64),
  });
  const outsideUntrustedRoots = (untrustedRoots: readonly string[]): boolean => untrustedRoots.every((root) => {
    let canonicalRoot: string;
    try { canonicalRoot = realpathSync(resolve(root)); } catch { canonicalRoot = resolve(root); }
    return !contained(canonicalRoot, executable);
  });
  return {
    pin,
    dependencies: {
      resolveGitCli: (untrustedRoots = []) => outsideUntrustedRoots(untrustedRoots) ? pin : null,
      verifyGitCli: (candidate, untrustedRoots = []) => candidate === pin && outsideUntrustedRoots(untrustedRoots),
    },
  };
}
