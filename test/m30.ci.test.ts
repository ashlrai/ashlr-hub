/**
 * M30 POLISH — CI workflow guard.
 *
 * Parses .github/workflows/ci.yml (line-based; no YAML dependency, no new deps)
 * and asserts the CI runs on Node 22 (the hard minimum — install.sh hard-fails
 * below 22, so a 20+22 matrix would silently lie), runs the required
 * typecheck / lint / build / test steps with hermetic isolation, that npm
 * caching is enabled, and that NOTHING public is wired in (no deploy/publish/
 * release step) — per the M30 "nothing public / self-hostable" invariant.
 * Read-only; touches no real config.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const ciYml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { engines?: { node?: string }; scripts?: Record<string, string> };

describe('M30 CI workflow', () => {
  it('runs on Node 22 only (install.sh hard-fails below 22; no 20+22 matrix)', () => {
    // The CI uses a single node-version: "22" (not a matrix array).
    // A Node-20 entry would be wrong — install.sh rejects it at runtime.
    expect(ciYml).toMatch(/node-version:\s*["']?22["']?/);
    // Confirm Node 20 is NOT in the workflow as a version entry.
    expect(ciYml).not.toMatch(/node-version:\s*["']?20["']?/);
  });

  it('keeps the typecheck / lint / build / test steps (hermetic invocation)', () => {
    expect(ciYml).toContain('npm run typecheck');
    expect(ciYml).toContain('npm run lint');
    expect(ciYml).toContain('npm run build');
    // The canonical test runner isolates HOME and adds a watchdog timeout.
    expect(ciYml).toContain('npm run test:ci');
    expect(pkg.scripts?.['test:ci']).toContain('scripts/test-ci.mjs');
  });

  it('runs Ubuntu exhaustively with fixed Windows and macOS portability partitions', () => {
    expect(ciYml.match(/os:\s*ubuntu-latest/g)).toHaveLength(1);
    expect(ciYml.match(/os:\s*windows-latest/g)).toHaveLength(3);
    expect(ciYml.match(/os:\s*macos-latest/g)).toHaveLength(1);
    for (const partition of ['1/3', '2/3', '3/3']) {
      expect(ciYml).toContain(`label: windows, portability ${partition}`);
    }
    expect(ciYml).toContain('test_args: ""');
    expect(ciYml).not.toContain('--shard=');

    const declaredFiles = ciYml.match(/test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts/g) ?? [];
    const nativeMatrixEntries =
      ciYml.match(
        /^ {10}- os: (?:ubuntu|windows|macos)-latest[\s\S]*?(?=^ {10}- os: |^ {4}runs-on:)/gm,
      ) ?? [];
    const windowsMatrixEntries = nativeMatrixEntries
      .filter((entry) => entry.includes('os: windows-latest'));
    const windowsEntries = windowsMatrixEntries.join('\n');
    const macosEntry =
      nativeMatrixEntries.find((entry) => entry.includes('os: macos-latest')) ?? '';
    const terminalRetentionTest = 'test/m395.effect-terminal-retention.test.ts';
    const observerSchedulerTest = 'test/m367.daemon-observer-scheduler.test.ts';
    const expectedWindowsPartitions = [
      [
        'test/setup/home.test.ts',
        'test/classify.test.ts',
        'test/m2.doctor.test.ts',
        'test/m3.tools-registry.test.ts',
        'test/m43.verify-commands.test.ts',
        'test/m84.goal-direct.test.ts',
        'test/m201.daemon-loop.test.ts',
        'test/m113.coordinator-wire.test.ts',
        'test/m373.directory-durability.test.ts',
        terminalRetentionTest,
        'test/m403.automerge-mutation-fence.test.ts',
        'test/m404.policy-result-surfaces.test.ts',
        'test/m428.goal-source-quality.test.ts',
        'test/m409.engine-execution-mutation-fence.test.ts',
        'test/m410.policy-opposing-race.test.ts',
        'test/m414.local-store-lock-unknown-owner.test.ts',
        'test/m415.policy-durability-races.test.ts',
        'test/m422.policy-transaction-recovery.test.ts',
        'test/m425.policy-startup-recovery.test.ts',
        'test/m416.local-store-lock-handoff.test.ts',
      ],
      [
        'test/m21.worktree.test.ts',
        'test/m23.apply.test.ts',
        'test/m100.web-open.test.ts',
        'test/m119.quality-metrics.test.ts',
        'test/m332.outcome-watcher.test.ts',
        'test/m310.queued-autonomy-work.test.ts',
        'test/m342.dispatch-production-ledger.test.ts',
        'test/m353.dispatch-manifest.test.ts',
        'test/m405.apply-mutation-fence.test.ts',
        'test/m406.daemon-stop-quiescence.test.ts',
        'test/m411.local-merge-reconciliation.test.ts',
        'test/m412.sandbox-pre-effect-recovery.test.ts',
        'test/m413.engineer-run-mutation-fence.test.ts',
        'test/m417.sandbox-cleanup-quiescence.test.ts',
        'test/m424.legacy-swarm-mutation-fence.test.ts',
        'test/m425.persistence-private-temp.test.ts',
        'test/m426.sandbox-reservation-identity.test.ts',
        'test/sandbox-reservation-recovery.test.ts',
      ],
      [
        'test/m220.anticlog-verdict-feedback.test.ts',
        'test/m22.backlog.test.ts',
        'test/m165.self-heal.test.ts',
        'test/m229.goal-engine-trio.test.ts',
        'test/m286.worktree-verify-env.test.ts',
        'test/m315.remote-handoff-truth.test.ts',
        observerSchedulerTest,
        'test/m372.test-ci-watchdog.test.ts',
        'test/m379.private-storage.test.ts',
        'test/m385.cutoff-checkpoint-scheduler.test.ts',
        'test/m385.cutoff-checkpoint-windows.test.ts',
        'test/m407.verification-mutation-fence.test.ts',
        'test/m408.sandbox-creation-mutation-fence.test.ts',
        'test/m418.pulse-quiescence.test.ts',
        'test/m419.remote-handoff-intent.test.ts',
        'test/m420.remote-handoff-recovery.test.ts',
        'test/m421.legacy-pulse-quiescence.test.ts',
        'test/m423.control-plane-lock-order.test.ts',
      ],
    ];
    const expectedMacosFiles = [
      'test/m111.work-queue.test.ts',
      'test/m392.queue-lease-epochs.test.ts',
      terminalRetentionTest,
      observerSchedulerTest,
    ];
    const nativeAliasFiles = [
      'test/m426.sandbox-reservation-identity.test.ts',
      'test/h7.rollback.test.ts',
    ];
    const expectedFiles = [
      ...expectedWindowsPartitions.flat(),
      ...expectedMacosFiles,
      ...nativeAliasFiles,
    ];

    expect(windowsMatrixEntries).toHaveLength(expectedWindowsPartitions.length);
    windowsMatrixEntries.forEach((entry, index) => {
      const partitionFiles = entry.match(/test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts/g) ?? [];
      expect([...partitionFiles].sort()).toEqual(
        [...(expectedWindowsPartitions[index] ?? [])].sort(),
      );
    });
    const windowsDeclaredFiles = windowsEntries.match(
      /test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts/g,
    ) ?? [];
    expect(new Set(windowsDeclaredFiles).size).toBe(windowsDeclaredFiles.length);
    const macosDeclaredFiles = macosEntry.match(
      /test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts/g,
    ) ?? [];
    expect([...macosDeclaredFiles].sort()).toEqual([...expectedMacosFiles].sort());

    expect([...declaredFiles].sort()).toEqual([...expectedFiles].sort());
    const duplicateFiles = declaredFiles.filter(
      (file, index) => declaredFiles.indexOf(file) !== index,
    );
    expect([...duplicateFiles].sort()).toEqual([
      terminalRetentionTest,
      observerSchedulerTest,
      'test/m426.sandbox-reservation-identity.test.ts',
    ].sort());
    expect(windowsEntries.match(/test\/m395\.effect-terminal-retention\.test\.ts/g)).toHaveLength(
      1,
    );
    expect(macosEntry.match(/test\/m395\.effect-terminal-retention\.test\.ts/g)).toHaveLength(1);
    expect(windowsEntries.match(/test\/m367\.daemon-observer-scheduler\.test\.ts/g)).toHaveLength(1);
    expect(macosEntry.match(/test\/m367\.daemon-observer-scheduler\.test\.ts/g)).toHaveLength(1);
    for (const file of declaredFiles) {
      expect(existsSync(resolve(repoRoot, file)), `missing native CI test: ${file}`).toBe(true);
    }
    expect(ciYml).toContain('npm run test:ci -- ${{ matrix.test_args }}');
    expect(ciYml).toContain(
      "if: matrix.os == 'macos-latest' || matrix.label == 'windows, portability 2/3'",
    );
    expect(ciYml).toContain(`npm run test:ci -- ${nativeAliasFiles.join(' ')}`);
  });

  it('enables npm caching for fast installs', () => {
    expect(ciYml).toMatch(/cache:\s*["']?npm["']?/);
    expect(ciYml).toContain('npm ci');
  });

  it('adds NO deploy / publish / release step (nothing public)', () => {
    expect(ciYml).not.toMatch(/\b(npm\s+publish|deploy|release)\b/i);
    expect(ciYml).not.toMatch(/vercel|netlify|gh-pages|pages-deploy/i);
  });

  it('package.json engines field declares the supported Node floor', () => {
    // Keep npm metadata aligned with install.sh, CI, and release workflows.
    expect(pkg.engines?.node).toBe('>=22');
  });
});
