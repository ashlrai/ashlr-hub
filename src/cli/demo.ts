/**
 * CLI handler for `ashlr demo` — a WATCHABLE, reproducible run of the FULL
 * autonomous chain on a DISPOSABLE repo so Mason can SEE it before trusting it.
 * See docs/contracts/CONTRACT-H8.md (BUILD ITEM 1).
 *
 * MILESTONE H8 "Harden & Prove" (FINAL). The demo adds NO new outward
 * capability: it is the ONLY new runtime surface, and it is
 * sandboxed/proposal-only/local + DISPOSABLE-repo-only with GUARANTEED
 * auto-cleanup.
 *
 * H8 ABSOLUTE RULES (proven by test/h8.demo.test.ts + test/h8.no-new-outward.test.ts):
 *  - DEMO-DISPOSABLE-ONLY: the demo runs in an ISOLATED context (its OWN tmp
 *    ~/.ashlr via a relocated process.env.HOME) and enrolls/works ONLY a
 *    throwaway git repo under os.tmpdir(). It NEVER enrolls or touches the real
 *    portfolio or the real ~/.ashlr/enrollment.json ({repos:[]}).
 *  - DEMO-AUTO-CLEANS: the tmp repo + tmp ~/.ashlr are removed on success, on
 *    error, AND on interrupt (try/finally + a SIGINT/SIGTERM handler). Cleanup
 *    is idempotent + never throws. `--no-cleanup` keeps the tmp dir (still under
 *    os.tmpdir()) for inspection and prints its path.
 *  - DEMO-NEVER-APPLIES: the demo creates only a PENDING proposal; it NEVER
 *    approves/applies a proposal, NEVER pushes/PRs/deploys, and NEVER runs
 *    against a real repo. It imports NO apply/push/PR/deploy primitive — it
 *    points the human at `ashlr inbox` exactly as the daemon does.
 *  - DETERMINISTIC, NO LIVE MODEL REQUIRED: the demo works end-to-end with NO
 *    local model. When a local model IS reachable it MAY run a real sandboxed
 *    PROPOSAL-ONLY swarm (via the daemon's existing `tick({dryRun:false})`,
 *    which imports no apply/push/PR/deploy primitive); otherwise it runs the
 *    daemon tick dry-run + a deterministic stub PENDING proposal so a proposal
 *    always appears.
 *  - No new runtime deps; node builtins + existing modules only.
 *
 * Wiring: BUILD/INTEGRATION adds `case 'demo'` + a `loadDemoCmd` lazy loader in
 * src/cli/index.ts + a cmdHelp entry.
 */

import { makeColors, isTty } from './ui.js';
import { makeDemoContext, type DemoContext } from './demo-sandbox.js';

import type { AshlrConfig } from '../core/types.js';
import { enroll, listEnrolled } from '../core/sandbox/policy.js';
import { buildBacklog } from '../core/portfolio/backlog.js';
import { tick } from '../core/daemon/loop.js';
import { probeEndpoint } from '../core/providers.js';
import { listProposals, createProposal } from '../core/inbox/store.js';
import { cmdInbox } from './inbox.js';

const { bold, dim, red, green, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Narration helper — every demo step prints a numbered, colorized line so the
// human can WATCH the chain. Kept tiny + side-effect-only (console.log).
// ---------------------------------------------------------------------------

/**
 * Print one narrated demo step. Exported so a test can assert the chain narrates
 * each stage (enroll → backlog → tick → PENDING → inbox → cleanup) in order.
 */
export function narrateStep(n: number, title: string, detail?: string): void {
  const head = `  ${cyan(String(n))}. ${bold(title)}`;
  console.log(detail ? `${head}  ${dim(detail)}` : head);
}

// ---------------------------------------------------------------------------
// JSON transcript — an optional structured trace of every step (for --json).
// ---------------------------------------------------------------------------

/** One step in the structured `--json` transcript. */
interface DemoStep {
  /** 1-based step number, in chain order. */
  n: number;
  /** Short step name (isolate/seed/enroll/backlog/tick/pending/inbox/rollback). */
  step: string;
  /** Human-readable detail line. */
  detail: string;
}

/** The structured `--json` transcript of a demo run. */
interface DemoTranscript {
  ok: boolean;
  /** True when a real local-model swarm ran; false on the deterministic stub path. */
  liveModel: boolean;
  /** Absolute path of the disposable tmp repo (under os.tmpdir()). */
  repoDir: string;
  /** Whether the tmp dir was kept (--no-cleanup). */
  kept: boolean;
  /** Present when best-effort policy teardown could not confirm unenrollment. */
  cleanupError?: string;
  /** Ordered step records. */
  steps: DemoStep[];
}

// ---------------------------------------------------------------------------
// Internal test seam — lets the demo test inject a mid-run failure to prove the
// try/finally ALWAYS cleans up. Never used by the dispatcher (which calls
// cmdDemo with one arg); production callers pass nothing.
// ---------------------------------------------------------------------------

/** @internal options consumed only by tests — see test/h8.demo.test.ts. */
export interface DemoInternalOptions {
  /**
   * Injected just before the inbox-review step (step 7). When provided and it
   * throws, the demo MUST still run its try/finally cleanup (tmp gone, HOME
   * restored) — the DEMO-AUTO-CLEANS error-path proof.
   */
  beforeInbox?: () => void;
}

// ---------------------------------------------------------------------------
// cmdDemo — the dispatcher entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr demo` — watch the FULL autonomous chain run, safely.
 *
 * Walks + narrates each step on a DISPOSABLE repo inside an ISOLATED tmp
 * ~/.ashlr (see {@link import('./demo-sandbox.js').makeDemoContext}):
 *   1. isolate  — relocate HOME to a fresh os.tmpdir() dir (assert it took effect)
 *   2. seed     — create a throwaway git repo with a `// TODO:` so work exists
 *   3. enroll   — enroll(tmpRepo)   (the explicit gate — on the DISPOSABLE repo only)
 *   4. backlog  — buildBacklog({repos:[tmpRepo]})   (narrate the discovered TODO)
 *   5. tick     — tick(cfg,{dryRun}) [real proposal-only swarm IF a local model is
 *                 up, else dry-run + a deterministic stub PENDING proposal]
 *   6. pending  — listProposals({status:'pending'})   (show the proposal — NOT applied)
 *   7. inbox    — cmdInbox (review only — the human gate; the demo NEVER approves)
 *   8. rollback — unenroll + sweepRepoSandboxes   (narrated; performed by dispose())
 *   9. cleanup  — FINALLY: dispose() the tmp context (rm -rf unless --no-cleanup)
 *
 * Flags:
 *   --no-cleanup  keep the tmp dir (still under os.tmpdir()) for inspection.
 *   --json        emit a structured trace of the steps instead of narration.
 *
 * GUARANTEED auto-cleanup: the whole chain runs inside a try/finally that calls
 * dispose(), and a SIGINT/SIGTERM handler is installed so an interrupt also
 * cleans up. Returns 0 on success, non-zero on error (after cleanup ran).
 *
 * @param args CLI args (`--no-cleanup`, `--json`).
 * @param internal @internal test-only injection seam (never passed by the CLI).
 */
export async function cmdDemo(
  args: string[],
  internal?: DemoInternalOptions,
): Promise<number> {
  const noCleanup = args.includes('--no-cleanup');
  const asJson = args.includes('--json');

  const steps: DemoStep[] = [];
  let stepNo = 0;

  // Record + narrate one step. In --json mode we stay quiet on stdout (the
  // transcript is emitted once at the end) but still track the step.
  const step = (name: string, title: string, detail: string): void => {
    stepNo += 1;
    steps.push({ n: stepNo, step: name, detail });
    if (!asJson) narrateStep(stepNo, title, detail);
  };

  if (!asJson) {
    console.log('');
    console.log(
      bold('ashlr demo') +
        dim(' — watch the full autonomous chain on a DISPOSABLE repo (proposal-only, auto-cleans)'),
    );
    console.log('');
  }

  // ── Step 1: isolate. Relocate HOME to a fresh tmp dir; assert it took effect.
  //    makeDemoContext throws (after restoring) if isolation did not engage, so
  //    we NEVER risk the real ~/.ashlr.
  let ctx: DemoContext;
  try {
    ctx = makeDemoContext({ keep: noCleanup });
  } catch (err) {
    // Isolation failed BEFORE any state was touched — report + bail (exit 1).
    if (!asJson) {
      console.error(red('demo: could not establish an isolated tmp context: ' + String(err)));
    } else {
      console.log(JSON.stringify({ ok: false, error: String(err) }));
    }
    return 1;
  }

  // Install a signal handler so an interrupt (Ctrl-C / SIGTERM) ALSO cleans up.
  // Declared here so the finally can remove it; INSTALLED inside the try below so
  // that ANY throw after makeDemoContext() (which has already relocated HOME to
  // the tmp dir) routes through the dispose() finally and never leaks tmp state.
  let signalled = false;
  const onSignal = (): void => {
    signalled = true;
    try {
      ctx.dispose();
    } catch {
      /* dispose is best-effort + idempotent */
    }
    // STOP the chain. process.once(...) suppresses Node's default
    // terminate-on-signal, so we MUST exit ourselves — otherwise the awaited
    // body would RESUME after dispose() restored the REAL HOME and the remaining
    // steps (tick / createProposal / inbox / audit) would write into the REAL
    // ~/.ashlr. Exiting here makes that impossible.
    process.exit(130);
  };

  let liveModel = false;
  let ok = false;
  let cleanupError: string | undefined;

  try {
    // Narrate the first two (already-completed) steps + install the signal
    // handler INSIDE the try, so any throw from here on — including from these
    // narration calls or the listener install — routes through the dispose()
    // finally with HOME still relocated to the tmp dir.
    step('isolate', 'Isolate', `tmp HOME at ${ctx.home} (NOT your real ~/.ashlr)`);
    step('seed', 'Seed disposable repo', `${ctx.repoDir} (a throwaway git repo with a // TODO:)`);

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // ── Step 3: enroll the DISPOSABLE repo (the explicit gate). Resolves state
    //    via homedir() at call time, so it writes ONLY into the isolated tmp
    //    ~/.ashlr and targets ONLY the throwaway repo — never a real path.
    const enrollment = enroll(ctx.repoDir);
    if (enrollment !== undefined && (!enrollment.ok || !enrollment.quiesced)) {
      throw new Error(`ashlr demo: disposable repo enrollment failed: ${enrollment.reason}`);
    }
    step(
      'enroll',
      'Enroll',
      `enrolled 1 disposable repo (${listEnrolled().length} total — NOT your portfolio)`,
    );

    // ── Step 4: backlog scan. Re-runs the REAL scanners over the tmp repo's
    //    working tree and finds the seeded // TODO:.
    const backlog = await buildBacklog({ repos: [ctx.repoDir] });
    const titles = backlog.items.map((i) => i.title);
    step(
      'backlog',
      'Backlog scan',
      `discovered ${backlog.items.length} work item(s)` +
        (titles.length > 0 ? `: ${titles.slice(0, 3).join('; ')}` : ''),
    );

    // ── Step 5: daemon tick. Determine the path by probing for a LOCAL model.
    //    probeEndpoint is local-only, 2s, never throws. With a model up we run
    //    the daemon's existing PROPOSAL-ONLY swarm (tick {dryRun:false}); with
    //    NO model we run the dry-run tick + synthesize a deterministic stub
    //    PENDING proposal so a proposal ALWAYS appears (the deterministic path
    //    the tests force).
    const cfg = demoCfg();
    const [lm, ol] = await Promise.all([
      probeEndpoint('lmstudio', cfg.models.lmstudio),
      probeEndpoint('ollama', cfg.models.ollama),
    ]);
    liveModel = lm.up || ol.up;

    if (liveModel) {
      // Real sandboxed PROPOSAL-ONLY swarm — tick imports no apply/push/PR/deploy
      // primitive (H1/H4 grep-guarded); the most it can do is emit a PENDING
      // proposal. NEVER applies.
      await tick(cfg, { dryRun: false });
      step(
        'tick',
        'Daemon tick (LIVE swarm)',
        `local model reachable (${lm.up ? 'lmstudio' : 'ollama'}) → sandboxed PROPOSAL-ONLY swarm`,
      );
    } else {
      // Deterministic no-model path: dry-run tick (touches nothing) + a stub
      // PENDING proposal so the human still sees the inbox half of the chain.
      await tick(cfg, { dryRun: true });
      const seedTitle = titles[0] ?? 'demo: address the seeded TODO';
      createProposal({
        repo: ctx.repoDir,
        origin: 'swarm',
        kind: 'note',
        title: `[demo] ${seedTitle}`,
        summary:
          'Deterministic demo stub: no local model was reachable, so the demo ' +
          'synthesizes a single PENDING proposal to show the inbox-review + ' +
          'rollback half of the chain. It is NEVER applied.',
      });
      step(
        'tick',
        'Daemon tick (no-model stub)',
        'no local model reachable → dry-run tick + a deterministic stub PENDING proposal',
      );
    }

    // ── Step 6: show the PENDING proposal — NOT applied.
    const pending = listProposals({ status: 'pending' });
    step(
      'pending',
      'PENDING proposal',
      `${pending.length} pending proposal(s) — ` +
        (pending[0] ? `"${pending[0].title}" ` : '') +
        green('NOT applied'),
    );

    // Test seam: inject a failure right before the inbox-review step to prove
    // the try/finally ALWAYS cleans up. Never set by the CLI.
    if (internal?.beforeInbox) internal.beforeInbox();

    // ── Step 7: inbox review (the human gate). cmdInbox renders against the
    //    ISOLATED inbox; the demo NEVER approves.
    if (!asJson) {
      console.log('');
      console.log(
        '  ' +
          yellow('This is the human gate.') +
          dim(' In real use YOU review + approve here. The demo NEVER approves.'),
      );
      await cmdInbox([]);
      console.log('');
    }
    step(
      'inbox',
      'Inbox review',
      'the human gate — in real use YOU approve here; the demo NEVER approves/applies',
    );

    // ── Step 8: narrate the rollback (performed by dispose() in the finally).
    step(
      'rollback',
      'Rollback / cleanup',
      'unenroll the tmp repo + sweep its sandboxes, then remove the tmp repo + tmp HOME',
    );

    ok = true;
  } finally {
    // ── Step 9: GUARANTEED auto-cleanup — runs on success, on error, AND on a
    //    forced mid-run throw. dispose() is idempotent + never throws.
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!signalled) {
      try {
        const disposed = ctx.dispose();
        if (!disposed.unenrolled) {
          cleanupError = disposed.reason;
          ok = false;
        }
      } catch (err) {
        cleanupError = err instanceof Error ? err.message : String(err);
        ok = false;
      }
    }
  }

  // ── Final report.
  if (asJson) {
    const transcript: DemoTranscript = {
      ok,
      liveModel,
      repoDir: ctx.repoDir,
      kept: noCleanup,
      ...(cleanupError ? { cleanupError } : {}),
      steps,
    };
    console.log(JSON.stringify(transcript, null, 2));
  } else {
    console.log('');
    if (cleanupError) {
      console.error(`  ${red('cleanup incomplete:')} ${cleanupError}`);
    } else if (noCleanup) {
      console.log(
        '  ' +
          yellow('--no-cleanup:') +
          ` kept the tmp dir for inspection (still under os.tmpdir()): ${ctx.repoDir}`,
      );
      console.log('  ' + dim('(remove it yourself when done — it is a throwaway repo)'));
    } else {
      console.log('  ' + green('done') + dim(' — tmp repo + tmp ~/.ashlr removed; your real portfolio was never touched'));
    }
    console.log('');
  }

  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// demoCfg — a minimal, deterministic in-memory AshlrConfig for the demo tick.
// Conservative caps; constructed in memory (NOT loadConfig) so it never depends
// on config.ts's module-load CONFIG_DIR — keeping the demo isolated regardless
// of import order, exactly like the H1 fixture's makeCfg().
// ---------------------------------------------------------------------------

function demoCfg(): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 0.5,
      perTickItems: 1,
      parallel: 1,
      intervalMs: 100,
    },
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['lmstudio', 'ollama'],
    },
  } as AshlrConfig;
}
