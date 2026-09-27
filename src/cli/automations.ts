/**
 * `ashlr automations` (3.15) — standing instructions that turn labelled
 * issues, red default branches, schedules, local webhooks and Telegram
 * `/task`s into work for a lane.
 *
 *   ashlr automations list [--json]
 *   ashlr automations templates
 *   ashlr automations add --template <id> [--name "…"] [--repos o/n,o/n|*] [--lane fleet|cloud|devin|leader-review] [--enable]
 *   ashlr automations add --file <automation.json> [--enable]
 *   ashlr automations enable|disable|remove <id>
 *   ashlr automations fire <id> [--dry-run] [--repo o/n] [--text "…"] [--title "…"]
 *
 * Every write goes through src/core/automations (validated, 0600 under
 * ~/.ashlr/automations). `fire` hands work to lanes through their own entry
 * points — the standing grant, KILL, the lane budgets and the automation's
 * limits all apply; `--dry-run` reads GitHub and writes nothing.
 */
import { readFile } from 'node:fs/promises';

import {
  AUTOMATION_LANES,
  AUTOMATION_TEMPLATES,
  AutomationInputError,
  automationsOverview,
  automationTemplate,
  createAutomation,
  deleteAutomation,
  disableAutomation,
  enableAutomation,
  fireAutomation,
  type AutomationEngineDeps,
  type AutomationInput,
  type AutomationView,
} from '../core/automations/index.js';

export const AUTOMATIONS_USAGE = [
  'Usage: ashlr automations <command>',
  '',
  '  list [--json]                         Automations with last fired, next run, queue, spend, success rate',
  '  templates                             Starting points for `add --template`',
  '  add --template <id> [--name "…"] [--repos o/n,o/n|*] [--lane <lane>] [--enable]',
  '  add --file <automation.json> [--enable]',
  '  enable <id> | disable <id> | remove <id>',
  '  fire <id> [--dry-run] [--repo o/n] [--text "…"] [--title "…"]',
  '',
  `Lanes: ${AUTOMATION_LANES.join(', ')}. New automations start disabled unless --enable.`,
].join('\n');

export interface AutomationsCliDeps {
  engine: AutomationEngineDeps;
  readFile: (path: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--template', '--name', '--repos', '--lane', '--file', '--repo', '--text', '--title']);
const BOOL_FLAGS = new Set(['--json', '--enable', '--dry-run']);

function parse(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw new UsageError(`${name} takes no value.`);
        flags.set(name, true);
      } else if (VALUE_FLAGS.has(name)) {
        const value = eq !== -1 ? arg.slice(eq + 1) : args[++i];
        if (value === undefined || value === '') throw new UsageError(`${name} needs a value.`);
        flags.set(name, value);
      } else {
        throw new UsageError(`Unknown flag ${name}.`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

function clean(text: string): string {
  const home = process.env['HOME'];
  return home && home.length > 1 ? text.split(home).join('~') : text;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function viewLines(view: AutomationView): string[] {
  const { automation: a, stats: s } = view;
  const rate = s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}% (${s.succeeded}/${s.succeeded + s.failed})`;
  return [
    `${a.enabled ? '●' : '○'} ${a.id}  ${a.name}  → ${a.lane}${a.playbookId ? ` (playbook ${a.playbookId})` : ''}`,
    `    ${view.triggerSummary}`,
    `    last fired ${when(s.lastFiredAt)} · next ${when(s.nextRunAt)} · queue ${s.queued}/${a.queueDepth} · in flight ${s.active}/${a.maxConcurrent} · today ${s.firedToday}/${a.maxPerDay} · spend $${s.spentThisMonthUsd.toFixed(2)}/$${a.spendCapUsd.toFixed(2)} this month · success ${rate}`,
    ...(s.lastError ? [`    ! ${s.lastError}`] : []),
  ];
}

async function cmdList(deps: AutomationsCliDeps, p: Parsed): Promise<number> {
  if (p.positional.length > 0) throw new UsageError('list takes no arguments.');
  const overview = await automationsOverview({ schedulerRunning: false, ...(deps.engine.now ? { now: deps.engine.now() } : {}) });
  if (p.flags.has('--json')) {
    deps.out(JSON.stringify({ automations: overview.automations, firings: overview.firings.slice(0, 50) }, null, 2));
    return 0;
  }
  if (overview.automations.length === 0) {
    deps.out('No automations yet. Start from a template: ashlr automations templates');
    return 0;
  }
  for (const view of overview.automations) for (const line of viewLines(view)) deps.out(line);
  return 0;
}

function cmdTemplates(deps: AutomationsCliDeps): number {
  for (const t of AUTOMATION_TEMPLATES) deps.out(`${t.id.padEnd(26)} ${t.name} — ${t.blurb}`);
  return 0;
}

async function cmdAdd(deps: AutomationsCliDeps, p: Parsed): Promise<number> {
  if (p.positional.length > 0) throw new UsageError('add takes flags only.');
  const templateId = str(p, '--template');
  const file = str(p, '--file');
  if ((templateId === undefined) === (file === undefined)) throw new UsageError('add needs exactly one of --template <id> or --file <path>.');
  let input: Record<string, unknown>;
  if (templateId !== undefined) {
    const template = automationTemplate(templateId);
    if (!template) throw new UsageError(`No template "${templateId}". See: ashlr automations templates`);
    input = { ...(template.input as AutomationInput) };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await deps.readFile(file!));
    } catch {
      deps.err(`Could not read ${clean(file!)} as JSON.`);
      return 1;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      deps.err('The file must hold one automation object.');
      return 1;
    }
    input = parsed as Record<string, unknown>;
  }
  const name = str(p, '--name');
  if (name !== undefined) input['name'] = name;
  const repos = str(p, '--repos');
  if (repos !== undefined) input['repos'] = repos.split(',').map((r) => r.trim()).filter((r) => r !== '');
  const lane = str(p, '--lane');
  if (lane !== undefined) input['lane'] = lane;
  if (p.flags.has('--enable')) input['enabled'] = true;
  const automation = await createAutomation(input);
  deps.out(`Created ${automation.id} (${automation.enabled ? 'enabled' : 'disabled — turn it on with: ashlr automations enable ' + automation.id}).`);
  return 0;
}

async function cmdSwitch(deps: AutomationsCliDeps, p: Parsed, verb: 'enable' | 'disable' | 'remove'): Promise<number> {
  const [id, extra] = p.positional;
  if (!id || extra !== undefined) throw new UsageError(`${verb} needs exactly one automation id.`);
  if (verb === 'remove') {
    if (!(await deleteAutomation(id))) { deps.err(`No automation ${id}.`); return 1; }
    deps.out(`Removed ${id} (its history stays in the journal).`);
    return 0;
  }
  const automation = verb === 'enable' ? await enableAutomation(id) : await disableAutomation(id);
  if (!automation) { deps.err(`No automation ${id}.`); return 1; }
  deps.out(`${automation.id} is ${automation.enabled ? 'enabled' : 'disabled'}.`);
  return 0;
}

async function cmdFire(deps: AutomationsCliDeps, p: Parsed): Promise<number> {
  const [id, extra] = p.positional;
  if (!id || extra !== undefined) throw new UsageError('fire needs exactly one automation id.');
  const dryRun = p.flags.has('--dry-run');
  const repo = str(p, '--repo');
  const text = str(p, '--text');
  const title = str(p, '--title');
  const result = await fireAutomation(id, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(title !== undefined ? { title } : {}),
  }, deps.engine);
  if (!result.ok) {
    deps.err(clean(result.error ?? 'The automation did not fire.'));
    return 1;
  }
  if (dryRun) {
    if (result.planned.length === 0) deps.out('Dry run: nothing to fire right now.');
    for (const t of result.planned) deps.out(`dry run · ${t.repo} · ${t.title} → ${t.verdict}`);
    return 0;
  }
  if (result.firings.length === 0 && result.planned.length === 0) deps.out('Nothing to fire right now.');
  for (const t of result.planned) deps.out(`${t.repo} · ${t.title} → ${t.verdict}`);
  for (const f of result.firings) {
    const link = f.laneRef?.url ?? f.source.url;
    deps.out(`${f.state.padEnd(15)} ${f.repo} · ${f.title}${f.reason ? ` — ${f.reason}` : ''}${link ? ` (${link})` : ''}`);
  }
  return 0;
}

export async function runAutomationsCli(argv: string[], injected: Partial<AutomationsCliDeps> = {}): Promise<number> {
  const deps: AutomationsCliDeps = {
    engine: injected.engine ?? {},
    readFile: injected.readFile ?? ((path) => readFile(path, 'utf8')),
    out: injected.out ?? ((line) => console.log(line)),
    err: injected.err ?? ((line) => console.error(line)),
  };
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    (sub ? deps.out : deps.err)(AUTOMATIONS_USAGE);
    return sub ? 0 : 2;
  }
  try {
    const p = parse(rest);
    switch (sub) {
      case 'list':
      case 'ls': return await cmdList(deps, p);
      case 'templates': return cmdTemplates(deps);
      case 'add': return await cmdAdd(deps, p);
      case 'enable': return await cmdSwitch(deps, p, 'enable');
      case 'disable': return await cmdSwitch(deps, p, 'disable');
      case 'remove': return await cmdSwitch(deps, p, 'remove');
      case 'fire': return await cmdFire(deps, p);
      default:
        deps.err(`Unknown automations command "${sub}".\n\n${AUTOMATIONS_USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n\n${AUTOMATIONS_USAGE}`);
      return 2;
    }
    if (err instanceof AutomationInputError) {
      deps.err(err.message);
      return 1;
    }
    deps.err(`automations ${sub} failed: ${clean(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}
