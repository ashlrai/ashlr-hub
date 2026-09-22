/**
 * Guards `cutoffCaptureCliInvocation` against the single-file-binary path trap.
 *
 * Inside a Bun-compiled binary `process.argv[1]` is a VIRTUAL path
 * (`/$bunfs/root/<entry>`) that is neither on disk nor equal to
 * `process.execPath`. The original "am I compiled?" test compared those two, so
 * it answered false in exactly the case it existed to detect, and the child was
 * spawned as `<binary> /$bunfs/root/_entry.js --_cutoff-checkpoint-supervisor …`
 * — which the CLI parses as an unknown command and rejects with exit 2. Cutoff
 * checkpoint capture was therefore dead in the shipping app while working from
 * source.
 *
 * Same defect class as the account-probe helper spawn, so this file pins the
 * argv SHAPE rather than the implementation: whatever signal is used, a
 * compiled process must never be handed a virtual path as its command word.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cutoffCaptureCliInvocation } from '../src/core/daemon/cutoff-checkpoint-scheduler.js';

const REAL_ARGV = process.argv;
const REAL_EXEC = process.execPath;

/** Replace argv/execPath the way a runtime would, then restore. */
function asRuntime(argv1: string | undefined, execPath: string): void {
  process.argv = argv1 === undefined ? [REAL_ARGV[0] ?? 'node'] : [REAL_ARGV[0] ?? 'node', argv1];
  Object.defineProperty(process, 'execPath', { value: execPath, configurable: true, writable: true });
}

afterEach(() => {
  process.argv = REAL_ARGV;
  Object.defineProperty(process, 'execPath', { value: REAL_EXEC, configurable: true, writable: true });
});

describe('cutoffCaptureCliInvocation — compiled-binary detection', () => {
  const FLAG = '--_cutoff-checkpoint-supervisor';
  const ARGS = ['attempt-123', '2026-09-21T04:00:00.000Z'];

  it('never passes a virtual bundle path as the command word', () => {
    // The exact shape bun 1.3.14 produces for a compiled binary.
    asRuntime('/$bunfs/root/_entry.js', '/Applications/Ashlr.app/Contents/MacOS/ashlr');
    const { command, args } = cutoffCaptureCliInvocation(FLAG, ARGS);

    expect(command).toBe('/Applications/Ashlr.app/Contents/MacOS/ashlr');
    // The regression: args[0] used to be '/$bunfs/root/_entry.js'.
    expect(args[0]).toBe(FLAG);
    expect(args).toEqual([FLAG, ...ARGS]);
    expect(args.some((a) => a.includes('$bunfs'))).toBe(false);
  });

  it('handles the Windows virtual root too', () => {
    asRuntime('B:\\~BUN\\root\\_entry.js', 'C:\\Program Files\\Ashlr\\ashlr.exe');
    const { args } = cutoffCaptureCliInvocation(FLAG, ARGS);
    expect(args[0]).toBe(FLAG);
    expect(args.some((a) => a.includes('~BUN'))).toBe(false);
  });

  it('still re-invokes the entry script when running from a normal dist', () => {
    // Node running `node /repo/dist/cli/index.js` must keep passing the entry,
    // otherwise the binary-shaped argv would be sent to a plain node.
    asRuntime('/repo/dist/cli/index.js', '/usr/local/bin/node');
    const { command, args } = cutoffCaptureCliInvocation(FLAG, ARGS);
    expect(command).toBe('/usr/local/bin/node');
    expect(args).toContain('/repo/dist/cli/index.js');
    expect(args.indexOf('/repo/dist/cli/index.js')).toBeLessThan(args.indexOf(FLAG));
    expect(args.slice(args.indexOf(FLAG))).toEqual([FLAG, ...ARGS]);
  });

  it('treats a Node SEA (argv[1] === execPath) as compiled', () => {
    asRuntime('/opt/ashlr/ashlr', '/opt/ashlr/ashlr');
    expect(cutoffCaptureCliInvocation(FLAG, ARGS).args).toEqual([FLAG, ...ARGS]);
  });

  it('treats a missing argv[1] as compiled', () => {
    asRuntime(undefined, '/opt/ashlr/ashlr');
    expect(cutoffCaptureCliInvocation(FLAG, ARGS).args).toEqual([FLAG, ...ARGS]);
  });
});
