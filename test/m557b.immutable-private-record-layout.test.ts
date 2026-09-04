import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  initializeImmutablePrivateRecordStoreLayout,
  readImmutablePrivateRecords,
  readImmutablePrivateRecordsForRecoveryAdmission,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../src/core/util/immutable-private-record-store.js';

interface RecordFixture { id: string }

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): {
  root: string;
  store: string;
  codec: ImmutablePrivateRecordCodec<RecordFixture>;
  config: ImmutablePrivateRecordStoreConfig<RecordFixture>;
} {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m557b-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const store = join(root, 'attempts');
  mkdirSync(store, { mode: 0o700 });
  const codec: ImmutablePrivateRecordCodec<RecordFixture> = {
    parse: (value: unknown): RecordFixture | null => value !== null && typeof value === 'object' &&
      !Array.isArray(value) && Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)['id'] === 'string'
      ? { id: (value as Record<string, string>)['id']! }
      : null,
    serialize: (value: RecordFixture) => `${JSON.stringify(value)}\n`,
    recordId: (value: RecordFixture) => value.id,
    recordFileName: (value: RecordFixture) => `${value.id}.json`,
    isRecordFileName: (value: string) => /^[a-z]+\.json$/u.test(value),
    stageToken: (value: RecordFixture) => value.id,
    equivalent: (left: RecordFixture, right: RecordFixture) => left.id === right.id,
  };
  return {
    root,
    store,
    codec,
    config: {
      label: 'M557b fixture',
      anchorPath: root,
      rootPath: store,
      lockFileName: '.fixture.lock',
      maxRecordBytes: 1024,
      defaultMaxFiles: 8,
      hardMaxFiles: 8,
      defaultMaxBytes: 8192,
      hardMaxBytes: 8192,
      codecForWrite: () => codec,
      codecForRead: () => codec,
    },
  };
}

function initialize(value: ReturnType<typeof setup>): void {
  expect(initializeImmutablePrivateRecordStoreLayout(value.config, { guard: () => true }))
    .toBe('initialized');
}

function recordBytes(id: string): string {
  return `${JSON.stringify({ id })}\n`;
}

function installLinkedCrash(
  value: ReturnType<typeof setup>,
  id = 'alpha',
  stageName = `.${id}.${id}.stage`,
): { target: string; stage: string } {
  initialize(value);
  const target = join(value.store, 'records', `${id}.json`);
  const stage = join(value.store, 'staging', stageName);
  writeFileSync(target, recordBytes(id), { mode: 0o600 });
  linkSync(target, stage);
  return { target, stage };
}

describe('guarded immutable private record layout initialization', () => {
  it.each(['records', 'staging'] as const)('repairs a root missing %s under a rechecked guard', (present) => {
    const value = setup();
    mkdirSync(join(value.store, present), { mode: 0o700 });
    let checks = 0;
    expect(initializeImmutablePrivateRecordStoreLayout(value.config, {
      guard: () => { checks += 1; return true; },
    })).toBe('initialized');
    expect(checks).toBe(2);
    expect(existsSync(join(value.store, 'records'))).toBe(true);
    expect(existsSync(join(value.store, 'staging'))).toBe(true);
  });

  it('does not create a missing store root or initialize after guard refusal', () => {
    const missing = setup();
    rmSync(missing.store, { recursive: true, force: true });
    expect(initializeImmutablePrivateRecordStoreLayout(missing.config, { guard: () => true }))
      .toBe('missing');
    expect(existsSync(missing.store)).toBe(false);

    const withheld = setup();
    expect(initializeImmutablePrivateRecordStoreLayout(withheld.config, { guard: () => false }))
      .toBe('withheld');
    expect(existsSync(join(withheld.store, 'records'))).toBe(false);
    expect(existsSync(join(withheld.store, 'staging'))).toBe(false);
  });

  it('rechecks the outer guard after durable layout creation', () => {
    const value = setup();
    let checks = 0;
    expect(initializeImmutablePrivateRecordStoreLayout(value.config, {
      guard: () => { checks += 1; return checks === 1; },
    })).toBe('withheld');
    expect(checks).toBe(2);
    expect(existsSync(join(value.store, 'records'))).toBe(true);
    expect(existsSync(join(value.store, 'staging'))).toBe(true);
  });
});

describe('read-only conservative linked-recovery admission', () => {
  it('admits only the exact linked crash while the ordinary read remains strict', () => {
    const value = setup();
    installLinkedCrash(value);

    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({
        records: [{ id: 'alpha' }],
        sourceState: 'healthy',
        complete: true,
        invalidFiles: 0,
      });
    expect(readImmutablePrivateRecords(value.config, { requireComplete: true })).toMatchObject({
      records: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: expect.arrayContaining(['source-mutated', 'invalid-file']),
    });
  });

  it.each([
    ['malformed stage name', '.wrong.stage'],
    ['temporary stage', '.alpha.alpha.stage.tmp'],
  ])('rejects a linked %s', (_label, stageName) => {
    const value = setup();
    installLinkedCrash(value, 'alpha', stageName);
    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({
        records: [],
        sourceState: 'degraded',
        complete: false,
        stopReasons: expect.arrayContaining(['source-mutated', 'invalid-file']),
      });
  });

  it('rejects a one-link stage', () => {
    const value = setup();
    initialize(value);
    writeFileSync(
      join(value.store, 'staging', '.alpha.alpha.stage'),
      recordBytes('alpha'),
      { mode: 0o600 },
    );
    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({ records: [], sourceState: 'degraded', complete: false });
  });

  it('rejects a canonical stage and target backed by different inodes and content', () => {
    const value = setup();
    initialize(value);
    const target = join(value.store, 'records', 'alpha.json');
    const stage = join(value.store, 'staging', '.alpha.alpha.stage');
    writeFileSync(target, recordBytes('beta'), { mode: 0o600 });
    linkSync(target, join(value.root, 'target-witness'));
    writeFileSync(stage, recordBytes('alpha'), { mode: 0o600 });
    linkSync(stage, join(value.root, 'stage-witness'));

    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({ records: [], sourceState: 'degraded', complete: false });
  });

  it.each(['symlink', 'directory'] as const)('rejects a %s at the canonical stage path', (kind) => {
    const value = setup();
    initialize(value);
    const target = join(value.store, 'records', 'alpha.json');
    const stage = join(value.store, 'staging', '.alpha.alpha.stage');
    writeFileSync(target, recordBytes('alpha'), { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(target, stage);
    else mkdirSync(stage, { mode: 0o700 });

    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({ records: [], sourceState: 'degraded', complete: false });
  });

  it('rejects a staging namespace beyond its read bound', () => {
    const value = setup();
    initialize(value);
    for (const id of ['alpha', 'bravo', 'charlie', 'delta']) {
      writeFileSync(join(value.store, 'staging', `.${id}.${id}.stage`), recordBytes(id), {
        mode: 0o600,
      });
    }
    expect(readImmutablePrivateRecordsForRecoveryAdmission(value.config, { requireComplete: true }))
      .toMatchObject({
        records: [],
        sourceState: 'degraded',
        complete: false,
        limitExceeded: false,
        stopReasons: expect.arrayContaining(['source-mutated', 'invalid-file']),
      });
  });

  it('detects callback-driven same-name inode substitution after parsing', () => {
    const value = setup();
    const { target, stage } = installLinkedCrash(value);
    let fileNameReads = 0;
    let replaced = false;
    const codec: ImmutablePrivateRecordCodec<RecordFixture> = {
      ...value.codec,
      recordFileName(record) {
        fileNameReads += 1;
        if (fileNameReads === 2) {
          unlinkSync(stage);
          unlinkSync(target);
          writeFileSync(target, '{}\n', { mode: 0o600 });
          linkSync(target, stage);
          replaced = true;
        }
        return value.codec.recordFileName(record);
      },
    };
    const config = { ...value.config, codecForRead: () => codec };

    expect(readImmutablePrivateRecordsForRecoveryAdmission(config, { requireComplete: true }))
      .toMatchObject({
        records: [],
        sourceState: 'degraded',
        complete: false,
        stopReasons: expect.arrayContaining(['source-mutated']),
      });
    expect(replaced).toBe(true);
  });
});
