/**
 * The planner-to-worker handoff.
 *
 * A deep phase (one slot, 262,144 tokens) reads widely and then throws almost
 * all of it away. What crosses to each worker in the wide phase (four slots,
 * 65,536 each) is this object. See docs/LOCAL-CONTEXT-STRATEGY.md.
 *
 * The rules below are enforced in code rather than documented as advice,
 * because every one of them was learned by watching it go wrong:
 *
 *   1. APPEND-ONLY. A worker prompt that gains content at the FRONT on each
 *      turn changes the prompt prefix and invalidates llama-server's entire
 *      cached prefix. That is the defect that reprocessed 23,301 tokens a turn
 *      against a conversation growing by ~300, and it produced correct output
 *      the whole time — so nothing failed, it was just slow. `appendFinding`
 *      is the only way to add to a handoff, and `renderHandoff` emits sections
 *      in a fixed order with findings last.
 *
 *   2. PATHS, NOT CONTENTS. A worker has a filesystem. A path and a line range
 *      costs ~10 tokens where the file costs thousands, and the file it reads
 *      itself is current where a pasted copy is a snapshot that can already be
 *      stale. `validateHandoff` rejects a reference that looks like it carries
 *      file contents.
 *
 *   3. A CONSTRAINT KEEPS ITS REASON. "Do not change the public signature"
 *      invites a worker to decide the rule looks obsolete. "...because three
 *      callers outside this repo depend on it" does not. `reason` is required,
 *      not optional, so compaction cannot quietly drop it.
 *
 *   4. A HANDOFF THAT IS TOO BIG IS A PLANNING FAILURE. If a worker needs the
 *      planner's full reading to proceed, the plan was not finished. That is
 *      not a transport problem to be solved with compression, so the budget
 *      here is a hard validation error rather than a warning.
 */

/** A place in the tree the worker should look, named rather than pasted. */
export interface HandoffFileRef {
  /** Repo-relative path. Never file contents. */
  readonly path: string;
  /** Optional 1-indexed inclusive line range to look at first. */
  readonly lines?: { readonly from: number; readonly to: number };
  /** Why this file is in the list, in a few words. */
  readonly why?: string;
}

/** A rule the worker must not violate, and the reason it exists. */
export interface HandoffConstraint {
  readonly rule: string;
  /** REQUIRED. A rule without its reason gets reasoned away. */
  readonly reason: string;
}

export interface WorkerHandoff {
  /** Stable id for this unit of work; also the worker's label. */
  readonly id: string;
  /** The task, stated so it can be done without asking a question back. */
  readonly task: string;
  /** Files the worker will touch or must read. Paths only. */
  readonly files: readonly HandoffFileRef[];
  readonly constraints: readonly HandoffConstraint[];
  /** What decides whether this worked — a command, or an observable outcome. */
  readonly check: string;
  /**
   * Things learned DURING the work. Append-only: never reorder, never insert
   * above. Rendered last for exactly that reason.
   */
  readonly findings?: readonly string[];
}

/**
 * Hard ceiling on a rendered handoff.
 *
 * 6,000 characters is roughly 1,500 tokens, about 2% of a worker's 65,536-token
 * slot. A handoff that does not fit was not compacted; it was forwarded.
 */
export const HANDOFF_MAX_CHARS = 6_000;

/** Longest a single reference's path may be before it is obviously not a path. */
const MAX_PATH_CHARS = 400;

export interface HandoffProblem {
  readonly field: string;
  readonly detail: string;
}

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Does this `path` actually look like somebody pasted a file into it?
 *
 * Deliberately shape-based rather than length-based alone: a newline or a brace
 * in a path is the giveaway, and both are things a real path essentially never
 * has while pasted source essentially always does.
 */
function looksLikeContents(path: string): boolean {
  if (path.length > MAX_PATH_CHARS) return true;
  return /[\n\r{};]/.test(path);
}

/**
 * Check a handoff against every rule above. Returns the problems; an empty
 * array means it is safe to send.
 *
 * Returns problems rather than throwing, so a planner can fix and retry instead
 * of losing the phase to an exception.
 */
export function validateHandoff(handoff: WorkerHandoff): readonly HandoffProblem[] {
  const problems: HandoffProblem[] = [];

  if (blank(handoff.id)) problems.push({ field: 'id', detail: 'required' });
  if (blank(handoff.task)) {
    problems.push({ field: 'task', detail: 'required — a worker cannot ask you what you meant' });
  }
  if (blank(handoff.check)) {
    problems.push({
      field: 'check',
      detail: 'required — without it nobody can tell whether the work succeeded, '
        + 'and in a fan-out nobody reads four transcripts',
    });
  }

  if (!Array.isArray(handoff.files) || handoff.files.length === 0) {
    problems.push({ field: 'files', detail: 'name at least one file; "find it yourself" wastes a turn' });
  } else {
    handoff.files.forEach((ref, index) => {
      if (blank(ref?.path)) {
        problems.push({ field: `files[${index}].path`, detail: 'required' });
        return;
      }
      if (looksLikeContents(ref.path)) {
        problems.push({
          field: `files[${index}].path`,
          detail: 'looks like file CONTENTS, not a path — send the path and let the worker read '
            + 'the current file; a pasted copy is a snapshot that can already be stale',
        });
      }
      const lines = ref.lines;
      if (lines && (!Number.isInteger(lines.from) || !Number.isInteger(lines.to) || lines.from < 1 || lines.to < lines.from)) {
        problems.push({ field: `files[${index}].lines`, detail: 'must be 1-indexed with from <= to' });
      }
    });
  }

  (handoff.constraints ?? []).forEach((c, index) => {
    if (blank(c?.rule)) problems.push({ field: `constraints[${index}].rule`, detail: 'required' });
    if (blank(c?.reason)) {
      problems.push({
        field: `constraints[${index}].reason`,
        detail: 'required — a rule without its reason gets reasoned away by the worker',
      });
    }
  });

  // Size is checked LAST and on the rendered form, because that is what the
  // worker actually pays for.
  const size = renderHandoff(handoff).length;
  if (size > HANDOFF_MAX_CHARS) {
    problems.push({
      field: 'handoff',
      detail: `${size} chars exceeds the ${HANDOFF_MAX_CHARS} budget — a handoff this large means `
        + 'the plan is not finished, not that it needs compressing',
    });
  }

  return problems;
}

function renderFile(ref: HandoffFileRef): string {
  const range = ref.lines ? `:${ref.lines.from}-${ref.lines.to}` : '';
  const why = ref.why ? `  (${ref.why})` : '';
  return `- ${ref.path}${range}${why}`;
}

/**
 * Render the handoff as the worker's prompt.
 *
 * Section order is FIXED and findings come last. That is not cosmetic: it is
 * what keeps the prompt append-only across turns, so llama-server can reuse the
 * cached prefix instead of reprocessing the whole context every turn.
 */
export function renderHandoff(handoff: WorkerHandoff): string {
  const parts: string[] = [`## Task\n${handoff.task.trim()}`];

  if (handoff.files.length > 0) {
    parts.push(`## Files\n${handoff.files.map(renderFile).join('\n')}`);
  }

  if ((handoff.constraints ?? []).length > 0) {
    const rules = handoff.constraints
      .map((c) => `- ${c.rule.trim()}\n  Why: ${c.reason.trim()}`)
      .join('\n');
    parts.push(`## Constraints\n${rules}`);
  }

  parts.push(`## Done when\n${handoff.check.trim()}`);

  // LAST, always. Everything above is stable across turns; this is the only
  // section that grows, so the prefix above it stays byte-identical.
  const findings = handoff.findings ?? [];
  if (findings.length > 0) {
    parts.push(`## Found along the way\n${findings.map((f) => `- ${f.trim()}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Add something learned during the work.
 *
 * The ONLY supported mutation. Returns a new handoff with the finding appended,
 * so the rendered prefix above it is unchanged and the cache still holds.
 */
export function appendFinding(handoff: WorkerHandoff, finding: string): WorkerHandoff {
  if (blank(finding)) return handoff;
  return { ...handoff, findings: [...(handoff.findings ?? []), finding.trim()] };
}

/**
 * Did `next` grow from `previous` by appending only?
 *
 * The guard for rule 1. Compares the rendered forms, because that is what the
 * model sees and therefore what the prefix cache keys on.
 */
export function isAppendOnly(previous: WorkerHandoff, next: WorkerHandoff): boolean {
  return renderHandoff(next).startsWith(renderHandoff(previous));
}

/** Rough token estimate for budgeting. Four characters per token. */
export function estimateHandoffTokens(handoff: WorkerHandoff): number {
  return Math.ceil(renderHandoff(handoff).length / 4);
}
