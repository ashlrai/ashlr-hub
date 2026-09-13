import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { readHarnessArchive, registerHarnessArchive, storeHarnessCandidate, type StoreHarnessCandidateOptions } from '../src/core/universe/harness-archive.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function file(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), content, { mode: 0o600 });
}
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-archive-'))); roots.push(parent);
  const root = join(parent, 'store'); const baselinePath = join(parent, 'baseline');
  const candidatePath = join(parent, 'candidate'); const evaluatorPath = join(parent, 'evaluator');
  for (const path of [root, baselinePath, candidatePath, evaluatorPath]) mkdirSync(path, { mode: 0o700 });
  file(baselinePath, 'src/prompt.ts', 'original'); file(candidatePath, 'src/prompt.ts', 'challenger');
  file(baselinePath, 'README.md', 'fixed readme'); file(candidatePath, 'README.md', 'fixed readme');
  file(evaluatorPath, 'evaluate.js', 'throw new Error("archive must never execute me")');
  const registration = { root, archiveId: 'search', mutableFiles: ['src/prompt.ts'], baselinePath,
    baselineDigest: artifactDigest(baselinePath), evaluatorPath, evaluatorDigest: artifactDigest(evaluatorPath) };
  const options = (): StoreHarnessCandidateOptions => ({ root, archiveId: 'search', candidateId: 'candidate-a', candidatePath,
    contentDigest: artifactDigest(candidatePath), hypothesis: 'More explicit context improves recall.', reason: 'The supplied evaluation failed.',
    outcome: 'refuted', evidence: null, supersededBy: null });
  const query = () => readHarnessArchive({ root, archiveId: 'search' });
  const recordPath = (name: string) => join(root, 'harness-search', 'records', `${name}.json`);
  return { parent, root, baselinePath, candidatePath, evaluatorPath, registration, options, query, recordPath };
}

describe('private harness hypothesis archive', () => {
  it('retains a refuted hypothesis and complete digest-bound content without executing or applying it', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    const stored = storeHarnessCandidate(f.options());
    expect(stored.disposition).toBe('recorded');
    expect(stored.candidate).toMatchObject({ outcome: 'refuted', independentlyVerified: false, evidence: null,
      evidenceScope: 'supplied-verifier-linkage', changedFiles: ['src/prompt.ts'] });
    expect(readFileSync(join(f.baselinePath, 'src/prompt.ts'), 'utf8')).toBe('original');
    const evaluatorBefore = readFileSync(join(f.evaluatorPath, 'evaluate.js'));
    rmSync(f.candidatePath, { recursive: true });
    const query = f.query(); expect(query.sourceState).toBe('healthy'); expect(query.candidates).toHaveLength(1);
    const snapshot = query.candidates[0]!.content.files.find((entry) => entry.path === 'src/prompt.ts')!;
    expect(Buffer.from(snapshot.contentBase64, 'base64').toString()).toBe('challenger');
    expect(readFileSync(join(f.evaluatorPath, 'evaluate.js'))).toEqual(evaluatorBefore);
  });

  it('replays exact registration and candidate identities; refuses either identity being rewritten', () => {
    const f = fixture(); expect(registerHarnessArchive(f.registration).disposition).toBe('recorded');
    expect(registerHarnessArchive(f.registration).disposition).toBe('replayed');
    expect(storeHarnessCandidate(f.options()).disposition).toBe('recorded');
    expect(storeHarnessCandidate(f.options()).disposition).toBe('replayed');
    const record = readFileSync(f.recordPath('registration'));
    expect(() => registerHarnessArchive({ ...f.registration, mutableFiles: ['src/prompt.ts', 'README.md'] })).toThrow(/conflicted/);
    expect(() => storeHarnessCandidate({ ...f.options(), reason: 'Reclassified without a new identity' })).toThrow(/conflicted/);
    expect(readFileSync(f.recordPath('registration'))).toEqual(record);
    expect(f.query().candidates).toHaveLength(1);
  });

  it('requires effective evidence to link exact evaluator, candidate and supplied verifier receipt', () => {
    const f = fixture(); registerHarnessArchive(f.registration); const input = { ...f.options(), outcome: 'effective' as const };
    expect(() => storeHarnessCandidate(input)).toThrow(/linkage/);
    const evidence = { evaluatorDigest: f.registration.evaluatorDigest, artifactDigest: input.contentDigest,
      verifierId: 'independent-evaluator', receiptDigest: 'a'.repeat(64) };
    expect(() => storeHarnessCandidate({ ...input, evidence: { ...evidence, evaluatorDigest: 'b'.repeat(64) } })).toThrow(/linkage/);
    expect(() => storeHarnessCandidate({ ...input, evidence: { ...evidence, artifactDigest: 'b'.repeat(64) } })).toThrow(/linkage/);
    expect(() => storeHarnessCandidate({ ...input, evidence: { ...evidence, verifierId: '' } })).toThrow(/linkage/);
    const { candidate } = storeHarnessCandidate({ ...input, evidence });
    expect(candidate.outcome).toBe('effective'); expect(candidate.independentlyVerified).toBe(false);
    expect(candidate.evidence).toEqual(evidence);
  });

  it('does not classify an unchanged candidate as effective', () => {
    const f = fixture(); registerHarnessArchive(f.registration); file(f.candidatePath, 'src/prompt.ts', 'original');
    const input = f.options();
    expect(() => storeHarnessCandidate({ ...input, outcome: 'effective', evidence: { evaluatorDigest: f.registration.evaluatorDigest,
      artifactDigest: input.contentDigest, verifierId: 'verifier', receiptDigest: 'a'.repeat(64) } })).toThrow(/linkage/);
    expect(storeHarnessCandidate({ ...input, outcome: 'inconclusive' }).candidate.changedFiles).toEqual([]);
  });

  it.each(['CONSTITUTION.md', 'docs/AGENT-OS-DOCTRINE.md', 'src/cli/verify-safety.ts', 'test/h4.verify-safety.test.ts',
    'test/h1.runtime.test.ts', 'test/safety/new.test.ts', 'src/cli/eval-fixtures.ts', 'eval/fixtures/case.json',
    'src/core/inbox/merge.ts', 'src/core/universe/fixed-evaluator.ts', 'docs/DoCtRiNe.md'])('always refuses protected allowlist %s', (path) => {
    const f = fixture(); expect(() => registerHarnessArchive({ ...f.registration, mutableFiles: [path] })).toThrow(/registration/);
    expect(readdirSync(f.root)).toEqual([]);
  });

  it.each(['../outside.ts', '/absolute.ts', 'src/../prompt.ts', 'src//prompt.ts', 'src\\prompt.ts', '.git/config', './src/prompt.ts'])('refuses escaped or ambiguous mutable path %s', (path) => {
    const f = fixture(); expect(() => registerHarnessArchive({ ...f.registration, mutableFiles: [path] })).toThrow(/registration/);
  });

  it('refuses unallowlisted modifications, deletion and executable-mode changes', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    file(f.candidatePath, 'README.md', 'rewritten'); expect(() => storeHarnessCandidate(f.options())).toThrow(/scope/);
    rmSync(join(f.candidatePath, 'README.md')); expect(() => storeHarnessCandidate(f.options())).toThrow(/scope/);
    file(f.candidatePath, 'README.md', 'fixed readme'); chmodSync(join(f.candidatePath, 'README.md'), 0o700);
    expect(() => storeHarnessCandidate(f.options())).toThrow(/scope/);
  });

  it('refuses candidate edits to evaluator paths even when explicitly allowlisted', () => {
    const f = fixture(); f.registration.mutableFiles.push('evaluate.js'); registerHarnessArchive(f.registration);
    file(f.candidatePath, 'evaluate.js', 'pass everything'); expect(() => storeHarnessCandidate(f.options())).toThrow(/scope/);
  });

  it('refuses forged artifact pins and frozen-evaluator changes', () => {
    const f = fixture(); expect(() => registerHarnessArchive({ ...f.registration, baselineDigest: 'a'.repeat(64) })).toThrow(/digest/);
    registerHarnessArchive(f.registration); expect(() => storeHarnessCandidate({ ...f.options(), contentDigest: 'a'.repeat(64) })).toThrow(/digest/);
    file(f.evaluatorPath, 'evaluate.js', 'weaker evaluator');
    expect(() => registerHarnessArchive(f.registration)).toThrow(/digest/);
    expect(() => registerHarnessArchive({ ...f.registration, evaluatorDigest: artifactDigest(f.evaluatorPath) })).toThrow(/conflicted/);
  });

  it('refuses symlinked source roots, ancestors, files and hardlinked file aliases', () => {
    const f = fixture(); registerHarnessArchive(f.registration); const input = f.options();
    const alias = join(f.parent, 'alias'); symlinkSync(f.parent, alias);
    expect(() => storeHarnessCandidate({ ...input, candidatePath: join(alias, 'candidate') })).toThrow(/path/);
    symlinkSync(join(f.baselinePath, 'README.md'), join(f.candidatePath, 'linked'));
    expect(() => storeHarnessCandidate(input)).toThrow();
    rmSync(join(f.candidatePath, 'linked')); linkSync(join(f.baselinePath, 'README.md'), join(f.candidatePath, 'linked'));
    expect(() => storeHarnessCandidate(input)).toThrow();
  });

  it('retains superseded evidence only with an existing replacement linkage', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    expect(() => storeHarnessCandidate({ ...f.options(), outcome: 'superseded', supersededBy: 'missing' })).toThrow(/linkage/);
    expect(() => storeHarnessCandidate({ ...f.options(), outcome: 'superseded', supersededBy: 'candidate-a' })).toThrow(/linkage/);
    storeHarnessCandidate({ ...f.options(), candidateId: 'replacement' });
    storeHarnessCandidate({ ...f.options(), outcome: 'superseded', supersededBy: 'replacement' });
    expect(f.query().candidates.find((row) => row.candidateId === 'candidate-a')?.supersededBy).toBe('replacement');
  });

  it.each(['bytes', 'digest', 'registration', 'scope'])('detects persisted %s corruption without returning partial healthy evidence', (mode) => {
    const f = fixture(); registerHarnessArchive(f.registration); storeHarnessCandidate(f.options());
    const candidate = JSON.parse(readFileSync(f.recordPath('candidate.candidate-a'), 'utf8'));
    if (mode === 'bytes') candidate.content.files[0].contentBase64 = Buffer.from('forged bytes').toString('base64');
    if (mode === 'digest') candidate.content.digest = 'a'.repeat(64);
    if (mode === 'registration') candidate.registrationDigest = 'a'.repeat(64);
    if (mode === 'scope') candidate.changedFiles = ['README.md'];
    const { candidateDigest: _old, ...payload } = candidate; candidate.candidateDigest = digest(canonical(payload));
    writeFileSync(f.recordPath('candidate.candidate-a'), `${canonical(candidate)}\n`);
    expect(f.query()).toMatchObject({ sourceState: 'degraded', registration: null, candidates: [] });
    expect(() => storeHarnessCandidate({ ...f.options(), candidateId: 'next' })).toThrow(/unavailable/);
  });

  it('reports missing storage without creating it and refuses corrupt or linked storage', () => {
    const f = fixture(); expect(f.query().sourceState).toBe('missing'); expect(readdirSync(f.root)).toEqual([]);
    const missing = join(f.parent, 'missing'); expect(readHarnessArchive({ root: missing, archiveId: 'search' }).sourceState).toBe('missing');
    expect(existsSync(missing)).toBe(false);
    registerHarnessArchive(f.registration); writeFileSync(f.recordPath('registration'), 'corrupt');
    expect(f.query().sourceState).toBe('degraded');
    rmSync(join(f.root, 'harness-search'), { recursive: true }); symlinkSync(f.baselinePath, join(f.root, 'harness-search'));
    expect(f.query().sourceState).toBe('degraded');
    rmSync(join(f.root, 'harness-search')); symlinkSync(missing, join(f.root, 'harness-search'));
    expect(f.query().sourceState).toBe('degraded');
  });

  it('rejects input getters before invoking them', () => {
    const f = fixture(); let invoked = false;
    const options = { ...f.registration, get baselinePath() { invoked = true; return f.baselinePath; } };
    expect(() => registerHarnessArchive(options)).toThrow(/registration/); expect(invoked).toBe(false);
    registerHarnessArchive(f.registration);
    const invalidOutcome = { toString() { invoked = true; return 'effective'; } };
    expect(() => storeHarnessCandidate({ ...f.options(), outcome: invalidOutcome as unknown as 'effective' })).toThrow(/candidate/);
    const invalidEvidence = { get evaluatorDigest() { invoked = true; return f.registration.evaluatorDigest; },
      artifactDigest: f.options().contentDigest, verifierId: 'verifier', receiptDigest: 'a'.repeat(64) };
    expect(() => storeHarnessCandidate({ ...f.options(), evidence: invalidEvidence })).toThrow(/linkage/);
    expect(invoked).toBe(false);
  });

  it('requires an owned private root and keeps records owner-private', () => {
    const f = fixture(); chmodSync(f.root, 0o755);
    expect(() => registerHarnessArchive(f.registration)).toThrow(); expect(f.query().sourceState).toBe('degraded');
    chmodSync(f.root, 0o700); registerHarnessArchive(f.registration); storeHarnessCandidate(f.options());
    expect(f.query().sourceState).toBe('healthy');
    expect(lstatSync(f.recordPath('registration')).mode & 0o777).toBe(0o600);
    expect(lstatSync(f.recordPath('candidate.candidate-a')).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(f.recordPath('registration'))).mode & 0o777).toBe(0o700);
  });

  it('bounds persisted snapshot size and refuses sources overlapping the archive scope', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    file(f.candidatePath, 'src/prompt.ts', 'x'.repeat(256 * 1024));
    expect(() => storeHarnessCandidate(f.options())).toThrow(/bounded/);
    expect(() => storeHarnessCandidate({ ...f.options(), candidatePath: f.root })).toThrow(/path/);
    expect(() => storeHarnessCandidate({ ...f.options(), candidatePath: f.parent })).toThrow(/path/);
    expect(f.query().candidates).toEqual([]);
  });

  it('refuses archive-owner contention before publication and permits retry after release', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    const lock = acquireLocalStoreLockWithOutcome(join(f.root, '.harness-search.lock'), 0, { anchorPath: f.root, exactPrivateStorage: true });
    if (lock.state !== 'acquired') throw new Error('Fixture failed to acquire archive ownership');
    try {
      expect(() => storeHarnessCandidate(f.options())).toThrow(/ownership unavailable/);
      expect(() => registerHarnessArchive(f.registration)).toThrow(/ownership unavailable/);
      expect(f.query().candidates).toEqual([]);
    } finally { releaseLocalStoreLock(lock.lock); }
    expect(storeHarnessCandidate(f.options()).disposition).toBe('recorded');
  });

  function sibling(record: ReturnType<typeof storeHarnessCandidate>['candidate'], candidateId: string) {
    const { candidateDigest: _old, ...payload } = { ...record, id: `candidate.${candidateId}`, candidateId };
    return { ...payload, candidateDigest: digest(canonical(payload)) };
  }

  it('rejects exact serialized aggregate overflow before writing and preserves healthy replay', () => {
    const f = fixture(); registerHarnessArchive(f.registration);
    file(f.candidatePath, 'src/prompt.ts', 'x'.repeat(256 * 1024 - Buffer.byteLength('fixed readme')));
    const input = f.options(); const { candidate } = storeHarnessCandidate(input);
    const cap = 64 * 1024 * 1024;
    let used = readFileSync(f.recordPath('registration')).length + readFileSync(f.recordPath(candidate.id)).length;
    let count = 1;
    for (; count < 256; count++) {
      const record = sibling(candidate, `large-${count}`); const bytes = `${canonical(record)}\n`;
      if (used + Buffer.byteLength(bytes) > cap) break;
      writeFileSync(f.recordPath(record.id), bytes, { mode: 0o600 }); used += Buffer.byteLength(bytes);
    }
    expect(count).toBeLessThan(256);
    expect(used).toBeLessThanOrEqual(cap);
    expect(used + Buffer.byteLength(`${canonical(sibling(candidate, 'overflow'))}\n`)).toBeGreaterThan(cap);
    const before = readdirSync(dirname(f.recordPath('registration'))).sort();
    expect(() => storeHarnessCandidate({ ...input, candidateId: 'overflow' })).toThrow(/capacity/);
    expect(readdirSync(dirname(f.recordPath('registration'))).sort()).toEqual(before);
    expect(f.query()).toMatchObject({ sourceState: 'healthy' });
    expect(storeHarnessCandidate(input).disposition).toBe('replayed');
  }, 30_000);

  it('serializes separate-process contenders for the final candidate slot', async () => {
    const f = fixture(); registerHarnessArchive(f.registration); const input = f.options();
    const { candidate } = storeHarnessCandidate(input);
    for (let index = 1; index < 255; index++) {
      const record = sibling(candidate, `filled-${index}`);
      writeFileSync(f.recordPath(record.id), `${canonical(record)}\n`, { mode: 0o600 });
    }
    const script = `import { storeHarnessCandidate } from ${JSON.stringify(new URL('../src/core/universe/harness-archive.ts', import.meta.url).href)};
      try { const result = storeHarnessCandidate(JSON.parse(process.argv[1])); console.log(result.disposition); }
      catch (error) { console.log(error.message); }`;
    const run = promisify(execFile);
    const outputs = await Promise.all(['contender-a', 'contender-b'].map((candidateId) =>
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify({ ...input, candidateId })],
        { timeout: 15_000, maxBuffer: 4_096 })));
    expect(outputs.filter((output) => output.stdout.trim() === 'recorded')).toHaveLength(1);
    expect(outputs.filter((output) => /ownership unavailable|capacity reached/.test(output.stdout))).toHaveLength(1);
    expect(f.query().sourceState).toBe('healthy'); expect(f.query().candidates).toHaveLength(256);
    expect(() => storeHarnessCandidate({ ...input, candidateId: 'after-full' })).toThrow(/capacity/);
    expect(storeHarnessCandidate(input).disposition).toBe('replayed');
  }, 30_000);
});
