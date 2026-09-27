/**
 * Playbook markdown ⇄ structure — parsing, validation, canonical form.
 *
 * PURE and BROWSER-SAFE (the editor validates as you type): no I/O, no Node.
 *
 * Format:
 *
 *   ---
 *   id: fix-issue
 *   name: Fix a reported bug
 *   macro: !fix-bug
 *   description: Reproduce, fix at the root, prove it with a test.
 *   kinds: [fix]
 *   repos: []
 *   globs: []
 *   auto: false
 *   budget-usd: 5
 *   budget-minutes: 60
 *   done-when:
 *     - A regression test fails before the fix and passes after it
 *   ---
 *   ## Outcome
 *   …
 *   ## Procedure
 *   …
 *
 * WHY a hand-rolled front-matter reader instead of YAML: the grammar is a
 * dozen flat keys, `yaml` is a dev dependency only, and a strict small reader
 * gives precise errors ("line 4: unknown key") instead of YAML's surprises
 * (`macro: !fix-bug` is a YAML tag; `no` is a boolean).
 *
 * The STORED form is always `serializePlaybook(parse(source))`, so two edits
 * that differ only in spacing or key order produce the same sha.
 */
import { TASK_KINDS, type TaskKind } from '../learn/retro/types.js';
import {
  PLAYBOOK_ID_PATTERN,
  PLAYBOOK_MACRO_PATTERN,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_SECTIONS,
  REQUIRED_PLAYBOOK_SECTIONS,
  type PlaybookMeta,
  type PlaybookParseResult,
  type PlaybookSectionName,
  type PlaybookSections,
  type PlaybookValidationIssue,
} from './types.js';

const KNOWN_KEYS = new Set([
  'id', 'name', 'macro', 'description', 'kinds', 'repos', 'globs', 'auto', 'budget-usd', 'budget-minutes', 'done-when',
]);
const LIST_KEYS = new Set(['kinds', 'repos', 'globs', 'done-when']);

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 200;
const MAX_LIST = 20;
const MAX_ITEM = 200;

function utf8Length(s: string): number {
  // TextEncoder exists in browsers and Node alike.
  return new TextEncoder().encode(s).length;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function inlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(unquote).filter((s) => s.length > 0);
}

interface RawFrontMatter {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

function readFrontMatter(lines: string[], errors: PlaybookValidationIssue[]): { raw: RawFrontMatter; bodyStart: number } | null {
  if (lines[0]?.trim() !== '---') {
    errors.push({ field: 'front-matter', message: 'A playbook starts with a `---` front-matter block.' });
    return null;
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) {
    errors.push({ field: 'front-matter', message: 'The front-matter block is not closed with `---`.' });
    return null;
  }
  const raw: RawFrontMatter = { scalars: new Map(), lists: new Map() };
  let openList: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item) {
      if (!openList) {
        errors.push({ field: 'front-matter', message: `Line ${i + 1}: a list item needs a key above it.` });
        continue;
      }
      raw.lists.get(openList)!.push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push({ field: 'front-matter', message: `Line ${i + 1}: expected \`key: value\`.` });
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    openList = null;
    if (!KNOWN_KEYS.has(key)) {
      errors.push({ field: key, message: `Line ${i + 1}: unknown key \`${key}\`.` });
      continue;
    }
    if (raw.scalars.has(key) || raw.lists.has(key)) {
      errors.push({ field: key, message: `Line ${i + 1}: \`${key}\` appears twice.` });
      continue;
    }
    if (LIST_KEYS.has(key)) {
      if (value === '') {
        raw.lists.set(key, []);
        openList = key;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        raw.lists.set(key, inlineList(value));
      } else {
        raw.lists.set(key, [unquote(value)]);
      }
    } else {
      raw.scalars.set(key, unquote(value));
    }
  }
  return { raw, bodyStart: end + 1 };
}

function canonicalSection(heading: string): PlaybookSectionName | null {
  const h = heading.trim().replace(/:$/, '').toLowerCase();
  return PLAYBOOK_SECTIONS.find((s) => s.toLowerCase() === h) ?? null;
}

function readSections(lines: string[], start: number, errors: PlaybookValidationIssue[], warnings: PlaybookValidationIssue[]): PlaybookSections {
  const sections: PlaybookSections = {};
  let current: PlaybookSectionName | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      const text = buf.join('\n').replace(/^\s*\n/, '').trimEnd();
      if (text.trim()) sections[current] = text;
    }
    buf = [];
  };
  let preamble = false;
  let inFence = false;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h2 = inFence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 && !/^###/.test(line)) {
      flush();
      const name = canonicalSection(h2[1]!);
      if (!name) {
        errors.push({ field: 'sections', message: `Unknown section “## ${h2[1]}”. Use: ${PLAYBOOK_SECTIONS.join(', ')}.` });
        current = null;
        continue;
      }
      if (sections[name] !== undefined) {
        errors.push({ field: name, message: `“## ${name}” appears twice.` });
      }
      current = name;
      continue;
    }
    if (current) buf.push(line);
    else if (line.trim() && !/^#\s/.test(line)) preamble = true;
  }
  flush();
  if (preamble) warnings.push({ field: 'sections', message: 'Text before the first `##` section is ignored.' });
  return sections;
}

function numberOrNull(raw: string | undefined, field: string, max: number, errors: PlaybookValidationIssue[]): number | null {
  if (raw === undefined || raw === '' || raw === 'null') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    errors.push({ field, message: `\`${field}\` must be a number between 0 and ${max}.` });
    return null;
  }
  return Math.round(n * 100) / 100;
}

function cleanList(values: string[] | undefined, field: string, errors: PlaybookValidationIssue[]): string[] {
  const list = (values ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length > MAX_LIST) errors.push({ field, message: `\`${field}\` has more than ${MAX_LIST} entries.` });
  for (const v of list) {
    if (v.length > MAX_ITEM) errors.push({ field, message: `An entry in \`${field}\` is longer than ${MAX_ITEM} characters.` });
  }
  return [...new Set(list)].slice(0, MAX_LIST);
}

/** Parse and validate one playbook source. Never throws. */
export function parsePlaybook(source: string): PlaybookParseResult {
  const errors: PlaybookValidationIssue[] = [];
  const warnings: PlaybookValidationIssue[] = [];
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, errors: [{ field: 'source', message: 'The playbook is empty.' }] };
  }
  if (utf8Length(source) > PLAYBOOK_MAX_BYTES) {
    return { ok: false, errors: [{ field: 'source', message: `A playbook is at most ${PLAYBOOK_MAX_BYTES / 1024} KiB.` }] };
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const fm = readFrontMatter(lines, errors);
  if (!fm) return { ok: false, errors };
  const { scalars, lists } = fm.raw;

  const id = (scalars.get('id') ?? '').trim();
  if (!PLAYBOOK_ID_PATTERN.test(id)) {
    errors.push({ field: 'id', message: '`id` is required: 2–48 lowercase letters, digits or dashes.' });
  }
  const name = (scalars.get('name') ?? '').trim();
  if (!name) errors.push({ field: 'name', message: '`name` is required.' });
  else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `\`name\` is at most ${MAX_NAME} characters.` });
  const macroRaw = (scalars.get('macro') ?? '').trim();
  const macro = (macroRaw ? (macroRaw.startsWith('!') ? macroRaw : `!${macroRaw}`) : `!${id}`).toLowerCase();
  if (!PLAYBOOK_MACRO_PATTERN.test(macro)) {
    errors.push({ field: 'macro', message: '`macro` is `!` followed by 2–48 lowercase letters, digits or dashes.' });
  }
  const description = (scalars.get('description') ?? '').trim();
  if (description.length > MAX_DESCRIPTION) {
    errors.push({ field: 'description', message: `\`description\` is at most ${MAX_DESCRIPTION} characters.` });
  }
  const kinds = cleanList(lists.get('kinds'), 'kinds', errors).map((k) => k.toLowerCase());
  const badKind = kinds.find((k) => !(TASK_KINDS as readonly string[]).includes(k));
  if (badKind) errors.push({ field: 'kinds', message: `Unknown task kind \`${badKind}\`. Use: ${TASK_KINDS.join(', ')}.` });
  const repos = cleanList(lists.get('repos'), 'repos', errors);
  const badRepo = repos.find((r) => !REPO_PATTERN.test(r));
  if (badRepo) errors.push({ field: 'repos', message: `\`${badRepo}\` is not an \`owner/name\` repo.` });
  const globs = cleanList(lists.get('globs'), 'globs', errors).map((g) => g.replace(/^\.\//, ''));
  if (globs.some((g) => g.startsWith('/') || g.split('/').includes('..'))) {
    errors.push({ field: 'globs', message: 'Globs are repo-relative (no leading `/`, no `..`).' });
  }
  const autoRaw = (scalars.get('auto') ?? 'false').toLowerCase();
  if (autoRaw !== 'true' && autoRaw !== 'false') errors.push({ field: 'auto', message: '`auto` is `true` or `false`.' });
  const auto = autoRaw === 'true';
  const doneWhen = cleanList(lists.get('done-when'), 'done-when', errors);
  const budget = {
    usd: numberOrNull(scalars.get('budget-usd'), 'budget-usd', 1000, errors),
    minutes: numberOrNull(scalars.get('budget-minutes'), 'budget-minutes', 24 * 60, errors),
  };
  if (auto && kinds.length === 0 && repos.length === 0) {
    errors.push({ field: 'auto', message: '`auto: true` needs `kinds` or `repos` — a playbook that matches every task is not a playbook.' });
  }

  const sections = readSections(lines, fm.bodyStart, errors, warnings);
  for (const required of REQUIRED_PLAYBOOK_SECTIONS) {
    if (!sections[required]) errors.push({ field: required, message: `“## ${required}” is required.` });
  }

  if (errors.length > 0) return { ok: false, errors };
  const meta: PlaybookMeta = {
    id,
    name,
    macro,
    description,
    appliesTo: { repos, globs },
    taskKinds: kinds as TaskKind[],
    doneWhen,
    budget,
    auto,
  };
  return { ok: true, meta, sections, warnings };
}

function listLines(key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((v) => `  - ${v}`)];
}

/** The canonical markdown for a playbook. Pure; `parse(serialize(x))` round-trips. */
export function serializePlaybook(meta: PlaybookMeta, sections: PlaybookSections): string {
  const fm = [
    '---',
    `id: ${meta.id}`,
    `name: ${meta.name}`,
    `macro: ${meta.macro}`,
    ...(meta.description ? [`description: ${meta.description}`] : []),
    `kinds: [${meta.taskKinds.join(', ')}]`,
    `repos: [${meta.appliesTo.repos.join(', ')}]`,
    // A glob like `src/{a,b}/**` carries commas: the block form keeps it whole.
    ...(meta.appliesTo.globs.some((g) => /[,[\]]/.test(g))
      ? listLines('globs', meta.appliesTo.globs)
      : [`globs: [${meta.appliesTo.globs.join(', ')}]`]),
    `auto: ${meta.auto ? 'true' : 'false'}`,
    ...(meta.budget.usd !== null ? [`budget-usd: ${meta.budget.usd}`] : []),
    ...(meta.budget.minutes !== null ? [`budget-minutes: ${meta.budget.minutes}`] : []),
    ...listLines('done-when', meta.doneWhen),
    '---',
  ];
  const body: string[] = [];
  for (const name of PLAYBOOK_SECTIONS) {
    const text = sections[name];
    if (!text) continue;
    body.push(`## ${name}`, '', text.trim(), '');
  }
  return `${fm.join('\n')}\n\n${body.join('\n').trimEnd()}\n`;
}

/** Parse then re-serialize. The form the store writes. */
export function canonicalizePlaybook(source: string): PlaybookParseResult & { source?: string } {
  const parsed = parsePlaybook(source);
  if (!parsed.ok) return parsed;
  return { ...parsed, source: serializePlaybook(parsed.meta, parsed.sections) };
}

/** A blank playbook for "New playbook". Pure. */
export function playbookTemplate(id = 'my-playbook'): string {
  return serializePlaybook(
    {
      id,
      name: 'New playbook',
      macro: `!${id}`,
      description: 'What this playbook is for, in one line.',
      appliesTo: { repos: [], globs: [] },
      taskKinds: [],
      doneWhen: ['The project’s own test command passes'],
      budget: { usd: null, minutes: null },
      auto: false,
    },
    {
      Outcome: 'What is true when this is done.',
      Procedure: '1. First step.\n2. Second step.',
      Specifications: '- Constraints the result must meet.',
      Advice: '- Tips that make this go well.',
      'Forbidden actions': '- Do not weaken or skip tests.',
      'Required from user': '- What the task description must include.',
    },
  );
}
