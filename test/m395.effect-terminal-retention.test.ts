import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commitToolEffect,
  compactEffectJournal,
  effectJournalCompactionSupported,
  effectJournalDirectory,
  hasUnresolvedToolEffects,
  prepareToolEffect,
  readEffectJournal,
  readEffectRecord,
  releasePreparedToolEffect,
  resolvePreparedEffect,
  type PreparedToolEffect,
  type ToolEffectInput,
} from '../src/core/util/effect-journal.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';

const GENERATION = '123e4567-e89b-12d3-a456-426614174000';
const NEXT_GENERATION = '223e4567-e89b-12d3-a456-426614174000';

interface PackedPair {
  prepared: Record<string, unknown>;
  terminal: Record<string, unknown>;
}

interface PackArtifact {
  packId: string;
  entries: PackedPair[];
}

interface MarkerArtifact {
  sequence: number;
  packId: string;
  previousCommitAttestation: string;
  attestation: string;
}

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

function effectInput(
  label: string,
  argumentsValue: unknown = { operation: label },
): ToolEffectInput {
  return {
    scopeId: `retention-${label}`,
    generation: GENERATION,
    taskId: `task-${label}`,
    ordinal: 1,
    toolName: 'proposal_tool',
    toolCallId: `call-${label}`,
    arguments: argumentsValue,
    safety: 'proposal',
  };
}

function prepare(input: ToolEffectInput): PreparedToolEffect {
  const result = prepareToolEffect(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`prepare failed: ${result.reason}`);
  return result.effect;
}

function commit(input: ToolEffectInput, outcome: unknown = 'done'): PreparedToolEffect {
  const effect = prepare(input);
  expect(commitToolEffect(effect, outcome)).toBe(true);
  return effect;
}

function terminalPath(effect: PreparedToolEffect): string {
  return path.join(
    path.dirname(effect.recordPath),
    path.basename(effect.recordPath).replace('.effect-v1-', '.terminal-v1-'),
  );
}

function artifacts(prefix: string): string[] {
  return fs.readdirSync(effectJournalDirectory())
    .filter((name) => name.startsWith(prefix))
    .sort();
}

function artifactPath(name: string): string {
  return path.join(effectJournalDirectory(), name);
}

function frozenLegacyExactPhase(effectId: string): string | 'absent' | 'degraded' {
  const matches = fs.readdirSync(effectJournalDirectory())
    .filter((name) => new RegExp(`^\\.effect-v1-[a-f0-9]{64}-${effectId}\\.json$`).test(name));
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) return 'degraded';
  try {
    const prepared = JSON.parse(fs.readFileSync(artifactPath(matches[0]!), 'utf8')) as { phase?: unknown };
    const terminalName = matches[0]!.replace('.effect-v1-', '.terminal-v1-');
    if (!fs.existsSync(artifactPath(terminalName))) return String(prepared.phase);
    const terminal = JSON.parse(fs.readFileSync(artifactPath(terminalName), 'utf8')) as { phase?: unknown };
    return String(terminal.phase);
  } catch { return 'degraded'; }
}

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(artifactPath(name), 'utf8')) as T;
}

function fixtureHash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function fixtureHmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value])).digest('hex');
}

function fixtureBloom(values: string[]): string {
  const bloom = Buffer.alloc(256);
  for (const value of values) {
    const digest = createHash('sha256')
      .update(JSON.stringify(['ashlr:tool-effect-terminal-pack-bloom:v1', value]))
      .digest();
    for (let index = 0; index < 4; index += 1) {
      const bit = digest.readUInt32BE(index * 4) % 2048;
      bloom[Math.floor(bit / 8)]! |= 1 << (bit % 8);
    }
  }
  return bloom.toString('base64');
}

function writeSignedPackFixture(label: string): { effectId: string; names: string[] } {
  const key = loadOrCreateKey();
  const scopeHash = fixtureHash(['ashlr:tool-effect:v1', 'scope', `retention-${label}`]);
  const generationHash = fixtureHash(['ashlr:tool-effect:v1', 'generation', GENERATION]);
  const taskHash = fixtureHash(['ashlr:tool-effect:v1', 'task', `task-${label}`]);
  const toolCallHash = fixtureHash(['ashlr:tool-effect:v1', 'tool-call', `call-${label}`]);
  const argumentDigest = createHash('sha256')
    .update(JSON.stringify({ operation: label }))
    .digest('hex');
  const effectId = fixtureHash([
    'ashlr:tool-effect:v1', scopeHash, 'proposal_tool', argumentDigest,
  ]);
  const preparedAt = '2026-07-13T05:00:00.000Z';
  const preparedUnsigned = {
    schemaVersion: 1,
    effectId,
    scopeHash,
    generationHash,
    taskHash,
    ordinal: 1,
    toolName: 'proposal_tool',
    toolCallHash,
    argumentDigest,
    safety: 'proposal',
    identityPolicy: 'scope-bound',
    phase: 'prepared',
    ownerHash: fixtureHash(['ashlr:tool-effect:v1', 'owner', 'signed-fixture-owner']),
    revision: 1,
    preparedAt,
  };
  const prepared = {
    ...preparedUnsigned,
    attestation: fixtureHmac(key, 'ashlr:tool-effect-attestation:v1', preparedUnsigned),
  };
  const { phase: _phase, revision: _revision, ...preparedBase } = preparedUnsigned;
  const terminalUnsigned = {
    ...preparedBase,
    phase: 'committed',
    revision: 2,
    committedAt: '2026-07-13T05:00:01.000Z',
    outcomeDigest: createHash('sha256').update('done').digest('hex'),
    preparedAttestation: prepared.attestation,
  };
  const terminal = {
    ...terminalUnsigned,
    attestation: fixtureHmac(key, 'ashlr:tool-effect-attestation:v1', terminalUnsigned),
  };
  const createdAt = '2026-07-13T05:00:02.000Z';
  const packId = fixtureHash([
    'ashlr:tool-effect-terminal-pack-id:v1',
    createdAt,
    [[scopeHash, effectId, prepared.attestation, terminal.attestation]],
  ]);
  const pack = {
    schemaVersion: 1,
    recordType: 'terminal-pack',
    packId,
    createdAt,
    entries: [{ prepared, terminal }],
  };
  const packBytes = Buffer.from(`${JSON.stringify(pack)}\n`);
  const floorUnsigned = {
    schemaVersion: 2,
    recordType: 'effect-terminal-pack-format',
    createdAt: '2026-07-13T05:00:03.000Z',
  };
  const floor = {
    ...floorUnsigned,
    attestation: fixtureHmac(key, 'ashlr:tool-effect-terminal-pack-format:v2', floorUnsigned),
  };
  const markerUnsigned = {
    schemaVersion: 1,
    recordType: 'terminal-pack-commit',
    sequence: 1,
    packId,
    packDigest: createHash('sha256').update(packBytes).digest('hex'),
    packBytes: packBytes.length,
    entryCount: 1,
    scopeBloom: fixtureBloom([scopeHash]),
    effectBloom: fixtureBloom([effectId]),
    previousCommitAttestation: '0'.repeat(64),
    committedAt: '2026-07-13T05:00:04.000Z',
  };
  const marker = {
    ...markerUnsigned,
    attestation: fixtureHmac(key, 'ashlr:tool-effect-terminal-pack-commit:v1', markerUnsigned),
  };
  fs.mkdirSync(effectJournalDirectory(), { recursive: true, mode: 0o700 });
  const names = [
    `.effect-v1-${scopeHash}-${effectId}.json`,
    '.format-v2-effect-terminal-packs.json',
    `.terminal-pack-v1-${packId}.json`,
    `.terminal-pack-commit-v1-${String(1).padStart(12, '0')}-${packId}.json`,
  ];
  for (const [name, value] of [
    [names[0]!, prepared],
    [names[1]!, floor],
    [names[2]!, pack],
    [names[3]!, marker],
  ] as const) {
    fs.writeFileSync(artifactPath(name), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  }
  return { effectId, names };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m395-retention-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
});

describe('effect terminal retention platform support', () => {
  it('reports compaction support only on POSIX', () => {
    expect(effectJournalCompactionSupported()).toBe(process.platform !== 'win32');
    if (process.platform === 'win32') {
      expect(compactEffectJournal()).toEqual({
        ok: false,
        reason: 'unsupported',
        packedRecords: 0,
        looseRecordsRemoved: 0,
      });
    }
  });

  it.skipIf(process.platform !== 'win32')('never trusts or mutates packed authority on Windows', () => {
    const fixture = writeSignedPackFixture('windows-packed');
    const before = fs.readdirSync(effectJournalDirectory()).sort();

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded', records: [] });
    expect(readEffectRecord(fixture.effectId)).toMatchObject({ sourceState: 'degraded', records: [] });
    expect(hasUnresolvedToolEffects('windows-packed', GENERATION)).toBe(true);
    expect(prepareToolEffect(effectInput('windows-packed'))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(fs.readdirSync(effectJournalDirectory()).sort()).toEqual(before);
    expect(before).toEqual([...fixture.names].sort());
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('effect terminal retention on POSIX', () => {
  it('accepts the same fully signed fixture that native Windows must reject', () => {
    const fixture = writeSignedPackFixture('posix-signed-fixture');

    expect(readEffectJournal()).toMatchObject({
      sourceState: 'healthy',
      records: [{ effectId: fixture.effectId, phase: 'committed' }],
    });
  });

  it('packs committed authority while retaining its prepared rollback tombstone', () => {
    const effect = commit(effectInput('committed-cleanup'));
    const looseTerminal = terminalPath(effect);
    expect(fs.existsSync(effect.recordPath)).toBe(true);
    expect(fs.existsSync(looseTerminal)).toBe(true);

    expect(compactEffectJournal()).toMatchObject({
      ok: true,
      reason: 'compacted',
      packedRecords: 1,
      looseRecordsRemoved: 1,
    });
    expect(fs.existsSync(effect.recordPath)).toBe(true);
    expect(fs.existsSync(looseTerminal)).toBe(false);
    expect(artifacts('.terminal-pack-v1-')).toHaveLength(1);
    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(1);
    expect(readEffectJournal()).toMatchObject({
      sourceState: 'healthy',
      records: [{ effectId: effect.effectId, phase: 'committed' }],
    });
  });

  it('keeps a packed resolution unresolved and refuses its replay', () => {
    const input = effectInput('resolved');
    const effect = prepare(input);
    const prepared = readEffectRecord(effect.effectId).records[0]!;
    releasePreparedToolEffect(effect);
    expect(resolvePreparedEffect({
      effectId: effect.effectId,
      expectedAttestation: prepared.attestation,
      resolution: 'attested-no-effect',
      evidenceDigest: 'a'.repeat(64),
    })).toBe(true);

    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    expect(readEffectRecord(effect.effectId)).toMatchObject({
      sourceState: 'healthy',
      records: [{ phase: 'resolved', resolution: 'attested-no-effect' }],
    });
    expect(hasUnresolvedToolEffects(input.scopeId, input.generation)).toBe(true);
    expect(prepareToolEffect({
      ...input,
      generation: NEXT_GENERATION,
      toolCallId: 'provider-retry-resolved',
    })).toMatchObject({ ok: false, reason: 'duplicate', phase: 'resolved' });
  });

  it('refuses a duplicate whose only authority is packed', () => {
    const input = effectInput('packed-duplicate');
    commit(input);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });

    expect(prepareToolEffect({ ...input, toolCallId: 'provider-retry-committed' }))
      .toMatchObject({ ok: false, reason: 'duplicate', phase: 'committed' });
  });

  it('reads one exact packed record without returning its pack neighbor', () => {
    const first = commit(effectInput('exact-first'));
    const second = commit(effectInput('exact-second'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 2 });

    const exact = readEffectRecord(second.effectId);
    expect(exact).toMatchObject({ sourceState: 'healthy', invalidRecords: 0, limitExceeded: false });
    expect(exact.records).toHaveLength(1);
    expect(exact.records[0]).toMatchObject({ effectId: second.effectId, phase: 'committed' });
    expect(exact.records[0]?.effectId).not.toBe(first.effectId);
  });

  it('reads multiple packs chained by sequence and prior attestation', () => {
    const first = commit(effectInput('chain-first'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const firstMarkerName = artifacts('.terminal-pack-commit-v1-')[0]!;
    const firstMarker = readJson<MarkerArtifact>(firstMarkerName);

    const second = commit(effectInput('chain-second'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const markerNames = artifacts('.terminal-pack-commit-v1-');
    const markers = markerNames.map((name) => readJson<MarkerArtifact>(name));

    expect(markers.map((marker) => marker.sequence)).toEqual([1, 2]);
    expect(markers[1]?.previousCommitAttestation).toBe(firstMarker.attestation);
    expect(markers[1]?.packId).not.toBe(firstMarker.packId);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'healthy', invalidRecords: 0 });
    expect(readEffectJournal().records.map((record) => record.effectId).sort())
      .toEqual([first.effectId, second.effectId].sort());
  });

  it('isolates an exact read from an unrelated damaged pack via signed membership summaries', () => {
    commit(effectInput('isolated-damaged-pack'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const firstMarker = readJson<MarkerArtifact>(artifacts('.terminal-pack-commit-v1-')[0]!);
    const targetInput = effectInput('isolated-target-pack');
    const target = commit(targetInput);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    fs.writeFileSync(
      artifactPath(`.terminal-pack-v1-${firstMarker.packId}.json`),
      '{"tampered":true}\n',
    );

    expect(readEffectRecord(target.effectId)).toMatchObject({
      sourceState: 'healthy',
      records: [{ effectId: target.effectId, phase: 'committed' }],
    });
    const next = prepareToolEffect({
      ...targetInput,
      taskId: 'isolated-target-next-task',
      toolCallId: 'isolated-target-next-call',
      arguments: { operation: 'isolated-target-next' },
    });
    expect(next).toMatchObject({ ok: true });
    if (next.ok) releasePreparedToolEffect(next.effect);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
  });

  it('degrades filtered reads when a signed membership summary is mutated', () => {
    const effect = commit(effectInput('tampered-membership-summary'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const markerName = artifacts('.terminal-pack-commit-v1-')[0]!;
    const marker = readJson<Record<string, unknown>>(markerName);
    const bloom = String(marker['effectBloom']);
    marker['effectBloom'] = `${bloom[0] === 'A' ? 'B' : 'A'}${bloom.slice(1)}`;
    fs.writeFileSync(artifactPath(markerName), `${JSON.stringify(marker)}\n`);

    expect(readEffectRecord(effect.effectId)).toMatchObject({ sourceState: 'degraded' });
  });

  it('degrades a marker-chain gap when sequence one is missing', () => {
    commit(effectInput('chain-gap-first'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    commit(effectInput('chain-gap-second'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const markerNames = artifacts('.terminal-pack-commit-v1-');
    expect(markerNames).toHaveLength(2);
    expect(readJson<MarkerArtifact>(markerNames[0]!).sequence).toBe(1);
    expect(readJson<MarkerArtifact>(markerNames[1]!).sequence).toBe(2);
    fs.unlinkSync(artifactPath(markerNames[0]!));

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(readEffectJournal().invalidRecords).toBeGreaterThan(0);
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });
  });

  it('degrades on marker deletion while the prepared tombstone still refuses replay', () => {
    const input = effectInput('marker-tail-deleted');
    const effect = commit(input);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-commit-v1-')[0]!));

    expect(readEffectRecord(effect.effectId)).toMatchObject({
      sourceState: 'degraded',
      records: [{ effectId: effect.effectId, phase: 'prepared' }],
    });
    expect(hasUnresolvedToolEffects(input.scopeId, input.generation)).toBe(true);
    expect(prepareToolEffect({ ...input, toolCallId: 'replayed-after-marker-delete' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('falls back to the prepared tombstone when the newest pack tail disappears', () => {
    const first = commit(effectInput('tail-first'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const secondInput = effectInput('tail-second');
    const second = commit(secondInput);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const markerName = artifacts('.terminal-pack-commit-v1-')[1]!;
    const marker = readJson<MarkerArtifact>(markerName);
    fs.unlinkSync(artifactPath(markerName));
    fs.unlinkSync(artifactPath(`.terminal-pack-v1-${marker.packId}.json`));

    expect(readEffectRecord(first.effectId).records[0]?.phase).toBe('committed');
    expect(readEffectRecord(second.effectId).records[0]?.phase).toBe('prepared');
    expect(prepareToolEffect({ ...secondInput, toolCallId: 'replayed-after-tail-delete' }))
      .toMatchObject({ ok: false, reason: 'duplicate', phase: 'prepared' });
  });

  it('degrades instead of replaying when a tombstone and its marker are both deleted', () => {
    const input = effectInput('tombstone-and-marker-deleted');
    const effect = commit(input);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    fs.unlinkSync(effect.recordPath);

    expect(readEffectRecord(effect.effectId)).toMatchObject({ sourceState: 'degraded' });
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-commit-v1-')[0]!));
    expect(readEffectRecord(effect.effectId)).toMatchObject({ sourceState: 'degraded' });
    expect(prepareToolEffect({ ...input, toolCallId: 'replayed-after-double-delete' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('accepts exact loose and packed overlap, then removes only the terminal copy', () => {
    const effect = commit(effectInput('exact-overlap'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const pack = readJson<PackArtifact>(artifacts('.terminal-pack-v1-')[0]!);
    const pair = pack.entries[0]!;
    const scopeHash = String(pair.prepared['scopeHash']);
    const effectId = String(pair.prepared['effectId']);
    const loosePrepared = artifactPath(`.effect-v1-${scopeHash}-${effectId}.json`);
    const looseTerminal = artifactPath(`.terminal-v1-${scopeHash}-${effectId}.json`);
    fs.writeFileSync(looseTerminal, `${JSON.stringify(pair.terminal)}\n`, { mode: 0o600, flag: 'wx' });

    expect(readEffectJournal()).toMatchObject({ sourceState: 'healthy', invalidRecords: 0 });
    expect(compactEffectJournal()).toEqual({
      ok: true,
      reason: 'compacted',
      packedRecords: 0,
      looseRecordsRemoved: 1,
    });
    expect(fs.existsSync(loosePrepared)).toBe(true);
    expect(fs.existsSync(looseTerminal)).toBe(false);
    expect(readEffectRecord(effect.effectId).records).toHaveLength(1);
  });

  it('recovers partial cleanup by removing an exact loose terminal copy', () => {
    const effect = commit(effectInput('partial-cleanup'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const pack = readJson<PackArtifact>(artifacts('.terminal-pack-v1-')[0]!);
    const terminal = pack.entries[0]!.terminal;
    fs.writeFileSync(terminalPath(effect), `${JSON.stringify(terminal)}\n`, { mode: 0o600, flag: 'wx' });

    expect(fs.existsSync(effect.recordPath)).toBe(true);
    expect(readEffectRecord(effect.effectId)).toMatchObject({
      sourceState: 'healthy',
      records: [{ effectId: effect.effectId, phase: 'committed' }],
    });
    expect(compactEffectJournal()).toEqual({
      ok: true,
      reason: 'compacted',
      packedRecords: 0,
      looseRecordsRemoved: 1,
    });
    expect(fs.existsSync(effect.recordPath)).toBe(true);
    expect(fs.existsSync(terminalPath(effect))).toBe(false);
    expect(readEffectRecord(effect.effectId).records).toHaveLength(1);
  });

  it.each([
    ['pack', '.terminal-pack-v1-'],
    ['commit marker', '.terminal-pack-commit-v1-'],
  ])('degrades when a packed %s is tampered', (_kind, prefix) => {
    commit(effectInput(`tampered-${prefix.length}`));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    fs.writeFileSync(artifactPath(artifacts(prefix)[0]!), '{"tampered":true}\n');

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(readEffectJournal().invalidRecords).toBeGreaterThan(0);
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });
  });

  it('degrades when the packed format floor is deleted or tampered', () => {
    commit(effectInput('format-floor-damage'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const floor = artifactPath('.format-v2-effect-terminal-packs.json');
    const validFloor = fs.readFileSync(floor);

    fs.unlinkSync(floor);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });

    fs.writeFileSync(floor, validFloor, { mode: 0o600, flag: 'wx' });
    expect(readEffectJournal()).toMatchObject({ sourceState: 'healthy', invalidRecords: 0 });
    fs.writeFileSync(floor, '{"tampered":true}\n');
    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });
  });

  it('degrades an orphan commit marker whose pack is absent', () => {
    commit(effectInput('orphan-marker'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-v1-')[0]!));

    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(1);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(readEffectJournal().invalidRecords).toBeGreaterThan(0);
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });
  });

  it('keeps a valid orphan pack non-authoritative while loose records remain authoritative', () => {
    const effect = commit(effectInput('orphan-pack'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const packName = artifacts('.terminal-pack-v1-')[0]!;
    const pack = readJson<PackArtifact>(packName);
    const pair = pack.entries[0]!;
    fs.writeFileSync(terminalPath(effect), `${JSON.stringify(pair.terminal)}\n`, { mode: 0o600, flag: 'wx' });
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-commit-v1-')[0]!));

    expect(artifacts('.terminal-pack-v1-')).toEqual([packName]);
    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(0);
    expect(readEffectJournal()).toMatchObject({
      sourceState: 'healthy',
      invalidRecords: 0,
      records: [{ effectId: effect.effectId, phase: 'committed' }],
    });
    expect(fs.existsSync(effect.recordPath)).toBe(true);
    expect(fs.existsSync(terminalPath(effect))).toBe(true);
  });

  it('reclaims a valid pre-marker orphan before retrying compaction', () => {
    const effect = commit(effectInput('recover-orphan-pack'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const oldPackName = artifacts('.terminal-pack-v1-')[0]!;
    const oldPack = readJson<PackArtifact>(oldPackName);
    fs.writeFileSync(
      terminalPath(effect),
      `${JSON.stringify(oldPack.entries[0]!.terminal)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-commit-v1-')[0]!));

    expect(readEffectJournal()).toMatchObject({ sourceState: 'healthy' });
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    expect(fs.existsSync(artifactPath(oldPackName))).toBe(false);
    expect(artifacts('.terminal-pack-v1-')).toHaveLength(1);
    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(1);
    expect(readEffectRecord(effect.effectId).records[0]?.phase).toBe('committed');
  });

  it('recovers a linked publication candidate before compacting again', () => {
    const effect = commit(effectInput('linked-candidate'));
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    const packName = artifacts('.terminal-pack-v1-')[0]!;
    const candidateName = `.terminal-stage-v1-${'c'.repeat(64)}-recovery.candidate`;
    fs.linkSync(artifactPath(packName), artifactPath(candidateName));

    expect(fs.lstatSync(artifactPath(packName)).nlink).toBe(2);
    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded' });
    expect(compactEffectJournal()).toEqual({
      ok: true,
      reason: 'nothing-to-compact',
      packedRecords: 0,
      looseRecordsRemoved: 0,
    });
    expect(fs.existsSync(artifactPath(candidateName))).toBe(false);
    expect(fs.lstatSync(artifactPath(packName)).nlink).toBe(1);
    expect(readEffectRecord(effect.effectId)).toMatchObject({
      sourceState: 'healthy',
      records: [{ effectId: effect.effectId, phase: 'committed' }],
    });
  });

  it('keeps every packed artifact visible to legacy reserved-prefix fail-closed logic', () => {
    const input = effectInput('legacy-downgrade');
    const effect = commit(input);
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });

    const names = fs.readdirSync(effectJournalDirectory());
    expect(names).toHaveLength(4);
    expect(names.filter((name) => name.startsWith('.effect-v1-'))).toHaveLength(1);
    expect(names.some((name) => /^\.terminal-v1-/.test(name))).toBe(false);
    expect(names.some((name) => /^\.terminal-(?!v1-)/.test(name))).toBe(true);
    expect(names).toContain('.format-v2-effect-terminal-packs.json');
    expect(frozenLegacyExactPhase(effect.effectId)).toBe('prepared');

    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-commit-v1-')[0]!));
    fs.unlinkSync(artifactPath(artifacts('.terminal-pack-v1-')[0]!));
    expect(frozenLegacyExactPhase(effect.effectId)).toBe('prepared');
    expect(prepareToolEffect({ ...input, toolCallId: 'legacy-tail-retry' }))
      .toMatchObject({ ok: false, reason: 'duplicate', phase: 'prepared' });
  });

  it('fails closed on unknown future reserved artifacts', () => {
    const effect = prepare(effectInput('future-artifact'));
    releasePreparedToolEffect(effect);
    fs.writeFileSync(
      artifactPath('.terminal-pack-v2-future-authority.json'),
      '{}\n',
      { mode: 0o600, flag: 'wx' },
    );

    expect(readEffectJournal()).toMatchObject({ sourceState: 'degraded', invalidRecords: 1 });
    expect(compactEffectJournal()).toMatchObject({ ok: false, reason: 'degraded' });
  });

  it('does not compact prepared-only authority', () => {
    const effect = prepare(effectInput('prepared-only'));
    const preparedBytes = fs.readFileSync(effect.recordPath);

    expect(compactEffectJournal()).toEqual({
      ok: true,
      reason: 'nothing-to-compact',
      packedRecords: 0,
      looseRecordsRemoved: 0,
    });
    expect(fs.readFileSync(effect.recordPath)).toEqual(preparedBytes);
    expect(artifacts('.terminal-pack-v1-')).toHaveLength(0);
    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(0);
    expect(readEffectRecord(effect.effectId).records[0]?.phase).toBe('prepared');
    releasePreparedToolEffect(effect);
  });

  it('bounds underfilled manual packs before they can exhaust the chain', () => {
    for (let index = 0; index < 8; index += 1) {
      commit(effectInput(`underfilled-${index}`));
      expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });
    }
    commit(effectInput('underfilled-refused'));

    expect(compactEffectJournal()).toEqual({
      ok: false,
      reason: 'capacity',
      packedRecords: 0,
      looseRecordsRemoved: 0,
    });
    expect(artifacts('.terminal-pack-v1-')).toHaveLength(8);
    expect(artifacts('.terminal-v1-')).toHaveLength(1);
  });

  it('automatically compacts the bounded terminal batch at the real threshold', () => {
    for (let index = 0; index < 200; index += 1) {
      commit(effectInput(`automatic-${index}`, { index }));
    }

    expect(artifacts('.effect-v1-')).toHaveLength(200);
    expect(artifacts('.terminal-v1-')).toHaveLength(0);
    expect(artifacts('.terminal-pack-v1-')).toHaveLength(1);
    expect(artifacts('.terminal-pack-commit-v1-')).toHaveLength(1);
    expect(readEffectJournal(1_000)).toMatchObject({
      sourceState: 'healthy',
      invalidRecords: 0,
      limitExceeded: false,
    });
    expect(readEffectJournal(1_000).records).toHaveLength(200);
  }, 60_000);

  it('stores no raw argument or outcome secrets in pack bytes', () => {
    const argumentSecret = 'm395-argument-secret-7fef7f';
    const outcomeSecret = 'm395-outcome-secret-9a9a9a';
    commit(
      effectInput('secret-bytes', { command: `deploy --token ${argumentSecret}` }),
      { stdout: `completed with ${outcomeSecret}` },
    );
    expect(compactEffectJournal()).toMatchObject({ ok: true, packedRecords: 1 });

    const packBytes = fs.readFileSync(artifactPath(artifacts('.terminal-pack-v1-')[0]!), 'utf8');
    expect(packBytes).not.toContain(argumentSecret);
    expect(packBytes).not.toContain(outcomeSecret);
    expect(packBytes).not.toContain('deploy --token');
  });
});
