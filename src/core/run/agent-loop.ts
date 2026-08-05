/**
 * agent-loop.ts — bounded ReAct-style loop for a single RunTask.
 *
 * Runs the task against a ProviderClient, handling tool calls when supported,
 * enforcing the hard budget ceiling, and emitting RunStep events per step.
 * Never throws out of runTask — all errors are captured into task.status/error.
 *
 * M11: accepts an optional StreamSink in ctx for live progress streaming.
 * Emits model-delta events via client.chatStream() when available (falls back
 * to client.chat() with a single delta of the full content). Also emits
 * tool-call events per tool execution.
 */

import type {
  RunTask,
  RunStep,
  RunBudget,
  RunUsage,
  RunStreamEvent,
  ProviderClient,
  ChatMessage,
  ChatResult,
  ToolExecutor,
  RunContextSummary,
} from '../types.js';
import { addUsage, overBudget, newUsage } from './budget.js';
import { nullSink } from './streaming.js';
import type { StreamSink } from './streaming.js';
import { resolveModelProfile } from './model-profile.js';
import { assembleSystemPrompt } from './prompts/index.js';
import {
  commitToolEffect,
  prepareToolEffect,
  releasePreparedToolEffect,
} from '../util/effect-journal.js';
import type {
  HarnessActionClassV1,
  HarnessObservationOutcomeV1,
} from '../learning/harness-observations.js';

/** Maximum steps per task, regardless of budget (safety backstop). */
const TASK_STEP_CAP = 20;
const TASK_EFFECT_CAP = 64;
export const LOCAL_API_MODEL_INITIAL_PROMPT_TOKEN_CAP = 2_500;

type ToolFreeResponseClass = 'complete' | 'continuation-intent' | 'empty';

/**
 * Classify a tool-free assistant response without retaining or returning its
 * text. The deliberately narrow patterns cover explicit promises to perform a
 * next engineering action, not ordinary future-tense conclusions.
 */
export function classifyToolFreeResponse(content: string): ToolFreeResponseClass {
  const trimmed = content.trim();
  if (!trimmed) return 'empty';
  const completionEvidence = /(?:\b(?:i|we)\s+(?:implemented|fixed|resolved|completed|updated|added|removed)\b|\b(?:implemented|fixed|resolved|completed|updated|added|removed)\s+(?:the|this|requested)\b|\btests?\s+(?:pass|passed|are\s+passing)\b)/i;
  if (completionEvidence.test(trimmed)) return 'complete';
  const futureAction = /^(?:(?:next|now)[,:]?\s+)?(?:i(?:'ll|\s+will|\s+need\s+to|\s+am\s+going\s+to)|let\s+me|we\s+need\s+to)\s+(?:inspect|read|check|look|search|open|edit|update|modify|run|test|verify|fix|implement|continue|proceed|investigate|review)\b[^\n]*[.!:]?$/i;
  const paragraphs = trimmed.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  return paragraphs.length > 0 && paragraphs.every((paragraph) => futureAction.test(paragraph))
    ? 'continuation-intent'
    : 'complete';
}

const OMITTED_CONTEXT_MARKER = '[optional context omitted]';
const MINIMAL_LOCAL_SYSTEM_PROMPT =
  'Complete the task directly. Use available tools when needed, then return a concise final result or explicit blocker.';

function semanticUnits(value: string): string[] {
  if (!value) return [];
  const paragraphs = value.split(/\r?\n\s*\r?\n/u).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = value.split(/\r?\n/u).map((part) => part.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return Array.from(value.matchAll(/\S+(?:\s+|$)/gu), (match) => match[0]!.trimEnd()).filter(Boolean);
}

type RequestSizer = (messages: ChatMessage[], tools: unknown[] | undefined) => number;

function serializedRequestChars(
  messages: ChatMessage[],
  tools?: unknown[],
  requestSizer?: RequestSizer,
): number {
  try {
    if (requestSizer) return requestSizer(messages, tools);
    return JSON.stringify({
      messages,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function appendWholeSections(
  current: string,
  value: string | undefined,
  joiner: string,
  fits: (candidate: string) => boolean,
): { value: string; admittedChars: number; dropped: boolean } {
  const units = semanticUnits(value ?? '');
  if (units.length === 0) return { value: current, admittedChars: 0, dropped: false };
  let result = current;
  let admittedChars = 0;
  let admitted = 0;
  for (const unit of units) {
    const candidate = result ? `${result}${joiner}${unit}` : unit;
    if (!fits(candidate)) break;
    result = candidate;
    admittedChars += unit.length;
    admitted++;
  }
  if (admitted < units.length) {
    const candidate = result
      ? `${result}${joiner}${OMITTED_CONTEXT_MARKER}`
      : OMITTED_CONTEXT_MARKER;
    if (fits(candidate)) result = candidate;
  }
  return { value: result, admittedChars, dropped: admitted < units.length };
}

function promptRatio(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, value / limit)) * 1_000) / 1_000;
}

function assembleBoundedInitialPrompt(input: {
  baseSystem: string;
  systemPrefix?: string;
  userPrefix?: string;
  goal: string;
  tokenCap: number;
  toolCount: number;
  tools?: unknown[];
  requestSizer?: RequestSizer;
}): { ok: true; system: string; user: string; summary: RunContextSummary } | { ok: false; reason: string } {
  const charCap = Math.max(256, Math.trunc(input.tokenCap) * 4);
  const rawMessages: ChatMessage[] = [
    { role: 'system', content: input.systemPrefix ? `${input.systemPrefix}\n\n${input.baseSystem}` : input.baseSystem },
    { role: 'user', content: input.userPrefix ? `${input.userPrefix}${input.goal}` : input.goal },
  ];
  const inputChars = serializedRequestChars(rawMessages, input.tools, input.requestSizer);

  let baseSystem = input.baseSystem;
  const baseFits = (candidate: string): boolean => serializedRequestChars([
    { role: 'system', content: candidate },
    { role: 'user', content: input.goal },
  ], input.tools, input.requestSizer) <= charCap;
  if (!baseFits(baseSystem)) {
    const compacted = appendWholeSections('', input.baseSystem, '\n\n', baseFits);
    baseSystem = compacted.value;
    if (compacted.admittedChars === 0 || !baseSystem || !baseFits(baseSystem)) {
      baseSystem = MINIMAL_LOCAL_SYSTEM_PROMPT;
    }
  }
  if (!baseFits(baseSystem)) {
    return {
      ok: false,
      reason: `Local API-model objective and tool schemas exceed the ${input.tokenCap}-token request budget.`,
    };
  }

  let systemPrefix = '';
  const systemContext = appendWholeSections(
    '',
    input.systemPrefix,
    '\n\n',
    (candidate) => serializedRequestChars([
      { role: 'system', content: `${candidate}\n\n${baseSystem}` },
      { role: 'user', content: input.goal },
    ], input.tools, input.requestSizer) <= charCap,
  );
  systemPrefix = systemContext.value;
  const system = systemPrefix ? `${systemPrefix}\n\n${baseSystem}` : baseSystem;

  let userPrefix = '';
  const userContext = appendWholeSections(
    '',
    input.userPrefix,
    '\n\n',
    (candidate) => serializedRequestChars([
      { role: 'system', content: system },
      { role: 'user', content: `${candidate}\n\n${input.goal}` },
    ], input.tools, input.requestSizer) <= charCap,
  );
  userPrefix = userContext.value;
  const user = userPrefix ? `${userPrefix}\n\n${input.goal}` : input.goal;
  const outputChars = serializedRequestChars([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], input.tools, input.requestSizer);
  const injectedChars = systemContext.admittedChars + userContext.admittedChars;
  const layersIncluded: NonNullable<NonNullable<RunContextSummary['prompt']>['layersIncluded']> = ['base'];
  if (input.toolCount > 0) layersIncluded.push('tool');
  if (injectedChars > 0) layersIncluded.push('memory');

  return {
    ok: true,
    system,
    user,
    summary: {
      prompt: {
        role: 'executor',
        profileId: 'local-api-model-bounded-v1',
        estimatedPromptTokens: Math.ceil(outputChars / 4),
        promptCharCap: charCap,
        assembledSystemChars: system.length,
        promptBudgetRatio: promptRatio(outputChars, charCap),
        layersIncluded,
        toolCount: input.toolCount,
      },
      retrieval: {
        source: 'local-context',
        hitCount: 0,
        injectedHitCount: 0,
        injectedChars,
      },
      compression: {
        source: 'prompt-budget',
        strategy: 'drop-layer',
        inputChars,
        outputChars,
        maxChars: charCap,
        droppedChars: Math.max(0, inputChars - outputChars),
        compressionRatio: inputChars > 0 ? promptRatio(outputChars, inputChars) : 1,
        truncated: outputChars < inputChars,
        ...((systemContext.dropped || userContext.dropped || baseSystem !== input.baseSystem)
          ? { droppedLayers: ['optional-context'] }
          : {}),
      },
    },
  };
}

function boundedMessagesForRequest(
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  charCap: number,
  requestSizer?: RequestSizer,
): { ok: true; messages: ChatMessage[]; requestChars: number } | { ok: false; reason: string } {
  const fullChars = serializedRequestChars(messages, tools, requestSizer);
  if (fullChars <= charCap) return { ok: true, messages, requestChars: fullChars };
  const mandatory = messages.slice(0, 2);
  if (serializedRequestChars(mandatory, tools, requestSizer) > charCap) {
    return { ok: false, reason: 'Local API-model immutable objective no longer fits the request budget.' };
  }

  const selected: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 2; index--) {
    const message = messages[index]!;
    const candidate = [...mandatory, message, ...selected];
    if (serializedRequestChars(candidate, tools, requestSizer) <= charCap) {
      selected.unshift(message);
      continue;
    }
    if (selected.length > 0) continue;

    const units = semanticUnits(message.content);
    let low = 0;
    let high = units.length;
    let best: ChatMessage | undefined;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const content = midpoint > 0
        ? `${units.slice(0, midpoint).join('\n\n')}\n\n${OMITTED_CONTEXT_MARKER}`
        : OMITTED_CONTEXT_MARKER;
      const compacted = { ...message, content };
      if (serializedRequestChars([...mandatory, compacted], tools, requestSizer) <= charCap) {
        best = compacted;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (!best && message.role === 'tool') {
      return { ok: false, reason: 'Local API-model tool result cannot be represented inside the request budget.' };
    }
    if (best) selected.unshift(best);
  }

  const bounded = [...mandatory, ...selected];
  return { ok: true, messages: bounded, requestChars: serializedRequestChars(bounded, tools, requestSizer) };
}

/** Completion handle returned after the caller atomically reserves a model step. */
export interface ModelStepReservation {
  finalize(
    summary: string,
    usage?: { tokensIn: number; tokensOut: number },
  ): void;
}

/**
 * Synchronous authority for the run-wide model-step budget. Returning undefined
 * denies the call because no global step remains.
 */
export type ReserveModelStep = () => ModelStepReservation | undefined;

/**
 * A tool executor passed through ctx. Each entry must have a callable `fn`.
 * We accept unknown[] from the contract; internally we cast when needed.
 */
interface ToolSpec {
  name: string;
  safety?: 'read' | 'append' | 'proposal' | 'write' | 'exec';
  fn?: ToolExecutor;
  [key: string]: unknown;
}

/**
 * Execute a single RunTask to completion using `client`.
 *
 * - Runs a bounded chat loop (ReAct-style).
 * - When ctx.tools is present AND client.supportsTools, may issue tool calls
 *   and feed results back as role:'tool' messages.
 * - Accumulates per-step usage into ctx.usage (mutated in place via addUsage).
 * - Emits one RunStep per model call (kind:'model') and per tool execution
 *   batch (kind:'tool') via ctx.onStep.
 * - M11: emits RunStreamEvents via ctx.sink for live CLI progress:
 *     model-delta (via chatStream if available, else single onDelta of full content),
 *     tool-call per tool execution.
 * - HARD STOP: if overBudget(ctx.usage, ctx.budget) at any point, stops the
 *   loop. Sets task.status='failed' (no result) or 'done' (partial result).
 * - On success: task.status='done', task.result=<text>, task.usage=<delta>.
 * - On error: task.status='failed', task.error=<message>.
 * - Returns the SAME task object (mutated) for caller convenience.
 */
export async function runTask(
  task: RunTask,
  client: ProviderClient,
  ctx: {
    tools?: unknown[];
    budget: RunBudget;
    usage: RunUsage;
    /** M11: optional StreamSink for live progress events. Defaults to nullSink. */
    sink?: StreamSink;
    onStep: (s: RunStep) => void;
    /**
     * M41: when true, build the system prompt from the model-adaptive prompt
     * suite and use the model profile's step cap. Default/false → the legacy
     * two-sentence prompt + TASK_STEP_CAP (byte-identical to prior behavior).
     */
    adaptivePrompts?: boolean;
    /** M41: optional memory block to inject into the executor prompt. */
    memory?: string;
    /** Optional caller cancellation for this task's model/tool loop. */
    signal?: AbortSignal;
    /** Run-wide authority that reserves a step before any external model call. */
    reserveModelStep?: ReserveModelStep;
    /**
     * M264: optional context prefix prepended to the system prompt.
     * Used by local-context.ts to inject NORTH-STAR + ecosystem map +
     * genome recall + repo tree for local api-model engines (local-coder,
     * local-agent). When absent (default) the system prompt is byte-identical
     * to pre-M264 behavior. Never affects frontier engines.
     */
    systemPrefix?: string;
    /** Local API-model-only hard cap and separately supplied context prefix. */
    initialPromptBudget?: {
      tokenCap: number;
      userPrefix?: string;
      requestSizer?: RequestSizer;
      onSummary?: (summary: RunContextSummary) => void;
    };
    /** Opt-in terminal-response discipline for local API-model execution. */
    continuationPolicy?: { maxCorrectiveNudges: 1 };
    /** Metadata-only notification after a mutating tool effect is committed. */
    onToolEffect?: (effect: { kind: 'mutating'; safety: Exclude<ToolSpec['safety'], 'read' | undefined> }) => void;
    /** Metadata-only harness observation. Never includes tool names, arguments, paths, commands, or results. */
    onHarnessObservation?: (observation: {
      actionClass: HarnessActionClassV1;
      outcome: HarnessObservationOutcomeV1;
    }) => void;
    /** Exact whole-run generation used to bind mutating tool evidence. */
    effectJournal?: { scopeId: string; generation: string };
  },
): Promise<RunTask> {
  // Track per-task usage delta so we can set task.usage at end.
  let taskUsage: RunUsage = task.usage ? { ...task.usage } : newUsage();
  let stepCount = 0;

  // M11: resolve sink — default to nullSink when not provided.
  const sink: StreamSink = ctx.sink ?? nullSink();

  function observeTool(
    safety: ToolSpec['safety'],
    outcome: HarnessObservationOutcomeV1,
  ): void {
    const actionClass: HarnessActionClassV1 = safety === 'read'
      ? 'read'
      : safety === 'exec'
        ? 'exec'
        : safety === 'append' || safety === 'proposal' || safety === 'write'
          ? 'write'
          : 'other';
    try {
      ctx.onHarnessObservation?.({ actionClass, outcome });
    } catch {
      // Observation callbacks are advisory and never affect execution.
    }
  }

  // Helper: emit a RunStreamEvent. Never throws.
  function emitStream(event: Omit<RunStreamEvent, 'ts'>): void {
    try {
      sink({ ...event, ts: new Date().toISOString() });
    } catch {
      // Sinks must never crash the loop.
    }
  }

  // Helper: accumulate ONLY into the local per-task delta.
  //
  // IMPORTANT: ctx.usage is the orchestrator-owned cumulative usage object and
  // the SINGLE source of truth. We deliberately do NOT write to it here.
  // Instead the orchestrator mutates ctx.usage IN PLACE inside its onStep
  // callback (orchestrator.ts) when it receives the model step we emit below.
  // Keeping a single writer (a) prevents double-counting (previously the loop
  // added the delta here AND the orchestrator added the same step.usage again),
  // and (b) preserves the object identity that every in-flight runTask holds,
  // so the in-loop hard-ceiling check overBudget(ctx.usage, ctx.budget) always
  // reads the true global total even under --parallel > 1.
  function accumulateUsage(delta: Partial<RunUsage>): void {
    taskUsage = addUsage(taskUsage, delta);
  }

  // Helper: emit a RunStep.
  function emitStep(
    kind: RunStep['kind'],
    summary: string,
    usage?: RunUsage,
  ): void {
    const step: RunStep = {
      ts: new Date().toISOString(),
      taskId: task.id,
      kind,
      summary,
      ...(usage !== undefined ? { usage } : {}),
    };
    try {
      ctx.onStep(step);
    } catch {
      // onStep must never crash the loop.
    }
  }

  function cancelIfRequested(): boolean {
    if (!ctx.signal?.aborted) return false;
    task.status = 'failed';
    task.error = 'Task cancelled.';
    delete task.result;
    return true;
  }

  function stopForBudget(): void {
    const partial = lastAssistantContent(messages);
    if (partial) {
      task.status = 'done';
      task.result = `[budget exceeded — partial result]\n${partial}`;
    } else {
      task.status = 'failed';
      task.error = 'Budget exceeded before any result was produced.';
    }
  }

  function finalizeReservation(
    reservation: ModelStepReservation | undefined,
    summary: string,
    usage?: { tokensIn: number; tokensOut: number },
  ): void {
    if (!reservation) return;
    try {
      reservation.finalize(summary, usage);
    } catch {
      // Reservation persistence/progress reporting must never crash the loop.
    }
  }

  // Resolve tools: only use them if client supports them AND tools provided.
  const useTools =
    client.supportsTools &&
    ctx.tools !== undefined &&
    ctx.tools.length > 0;
  const toolSpecs = useTools ? (ctx.tools as unknown[]) : undefined;

  // Build a tool executor map keyed by name (best-effort; tools may lack fn).
  const toolExecutors = new Map<string, ToolExecutor>();
  const toolSafety = new Map<string, ToolSpec['safety']>();
  if (useTools && ctx.tools) {
    for (const t of ctx.tools) {
      const spec = t as ToolSpec;
      if (spec.name && typeof spec.fn === 'function') {
        toolExecutors.set(spec.name, spec.fn);
        toolSafety.set(spec.name, spec.safety);
      }
    }
  }

  // M41: model-adaptive system prompt + step cap when enabled; otherwise the
  // legacy literal and TASK_STEP_CAP (unchanged behavior when the flag is off).
  const profile = resolveModelProfile(client.model);
  const useAdaptive = ctx.adaptivePrompts === true;
  const stepCap = useAdaptive ? profile.stepCap : TASK_STEP_CAP;

  let systemContent: string;
  if (useAdaptive) {
    // Assemble the verbosity-tiered prompt layers for this profile.
    let assembled = assembleSystemPrompt({
      role: 'executor',
      useTools,
      profile,
      memory: ctx.memory,
      charCap: profile.promptCharCap,
    }).system;

    // M134: append per-profile roleHint (diff-quality / completeness contract)
    // as a final block so it lands last and overrides any weaker guidance above.
    // Only appended when the roleHint fits within the char budget.
    if (profile.roleHint) {
      const separator = '\n\n';
      const candidate = assembled + separator + profile.roleHint;
      if (candidate.length <= profile.promptCharCap) {
        assembled = candidate;
      }
    }
    systemContent = assembled;
  } else {
    // Flag-OFF: byte-identical to prior behavior.
    systemContent =
      'You are an Ashlr sub-agent. Be concise and focused. ' +
      'Complete the given task directly. ' +
      (useTools
        ? 'You may call tools to gather information; always follow up with a final answer.'
        : 'Do not request tools — respond with a final textual answer only.');
  }

  let userContent = task.goal;
  let initialPromptSummary: RunContextSummary | undefined;
  if (ctx.initialPromptBudget) {
    const bounded = assembleBoundedInitialPrompt({
      baseSystem: systemContent,
      systemPrefix: ctx.systemPrefix,
      userPrefix: ctx.initialPromptBudget.userPrefix,
      goal: task.goal,
      tokenCap: ctx.initialPromptBudget.tokenCap,
      toolCount: toolSpecs?.length ?? 0,
      tools: toolSpecs,
      requestSizer: ctx.initialPromptBudget.requestSizer,
    });
    if (!bounded.ok) {
      task.status = 'failed';
      task.error = bounded.reason;
      task.usage = taskUsage;
      return task;
    }
    systemContent = bounded.system;
    userContent = bounded.user;
    initialPromptSummary = bounded.summary;
    try {
      ctx.initialPromptBudget.onSummary?.(bounded.summary);
    } catch {
      // Telemetry callbacks never affect execution.
    }
  } else if (ctx.systemPrefix && ctx.systemPrefix.length > 0) {
    // Non-local callers retain the pre-existing byte-identical assembly path.
    systemContent = ctx.systemPrefix + '\n\n' + systemContent;
  }

  // Build the initial message list.
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  task.status = 'running';
  let effectOrdinal = 0;
  let toolFreeCorrections = 0;
  let awaitingContinuationCorrection = false;
  let maxSerializedRequestChars = initialPromptSummary?.compression?.outputChars ?? 0;

  try {
    // Main agent loop.
    while (true) {
      if (cancelIfRequested()) break;

      // Pre-step budget check.
      if (overBudget(ctx.usage, ctx.budget)) {
        stopForBudget();
        break;
      }

      // Per-task step cap (safety backstop independent of global budget).
      if (stepCount >= stepCap) {
        if (ctx.continuationPolicy && awaitingContinuationCorrection) {
          task.status = 'failed';
          task.error = 'Model stopped at the step cap after stating continuation intent without completing the task.';
          delete task.result;
          break;
        }
        const partial = lastAssistantContent(messages);
        if (partial) {
          task.status = 'done';
          task.result = `[step cap reached — partial result]\n${partial}`;
        } else {
          task.status = 'failed';
          task.error = `Step cap of ${stepCap} reached without producing a result.`;
        }
        break;
      }

      let requestMessages = messages;
      if (ctx.initialPromptBudget) {
        const charCap = Math.max(256, Math.trunc(ctx.initialPromptBudget.tokenCap) * 4);
        const boundedRequest = boundedMessagesForRequest(
          messages,
          toolSpecs,
          charCap,
          ctx.initialPromptBudget.requestSizer,
        );
        if (!boundedRequest.ok) {
          task.status = 'failed';
          task.error = boundedRequest.reason;
          delete task.result;
          break;
        }
        requestMessages = boundedRequest.messages;
        maxSerializedRequestChars = Math.max(maxSerializedRequestChars, boundedRequest.requestChars);
        if (initialPromptSummary?.prompt) {
          initialPromptSummary = {
            ...initialPromptSummary,
            prompt: {
              ...initialPromptSummary.prompt,
              estimatedPromptTokens: Math.ceil(maxSerializedRequestChars / 4),
              promptBudgetRatio: promptRatio(maxSerializedRequestChars, charCap),
            },
          };
          try {
            ctx.initialPromptBudget.onSummary?.(initialPromptSummary);
          } catch {
            // Telemetry callbacks never affect execution.
          }
        }
      }

      // The authority callback is synchronous: parallel tasks cannot all pass a
      // stale pre-check and overshoot the run-wide ceiling as a whole batch.
      let reservation: ModelStepReservation | undefined;
      if (ctx.reserveModelStep) {
        try {
          reservation = ctx.reserveModelStep();
        } catch (err) {
          task.status = 'failed';
          task.error = `Could not reserve model step: ${String(err)}`;
          break;
        }
        if (!reservation) {
          stopForBudget();
          break;
        }
      }

      stepCount++;
      // A reserved call is already an attempted model step, even if its promise
      // later rejects because cancellation won the in-flight race.
      accumulateUsage({ steps: 1 });

      // M11: Call the model via chatStream when available for live token streaming.
      // Falls back to client.chat() when chatStream is not implemented.
      let result: ChatResult;
      try {
        if (typeof client.chatStream === 'function') {
          // Stream mode: onDelta emits model-delta events for each token chunk.
          result = await client.chatStream(
            requestMessages,
            toolSpecs,
            (chunk: string) => {
              if (!ctx.signal?.aborted && chunk.length > 0) {
                emitStream({ kind: 'model-delta', taskId: task.id, text: chunk });
              }
            },
            ctx.signal,
          );
        } else {
          // Non-streaming fallback: emit the full content as a single delta.
          result = await client.chat(requestMessages, toolSpecs, ctx.signal);
          if (!ctx.signal?.aborted && result.content.length > 0) {
            emitStream({ kind: 'model-delta', taskId: task.id, text: result.content });
          }
        }
      } catch (err) {
        const reportedUsage = usageReportedBy(err);
        if (reportedUsage) accumulateUsage(reportedUsage);
        const summary = ctx.signal?.aborted
          ? 'Model call attempted and cancelled.'
          : `Model call failed: ${truncate(String(err), 100)}`;
        const stepUsage = {
          ...newUsage(),
          ...(reportedUsage ?? {}),
          steps: 1,
        };
        if (reservation) {
          finalizeReservation(reservation, summary, reportedUsage);
        } else {
          emitStep('model', summary, stepUsage);
        }
        if (!cancelIfRequested()) {
          task.status = 'failed';
          task.error = `Model call failed: ${String(err)}`;
        }
        break;
      }

      // Accumulate usage for this model step.
      const stepUsageDelta: Partial<RunUsage> = {
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
      };
      accumulateUsage(stepUsageDelta);
      if (stepCount === 1 && initialPromptSummary?.prompt) {
        initialPromptSummary = {
          ...initialPromptSummary,
          prompt: {
            ...initialPromptSummary.prompt,
            providerPromptTokens: result.usage.tokensIn,
          },
        };
        try {
          ctx.initialPromptBudget?.onSummary?.(initialPromptSummary);
        } catch {
          // Telemetry callbacks never affect execution.
        }
      }

      // Emit model step.
      const modelSummary = result.content
        ? truncate(result.content, 120)
        : result.toolCalls && result.toolCalls.length > 0
          ? `tool calls: ${result.toolCalls.map((tc) => tc.name).join(', ')}`
          : '(empty response)';
      if (reservation) {
        finalizeReservation(reservation, modelSummary, result.usage);
      } else {
        emitStep('model', modelSummary, { ...newUsage(), ...stepUsageDelta, steps: 1 });
      }

      if (cancelIfRequested()) break;

      // Append assistant message.
      messages.push({
        role: 'assistant',
        content: result.content,
      });

      const responseClass = !ctx.continuationPolicy || (result.toolCalls && result.toolCalls.length > 0)
        ? 'complete'
        : classifyToolFreeResponse(result.content);

      // Post-step budget check.
      if (overBudget(ctx.usage, ctx.budget)) {
        if (responseClass === 'continuation-intent') {
          task.status = 'failed';
          task.error = 'Model exhausted the budget after stating continuation intent without completing the task.';
          delete task.result;
          break;
        }
        const partial = result.content || lastAssistantContent(messages);
        if (partial) {
          task.status = 'done';
          task.result = `[budget exceeded — partial result]\n${partial}`;
        } else {
          task.status = 'failed';
          task.error = 'Budget exceeded after model call; no usable result.';
        }
        break;
      }

      // Handle tool calls if present.
      if (result.toolCalls && result.toolCalls.length > 0 && useTools) {
        for (const tc of result.toolCalls) {
          if (cancelIfRequested()) break;

          // M11: emit tool-call stream event before execution.
          emitStream({
            kind: 'tool-call',
            taskId: task.id,
            text: tc.name,
            data: { name: tc.name, arguments: tc.arguments },
          });

          if (cancelIfRequested()) break;

          let toolResultContent: string;
          let toolExecutionFailed = false;
          const executor = toolExecutors.get(tc.name);
          const safety = toolSafety.get(tc.name);

          if (executor) {
            const effectful = safety !== undefined && safety !== 'read';
            if (effectful && !ctx.effectJournal) {
              observeTool(safety, 'refused');
              task.status = 'failed';
              task.error = `Tool effect authority is unavailable for ${tc.name}.`;
              delete task.result;
              emitStep('tool', `${tc.name}: effect authority unavailable`);
              break;
            }
            if (effectful && effectOrdinal >= TASK_EFFECT_CAP) {
              observeTool(safety, 'refused');
              task.status = 'failed';
              task.error = `Tool effect cap exceeded (${TASK_EFFECT_CAP}) for this task.`;
              delete task.result;
              emitStep('tool', `${tc.name}: effect cap exceeded`);
              break;
            }
            const effectInput = effectful && ctx.effectJournal
              ? {
                  ...ctx.effectJournal,
                  taskId: task.id,
                  ordinal: ++effectOrdinal,
                  toolName: tc.name,
                  toolCallId: tc.id,
                  arguments: tc.arguments,
                  safety,
                }
              : undefined;
            const prepared = effectInput ? prepareToolEffect(effectInput) : undefined;
            if (prepared && !prepared.ok) {
              observeTool(safety, 'refused');
              task.status = 'failed';
              task.error = `Tool effect authority refused ${tc.name}: ${prepared.reason}`;
              delete task.result;
              emitStep('tool', `${tc.name}: effect authority ${prepared.reason}`);
              break;
            }
            try {
              const rawResult = await executor(tc.arguments, ctx.signal);
              toolResultContent =
                typeof rawResult === 'string'
                  ? rawResult
                  : JSON.stringify(rawResult);
            } catch (toolErr) {
              if (prepared?.ok) {
                releasePreparedToolEffect(prepared.effect);
                observeTool(safety, 'uncertain');
                task.status = 'failed';
                task.error = `Tool effect outcome is uncertain for ${tc.name}; operator reconciliation is required.`;
                delete task.result;
                emitStep('tool', `${tc.name}: effect outcome uncertain`);
                break;
              }
              observeTool(safety, 'failed');
              toolExecutionFailed = true;
              toolResultContent = `Tool execution error: ${String(toolErr)}`;
            }
            if (prepared?.ok && !commitToolEffect(prepared.effect, toolResultContent)) {
              observeTool(safety, 'uncertain');
              task.status = 'failed';
              task.error = `Tool effect outcome is uncertain for ${tc.name}; operator reconciliation is required.`;
              delete task.result;
              emitStep('tool', `${tc.name}: effect outcome uncertain`);
              break;
            }
            if (!toolExecutionFailed) {
              observeTool(safety, effectful ? 'committed' : 'returned');
            }
            if (effectful) {
              try {
                ctx.onToolEffect?.({
                  kind: 'mutating',
                  safety: safety as Exclude<ToolSpec['safety'], 'read' | undefined>,
                });
              } catch {
                // Metadata callbacks never affect execution.
              }
            }
          } else {
            // No executor — report the tool as unavailable.
            observeTool(safety, 'unavailable');
            toolResultContent = `Tool '${tc.name}' is not available in this context. Please proceed without it.`;
          }

          messages.push({
            role: 'tool',
            content: toolResultContent,
            toolCallId: tc.id,
            name: tc.name,
          });

          // Emit a tool step.
          emitStep('tool', `${tc.name}: ${truncate(toolResultContent, 80)}`);

          if (cancelIfRequested()) break;
        }

        if (cancelIfRequested() || task.status === 'failed') break;

        // Continue the loop to let the model react to tool results.
        awaitingContinuationCorrection = false;
        continue;
      }

      // If there were tool calls but tools are not supported by the client,
      // ask the model to proceed without tools.
      if (result.toolCalls && result.toolCalls.length > 0 && !useTools) {
        for (const tc of result.toolCalls) observeTool(toolSafety.get(tc.name), 'unavailable');
        messages.push({
          role: 'user',
          content:
            'Tool calls are not available in this context. Please provide your final answer using only your existing knowledge.',
        });
        continue;
      }

      if (responseClass === 'continuation-intent') {
        if (toolFreeCorrections >= ctx.continuationPolicy!.maxCorrectiveNudges) {
          task.status = 'failed';
          task.error = 'Model stated continuation intent twice without completing the task.';
          delete task.result;
          break;
        }
        toolFreeCorrections++;
        awaitingContinuationCorrection = true;
        messages.push({
          role: 'user',
          content: 'Complete the next action now. Use a tool if needed, or return a concise final result or explicit blocker; do not narrate an intended future action.',
        });
        continue;
      }

      // No tool calls — this is a final answer.
      if (result.content && result.content.trim().length > 0) {
        awaitingContinuationCorrection = false;
        task.status = 'done';
        task.result = result.content;
        break;
      }

      if (ctx.continuationPolicy && toolFreeCorrections >= ctx.continuationPolicy.maxCorrectiveNudges) {
        task.status = 'failed';
        task.error = 'Model returned an empty response twice without completing the task.';
        delete task.result;
        break;
      }

      // Empty content and no tool calls — one local-only corrective nudge.
      if (ctx.continuationPolicy) {
        toolFreeCorrections++;
        awaitingContinuationCorrection = true;
      }
      messages.push({
        role: 'user',
        content: ctx.continuationPolicy
          ? 'Return a concise final result or explicit blocker now; do not return an empty response.'
          : 'Please provide your answer.',
      });
    }
  } catch (unexpectedErr) {
    // Catch-all: should not reach here, but ensure we never propagate.
    if (!cancelIfRequested()) {
      task.status = 'failed';
      task.error = `Unexpected error in agent loop: ${String(unexpectedErr)}`;
    }
  }

  // Attach accumulated task-level usage.
  task.usage = taskUsage;

  return task;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen, appending '…' if cut. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/**
 * Find the last assistant message content in the message list, if any.
 * Used to preserve partial results when budget runs out mid-loop.
 */
function lastAssistantContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content && m.content.trim().length > 0) {
      return m.content;
    }
  }
  return undefined;
}

/** Best-effort token recovery for providers that attach usage to a rejected call. */
function usageReportedBy(err: unknown): { tokensIn: number; tokensOut: number } | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const usage = (err as { usage?: { tokensIn?: unknown; tokensOut?: unknown } }).usage;
  if (!usage) return undefined;
  const tokensIn = usage.tokensIn;
  const tokensOut = usage.tokensOut;
  if (
    typeof tokensIn !== 'number' ||
    !Number.isFinite(tokensIn) ||
    tokensIn < 0 ||
    typeof tokensOut !== 'number' ||
    !Number.isFinite(tokensOut) ||
    tokensOut < 0
  ) {
    return undefined;
  }
  return { tokensIn, tokensOut };
}
