/**
 * `ashlr ecosystem doctor` — read-only sibling repository health scan.
 */

import { resolve } from 'node:path';
import { runEcosystemDoctor, type EcosystemDoctorCheck, type EcosystemDoctorReport } from '../core/ecosystem/doctor.js';
import { isTty, makeColors, pad } from './ui.js';

interface ParsedEcosystemArgs {
  sub: 'doctor' | 'help';
  json: boolean;
  deep: boolean;
  root: string | undefined;
  help: boolean;
  error: string | undefined;
}

function parseArgs(args: string[]): ParsedEcosystemArgs {
  const parsed: ParsedEcosystemArgs = {
    sub: args[0] === 'doctor' ? 'doctor' : 'help',
    json: false,
    deep: false,
    root: undefined,
    help: false,
    error: undefined,
  };

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    parsed.help = true;
    return parsed;
  }

  if (args[0] !== 'doctor') {
    parsed.error = `unknown ecosystem subcommand: ${args[0]}`;
    return parsed;
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--deep') {
      parsed.deep = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--root') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        parsed.error = '--root requires a directory';
        break;
      }
      parsed.root = resolve(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      parsed.error = `unknown flag: ${arg}`;
      break;
    } else {
      parsed.error = `unexpected argument: ${arg}`;
      break;
    }
  }

  return parsed;
}

function printHelp(): void {
  const { bold, cyan, dim } = makeColors(isTty());
  process.stdout.write('\n');
  process.stdout.write(bold('  ashlr ecosystem') + dim(' — read-only sibling repo diagnostics') + '\n');
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('Usage:') + '\n');
  process.stdout.write(`    ${cyan('ashlr ecosystem doctor')} [--json] [--root <dir>] [--deep]\n`);
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('Options:') + '\n');
  process.stdout.write(`    ${cyan(pad('--json', 12))} Emit {generatedAt, root, summary, checks, repos} as JSON.\n`);
  process.stdout.write(`    ${cyan(pad('--root <dir>', 12))} Scan immediate sibling repos under this directory.\n`);
  process.stdout.write(`    ${cyan(pad('--deep', 12))} Add extra read-only git/package/docs probes.\n`);
  process.stdout.write('\n');
  process.stdout.write('  ' + dim('Never runs package scripts, builds, tests, or package managers; writes nothing.') + '\n');
  process.stdout.write('\n');
}

const GLYPH: Record<EcosystemDoctorCheck['status'], string> = {
  pass: 'ok',
  warn: '!',
  fail: 'x',
};

function formatStatus(check: EcosystemDoctorCheck): string {
  const { green, yellow, red } = makeColors(isTty());
  const raw = `${GLYPH[check.status]} ${check.status}`;
  if (check.status === 'pass') return green(raw);
  if (check.status === 'warn') return yellow(raw);
  return red(raw);
}

function printHuman(report: EcosystemDoctorReport): void {
  const { bold, cyan, dim, gray, green, red, yellow } = makeColors(isTty());
  process.stdout.write('\n');
  process.stdout.write(bold('  ashlr ecosystem doctor') + gray(` — ${new Date(report.generatedAt).toLocaleString()}`) + '\n');
  process.stdout.write(dim(`  root: ${report.root}`) + '\n');
  process.stdout.write('\n');

  const repoW = Math.max(4, ...report.repos.map((repo) => repo.name.length));
  process.stdout.write(
    '  ' +
      gray(pad('REPO', repoW)) +
      '  ' + gray(pad('STATUS', 8)) +
      '  ' + gray(pad('GIT', 24)) +
      '  ' + gray(pad('PACKAGE', 26)) +
      '  ' + gray('DOCS') +
      '\n',
  );

  if (report.repos.length === 0) {
    process.stdout.write('  ' + dim('(no sibling repos found)') + '\n');
  }

  for (const repo of report.repos) {
    const worst = repo.summary.fail > 0 ? 'fail' : repo.summary.warn > 0 ? 'warn' : 'pass';
    const git = repo.git
      ? `${repo.git.branch ?? 'detached'}${repo.git.dirty > 0 ? `, ${repo.git.dirty} dirty` : ''}`
      : 'unreadable';
    const pkg = repo.package
      ? `${repo.package.name ?? 'unnamed'}${repo.package.version ? `@${repo.package.version}` : ''}`
      : 'missing';
    const docs = repo.docs.readme || repo.docs.docsMarkdown > 0
      ? `${repo.docs.readme ? 'README' : 'no README'}, ${repo.docs.docsMarkdown} docs`
      : 'missing';
    process.stdout.write(
      '  ' +
        cyan(pad(repo.name, repoW)) +
        '  ' + pad(worst === 'pass' ? green('pass') : worst === 'warn' ? yellow('warn') : red('fail'), 8) +
        '  ' + pad(git, 24) +
        '  ' + pad(pkg, 26) +
        '  ' + dim(docs) +
        '\n',
    );
  }

  const notable = report.checks.filter((check) => check.status !== 'pass');
  if (notable.length > 0) {
    process.stdout.write('\n');
    process.stdout.write('  ' + bold('Findings') + '\n');
    for (const check of notable) {
      const repo = check.repo ? `${check.repo}: ` : '';
      process.stdout.write(`  ${pad(formatStatus(check), 8)}  ${repo}${check.label} — ${dim(check.detail)}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${green(`${report.summary.pass} pass`)}  ` +
      `${yellow(`${report.summary.warn} warn`)}  ` +
      `${red(`${report.summary.fail} fail`)}  ` +
      dim(`across ${report.summary.repos} repo(s)`) +
      '\n',
  );
  process.stdout.write('\n');
}

export async function cmdEcosystem(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return parsed.error ? 2 : 0;
  }
  if (parsed.error) {
    const { red } = makeColors(isTty());
    process.stderr.write(red('error: ') + parsed.error + '\n');
    return 2;
  }
  if (parsed.sub !== 'doctor') {
    printHelp();
    return 2;
  }

  const report = await runEcosystemDoctor({ root: parsed.root, deep: parsed.deep });
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printHuman(report);
  }
  return report.summary.fail > 0 ? 1 : 0;
}
