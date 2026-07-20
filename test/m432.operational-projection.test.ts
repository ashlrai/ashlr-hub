import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import {
  migrateOperationalProposalProjection,
  observeOperationalProjectionArtifacts,
  operationalProposalProjectionDir,
  operationalProposalProjectionPath,
  readOperationalProposals,
} from '../src/core/inbox/operational-projection.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import { inboxDir } from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const NOW_MS = Date.parse('2026-07-16T16:00:00.000Z');

let home: string;
let repo: string;
let heldLock: ProposalStoreMutationLock | null;

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    repo,
    origin: 'agent',
    kind: 'patch',
    title: `Operational ${id}`,
    summary: 'Bound into the sealed operational proposal projection.',
    diff: [
      'diff --git a/m432.txt b/m432.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/m432.txt',
      '@@ -0,0 +1 @@',
      `+${id}`,
      '',
    ].join('\n'),
    status: 'pending',
    createdAt: '2026-07-16T15:00:00.000Z',
    ...overrides,
  };
}

function writeProposal(value: Proposal): string {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const target = path.join(dir, `${value.id}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return target;
}

function acquireLock(): ProposalStoreMutationLock {
  const lock = acquireProposalStoreMutationLock();
  expect(lock).not.toBeNull();
  heldLock = lock;
  return lock!;
}

function migrate(values: Proposal[]) {
  loadOrCreateKey();
  return migrateOperationalProposalProjection({
    proposals: values,
    storeLock: acquireLock(),
    nowMs: NOW_MS,
  });
}

function restoreEnvironment(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  heldLock = null;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m432-projection-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { mode: 0o700 });
  repo = fs.realpathSync(repo);
});

afterEach(() => {
  releaseProposalStoreMutationLock(heldLock);
  heldLock = null;
  fs.rmSync(home, { recursive: true, force: true });
  restoreEnvironment('HOME', originalHome);
  restoreEnvironment('USERPROFILE', originalUserProfile);
});

describe('M432 operational proposal projection', () => {
  it('observes canonical proposal and projection artifacts only while the store lock is held', () => {
    const value = proposal('observe-active');
    writeProposal(value);
    const migrated = migrate([value]);
    expect(migrated.state).toBe('healthy');
    const projectionBytes = fs.readFileSync(operationalProposalProjectionPath());
    const proposalBytes = fs.readFileSync(path.join(inboxDir(), `${value.id}.json`));

    const observed = observeOperationalProjectionArtifacts(value.id, heldLock!);
    expect(observed).toMatchObject({
      state: 'healthy',
      proposal: { digest: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) },
      projection: { digest: migrated.projection?.projectionDigest, bytes: expect.any(Number) },
    });
    if (observed.state !== 'healthy') throw new Error('expected healthy observation');
    expect(observed.proposal.bytes).toBeGreaterThan(0);
    expect(observed.projection.bytes).toBe(projectionBytes.length);
    expect(fs.readFileSync(operationalProposalProjectionPath())).toEqual(projectionBytes);
    expect(fs.readFileSync(path.join(inboxDir(), `${value.id}.json`))).toEqual(proposalBytes);

    releaseProposalStoreMutationLock(heldLock);
    heldLock = null;
    expect(observeOperationalProjectionArtifacts(value.id, null)).toEqual({
      state: 'degraded', reason: 'store-lock-not-owned', proposal: null, projection: null,
    });
  });

  it('reports a truly empty store as a read-only cold start', () => {
    expect(readOperationalProposals()).toEqual({
      state: 'cold-start',
      proposals: [],
      projection: null,
    });
    expect(fs.existsSync(path.join(home, '.ashlr'))).toBe(false);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
  });

  it('reports legacy inbox entries without a projection as degraded', () => {
    writeProposal(proposal('legacy-pending'));
    const inboxBytes = fs.readFileSync(path.join(inboxDir(), 'legacy-pending.json'));

    expect(readOperationalProposals()).toEqual({
      state: 'degraded',
      reason: 'legacy-unmigrated',
      proposals: [],
      projection: null,
    });
    expect(fs.existsSync(operationalProposalProjectionPath())).toBe(false);
    expect(fs.readFileSync(path.join(inboxDir(), 'legacy-pending.json'))).toEqual(inboxBytes);
  });

  it('migrates a complete generation, sorts members, filters reads, and preserves inbox bytes', () => {
    const later = proposal('z-pending', { createdAt: '2026-07-16T15:30:00.000Z' });
    const earlier = proposal('a-approved', { status: 'approved' });
    const laterPath = writeProposal(later);
    const earlierPath = writeProposal(earlier);
    const before = [fs.readFileSync(laterPath), fs.readFileSync(earlierPath)];

    const migrated = migrate([later, earlier]);
    expect(migrated.state).toBe('healthy');
    if (migrated.state !== 'healthy') return;
    expect(migrated.projection.generation).toBe(1);
    expect(migrated.projection.previousProjectionDigest).toBeNull();
    expect(migrated.projection.members.map(({ proposalId }) => proposalId)).toEqual([
      'a-approved',
      'z-pending',
    ]);
    expect(migrated.proposals.map(({ id }) => id)).toEqual(['a-approved', 'z-pending']);
    expect(readOperationalProposals({ status: 'approved' })).toMatchObject({
      state: 'healthy',
      proposals: [{ id: 'a-approved', status: 'approved' }],
    });
    expect(fs.readFileSync(laterPath)).toEqual(before[0]);
    expect(fs.readFileSync(earlierPath)).toEqual(before[1]);
  });

  it('fails closed for seal tampering and members-digest tampering', () => {
    const pending = proposal('tamper-projection');
    writeProposal(pending);
    expect(migrate([pending]).state).toBe('healthy');
    releaseProposalStoreMutationLock(heldLock);
    heldLock = null;

    const target = operationalProposalProjectionPath();
    const sealed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    sealed['projectionDigest'] = '0'.repeat(64);
    fs.writeFileSync(target, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
    expect(readOperationalProposals()).toMatchObject({
      state: 'degraded',
      reason: 'projection-integrity-failed',
      proposals: [],
    });

    sealed['projectionDigest'] = '1'.repeat(64);
    sealed['membersDigest'] = '2'.repeat(64);
    fs.writeFileSync(target, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
    expect(readOperationalProposals()).toMatchObject({
      state: 'degraded',
      reason: 'projection-integrity-failed',
      proposals: [],
    });
  });

  it('fails closed when current proposal bytes do not match their sealed member', () => {
    const pending = proposal('tamper-member');
    const target = writeProposal(pending);
    expect(migrate([pending]).state).toBe('healthy');
    releaseProposalStoreMutationLock(heldLock);
    heldLock = null;

    writeProposal({ ...pending, title: 'Changed after projection' });
    expect(fs.existsSync(target)).toBe(true);
    expect(readOperationalProposals()).toMatchObject({
      state: 'degraded',
      reason: 'proposal-member-mismatch',
      proposals: [],
    });
  });

  it('does not bind or later consult excluded terminal archive entries', () => {
    const pending = proposal('still-operational');
    const terminal = proposal('already-terminal', { status: 'failed' });
    writeProposal(pending);
    const terminalPath = writeProposal(terminal);
    const migrated = migrate([terminal, pending]);
    expect(migrated.state).toBe('healthy');
    if (migrated.state !== 'healthy') return;
    expect(migrated.projection.members.map(({ proposalId }) => proposalId)).toEqual(['still-operational']);
    releaseProposalStoreMutationLock(heldLock);
    heldLock = null;

    const archive = path.join(home, '.ashlr', 'proposal-archive');
    fs.mkdirSync(archive, { mode: 0o700 });
    fs.renameSync(terminalPath, path.join(archive, path.basename(terminalPath)));
    expect(readOperationalProposals()).toMatchObject({
      state: 'healthy',
      proposals: [{ id: 'still-operational' }],
    });
  });

  it.runIf(process.platform !== 'win32')('writes exact private directories and manifest', () => {
    const pending = proposal('private-projection');
    writeProposal(pending);
    expect(migrate([pending]).state).toBe('healthy');

    expect(fs.statSync(path.join(home, '.ashlr')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(operationalProposalProjectionDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(operationalProposalProjectionPath()).mode & 0o777).toBe(0o600);
  });

  it('supports complete projections with more than 200 members within bounded totals', () => {
    const proposals = Array.from({ length: 225 }, (_, index) =>
      proposal(`bulk-${String(index).padStart(3, '0')}`));
    for (const value of proposals) writeProposal(value);

    const migrated = migrate([...proposals].reverse());
    expect(migrated.state).toBe('healthy');
    if (migrated.state !== 'healthy') return;
    expect(migrated.projection.members).toHaveLength(225);
    expect(migrated.proposals).toHaveLength(225);
    expect(migrated.projection.members[0]?.proposalId).toBe('bulk-000');
    expect(migrated.projection.members.at(-1)?.proposalId).toBe('bulk-224');
  });

  it('filters 4,097 terminal records without tripping the operational member cap', () => {
    const terminal = Array.from({ length: 4_097 }, (_, index) => proposal(
      `terminal-${String(index).padStart(4, '0')}`,
      { status: 'failed' },
    ));
    for (const value of terminal) writeProposal(value);

    const migrated = migrate(terminal);
    expect(migrated.state).toBe('healthy');
    if (migrated.state !== 'healthy') return;
    expect(migrated.projection.members).toEqual([]);
    expect(migrated.proposals).toEqual([]);
  });

  it('refuses an omitted namespace member without installing a projection', () => {
    const included = proposal('included');
    const omitted = proposal('omitted');
    writeProposal(included);
    writeProposal(omitted);

    expect(migrate([included])).toMatchObject({
      state: 'degraded', reason: 'migration-input-invalid',
    });
    expect(fs.existsSync(operationalProposalProjectionPath())).toBe(false);
  });

  it('refuses more than 4,096 active members before installing a projection', () => {
    const active = Array.from({ length: 4_097 }, (_, index) => proposal(
      `active-${String(index).padStart(4, '0')}`,
    ));

    expect(migrate(active)).toMatchObject({
      state: 'degraded', reason: 'migration-input-invalid',
    });
    expect(fs.existsSync(operationalProposalProjectionPath())).toBe(false);
  });
});
