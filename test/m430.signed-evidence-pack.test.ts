import { createHash, createHmac } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHarness = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((
    openedPath: string,
    flags: number,
    actual: typeof import('node:fs'),
  ) => void),
  beforeRename: undefined as undefined | ((
    oldPath: string,
    newPath: string,
    actual: typeof import('node:fs'),
  ) => void),
  afterRename: undefined as undefined | ((
    oldPath: string,
    newPath: string,
    actual: typeof import('node:fs'),
  ) => void),
  opens: [] as Array<{ path: string; flags: number }>,
  syncPaths: [] as string[],
  rejectSyncPath: undefined as string | undefined,
  fdPaths: new Map<number, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(openedPath: import('node:fs').PathLike, flags: number, ...args: unknown[]) {
      fsHarness.beforeOpen?.(String(openedPath), flags, actual);
      const fd = (actual.openSync as (...params: unknown[]) => number)(openedPath, flags, ...args);
      fsHarness.opens.push({ path: String(openedPath), flags });
      fsHarness.fdPaths.set(fd, String(openedPath));
      return fd;
    },
    renameSync(oldPath: import('node:fs').PathLike, newPath: import('node:fs').PathLike) {
      fsHarness.beforeRename?.(String(oldPath), String(newPath), actual);
      const result = actual.renameSync(oldPath, newPath);
      fsHarness.afterRename?.(String(oldPath), String(newPath), actual);
      return result;
    },
    fsyncSync(fd: number) {
      const syncedPath = fsHarness.fdPaths.get(fd) ?? `fd:${fd}`;
      fsHarness.syncPaths.push(syncedPath);
      if (fsHarness.rejectSyncPath === syncedPath) {
        throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
      }
      return actual.fsyncSync(fd);
    },
    closeSync(fd: number) {
      try {
        return actual.closeSync(fd);
      } finally {
        fsHarness.fdPaths.delete(fd);
      }
    },
  };
});

import * as fs from 'node:fs';

import {
  buildAutonomyEvidencePack,
  buildSignedAutonomyEvidencePackV3,
  evidenceDir,
  evidencePath,
  listAutonomyEvidencePacks,
  persistAutonomyEvidencePack,
  readAutonomyEvidencePack,
  readAutonomyEvidencePacksDetailed,
  sealAutonomyEvidencePackV3,
  verifyAutonomyEvidencePackV3,
  type AutonomyEvidencePackLegacy,
  type SignedAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import {
  canonicalEvidencePackJsonV3,
  hashDiff,
  provenanceKeyPath,
  sealedEvidencePackDigestV3,
} from '../src/core/foundry/provenance.js';
import type { Proposal } from '../src/core/types.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tmpHome: string;
const privateStorageRequests: Array<{
  operation: string;
  mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  kind?: 'file' | 'directory';
}> = [];

const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
    kind?: 'file' | 'directory';
  };
  privateStorageRequests.push(request);
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason: request.operation === 'assure-private-paths'
        ? 'owned-safe-paths'
        : request.mode === 'inspect-owned'
          ? 'owned-safe-path'
          : 'exact-private-dacl',
    }),
  };
};

function restoreEnvironment(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function diff(): string {
  return [
    'diff --git a/docs/signed.md b/docs/signed.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/signed.md',
    '@@ -0,0 +1 @@',
    '+signed evidence',
    '',
  ].join('\n');
}

const TEST_DIFF_HASH = hashDiff(diff());

function proposal(id = 'prop-m430'): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: 'signed evidence pack',
    summary: 'signed evidence pack v3 test',
    diff: diff(),
    diffHash: TEST_DIFF_HASH,
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: '2026-07-16T12:00:00.000Z',
  };
}

function input(id = 'prop-m430') {
  return {
    proposal: proposal(id),
    target: 'main' as const,
    trustBasis: 'tier' as const,
    remotePreferred: true,
    riskClass: 'low' as const,
    authority: { ok: true, detail: 'frontier authority' },
    provenance: { ok: true, detail: 'producer HMAC valid' },
    verification: {
      passed: true,
      detail: 'focused checks passed',
      commandKinds: ['test', 'typecheck'],
      baseBranch: 'main',
      baseHead: 'b'.repeat(40),
      diffHash: TEST_DIFF_HASH,
      verifiedAt: '2026-07-16T12:01:00.000Z',
      source: 'auto-merge' as const,
    },
    risk: { ok: true, detail: 'low risk' },
    scope: { ok: true, detail: 'one bounded file' },
  };
}

function legacy(id = 'prop-m430'): AutonomyEvidencePackLegacy {
  const pack = buildAutonomyEvidencePack(input(id));
  pack.generatedAt = '2026-07-16T12:02:00.000Z';
  pack.policy = {
    tier: 'T4',
    action: 'merge-main',
    allowed: true,
    reason: 'fixture verdict only',
  };
  if (pack.evidenceOutcome) {
    pack.evidenceOutcome.policyAllowed = true;
    pack.evidenceOutcome.policyAction = 'merge-main';
    pack.evidenceOutcome.policyTier = 'T4';
  }
  return pack;
}

function signed(id = 'prop-m430'): SignedAutonomyEvidencePackV3 {
  const pack = sealAutonomyEvidencePackV3(legacy(id));
  expect(pack).not.toBeNull();
  return pack!;
}

function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseKeyOrder(entry)]),
  );
}

beforeEach(() => {
  fsHarness.beforeOpen = undefined;
  fsHarness.beforeRename = undefined;
  fsHarness.afterRename = undefined;
  fsHarness.opens.length = 0;
  fsHarness.syncPaths.length = 0;
  fsHarness.rejectSyncPath = undefined;
  fsHarness.fdPaths.clear();
  privateStorageRequests.length = 0;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m430-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  _setPrivateStorageTestControlForTest(
    PRIVATE_STORAGE_TEST_CONTROL,
    process.platform === 'win32' ? { runner: semanticPrivateStorageRunner } : undefined,
  );
});

afterEach(() => {
  fsHarness.beforeOpen = undefined;
  fsHarness.beforeRename = undefined;
  fsHarness.afterRename = undefined;
  fsHarness.rejectSyncPath = undefined;
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  restoreEnvironment('HOME', originalHome);
  restoreEnvironment('USERPROFILE', originalUserProfile);
});

describe('M430 signed evidence-pack v3 protocol', () => {
  it('binds the canonical payload, HMAC signature, and self-excluding full-pack seal', () => {
    const pack = signed();
    const {
      payloadDigest,
      signatureAlgorithm,
      signingKeyId,
      signature,
      sealedPackDigest,
      ...payload
    } = pack;
    const canonicalPayload = canonicalEvidencePackJsonV3(payload);
    expect(canonicalPayload).not.toBeNull();

    const expectedPayloadDigest = createHash('sha256')
      .update('ashlr.autonomy-evidence-pack.payload.v3\n', 'utf8')
      .update(canonicalPayload!, 'utf8')
      .digest('hex');
    expect(payloadDigest).toBe(expectedPayloadDigest);

    const key = fs.readFileSync(provenanceKeyPath());
    const signingKey = createHmac('sha256', key)
      .update('ashlr.autonomy-evidence-pack.signing-key.v3\n', 'utf8')
      .digest();
    const expectedSigningKeyId = createHash('sha256')
      .update('ashlr.autonomy-evidence-pack.signing-key-id.v3\n', 'utf8')
      .update(signingKey)
      .digest('hex');
    expect(signatureAlgorithm).toBe('hmac-sha256');
    expect(signingKeyId).toBe(expectedSigningKeyId);
    const expectedSignature = createHmac('sha256', signingKey)
      .update('ashlr.autonomy-evidence-pack.signature.v3\n', 'utf8')
      .update(signatureAlgorithm, 'utf8')
      .update('\n')
      .update(signingKeyId, 'utf8')
      .update('\n')
      .update(payloadDigest, 'utf8')
      .digest('hex');
    expect(signature).toBe(expectedSignature);

    const signedPack = { ...payload, payloadDigest, signatureAlgorithm, signingKeyId, signature };
    const expectedSeal = createHash('sha256')
      .update('ashlr.autonomy-evidence-pack.seal.v3\n', 'utf8')
      .update(canonicalEvidencePackJsonV3(signedPack)!, 'utf8')
      .digest('hex');
    expect(sealedPackDigest).toBe(expectedSeal);
    expect(sealedEvidencePackDigestV3(signedPack)).toBe(sealedPackDigest);
    expect(verifyAutonomyEvidencePackV3(pack)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('verifies independently of object key insertion order', () => {
    const pack = signed();
    const reordered = reverseKeyOrder(pack);

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(pack));
    expect(verifyAutonomyEvidencePackV3(reordered).ok).toBe(true);
  });

  it('offers an explicit signed builder without changing the legacy v2 builder', () => {
    const legacyPack = buildAutonomyEvidencePack(input('prop-build-v2'));
    const signedPack = buildSignedAutonomyEvidencePackV3(input('prop-build-v3'));

    expect(legacyPack.version).toBe(2);
    expect(signedPack?.version).toBe(3);
    expect(verifyAutonomyEvidencePackV3(signedPack).ok).toBe(true);
  });

  it('persists and reads only a cryptographically valid v3 pack', () => {
    const pack = signed('prop-v3-read');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const read = readAutonomyEvidencePack(pack.proposal.id);
    expect(read).toEqual(pack);
    expect(read?.version).toBe(3);
  });

  it('persists one canonical v3 transport and durably publishes an exclusive private temporary', () => {
    const pack = signed('prop-v3-transport');
    fsHarness.opens.length = 0;
    fsHarness.syncPaths.length = 0;

    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const raw = fs.readFileSync(evidencePath(pack.proposal.id), 'utf8');
    expect(raw).toBe(`${canonicalEvidencePackJsonV3(pack)}\n`);
    const temporary = fsHarness.opens.find(({ path: openedPath }) =>
      new RegExp(`${pack.proposal.id}\\.json\\.${process.pid}\\.[a-f0-9]{32}\\.tmp$`, 'u')
        .test(openedPath));
    expect(temporary).toBeDefined();
    expect(temporary!.flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      expect(temporary!.flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
    expect(fsHarness.syncPaths).toContain(temporary!.path);
    if (process.platform !== 'win32') expect(fsHarness.syncPaths).toContain(evidenceDir());
    expect(fs.readdirSync(evidenceDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('uses exact private-storage assurance for Windows directories and files', () => {
    const pack = signed('prop-v3-windows-private');
    privateStorageRequests.length = 0;

    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    expect(readAutonomyEvidencePack(pack.proposal.id)).toEqual(pack);

    expect(privateStorageRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'directory', mode: 'secure-created' }),
      expect.objectContaining({ kind: 'directory', mode: 'inspect-existing' }),
      expect.objectContaining({ kind: 'file', mode: 'secure-created' }),
      expect.objectContaining({ kind: 'file', mode: 'inspect-existing' }),
    ]));
    expect(privateStorageRequests.some(({ mode }) => mode === 'inspect-owned')).toBe(false);
  });
});

describe('M430 v3 tamper and schema rejection', () => {
  it.each([
    ['payload', (pack: SignedAutonomyEvidencePackV3) => {
      pack.proposal.title = 'tampered title';
    }, /payload digest mismatch/i],
    ['payload digest', (pack: SignedAutonomyEvidencePackV3) => {
      pack.payloadDigest = '0'.repeat(64);
    }, /payload digest mismatch/i],
    ['signature algorithm', (pack: SignedAutonomyEvidencePackV3) => {
      (pack as { signatureAlgorithm: string }).signatureAlgorithm = 'unknown';
    }, /unsupported.*signature algorithm/i],
    ['signing key id', (pack: SignedAutonomyEvidencePackV3) => {
      pack.signingKeyId = '0'.repeat(64);
    }, /unknown.*signing key id/i],
    ['signature', (pack: SignedAutonomyEvidencePackV3) => {
      pack.signature = '0'.repeat(64);
    }, /signature mismatch/i],
    ['sealed digest', (pack: SignedAutonomyEvidencePackV3) => {
      pack.sealedPackDigest = '0'.repeat(64);
    }, /sealed pack digest mismatch/i],
  ])('rejects tampered %s bytes', (_name, mutate, reason) => {
    const pack = structuredClone(signed());
    mutate(pack);

    const verdict = verifyAutonomyEvidencePackV3(pack);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(reason);
    expect(persistAutonomyEvidencePack(pack)).toBe(false);
  });

  it('rejects unknown fields at the envelope and nested payload levels', () => {
    const envelopeUnknown = { ...signed(), unknownAuthority: true };
    const nestedUnknown = structuredClone(signed()) as SignedAutonomyEvidencePackV3 & {
      proposal: SignedAutonomyEvidencePackV3['proposal'] & { unknownAuthority?: boolean };
    };
    nestedUnknown.proposal.unknownAuthority = true;

    expect(verifyAutonomyEvidencePackV3(envelopeUnknown).reason).toMatch(/unknown/i);
    expect(verifyAutonomyEvidencePackV3(nestedUnknown).reason).toMatch(/unknown/i);
  });

  it.each([
    ['generated timestamp', (pack: AutonomyEvidencePackLegacy) => { pack.generatedAt = 'later'; }],
    ['proposal kind', (pack: AutonomyEvidencePackLegacy) => { pack.proposal.kind = 'unknown' as never; }],
    ['proposal status', (pack: AutonomyEvidencePackLegacy) => { pack.proposal.status = 'unknown' as never; }],
    ['proposal origin', (pack: AutonomyEvidencePackLegacy) => { pack.proposal.origin = 'unknown' as never; }],
    ['engine tier', (pack: AutonomyEvidencePackLegacy) => { pack.producer.engineTier = 'unknown' as never; }],
    ['target', (pack: AutonomyEvidencePackLegacy) => { pack.target = 'unknown' as never; }],
    ['trust basis', (pack: AutonomyEvidencePackLegacy) => { pack.trustBasis = 'unknown' as never; }],
    ['risk class', (pack: AutonomyEvidencePackLegacy) => { pack.riskClass = 'unknown' as never; }],
    ['diff hash', (pack: AutonomyEvidencePackLegacy) => { pack.diff.hash = 'A'.repeat(64); }],
    ['base head', (pack: AutonomyEvidencePackLegacy) => { pack.verification.baseHead = 'B'.repeat(40); }],
    ['verified timestamp', (pack: AutonomyEvidencePackLegacy) => { pack.verification.verifiedAt = 'today'; }],
    ['verification source', (pack: AutonomyEvidencePackLegacy) => { pack.verification.source = ''; }],
    ['verification hash binding', (pack: AutonomyEvidencePackLegacy) => {
      pack.verification.diffHash = '0'.repeat(64);
    }],
    ['policy tier', (pack: AutonomyEvidencePackLegacy) => { pack.policy!.tier = 'T99'; }],
    ['policy action', (pack: AutonomyEvidencePackLegacy) => { pack.policy!.action = 'ship-anyway'; }],
    ['merge command evidence', (pack: AutonomyEvidencePackLegacy) => {
      pack.verification.commandKinds = [];
    }],
    ['evidence remote binding', (pack: AutonomyEvidencePackLegacy) => {
      pack.trustBasis = 'evidence';
      pack.remotePreferred = true;
    }],
  ])('refuses semantically invalid %s before signing', (_name, mutate) => {
    const pack = legacy(`prop-semantic-${_name.replaceAll(' ', '-')}`);
    mutate(pack);
    expect(sealAutonomyEvidencePackV3(pack)).toBeNull();
  });

  it('derives the signed builder diff hash and refuses stored hash disagreement', () => {
    const valid = input('prop-builder-derived');
    const built = buildSignedAutonomyEvidencePackV3(valid);
    expect(built?.diff.hash).toBe(TEST_DIFF_HASH);

    const proposalMismatch = input('prop-builder-proposal-mismatch');
    proposalMismatch.proposal.diffHash = '0'.repeat(64);
    expect(buildSignedAutonomyEvidencePackV3(proposalMismatch)).toBeNull();

    const verificationMismatch = input('prop-builder-verification-mismatch');
    verificationMismatch.verification.diffHash = '0'.repeat(64);
    expect(buildSignedAutonomyEvidencePackV3(verificationMismatch)).toBeNull();
  });

  it('rejects duplicate object keys even when last-member parsing preserves the signed value', () => {
    const pack = signed('prop-v3-duplicate');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    const file = evidencePath(pack.proposal.id);
    const canonical = fs.readFileSync(file, 'utf8');
    const duplicate = canonical.replace(
      '"proposal":{',
      `"proposal":{"\\u0069d":"shadowed",`,
    );
    expect(JSON.parse(duplicate)).toEqual(pack);
    fs.writeFileSync(file, duplicate, { encoding: 'utf8', mode: 0o600 });

    const result = readAutonomyEvidencePacksDetailed(10);
    expect(result).toMatchObject({
      packs: [],
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
    });
  });

  it('rejects semantically equivalent but non-canonical v3 transport bytes', () => {
    const pack = signed('prop-v3-pretty');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    fs.writeFileSync(
      evidencePath(pack.proposal.id),
      `${JSON.stringify(reverseKeyOrder(pack), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    expect(verifyAutonomyEvidencePackV3(pack).ok).toBe(true);
    expect(readAutonomyEvidencePack(pack.proposal.id)).toBeNull();
    expect(readAutonomyEvidencePacksDetailed(10)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
    });
  });

  it('rejects undefined, functions, bigint, non-plain objects, and non-finite numbers', () => {
    for (const invalid of [undefined, () => true, 1n, new Date()]) {
      const pack = legacy() as AutonomyEvidencePackLegacy & { unknownValue?: unknown };
      pack.unknownValue = invalid;
      expect(sealAutonomyEvidencePackV3(pack)).toBeNull();
    }

    const nan = legacy();
    nan.diff.changedLines = Number.NaN;
    expect(sealAutonomyEvidencePackV3(nan)).toBeNull();

    const infinity = legacy();
    infinity.verification.browser = {
      ok: true,
      renderOk: true,
      consoleErrorCount: Number.POSITIVE_INFINITY,
      screenshotCaptured: true,
      detail: 'invalid finite bound',
    };
    expect(sealAutonomyEvidencePackV3(infinity)).toBeNull();
  });

  it('rejects malformed visual evidence and policy claims without a policy verdict', () => {
    const malformedVisual = legacy();
    malformedVisual.verification.browser = {
      ok: true,
      renderOk: true,
      consoleErrorCount: 0,
      screenshotCaptured: true,
      detail: 'rendered',
      visualGrounding: {
        status: 'ok',
        provider: 'locateanything-http',
        boxCount: 2,
        boxes: [{
          x1: 10,
          y1: 20,
          x2: 5,
          y2: 40,
          scale: 'normalized-1000',
          confidence: 1.1,
        }],
        image: { bytes: 10, sha256: 'A'.repeat(64) },
        detail: 'invalid visual claims',
      },
    };
    expect(sealAutonomyEvidencePackV3(malformedVisual)).toBeNull();

    const policyless = buildAutonomyEvidencePack(input('prop-policyless-outcome'));
    policyless.generatedAt = '2026-07-16T12:02:00.000Z';
    expect(policyless.policy).toBeUndefined();
    expect(policyless.evidenceOutcome).toBeDefined();
    policyless.evidenceOutcome!.policyAllowed = true;
    policyless.evidenceOutcome!.policyAction = 'merge-main';
    policyless.evidenceOutcome!.policyTier = 'T4';
    expect(sealAutonomyEvidencePackV3(policyless)).toBeNull();
  });

  it('binds branch policy tuples to remote preference', () => {
    const impossibleReadyPr = legacy('prop-impossible-ready-pr');
    impossibleReadyPr.target = 'branch';
    impossibleReadyPr.remotePreferred = false;
    impossibleReadyPr.policy = {
      tier: 'T3',
      action: 'open-ready-pr',
      allowed: true,
      reason: 'contradicts remote preference',
    };
    impossibleReadyPr.evidenceOutcome!.target = 'branch';
    impossibleReadyPr.evidenceOutcome!.policyTier = 'T3';
    impossibleReadyPr.evidenceOutcome!.policyAction = 'open-ready-pr';
    expect(sealAutonomyEvidencePackV3(impossibleReadyPr)).toBeNull();
  });

  it('seals active approved proposals for the merge authority path', () => {
    const approved = legacy('prop-approved-v3');
    approved.proposal.status = 'approved';

    expect(sealAutonomyEvidencePackV3(approved)).not.toBeNull();
  });

  it('rejects oversized fields, containers, and total canonical bytes', () => {
    const oversizedField = legacy();
    oversizedField.proposal.title = 'x'.repeat(128 * 1024 + 1);
    expect(sealAutonomyEvidencePackV3(oversizedField)).toBeNull();

    const oversizedContainer = legacy();
    oversizedContainer.diff.files = Array.from({ length: 4_097 }, (_, index) => `f-${index}`);
    expect(sealAutonomyEvidencePackV3(oversizedContainer)).toBeNull();

    const oversizedPack = legacy();
    const chunk = 'z'.repeat(120 * 1024);
    oversizedPack.proposal.title = chunk;
    oversizedPack.proposal.createdAt = chunk;
    oversizedPack.producer.engineModel = chunk;
    oversizedPack.producer.engineTier = chunk as never;
    oversizedPack.gates.authority.detail = chunk;
    oversizedPack.gates.provenance.detail = chunk;
    oversizedPack.gates.verification.detail = chunk;
    oversizedPack.gates.risk.detail = chunk;
    oversizedPack.gates.scope.detail = chunk;
    oversizedPack.verification.detail = chunk;
    expect(sealAutonomyEvidencePackV3(oversizedPack)).toBeNull();
  });
});

describe('M430 key and legacy behavior', () => {
  it('refuses a relative home instead of placing evidence in the worktree', () => {
    const pack = signed('prop-relative-home');
    process.env.HOME = '.';
    process.env.USERPROFILE = '.';

    expect(evidenceDir).toThrow(/absolute home directory/i);
    expect(persistAutonomyEvidencePack(pack)).toBe(false);
  });

  it('does not create a missing key or storage tree during verification', () => {
    const pack = signed();
    fs.rmSync(path.join(tmpHome, '.ashlr'), { recursive: true, force: true });

    const verdict = verifyAutonomyEvidencePackV3(pack);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/missing.*key/i);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects an unsafe protected provenance key', () => {
    const pack = signed();
    fs.chmodSync(provenanceKeyPath(), 0o644);

    const verdict = verifyAutonomyEvidencePackV3(pack);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unsafe permissions|verify error/i);
  });

  it('keeps v1 and v2 readable but never treats them as signed v3 evidence', () => {
    const v1 = legacy('prop-legacy-v1');
    v1.version = 1;
    const v2 = legacy('prop-legacy-v2');

    expect(persistAutonomyEvidencePack(v1)).toBe(true);
    expect(persistAutonomyEvidencePack(v2)).toBe(true);
    expect(readAutonomyEvidencePack(v1.proposal.id)?.version).toBe(1);
    expect(readAutonomyEvidencePack(v2.proposal.id)?.version).toBe(2);
    expect(listAutonomyEvidencePacks(10).map((pack) => pack.version).sort()).toEqual([1, 2]);
    expect(verifyAutonomyEvidencePackV3(v1)).toMatchObject({ ok: false });
    expect(verifyAutonomyEvidencePackV3(v2)).toMatchObject({ ok: false });
    expect(verifyAutonomyEvidencePackV3(v1).reason).toMatch(/observational/i);
    expect(fs.existsSync(evidencePath(v1.proposal.id))).toBe(true);
  });
});

describe('M430 evidence filesystem races', () => {
  it('does not leave an authorizable pack after post-rename durability failure', () => {
    const pack = signed('prop-v3-post-rename-fsync');
    fsHarness.rejectSyncPath = evidenceDir();

    expect(persistAutonomyEvidencePack(pack)).toBe(false);
    expect(fs.existsSync(evidencePath(pack.proposal.id))).toBe(false);
    expect(readAutonomyEvidencePack(pack.proposal.id)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('detects a transient .ashlr rebind restored with the published inode', () => {
    const pack = signed('prop-v3-transient-ancestor-race');
    const ashlr = path.dirname(evidenceDir());
    const moved = `${ashlr}.original`;
    const replacement = `${ashlr}.replacement`;
    fs.mkdirSync(path.join(replacement, 'evidence'), { recursive: true, mode: 0o700 });
    let raced = false;

    fsHarness.beforeRename = (oldPath, newPath, actual) => {
      if (raced || newPath !== evidencePath(pack.proposal.id) || !oldPath.endsWith('.tmp')) return;
      raced = true;
      actual.renameSync(ashlr, moved);
      actual.renameSync(replacement, ashlr);
      actual.renameSync(
        path.join(moved, 'evidence', path.basename(oldPath)),
        oldPath,
      );
    };
    fsHarness.afterRename = (_oldPath, newPath, actual) => {
      if (!raced || newPath !== evidencePath(pack.proposal.id)) return;
      fsHarness.beforeRename = undefined;
      fsHarness.afterRename = undefined;
      actual.renameSync(
        newPath,
        path.join(moved, 'evidence', path.basename(newPath)),
      );
      actual.renameSync(ashlr, replacement);
      actual.renameSync(moved, ashlr);
    };

    expect(persistAutonomyEvidencePack(pack)).toBe(false);
    expect(raced).toBe(true);
    expect(fs.existsSync(evidencePath(pack.proposal.id))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails persistence when the held evidence directory is rebound before publication', () => {
    const pack = signed('prop-v3-write-race');
    const moved = `${evidenceDir()}.original`;
    let raced = false;
    fsHarness.beforeRename = (oldPath, newPath, actual) => {
      if (raced || newPath !== evidencePath(pack.proposal.id) || !oldPath.endsWith('.tmp')) return;
      raced = true;
      fsHarness.beforeRename = undefined;
      actual.renameSync(evidenceDir(), moved);
      actual.mkdirSync(evidenceDir(), { mode: 0o700 });
    };

    expect(persistAutonomyEvidencePack(pack)).toBe(false);
    expect(raced).toBe(true);
    expect(fs.existsSync(evidencePath(pack.proposal.id))).toBe(false);
    expect(fs.readdirSync(moved).some((name) => name.endsWith('.tmp'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a file opened through a rebound evidence directory', () => {
    const pack = signed('prop-v3-read-race');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    const moved = `${evidenceDir()}.original`;
    let raced = false;
    fsHarness.beforeOpen = (openedPath, _flags, actual) => {
      if (raced || openedPath !== evidencePath(pack.proposal.id)) return;
      raced = true;
      fsHarness.beforeOpen = undefined;
      actual.renameSync(evidenceDir(), moved);
      actual.mkdirSync(evidenceDir(), { mode: 0o700 });
      actual.copyFileSync(path.join(moved, `${pack.proposal.id}.json`), openedPath);
      actual.chmodSync(openedPath, 0o600);
    };

    const result = readAutonomyEvidencePacksDetailed(10);
    expect(raced).toBe(true);
    expect(result).toMatchObject({
      packs: [],
      sourceState: 'degraded',
      complete: false,
    });
  });

  it('rejects a same-size file replacement between inspection and open', () => {
    const pack = signed('prop-v3-file-race');
    expect(persistAutonomyEvidencePack(pack)).toBe(true);
    const file = evidencePath(pack.proposal.id);
    const replacement = path.join(tmpHome, 'replacement-evidence.json');
    fs.copyFileSync(file, replacement);
    fs.chmodSync(replacement, 0o600);
    let raced = false;
    fsHarness.beforeOpen = (openedPath, _flags, actual) => {
      if (raced || openedPath !== file) return;
      raced = true;
      fsHarness.beforeOpen = undefined;
      actual.renameSync(file, path.join(tmpHome, 'original-evidence.json'));
      actual.renameSync(replacement, file);
    };

    const result = readAutonomyEvidencePacksDetailed(10);
    expect(raced).toBe(true);
    expect(result).toMatchObject({
      packs: [],
      sourceState: 'degraded',
      complete: false,
    });
  });
});
