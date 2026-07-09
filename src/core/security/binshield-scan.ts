import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BINSHIELD_TIMEOUT_MS = 60_000;
const BINSHIELD_MAX_BUFFER = 1024 * 1024;

export type BinshieldRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type AdvisorySeverity = BinshieldRiskLevel;

export type CVE = {
  id: string;
  severity: BinshieldRiskLevel;
  summary: string;
  packageName?: string;
  affectedVersion?: string;
  fixedVersion?: string;
  cvssScore?: number;
  url?: string;
};

export type AdvisoryReport = {
  cves: CVE[];
  maxSeverity: BinshieldRiskLevel;
  riskLevel: BinshieldRiskLevel;
  summary: string;
  packageName?: string;
  fromVersion?: string;
  targetVersion?: string;
  riskScore?: number;
};

export class BinshieldScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinshieldScanError';
  }
}

const RISK_RANK: Record<BinshieldRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function cvssScore(record: Record<string, unknown>): number | undefined {
  const direct = numberField(record, ['cvssScore', 'cvss_score', 'score']);
  if (direct !== undefined) return direct;

  const cvss = record['cvss'];
  if (typeof cvss === 'number' && Number.isFinite(cvss)) return cvss;
  if (typeof cvss === 'string') {
    const parsed = Number(cvss);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (isRecord(cvss)) return numberField(cvss, ['score', 'baseScore', 'base_score']);
  return undefined;
}

function severityFromCvss(score: number | undefined): BinshieldRiskLevel {
  if (score === undefined) return 'none';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function normalizeRiskLevel(value: unknown, score: number | undefined): BinshieldRiskLevel {
  if (typeof value === 'number' && Number.isFinite(value)) return severityFromCvss(value);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'critical' || normalized === 'crit') return 'critical';
    if (normalized === 'high') return 'high';
    if (normalized === 'medium' || normalized === 'moderate' || normalized === 'mod') return 'medium';
    if (normalized === 'low') return 'low';
    if (normalized === 'none' || normalized === 'info' || normalized === 'informational' || normalized === 'unknown') return 'none';
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) return severityFromCvss(numeric);
  }
  return severityFromCvss(score);
}

function hasRiskLevel(value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (['critical', 'crit', 'high', 'medium', 'moderate', 'mod', 'low', 'none', 'info', 'informational'].includes(normalized)) {
    return true;
  }
  return normalized.length > 0 && Number.isFinite(Number(normalized));
}

function maxSeverity(cves: CVE[]): BinshieldRiskLevel {
  return cves.reduce<BinshieldRiskLevel>(
    (max, cve) => (RISK_RANK[cve.severity] > RISK_RANK[max] ? cve.severity : max),
    'none',
  );
}

function addCveId(ids: Set<string>, candidate: unknown): void {
  if (typeof candidate !== 'string') return;
  const trimmed = candidate.trim();
  if (/^CVE-\d{4}-\d{4,}$/i.test(trimmed)) ids.add(trimmed.toUpperCase());
}

function collectCveIds(record: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ['cve', 'cveId', 'cve_id', 'id', 'identifier']) {
    addCveId(ids, record[key]);
  }

  for (const key of ['cves', 'cveIds', 'identifiers']) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') {
        addCveId(ids, entry);
      } else if (isRecord(entry)) {
        for (const nestedKey of ['cve', 'cveId', 'cve_id', 'id', 'identifier']) {
          addCveId(ids, entry[nestedKey]);
        }
      }
    }
  }

  return [...ids];
}

function entrySummary(record: Record<string, unknown>, fallbackId: string): string {
  return stringField(record, ['summary', 'title', 'description', 'detail', 'name']) ?? fallbackId;
}

function normalizeCves(entries: unknown[]): CVE[] {
  const cves: CVE[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;

    const ids = collectCveIds(entry);
    if (ids.length === 0) continue;

    const score = cvssScore(entry);
    const severity = normalizeRiskLevel(
      entry['severity'] ?? entry['cvssSeverity'] ?? entry['cvss_severity'] ?? entry['rating'],
      score,
    );
    const packageName = stringField(entry, ['packageName', 'package', 'pkg', 'dependency']);
    const affectedVersion = stringField(entry, ['affectedVersion', 'affected_version', 'fromVersion', 'from']);
    const fixedVersion = stringField(entry, ['fixedVersion', 'fixed_version', 'patchedVersion', 'patched_version', 'toVersion', 'to']);
    const url = stringField(entry, ['url', 'link', 'advisoryUrl', 'advisory_url']);

    for (const id of ids) {
      cves.push({
        id,
        severity,
        summary: entrySummary(entry, id),
        packageName,
        affectedVersion,
        fixedVersion,
        cvssScore: score,
        url,
      });
    }
  }

  return cves;
}

function maxRisk(a: BinshieldRiskLevel, b: BinshieldRiskLevel): BinshieldRiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function riskFromPackages(packages: unknown): BinshieldRiskLevel {
  if (!Array.isArray(packages)) return 'none';
  return packages.reduce<BinshieldRiskLevel>((max, entry) => {
    if (!isRecord(entry)) return max;
    const score = numberField(entry, ['riskScore', 'risk_score', 'score']);
    const raw = entry['riskLevel'] ?? entry['risk_level'] ?? entry['severity'];
    return hasRiskLevel(raw) || score !== undefined ? maxRisk(max, normalizeRiskLevel(raw, score)) : max;
  }, 'none');
}

type EntryResult = { entries: unknown[]; recognized: boolean };

function entriesFromParsed(parsed: unknown): EntryResult {
  if (Array.isArray(parsed)) return { entries: parsed, recognized: true };
  if (!isRecord(parsed)) return { entries: [], recognized: false };

  for (const key of ['cves', 'advisories', 'findings', 'vulnerabilities', 'results']) {
    const value = parsed[key];
    if (Array.isArray(value)) return { entries: value, recognized: true };
    if (key === 'vulnerabilities' && isRecord(value)) {
      return { entries: Object.values(value), recognized: true };
    }
  }

  if (Array.isArray(parsed['packages'])) return { entries: parsed['packages'], recognized: true };

  const score = numberField(parsed, ['riskScore', 'risk_score', 'score']);
  const risk = parsed['riskLevel'] ?? parsed['risk_level'] ?? parsed['severity'];
  if (hasRiskLevel(risk) || score !== undefined) return { entries: [], recognized: true };

  return { entries: [], recognized: false };
}

function reportSummary(parsed: unknown, cves: CVE[], max: BinshieldRiskLevel): string {
  const explicit = isRecord(parsed) ? stringField(parsed, ['summary', 'message', 'description']) : undefined;
  if (explicit) return explicit;
  if (cves.length === 0) return 'No CVEs found';
  return `${cves.length} CVE${cves.length === 1 ? '' : 's'} found; max severity ${max}`;
}

export function parseAdvisoryReport(
  raw: string,
  context: { packageName?: string; fromVersion?: string; targetVersion?: string } = {},
): AdvisoryReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BinshieldScanError(`binshield returned invalid JSON: ${message}`);
  }

  if (isRecord(parsed) && (typeof parsed['error'] === 'string' || typeof parsed['errors'] === 'string' || Array.isArray(parsed['errors']))) {
    throw new BinshieldScanError('binshield returned error JSON');
  }

  const entryResult = entriesFromParsed(parsed);
  if (!entryResult.recognized) {
    throw new BinshieldScanError('binshield returned unsupported JSON schema');
  }

  const cves = normalizeCves(entryResult.entries);
  const max = maxSeverity(cves);
  const obj = isRecord(parsed) ? parsed : {};
  const riskScore = numberField(obj, ['riskScore', 'risk_score', 'score']);
  const rawRisk = obj['riskLevel'] ?? obj['risk_level'] ?? obj['severity'];
  const packageRisk = hasRiskLevel(rawRisk) || riskScore !== undefined
    ? normalizeRiskLevel(rawRisk, riskScore)
    : 'none';
  const riskLevel = maxRisk(maxRisk(packageRisk, riskFromPackages(obj['packages'])), max);
  const packageName = stringField(obj, ['packageName', 'package', 'pkg', 'name']) ?? context.packageName;
  const targetVersion = stringField(obj, ['version', 'targetVersion', 'toVersion', 'to']) ?? context.targetVersion;

  return {
    cves,
    maxSeverity: max,
    riskLevel,
    summary: reportSummary(parsed, cves, max),
    packageName,
    fromVersion: context.fromVersion,
    targetVersion,
    riskScore,
  };
}

export function riskAtOrAbove(level: BinshieldRiskLevel, threshold: BinshieldRiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK[threshold];
}

export async function scanDependencyBump(
  pkg: string,
  fromVersion: string,
  toVersion: string,
): Promise<AdvisoryReport> {
  try {
    const { stdout } = await execFileAsync(
      'binshield',
      [
        'scan',
        'npm',
        pkg,
        toVersion,
        '--json',
      ],
      {
        timeout: BINSHIELD_TIMEOUT_MS,
        maxBuffer: BINSHIELD_MAX_BUFFER,
      },
    );

    return parseAdvisoryReport(stdout, { packageName: pkg, fromVersion, targetVersion: toVersion });
  } catch (err) {
    if (err instanceof BinshieldScanError) throw err;
    const stdout = (err as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      return parseAdvisoryReport(stdout, { packageName: pkg, fromVersion, targetVersion: toVersion });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new BinshieldScanError(`binshield target-version scan failed: ${message}`);
  }
}
