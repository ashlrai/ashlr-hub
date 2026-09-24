/**
 * V3.10 workbench (unit C0): the environment and PATH of every child the
 * page drives — terminal tabs (C4), Apps detection and [Launch ▸] (C6), dev
 * servers (C4 Preview) — plus the static Apps catalog they read.
 *
 * SPEC-310C §7 C0: "Child process env has ASHLR_* and token vars stripped."
 * A terminal the operator types into must never inherit the sidecar's private
 * settings or a credential exported by whoever launched it, and a stray seat
 * pin (CLAUDE_CONFIG_DIR) must not silently run a terminal `claude` on the
 * wrong account.
 *
 * No real shell is ever started: every probe gets an injected runner, the
 * same seam C4 and C6 use under vitest (which runs on Node, not Bun).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  childProcessEnv,
  FALLBACK_PATH_DIRS,
  isStrippedEnvName,
  loginShellArgs,
  normalizePathEntries,
  parseLoginShellOutput,
  pickLoginShell,
  probeLoginPath,
  refreshLoginPath,
  resetLoginPathCache,
  resolveLoginPath,
  sanitizeChildEnv,
  type ShellRunner,
} from '../src/core/verse/login-path.js';
import { APPS_CATALOG, appCatalogEntry, parseOllamaLaunchIntegrations } from '../src/core/verse/apps-catalog.js';
import { ENGINE_MONOGRAM } from '../src/core/verse/workbench-types.js';

afterEach(() => resetLoginPathCache());

const HOME = '/Users/op';

/** Directories that "exist" for the fallback filter. */
const EXISTING = new Set(['/opt/homebrew/bin', '/usr/local/bin', `${HOME}/.local/bin`, `${HOME}/.grok/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
const isDirectory = (p: string): boolean => EXISTING.has(p);

function markers(pathValue: string): string {
  return `__VERSE_LOGIN_PATH_BEGIN__${pathValue}__VERSE_LOGIN_PATH_END__`;
}

function recordingRunner(result: { stdout: string; code?: number | null; timedOut?: boolean } | Error) {
  const seen: Array<{ file: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const run: ShellRunner = async (file, args, opts) => {
    seen.push({ file, args, env: opts.env, timeoutMs: opts.timeoutMs });
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, code: result.code ?? 0, timedOut: result.timedOut ?? false };
  };
  return { run, seen };
}

// ---------------------------------------------------------------------------
// Environment sanitising
// ---------------------------------------------------------------------------

describe('sanitizeChildEnv — what a page-driven child may inherit', () => {
  const sidecarEnv: NodeJS.ProcessEnv = {
    // Ashlr's own settings (any case).
    ASHLR_TOKEN: 'mutation-token',
    ASHLR_WEB_PUBLIC: '/app/public',
    ASHLR_HOME: '/Users/op/.ashlr',
    Ashlr_Debug: '1',
    // Credentials, as providers and CI name them.
    GITHUB_TOKEN: 'ghp_x',
    GH_TOKEN: 'gho_x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    OPENAI_API_KEY: 'sk-x',
    XAI_API_KEY: 'xai-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'session',
    NPM_TOKEN: 'npm_x',
    SLACK_BOT_TOKEN: 'xoxb',
    TELEGRAM_BOT_TOKEN: '123:abc',
    DATABASE_PASSWORD: 'pw',
    PGPASSWORD: 'pw2',
    MYSQL_PWD: 'pw3',
    GHTOKEN: 'gh-glued',
    GOOGLE_APPLICATION_CREDENTIALS: '/Users/op/key.json',
    STRIPE_SECRET_KEY: 'sk_live',
    OAUTH_CLIENT_SECRET: 'cs',
    SSH_PRIVATE_KEY: '-----BEGIN',
    SESSION_COOKIE: 'c',
    api_key: 'lower',
    // Seat pins Verse sets per turn.
    CLAUDE_CONFIG_DIR: '/Users/op/.ashlr/seats/claude-a',
    CODEX_HOME: '/Users/op/.ashlr/seats/codex-b',
    GROK_HOME: '/Users/op/.ashlr/seats/grok-a',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '65536',
    // Ordinary environment a shell needs.
    PATH: '/usr/bin:/bin',
    HOME,
    SHELL: '/bin/zsh',
    USER: 'op',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/var/folders/x/T/',
    SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
    TOKENIZERS_PARALLELISM: 'false',
    EDITOR: 'vim',
    XDG_CONFIG_HOME: '/Users/op/.config',
    PWD: '/Users/op/code/repo',
    OLDPWD: '/Users/op',
  };

  it('strips every ASHLR_* variable and every credential-shaped name', () => {
    const out = sanitizeChildEnv(sidecarEnv);
    for (const name of Object.keys(out)) {
      expect(name.toUpperCase().startsWith('ASHLR_'), name).toBe(false);
      expect(/TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL|PRIVATE_KEY|COOKIE|ACCESS_KEY/i.test(name) && name !== 'TOKENIZERS_PARALLELISM', name).toBe(false);
    }
    for (const name of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'TELEGRAM_BOT_TOKEN', 'api_key', 'Ashlr_Debug', 'PGPASSWORD', 'MYSQL_PWD', 'GHTOKEN']) {
      expect(out[name], name).toBeUndefined();
    }
  });

  it('strips the per-turn seat pins (a stray CLAUDE_CONFIG_DIR would run a terminal claude on the wrong account)', () => {
    const out = sanitizeChildEnv(sidecarEnv);
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) {
      expect(out[name], name).toBeUndefined();
    }
  });

  it('keeps what a shell and git need — including names that merely CONTAIN a credential word', () => {
    const out = sanitizeChildEnv(sidecarEnv);
    expect(out).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME,
      SHELL: '/bin/zsh',
      USER: 'op',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/var/folders/x/T/',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
      TOKENIZERS_PARALLELISM: 'false',
      EDITOR: 'vim',
      XDG_CONFIG_HOME: '/Users/op/.config',
      // PWD is the shell's working directory, not a password.
      PWD: '/Users/op/code/repo',
      OLDPWD: '/Users/op',
    });
  });

  it('re-admits an exact name only when the caller asks for it', () => {
    expect(sanitizeChildEnv(sidecarEnv, { keep: ['GH_TOKEN'] })['GH_TOKEN']).toBe('gho_x');
    expect(sanitizeChildEnv(sidecarEnv, { keep: ['GH_TOKEN'] })['GITHUB_TOKEN']).toBeUndefined();
  });

  it('drops undefined values and never mutates its input', () => {
    const input: NodeJS.ProcessEnv = { A: '1', B: undefined, ASHLR_X: '2' };
    const out = sanitizeChildEnv(input);
    expect(out).toEqual({ A: '1' });
    expect(input).toEqual({ A: '1', B: undefined, ASHLR_X: '2' });
  });

  it('classifies names on whole-word boundaries', () => {
    expect(isStrippedEnvName('MY_SERVICE_TOKEN')).toBe(true);
    expect(isStrippedEnvName('TOKEN')).toBe(true);
    expect(isStrippedEnvName('TOKENIZERS_PARALLELISM')).toBe(false);
    expect(isStrippedEnvName('SSH_AUTH_SOCK')).toBe(false);
    expect(isStrippedEnvName('KEYCHAIN_PATH')).toBe(false);
    // Glued suffixes (Postgres' own PGPASSWORD) are credentials too.
    expect(isStrippedEnvName('PGPASSWORD')).toBe(true);
    expect(isStrippedEnvName('DBPASSWORD')).toBe(true);
    expect(isStrippedEnvName('PWD')).toBe(false);
    expect(isStrippedEnvName('OLDPWD')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATH resolution
// ---------------------------------------------------------------------------

describe('login PATH — the answer launchd does not give the sidecar', () => {
  it("asks the operator's login shell once, with markers, and keeps its order first", async () => {
    const { run, seen } = recordingRunner({
      stdout: `Last login: Thu\nWelcome banner\n${markers('/opt/homebrew/bin:/Users/op/.local/bin:/usr/bin:/bin')}\nbye`,
    });
    const result = await probeLoginPath({ runShell: run, env: { SHELL: '/bin/zsh' }, home: HOME, isDirectory, platform: 'darwin' });
    expect(result.source).toBe('login-shell');
    expect(result.fallbackReason).toBeNull();
    expect(result.shell).toBe('/bin/zsh');
    // The login shell's own entries lead; known install dirs that exist follow, de-duplicated.
    expect(result.entries.slice(0, 4)).toEqual(['/opt/homebrew/bin', '/Users/op/.local/bin', '/usr/bin', '/bin']);
    expect(result.entries).toContain(`${HOME}/.grok/bin`);
    expect(new Set(result.entries).size).toBe(result.entries.length);
    expect(result.path).toBe(result.entries.join(':'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args.slice(0, 3)).toEqual(['-l', '-i', '-c']);
  });

  it('runs the probe itself with a SANITISED environment — startup files never see the sidecar secrets', async () => {
    const { run, seen } = recordingRunner({ stdout: markers('/usr/bin') });
    await probeLoginPath({
      runShell: run,
      env: { SHELL: '/bin/zsh', ASHLR_TOKEN: 't', GITHUB_TOKEN: 'g', CLAUDE_CONFIG_DIR: '/x', LANG: 'C' },
      home: HOME,
      isDirectory,
      platform: 'darwin',
    });
    expect(seen[0]!.env).toEqual({ SHELL: '/bin/zsh', LANG: 'C', HOME });
  });

  it('drops relative and empty entries (they would resolve against a repo an agent just wrote)', () => {
    expect(normalizePathEntries(['/usr/bin', '', '.', 'bin', 'node_modules/.bin', '/usr/bin', ' /bin ', '/a\0b'])).toEqual(['/usr/bin', '/bin']);
    expect(parseLoginShellOutput(markers('.:/usr/bin::bin:/bin'))).toEqual(['/usr/bin', '/bin']);
  });

  it('parses the LAST marker pair and treats a missing or empty answer as no answer', () => {
    expect(parseLoginShellOutput(`${markers('/wrong')} noise ${markers('/usr/bin')}`)).toEqual(['/usr/bin']);
    expect(parseLoginShellOutput('no markers here')).toBeNull();
    expect(parseLoginShellOutput(markers(''))).toBeNull();
    expect(parseLoginShellOutput('__VERSE_LOGIN_PATH_BEGIN__/usr/bin')).toBeNull();
  });

  it('falls back to the inherited PATH plus existing install dirs when the shell times out — without echoing its output', async () => {
    const { run } = recordingRunner({ stdout: 'secret banner text', code: null, timedOut: true });
    const result = await probeLoginPath({ runShell: run, env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, home: HOME, isDirectory, platform: 'darwin', timeoutMs: 1234 });
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('login shell timed out after 1234 ms');
    expect(result.fallbackReason).not.toContain('secret');
    expect(result.entries.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(result.entries).toEqual(expect.arrayContaining(['/opt/homebrew/bin', `${HOME}/.local/bin`, `${HOME}/.grok/bin`]));
    // Only directories that exist.
    expect(result.entries).not.toContain(`${HOME}/.cargo/bin`);
  });

  it('falls back when the shell prints no PATH, or cannot be started', async () => {
    const quiet = await probeLoginPath({ runShell: recordingRunner({ stdout: 'hello', code: 1 }).run, env: { SHELL: '/bin/zsh' }, home: HOME, isDirectory, platform: 'darwin' });
    expect(quiet.source).toBe('fallback');
    expect(quiet.fallbackReason).toBe('login shell printed no PATH (exit 1)');

    const broken = await probeLoginPath({ runShell: recordingRunner(new Error('spawn ENOENT')).run, env: { SHELL: '/bin/zsh' }, home: HOME, isDirectory, platform: 'darwin' });
    expect(broken.source).toBe('fallback');
    expect(broken.fallbackReason).toBe('login shell could not be started');
  });

  it('never asks a shell on Windows', async () => {
    const { run, seen } = recordingRunner({ stdout: markers('/usr/bin') });
    const result = await probeLoginPath({ runShell: run, env: { PATH: 'C:\\bin' }, home: HOME, isDirectory, platform: 'win32' });
    expect(seen).toHaveLength(0);
    expect(result.source).toBe('fallback');
    expect(result.shell).toBeNull();
  });

  it('picks $SHELL only when it is an absolute path to a shell it knows how to drive', () => {
    expect(pickLoginShell({ SHELL: '/opt/homebrew/bin/bash' }, 'darwin')).toBe('/opt/homebrew/bin/bash');
    expect(pickLoginShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toBe('/opt/homebrew/bin/fish');
    expect(pickLoginShell({ SHELL: 'zsh' }, 'darwin')).toBe('/bin/zsh');
    expect(pickLoginShell({ SHELL: '/usr/local/bin/xonsh' }, 'darwin')).toBe('/bin/zsh');
    expect(pickLoginShell({}, 'linux')).toBe('/bin/sh');
    expect(pickLoginShell({ SHELL: '/bin/zsh' }, 'win32')).toBeNull();
  });

  it('prints PATH the way each shell family can', () => {
    expect(loginShellArgs('/bin/zsh')[3]).toContain('"$PATH"');
    expect(loginShellArgs('/opt/homebrew/bin/fish')[3]).toContain('string join : $PATH');
  });

  it('lists only absolute or ~ install dirs, homebrew first', () => {
    expect(FALLBACK_PATH_DIRS[0]).toBe('/opt/homebrew/bin');
    for (const dir of FALLBACK_PATH_DIRS) expect(dir.startsWith('/') || dir.startsWith('~/'), dir).toBe(true);
  });

  it('resolves once per process (single-flight), and refresh re-asks', async () => {
    const { run, seen } = recordingRunner({ stdout: markers('/usr/bin') });
    const opts = { runShell: run, env: { SHELL: '/bin/zsh' }, home: HOME, isDirectory, platform: 'darwin' as const };
    const [a, b] = await Promise.all([resolveLoginPath(opts), resolveLoginPath(opts)]);
    expect(a).toBe(b);
    await resolveLoginPath(opts);
    expect(seen).toHaveLength(1);
    await refreshLoginPath(opts);
    expect(seen).toHaveLength(2);
  });

  it('childProcessEnv = sanitised base + login PATH + the caller’s own additions last', async () => {
    const { run } = recordingRunner({ stdout: markers('/opt/homebrew/bin:/usr/bin') });
    const env = await childProcessEnv({
      base: { SHELL: '/bin/zsh', HOME, ASHLR_TOKEN: 't', GITHUB_TOKEN: 'g', PATH: '/usr/bin', LANG: 'C' },
      set: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      loginPath: { runShell: run, env: { SHELL: '/bin/zsh' }, home: HOME, isDirectory, platform: 'darwin' },
    });
    expect(env['ASHLR_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['PATH']!.startsWith('/opt/homebrew/bin:/usr/bin')).toBe(true);
    expect(env).toMatchObject({ SHELL: '/bin/zsh', HOME, LANG: 'C', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  });
});

// ---------------------------------------------------------------------------
// Apps catalog
// ---------------------------------------------------------------------------

/** `ollama launch --help`, ollama 0.33.3, captured 2026-09-24 (zero-cost help text). */
const OLLAMA_0_33_3_LAUNCH_HELP = `Launch the Ollama interactive menu, or directly launch a specific integration.

Without arguments, this is equivalent to running 'ollama' directly.
Flags and extra arguments require an integration name.

Supported integrations:
  claude          Claude Code
  chatgpt         ChatGPT (aliases: codex-app, codex-desktop, codex-gui)
  hermes          Hermes Agent
  openclaw        OpenClaw (aliases: clawdbot, moltbot)
  opencode        OpenCode
  codex           Codex
  hermes-desktop  Hermes Desktop
  copilot         Copilot CLI (aliases: copilot-cli)
  omp             OMP
  droid           Droid
  dsh             DeepSeek Harness (alias: deepseek-harness)
  kimi            Kimi Code CLI
  muse            Muse Code (aliases: muse-code)
  pi              Pi
  pool            Pool
  cline           Cline
  qwen            Qwen Code
  vscode          VS Code (aliases: code)

Examples:
  ollama launch
  ollama launch claude-desktop --restore
  ollama launch claude
  ollama launch claude --model <model>
  ollama launch chatgpt
  ollama launch chatgpt --restore
  ollama launch hermes
  ollama launch hermes-desktop
  ollama launch dsh
  ollama launch droid --config (does not auto-launch)
  ollama launch codex --restore
  ollama launch codex -- --sandbox workspace-write

Usage:
  ollama launch [INTEGRATION] [-- [EXTRA_ARGS...]] [flags]

Flags:
      --config         Configure without launching
  -h, --help           help for launch
      --model string   Model to use
      --restore        Restore an integration to its default profile
  -y, --yes            Automatically answer yes to confirmation prompts
`;

describe('parseOllamaLaunchIntegrations', () => {
  const ids = parseOllamaLaunchIntegrations(OLLAMA_0_33_3_LAUNCH_HELP);

  it('reads the integration list with its aliases', () => {
    for (const id of ['claude', 'codex', 'hermes', 'hermes-desktop', 'opencode', 'droid', 'pi', 'cline', 'chatgpt', 'codex-app', 'deepseek-harness', 'code']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('also admits ids only the Examples launch (0.33.3 documents claude-desktop there alone)', () => {
    expect(ids.has('claude-desktop')).toBe(true);
  });

  it('never mistakes flags, usage or prose for an integration', () => {
    for (const id of ['launch', 'ollama', 'config', 'help', 'model', 'restore', 'yes', 'usage', 'flags', 'without', 'integration']) {
      expect(ids.has(id), id).toBe(false);
    }
  });

  it('offers the ⧉ pill only where the INSTALLED ollama lists the entry', () => {
    const offered = APPS_CATALOG.filter((e) => e.ollamaLaunchId !== null && ids.has(e.ollamaLaunchId)).map((e) => e.id);
    expect(offered).toEqual(['claude-desktop', 'hermes-desktop', 'claude-code', 'codex', 'hermes', 'opencode', 'droid', 'pi', 'cline']);
    expect(parseOllamaLaunchIntegrations('').size).toBe(0);
  });
});

describe('APPS_CATALOG', () => {
  it('has unique ids and a lookup that finds each one', () => {
    const ids = APPS_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(appCatalogEntry(id)?.id).toBe(id);
    expect(appCatalogEntry('nope')).toBeNull();
  });

  it('lists the SPEC-310C §4 terminal agents in order', () => {
    expect(APPS_CATALOG.filter((e) => e.group === 'terminal-agents').map((e) => e.name)).toEqual([
      'Claude Code', 'Codex', 'Grok', 'Hermes', 'Aider', 'Goose', 'OpenCode', 'Droid', 'Pi', 'Cline',
    ]);
  });

  it('keeps every command an argv of plain words — never a shell string, never a secret', () => {
    for (const entry of APPS_CATALOG) {
      const argvs = [entry.launch, entry.versionArgs, entry.desktopToggle?.onCommand, entry.desktopToggle?.restoreCommand].filter(
        (argv): argv is readonly string[] => Array.isArray(argv),
      );
      for (const argv of argvs) {
        for (const word of argv) {
          expect(/^[A-Za-z0-9._@:=/-]+$/.test(word), `${entry.id}: "${word}"`).toBe(true);
          expect(/token|secret|key|password/i.test(word), `${entry.id}: "${word}"`).toBe(false);
        }
      }
    }
  });

  it('launches each terminal agent with its own binary and asks versions with a zero-cost flag', () => {
    for (const entry of APPS_CATALOG.filter((e) => e.group === 'terminal-agents')) {
      expect(entry.launch?.[0] && entry.binaries.includes(entry.launch[0]), entry.id).toBe(true);
      expect(entry.versionArgs, entry.id).toEqual(['--version']);
    }
  });

  it('ships desktop toggles OFF, with the restore command beside the command (§0.5)', () => {
    const toggles = APPS_CATALOG.filter((e) => e.desktopToggle !== null);
    expect(toggles.map((e) => e.id)).toEqual(['claude-desktop', 'hermes-desktop']);
    for (const entry of toggles) {
      expect(entry.desktopToggle!.defaultEnabled).toBe(false);
      expect(entry.desktopToggle!.restoreCommand).toEqual([...entry.desktopToggle!.onCommand, '--restore']);
      expect(entry.desktopToggle!.note.length).toBeGreaterThan(0);
    }
  });

  it('probes local runtimes on loopback only', () => {
    for (const entry of APPS_CATALOG.filter((e) => e.probe !== null)) {
      expect(entry.probe!.url.startsWith('http://127.0.0.1:'), entry.id).toBe(true);
    }
    expect(appCatalogEntry('llama-server')?.probe?.url).toBe('http://127.0.0.1:8080/health');
  });

  it('prints the engine monogram on engine-backed rows (a tile, never a vendor logo)', () => {
    for (const entry of APPS_CATALOG) {
      expect(entry.monogram.length >= 1 && entry.monogram.length <= 2, entry.id).toBe(true);
      if (entry.engine !== null) expect(entry.monogram, entry.id).toBe(ENGINE_MONOGRAM[entry.engine]);
    }
  });
});
