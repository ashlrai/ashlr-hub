import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { McpRegistry, McpServerSpec } from '../types.js';
import { lexiconServerSpec, pathWithinProject } from './lexicon-mcp.js';

export interface CompanionProjectScope { project: string; client: string; config: string }
interface ScopedRuntime { cwd: string; env: Record<string, string> }
// JSON configuration cannot create this marker. Enumerable symbols survive the
// gateway's defensive shallow copy without becoming printed configuration.
const runtime = Symbol('validated-companion-project-runtime');
type ScopedSpec = McpServerSpec & { [runtime]?: ScopedRuntime };
export function companionProjectRuntime(spec: McpServerSpec): ScopedRuntime | undefined {
  return (spec as ScopedSpec)[runtime];
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validAbsolute(value: string): boolean { return isAbsolute(value) && !/[\r\n\0]/.test(value); }

/** Metadata only: refuse escapes/dangling links without reading vocabulary or trust. */
function boundedPath(project: string, candidate: string): string {
  if (!pathWithinProject(project, candidate)) throw new Error('Scoped MCP path must be inside the project');
  let ancestor = candidate;
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isFile() && metadata.nlink !== 1) throw new Error('Scoped MCP path contains a multiply linked file');
      const canonical = realpathSync(ancestor); // dangling links fail closed
      if (canonical !== project && !pathWithinProject(project, canonical)) throw new Error('Scoped MCP path escapes the project');
      return resolve(canonical, candidate.slice(ancestor.length).replace(/^[/\\]+/, ''));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link is an existing entry, not a missing ancestor.
      try { lstatSync(ancestor); throw new Error('Scoped MCP path contains a dangling link'); }
      catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError; }
      ancestor = dirname(ancestor);
    }
  }
}

function installedLexicon(): { command: string; launch: 'cli' | 'stdio' } {
  for (const binary of ['lexicon-mcp', 'lexicon']) {
    for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(isAbsolute)) {
      const command = resolve(directory, binary);
      try {
        accessSync(command, constants.X_OK);
        if (statSync(command).isFile()) return { command, launch: binary === 'lexicon' ? 'cli' : 'stdio' };
      } catch { /* continue installed executable discovery; never execute */ }
    }
  }
  throw new Error('No installed Lexicon executable found; scoped discovery does not install or download it');
}

/** Explicit one-file discovery. Never scans HOME, starts a process, or grants trust. */
export function discoverCompanionProjectMcp(scope: CompanionProjectScope): McpRegistry {
  if (!validAbsolute(scope.project) || !validAbsolute(scope.config)) throw new Error('Scoped MCP requires absolute project and config paths');
  const project = realpathSync(scope.project);
  if (!statSync(project).isDirectory()) throw new Error('Scoped MCP project must be an existing directory');
  // Lexicon 0.5.x searches ancestors for .lexicon.yaml before checking trust.
  // An existing Git boundary stops that traversal without reading its contents.
  let git;
  try { git = lstatSync(join(project, '.git')); }
  catch { throw new Error('Scoped Lexicon requires a project-root .git marker to prevent ancestor vocabulary discovery'); }
  if (!git.isDirectory() && !git.isFile()) throw new Error('Scoped Lexicon requires a regular project-root .git marker');
  // This also validates the client identifier before reading any config.
  const installed = installedLexicon();
  const expected = lexiconServerSpec({ projectRoot: project, client: scope.client, ...installed });
  const config = boundedPath(project, resolve(scope.config));
  const vocabulary = expected.env['LEXICON_PATH']!;
  const home = dirname(vocabulary);
  for (const state of [join(project, '.lexicon.yaml'), vocabulary, join(home, 'trust.json'), join(home, 'hits.json')]) {
    for (const candidate of [state, `${state}.bak`, `${state}.1.bak`, `${state}.lock`]) {
      if (boundedPath(project, candidate) !== candidate) throw new Error('Scoped Lexicon state cannot redirect through symlinks');
      try {
        const metadata = lstatSync(candidate);
        if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Scoped Lexicon state must be a regular single-link file');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const before = lstatSync(config);
  if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error('Scoped MCP config must be a bounded regular file with one link');
  const fd = openSync(config, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: unknown;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 1024 * 1024) throw new Error('Scoped MCP config changed during discovery');
    const raw = readFileSync(fd, 'utf8');
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('Scoped MCP config is not valid JSON'); }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Scoped MCP config changed during discovery');
  } finally { closeSync(fd); }
  if (!plain(parsed) || !plain(parsed['mcpServers']) || !plain(parsed['mcpServers']['lexicon'])) throw new Error('Scoped MCP config requires a Lexicon registration');
  const entry = parsed['mcpServers']['lexicon'];
  if (entry['command'] !== expected.command || JSON.stringify(entry['args'] ?? []) !== JSON.stringify(expected.args)
      || !plain(entry['env']) || Object.keys(entry['env']).length !== 2
      || entry['env']['LEXICON_CWD'] !== expected.env['LEXICON_CWD']
      || entry['env']['LEXICON_PATH'] !== vocabulary) {
    throw new Error('Lexicon registration does not match the selected installed executable, project and client; environment overrides are refused');
  }
  const env = Object.freeze({ ...expected.env, HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home, XDG_STATE_HOME: home, PATH: dirname(process.execPath) });
  const spec: ScopedSpec = { name: 'lexicon', ...expected, source: config,
    [runtime]: Object.freeze({ cwd: project, env }) };
  return { servers: [spec] };
}
