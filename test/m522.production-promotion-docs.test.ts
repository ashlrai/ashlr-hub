import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseDocs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');
const promotionSection = releaseDocs.split(
  '## Production promotion after 3.3.1 acceptance',
)[1]?.split('## Historical failure recovery record')[0] ?? '';
const promotionShell = promotionSection.match(/```bash\n([\s\S]*?)```/u)?.[1] ?? '';

describe('M522 — production-promotion operator boundary', () => {
  it('documents the protected observation-only admission without inventing authority', () => {
    expect(promotionSection).toContain('`npm-production-promotion` environment');
    expect(promotionSection).toContain('protected branches only');
    expect(promotionSection).toContain('required reviewer distinct from the dispatcher');
    expect(promotionSection).toContain('prevent self-review enabled');
    expect(promotionSection).toContain('`can_admins_bypass` set to `false`');
    expect(promotionSection).toContain('no environment secrets');
    expect(promotionSection).toContain('no more than 24 hours old');
    expect(promotionSection).toContain('human attestations');
    expect(promotionSection).toContain('The workflow is observation-only');
    expect(promotionSection).toContain('bounded GitHub receipt artifact');
    expect(promotionSection).toContain('cannot promote the package');
    expect(promotionSection).toMatch(/Any\s+rerun, expired acceptance, or drift/u);
    expect(promotionSection).toContain('quarantined 3.3.0 package');
    expect(promotionSection).toContain('remains ineligible for `latest`');
  });

  it('pins live owner revalidation and keeps the only npm effect interactive', () => {
    expect(promotionSection).toContain('registry="https://registry.npmjs.org/"');
    expect(promotionSection).toContain('npm@11.19.0');
    expect(promotionSection).toContain('node "$npm_cli" whoami --registry="$registry"');
    expect(promotionSection).toContain('node "$npm_cli" owner ls @ashlr/hub');
    expect(promotionSection).toContain(
      'node "$npm_cli" dist-tag add @ashlr/hub@3.3.1 latest',
    );
    expect(promotionShell).toContain('view @ashlr/hub@3.3.0 dist.integrity');
    expect(promotionShell).not.toContain('--otp');
    expect(promotionShell).toContain('NPM_CONFIG_USERCONFIG="$promotion_root/npmrc"');
    expect(promotionSection).toContain('Enter the fresh OTP only at npm\'s interactive prompt');
    expect(promotionSection).toContain('remain separate gates');
  });
});
