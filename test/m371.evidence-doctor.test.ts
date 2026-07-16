import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnoseFleetEvidence,
  FLEET_EVIDENCE_SOURCES,
  isFleetEvidenceSource,
  type FleetEvidenceDiagnosisQuality,
  type FleetEvidenceSource,
} from '../src/core/fleet/evidence-doctor.js';
import { cmdFleet } from '../src/cli/fleet.js';

let home: string;
let previousAshlrHome: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

const quality = (overrides: Partial<FleetEvidenceDiagnosisQuality> = {}): FleetEvidenceDiagnosisQuality => ({
  sourceState: 'healthy',
  sourcePresent: true,
  complete: true,
  stopReasons: [],
  filesRead: 1,
  bytesRead: 128,
  rowsScanned: 2,
  invalidRows: 0,
  unreadableFiles: 0,
  ...overrides,
});

beforeEach(() => {
  previousAshlrHome = process.env.ASHLR_HOME;
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m371-evidence-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M371 read-only fleet evidence doctor', () => {
  it('diagnoses every absent ledger as cold-start without creating storage', () => {
    for (const source of FLEET_EVIDENCE_SOURCES) {
      expect(diagnoseFleetEvidence(source)).toMatchObject({
        schemaVersion: 1,
        source,
        state: 'cold-start',
        attempts: 1,
        mutable: false,
        quality: { sourceState: 'missing', sourcePresent: false, complete: true },
      });
    }
    expect(existsSync(process.env.ASHLR_HOME!)).toBe(false);
  });

  it('classifies complete evidence as healthy and forwards normal versus deep mode', () => {
    const seen: boolean[] = [];
    const reader = (deep: boolean) => { seen.push(deep); return quality(); };
    expect(diagnoseFleetEvidence('decisions', { deps: { readers: { decisions: reader } } })).toMatchObject({
      state: 'healthy', deep: false, attempts: 1, mutable: false,
    });
    expect(diagnoseFleetEvidence('decisions', { deep: true, deps: { readers: { decisions: reader } } })).toMatchObject({
      state: 'healthy', deep: true, attempts: 1, mutable: false,
    });
    expect(seen).toEqual([false, true]);
  });

  it('retries a transient I/O failure once and never claims durable repair', () => {
    let calls = 0;
    const reader = () => ++calls === 1
      ? quality({ sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1 })
      : quality();
    expect(diagnoseFleetEvidence('judge-traces', { deps: { readers: { 'judge-traces': reader } } })).toMatchObject({
      state: 'transient-retry-recovered',
      attempts: 2,
      mutable: false,
      quality: { sourceState: 'healthy', complete: true },
    });
    expect(calls).toBe(2);
  });

  it.each(['file-limit', 'byte-limit', 'row-limit', 'event-limit', 'bounded-limit'])('reports %s as a hard cap without retry', (reason) => {
    let calls = 0;
    const reader = () => {
      calls++;
      return quality({ sourceState: 'degraded', complete: false, stopReasons: [reason] });
    };
    expect(diagnoseFleetEvidence('agent-actions', { deps: { readers: { 'agent-actions': reader } } })).toMatchObject({
      state: 'hard-cap-exceeded', attempts: 1, mutable: false,
    });
    expect(calls).toBe(1);
  });

  it('keeps malformed evidence fail-closed for manual inspection', () => {
    const reader = () => quality({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(diagnoseFleetEvidence('best-of-n', { deps: { readers: { 'best-of-n': reader } } })).toMatchObject({
      state: 'manual-inspection-required', attempts: 1, mutable: false,
      quality: { invalidRows: 1 },
    });
  });

  it('leaves malformed persisted bytes unchanged during real diagnosis', () => {
    const dir = join(process.env.ASHLR_HOME!, 'best-of-n');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(file, '{malformed-json\n', { mode: 0o600 });
    const before = readFileSync(file);

    expect(diagnoseFleetEvidence('best-of-n')).toMatchObject({
      state: 'manual-inspection-required', mutable: false,
      quality: { invalidRows: 1 },
    });
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(dir, '.best-of-n.lock'))).toBe(false);
  });

  it('leaves malformed autonomy packs and storage unchanged during deep diagnosis', () => {
    const root = process.env.ASHLR_HOME!;
    const dir = join(root, 'evidence');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'malformed-pack.json');
    const malformed = '{malformed-json\n';
    writeFileSync(file, malformed, { mode: 0o600 });
    const before = readFileSync(file);
    const storageBefore = readdirSync(root, { recursive: true }).sort();
    const provenanceKey = join(root, 'foundry', 'provenance.key');
    expect(existsSync(provenanceKey)).toBe(false);

    expect(diagnoseFleetEvidence('autonomy-packs', { deep: true })).toMatchObject({
      source: 'autonomy-packs',
      state: 'manual-inspection-required',
      deep: true,
      attempts: 1,
      mutable: false,
      quality: {
        sourceState: 'degraded',
        complete: false,
        stopReasons: ['invalid-file'],
        filesRead: 1,
        bytesRead: Buffer.byteLength(malformed),
        rowsScanned: 1,
        invalidRows: 1,
        unreadableFiles: 0,
      },
    });
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(storageBefore);
    expect(existsSync(provenanceKey)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not migrate unsafe legacy modes during inspection', () => {
    const dir = join(process.env.ASHLR_HOME!, 'best-of-n');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(file, '{malformed-json\n', { mode: 0o644 });

    expect(diagnoseFleetEvidence('best-of-n')).toMatchObject({
      state: 'manual-inspection-required', attempts: 2, mutable: false,
    });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dir, '.best-of-n.lock'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not migrate dispatch-manifest modes during inspection', () => {
    const dir = join(process.env.ASHLR_HOME!, 'dispatch-manifests');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(file, '{malformed-json\n', { mode: 0o644 });

    expect(diagnoseFleetEvidence('dispatch-manifests')).toMatchObject({
      state: 'manual-inspection-required', attempts: 2, mutable: false,
    });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dir, '.dispatch-manifests.lock'))).toBe(false);
  });

  it('does not create coordination locks for empty inspection stores', () => {
    const root = process.env.ASHLR_HOME!;
    mkdirSync(join(root, 'agent-actions'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'dispatch-manifests'), { mode: 0o700 });

    expect(diagnoseFleetEvidence('agent-actions').state).toBe('healthy');
    expect(diagnoseFleetEvidence('dispatch-manifests').state).toBe('healthy');
    expect(existsSync(join(root, 'agent-actions', '.agent-actions.lock'))).toBe(false);
    expect(existsSync(join(root, 'dispatch-manifests', '.dispatch-manifests.lock'))).toBe(false);
  });

  it('validates the closed source vocabulary', () => {
    for (const source of FLEET_EVIDENCE_SOURCES) expect(isFleetEvidenceSource(source)).toBe(true);
    expect(FLEET_EVIDENCE_SOURCES).toContain('autonomy-packs');
    expect(isFleetEvidenceSource('arbitrary-ledger')).toBe(false);
    expect(new Set<FleetEvidenceSource>(FLEET_EVIDENCE_SOURCES).size).toBe(7);
  });

  it('wires JSON CLI diagnosis without endpoint or mutation authority', async () => {
    let output = '';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });
    try {
      expect(await cmdFleet(['evidence', 'doctor', 'autonomy-packs', '--json'])).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(JSON.parse(output)).toMatchObject({
      source: 'autonomy-packs', state: 'cold-start', mutable: false, attempts: 1,
    });
    expect(output).not.toContain('endpointPath');
  });

  it('rejects unknown CLI sources and options', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleet(['evidence', 'doctor', 'unknown', '--json'])).toBe(2);
      expect(await cmdFleet(['evidence', 'doctor', 'decisions', '--mutate'])).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });
});
