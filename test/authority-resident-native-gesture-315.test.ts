/**
 * 3.15 — the desktop app's native gesture stands in for the TTY in
 * `ashlr authority resident start` (src/core/authority/resident.ts
 * `consumeNativeGesture`), and for nothing else.
 *
 * The token is a file the desktop app writes only after Mason clicks its
 * native confirm dialog (desktop/src-tauri/src/fleet_ops.rs). It must be a
 * private regular file owned by this user, fresh, for `resident-start`, and it
 * is consumed (deleted) on first read. The agent markers and the login-HOME
 * check still refuse. A temporary directory stands in for the home.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NATIVE_GESTURE_DIR_RELATIVE,
  NATIVE_GESTURE_ENV,
  NATIVE_GESTURE_TTL_MS,
  consumeNativeGesture,
  operatorContextRefusal,
} from '../src/core/authority/resident.js';

let home: string;
const NAME = '0123456789abcdef0123456789abcdef';

function write(body: unknown, opts: { mode?: number; name?: string } = {}): string {
  const dir = join(home, NATIVE_GESTURE_DIR_RELATIVE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${opts.name ?? NAME}.json`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode: opts.mode ?? 0o600 });
  chmodSync(path, opts.mode ?? 0o600);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'native-gesture-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('consumeNativeGesture', () => {
  const env = { [NATIVE_GESTURE_ENV]: NAME };

  it('accepts a fresh, private token for resident-start exactly once', () => {
    const now = Date.now();
    const path = write({ v: 1, op: 'resident-start', createdAt: now });
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false });
  });

  it('is absent without the variable and refuses a malformed name', () => {
    expect(consumeNativeGesture({}, home, 'resident-start')).toEqual({ ok: false, reason: 'absent' });
    expect(consumeNativeGesture({ [NATIVE_GESTURE_ENV]: '../../etc/passwd' }, home, 'resident-start')).toMatchObject({ ok: false, reason: 'the gesture token is malformed' });
  });

  it('refuses an old token, a future one, another op, and one others can read — and deletes each', () => {
    const now = Date.now();
    let path = write({ v: 1, op: 'resident-start', createdAt: now - NATIVE_GESTURE_TTL_MS - 1_000 });
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(existsSync(path)).toBe(false);

    path = write({ v: 1, op: 'resident-start', createdAt: now + 60_000 });
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false });

    path = write({ v: 1, op: 'custody-install', createdAt: now });
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/not for resident-start/) });

    path = write({ v: 1, op: 'resident-start', createdAt: now }, { mode: 0o644 });
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/readable by others/) });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a stale file even when its body claims to be fresh', () => {
    const now = Date.now();
    const path = write({ v: 1, op: 'resident-start', createdAt: now });
    const old = (now - NATIVE_GESTURE_TTL_MS - 5_000) / 1000;
    utimesSync(path, old, old);
    expect(consumeNativeGesture(env, home, 'resident-start', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('refuses a symlink', () => {
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ v: 1, op: 'resident-start', createdAt: Date.now() }), { mode: 0o600 });
    const dir = join(home, NATIVE_GESTURE_DIR_RELATIVE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(dir, `${NAME}.json`));
    expect(consumeNativeGesture(env, home, 'resident-start')).toMatchObject({ ok: false, reason: 'the gesture token is not a regular file' });
    expect(existsSync(target)).toBe(true);
  });
});

describe('operatorContextRefusal with a native gesture', () => {
  const ctx = (env: Record<string, string>, nativeGesture: boolean) => ({ stdinTTY: false, stdoutTTY: false, env: { HOME: '/Users/mason', ...env }, passwdHome: '/Users/mason', nativeGesture });

  it('stands in for the TTY only', () => {
    expect(operatorContextRefusal(ctx({}, false))).toMatch(/not an interactive terminal/);
    expect(operatorContextRefusal(ctx({}, true))).toBeNull();
    // An agent harness marker still refuses, gesture or not.
    expect(operatorContextRefusal(ctx({ CLAUDECODE: '1' }, true))).toMatch(/^CLAUDECODE is set/);
    // So does a redirected HOME.
    expect(operatorContextRefusal(ctx({ HOME: '/private/var/folders/x/home' }, true))).toMatch(/HOME is not your login home/);
  });
});
