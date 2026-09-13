import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertRuntimeReleaseRootPackagePortability, type RuntimeReleaseDependencyInventoryV2 } from '../src/core/daemon/runtime-release-dependency-inventory.js';

// The root declaration check consumes only this existing inventory discriminator.
// No manifest, release signature or actual package installation is asserted here.
const inventory = { portability: 'platform-independent-no-native-or-install-variance' } as RuntimeReleaseDependencyInventoryV2;
const base = { name: '@ashlr/hub', version: '3.4.0', files: ['bin', 'dist', 'scripts/run-verify-command.mjs'] };

describe('firm documentation distribution allowlist', () => {
  it('excludes the machine-specific scorer from the actual public package declaration', () => {
    const declaration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(declaration.files).toContain('!dist/core/universe/builtins/preparation-score/**');
  });
  it('allows only the exact local scorer exclusion', () => {
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base,
      files: [...base.files, '!dist/core/universe/builtins/preparation-score/**'] }, [], inventory)).not.toThrow();
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base,
      files: [...base.files, '!dist/**'] }, [], inventory)).toThrow();
  });
  it.each(['calibration.json', 'preparation-typecheck-project.json', 'measurement/preparation-bridge.mjs'])(
    'rejects leaked local scorer %s even if the pack list includes it', (file) => {
      expect(() => assertRuntimeReleaseRootPackagePortability(base,
        [`dist/core/universe/builtins/preparation-score/${file}`], inventory)).toThrow(/local preparation scorer/);
    });
  it.each(['AUTONOMY-GAP.md', 'FIRM-DEMO.md'])('allows the exact public %s guide', (name) => {
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base, files: [...base.files, `docs/${name}`] }, [], inventory)).not.toThrow();
  });
  it.each(['docs/private.md', 'docs', '../secrets', 'docs/FIRM-DEMO.md/secret'])('still refuses unlisted %s', (path) => {
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base, files: [...base.files, path] }, [], inventory)).toThrow();
  });
});
