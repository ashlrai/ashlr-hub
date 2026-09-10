import { describe, expect, it } from 'vitest';
import { assertRuntimeReleaseRootPackagePortability, type RuntimeReleaseDependencyInventoryV2 } from '../src/core/daemon/runtime-release-dependency-inventory.js';

// The root declaration check consumes only this existing inventory discriminator.
// No manifest, release signature or actual package installation is asserted here.
const inventory = { portability: 'platform-independent-no-native-or-install-variance' } as RuntimeReleaseDependencyInventoryV2;
const base = { name: '@ashlr/hub', version: '3.4.0', files: ['bin', 'dist', 'scripts/run-verify-command.mjs'] };

describe('firm documentation distribution allowlist', () => {
  it.each(['AUTONOMY-GAP.md', 'FIRM-DEMO.md'])('allows the exact public %s guide', (name) => {
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base, files: [...base.files, `docs/${name}`] }, [], inventory)).not.toThrow();
  });
  it.each(['docs/private.md', 'docs', '../secrets', 'docs/FIRM-DEMO.md/secret'])('still refuses unlisted %s', (path) => {
    expect(() => assertRuntimeReleaseRootPackagePortability({ ...base, files: [...base.files, path] }, [], inventory)).toThrow();
  });
});
