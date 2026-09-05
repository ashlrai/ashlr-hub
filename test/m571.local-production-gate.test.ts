import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertExternalReceiptPath,
  parseLocalGateArgs,
  prepareDisposableTauriSidecar,
  validateLocalGateToolchain,
  validateLocalProductionContract,
} from '../scripts/run-local-production-gate.mjs';
import { tarballEvidence } from '../scripts/run-local-pack-smoke.mjs';
import { parseBoundedCommandArgs } from '../scripts/run-bounded-command.mjs';
import {
  canonicalizeLocalProductionGateReceipt,
  LOCAL_PRODUCTION_GATE_COMMANDS,
  LOCAL_PRODUCTION_GATE_IDS,
  parseLocalProductionGateReceiptBytes,
  validateLocalProductionGateReceipt,
  verifyExpectedReceiptBindings,
} from '../scripts/verify-local-production-gate-receipt.mjs';

const repoRoot = process.cwd();
const scratch: string[] = [];
const digest = 'a'.repeat(64);
const revision = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const integrity = `sha512-${'A'.repeat(86)}==`;
const instant = '2026-09-05T00:00:00.000Z';

function validReceipt(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'ashlr-local-production-gate-receipt-v1',
    assurance: 'local-source-verification-only',
    source: { revision, tree, cleanBefore: true, cleanAfter: true },
    toolchain: {
      nodeVersion: '24.18.0',
      npmVersion: '11.16.0',
      rustcVersion: 'rustc 1.95.0 (example)',
      cargoVersion: 'cargo 1.95.0 (example)',
      cargoAuditVersion: 'cargo-audit 0.22.2',
    },
    bindings: {
      policy: { policyId: 'ashlr-release-successor-v1:9.8.7', version: '9.8.7', sha256: digest },
      contract: { path: 'ashlr.verify.json', sha256: 'd'.repeat(64) },
      package: {
        name: '@ashlr/hub', version: '9.8.7', tarballName: 'ashlr-hub-9.8.7.tgz',
        sha256: 'e'.repeat(64), integrity,
      },
    },
    execution: {
      startedAt: instant,
      finishedAt: instant,
      hostPlatform: 'darwin',
      networkUse: 'dependency-and-advisory-reads-only',
      externalMutations: false,
      operationalAshlrHome: 'redirected-to-disposable-root',
      disposableSidecar: 'created-exclusive-and-removed-before-receipt',
    },
    gates: LOCAL_PRODUCTION_GATE_IDS.map((id, index) => ({
      id,
      commandSha256: createHash('sha256')
        .update(Buffer.from(JSON.stringify({
          argv: LOCAL_PRODUCTION_GATE_COMMANDS[index][1],
          cwd: LOCAL_PRODUCTION_GATE_COMMANDS[index][2],
        }), 'utf8')).digest('hex'),
      startedAt: instant,
      finishedAt: instant,
      durationMs: 0,
      exitCode: 0,
      stdoutSha256: digest,
      stderrSha256: digest,
    })),
    authority: {
      activate: false, dispatch: false, install: false, promote: false,
      providerEffects: false, publish: false,
    },
    verdict: 'passed',
  };
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('M571 local production gate v1', () => {
  it('pins the complete ordered local-only gate without replacing merge shards', () => {
    const contract = JSON.parse(readFileSync(join(repoRoot, 'ashlr.verify.json'), 'utf8'));
    const local = validateLocalProductionContract(contract);
    expect(local.gates.map((gate) => gate.id)).toEqual(LOCAL_PRODUCTION_GATE_IDS);
    expect(contract.commands.map((gate: { id: string }) => gate.id)).toEqual([
      'typecheck', 'lint', 'build', 'test-ci-1-of-3', 'test-ci-2-of-3', 'test-ci-3-of-3',
    ]);
    expect(local.gates.find((gate) => gate.id === 'native-clippy')?.cmd).toEqual([
      'cargo', 'clippy', '--locked', '--all-targets', '--', '-D', 'warnings',
    ]);
    expect(local.gates.find((gate) => gate.id === 'native-audit')?.cmd).toContain('RUSTSEC-2024-0429');
    const drifted = structuredClone(contract);
    drifted.localProductionGate.gates[0].cmd = ['true'];
    expect(() => validateLocalProductionContract(drifted)).toThrow(/closed v1 command/u);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:local-production']).toBe('node scripts/run-local-production-gate.mjs');
  });

  it('accepts only canonical complete passing receipts and binds caller pins', () => {
    const receipt = validReceipt();
    validateLocalProductionGateReceipt(receipt);
    const bytes = Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8');
    const parsed = parseLocalProductionGateReceiptBytes(bytes);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => verifyExpectedReceiptBindings(parsed, {
      revision,
      tree,
      policySha256: digest,
      contractSha256: 'd'.repeat(64),
      integrity,
      receiptSha256: parsed.sha256,
    })).not.toThrow();
    expect(() => parseLocalProductionGateReceiptBytes(Buffer.from(JSON.stringify(receipt)))).toThrow(/canonical/u);
  });

  it('rejects failed, reordered, incomplete, or authority-bearing evidence', () => {
    const failed = validReceipt();
    (failed.gates as Array<Record<string, unknown>>)[0].exitCode = 1;
    expect(() => validateLocalProductionGateReceipt(failed)).toThrow(/successful/u);
    const reordered = validReceipt();
    (reordered.gates as Array<Record<string, unknown>>).reverse();
    expect(() => validateLocalProductionGateReceipt(reordered)).toThrow(/out of order/u);
    const incomplete = validReceipt();
    (incomplete.gates as Array<Record<string, unknown>>).pop();
    expect(() => validateLocalProductionGateReceipt(incomplete)).toThrow(/complete ordered/u);
    const authority = validReceipt();
    (authority.authority as Record<string, unknown>).publish = true;
    expect(() => validateLocalProductionGateReceipt(authority)).toThrow(/every effect false/u);
  });

  it('requires Node 24+, npm 11+, and exact policy toolchain identity', () => {
    const policy = { toolchain: { nodeVersion: '24.18.0', npmVersion: '11.16.0' } };
    expect(validateLocalGateToolchain({ nodeVersion: 'v24.18.0', npmVersion: '11.16.0', policy }))
      .toEqual({ nodeVersion: '24.18.0', npmVersion: '11.16.0' });
    expect(() => validateLocalGateToolchain({ nodeVersion: '22.22.3', npmVersion: '11.16.0', policy }))
      .toThrow(/Node/u);
    expect(() => validateLocalGateToolchain({ nodeVersion: '24.18.0', npmVersion: '11.15.0', policy }))
      .toThrow(/exactly match/u);
  });

  it('requires a pinned commit, tracked policy argument, and absolute external receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m571-args-'));
    scratch.push(root);
    const receipt = join(root, 'receipt.json');
    expect(parseLocalGateArgs([
      '--expected-sha', revision, '--policy', '.github/release-policies/v9.8.7.json', '--receipt', receipt,
    ])).toMatchObject({ expectedSha: revision, receiptPath: receipt });
    expect(() => parseLocalGateArgs([
      '--expected-sha', revision, '--policy', 'policy.json', '--receipt', 'relative.json',
    ])).toThrow(/absolute/u);
    expect(assertExternalReceiptPath(repoRoot, receipt)).toMatch(/\/ashlr-m571-args-[^/]+\/receipt\.json$/u);
    expect(() => assertExternalReceiptPath(repoRoot, join(repoRoot, 'receipt.json'))).toThrow(/outside/u);
  });

  it.runIf(process.platform === 'darwin')('creates one inert sidecar exclusively and removes only its own file', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'ashlr-m571-sidecar-'));
    scratch.push(fakeRepo);
    const binaries = join(fakeRepo, 'desktop', 'src-tauri', 'binaries');
    mkdirSync(binaries, { recursive: true });
    const rustc = 'rustc 1.95.0\nhost: aarch64-apple-darwin\n';
    const sidecar = prepareDisposableTauriSidecar(fakeRepo, rustc);
    expect(existsSync(sidecar.path)).toBe(true);
    expect(readFileSync(sidecar.path, 'utf8')).toBe('#!/bin/sh\nexit 64\n');
    expect(() => prepareDisposableTauriSidecar(fakeRepo, rustc)).toThrow(/already exists/u);
    sidecar.cleanup();
    expect(existsSync(sidecar.path)).toBe(false);
  });

  it('recomputes both tarball SHA-256 and npm-compatible sha512 SRI', () => {
    expect(tarballEvidence(Buffer.from('ashlr', 'utf8'))).toEqual({
      sha256: '7be78d718b02239002e56900741a42d7f4ce6953c69a092d41fe5163236d11ae',
      integrity: 'sha512-0QPHexANJE3e13GBIZZy0RjoNQOazVvzeaUCU/omHM1XkplC2TigkMRSei6L9CS+FUlxYdoITNvFki03plBwkw==',
      size: 5,
    });
  });

  it('provides the exact bounded timeout interface used by local macOS audits', () => {
    expect(parseBoundedCommandArgs([
      '--signal=TERM', '--kill-after=5s', '40s', 'npm', 'audit', '--json',
    ])).toEqual({
      timeoutMs: 40_000,
      killAfterMs: 5_000,
      command: 'npm',
      args: ['audit', '--json'],
    });
    expect(() => parseBoundedCommandArgs(['40s', 'npm'])).toThrow(/expected/u);
  });

  it('documents local execution without claiming release or runtime authority', () => {
    const contract = readFileSync(join(repoRoot, 'docs', 'contracts', 'CONTRACT-M571.md'), 'utf8');
    const runner = readFileSync(join(repoRoot, 'scripts', 'run-local-production-gate.mjs'), 'utf8');
    expect(contract).toContain('does not publish, promote, install a production runtime');
    expect(contract).toContain('Dependency acquisition and advisory audits may perform\nread-only network queries');
    expect(runner).toContain("delete env.GITHUB_ACTIONS");
    expect(runner).toContain("ASHLR_RUN_NATIVE_LAUNCHD_TEST: '0'");
    expect(runner).not.toMatch(/execSync\(['"]gh|spawn\(['"]gh/u);
  });
});
