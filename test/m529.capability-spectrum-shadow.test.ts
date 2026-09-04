import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import type { ExecutionIdentityPublicResourceV1 } from '../src/core/fabric/execution-identity.js';
import {
  CAPABILITY_SPECTRUM_MAX_RESOURCES,
  buildCapabilitySpectrumShadowV1,
  digestCapabilityClassV1,
  verifyCapabilitySpectrumShadowV1,
  type CapabilitySpectrumInputV1,
  type CapabilitySpectrumLaneV1,
  type CapabilitySpectrumLocalResourceV1,
} from '../src/core/fabric/capability-spectrum.js';

const digest = (label: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
const AS_OF = '2026-09-03T12:00:00.000Z';
const OBSERVED = '2026-09-03T11:59:00.000Z';
const MODEL_CLASS = digestCapabilityClassV1('model', 'codex')!;
const COMPUTE_CLASS = digest('c');
const WORKTREE_CLASS = digest('w');
const TOOL_CLASS = digest('t');

function identity(overrides: Partial<ExecutionIdentityPublicResourceV1> = {}): ExecutionIdentityPublicResourceV1 {
  return {
    executionIdentityDigest: digest('1'),
    engine: 'codex',
    state: 'open',
    trustedSlots: 2,
    maxConcurrent: 2,
    usedPercent: 20,
    observedAt: OBSERVED,
    reason: 'observed-open',
    ...overrides,
  };
}

function local(
  resourceDigest: `sha256:${string}`,
  kind: CapabilitySpectrumLocalResourceV1['kind'],
  classDigest: `sha256:${string}`,
  overrides: Partial<CapabilitySpectrumLocalResourceV1> = {},
): CapabilitySpectrumLocalResourceV1 {
  return {
    resourceDigest,
    kind,
    classDigest,
    state: 'open',
    maxUnits: 4,
    trustedUnits: 4,
    observedAt: OBSERVED,
    resetAt: null,
    ...overrides,
  };
}

function lane(
  laneDigest: `sha256:${string}`,
  queueRank: number,
  requirements: CapabilitySpectrumLaneV1['requirements'],
  overrides: Partial<CapabilitySpectrumLaneV1> = {},
): CapabilitySpectrumLaneV1 {
  return { laneDigest, queueRank, sourceComplete: true, requirements, ...overrides };
}

function input(overrides: Partial<CapabilitySpectrumInputV1> = {}): CapabilitySpectrumInputV1 {
  return {
    schemaVersion: 1,
    asOf: AS_OF,
    sourceDigest: digest('s'),
    resourceEnvelopeDigest: 'e'.repeat(64),
    executionIdentitySourceState: 'healthy',
    executionIdentityResources: [{ resource: identity() }],
    resetWindows: [{ executionIdentityDigest: digest('1'), resetAt: '2026-09-03T13:00:00.000Z' }],
    localResources: [
      local(digest('2'), 'compute', COMPUTE_CLASS),
      local(digest('3'), 'worktree', WORKTREE_CLASS, { trustedUnits: 2, maxUnits: 2 }),
      local(digest('4'), 'tool', TOOL_CLASS, { trustedUnits: 1, maxUnits: 1 }),
    ],
    lanes: [lane(digest('a'), 1, [
      { kind: 'model', classDigest: MODEL_CLASS, units: 1 },
      { kind: 'compute', classDigest: COMPUTE_CLASS, units: 2 },
      { kind: 'worktree', classDigest: WORKTREE_CLASS, units: 1 },
      { kind: 'tool', classDigest: TOOL_CLASS, units: 1 },
    ])],
    ...overrides,
  };
}

function spectrum(value: unknown = input()) {
  const result = buildCapabilitySpectrumShadowV1(value);
  if (!result.ok) throw new Error(`expected spectrum: ${result.issues.join(',')}`);
  return result.spectrum;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function resign(value: ReturnType<typeof spectrum>): ReturnType<typeof spectrum> {
  const unsigned: Record<string, unknown> = { ...value };
  delete unsigned['projectionDigest'];
  return {
    ...value,
    projectionDigest: `sha256:${createHash('sha256')
      .update('ashlr:capability-spectrum:projection:v1', 'utf8').update('\0')
      .update(canonicalJson(unsigned), 'utf8').digest('hex')}`,
  };
}

describe('M529 Capability Spectrum shadow projection', () => {
  it('is deterministic across input order and spends earliest-reset capacity first', () => {
    const secondIdentity = identity({ executionIdentityDigest: digest('5'), trustedSlots: 1, maxConcurrent: 1 });
    const first = spectrum(input({
      executionIdentityResources: [{ resource: identity() }, { resource: secondIdentity }],
      resetWindows: [
        { executionIdentityDigest: digest('1'), resetAt: '2026-09-03T14:00:00.000Z' },
        { executionIdentityDigest: digest('5'), resetAt: '2026-09-03T12:30:00.000Z' },
      ],
    }));
    const reversedInput = input({
      executionIdentityResources: [{ resource: secondIdentity }, { resource: identity() }],
      resetWindows: [
        { executionIdentityDigest: digest('5'), resetAt: '2026-09-03T12:30:00.000Z' },
        { executionIdentityDigest: digest('1'), resetAt: '2026-09-03T14:00:00.000Z' },
      ],
      localResources: [...input().localResources].reverse(),
      lanes: [...input().lanes].reverse(),
    });
    const second = spectrum(reversedInput);

    expect(second).toEqual(first);
    expect(verifyCapabilitySpectrumShadowV1(first)).toEqual(first);
    expect(first.inventory.find((item) => item.resourceDigest === digest('5'))?.spendPriority).toBe(1);
    expect(first.lanes[0]?.requirements.find((item) => item.kind === 'model')?.allocations[0])
      .toMatchObject({ resourceDigest: digest('5'), resetAt: '2026-09-03T12:30:00.000Z' });
  });

  it('zeros unknown, stale, expired, future, invalid, and source-degraded capacity', () => {
    const stale = local(digest('6'), 'compute', COMPUTE_CLASS, {
      observedAt: '2026-09-03T11:00:00.000Z', trustedUnits: 100, maxUnits: 100,
    });
    const expired = local(digest('7'), 'worktree', WORKTREE_CLASS, {
      resetAt: AS_OF, trustedUnits: 100, maxUnits: 100,
    });
    const future = local(digest('8'), 'tool', TOOL_CLASS, {
      observedAt: '2026-09-03T12:02:00.000Z', trustedUnits: 100, maxUnits: 100,
    });
    const unknown = local(digest('9'), 'tool', digest('u'), {
      state: 'unknown', trustedUnits: 100, maxUnits: 100,
    });
    const output = spectrum(input({
      executionIdentitySourceState: 'degraded',
      localResources: [stale, expired, future, unknown, {
        ...local(digest('0'), 'tool', digest('v')),
        locator: '/secret/tool/path',
      } as CapabilitySpectrumLocalResourceV1],
    }));

    expect(output.inventory.every((item) => item.trustedUnits === 0)).toBe(true);
    expect(new Set(output.inventory.map((item) => item.reason))).toEqual(new Set([
      'source-degraded', 'observation-stale', 'reset-elapsed', 'observation-future', 'unavailable-state',
    ]));
    expect(output.quarantine.invalidLocalResources).toBe(1);
    expect(JSON.stringify(output)).not.toContain('/secret/tool/path');
  });

  it('accepts only the shared bounded future-skew tolerance', () => {
    const withinTolerance = spectrum(input({
      localResources: [local(digest('8'), 'tool', TOOL_CLASS, {
        observedAt: '2026-09-03T12:01:00.000Z', trustedUnits: 1, maxUnits: 1,
      })],
      lanes: [],
    }));
    const beyondTolerance = spectrum(input({
      localResources: [local(digest('8'), 'tool', TOOL_CLASS, {
        observedAt: '2026-09-03T12:01:00.001Z', trustedUnits: 1, maxUnits: 1,
      })],
      lanes: [],
    }));

    expect(withinTolerance.inventory.find((item) => item.resourceDigest === digest('8')))
      .toMatchObject({ state: 'available', trustedUnits: 1 });
    expect(beyondTolerance.inventory.find((item) => item.resourceDigest === digest('8')))
      .toMatchObject({ state: 'unavailable', reason: 'observation-future', trustedUnits: 0 });
  });

  it('degrades a contended lane locally without halting or consuming its partial capacity', () => {
    const lanes = [
      lane(digest('a'), 1, [
        { kind: 'compute', classDigest: COMPUTE_CLASS, units: 2 },
        { kind: 'tool', classDigest: digest('z'), units: 1 },
      ]),
      lane(digest('b'), 2, [{ kind: 'compute', classDigest: COMPUTE_CLASS, units: 4 }]),
    ];
    const output = spectrum(input({ lanes }));

    expect(output.globalHalt).toBe(false);
    expect(output.lanes[0]).toMatchObject({ laneDigest: digest('a'), state: 'degraded', reason: 'capability-unavailable' });
    expect(output.lanes[0]?.requirements.every((item) => item.allocations.length === 0)).toBe(true);
    expect(output.lanes[1]).toMatchObject({ laneDigest: digest('b'), state: 'ready' });
    expect(output.lanes[1]?.requirements[0]?.allocations).toEqual([
      { resourceDigest: digest('2'), units: 4, resetAt: null },
    ]);
    expect(output.contention.find((item) => item.classDigest === COMPUTE_CLASS)).toMatchObject({
      requestedUnits: 6, trustedUnits: 4, shortageUnits: 2, state: 'contended',
    });
  });

  it('quarantines malformed rows and incomplete lanes rather than globally halting', () => {
    const malformedIdentity = { resource: { ...identity(), privateRuntimeLocatorRef: 'erl_secret' } };
    const malformedLane = { ...lane(digest('d'), 3, [
      { kind: 'compute', classDigest: COMPUTE_CLASS, units: 1 },
    ]), unexpected: true };
    const output = spectrum(input({
      executionIdentityResources: [malformedIdentity as never],
      lanes: [
        lane(digest('c'), 1, [{ kind: 'compute', classDigest: COMPUTE_CLASS, units: 1 }], {
          sourceComplete: false,
        }),
        malformedLane as CapabilitySpectrumLaneV1,
        lane(digest('e'), 2, [{ kind: 'worktree', classDigest: WORKTREE_CLASS, units: 1 }]),
      ],
    }));

    expect(output.globalHalt).toBe(false);
    expect(output.quarantine).toMatchObject({ invalidIdentityResources: 1, invalidLanes: 1 });
    expect(output.lanes.find((item) => item.laneDigest === digest('c'))?.reason).toBe('lane-source-incomplete');
    expect(output.lanes.find((item) => item.laneDigest === digest('d'))?.reason).toBe('invalid-lane');
    expect(output.lanes.find((item) => item.laneDigest === digest('e'))?.state).toBe('ready');
    const encoded = JSON.stringify(output);
    expect(encoded).not.toContain('privateRuntimeLocatorRef');
    expect(encoded).not.toContain('erl_secret');
  });

  it('globally halts only for malformed shared envelopes or identity ambiguity', () => {
    expect(buildCapabilitySpectrumShadowV1({ ...input(), unexpected: true })).toEqual({
      ok: false, globalHalt: true, spectrum: null, issues: ['invalid-input'],
    });
    expect(buildCapabilitySpectrumShadowV1(input({
      localResources: [local(digest('1'), 'compute', COMPUTE_CLASS)],
    }))).toEqual({
      ok: false, globalHalt: true, spectrum: null, issues: ['shared-resource-identity-collision'],
    });
    expect(buildCapabilitySpectrumShadowV1(input({
      localResources: [{
        ...local(digest('1'), 'compute', COMPUTE_CLASS), unexpected: true,
      } as CapabilitySpectrumLocalResourceV1],
    }))).toEqual({
      ok: false, globalHalt: true, spectrum: null, issues: ['shared-resource-identity-collision'],
    });
    expect(buildCapabilitySpectrumShadowV1(input({
      lanes: [input().lanes[0]!, input().lanes[0]!],
    }))).toEqual({
      ok: false, globalHalt: true, spectrum: null, issues: ['shared-lane-identity-collision'],
    });
    expect(buildCapabilitySpectrumShadowV1(input({
      resetWindows: [
        { executionIdentityDigest: digest('1'), resetAt: '2026-09-03T13:00:00.000Z' },
        { executionIdentityDigest: digest('1'), resetAt: '2026-09-03T14:00:00.000Z' },
      ],
    }))).toEqual({
      ok: false, globalHalt: true, spectrum: null, issues: ['shared-reset-window-conflict'],
    });
  });

  it('rejects unknown output fields, nested shape changes, and forged authority/effects', () => {
    const output = spectrum();
    expect(verifyCapabilitySpectrumShadowV1({ ...output, unexpected: true })).toBeNull();
    expect(verifyCapabilitySpectrumShadowV1({ ...output, executionAuthority: true })).toBeNull();
    expect(verifyCapabilitySpectrumShadowV1({
      ...output, effects: { ...output.effects, dispatches: true },
    })).toBeNull();
    expect(verifyCapabilitySpectrumShadowV1({
      ...output,
      inventory: output.inventory.map((item, index) => index === 0 ? { ...item, rawError: 'secret' } : item),
    })).toBeNull();

    const forgedAllocation = resign({
      ...output,
      lanes: output.lanes.map((laneEntry, laneIndex) => laneIndex === 0 ? {
        ...laneEntry,
        requirements: laneEntry.requirements.map((requirement, requirementIndex) => requirementIndex === 0 ? {
          ...requirement,
          allocations: requirement.allocations.map((allocation) => ({
            ...allocation, resourceDigest: digest('not-a-real-resource'),
          })),
        } : requirement),
      } : laneEntry),
    });
    expect(verifyCapabilitySpectrumShadowV1(forgedAllocation)).toBeNull();

    const expiredCapacity = resign({
      ...output,
      inventory: output.inventory.map((item) => item.state === 'available' ? {
        ...item, resetAt: '2026-09-03T11:00:00.000Z',
      } : item),
      lanes: output.lanes.map((laneEntry) => ({
        ...laneEntry,
        requirements: laneEntry.requirements.map((requirement) => ({
          ...requirement,
          allocations: requirement.allocations.map((allocation) => ({
            ...allocation, resetAt: '2026-09-03T11:00:00.000Z',
          })),
        })),
      })),
    });
    expect(verifyCapabilitySpectrumShadowV1(expiredCapacity)).toBeNull();
  });

  it('rejects cyclic and oversized output envelopes without throwing', () => {
    const output = spectrum();
    const cyclicInventory: Record<string, unknown> = {};
    cyclicInventory['resourceDigest'] = cyclicInventory;
    expect(() => verifyCapabilitySpectrumShadowV1({
      ...output, inventory: [cyclicInventory],
    })).not.toThrow();
    expect(verifyCapabilitySpectrumShadowV1({
      ...output, inventory: [cyclicInventory],
    })).toBeNull();

    const oversizedInventory = Array.from(
      { length: CAPABILITY_SPECTRUM_MAX_RESOURCES * 2 + 1 },
      () => output.inventory[0],
    );
    expect(verifyCapabilitySpectrumShadowV1({ ...output, inventory: oversizedInventory })).toBeNull();
  });

  it('does not expose raw identities, paths, secret names, errors, or effect authority', () => {
    const output = spectrum();
    expect(output).toMatchObject({
      authority: 'observation-only', executionAuthority: false, routingAuthority: false,
      reservationAuthority: false, budgetAuthority: false, mutationAuthority: false,
    });
    expect(Object.values(output.effects).every((effect) => effect === false)).toBe(true);
    const keys = JSON.stringify(output);
    for (const forbidden of ['identityRef', 'locator', 'path', 'secret', 'rawError', 'CODEX_HOME']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
