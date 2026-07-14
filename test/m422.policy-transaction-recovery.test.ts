import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
const children = new Set<ChildProcess>();
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function registryBytes(repos: string[]): Buffer {
  return Buffer.from(`${JSON.stringify({ repos }, null, 2)}\n`, 'utf8');
}

function markerAuthentication(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update('ashlr:enrollment-transaction:v2\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function writeMarker(pid: number, before: Buffer | null, after: Buffer): { temp: string; backup: string; marker: string } {
  const nonce = randomBytes(16).toString('hex');
  const tempName = `.enrollment.${nonce}.tmp`;
  const backupName = `.enrollment.${nonce}.backup`;
  const payload = {
    version: 2,
    state: 'prepared',
    pid,
    startRef: '0'.repeat(64),
    startRefVerified: false,
    startRefSource: null,
    nonce,
    beforeDigest: before === null ? null : digest(before),
    afterDigest: digest(after),
    tempName,
    backupName,
  };
  const root = join(home, '.ashlr');
  const marker = join(root, 'enrollment.transaction');
  writeFileSync(marker, `${JSON.stringify({ ...payload, authentication: markerAuthentication(payload) })}\n`, { mode: 0o600 });
  return { temp: join(root, tempName), backup: join(root, backupName), marker };
}

function writeLegacyPartialInitialMarker(markerBytes: Buffer, after: Buffer): { temp: string; marker: string } {
  const nonce = randomBytes(16).toString('hex');
  const root = join(home, '.ashlr');
  const temp = join(root, `.enrollment.${nonce}.tmp`);
  const marker = join(root, 'enrollment.transaction');
  writeFileSync(temp, after, { mode: 0o600 });
  writeFileSync(marker, markerBytes, { mode: 0o600 });
  return { temp, marker };
}

function startOwner(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function deadOwnerPid(): Promise<number> {
  const child = await startOwner();
  const pid = child.pid!;
  child.kill('SIGKILL');
  await waitForExit(child);
  return pid;
}

function runPolicy(repo: string | null): { result?: unknown; repos: string[] } {
  const source = repo === null
    ? `import { listEnrolled } from ${JSON.stringify(policyModuleUrl)}; process.stdout.write(JSON.stringify({ repos: listEnrolled() }));`
    : `import { enroll, listEnrolled } from ${JSON.stringify(policyModuleUrl)}; const result = enroll(${JSON.stringify(repo)}, { waitMs: 1000 }); process.stdout.write(JSON.stringify({ result, repos: listEnrolled() }));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr') },
    encoding: 'utf8',
    timeout: 8_000,
  });
  if (child.error) throw child.error;
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as { result?: unknown; repos: string[] };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  home = join(tmpdir(), `ashlr-m422-${process.pid}-${randomUUID()}`);
  mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(async () => {
  const running = [...children];
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(running.map(waitForExit));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M422 policy transaction recovery', { timeout: 15_000 }, () => {
  it.each([
    ['zero-byte', Buffer.alloc(0)],
    ['truncated', Buffer.from('{"version":2,"state":"prepared"', 'utf8')],
  ])('recovers a %s initial marker only from a proven pre-effect state', (_label, markerBytes) => {
    const requested = join(home, 'requested-after-partial-marker');
    const abandoned = registryBytes([join(home, 'abandoned')]);
    const paths = writeLegacyPartialInitialMarker(markerBytes, abandoned);

    expect(runPolicy(requested)).toMatchObject({ result: { ok: true, reason: 'enrolled' } });
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8'))).toEqual({
      repos: [requested],
    });
    expect(existsSync(paths.marker)).toBe(false);
    expect(existsSync(paths.temp)).toBe(false);
  });

  it('keeps a partial marker fail-closed when the registry pathname already exists', () => {
    const original = registryBytes([join(home, 'original')]);
    const registry = join(home, '.ashlr', 'enrollment.json');
    writeFileSync(registry, original, { mode: 0o600 });
    const paths = writeLegacyPartialInitialMarker(
      Buffer.from('{"version":2', 'utf8'),
      registryBytes([join(home, 'abandoned')]),
    );

    expect(runPolicy(join(home, 'must-not-enroll'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-tampered' },
      repos: [],
    });
    expect(readFileSync(registry).equals(original)).toBe(true);
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.temp)).toBe(true);
  });

  it('keeps newline-complete malformed and authentication-tampered markers fail-closed', async () => {
    const after = registryBytes([join(home, 'abandoned')]);
    const malformed = writeLegacyPartialInitialMarker(Buffer.from('{"version":2}\n', 'utf8'), after);
    expect(runPolicy(join(home, 'malformed-request'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-tampered' },
      repos: [],
    });
    expect(existsSync(malformed.marker)).toBe(true);
    rmSync(malformed.marker);
    rmSync(malformed.temp);

    const completeWithoutTerminator = writeLegacyPartialInitialMarker(
      Buffer.from('{"version":2}', 'utf8'),
      after,
    );
    expect(runPolicy(join(home, 'unterminated-complete-request'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-tampered' },
      repos: [],
    });
    expect(existsSync(completeWithoutTerminator.marker)).toBe(true);
    rmSync(completeWithoutTerminator.marker);
    rmSync(completeWithoutTerminator.temp);

    const tampered = writeMarker(await deadOwnerPid(), null, after);
    writeFileSync(tampered.temp, after, { mode: 0o600 });
    const marker = JSON.parse(readFileSync(tampered.marker, 'utf8')) as Record<string, unknown>;
    marker['authentication'] = 'f'.repeat(64);
    writeFileSync(tampered.marker, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    expect(runPolicy(join(home, 'tampered-request'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-tampered' },
      repos: [],
    });
    expect(existsSync(tampered.marker)).toBe(true);
    expect(existsSync(tampered.temp)).toBe(true);
  });

  it('keeps reads inert, then rolls back a prepared transaction from a dead owner', async () => {
    const original = join(home, 'original');
    const requested = join(home, 'requested');
    const before = registryBytes([original]);
    const after = registryBytes([original, join(home, 'crashed')]);
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), before, { mode: 0o600 });
    const paths = writeMarker(await deadOwnerPid(), before, after);
    writeFileSync(paths.temp, after, { mode: 0o600 });

    expect(runPolicy(null)).toEqual({ repos: [] });
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.temp)).toBe(true);

    expect(runPolicy(requested)).toMatchObject({ result: { ok: true, reason: 'enrolled' } });
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8'))).toEqual({
      repos: [original, requested],
    });
    expect(existsSync(paths.marker)).toBe(false);
    expect(existsSync(paths.temp)).toBe(false);
  });

  it('resumes rollback after the prepared temp was removed before marker clear', async () => {
    const original = join(home, 'original');
    const requested = join(home, 'requested-after-cleanup-crash');
    const before = registryBytes([original]);
    const after = registryBytes([original, join(home, 'crashed')]);
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), before, { mode: 0o600 });
    const paths = writeMarker(await deadOwnerPid(), before, after);

    expect(existsSync(paths.temp)).toBe(false);
    expect(runPolicy(requested)).toMatchObject({ result: { ok: true, reason: 'enrolled' } });
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8'))).toEqual({
      repos: [original, requested],
    });
    expect(existsSync(paths.marker)).toBe(false);
  });

  it('resumes rollback to original absence after temp cleanup crashes', async () => {
    const requested = join(home, 'requested-after-absent-cleanup-crash');
    const after = registryBytes([join(home, 'crashed')]);
    const paths = writeMarker(await deadOwnerPid(), null, after);

    expect(existsSync(join(home, '.ashlr', 'enrollment.json'))).toBe(false);
    expect(existsSync(paths.temp)).toBe(false);
    expect(runPolicy(requested)).toMatchObject({ result: { ok: true, reason: 'enrolled' } });
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8'))).toEqual({
      repos: [requested],
    });
    expect(existsSync(paths.marker)).toBe(false);
  });

  it('commits an installed transaction from a dead owner before the next mutation', async () => {
    const original = join(home, 'original');
    const crashed = join(home, 'crashed');
    const requested = join(home, 'requested');
    const before = registryBytes([original]);
    const after = registryBytes([original, crashed]);
    const paths = writeMarker(await deadOwnerPid(), before, after);
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), after, { mode: 0o600 });
    writeFileSync(paths.backup, before, { mode: 0o600 });

    expect(runPolicy(requested)).toMatchObject({ result: { ok: true, reason: 'enrolled' } });
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8'))).toEqual({
      repos: [original, crashed, requested],
    });
    expect(existsSync(paths.marker)).toBe(false);
    expect(existsSync(paths.backup)).toBe(false);
  });

  it('refuses live-owner and tampered transactions without changing their artifacts', async () => {
    const original = join(home, 'original');
    const before = registryBytes([original]);
    const after = registryBytes([original, join(home, 'crashed')]);
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), before, { mode: 0o600 });

    const owner = await startOwner();
    const live = writeMarker(owner.pid!, before, after);
    writeFileSync(live.temp, after, { mode: 0o600 });
    expect(runPolicy(join(home, 'live-request'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-owner-alive' },
      repos: [],
    });
    expect(existsSync(live.marker)).toBe(true);
    owner.kill('SIGKILL');
    await waitForExit(owner);

    writeFileSync(live.temp, registryBytes([join(home, 'tampered')]), { mode: 0o600 });
    expect(runPolicy(join(home, 'tamper-request'))).toMatchObject({
      result: { ok: false, reason: 'registry-transaction-tampered' },
      repos: [],
    });
    expect(existsSync(live.marker)).toBe(true);
    expect(readFileSync(join(home, '.ashlr', 'enrollment.json')).equals(before)).toBe(true);
  });
});
