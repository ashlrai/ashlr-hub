import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  projectSkillRoutingCalibrationSnapshot,
  SKILL_ROUTING_CALIBRATION_PROJECTION_POLICY_VERSION,
  type SkillRoutingCalibrationSnapshotSourceV1,
} from '../src/core/fleet/skill-routing-calibration-snapshot.js';
import {
  evaluateSkillRoutingCalibration,
  SKILL_ROUTING_CALIBRATION_POLICY_VERSION,
} from '../src/core/fleet/skill-routing-calibration.js';

const KEY = Buffer.alloc(32, 0x45);
const OBSERVED_AT = '2026-07-22T11:57:00.000Z';
const AS_OF = '2026-07-22T12:00:00.000Z';
const CANONICAL_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState',
  'complete', 'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded',
  'skills', 'cases', 'sourceId', 'kind', 'ownerSkillSourceId',
  'excludedSkillSourceId', 'observedAt', 'textParts',
] as const;

function input(
  overrides: Partial<SkillRoutingCalibrationSnapshotSourceV1> = {},
): SkillRoutingCalibrationSnapshotSourceV1 {
  const cases: SkillRoutingCalibrationSnapshotSourceV1['cases'] = [];
  for (const [owner, excluded, token] of [
    ['deploy', 'verify', 'release'],
    ['verify', 'deploy', 'testing'],
  ] as const) {
    for (let index = 0; index < 5; index += 1) {
      cases.push({
        sourceId: `${owner}-positive-${index}`,
        kind: 'positive-owner',
        ownerSkillSourceId: owner,
        excludedSkillSourceId: null,
        observedAt: OBSERVED_AT,
        textParts: [`${token} ${token} workflow`],
      });
    }
    for (let index = 0; index < 3; index += 1) {
      cases.push({
        sourceId: `${owner}-negative-${index}`,
        kind: 'negative-owner',
        ownerSkillSourceId: owner,
        excludedSkillSourceId: excluded,
        observedAt: OBSERVED_AT,
        textParts: [`${token} workflow`],
      });
    }
  }
  return {
    schemaVersion: 1,
    sourceRevision: 'settled-source-v1',
    routerPolicyVersion: SKILL_ROUTING_CALIBRATION_POLICY_VERSION,
    sourceState: 'healthy',
    complete: true,
    invalidRows: 0,
    duplicateRows: 0,
    conflictingRows: 0,
    limitExceeded: false,
    skills: [
      { sourceId: 'deploy', textParts: ['release deployment workflow'] },
      { sourceId: 'verify', textParts: ['testing verification workflow'] },
    ],
    cases,
    ...overrides,
  };
}

function encode(source: SkillRoutingCalibrationSnapshotSourceV1): Buffer {
  return Buffer.from(JSON.stringify(source, CANONICAL_KEYS), 'utf8');
}

function project(
  source = input(),
  key: Buffer = KEY,
) {
  return projectSkillRoutingCalibrationSnapshot(encode(source), key);
}

describe('M453 privacy-safe skill calibration snapshot projection', () => {
  it('projects deterministic HMAC-only snapshots that M450 can evaluate', () => {
    const first = project();
    const second = project(structuredClone(input()));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'projected',
      reason: 'snapshot-projected',
      authority: 'observation-only',
      metadataOnly: true,
      rawSourceReturned: false,
      sourceKeyReturned: false,
      routingAuthority: false,
      learningAuthority: false,
      policyAuthority: false,
      promotionAuthority: false,
      mergeAuthority: false,
    });
    if (first.state !== 'projected' || second.state !== 'projected') throw new Error('projection withheld');
    expect(first.snapshot).toMatchObject({
      routerPolicyVersion: SKILL_ROUTING_CALIBRATION_POLICY_VERSION,
      projectionPolicyVersion: SKILL_ROUTING_CALIBRATION_PROJECTION_POLICY_VERSION,
    });
    expect(first.snapshot.skills).toHaveLength(2);
    expect(first.snapshot.cases).toHaveLength(16);
    for (const skill of first.snapshot.skills) {
      expect(skill.skillId).toMatch(/^[a-f0-9]{64}$/);
      for (const term of skill.vector) expect(term.termId).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(evaluateSkillRoutingCalibration({
      asOf: AS_OF,
      firstSnapshot: first.snapshot,
      secondSnapshot: second.snapshot,
    })).toMatchObject({ gate: 'ready', reason: 'calibration-ready' });
  });

  it('does not return raw identifiers, text, terms, or key bytes', () => {
    const canaries = [
      'private-skill-name', 'raw-super-secret-prompt', 'release', 'testing',
      KEY.toString('hex'),
    ];
    const result = project(input({
      skills: [
        { sourceId: 'private-skill-name', textParts: ['raw-super-secret-prompt release workflow'] },
        { sourceId: 'verify', textParts: ['testing verification workflow'] },
      ],
      cases: [],
    }));
    expect(result.state).toBe('projected');
    const serialized = JSON.stringify(result);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
  });

  it('uses separate HMAC domains for skill, case, and term identities', () => {
    const result = project(input({
      skills: [{ sourceId: 'same', textParts: ['same'] }],
      cases: [{
        sourceId: 'same',
        kind: 'positive-owner',
        ownerSkillSourceId: 'same',
        excludedSkillSourceId: null,
        observedAt: OBSERVED_AT,
        textParts: ['same'],
      }],
    }));
    if (result.state !== 'projected') throw new Error('projection withheld');
    const skillId = result.snapshot.skills[0]!.skillId;
    const caseId = result.snapshot.cases[0]!.caseId;
    const termId = result.snapshot.skills[0]!.vector[0]!.termId;
    expect(new Set([skillId, caseId, termId]).size).toBe(3);
  });

  it.each([
    ['degraded source', { sourceState: 'degraded' }, 'source-degraded'],
    ['incomplete source', { complete: false }, 'source-incomplete'],
    ['invalid rows', { invalidRows: 1 }, 'source-invalid'],
    ['duplicate rows', { duplicateRows: 1 }, 'duplicate-input'],
    ['conflicting rows', { conflictingRows: 1 }, 'conflicting-input'],
    ['declared overflow', { limitExceeded: true }, 'input-limit-exceeded'],
  ] as const)('withholds a %s', (_label, overrides, reason) => {
    expect(project(input(overrides))).toMatchObject({
      state: 'withheld',
      reason,
      snapshot: null,
    });
  });

  it('rejects duplicate source identities and invalid ownership', () => {
    expect(project(input({
      skills: [
        { sourceId: 'deploy', textParts: ['release'] },
        { sourceId: 'deploy', textParts: ['testing'] },
      ],
      cases: [],
    }))).toMatchObject({ state: 'withheld', reason: 'duplicate-input' });

    expect(project(input({
      cases: [{
        sourceId: 'orphan-case',
        kind: 'positive-owner',
        ownerSkillSourceId: 'missing',
        excludedSkillSourceId: null,
        observedAt: OBSERVED_AT,
        textParts: ['release'],
      }],
    }))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
  });

  it('rejects positive exclusions and negative self-exclusions', () => {
    expect(project(input({
      cases: [{
        sourceId: 'bad-positive',
        kind: 'positive-owner',
        ownerSkillSourceId: 'deploy',
        excludedSkillSourceId: 'verify',
        observedAt: OBSERVED_AT,
        textParts: ['release'],
      }],
    }))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });

    expect(project(input({
      cases: [{
        sourceId: 'bad-negative',
        kind: 'negative-owner',
        ownerSkillSourceId: 'deploy',
        excludedSkillSourceId: 'deploy',
        observedAt: OBSERVED_AT,
        textParts: ['release'],
      }],
    }))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
  });

  it('rejects malformed timestamps, key sizes, empty vectors, and policy drift', () => {
    const badTimestamp = input();
    badTimestamp.cases = [{ ...badTimestamp.cases[0]!, observedAt: '2026-07-22T11:57:00Z' }];
    expect(project(badTimestamp)).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(project(input(), Buffer.alloc(31))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(project(input({
      routerPolicyVersion: 'verified-skills-v1',
    }))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(project(input({
      skills: [{ sourceId: 'empty', textParts: ['a the and'] }],
      cases: [],
    }))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
  });

  it('requires direct non-shared Buffer arguments without invoking proxy traps', () => {
    const sourceProxy = new Proxy(encode(input()), {
      getPrototypeOf() {
        throw new Error('proxy trap executed');
      },
    });
    const keyProxy = new Proxy(KEY, {
      getPrototypeOf() {
        throw new Error('proxy trap executed');
      },
    });
    expect(projectSkillRoutingCalibrationSnapshot(sourceProxy, KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
    expect(projectSkillRoutingCalibrationSnapshot(encode(input()), keyProxy)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });

    const sharedSource = Buffer.from(new SharedArrayBuffer(32));
    const sharedKey = Buffer.from(new SharedArrayBuffer(32));
    expect(projectSkillRoutingCalibrationSnapshot(sharedSource, KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
    expect(projectSkillRoutingCalibrationSnapshot(encode(input()), sharedKey)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
  });

  it('copies direct Buffers without invoking hostile own accessors or iterators', () => {
    const sourceBytes = encode(input());
    const sourceBefore = Buffer.from(sourceBytes);
    Object.defineProperties(sourceBytes, {
      length: { get: () => { throw new Error('source length getter executed'); } },
      buffer: { get: () => { throw new Error('source buffer getter executed'); } },
      [Symbol.iterator]: { value: () => { throw new Error('source iterator executed'); } },
    });
    const key = Buffer.from(KEY);
    Object.defineProperties(key, {
      length: { get: () => { throw new Error('key length getter executed'); } },
      buffer: { get: () => { throw new Error('key buffer getter executed'); } },
      [Symbol.iterator]: { value: () => { throw new Error('key iterator executed'); } },
    });

    const result = projectSkillRoutingCalibrationSnapshot(sourceBytes, key);
    expect(result.state).toBe('projected');
    expect(Buffer.compare(sourceBytes, sourceBefore)).toBe(0);
    expect(Buffer.compare(key, KEY)).toBe(0);
  });

  it('rejects invalid UTF-8, invalid JSON, and oversized source bytes before parsing', () => {
    expect(projectSkillRoutingCalibrationSnapshot(Buffer.from([0xff]), KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
    expect(projectSkillRoutingCalibrationSnapshot(Buffer.from('{'), KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
    expect(projectSkillRoutingCalibrationSnapshot(Buffer.alloc(5 * 1024 * 1024 + 1), KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
  });

  it('rejects noncanonical JSON, duplicate keys, and unknown fields', () => {
    const source = input();
    expect(projectSkillRoutingCalibrationSnapshot(
      Buffer.from(JSON.stringify(source, null, 2)),
      KEY,
    )).toMatchObject({ state: 'withheld', reason: 'invalid-input' });

    const duplicate = encode(source).toString('utf8').replace(
      '{"schemaVersion":1,',
      '{"schemaVersion":1,"schemaVersion":1,',
    );
    expect(projectSkillRoutingCalibrationSnapshot(Buffer.from(duplicate), KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });

    expect(projectSkillRoutingCalibrationSnapshot(Buffer.from(JSON.stringify({
      ...source,
      unknownSecret: 'raw-super-secret-prompt',
    })), KEY)).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
  });

  it('rejects alternate JSON escapes for otherwise equivalent source data', () => {
    const source = input({
      skills: [
        { sourceId: 'folder/deploy', textParts: ['release deployment workflow'] },
        { sourceId: 'verify', textParts: ['testing verification workflow'] },
      ],
      cases: [],
    });
    const alternateEscape = encode(source).toString('utf8').replace('folder/deploy', 'folder\\/deploy');
    expect(projectSkillRoutingCalibrationSnapshot(Buffer.from(alternateEscape), KEY)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
    });
  });

  it('bounds vector width and aggregate source text', () => {
    const tooManyTerms = Array.from({ length: 257 }, (_, index) => `term${index}`).join(' ');
    expect(project(input({
      skills: [{ sourceId: 'wide', textParts: [tooManyTerms] }],
      cases: [],
    }))).toMatchObject({ state: 'withheld', reason: 'input-limit-exceeded' });

    const largePart = `large ${'x'.repeat(8 * 1024 - 6)}`;
    const cases = Array.from({ length: 520 }, (_, index) => ({
      sourceId: `large-case-${index}`,
      kind: 'positive-owner' as const,
      ownerSkillSourceId: 'deploy',
      excludedSkillSourceId: null,
      observedAt: OBSERVED_AT,
      textParts: [largePart],
    }));
    expect(project(input({ cases }))).toMatchObject({
      state: 'withheld',
      reason: 'input-limit-exceeded',
    });
  });

  it('does not modify caller-owned source or key buffers', () => {
    const sourceBytes = encode(input());
    const sourceBefore = Buffer.from(sourceBytes);
    const key = Buffer.from(KEY);
    const keyBefore = Buffer.from(key);
    expect(projectSkillRoutingCalibrationSnapshot(sourceBytes, key).state).toBe('projected');
    expect(sourceBytes).toEqual(sourceBefore);
    expect(key).toEqual(keyBefore);
  });

  it('has no runtime consumer or public API export', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const modulePath = join('core', 'fleet', 'skill-routing-calibration-snapshot.ts');
    const sourceFiles = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.ts') && path !== modulePath);
    for (const path of sourceFiles) {
      expect(readFileSync(join(sourceRoot, path), 'utf8')).not.toContain('skill-routing-calibration-snapshot');
    }
  });
});
