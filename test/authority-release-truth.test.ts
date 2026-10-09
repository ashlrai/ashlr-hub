/**
 * Release-truth regressions for the fail-closed authority salvage.
 *
 * These checks preserve the immutable public 3.3.0 record while binding the
 * current 3.3.2 successor and documented configuration surface to the
 * production boundary: protected PR handoff is terminal, and rejected local
 * activation/host-merge authority is not shipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopUpdateProfileForPackage } from '../src/core/desktop/update-manifest.js';

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
  it('keeps current install discovery separate from candidate and dated release examples', () => {
    const latest = 'https://github.com/ashlrai/phantom/releases/latest';
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const candidate = `This source tree targets version ${version}; check canonical release availability and exact matching assets before installation.`;
    for (const file of ['README.md', 'docs/QUICKSTART.md', 'desktop/README.md']) {
      const source = read(file);
      expect(source, file).toContain(latest);
      expect(source.split(candidate), file).toHaveLength(2);
      expect(source, file).not.toMatch(/Phantom \d+\.\d+\.\d+ is published|canonical \d+\.\d+\.\d+ release is published|The current published release is \[\d|the published \d+\.\d+\.\d+ package is/u);
    }
    const appInstall = read('README.md').split('## The desktop app (macOS)')[1]!.split('```')[0]!;
    expect(appInstall).toContain(latest);
    expect(appInstall).not.toMatch(/releases\/tag\/v\d/u);
    const desktop = read('desktop/README.md');
    expect(desktop).toContain('Phantom_<version>_aarch64.app.tar.gz');
    expect(desktop).toContain(`${latest}/download/latest.json`);
    expect(desktop).toContain('Match desktop artifacts to that version.');
    const site = read('site/index.html');
    expect(site).toContain('signed arm64 app archive and paired update manifest');
    expect(site).not.toContain('Apple silicon desktop app, locally signed; unsigned DMG; neither Apple notarized');
    expect(read('site/README.md')).toContain('https://github.com/ashlrai/phantom/blob/master/docs/PHANTOM-BRAND.md');
  });

  it('preserves the published 3.3.0 record and binds the 3.3.2 successor', () => {
    const historical = releaseBlock('3.3.0');
    const failed = releaseBlock('3.3.1');
    const release = releaseBlock('3.3.2');

    // The old source notes now sit in the 3.16 entry. They still distinguish
    // earlier receipts from changes that arrived later.
    const laterRelease = releaseBlock('3.16.0');
    expect(laterRelease).toMatch(/Verification[\s\S]{0,80}runs locally without GitHub Actions/);
    expect(laterRelease).toMatch(/receipt does not certify these new source changes/);
    expect(laterRelease).toMatch(/does not activate accounts, publish a registry release, or start a resident\s+scheduler/);

    expect(historical).toContain('Fleet activation unblocked, autonomous merge wired, learning loop closed');
    expect(createHash('sha256').update(historical).digest('hex'))
      .toBe('1ddec34a674cc8dd88315091bccbbda699a02558942eb23c244f9626b57131eb');

    expect(failed).toMatch(/fail-closed runtime boundaries/i);
    expect(failed).toMatch(/compiled daemon and conductor trust roots are empty/i);
    expect(failed).toMatch(/resident-start,[\s\S]{0,80}service-install,[\s\S]{0,80}host-merge[\s\S]{0,80}dormant/i);
    expect(failed).toMatch(/post-merge credit[\s\S]{0,50}report-only/i);
    expect(failed).toMatch(/3\.3\.0 must never move to npm `latest`/i);
    expect(release).toMatch(/failed immutable 3\.3\.1 release attempt/i);
    expect(release).toContain('f2c9353db35fbf12889bddafd8acc2b7ca5ae67c');
    expect(release).toContain('32396250683');
    expect(release).toMatch(/npm version 3\.3\.1[\s\S]{0,80}GitHub Release remain\s+absent/i);
    expect(release).toContain('2971c9f767c934e12fd056bf8c6dca5164ffe7d2');
    expect(release).toContain('33932333902');
    expect(release).toContain('33933861238');
    expect(release).toMatch(/npm `latest` and `candidate` both resolve to 3\.3\.2/i);
    expect(release).toMatch(/does not install or activate a runtime/i);
    expect(release).toContain('d6c1a5ec3626f715018a8ffb929906ac0f52f5c9');

    for (const removedClaim of [
      'RUNTIME-FLEET-ACTIVATION.md',
      'ashlr activation init',
      'ashlr activation grant',
      'test/m470.activation-authority.test.ts',
      'test/m505.host-auto-merge.test.ts',
      'on-machine standing grants',
    ]) {
      expect(`${failed}\n${release}`).not.toContain(removedClaim);
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

  it('records 3.3.1 as failed and ineligible while naming 3.3.2 as the sole successor', () => {
    const failed = releaseBlock('3.3.1');

    expect(failed).toContain('f2c9353db35fbf12889bddafd8acc2b7ca5ae67c');
    expect(failed).toContain('32396250683');
    expect(failed).toMatch(/failed during native verification/i);
    expect(failed).toMatch(/signed canary,[\s\S]{0,100}prepare,[\s\S]{0,100}npm publish,[\s\S]{0,100}publication\s+verification,[\s\S]{0,100}GitHub Release[—\s]+was skipped/i);
    expect(failed).toMatch(/npm version 3\.3\.1[\s\S]{0,80}GitHub Release remain absent/i);
    expect(failed).toMatch(/tag and reserved version must not be moved,[\s\S]{0,80}reused,[\s\S]{0,80}published,[\s\S]{0,80}promoted/i);
    expect(failed).toMatch(/3\.3\.2 is the sole successor lane/i);
    expect(failed).not.toMatch(/prepares immutable 3\.3\.1/i);
    expect(failed).not.toMatch(/3\.3\.1 is the sole successor/i);
    expect(failed).not.toMatch(/3\.3\.1[^.\n]*eligible[^.\n]*npm `latest` promotion/i);
  });

  it('documents dormant production execution and the exact new-console auth lifecycle', () => {
    const readme = read('README.md');
    const hubReference = read('docs/HUB-REFERENCE.md');
    const quickstart = read('docs/QUICKSTART.md');

    // The install-first README links to the detailed Hub reference where this
    // legacy console contract now lives.
    expect(readme).toContain('docs/HUB-REFERENCE.md');
    expect(readme).toMatch(/Autonomy ships \*\*dormant\*\*/i);
    // #580 rewrote the quickstart for the workbench: the legacy `/next/` console and
    // its token lifecycle now live only in the Hub reference, and the
    // quickstart must steer new users away from that path.
    expect(quickstart).toContain('[Phantom reference](https://github.com/ashlrai/phantom/blob/master/docs/HUB-REFERENCE.md)');
    expect(quickstart).toMatch(/Resident autonomy is macOS-only and starts dormant/);
    expect(quickstart).toMatch(/older `\/` and `\/next\/` dashboard guidance should not\s+be used as a \S+ onboarding path/);
    for (const doc of [hubReference]) {
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

  it('keeps examples, team enrollment, and desktop release guidance within current authority', () => {
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

    // The arm64 installer is now public and locally signed. Availability of a
    // desktop download does not grant or start resident authority.
    expect(desktop).toMatch(/A Tauri v2 desktop app/i);
    expect(normalizedDesktop).toMatch(/resident autonomy requires its separate local setup and grant/i);
    const currentPackage = JSON.parse(read('package.json')) as { name: string; version: string };
    const profile = desktopUpdateProfileForPackage(currentPackage.name);
    // Source metadata identifies a candidate, not a public download. Keep the
    // documented published version separate until its public bytes are verified.
    const currentVersion = currentPackage.version;
    const canonicalVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
    expect(currentVersion).toMatch(canonicalVersion);
    const publishedDeclarations = [...desktop.matchAll(
      /^The published canonical ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) release includes `Phantom\.app`, with$/gm,
    )];
    expect(desktop.match(/^The published canonical [^\n]*$/gm)).toHaveLength(1);
    expect(publishedDeclarations).toHaveLength(1);
    const publishedVersion = publishedDeclarations[0]![1]!;
    expect(desktop).toContain(
      `https://github.com/${profile.repository}/releases/download/v${publishedVersion}/Phantom_${publishedVersion}_aarch64.dmg`,
    );
    expect(desktop).toContain(`\`Phantom_${publishedVersion}_aarch64.dmg\` downloads`);
    expect(desktop).toContain(`| macOS arm64 | Published canonical v${publishedVersion} \`.dmg\` |`);
    expect(normalizedDesktop).toContain('is the verified published canonical download.');
    expect(releaseBlock(publishedVersion).trim().length).toBeGreaterThan(50);
    const sourceParts = currentVersion.split('.').map(BigInt);
    const publishedParts = publishedVersion.split('.').map(BigInt);
    const differingPart = publishedParts.findIndex((part, index) => part !== sourceParts[index]);
    const sourceMarker = `This source tree targets version ${currentVersion}; check canonical release availability and exact matching assets before installation.`;
    expect(desktop.split(sourceMarker)).toHaveLength(2);
    expect(desktop).not.toMatch(/The source candidate is [^\n]+; publication and installation are pending/);
    if (differingPart !== -1) {
      expect(publishedParts[differingPart]! < sourceParts[differingPart]!).toBe(true);
      expect(desktop).not.toContain(`/releases/download/v${currentVersion}/Phantom_${currentVersion}_aarch64.dmg`);
    }
    expect(normalizedDesktop).toMatch(/locally signed, not Apple Developer ID notarized/i);
    expect(normalizedDesktop).toMatch(/Windows[^\n]*draft only/i);
    expect(normalizedDesktop).toMatch(/Linux[^\n]*Not produced while quarantined/i);
    expect(normalizedDesktop).not.toMatch(/Public desktop releases and installers: none/);
    expect(normalizedDesktop).toMatch(/setup --yes`[\s\S]{0,180}refuses before config/i);
    expect(normalizedDesktop).toMatch(/No resident daemon is started/);
    expect(normalizedDesktop).toMatch(/Daemon start\/stop and the kill switch are deliberately \*\*not\*\* here/);
    expect(desktop).not.toMatch(/^\|\s*(?:Start|Stop) Daemon\s*\|/im);
    expect(desktop).not.toMatch(/manages the daemon lifecycle|daemon keeps running/i);

    // Bind the README's tray table to the shipped tray, not just to prose.
    // 3.10 (C8) moved the tray into tray.rs and builds its rows from data, so
    // the ids are read from tray.rs's `pub const ID_*` declarations — the one
    // place a new row has to be declared. The set is pinned EXACTLY: adding a
    // row (say, a daemon toggle) must fail here and force a README + authority
    // review, rather than slipping in. None of these rows starts, stops or
    // activates the daemon: `tray.stop-chats` stops interactive Verse chat
    // turns only; Stop for the fleet stays in the authority surfaces.
    const desktopMain = read('desktop/src-tauri/src/main.rs');
    const trayRs = read('desktop/src-tauri/src/tray.rs');
    const trayItems = [...trayRs.matchAll(/pub const ID_[A-Z_]+: &str = "(tray\.[^"]+)"/g)].map((match) => match[1]);
    expect(trayItems).toEqual(['tray.show', 'tray.quit', 'tray.needs-you', 'tray.new-chat', 'tray.stop-chats']);
    // A tray row built with a literal id in main.rs would dodge the list above.
    expect([...desktopMain.matchAll(/MenuItemBuilder::with_id\(\s*"(tray\.[^"]+)"/g)]).toEqual([]);
    for (const shellSource of [desktopMain, read('desktop/src-tauri/src/app_menu.rs'), trayRs]) {
      expect(shellSource).not.toMatch(/"daemon"\s*,\s*"start"|daemon start/);
    }

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
    const hubReference = read('docs/HUB-REFERENCE.md');
    const architecture = read('docs/ARCHITECTURE.md');

    expect(readme).toContain('docs/HUB-REFERENCE.md');
    expect(readme).toMatch(/Autonomy ships \*\*dormant\*\*/i);
    for (const source of [hubReference, architecture]) {
      expect(source).toMatch(/`ashlr goal "<objective>"`[^.]*live[^.]*owner-invoked/i);
      expect(source).toMatch(/proposal-only/i);
      expect(source).toMatch(/(?:resident )?loop[^.\n]*(?:dormant|refuse)/i);
    }
  });

  it('documents exactly the seven steps returned by ashlr init', () => {
    const quickstart = read('docs/QUICKSTART.md');
    const start = quickstart.indexOf('Initialization reports these steps:');
    // #580 removed the step table from the Verse quickstart and defers
    // `ashlr init` to the Hub reference. If a step table comes back, it must
    // list exactly the seven steps again.
    if (start === -1) {
      expect(quickstart).toMatch(/`ashlr init`[^.]*remain compatibility\s+surfaces[\s\S]{0,200}\[Phantom reference\]\(https:\/\/github\.com\/ashlrai\/phantom\/blob\/master\/docs\/HUB-REFERENCE\.md\)/);
      expect(quickstart).not.toContain('| `engines` |');
      expect(quickstart).not.toContain('| `enroll` |');
      return;
    }
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
      expect(normalized, relativePath).toMatch(/compiled (?:daemon and conductor|conductor) trust roots (?:are|remain) empty/i);
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
