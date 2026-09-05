import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:cts|mts|tsx?)$/.test(entry.name) ? [path] : [];
    });
}

const DORMANT_MODULES = new Set([
  'src/core/inbox/operational-projection-replay-ledger.ts',
  'src/core/inbox/operational-projection-transaction-coordinator.ts',
  'src/core/inbox/operational-projection-transaction.ts',
]);

const DORMANT_SPECIFIERS = [
  'operational-projection-replay-ledger',
  'operational-projection-transaction-coordinator',
  'operational-projection-transaction',
] as const;

function importedSpecifiers(path: string): string[] {
  // preProcessFile extracts static imports, exports, dynamic imports, and
  // require() specifiers without building and traversing a full AST for every
  // source file. This keeps the repository-wide contract deterministic under
  // heavily contended CI shards instead of relying on a larger timeout.
  return ts.preProcessFile(readFileSync(path, 'utf8'), true, true)
    .importedFiles
    .map((entry) => entry.fileName);
}

describe('projection authority architecture contract', () => {
  it('keeps transaction and replay authority unreachable from live source', () => {
    const violations = sourceFiles(SRC).flatMap((path) => {
      const repoPath = relative(ROOT, path).replaceAll('\\', '/');
      if (DORMANT_MODULES.has(repoPath)) return [];
      return importedSpecifiers(path).some((specifier) =>
        DORMANT_SPECIFIERS.some((dormant) => specifier.includes(dormant)))
        ? [repoPath]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('documents a fail-closed handle-relative service without claiming activation', () => {
    const adr = readFileSync(
      join(ROOT, 'docs', 'adr', '0001-projection-authority.md'),
      'utf8',
    );

    expect(adr).toContain('Status: accepted design, dormant implementation');
    expect(adr).toMatch(/long-lived native\s+single-writer service/);
    expect(adr).toMatch(/There is no path\s+fallback\./);
    expect(adr).toContain('external signed monotonic CAS');
    expect(adr).toContain('private anonymous inherited IPC channel');
    expect(adr).toContain('allowlisted environment');
    expect(adr).toContain('local candidate');
    expect(adr).toMatch(/only\s+after the signed CAS response verifies/);
    expect(adr).toContain('no reconnect to a path-discovered endpoint');
    expect(adr).toContain('Activation is a separate reviewed change.');
  });
});
