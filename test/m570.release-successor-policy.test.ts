import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalizeReleaseSuccessorPolicy,
  parseReleaseSuccessorPolicyBytes,
  RELEASE_SUCCESSOR_POLICY_AUTHORITY,
  RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION,
  validateReleaseSuccessorPolicy,
  verifyReleaseSuccessorPolicyFile,
} from '../scripts/verify-release-policy.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');
const fixturePath = join(testDir, 'fixtures', 'release-policy', 'valid-v1.json');
const schemaPath = join(repoRoot, '.github', 'release-policies', 'schema-v1.json');
const productionPolicyPath = join(repoRoot, '.github', 'release-policies', 'v3.4.0.json');
const verifierPath = join(repoRoot, 'scripts', 'verify-release-policy.mjs');
const contract = readFileSync(join(repoRoot, 'docs', 'contracts', 'CONTRACT-M570.md'), 'utf8');
const expectedDigest = '4fc13649b76f0f697683a1fb231bb2ca37f26e2ba15699f9e513155b278ff979';
const scratch: string[] = [];

type JsonRecord = Record<string, unknown>;

function validPolicy(): JsonRecord {
  return structuredClone(parseReleaseSuccessorPolicyBytes(readFileSync(fixturePath)).policy) as JsonRecord;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalizeReleaseSuccessorPolicy(value)}\n`, 'utf8');
}

function nested(value: JsonRecord, key: string): JsonRecord {
  return value[key] as JsonRecord;
}

function tempFile(bytes: Buffer | string): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-release-policy-test-'));
  scratch.push(root);
  const path = join(root, 'policy.json');
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('M570 release successor policy v1', () => {
  it('verifies one static canonical synthetic policy and returns no authority', () => {
    const result = parseReleaseSuccessorPolicyBytes(readFileSync(fixturePath));
    expect(result.canonicalSha256).toBe(expectedDigest);
    expect(result.policy).toMatchObject({
      schemaVersion: RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION,
      policyId: 'ashlr-release-successor-v1:9.8.7',
      package: {
        name: '@ashlr/hub',
        version: '9.8.7',
        releaseTag: 'v9.8.7',
        tarballName: 'ashlr-hub-9.8.7.tgz',
        integrity: expect.stringMatching(/^sha512-/u),
      },
      release: {
        distTag: 'candidate',
        requiredProtectedBranch: 'master',
        rollback: { version: '9.7.6' },
      },
      authority: { kind: 'evidence-only', ...RELEASE_SUCCESSOR_POLICY_AUTHORITY },
      localVerification: {
        kind: 'local-production-gate-v1',
        contractPath: 'ashlr.verify.json',
        requiredReceiptSchemaVersion: 1,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.values(RELEASE_SUCCESSOR_POLICY_AUTHORITY)).toEqual(Array(6).fill(false));
  });

  it('ships a closed schema and exact 3.4.0 local-production policy without fixture placeholders', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonRecord;
    const source = readFileSync(fixturePath, 'utf8');
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
    });
    expect(nested(schema, '$defs')).toMatchObject({
      package: { additionalProperties: false },
      release: { additionalProperties: false },
      registry: { additionalProperties: false },
      localVerification: { additionalProperties: false },
      runtime: { additionalProperties: false },
      authority: { additionalProperties: false },
    });
    expect(existsSync(productionPolicyPath)).toBe(true);
    expect(verifyReleaseSuccessorPolicyFile(productionPolicyPath, '3.4.0').policy).toMatchObject({
      release: { requiredFirstParentRevision: '22adafc995a4c9f95fd48bf9572f90f95db1923e' },
      package: { version: '3.4.0' },
    });
    expect(source).not.toMatch(/3\.3\.2|3\.4\.0|abd49a5049759e417d99089b88c628fd2364f79c|d6c1a5ec/u);
    expect(source).toContain('v9.8.7');
  });

  it('records completed 3.3.2 gates without granting successor authority', () => {
    expect(contract).toContain('completed its own trusted-publisher, candidate, provenance, isolated acceptance');
    expect(contract).toContain('`2971c9f767c934e12fd056bf8c6dca5164ffe7d2`');
    expect(contract).toContain('`33932333902`');
    expect(contract).toContain('`33933861238`');
    expect(contract).toContain('npm `latest` and\n`candidate` then both resolved to 3.3.2');
    expect(contract).toContain('did\nnot itself populate an M570 production policy or grant this milestone any\neffect authority');
    expect(contract).toContain('later tracked 3.4.0 policy remains evidence-only');
    expect(contract).not.toContain('must first complete its own trusted-publisher');
  });

  it.each([
    ['unknown top-level field', (policy: JsonRecord) => { policy.extra = true; }],
    ['policy id', (policy: JsonRecord) => { policy.policyId = 'ashlr-release-successor-v1:9.8.8'; }],
    ['candidate release tag', (policy: JsonRecord) => {
      nested(policy, 'package').releaseTag = 'v9.8.8';
    }],
    ['candidate tarball', (policy: JsonRecord) => {
      nested(policy, 'package').tarballName = 'ashlr-hub-next.tgz';
    }],
    ['candidate downgrade', (policy: JsonRecord) => {
      const pkg = nested(policy, 'package');
      pkg.version = '9.7.5';
      pkg.releaseTag = 'v9.7.5';
      pkg.tarballName = 'ashlr-hub-9.7.5.tgz';
      policy.policyId = 'ashlr-release-successor-v1:9.7.5';
    }],
    ['rollback tag', (policy: JsonRecord) => {
      nested(nested(policy, 'release'), 'rollback').releaseTag = 'v9.7.7';
    }],
    ['baseline rollback identity', (policy: JsonRecord) => {
      nested(nested(policy, 'registry'), 'baselineLatest').integrity = `sha512-${'A'.repeat(86)}==`;
    }],
    ['previous candidate identity', (policy: JsonRecord) => {
      nested(nested(policy, 'registry'), 'previousCandidate').revision = '6'.repeat(40);
    }],
    ['quarantine collision', (policy: JsonRecord) => {
      const quarantined = nested(policy, 'registry').quarantined as JsonRecord[];
      quarantined[0].version = '9.7.6';
      quarantined[0].releaseTag = 'v9.7.6';
    }],
    ['history revision collision', (policy: JsonRecord) => {
      const failed = nested(policy, 'registry').failedCandidates as JsonRecord[];
      failed[0].tagRevision = '4'.repeat(40);
    }],
    ['failed candidate absence', (policy: JsonRecord) => {
      const failed = nested(policy, 'registry').failedCandidates as JsonRecord[];
      failed[0].npmVersionAbsent = false;
    }],
    ['candidate integrity', (policy: JsonRecord) => {
      nested(policy, 'package').integrity = 'sha512-invalid';
    }],
    ['local verification contract', (policy: JsonRecord) => {
      nested(policy, 'localVerification').contractPath = '.github/workflows/release.yml';
    }],
    ['local verification contract digest', (policy: JsonRecord) => {
      nested(policy, 'localVerification').contractSha256 = '7'.repeat(63);
    }],
    ['failed candidate receipt digest', (policy: JsonRecord) => {
      const failed = nested(policy, 'registry').failedCandidates as JsonRecord[];
      failed[0].attemptReceiptSha256 = '6'.repeat(63);
    }],
    ['old node toolchain', (policy: JsonRecord) => {
      nested(policy, 'toolchain').nodeVersion = '22.15.0';
    }],
    ['runtime rollback schemas', (policy: JsonRecord) => {
      nested(policy, 'runtime').rollbackManifestSchemaVersions = [3];
    }],
    ['runtime protocol', (policy: JsonRecord) => {
      nested(policy, 'runtime').stoppedConsumerProtocol = 'runtime-activation-stopped-consumer-v1';
    }],
    ['publish authority', (policy: JsonRecord) => {
      nested(policy, 'authority').publish = true;
    }],
    ['activation authority', (policy: JsonRecord) => {
      nested(policy, 'authority').activate = true;
    }],
  ])('rejects %s drift even in canonical bytes', (_label, mutate) => {
    const policy = validPolicy();
    mutate(policy);
    expect(() => parseReleaseSuccessorPolicyBytes(canonicalBytes(policy)))
      .toThrow(/release successor policy:/u);
  });

  it('rejects sparse and decorated history arrays before using their contents', () => {
    const sparse = validPolicy();
    const sparseHistory = nested(sparse, 'registry').quarantined as JsonRecord[];
    sparseHistory.length = 2;
    expect(() => validateReleaseSuccessorPolicy(sparse)).toThrow(/dense array/u);

    const decorated = validPolicy();
    const decoratedHistory = nested(decorated, 'registry').failedCandidates as JsonRecord[];
    Object.defineProperty(decoratedHistory, 'unexpected', { enumerable: true, value: true });
    expect(() => validateReleaseSuccessorPolicy(decorated)).toThrow(/dense array/u);
  });

  it.each([
    ['pretty JSON', () => Buffer.from(`${JSON.stringify(validPolicy(), null, 2)}\n`)],
    ['missing LF', () => canonicalBytes(validPolicy()).subarray(0, -1)],
    ['CRLF', () => Buffer.from(canonicalBytes(validPolicy()).toString('utf8').replace(/\n$/u, '\r\n'))],
    ['trailing bytes', () => Buffer.concat([canonicalBytes(validPolicy()), Buffer.from(' ')])],
    ['BOM', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalBytes(validPolicy())])],
    ['duplicate key', () => Buffer.from(canonicalBytes(validPolicy()).toString('utf8').replace(
      '{"authority":',
      '{"schemaVersion":1,"authority":',
    ))],
    ['invalid UTF-8', () => Buffer.from([0xc3, 0x28, 0x0a])],
    ['oversized input', () => Buffer.alloc(64 * 1024 + 1, 0x20)],
  ])('rejects %s', (_label, bytes) => {
    expect(() => parseReleaseSuccessorPolicyBytes(bytes())).toThrow(/release successor policy:/u);
  });

  it('verifies an explicit path and rejects an expected-version mismatch', () => {
    const accepted = verifyReleaseSuccessorPolicyFile(fixturePath, '9.8.7');
    expect(accepted.canonicalSha256).toBe(expectedDigest);
    expect(accepted.policy.policyId).toBe('ashlr-release-successor-v1:9.8.7');

    const copy = tempFile(readFileSync(fixturePath));
    expect(() => verifyReleaseSuccessorPolicyFile(copy, '9.8.8'))
      .toThrow('package.version does not match --expect-version');
  });

  it('has no network, process, filesystem-write, credential, or runtime authority surface', () => {
    const source = readFileSync(verifierPath, 'utf8');
    expect(source).not.toMatch(/node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|\bspawn(?:Sync)?\s*\(/u);
    expect(source).not.toMatch(/writeFile|appendFile|rename|unlink|mkdir|chmod|chown|launchctl|npm publish/u);
    expect(source).not.toMatch(/process\.env|NPM_TOKEN|NODE_AUTH_TOKEN|ASHLR_HOME/u);
    expect(source).not.toMatch(/\.github\/workflows|releaseEnvironment|promotionEnvironment/u);
    expect(source).not.toContain('.github/release-policies/v3.4.0.json');
  });
});
