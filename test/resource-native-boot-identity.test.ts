import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNativeBootIdentity } from '../src/core/resources/native-boot-identity.js';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const boot = '11111111-2222-3333-4444-555555555555';
const machine = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
beforeEach(() => { exec.mockReset(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); });
function readings(first = boot, hardware = `"IOPlatformUUID" = "${machine}"`, last = boot) {
  exec.mockReturnValueOnce(first).mockReturnValueOnce(hardware).mockReturnValueOnce(last);
}

describe('bounded local native boot identity', () => {
  it('normalizes stable OS UUIDs, hashes the machine identity, and uses fixed bounded nonsecret execution', () => {
    readings(` ${boot.toUpperCase()}\n`, `"IOPlatformUUID" = "${machine.toUpperCase()}"`, `${boot}\n`);
    expect(readNativeBootIdentity()).toEqual({ bootId: boot,
      machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0${machine}`).digest('hex') });
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
      ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']],
      ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
    ]);
    for (const [, , options] of exec.mock.calls) expect(options).toEqual({ encoding: 'utf8', timeout: 1000,
      maxBuffer: 64 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } });
  });

  it.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', `${boot}\n${boot}`])(
    'rejects invalid boot output before reading hardware %#', (value) => {
      readings(value); expect(readNativeBootIdentity()).toBeNull(); expect(exec).toHaveBeenCalledTimes(1);
    });

  it.each(['', '"IOPlatformUUID" = "not-a-uuid"', '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"',
    `"IOPlatformUUID" = "${machine}"\n"IOPlatformUUID" = "${machine}"`, `"IOPlatformUUID" = "${machine}\nextra"`])(
    'rejects missing malformed or duplicate hardware UUIDs %#', (value) => {
      readings(boot, value); expect(readNativeBootIdentity()).toBeNull();
    });

  it('rejects a boot change during the identity read', () => {
    readings(boot, `"IOPlatformUUID" = "${machine}"`, '66666666-2222-3333-4444-555555555555');
    expect(readNativeBootIdentity()).toBeNull();
  });

  it.each([0, 1, 2])('fails closed on denied oversized or timed-out OS reads at stage %s', (stage) => {
    for (let i = 0; i < stage; i++) exec.mockReturnValueOnce(i === 0 ? boot : `"IOPlatformUUID" = "${machine}"`);
    exec.mockImplementationOnce(() => { throw new Error('private OS diagnostics'); });
    expect(readNativeBootIdentity()).toBeNull();
  });

  it.each(['linux', 'win32', 'freebsd'])('does not launch commands on unsupported platform %s', (value) => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    expect(readNativeBootIdentity()).toBeNull(); expect(exec).not.toHaveBeenCalled();
  });
});
