/**
 * Types for the local-agent evaluation harness.
 *
 * WHY THIS EXISTS. Every number we have about the local seat so far is a
 * handful of one-line fixes timed by hand. That is enough to show a prompt-cache
 * bug was costing 23,301 reprocessed tokens a turn, and not nearly enough to
 * answer the only question that matters when tuning: did this change make the
 * agent BETTER at real work, or just faster at failing?
 *
 * Three commitments are encoded in these types, each one a lesson this
 * repository paid for:
 *
 *   1. A verdict is an EXIT CODE, never a model's opinion. `TaskSpec.verify` is
 *      a command; its status decides the trial. No model ever judges a model.
 *   2. A result is a DISTRIBUTION, never a sample. `TaskOutcome` carries every
 *      trial, because on this hardware turns vary by tens of seconds and one
 *      run has already produced a wrong conclusion here.
 *   3. A number without its CONFIGURATION cannot be compared to anything, so
 *      `HarnessConfiguration` is captured from the live runtime at run time and
 *      stored beside the results rather than written down by hand.
 */

/** What the task is asking of the agent, which decides how it is graded. */
export type TaskExpectation =
  /** The agent should change the tree, and `verify` proves the change correct. */
  | 'edit'
  /**
   * The agent should decline or ask. `verify` proves the tree is still intact,
   * and the closing message must not assert a change it did not make.
   */
  | 'refuse';

/** A single evaluation task. */
export interface TaskSpec {
  readonly id: string;
  /** Why this task earns a place in the set. Printed in the report. */
  readonly why: string;
  readonly expectation: TaskExpectation;
  /** The instruction handed to the agent verbatim. */
  readonly prompt: string;
  /** Fixture contents, written relative to the trial's working directory. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Source of the pass check, written OUTSIDE the agent's working directory.
   *
   * This placement is load-bearing, not tidiness. A checker sitting next to the
   * code is itself editable, and "make the failing test pass" has an obvious
   * cheat if the test is in reach. Claude Code confines its file tools to the
   * working directory, so a checker one level above it cannot be rewritten by
   * the agent under evaluation.
   */
  readonly check: string;
  /**
   * The pass check. Argv, not a shell string: no quoting to get wrong, and
   * nothing a fixture file name could inject into a shell.
   */
  readonly verify: readonly string[];
}

/**
 * How a trial failed. `pass` is included so a trial always carries exactly one
 * verdict and callers never have to combine a boolean with an enum.
 */
export type FailureMode =
  | 'pass'
  /** THE ONE THAT MATTERS: reported a change, the tree never moved. */
  | 'claimed-change-none-made'
  /** Declined or stopped on a task that was plainly doable. */
  | 'refused-doable-task'
  /** Complied with a request it should have questioned. */
  | 'complied-with-bad-request'
  /** Ended before finishing: cancelled, max turns, or a non-completed stop. */
  | 'stopped-early'
  /** Edited something, but the result is wrong. */
  | 'wrong-edit'
  /** Ran past the wall-clock budget and was killed. */
  | 'timeout'
  /** Hit the model's context limit. */
  | 'context-exhausted'
  /** The CLI or the runtime errored — not the model's fault, and not a pass. */
  | 'harness-error';

/**
 * One request/response exchange between the agent and the runtime, as seen on
 * the wire by the tracing proxy.
 *
 * `sawTerminator` is the field this whole record exists for. An SSE turn that
 * closes without `message_stop` leaves the agent waiting on a socket the server
 * already considers finished, and that is indistinguishable from a slow model
 * to everything downstream — including the CLI's own result JSON, which an
 * aborted turn is documented to report as COMPLETED.
 */
export interface StreamRecord {
  readonly seq: number;
  readonly url: string;
  readonly status: number | null;
  /** Which side ended it, and how. */
  readonly ended: 'upstream-end' | 'upstream-aborted' | 'upstream-error' | 'client-closed';
  readonly bytes: number;
  /** SSE event names to counts, e.g. `{ content_block_delta: 512 }`. */
  readonly events: Readonly<Record<string, number>>;
  /** Whether a `message_stop` event ever arrived. */
  readonly sawTerminator: boolean;
  /** Node's own view of whether the response body arrived in full. */
  readonly upstreamComplete: boolean;
  readonly waitedForFirstByteMs: number | null;
  /** Silence between the last byte and the close. Null when no byte arrived. */
  readonly idleAtEndMs: number | null;
  readonly durationMs: number;
}

/** A stream that had not finished when the trace was read. */
export interface OpenStreamRecord {
  readonly seq: number;
  readonly url: string;
  readonly status: number | null;
  readonly bytes: number;
  readonly events: Readonly<Record<string, number>>;
  readonly openForMs: number;
  /** Null when not one byte has arrived yet. */
  readonly sinceLastByteMs: number | null;
  readonly waitedForFirstByteMs: number | null;
}

/** Everything the tracing proxy saw during one trial. */
export interface TrialTrace {
  /** Where the raw request bodies and response streams were written. */
  readonly captureDir: string;
  readonly requests: number;
  readonly streams: readonly StreamRecord[];
  readonly openStreams: readonly OpenStreamRecord[];
  /** Silence longer than this is reported as a stall rather than as slowness. */
  readonly stallMs: number;
}

/**
 * WHY a trial ran out of clock.
 *
 * Each value names a different thing to go and fix, which is the entire point:
 * "timeout" alone is the same non-answer as a pass rate with no failure modes.
 */
export type TimeoutDiagnosisKind =
  /** Tokens were still arriving when the budget expired. The model was working. */
  | 'generating-at-cutoff'
  /** A stream went silent and was never closed. The socket outlived the turn. */
  | 'stream-stalled'
  /** A request was accepted and never produced a single byte. */
  | 'no-first-token'
  /** The last stream closed with no `message_stop`; the agent waited forever. */
  | 'stream-ended-without-terminator'
  /** Every stream completed cleanly and the agent simply stopped. Client-side. */
  | 'idle-between-turns'
  /** The agent never reached the runtime at all. */
  | 'no-request-reached-the-model';

export interface TimeoutDiagnosis {
  readonly kind: TimeoutDiagnosisKind;
  /** One sentence naming the evidence, safe to print in a report. */
  readonly detail: string;
  /** The request the verdict is about, when there is one. */
  readonly seq: number | null;
}

/** Token counts for one trial, as reported by the agent CLI. */
export interface TrialTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/** One attempt at one task. */
export interface TrialResult {
  readonly taskId: string;
  readonly trial: number;
  readonly mode: FailureMode;
  readonly passed: boolean;
  /** Wall clock for the agent turn, milliseconds. */
  readonly wallMs: number;
  readonly tokens: TrialTokens;
  /** Exit status of the agent CLI. */
  readonly agentExit: number | null;
  /** Exit status of the `verify` command; null when it was never reached. */
  readonly verifyExit: number | null;
  /** Files the agent actually changed, counted from the git diff. */
  readonly changedFiles: number | null;
  /** The agent's closing message, as classified by completion-claims. */
  readonly claim: string;
  readonly integrity: string;
  /** Number of assistant turns the CLI reported. */
  readonly turns: number | null;
  /** Short human-readable note, e.g. the first line of a crash. */
  readonly note: string;
  /**
   * What the wire was doing when the clock ran out. Null for every trial that
   * did not time out — and never null for one that did, which is the guarantee
   * this field was added to make.
   */
  readonly timeoutDiagnosis: TimeoutDiagnosis | null;
  /**
   * The wire summary, present whenever tracing was on. Kept on the trial rather
   * than only in a log file so a recorded baseline stays diagnosable after the
   * temporary directory it ran in is gone.
   */
  readonly trace: TrialTrace | null;
}

/** Every trial for one task, plus the aggregate that answers "did this help?". */
export interface TaskOutcome {
  readonly taskId: string;
  readonly why: string;
  readonly expectation: TaskExpectation;
  readonly trials: readonly TrialResult[];
  readonly passes: number;
  readonly total: number;
  readonly passRate: number;
  readonly medianWallMs: number;
  readonly meanWallMs: number;
  /** Failure modes seen, most frequent first. Empty when every trial passed. */
  readonly modes: readonly { readonly mode: FailureMode; readonly count: number }[];
}

/**
 * The configuration a result is only meaningful against.
 *
 * Read from the live runtime rather than accepted as an argument wherever
 * possible: a hand-written record of what was running is exactly the thing that
 * goes stale and silently invalidates a comparison.
 */
export interface HarnessConfiguration {
  /** Resolved model reference, e.g. `qwen3.8:27b-q8_0`. */
  readonly model: string;
  /** The on-disk blob actually loaded, which is what `model` is derived from. */
  readonly modelPath: string;
  readonly quantization: string;
  readonly slots: number;
  /** Context per slot, which is the number that bounds a single agent. */
  readonly contextPerSlot: number;
  /** Total context across all slots, i.e. llama-server's `-c`. */
  readonly contextTotal: number;
  readonly samplingParams: Readonly<Record<string, unknown>>;
  /** The base URL the agent was pointed at. */
  readonly baseUrl: string;
  /** Whether that base URL is the normalising proxy or llama-server directly. */
  readonly proxy: 'on' | 'off';
  /**
   * Whether the tracing proxy was inserted in front of `baseUrl`.
   *
   * Recorded because it changes what a timed-out trial can say about itself,
   * and a baseline that predates tracing must not be mistaken for one where
   * tracing found nothing.
   */
  readonly tracing: 'on' | 'off';
  /** What is actually serving the proxy port, when that could be determined. */
  readonly proxyImplementation: string;
  readonly agentCli: string;
  readonly llamaServerArgv: readonly string[];
  readonly capturedAt: string;
}

/** A complete harness run: the configuration, and what it scored. */
export interface EvalReport {
  readonly configuration: HarnessConfiguration;
  readonly trialsPerTask: number;
  readonly concurrency: number;
  readonly outcomes: readonly TaskOutcome[];
  readonly overallPassRate: number;
  readonly totalPasses: number;
  readonly totalTrials: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
}
