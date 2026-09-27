/**
 * A fake `/usr/bin/security` for the Devin key store (3.15) — never the real
 * Keychain. Understands exactly the invocations src/core/devin/secret.ts makes
 * and records argv, so tests can prove the key never travels in argv.
 */
import type { SecurityRunner } from '../../src/core/devin/secret.js';

export interface FakeKeychain {
  run: SecurityRunner;
  items: Map<string, string>;
  calls: Array<{ args: string[]; stdin: string | null }>;
}

function argOf(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

export function fakeKeychain(): FakeKeychain {
  const k: FakeKeychain = { run: null as unknown as SecurityRunner, items: new Map(), calls: [] };
  k.run = async (args, stdin) => {
    k.calls.push({ args: [...args], stdin });
    if (args[0] === '-i') {
      const line = (stdin ?? '').trim().split(/\s+/);
      if (line[0] !== 'add-generic-password') return { code: 1, stdout: '', timedOut: false };
      const svc = argOf(line, '-s');
      const acct = argOf(line, '-a');
      const pw = argOf(line, '-w');
      if (!svc || !acct || !pw) return { code: 1, stdout: '', timedOut: false };
      k.items.set(`${svc}/${acct}`, pw);
      return { code: 0, stdout: '', timedOut: false };
    }
    const svc = argOf(args, '-s');
    const acct = argOf(args, '-a');
    const key = `${svc}/${acct}`;
    if (args[0] === 'find-generic-password') {
      if (!k.items.has(key)) return { code: 44, stdout: '', timedOut: false };
      return { code: 0, stdout: args.includes('-w') ? `${k.items.get(key)}\n` : 'keychain: "login"\nattributes: …\n', timedOut: false };
    }
    if (args[0] === 'delete-generic-password') {
      const had = k.items.delete(key);
      return { code: had ? 0 : 44, stdout: '', timedOut: false };
    }
    return { code: 1, stdout: '', timedOut: false };
  };
  return k;
}
