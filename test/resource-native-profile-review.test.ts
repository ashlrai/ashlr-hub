/** Independent profile review with inert native executables. Never vendor authentication or inference. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareResourceNativeProfile } from '../src/core/resources/native-profile.js';

let root: string;
let executable: string;
const CODEX_AUTH_FLAGS = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-profile-independent-')));
  executable = join(root, 'native fixture.cjs');
  writeFileSync(executable, `#!${realpathSync(process.execPath)}\nlet input='';process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),env:process.env,input}));
if(process.argv.includes('--fixture-exit'))process.exitCode=23;});\n`, { mode: 0o755 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function prepare(provider: 'codex' | 'claude', name: string = provider) {
  return prepareResourceNativeProfile({ provider, directory: join(root, name), executable });
}
async function invoke(command: string[], args: string[] = [], input = '') {
  const child = spawn(command[0]!, [...command.slice(1), ...args], {
    cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    child.stdin.end(input);
    const code = await closed;
    return { code, pid: child.pid, stdout, stderr };
  } finally { clearTimeout(timer); }
}

describe('independent native-profile isolation and real wrapper semantics', () => {
  it('prepares three distinct native stores without authenticating or adopting preexisting state', () => {
    const sentinel = join(root, 'existing-default-state'); mkdirSync(sentinel, { mode: 0o700 });
    writeFileSync(join(sentinel, 'credentials.fixture'), 'DO_NOT_COPY_EXISTING_ACCOUNT', { mode: 0o600 });
    vi.stubEnv('CODEX_HOME', sentinel); vi.stubEnv('CLAUDE_CONFIG_DIR', sentinel); vi.stubEnv('ANTHROPIC_CONFIG_DIR', sentinel);
    const profiles = [prepare('codex', 'codex-a'), prepare('codex', 'codex-b'), prepare('claude', 'claude-a')];
    expect(new Set(profiles.map((profile) => profile.nativeStatePath)).size).toBe(3);
    for (const profile of profiles) {
      expect(profile).toMatchObject({ status: 'prepared', authentication: 'not-checked' });
      const state = readdirSync(profile.nativeStatePath);
      expect(state).not.toContain('credentials.fixture');
      expect(JSON.stringify(profile)).not.toContain('DO_NOT_COPY_EXISTING_ACCOUNT');
      expect((statSync(profile.directory).mode & 0o777)).toBe(0o700);
      expect((statSync(profile.nativeStatePath).mode & 0o777)).toBe(0o700);
    }
    expect(profiles[2]!.anthropicStatePath).not.toBeNull();
    expect(readdirSync(profiles[2]!.anthropicStatePath!)).toEqual([]);
    expect(readFileSync(join(sentinel, 'credentials.fixture'), 'utf8')).toBe('DO_NOT_COPY_EXISTING_ACCOUNT');
  });

  it.each(['codex', 'claude'] as const)('%s launcher preserves PID, stdin, cwd and literal argv without a shell', async (provider) => {
    const profile = prepare(provider);
    const before = readFileSync(profile.launcherPath);
    const args = ['--help', 'space value', 'single\'quote', '$(touch NEVER_EXECUTE)', '`NEVER_EXECUTE`', '--literal=é'];
    const result = await invoke(profile.command, args, 'private fixture stdin\n');
    expect(result.code).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({ pid: result.pid, argv: [...(provider === 'codex' ? CODEX_AUTH_FLAGS : []), ...args],
      cwd: root, input: 'private fixture stdin\n' });
    expect(existsSync(join(root, 'NEVER_EXECUTE'))).toBe(false);
    expect(readFileSync(profile.launcherPath).equals(before)).toBe(true);
  });

  it.each(['codex', 'claude'] as const)('%s removes ambient provider, workload, proxy and loader selection', async (provider) => {
    const profile = prepare(provider);
    const unsafe = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
      'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_PROFILE',
      'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'HTTPS_PROXY', 'ALL_PROXY', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'NODE_PATH'];
    for (const key of unsafe) vi.stubEnv(key, 'SHOULD_NOT_REACH_NATIVE');
    // Harmless startup option: Node consumes NODE_OPTIONS before our launcher
    // runs, but it still must not propagate that variable to the native child.
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('CODEX_HOME', '/unused/ambient-codex'); vi.stubEnv('CLAUDE_CONFIG_DIR', '/unused/ambient-claude');
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', '/unused/ambient-anthropic'); vi.stubEnv('GROK_HOME', '/unused/ambient-grok');
    const result = await invoke(profile.command, ['--version']);
    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout).env as Record<string, string>;
    for (const key of unsafe) expect(env).not.toHaveProperty(key);
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('GROK_HOME'); expect(env.HOME).toBe(process.env.HOME);
    if (provider === 'claude') {
      expect(env.CLAUDE_CONFIG_DIR).toBe(profile.nativeStatePath);
      expect(env.ANTHROPIC_CONFIG_DIR).toBe(profile.anthropicStatePath);
      expect(env.DISABLE_UPDATES).toBe('1'); expect(env).not.toHaveProperty('CODEX_HOME');
    } else {
      expect(env.CODEX_HOME).toBe(profile.nativeStatePath);
      expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR'); expect(env).not.toHaveProperty('ANTHROPIC_CONFIG_DIR');
    }
  });

  it.each(['codex', 'claude'] as const)('%s provides an explicit native sign-in command without running it during preparation', async (provider) => {
    const profile = prepare(provider);
    expect(profile.loginCommand).toEqual([...profile.command, ...(provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'])]);
    // This is our inert native executable, never the actual provider login.
    const result = await invoke(profile.loginCommand);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).argv).toEqual(provider === 'claude' ? ['auth', 'login', '--claudeai'] : [...CODEX_AUTH_FLAGS, 'login']);
  });

  it('preserves an ordinary native exit status', async () => {
    const result = await invoke(prepare('claude').command, ['--fixture-exit']);
    expect(result.code).toBe(23);
  });

  it('does not overwrite an existing profile, including native-created credential state', () => {
    const profile = prepare('claude');
    const credential = join(profile.nativeStatePath, '.credentials.fixture');
    writeFileSync(credential, 'NATIVE_OWNED_FIXTURE', { mode: 0o600 });
    const files = [profile.commandPath, profile.launcherPath, profile.manifestPath, credential];
    const before = files.map((path) => readFileSync(path));
    expect(() => prepare('claude')).toThrow();
    files.forEach((path, index) => { expect(readFileSync(path).equals(before[index]!)).toBe(true); });
  });

  it('rejects a symlink destination without writing through it', () => {
    const existing = join(root, 'existing'); mkdirSync(existing, { mode: 0o700 });
    const target = join(root, 'alias'); symlinkSync(existing, target);
    expect(() => prepareResourceNativeProfile({ provider: 'claude', directory: target, executable })).toThrow();
    expect(readdirSync(existing)).toEqual([]);
  });

  it('rejects an unsafe existing executable or parent without repairing either', () => {
    chmodSync(executable, 0o777);
    expect(() => prepare('claude')).toThrow(); expect(statSync(executable).mode & 0o777).toBe(0o777);
    expect(existsSync(join(root, 'claude'))).toBe(false);
    chmodSync(executable, 0o755); chmodSync(root, 0o755);
    expect(() => prepare('claude')).toThrow(); expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, 'claude'))).toBe(false);
  });
});
