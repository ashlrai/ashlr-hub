/**
 * Markdown parsers for the Goal Loop milestone-file contract.
 *
 * Two inputs are parsed here (see docs/MILESTONE-CONTRACT.md):
 *  - the roadmap INDEX file: milestones in dependency order, one markdown link per
 *    line (e.g. `- [M0](M0-bootstrap.md)`), via {@link parseRoadmap}.
 *  - each MILESTONE file: `- [ ]`/`- [x]` checkbox steps with stable ids (M0.1),
 *    a `Done when:` check per step, and an `Acceptance checklist (gate)` section,
 *    via {@link parseMilestone}.
 *
 * The repo carries no markdown library, so these are deliberately small,
 * tolerant, hand-rolled line scanners (mirroring the hand-parsing style of
 * src/core/run/orchestrator.ts `parseTaskList`). They never throw on shape — a
 * malformed file yields empty/partial structures the caller can reject.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { MilestoneDoc, MilestoneStep, RoadmapEntry, RoadmapIndex } from './types.js';

// ---------------------------------------------------------------------------
// Shared line patterns
// ---------------------------------------------------------------------------

/** A markdown heading: `#`…`######` + text. */
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
/** A checkbox list item: `- [ ]` / `- [x]` (also `*`). Captures (mark, label). */
const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
/** A plain (non-checkbox) bullet: `- text` / `* text`. Captures (text). */
const BULLET_RE = /^\s*[-*]\s+(?!\[[ xX]\])(.+)$/;
/** A stable step id at the start of a checkbox label: `M0.1`, `M2.4 …`. */
const STEP_ID_RE = /^(M\d+(?:\.\d+)+)\b[\s:.)\-]*\s*(.*)$/;
/** A `Done when:` verifiable check (case-insensitive). Captures the check text. */
const DONE_WHEN_RE = /done when:\s*(.*)$/i;
/** A markdown link inside a list item: `[label](target)`. */
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
/** Heading text that marks the acceptance gate section. */
const GATE_HEADING_RE = /acceptance|gate/i;
/** A milestone id token (e.g. `M0`, `M12`) at the start of a label. */
const MILESTONE_ID_RE = /^(M\d+)\b/;

/** Split file content into lines, tolerant of CRLF (Windows) and LF. */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Roadmap index
// ---------------------------------------------------------------------------

/** Candidate index filenames tried (in order) when none is given explicitly. */
const DEFAULT_ROADMAP_NAMES = ['roadmap.md', 'ROADMAP.md', 'README.md'];

/**
 * Resolve the roadmap index path from a directory + optional explicit filename.
 * Returns an absolute path (not guaranteed to exist — the caller reads it).
 */
export function resolveRoadmapPath(dir: string, roadmapFile?: string): string {
  const base = resolve(dir);
  if (roadmapFile && roadmapFile.trim()) {
    const f = roadmapFile.trim();
    return isAbsolute(f) ? f : resolve(base, f);
  }
  // Default name; existence is the caller's concern (parseRoadmap reports clearly).
  return resolve(base, DEFAULT_ROADMAP_NAMES[0] as string);
}

/**
 * Parse the roadmap INDEX file into ordered milestone entries.
 *
 * Recognises list items that link to a `.md` milestone file, in two forms:
 *   - `- [M0](M0-bootstrap.md)`            (markdown link; preferred)
 *   - `- M0: M0-bootstrap.md`              (plain `id: file.md` fallback)
 *
 * Order is preserved verbatim (dependency order). Non-matching lines are ignored,
 * so prose/headings around the list are fine. Throws only if the index file
 * cannot be read.
 */
export function parseRoadmap(dir: string, roadmapFile?: string): RoadmapIndex {
  const path = resolveRoadmapPath(dir, roadmapFile);
  const base = resolve(dir);
  const content = readFileSync(path, 'utf8');
  const milestones: RoadmapEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of splitLines(content)) {
    const line = rawLine.trim();
    if (!line.startsWith('-') && !line.startsWith('*')) continue;

    let id: string | null = null;
    let title = '';
    let target: string | null = null;

    const link = LINK_RE.exec(line);
    if (link) {
      title = (link[1] as string).trim();
      target = (link[2] as string).trim();
    } else {
      // Fallback: `- M0: some-file.md`
      const plain = /^[-*]\s+(M\d+)\b[\s:.)\-]*\s*(\S+\.md)\s*$/.exec(line);
      if (plain) {
        id = plain[1] as string;
        title = id;
        target = (plain[2] as string).trim();
      }
    }

    if (!target || !target.toLowerCase().endsWith('.md')) continue;

    if (!id) {
      const m = MILESTONE_ID_RE.exec(title);
      id = m ? (m[1] as string) : title;
    }
    if (seen.has(id)) continue; // first occurrence wins
    seen.add(id);

    const file = isAbsolute(target) ? target : resolve(dirname(path), target);
    milestones.push({ id, title, file });
  }

  return { path, dir: base, milestones };
}

// ---------------------------------------------------------------------------
// Milestone file
// ---------------------------------------------------------------------------

/**
 * Scan forward from a step's checkbox line for its `Done when:` check. Looks on
 * the checkbox label itself first, then following lines up to the next checkbox,
 * heading, or blank-gap boundary. Returns the check text, or null if absent.
 */
function findDoneWhen(lines: string[], startIdx: number, label: string): string | null {
  const onLabel = DONE_WHEN_RE.exec(label);
  if (onLabel) return (onLabel[1] as string).trim();

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (HEADING_RE.test(line) || CHECKBOX_RE.test(line)) break;
    const m = DONE_WHEN_RE.exec(line);
    if (m) return (m[1] as string).trim();
  }
  return null;
}

/**
 * Parse a MILESTONE markdown file into steps + acceptance gate.
 *
 * - Title is the first heading (falls back to `id`).
 * - Steps are checkbox lines whose label starts with a stable step id (`M0.1`).
 *   Their `checked` flag and source `lineIndex` are recorded so the runner can
 *   tick them in place. Each step's `Done when:` is captured when present.
 * - Gate items are the bullets/checkboxes under the first heading matching
 *   "acceptance"/"gate". Step-id checkboxes inside the gate section are treated
 *   as gate items, not steps.
 *
 * `id` is taken from the parsed steps' shared prefix when not supplied; pass the
 * id from the roadmap entry for authority. Throws only if the file can't be read.
 */
export function parseMilestone(path: string, id?: string): MilestoneDoc {
  const abs = resolve(path);
  const content = readFileSync(abs, 'utf8');
  const lines = splitLines(content);

  let title = '';
  const steps: MilestoneStep[] = [];
  const gate: string[] = [];
  let inGate = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = (heading[2] as string).trim();
      if (!title) title = text;
      inGate = GATE_HEADING_RE.test(text);
      continue;
    }

    const checkbox = CHECKBOX_RE.exec(line);
    if (checkbox) {
      const label = (checkbox[2] as string).trim();
      if (inGate) {
        gate.push(label);
        continue;
      }
      const stepMatch = STEP_ID_RE.exec(label);
      if (stepMatch) {
        steps.push({
          id: stepMatch[1] as string,
          text: (stepMatch[2] as string).trim(),
          doneWhen: findDoneWhen(lines, i, label),
          checked: (checkbox[1] as string).toLowerCase() === 'x',
          lineIndex: i,
        });
      }
      continue;
    }

    if (inGate) {
      const bullet = BULLET_RE.exec(line);
      if (bullet) gate.push((bullet[1] as string).trim());
    }
  }

  const resolvedId = id ?? deriveMilestoneId(steps) ?? title ?? abs;
  return { id: resolvedId, title: title || resolvedId, path: abs, steps, gate, lines };
}

/** Derive a milestone id (`M0`) from the common prefix of step ids (`M0.1`,`M0.2`). */
function deriveMilestoneId(steps: MilestoneStep[]): string | null {
  for (const s of steps) {
    const m = MILESTONE_ID_RE.exec(s.id);
    if (m) return m[1] as string;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checkbox writing (format-aware; used by the driver to reconcile ticks)
// ---------------------------------------------------------------------------

/**
 * Return a NEW lines array with the checkboxes for `completedIds` ticked (`[x]`).
 * Only flips unchecked → checked; never unticks. Operates on the recorded
 * `lineIndex` of each step so the rest of the file is byte-preserved.
 *
 * Returns `{ lines, changed }` — `changed` is true iff at least one box flipped,
 * letting the caller skip a no-op disk write.
 */
export function tickSteps(
  doc: MilestoneDoc,
  completedIds: string[],
): { lines: string[]; changed: boolean } {
  const want = new Set(completedIds);
  const lines = doc.lines.slice();
  let changed = false;

  for (const step of doc.steps) {
    if (!want.has(step.id) || step.checked) continue;
    const idx = step.lineIndex;
    const line = lines[idx];
    if (line === undefined) continue;
    const ticked = line.replace(/(\[)[ ](\])/, '$1x$2');
    if (ticked !== line) {
      lines[idx] = ticked;
      changed = true;
    }
  }

  return { lines, changed };
}
