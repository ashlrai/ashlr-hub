/** Real Node transport controls, not a claim about Git or candidate correctness. */
import { execFileSync, spawnSync, type SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const limit = 8 * 1024 * 1024;
const supported = Number(process.versions.node.split('.')[0]) >= 24;
// Use the exact running Node binary, without inherited NODE_OPTIONS/preloads.
// Like the original Git helper: ignored stdin, captured Buffer streams, and a
// combined maxBuffer. The fixed scripts have no descendant-launch or wait paths;
// synchronous return waits for the direct child, including overflow termination.
function options(): SpawnSyncOptionsWithBufferEncoding {
  return { timeout: 5000, maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } };
}
function script(stdoutBytes: number, stderr: string, status = 0): string {
  return `const{writeSync}=require('node:fs');const bytes=Buffer.alloc(${stdoutBytes},97);` +
    'for(let offset=0;offset<bytes.length;)offset+=writeSync(1,bytes,offset,bytes.length-offset);' +
    `writeSync(2,${JSON.stringify(stderr)});process.exitCode=${status};`;
}

describe.runIf(supported)('pinned running Node combined-output boundaries', () => {
  it.each([
    { bytes: limit, warning: '' },
    { bytes: limit - 1, warning: 'w' },
  ])('accepts exactly 8 MiB combined output: %j', ({ bytes, warning }) => {
    const output = execFileSync(process.execPath, ['-e', script(bytes, warning)], options());
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.length).toBe(bytes);
    expect(output[0]).toBe(97); expect(output.at(-1)).toBe(97);
  });

  it('execFileSync rejects an 8 MiB stdout payload plus one stderr byte', () => {
    let failure: unknown;
    try { execFileSync(process.execPath, ['-e', script(limit, 'w')], options()); }
    catch (error) { failure = error; }
    expect(failure instanceof Error).toBe(true);
    const error = failure as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
    expect(error.code).toBe('ENOBUFS');
    expect(Buffer.isBuffer(error.stdout)).toBe(true); expect(Buffer.isBuffer(error.stderr)).toBe(true);
    expect(error.stdout!.length).toBeLessThanOrEqual(limit);
    expect(error.stderr!.length).toBeLessThanOrEqual(1);
    expect(error.stdout!.length + error.stderr!.length).toBe(limit + 1);
  });

  it.each([0, 7])('spawnSync exposes ordinary warning/exit status %i without a transport error', status => {
    const result = spawnSync(process.execPath, ['-e', script(8, 'warning', status)], options());
    expect(result.pid).toBeGreaterThan(0);
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(status);
    expect(Buffer.isBuffer(result.stdout)).toBe(true); expect(Buffer.isBuffer(result.stderr)).toBe(true);
    expect(result.stdout.length).toBe(8); expect(result.stderr.toString('utf8')).toBe('warning');
  });

  it('spawnSync reports combined-output overflow as an error, not an ordinary nonzero result', () => {
    const result = spawnSync(process.execPath, ['-e', script(limit, 'w')], options());
    expect(result.pid).toBeGreaterThan(0);
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    expect(Buffer.isBuffer(result.stdout)).toBe(true); expect(Buffer.isBuffer(result.stderr)).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(limit);
    expect(result.stderr.length).toBeLessThanOrEqual(1);
    expect(result.stdout.length + result.stderr.length).toBe(limit + 1);
    // The child can exit normally before Node observes the overflowing pipe.
    // An error still makes this unusable regardless of status/signal ordering.
    expect(result.status === null || Number.isInteger(result.status)).toBe(true);
  });
});
