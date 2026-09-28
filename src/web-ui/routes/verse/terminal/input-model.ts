/**
 * terminal/input-model.ts — the input editor's pure rules (3.15): when it is
 * shown, what Enter sends, the ghost text, ↑/↓ through history, which word is
 * a path to complete, and `#` → plain language. No DOM, no CodeMirror
 * (command-editor.ts is the lazily loaded editor; CommandInput.tsx the glue).
 */

/**
 * Where the shell is, from its OSC 133 marks as xterm parsed them:
 *   A → drawing a prompt, B → waiting for input, C → running, D → done.
 * The editor is offered only at `input` — after B, before C.
 */
export type PromptPhase = 'unknown' | 'prompt' | 'input' | 'running' | 'done';

export function nextPromptPhase(phase: PromptPhase, markPayload: string): PromptPhase {
  const code = markPayload.split(';', 1)[0];
  switch (code) {
    case 'A': return 'prompt';
    case 'B': return 'input';
    case 'C': return 'running';
    case 'D': return 'done';
    default: return phase;
  }
}

export interface InputVisibility {
  phase: PromptPhase;
  /** The integration is live: without marks there is no telling where a prompt is. */
  integration: boolean;
  alternateScreen: boolean;
  exited: boolean;
  /** Raw input for this shell (the operator's own line editor, untouched). */
  raw: boolean;
  /** The operator typed into the terminal itself at this prompt: it is theirs until the next one. */
  handedOff: boolean;
  /** The terminal view is showing (not the Blocks view). */
  terminalMode: boolean;
}

export function inputVisible(v: InputVisibility): boolean {
  return v.integration && v.phase === 'input' && !v.alternateScreen && !v.exited && !v.raw && !v.handedOff && v.terminalMode;
}

/**
 * Terminal replies xterm sends through onData on the program's behalf
 * (cursor position, device attributes, focus in/out) — not the operator
 * typing, so they never hand the prompt over to the raw terminal.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_REPLY_RE = /^(?:\x1b\[\??[\d;]*[Rcn]|\x1b\[[IO]|\x1b\][\s\S]*(?:\x07|\x1b\\)|\x1bP[\s\S]*\x1b\\)+$/;

export function isOperatorKeystroke(data: string): boolean {
  return data.length > 0 && !TERMINAL_REPLY_RE.test(data);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_IN_PASTE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * What Enter sends to the PTY. One line: the text and a CR, exactly as if
 * typed. Several lines: as ONE bracketed paste then CR when the shell asked
 * for bracketed paste (zsh, bash ≥ 5.1, fish do) — so the shell sees one
 * command, not a line-by-line run — else line by line (each line a CR,
 * which is what typing it would do). Control characters other than tab and
 * newline are dropped: a stray ESC must not end the paste early.
 */
export function submitBytes(text: string, bracketedPaste: boolean): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(UNSAFE_IN_PASTE_RE, '').replace(/\n+$/, '');
  if (!clean.includes('\n')) return `${clean}\r`;
  if (bracketedPaste) return `\x1b[200~${clean}\x1b[201~\r`;
  return `${clean.replace(/\n/g, '\r')}\r`;
}

/** Hand the line to the shell's own editor (no Enter): what Esc / Tab / ⌃R-again do. */
export function handOffBytes(text: string, key: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(UNSAFE_IN_PASTE_RE, '');
  if (!clean) return key;
  // Several lines can only arrive whole as a bracketed paste; otherwise send the first.
  const line = clean.includes('\n') ? `\x1b[200~${clean}\x1b[201~` : clean;
  return `${line}${key}`;
}

/**
 * Ghost text: the best history command that starts with what is typed (the
 * list comes ranked from the server: cwd, repo, success, recency), shown
 * after the cursor. Only for one line with something typed.
 */
export function ghostFor(text: string, ranked: readonly string[]): string | null {
  if (text.trim().length === 0 || text.includes('\n')) return null;
  for (const cmd of ranked) {
    if (cmd.length > text.length && cmd.startsWith(text)) return cmd;
  }
  return null;
}

/**
 * ↑ / ↓ through history, like a shell: ↑ from the draft goes to the most
 * recent command (optionally only those starting with the draft), ↓ past the
 * newest returns to the draft.
 */
export class HistoryWalker {
  private index = -1;
  private draft = '';
  private matches: string[] = [];

  constructor(private readonly source: () => readonly string[]) {}

  get active(): boolean {
    return this.index >= 0;
  }

  reset(): void {
    this.index = -1;
    this.draft = '';
    this.matches = [];
  }

  /** The text to show after ↑, or null to stay (nothing older). */
  prev(current: string): string | null {
    if (this.index < 0) {
      this.draft = current;
      const prefix = current.trim();
      const all = this.source();
      this.matches = prefix ? all.filter((c) => c.startsWith(prefix) && c !== current) : [...all];
    }
    if (this.index + 1 >= this.matches.length) return null;
    this.index += 1;
    return this.matches[this.index]!;
  }

  /** The text to show after ↓, or null when not walking. */
  next(): string | null {
    if (this.index < 0) return null;
    this.index -= 1;
    return this.index < 0 ? this.draft : this.matches[this.index]!;
  }
}

/** `#…` (or `# …`) is a request in plain language, not a command; null when it is not one. */
export function assistRequest(text: string): string | null {
  const m = /^\s*#\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const request = m[1]!.trim();
  return request.length > 0 ? request : null;
}

// ---------------------------------------------------------------------------
// Path completion
// ---------------------------------------------------------------------------

/** The word being typed at `cursor`, when it looks like a path (has a `/`, or starts with `.` or `~`). */
export function pathToken(text: string, cursor: number): { from: number; token: string } | null {
  const before = text.slice(0, cursor);
  // A word starts after unescaped whitespace or a shell operator.
  let from = before.length;
  while (from > 0) {
    const ch = before[from - 1]!;
    if (/[\s;|&<>()`'"=]/.test(ch) && before[from - 2] !== '\\') break;
    from -= 1;
  }
  const token = before.slice(from);
  if (!token || !(token.includes('/') || token.startsWith('.') || token.startsWith('~'))) return null;
  return { from, token };
}

function splitSegments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0 && s !== '.');
}

/** POSIX `relative(from, to)` for absolute (or `~/`) paths, without node:path. */
export function relativePath(from: string, to: string): string {
  const a = splitSegments(from);
  const b = splitSegments(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const ups = a.length - i;
  const rest = b.slice(i);
  const parts = [...Array.from({ length: ups }, () => '..'), ...rest];
  return parts.join('/') || '.';
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

/**
 * The composer's file index lists files relative to a chat root. For the
 * word being typed in `cwd`, the candidates it names — files, and the
 * directories on the way to them — spelled relative to `cwd` (or as typed,
 * for `~/` and absolute words). Ranked: the next path segment first.
 */
export function pathCompletions(token: string, cwd: string | null, files: ReadonlyArray<{ path: string; root: string }>, limit = 30): string[] {
  const out = new Set<string>();
  const typedAbsolute = token.startsWith('/') || token.startsWith('~');
  for (const f of files) {
    const abs = joinPath(f.root, f.path);
    let spelled: string;
    if (typedAbsolute) {
      spelled = token.startsWith('~') && abs.startsWith('~') ? abs : token.startsWith('/') && abs.startsWith('/') ? abs : '';
      if (!spelled) continue;
    } else {
      if (!cwd) continue;
      spelled = relativePath(cwd, abs);
      if (token.startsWith('./') && !spelled.startsWith('.')) spelled = `./${spelled}`;
    }
    if (!spelled.startsWith(token)) continue;
    // Offer the next segment: a directory (with its slash) or the file itself.
    const rest = spelled.slice(token.length);
    const slash = rest.indexOf('/');
    out.add(slash >= 0 ? spelled.slice(0, token.length + slash + 1) : spelled);
    if (out.size >= limit) break;
  }
  return [...out].sort((x, y) => Number(y.endsWith('/')) - Number(x.endsWith('/')) || x.length - y.length || x.localeCompare(y));
}

/** The search the file index is asked for a word: its last segment (the index matches names and paths). */
export function fileIndexQuery(token: string): string {
  const segments = token.split('/').filter((s) => s && s !== '.' && s !== '..' && s !== '~');
  return segments.join('/');
}
