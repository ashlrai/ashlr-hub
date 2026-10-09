import { isAbsolute, join } from 'node:path';
import { inventoryCompanions, type CompanionId, type CompanionInventoryOptions } from '../core/companion-inventory.js';
import { planCompanionProvisioning } from '../core/companion-provisioning.js';
import { installCompanionArtifact } from '../core/companion-installation.js';

const HELP = `Usage: phm companions [--json] [--root <absolute-install-root>] [--bin-dir <absolute-dir>]\n  [--secrets-bin <absolute-file>] [--locus-bin <absolute-file>] [--lexicon-bin <absolute-file>]

Read-only inventory of separately installed Secrets, Locus and Lexicon.
Only --version and --help are run in disposable state with a scrubbed environment.
--root searches only <root>/bin; repeated --bin-dir options replace PATH discovery.
Explicit --*-bin paths take precedence. Multiple distinct candidates are refused.
No configuration, vault, provider, trust, MCP or service state is inspected.
Nothing is bundled, installed, registered or enabled. Exit 0: inventory completed;
missing/incompatible companions are reported individually. Exit 2: bad usage.\n`;

const PLAN_HELP = `Usage: phm companions plan --artifacts <absolute-directory> --manifest <relative-file>\n  --sha256 <independently-verified-manifest-digest> --root <absolute-destination> [--json]

Verify an expanded local artifact file set against an independently reviewed manifest digest.
No download, extraction, executable probe, installation, configuration, trust or service changes.
The destination before images are observations, not backups or permission to apply changes.
Exit 0: verified plan; exit 1: blocked; exit 2: bad usage.\n`;

const INSTALL_HELP = `Usage: phm companions install --artifacts <absolute-directory> --manifest <relative-file>\n  --sha256 <independently-verified-manifest-digest> --root <absolute-private-destination>\n  --python <absolute-reviewed-python-runtime> [--json]

Install verified expanded local files into a fresh immutable companion directory.
Requires an existing private destination root and descriptor-relative macOS/Linux support.
No download, extraction, source fallback, executable probe, registration, trust or service changes.
Existing installations are never overwritten. Review the manifest digest and Python runtime first.
Exit 0: installed; exit 1: blocked; exit 2: bad usage; exit 3: indeterminate, inspect the destination.\n`;

async function cmdCompanionInstall(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(INSTALL_HELP);
    return 0;
  }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--artifacts', '--manifest', '--sha256', '--root', '--python'].includes(arg) || values.has(arg)) {
      process.stderr.write('Invalid or duplicate companion install option.\n');
      return 2;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      process.stderr.write(`${arg} requires a value.\n`);
      return 2;
    }
    values.set(arg, value);
  }
  if (values.size !== 5 || !isAbsolute(values.get('--artifacts')!) || !isAbsolute(values.get('--root')!) ||
      !isAbsolute(values.get('--python')!) || isAbsolute(values.get('--manifest')!) ||
      !/^[a-f0-9]{64}$/u.test(values.get('--sha256')!)) {
    process.stderr.write('Companion install requires absolute artifact/destination/runtime paths, a relative manifest and verified SHA256.\n');
    return 2;
  }
  const result = await installCompanionArtifact({
    artifactRoot: values.get('--artifacts')!, destinationRoot: values.get('--root')!,
    manifestPath: values.get('--manifest')!, trustedManifestSha256: values.get('--sha256')!,
    pythonPath: values.get('--python')!,
  });
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write(`Phantom companion artifact installation: ${result.status}; runtime: not inspected\n`);
    if (result.destination) process.stdout.write(`  Destination: ${result.destination}\n`);
    for (const blocker of result.blockers) process.stdout.write(`  Blocked: ${blocker}\n`);
    if (result.status === 'indeterminate') process.stdout.write('Inspect the destination before retrying; completion is uncertain.\n');
    else if (result.installed) process.stdout.write('Files installed. Client registration and a real MCP handshake remain separate steps.\n');
  }
  return result.status === 'installed' ? 0 : result.status === 'indeterminate' ? 3 : 1;
}

function cmdCompanionPlan(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(PLAN_HELP);
    return 0;
  }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--artifacts', '--manifest', '--sha256', '--root'].includes(arg) || values.has(arg)) {
      process.stderr.write('Invalid or duplicate companion plan option.\n');
      return 2;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      process.stderr.write(`${arg} requires a value.\n`);
      return 2;
    }
    values.set(arg, value);
  }
  if (values.size !== 4 || !isAbsolute(values.get('--artifacts')!) || !isAbsolute(values.get('--root')!) ||
      isAbsolute(values.get('--manifest')!) || !/^[a-f0-9]{64}$/u.test(values.get('--sha256')!)) {
    process.stderr.write('Companion plan requires absolute artifact/destination roots, a relative manifest and verified SHA256.\n');
    return 2;
  }
  const plan = planCompanionProvisioning({
    artifactRoot: values.get('--artifacts')!, destinationRoot: values.get('--root')!,
    manifestPath: values.get('--manifest')!, trustedManifestSha256: values.get('--sha256')!,
  });
  if (json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else {
    process.stdout.write(`Phantom companion artifact plan: ${plan.status}; installed: no; runtime: not inspected\n`);
    for (const blocker of plan.blockers) process.stdout.write(`  Blocked: ${blocker}\n`);
    for (const file of plan.files) process.stdout.write(`  ${file.action}: ${file.path}\n`);
    process.stdout.write('No effects applied. Revalidate artifacts and before images before any future authorized installation.\n');
  }
  return plan.status === 'verified-plan' ? 0 : 1;
}

export async function cmdCompanions(args: string[]): Promise<number> {
  if (args[0] === 'plan') return cmdCompanionPlan(args.slice(1));
  if (args[0] === 'install') return cmdCompanionInstall(args.slice(1));
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    process.stdout.write(HELP + '\nOffline artifact verification: phm companions plan --help\nExplicit local installation: phm companions install --help\n');
    return 0;
  }
  const options: CompanionInventoryOptions = { binaries: {} };
  let json = false;
  const directories: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (!['--root', '--bin-dir', '--secrets-bin', '--locus-bin', '--lexicon-bin'].includes(arg)) {
      process.stderr.write(`Unknown companions argument: ${arg}\n`);
      return 2;
    }
    const value = args[++i];
    if (!value || !isAbsolute(value)) {
      process.stderr.write(`${arg} requires an absolute path.\n`);
      return 2;
    }
    if (arg === '--root') directories.push(join(value, 'bin'));
    else if (arg === '--bin-dir') directories.push(value);
    else options.binaries![arg.slice(2, -4) as CompanionId] = value;
  }
  if (directories.length > 256) {
    process.stderr.write('At most 256 companion search directories are supported.\n');
    return 2;
  }
  if (directories.length) options.searchPaths = directories;
  const report = await inventoryCompanions(options);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write('Phantom companions — separately installed; bundled: no\n');
    for (const tool of report.companions) {
      process.stdout.write(`${tool.name}: ${tool.status}${tool.version ? ` (${tool.version})` : ''}\n`);
      if (tool.path) process.stdout.write(`  ${tool.path}\n`);
      process.stdout.write(`  ${tool.guidance}\n  Reviewed release: ${tool.reviewedRelease.url}\n`);
    }
  }
  return 0;
}
