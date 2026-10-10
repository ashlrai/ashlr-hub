// Shadow data only. Changing this policy cannot authorize report inheritance.
export const IMPACT_POLICY = Object.freeze({
  schemaVersion: 1,
  name: 'impact-policy-v1',
  advisoryOnly: true,
  activationEnabled: false,
  reviewedCompleteDomains: Object.freeze([]),
  roles: Object.freeze(['web', 'mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated']),
  globalInputs: Object.freeze([
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json',
    'vitest.config.ts', 'vitest.config.web.ts', 'vite.config.ts',
    'test/setup/home.ts', 'test/setup/home-isolation-guard.ts', 'src/web-ui/test/setup.ts',
    'test/config/realio-lane-membership.mjs', 'scripts/test-ci.mjs', 'scripts/test-ci-sharded.mjs',
    'test/config/weighted-sequencer.mjs', '.github/scripts/ci-partition-shadow.mjs',
    '.github/workflows/ci.yml', '.github/scripts/ci-qualification-lane.mjs',
    '.github/scripts/ci-impact-policy.mjs', '.github/scripts/ci-impact-shadow.mjs',
  ]),
  environmentInputs: Object.freeze([
    'ASHLR_VITEST_TEST_TIMEOUT_MS', 'ASHLR_RUN_NATIVE_LAUNCHD_TEST', 'ASHLR_TEST_CI_TIMEOUT_MS',
    'CI', 'NODE_OPTIONS',
  ]),
});

// These domains require full qualification even if import edges are unchanged.
// No path or extension in the complement is deemed safe by this classifier.
export function fullChangeReason(path) {
  if (/(?:^|\/)(?:package(?:-lock)?\.json|[^/]*\.lock|Cargo\.toml|Package\.swift)$/.test(path)) return 'package-or-version-change';
  if (path.startsWith('src/core/')) return 'backend-or-authority-change';
  if (path.startsWith('desktop/')) return 'native-or-tool-change';
  if (path.startsWith('.github/') || path.startsWith('scripts/')) return 'workflow-or-policy-or-tool-change';
  if (/(?:^|\/)(?:[^/]*config\.[^/]+|[^/]*\.test\.[^/]+)$/.test(path) || path.startsWith('test/')) return 'test-or-setup-change';
  return null;
}
