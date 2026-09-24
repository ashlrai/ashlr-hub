import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr resources profile prepare --provider codex|claude|grok
  --directory NEW_ABS --executable ABS [--json]
       ashlr resources profile repin --directory EXISTING_ABS --executable ABS
  [--dry-run] [--json]

prepare creates one new private profile under an existing owned mode-0700 parent.
Writes a standalone launcher, command.json, preparation manifest and empty native
state directories. Existing targets are never overwritten, repaired or reused.
On failure, a partially prepared directory may remain; inspect it rather than
deleting account state automatically. No parent directories are created.

repin points one existing prepared profile at a different native executable,
for example a newer CLI version that a model requires. It rewrites only the
executable locator in launcher.mjs and profile.json (command.json names node and
the launcher, never the native executable, so its bytes do not change), keeps
the provider, native state and sign-in untouched, and first copies the three
files to launcher.mjs.prev, profile.json.prev and command.json.prev. Every file
must still be prepare's unmodified output; a hand-edited profile is refused.
Rerunning the same repin after an interruption finishes it; repinning to the
current executable writes nothing. Sessions already running keep the binary
they started with; the next launch through the profile uses the new one.
--dry-run validates everything and reports the change without writing.

No executable is launched, credentials read/copied, account signed in, provider
contacted, pool enrolled or resident service installed. The returned login argv
is a separate interactive native action, not something this command executes.
Generated launchers preserve stdio/process ownership and use a minimal native
environment; they are operator-owned code, not a sandbox or billing attestation.
Node with process.execve support and a supported POSIX platform are required.
--executable must name a canonical regular executable file, not an install symlink.
Output includes private local paths, never authentication material.
Exit codes: 0 prepared, repinned or already pinned (authentication not checked),
1 preparation or repin unavailable, 2 invalid arguments. Grok preparation
supports separate native login/metadata; it does not enable a Grok
task-generation adapter.
`;
class UsageError extends Error {}
/** A repin failure whose message is fixed, path-free text saying whether the profile changed. */
class RepinFailure extends Error {}
const REPIN_UNAVAILABLE = 'Native profile repin unavailable; inspect the profile before retrying';

type ProfileCommand =
  | { help: true }
  | { help: false; subcommand: 'prepare'; json: boolean; provider: 'codex' | 'claude' | 'grok'; directory: string; executable: string }
  | { help: false; subcommand: 'repin'; json: boolean; dryRun: boolean; directory: string; executable: string };

function parse(args: string[]): ProfileCommand {
  if (args.length > 12 || args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
    [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    Buffer.byteLength(args.join('\0')) > 16 * 1024) throw new UsageError('Invalid profile arguments');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const subcommand = args[0];
  if (subcommand !== 'prepare' && subcommand !== 'repin') throw new UsageError('Expected prepare or repin subcommand');
  // repin reads the provider from the existing profile and never changes it.
  const valued = subcommand === 'prepare' ? ['--provider', '--directory', '--executable'] : ['--directory', '--executable'];
  const values = new Map<string, string>(); let json = false; let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json') { if (json) throw new UsageError('Duplicate profile option'); json = true; continue; }
    if (flag === '--dry-run' && subcommand === 'repin') { if (dryRun) throw new UsageError('Duplicate profile option'); dryRun = true; continue; }
    if (flag === '--provider' && subcommand === 'repin') throw new UsageError('repin keeps the profile provider; --provider is not accepted');
    if (!valued.includes(flag) || values.has(flag)) throw new UsageError('Unknown or duplicate profile option');
    const value = args[++i]; if (!value || value.startsWith('-')) throw new UsageError('Profile option requires a value');
    values.set(flag, value);
  }
  const path = (flag: string) => {
    const value = values.get(flag);
    if (!value || !isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value) {
      throw new UsageError(`${flag} requires a canonical absolute non-root path`);
    }
    return value;
  };
  if (subcommand === 'repin') return { help: false, subcommand, json, dryRun, directory: path('--directory'), executable: path('--executable') };
  const provider = values.get('--provider');
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') throw new UsageError('Expected codex, claude or grok provider');
  return { help: false, subcommand, json, provider, directory: path('--directory'), executable: path('--executable') };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function prepare(options: Extract<ProfileCommand, { subcommand: 'prepare' }>): Promise<void> {
  const { prepareResourceNativeProfile } = await import('../core/resources/native-profile.js');
  const report = prepareResourceNativeProfile({ provider: options.provider, directory: options.directory, executable: options.executable });
  console.log(options.json ? JSON.stringify(report, null, 2) : [
    `Native profile · ${report.provider} · prepared · authentication not checked`,
    `Directory: ${report.directory}`, `Command file: ${report.commandPath}`,
    `Separate interactive sign-in: ${report.loginCommand.map(quote).join(' ')}`,
    'No login was executed. Verify native account, billing route and quota before enrolling capacity.',
  ].join('\n'));
}

async function repin(options: Extract<ProfileCommand, { subcommand: 'repin' }>): Promise<void> {
  const { repinResourceNativeProfile, ResourceNativeProfileRepinError } = await import('../core/resources/native-profile.js');
  let report: ReturnType<typeof repinResourceNativeProfile>;
  try {
    report = repinResourceNativeProfile({ directory: options.directory, executable: options.executable, dryRun: options.dryRun });
  } catch (error) {
    throw new RepinFailure(error instanceof ResourceNativeProfileRepinError ? error.message : REPIN_UNAVAILABLE);
  }
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  const heading = report.status === 'repinned' ? (report.resumed ? 'repinned (finished an interrupted repin)' : 'repinned')
    : report.status === 'would-repin' ? (report.resumed ? 'dry run · would finish an interrupted repin' : 'dry run · would repin')
      : 'already pinned · nothing written';
  const lines = [`Native profile · ${report.provider} · ${heading} · authentication not checked`, `Directory: ${report.directory}`];
  if (report.status === 'unchanged') lines.push(`Executable: ${report.executable}`);
  else lines.push(`Executable: ${report.previousExecutable} -> ${report.executable}`);
  if (report.backups) {
    lines.push(`Previous files kept: ${[report.backups.launcherPath, report.backups.manifestPath, report.backups.commandPath].map(quote).join(' ')}`);
    lines.push('Sessions already running keep the binary they started with; the next launch through this profile uses the new one.');
  }
  if (report.status === 'would-repin') lines.push('Nothing was written.');
  lines.push(`Nothing was executed. Check the new binary with: ashlr resources launcher check --provider ${report.provider} --command ${quote(report.commandPath)} --cwd <private dir>`);
  console.log(lines.join('\n'));
}

export async function cmdResourceProfile(args: string[]): Promise<number> {
  let subcommand: 'prepare' | 'repin' | null = null;
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    subcommand = options.subcommand;
    if (options.subcommand === 'repin') await repin(options); else await prepare(options);
    return 0;
  } catch (error) {
    // Repin failures carry fixed, path-free text that says whether the profile
    // changed; anything else (and every prepare failure) stays generic.
    const message = error instanceof UsageError || error instanceof RepinFailure ? error.message
      : subcommand === 'repin' ? REPIN_UNAVAILABLE : 'Native profile preparation unavailable; inspect the selected target for partial files';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof UsageError ? 2 : 1;
  }
}
