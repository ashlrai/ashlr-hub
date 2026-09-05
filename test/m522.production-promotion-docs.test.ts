import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseDocs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');
const promotionSection = releaseDocs.split(
  '## Completed production promotion after 3.3.2 acceptance',
)[1]?.split('## Historical failure recovery record')[0] ?? '';
const promotionShell = promotionSection.match(/```bash\n([\s\S]*?)```/u)?.[1] ?? '';

describe('M522 — production-promotion operator boundary', () => {
  it('records the completed distribution state without claiming local activation', () => {
    expect(releaseDocs).toContain('Both npm dist-tags, `latest` and `candidate`');
    expect(releaseDocs).toContain(
      'sha512-674ZY76hBxks8j9JR5QifoyMn6uxmRx6dhbgiYAuWRyrnB4Zeuo/H+rgQ1mQ/mNYf62s1ORnJcvTxbxHZFuqTA==',
    );
    expect(releaseDocs).toContain('Release run `33932333902` completed successfully');
    expect(releaseDocs).toContain('admission run `33933861238` completed successfully');
    expect(releaseDocs).toContain('`promotionExecuted: false`');
    expect(releaseDocs).toMatch(/no immutable\s+post-effect receipt currently binds/u);
    expect(releaseDocs).toContain('Registry promotion did not install or activate any local');
    expect(releaseDocs).toContain('unreleased 3.4.0 development line');
    expect(releaseDocs).toContain('Do not recreate or move `v3.3.2`');
  });

  it('documents the protected observation-only admission without inventing authority', () => {
    expect(promotionSection).toContain('`npm-production-promotion` environment');
    expect(promotionSection).toContain('protected branches only');
    expect(promotionSection).toContain('exactly one required `User` reviewer, `masonwyatt23`');
    expect(promotionSection).toContain('prevent self-review disabled');
    expect(promotionSection).toContain('`can_admins_bypass` set to `false`');
    expect(promotionSection).toContain('no environment secrets');
    expect(promotionSection).toContain('explicit single-owner production gate');
    expect(promotionSection).toContain('only `masonwyatt23` can approve');
    expect(promotionSection).toContain('no more than 24 hours old');
    expect(promotionSection).toContain('human attestations');
    expect(promotionSection).toContain('The workflow is observation-only');
    expect(promotionSection).toContain('bounded GitHub receipt artifact');
    expect(promotionSection).toContain('cannot promote the package');
    expect(promotionSection).toMatch(/Any\s+rerun, expired acceptance, or drift/u);
    expect(promotionSection).toMatch(/quarantined\s+3\.3\.0 package/u);
    expect(promotionSection).toMatch(/remains ineligible\s+for `latest`/u);
    expect(promotionSection).toContain('failed v3.3.1 tag/run/npm/GitHub-Release absence');
  });

  it('pins live owner revalidation and keeps the only npm effect interactive', () => {
    expect(promotionSection).toContain('registry="https://registry.npmjs.org/"');
    expect(promotionSection).toContain('npm@11.19.0');
    expect(promotionSection).toContain('node "$npm_cli" whoami --registry="$registry"');
    expect(promotionSection).toContain('node "$npm_cli" owner ls @ashlr/hub');
    expect(promotionSection).toContain(
      'node "$npm_cli" dist-tag add @ashlr/hub@3.3.2 latest',
    );
    expect(promotionShell).toContain('view @ashlr/hub@3.3.0 dist.integrity');
    expect(promotionShell).not.toContain('--otp');
    expect(promotionShell).toContain('NPM_CONFIG_USERCONFIG="$promotion_root/npmrc"');
    expect(promotionSection).toContain('fresh OTP was entered only at npm\'s interactive prompt');
    expect(promotionSection).toContain('remain separate gates');
  });
});
