/**
 * `ashlr new <name>` — scaffold a new project into the ashlr ecosystem.
 *
 * Usage:
 *   ashlr new <name> [--template <id>] [--category <c>] [--stack <recipe>]
 *                    [--here] [--no-git] [--json] [--list]
 *
 * Flags:
 *   --template <id>    Template to scaffold from (default: node-cli).
 *                      Run --list to see available templates.
 *   --category <c>     Category bucket under ~/Desktop/github/ (default: side-projects).
 *   --stack <recipe>   Stack recipe id to provision after scaffold (requires `stack` installed).
 *   --here             Scaffold into cwd/<name> instead of the default github tree.
 *   --no-git           Skip `git init`.
 *   --json             Emit ScaffoldResult as JSON on stdout instead of human output.
 *   --list             List available templates and exit.
 *
 * Exit codes:
 *   0  success
 *   1  error (dir exists, scaffold failed, etc.)
 *   2  bad usage / invalid name
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { cwd } from 'node:process';

import type { ScaffoldSpec, ScaffoldResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Lazy imports — lifecycle modules built by other M6 agents
// ---------------------------------------------------------------------------

async function importScaffold() {
  return (import('../core/lifecycle/scaffold.js' as unknown as string)) as Promise<{
    scaffoldProject: (spec: ScaffoldSpec) => ScaffoldResult;
    defaultCategory: () => string;
    targetDir: (name: string, category: string) => string;
    githubRoot: () => string;
  }>;
}

async function importTemplates() {
  return (import('../core/lifecycle/templates.js' as unknown as string)) as Promise<{
    listTemplates: () => { id: string; title: string; description: string }[];
    getTemplate: (id: string) => import('../core/types.js').ProjectTemplate | null;
  }>;
}

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

import { makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * A safe project name slug:
 *   - 1–80 characters
 *   - lowercase letters, digits, hyphens, underscores only
 *   - must start with a letter or digit
 *   - no path separators, dots (leading/trailing), spaces, or special chars
 */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function validateName(name: string): string | null {
  if (!name || name.trim() === '') {
    return 'Project name is required.';
  }
  if (name.includes('/') || name.includes('\\')) {
    return `Name must not contain path separators: "${name}"`;
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return `Name must not start or end with a dot: "${name}"`;
  }
  if (!SAFE_NAME_RE.test(name)) {
    return (
      `Name "${name}" is invalid. Use only lowercase letters, digits, hyphens, ` +
      `and underscores. Must start with a letter or digit.`
    );
  }
  return null;
}

/**
 * A safe category slug — a single path segment under ~/Desktop/github/.
 *   - 1–64 characters
 *   - lowercase letters, digits, hyphens, underscores only
 *   - must start with a letter or digit
 *   - NO path separators, dots, or traversal sequences
 * Mirrors validateName to keep `--category` from escaping the github tree.
 */
const SAFE_CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateCategory(category: string): string | null {
  if (!category || category.trim() === '') {
    return 'Category must not be empty.';
  }
  if (
    category.includes('/') ||
    category.includes('\\') ||
    category.includes('.')
  ) {
    return `Category must not contain path separators or dots: "${category}"`;
  }
  if (!SAFE_CATEGORY_RE.test(category)) {
    return (
      `Category "${category}" is invalid. Use only lowercase letters, digits, ` +
      `hyphens, and underscores. Must start with a letter or digit.`
    );
  }
  return null;
}

/**
 * A safe stack-recipe slug. Rejects shell metacharacters, whitespace, path
 * separators, and traversal so it can never be interpreted as a shell command
 * even though we already invoke `stack` via execFileSync (no shell).
 */
const SAFE_RECIPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function validateRecipe(recipe: string): string | null {
  if (!recipe || recipe.trim() === '') {
    return 'Stack recipe must not be empty.';
  }
  if (!SAFE_RECIPE_RE.test(recipe)) {
    return (
      `Stack recipe "${recipe}" is invalid. Use only letters, digits, hyphens, ` +
      `and underscores (no spaces, slashes, dots, or shell metacharacters).`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedNewArgs {
  name?: string;
  templateId: string;
  category: string;
  stackRecipe?: string;
  here: boolean;
  noGit: boolean;
  json: boolean;
  list: boolean;
  usageError?: string;
}

function parseArgs(args: string[]): ParsedNewArgs {
  const result: ParsedNewArgs = {
    templateId: 'node-cli',
    category:   'side-projects',
    here:       false,
    noGit:      false,
    json:       false,
    list:       false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--list') {
      result.list = true;
      i++;
    } else if (arg === '--here') {
      result.here = true;
      i++;
    } else if (arg === '--no-git') {
      result.noGit = true;
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--template') {
      const val = args[++i];
      if (!val) {
        result.usageError = '--template requires a template id (e.g. node-cli, mcp-server, next-app, minimal)';
        return result;
      }
      result.templateId = val;
      i++;
    } else if (arg === '--category') {
      const val = args[++i];
      if (!val) {
        result.usageError = '--category requires a category name (e.g. side-projects, dev-tools)';
        return result;
      }
      result.category = val;
      i++;
    } else if (arg === '--stack') {
      const val = args[++i];
      if (!val) {
        result.usageError = '--stack requires a recipe name';
        return result;
      }
      result.stackRecipe = val;
      i++;
    } else if (!arg.startsWith('--')) {
      // Positional: the project name
      if (result.name !== undefined) {
        result.usageError = `Unexpected positional argument: "${arg}". Only one name allowed.`;
        return result;
      }
      result.name = arg;
      i++;
    } else {
      result.usageError = `Unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stack provisioning (best-effort, post-scaffold)
// ---------------------------------------------------------------------------

function detectTool(name: string): string | null {
  try {
    const out = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function runStackRecipe(dir: string, recipe: string): { ok: boolean; detail: string } {
  const stackBin = detectTool('stack');
  if (!stackBin) {
    return { ok: false, detail: 'stack not installed — skipping recipe provisioning' };
  }
  try {
    // execFileSync bypasses the shell entirely — `recipe` is passed as a
    // discrete argv entry and can never be interpreted as a shell command.
    // `recipe` is additionally validated against SAFE_RECIPE_RE before we get
    // here, so command injection is doubly prevented.
    execFileSync(stackBin, ['provision', recipe], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { ok: true, detail: `stack provision ${recipe} completed` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `stack provision ${recipe} failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printSuccess(result: ScaffoldResult, name: string, templateId: string): void {
  const homeDir = process.env['HOME'] ?? '';
  const shortDir = result.dir.startsWith(homeDir)
    ? '~' + result.dir.slice(homeDir.length)
    : result.dir;

  console.log('');
  console.log(bold('  ashlr new') + gray(' — project scaffolded'));
  console.log('');
  console.log(`  ${bold('Project:')}   ${cyan(name)}`);
  console.log(`  ${bold('Template:')}  ${templateId}`);
  console.log(`  ${bold('Location:')}  ${shortDir}`);
  console.log('');

  // Files written
  const filesShort = result.filesWritten.map(f => {
    const rel = f.startsWith(result.dir + '/') ? f.slice(result.dir.length + 1) : f;
    return rel;
  });
  console.log(`  ${bold('Files written')} ${gray(`(${filesShort.length}):`)} `);
  for (const f of filesShort) {
    console.log(`    ${dim('+')} ${f}`);
  }
  console.log('');

  // Status line
  const gitStr    = result.gitInitialized ? green('git init') : dim('no git');
  const mcpStr    = result.mcpWired       ? green('mcp wired') : yellow('mcp not wired');
  const indexStr  = result.registered     ? green('indexed') : dim('not indexed');
  console.log(`  ${gitStr}  ${dim('·')}  ${mcpStr}  ${dim('·')}  ${indexStr}`);

  // Warnings
  if (result.warnings.length > 0) {
    console.log('');
    for (const w of result.warnings) {
      console.log(`  ${yellow('warn:')} ${w}`);
    }
  }

  // Next steps
  console.log('');
  console.log(`  ${bold('Next steps:')}`);
  console.log(`    ${cyan(`cd ${shortDir}`)}`);
  if (result.gitInitialized) {
    console.log(`    ${dim('# make your first commit')}`);
    console.log(`    ${cyan('git add -A && git commit -m "initial scaffold"')}`);
  }
  console.log(`    ${cyan('ashlr run "get started"')}  ${dim('# kick off a local agent')}`);
  console.log(`    ${cyan('ashlr ship .')}             ${dim('# run pre-ship gate when ready')}`);
  console.log('');
}

function printError(msg: string): void {
  process.stderr.write(red('error: ') + msg + '\n');
}

// ---------------------------------------------------------------------------
// Template list display
// ---------------------------------------------------------------------------

async function cmdNewList(jsonMode: boolean): Promise<number> {
  let listTemplates: () => { id: string; title: string; description: string }[];
  try {
    const mod = await importTemplates();
    listTemplates = mod.listTemplates;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to load templates (M6 module not yet built): ${msg}`);
    return 1;
  }

  let templates = listTemplates();

  // M33: append validated plugin templates (best-effort; builtins always list).
  try {
    const mod = await importTemplates();
    const all = await (mod as { getTemplates?: (cfg?: unknown) => Promise<{ id: string; title: string; description: string }[]> }).getTemplates?.();
    if (all && all.length > templates.length) {
      const known = new Set(templates.map((t) => t.id));
      templates = [
        ...templates,
        ...all.filter((t) => !known.has(t.id)).map((t) => ({ id: t.id, title: t.title, description: t.description })),
      ];
    }
  } catch { /* plugin templates are additive only */ }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(templates, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr new --list') + gray(' — available templates'));
  console.log('');

  const idW    = Math.max(10, ...templates.map(t => t.id.length));
  const titleW = Math.max(10, ...templates.map(t => t.title.length));

  console.log(`  ${bold(padStr('ID', idW))}  ${bold(padStr('Title', titleW))}  ${bold('Description')}`);
  console.log(`  ${'─'.repeat(idW)}  ${'─'.repeat(titleW)}  ${'─'.repeat(40)}`);

  for (const t of templates) {
    console.log(
      `  ${cyan(padStr(t.id, idW))}  ${padStr(t.title, titleW)}  ${dim(t.description)}`
    );
  }

  console.log('');
  console.log(`  ${dim('Use --template <id> to scaffold from a template.')}`);
  console.log(`  ${dim('Example: ashlr new my-project --template mcp-server')}`);
  console.log('');

  return 0;
}

function padStr(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const spaces = Math.max(0, width - visible);
  return s + ' '.repeat(spaces);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * `ashlr new <name> [--template <id>] [--category <c>] [--stack <recipe>]
 *                    [--here] [--no-git] [--json] [--list]`
 *
 * Scaffold a new project with the agentic-engineering layout and register it
 * in the ashlr index. REFUSES to overwrite an existing directory.
 *
 * Returns a process exit code (0 = success, 1 = error, 2 = bad usage).
 */
export async function cmdNew(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp();
    return 0;
  }

  const parsed = parseArgs(args);

  if (parsed.usageError) {
    printError(parsed.usageError);
    process.stderr.write(dim('Run `ashlr new --help` for usage.\n'));
    return 2;
  }

  // --list: show templates and exit
  if (parsed.list) {
    return cmdNewList(parsed.json);
  }

  // Name is required (unless --list)
  if (!parsed.name) {
    printError('Project name is required.');
    process.stderr.write(dim('Usage: ashlr new <name> [--template <id>] [--category <c>] [--stack <recipe>] [--here] [--no-git] [--json]\n'));
    return 2;
  }

  // Validate name
  const nameErr = validateName(parsed.name);
  if (nameErr) {
    printError(nameErr);
    return 2;
  }

  // Validate category — a single in-tree path segment under ~/Desktop/github/.
  // Without this, `--category '../../../../tmp/evil'` would resolve OUTSIDE the
  // github tree and scaffold there. Skipped for --here (cwd-relative scaffold).
  if (!parsed.here) {
    const categoryErr = validateCategory(parsed.category);
    if (categoryErr) {
      printError(categoryErr);
      return 2;
    }
  }

  // Validate stack recipe (defense-in-depth; execFileSync already avoids shell).
  if (parsed.stackRecipe !== undefined) {
    const recipeErr = validateRecipe(parsed.stackRecipe);
    if (recipeErr) {
      printError(recipeErr);
      return 2;
    }
  }

  // Load scaffold + template modules
  let scaffoldProject: (spec: ScaffoldSpec) => ScaffoldResult;
  let targetDir: (name: string, category: string) => string;
  let getTemplate: (id: string) => import('../core/types.js').ProjectTemplate | null;

  try {
    const [scaffoldMod, templatesMod] = await Promise.all([
      importScaffold(),
      importTemplates(),
    ]);
    scaffoldProject = scaffoldMod.scaffoldProject;
    targetDir       = scaffoldMod.targetDir;
    getTemplate     = templatesMod.getTemplate;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to load lifecycle modules (M6 not yet built): ${msg}`);
    return 1;
  }

  // Validate that the requested template exists (builtin first; M33 plugin
  // templates resolved by their prefixed id, e.g. "my-plugin:my-template").
  let tmpl = getTemplate(parsed.templateId);
  if (!tmpl && parsed.templateId.includes(':')) {
    try {
      const templatesMod = await importTemplates();
      const all = await (templatesMod as { getTemplates?: () => Promise<import('../core/types.js').ProjectTemplate[]> }).getTemplates?.();
      tmpl = all?.find((t) => t.id === parsed.templateId) ?? null;
    } catch { /* fall through to the unknown-template error */ }
  }
  if (!tmpl) {
    printError(
      `Unknown template: "${parsed.templateId}". ` +
      `Run \`ashlr new --list\` to see available templates.`
    );
    return 2;
  }

  // Resolve target directory
  let dir: string;
  if (parsed.here) {
    dir = resolve(join(cwd(), parsed.name));
  } else {
    dir = targetDir(parsed.name, parsed.category);

    // SAFETY: belt-and-suspenders — even with a validated category, assert the
    // resolved dir lives strictly inside ~/Desktop/github/ before any write or
    // `git init` can touch the filesystem. Refuses out-of-tree creation.
    const root = resolve(join(homedir(), 'Desktop', 'github'));
    if (!(dir === root || dir.startsWith(root + sep))) {
      printError(
        `Refusing to scaffold outside the github tree.\n` +
        `  Resolved target: ${dir}\n` +
        `  Allowed root:    ${root}`,
      );
      return 2;
    }
  }

  // SAFETY: refuse to overwrite an existing directory
  if (existsSync(dir)) {
    printError(
      `Target directory already exists: ${dir}\n` +
      `  Refusing to overwrite. Choose a different name or category.`
    );
    return 1;
  }

  // Build the scaffold spec
  const spec: ScaffoldSpec = {
    name:         parsed.name,
    category:     parsed.category,
    templateId:   parsed.templateId,
    dir,
    git:          !parsed.noGit,
    stackRecipe:  parsed.stackRecipe,
  };

  // Run the scaffold
  if (!parsed.json) {
    process.stderr.write(dim(`Scaffolding "${parsed.name}" from template "${parsed.templateId}"…\n`));
  }

  let result: ScaffoldResult;
  try {
    result = scaffoldProject(spec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Scaffold failed unexpectedly: ${msg}`);
    return 1;
  }

  if (!result.ok) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      printError(result.error ?? 'Scaffold failed for unknown reason.');
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          process.stderr.write(yellow('warn: ') + w + '\n');
        }
      }
    }
    return 1;
  }

  // Post-scaffold: run stack recipe (best-effort, after scaffold)
  const stackWarnings: string[] = [];
  if (parsed.stackRecipe) {
    if (!parsed.json) {
      process.stderr.write(dim(`Running stack recipe "${parsed.stackRecipe}"…\n`));
    }
    const stackResult = runStackRecipe(result.dir, parsed.stackRecipe);
    if (!stackResult.ok) {
      stackWarnings.push(stackResult.detail);
    } else if (!parsed.json) {
      process.stderr.write(green('stack: ') + stackResult.detail + '\n');
    }
  }

  // Merge any stack warnings into result warnings for JSON output
  const finalResult: ScaffoldResult = stackWarnings.length > 0
    ? { ...result, warnings: [...result.warnings, ...stackWarnings] }
    : result;

  // Output
  if (parsed.json) {
    process.stdout.write(JSON.stringify(finalResult, null, 2) + '\n');
  } else {
    printSuccess(finalResult, parsed.name, parsed.templateId);

    // Surface stack warnings after the summary
    for (const w of stackWarnings) {
      console.log(`  ${yellow('warn:')} ${w}`);
    }
    if (stackWarnings.length > 0) {
      console.log('');
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log('');
  console.log(bold('  ashlr new') + dim(' — scaffold a new project into the ashlr ecosystem'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr new ${cyan('<name>')} [options]`);
  console.log(`    ashlr new ${cyan('--list')} [--json]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['--template <id>',   'Template to use (default: node-cli). See --list for available templates.'],
    ['--category <c>',    'Category under ~/Desktop/github/ (default: side-projects).'],
    ['--stack <recipe>',  'Run a stack recipe after scaffolding (requires `stack` on PATH).'],
    ['--here',            'Scaffold into cwd/<name> instead of the default ~/Desktop/github tree.'],
    ['--no-git',          'Skip `git init` in the new project.'],
    ['--json',            'Emit ScaffoldResult JSON on stdout instead of human output.'],
    ['--list',            'List available templates and exit.'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(padStr(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Templates:'));
  console.log('');
  console.log(`    ${cyan('node-cli')}    Node.js CLI starter with TypeScript + ESM`);
  console.log(`    ${cyan('mcp-server')}  MCP server starter with stdio transport`);
  console.log(`    ${cyan('next-app')}    Next.js app with TypeScript`);
  console.log(`    ${cyan('minimal')}     Bare-bones project with just the agentic-engineering layout`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${gray('# Scaffold a new CLI tool in the default category (side-projects)')}`);
  console.log(`    ashlr new my-tool`);
  console.log('');
  console.log(`    ${gray('# MCP server in the dev-tools category')}`);
  console.log(`    ashlr new my-mcp --template mcp-server --category dev-tools`);
  console.log('');
  console.log(`    ${gray('# Scaffold into current directory (e.g. inside a monorepo)')}`);
  console.log(`    ashlr new my-app --template next-app --here`);
  console.log('');
  console.log(`    ${gray('# Scaffold then provision with a stack recipe')}`);
  console.log(`    ashlr new my-proj --stack my-recipe`);
  console.log('');
  console.log(`    ${gray('# List all available templates')}`);
  console.log(`    ashlr new --list`);
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• REFUSES to overwrite an existing directory (no clobber).')}`);
  console.log(`    ${dim('• Writes ONLY under the target directory.')}`);
  console.log(`    ${dim('• Stack provisioning is best-effort; scaffold succeeds even if stack fails.')}`);
  console.log('');
}
