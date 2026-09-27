/**
 * `ashlr wiki` — a private, local architecture wiki per enrolled repo.
 *
 *   ashlr wiki build [repo] [--all] [--force] [--no-model] [--pages N] [--tokens N] [--json]
 *   ashlr wiki status [repo] [--json]
 *   ashlr wiki show <repo> [page]
 *   ashlr wiki ask "<question>" [--repo <path|name>] [--no-model] [--json]
 *
 * Pages live in ~/.ashlr/knowledge/wiki/<repo>/ — never in the repo, never on
 * a server. Generation routes through the seat plan (local models first; grok
 * only where the grant and the repo allow; never Claude) and falls back to
 * facts-only pages when no model may see the code.
 *
 * Exit codes: 0 ok, 1 failure, 2 bad usage.
 */

import path from 'node:path';

import { loadConfigReadOnly } from '../core/config.js';
import type { AshlrConfig } from '../core/types.js';
import { makeColors, isTty } from './ui.js';

type WikiModule = typeof import('../core/knowledge/wiki/index.js');

interface Parsed {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set(['--repo', '--pages', '--tokens']);

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v !== undefined) values.set(a, v);
      i++;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0 && VALUE_FLAGS.has(a.slice(0, eq))) values.set(a.slice(0, eq), a.slice(eq + 1));
      else flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, values };
}

function positiveInt(v: string | undefined): number | undefined | null {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A repo argument may be a path or an enrolled repo's name. */
function resolveRepo(wiki: WikiModule, arg: string | undefined): { repo: string } | { error: string } {
  const enrolled = wiki.wikiCandidateRepos();
  if (arg === undefined) {
    const cwd = process.cwd();
    const hit = enrolled.find((r) => cwd === r || cwd.startsWith(r + path.sep));
    return hit ? { repo: hit } : { error: 'Not inside an enrolled repo — pass a repo path or name, or --all.' };
  }
  const abs = path.resolve(arg);
  const byPath = enrolled.find((r) => r === abs);
  if (byPath) return { repo: byPath };
  const byName = enrolled.filter((r) => path.basename(r) === arg);
  if (byName.length === 1) return { repo: byName[0]! };
  if (byName.length > 1) return { error: `"${arg}" matches ${byName.length} enrolled repos — pass the full path.` };
  return { error: `${arg} is not an enrolled repo (see \`ashlr enroll list\`).` };
}

/** Citations render as plain `file:line` in a terminal. */
function plainCitations(md: string): string {
  return md.replace(/\[([^\]]+)\]\(#(?:cite|page):[^)]+\)/g, '$1');
}

function printHelp(): void {
  const { bold, cyan, dim } = makeColors(isTty());
  const out = (s = ''): void => void process.stdout.write(`${s}\n`);
  out('');
  out(`${bold('  ashlr wiki')}${dim(' — a private architecture wiki per repo, with cited answers')}`);
  out('');
  out(`    ${cyan('build [repo] [--all]')}         Generate or refresh (only stale pages are rebuilt).`);
  out(`    ${cyan('status [repo]')}                Freshness: generated at <commit>, N pages stale.`);
  out(`    ${cyan('show <repo> [page]')}           Print a page (default: overview).`);
  out(`    ${cyan('ask "<question>" [--repo r]')}  Answer from the wiki, index and genome with file:line citations.`);
  out('');
  out(`    ${dim('--force        regenerate every page')}`);
  out(`    ${dim('--no-model     facts-only pages / extractive answers; no model sees the code')}`);
  out(`    ${dim('--pages N      max model calls this run (default foundry.wiki.pageBudget, 8)')}`);
  out(`    ${dim('--tokens N     max estimated tokens this run (default foundry.wiki.tokenBudget, 60000)')}`);
  out(`    ${dim('--json         structured output')}`);
  out('');
  out(dim('  Steer it with .ashlr/wiki.json in the repo (.devin/wiki.json is read too).'));
  out('');
}

function loadCfg(): AshlrConfig | undefined {
  try {
    return loadConfigReadOnly();
  } catch {
    return undefined;
  }
}

async function cmdBuild(wiki: WikiModule, p: Parsed): Promise<number> {
  const { green, yellow, red, dim, bold } = makeColors(isTty());
  const json = p.flags.has('--json');
  const pages = positiveInt(p.values.get('--pages'));
  const tokens = positiveInt(p.values.get('--tokens'));
  if (pages === null || tokens === null) {
    process.stderr.write('--pages and --tokens take a positive integer.\n');
    return 2;
  }
  let repos: string[];
  if (p.flags.has('--all')) {
    repos = wiki.wikiCandidateRepos();
    if (repos.length === 0) {
      process.stderr.write('No enrolled repos. Enroll one with `ashlr enroll add <path>`.\n');
      return 1;
    }
  } else {
    const r = resolveRepo(wiki, p.positional[0]);
    if ('error' in r) {
      process.stderr.write(`${r.error}\n`);
      return 2;
    }
    repos = [r.repo];
  }
  const cfg = loadCfg();
  const results = [];
  let failed = 0;
  for (const repo of repos) {
    if (!json) process.stdout.write(`${bold(path.basename(repo))} ${dim(repo)}\n`);
    const res = await wiki.buildWiki({
      repo,
      ...(cfg ? { cfg } : {}),
      ...(p.flags.has('--force') ? { force: true } : {}),
      ...(p.flags.has('--no-model') ? { noModel: true } : {}),
      ...(pages !== undefined ? { pageBudget: pages } : {}),
      ...(tokens !== undefined ? { tokenBudget: tokens } : {}),
      onProgress: json ? undefined : (ev) => {
        const mark = ev.action === 'generated' ? green('✓') : ev.action === 'fresh' ? dim('·') : ev.action === 'failed' ? red('✗') : yellow('○');
        process.stdout.write(`  ${mark} ${ev.page} ${dim(ev.action)}\n`);
      },
    });
    results.push({ repo, ...res });
    if (!res.ok) {
      failed++;
      if (!json) process.stdout.write(`  ${red('✗')} ${res.reason}\n`);
      continue;
    }
    if (!json) {
      const s = res.summary;
      process.stdout.write(
        `  ${green('done')} ${s.generated} generated · ${s.skippedFresh} fresh · ${s.deferred} deferred · engine ${s.engine}` +
          `${s.budgetStop ? yellow(` · stopped at the ${s.budgetStop} budget`) : ''}\n`,
      );
      if (s.modelNote) process.stdout.write(`  ${dim(s.modelNote)}\n`);
    }
  }
  if (json) process.stdout.write(`${JSON.stringify(results.map((r) => (r.ok ? { repo: r.repo, ok: true, summary: r.summary, pages: r.manifest.pages.length, pending: r.manifest.pending } : r)), null, 2)}\n`);
  return failed > 0 ? 1 : 0;
}

async function cmdStatus(wiki: WikiModule, p: Parsed): Promise<number> {
  const { green, yellow, dim, bold } = makeColors(isTty());
  const json = p.flags.has('--json');
  let repos: string[];
  if (p.positional[0] !== undefined) {
    const r = resolveRepo(wiki, p.positional[0]);
    if ('error' in r) {
      process.stderr.write(`${r.error}\n`);
      return 2;
    }
    repos = [r.repo];
  } else {
    repos = wiki.wikiCandidateRepos();
  }
  const statuses = await Promise.all(repos.map((r) => wiki.wikiStatus(r)));
  if (json) {
    process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
    return 0;
  }
  if (statuses.length === 0) process.stdout.write('No enrolled repos.\n');
  for (const s of statuses) {
    if (!s.exists) {
      process.stdout.write(`${bold(s.repoName)}  ${dim('no wiki yet — ashlr wiki build ' + s.repoName)}\n`);
      continue;
    }
    const at = s.generatedCommit ? s.generatedCommit.slice(0, 8) : 'no commit';
    const fresh = s.stalePages === 0 ? green('fresh') : yellow(`${s.stalePages} of ${s.pages.length} pages stale`);
    process.stdout.write(`${bold(s.repoName)}  generated at ${at}${s.currentCommit && s.currentCommit !== s.generatedCommit ? dim(` (HEAD ${s.currentCommit.slice(0, 8)})`) : ''} · ${fresh}\n`);
  }
  return 0;
}

async function cmdShow(wiki: WikiModule, p: Parsed): Promise<number> {
  const r = resolveRepo(wiki, p.positional[0]);
  if ('error' in r) {
    process.stderr.write(`${r.error}\n`);
    return 2;
  }
  const page = p.positional[1] ?? 'overview';
  if (!wiki.isPageId(page)) {
    process.stderr.write(`"${page}" is not a page id.\n`);
    return 2;
  }
  const md = await wiki.readPage(wiki.wikiKey(r.repo), page);
  if (md === null) {
    const m = await wiki.readManifest(wiki.wikiKey(r.repo));
    process.stderr.write(m ? `No page "${page}". Pages: ${m.pages.map((x) => x.id).join(', ')}\n` : `No wiki yet — run \`ashlr wiki build ${path.basename(r.repo)}\`.\n`);
    return 1;
  }
  process.stdout.write(`${plainCitations(md)}\n`);
  return 0;
}

async function cmdAsk(wiki: WikiModule, p: Parsed): Promise<number> {
  const { green, yellow, dim, bold } = makeColors(isTty());
  const question = p.positional.join(' ').trim();
  if (!question) {
    process.stderr.write('Usage: ashlr wiki ask "<question>" [--repo <path|name>]\n');
    return 2;
  }
  let repo: string | undefined;
  const repoArg = p.values.get('--repo');
  if (repoArg !== undefined) {
    const r = resolveRepo(wiki, repoArg);
    if ('error' in r) {
      process.stderr.write(`${r.error}\n`);
      return 2;
    }
    repo = r.repo;
  }
  const cfg = loadCfg();
  const res = await wiki.askWiki({ question, ...(repo ? { repo } : {}), ...(cfg ? { cfg } : {}), ...(p.flags.has('--no-model') ? { noModel: true } : {}) });
  if (p.flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.status === 'not-found' ? 1 : 0;
  }
  const label = res.status === 'answered' ? green('answer') : res.status === 'extractive' ? yellow('passages') : yellow('not found');
  process.stdout.write(`\n${bold(label)}${res.repoName ? dim(` · ${res.repoName}`) : ''}${res.engine !== 'none' ? dim(` · ${res.engine}${res.local ? ' (local)' : ''}`) : ''}\n\n`);
  process.stdout.write(`${plainCitations(res.answer)}\n`);
  if (res.sources.length > 0) {
    process.stdout.write(`\n${dim('sources')}\n`);
    for (const s of res.sources.slice(0, 8)) process.stdout.write(`  ${s.file}:${s.line}${s.endLine ? `-${s.endLine}` : ''} ${dim(`(${s.via}${s.title ? `: ${s.title}` : ''})`)}\n`);
  }
  if (res.alsoIn.length > 0) process.stdout.write(`\n${dim(`also relevant: ${res.alsoIn.map((a) => a.repoName).join(', ')}`)}\n`);
  if (res.droppedCitations > 0) process.stdout.write(dim(`\n${res.droppedCitations} unverifiable citation(s) removed.\n`));
  return res.status === 'not-found' ? 1 : 0;
}

export async function cmdWiki(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
    return sub === undefined ? 2 : 0;
  }
  const wiki = await import('../core/knowledge/wiki/index.js');
  const p = parse(rest);
  switch (sub) {
    case 'build':
      return cmdBuild(wiki, p);
    case 'status':
    case 'list':
      return cmdStatus(wiki, p);
    case 'show':
      return cmdShow(wiki, p);
    case 'ask':
      return cmdAsk(wiki, p);
    default:
      process.stderr.write(`Unknown subcommand "${sub}". Try \`ashlr wiki --help\`.\n`);
      return 2;
  }
}
