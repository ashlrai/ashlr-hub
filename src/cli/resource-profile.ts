import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr resources profile prepare --provider codex|claude
  --directory NEW_ABS --executable ABS [--json]

Creates one new private profile under an existing owned mode-0700 parent.
Writes a standalone launcher, command.json, preparation manifest and empty native
state directories. Existing targets are never overwritten, repaired or reused.
On failure, a partially prepared directory may remain; inspect it rather than
deleting account state automatically. No parent directories are created.

No executable is launched, credentials read/copied, account signed in, provider
contacted, pool enrolled or resident service installed. The returned login argv
is a separate interactive native action, not something this command executes.
Generated launchers preserve stdio/process ownership and use a minimal native
environment; they are operator-owned code, not a sandbox or billing attestation.
Node with process.execve support and a supported POSIX platform are required.
--executable must name a canonical regular executable file, not an install symlink.
Output includes private local paths, never authentication material.
Exit codes: 0 prepared (authentication not checked), 1 preparation unavailable,
2 invalid arguments. Grok profile execution is not supported by this command.
`;
class UsageError extends Error {}

function parse(args: string[]) {
  if (args.length > 12 || args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
    [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    Buffer.byteLength(args.join('\0')) > 16 * 1024) throw new UsageError('Invalid profile arguments');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true as const };
  if (args[0] !== 'prepare') throw new UsageError('Expected prepare subcommand');
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json') { if (json) throw new UsageError('Duplicate profile option'); json = true; continue; }
    if (!['--provider', '--directory', '--executable'].includes(flag) || values.has(flag)) throw new UsageError('Unknown or duplicate profile option');
    const value = args[++i]; if (!value || value.startsWith('-')) throw new UsageError('Profile option requires a value');
    values.set(flag, value);
  }
  const provider = values.get('--provider');
  if (provider !== 'codex' && provider !== 'claude') throw new UsageError('Expected codex or claude provider');
  const path = (flag: string) => {
    const value = values.get(flag);
    if (!value || !isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value) {
      throw new UsageError(`${flag} requires a canonical absolute non-root path`);
    }
    return value;
  };
  return { help: false as const, json, provider, directory: path('--directory'), executable: path('--executable') } as const;
}

export async function cmdResourceProfile(args: string[]): Promise<number> {
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    const { prepareResourceNativeProfile } = await import('../core/resources/native-profile.js');
    const report = prepareResourceNativeProfile({ provider: options.provider, directory: options.directory, executable: options.executable });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(options.json ? JSON.stringify(report, null, 2) : [
      `Native profile · ${report.provider} · prepared · authentication not checked`,
      `Directory: ${report.directory}`, `Command file: ${report.commandPath}`,
      `Separate interactive sign-in: ${report.loginCommand.map(quote).join(' ')}`,
      'No login was executed. Verify native account, billing route and quota before enrolling capacity.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Native profile preparation unavailable; inspect the selected target for partial files';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof UsageError ? 2 : 1;
  }
}
