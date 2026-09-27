/**
 * Which playbook applies to a task, and the block an engine reads.
 *
 * Resolution order (first hit wins):
 *   1. explicit   the caller named one (`--playbook`, the Leader's `playbook`
 *                 param, "Use playbook…"): `id`, `!macro`, or pinned `id@v3`.
 *   2. macro      the task text mentions `!fix-bug` (or `!<id>`, or pinned
 *                 `!fix-bug@v3`) — the first known macro in the text.
 *   3. auto       a playbook with `auto: true` whose kinds / repos / globs all
 *                 match the task (most specific first, then id).
 *
 * Unknown macros are ignored (`!important` in a CSS task stays text). Macros
 * inside code spans and fenced blocks are ignored.
 *
 * The rendered block is appended AFTER the task text and BEFORE any delivery
 * contract; with no playbook the prompt is returned byte-identical.
 */
import { classifyTaskKind, repoMatches } from '../learn/retro/inject.js';
import { getPlaybook, getPlaybookSync, listLatestPlaybooks, listLatestPlaybooksSync } from './store.js';
import {
  PLAYBOOK_INJECT_CAP_BYTES,
  PLAYBOOK_SECTIONS,
  formatPlaybookRef,
  parsePlaybookRefText,
  type PlaybookMatch,
  type PlaybookRef,
  type PlaybookSectionName,
  type PlaybookV1,
  type TaskKind,
} from './types.js';

export interface PlaybookTarget {
  /** A playbook the caller named: `id`, `!macro`, `id@v3`. Unknown ⇒ resolution fails (see `resolveExplicit`). */
  explicit?: string | null;
  /** The task text (title + body) — scanned for `!macros` and used to infer kind. */
  text: string;
  /** `owner/name` or an absolute checkout path. */
  repo: string | null;
  kind?: TaskKind | null;
}

export interface ResolvedPlaybook {
  playbook: PlaybookV1;
  ref: PlaybookRef;
  match: PlaybookMatch;
}

/** What resolution wants before the version is read. */
export interface PlaybookChoice {
  id: string;
  version: number | null;
  match: PlaybookMatch;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Text with code spans and fenced blocks blanked, so `!x` in code is not a macro. */
function proseOnly(text: string): string {
  return text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** `!name` / `!name@v3` mentions, in order. Pure. */
export function findMacroMentions(text: string): { name: string; version: number | null }[] {
  const out: { name: string; version: number | null }[] = [];
  const re = /(^|[\s>])!([a-z0-9][a-z0-9-]{1,47})(?:@v?(\d{1,6}))?(?![A-Za-z0-9_-])/gm;
  for (const m of proseOnly(text ?? '').matchAll(re)) {
    out.push({ name: m[2]!.toLowerCase(), version: m[3] ? Number(m[3]) : null });
  }
  return out;
}

/** The playbook a macro name refers to: its macro, else its id. */
function byMacro(catalog: readonly PlaybookV1[], name: string): PlaybookV1 | null {
  return catalog.find((p) => p.meta.macro === `!${name}`) ?? catalog.find((p) => p.meta.id === name) ?? null;
}

function globPrefix(glob: string): string {
  const i = glob.search(/[*?{[]/);
  return (i === -1 ? glob : glob.slice(0, i)).toLowerCase().replace(/\/$/, '');
}

/** Does an auto playbook apply to this task? Pure. */
export function autoMatches(pb: PlaybookV1, target: PlaybookTarget): boolean {
  const m = pb.meta;
  if (!m.auto || (m.taskKinds.length === 0 && m.appliesTo.repos.length === 0)) return false;
  if (m.appliesTo.repos.length > 0 && !m.appliesTo.repos.some((r) => repoMatches(r, target.repo))) return false;
  if (m.taskKinds.length > 0) {
    const kind = target.kind ?? classifyTaskKind(target.text);
    if (!m.taskKinds.includes(kind)) return false;
  }
  if (m.appliesTo.globs.length > 0) {
    const text = (target.text ?? '').toLowerCase();
    const prefixes = m.appliesTo.globs.map(globPrefix).filter((p) => p.length >= 3);
    if (prefixes.length === 0 || !prefixes.some((p) => text.includes(p))) return false;
  }
  return true;
}

/**
 * A pluggable auto-matcher (e.g. a model-backed decider). It only ever sees
 * playbooks Mason switched to `auto: true`, and its pick is used only at or
 * above `minConfidence`; otherwise the deterministic match below decides.
 * Must be synchronous and cheap (fleet goal assembly calls it).
 */
export type PlaybookAutoMatcher = (
  candidates: readonly PlaybookV1[],
  target: PlaybookTarget,
) => { id: string; confidence: number } | null;

export interface RegisteredMatcher {
  fn: PlaybookAutoMatcher;
  minConfidence: number;
}

let registeredMatcher: RegisteredMatcher | null = null;

/** Install (or with null, remove) the auto-matcher. Default gate: confidence ≥ 0.8. */
export function registerPlaybookAutoMatcher(fn: PlaybookAutoMatcher | null, opts: { minConfidence?: number } = {}): void {
  const min = typeof opts.minConfidence === 'number' && Number.isFinite(opts.minConfidence) ? Math.min(1, Math.max(0, opts.minConfidence)) : 0.8;
  registeredMatcher = fn ? { fn, minConfidence: min } : null;
}

function matcherPick(candidates: readonly PlaybookV1[], target: PlaybookTarget, matcher: RegisteredMatcher | null): PlaybookV1 | null {
  if (!matcher || candidates.length === 0) return null;
  try {
    const pick = matcher.fn(candidates, target);
    if (!pick || typeof pick.confidence !== 'number' || pick.confidence < matcher.minConfidence) return null;
    return candidates.find((p) => p.meta.id === pick.id) ?? null;
  } catch {
    return null;
  }
}

function specificity(pb: PlaybookV1): number {
  return (pb.meta.appliesTo.repos.length ? 4 : 0) + (pb.meta.appliesTo.globs.length ? 2 : 0) + (pb.meta.taskKinds.length ? 1 : 0);
}

/**
 * Pick a playbook from the latest versions. Pure. An explicit name that
 * matches nothing returns `{ unknown }` so a caller can refuse instead of
 * silently running without the playbook it asked for.
 */
export function choosePlaybook(
  catalog: readonly PlaybookV1[],
  target: PlaybookTarget,
  matcher: RegisteredMatcher | null = registeredMatcher,
): PlaybookChoice | { unknown: string } | null {
  const explicit = typeof target.explicit === 'string' ? target.explicit.trim() : '';
  if (explicit) {
    const parsed = parsePlaybookRefText(explicit);
    const pb = parsed ? byMacro(catalog, parsed.id) : null;
    if (!parsed || !pb) return { unknown: explicit };
    return { id: pb.meta.id, version: parsed.version, match: 'explicit' };
  }
  for (const mention of findMacroMentions(target.text)) {
    const pb = byMacro(catalog, mention.name);
    if (pb) return { id: pb.meta.id, version: mention.version, match: 'macro' };
  }
  const picked = matcherPick(catalog.filter((p) => p.meta.auto), target, matcher);
  if (picked) return { id: picked.meta.id, version: null, match: 'auto' };
  const auto = catalog.filter((p) => autoMatches(p, target))
    .sort((a, b) => specificity(b) - specificity(a) || a.meta.id.localeCompare(b.meta.id));
  return auto[0] ? { id: auto[0].meta.id, version: null, match: 'auto' } : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

export const PLAYBOOK_BLOCK_PREAMBLE =
  'Follow this playbook for the task above. The task decides WHAT to change; the playbook says HOW. '
  + 'If they conflict, the task wins — say so in your report.';

/** Sections dropped first when a block would pass the cap (never cut mid-line). */
const DROP_ORDER: readonly PlaybookSectionName[] = ['Advice', 'Specifications', 'Required from user'];

function budgetLine(pb: PlaybookV1): string | null {
  const { usd, minutes } = pb.meta.budget;
  if (usd === null && minutes === null) return null;
  const parts = [usd !== null ? `$${usd}` : null, minutes !== null ? `${minutes} minutes` : null].filter(Boolean);
  return `Aim to finish within ${parts.join(' / ')}. If you expect to exceed that, stop and report instead of pushing on.`;
}

/** The block an engine reads. Pure. Never exceeds PLAYBOOK_INJECT_CAP_BYTES. */
export function renderPlaybookBlock(pb: PlaybookV1, capBytes: number = PLAYBOOK_INJECT_CAP_BYTES): string {
  const build = (skip: ReadonlySet<PlaybookSectionName>): string => {
    const lines = [
      `## Playbook: ${pb.meta.name} (${pb.meta.macro} · ${formatPlaybookRef({ id: pb.meta.id, version: pb.version })})`,
      PLAYBOOK_BLOCK_PREAMBLE,
    ];
    for (const name of PLAYBOOK_SECTIONS) {
      const text = pb.sections[name];
      if (!text || skip.has(name)) continue;
      lines.push('', `### ${name}`, text.trim());
      if (name === 'Required from user') {
        lines.push('If the task above is missing any of this, stop and report what is missing instead of guessing.');
      }
    }
    if (pb.meta.doneWhen.length > 0) lines.push('', '### Done when', ...pb.meta.doneWhen.map((d) => `- ${d}`));
    const budget = budgetLine(pb);
    if (budget) lines.push('', '### Budget', budget);
    return lines.join('\n');
  };
  const skip = new Set<PlaybookSectionName>();
  let text = build(skip);
  for (const name of DROP_ORDER) {
    if (utf8(text) <= capBytes) break;
    skip.add(name);
    text = build(skip);
  }
  return utf8(text) <= capBytes ? text : '';
}

export function refOf(pb: PlaybookV1): PlaybookRef {
  return { id: pb.meta.id, version: pb.version, sha: pb.sha };
}

/** Append a rendered block to a prompt. '' block ⇒ the prompt, byte-identical. Pure. */
export function appendPlaybookBlock(prompt: string, block: string): string {
  return block ? `${prompt}\n\n${block}` : prompt;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ResolveOutcome =
  | { ok: true; resolved: ResolvedPlaybook | null }
  | { ok: false; error: string };

function unknownError(name: string): string {
  return `There is no playbook called “${name.slice(0, 60)}”. Run \`ashlr playbook list\` or open Playbooks in Verse.`;
}

function versionError(id: string, version: number): string {
  return `The playbook “${id}” has no version ${version}.`;
}

/** Resolve for a task (async — Verse routes, launch services). Never throws. */
export async function resolvePlaybook(target: PlaybookTarget, catalog?: readonly PlaybookV1[]): Promise<ResolveOutcome> {
  try {
    const choice = choosePlaybook(catalog ?? (await listLatestPlaybooks()), target);
    if (!choice) return { ok: true, resolved: null };
    if ('unknown' in choice) return { ok: false, error: unknownError(choice.unknown) };
    const pb = await getPlaybook(choice.id, choice.version);
    if (!pb) return choice.version !== null ? { ok: false, error: versionError(choice.id, choice.version) } : { ok: true, resolved: null };
    return { ok: true, resolved: { playbook: pb, ref: refOf(pb), match: choice.match } };
  } catch {
    return { ok: true, resolved: null };
  }
}

/** Synchronous twin for synchronous prompt builders. A bad pin resolves to nothing. Never throws. */
export function resolvePlaybookSync(target: PlaybookTarget, catalog?: readonly PlaybookV1[]): ResolvedPlaybook | null {
  try {
    const choice = choosePlaybook(catalog ?? listLatestPlaybooksSync(), target);
    if (!choice || 'unknown' in choice) return null;
    const pb = getPlaybookSync(choice.id, choice.version);
    return pb ? { playbook: pb, ref: refOf(pb), match: choice.match } : null;
  } catch {
    return null;
  }
}
