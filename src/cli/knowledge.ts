/**
 * CLI handler for `ashlr knowledge` and `ashlr impact`.
 *
 *   ashlr knowledge build [--repo <path>] [--allow-cloud]
 *   ashlr knowledge graph [--json]
 *   ashlr impact <file|symbol> [--repo <path>] [--json]
 *
 * All operations are READ-ONLY and LOCAL by default. Indexing/embedding run
 * via the local Ollama provider. Cloud is never used unless --allow-cloud is
 * explicitly passed AND a key exists.
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */

import path from 'node:path';
import { pad, makeColors, isTty } from './ui.js';
import { isEnrolled } from '../core/sandbox/policy.js';

/**
 * Resolve user-supplied repo paths to absolute and partition them by enrollment.
 * ENROLLMENT-SCOPED (docs/contracts/CONTRACT-M25.md invariant 3): only enrolled repos may be
 * indexed/walked. Non-enrolled paths are rejected at the CLI so the user gets a
 * clear error instead of a silent no-op (the core modules also drop them).
 */
function partitionEnrolled(repos: string[]): { enrolled: string[]; rejected: string[] } {
  const enrolled: string[] = [];
  const rejected: string[] = [];
  for (const r of repos) {
    const abs = path.resolve(r);
    if (isEnrolled(abs)) enrolled.push(abs);
    else rejected.push(r);
  }
  return { enrolled, rejected };
}

// ─── Lazy imports (graceful degradation if M25 modules not yet built) ────────

type BuildKnowledgeFn = (opts?: {
  repos?: string[];
  allowCloud?: boolean;
}) => Promise<{ repos: number; chunks: number }>;

type BuildGraphFn = (repos?: string[]) => import('../core/types.js').KnowledgeGraph;

type ImpactFn = (
  target: string,
  repos?: string[],
) => import('../core/types.js').ImpactResult;

let _buildKnowledge: BuildKnowledgeFn | null | undefined = undefined;
let _buildGraph: BuildGraphFn | null | undefined = undefined;
let _impact: ImpactFn | null | undefined = undefined;

async function importKnowledgeIndex(): Promise<BuildKnowledgeFn | null> {
  if (_buildKnowledge === undefined) {
    try {
      const mod = (await import('../core/knowledge/index.js')) as {
        buildKnowledge: BuildKnowledgeFn;
      };
      _buildKnowledge = mod.buildKnowledge;
    } catch {
      _buildKnowledge = null;
    }
  }
  return _buildKnowledge ?? null;
}

async function importGraph(): Promise<{
  buildGraph: BuildGraphFn;
  impact: ImpactFn;
} | null> {
  if (_buildGraph === undefined) {
    try {
      const mod = (await import('../core/knowledge/graph.js')) as {
        buildGraph: BuildGraphFn;
        impact: ImpactFn;
      };
      _buildGraph = mod.buildGraph;
      _impact = mod.impact;
      return { buildGraph: _buildGraph, impact: _impact };
    } catch {
      _buildGraph = null;
      _impact = null;
    }
  }
  if (_buildGraph && _impact) {
    return { buildGraph: _buildGraph, impact: _impact };
  }
  return null;
}

// ─── Help printers ────────────────────────────────────────────────────────────

function printKnowledgeHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr knowledge') + dim(' — Portfolio intelligence: index, graph, and impact'));
  out('');
  out('  ' + bold('Subcommands:'));
  out('');

  const subs: [string, string][] = [
    ['build [--repo <path>] [--allow-cloud]', 'Index enrolled repos (or a single repo) for ask/RAG.'],
    ['graph [--json]',                        'Print the cross-repo knowledge graph (nodes + edges).'],
    ['impact <target> [--repo <path>]',       'What references/depends on a file or symbol? (alias: ashlr impact)'],
  ];
  const w = Math.max(...subs.map(([s]) => s.length));
  for (const [sub, desc] of subs) {
    out(`    ${cyan(pad(sub, w))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--repo <path>', 'Scope to a single enrolled repo (absolute path or name).'],
    ['--allow-cloud', 'Allow cloud synthesis for `ashlr ask`. Indexing is always local.'],
    ['--json',        'Emit structured JSON instead of human-readable output.'],
    ['--help',        'Show this help.'],
  ];
  const ow = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) {
    out(`    ${cyan(pad(flag, ow))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Examples:'));
  out(`    ${cyan('ashlr knowledge build')}                            ${dim('# index all enrolled repos')}`);
  out(`    ${cyan('ashlr knowledge build --repo ~/projects/my-app')}   ${dim('# index one repo')}`);
  out(`    ${cyan('ashlr knowledge graph')}                            ${dim('# print knowledge graph')}`);
  out(`    ${cyan('ashlr knowledge graph --json')}                     ${dim('# JSON graph for tooling')}`);
  out(`    ${cyan('ashlr impact src/core/orchestrator.ts')}            ${dim('# what depends on this?')}`);
  out(`    ${cyan('ashlr impact parseGoal --repo ~/my-app')}           ${dim('# symbol search in one repo')}`);
  out('');
  out('  ' + gray('Enrollment:') + dim(' enroll repos with `ashlr enroll add <path>` before building.'));
  out('');
}

function printImpactHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr impact') + dim(' — Cross-repo reference and dependency analysis'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr impact <file|symbol>')} [--repo <path>] [--json]`);
  out('');
  out('  ' + bold('Examples:'));
  out(`    ${cyan('ashlr impact src/core/run/orchestrator.ts')}`);
  out(`    ${cyan('ashlr impact buildIndex --repo ~/my-app')}`);
  out(`    ${cyan('ashlr impact lodash --json')}  ${dim('# check which repos depend on lodash')}`);
  out('');
}

// ─── Subcommand: build ────────────────────────────────────────────────────────

interface ParsedBuildArgs {
  repos: string[];   // empty = all enrolled
  allowCloud: boolean;
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parseBuildArgs(args: string[]): ParsedBuildArgs {
  const repos: string[] = [];
  let allowCloud = false;
  let json = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--allow-cloud') {
      allowCloud = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--repo') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        error = '--repo requires a path argument';
        break;
      }
      repos.push(next);
    } else if (!a.startsWith('--')) {
      // Bare positional: treat as a repo path
      repos.push(a);
    } else {
      error = `Unknown flag: ${a}`;
      break;
    }
  }

  return { repos, allowCloud, json, help, error };
}

async function runBuild(subArgs: string[]): Promise<number> {
  const parsed = parseBuildArgs(subArgs);

  if (parsed.help) {
    printKnowledgeHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr knowledge --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { bold, cyan, dim, red, yellow, green } = makeColors(tty);

  // ENROLLMENT-SCOPED: reject any user-supplied --repo / positional path that is
  // not enrolled before forwarding to buildKnowledge (no scanning of arbitrary dirs).
  let scopedRepos: string[] | undefined;
  if (parsed.repos.length > 0) {
    const { enrolled, rejected } = partitionEnrolled(parsed.repos);
    if (rejected.length > 0) {
      process.stderr.write(
        red('error: ') +
        'not enrolled: ' + rejected.join(', ') + '\n' +
        '       Only enrolled repos can be indexed. Enroll first: ' +
        'ashlr enroll add <path>\n',
      );
      return 1;
    }
    scopedRepos = enrolled;
  }

  if (parsed.allowCloud && !parsed.json) {
    process.stderr.write(
      yellow('note: ') +
      'indexing/embedding is ALWAYS local — --allow-cloud has no effect on `knowledge build`.\n' +
      '      (It only affects `ashlr ask` synthesis.) No repository code leaves the machine here.\n',
    );
  }

  const buildKnowledge = await importKnowledgeIndex();
  if (!buildKnowledge) {
    process.stderr.write(
      red('error: ') +
      'knowledge build requires src/core/knowledge/index.ts (M25 module not yet built).\n',
    );
    return 1;
  }

  if (!parsed.json) {
    const scopeNote = parsed.repos.length > 0
      ? ` (${parsed.repos.length} repo${parsed.repos.length !== 1 ? 's' : ''})`
      : ' (all enrolled repos)';
    process.stderr.write(dim(`Indexing${scopeNote}…\n`));
  }

  let result: { repos: number; chunks: number };
  try {
    result = await buildKnowledge({
      repos: scopedRepos,
      allowCloud: parsed.allowCloud,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write('\n');
    if (result.repos > 0 && result.chunks === 0) {
      // Incremental no-op: nothing changed since last run. Avoid implying the
      // portfolio is unindexed — it is up to date.
      process.stdout.write(
        `  ${bold('Knowledge index up to date')}  ` +
        `${cyan(String(result.repos))} repo${result.repos !== 1 ? 's' : ''}  ` +
        `${dim('·')}  ${dim('0 new chunks')}\n`,
      );
    } else {
      process.stdout.write(
        `  ${bold('Knowledge indexed')}  ` +
        `${cyan(String(result.repos))} repo${result.repos !== 1 ? 's' : ''}  ` +
        `${dim('·')}  ` +
        `${cyan(String(result.chunks))} new chunk${result.chunks !== 1 ? 's' : ''}\n`,
      );
    }
    if (result.repos === 0) {
      process.stdout.write(
        `\n  ${dim('No enrolled repos found.')} ` +
        `Use ${green('ashlr enroll add <path>')} to enroll a repo first.\n`,
      );
    }
    process.stdout.write('\n');
  }

  return 0;
}

// ─── Subcommand: graph ────────────────────────────────────────────────────────

interface ParsedGraphArgs {
  json: boolean;
  repos: string[];
  help: boolean;
  error: string | undefined;
}

function parseGraphArgs(args: string[]): ParsedGraphArgs {
  const repos: string[] = [];
  let json = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--repo') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        error = '--repo requires a path argument';
        break;
      }
      repos.push(next);
    } else if (!a.startsWith('--')) {
      repos.push(a);
    } else {
      error = `Unknown flag: ${a}`;
      break;
    }
  }

  return { json, repos, help, error };
}

function printGraphHuman(graph: import('../core/types.js').KnowledgeGraph): void {
  const tty = isTty();
  const { bold, cyan, dim, yellow, green } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(
    bold('  Knowledge Graph') +
    dim(`  ${graph.nodes.length} node${graph.nodes.length !== 1 ? 's' : ''}`) +
    dim(` · ${graph.edges.length} edge${graph.edges.length !== 1 ? 's' : ''}`) +
    (graph.crossRepo.length > 0 ? yellow(`  · ${graph.crossRepo.length} cross-repo signal${graph.crossRepo.length !== 1 ? 's' : ''}`) : ''),
  );
  out('');

  if (graph.nodes.length === 0) {
    out(dim('  No nodes. Run `ashlr knowledge build` to index repos first.'));
    out('');
    return;
  }

  // Group nodes by kind
  const byKind = new Map<string, typeof graph.nodes>();
  for (const n of graph.nodes) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, []);
    byKind.get(n.kind)!.push(n);
  }

  for (const [kind, nodes] of byKind) {
    out(`  ${bold(kind.toUpperCase())} ${dim(`(${nodes.length})`)}`);
    for (const n of nodes.slice(0, 20)) {
      out(`    ${cyan(n.label)}  ${dim(n.id)}`);
    }
    if (nodes.length > 20) {
      out(`    ${dim(`… and ${nodes.length - 20} more`)}`);
    }
    out('');
  }

  if (graph.edges.length > 0) {
    out(bold('  Edges') + dim(` (${graph.edges.length})`));
    const edgeW = 40;
    for (const e of graph.edges.slice(0, 30)) {
      out(`    ${pad(cyan(e.from), edgeW)}  ${dim('→')}  ${cyan(e.to)}  ${dim('[' + e.kind + ']')}`);
    }
    if (graph.edges.length > 30) {
      out(`    ${dim(`… and ${graph.edges.length - 30} more edges — use --json for the full graph`)}`);
    }
    out('');
  }

  if (graph.crossRepo.length > 0) {
    out(bold('  Cross-repo signals') + dim(` (${graph.crossRepo.length})`));
    for (const cr of graph.crossRepo) {
      const repoList = cr.repos.join(', ');
      out(`    ${yellow(cr.kind)}  ${cr.detail}  ${dim('[' + repoList + ']')}`);
    }
    out('');
  }

  if (graph.nodes.length === 0) {
    out(dim('  Tip: run `ashlr knowledge build` to populate the graph.'));
    out('');
  } else {
    out(green('  Tip:') + dim(' use `ashlr impact <file|symbol>` to drill into dependencies.'));
    out('');
  }
}

async function runGraph(subArgs: string[]): Promise<number> {
  const parsed = parseGraphArgs(subArgs);

  if (parsed.help) {
    printKnowledgeHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr knowledge --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red } = makeColors(tty);

  // ENROLLMENT-SCOPED: reject non-enrolled --repo / positional paths.
  let scopedRepos: string[] | undefined;
  if (parsed.repos.length > 0) {
    const { enrolled, rejected } = partitionEnrolled(parsed.repos);
    if (rejected.length > 0) {
      process.stderr.write(
        red('error: ') +
        'not enrolled: ' + rejected.join(', ') + '\n' +
        '       Only enrolled repos can be analyzed. Enroll first: ' +
        'ashlr enroll add <path>\n',
      );
      return 1;
    }
    scopedRepos = enrolled;
  }

  const graphMod = await importGraph();
  if (!graphMod) {
    process.stderr.write(
      red('error: ') +
      'knowledge graph requires src/core/knowledge/graph.ts (M25 module not yet built).\n',
    );
    return 1;
  }

  let graph: import('../core/types.js').KnowledgeGraph;
  try {
    graph = graphMod.buildGraph(scopedRepos);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(graph) + '\n');
  } else {
    printGraphHuman(graph);
  }

  return 0;
}

// ─── Subcommand / standalone: impact ─────────────────────────────────────────

interface ParsedImpactArgs {
  target: string;
  repos: string[];
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parseImpactArgs(args: string[]): ParsedImpactArgs {
  let target: string | undefined;
  const repos: string[] = [];
  let json = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--repo') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        error = '--repo requires a path argument';
        break;
      }
      repos.push(next);
    } else if (!a.startsWith('--')) {
      if (target === undefined) {
        target = a;
      } else {
        error = `Unexpected argument: ${a}. Usage: ashlr impact <file|symbol>`;
        break;
      }
    } else {
      error = `Unknown flag: ${a}`;
      break;
    }
  }

  if (!error && !help && target === undefined) {
    error = 'A file or symbol target is required. Usage: ashlr impact <file|symbol>';
  }

  return { target: target ?? '', repos, json, help, error };
}

function printImpactHuman(result: import('../core/types.js').ImpactResult): void {
  const tty = isTty();
  const { bold, cyan, dim, yellow, green, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold(`  Impact: ${cyan(result.target)}`));
  out('');

  if (result.references.length === 0 && result.dependents.length === 0) {
    out(dim('  No references or dependents found for this target.'));
    out(dim('  Run `ashlr knowledge build` to ensure repos are indexed.'));
    out('');
    return;
  }

  if (result.references.length > 0) {
    out(bold(`  References`) + dim(` (${result.references.length})`));
    const fileW = Math.max(
      ...result.references.map(r => `${r.repo}:${r.file}`.length),
      20,
    );
    for (const ref of result.references) {
      const loc = `${ref.repo}:${ref.file}`;
      const lineRef = ref.line > 0 ? yellow(`L${ref.line}`) : dim('—');
      out(`    ${cyan(pad(loc, fileW))}  ${lineRef}`);
    }
    out('');
  }

  if (result.dependents.length > 0) {
    out(bold(`  Dependents`) + dim(` (${result.dependents.length})`));
    for (const dep of result.dependents) {
      out(`    ${green(dep)}`);
    }
    out('');
  }

  if (result.references.length === 0) {
    out(gray('  No direct references found — the target may be a top-level export.'));
    out('');
  }
}

async function runImpact(subArgs: string[]): Promise<number> {
  const parsed = parseImpactArgs(subArgs);

  if (parsed.help) {
    printImpactHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr impact --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red } = makeColors(tty);

  // ENROLLMENT-SCOPED: reject non-enrolled --repo / positional paths.
  let scopedRepos: string[] | undefined;
  if (parsed.repos.length > 0) {
    const { enrolled, rejected } = partitionEnrolled(parsed.repos);
    if (rejected.length > 0) {
      process.stderr.write(
        red('error: ') +
        'not enrolled: ' + rejected.join(', ') + '\n' +
        '       Only enrolled repos can be analyzed. Enroll first: ' +
        'ashlr enroll add <path>\n',
      );
      return 1;
    }
    scopedRepos = enrolled;
  }

  const graphMod = await importGraph();
  if (!graphMod) {
    process.stderr.write(
      red('error: ') +
      'impact requires src/core/knowledge/graph.ts (M25 module not yet built).\n',
    );
    return 1;
  }

  let result: import('../core/types.js').ImpactResult;
  try {
    result = graphMod.impact(
      parsed.target,
      scopedRepos,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    printImpactHuman(result);
  }

  return 0;
}

// ─── Main export: knowledge ───────────────────────────────────────────────────

/**
 * `ashlr knowledge <subcommand> [options]`
 *
 * Subcommands:
 *   build [--repo <path>] [--allow-cloud]  — index enrolled repos
 *   graph [--json]                         — print knowledge graph
 *   impact <target> [--repo <path>]        — reference + dependency analysis
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */
export async function cmdKnowledge(args: string[]): Promise<number> {
  const sub = args[0];
  const subArgs = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printKnowledgeHelp();
    return 0;
  }

  switch (sub) {
    case 'build':
      return runBuild(subArgs);

    case 'graph':
      return runGraph(subArgs);

    case 'impact':
      // `ashlr knowledge impact <target>` — delegate to the same handler
      // as standalone `ashlr impact <target>`
      return runImpact(subArgs);

    default:
      // If the first arg looks like a positional (no --), treat it as
      // `build` so `ashlr knowledge` (no subcommand) is slightly friendlier.
      if (!sub.startsWith('--')) {
        process.stderr.write(`error: Unknown knowledge subcommand: ${sub}\n`);
        process.stderr.write('Run `ashlr knowledge --help` for usage.\n');
        return 2;
      }
      // Flags with no subcommand: default to help
      printKnowledgeHelp();
      return 0;
  }
}

/**
 * `ashlr impact <file|symbol> [--repo <path>] [--json]`
 *
 * Standalone alias for `ashlr knowledge impact`. What references or depends on
 * the given target, within and across enrolled repos?
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */
export async function cmdImpact(args: string[]): Promise<number> {
  return runImpact(args);
}
