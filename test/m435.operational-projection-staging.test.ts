import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { operationalProposalProjectionDir } from '../src/core/inbox/operational-projection.js';
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
});
