import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  operationalProposalProjectionDir,
  validateOperationalProposalStageText,
} from '../src/core/inbox/operational-projection.js';
import {
  operationalProjectionStageDir,
  operationalProjectionStagePath,
  readOperationalProjectionStage,
  writeOperationalProjectionStage,
  type OperationalProjectionStagedArtifactMetadata,
} from '../src/core/inbox/operational-projection-staging.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const TRANSACTION_ID = 'a'.repeat(64);

let home: string;

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function metadata(text: string): OperationalProjectionStagedArtifactMetadata {
  return {
    present: true,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function validate(text: string) {
  return { digest: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8') };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m435-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.ashlr'), { mode: 0o700 });
  fs.mkdirSync(operationalProposalProjectionDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(home, '.ashlr'), 0o700);
    fs.chmodSync(operationalProposalProjectionDir(), 0o700);
  }
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
});

describe('M435 operational projection staging', () => {
  it('uses deterministic transaction-scoped private paths and validates staged bytes on reread', () => {
    const text = '{"proposal":"alpha"}\n';
    const expected = metadata(text);
    expect(operationalProjectionStagePath(TRANSACTION_ID, 'proposal'))
      .toBe(path.join(operationalProjectionStageDir(TRANSACTION_ID), 'proposal.json'));
    expect(writeOperationalProjectionStage(
      TRANSACTION_ID, 'proposal', Buffer.from(text, 'utf8'), expected, validate,
    )).toEqual({ ok: true });
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'proposal', expected, validate))
      .toEqual({ state: 'present', text });
    if (process.platform !== 'win32') {
      expect(fs.statSync(operationalProjectionStageDir(TRANSACTION_ID)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(operationalProjectionStagePath(TRANSACTION_ID, 'proposal')).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts the real canonical proposal identity validator through the storage boundary', () => {
    const proposalId = 'stage-real-proposal';
    const proposal = {
      id: proposalId,
      kind: 'patch',
      origin: 'agent',
      repo: null,
      status: 'pending',
      summary: 'Canonical staged proposal summary.',
      title: 'Canonical staged proposal',
      createdAt: '2026-07-20T00:00:00.000Z',
    };
    const text = JSON.stringify(Object.fromEntries(
      Object.entries(proposal).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ));
    const validation = validateOperationalProposalStageText(text, proposalId);
    expect(validation).not.toBeNull();
    if (!validation) return;
    expect(validateOperationalProposalStageText(
      JSON.stringify({ id: proposalId, title: 'Missing proposal fields' }), proposalId,
    )).toBeNull();
    const expected = { present: true, ...validation } as const;
    const validateProposal = (candidate: string) =>
      validateOperationalProposalStageText(candidate, proposalId);
    expect(writeOperationalProjectionStage(
      TRANSACTION_ID, 'proposal', Buffer.from(text, 'utf8'), expected, validateProposal,
    )).toEqual({ ok: true });
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'proposal', expected, validateProposal))
      .toEqual({ state: 'present', text });
  });

  it('refuses malformed identity, metadata mismatch, and a stale deletion artifact', () => {
    const text = '{"projection":"beta"}';
    const expected = metadata(text);
    expect(writeOperationalProjectionStage('bad', 'projection', Buffer.from(text), expected, validate))
      .toEqual({ ok: false, reason: 'stage-input-invalid' });
    expect(writeOperationalProjectionStage(
      TRANSACTION_ID, 'projection', Buffer.from(text), { ...expected, bytes: expected.bytes + 1 }, validate,
    )).toEqual({ ok: false, reason: 'stage-content-invalid' });
    expect(writeOperationalProjectionStage(TRANSACTION_ID, 'projection', Buffer.from(text), expected, validate))
      .toEqual({ ok: true });
    const deletion = { present: false, digest: null, bytes: 0 } as const;
    expect(writeOperationalProjectionStage(TRANSACTION_ID, 'projection', Buffer.alloc(0), deletion, validate))
      .toEqual({ ok: false, reason: 'stage-expected-absent' });
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'projection', deletion, validate))
      .toEqual({ state: 'degraded', reason: 'stage-expected-absent' });
  });

  it('does not treat a missing transaction stage directory as a valid deletion', () => {
    const deletion = { present: false, digest: null, bytes: 0 } as const;
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'proposal', deletion, validate))
      .toEqual({ state: 'degraded', reason: 'stage-missing' });
  });

  it('fails closed when a staged artifact is replaced after publication', () => {
    const text = '{"proposal":"gamma"}';
    const expected = metadata(text);
    expect(writeOperationalProjectionStage(TRANSACTION_ID, 'proposal', Buffer.from(text), expected, validate))
      .toEqual({ ok: true });
    fs.writeFileSync(operationalProjectionStagePath(TRANSACTION_ID, 'proposal'), '{"proposal":"tampered"}');
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'proposal', expected, validate))
      .toEqual({ state: 'degraded', reason: 'stage-content-invalid' });
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked stage artifact', () => {
    const text = '{"proposal":"delta"}';
    const expected = metadata(text);
    const staged = operationalProjectionStagePath(TRANSACTION_ID, 'proposal');
    fs.mkdirSync(operationalProjectionStageDir(TRANSACTION_ID), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(home, 'outside.json'), staged);
    expect(readOperationalProjectionStage(TRANSACTION_ID, 'proposal', expected, validate))
      .toMatchObject({ state: 'degraded' });
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked transaction directory for writes and absence reads', () => {
    const text = '{"proposal":"directory-link"}';
    const expected = metadata(text);
    const directory = operationalProjectionStageDir(TRANSACTION_ID);
    const outside = path.join(home, 'outside-stage');
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, directory);

    expect(writeOperationalProjectionStage(
      TRANSACTION_ID, 'proposal', Buffer.from(text), expected, validate,
    )).toEqual({ ok: false, reason: 'stage-directory-unsafe' });
    expect(readOperationalProjectionStage(
      TRANSACTION_ID, 'projection', { present: false, digest: null, bytes: 0 }, validate,
    )).toEqual({ state: 'degraded', reason: 'stage-directory-unsafe' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
