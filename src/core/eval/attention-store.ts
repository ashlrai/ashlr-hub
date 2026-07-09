import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';

export interface AttentionReportStoreOptions {
  rootDir?: string;
}

export function attentionEvalRoot(opts: AttentionReportStoreOptions = {}): string {
  return path.join(ashlrRoot(opts.rootDir), 'eval', 'attention');
}

export function attentionReportsDir(opts: AttentionReportStoreOptions = {}): string {
  return path.join(attentionEvalRoot(opts), 'reports');
}

export function saveAttentionReport(
  report: AttentionEvalReport,
  opts: AttentionReportStoreOptions = {},
): string {
  const dir = attentionReportsDir(opts);
  mkdirSync(dir, { recursive: true });
  const id = safeReportId(report.id);
  const file = path.join(dir, `${id}.json`);
  const tmp = path.join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
    return file;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  const dir = attentionReportsDir(opts);
  if (!existsSync(dir)) return [];
  const reports: AttentionEvalReport[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as AttentionEvalReport;
      if (parsed?.schemaVersion === 1 && typeof parsed.id === 'string') reports.push(parsed);
    } catch {
      // ignore malformed reports
    }
  }
  return reports.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

function ashlrRoot(rootDir: string | undefined): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
