/** Private real-process harness for candidate-linked correctness controls.
 * No provider transport is started; callers must settle sessions before teardown. */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { runVerifySubprocessAsync } from '../../src/core/run/verify-commands.js';
import { buildPreparationVerificationBridge } from './preparation-verification-bundle.js';
import { resolvePreparationGit, assertPreparationGit } from '../../scripts/evaluators/preparation-verification-native.mjs';

type Counts = { processes: number; blobProcesses: number };
export interface PreparationCandidateSession {
  call(method: string, input: unknown): Promise<{ value?: unknown; error?: string; measurement: Counts }>;
  close(): Promise<void>;
  measurementLedger(): Counts & { requests: Array<Counts & { id: number; method: string }> };
}

/** Failed opens and failed closes leave custody unresolved. A rejection is not
 * proof that every native group has settled, so teardown must preserve evidence. */
export function createPreparationHarnessCustody() {
  let pending = 0;
  return {
    assertSettled(): void { if (pending !== 0) throw new Error('PREPARATION_HARNESS_CUSTODY_UNSETTLED'); },
    async track(open: () => Promise<PreparationCandidateSession>): Promise<PreparationCandidateSession> {
      pending++;
      const child = await open();
      let closing: Promise<void> | undefined;
      return { ...child,
        close() {
          closing ??= Promise.resolve().then(() => child.close()).then(() => { pending--; });
          return closing;
        },
      };
    },
  };
}

/** Include identity and timestamps, not just bytes; never follow fixture symlinks. */
export function snapshotPreparationFixture(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isSymbolicLink() ? { symlink: readlinkSync(file) }
      : stat.isDirectory() ? Object.fromEntries(readdirSync(file).sort().map(name => [name, snapshotPreparationFixture(join(file, name))]))
        : createHash('sha256').update(readFileSync(file)).digest('hex') };
}

export async function createPreparationCandidateHarness(repository: string) {
  const gitPin = Object.freeze(resolvePreparationGit());
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-mutation-')));
  const custody = createPreparationHarnessCustody();
  function close() {
    try { custody.assertSettled(); }
    catch { throw new Error(`PREPARATION_HARNESS_CUSTODY_UNSETTLED: retained ${root}`); }
    assertPreparationGit(gitPin);
    const writable = (file: string): void => {
      const stat = lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(file, 0o700);
      for (const name of readdirSync(file)) writable(join(file, name));
    };
    writable(root); rmSync(root, { recursive: true, force: true });
  }
  try {
    const workRoot = join(root, 'work'), bundle = join(root, 'fixed');
    mkdirSync(workRoot, { mode: 0o700 }); mkdirSync(bundle, { mode: 0o700 });
    const bridgePath = join(bundle, 'preparation-bridge.mjs');
    await buildPreparationVerificationBridge(repository, bridgePath);
    const bridge = await import(pathToFileURL(bridgePath).href);
    const run = bridge.runVerifySubprocessAsync as typeof runVerifySubprocessAsync;
    const { createPreparationCandidateSession } = await import(pathToFileURL(join(bundle, 'preparation-verification-controller.mjs')).href) as {
      createPreparationCandidateSession(options: unknown): Promise<PreparationCandidateSession>;
    };
    const target = 'src/core/resources/engineering-preparation.ts';
    const source = readFileSync(join(repository, target), 'utf8');
    return { root, source, run, gitPin: { ...gitPin }, toolPath: join(bundle, 'preparation-verification-tool.mjs'), close,
      async session(text: string, fixtureRoot: string, runOverride: typeof runVerifySubprocessAsync = run) {
        // Separate roots preserve the controller's existing containment rules.
        const candidateRoot = mkdtempSync(join(root, 'candidate-'));
        mkdirSync(join(candidateRoot, dirname(target)), { recursive: true, mode: 0o700 });
        writeFileSync(join(candidateRoot, target), text, { mode: 0o600 });
        return custody.track(() => createPreparationCandidateSession({ bridge: { ...bridge, runVerifySubprocessAsync: runOverride },
          bridgePath, candidateRoot, fixtureRoot, workRoot, timeoutMs: 300000, gitPin }));
      },
    };
  } catch (error) { close(); throw error; }
}
