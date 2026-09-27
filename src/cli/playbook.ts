/**
 * `ashlr playbook` — versioned task templates every lane runs under
 * (src/core/playbooks/**).
 *
 *   ashlr playbook list [--json]
 *   ashlr playbook show <id>[@vN] [--source] [--json]
 *   ashlr playbook new <id> [--file path] [--note "why"]
 *   ashlr playbook edit <id> [--file path] [--note "why"]
 *   ashlr playbook run <id>[@vN] [--repo owner/name] [--lane cloud|devin] [--task "text"] [--title t] [--base branch] [--json]
 *
 * `new` / `edit` open $VISUAL / $EDITOR on the template or the latest version
 * unless `--file` (or piped stdin) supplies the markdown. An edit always
 * writes a NEW version; nothing is ever rewritten. `run` launches a cloud
 * (default) or Devin task pinned to the playbook — through the same service
 * (and every gate) as `ashlr cloud launch` / `ashlr devin launch`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CloudLaunchRequest, CloudLaunchResponse } from '../core/cloud/types.js';
import type { DevinLaunchRequest, DevinLaunchResponse } from '../core/devin/types.js';
import type { PlaybookOutcomeCounts, PlaybookSummary, PlaybookV1, PlaybookVersionInfo } from '../core/playbooks/types.js';
import type { SavePlaybookOptions, SavePlaybookResult } from '../core/playbooks/store.js';
import { isTty, makeColors, pad } from './ui.js';

export const PLAYBOOK_USAGE = [
  'Usage: ashlr playbook list [--json]',
  '       ashlr playbook show <id>[@vN] [--source] [--json]',
  '       ashlr playbook new <id> [--file path] [--note "why"]',
  '       ashlr playbook edit <id> [--file path] [--note "why"]',
  '       ashlr playbook run <id>[@vN] [--repo owner/name] [--lane cloud|devin] [--task "text"] [--title t] [--base branch] [--json]',
  '',
  'In any task text (Verse composer, goals, `ashlr cloud launch`), `!macro` (e.g. `!fix-bug`) runs under that playbook.',
].join('\n');

export interface PlaybookCliDeps {
  list: () => Promise<PlaybookSummary[]>;
  get: (id: string, version: number | null) => Promise<PlaybookV1 | null>;
  versions: (id: string) => Promise<PlaybookVersionInfo[]>;
  outcomes: (id: string) => Promise<Map<number, PlaybookOutcomeCounts>>;
  save: (source: string, opts: SavePlaybookOptions) => Promise<SavePlaybookResult>;
  render: (pb: PlaybookV1) => string;
  template: (id: string) => string;
  launchCloud: (req: CloudLaunchRequest) => Promise<CloudLaunchResponse>;
  launchDevin: (req: DevinLaunchRequest) => Promise<DevinLaunchResponse>;
  originRepo: (cwd: string) => string | null;
  /** Open an editor on `initial`; the edited text, or null when aborted. */
  edit: (initial: string) => string | null;
  readFile: (path: string) => string;
  /** Piped stdin, or null on a TTY. */
  readStdin: () => string | null;
  cwd: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
  color: boolean;
}

function editWithEditor(initial: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-playbook-'));
  const file = join(dir, 'playbook.md');
  try {
    writeFileSync(file, initial, { encoding: 'utf8', mode: 0o600 });
    const editor = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
    const r = spawnSync(editor, [file], { stdio: 'inherit', shell: /\s/.test(editor) });
    if (r.status !== 0) return null;
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readPipedStdin(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

async function defaultDeps(): Promise<PlaybookCliDeps> {
  const [store, resolve, parse, stats, cloudCli] = await Promise.all([
    import('../core/playbooks/store.js'),
    import('../core/playbooks/resolve.js'),
    import('../core/playbooks/parse.js'),
    import('../core/playbooks/stats.js'),
    import('./cloud.js'),
  ]);
  return {
    list: () => store.listPlaybookSummaries(),
    get: (id, version) => store.getPlaybook(id, version),
    versions: (id) => store.listPlaybookVersions(id),
    outcomes: (id) => stats.playbookOutcomes(id),
    save: (source, opts) => store.savePlaybook(source, opts),
    render: (pb) => resolve.renderPlaybookBlock(pb),
    template: (id) => parse.playbookTemplate(id),
    launchCloud: async (req) => (await import('../core/cloud/service.js')).launchCloudTask(req),
    launchDevin: async (req) => (await import('../core/devin/service.js')).launchDevinTask(req),
    originRepo: (cwd) => cloudCli.readOriginRepo(cwd),
    edit: editWithEditor,
    readFile: (path) => readFileSync(path, 'utf8'),
    readStdin: readPipedStdin,
    cwd: () => process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    color: isTty(),
  };
}

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set(['--file', '--note', '--repo', '--lane', '--task', '--title', '--base']);
const BOOL_FLAGS = new Set(['--json', '--source']);

export function parsePlaybookArgs(args: readonly string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : args[i + 1];
      if (eq <= 0) i += 1;
      if (value === undefined || (eq <= 0 && value.startsWith('--'))) throw new UsageError(`${name} needs a value`);
      out.flags.set(name, value);
    } else if (BOOL_FLAGS.has(arg)) {
      out.bools.add(arg);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function parseRef(text: string | undefined): { id: string; version: number | null } {
  const m = /^!?([a-z0-9][a-z0-9-]{1,47})(?:@v?(\d{1,6}))?$/.exec((text ?? '').trim());
  if (!m) throw new UsageError('name a playbook id, e.g. `fix-issue` or `fix-issue@v2`');
  return { id: m[1]!, version: m[2] ? Number(m[2]) : null };
}

function outcomeText(o: PlaybookOutcomeCounts | undefined): string {
  if (!o || o.total === 0) return 'no finished runs';
  return `${o.merged} merged · ${o.refused} refused · ${o.reverted} reverted · ${o.failed} failed`;
}

async function cmdList(deps: PlaybookCliDeps, p: Parsed): Promise<number> {
  const rows = await deps.list();
  if (p.bools.has('--json')) {
    deps.out(JSON.stringify({ v: 1, playbooks: rows }, null, 2));
    return 0;
  }
  const { bold, dim } = makeColors(deps.color);
  if (rows.length === 0) {
    deps.out('No playbooks.');
    return 0;
  }
  const idW = Math.max(...rows.map((r) => r.id.length), 2);
  const macroW = Math.max(...rows.map((r) => r.macro.length), 5);
  deps.out(bold(`${pad('ID', idW)}  ${pad('MACRO', macroW)}  VER  NAME`));
  for (const r of rows) {
    const flags = [r.builtin ? 'built-in' : null, r.auto ? 'auto' : null].filter(Boolean).join(', ');
    deps.out(`${pad(r.id, idW)}  ${pad(r.macro, macroW)}  ${pad(`v${r.latest}`, 3)}  ${r.name}${flags ? dim(` (${flags})`) : ''}`);
  }
  return 0;
}

async function cmdShow(deps: PlaybookCliDeps, p: Parsed): Promise<number> {
  const ref = parseRef(p.positional[0]);
  const pb = await deps.get(ref.id, ref.version);
  if (!pb) {
    deps.err(ref.version === null ? `No playbook named ${ref.id}.` : `${ref.id} has no version ${ref.version}.`);
    return 1;
  }
  const [versions, outcomes] = await Promise.all([deps.versions(ref.id), deps.outcomes(ref.id)]);
  if (p.bools.has('--json')) {
    deps.out(JSON.stringify({
      v: 1, playbook: pb, rendered: deps.render(pb),
      versions: versions.map((v) => ({ ...v, outcomes: outcomes.get(v.version) ?? null })),
    }, null, 2));
    return 0;
  }
  if (p.bools.has('--source')) {
    deps.out(pb.source.trimEnd());
    return 0;
  }
  const { bold, dim } = makeColors(deps.color);
  deps.out(bold(`${pb.meta.name} — ${pb.meta.id}@v${pb.version} (${pb.meta.macro})`));
  if (pb.meta.description) deps.out(dim(pb.meta.description));
  deps.out('');
  deps.out(deps.render(pb));
  deps.out('');
  deps.out(bold('Versions'));
  for (const v of [...versions].reverse()) {
    deps.out(`  v${v.version}  ${v.createdAt.slice(0, 10)}  ${v.sha}  ${outcomeText(outcomes.get(v.version))}${v.note ? dim(`  — ${v.note}`) : ''}`);
  }
  return 0;
}

function sourceFor(deps: PlaybookCliDeps, p: Parsed, initial: string): string | null {
  const file = p.flags.get('--file');
  if (file) return deps.readFile(file);
  const piped = deps.readStdin();
  if (piped !== null && piped.trim()) return piped;
  return deps.edit(initial);
}

function reportSave(deps: PlaybookCliDeps, result: SavePlaybookResult): number {
  if (!result.ok) {
    deps.err('Not saved:');
    for (const e of result.errors) deps.err(`  - ${e.field}: ${e.message}`);
    return 1;
  }
  deps.out(`Saved ${result.playbook.meta.id}@v${result.playbook.version} (${result.playbook.meta.macro}, sha ${result.playbook.sha}).`);
  return 0;
}

async function cmdNew(deps: PlaybookCliDeps, p: Parsed): Promise<number> {
  const { id } = parseRef(p.positional[0]);
  const source = sourceFor(deps, p, deps.template(id));
  if (source === null) {
    deps.err('Editor closed without saving; nothing written.');
    return 1;
  }
  if (!new RegExp(`^id:\\s*${id}\\s*$`, 'm').test(source)) {
    deps.err(`The playbook's front-matter must say \`id: ${id}\`.`);
    return 1;
  }
  const note = p.flags.get('--note');
  return reportSave(deps, await deps.save(source, { createOnly: true, author: 'cli', ...(note ? { note } : {}) }));
}

async function cmdEdit(deps: PlaybookCliDeps, p: Parsed): Promise<number> {
  const { id } = parseRef(p.positional[0]);
  const current = await deps.get(id, null);
  if (!current) {
    deps.err(`No playbook named ${id}. Create it with \`ashlr playbook new ${id}\`.`);
    return 1;
  }
  const source = sourceFor(deps, p, current.source);
  if (source === null) {
    deps.err('Editor closed without saving; nothing written.');
    return 1;
  }
  const note = p.flags.get('--note');
  return reportSave(deps, await deps.save(source, {
    editOnly: true, baseVersion: current.version, author: 'cli', ...(note ? { note } : {}),
  }));
}

async function cmdRun(deps: PlaybookCliDeps, p: Parsed): Promise<number> {
  const ref = parseRef(p.positional[0]);
  const pb = await deps.get(ref.id, ref.version);
  if (!pb) {
    deps.err(ref.version === null ? `No playbook named ${ref.id}.` : `${ref.id} has no version ${ref.version}.`);
    return 1;
  }
  const repo = p.flags.get('--repo') ?? deps.originRepo(deps.cwd());
  if (!repo) throw new UsageError('pass --repo owner/name (this folder has no GitHub origin)');
  const lane = p.flags.get('--lane') ?? 'cloud';
  if (lane !== 'cloud' && lane !== 'devin') throw new UsageError('--lane is cloud or devin');
  const task = p.flags.get('--task')?.trim() || `Run the “${pb.meta.name}” playbook on ${repo}.`;
  const base = p.flags.get('--base');
  const req = {
    repo,
    prompt: task,
    title: p.flags.get('--title') ?? pb.meta.name,
    origin: 'cli' as const,
    playbook: `${pb.meta.id}@v${pb.version}`,
    ...(base ? { baseBranch: base } : {}),
  };
  const result = lane === 'cloud' ? await deps.launchCloud(req) : await deps.launchDevin(req);
  if (p.bools.has('--json')) {
    deps.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok || !result.task) {
    deps.err(`Not launched: ${result.error ?? 'the session could not be started.'}`);
    return 1;
  }
  deps.out(`Launched ${lane} task ${result.task.id} under ${pb.meta.id}@v${pb.version}.`);
  if (result.task.sessionUrl) deps.out(`Session: ${result.task.sessionUrl}`);
  return 0;
}

export async function runPlaybookCli(args: string[], injected?: Partial<PlaybookCliDeps>): Promise<number> {
  const [sub = 'list', ...rest] = args;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(PLAYBOOK_USAGE);
    return 0;
  }
  const deps: PlaybookCliDeps = { ...(await defaultDeps()), ...injected };
  try {
    const parsed = parsePlaybookArgs(rest);
    switch (sub) {
      case 'list':
      case 'ls': return await cmdList(deps, parsed);
      case 'show': return await cmdShow(deps, parsed);
      case 'new': return await cmdNew(deps, parsed);
      case 'edit': return await cmdEdit(deps, parsed);
      case 'run': return await cmdRun(deps, parsed);
      default: throw new UsageError(`unknown subcommand ${sub}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`error: ${err.message}\n${PLAYBOOK_USAGE}`);
      return 2;
    }
    throw err;
  }
}
