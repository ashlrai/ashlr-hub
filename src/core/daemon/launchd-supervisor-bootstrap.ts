import type { LaunchdSupervisorResult } from './launchd-supervisor-runtime.js';

type RuntimeLoader = () => Promise<{
  runLaunchdSupervisor: (args: readonly string[]) => Promise<LaunchdSupervisorResult>;
}>;

const loadRuntime: RuntimeLoader = () => import('./launchd-supervisor-runtime.js');

/** Minimal fail-closed bootstrap used by the launchd entrypoint. */
export async function runLaunchdSupervisorBootstrap(
  args: readonly string[],
  loader: RuntimeLoader = loadRuntime,
): Promise<0> {
  try {
    const runtime = await loader();
    await runtime.runLaunchdSupervisor(args);
  } catch {
    // launchd is explicitly one-shot, so every bootstrap failure stops here.
  }
  return 0;
}
