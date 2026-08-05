import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

import { auditExternalSkillPack } from '../src/core/fleet/external-skill-audit.js';
import { captureExternalSkillGitObject } from '../src/core/fleet/external-skill-git-capture.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
if (process.platform !== 'win32') process.env.PATH = '/usr/bin:/bin';

function temporary(name: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `ashlr-m446-${name}-`)));
  roots.push(path);
  return path;
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeSkill(
  root: string,
  name: string,
  otherSkill: string,
  word: string,
): void {
  const skill = join(root, 'skills', name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Guides ${word} workflows with deterministic evidence. Use when ${word} is required.`,
    '---',
    '',
    '## When to Use',
    `${word} work.`,
    '## Workflow',
    'Follow bounded steps.',
    '## Common Rationalizations',
    'Do not skip proof.',
    '## Red Flags',
    'Unsupported claims.',
    '## Verification',
    'Provide deterministic evidence.',
  ].join('\n'));
  const fixture = join(root, 'evals', 'fixtures', name);
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'input.txt'), word);
  writeFileSync(join(root, 'evals', 'cases', `${name}.json`), JSON.stringify({
    skill_name: name,
    trigger: {
      positive: [
        { prompt: `${word} ${word} workflow`, top_k: 1 },
        { prompt: `perform ${word} carefully`, top_k: 1 },
        { prompt: `need ${word} evidence`, top_k: 1 },
      ],
      negative: [
        { prompt: `${otherSkill.replaceAll('-', ' ')} workflow`, owner: otherSkill },
        { prompt: `perform ${otherSkill.replaceAll('-', ' ')}`, owner: otherSkill },
      ],
    },
    evals: [{
      id: 1,
      kind: 'execution',
      prompt: `Complete ${word}`,
      expected_output: 'private expected output',
      files: [name],
      expectations: ['private evidence expectation'],
    }],
  }));
}

function committedPack(options: { symlink?: boolean; rootSymlink?: boolean; lfs?: boolean } = {}): {
  work: string;
  bare: string;
  commitOid: string;
  portablePackDigest: string;
} {
  const root = temporary('repo');
  const work = join(root, 'work');
  const bare = join(root, 'bare.git');
  mkdirSync(work);
  chmodSync(work, 0o700);
  mkdirSync(join(work, 'skills'));
  mkdirSync(join(work, 'evals', 'cases'), { recursive: true });
  mkdirSync(join(work, 'evals', 'fixtures'), { recursive: true });
  writeSkill(work, 'testing-workflow', 'documentation-workflow', 'testing');
  writeSkill(work, 'documentation-workflow', 'testing-workflow', 'documentation');
  if (options.lfs) {
    writeFileSync(join(work, 'skills', 'testing-workflow', 'large.bin'), [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'size 123',
    ].join('\n'));
  }
  if (options.symlink && process.platform !== 'win32') {
    mkdirSync(join(work, '.opencode'));
    symlinkSync('../skills/', join(work, '.opencode', 'skills'));
  }
  if (options.rootSymlink && process.platform !== 'win32') {
    symlinkSync('.', join(work, 'self'));
  }
  git(work, ['init', '--quiet', '--initial-branch=main']);
  git(work, ['config', 'user.email', 'm446@ashlr.test']);
  git(work, ['config', 'user.name', 'M446']);
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  const commitOid = git(work, ['rev-parse', 'HEAD']);
  execFileSync('git', ['clone', '--quiet', '--bare', '--no-local', work, bare], { stdio: 'pipe' });
  chmodSync(bare, 0o700);
  const report = auditExternalSkillPack(work);
  if (!report.portablePackDigest) throw new Error('fixture audit unavailable');
  return { work, bare, commitOid, portablePackDigest: report.portablePackDigest };
}

function store(): string {
  const root = temporary('store');
  chmodSync(root, 0o700);
  return root;
}

type GitObjectFormat = 'sha1' | 'sha256';

interface RawTreeEntry {
  mode: '40000' | '100644' | '100755' | '120000' | '160000';
  name: string;
  oid: string;
}

interface RawRepository {
  bare: string;
  format: GitObjectFormat;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function initializeRawRepository(format: GitObjectFormat = 'sha1'): RawRepository {
  const root = temporary(`raw-${format}`);
  const bare = join(root, 'objects.git');
  git(root, [
    'init', '--quiet', '--bare', '--initial-branch=main',
    ...(format === 'sha256' ? ['--object-format=sha256'] : []),
    bare,
  ]);
  chmodSync(bare, 0o700);
  return { bare, format };
}

function rawGit(repository: RawRepository, args: string[], input?: Buffer): string {
  return git(repository.bare, ['--git-dir=.', ...args], input);
}

function writeRawObject(
  repository: RawRepository,
  type: 'blob' | 'tree' | 'commit',
  bytes: Buffer,
): string {
  return rawGit(repository, [
    'hash-object', '--literally', '-w', '-t', type, '--stdin',
  ], bytes);
}

function writeRawBlob(repository: RawRepository, bytes: Buffer | string): string {
  return writeRawObject(
    repository,
    'blob',
    typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes,
  );
}

function writeRawTree(repository: RawRepository, entries: RawTreeEntry[]): string {
  const body = Buffer.concat(entries
    .map((entry) => ({ ...entry, rawName: Buffer.from(entry.name, 'utf8') }))
    .sort((left, right) => Buffer.compare(left.rawName, right.rawName))
    .map((entry) => Buffer.concat([
      Buffer.from(`${entry.mode} `, 'ascii'),
      entry.rawName,
      Buffer.from([0]),
      Buffer.from(entry.oid, 'hex'),
    ])));
  return writeRawObject(repository, 'tree', body);
}

function writeRawCommit(
  repository: RawRepository,
  treeOid: string,
  message = 'fixture',
): string {
  return writeRawObject(repository, 'commit', Buffer.from([
    `tree ${treeOid}`,
    'author M446 <m446@ashlr.test> 0 +0000',
    'committer M446 <m446@ashlr.test> 0 +0000',
    '',
    message,
    '',
  ].join('\n'), 'utf8'));
}

function portableFileDigest(bytes: Buffer): string {
  return sha256(Buffer.concat([
    Buffer.from(`file\0${'644'}\0${bytes.length}\0`, 'utf8'),
    bytes,
  ]));
}

function portableDirectoryDigest(entries: Array<{ name: string; digest: string }>): string {
  const ordered = entries
    .map((entry) => ({ ...entry, rawName: Buffer.from(entry.name, 'utf8') }))
    .sort((left, right) => Buffer.compare(left.rawName, right.rawName));
  const hasher = createHash('sha256').update(`directory\0${'755'}\0${ordered.length}\0`);
  for (const entry of ordered) {
    hasher.update(`${entry.rawName.length}\0`);
    hasher.update(entry.rawName);
    hasher.update(`\0${entry.digest}`);
  }
  return hasher.digest('hex');
}

function singleFileCommit(
  repository: RawRepository,
  options: { name?: string; bytes?: Buffer; executable?: boolean; message?: string } = {},
): { blobOid: string; treeOid: string; commitOid: string; portablePackDigest: string } {
  const name = options.name ?? 'SKILL.md';
  const bytes = options.bytes ?? Buffer.from('inert skill bytes\n', 'utf8');
  const executable = options.executable ?? false;
  const blobOid = writeRawBlob(repository, bytes);
  const treeOid = writeRawTree(repository, [{
    mode: executable ? '100755' : '100644',
    name,
    oid: blobOid,
  }]);
  const commitOid = writeRawCommit(repository, treeOid, options.message);
  return {
    blobOid,
    treeOid,
    commitOid,
    portablePackDigest: portableDirectoryDigest([{
      name,
      digest: portableFileDigest(bytes),
    }]),
  };
}

function readCaptureBundle(storageRoot: string, captureDigest: string | null): Record<string, unknown> {
  if (!captureDigest) throw new Error('capture digest unavailable');
  return JSON.parse(readFileSync(
    join(storageRoot, 'objects', `${captureDigest}.bundle`),
    'utf8',
  )) as Record<string, unknown>;
}

function supportsSha256Repositories(): boolean {
  try {
    const repository = initializeRawRepository('sha256');
    return rawGit(repository, ['rev-parse', '--show-object-format']) === 'sha256';
  } catch {
    return false;
  }
}

const SHA256_REPOSITORIES_SUPPORTED = supportsSha256Repositories();

afterAll(() => {
  process.env.PATH = originalPath;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('M446 platform boundary', () => {
  it.runIf(process.platform === 'win32')('withholds until Windows executable custody is implemented', () => {
    expect(captureExternalSkillGitObject({
      repoPath: resolve('m446-not-opened.git'),
      commitOid: 'a'.repeat(40),
      packSubdir: '.',
      expectedPortablePackDigest: 'b'.repeat(64),
    })).toMatchObject({ state: 'withheld', reason: 'platform-unsupported' });
  });
});

describe.runIf(process.platform !== 'win32')('M446 external skill Git-object capture', () => {
  it('captures one exact bare-repository commit into metadata-only private CAS', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'git-object-quarantine',
      state: 'captured',
      reason: 'captured',
      portablePackDigest: fixture.portablePackDigest,
      authority: 'observation-only',
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
      custody: { localIntegrity: 'verified', authenticated: false },
    });
    expect(result.captureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.captureReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('private expected output');
    expect(JSON.stringify(result)).not.toContain(fixture.work);
    expect(JSON.stringify(result)).not.toContain(fixture.bare);
  });

  it('replays the exact capture without rewriting authority', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const input = {
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    };
    const first = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
    const second = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });

    expect(first.state).toBe('captured');
    expect(second).toEqual({ ...first, state: 'replayed', reason: 'replayed' });
  });

  it('derives receipt identity from the exact canonical bytes published by M446', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });
    if (!result.captureDigest || !result.captureReceiptDigest) {
      throw new Error('capture receipt identity unavailable');
    }
    const receiptBytes = readFileSync(
      join(storageRoot, 'receipts', `${result.captureDigest}.json`),
    );
    const expected = createHash('sha256')
      .update('ashlr:external-skill-capture-receipt:v1\0', 'utf8')
      .update(receiptBytes)
      .digest('hex');

    expect(result.captureReceiptDigest).toBe(expected);
    expect(JSON.stringify(result)).not.toContain(receiptBytes.toString('utf8'));
  });

  it.runIf(process.platform !== 'win32')(
    'recovers a hard-link publication crash before replaying the capture',
    () => {
      const fixture = committedPack();
      const storageRoot = store();
      const input = {
        repoPath: fixture.bare,
        commitOid: fixture.commitOid,
        packSubdir: '.',
        expectedPortablePackDigest: fixture.portablePackDigest,
      };
      const first = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
      if (!first.captureDigest) throw new Error('capture digest unavailable');
      const bundleTarget = join(storageRoot, 'objects', `${first.captureDigest}.bundle`);
      const candidate = join(
        storageRoot,
        'staging',
        `${first.captureDigest}.bundle.candidate`,
      );
      linkSync(bundleTarget, candidate);

      expect(statSync(bundleTarget).nlink).toBe(2);
      expect(statSync(candidate).nlink).toBe(2);

      const replay = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });

      expect(replay).toEqual({ ...first, state: 'replayed', reason: 'replayed' });
      expect(existsSync(candidate)).toBe(false);
      expect(statSync(bundleTarget).nlink).toBe(1);
    },
  );

  it('matches the M444 digest for an inert symlink resolving to the pack root', () => {
    const fixture = committedPack({ rootSymlink: true });
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({
      state: 'captured',
      portablePackDigest: fixture.portablePackDigest,
      symlinkCount: 1,
    });
  });

  it('withholds on a mutable ref, unknown input field, or digest mismatch', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const base = {
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    };
    expect(captureExternalSkillGitObject({ ...base, commitOid: 'main' }, {
      storageRoot, storageAnchor: storageRoot,
    })).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(captureExternalSkillGitObject({ ...base, extra: true } as never, {
      storageRoot, storageAnchor: storageRoot,
    })).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(captureExternalSkillGitObject({ ...base, expectedPortablePackDigest: 'f'.repeat(64) }, {
      storageRoot, storageAnchor: storageRoot,
    })).toMatchObject({ state: 'withheld', reason: 'audit-digest-mismatch' });
  });

  it('requires a bare object database and never falls back to the worktree', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.work,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'source-not-bare' });
  });

  it('requires the bare repository root to be private to the capture principal', () => {
    const fixture = committedPack();
    const storageRoot = store();
    chmodSync(fixture.bare, 0o755);
    try {
      const result = captureExternalSkillGitObject({
        repoPath: fixture.bare,
        commitOid: fixture.commitOid,
        packSubdir: '.',
        expectedPortablePackDigest: fixture.portablePackDigest,
      }, { storageRoot, storageAnchor: storageRoot });

      expect(result).toMatchObject({ state: 'withheld', reason: 'source-unsafe' });
      expect(existsSync(join(storageRoot, 'objects'))).toBe(false);
    } finally {
      chmodSync(fixture.bare, 0o700);
    }
  });

  it.each(['inside-source', 'contains-source'] as const)(
    'rejects quarantine storage that %s',
    (relationship) => {
      const fixture = committedPack();
      const sourceParent = dirname(fixture.bare);
      const storageRoot = relationship === 'inside-source' ? fixture.bare : sourceParent;
      const result = captureExternalSkillGitObject({
        repoPath: fixture.bare,
        commitOid: fixture.commitOid,
        packSubdir: '.',
        expectedPortablePackDigest: fixture.portablePackDigest,
      }, { storageRoot, storageAnchor: sourceParent });

      expect(result).toMatchObject({ state: 'withheld', reason: 'store-unavailable' });
      expect(existsSync(join(storageRoot, 'receipts'))).toBe(false);
      expect(existsSync(join(storageRoot, 'staging'))).toBe(false);
      expect(existsSync(join(storageRoot, 'locks'))).toBe(false);
    },
  );

  it('rejects LFS pointers instead of fetching external payloads', () => {
    const fixture = committedPack({ lfs: true });
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'lfs-pointer' });
  });

  it.runIf(process.platform !== 'win32')('binds safe internal symlinks as inert bytes', () => {
    const fixture = committedPack({ symlink: true });
    const storageRoot = store();
    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'captured', symlinkCount: 1, executionEligible: false });
  });

  it.runIf(process.platform !== 'win32')(
    'matches the M444 digest when a symlink target traverses an intermediate symlink',
    () => {
      const root = temporary('intermediate-symlink');
      const work = join(root, 'work');
      const bare = join(root, 'bare.git');
      mkdirSync(join(work, 'real'), { recursive: true });
      mkdirSync(join(work, 'skills'));
      writeFileSync(join(work, 'real', 'target.txt'), 'inert target bytes\n');
      writeFileSync(join(work, 'skills', 'tracked-entry.txt'), 'auditable pack entry\n');
      symlinkSync('real', join(work, 'alias'));
      symlinkSync('alias/target.txt', join(work, 'through-alias'));
      git(work, ['init', '--quiet', '--initial-branch=main']);
      git(work, ['config', 'user.email', 'm446@ashlr.test']);
      git(work, ['config', 'user.name', 'M446']);
      git(work, ['add', '-A']);
      git(work, ['commit', '--quiet', '--no-gpg-sign', '-m', 'intermediate symlink']);
      const commitOid = git(work, ['rev-parse', 'HEAD']);
      execFileSync('git', ['clone', '--quiet', '--bare', '--no-local', work, bare], { stdio: 'pipe' });
      chmodSync(bare, 0o700);
      const audit = auditExternalSkillPack(work);
      if (!audit.portablePackDigest) throw new Error('fixture audit unavailable');
      const storageRoot = store();

      const result = captureExternalSkillGitObject({
        repoPath: bare,
        commitOid,
        packSubdir: '.',
        expectedPortablePackDigest: audit.portablePackDigest,
      }, { storageRoot, storageAnchor: storageRoot });

      expect(result, JSON.stringify(result)).toMatchObject({
        state: 'captured',
        portablePackDigest: audit.portablePackDigest,
        symlinkCount: 2,
        executionEligible: false,
      });
    },
  );

  it('detects tampered content-addressed storage and never repairs it in place', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const input = {
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    };
    const first = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
    expect(first.captureDigest).not.toBeNull();
    writeFileSync(
      join(storageRoot, 'objects', `${first.captureDigest}.bundle`),
      readFileSync(join(storageRoot, 'objects', `${first.captureDigest}.bundle`), 'utf8') + 'tampered',
      { mode: 0o600 },
    );

    const second = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
    expect(second).toMatchObject({ state: 'withheld', reason: 'store-conflict' });
  });

  it('rejects semantically equivalent but non-canonical receipt bytes on replay', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const input = {
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    };
    const first = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
    if (!first.captureDigest) throw new Error('capture digest unavailable');
    const receiptPath = join(storageRoot, 'receipts', `${first.captureDigest}.json`);
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(receiptPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    const replay = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });

    expect(replay).toMatchObject({ state: 'withheld', reason: 'store-conflict' });
  });

  it('rejects a receipt without its bundle and never repairs beneath the commit marker', () => {
    const fixture = committedPack();
    const storageRoot = store();
    const input = {
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    };
    const first = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });
    if (!first.captureDigest) throw new Error('capture digest unavailable');
    const bundle = join(storageRoot, 'objects', `${first.captureDigest}.bundle`);
    const receipt = join(storageRoot, 'receipts', `${first.captureDigest}.json`);
    rmSync(bundle);

    const replay = captureExternalSkillGitObject(input, { storageRoot, storageAnchor: storageRoot });

    expect(replay).toMatchObject({ state: 'withheld', reason: 'store-conflict' });
    expect(existsSync(bundle)).toBe(false);
    expect(existsSync(receipt)).toBe(true);
  });

  it('requires a full object ID that resolves to a commit, never a ref or another object type', () => {
    const repository = initializeRawRepository();
    const fixture = singleFileCommit(repository);
    const storageRoot = store();
    const capture = (commitOid: string) => captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(capture(fixture.commitOid.slice(0, 12))).toMatchObject({
      state: 'withheld', reason: 'invalid-input',
    });
    expect(capture('main')).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(capture(fixture.blobOid)).toMatchObject({
      state: 'withheld', reason: 'source-unavailable',
    });
    expect(capture(fixture.treeOid)).toMatchObject({
      state: 'withheld', reason: 'source-unavailable',
    });
  });

  it('rejects gitlinks without resolving or recursing into submodules', () => {
    const repository = initializeRawRepository();
    const target = writeRawBlob(repository, 'not a submodule commit');
    const treeOid = writeRawTree(repository, [{ mode: '160000', name: 'vendor', oid: target }]);
    const commitOid = writeRawCommit(repository, treeOid);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: 'f'.repeat(64),
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'unsupported-tree-entry' });
  });

  it('rejects portable case-fold collisions in raw tree names', () => {
    const repository = initializeRawRepository();
    const first = writeRawBlob(repository, 'first');
    const second = writeRawBlob(repository, 'second');
    const treeOid = writeRawTree(repository, [
      { mode: '100644', name: 'README', oid: first },
      { mode: '100644', name: 'readme', oid: second },
    ]);
    const commitOid = writeRawCommit(repository, treeOid);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: 'f'.repeat(64),
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'portable-path-collision' });
  });

  it.each([
    ['broken', 'missing-target'],
    ['traversal', '../outside-pack'],
    ['metadata', '.git/config'],
  ])('rejects %s symlinks as inert raw target bytes', (_label, target) => {
    const repository = initializeRawRepository();
    const linkOid = writeRawBlob(repository, target);
    const treeOid = writeRawTree(repository, [{ mode: '120000', name: 'unsafe-link', oid: linkOid }]);
    const commitOid = writeRawCommit(repository, treeOid);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: 'f'.repeat(64),
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'unsafe-symlink' });
  });

  it('captures only the exact requested pack subdirectory', () => {
    const repository = initializeRawRepository();
    const selectedBytes = Buffer.from('selected pack bytes\n', 'utf8');
    const selectedBlob = writeRawBlob(repository, selectedBytes);
    const selectedTree = writeRawTree(repository, [{
      mode: '100644', name: 'SKILL.md', oid: selectedBlob,
    }]);
    const siblingBlob = writeRawBlob(repository, 'sibling private material');
    const packsTree = writeRawTree(repository, [
      { mode: '40000', name: 'selected', oid: selectedTree },
      { mode: '100644', name: 'sibling-secret.txt', oid: siblingBlob },
    ]);
    const outsideBlob = writeRawBlob(repository, 'outside private material');
    const rootTree = writeRawTree(repository, [
      { mode: '40000', name: 'packs', oid: packsTree },
      { mode: '100644', name: 'outside-secret.txt', oid: outsideBlob },
    ]);
    const commitOid = writeRawCommit(repository, rootTree);
    const portablePackDigest = portableDirectoryDigest([{
      name: 'SKILL.md',
      digest: portableFileDigest(selectedBytes),
    }]);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: 'packs/selected',
      expectedPortablePackDigest: portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });
    const bundle = readCaptureBundle(storageRoot, result.captureDigest);
    const serialized = JSON.stringify(bundle);

    expect(result).toMatchObject({ state: 'captured', fileCount: 1, totalBytes: selectedBytes.length });
    expect(serialized).toContain('SKILL.md');
    expect(serialized).not.toContain('sibling-secret');
    expect(serialized).not.toContain('outside-secret');
    expect(serialized).not.toContain('outside private material');
  });

  it.each([
    ['duplicate', 'packs', 'packs'],
    ['case-fold collision', 'PACKS', 'packs'],
  ])('rejects %s ancestor entries before pack-subdirectory selection', (_label, firstName, secondName) => {
    const repository = initializeRawRepository();
    const selected = singleFileCommit(repository);
    const firstPacks = writeRawTree(repository, [{
      mode: '40000', name: 'selected', oid: selected.treeOid,
    }]);
    const secondPacks = writeRawTree(repository, [{
      mode: '40000', name: 'selected', oid: selected.treeOid,
    }]);
    const rootTree = writeRawTree(repository, [
      { mode: '40000', name: firstName, oid: firstPacks },
      { mode: '40000', name: secondName, oid: secondPacks },
    ]);
    const commitOid = writeRawCommit(repository, rootTree);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: 'packs/selected',
      expectedPortablePackDigest: selected.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'portable-path-collision' });
  });

  it('applies the depth ceiling to file and symlink leaves, not only directories', () => {
    const repository = initializeRawRepository();
    const blob = writeRawBlob(repository, 'too deep');
    let tree = writeRawTree(repository, [{ mode: '100644', name: 'leaf.txt', oid: blob }]);
    for (let depth = 12; depth >= 1; depth -= 1) {
      tree = writeRawTree(repository, [{ mode: '40000', name: `d${depth}`, oid: tree }]);
    }
    const commitOid = writeRawCommit(repository, tree);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: 'f'.repeat(64),
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'capture-limit' });
  });

  it('counts every parsed ancestor entry toward the expansion ceiling', () => {
    const repository = initializeRawRepository();
    const selected = singleFileCommit(repository);
    const selectedTree = writeRawTree(repository, [{
      mode: '40000', name: 'selected', oid: selected.treeOid,
    }]);
    const sibling = writeRawBlob(repository, 'shared sibling');
    const rootTree = writeRawTree(repository, [
      { mode: '40000', name: 'packs', oid: selectedTree },
      ...Array.from({ length: 2_048 }, (_, index) => ({
        mode: '100644' as const,
        name: `sibling-${index.toString().padStart(4, '0')}`,
        oid: sibling,
      })),
    ]);
    const commitOid = writeRawCommit(repository, rootTree);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: 'packs/selected',
      expectedPortablePackDigest: selected.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'capture-limit' });
  });

  it('counts repeated shared-tree objects at every expanded path', () => {
    const repository = initializeRawRepository();
    const blob = writeRawBlob(repository, 'shared leaf');
    let tree = writeRawTree(repository, [
      { mode: '100644', name: 'left.txt', oid: blob },
      { mode: '100644', name: 'right.txt', oid: blob },
    ]);
    for (let depth = 0; depth < 11; depth += 1) {
      tree = writeRawTree(repository, [
        { mode: '40000', name: 'left', oid: tree },
        { mode: '40000', name: 'right', oid: tree },
      ]);
    }
    const commitOid = writeRawCommit(repository, tree);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: 'f'.repeat(64),
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'capture-limit' });
  }, 20_000);

  it('preserves executable mode as metadata while never executing blob bytes', () => {
    const repository = initializeRawRepository();
    const canaryRoot = temporary('execution-canary');
    const sentinel = join(canaryRoot, 'executed');
    const script = Buffer.from(`#!/bin/sh\nprintf compromised > "${sentinel}"\n`, 'utf8');
    const fixture = singleFileCommit(repository, {
      name: 'run-me',
      bytes: script,
      executable: true,
    });
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });
    expect(result, JSON.stringify(result)).toMatchObject({
      state: 'captured', executionEligible: false,
    });
    const bundle = readCaptureBundle(storageRoot, result.captureDigest) as {
      entries?: Array<{ mode?: string; contentBase64?: string }>;
    };

    expect(existsSync(sentinel)).toBe(false);
    expect(bundle.entries).toEqual([expect.objectContaining({
      mode: '100755',
      contentBase64: script.toString('base64'),
    })]);
  });

  it.runIf(SHA256_REPOSITORIES_SUPPORTED)(
    'captures a full SHA-256 commit when the installed Git supports that object format',
    () => {
      const repository = initializeRawRepository('sha256');
      const fixture = singleFileCommit(repository);
      const storageRoot = store();

      const result = captureExternalSkillGitObject({
        repoPath: repository.bare,
        commitOid: fixture.commitOid,
        packSubdir: '.',
        expectedPortablePackDigest: fixture.portablePackDigest,
      }, { storageRoot, storageAnchor: storageRoot });
      const bundle = readCaptureBundle(storageRoot, result.captureDigest);

      expect(fixture.commitOid).toMatch(/^[a-f0-9]{64}$/);
      expect(result).toMatchObject({ state: 'captured', executionEligible: false });
      expect(bundle).toMatchObject({ objectFormat: 'sha256', commitOid: fixture.commitOid });
    },
  );

  it('rejects alternate object-store contamination before invoking object reads', () => {
    const repository = initializeRawRepository();
    const fixture = singleFileCommit(repository);
    const alternateSecret = join(temporary('alternate-secret'), 'objects-with-token');
    mkdirSync(join(repository.bare, 'objects', 'info'), { recursive: true });
    writeFileSync(join(repository.bare, 'objects', 'info', 'alternates'), `${alternateSecret}\n`);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'source-unsafe' });
    expect(JSON.stringify(result)).not.toContain(alternateSecret);
  });

  it('rejects Git objects reached through filesystem symlinks outside the bare store', () => {
    const repository = initializeRawRepository();
    const fixture = singleFileCommit(repository);
    const objectPath = join(
      repository.bare,
      'objects',
      fixture.blobOid.slice(0, 2),
      fixture.blobOid.slice(2),
    );
    const outside = join(temporary('outside-object'), 'external-object');
    writeFileSync(outside, readFileSync(objectPath), { mode: 0o444 });
    rmSync(objectPath);
    symlinkSync(outside, objectPath);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'source-unsafe' });
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it('rejects oversized source object files before invoking Git object parsing', () => {
    const fixture = committedPack();
    const oversized = join(fixture.bare, 'objects', 'oversized.pack');
    writeFileSync(oversized, '');
    truncateSync(oversized, 32 * 1024 * 1024 + 1);
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'capture-limit' });
    expect(existsSync(join(storageRoot, 'objects'))).toBe(false);
  });

  it('rejects aggregate oversized object stores even when each file is below the per-file cap', () => {
    const fixture = committedPack();
    for (const name of ['oversized-a.pack', 'oversized-b.pack', 'oversized-c.pack']) {
      const path = join(fixture.bare, 'objects', name);
      writeFileSync(path, '');
      truncateSync(path, 24 * 1024 * 1024);
    }
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: fixture.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });

    expect(result).toMatchObject({ state: 'withheld', reason: 'capture-limit' });
    expect(existsSync(join(storageRoot, 'objects'))).toBe(false);
  });

  it('rejects oversized or externally including repository config before Git invocation', () => {
    const oversizedFixture = committedPack();
    truncateSync(join(oversizedFixture.bare, 'config'), 64 * 1024 + 1);
    const oversizedStore = store();
    expect(captureExternalSkillGitObject({
      repoPath: oversizedFixture.bare,
      commitOid: oversizedFixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: oversizedFixture.portablePackDigest,
    }, { storageRoot: oversizedStore, storageAnchor: oversizedStore })).toMatchObject({
      state: 'withheld', reason: 'source-unsafe',
    });

    const includeFixture = committedPack();
    const configPath = join(includeFixture.bare, 'config');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n[include]\n\tpath = /private/tmp/forbidden\n`);
    const includeStore = store();
    expect(captureExternalSkillGitObject({
      repoPath: includeFixture.bare,
      commitOid: includeFixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: includeFixture.portablePackDigest,
    }, { storageRoot: includeStore, storageAnchor: includeStore })).toMatchObject({
      state: 'withheld', reason: 'source-unsafe',
    });

    const worktreeFixture = committedPack();
    writeFileSync(join(worktreeFixture.bare, 'config.worktree'), '[include]\n\tpath = /private/tmp/forbidden\n');
    const worktreeStore = store();
    expect(captureExternalSkillGitObject({
      repoPath: worktreeFixture.bare,
      commitOid: worktreeFixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: worktreeFixture.portablePackDigest,
    }, { storageRoot: worktreeStore, storageAnchor: worktreeStore })).toMatchObject({
      state: 'withheld', reason: 'source-unsafe',
    });

    const commonFixture = committedPack();
    writeFileSync(join(commonFixture.bare, 'commondir'), '../redirected-git-dir\n');
    const commonStore = store();
    expect(captureExternalSkillGitObject({
      repoPath: commonFixture.bare,
      commitOid: commonFixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: commonFixture.portablePackDigest,
    }, { storageRoot: commonStore, storageAnchor: commonStore })).toMatchObject({
      state: 'withheld', reason: 'source-unsafe',
    });
  });

  it('keeps repository paths, commit messages, filenames, and blob contents out of public output', () => {
    const repository = initializeRawRepository();
    const filenameSecret = 'credential-canary-9f43.txt';
    const contentSecret = 'api-key-canary-6f2e';
    const commitSecret = 'commit-message-canary-a713';
    const fixture = singleFileCommit(repository, {
      name: filenameSecret,
      bytes: Buffer.from(contentSecret, 'utf8'),
      message: commitSecret,
    });
    const storageRoot = store();

    const result = captureExternalSkillGitObject({
      repoPath: repository.bare,
      commitOid: fixture.commitOid,
      packSubdir: '.',
      expectedPortablePackDigest: fixture.portablePackDigest,
    }, { storageRoot, storageAnchor: storageRoot });
    const publicJson = JSON.stringify(result);

    expect(result.state).toBe('captured');
    for (const secret of [
      repository.bare, filenameSecret, contentSecret, commitSecret, 'm446@ashlr.test',
    ]) {
      expect(publicJson).not.toContain(secret);
    }
  });

  it('has no runtime import path from src into the observation-only capture module', () => {
    const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sourceRoot = join(repositoryRoot, 'src');
    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const literalReferences: string[] = [];
    const target = /(?:^|\/)external-skill-git-capture\.js(?:[?#].*)?$/;
    expect(target.test('../core/fleet/external-skill-git-capture.js?runtime-edge')).toBe(true);
    expect(target.test('../core/fleet/external-skill-git-capture.js#runtime-edge')).toBe(true);
    const sourceFiles = (directory: string): string[] => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) ? [path] : [];
    });
    const moduleText = (node: ts.Expression | undefined): string | null =>
      node && ts.isStringLiteralLike(node) ? node.text : null;
    const importIsTypeOnly = (node: ts.ImportDeclaration): boolean => {
      const clause = node.importClause;
      if (!clause) return false;
      if (clause.isTypeOnly) return true;
      return clause.name === undefined && clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
    };

    for (const path of sourceFiles(sourceRoot)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const inspect = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && target.test(node.text)) {
          literalReferences.push(relative(repositoryRoot, path).replaceAll('\\', '/'));
        }
        if (ts.isImportDeclaration(node) && target.test(moduleText(node.moduleSpecifier) ?? '')) {
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'import',
            typeOnly: importIsTypeOnly(node),
          });
        } else if (ts.isExportDeclaration(node) && target.test(moduleText(node.moduleSpecifier) ?? '')) {
          const namedTypeOnly = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly);
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'export',
            typeOnly: node.isTypeOnly || namedTypeOnly,
          });
        } else if (ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          target.test(moduleText(node.moduleReference.expression) ?? '')) {
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'import-equals',
            typeOnly: node.isTypeOnly,
          });
        } else if (ts.isCallExpression(node)) {
          const specifier = moduleText(node.arguments[0]);
          const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if ((isDynamicImport || isRequire) && target.test(specifier ?? '')) {
            references.push({
              file: relative(repositoryRoot, path).replaceAll('\\', '/'),
              kind: isDynamicImport ? 'dynamic-import' : 'require',
              typeOnly: false,
            });
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }

    expect(references).toEqual([
      {
        file: 'src/api/types.ts',
        kind: 'export',
        typeOnly: true,
      },
      {
        file: 'src/core/fleet/external-skill-custody-attestation.ts',
        kind: 'import',
        typeOnly: true,
      },
    ]);
    expect([...new Set(literalReferences)]).toEqual([
      'src/api/types.ts',
      'src/core/fleet/external-skill-custody-attestation.ts',
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects unsafe writable source and storage ancestors before creating descendants',
    () => {
      const sourceFixture = committedPack();
      const unsafeSourceAncestor = dirname(sourceFixture.bare);
      chmodSync(unsafeSourceAncestor, 0o777);
      const unusedStoreAnchor = store();
      const unusedStorageRoot = join(unusedStoreAnchor, 'must-not-exist');
      try {
        const sourceResult = captureExternalSkillGitObject({
          repoPath: sourceFixture.bare,
          commitOid: sourceFixture.commitOid,
          packSubdir: '.',
          expectedPortablePackDigest: sourceFixture.portablePackDigest,
        }, { storageRoot: unusedStorageRoot, storageAnchor: unusedStoreAnchor });

        expect(sourceResult).toMatchObject({ state: 'withheld', reason: 'source-unsafe' });
        expect(existsSync(unusedStorageRoot)).toBe(false);
      } finally {
        chmodSync(unsafeSourceAncestor, 0o700);
      }

      const storageFixture = committedPack();
      const unsafeStorageAnchor = temporary('unsafe-storage-ancestor');
      const unsafeStorageRoot = join(unsafeStorageAnchor, 'must-not-exist');
      chmodSync(unsafeStorageAnchor, 0o777);
      try {
        const storageResult = captureExternalSkillGitObject({
          repoPath: storageFixture.bare,
          commitOid: storageFixture.commitOid,
          packSubdir: '.',
          expectedPortablePackDigest: storageFixture.portablePackDigest,
        }, { storageRoot: unsafeStorageRoot, storageAnchor: unsafeStorageAnchor });

        expect(storageResult).toMatchObject({ state: 'withheld', reason: 'store-unavailable' });
        expect(existsSync(unsafeStorageRoot)).toBe(false);
      } finally {
        chmodSync(unsafeStorageAnchor, 0o700);
      }
    },
  );
});
