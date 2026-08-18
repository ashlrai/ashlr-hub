/**
 * Release-truth regressions for the fail-closed authority salvage.
 *
 * These checks preserve the immutable public 3.3.0 record while binding the
 * current 3.3.1 correction and documented configuration surface to the
 * production boundary: protected PR handoff is terminal, and rejected local
 * activation/host-merge authority is not shipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function releaseBlock(version: string): string {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf(`## [${version}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, next === -1 ? undefined : next);
}

describe('emergency authority release truth', () => {
  it('preserves the published 3.3.0 record and binds the 3.3.1 correction', () => {
    const historical = releaseBlock('3.3.0');
    const release = releaseBlock('3.3.1');

    expect(releaseBlock('Unreleased').trim()).toBe('## [Unreleased]');

    expect(historical).toContain('Fleet activation unblocked, autonomous merge wired, learning loop closed');
    expect(createHash('sha256').update(historical).digest('hex'))
      .toBe('1ddec34a674cc8dd88315091bccbbda699a02558942eb23c244f9626b57131eb');

    expect(release).toMatch(/fail-closed runtime boundaries/i);
    expect(release).toMatch(/compiled daemon and conductor trust roots are empty/i);
    expect(release).toMatch(/resident-start,[\s\S]{0,80}service-install,[\s\S]{0,80}host-merge[\s\S]{0,80}dormant/i);
    expect(release).toMatch(/post-merge credit[\s\S]{0,50}report-only/i);
    expect(release).toMatch(/3\.3\.0 must never move to npm `latest`/i);
    expect(release).toMatch(/3\.3\.1 is the sole successor/i);

    for (const removedClaim of [
      'RUNTIME-FLEET-ACTIVATION.md',
      'ashlr activation init',
      'ashlr activation grant',
      'test/m470.activation-authority.test.ts',
      'test/m505.host-auto-merge.test.ts',
      'on-machine standing grants',
    ]) {
      expect(release).not.toContain(removedClaim);
    }
  });

  it('records the restored console and web security changes without an unchanged-backend claim', () => {
    const release = releaseBlock('3.3.1');

    expect(release).toMatch(/session-bound and expiry-bound\s+SSE/);
    expect(release).toContain('descriptor-bound static reads');
    expect(release).toContain('CSP/security headers');
    expect(release).not.toMatch(/backend changes were\s+minimal and additive/i);
    expect(release).not.toMatch(/server\.ts`?\/`?static\.ts`? routing is\s+unchanged/i);
  });

  it('documents dormant production execution and the exact new-console auth lifecycle', () => {
    const readme = read('README.md');
    const quickstart = read('docs/QUICKSTART.md');

    for (const doc of [readme, quickstart]) {
      expect(doc).toMatch(/compiled\s+(?:daemon and conductor\s+)?trust roots\s+are empty/i);
      expect(doc).toMatch(/live non-dry[^.\n]*(?:dormant|refuse)/i);
      expect(doc).toContain('/next/');
      expect(doc).toMatch(/discards? the raw read token/i);
      expect(doc).toMatch(/cookie[\s\S]{0,180}proof[\s\S]{0,180}survives/i);
      expect(doc).toMatch(/After\s+expiry, (?:re-)?enter the raw read token/i);
      expect(doc).toMatch(/20-minute idle/i);
      expect(doc).toMatch(/Lock[^.\n]*clears/i);
      expect(doc).toMatch(/legacy dashboard at `\/`/i);
    }
  });

  it('keeps setup, update, and help guidance on admitted owner or dry-run paths', () => {
    const release = releaseBlock('3.3.1');
    const readme = read('README.md');
    const quickstart = read('docs/QUICKSTART.md');
    const serviceAuthority = read('src/core/daemon/service-install-authority.ts');
    const setup = read('src/cli/setup.ts');
    const onboard = read('src/core/onboard.ts');
    const update = read('src/cli/update.ts');
    const help = read('src/cli/help.ts');

    expect(readme).not.toMatch(/setup covers the same ground/i);
    expect(quickstart).not.toMatch(/setup` prints auth guidance/i);
    expect(release).not.toMatch(/closed learning loop|admitted one-shot workflows/i);
    expect(release).toMatch(/learning signals[\s\S]{0,30}report-only/i);

    for (const source of [serviceAuthority, update]) {
      expect(source).toMatch(/compiled daemon and conductor trust roots are empty/i);
      expect(source).toContain('ashlr run');
      expect(source).toContain('ashlr swarm');
      expect(source).toContain('ashlr daemon start --once --dry-run');
      expect(source).not.toMatch(/admitted one-shot workflows/i);
    }

    for (const source of [setup, onboard]) {
      expect(source).toContain('RESIDENT_SERVICE_DORMANT_RUNTIME_GUIDANCE');
      expect(source).toContain('ashlr run');
      expect(source).toContain('ashlr swarm');
      expect(source).toContain('ashlr daemon start --once --dry-run');
    }

    expect(help).toMatch(/daemon start --once'[\s\S]{0,220}compiled daemon trust roots are empty/i);
    expect(help).toMatch(/goal "<objective>"'[\s\S]{0,220}live owner-invoked[\s\S]{0,160}proposal-only advance/i);
    expect(help).not.toMatch(/goal "<objective>"'[\s\S]{0,180}(?:dormant|compiled conductor trust roots are empty)/i);
    expect(help).toMatch(/cmd: 'loop'[\s\S]{0,180}compiled conductor trust roots are empty/i);
    expect(help).not.toMatch(/use admitted one-shot workflows/i);
  });

  it('keeps operator guides off non-dry daemon and resident-loop activation recipes', () => {
    const operatorGuides = [
      'docs/TEAM.md',
      'docs/WORKER.md',
      'docs/RELIABILITY.md',
    ].map(read);

    for (const guide of operatorGuides) {
      expect(guide).toMatch(/compiled daemon and conductor trust roots are empty/i);
      expect(guide).toContain('ashlr daemon start --once --dry-run');
      expect(guide).toMatch(/ashlr run/);
      expect(guide).toMatch(/ashlr swarm/);
      expect(guide).not.toMatch(/admitted one-shot workflows/i);
      expect(guide).not.toMatch(/^ashlr daemon start(?: --once)?\s*(?:#.*)?$/m);
      expect(guide).not.toMatch(/^ashlr loop(?: --watch)?\s*(?:#.*)?$/m);
    }
  });

  it('keeps examples, team enrollment, and desktop draft guidance within current authority', () => {
    const example = read('examples/quickstart.md');
    const team = read('docs/TEAM.md');
    const desktop = read('desktop/README.md');
    const loopSlashCommand = read('.claude/commands/loop.md');
    const goalSlashCommand = read('.claude/commands/goal.md');
    const normalizedDesktop = desktop.replace(/\s+/g, ' ');

    expect(example).toMatch(/compiled conductor trust roots are empty/i);
    expect(example).toMatch(/non-dry `ashlr[\s\S]{0,30}loop`[^.]*refuse/i);
    expect(example).toContain('ashlr loop --dry-run');
    expect(example).toContain('ashlr goal "<objective>"');
    expect(example).not.toMatch(/^ashlr loop(?: --watch)?\s*(?:#.*)?$/m);

    expect(team).toMatch(/setup --yes` currently refuses before discovery or enrollment/i);
    expect(team).toContain('ashlr enroll add');
    expect(team).not.toMatch(/setup --yes` to auto-discover/i);
    expect(team).toMatch(/--yes` does not discover or enroll/i);
    expect(team).toMatch(/--wire` does not edit anything/i);
    expect(team).toMatch(/--json` changes only the refusal output format/i);
    expect(team).toMatch(/setup` syntactically accepts `--user` and `--user-id`/i);
    expect(team).toMatch(/refusal occurs before either value is applied or persisted/i);
    expect(team).not.toMatch(/setup` does not accept a `--user` flag/i);

    expect(desktop).toMatch(/source-only Tauri v2 desktop draft/i);
    expect(normalizedDesktop).toMatch(/not a public or commissioned desktop product/i);
    expect(normalizedDesktop).toMatch(/setup --yes`[\s\S]{0,180}refuses before config/i);
    expect(normalizedDesktop).toMatch(/daemon start`[\s\S]{0,180}refuses before effects/i);
    expect(desktop).not.toMatch(/manages the daemon lifecycle|daemon keeps running/i);

    expect(loopSlashCommand).toMatch(/compiled conductor trust roots are empty/i);
    expect(loopSlashCommand).toMatch(/non-dry `ashlr loop`[\s\S]{0,100}refuse/i);
    expect(loopSlashCommand).toContain('ashlr loop --dry-run');
    expect(loopSlashCommand).not.toContain('ashlr loop $ARGUMENTS');
    expect(loopSlashCommand).not.toMatch(/files \*\*PENDING proposals\*\*/i);

    expect(goalSlashCommand).toContain('ashlr goal $ARGUMENTS');
    expect(goalSlashCommand).toMatch(/sandboxed, proposal-only/i);
    expect(goalSlashCommand).not.toMatch(/compiled conductor trust roots are empty|dormant/i);
  });

  it('distinguishes live owner goals from dormant resident loop execution', () => {
    const readme = read('README.md');
    const architecture = read('docs/ARCHITECTURE.md');

    for (const source of [readme, architecture]) {
      expect(source).toMatch(/`ashlr goal "<objective>"`[^.]*live[^.]*owner-invoked/i);
      expect(source).toMatch(/proposal-only/i);
      expect(source).toMatch(/(?:resident )?loop[^.\n]*(?:dormant|refuse)/i);
    }
  });

  it('documents exactly the seven steps returned by ashlr init', () => {
    const quickstart = read('docs/QUICKSTART.md');
    const start = quickstart.indexOf('Initialization reports these steps:');
    const end = quickstart.indexOf('Steps marked `!`', start);
    const initSteps = quickstart.slice(start, end);

    for (const name of ['config', 'models', 'editors', 'symlink', 'genome', 'phantom', 'doctor']) {
      expect(initSteps).toContain(`| \`${name}\` |`);
    }
    expect(initSteps).not.toContain('| `engines` |');
    expect(initSteps).not.toContain('| `enroll` |');
  });

  it('marks historical and aspirational fleet documents as non-activation context', () => {
    const historicalOrDesignDocs = [
      'docs/ROADMAP.md',
      'docs/NORTH-STAR.md',
      'docs/SPEC-V4-FOUNDRY.md',
      'docs/SPEC-V5-OPEN-FLEET.md',
      'docs/SPEC-RESOURCE-CONTROL-PLANE.md',
      'docs/contracts/CONTRACT-M24.md',
      'docs/contracts/CONTRACT-M54.md',
      'docs/contracts/CONTRACT-M55.md',
      'docs/contracts/CONTRACT-M59.md',
    ];

    for (const relativePath of historicalOrDesignDocs) {
      const source = read(relativePath);
      const normalized = source.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
      expect(source, relativePath).toMatch(/(?:historical|aspirational)[^\n]*design|historical implementation contract/i);
      expect(normalized, relativePath).toMatch(/not current runtime activation guidance/i);
      expect(normalized, relativePath).toMatch(/compiled daemon and conductor trust roots are empty|compiled conductor trust roots are empty/i);
    }

    const daemonContract = read('docs/contracts/CONTRACT-M24.md');
    expect(daemonContract).toMatch(/start --once --budget 0\.05` => REFUSES before dispatch/i);
    expect(daemonContract).toMatch(/injected test-only trust root/i);
  });

  it('does not ship the rejected authority surfaces', () => {
    for (const removedPath of [
      'docs/RUNTIME-FLEET-ACTIVATION.md',
      'src/cli/activation.ts',
      'test/m470.activation-authority.test.ts',
      'test/m505.host-auto-merge.test.ts',
      'test/m506.host-auto-merge-e2e.test.ts',
      'test/m520.full-chain-merge-e2e.test.ts',
    ]) {
      expect(existsSync(join(ROOT, removedPath)), removedPath).toBe(false);
    }
  });
});

describe('pushToRemote public contract', () => {
  it('documents a protected PR handoff in the type and schema', () => {
    const types = read('src/core/types.ts');
    const schema = JSON.parse(read('schema/config.schema.json'));
    const description = schema.properties.foundry.properties.autoMerge
      .properties.pushToRemote.description as string;

    expect(types).toMatch(/protected PR handoff; never merges the hosted PR[\s\S]{0,100}pushToRemote/);
    expect(description).toMatch(/protected PR handoff; never merges the hosted PR/i);
    expect(description).not.toMatch(/gh pr merge|host auto-merge/i);
  });

  it('documents the same terminal handoff in the operator guide', () => {
    const row = read('docs/FOUNDRY-CONFIG.md')
      .split('\n')
      .find((line) => line.includes('`pushToRemote`'));

    expect(row).toMatch(/protected PR handoff; never merge the hosted PR/i);
    expect(row).not.toMatch(/gh pr merge|host auto-merge/i);
  });

  it('keeps the M56 contract at protected PR handoff with no hosted merge claim', () => {
    const contract = read('docs/contracts/CONTRACT-M56.md');

    expect(contract).toMatch(/protection-checked PR[\s\S]{0,100}awaiting-host-merge/i);
    expect(contract).toMatch(/hosted merge is outside this module/i);
    expect(contract).not.toMatch(/gh pr merge|squash-merge to main/i);
  });

  it('keeps milestone cross-references aligned with the fail-closed release heading', () => {
    const milestones = read('docs/MILESTONE-INDEX.md');

    expect(milestones).toContain('CHANGELOG\'s "Fail-closed runtime boundaries"');
    expect(milestones).not.toContain('CHANGELOG\'s "Fleet activation unblocked"');
  });

  it('contains no host merge effect, caller, or configuration key', () => {
    const merge = read('src/core/inbox/merge.ts');
    const types = read('src/core/types.ts');
    const schema = read('schema/config.schema.json');

    expect(merge).not.toContain('attemptHostAutoMerge');
    expect(merge).not.toContain('hostMergeGhPrMerge');
    expect(merge).not.toMatch(/["']pr["']\s*,\s*["']merge["']/);
    expect(types).not.toContain('hostAutoMerge');
    expect(schema).not.toContain('hostAutoMerge');
  });
});
