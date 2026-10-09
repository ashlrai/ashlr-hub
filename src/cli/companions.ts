import { isAbsolute, join } from 'node:path';
import { inventoryCompanions, type CompanionId, type CompanionInventoryOptions } from '../core/companion-inventory.js';

const HELP = `Usage: phm companions [--json] [--root <absolute-install-root>] [--bin-dir <absolute-dir>]\n  [--secrets-bin <absolute-file>] [--locus-bin <absolute-file>] [--lexicon-bin <absolute-file>]

Read-only inventory of separately installed Secrets, Locus and Lexicon.
Only --version and --help are run in disposable state with a scrubbed environment.
--root searches only <root>/bin; repeated --bin-dir options replace PATH discovery.
Explicit --*-bin paths take precedence. Multiple distinct candidates are refused.
No configuration, vault, provider, trust, MCP or service state is inspected.
Nothing is bundled, installed, registered or enabled. Exit 0: inventory completed;
missing/incompatible companions are reported individually. Exit 2: bad usage.\n`;

export async function cmdCompanions(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    process.stdout.write(HELP);
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
