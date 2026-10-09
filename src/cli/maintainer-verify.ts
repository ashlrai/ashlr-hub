/** Explicit maintainer intake; compatible `ashlr` command identity is retained. */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { evaluateStandingAuthority } from '../core/authority/effective-config.js';
import { defaultHostMergeDeps } from '../core/fleet/host-merge.js';
import { ensureMirror, mirrorLeaseKey, mirrorPathFor } from '../core/fleet/mirrors.js';
import { prepareMaintainerRun, runMaintainerPr } from '../core/fleet/maintainer-pr-runner.js';
import {
  maintainerEvidenceDigest, verifyMaintainerPr,
  type MaintainerVerificationDeps, type MaintainerVerificationReceipt,
} from '../core/fleet/maintainer-pr-verification.js';
import { registerExecutionLease, withRepoLease, type ExecutionLease } from '../core/sandbox/execution-leases.js';
import { acquireOutwardMutationFenceAsync, ownsOutwardMutationFence, releaseOutwardMutationFence, type OutwardMutationFence } from '../core/sandbox/mutation-fence.js';
import { githubRemoteUrl, runSafeGit } from '../core/sandbox/safe-git.js';
import { assurePrivateStoragePath } from '../core/util/private-storage.js';
import { writePrivateFileAtomically } from '../core/util/private-file-write.js';
import { scrubSecrets } from '../core/util/scrub.js';

export const MAINTAINER_VERIFY_USAGE = 'ashlr verify-pr <owner/repo> <PR> --confirm-head <40-character SHA> [--json]';

function saveReceipt(receipt: MaintainerVerificationReceipt): void {
  const home = realpathSync(homedir());
  let anchor = home;
  for (const component of ['.ashlr', 'authority', 'maintainer-verification']) {
    const path = join(anchor, component);
    let created = false;
    try { mkdirSync(path, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) throw new Error('unsafe maintainer receipt directory');
    const proof = assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-owned', { anchorPath: anchor });
    const after = lstatSync(path, { bigint: true });
    if (!proof.ok || before.dev !== after.dev || before.ino !== after.ino) throw new Error('maintainer receipt directory is not private/stable');
    anchor = path;
  }
  const bytes = JSON.stringify(receipt) + '\n';
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('maintainer receipt exceeds the private record limit');
  writePrivateFileAtomically(join(anchor, `.receipt-${randomBytes(16).toString('hex')}.tmp`), join(anchor, `${receipt.receiptSha256}.json`), bytes,
    { anchorPath: home, label: 'maintainer verification receipt' });
}

/** Dependencies are host-owned code, never a CLI JSON/script/receipt argument. */
export function defaultMaintainerVerificationDeps(signal?: AbortSignal): MaintainerVerificationDeps {
  const host = defaultHostMergeDeps();
  // This explicit publication path must observe revocations and superseding
  // grants from other processes, rather than inheriting the 10s display cache.
  let surfaceQualified = false;
  host.policy = () => {
    // Re-read ledger prefix, signed grant, config and every lowering signal on each probe.
    // After one actual full hash, surface.ts reuses a file hash only while its inode/size/mtime/ctime match.
    const evaluated = evaluateStandingAuthority({ mode: 'fresh', surface: 'running', nowMs: host.nowMs(),
      ...(surfaceQualified ? { surfaceHashes: 'unchanged' as const } : {}) });
    surfaceQualified = evaluated.surface?.ok === true;
    return evaluated.policy;
  };
  let activeFence: OutwardMutationFence | null = null;
  return {
    ...host,
    authenticatedActor: async () => {
      // Pin the account read to github.com, matching the App's repository
      // transport; GH_HOST must not select an unrelated enterprise account.
      const stdout = await new Promise<string>((done, fail) => {
        execFile('gh', ['api', '--hostname', 'github.com', 'user'], {
          encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
          env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        }, (error, output) => error ? fail(new Error('GitHub CLI account authentication is unavailable')) : done(output));
      });
      const actor = JSON.parse(stdout) as { login?: unknown };
      if (typeof actor.login !== 'string') throw new Error('GitHub returned no authenticated account');
      return actor.login;
    },
    run: async (pins) => {
      const initialPolicy = host.policy();
      if (!initialPolicy || !initialPolicy.repos.some((entry) => entry.nameWithOwner.toLowerCase() === pins.repo.toLowerCase())) throw new Error('signed maintainer repository authority is unavailable');
      const policyBinding = (value: typeof initialPolicy): string => {
        const { computedAt: _computedAt, ...binding } = value;
        return maintainerEvidenceDigest(binding);
      };
      const digest = policyBinding(initialPolicy);
      const epoch = host.killEpoch();
      const assertAuthorized = (): void => {
        const current = host.policy();
        if (signal?.aborted || host.killActive() || !current || policyBinding(current) !== digest || host.killEpoch() !== epoch ||
            !current.repos.some((entry) => entry.nameWithOwner.toLowerCase() === pins.repo.toLowerCase()) ||
            !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= host.nowMs()) throw new Error('verification authority changed, expired or was stopped');
      };
      assertAuthorized();
      let execution: ExecutionLease | null = null;
      const registrationFence = await acquireOutwardMutationFenceAsync(2_000, { signal });
      if (!registrationFence) throw new Error('maintainer execution-registration fence unavailable');
      try {
        assertAuthorized();
        const registered = registerExecutionLease(registrationFence, {
          runId: `maintainer-pr-${pins.repo.replace('/', '-')}-${pins.pr}-${randomBytes(8).toString('hex')}`,
          repoKey: mirrorLeaseKey(mirrorPathFor(pins.repo)), engine: 'maintainer-verifier', parentSignal: signal,
          shouldAbort: () => { try { assertAuthorized(); return null; } catch { return 'maintainer verification authority changed'; } },
        });
        if (!registered.ok) throw new Error(registered.reason);
        execution = registered.lease;
      } finally { releaseOutwardMutationFence(registrationFence); }
      const executionSignal = execution.signal;
      const assertExecutionAuthorized = (): void => {
        if (executionSignal.aborted) throw new Error('maintainer execution stopped');
        assertAuthorized();
      };
      try {
        const mirror = await ensureMirror({ nameWithOwner: pins.repo, base: pins.baseBranch }, {
          signal: executionSignal,
          githubToken: async (repo) => { const minted = await host.token(repo); assertExecutionAuthorized(); return minted.token; },
        });
        assertExecutionAuthorized();
        if (!mirror.ok || mirror.headSha !== pins.baseSha || mirror.path !== mirrorPathFor(pins.repo)) throw new Error('trusted mirror did not acquire the exact current base');
        const leased = await withRepoLease(mirrorLeaseKey(mirror.path), async () => {
          assertExecutionAuthorized();
          // A fixed repository URL and PR ref. Credentials are carried by the
          // existing safe-git header adapter, never argv or repository config.
          const token = (await host.token(pins.repo)).token;
          assertExecutionAuthorized();
          const fetched = await runSafeGit({ workTree: mirror.path, gitDir: join(mirror.path, '.git'), layout: 'repo',
            args: ['fetch', '--no-tags', '--no-recurse-submodules', githubRemoteUrl(pins.repo), `+refs/pull/${pins.pr}/head:refs/ashlr/maintainer/${pins.pr}`],
            auth: { token }, signal: executionSignal, timeoutMs: 60_000 });
          if (!fetched.ok) throw new Error('exact PR fetch failed');
          const head = await runSafeGit({ workTree: mirror.path, gitDir: join(mirror.path, '.git'), layout: 'repo',
            args: ['rev-parse', '--verify', `refs/ashlr/maintainer/${pins.pr}^{commit}`], noOptionalLocks: true, signal: executionSignal });
          if (!head.ok || head.stdout.trim() !== pins.headSha) throw new Error('PR changed during exact head fetch');
        }, { signal: executionSignal });
        if (!leased.ok) throw new Error('trusted mirror lease unavailable');
        const prepared = await prepareMaintainerRun({ ...pins, mirrorPath: mirror.path, cfg: loadConfigReadOnlyStrict(), assertAuthorized: assertExecutionAuthorized, signal: executionSignal });
        return await runMaintainerPr(prepared);
      } finally { execution.release(); }
    },
    fenced: async (fn) => {
      const fence = await acquireOutwardMutationFenceAsync(2_000, { signal });
      if (!fence) throw new Error('outward check-publication fence unavailable');
      try {
        if (!ownsOutwardMutationFence(fence) || signal?.aborted) throw new Error('check-publication fence changed');
        activeFence = fence;
        return await fn();
      } finally { activeFence = null; releaseOutwardMutationFence(fence); }
    },
    publicationFenceHeld: () => signal?.aborted !== true && ownsOutwardMutationFence(activeFence),
    record: saveReceipt,
  };
}

export async function runMaintainerVerifyCli(argv: string[], deps: MaintainerVerificationDeps, print: (line: string) => void): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  if (args.length !== 4 || args[2] !== '--confirm-head' || !/^[1-9]\d*$/.test(args[1] ?? '') || !/^[0-9a-f]{40}$/.test(args[3] ?? '')) {
    print(json ? JSON.stringify({ ok: false, reason: MAINTAINER_VERIFY_USAGE }) : MAINTAINER_VERIFY_USAGE);
    return 2;
  }
  const result = await verifyMaintainerPr({ repo: args[0]!, pr: Number(args[1]), confirmHead: args[3]! }, deps);
  print(json ? JSON.stringify(result) : result.ok
    ? `Verified ${result.receipt.source.repo} #${result.receipt.source.pr}; ${result.receipt.run.commands.length} commands passed. App check ${result.check.id} confirmed. No merge or deployment was performed.`
    : `Verification withheld: ${scrubSecrets(result.reason)}`);
  return result.ok ? 0 : 1;
}

export async function cmdMaintainerVerify(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(MAINTAINER_VERIFY_USAGE + '\n'); return 0; }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await runMaintainerVerifyCli(argv, defaultMaintainerVerificationDeps(controller.signal), (line) => process.stdout.write(line + '\n'));
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
