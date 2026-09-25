/**
 * Isolated launch checkouts (unit C1): `<cloudHome>/checkouts/<owner>__<name>`,
 * a shallow single-branch clone of https://github.com/<owner>/<name>.git
 * using the operator's normal git credentials. Before each launch:
 * `git fetch --depth 1 origin <branch>` then `git checkout -B <branch>
 * FETCH_HEAD` with upstream set, so the CLI sees a pushed branch. Never
 * touches the operator's own clones or fleet mirrors. Serialise per path.
 */
import { notImplemented } from './_stub.js';

export type CloudCheckoutResult =
  | { ok: true; path: string }
  | { ok: false; failure: 'no-remote' | 'checkout-failed'; message: string };

export interface CloudCheckoutDeps {
  git?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  originUrlFor?: (repo: string) => string;
}

export function ensureCloudCheckout(_repo: string, _branch: string, _deps?: CloudCheckoutDeps): Promise<CloudCheckoutResult> { return notImplemented('ensureCloudCheckout'); }
