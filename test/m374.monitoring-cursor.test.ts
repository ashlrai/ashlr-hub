import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMonitoringCursor,
  canonicalEnrollmentDigest,
  loadMonitoringCursor,
  monitoringCursorPath,
  outcomeCandidateKey,
  readMonitoringCursor,
  saveMonitoringCursor,
  sanitizeMonitoringCursor,
  selectSuccessor,
  selectOutcomeCandidateSuccessors,
  selectRegressionRepoSuccessors,
  writeMonitoringCursor,
  type MonitoringOutcomeCandidateCursor,
} from '../src/core/fleet/monitoring-cursor.js';

let home: string;
let previousAshlrHome: string | undefined;
let repos: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-monitoring-cursor-'));
  previousAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  repos = [join(home, 'repo-b'), join(home, 'repo-a')];
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

const candidate = (proposalId: string, oidChar: string): MonitoringOutcomeCandidateCursor => ({
  proposalId,
  mergeCommitOid: oidChar.repeat(40),
});

describe('M374 durable fleet monitoring cursor', () => {
  it('persists rotation progress across a restart-shaped read/write cycle', () => {
    const candidates = [candidate('proposal-c', 'c'), candidate('proposal-a', 'a'), candidate('proposal-b', 'b')];
    const first = selectOutcomeCandidateSuccessors(candidates, null, 1).selected[0]!;
    const checkpoint = buildMonitoringCursor(repos, {
      outcome: { candidateAfter: first, sweepComplete: false, hadIncomplete: false, candidateSetDigest: null },
      regressionRepoAfter: repos[1]!,
    })!;

    expect(writeMonitoringCursor(checkpoint, { enrolledRepos: repos })).toBe(true);
    const restarted = loadMonitoringCursor([...repos].reverse());
    expect(restarted).toEqual({
      cursor: checkpoint, storedCursor: checkpoint, sourceState: 'healthy', enrollmentMatches: true,
    });
    expect(selectOutcomeCandidateSuccessors(candidates, restarted.cursor!.outcome.candidateAfter, 1).selected[0])
      .toEqual(candidate('proposal-b', 'b'));
    expect(selectSuccessor(candidates, outcomeCandidateKey(first), outcomeCandidateKey)).toEqual({
      value: candidate('proposal-b', 'b'),
      wrapped: false,
    });
    expect(lstatSync(dirname(monitoringCursorPath())).mode & 0o777).toBe(0o700);
    expect(lstatSync(monitoringCursorPath()).mode & 0o777).toBe(0o600);
  });

  it('binds state to canonical enrollment and treats drift as healthy but inapplicable', () => {
    expect(canonicalEnrollmentDigest(repos)).toBe(canonicalEnrollmentDigest([repos[1]!, repos[0]!, repos[0]!]));
    const checkpoint = buildMonitoringCursor(repos)!;
    expect(writeMonitoringCursor(checkpoint, { enrolledRepos: repos })).toBe(true);

    expect(readMonitoringCursor([...repos, join(home, 'repo-c')])).toEqual({
      cursor: null,
      storedCursor: checkpoint,
      sourceState: 'healthy',
      enrollmentMatches: false,
    });
    const changedRepos = [...repos, join(home, 'repo-c')];
    const replacement = buildMonitoringCursor(changedRepos)!;
    expect(saveMonitoringCursor(replacement, {
      enrolledRepos: changedRepos,
      expectedCursor: checkpoint,
    })).toBe(true);
    expect(loadMonitoringCursor(changedRepos).cursor).toEqual(replacement);
    expect(writeMonitoringCursor(checkpoint, { enrolledRepos: [repos[0]!] })).toBe(false);
  });

  it('rejects malformed, extra-field, and future persisted state', () => {
    const valid = buildMonitoringCursor(repos)!;
    expect(sanitizeMonitoringCursor({ ...valid, schemaVersion: 2 })).toBeNull();
    expect(sanitizeMonitoringCursor({ ...valid, timestamp: new Date().toISOString() })).toBeNull();
    expect(sanitizeMonitoringCursor({ ...valid, outcome: { candidateAfter: { proposalId: 'p', mergeCommitOid: 'bad' }, sweepComplete: false } }))
      .toBeNull();

    mkdirSync(dirname(monitoringCursorPath()), { recursive: true, mode: 0o700 });
    writeFileSync(monitoringCursorPath(), JSON.stringify({ ...valid, schemaVersion: 9 }), { mode: 0o600 });
    expect(readMonitoringCursor(repos)).toEqual({
      cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false,
    });
    expect(writeMonitoringCursor(valid)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('fails closed for symlink and hardlink state targets', () => {
    const valid = buildMonitoringCursor(repos)!;
    const path = monitoringCursorPath();
    const target = join(home, 'outside.json');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify(valid)}\n`, { mode: 0o600 });

    symlinkSync(target, path);
    expect(readMonitoringCursor(repos).sourceState).toBe('degraded');
    expect(writeMonitoringCursor(valid)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify(valid)}\n`);

    rmSync(path);
    linkSync(target, path);
    expect(lstatSync(path).nlink).toBe(2);
    expect(readMonitoringCursor(repos).sourceState).toBe('degraded');
    expect(writeMonitoringCursor(valid)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects non-private roots and symlinked storage ancestors', () => {
    mkdirSync(process.env.ASHLR_HOME!, { mode: 0o755 });
    chmodSync(process.env.ASHLR_HOME!, 0o755);
    expect(writeMonitoringCursor(buildMonitoringCursor(repos)!)).toBe(false);
    expect(readMonitoringCursor(repos).sourceState).toBe('degraded');

    rmSync(process.env.ASHLR_HOME!, { recursive: true });
    const outside = join(home, 'outside-home');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, process.env.ASHLR_HOME!, 'dir');
    expect(writeMonitoringCursor(buildMonitoringCursor(repos)!)).toBe(false);
    expect(readMonitoringCursor(repos).sourceState).toBe('degraded');
  });

  it('selects stable composite successors, wraps fairly, and reports complete persistence', () => {
    const candidates = [candidate('same', 'b'), candidate('same', 'a'), candidate('z', 'f')];
    expect(outcomeCandidateKey(candidates[0]!)).not.toBe(outcomeCandidateKey(candidates[1]!));
    expect(selectOutcomeCandidateSuccessors(candidates, candidate('same', 'a'), 2)).toEqual({
      selected: [candidate('same', 'b'), candidate('z', 'f')],
      wrapped: false,
    });
    expect(selectOutcomeCandidateSuccessors(candidates, candidate('z', 'f'), 2)).toEqual({
      selected: [candidate('same', 'a'), candidate('same', 'b')],
      wrapped: true,
    });

    const canonicalRepos = [...repos].sort();
    expect(selectRegressionRepoSuccessors(repos, canonicalRepos[1]!, 1)).toEqual({
      selected: [canonicalRepos[0]],
      wrapped: true,
    });
    const completed = buildMonitoringCursor(repos, {
      outcome: { candidateAfter: candidates[2]!, sweepComplete: true, hadIncomplete: false, candidateSetDigest: null },
      regressionRepoAfter: canonicalRepos[1]!,
    })!;
    expect(saveMonitoringCursor(completed)).toBe(true);
    expect(readMonitoringCursor(repos).cursor).toEqual(completed);
    expect(existsSync(`${monitoringCursorPath()}.tmp`)).toBe(false);
    expect(readdirSync(dirname(monitoringCursorPath())).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports missing distinctly and falls back from a relative ASHLR_HOME', () => {
    expect(readMonitoringCursor(repos)).toEqual({
      cursor: null, storedCursor: null, sourceState: 'missing', enrollmentMatches: true,
    });
    process.env.ASHLR_HOME = 'relative-home';
    expect(monitoringCursorPath()).toBe(join(process.env.HOME ?? home, '.ashlr', 'fleet', 'monitoring-cursor.json'));
  });

  it('refuses a stale compare-and-swap writer', () => {
    const original = buildMonitoringCursor(repos)!;
    expect(saveMonitoringCursor(original, { enrolledRepos: repos, expectedCursor: null })).toBe(true);
    const advanced = { ...original, regressionRepoAfter: [...repos].sort()[0]! };
    expect(saveMonitoringCursor(advanced, { enrolledRepos: repos, expectedCursor: original })).toBe(true);

    const stale = {
      ...original,
      outcome: { candidateAfter: candidate('stale', 'a'), sweepComplete: false, hadIncomplete: false, candidateSetDigest: null },
    };
    expect(saveMonitoringCursor(stale, { enrolledRepos: repos, expectedCursor: original })).toBe(false);
    expect(loadMonitoringCursor(repos).cursor).toEqual(advanced);
  });
});
