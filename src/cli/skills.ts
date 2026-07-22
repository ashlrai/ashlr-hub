/** Read-only external skill-pack inspection. */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import {
  auditExternalSkillPack,
  failedExternalSkillAudit,
  formatExternalSkillAudit,
} from '../core/fleet/external-skill-audit.js';
import type { ExternalSkillAuditReport } from '../core/fleet/external-skill-audit.js';

const AUDIT_TIMEOUT_MS = 30_000;
const MAX_AUDIT_OUTPUT_BYTES = 1024 * 1024;

function runAuditProcess(packPath: string): Promise<ExternalSkillAuditReport> {
  const currentFile = fileURLToPath(import.meta.url);
  const extension = extname(currentFile);
  const worker = fileURLToPath(new URL(`./skills-audit-process${extension}`, import.meta.url));
  const entry = process.argv[1] ?? '';
  const bunRuntime = typeof process.versions.bun === 'string';
  const directSourceImport = extension === '.ts' && !/[/\\]index\.ts$/.test(entry);
  const args = directSourceImport
    ? ['--import', 'tsx', worker, packPath]
    : bunRuntime
      ? ['__skills-audit-worker', packPath]
      : [...process.execArgv, entry, '__skills-audit-worker', packPath];

  return new Promise((resolveReport) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (report: ExternalSkillAuditReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveReport(report);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failedExternalSkillAudit('audit-worker-timeout'));
    }, AUDIT_TIMEOUT_MS);
    timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > MAX_AUDIT_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(failedExternalSkillAudit('audit-worker-failed'));
      }
    });
    child.once('error', () => finish(failedExternalSkillAudit('audit-worker-failed')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(failedExternalSkillAudit('audit-worker-failed'));
        return;
      }
      try {
        const parsed = JSON.parse(output) as Partial<ExternalSkillAuditReport>;
        if (
          parsed.schemaVersion !== 2
          || parsed.mode !== 'quarantine'
          || parsed.promotion?.eligible !== false
        ) throw new Error('invalid audit worker report');
        finish(parsed as ExternalSkillAuditReport);
      } catch {
        finish(failedExternalSkillAudit('audit-worker-failed'));
      }
    });
  });
}

/** Hidden self-reentry used by the Node CLI and Bun compiled binary. */
export async function cmdSkillsAuditWorker(args: string[]): Promise<number> {
  if (args.length !== 1) return 2;
  const report = auditExternalSkillPack(resolve(args[0]!));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

function help(): void {
  console.log([
    'Usage: ashlr skills audit <pack-path> [--json]',
    '',
    'Audits an external skills/ catalog and evals/cases fixtures without',
    'executing scripts, importing prompts, or granting skill authority.',
  ].join('\n'));
}

function invalidUsage(json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      error: { code: 'invalid-usage' },
      usage: 'ashlr skills audit <pack-path> [--json]',
    })}\n`);
  } else {
    help();
  }
  return 2;
}

export async function cmdSkills(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const unknownFlags = args.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const jsonCount = args.filter((arg) => arg === '--json').length;
  if (
    unknownFlags.length > 0
    || jsonCount > 1
    || positional[0] !== 'audit'
    || positional.length !== 2
  ) {
    return invalidUsage(json);
  }

  const report = await runAuditProcess(resolve(positional[1]!));
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatExternalSkillAudit(report)}\n`);
  return report.trialReady ? 0 : 1;
}
