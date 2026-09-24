/**
 * Review finding d0 (3.10): sandbox-violation evidence must not come solely
 * from agent-controlled output. The kernel's own log of each TAGGED protected
 * denial is now the source of truth (kernel-evidence.ts); output parsing is a
 * secondary signal; and a run whose kernel evidence is unavailable or
 * incomplete reports its violations as UNKNOWN (violationsKnown=false), never
 * as "zero". The darwin block runs the real `log stream` + sandbox-exec (no
 * model, no seat, HOME is the per-worker temp home).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isViolationTag,
  newViolationTag,
  parseKernelDenials,
  startSandboxDenialWatch,
  type KernelEvidenceDeps,
} from '../src/core/sandbox/kernel-evidence.js';
import {
  AUTONOMOUS_DENIED_EXECUTABLES,
  autonomousConfinementProfile,
  buildAutonomousSbplProfile,
  sandboxViolationsFromKernel,
} from '../src/core/sandbox/confine.js';
import { buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import {
  finishAutonomousSpawn,
  prepareAutonomousSpawn,
  setKernelEvidenceWatcherForTest,
  type AutonomousSpawn,
} from '../src/core/sandbox/autonomous-run.js';

afterEach(() => setKernelEvidenceWatcherForTest());

const DARWIN = process.platform === 'darwin';

function event(message: string): string {
  return JSON.stringify({ eventMessage: message, processImagePath: '/kernel', senderImagePath: '/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox' });
}

describe('parseKernelDenials (d0)', () => {
  const tag = newViolationTag();
  it('extracts tagged denials (engine or child), the barrier, and dropped-message warnings', () => {
    const capture = [
      `Filtering the log data using "sender == "Sandbox" AND composedMessage CONTAINS "${tag}""`,
      event(`Sandbox: cat(90303) deny(1) file-read-data /Users/m/.ashlr/authority/grant.json\n${tag}`),
      event(`2 duplicate reports for Sandbox: bash(90304) deny(1) process-exec* /usr/bin/security\n${tag}`),
      event(`Sandbox: cat(1) deny(1) file-read-data /other\nashlr-sbx-${'0'.repeat(32)}`), // another run's tag
      event(`Sandbox: cat(2) deny(1) file-read-data /tmp/x/barrier\n${tag}-end`),
    ].join('\n');
    const parsed = parseKernelDenials(capture, tag);
    expect(parsed.barrier).toBe(true);
    expect(parsed.dropped).toBe(false);
    expect(parsed.denials).toEqual([
      { process: 'cat', pid: 90303, operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' },
      { process: 'bash', pid: 90304, operation: 'process-exec*', target: '/usr/bin/security' },
    ]);
    expect(parseKernelDenials(`${capture}\n=== Messages dropped during live streaming (use \`log show\` to see what they were)`, tag).dropped).toBe(true);
  });

  it('tags are unguessable hex (safe in SBPL and log predicates)', () => {
    const a = newViolationTag();
    expect(isViolationTag(a)).toBe(true);
    expect(a).not.toBe(newViolationTag());
    expect(isViolationTag('ashlr-sbx-"; (allow default)')).toBe(false);
  });
});

describe('startSandboxDenialWatch with injected process pieces (d0)', () => {
  function deps(opts: { ready?: boolean; lines?: (tag: string) => string[]; barrier?: boolean; platform?: NodeJS.Platform }): KernelEvidenceDeps & { killed: number } {
    let now = 0;
    let fd = -1;
    const d = {
      killed: 0,
      platform: opts.platform ?? 'darwin',
      startStream: (_predicate: string, outFd: number) => {
        fd = outFd;
        if (opts.ready !== false) writeFileSync(fd, 'Filtering the log data using "…"\n');
        return { kill: () => { d.killed++; return true; } };
      },
      barrier: (_marker: string, message: string) => {
        void fd;
        const tag = message.replace(/-end$/, '');
        const out = [...(opts.lines?.(tag) ?? []), ...(opts.barrier === false ? [] : [event(`Sandbox: cat(9) deny(1) file-read-data /b\n${message}`)])];
        captured.push(out.join('\n'));
      },
      sleepSync: (ms: number) => { now += ms; },
      nowMs: () => now,
    };
    const captured: string[] = [];
    // The stream writes to the capture file; emulate by appending on barrier.
    const realBarrier = d.barrier;
    d.barrier = (marker, message) => {
      realBarrier(marker, message);
      const file = join(marker, '..', 'stream.ndjson');
      writeFileSync(file, `Filtering the log data using "…"\n${captured.join('\n')}\n`, { flag: 'w' });
    };
    return d;
  }

  it('complete: tagged denials returned after the barrier; the stream is stopped', () => {
    const d = deps({ lines: (tag) => [event(`Sandbox: sh(5) deny(1) process-exec* /usr/bin/security\n${tag}`)] });
    const watch = startSandboxDenialWatch(newViolationTag(), { deps: d });
    const evidence = watch.finish();
    expect(evidence.state).toBe('complete');
    expect(evidence.denials.map((x) => x.target)).toEqual(['/usr/bin/security']);
    expect(d.killed).toBe(1);
    expect(watch.finish()).toBe(evidence); // idempotent
  });

  it('a stream that never becomes ready ⇒ unavailable (violations unknown, never "zero")', () => {
    const d = deps({ ready: false });
    const evidence = startSandboxDenialWatch(newViolationTag(), { deps: d }).finish();
    expect(evidence.state).toBe('unavailable');
    expect(evidence.denials).toEqual([]);
  });

  it('no barrier ⇒ incomplete; not macOS ⇒ unavailable; an invalid tag ⇒ unavailable', () => {
    expect(startSandboxDenialWatch(newViolationTag(), { deps: deps({ barrier: false }) }).finish().state).toBe('incomplete');
    expect(startSandboxDenialWatch(newViolationTag(), { deps: deps({ platform: 'linux' }) }).finish().state).toBe('unavailable');
    expect(startSandboxDenialWatch('not-a-tag', { deps: deps({}) }).finish().state).toBe('unavailable');
  });
});

describe('the SBPL profile tags exactly the violation rules (d0)', () => {
  function world() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd0-profile-')));
    const home = join(root, 'home');
    const worktree = join(home, '.ashlr', 'sandboxes', 'sb1');
    const run = join(root, 'run');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(run, { mode: 0o700 });
    const overlay = buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
    return { home, worktree, overlay };
  }

  it('tripwires, the custody helper and escape-tool execs carry the tag; quiet denials do not', () => {
    const w = world();
    const tag = newViolationTag();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree: w.worktree, home: w.home, overlay: w.overlay, violationTag: tag });
    const tagged = p.split('\n').filter((l) => l.includes(tag));
    expect(tagged.some((l) => l.includes('(with send-signal SIGKILL)') && l.includes('.ashlr/authority'))).toBe(true);
    expect(tagged.some((l) => l.includes('ashlr-custody') && l.startsWith('(deny file-read-data'))).toBe(true);
    const taggedExec = tagged.find((l) => l.startsWith('(deny process-exec'))!;
    expect(taggedExec).toContain('/usr/bin/security');
    expect(taggedExec).not.toContain('/usr/bin/pbcopy');
    // Every denied executable is still denied (split, not dropped).
    for (const exe of AUTONOMOUS_DENIED_EXECUTABLES) expect(p).toContain(`"${exe}"`);
    expect(tagged.every((l) => !l.startsWith('(deny mach-lookup') && !l.startsWith('(deny file-read* (subpath'))).toBe(true);
  });

  it('an invalid or absent tag leaves the rules untagged', () => {
    const w = world();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree: w.worktree, home: w.home, overlay: w.overlay, violationTag: 'x") (allow default' });
    expect(p).not.toContain('with message');
  });

  it('kernel denials map onto the same operation strings as the output scan', () => {
    const home = '/Users/m';
    expect(sandboxViolationsFromKernel([
      { process: 'cat', operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' },
      { process: 'cat', operation: 'file-read-data', target: '/Users/m/.ashlr/authority/ledger.jsonl' },
      { process: 'bash', operation: 'process-exec*', target: '/usr/bin/security' },
      { process: 'node', operation: 'file-write-create', target: '/Users/m/Library/Keychains/login.keychain-db' },
    ], home)).toEqual(['access ~/.ashlr/authority', 'access ~/Library/Keychains', 'exec /usr/bin/security']);
  });
});

describe('finishAutonomousSpawn: kernel evidence first, output second (d0)', () => {
  function fakeSpawn(evidence: AutonomousSpawn['evidence']): AutonomousSpawn {
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'd0-run-')));
    return {
      bin: '/bin/sh', env: {}, launcher: { bin: '/usr/bin/sandbox-exec', prefixArgs: [] },
      overlay: { vendorCommits: [] } as unknown as AutonomousSpawn['overlay'],
      profile: { mode: 'os' }, runDir, home: '/Users/m', evidence,
    };
  }

  it('SILENT agent: output shows nothing, the kernel recorded the denial ⇒ it is a violation', () => {
    const tag = newViolationTag();
    const spawn = fakeSpawn({
      tag,
      finish: () => ({ source: 'kernel-log', state: 'complete', reason: null, denials: [{ process: 'cat', pid: 7, operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' }] }),
      abort: () => undefined,
    });
    const finished = finishAutonomousSpawn(spawn, { output: '' });
    expect(finished.violations).toEqual(['access ~/.ashlr/authority']);
    expect(finished.violationsKnown).toBe(true);
  });

  it('no kernel evidence ⇒ violations UNKNOWN even when the output is clean', () => {
    const finished = finishAutonomousSpawn(fakeSpawn(null), { output: 'all good' });
    expect(finished.violations).toEqual([]);
    expect(finished.violationsKnown).toBe(false);
    expect(finished.kernelEvidence.state).toBe('unavailable');
  });

  it('output parsing stays a secondary signal (it can add, never remove)', () => {
    const spawn = fakeSpawn({ tag: newViolationTag(), finish: () => ({ source: 'kernel-log', state: 'complete', reason: null, denials: [] }), abort: () => undefined });
    const finished = finishAutonomousSpawn(spawn, { output: '/usr/bin/security: Operation not permitted' });
    expect(finished.violations).toEqual(['exec /usr/bin/security']);
  });
});

function kernelLogUsable(): boolean {
  if (!DARWIN) return false;
  const r = spawnSync('/usr/bin/log', ['stream', '--timeout', '1', '--predicate', 'sender == "ashlr-none"'], { encoding: 'utf8', timeout: 5_000 });
  return /Filtering the log data/.test(`${r.stdout}${r.stderr}`);
}

describe.runIf(kernelLogUsable())('REAL kernel evidence under sandbox-exec (d0, darwin)', () => {
  it('an agent that hides every denial (2>/dev/null, || true, child-only tripwire) is still caught', () => {
    setKernelEvidenceWatcherForTest((tag, parent) => startSandboxDenialWatch(tag, { parent }));
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'd0-silent');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.ashlr', 'authority', 'grant.json'), '{}\n');
    const prep = prepareAutonomousSpawn({ engine: 'local', worktree, baseEnv: { PATH: '/usr/bin:/bin' }, bin: '/bin/sh' });
    expect(prep.evidence).not.toBeNull();
    const script = `{ /bin/cat "${home}/.ashlr/authority/grant.json"; /usr/bin/security find-generic-password -s ai.ashlr.custody; } >/dev/null 2>&1 || true; exit 0`;
    const r = spawnSync(prep.launcher.bin, [...prep.launcher.prefixArgs, '/bin/sh', '-c', script], { cwd: worktree, env: prep.env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toBe(''); // nothing for the output scan to find
    const finished = finishAutonomousSpawn(prep, { output: `${r.stdout}${r.stderr}` });
    expect(finished.kernelEvidence.state).toBe('complete');
    expect(finished.violationsKnown).toBe(true);
    expect(finished.violations).toEqual(['access ~/.ashlr/authority', 'exec /usr/bin/security']);
  });

  it('a clean run is complete with zero violations (known zero, not unknown)', () => {
    setKernelEvidenceWatcherForTest((tag, parent) => startSandboxDenialWatch(tag, { parent }));
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'd0-clean');
    mkdirSync(worktree, { recursive: true });
    const prep = prepareAutonomousSpawn({ engine: 'local', worktree, baseEnv: { PATH: '/usr/bin:/bin' }, bin: '/bin/sh' });
    const r = spawnSync(prep.launcher.bin, [...prep.launcher.prefixArgs, '/bin/sh', '-c', 'echo ok > out.txt'], { cwd: worktree, env: prep.env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    const finished = finishAutonomousSpawn(prep, { output: r.stdout });
    expect(finished.kernelEvidence.state).toBe('complete');
    expect(finished.violations).toEqual([]);
    expect(finished.violationsKnown).toBe(true);
  });
});
