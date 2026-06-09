/**
 * `ashlr spec` CLI command.
 *
 * Subcommands:
 *   new "<goal>" [--project <path>] [--json]   Draft a new end-state spec (versioned).
 *   list [--project <path>] [--json]            List all specs, newest version per id.
 *   show <id> [--json]                          Show the highest version of a spec.
 *   refine <id> "<note>" [--json]               Produce v+1 incorporating the note.
 *
 * Exit codes:
 *   0  success
 *   1  error / not-found
 *   2  bad usage
 */

import type { SpecArtifact, AshlrConfig } from '../core/types.js';
import { pad, makeColors, isTty } from './ui.js';

// ---------------------------------------------------------------------------
// Lazy imports — spec-store is built by another M12 agent
// ---------------------------------------------------------------------------

type SpecStoreMod = {
  authorSpec: (goal: string, cfg: AshlrConfig, opts?: { project?: string }) => Promise<SpecArtifact>;
  listSpecs:  (project?: string) => SpecArtifact[];
  loadSpec:   (id: string, project?: string) => { meta: SpecArtifact; body: string } | null;
  refineSpec: (id: string, note: string, cfg: AshlrConfig, project?: string) => Promise<SpecArtifact>;
};

async function importSpecStore(): Promise<SpecStoreMod> {
  return import('../core/spec/spec-store.js') as Promise<SpecStoreMod>;
}

async function importConfig() {
  return import('../core/config.js') as Promise<{
    loadConfig: () => AshlrConfig;
  }>;
}

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const cl = makeColors(isTty());
const { bold, dim, red, green, yellow, cyan, gray, blue } = cl;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type SpecSubcmd =
  | { sub: 'new';    goal: string;  project?: string; json: boolean }
  | { sub: 'list';   project?: string; json: boolean }
  | { sub: 'show';   id: string;   project?: string; json: boolean }
  | { sub: 'refine'; id: string;   note: string; project?: string; json: boolean }
  | { sub: 'help' }
  | { sub: 'error';  message: string };

function parseSpecArgs(args: string[]): SpecSubcmd {
  const first = args[0];

  if (!first || first === '--help' || first === '-h' || first === 'help') {
    return { sub: 'help' };
  }

  // ── new ──────────────────────────────────────────────────────────────────
  if (first === 'new') {
    const rest = args.slice(1);
    let goal: string | undefined;
    let project: string | undefined;
    let json = false;

    let i = 0;
    while (i < rest.length) {
      const a = rest[i]!;
      if (a === '--project' || a === '-p') {
        project = rest[i + 1];
        if (!project) return { sub: 'error', message: '--project requires a path argument' };
        i += 2;
      } else if (a === '--json') {
        json = true;
        i++;
      } else if (!goal && !a.startsWith('--')) {
        goal = a;
        i++;
      } else {
        return { sub: 'error', message: `Unknown flag: ${a}` };
      }
    }

    if (!goal) return { sub: 'error', message: 'Usage: ashlr spec new "<goal>" [--project <path>] [--json]' };
    return { sub: 'new', goal, project, json };
  }

  // ── list ─────────────────────────────────────────────────────────────────
  if (first === 'list') {
    const rest = args.slice(1);
    let project: string | undefined;
    let json = false;

    let i = 0;
    while (i < rest.length) {
      const a = rest[i]!;
      if (a === '--project' || a === '-p') {
        project = rest[i + 1];
        if (!project) return { sub: 'error', message: '--project requires a path argument' };
        i += 2;
      } else if (a === '--json') {
        json = true;
        i++;
      } else {
        return { sub: 'error', message: `Unknown flag: ${a}` };
      }
    }

    return { sub: 'list', project, json };
  }

  // ── show ─────────────────────────────────────────────────────────────────
  if (first === 'show') {
    const rest = args.slice(1);
    let id: string | undefined;
    let project: string | undefined;
    let json = false;

    let i = 0;
    while (i < rest.length) {
      const a = rest[i]!;
      if (a === '--project' || a === '-p') {
        project = rest[i + 1];
        if (!project) return { sub: 'error', message: '--project requires a path argument' };
        i += 2;
      } else if (a === '--json') {
        json = true;
        i++;
      } else if (!id && !a.startsWith('--')) {
        id = a;
        i++;
      } else {
        return { sub: 'error', message: `Unknown flag: ${a}` };
      }
    }

    if (!id) return { sub: 'error', message: 'Usage: ashlr spec show <id> [--project <path>]' };
    return { sub: 'show', id, project, json };
  }

  // ── refine ───────────────────────────────────────────────────────────────
  if (first === 'refine') {
    const rest = args.slice(1);
    const positionals: string[] = [];
    let project: string | undefined;
    let json = false;

    let i = 0;
    while (i < rest.length) {
      const a = rest[i]!;
      if (a === '--project' || a === '-p') {
        project = rest[i + 1];
        if (!project) return { sub: 'error', message: '--project requires a path argument' };
        i += 2;
      } else if (a === '--json') {
        json = true;
        i++;
      } else if (!a.startsWith('--')) {
        positionals.push(a);
        i++;
      } else {
        return { sub: 'error', message: `Unknown flag: ${a}` };
      }
    }

    const id = positionals[0];
    const note = positionals[1];
    if (!id)   return { sub: 'error', message: 'Usage: ashlr spec refine <id> "<note>" [--project <path>]' };
    if (!note) return { sub: 'error', message: 'Usage: ashlr spec refine <id> "<note>" [--project <path>]' };
    return { sub: 'refine', id, note, project, json };
  }

  return { sub: 'error', message: `Unknown subcommand: ${first}. Try 'ashlr spec help'.` };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s  / 60);
  const h  = Math.floor(m  / 60);
  const d  = Math.floor(h  / 24);
  if (d > 0)  return `${d}d ago`;
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  return `${Math.max(0, s)}s ago`;
}

function statusColor(status: SpecArtifact['status']): string {
  switch (status) {
    case 'active':   return green(status);
    case 'draft':    return yellow(status);
    case 'archived': return gray(status);
    default:         return String(status);
  }
}

/**
 * Extract the section headings present in a spec body (lines starting with `##`).
 * Returns at most 8 section names for the summary view.
 */
function extractSections(body: string): string[] {
  const sections: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^#{1,3}\s+(.+)/);
    if (m) {
      sections.push(m[1]!.trim());
      if (sections.length >= 8) break;
    }
  }
  return sections;
}

function printSpecSummary(meta: SpecArtifact, body: string): void {
  const sections = extractSections(body);
  const totalTokensEst = Math.round(body.length / 4); // rough char→token estimate

  console.log('');
  console.log(bold('  ashlr spec') + gray(` — ${meta.id}`));
  console.log('');
  console.log(`  ${bold('Goal:')}    ${meta.goal}`);
  console.log(`  ${bold('Status:')}  ${statusColor(meta.status)}  ${dim('·')}  ${bold('Version:')} v${meta.version}`);
  console.log(`  ${bold('Path:')}    ${dim(meta.path)}`);
  if (meta.project) {
    console.log(`  ${bold('Project:')} ${cyan(meta.project)}`);
  }
  console.log(`  ${bold('Created:')} ${relativeTime(meta.createdAt)}  ${dim('·')}  ${bold('Updated:')} ${relativeTime(meta.updatedAt)}`);
  console.log(`  ${bold('Size:')}    ~${totalTokensEst.toLocaleString()} tokens`);

  if (sections.length > 0) {
    console.log('');
    console.log(`  ${bold('Sections:')}`);
    for (const s of sections) {
      console.log(`    ${dim('•')} ${s}`);
    }
  }

  console.log('');
  console.log(dim(`  Use 'ashlr spec show ${meta.id}' to view the full body.`));
  console.log('');
}

function printSpecList(specs: SpecArtifact[]): void {
  if (specs.length === 0) {
    console.log('');
    console.log(`  ${dim('No specs found.')} Create one with ${bold('ashlr spec new "<goal>"')}.`);
    console.log('');
    return;
  }

  const idW     = Math.max(4, ...specs.map(s => s.id.length));
  const statusW = 8;
  const verW    = 4;
  const timeW   = 8;
  const goalW   = 50;

  console.log('');
  console.log(bold('  ashlr specs') + gray(`  — ${specs.length} spec(s)`));
  console.log('');
  console.log(
    `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
    `${bold(pad('Ver', verW))}  ${bold(pad('Updated', timeW))}  ${bold('Goal')}`,
  );
  console.log(
    `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(verW)}  ${'─'.repeat(timeW)}  ${'─'.repeat(goalW)}`,
  );

  for (const s of specs) {
    const goalTrunc = s.goal.length > goalW ? s.goal.slice(0, goalW - 1) + '…' : s.goal;
    const when      = relativeTime(s.updatedAt);
    const ver       = `v${s.version}`;

    console.log(
      `  ${pad(dim(s.id), idW)}  ${pad(statusColor(s.status), statusW)}  ` +
      `${pad(blue(ver), verW)}  ${pad(gray(when), timeW)}  ${goalTrunc}`,
    );
  }

  console.log('');
  console.log(dim(`  Use 'ashlr spec show <id>' to view a spec.`));
  console.log('');
}

function printSpecFull(meta: SpecArtifact, body: string): void {
  console.log('');
  console.log(bold('  ashlr spec') + gray(` — ${meta.id}  v${meta.version}`));
  console.log('');
  console.log(`  ${bold('Goal:')}    ${meta.goal}`);
  console.log(`  ${bold('Status:')}  ${statusColor(meta.status)}`);
  console.log(`  ${bold('Path:')}    ${dim(meta.path)}`);
  if (meta.project) {
    console.log(`  ${bold('Project:')} ${cyan(meta.project)}`);
  }
  console.log(`  ${bold('Updated:')} ${relativeTime(meta.updatedAt)}`);
  console.log('');
  console.log(dim('  ─'.repeat(40)));
  console.log('');

  // Print body indented
  for (const line of body.split('\n')) {
    console.log(`  ${line}`);
  }

  console.log('');
}

function printSpecHelp(): void {
  console.log('');
  console.log(bold('  ashlr spec') + dim(' — author, version, and refine end-state specs'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr spec ${cyan('new')} ${cyan('"<goal>"')} [--project <path>] [--json]`);
  console.log(`    ashlr spec ${cyan('list')} [--project <path>] [--json]`);
  console.log(`    ashlr spec ${cyan('show')} ${cyan('<id>')} [--project <path>] [--json]`);
  console.log(`    ashlr spec ${cyan('refine')} ${cyan('<id>')} ${cyan('"<note>"')} [--project <path>] [--json]`);
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const cmds: [string, string][] = [
    ['new "<goal>" [--project <path>]', 'Draft a structured end-state spec (versioned v1).'],
    ['list [--project <path>]',         'List all specs, newest version per id.'],
    ['show <id> [--project <path>]',     'Display the full spec body (highest version).'],
    ['refine <id> "<note>" [--project <path>]', 'Produce v+1 incorporating the refinement note.'],
  ];

  const cmdW = Math.max(...cmds.map(([c]) => c.length));
  for (const [cmd, desc] of cmds) {
    console.log(`    ${cyan(pad(cmd, cmdW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');
  console.log(`    ${cyan('--project <path>')}  Scope spec to a specific project directory.`);
  console.log(`    ${cyan('--json')}            Emit JSON on stdout.`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${gray('# Draft a new spec for a project')}`);
  console.log(`    ashlr spec new "Build a CLI tool that organizes dotfiles" --project ~/dotfiles`);
  console.log('');
  console.log(`    ${gray('# List all known specs')}`);
  console.log(`    ashlr spec list`);
  console.log('');
  console.log(`    ${gray('# Refine an existing spec with new context')}`);
  console.log(`    ashlr spec refine abc123 "Add a phase for cross-platform support"`);
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• Specs are stored versioned — refine never overwrites prior versions.')}`);
  console.log(`    ${dim('• Project specs: <project>/.ashlr/specs/; Global specs: ~/.ashlr/specs/')}`);
  console.log(`    ${dim('• Models run LOCAL-FIRST (Ollama / LM Studio).')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * `ashlr spec` command handler.
 * Returns process exit code (0 = success, 1 = error, 2 = usage error).
 */
export async function cmdSpec(args: string[]): Promise<number> {
  const parsed = parseSpecArgs(args);

  // ── help ─────────────────────────────────────────────────────────────────
  if (parsed.sub === 'help') {
    printSpecHelp();
    return 0;
  }

  // ── usage error ──────────────────────────────────────────────────────────
  if (parsed.sub === 'error') {
    process.stderr.write(red('error: ') + parsed.message + '\n');
    return 2;
  }

  // Load config (required for model calls in new/refine)
  let cfg: AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load spec store
  let store: SpecStoreMod;
  try {
    store = await importSpecStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load spec-store (M12 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // ── new ──────────────────────────────────────────────────────────────────
  if (parsed.sub === 'new') {
    process.stderr.write(dim('  Drafting spec…') + '\n');

    let artifact: SpecArtifact;
    try {
      artifact = await store.authorSpec(parsed.goal, cfg, { project: parsed.project });
    } catch (err) {
      process.stderr.write(
        red('error: ') + 'Failed to author spec: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');
      return 0;
    }

    // Human-readable summary — load body for section listing
    const loaded = store.loadSpec(artifact.id);
    if (loaded) {
      printSpecSummary(loaded.meta, loaded.body);
    } else {
      // Fallback if loadSpec doesn't find it immediately
      console.log('');
      console.log(bold('  Spec created:') + gray(` ${artifact.id} v${artifact.version}`));
      console.log(`  ${bold('Path:')} ${dim(artifact.path)}`);
      console.log('');
    }

    return 0;
  }

  // ── list ─────────────────────────────────────────────────────────────────
  if (parsed.sub === 'list') {
    let specs: SpecArtifact[];
    try {
      specs = store.listSpecs(parsed.project);
    } catch (err) {
      process.stderr.write(
        red('error: ') + 'Failed to list specs: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(specs, null, 2) + '\n');
      return 0;
    }

    printSpecList(specs);
    return 0;
  }

  // ── show ─────────────────────────────────────────────────────────────────
  if (parsed.sub === 'show') {
    let loaded: { meta: SpecArtifact; body: string } | null;
    try {
      loaded = store.loadSpec(parsed.id, parsed.project);
    } catch (err) {
      process.stderr.write(
        red('error: ') + 'Failed to load spec: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }

    if (!loaded) {
      const msg = `Spec not found: ${parsed.id}`;
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ error: msg }) + '\n');
      } else {
        process.stderr.write(red('error: ') + msg + '\n');
      }
      return 1;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify({ meta: loaded.meta, body: loaded.body }, null, 2) + '\n');
      return 0;
    }

    printSpecFull(loaded.meta, loaded.body);
    return 0;
  }

  // ── refine ───────────────────────────────────────────────────────────────
  if (parsed.sub === 'refine') {
    // Verify the spec exists before making the model call
    let existing: { meta: SpecArtifact; body: string } | null;
    try {
      existing = store.loadSpec(parsed.id, parsed.project);
    } catch (err) {
      process.stderr.write(
        red('error: ') + 'Failed to load spec: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }

    if (!existing) {
      process.stderr.write(red('error: ') + `Spec not found: ${parsed.id}\n`);
      return 1;
    }

    process.stderr.write(
      dim(`  Refining spec ${parsed.id} v${existing.meta.version} → v${existing.meta.version + 1}…`) + '\n',
    );

    let artifact: SpecArtifact;
    try {
      artifact = await store.refineSpec(parsed.id, parsed.note, cfg, parsed.project);
    } catch (err) {
      process.stderr.write(
        red('error: ') + 'Failed to refine spec: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');
      return 0;
    }

    const loaded = store.loadSpec(artifact.id);
    if (loaded) {
      printSpecSummary(loaded.meta, loaded.body);
    } else {
      console.log('');
      console.log(bold('  Spec refined:') + gray(` ${artifact.id} v${artifact.version}`));
      console.log(`  ${bold('Path:')} ${dim(artifact.path)}`);
      console.log('');
    }

    return 0;
  }

  // Should be unreachable
  return 2;
}
