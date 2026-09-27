/**
 * Command workflows (3.15) — the template half of a `kind: command` playbook.
 *
 * A command workflow is a shell command with named holes:
 *
 *   git switch -c {{branch}} && git push -u origin {{branch}}
 *   gh pr list --state {{state:open}} --limit {{limit:20}}
 *
 * `{{name}}` has no default (the operator must fill it); `{{name:default}}`
 * is prefilled with `default` (which may be empty: `{{name:}}` is an optional
 * hole). The operator fills a form, sees the filled command, and it is PASTED
 * at a terminal prompt — never run. Enter is theirs.
 *
 * PURE and BROWSER-SAFE: the Playbooks view previews as you type, the
 * terminal's picker fills without a round trip, and the server validates the
 * same way on save. No I/O, no Node.
 *
 * SHELL SAFETY — the rules, and why:
 *
 *   1. Every hole is ONE shell word. A filled value is inserted as-is only
 *      when it is a "simple word" (/^[A-Za-z0-9_./:@%+=,-]+$/, not starting
 *      with `=`, which zsh expands to a command path); anything else is
 *      single-quoted with the POSIX `'\''` escape. Inside single quotes
 *      nothing is special to sh / bash / zsh — no `$(…)`, no backticks, no
 *      `;`, no globbing — so a value can never become code. The price: a hole
 *      cannot carry several arguments (`--a --b` becomes one word). That is
 *      deliberate: a form field that can inject arbitrary syntax is a
 *      footgun even when the operator reviews the paste.
 *   2. Single-quoting is only sound where the shell treats quotes as quotes,
 *      so a hole must sit in plain command context (top level, or inside
 *      `$( … )`). The template is lexed and a hole inside '…', "…", $'…',
 *      backticks, a here-document body, or right after a bare `$` is a parse
 *      error ("put it outside the quotes — its value is quoted for you").
 *   3. Values may not contain control characters: no newline or CR (a paste
 *      must never carry a second line the shell could run), no tab (would
 *      trigger completion when typed), no ESC / C1 codes (terminal control
 *      sequences), no bidi override or Unicode line separator (the preview
 *      must read as the paste does). They are refused, not escaped.
 *
 * The quoting is POSIX-shell quoting (sh, bash, zsh — what the Verse
 * terminal runs). fish treats `\'` inside single quotes differently; a value
 * with both `\` and `'` may not survive fish intact (it still cannot execute).
 *
 * `\{{` is a literal `{{` (Go templates: `docker ps --format '\{{.Names}}'`).
 */

/** A hole's name: a letter or `_`, then up to 31 letters, digits, `_` or `-`. */
export const COMMAND_PARAM_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;
/** Distinct holes per template. */
export const MAX_COMMAND_PARAMS = 20;
/** A template's size, in characters. */
export const MAX_COMMAND_TEMPLATE_CHARS = 4096;
/** One filled value, in characters. */
export const MAX_COMMAND_VALUE_CHARS = 1024;

/** A value inserted without quotes. See rule 1 above. */
const SIMPLE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;
/**
 * Bidi embeddings / overrides / isolates and the Unicode line separators:
 * text that would make the preview read differently from what is pasted
 * ("Trojan Source"). Refused in templates and values alike.
 */
function invisibleTrick(c: number): boolean {
  return (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x2028 || c === 0x2029 || c === 0x200e || c === 0x200f;
}
/** C0 controls except newline and tab, DEL, C1 controls and invisibleTrick: never in a template. */
function templateForbidden(s: string): boolean {
  return hasCode(s, (c) => c <= 0x08 || (c >= 0x0b && c <= 0x1f) || (c >= 0x7f && c <= 0x9f) || invisibleTrick(c));
}
/** Every C0 control (newline and tab included), DEL, C1 and invisibleTrick: never in a value. */
function valueForbidden(s: string): boolean {
  return hasCode(s, (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || invisibleTrick(c));
}
/** Char-code scans instead of control-character regexes (eslint no-control-regex). */
function hasCode(s: string, bad: (code: number) => boolean): boolean {
  for (let i = 0; i < s.length; i += 1) if (bad(s.charCodeAt(i))) return true;
  return false;
}
/** Stands for a hole while the template is lexed. NUL cannot occur in a valid template. */
const HOLE = '\u0000';

export interface CommandParam {
  name: string;
  /** null = no default: the operator must fill it in. '' = optional, empty by default. */
  default: string | null;
}

export interface CommandTemplateParse {
  /** Distinct holes, in first-appearance order. */
  params: CommandParam[];
  /** Operator-language problems; [] = the template is usable. */
  errors: string[];
}

/** Thrown by fillCommandTemplate for an invalid template or an unsafe value. */
export class CommandTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandTemplateError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizing: text and holes
// ---------------------------------------------------------------------------

type Piece = { kind: 'text'; text: string } | { kind: 'hole'; name: string; default: string | null; raw: string };

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function tokenize(text: string, errors: string[]): Piece[] {
  const pieces: Piece[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\{{', i)) {
      buf += '{{';
      i += 3;
      continue;
    }
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      if (close === -1) {
        errors.push(`Line ${lineAt(text, i)}: \`{{\` is never closed with \`}}\` (write \`\\{{\` for a literal \`{{\`).`);
        buf += text.slice(i);
        break;
      }
      const inner = text.slice(i + 2, close);
      const raw = `{{${inner}}}`;
      if (/[\r\n]/.test(inner)) {
        errors.push(`Line ${lineAt(text, i)}: a placeholder must fit on one line.`);
        buf += raw;
      } else {
        const colon = inner.indexOf(':');
        const name = (colon === -1 ? inner : inner.slice(0, colon)).trim();
        const def = colon === -1 ? null : inner.slice(colon + 1).trim();
        if (!COMMAND_PARAM_NAME_PATTERN.test(name)) {
          errors.push(
            `Line ${lineAt(text, i)}: \`${raw.slice(0, 40)}\` is not a placeholder — a name is a letter or _ then up to 31 letters, digits, _ or - `
            + '(write `\\{{` for a literal `{{`).',
          );
          buf += raw;
        } else {
          const problem = def === null ? null : commandValueProblem(def);
          if (problem) errors.push(`Line ${lineAt(text, i)}: the default of \`${name}\` ${problem}`);
          if (buf) pieces.push({ kind: 'text', text: buf });
          buf = '';
          pieces.push({ kind: 'hole', name, default: def, raw });
        }
      }
      i = close + 2;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  if (buf) pieces.push({ kind: 'text', text: buf });
  return pieces;
}

// ---------------------------------------------------------------------------
// Lexing: which shell context each hole sits in (rule 2)
// ---------------------------------------------------------------------------

type HoleContext = 'plain' | 'comment' | 'single' | 'double' | 'backtick' | 'heredoc' | 'dollar';
type Frame = { t: 'single' } | { t: 'ansi' } | { t: 'double' } | { t: 'backtick' } | { t: 'cmdsub'; depth: number };

/** Characters that end a word (and so may precede a `#` comment). */
const WORD_BREAK = /[\s;&|()<>]/;

/**
 * The shell context of each HOLE in `s`, in order. A small, conservative
 * POSIX lexer: quotes, escapes, $'…', "…", `…`, $( … ) (nested), comments and
 * here-documents. It only needs to be right about where a hole may go; when
 * unsure it reports a quoted context, which refuses rather than guesses.
 */
function holeContexts(s: string): HoleContext[] {
  const out: HoleContext[] = [];
  const stack: Frame[] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  const top = (): Frame | null => stack[stack.length - 1] ?? null;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const frame = top();
    if (c === HOLE) {
      if (frame === null || frame.t === 'cmdsub') {
        const prev = s[i - 1];
        out.push(prev === '$' && s[i - 2] !== '\\' ? 'dollar' : 'plain');
      } else {
        out.push(frame.t === 'ansi' ? 'single' : frame.t);
      }
      i += 1;
      continue;
    }
    if (frame?.t === 'single') {
      if (c === "'") stack.pop();
      i += 1;
      continue;
    }
    if (frame?.t === 'ansi') {
      if (c === '\\') i += 2;
      else {
        if (c === "'") stack.pop();
        i += 1;
      }
      continue;
    }
    if (frame?.t === 'double') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') stack.pop();
      else if (c === '`') stack.push({ t: 'backtick' });
      else if (c === '$' && s[i + 1] === '(') { stack.push({ t: 'cmdsub', depth: 0 }); i += 2; continue; }
      i += 1;
      continue;
    }
    // Command context: top level, $( … ) or ` … `.
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { stack.push({ t: 'single' }); i += 1; continue; }
    if (c === '"') { stack.push({ t: 'double' }); i += 1; continue; }
    if (c === '$' && s[i + 1] === "'") { stack.push({ t: 'ansi' }); i += 2; continue; }
    if (c === '$' && s[i + 1] === '(') { stack.push({ t: 'cmdsub', depth: 0 }); i += 2; continue; }
    if (c === '`') {
      if (frame?.t === 'backtick') stack.pop();
      else stack.push({ t: 'backtick' });
      i += 1;
      continue;
    }
    if (frame?.t === 'cmdsub' && c === '(') { frame.depth += 1; i += 1; continue; }
    if (frame?.t === 'cmdsub' && c === ')') {
      if (frame.depth === 0) stack.pop();
      else frame.depth -= 1;
      i += 1;
      continue;
    }
    if (c === '#' && (i === 0 || WORD_BREAK.test(s[i - 1]!))) {
      // A comment runs to the end of the line; a hole there is inert text.
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      for (let j = i; j < stop; j += 1) if (s[j] === HOLE) out.push('comment');
      i = stop;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j += 1;
      while (s[j] === ' ' || s[j] === '\t') j += 1;
      let word = '';
      while (j < s.length && !WORD_BREAK.test(s[j]!)) { word += s[j]; j += 1; }
      // A hole in the delimiter itself is refused as a here-document hole.
      for (const ch of word) if (ch === HOLE) out.push('heredoc');
      const delim = word.split(HOLE).join('').replace(/['"\\]/g, '');
      if (delim) heredocs.push({ delim, strip });
      i = j;
      continue;
    }
    if (c === '\n' && heredocs.length > 0) {
      // The bodies start on the next line, one after another.
      let pos = i + 1;
      for (const doc of heredocs.splice(0)) {
        while (pos < s.length) {
          const nl = s.indexOf('\n', pos);
          const lineEnd = nl === -1 ? s.length : nl;
          const line = s.slice(pos, lineEnd);
          pos = nl === -1 ? s.length : nl + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
          for (const ch of line) if (ch === HOLE) out.push('heredoc');
        }
      }
      i = pos;
      continue;
    }
    i += 1;
  }
  return out;
}

const CONTEXT_PROBLEM: Record<Exclude<HoleContext, 'plain' | 'comment'>, string> = {
  single: 'is inside quotes — put it outside them; its value is quoted for you.',
  double: 'is inside quotes — put it outside them; its value is quoted for you.',
  backtick: 'is inside backticks — use $( … ) instead.',
  heredoc: 'is inside a here-document, where quoting does not apply.',
  dollar: 'follows a bare `$` — a placeholder is a whole word, not part of a variable.',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Why `value` cannot fill a hole, or null when it can. Rule 3. */
export function commandValueProblem(value: string): string | null {
  if (valueForbidden(value)) return 'contains a line break, tab or control character — a pasted command is one line of text.';
  if (value.length > MAX_COMMAND_VALUE_CHARS) return `is longer than ${MAX_COMMAND_VALUE_CHARS} characters.`;
  return null;
}

/** One value as one shell word: simple words as-is, anything else single-quoted. Rule 1. Pure. */
export function quoteShellValue(value: string): string {
  if (SIMPLE_WORD.test(value) && !value.startsWith('=')) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parsePieces(text: string): { pieces: Piece[]; params: CommandParam[]; errors: string[] } {
  const errors: string[] = [];
  if (typeof text !== 'string' || !text.trim()) return { pieces: [], params: [], errors: ['The command is empty.'] };
  if (text.length > MAX_COMMAND_TEMPLATE_CHARS) {
    return { pieces: [], params: [], errors: [`The command is longer than ${MAX_COMMAND_TEMPLATE_CHARS} characters.`] };
  }
  if (templateForbidden(text)) return { pieces: [], params: [], errors: ['The command contains a control character.'] };
  const pieces = tokenize(text, errors);
  const params: CommandParam[] = [];
  const byName = new Map<string, CommandParam>();
  for (const p of pieces) {
    if (p.kind !== 'hole') continue;
    const seen = byName.get(p.name);
    if (!seen) {
      const param = { name: p.name, default: p.default };
      byName.set(p.name, param);
      params.push(param);
    } else if (p.default !== null) {
      if (seen.default === null) seen.default = p.default;
      else if (seen.default !== p.default) errors.push(`\`${p.name}\` has two different defaults.`);
    }
  }
  if (params.length > MAX_COMMAND_PARAMS) errors.push(`At most ${MAX_COMMAND_PARAMS} different placeholders.`);
  const flat = pieces.map((p) => (p.kind === 'text' ? p.text : HOLE)).join('');
  const contexts = holeContexts(flat);
  const holes = pieces.filter((p): p is Extract<Piece, { kind: 'hole' }> => p.kind === 'hole');
  const reported = new Set<string>();
  holes.forEach((hole, index) => {
    const context = contexts[index] ?? 'double';
    if (context === 'plain' || context === 'comment') return;
    const message = `\`${hole.raw.slice(0, 40)}\` ${CONTEXT_PROBLEM[context]}`;
    if (!reported.has(message)) errors.push(message);
    reported.add(message);
  });
  return { pieces, params, errors };
}

/**
 * The holes of a template, and what is wrong with it. Never throws. Pure.
 * `errors: []` means fillCommandTemplate will accept it.
 */
export function parseCommandTemplate(text: string): CommandTemplateParse {
  const { params, errors } = parsePieces(text);
  return { params, errors };
}

function valueFor(values: Readonly<Record<string, string>>, param: CommandParam): string {
  // Own string properties only: `constructor` is a valid hole name.
  const own = Object.prototype.hasOwnProperty.call(values, param.name) ? values[param.name] : undefined;
  if (typeof own === 'string') return own;
  return param.default ?? '';
}

/**
 * Per-hole problems for a set of values: a hole with no default left empty
 * ("required"), or a value that breaks rule 3. [] = fillable. Pure.
 */
export function commandValueIssues(params: readonly CommandParam[], values: Readonly<Record<string, string>>): CommandValueIssue[] {
  const issues: CommandValueIssue[] = [];
  for (const param of params) {
    const value = valueFor(values, param);
    const problem = commandValueProblem(value);
    if (problem) issues.push({ name: param.name, message: `\`${param.name}\` ${problem}`, required: false });
    else if (param.default === null && value === '') issues.push({ name: param.name, message: `Fill in \`${param.name}\`.`, required: true });
  }
  return issues;
}

export interface CommandValueIssue {
  name: string;
  message: string;
  /** true = only "left empty" (a hole with no default); false = the value itself is refused. */
  required: boolean;
}

/**
 * The command with every hole filled — each value as ONE shell word (rule 1);
 * a missing value falls back to the hole's default, then to '' (inserted as
 * `''`, an explicit empty argument). No trailing newline: the result is
 * pasted, never submitted. Throws CommandTemplateError for an invalid
 * template or a value with a control character — never returns an unsafe
 * command. Pure.
 */
export function fillCommandTemplate(text: string, values: Readonly<Record<string, string>>): string {
  const { pieces, params, errors } = parsePieces(text);
  if (errors.length > 0) throw new CommandTemplateError(errors[0]!);
  const byName = new Map(params.map((p) => [p.name, p]));
  let out = '';
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      out += piece.text;
      continue;
    }
    const value = valueFor(values, byName.get(piece.name)!);
    const problem = commandValueProblem(value);
    if (problem) throw new CommandTemplateError(`\`${piece.name}\` ${problem}`);
    out += quoteShellValue(value);
  }
  return out.replace(/\s+$/, '');
}

/**
 * The command as the form's preview shows it: each hole filled like
 * fillCommandTemplate, except a required hole still empty (or a refused
 * value) shows as `<name>`. For display only — paste fillCommandTemplate's
 * result, never this. Pure; never throws.
 */
export function previewCommandTemplate(text: string, values: Readonly<Record<string, string>> = {}): string {
  const { pieces, params } = parsePieces(text);
  const byName = new Map(params.map((p) => [p.name, p]));
  return pieces.map((piece) => {
    if (piece.kind === 'text') return piece.text;
    const param = byName.get(piece.name)!;
    const value = valueFor(values, param);
    if (commandValueProblem(value) || (param.default === null && value === '')) return `<${piece.name}>`;
    return quoteShellValue(value);
  }).join('').replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// The `## Command` section: one fenced code block
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})([^`]*)$/;

/**
 * The template inside a `## Command` section's body, which must be exactly
 * one fenced code block (``` or ~~~, any info string). Pure.
 */
export function extractCommandFence(body: string): { ok: true; template: string } | { ok: false; error: string } {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i += 1;
  const open = i < lines.length ? FENCE_OPEN.exec(lines[i]!) : null;
  if (!open) return { ok: false, error: '“## Command” holds one fenced code block (```) with the command in it.' };
  const ch = open[1]![0]!;
  const len = open[1]!.length;
  const content: string[] = [];
  let closed = -1;
  for (let j = i + 1; j < lines.length; j += 1) {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
    if (m && m[1]![0] === ch && m[1]!.length >= len) {
      closed = j;
      break;
    }
    content.push(lines[j]!);
  }
  if (closed === -1) return { ok: false, error: 'The code block in “## Command” is never closed.' };
  if (lines.slice(closed + 1).some((l) => l.trim())) {
    return { ok: false, error: '“## Command” holds exactly one code block and nothing else — put notes in `description`.' };
  }
  const template = content.join('\n').replace(/\s+$/, '');
  if (!template.trim()) return { ok: false, error: 'The code block in “## Command” is empty.' };
  return { ok: true, template };
}

/** A fence that cannot occur inside `template` (CommonMark: longer than any backtick run in it). Pure. */
export function commandFenceFor(template: string): string {
  const longest = Math.max(0, ...(template.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * A command workflow as markdown, for reading (the Playbooks view and
 * `GET /api/verse/playbooks/<id>`'s `rendered`): the command block, then its
 * parameters. Never an engine prompt. Pure.
 */
export function renderCommandWorkflowMarkdown(name: string, spec: { template: string; params: readonly CommandParam[] }): string {
  const fence = commandFenceFor(spec.template);
  const lines = [`## Command workflow: ${name}`, '', `${fence}sh`, spec.template, fence];
  if (spec.params.length > 0) {
    lines.push('', '### Parameters');
    for (const p of spec.params) {
      lines.push(`- \`${p.name}\`${p.default === null ? ' — required' : p.default === '' ? ' — optional' : ` — default \`${p.default.replace(/`/g, "'")}\``}`);
    }
  }
  lines.push('', 'Filled in, it is pasted at a terminal prompt — never run. You press Enter.');
  return lines.join('\n');
}
