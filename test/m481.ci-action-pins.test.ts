/**
 * M481 - CI workflow action trust chain.
 *
 * Pure workflow assertions: every action used by every CI job must be one of
 * the reviewed immutable action commits below.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const workflow = parse(workflowText) as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

const approvedActions = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
  'actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809',
  'actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809',
]);

function actionRefs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(actionRefs);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    if (key === 'uses' && typeof entry === 'string') {
      return [entry];
    }
    return actionRefs(entry);
  });
}

interface CacheFixture {
  files?: Record<string, string>;
  untracked?: Record<string, string>;
  environment?: Record<string, string>;
  probes?: Record<string, string>;
  nonregular?: string;
}

// Execute the actual committed inline key script with closed host probes and
// an in-memory index. No Cargo, cache, filesystem or runner effects occur.
function cacheKey(fixture: CacheFixture = {}): { key: string; reads: string[] } {
  const native = jobs['native-macos-broker-foundation'];
  const steps = native.steps as Array<Record<string, unknown>>;
  const run = steps.find((step) => step.id === 'cargo-inputs')?.run;
  if (typeof run !== 'string') throw new Error('missing actual cache fingerprint');
  const script = run.match(/node <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
  if (!script) throw new Error('missing actual inline cache program');
  const files: Record<string, string> = {
    '.github/workflows/ci.yml': 'reviewed workflow',
    'desktop/src-tauri/Cargo.toml': 'manifest',
    'desktop/src-tauri/Cargo.lock': 'locked graph',
    'desktop/src-tauri/build.rs': 'build script',
    'desktop/src-tauri/tauri.conf.json': 'config',
    'desktop/src-tauri/src/lib.rs': 'native source',
    'desktop/src-tauri/capabilities/main.json': 'capabilities',
    'desktop/src-tauri/icons/icon.svg': 'icon',
    'src/core/daemon/loop.ts': 'unrelated source',
    ...fixture.files,
  };
  const probes: Record<string, string> = {
    'rustc -vV': 'rustc 1.97.1\nhost: aarch64-apple-darwin',
    'cargo -V': 'cargo 1.97.1', 'sw_vers -productVersion': '15.6',
    'uname -m': 'arm64', 'xcodebuild -version': 'Xcode 16.4',
    'xcode-select -p': '/Applications/Xcode.app/Contents/Developer',
    'xcrun --show-sdk-version': '15.5', 'xcrun --show-sdk-path': '/Applications/Xcode.app/SDK',
    ...fixture.probes,
  };
  let output = '';
  const reads: string[] = [];
  runInNewContext(script, {
    process: { env: { GITHUB_OUTPUT: 'output', ImageOS: 'macos15', ImageVersion: '20261001', ...fixture.environment } },
    require: (name: string) => {
      if (name === 'node:crypto') return { createHash };
      if (name === 'node:child_process') return { execFileSync: (file: string, args: string[]) => {
        if (file === 'git') {
          expect(args).toEqual(['ls-files', '-z']);
          return Object.keys(files).join('\0') + '\0';
        }
        const value = probes[[file, ...args].join(' ')];
        if (value === undefined) throw new Error('unexpected host probe');
        return value;
      } };
      if (name === 'node:fs') return {
        lstatSync: (file: string) => ({ isFile: () => file !== fixture.nonregular }),
        readFileSync: (file: string) => { reads.push(file); return Buffer.from(files[file] ?? fixture.untracked?.[file] ?? 'unexpected'); },
        appendFileSync: (file: string, value: string) => { expect(file).toBe('output'); output += value; },
      };
      throw new Error('unexpected inline module');
    },
  });
  expect(output).toMatch(/^key=phantom-ci-broker-cargo-v1-[a-f0-9]{64}-[a-f0-9]{64}\n$/);
  return { key: output.trim().slice(4), reads };
}

describe('M481 CI workflow action trust chain', () => {
  it('pins every action in every CI job to an approved immutable commit', () => {
    const refsByJob = Object.fromEntries(
      Object.entries(jobs).map(([jobId, job]) => [jobId, actionRefs(job)]),
    );
    const refs = Object.values(refsByJob).flat();

    expect(refsByJob).toEqual({
      ci: [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      ],
      'mac-general': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      ],
      'mac-isolated': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      ],
      'native-macos-broker-foundation': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
        'actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809',
        'actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809',
      ],
      'windows-service-authority': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      ],
    });

    for (const ref of refs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?@[0-9a-f]{40}$/i,
      );
      expect(approvedActions.has(ref), `unapproved action ref: ${ref}`).toBe(true);
    }
  });

  it('runs the dormant native broker library gate on a hosted Mac with pinned Rust', () => {
    const native = jobs['native-macos-broker-foundation'];
    expect(native?.['runs-on']).toBe('macos-latest');
    const serialized = JSON.stringify(native);
    expect(serialized).toContain('toolchain":"1.97.1"');
    expect(serialized).toContain('desktop/src-tauri/binaries/ashlr-${HOST_TRIPLE}');
    expect(serialized).toContain('set -o noclobber');
    expect(workflowText).toContain("trap 'rm -f -- \"$SIDECAR\"' ERR INT TERM");
    expect(serialized).toContain('ASHLR_TEST_SIDECAR_CREATED=1');
    expect(workflowText).toContain('if [[ "${ASHLR_TEST_SIDECAR_CREATED:-}" == "1" ]]');
    // tauri.conf.json bundles resources/public; the library gate needs a
    // disposable empty placeholder that is refused if anything already exists.
    expect(serialized).toContain('refusing unexpected resources fixture target');
    expect(workflowText).toContain('if [[ "${ASHLR_TEST_RESOURCES_CREATED:-}" == "1" ]]');
    expect(serialized).toContain('rustfmt --edition 2021 --check desktop/src-tauri/src/lib.rs desktop/src-tauri/src/native_launchd_broker.rs');
    expect(serialized).toContain('cargo check --manifest-path desktop/src-tauri/Cargo.toml --lib --locked');
    expect(serialized).toContain('cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --lib --locked -- -D warnings');
    // The signed-update policy shares this library; filtering to the broker
    // would silently omit its identity and host-result contracts.
    expect(serialized).toContain('cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib --locked -- --nocapture');
    expect(serialized).not.toContain('--lib --locked native_launchd_broker');
    expect(serialized).toContain('desktop/src-tauri/src/native_updates.rs');
  });

  it('restores only exact debug compilation keys and saves only successful master pushes after cleanup', () => {
    const steps = jobs['native-macos-broker-foundation'].steps as Array<Record<string, unknown>>;
    const restore = steps.find((step) => step.id === 'cargo-cache');
    const save = steps.find((step) => step.name === 'Save native compilation cache');
    expect(restore?.uses).toBe('actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809');
    expect(save?.uses).toBe('actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809');
    expect(restore?.with).toEqual({ path: 'desktop/src-tauri/target/debug/', key: '${{ steps.cargo-inputs.outputs.key }}' });
    expect(save?.with).toEqual(restore?.with);
    expect(save?.if).toBe("success() && github.event_name == 'push' && github.ref == 'refs/heads/master' && steps.cargo-cache.outputs.cache-hit != 'true'");
    expect(steps.indexOf(restore!)).toBeLessThan(steps.findIndex((step) => step.name === 'Check native broker library'));
    expect(steps.indexOf(save!)).toBeGreaterThan(steps.findIndex((step) => step.name === 'Remove disposable Tauri sidecar fixture'));
    const guard = steps.find((step) => step.name === 'Validate native cache identity');
    expect(guard?.env).toEqual({ EXPECTED_CARGO_CACHE_KEY: '${{ steps.cargo-inputs.outputs.key }}', PRIMARY_CARGO_CACHE_KEY: '${{ steps.cargo-cache.outputs.cache-primary-key }}', RESTORED_CARGO_CACHE_KEY: '${{ steps.cargo-cache.outputs.cache-matched-key }}' });
    expect(steps.indexOf(guard!)).toBeGreaterThan(steps.indexOf(restore!));
    expect(steps.indexOf(guard!)).toBeLessThan(steps.findIndex((step) => step.name === 'Create disposable Tauri sidecar fixture'));
    expect(guard).not.toHaveProperty('if');
    for (const name of ['Check native broker formatting', 'Check native broker library', 'Lint native broker library', 'Test native broker library']) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step).toBeDefined();
      expect(step).not.toHaveProperty('if');
      expect(step).not.toHaveProperty('continue-on-error');
    }
  });

  it('allows a cold miss or exact restored key but refuses prefix and substituted identities before Cargo', () => {
    const steps = jobs['native-macos-broker-foundation'].steps as Array<Record<string, unknown>>;
    const run = steps.find((step) => step.name === 'Validate native cache identity')?.run;
    expect(typeof run).toBe('string');
    const script = (run as string).match(/node <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
    expect(script).toBeDefined();
    const key = cacheKey().key;
    const validate = (expected: string, primary: string, restored?: string): void => {
      runInNewContext(script!, { process: { env: { EXPECTED_CARGO_CACHE_KEY: expected, PRIMARY_CARGO_CACHE_KEY: primary, RESTORED_CARGO_CACHE_KEY: restored } } });
    };
    expect(() => validate(key, key)).not.toThrow();
    expect(() => validate(key, key, '')).not.toThrow();
    expect(() => validate(key, key, key)).not.toThrow();
    expect(() => validate(key, key, `${key}-suffix`)).toThrow('native compilation cache identity differs');
    expect(() => validate(key, `${key}-other`, key)).toThrow('native compilation cache identity differs');
    expect(() => validate('unknown', 'unknown')).toThrow('native compilation cache identity differs');
  });

  it('keys actual tracked native inputs and excludes unrelated source, outputs and untracked private content', () => {
    const baseline = cacheKey();
    expect(cacheKey({ files: { 'src/core/daemon/loop.ts': 'new JS' } }).key).toBe(baseline.key);
    expect(cacheKey({ files: { 'desktop/src-tauri/target/debug/private.rs': 'output', 'desktop/src-tauri/resources/public/index.html': 'fixture', 'desktop/src-tauri/binaries/ashlr-host': 'sidecar' }, untracked: { 'desktop/src-tauri/src/secret.rs': 'secret' } }).key).toBe(baseline.key);
    expect(baseline.reads).not.toContain('src/core/daemon/loop.ts');
    expect(cacheKey({ environment: { CARGO_REGISTRIES_PRIVATE_TOKEN: 'secret' } }).key).toBe(baseline.key);
    for (const path of ['desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock', 'desktop/src-tauri/build.rs', 'desktop/src-tauri/src/lib.rs', 'desktop/src-tauri/src/shell_contract.js', 'desktop/src-tauri/src/browser_tap.js', 'desktop/src-tauri/Info.plist', 'desktop/src-tauri/Entitlements.plist', 'desktop/src-tauri/tauri.conf.json', 'desktop/src-tauri/capabilities/main.json', 'desktop/src-tauri/icons/icon.svg', '.github/workflows/ci.yml', '.cargo/config.toml', 'desktop/src-tauri/rust-toolchain.toml']) {
      expect(cacheKey({ files: { [path]: 'changed' } }).key, path).not.toBe(baseline.key);
    }
  });

  it('invalidates compiler, host, SDK, image and flag changes while refusing unsupported or unknown domains', () => {
    const baseline = cacheKey().key;
    for (const probe of ['rustc -vV', 'cargo -V', 'sw_vers -productVersion', 'uname -m', 'xcodebuild -version', 'xcode-select -p', 'xcrun --show-sdk-version', 'xcrun --show-sdk-path']) {
      expect(cacheKey({ probes: { [probe]: probe === 'rustc -vV' ? 'rustc changed\nhost: x86_64-apple-darwin' : 'changed' } }).key, probe).not.toBe(baseline);
    }
    for (const field of ['ImageOS', 'ImageVersion', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CC', 'CFLAGS', 'CXX', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CARGO_PROFILE_DEV_OPT_LEVEL', 'CARGO_PROFILE_TEST_DEBUG', 'CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER', 'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS']) {
      expect(cacheKey({ environment: { [field]: 'changed' } }).key, field).not.toBe(baseline);
    }
    for (const field of ['CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
      expect(() => cacheKey({ environment: { [field]: '/outside' } })).toThrow('unsupported native cache output or wrapper');
    }
    expect(() => cacheKey({ environment: { ImageVersion: '' } })).toThrow('missing native compiler/image identity');
    expect(() => cacheKey({ probes: { 'cargo -V': '' } })).toThrow('missing native compiler probe');
    expect(() => cacheKey({ probes: { 'rustc -vV': 'unknown' } })).toThrow('missing native compiler/image identity');
    expect(() => cacheKey({ nonregular: 'desktop/src-tauri/src/lib.rs' })).toThrow('nonregular native input');
  });
});
