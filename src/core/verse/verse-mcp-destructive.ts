/**
 * core/verse/verse-mcp-destructive.ts — which agent-typed commands need the
 * operator's yes before they reach a shell (3.15 agent tools).
 *
 * CONSERVATIVE BY DESIGN. This reads a command line as text — it is not a
 * shell parser, and a determined model can always spell a command so it does
 * not match (a script file, an alias, base64). It exists to stop the common,
 * honest-mistake and prompt-injected cases in front of a human, not to be a
 * sandbox: a false positive costs the operator one click, a false negative
 * leaves the command to the seat's own permission mode. So:
 *   - the line is split on `;`, `&&`, `||`, `|`, `&` and newlines (quotes
 *     respected), and each segment's program is found past env assignments
 *     and wrappers (`env`, `command`, `nohup`, `time`, `exec`, `xargs`);
 *   - an inline `sh|bash|zsh -c '…'` / `eval '…'` body is classified too;
 *   - rm -rf and pipe-to-shell are ALSO matched on the raw text, so quoting
 *     tricks that defeat the splitter still ask.
 *
 * EXFIL. Commands that send data to another host (curl with a body or upload,
 * nc, scp/rsync/sftp to a remote, ssh with a command, git push, gist, s3 cp,
 * mail) are only asked about AFTER the turn read content from a non-loopback
 * origin (a remote page in the Browser pane, a remote fetch in the terminal):
 * that is when an injected instruction is most likely to try to ship
 * something out. A destination that is loopback-only never counts.
 *
 * Pure: no IO.
 */

export interface DestructiveMatch {
  /** Stable id: "Allow for chat" allows this rule. */
  rule: string;
  /** One sentence for the confirmation card. */
  reason: string;
}

/** Split a command line into pipeline segments, keeping which operator joined each to the previous one. */
export function splitCommand(line: string): Array<{ text: string; pipedFrom: boolean }> {
  const out: Array<{ text: string; pipedFrom: boolean }> = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let pipedFrom = false;
  const push = (nextPiped: boolean): void => {
    if (current.trim().length > 0) out.push({ text: current.trim(), pipedFrom });
    current = '';
    pipedFrom = nextPiped;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { current += ch + line[i + 1]; i += 1; continue; }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) { current += ch + line[i + 1]; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '\n' || ch === ';') { push(false); continue; }
    if (ch === '&') {
      if (line[i + 1] === '&') i += 1;
      push(false);
      continue;
    }
    if (ch === '|') {
      if (line[i + 1] === '|') { i += 1; push(false); continue; }
      if (line[i + 1] === '&') i += 1;
      push(true);
      continue;
    }
    current += ch;
  }
  push(false);
  return out;
}

/** Shell-ish word split with quotes removed (good enough for flags and program names). */
export function words(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) { current += segment[i + 1]; i += 1; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (ch === '\\' && i + 1 < segment.length) { current += segment[i + 1]; i += 1; any = true; continue; }
    if (/\s/.test(ch)) {
      if (current.length > 0 || any) out.push(current);
      current = '';
      any = false;
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || any) out.push(current);
  return out;
}

const WRAPPERS = new Set(['env', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'caffeinate', 'xargs', 'watch', 'timeout', 'gtimeout']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'osascript']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh']);

function basename(word: string): string {
  const slash = word.lastIndexOf('/');
  return (slash >= 0 ? word.slice(slash + 1) : word).toLowerCase();
}

/** The program and its arguments, past env assignments and wrappers (and their numeric/flag operands). */
export function programOf(argv: string[]): { program: string; args: string[]; sudo: boolean } {
  let i = 0;
  let sudo = false;
  while (i < argv.length) {
    const word = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i += 1; continue; }
    const name = basename(word);
    if (name === 'sudo' || name === 'doas' || name === 'su') {
      sudo = true;
      i += 1;
      while (i < argv.length && argv[i]!.startsWith('-')) {
        // sudo -u <user> / -g <group> take a value.
        if (/^-[ugCDhpRT]$/.test(argv[i]!)) i += 1;
        i += 1;
      }
      continue;
    }
    if (WRAPPERS.has(name)) {
      i += 1;
      while (i < argv.length && (argv[i]!.startsWith('-') || /^\d+[smhd]?$/.test(argv[i]!))) i += 1;
      continue;
    }
    break;
  }
  const program = i < argv.length ? basename(argv[i]!) : '';
  return { program, args: argv.slice(i + 1), sudo };
}

function hasShortFlag(args: string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
}

/** Hosts a command names (URLs and user@host:path / host:path forms). */
export function hostsIn(args: string[]): string[] {
  const hosts: string[] = [];
  for (const arg of args) {
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#\s]+)/i.exec(arg);
    if (url) { hosts.push(url[1]!.replace(/^[^@]*@/, '').toLowerCase()); continue; }
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)/.exec(arg);
    if (scp && !arg.startsWith('-')) hosts.push(scp[1]!.toLowerCase());
  }
  return hosts;
}

export function isLoopbackName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0';
}

function remoteHosts(args: string[]): string[] {
  return hostsIn(args).filter((h) => !isLoopbackName(h));
}

/** Rules that always ask. */
function destructiveInSegment(argv: string[], pipedFrom: boolean, previous: string[] | null): DestructiveMatch[] {
  const out: DestructiveMatch[] = [];
  const { program, args, sudo } = programOf(argv);
  if (sudo) out.push({ rule: 'sudo', reason: 'It runs with administrator rights (sudo).' });
  switch (program) {
    case 'rm':
    case 'rmdir': {
      const recursive = hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || hasFlag(args, '--recursive');
      const force = hasShortFlag(args, 'f') || hasFlag(args, '--force');
      if (program === 'rm' && recursive && force) out.push({ rule: 'rm-recursive', reason: 'It deletes files recursively without asking (rm -rf).' });
      else if (program === 'rm' && recursive) out.push({ rule: 'rm-recursive', reason: 'It deletes a directory tree (rm -r).' });
      break;
    }
    case 'find':
      if (hasFlag(args, '-delete') || (args.includes('-exec') && args.some((a) => basename(a) === 'rm'))) {
        out.push({ rule: 'find-delete', reason: 'It deletes every file find matches.' });
      }
      break;
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'));
      const rest = sub ? args.slice(args.indexOf(sub) + 1) : [];
      if (sub === 'push' && (hasFlag(rest, '--force', '--force-with-lease', '--mirror', '--delete') || hasShortFlag(rest, 'f') || hasShortFlag(rest, 'd') || rest.some((a) => /^\+/.test(a) || /^:[^/]/.test(a)))) {
        out.push({ rule: 'git-force-push', reason: 'It force-pushes or deletes a remote branch, which can destroy other people\'s work.' });
      }
      if (sub === 'reset' && hasFlag(rest, '--hard')) out.push({ rule: 'git-reset-hard', reason: 'It discards uncommitted changes (git reset --hard).' });
      if (sub === 'clean' && (hasShortFlag(rest, 'f') || hasFlag(rest, '--force'))) out.push({ rule: 'git-clean', reason: 'It deletes untracked files (git clean -f).' });
      if (sub === 'branch' && (hasShortFlag(rest, 'D') || (hasFlag(rest, '--delete') && hasFlag(rest, '--force')))) out.push({ rule: 'git-branch-delete', reason: 'It force-deletes a branch.' });
      if (sub === 'checkout' && rest.includes('--') && rest.slice(rest.indexOf('--') + 1).some((a) => a === '.' || a === '*')) out.push({ rule: 'git-reset-hard', reason: 'It discards uncommitted changes (git checkout -- .).' });
      break;
    }
    case 'kill':
    case 'pkill':
    case 'killall':
      out.push({ rule: 'kill', reason: 'It stops running processes.' });
      break;
    case 'dd':
      if (args.some((a) => a.startsWith('of='))) out.push({ rule: 'dd', reason: 'It writes raw bytes to a file or device (dd).' });
      break;
    case 'diskutil':
      if (args.some((a) => /^(erase|zero|partition|secureerase|reformat|apfs)/i.test(a))) out.push({ rule: 'mkfs', reason: 'It erases or repartitions a disk.' });
      break;
    case 'fdisk':
    case 'newfs':
    case 'wipefs':
      out.push({ rule: 'mkfs', reason: 'It erases or repartitions a disk.' });
      break;
    case 'chmod':
    case 'chown': {
      const recursive = hasShortFlag(args, 'R') || hasFlag(args, '--recursive');
      if (program === 'chmod' && args.some((a) => /^0?777$|^a\+rwx$|^ugo\+rwx$/.test(a)) && (recursive || args.some((a) => a === '/'))) {
        out.push({ rule: 'chmod-777', reason: 'It makes files world-writable recursively.' });
      } else if (recursive && args.some((a) => a === '/' || a === '~' || /^\/(usr|etc|bin|sbin|System|Library|opt)\b/.test(a))) {
        out.push({ rule: 'chmod-777', reason: 'It changes permissions or ownership across system folders.' });
      }
      break;
    }
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      out.push({ rule: 'shutdown', reason: 'It shuts down or restarts the machine.' });
      break;
    case 'launchctl':
      if (args.some((a) => /^(bootout|unload|remove|disable|kill)$/.test(a))) out.push({ rule: 'kill', reason: 'It stops or removes system services.' });
      break;
    case 'crontab':
      if (hasShortFlag(args, 'r')) out.push({ rule: 'rm-recursive', reason: 'It deletes the crontab (crontab -r).' });
      break;
    default:
      if (/^mkfs(\.|$)/.test(program)) out.push({ rule: 'mkfs', reason: 'It formats a filesystem.' });
      break;
  }
  if (pipedFrom && INTERPRETERS.has(program) && previous) {
    const prev = programOf(previous).program;
    if (FETCHERS.has(prev) || prev === 'base64' || (prev === 'cat' && previous.some((a) => /^https?:/.test(a)))) {
      out.push({ rule: 'pipe-to-shell', reason: 'It runs a downloaded script without letting anyone read it first (curl | sh).' });
    }
  }
  // `> /dev/disk…` redirects
  if (argv.some((a) => /^>+\/dev\/(r?disk|sd|nvme)/.test(a)) || argv.some((a, i) => /^>+$/.test(a) && /^\/dev\/(r?disk|sd|nvme)/.test(argv[i + 1] ?? ''))) {
    out.push({ rule: 'dd', reason: 'It writes directly to a disk device.' });
  }
  return out;
}

/** Rules that ask only after the turn read remote content (see the file header). */
function exfilInSegment(argv: string[]): DestructiveMatch | null {
  const { program, args } = programOf(argv);
  const remote = remoteHosts(args);
  switch (program) {
    case 'curl':
    case 'xh':
    case 'http':
    case 'https':
      if (remote.length > 0 && (hasFlag(args, '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--upload-file', '--json', '-d', '-F', '-T')
        || args.some((a) => /^-[A-Za-z]*[dFT]$/.test(a)) || args.some((a, i) => (a === '-X' || a === '--request') && /^(POST|PUT|PATCH)$/i.test(args[i + 1] ?? '')) || args.some((a) => /^[A-Za-z_-]+(:=|=|@)/.test(a) && program !== 'curl'))) {
        return { rule: 'exfil', reason: `It sends data to ${remote[0]} after this turn read content from outside this machine.` };
      }
      return null;
    case 'wget':
      if (remote.length > 0 && hasFlag(args, '--post-data', '--post-file', '--body-data', '--body-file', '--method')) {
        return { rule: 'exfil', reason: `It sends data to ${remote[0]} after this turn read content from outside this machine.` };
      }
      return null;
    case 'nc':
    case 'ncat':
    case 'netcat':
    case 'telnet':
    case 'socat': {
      const host = args.find((a) => !a.startsWith('-') && !/^\d+$/.test(a));
      if (host && !isLoopbackName(host)) return { rule: 'exfil', reason: `It opens a raw connection to ${host} after this turn read content from outside this machine.` };
      return null;
    }
    case 'scp':
    case 'rsync':
    case 'sftp':
      if (remote.length > 0) return { rule: 'exfil', reason: `It copies files to or from ${remote[0]} after this turn read content from outside this machine.` };
      return null;
    case 'ssh': {
      const host = args.find((a) => !a.startsWith('-'));
      if (host && !isLoopbackName(host.replace(/^[^@]*@/, ''))) return { rule: 'exfil', reason: `It runs a command on ${host.replace(/^[^@]*@/, '')} after this turn read content from outside this machine.` };
      return null;
    }
    case 'git':
      if (args.some((a) => a === 'push')) return { rule: 'exfil', reason: 'It pushes to a remote after this turn read content from outside this machine.' };
      return null;
    case 'gh':
      if (args[0] === 'gist' || (args[0] === 'api' && hasFlag(args, '-f', '-F', '--field', '--raw-field', '--input'))) {
        return { rule: 'exfil', reason: 'It publishes data to GitHub after this turn read content from outside this machine.' };
      }
      return null;
    case 'aws':
    case 'gsutil':
      if (args.some((a) => /^(s3|gs):\/\//.test(a))) return { rule: 'exfil', reason: 'It uploads to cloud storage after this turn read content from outside this machine.' };
      return null;
    case 'mail':
    case 'sendmail':
    case 'mutt':
      return { rule: 'exfil', reason: 'It sends email after this turn read content from outside this machine.' };
    default:
      return null;
  }
}

/** Does this command fetch from a non-loopback host (its output is then remote content)? */
export function fetchesRemote(line: string): boolean {
  return splitCommand(line).some(({ text }) => {
    const { program, args } = programOf(words(text));
    return (FETCHERS.has(program) || (program === 'git' && args[0] === 'clone') || program === 'gh') && remoteHosts(args).length > 0;
  });
}

const RAW_RM_RF = /(^|[\s;&|(`'"])(?:\S*\/)?rm\s+(?:-[A-Za-z]*(?:r[A-Za-z]*f|f[A-Za-z]*r)[A-Za-z]*|(?:-[A-Za-z]*[rR][A-Za-z]*\s+-[A-Za-z]*f[A-Za-z]*)|(?:-[A-Za-z]*f[A-Za-z]*\s+-[A-Za-z]*[rR][A-Za-z]*)|--recursive\s+--force|--force\s+--recursive)\b/;
const RAW_PIPE_SHELL = /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|fish|dash|python3?|node|perl|ruby)\b|(?:sh|bash|zsh|eval)\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|<\(\s*(?:curl|wget)\b/;

/**
 * Every rule a command line matches. `remoteRead`: the turn has read
 * non-loopback content, so exfil-shaped commands count too.
 */
export function classifyCommand(line: string, opts: { remoteRead?: boolean; depth?: number } = {}): DestructiveMatch[] {
  const found = new Map<string, DestructiveMatch>();
  const add = (m: DestructiveMatch | null): void => { if (m && !found.has(m.rule)) found.set(m.rule, m); };
  const segments = splitCommand(line);
  let previous: string[] | null = null;
  for (const segment of segments) {
    const argv = words(segment.text);
    for (const m of destructiveInSegment(argv, segment.pipedFrom, previous)) add(m);
    if (opts.remoteRead) add(exfilInSegment(argv));
    // An inline script: `bash -c '…'`, `eval '…'` — classify its body too.
    const { program, args } = programOf(argv);
    if ((opts.depth ?? 0) < 2) {
      let body: string | null = null;
      if (SHELLS.has(program)) {
        const c = args.indexOf('-c');
        if (c >= 0 && typeof args[c + 1] === 'string') body = args[c + 1]!;
      } else if (program === 'eval') {
        body = args.join(' ');
      }
      if (body) for (const m of classifyCommand(body, { ...opts, depth: (opts.depth ?? 0) + 1 })) add(m);
    }
    previous = argv;
  }
  if (RAW_RM_RF.test(line)) add({ rule: 'rm-recursive', reason: 'It deletes files recursively without asking (rm -rf).' });
  if (RAW_PIPE_SHELL.test(line)) add({ rule: 'pipe-to-shell', reason: 'It runs a downloaded script without letting anyone read it first (curl | sh).' });
  return [...found.values()];
}

/** The confirmation key and sentence for a set of matches (`sudo+rm-recursive`). */
export function confirmationFor(matches: readonly DestructiveMatch[]): { rule: string; reason: string } | null {
  if (matches.length === 0) return null;
  const rules = [...new Set(matches.map((m) => m.rule))].sort();
  return { rule: rules.join('+'), reason: matches.map((m) => m.reason).filter((r, i, all) => all.indexOf(r) === i).join(' ') };
}
