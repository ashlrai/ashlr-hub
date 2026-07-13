import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdRecovery } from '../src/cli/recovery.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';
import type { ProviderClient, RunTask } from '../src/core/types.js';
import { releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  effectJournalDirectory,
  effectJournalExecutionSupported,
  commitToolEffect,
  hasUnresolvedToolEffects,
  prepareToolEffect,
  readEffectJournal,
  resolvePreparedEffect,
} from '../src/core/util/effect-journal.js';

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

function task(): RunTask {
  return { id: 'task-1', goal: 'make the change', deps: [], status: 'pending' };
}

function client(toolCallId: string): ProviderClient {
  let calls = 0;
  return {
    id: 'test-provider',
    supportsTools: true,
    async chat() {
      calls += 1;
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: toolCallId,
              name: 'edit_file',
              arguments: { path: 'src/a.ts', old_string: 'a', new_string: 'b' },
            }],
            usage: { tokensIn: 1, tokensOut: 1 },
          }
        : { content: 'done', usage: { tokensIn: 1, tokensOut: 1 } };
    },
  };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m394-effects-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
});

describe('effect journal platform support', () => {
  it('fails closed on platforms without durable directory-entry installation', () => {
    expect(effectJournalExecutionSupported()).toBe(process.platform !== 'win32');
    expect(prepareToolEffect({
      scopeId: 'unsupported-platform', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'bash', toolCallId: 'call-1',
      arguments: { command: 'opaque-command' }, safety: 'exec',
    })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe.skipIf(process.platform === 'win32')('agent-loop effect authority integration', () => {
  it('elects exactly one preparer across independent processes', async () => {
    const source = String.raw`
      import { prepareToolEffect } from './src/core/util/effect-journal.ts';
      const result = prepareToolEffect({
        scopeId: 'run-race', generation: '123e4567-e89b-12d3-a456-426614174000',
        taskId: 'task-1', ordinal: 1, toolName: 'edit_file', toolCallId: process.pid.toString(),
        arguments: { path: 'x', old_string: 'a', new_string: 'b' }, safety: 'write',
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const runChild = (): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`child timeout: ${stderr}`)); }, 15_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr));
        else resolve(JSON.parse(stdout) as Record<string, unknown>);
      });
    });
    const results = await Promise.all([runChild(), runChild()]);
    expect(results.filter((result) => result['ok'] === true)).toHaveLength(1);
    expect(results.filter((result) => result['reason'] === 'duplicate'), JSON.stringify(results)).toHaveLength(1);
    expect(readEffectJournal().records).toHaveLength(1);
  }, 30_000);

  it('retains prepared ambiguity after an independent process exits before commit', () => {
    const externalMarker = path.join(home, 'observable-effect.log');
    const source = String.raw`
      import * as fs from 'node:fs';
      import { prepareToolEffect } from './src/core/util/effect-journal.ts';
      const result = prepareToolEffect({
        scopeId: 'run-crash',
        generation: '123e4567-e89b-12d3-a456-426614174000',
        taskId: 'task-1',
        ordinal: 1,
        toolName: 'proposal_tool',
        toolCallId: 'child-call',
        arguments: { command: 'opaque-command' },
        safety: 'proposal',
      });
      if (result.ok) fs.appendFileSync(process.env.EFFECT_MARKER, 'happened\n');
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, EFFECT_MARKER: externalMarker },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: true });
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');
    expect(hasUnresolvedToolEffects('run-crash', '223e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(prepareToolEffect({
      scopeId: 'run-crash',
      generation: '223e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 99,
      toolName: 'proposal_tool',
      toolCallId: 'successor-call',
      arguments: { command: 'opaque-command' },
      safety: 'proposal',
    })).toMatchObject({ ok: false, reason: 'duplicate', phase: 'prepared' });
    expect(fs.readFileSync(externalMarker, 'utf8')).toBe('happened\n');
  });

  it('commits one mutating tool call and suppresses a semantic replay with a different provider id', async () => {
    const execute = vi.fn(async () => 'edited');
    const context = {
      tools: [{ name: 'edit_file', safety: 'write', fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'run-1', generation: '123e4567-e89b-12d3-a456-426614174000' },
    };

    const first = await runTask(task(), client('call_0'), context);
    expect(first.status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readEffectJournal().records).toHaveLength(1);
    expect(readEffectJournal().records[0]?.phase).toBe('committed');
    expect(hasUnresolvedToolEffects('run-1', context.effectJournal.generation)).toBe(false);

    const second = await runTask(task(), client('provider-reused-a-different-id'), context);
    expect(second.status).toBe('failed');
    expect(second.error).toContain('effect authority refused edit_file: duplicate');
    expect(execute).toHaveBeenCalledTimes(1);

    const successor = await runTask(task(), client('successor-write'), {
      ...context,
      effectJournal: { scopeId: 'run-1', generation: '223e4567-e89b-12d3-a456-426614174000' },
    });
    expect(successor.status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(readEffectJournal().records).toHaveLength(2);
  });

  it('retains prepared ambiguity when a mutating tool throws after an observable effect', async () => {
    const effects: string[] = [];
    const execute = vi.fn(async () => {
      effects.push('happened');
      throw new Error('connection dropped after effect');
    });
    const context = {
      tools: [{ name: 'edit_file', safety: 'write' as const, fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'run-thrown-effect', generation: '123e4567-e89b-12d3-a456-426614174000' },
    };

    const first = await runTask(task(), client('effect-then-throw'), context);
    expect(first.status).toBe('failed');
    expect(first.error).toContain('operator reconciliation is required');
    expect(effects).toEqual(['happened']);
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');

    const retry = await runTask(task(), client('different-provider-call-id'), context);
    expect(retry.status).toBe('failed');
    expect(retry.error).toContain('effect authority refused edit_file: duplicate');
    expect(execute).toHaveBeenCalledOnce();
    expect(effects).toEqual(['happened']);
  });

  it('bounds effectful calls from one provider response before execution', async () => {
    const execute = vi.fn(async () => 'edited');
    const manyCalls: NonNullable<Awaited<ReturnType<ProviderClient['chat']>>['toolCalls']> =
      Array.from({ length: 65 }, (_, index) => ({
        id: `call-${index}`,
        name: 'edit_file',
        arguments: { path: `src/${index}.ts`, old_string: 'a', new_string: 'b' },
      }));
    const provider: ProviderClient = {
      id: 'effect-flood-provider',
      supportsTools: true,
      async chat() {
        return { content: '', toolCalls: manyCalls, usage: { tokensIn: 1, tokensOut: 1 } };
      },
    };
    const result = await runTask(task(), provider, {
      tools: [{ name: 'edit_file', safety: 'write', fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'run-effect-cap', generation: '123e4567-e89b-12d3-a456-426614174000' },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('effect cap exceeded (64)');
    expect(execute).toHaveBeenCalledTimes(64);
    expect(readEffectJournal().records).toHaveLength(64);
  }, 30_000);

  it('does not journal explicitly read-only tools', async () => {
    const execute = vi.fn(async () => 'content');
    const result = await runTask(task(), client('read-call'), {
      tools: [{ name: 'edit_file', safety: 'read', fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'run-read', generation: '123e4567-e89b-12d3-a456-426614174000' },
    });
    expect(result.status).toBe('done');
    expect(execute).toHaveBeenCalledOnce();
    expect(readEffectJournal().sourceState).toBe('missing');
  });

  it('accepts bounded planner labels without letting labels authorize semantic replay', () => {
    const base = {
      scopeId: 'run-task-label', generation: '123e4567-e89b-12d3-a456-426614174000',
      ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-1',
      arguments: { command: 'opaque-command' }, safety: 'proposal' as const,
    };
    const upper = prepareToolEffect({ ...base, taskId: 'Implement API' });
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(commitToolEffect(upper.effect, 'done')).toBe(true);
    const lower = prepareToolEffect({ ...base, taskId: 'implement API' });
    expect(lower).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(readEffectJournal().records).toHaveLength(1);
  });

  it('persists only metadata digests and never raw arguments or outcomes', () => {
    const argumentSecret = 'argument-secret-7fef7f';
    const outcomeSecret = 'outcome-secret-9a9a9a';
    const prepared = prepareToolEffect({
      scopeId: 'run-private-metadata', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-private',
      arguments: { command: `deploy --token ${argumentSecret}` }, safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(commitToolEffect(prepared.effect, `stdout ${outcomeSecret}`)).toBe(true);

    const persisted = fs.readdirSync(effectJournalDirectory())
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(effectJournalDirectory(), name), 'utf8'))
      .join('\n');
    expect(persisted).not.toContain(argumentSecret);
    expect(persisted).not.toContain(outcomeSecret);
    expect(persisted).not.toContain('deploy --token');
  });

  it('leaves prepared ambiguity when a definitive outcome exceeds its bound', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-outcome-bound', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-large-outcome',
      arguments: { command: 'opaque-command' }, safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(commitToolEffect(prepared.effect, 'x'.repeat(1024 * 1024 + 1))).toBe(false);
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');
  });

  it.each(['append', 'proposal', 'write'] as const)(
    'binds %s effects to the intended identity policy across generations',
    (safety) => {
      const input = {
        scopeId: `run-policy-${safety}`,
        generation: '123e4567-e89b-12d3-a456-426614174000',
        taskId: 'task-1', ordinal: 1, toolName: `tool_${safety}`, toolCallId: 'call-1',
        arguments: { operation: safety }, safety,
      };
      const first = prepareToolEffect(input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(commitToolEffect(first.effect, 'done')).toBe(true);
      expect(readEffectJournal().records.find((record) => record.effectId === first.effect.effectId))
        .toMatchObject({ identityPolicy: safety === 'write' ? 'generation-bound' : 'scope-bound' });

      const successor = prepareToolEffect({
        ...input,
        generation: '223e4567-e89b-12d3-a456-426614174000',
        toolCallId: 'provider-changed-call-id',
      });
      if (safety === 'write') {
        expect(successor.ok).toBe(true);
        if (successor.ok) expect(commitToolEffect(successor.effect, 'done')).toBe(true);
      } else {
        expect(successor).toMatchObject({ ok: false, reason: 'duplicate', phase: 'committed' });
      }
    },
  );

  it('refuses a classified effect when the caller omitted journal authority', async () => {
    const execute = vi.fn(async () => 'edited');
    const result = await runTask(task(), client('missing-scope'), {
      tools: [{ name: 'edit_file', safety: 'write', fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('effect authority is unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect(readEffectJournal().sourceState).toBe('missing');
  });

  it('retains fail-closed evidence when the effect record is corrupted before commit', async () => {
    const execute = vi.fn(async () => {
      const record = readEffectJournal().records[0];
      expect(record?.phase).toBe('prepared');
      const file = fs.readdirSync(effectJournalDirectory()).find((name) => name.startsWith('.effect-v1-'));
      fs.writeFileSync(path.join(effectJournalDirectory(), file!), '{"torn":true}\n');
      return 'effect may have happened';
    });
    const result = await runTask(task(), client('corrupt-call'), {
      tools: [{ name: 'edit_file', safety: 'write', fn: execute }],
      budget: { maxTokens: 100, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'run-corrupt', generation: '123e4567-e89b-12d3-a456-426614174000' },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('operator reconciliation is required');
    expect(readEffectJournal().sourceState).toBe('degraded');
    expect(hasUnresolvedToolEffects('run-corrupt', '123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('retains run ambiguity when observed journal evidence is deleted and the directory is recreated', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-recreated-journal', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-1',
      arguments: { proposal: 'opaque' }, safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(commitToolEffect(prepared.effect, 'done')).toBe(true);
    fs.rmSync(effectJournalDirectory(), { recursive: true, force: true });
    fs.mkdirSync(effectJournalDirectory(), { recursive: true, mode: 0o700 });

    expect(hasUnresolvedToolEffects(
      'run-recreated-journal',
      '123e4567-e89b-12d3-a456-426614174000',
    )).toBe(true);
    expect(prepareToolEffect({
      scopeId: 'run-recreated-journal', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-2',
      arguments: { proposal: 'opaque' }, safety: 'proposal',
    })).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe.skipIf(process.platform === 'win32')('operator recovery CLI', () => {
  it('rejects unknown commands, duplicate flags, and whitespace forensic reasons', async () => {
    const effectId = 'a'.repeat(64);
    const attestation = 'b'.repeat(64);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdRecovery(['frobnicate', effectId])).toBe(2);
    expect(stderr.mock.calls.flat().join('')).toContain('unknown recovery subcommand');
    stderr.mockClear();
    expect(await cmdRecovery(['list', '--json', '--json'])).toBe(2);
    expect(await cmdRecovery(['inspect', effectId, '--json', '--json'])).toBe(2);
    expect(await cmdRecovery([
      'abandon', effectId, '--expect', attestation, '--reason', '   ',
    ])).toBe(2);
  });

  it('supports bounded JSON inspection and refuses non-interactive disposition', async () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-recovery',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'proposal_tool',
      toolCallId: 'call-1',
      arguments: { command: 'opaque-command' },
      safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    const record = readEffectJournal().records[0]!;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdRecovery(['inspect', record.effectId, '--json'])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain(record.effectId);

    expect(await cmdRecovery([
      'abandon', record.effectId,
      '--expect', record.attestation,
      '--reason', 'positive operator disposition',
    ])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('interactive exact-id confirmation required');
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');
  });

  it('keeps prepared evidence immutable and records an authenticated terminal sidecar', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-terminal',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'proposal_tool',
      toolCallId: 'call-1',
      arguments: { command: 'opaque-command' },
      safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const original = fs.readFileSync(prepared.effect.recordPath, 'utf8');
    expect(commitToolEffect(prepared.effect, undefined)).toBe(true);
    expect(fs.readFileSync(prepared.effect.recordPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(effectJournalDirectory()).filter((name) => name.startsWith('.terminal-v1-'))).toHaveLength(1);
    expect(readEffectJournal().records[0]?.phase).toBe('committed');
    if (process.platform !== 'win32') {
      expect(fs.statSync(prepared.effect.recordPath).mode & 0o077).toBe(0);
      expect(fs.statSync(effectJournalDirectory()).mode & 0o077).toBe(0);
    }
  });

  it('refuses stale commit authority and accepts only the exact prepare capability', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-stale',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'edit_file',
      toolCallId: 'call-1',
      arguments: { path: 'x', old_string: 'a', new_string: 'b' },
      safety: 'write',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(commitToolEffect({ ...prepared.effect, ownerToken: '00000000-0000-0000-0000-000000000000' }, 'done')).toBe(false);
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');
    expect(commitToolEffect(prepared.effect, 'done')).toBe(true);
    expect(readEffectJournal().records[0]?.phase).toBe('committed');
  });

  it('records an exact terminal resolution without authorizing replay', () => {
    const input = {
      scopeId: 'run-resolved',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'proposal_tool',
      toolCallId: 'call-1',
      arguments: { command: 'opaque-command' },
      safety: 'proposal' as const,
    };
    const prepared = prepareToolEffect(input);
    expect(prepared.ok).toBe(true);
    const record = readEffectJournal().records[0]!;
    expect(resolvePreparedEffect({
      effectId: record.effectId,
      expectedAttestation: record.attestation,
      resolution: 'attested-no-effect',
      evidenceDigest: 'a'.repeat(64),
    })).toBe(false);
    if (prepared.ok) releaseLocalStoreLock(prepared.effect.liveLock);
    expect(resolvePreparedEffect({
      effectId: record.effectId,
      expectedAttestation: record.attestation,
      resolution: 'attested-no-effect',
      evidenceDigest: 'a'.repeat(64),
    })).toBe(true);
    expect(readEffectJournal().records[0]).toMatchObject({
      phase: 'resolved',
      resolution: 'attested-no-effect',
      preparedAttestation: record.attestation,
    });
    expect(hasUnresolvedToolEffects(
      'run-resolved',
      '123e4567-e89b-12d3-a456-426614174000',
    )).toBe(true);
    expect(prepareToolEffect({ ...input, generation: '223e4567-e89b-12d3-a456-426614174000' }))
      .toMatchObject({ ok: false, reason: 'duplicate', phase: 'resolved' });
  });

  it('rejects invalid runtime dispositions without replacing valid prepared evidence', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-invalid-resolution',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'edit_file',
      toolCallId: 'call-1',
      arguments: { path: 'x', old_string: 'a', new_string: 'b' },
      safety: 'write',
    });
    expect(prepared.ok).toBe(true);
    const record = readEffectJournal().records[0]!;
    expect(resolvePreparedEffect({
      effectId: record.effectId,
      expectedAttestation: record.attestation,
      resolution: 'bogus' as never,
      evidenceDigest: 'a'.repeat(64),
    })).toBe(false);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'healthy' });
    expect(readEffectJournal().records[0]?.phase).toBe('prepared');
  });

  it('binds signed record identity to its scope-indexed filename', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-filename',
      generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1',
      ordinal: 1,
      toolName: 'edit_file',
      toolCallId: 'call-1',
      arguments: { path: 'x', old_string: 'a', new_string: 'b' },
      safety: 'write',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const forgedName = path.basename(prepared.effect.recordPath).replace(/[a-f0-9]{64}\.json$/, `${'b'.repeat(64)}.json`);
    fs.copyFileSync(prepared.effect.recordPath, path.join(effectJournalDirectory(), forgedName));
    const result = readEffectJournal();
    expect(result.sourceState).toBe('degraded');
    expect(result.invalidRecords).toBe(1);
  });

  it('does not strand an unrelated scope when another scope is corrupt', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-corrupt-a', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'edit_file', toolCallId: 'call-1',
      arguments: { path: 'x', old_string: 'a', new_string: 'b' }, safety: 'write',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    fs.writeFileSync(prepared.effect.recordPath, '{"torn":true}\n');
    expect(readEffectJournal().sourceState).toBe('degraded');
    expect(hasUnresolvedToolEffects('run-corrupt-a', '123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(hasUnresolvedToolEffects('run-healthy-b', '123e4567-e89b-12d3-a456-426614174000')).toBe(false);
  });

  it('refuses new effects in a visibly corrupt scope', () => {
    const first = prepareToolEffect({
      scopeId: 'run-corrupt-scope', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'edit_file', toolCallId: 'call-1',
      arguments: { path: 'x', old_string: 'a', new_string: 'b' }, safety: 'write',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    releaseLocalStoreLock(first.effect.liveLock);
    fs.writeFileSync(first.effect.recordPath, '{"torn":true}\n');

    expect(prepareToolEffect({
      scopeId: 'run-corrupt-scope', generation: '223e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-2', ordinal: 1, toolName: 'edit_file', toolCallId: 'call-2',
      arguments: { path: 'y', old_string: 'a', new_string: 'b' }, safety: 'write',
    })).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('fails closed on a torn terminal sidecar and preserves its forensic residue', () => {
    const input = {
      scopeId: 'run-torn-terminal', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-1',
      arguments: { command: 'opaque-command' }, safety: 'proposal' as const,
    };
    const prepared = prepareToolEffect(input);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    releaseLocalStoreLock(prepared.effect.liveLock);
    const terminal = path.join(
      effectJournalDirectory(),
      path.basename(prepared.effect.recordPath).replace('.effect-v1-', '.terminal-v1-'),
    );
    fs.writeFileSync(terminal, '{"torn":true}\n', { mode: 0o600 });

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded', records: [] });
    expect(prepareToolEffect(input)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(resolvePreparedEffect({
      effectId: prepared.effect.effectId,
      expectedAttestation: 'a'.repeat(64),
      resolution: 'abandoned',
      evidenceDigest: 'b'.repeat(64),
    })).toBe(false);
    expect(fs.readFileSync(terminal, 'utf8')).toBe('{"torn":true}\n');
  });

  it('treats a missing provenance key as unresolved degraded evidence', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-missing-key', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-1',
      arguments: { command: 'opaque-command' }, safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    releaseLocalStoreLock(prepared.effect.liveLock);
    fs.unlinkSync(provenanceKeyPath());

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded', records: [] });
    expect(hasUnresolvedToolEffects(
      'run-missing-key',
      '123e4567-e89b-12d3-a456-426614174000',
    )).toBe(true);
  });

  it('fails closed when a newer or malformed journal artifact is present', () => {
    const prepared = prepareToolEffect({
      scopeId: 'run-format-floor', generation: '123e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-1', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-1',
      arguments: { command: 'opaque-command' }, safety: 'proposal',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    releaseLocalStoreLock(prepared.effect.liveLock);
    fs.writeFileSync(path.join(effectJournalDirectory(), '.effect-v2-future.json'), '{}\n', { mode: 0o600 });

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded', invalidRecords: 1 });
    expect(prepareToolEffect({
      scopeId: 'run-other-scope', generation: '223e4567-e89b-12d3-a456-426614174000',
      taskId: 'task-2', ordinal: 1, toolName: 'proposal_tool', toolCallId: 'call-2',
      arguments: { command: 'another-command' }, safety: 'proposal',
    })).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
