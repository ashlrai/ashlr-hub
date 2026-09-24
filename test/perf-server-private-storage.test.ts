/**
 * 3.10 server performance (unit A3) — Darwin ACL verdict cache.
 *
 * A SAFE `/bin/ls -lde` verdict is reused while every path in the chain keeps
 * its (dev, ino, mode, uid, gid, ctime). Any ACL edit bumps ctime, so it must
 * be re-inspected — and a refusal must never be cached. Uses the real /bin/ls
 * on macOS against a private tmp tree; skipped elsewhere (the cache is
 * Darwin-only by design).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setPrivateStorageTestControlForTest,
  assurePrivateStoragePath,
  clearPrivateStorageVerdictCache,
  PRIVATE_STORAGE_TEST_CONTROL,
} from '../src/core/util/private-storage.js';

const darwin = process.platform === 'darwin';
let anchor: string;
let file: string;
let invocations = 0;

function install(enableVerdictCache: boolean): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
    enableVerdictCache,
    observeInvocation: () => { invocations += 1; },
  });
}

function check() {
  return assurePrivateStoragePath(file, 'file', 'inspect-owned', { anchorPath: anchor });
}

beforeEach(() => {
  invocations = 0;
  clearPrivateStorageVerdictCache();
  anchor = mkdtempSync(join(tmpdir(), 'ashlr-a3-acl-'));
  chmodSync(anchor, 0o700);
  mkdirSync(join(anchor, 'priv'), { mode: 0o700 });
  file = join(anchor, 'priv', 'state.json');
  writeFileSync(file, '{}', { mode: 0o600 });
});

afterEach(() => {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  if (darwin) spawnSync('/bin/chmod', ['-RN', anchor], { shell: false, timeout: 5_000 });
  rmSync(anchor, { recursive: true, force: true });
});

describe.skipIf(!darwin)('Darwin ACL verdict cache', () => {
  it('reuses a safe verdict while the chain is unchanged', () => {
    install(true);
    expect(check()).toEqual({ ok: true, reason: 'darwin-acl-safe' });
    expect(check()).toEqual({ ok: true, reason: 'darwin-acl-safe' });
    expect(check()).toEqual({ ok: true, reason: 'darwin-acl-safe' });
    expect(invocations).toBe(1);
  });

  it('re-inspects after an ACL grant anywhere in the chain, and refuses it', () => {
    install(true);
    expect(check().ok).toBe(true);
    const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow write,add_file', join(anchor, 'priv')], {
      shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(grant.status).toBe(0);
    expect(check()).toEqual({ ok: false, reason: 'darwin-untrusted-allow' });
    expect(invocations).toBe(2);
    // A refusal is never cached: every check runs the adapter again.
    expect(check().ok).toBe(false);
    expect(invocations).toBe(3);
    spawnSync('/bin/chmod', ['-N', join(anchor, 'priv')], { shell: false, timeout: 5_000 });
    expect(check().ok).toBe(true);
  });

  it('re-inspects when the file is replaced (new inode)', () => {
    install(true);
    expect(check().ok).toBe(true);
    rmSync(file);
    writeFileSync(file, '{}', { mode: 0o600 });
    expect(check().ok).toBe(true);
    expect(invocations).toBe(2);
  });

  it('re-inspects after a mode change', () => {
    install(true);
    expect(check().ok).toBe(true);
    chmodSync(file, 0o644);
    check();
    expect(invocations).toBe(2);
  });

  it('is off by default under test control so adapter scripting still sees every call', () => {
    install(false);
    check();
    check();
    expect(invocations).toBe(2);
  });

  it('never answers a caller-supplied runner from the cache', () => {
    install(true);
    expect(check().ok).toBe(true);
    let runnerCalls = 0;
    const result = assurePrivateStoragePath(file, 'file', 'inspect-owned', {
      anchorPath: anchor,
      runner: () => { runnerCalls += 1; return { status: 1, stdout: '' }; },
    });
    expect(runnerCalls).toBe(1);
    expect(result).toEqual({ ok: false, reason: 'adapter-failed' });
  });
});
