import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface NativeBootIdentity {
  machineDigest: string;
  bootId: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function uuid(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID.test(normalized) && normalized !== '00000000-0000-0000-0000-000000000000' ? normalized : null;
}

/** Local OS identity only; never credentials, a provider probe, or a wall-clock heuristic. */
export function readNativeBootIdentity(): NativeBootIdentity | null {
  if (process.platform !== 'darwin') return null;
  const read = (file: string, args: string[]): string => execFileSync(file, args, {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
  });
  try {
    const bootId = uuid(read('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']));
    if (!bootId) return null;
    const platform = read('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const matches = [...platform.matchAll(/"IOPlatformUUID"\s*=\s*"([^"\r\n]+)"/g)];
    const machine = matches.length === 1 ? uuid(matches[0]![1]!) : null;
    if (!machine || uuid(read('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])) !== bootId) return null;
    // Keep hardware identifiers out of durable records and public projections.
    return { machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0${machine}`).digest('hex'), bootId };
  } catch {
    // Unsupported, denied, oversized or timed-out reads cannot authorize recovery.
    return null;
  }
}
