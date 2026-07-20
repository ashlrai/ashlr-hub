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
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const ciYml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { engines?: { node?: string }; scripts?: Record<string, string> };

function vitestCallRoot(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return vitestCallRoot(expression.expression);
  if (ts.isCallExpression(expression)) return vitestCallRoot(expression.expression);
  return undefined;
}

function staticEachTitleValues(expression: ts.Expression): string[] | undefined {
  if (!ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== 'each') return undefined;
  let table = expression.arguments[0];
  while (table && (ts.isAsExpression(table) || ts.isParenthesizedExpression(table))) {
    table = table.expression;
  }
  if (!table || !ts.isArrayLiteralExpression(table)) return undefined;
  const values: string[] = [];
  for (const row of table.elements) {
    if (!ts.isStringLiteral(row) && !ts.isNoSubstitutionTemplateLiteral(row)) return undefined;
    values.push(row.text);
  }
  return values;
}

function declaredTestTitles(file: string): string[] {
  const path = resolve(repoRoot, file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ['it', 'test'].includes(vitestCallRoot(node.expression) ?? '')) {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        const eachValues = staticEachTitleValues(node.expression);
        if (eachValues && title.text.split('%s').length === 2) {
          titles.push(...eachValues.map((value) => title.text.replace('%s', value)));
        } else {
          titles.push(title.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

describe('M30 CI workflow', () => {
  it('is reusable as the canonical release verification authority', () => {
    expect(ciYml).toMatch(/(?:^|\n)\s{2}workflow_call:\s*(?:\n|$)/);
    expect(ciYml.match(/^permissions:\n(?: {2}[^\n]+\n)+/m)?.[0]).toBe(
      'permissions:\n  contents: read\n',
    );
    expect(ciYml.match(/^\s{2,}permissions:/gm) ?? []).toHaveLength(0);
  });

  it('cancels only superseded runs from the same event and branch', () => {
    const concurrency = ciYml.match(/^concurrency:\n(?: {2}[^\n]+\n)+/m)?.[0] ?? '';
    expect(concurrency).toContain('group: ci-${{ github.event_name }}-${{ github.head_ref || github.ref_name }}');
    expect(concurrency).toContain('cancel-in-progress: true');
  });

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
    expect(ciYml.match(/os:\s*windows-latest/g)).toHaveLength(4);
    expect(ciYml.match(/os:\s*macos-latest/g)).toHaveLength(1);
    for (const partition of ['1/3', '2/3', '3/3']) {
      expect(ciYml).toContain(`label: windows, portability ${partition}`);
    }
    expect(ciYml).toContain('label: windows, portability overflow');
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
    const windowsPortabilityThree = windowsMatrixEntries.find((entry) =>
      entry.includes('label: windows, portability 3/3')) ?? '';
    const windowsPortabilityOverflow = windowsMatrixEntries.find((entry) =>
      entry.includes('label: windows, portability overflow')) ?? '';
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
        'test/m315.remote-handoff-truth.test.ts',
        'test/m372.test-ci-watchdog.test.ts',
        'test/m423.control-plane-lock-order.test.ts',
      ],
      [
        'test/m220.anticlog-verdict-feedback.test.ts',
        'test/m286.worktree-verify-env.test.ts',
        observerSchedulerTest,
        'test/m379.private-storage.test.ts',
        'test/m385.cutoff-checkpoint-scheduler.test.ts',
        'test/m385.cutoff-checkpoint-windows.test.ts',
        'test/m407.verification-mutation-fence.test.ts',
        'test/m408.sandbox-creation-mutation-fence.test.ts',
        'test/m418.pulse-quiescence.test.ts',
        'test/m419.remote-handoff-intent.test.ts',
        'test/m420.remote-handoff-recovery.test.ts',
        'test/m421.legacy-pulse-quiescence.test.ts',
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
    const nativePathIdentityFiles = [
      'test/h1.fixture.test.ts',
      'test/h4.sandbox-enrollment-kill.test.ts',
      'test/m165.self-heal.test.ts',
      'test/m201.daemon-loop.test.ts',
      'test/m22.backlog.test.ts',
      'test/m229.goal-engine-trio.test.ts',
      'test/m310.queued-autonomy-work.test.ts',
      'test/m342.dispatch-production-ledger.test.ts',
      'test/m362.repair-handoff-journal.test.ts',
      'test/m360.generated-repair-lifecycle.test.ts',
      'test/m353.dispatch-manifest.test.ts',
      'test/m84.goal-direct.test.ts',
    ];
    const nativeJournalAuthoritySelector = [
      'journal activation authority: canonicalizes UUID casing before persistence and lookup',
      'journal activation authority: quarantines UUID case-variant timestamp collisions',
      'journal activation authority: reports the latest same-generation recurrence',
      'journal activation authority: rejects recurrence authority when its immutable anchor parent is missing',
      'journal activation authority: preserves unbound v2 rows written before activation',
      'journal activation authority: quarantines unbound v2 rows written after activation',
      'journal activation authority: reconciles a file-durable append crash before parent settlement',
      'preserves the journal-wide high-water through compaction and rejects a stale writer generation',
      'rejects a distinct writer id claiming the high-water activation instant',
      'rejects an activation id that mutates its timestamp',
      'degrades summary when an active-epoch recurrence loses its parent',
      'tracks the active writer epoch without moving the immutable generation anchor',
      'keeps the first exact route tuple as the immutable generation anchor',
      'does not let a backdated recurrence replace the first durable anchor',
      'quarantines a malformed claimed id across compaction and later replay',
      'projects the immutable first v2 attempt while compaction preserves recurrence history',
      'keeps compacted history able to quarantine a changed old replay',
      'quarantines an exact parent with a conflicting backend/tier sibling',
      'reports the true latest authority timestamp across current-activation generations',
      'preserves generation proof across an intentional writer activation rollover',
    ].join('|');
    const expectedNativeCases = [
      {
        file: 'test/h1.fixture.test.ts',
        title: 'relocates homedir() to the fresh tmp HOME while active',
        selector: String.raw`relocates homedir\(\) to the fresh tmp HOME while active`,
      },
      {
        file: 'test/h1.fixture.test.ts',
        title: 'cleanup() restores the prior HOME, USERPROFILE, and ASHLR_HOME exactly',
        selector: String.raw`cleanup\(\) restores the prior HOME, USERPROFILE, and ASHLR_HOME exactly`,
      },
      {
        file: 'test/h4.sandbox-enrollment-kill.test.ts',
        title: '3.8 secures a fresh Windows authority root before enrollment',
        selector: '3.8 secures a fresh Windows authority root before enrollment',
      },
      {
        file: 'test/h4.sandbox-enrollment-kill.test.ts',
        title: '3.9 refuses without rewriting a pre-existing permissive Windows authority root',
        selector: '3.9 refuses without rewriting a pre-existing permissive Windows authority root',
      },
      {
        file: 'test/h4.sandbox-enrollment-kill.test.ts',
        title: '3.10 refuses a permissive pre-existing Windows fence directory',
        selector: '3.10 refuses a permissive pre-existing Windows fence directory',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'retires an uncommitted intent so a cross-day retry can acquire authority',
        selector: 'retires an uncommitted intent so a cross-day retry can acquire authority',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'materializes exact failure receipts for treatment-free capture and proposal repair lineage',
        selector: 'materializes exact failure receipts for treatment-free capture and proposal repair lineage',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'recovers a failure append crash without duplicating its authoritative raw event',
        selector: 'recovers a failure append crash without duplicating its authoritative raw event',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'recovers one exact failure append beyond the analytics partition read bound',
        selector: 'recovers one exact failure append beyond the analytics partition read bound',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'fails closed when a crashed failure append partition suffers replacement',
        selector: 'fails closed when a crashed failure append partition suffers replacement',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'fails closed when a crashed failure append partition suffers truncation',
        selector: 'fails closed when a crashed failure append partition suffers truncation',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'fails closed when a crashed failure append partition suffers mutation',
        selector: 'fails closed when a crashed failure append partition suffers mutation',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'bounds and crash-recovers 2,048 same-generation failures with batched assurance',
        selector: 'bounds and crash-recovers 2,048 same-generation failures with batched assurance',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'recovers an interrupted retention manifest for an exact failure-receipt artifact',
        selector: 'recovers an interrupted retention manifest for an exact failure-receipt artifact',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'recovers an interrupted retention manifest for an exact failure-intent artifact',
        selector: 'recovers an interrupted retention manifest for an exact failure-intent artifact',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'establishes exact private DACLs for attempt authority writes',
        selector: 'establishes exact private DACLs for attempt authority writes',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'exact-inspects receipt directory DACLs during pure authority reads',
        selector: 'exact-inspects receipt directory DACLs during pure authority reads',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'rejects owner-safe but non-exact Windows ACLs before parsing treatment authority',
        selector: 'rejects owner-safe but non-exact Windows ACLs before parsing treatment authority',
      },
      {
        file: 'test/m342.dispatch-production-ledger.test.ts',
        title: 'establishes exact private DACLs for treatment receipt, retention, and protocol writes',
        selector: 'establishes exact private DACLs for treatment receipt, retention, and protocol writes',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'consumes protocol v5 emitted by the real dispatch writer',
        selector: 'consumes protocol v5 emitted by the real dispatch writer',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'publishes an ordinal-2 retained proof at the writer retention cutoff',
        selector: 'publishes an ordinal-2 retained proof at the writer retention cutoff',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'accepts an exact-inspected v2 receipt tombstone after the live receipt is retained',
        selector: 'accepts an exact-inspected v2 receipt tombstone after the live receipt is retained',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'keeps a proven converted witness pending until exact immutable publication',
        selector: 'keeps a proven converted witness pending until exact immutable publication',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'retries converted publication after receipt storage is repaired',
        selector: 'retries converted publication after receipt storage is repaired',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'treats exact immutable publication replay as idempotent',
        selector: 'treats exact immutable publication replay as idempotent',
      },
      {
        file: 'test/m360.generated-repair-lifecycle.test.ts',
        title: 'establishes exact private DACLs for lifecycle treatment receipt and existing retention storage',
        selector: 'establishes exact private DACLs for lifecycle treatment receipt and existing retention storage',
      },
    ] as const;
    const expectedFiles = [
      ...expectedWindowsPartitions.flat(),
      ...expectedMacosFiles,
      ...nativeAliasFiles,
      ...nativePathIdentityFiles,
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
    expect(windowsPortabilityThree).toContain('--reporter=dot');
    expect(windowsPortabilityOverflow).toContain('--reporter=dot');
    expect(ciYml.match(/--reporter=dot/g)).toHaveLength(2);
    for (const entry of windowsMatrixEntries) {
      if (entry === windowsPortabilityThree || entry === windowsPortabilityOverflow) continue;
      expect(entry).not.toContain('--reporter=dot');
    }
    expect(ciYml).not.toContain('ASHLR_TEST_CI_IDLE_TIMEOUT_MS');
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
    expect(ciYml).toContain("if: matrix.label == 'windows, portability 1/3'");
    for (const file of nativePathIdentityFiles) expect(ciYml).toContain(file);
    const nativePathStep = ciYml.match(
      /^ {6}- name: Test native path and lifecycle authority \(hermetic\)[\s\S]*?(?=^ {6}- name: |^ {6}#)/m,
    )?.[0] ?? '';
    expect(nativePathStep).not.toBe('');
    expect(nativePathStep).toContain('node scripts/test-native-path-lifecycle.mjs --');
    const nativePathRunner = resolve(repoRoot, 'scripts/test-native-path-lifecycle.mjs');
    expect(existsSync(nativePathRunner)).toBe(true);
    const nativePathRunnerSource = readFileSync(nativePathRunner, 'utf8');
    expect(nativePathRunnerSource).toContain("'ASHLR_TEST_CI_TIMEOUT_MS'");
    expect(nativePathRunnerSource).toContain('deadline - Date.now()');
    const nativePathFiles = nativePathStep.match(
      /test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts/g,
    ) ?? [];
    expect([...nativePathFiles].sort()).toEqual([...nativePathIdentityFiles].sort());
    const selector = nativePathStep.match(/-t "([^"]+)"/)?.[1] ?? '';
    expect(selector).toContain(nativeJournalAuthoritySelector);
    const selectorAlternatives = selector.split('|').filter(Boolean);
    expect(new Set(selectorAlternatives).size).toBe(selectorAlternatives.length);
    const expectedSelectorAlternatives = expectedNativeCases.map(({ selector }) => selector);
    expect(new Set(expectedSelectorAlternatives).size).toBe(expectedSelectorAlternatives.length);
    for (const alternative of expectedSelectorAlternatives) {
      expect(selectorAlternatives, `native selector omits dedicated alternative: ${alternative}`)
        .toContain(alternative);
    }
    const titlesByFile = new Map(
      nativePathFiles.map((file) => [file, declaredTestTitles(file)]),
    );
    const declaredNativeTitles = [...titlesByFile.values()].flat();
    for (const alternative of selectorAlternatives) {
      const pattern = new RegExp(alternative);
      const matchingTitles = declaredNativeTitles.filter((title) => pattern.test(title));
      expect(
        matchingTitles,
        `native selector alternative must match exactly one declared test title: ${alternative}`,
      ).toHaveLength(1);
    }
    for (const expectedCase of expectedNativeCases) {
      const titles = titlesByFile.get(expectedCase.file) ?? [];
      expect(titles, `native manifest omits expected test file: ${expectedCase.file}`)
        .toContain(expectedCase.title);
      const matchingAlternatives = selectorAlternatives.filter((alternative) =>
        new RegExp(alternative).test(expectedCase.title));
      expect(
        matchingAlternatives,
        `expected native case must have exactly one dedicated selector: ${expectedCase.file} :: ${expectedCase.title}`,
      ).toEqual([expectedCase.selector]);
      const dedicatedMatches = [...titlesByFile].flatMap(([file, declaredTitles]) =>
        declaredTitles
          .filter((title) => new RegExp(expectedCase.selector).test(title))
          .map((title) => `${file} :: ${title}`));
      expect(
        dedicatedMatches,
        `dedicated native selector must match one declared title: ${expectedCase.selector}`,
      ).toEqual([`${expectedCase.file} :: ${expectedCase.title}`]);
    }
    for (const alternative of selectorAlternatives) {
      const expectedMatches = expectedNativeCases.filter(({ title }) =>
        new RegExp(alternative).test(title));
      expect(
        expectedMatches.length,
        `native selector alternative satisfies multiple expected cases: ${alternative}`,
      ).toBeLessThanOrEqual(1);
    }
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
