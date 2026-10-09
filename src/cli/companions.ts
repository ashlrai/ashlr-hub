import { isAbsolute, join } from 'node:path';
import { inventoryCompanions, type CompanionId, type CompanionInventoryOptions } from '../core/companion-inventory.js';
import { planCompanionProvisioning } from '../core/companion-provisioning.js';
import { installCompanionArtifact } from '../core/companion-installation.js';
import { inspectCompanionCatalog, resolveCompanionCatalog } from '../core/companion-catalog.js';
import { planCompanionClient } from '../core/companion-client-plan.js';

const HELP = `Usage: phm companions [--json] [--root <absolute-install-root>] [--bin-dir <absolute-dir>]\n  [--secrets-bin <absolute-file>] [--locus-bin <absolute-file>] [--lexicon-bin <absolute-file>]

Read-only inventory of separately installed Secrets, Locus and Lexicon.
Only --version and --help are run in disposable state with a scrubbed environment.
--root searches only <root>/bin; repeated --bin-dir options replace PATH discovery.
Explicit --*-bin paths take precedence. Multiple distinct candidates are refused.
No configuration, vault, provider, trust, MCP or service state is inspected.
Nothing is bundled, installed, registered or enabled. Exit 0: inventory completed;
missing/incompatible companions are reported individually. Exit 2: bad usage.\n`;

const PLAN_HELP = `Usage: phm companions plan --artifacts <absolute-directory> --root <absolute-destination>\n  (--catalog <id> [--manifest <relative-file>] | --manifest <relative-file> --sha256 <verified-digest>) [--json]

Verify an expanded local artifact file set against an independently reviewed manifest digest.
--catalog uses shipped component pins for this host; its manifest defaults to manifest.json.
Catalog selection does not generate a manifest. --catalog and --sha256 are mutually exclusive.
No download, extraction, executable probe, installation, configuration, trust or service changes.
The destination before images are observations, not backups or permission to apply changes.
Exit 0: verified plan; exit 1: blocked; exit 2: bad usage.\n`;

const INSTALL_HELP = `Usage: phm companions install --artifacts <absolute-directory> --root <absolute-private-destination>\n  --python <absolute-reviewed-python-runtime>\n  (--catalog <id> [--manifest <relative-file>] | --manifest <relative-file> --sha256 <verified-digest>) [--json]

Install verified expanded local files into a fresh immutable companion directory.
--catalog uses shipped component pins for this host; its manifest defaults to manifest.json.
Catalog selection does not generate a manifest. --catalog and --sha256 are mutually exclusive.
Requires an existing private destination root and descriptor-relative macOS/Linux support.
No download, extraction, source fallback, executable probe, registration, trust or service changes.
Existing installations are never overwritten. Review the manifest digest and Python runtime first.
Exit 0: installed; exit 1: blocked; exit 2: bad usage; exit 3: indeterminate, inspect the destination.\n`;

const CLIENT_PLAN_HELP = `Usage: phm companions client-plan --installation <absolute-private-parent>\n  --project <absolute-project-root> --client <id> --registry <absolute-project-registry.json>\n  --config <absolute-project-client.json> [--json]

Verify the installed Lexicon MCP component against shipped host catalog pins.
Plan separate internal Lexicon and client Phantom-gateway entries; preserve unrelated configuration.
Requires the current Node host, packaged CLI and a project-root Git marker.
No files are written, processes started, vocabulary trusted or providers accessed.
Exit 0: verified client plan; exit 1: blocked; exit 2: bad usage.\n`;

function cmdCompanionClientPlan(args: string[]): number {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(CLIENT_PLAN_HELP);
    return 0;
  }
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--installation', '--project', '--client', '--registry', '--config'].includes(flag) || values.has(flag)) {
      process.stderr.write('Invalid or duplicate companion client-plan option.\n');
      return 2;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      process.stderr.write(`${flag} requires a value.\n`);
      return 2;
    }
    values.set(flag, value);
  }
  if (values.size !== 5 || !['--installation', '--project', '--registry', '--config'].every(flag => isAbsolute(values.get(flag)!))) {
    process.stderr.write('Client-plan requires an installation parent, project, client and two explicit absolute JSON config paths.\n');
    return 2;
  }
  const plan = planCompanionClient({ installationRoot: values.get('--installation')!, projectRoot: values.get('--project')!,
    client: values.get('--client')!, registryPath: values.get('--registry')!, clientConfigPath: values.get('--config')! });
  if (json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else {
    process.stdout.write(`Phantom companion client plan: ${plan.status}; wiring: not applied; runtime: not inspected\n`);
    for (const blocker of plan.blockers) process.stdout.write(`  Blocked: ${blocker}\n`);
    for (const patch of plan.patches) process.stdout.write(`  ${patch.action}: ${patch.serverName} in ${patch.path}\n`);
    process.stdout.write('Use --json to review the entry patches. Revalidate before merging or executing; preserve unrelated entries.\n');
  }
  return plan.status === 'verified-client-plan' ? 0 : 1;
}

type ManifestSelection =
  | { status: 'selected'; manifestPath: string; trustedManifestSha256: string }
  | { status: 'invalid'; message: string }
  | { status: 'blocked'; blockers: string[] };

function selectManifest(values: Map<string, string>): ManifestSelection {
  const catalog = values.get('--catalog');
  const digest = values.get('--sha256');
  if (catalog !== undefined && digest !== undefined) {
    return { status: 'invalid', message: '--catalog and --sha256 are mutually exclusive.' };
  }
  const manifestPath = values.get('--manifest') ?? (catalog !== undefined ? 'manifest.json' : undefined);
  if (!manifestPath || isAbsolute(manifestPath)) {
    return { status: 'invalid', message: 'A relative manifest is required; catalog selection defaults to manifest.json.' };
  }
  if (catalog !== undefined) {
    const selection = resolveCompanionCatalog(catalog);
    if (selection.status === 'blocked') {
      if (selection.blockers.includes('unknown-catalog-id')) return { status: 'invalid', message: 'Unknown companion catalog ID.' };
      return selection;
    }
    return { status: 'selected', manifestPath, trustedManifestSha256: selection.entry.manifestSha256 };
  }
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
    return { status: 'invalid', message: 'An independently verified SHA256 or reviewed --catalog selection is required.' };
  }
  return { status: 'selected', manifestPath, trustedManifestSha256: digest };
}

function selectionFailure(selection: Exclude<ManifestSelection, { status: 'selected' }>, json: boolean): number {
  if (selection.status === 'invalid') {
    process.stderr.write(selection.message + '\n');
    return 2;
  }
  const report = { schemaVersion: 1, status: 'blocked', effects: [], installed: false,
    runtimeCapability: 'not-inspected', blockers: selection.blockers };
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(`Phantom companion artifact selection: blocked; no effects\n  Blocked: ${selection.blockers.join(', ')}\n`);
  return 1;
}

function cmdCompanionCatalog(args: string[]): number {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write('Usage: phm companions catalog [--json]\nRead-only shipped artifact pins and narrow local test evidence. No payloads bundled or effects applied.\n');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.stderr.write('Companion catalog accepts only --json or --help.\n');
    return 2;
  }
  const report = inspectCompanionCatalog();
  if (args[0] === '--json') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(`Phantom companion catalog: ${report.platform}; installed: no; runtime: not inspected; bundled: no\n`);
    for (const entry of report.entries) {
      process.stdout.write(`${entry.id}: ${entry.availability}; ${entry.component}\n  Manifest SHA256: ${entry.manifestSha256}\n`);
    }
    for (const entry of report.unavailable) process.stdout.write(`${entry.tool}: ${entry.status}; ${entry.reason}\n`);
    process.stdout.write(report.qualificationBoundary + '\n');
  }
  return 0;
}

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
    if (!['--artifacts', '--manifest', '--sha256', '--catalog', '--root', '--python'].includes(arg) || values.has(arg)) {
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
  if (!['--artifacts', '--root', '--python'].every(option => values.has(option) && isAbsolute(values.get(option)!))) {
    process.stderr.write('Companion install requires absolute artifact/destination/runtime paths.\n');
    return 2;
  }
  const selection = selectManifest(values);
  if (selection.status !== 'selected') return selectionFailure(selection, json);
  const result = await installCompanionArtifact({
    artifactRoot: values.get('--artifacts')!, destinationRoot: values.get('--root')!,
    manifestPath: selection.manifestPath, trustedManifestSha256: selection.trustedManifestSha256,
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
    if (!['--artifacts', '--manifest', '--sha256', '--catalog', '--root'].includes(arg) || values.has(arg)) {
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
  if (!['--artifacts', '--root'].every(option => values.has(option) && isAbsolute(values.get(option)!))) {
    process.stderr.write('Companion plan requires absolute artifact/destination roots.\n');
    return 2;
  }
  const selection = selectManifest(values);
  if (selection.status !== 'selected') return selectionFailure(selection, json);
  const plan = planCompanionProvisioning({
    artifactRoot: values.get('--artifacts')!, destinationRoot: values.get('--root')!,
    manifestPath: selection.manifestPath, trustedManifestSha256: selection.trustedManifestSha256,
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
  if (args[0] === 'client-plan') return cmdCompanionClientPlan(args.slice(1));
  if (args[0] === 'catalog') return cmdCompanionCatalog(args.slice(1));
  if (args[0] === 'plan') return cmdCompanionPlan(args.slice(1));
  if (args[0] === 'install') return cmdCompanionInstall(args.slice(1));
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    process.stdout.write(HELP + '\nShipped artifact pins: phm companions catalog --help\nOffline artifact verification: phm companions plan --help\nExplicit local installation: phm companions install --help\nExplicit client wiring plan: phm companions client-plan --help\n');
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
