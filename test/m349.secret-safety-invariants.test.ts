/**
 * M349 — cross-store synthetic secret safety invariants.
 *
 * These tests use fake, provider-shaped values only. They prove the metadata
 * ledgers that feed Ashlr's learning loop can keep causal/action data without
 * retaining raw credential bodies.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendHubEntry, loadGenome } from '../src/core/genome/store.js';
import { recordDecision, readDecisions } from '../src/core/fleet/decisions-ledger.js';
import {
  recordDispatchProduction,
  readDispatchProductionEvents,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { recordAgentAction, readAgentActions } from '../src/core/fleet/agent-action-ledger.js';
import { recordJudgeTrace, readJudgeTraces } from '../src/core/fleet/judge-trace.js';
import { listAttemptRecords, summarizeAttemptCoverage } from '../src/core/autonomy/attempt-records.js';
import { audit, readAudit } from '../src/core/sandbox/audit.js';
import { scrubSecrets } from '../src/core/util/scrub.js';
import type { AshlrConfig } from '../src/core/types.js';

const SAFE_COMMIT_SHA = 'deadbeefcafef00ddeadbeefcafef00ddeadbeef';
const SECRET_VALUES = [
  'sk-testvalue-verysecret00000000',
  'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ',
  'glpat-ABCDEF1234567890abcdef',
  'hf_abcdefghijklmnopqrstuvwxyz123456',
  'npm_abcdefghijklmnopqrstuvwxyz123456',
  'AKIAIOSFODNN7EXAMPLE',
  'AIzaSyD1234567890abcdefghijklmnopqrstuv',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
];

const SECRET_BUNDLE = [
  ...SECRET_VALUES,
  'Authorization Bearer sk-testvalue-verysecret00000000',
  'password=literal-secret-value-DO-NOT-LOG',
  'postgres://user:literal-secret-value-DO-NOT-LOG@localhost/db',
  '-----BEGIN PRIVATE KEY-----\n' +
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n' +
    '-----END PRIVATE KEY-----',
].join(' ');

const RAW_EXECUTION_CANARIES = [
  'RAW_PROMPT_CANARY_DO_NOT_SERIALIZE_M349',
  'RAW_DIFF_CANARY_DO_NOT_SERIALIZE_M349',
  'RAW_STDOUT_CANARY_DO_NOT_SERIALIZE_M349',
  'RAW_STDERR_CANARY_DO_NOT_SERIALIZE_M349',
  'ASHLR_SECRET=RAW_ENV_CANARY_DO_NOT_SERIALIZE_M349',
  'RAW_FILE_CONTENT_CANARY_DO_NOT_SERIALIZE_M349',
  'RAW_ARGV_CANARY_DO_NOT_SERIALIZE_M349',
] as const;

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

function allPersistedText(root: string): string {
  if (!existsSync(root)) return '';
  const chunks: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        chunks.push(readFileSync(file, 'utf8'));
      }
    }
  };
  visit(root);
  return chunks.join('\n');
}

function assertNoSecretValues(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    ...SECRET_VALUES,
    'literal-secret-value-DO-NOT-LOG',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

function expectRedacted(label: string, value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  expect(serialized, label).toContain('[REDACTED]');
  assertNoSecretValues(serialized);
}

function assertNoRawExecutionPayloads(label: string, value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of RAW_EXECUTION_CANARIES) {
    expect(serialized, label).not.toContain(canary);
  }
}

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m349-secret-safety-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('M349 secret safety invariants', () => {
  it('redacts a shared provider-token canary corpus', () => {
    const scrubbed = scrubSecrets(`${SECRET_BUNDLE} commit ${SAFE_COMMIT_SHA}`);

    assertNoSecretValues(scrubbed);
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).toContain(SAFE_COMMIT_SHA);
  });

  it('keeps action, dispatch, decision, audit, judge, and genome stores metadata-only for fake secrets', () => {
    audit({
      action: 'm349:audit-canary',
      repo: '/tmp/repo',
      sandboxId: null,
      summary: `audit summary ${SECRET_BUNDLE}`,
      result: 'ok',
    });

    recordDecision({
      ts: '2026-07-09T06:00:00.000Z',
      proposalId: 'prop-m349',
      action: 'judged',
      verdict: `ship ${SECRET_BUNDLE}`,
      reason: `decision reason ${SECRET_BUNDLE}`,
      detail: `decision detail ${SECRET_BUNDLE}`,
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: `gpt-5.5 token=${SECRET_VALUES[0]}`,
        assignedBy: 'm349',
        reason: `route reason ${SECRET_BUNDLE}`,
      },
      runEventSummary: {
        runId: `run-m349 token=${SECRET_VALUES[1]}`,
        status: `done token=${SECRET_VALUES[2]}`,
        outcome: `proposal-created token=${SECRET_VALUES[3]}`,
        proposalCreated: true,
        diffFiles: 1,
        diffLines: 2,
        actionCounts: {
          proposalCreated: 1,
          [`count token=${SECRET_VALUES[8]}`]: 7,
          unknownCounter: 9,
        } as never,
      },
      evidenceOutcome: {
        target: `main token=${SECRET_VALUES[4]}`,
        trustBasis: 'evidence',
        riskClass: `low token=${SECRET_VALUES[5]}`,
        verificationPassed: true,
        policyAllowed: true,
        policyAction: `automerge token=${SECRET_VALUES[6]}`,
      },
    });

    recordDispatchProduction({
      schemaVersion: 1,
      ts: '2026-07-09T06:00:01.000Z',
      itemId: `item token=${SECRET_VALUES[0]}`,
      source: 'test',
      repo: `/tmp/repo token=${SECRET_VALUES[1]}`,
      title: `dispatch title ${SECRET_BUNDLE}`,
      backend: 'codex',
      tier: 'frontier',
      model: `gpt-5.5 token=${SECRET_VALUES[2]}`,
      assignedBy: 'm349',
      routeReason: `dispatch route ${SECRET_BUNDLE}`,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-m349',
      runId: 'run-m349',
      spentUsd: 0.01,
      reason: `dispatch reason ${SECRET_BUNDLE}`,
      basis: 'run-proposal-outcome',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        reason: `route snapshot ${SECRET_BUNDLE}`,
      },
    });

    recordAgentAction({
      schemaVersion: 1,
      ts: '2026-07-09T06:00:02.000Z',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'proposal-created',
      action: `agent action token=${SECRET_VALUES[3]}`,
      summary: `agent summary ${SECRET_BUNDLE}`,
      repo: `/tmp/repo token=${SECRET_VALUES[4]}`,
      itemId: `item token=${SECRET_VALUES[5]}`,
      proposalId: 'prop-m349',
      runId: 'run-m349',
      backend: 'codex',
      tier: 'frontier',
      model: `gpt-5.5 token=${SECRET_VALUES[6]}`,
      reason: `agent reason ${SECRET_BUNDLE}`,
      tags: [`tag token=${SECRET_VALUES[7]}`],
      counts: { [`count token=${SECRET_VALUES[8]}`]: 1 },
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        reason: `route action ${SECRET_BUNDLE}`,
      },
      runEventSummary: {
        runId: 'run-m349',
        status: 'done',
        actionCounts: {
          sandboxCreated: 1,
          proposalCreated: 1,
          [`count token=${SECRET_VALUES[8]}`]: 7,
          unknownCounter: 9,
        } as never,
      },
    });

    recordJudgeTrace({
      proposalId: 'prop-m349',
      judgeEngine: 'codex',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 4, alignment: 5 },
      fullReasoning: `judge reasoning ${SECRET_BUNDLE}`,
      promptContext: `judge prompt ${SECRET_BUNDLE}`,
    });

    const entry = appendHubEntry({
      title: `genome title ${SECRET_BUNDLE}`,
      text: `genome body ${SECRET_BUNDLE}`,
      project: `project token=${SECRET_VALUES[0]}`,
      tags: [`tag token=${SECRET_VALUES[1]}`],
      hubOnly: true,
    });
    const genomeConfig = { version: 1, roots: [] } as AshlrConfig;

    const readBack = {
      audit: readAudit(),
      decisions: readDecisions({ proposalId: 'prop-m349' }),
      dispatch: readDispatchProductionEvents(),
      actions: readAgentActions(),
      judge: readJudgeTraces({ proposalId: 'prop-m349' }),
      attemptRecords: listAttemptRecords({ windowHours: 48 }),
      attemptCoverage: summarizeAttemptCoverage(listAttemptRecords({ windowHours: 48 }), 48),
      genomeEntry: entry,
      genomeLoaded: loadGenome(genomeConfig),
      files: allPersistedText(join(tmpHome, '.ashlr')),
    };

    expect(readBack.audit).toHaveLength(1);
    expect(readBack.decisions).toHaveLength(1);
    expect(readBack.dispatch).toHaveLength(1);
    expect(readBack.actions).toHaveLength(1);
    expect(readBack.judge).toHaveLength(1);
    expect(readBack.attemptRecords).toHaveLength(1);
    expect(readBack.genomeLoaded.some((row) => row.id === entry.id)).toBe(true);

    expectRedacted('audit record', readBack.audit[0]);
    expectRedacted('decision record', readBack.decisions[0]);
    expectRedacted('dispatch record', readBack.dispatch[0]);
    expectRedacted('agent-action record', readBack.actions[0]);
    expectRedacted('judge trace record', readBack.judge[0]);
    expectRedacted('attempt record', readBack.attemptRecords[0]);
    expectRedacted('genome returned entry', readBack.genomeEntry);
    expectRedacted('genome loaded entry', readBack.genomeLoaded.find((row) => row.id === entry.id));

    const root = join(tmpHome, '.ashlr');
    expectRedacted('audit raw bytes', allPersistedText(join(root, 'audit')));
    expectRedacted('decisions raw bytes', allPersistedText(join(root, 'decisions')));
    expectRedacted('dispatch raw bytes', allPersistedText(join(root, 'dispatch-production')));
    expectRedacted('agent-actions raw bytes', allPersistedText(join(root, 'agent-actions')));
    expectRedacted('judge raw bytes', allPersistedText(join(root, 'judge-traces')));
    expectRedacted('genome raw bytes', allPersistedText(join(root, 'genome')));

    assertNoSecretValues(readBack);
    expect(readBack.decisions[0]).toMatchObject({
      proposalId: 'prop-m349',
      learningSource: 'decision-ledger',
      labelBasis: 'judge-verdict',
      routerPolicyVersion: 'fleet-router-v1',
      learningEpoch: '2026-07-09',
    });
    expect(readBack.decisions[0]?.runEventSummary?.actionCounts).toEqual({ proposalCreated: 1 });
    expect(readBack.actions[0]?.runEventSummary?.actionCounts).toEqual({
      sandboxCreated: 1,
      proposalCreated: 1,
    });
  });

  it('keeps attempt-record and fleet coverage surfaces metadata-only for raw execution payloads', () => {
    const [
      rawPrompt,
      rawDiff,
      rawStdout,
      rawStderr,
      rawEnv,
      rawFileContents,
      rawArgv,
    ] = RAW_EXECUTION_CANARIES;
    const records = listAttemptRecords({
      deps: {
        readDispatchProductionEvents: () => [{
          schemaVersion: 1,
          ts: '2026-07-09T06:00:03.000Z',
          itemId: 'item-m349-attempt',
          source: 'goal',
          repo: '/tmp/repo',
          title: 'safe attempt title',
          backend: 'codex',
          tier: 'frontier',
          model: 'gpt-5.5',
          assignedBy: 'm349',
          routeReason: 'safe route',
          outcome: 'proposal-created',
          proposalCreated: true,
          proposalId: 'prop-m349-attempt',
          runId: 'run-m349-attempt',
          trajectoryId: 'traj-m349-attempt',
          spentUsd: 0,
          basis: 'run-proposal-outcome',
          runEventSummary: {
            runId: 'run-m349-attempt',
            status: 'done',
            outcome: 'proposal-created',
            proposalCreated: true,
            proposalId: 'prop-m349-attempt',
            diffFiles: 1,
            diffLines: 2,
            actionCounts: {
              proposalCreated: 1,
              diffFiles: 1,
              diffLines: 2,
              [`stdout:${rawStdout}`]: 1,
              [`argv:${rawArgv}`]: 1,
            } as never,
          },
          prompt: rawPrompt,
          diff: `diff --git a/secret.ts b/secret.ts\n+${rawDiff}`,
          stdout: rawStdout,
          stderr: rawStderr,
          env: { ASHLR_SECRET: rawEnv },
          files: [{ path: 'src/secret.ts', content: `const secretFile = "${rawFileContents}";` }],
          command: { argv: ['codex', 'exec', '--dangerously-allow-all', rawArgv] },
        } as never],
        readAgentActions: () => [{
          schemaVersion: 1,
          ts: '2026-07-09T06:00:04.000Z',
          actor: 'daemon',
          kind: 'dispatch',
          outcome: 'proposal-created',
          action: 'dispatch',
          summary: rawStdout,
          repo: '/tmp/repo',
          itemId: 'item-m349-attempt',
          proposalId: 'prop-m349-attempt',
          runId: 'run-m349-attempt',
          trajectoryId: 'traj-m349-attempt',
          stdout: rawStdout,
          stderr: rawStderr,
          env: rawEnv,
          argv: ['codex', 'exec', '--dangerously-allow-all', rawArgv],
        } as never],
        listOutcomeRecords: () => [{
          version: 1,
          proposal: {
            id: 'prop-m349-attempt',
            repo: '/tmp/repo',
            origin: 'agent',
            kind: 'patch',
            status: 'pending',
            title: 'safe proposal title',
            summary: rawPrompt,
            diff: `diff --git a/secret.ts b/secret.ts\n+${rawDiff}`,
            createdAt: '2026-07-09T06:00:05.000Z',
          },
          lastActivityAt: '2026-07-09T06:00:05.000Z',
          decisions: [{ detail: rawPrompt }],
          judgeTraces: [],
          evidencePacks: [],
          workedEvents: [],
        } as never],
        readDecisions: () => [{
          ts: '2026-07-09T06:00:06.000Z',
          proposalId: 'prop-m349-attempt',
          action: 'judged',
          detail: `${rawPrompt}\ndiff --git a/secret.ts b/secret.ts\n+${rawDiff}`,
        } as never],
        listAutonomyEvidencePacks: () => [{
          proposal: { id: 'prop-m349-attempt' },
          gates: { verification: { detail: rawStderr } },
          fileContents: rawFileContents,
        } as never],
        loadWorkedLedger: () => ({
          events: [{
            itemId: 'item-m349-attempt',
            proposalId: 'prop-m349-attempt',
            outcome: 'diff',
            ts: '2026-07-09T06:00:07.000Z',
            argv: rawArgv,
          } as never],
        }),
      },
    });
    const fleetCoverage = summarizeAttemptCoverage(records);

    expect(records).toHaveLength(1);
    expect(records[0]?.coverage).toEqual({
      agentAction: true,
      outcomeRecord: true,
      decision: true,
      evidence: true,
      worked: true,
    });
    expect(records[0]?.actionCounts).toEqual({
      proposalCreated: 1,
      diffFiles: 1,
      diffLines: 2,
    });
    assertNoRawExecutionPayloads('attempt-record surface', records);
    assertNoRawExecutionPayloads('fleet coverage surface', { attemptCoverage: fleetCoverage });
  });
});
