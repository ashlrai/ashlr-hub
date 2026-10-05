import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngineCommand, spawnEngine } from '../src/core/run/engines.js';
import type { AshlrConfig } from '../src/core/types.js';
import { autonomousDevinIdentityCurrent, buildAutonomousEnvOverlay, applyAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';

import { devinCliBindingCurrent, parseDevinCliPrincipal, peekDevinCliExecutionBinding, refreshDevinCliExecutionBinding, resetDevinCliAdmissionForTest, type DevinCliAdmissionOptions } from '../src/core/devin/cli-admission.js';

const NOW = Date.parse('2026-10-05T17:00:00Z');
const STATUS = 'Logged in\n  Email: fixture@example.invalid\n  User ID: native-user-1\n  Team ID: native-team-1\n  API server: https://server.codeium.com\n  Devin API: https://api.devin.ai\n';
const catalog = (meta = '262K context, Free', model = 'swe-2-high') => `Available models (1 family)\nSWE-2 (swe-2)\n  ${model}  Fixture Model  [${meta}]\n`;

describe.runIf(process.platform !== 'win32')('native Devin execution admission', () => {
  let root: string; let bin: string; let credentials: string;
  beforeEach(() => {
    resetDevinCliAdmissionForTest();
    vi.spyOn(Date,'now').mockReturnValue(NOW);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-devin-admission-')));
    bin = join(root, 'devin');
    mkdirSync(join(root,'data','devin'),{recursive:true,mode:0o700});
    credentials = join(root, 'data','devin','credentials.toml');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode:0o755 });
    writeFileSync(credentials, 'fixture-not-a-real-login', { mode:0o600 });
  });
  afterEach(() => { resetDevinCliAdmissionForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, {recursive:true,force:true}); });
  function options(run: DevinCliAdmissionOptions['runMetadata'] = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog()), now = () => NOW) {
    return { cliPath:bin, credentialsPath:credentials, now, runMetadata:run };
  }

  it('seals the exact binary and supported native principal/context without storing identifiers or credentials', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog());
    const binding = await refreshDevinCliExecutionBinding('swe-2-high', options(run));
    expect(binding).toMatchObject({ executable:bin, model:'swe-2-high', contextTokens:262000, principalBasis:'user-id',
      executableSha256:createHash('sha256').update(readFileSync(bin)).digest('hex') });
    expect(JSON.stringify(binding)).not.toMatch(/native-user|native-team|fixture@example|fixture-not-a-real-login/);
    expect(devinCliBindingCurrent(binding, 'swe-2-high', NOW)).toBe(true);
    expect(devinCliBindingCurrent(binding, 'swe-2-max', NOW)).toBe(false);
    expect(devinCliBindingCurrent({ ...binding! }, 'swe-2-high', NOW)).toBe(false);
    expect(run.mock.calls.map(c => [c[0],c[1]])).toEqual([[bin,['auth','status']],[bin,['models','list']],[bin,['auth','status']]]);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('joins a same-tuple refresh and reuses evidence without another native request', async () => {
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    const run = vi.fn(async (_bin: string, args: readonly string[]) => { if (args[0] === 'auth') await wait; return args[0] === 'auth' ? STATUS : catalog(); });
    const a = refreshDevinCliExecutionBinding('swe-2-high', options(run));
    const b = refreshDevinCliExecutionBinding('swe-2-high', options(run));
    release(); expect(await a).toBe(await b);
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(run))).toBe(await a);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each(['256K context', '256K context, $2 / 1M Input · $8 / 1M Output', 'Free', '256K context, Free, $2 / 1M Input'])('holds unknown/paid/incomplete/contradictory evidence: %s', async meta => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog(meta))))).toBeNull();
  });
  it.each(['Logged out', STATUS.replace('User ID: native-user-1', 'User ID: native-user-1\n  User ID: duplicate'), STATUS.replace('https://api.devin.ai','https://user:password@api.devin.ai'), STATUS.replace('https://api.devin.ai','https://unconfirmed.invalid')])('refuses unqualified native identity', async status => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? status : catalog())))).toBeNull();
  });

  it('uses email-only evidence as principal consistency without inventing an org or balance', () => {
    const email = parseDevinCliPrincipal(STATUS.replace('  User ID: native-user-1\n','').replace('  Team ID: native-team-1\n',''));
    expect(email).toMatchObject({ principalBasis:'email', teamDigest:null });
    expect(email).not.toHaveProperty('organizationId'); expect(email).not.toHaveProperty('remainingQuota');
    expect(parseDevinCliPrincipal(STATUS.replace('native-team-1','native-team-2'))?.teamDigest).not.toBe(parseDevinCliPrincipal(STATUS)?.teamDigest);
    expect(parseDevinCliPrincipal(STATUS.replace('native-user-1','native-user-2'))?.principalDigest).not.toBe(parseDevinCliPrincipal(STATUS)?.principalDigest);
  });
  it.each(['same-family', 'other-family'])('refuses duplicate model rows even when the first is Free: %s', async where => {
    const duplicate = where === 'same-family'
      ? catalog() + '  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n'
      : catalog().replace('(1 family)', '(2 families)') + 'Other (other)\n  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n';
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : duplicate)))).toBeNull();
  });
  it.each(['User ID', 'Team ID', 'Devin API'])('refuses changed native %s after catalog despite unchanged credential epoch', async field => {
    let authReads = 0;
    const changed = field === 'User ID' ? STATUS.replace('native-user-1','native-user-2') : field === 'Team ID'
      ? STATUS.replace('native-team-1','native-team-2') : STATUS.replace('https://api.devin.ai','https://other.devin.ai');
    const run = vi.fn(async (_bin:string,args:readonly string[]) => args[0] === 'auth' ? (++authReads === 1 ? STATUS : changed) : catalog());
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(run))).toBeNull();
    expect(authReads).toBe(2);
  });
  it('refuses native transport in tests unless an explicit hermetic seam is supplied', async () => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{cliPath:bin,credentialsPath:credentials})).toBeNull();
  });
  it('refuses a truncated catalog that could hide a duplicate beyond the UI row cap', async () => {
    const many = catalog() + Array.from({length:4000},(_,i) => `  other-${i}  Other  [262K context, Free]\n`).join('') + '  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n';
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : many)))).toBeNull();
  });
  it('refuses partial declared catalogs and never uses source fallback models', async () => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog().replace('(1 family)','(2 families)'))))).toBeNull();
  });
  it('does not permanently authorize promotional IDs after the conservative host boundary, even on a new Free reading', async () => {
    const boundary = Date.parse('2026-10-16T00:00:00Z');
    const binding = await refreshDevinCliExecutionBinding('swe-2-high', options(undefined,() => boundary-1));
    expect(binding).not.toBeNull(); expect(binding!.validUntil).toBe(boundary);
    expect(devinCliBindingCurrent(binding, 'swe-2-high', boundary)).toBe(false);
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(undefined,() => boundary))).toBeNull();
  });
  it('refuses stale/future evidence and a forged host object', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high', options());
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW-1)).toBe(false);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW+60000)).toBe(false);
    expect(devinCliBindingCurrent(JSON.parse(JSON.stringify(binding)),'swe-2-high',NOW)).toBe(false);
  });
  it('allows another actually Free native model without permanently hardcoding its ID', async () => {
    expect(await refreshDevinCliExecutionBinding('another-free',options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog('262K context, Free','another-free'))))).toMatchObject({model:'another-free'});
  });
  it('pins the symlink selection and refuses later replacement rather than using PATH', async () => {
    const link = join(root,'selected-devin'); symlinkSync(bin,link);
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',{...options(),cliPath:link});
    expect(binding?.executable).toBe(bin);
    const replacement = join(root,'replacement'); writeFileSync(replacement,'#!/bin/sh\nexit 1\n',{mode:0o755});
    rmSync(link); symlinkSync(replacement,link);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
  });
  it.each(['executable','credentials'])('refuses %s replacement after metadata', async which => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options());
    const file = which === 'executable' ? bin : credentials;
    renameSync(file,`${file}.old`); writeFileSync(file,'replacement',{mode:which === 'executable' ? 0o755 : 0o600});
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
  });
  it.each(['auth','models'])('rejects epoch mutation during %s and never issues a binding', async when => {
    const run = vi.fn(async (_bin: string,args:readonly string[]) => { if(args[0] === when) writeFileSync(credentials,'changed'); return args[0] === 'auth' ? STATUS : catalog(); });
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(run))).toBeNull();
    expect(run).toHaveBeenCalledTimes(when === 'auth' ? 1 : 2);
  });
  it('checks cancellation between metadata contacts and excludes ambient authentication overrides', async () => {
    vi.stubEnv('WINDSURF_API_KEY','must-not-reach-native'); vi.stubEnv('DEVIN_API_KEY','must-not-reach-native');
    let open = true;
    const run = vi.fn(async (_bin:string,_args:readonly string[],env:NodeJS.ProcessEnv) => {
      expect(env['WINDSURF_API_KEY']).toBeUndefined(); expect(env['DEVIN_API_KEY']).toBeUndefined();
      expect(env['XDG_DATA_HOME']).toBe(dirnameTwice(credentials)); open = false; return STATUS;
    });
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{...options(run),admitted:() => open})).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });
  it('binds the private login copy and refuses source/copy replacement before actual spawn', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options(undefined,Date.now));
    expect(binding).not.toBeNull();
    const run = join(root,'run'); mkdirSync(run,{mode:0o700});
    const overlay = buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:run,home:root,seatId:null,devinExecutionBinding:binding!});
    const copy = join(overlay.set['XDG_DATA_HOME']!,'devin','credentials.toml');
    expect(readFileSync(copy)).toEqual(readFileSync(credentials));
    expect(autonomousDevinIdentityCurrent(overlay)).toBe(true);
    expect(applyAutonomousEnvOverlay({WINDSURF_API_KEY:'ambient',DEVIN_API_KEY:'ambient'},overlay)['WINDSURF_API_KEY']).toBeUndefined();
    writeFileSync(copy,'different private login');
    expect(autonomousDevinIdentityCurrent(overlay)).toBe(false);
    renameSync(credentials,credentials+'.old');writeFileSync(credentials,'replacement',{mode:0o600});
    const next = join(root,'next-run');mkdirSync(next,{mode:0o700});
    expect(() => buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:next,home:root,seatId:null,devinExecutionBinding:binding!})).toThrow(/identity changed/);
  });
  it.each(['source', 'copy', 'Stop'])('refuses actual child contact after awaited setup changes %s', async changed => {
    const marker = join(root,'contacted');
    writeFileSync(bin,`#!/bin/sh\necho contacted > '${marker}'\n`,{mode:0o755});
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options(undefined,Date.now));
    const run = join(root,'run');mkdirSync(run,{mode:0o700});
    const overlay = buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:run,home:root,seatId:null,devinExecutionBinding:binding!});
    let active = true;
    await Promise.resolve();
    if (changed === 'source') writeFileSync(credentials,'changed source');
    else if (changed === 'copy') writeFileSync(join(overlay.set['XDG_DATA_HOME']!,'devin','credentials.toml'),'changed copy');
    else active = false;
    const cfg = {foundry:{},models:{}} as AshlrConfig;
    const cmd = buildEngineCommand('devin-cli','fixture',cfg,{cwd:root,model:'swe-2-high'})!;
    const result = await spawnEngine({...cmd,bin:binding!.executable},cfg,{selectedOutcomeAdmission:() => active && devinCliBindingCurrent(binding,'swe-2-high') && autonomousDevinIdentityCurrent(overlay)});
    expect(result).toMatchObject({ok:false,terminationReason:'cancelled'});
    expect(() => readFileSync(marker)).toThrow();
  });
  it('does not trust a source login changed after a formerly valid read', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options());
    chmodSync(credentials,0o666);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
    expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).toBeNull();
  });
});

function dirnameTwice(file: string): string { return join(file,'..','..'); }

// Windows cannot supply this POSIX private-file/exec proof; autonomous confinement
// remains unsupported there. Refusal must precede any native account metadata.
it.runIf(process.platform === 'win32')('holds unqualified Windows native file permissions before metadata contact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'devin-windows-held-')));
  try {
    const bin = join(root,'devin.exe');writeFileSync(bin,'fake native',{mode:0o755});
    mkdirSync(join(root,'data','devin'),{recursive:true});
    const credentialsPath = join(root,'data','devin','credentials.toml');writeFileSync(credentialsPath,'fake login',{mode:0o600});
    const runMetadata = vi.fn(async () => STATUS);
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{cliPath:bin,credentialsPath,runMetadata})).toBeNull();
    expect(runMetadata).not.toHaveBeenCalled();
  } finally {resetDevinCliAdmissionForTest();rmSync(root,{recursive:true,force:true});}
});
