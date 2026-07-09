/**
 * Binshield dependency-bump scan adapter tests.
 *
 * Hermetic: child_process.execFile is mocked, no live binshield binary or
 * network calls are made. The parser is exercised through the public adapter
 * using fixture-shaped binshield JSON.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

let _execFileImpl: Mock;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockExecFile = ((...args: unknown[]) => _execFileImpl(...args)) as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  mockExecFile[promisify.custom] = (
    file: string,
    cmdArgs: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      _execFileImpl(
        file,
        cmdArgs,
        options,
        (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

import {
  BinshieldScanError,
  scanDependencyBump,
} from '../src/core/security/binshield-scan.js';

const fixture = readFileSync(
  join(process.cwd(), 'test/fixtures/binshield-dependency-bump-report.json'),
  'utf8',
);

beforeEach(() => {
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
    cb(null, fixture, '');
  });
});

describe('scanDependencyBump', () => {
  it('runs binshield with a safe argv target-version scan and parses fixture output', async () => {
    const report = await scanDependencyBump('lodash', '4.17.20', '4.17.21');

    expect(_execFileImpl).toHaveBeenCalledTimes(1);
    expect(_execFileImpl.mock.calls[0]?.[0]).toBe('binshield');
    expect(_execFileImpl.mock.calls[0]?.[1]).toEqual([
      'scan',
      'npm',
      'lodash',
      '4.17.21',
      '--json',
    ]);
    expect(report.summary).toBe('2 CVEs found for lodash 4.17.20 -> 4.17.21');
    expect(report.maxSeverity).toBe('high');
    expect(report.riskLevel).toBe('high');
    expect(report.packageName).toBe('lodash');
    expect(report.fromVersion).toBe('4.17.20');
    expect(report.targetVersion).toBe('4.17.21');
    expect(report.cves).toEqual([
      {
        id: 'CVE-2021-23337',
        severity: 'high',
        summary: 'Command injection in lodash templates',
        packageName: 'lodash',
        affectedVersion: '4.17.20',
        fixedVersion: '4.17.21',
        cvssScore: 7.2,
        url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337',
      },
      {
        id: 'CVE-2020-8203',
        severity: 'medium',
        summary: 'Prototype pollution in lodash',
        packageName: 'lodash',
        affectedVersion: '4.17.20',
        fixedVersion: '4.17.21',
        cvssScore: 5.3,
        url: undefined,
      },
    ]);
  });

  it('derives critical severity from CVSS score and supports object vulnerability maps', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(
        null,
        JSON.stringify({
          vulnerabilities: {
            react: {
              identifiers: [{ id: 'CVE-2026-12345' }],
              cvssScore: '9.8',
              title: 'Remote code execution in react',
            },
          },
        }),
        '',
      );
    });

    const report = await scanDependencyBump('react', '18.2.0', '18.3.1');

    expect(report.maxSeverity).toBe('critical');
    expect(report.riskLevel).toBe('critical');
    expect(report.summary).toBe('1 CVE found; max severity critical');
    expect(report.cves).toMatchObject([
      {
        id: 'CVE-2026-12345',
        severity: 'critical',
        summary: 'Remote code execution in react',
        cvssScore: 9.8,
      },
    ]);
  });

  it('normalizes empty scan results to a none-severity report', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, JSON.stringify({ findings: [] }), '');
    });

    const report = await scanDependencyBump('left-pad', '1.0.0', '1.0.1');

    expect(report).toMatchObject({
      cves: [],
      maxSeverity: 'none',
      riskLevel: 'none',
      summary: 'No CVEs found',
      packageName: 'left-pad',
      fromVersion: '1.0.0',
      targetVersion: '1.0.1',
    });
  });

  it('parses current binshield package-scan JSON with riskLevel but no CVEs', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(
        null,
        JSON.stringify({
          id: 'pkg_json_1',
          ecosystem: 'npm',
          packageName: 'sharp',
          version: '0.34.4',
          status: 'complete',
          riskScore: 8,
          riskLevel: 'medium',
          summary: 'Native package with expected binary surface.',
          binaryCount: 1,
          totalBinarySize: 204800,
          binaries: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        '',
      );
    });

    const report = await scanDependencyBump('sharp', '0.34.3', '0.34.4');

    expect(report).toMatchObject({
      cves: [],
      maxSeverity: 'none',
      riskLevel: 'medium',
      summary: 'Native package with expected binary surface.',
      packageName: 'sharp',
      fromVersion: '0.34.3',
      targetVersion: '0.34.4',
      riskScore: 8,
    });
  });

  it('parses non-zero binshield exits when JSON stdout is present', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
      cb(
        Object.assign(new Error('risk threshold met'), { code: 2 }),
        JSON.stringify({
          packageName: 'evil-package',
          version: '1.0.0',
          riskScore: 97,
          riskLevel: 'critical',
          summary: 'Known malicious install script.',
        }),
        '',
      );
    });

    const report = await scanDependencyBump('evil-package', '0.9.0', '1.0.0');

    expect(report.riskLevel).toBe('critical');
    expect(report.summary).toBe('Known malicious install script.');
  });

  it('throws a typed error when binshield fails or emits invalid JSON', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
      cb(new Error('binshield unavailable'), '', '');
    });

    await expect(scanDependencyBump('lodash', '4.17.20', '4.17.21')).rejects.toBeInstanceOf(BinshieldScanError);

    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, '{not-json', '');
    });

    await expect(scanDependencyBump('lodash', '4.17.20', '4.17.21')).rejects.toThrow('invalid JSON');
  });

  it('throws a typed error for valid JSON with an unsupported schema', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, JSON.stringify({ ok: true }), '');
    });

    await expect(scanDependencyBump('lodash', '4.17.20', '4.17.21')).rejects.toThrow('unsupported JSON schema');
  });

  it('throws a typed error for unknown top-level risk levels', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, JSON.stringify({ packageName: 'lodash', version: '4.17.21', riskLevel: 'unknown' }), '');
    });

    await expect(scanDependencyBump('lodash', '4.17.20', '4.17.21')).rejects.toThrow('unsupported JSON schema');
  });

  it('throws a typed error for binshield error JSON', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, JSON.stringify({ error: 'rate limited' }), '');
    });

    await expect(scanDependencyBump('lodash', '4.17.20', '4.17.21')).rejects.toBeInstanceOf(BinshieldScanError);
  });
});
