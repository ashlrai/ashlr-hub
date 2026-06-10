/**
 * policy.ts — Enrollment registry + kill switch (the gate).
 *
 * SAFETY RULES:
 *  - Enrollment registry persisted at ~/.ashlr/enrollment.json, DEFAULT EMPTY.
 *  - Kill switch backed by the presence of ~/.ashlr/KILL file.
 *  - assertMayMutate ALWAYS throws when the kill switch is on, regardless of
 *    enrollment or allowAnyRepo. allowAnyRepo ONLY bypasses the enrollment
 *    check (for tests operating on tmp repos) — it NEVER bypasses the kill switch.
 *  - enroll/unenroll normalize repo paths to absolute via path.resolve().
 *  - All functions are idempotent; never throw except the intentional assert.
 *  - No new runtime deps; node builtins only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Enrollment } from '../types.js';

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  return join(homedir(), '.ashlr');
}

/** Path to the enrollment registry file. */
export function enrollmentPath(): string {
  return join(ashlrDir(), 'enrollment.json');
}

/** Path to the kill-switch sentinel file. */
export function killSwitchPath(): string {
  return join(ashlrDir(), 'KILL');
}

// ---------------------------------------------------------------------------
// Internal I/O helpers
// ---------------------------------------------------------------------------

/** Read the enrollment registry. Returns { repos: [] } when absent/malformed. */
function readRegistry(): Enrollment {
  const p = enrollmentPath();
  if (!existsSync(p)) return { repos: [] };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>)['repos'])
    ) {
      const repos = ((parsed as Record<string, unknown>)['repos'] as unknown[])
        .filter((r): r is string => typeof r === 'string');
      return { repos };
    }
  } catch {
    // malformed — treat as empty
  }
  return { repos: [] };
}

/** Persist the enrollment registry, creating ~/.ashlr if needed. */
function writeRegistry(reg: Enrollment): void {
  const dir = ashlrDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(enrollmentPath(), JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Returns true when the global kill switch is active.
 * Backed by the presence of ~/.ashlr/KILL.
 */
export function killSwitchOn(): boolean {
  return existsSync(killSwitchPath());
}

/**
 * Turn the kill switch on (creates ~/.ashlr/KILL) or off (removes it).
 * Idempotent in both directions.
 */
export function setKill(on: boolean): void {
  const kp = killSwitchPath();
  const dir = ashlrDir();
  if (on) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(kp)) {
      writeFileSync(kp, 'kill switch active\n', 'utf8');
    }
  } else {
    if (existsSync(kp)) {
      unlinkSync(kp);
    }
  }
}

// ---------------------------------------------------------------------------
// Enrollment registry
// ---------------------------------------------------------------------------

/**
 * Returns true when `repo` (normalized to absolute path) is enrolled
 * for autonomous work.
 */
export function isEnrolled(repo: string): boolean {
  const abs = resolve(repo);
  const reg = readRegistry();
  return reg.repos.includes(abs);
}

/**
 * Enroll `repo` for autonomous/sandbox mutation. Idempotent — enrolling
 * an already-enrolled repo is a no-op. Normalizes to absolute path.
 */
export function enroll(repo: string): void {
  const abs = resolve(repo);
  const reg = readRegistry();
  if (!reg.repos.includes(abs)) {
    reg.repos.push(abs);
    writeRegistry(reg);
  }
}

/**
 * Remove `repo` from the enrollment registry. Idempotent — unenrolling
 * an absent repo is a no-op. Normalizes to absolute path.
 */
export function unenroll(repo: string): void {
  const abs = resolve(repo);
  const reg = readRegistry();
  const filtered = reg.repos.filter(r => r !== abs);
  if (filtered.length !== reg.repos.length) {
    writeRegistry({ repos: filtered });
  }
}

/**
 * Return all enrolled repos (absolute paths). Returns [] when nothing is
 * enrolled (the default state — DEFAULT EMPTY).
 */
export function listEnrolled(): string[] {
  return readRegistry().repos;
}

// ---------------------------------------------------------------------------
// assertMayMutate — the gate every sandbox-mutating op calls first
// ---------------------------------------------------------------------------

/**
 * Assert that autonomous/sandbox mutation of `repo` is permitted.
 *
 * Throws when:
 *  1. The kill switch is on (ALWAYS, regardless of enrollment or opts).
 *  2. `repo` is not enrolled AND `opts.allowAnyRepo` is not true.
 *
 * `opts.allowAnyRepo` is a TEST SEAM only — it bypasses enrollment so tests
 * can operate on tmp repos without enrolling them. It NEVER bypasses the kill
 * switch.
 */
export function assertMayMutate(
  repo: string,
  opts?: { allowAnyRepo?: boolean },
): void {
  // Kill switch check — always enforced, no exceptions.
  if (killSwitchOn()) {
    throw new Error('autonomy kill switch is ON');
  }

  // Enrollment check — bypassed only by the explicit test hatch.
  if (!opts?.allowAnyRepo && !isEnrolled(repo)) {
    throw new Error(`repo not enrolled for autonomous work: ${resolve(repo)}`);
  }
}
