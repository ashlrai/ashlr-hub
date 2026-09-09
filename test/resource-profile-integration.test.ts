/** Installed-style built CLI with temporary private profiles and inert native help. */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceNativeProfile } from '../src/core/resources/native-profile.js';

const CLI = resolve('dist/cli/index.js');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]) }
    : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}
function invoke(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => execFile(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C',
      OPENAI_API_KEY: 'inert-key-must-not-pass', ANTHROPIC_API_KEY: 'inert-key-must-not-pass',
      CODEX_HOME: '/fixture/ambient-codex', CLAUDE_CONFIG_DIR: '/fixture/ambient-claude', ANTHROPIC_CONFIG_DIR: '/fixture/ambient-anthropic',
      GROK_HOME: '/fixture/ambient-grok', XAI_API_KEY: 'inert-key-must-not-pass' } },
  (error, stdout, stderr) => {
    if (error && (error.killed || error.signal || typeof error.code !== 'number')) { reject(error); return; }
    done({ code: error?.code ?? 0, stdout, stderr });
  }));
}
function fixture(provider: 'codex' | 'claude' | 'grok' = 'codex') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-profile-cli-'))); roots.push(base);
  const cwd = join(base, 'help-cwd'); mkdirSync(cwd, { mode: 0o700 });
  const executable = join(base, 'inert-native'); const marker = join(base, 'invocations.jsonl');
  const required = provider === 'codex' ? ['--model', '--cd', '--sandbox', '--json', '--ephemeral', '--ignore-user-config']
    : ['--print', '--model', '--output-format', '--verbose', '--no-session-persistence', '--safe-mode', '--restricted', '--strict-mcp-config', '--tools', '--permission-mode'];
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const raw=process.argv.slice(2);const args=[...raw];const provider=${JSON.stringify(provider)};
const marker=${JSON.stringify(marker)};const log=row=>fs.appendFileSync(marker,JSON.stringify(row)+'\\n',{mode:0o600});
log({args:raw,env:process.env});process.stdin.on('data',()=>{log({unexpected:'stdin'});process.exitCode=71;});
if(provider==='codex'){
 if(JSON.stringify(args.splice(0,4))!==JSON.stringify(['-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"'])){log({unexpected:'missing-fixed-auth'});process.exit(72);}
}
if(JSON.stringify(args)==='["--version"]')console.log(provider==='codex'?'codex-cli 0.114.0':'2.1.248 (Claude Code)');
else if(JSON.stringify(args)===JSON.stringify(provider==='codex'?['exec','--help']:['--help']))console.log('Usage: fixture\\n\\nOptions:\\n'+${JSON.stringify(required)}.map(flag=>'  '+flag+'  Fixture help').join('\\n'));
else{log({unexpected:'non-help-request'});process.exitCode=73;}
`, { mode: 0o700 });
  const directory = join(base, 'new-profile');
  return { base, cwd, executable, marker, directory,
    prepare: (target = directory, selectedProvider: string = provider, native = executable) => invoke(base,
      ['resources', 'profile', 'prepare', '--provider', selectedProvider, '--directory', target, '--executable', native, '--json']),
    events: () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

describe.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('built native profile preparation CLI', () => {
  it.each(['codex', 'claude'] as const)('prepares a private %s profile then checks generated launcher compatibility without signing in', async (provider) => {
    const f = fixture(provider); const nativeBefore = readFileSync(f.executable); const result = await f.prepare();
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    const profile = JSON.parse(result.stdout) as ResourceNativeProfile;
    expect(profile).toMatchObject({ status: 'prepared', authentication: 'not-checked', provider, directory: f.directory });
    expect(profile.command).toEqual([realpathSync(process.execPath), profile.launcherPath]);
    expect(JSON.parse(readFileSync(profile.commandPath, 'utf8'))).toEqual(profile.command);
    expect(JSON.parse(readFileSync(profile.manifestPath, 'utf8'))).toEqual(profile);
    expect(f.events()).toEqual([]);
    for (const file of [profile.commandPath, profile.launcherPath, profile.manifestPath]) expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(profile.nativeStatePath).mode & 0o777).toBe(0o700); expect(readdirSync(profile.nativeStatePath)).toEqual([]);
    if (profile.anthropicStatePath) expect(readdirSync(profile.anthropicStatePath)).toEqual([]);
    const before = tree(profile.directory);
    const checked = await invoke(f.base, ['resources', 'launcher', 'check', '--provider', provider, '--command', profile.commandPath,
      '--cwd', f.cwd, '--timeout-ms', '5000', '--json']);
    expect(checked.code).toBe(0); expect(checked.stderr).toBe('');
    expect(JSON.parse(checked.stdout)).toMatchObject({ provider, status: 'supported', scope: 'native-cli-help', reason: 'launcher-flags-advertised' });
    expect(checked.stdout).not.toContain(f.base); expect(checked.stdout).not.toContain('inert-key-must-not-pass');
    const fixed = provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'] : [];
    expect(f.events().map((row) => row.args)).toEqual([[...fixed, '--version'], [...fixed, ...(provider === 'codex' ? ['exec', '--help'] : ['--help'])]]);
    for (const event of f.events()) {
      expect(event.env.HOME).toBe(process.env.HOME); expect(event.env).not.toHaveProperty('OPENAI_API_KEY'); expect(event.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      if (provider === 'codex') { expect(event.env.CODEX_HOME).toBe(profile.nativeStatePath); expect(event.env).not.toHaveProperty('CLAUDE_CONFIG_DIR'); }
      else { expect(event.env.CLAUDE_CONFIG_DIR).toBe(profile.nativeStatePath); expect(event.env.ANTHROPIC_CONFIG_DIR).toBe(profile.anthropicStatePath); expect(event.env.DISABLE_UPDATES).toBe('1'); }
    }
    expect(tree(profile.directory)).toEqual(before); expect(readFileSync(f.executable)).toEqual(nativeBefore);
  });
  it('refuses existing profile targets with exact byte preservation and no launch', async () => {
    const f = fixture(); const prepared = await f.prepare(); expect(prepared.code).toBe(0); const before = tree(f.directory);
    const second = await f.prepare(); expect(second.code).toBe(1);
    expect(JSON.parse(second.stdout)).toEqual({ error: 'Native profile preparation unavailable; inspect the selected target for partial files' });
    expect(second.stdout).not.toContain(f.base); expect(tree(f.directory)).toEqual(before); expect(f.events()).toEqual([]);
  });
  it('prepares two fresh Codex profiles with distinct empty stores, without asserting independent subscriptions', async () => {
    const f = fixture(); const first = JSON.parse((await f.prepare()).stdout) as ResourceNativeProfile;
    const secondResult = await f.prepare(join(f.base, 'second-profile')); expect(secondResult.code).toBe(0);
    const second = JSON.parse(secondResult.stdout) as ResourceNativeProfile;
    expect(first.nativeStatePath).not.toBe(second.nativeStatePath); expect(first.authentication).toBe('not-checked'); expect(second.authentication).toBe('not-checked');
    expect(readdirSync(first.nativeStatePath)).toEqual([]); expect(readdirSync(second.nativeStatePath)).toEqual([]); expect(f.events()).toEqual([]);
  });
  it('rejects unsupported providers before creating storage or running the executable', async () => {
    const f = fixture(); const before = tree(f.base); const result = await f.prepare(f.directory, 'unsupported-provider');
    expect(result.code).toBe(2); expect(JSON.parse(result.stdout)).toEqual({ error: 'Expected codex, claude or grok provider' });
    expect(existsSync(f.directory)).toBe(false); expect(f.events()).toEqual([]); expect(tree(f.base)).toEqual(before);
  });
  it('prepares an isolated Grok login locator and forwards help without enabling task execution', async () => {
    const f = fixture('grok'); const result = await f.prepare();
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    const profile = JSON.parse(result.stdout) as ResourceNativeProfile;
    expect(profile).toMatchObject({ provider: 'grok', authentication: 'not-checked', anthropicStatePath: null });
    expect(profile.loginCommand).toEqual([...profile.command, '--no-auto-update', 'login', '--oauth']);
    expect(f.events()).toEqual([]); expect(readdirSync(profile.nativeStatePath)).toEqual([]);
    const before = tree(profile.directory);
    execFileSync(profile.command[0]!, [...profile.command.slice(1), '--help'], { cwd: f.cwd, encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GROK_HOME: '/fixture/ambient-grok', XAI_API_KEY: 'inert-key-must-not-pass' } });
    expect(f.events()).toHaveLength(1); expect(f.events()[0].args).toEqual(['--help']);
    expect(f.events()[0].env.GROK_HOME).toBe(profile.nativeStatePath); expect(f.events()[0].env).not.toHaveProperty('XAI_API_KEY');
    expect(f.events()[0].env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(tree(profile.directory)).toEqual(before);
  });
  it('rejects install symlinks before creating profile storage', async () => {
    const f = fixture(); const link = join(f.base, 'install-link'); symlinkSync(f.executable, link);
    const executableBefore = readFileSync(f.executable); const result = await f.prepare(f.directory, 'codex', link);
    expect(result.code).toBe(1); expect(result.stdout).not.toContain(f.base); expect(existsSync(f.directory)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(readFileSync(f.executable)).toEqual(executableBefore); expect(f.events()).toEqual([]);
  });
});
