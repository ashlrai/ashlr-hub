/**
 * The automations timer — ONE call per tick (`runAutomationsTick`), started
 * by the Verse server's background services (cli/verse.ts), never by the
 * daemon: automations only hand work to lanes through their own entry
 * points, so the daemon's Tier-1 loop needs no new edge.
 *
 * Never in a test process (a timer outliving a test could launch a paid
 * session or write under the next test's HOME); ASHLR_AUTOMATIONS_AUTO=0
 * turns it off. Overlapping ticks are skipped, not queued; a failing tick is
 * logged once per distinct error.
 */
import { scrubSecrets } from '../util/scrub.js';
import { runAutomationsTick, type AutomationEngineDeps } from './engine.js';
import { refreshAutomationsNeedsYou } from './needs-you.js';

export const AUTOMATIONS_TICK_EVERY_MS = 60_000;
export const AUTOMATIONS_FIRST_TICK_MS = 30_000;

export function automationsSchedulerRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return 'test process';
  if (env['ASHLR_AUTOMATIONS_AUTO'] === '0') return 'disabled by ASHLR_AUTOMATIONS_AUTO=0';
  return null;
}

let running = false;

export function automationsSchedulerRunning(): boolean {
  return running;
}

export interface AutomationsSchedulerOptions {
  env?: NodeJS.ProcessEnv;
  deps?: AutomationEngineDeps;
  log?: (message: string) => void;
  tick?: () => Promise<unknown>;
}

/** Start the timer; returns its stop function, or null when this process must not run it. */
export function scheduleAutomationsTick(opts: AutomationsSchedulerOptions = {}): (() => void) | null {
  if (running) return null;
  if (automationsSchedulerRefusal(opts.env ?? process.env) !== null) return null;
  const log = opts.log ?? ((message: string) => { console.warn(`[ashlr] ${message}`); });
  const tick = opts.tick ?? (async () => {
    await runAutomationsTick(opts.deps ?? {});
    await refreshAutomationsNeedsYou();
  });
  let busy = false;
  let lastError: string | null = null;
  const run = (): void => {
    if (busy) return;
    busy = true;
    let p: Promise<unknown>;
    try { p = tick(); } catch (err) { p = Promise.reject(err); }
    void p
      .then(() => { lastError = null; })
      .catch((err: unknown) => {
        const text = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
        if (text !== lastError) {
          lastError = text;
          try { log(`automations tick failed (${text}); retrying next minute`); } catch { /* never throws */ }
        }
      })
      .finally(() => { busy = false; });
  };
  const first = setTimeout(run, AUTOMATIONS_FIRST_TICK_MS);
  first.unref?.();
  const every = setInterval(run, AUTOMATIONS_TICK_EVERY_MS);
  every.unref?.();
  running = true;
  return () => {
    clearTimeout(first);
    clearInterval(every);
    running = false;
  };
}
