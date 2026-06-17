/**
 * integrations/stack.ts — M69: detect + read the ecosystem `stack` tool
 * (service control plane: OAuth → provider → secrets, Phantom-wired).
 *
 * READ-ONLY / ADVISORY by design: the hub DETECTS stack and reports status so an
 * agent or the operator knows what services are wired — it never auto-provisions
 * (`stack apply` stays a deliberate, user-initiated action). Never throws.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STACK_BIN = 'stack';
const TIMEOUT_MS = 5_000;

/** Whether the `stack` CLI is on PATH. Never throws. */
export function stackInstalled(): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [STACK_BIN], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Whether a repo has a committed stack config (.stack.toml). Never throws. */
export function stackProjectConfigured(repo: string): boolean {
  try {
    return existsSync(join(repo, '.stack.toml'));
  } catch {
    return false;
  }
}

export interface StackStatus {
  ok: boolean;
  /** Service names stack reports as wired (best-effort parse). */
  services?: string[];
  detail: string;
}

/**
 * Read `stack status --json` for a repo (best-effort). ok:false (never throws)
 * when stack is absent, errors, or times out. Tolerates an unparsable payload
 * (returns ok:true with an empty service list).
 */
export function stackStatus(repo?: string): StackStatus {
  if (!stackInstalled()) return { ok: false, detail: 'stack not installed' };
  try {
    const res = spawnSync(STACK_BIN, ['status', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    if (res.status !== 0 || res.error) {
      return { ok: false, detail: `stack status exit ${res.status ?? 'error'}` };
    }
    const out = (res.stdout ?? '').trim();
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const raw = parsed['services'];
      const services = Array.isArray(raw)
        ? raw
            .map((s) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.['name'] as string | undefined)))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      return { ok: true, services, detail: `${services.length} service(s)` };
    } catch {
      return { ok: true, services: [], detail: 'stack reachable (status not JSON-parseable)' };
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
