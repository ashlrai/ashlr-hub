import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_MISSION_GRAPH_NODES,
  compileEcosystemMissionGraph,
  ecosystemMissionGraphDigest,
  projectEcosystemMissionGraph,
  validateEcosystemMissionGraph,
  type EcosystemMissionGraphV1,
  type MissionGraphInput,
  type MissionGraphNodeInput,
} from '../src/core/vision/mission-graph.js';

function work(
  key: string,
  targetRepo: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<MissionGraphNodeInput> = {},
): MissionGraphNodeInput {
  return {
    kind: 'work',
    key,
    title: `Build ${key}`,
    objective: `Implement the ${key} part of the mission`,
    deliverable: `${key} ships a versioned, verified capability`,
    riskClass: 'medium',
    targetRepo,
    dependsOn,
    acceptance: [`${key} focused verification passes`],
    outcomeContract: {
      desiredOutcome: `${key} measurably improves the user workflow`,
      successSignals: [`${key} is exercised end-to-end`],
      guardrails: [`${key} does not broaden mutation authority`],
    },
    ...overrides,
  };
}

function gate(key: string, dependsOn: readonly string[] = []): MissionGraphNodeInput {
  return {
    kind: 'human-gate',
    key,
    title: `Approve ${key}`,
    objective: `Confirm the ${key} release decision`,
    deliverable: `A human approval receipt for ${key}`,
    riskClass: 'high',
    targetRepo: null,
    dependsOn,
    acceptance: ['The operator reviewed the complete upstream evidence set'],
  };
}

function mission(nodes: readonly MissionGraphNodeInput[]): MissionGraphInput {
  return {
    missionKey: 'autonomous-team-os',
    title: 'Autonomous Team Operating System',
    objective: 'Coordinate a trustworthy multi-repository delivery mission',
    createdAt: '2026-08-09T23:30:00.000Z',
    nodes,
  };
}

function withRepos(run: (repos: { hub: string; cortex: string; root: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m491-'));
  const hub = join(root, 'ashlr-hub');
  const cortex = join(root, 'ashlr-cortex');
  mkdirSync(hub);
  mkdirSync(cortex);
  try {
    run({ hub, cortex, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function compileOrThrow(input: MissionGraphInput, repos: readonly string[]): EcosystemMissionGraphV1 {
  const result = compileEcosystemMissionGraph(input, repos);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.graph;
}

describe('M491 ecosystem mission graph compilation', () => {
  it('canonicalizes node, dependency, acceptance, and outcome-signal order into one digest', () => {
    withRepos(({ hub, cortex }) => {
      const first = compileOrThrow(mission([
        work('cortex-contract', cortex, [], {
          acceptance: ['Contract test passes', 'Schema is versioned'],
        }),
        work('hub-consumer', hub, ['cortex-contract'], {
          acceptance: ['Integration passes', 'CLI remains compatible'],
          outcomeContract: {
            desiredOutcome: 'The mission executes across repositories',
            successSignals: ['Operator sees completion', 'Consumer uses contract'],
            guardrails: ['No deployment authority', 'No merge bypass'],
          },
        }),
      ]), [hub, cortex]);
      const second = compileOrThrow(mission([
        work('hub-consumer', hub, ['cortex-contract'], {
          acceptance: ['CLI remains compatible', 'Integration passes'],
          outcomeContract: {
            desiredOutcome: 'The mission executes across repositories',
            successSignals: ['Consumer uses contract', 'Operator sees completion'],
            guardrails: ['No merge bypass', 'No deployment authority'],
          },
        }),
        work('cortex-contract', cortex, [], {
          acceptance: ['Schema is versioned', 'Contract test passes'],
        }),
      ]), [cortex, hub]);

      expect(second).toEqual(first);
      expect(first.graphDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(ecosystemMissionGraphDigest(first)).toBe(first.graphDigest);
      expect(validateEcosystemMissionGraph(first)).toEqual([]);
      expect(first.nodes.find((node) => node.key === 'hub-consumer')).toMatchObject({
        repo: hub,
        deliverable: 'hub-consumer ships a versioned, verified capability',
        riskClass: 'medium',
      });

      const punctuation = compileOrThrow(mission([
        work('a_0', hub), work('a.0', hub), work('a-0', hub),
      ]), [hub]);
      expect(punctuation.nodes.map((node) => node.key)).toEqual(['a-0', 'a.0', 'a_0']);
    });
  });

  it('resolves only an exact enrolled root or unambiguous exact basename', () => {
    withRepos(({ hub, root }) => {
      const otherParent = join(root, 'other');
      const duplicateHub = join(otherParent, 'ashlr-hub');
      mkdirSync(otherParent);
      mkdirSync(duplicateHub);

      const exact = compileEcosystemMissionGraph(mission([work('exact', hub)]), [hub, duplicateHub]);
      expect(exact.ok).toBe(true);

      const ambiguous = compileEcosystemMissionGraph(
        mission([work('ambiguous', 'ashlr-hub')]),
        [hub, duplicateHub],
      );
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) expect(ambiguous.issues.map((entry) => entry.code)).toContain('repository-target-ambiguous');

      const malformed = compileEcosystemMissionGraph(mission([work('malformed', '../ashlr-hub')]), [hub]);
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.issues.map((entry) => entry.code)).toContain('invalid-repository-target');

      const lexicalAlias = compileEcosystemMissionGraph(
        mission([work('alias', `${hub}/../ashlr-hub`)]),
        [hub],
      );
      expect(lexicalAlias.ok).toBe(false);
      if (!lexicalAlias.ok) expect(lexicalAlias.issues.map((entry) => entry.code)).toContain('invalid-repository-target');
    });
  });

  it('fails closed for duplicate keys, missing dependencies, self edges, and cycles', () => {
    withRepos(({ hub, cortex }) => {
      const cases = [
        { nodes: [work('same', hub), work('same', cortex)], code: 'duplicate-node-key' },
        { nodes: [work('missing', hub, ['absent'])], code: 'missing-dependency' },
        { nodes: [work('self', hub, ['self'])], code: 'self-dependency' },
        { nodes: [work('one', hub, ['two']), work('two', cortex, ['one'])], code: 'cyclic-dependency' },
      ] as const;
      for (const sample of cases) {
        const result = compileEcosystemMissionGraph(mission(sample.nodes), [hub, cortex]);
        expect(result.ok, sample.code).toBe(false);
        if (!result.ok) expect(result.issues.map((entry) => entry.code), sample.code).toContain(sample.code);
      }
    });
  });

  it('bounds graph size and requires valid deliverable, risk, acceptance, and outcome contracts', () => {
    withRepos(({ hub }) => {
      const oversized = compileEcosystemMissionGraph(
        mission(Array.from({ length: MAX_MISSION_GRAPH_NODES + 1 }, (_, index) => work(`node-${index}`, hub))),
        [hub],
      );
      expect(oversized.ok).toBe(false);
      if (!oversized.ok) expect(oversized.issues.map((entry) => entry.code)).toContain('too-many-nodes');

      const invalid = compileEcosystemMissionGraph(mission([
        work('invalid-contract', hub, [], {
          deliverable: '',
          riskClass: 'urgent' as 'low',
          acceptance: [],
          outcomeContract: { desiredOutcome: '', successSignals: [], guardrails: [] },
        }),
      ]), [hub]);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
          'invalid-deliverable',
          'invalid-risk-class',
          'too-many-acceptance-criteria',
          'invalid-outcome-contract',
        ]));
      }
    });
  });

  it('requires repository-neutral human gates', () => {
    withRepos(({ hub }) => {
      const invalidGate = { ...gate('release'), targetRepo: hub };
      const result = compileEcosystemMissionGraph(mission([invalidGate]), [hub]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((entry) => entry.code)).toContain('human-gate-repository-target');
    });
  });

  it('detects canonical content tampering', () => {
    withRepos(({ hub }) => {
      const graph = compileOrThrow(mission([work('hub', hub)]), [hub]);
      const tampered = structuredClone(graph);
      tampered.nodes[0]!.deliverable = 'A different deliverable';
      expect(validateEcosystemMissionGraph(tampered).map((entry) => entry.code)).toContain('digest-mismatch');

      const widened = structuredClone(graph) as EcosystemMissionGraphV1 & { authority?: string };
      widened.authority = 'deploy';
      expect(validateEcosystemMissionGraph(widened).map((entry) => entry.code)).toContain('invalid-schema');
    });
  });

  it('returns a validation result instead of throwing for malformed runtime input', () => {
    const result = compileEcosystemMissionGraph(null as unknown as MissionGraphInput, []);
    expect(result).toEqual({
      ok: false,
      issues: [{ code: 'invalid-schema', path: '$', message: 'mission graph input is structurally invalid' }],
    });
  });
});

describe('M491 ecosystem mission graph projection', () => {
  it('projects dependency readiness, work lifecycle, and an explicit human gate', () => {
    withRepos(({ hub, cortex }) => {
      const graph = compileOrThrow(mission([
        work('cortex-contract', cortex),
        work('hub-consumer', hub, ['cortex-contract']),
        gate('release-approval', ['hub-consumer']),
      ]), [hub, cortex]);

      const initial = projectEcosystemMissionGraph(graph, []);
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(initial.projection.status).toBe('ready');
      expect(initial.projection.nodes.map((node) => [node.key, node.status, node.blockedBy])).toEqual([
        ['cortex-contract', 'ready', []],
        ['hub-consumer', 'blocked', ['cortex-contract']],
        ['release-approval', 'blocked', ['hub-consumer']],
      ]);

      const building = projectEcosystemMissionGraph(graph, [
        { nodeKey: 'cortex-contract', state: 'realized' },
        { nodeKey: 'hub-consumer', state: 'proposed' },
      ]);
      expect(building.ok).toBe(true);
      if (!building.ok) return;
      expect(building.projection.status).toBe('in-progress');
      expect(building.projection.nodes.map((node) => [node.key, node.status])).toEqual([
        ['cortex-contract', 'complete'],
        ['hub-consumer', 'proposed'],
        ['release-approval', 'blocked'],
      ]);

      const awaiting = projectEcosystemMissionGraph(graph, [
        { nodeKey: 'cortex-contract', state: 'realized' },
        { nodeKey: 'hub-consumer', state: 'realized' },
      ]);
      expect(awaiting.ok && awaiting.projection.status).toBe('awaiting-human');

      const complete = projectEcosystemMissionGraph(graph, [
        { nodeKey: 'cortex-contract', state: 'realized' },
        { nodeKey: 'hub-consumer', state: 'realized' },
        { nodeKey: 'release-approval', humanApproved: true },
      ]);
      expect(complete.ok && complete.projection.status).toBe('complete');
    });
  });

  it('does not let out-of-order realized evidence unlock downstream work', () => {
    withRepos(({ hub, cortex }) => {
      const graph = compileOrThrow(mission([
        work('upstream', cortex),
        work('downstream', hub, ['upstream']),
      ]), [hub, cortex]);
      const result = projectEcosystemMissionGraph(graph, [
        { nodeKey: 'downstream', state: 'realized' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.projection.nodes.find((node) => node.key === 'downstream')).toMatchObject({
        status: 'blocked',
        observedState: 'realized',
        blockedBy: ['upstream'],
      });
    });
  });

  it('fails closed for duplicate, unknown, and kind-incompatible observations', () => {
    withRepos(({ hub }) => {
      const graph = compileOrThrow(mission([work('work', hub), gate('gate')]), [hub]);
      const result = projectEcosystemMissionGraph(graph, [
        { nodeKey: 'work', state: 'active' },
        { nodeKey: 'work', state: 'proposed' },
        { nodeKey: 'unknown', state: 'active' },
        { nodeKey: 'gate', state: 'realized' },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(new Set(result.issues.map((entry) => entry.code))).toEqual(new Set([
          'duplicate-observation',
          'unknown-observation-node',
          'invalid-observation',
        ]));
      }
    });
  });
});

describe('M491 authority boundary', () => {
  it('imports only deterministic Node primitives and no outward-action module', () => {
    const source = readFileSync(join(process.cwd(), 'src/core/vision/mission-graph.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports).toEqual([
      "import { createHash } from 'node:crypto';",
      "import { basename, isAbsolute, resolve } from 'node:path';",
    ]);
    expect(source).not.toMatch(/from ['"][^'"]*(?:merge|apply|push|deploy|provider|daemon|inbox|sandbox)[^'"]*['"]/);
  });
});
