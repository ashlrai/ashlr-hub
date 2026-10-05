import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveClaudeBrokerToolInvocation } from '../src/core/sandbox/claude-broker-tool-invocation.js';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/core/config.js';
import { claudeBrokerCommand, claudeBrokerNativeEnvironment, startClaudeNativeBroker } from '../src/core/sandbox/claude-native-broker.js';
import type { ClaudeBrokerHandle, ClaudeBrokerObservation, ClaudeBrokerScope } from '../src/core/sandbox/claude-native-broker.js';
import { claudeBrokerToolExecutor } from '../src/core/sandbox/claude-broker-executor.js';
import { setKernelEvidenceWatcherForTest } from '../src/core/sandbox/autonomous-run.js';
import type { AutonomousSpawnFinish } from '../src/core/sandbox/autonomous-run.js';

const SCOPE: ClaudeBrokerScope = { runId: 'fixture-run', seatId: 'claude-a', model: 'claude-sonnet-4-5',
  accountDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), epochDigest: 'c'.repeat(64) };
const TIME = Date.now();
const OBSERVED: ClaudeBrokerObservation = { ...SCOPE, observedAtMs: TIME - 1000, expiresAtMs: TIME + 59_000,
  authMethod: 'claude.ai', extraUsageEnabled: false };
const handles: ClaudeBrokerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  setKernelEvidenceWatcherForTest();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
async function setup() {
  let observed: ClaudeBrokerObservation | null = { ...OBSERVED }; let admitted = true;
  const execute = vi.fn(async (_call, _signal, fence: () => boolean) => {
    if (!fence()) throw new Error(); return 'fixture content';
  });
  const handle = await startClaudeNativeBroker({ scope: SCOPE, now: () => TIME, observation: () => observed,
    admission: () => admitted, execute }); handles.push(handle);
  return { handle, execute, setObserved(value: ClaudeBrokerObservation | null) { observed = value; },
    setAdmitted(value: boolean) { admitted = value; } };
}
function call(handle: ClaudeBrokerHandle, method = 'tools/call', params: unknown = { name: 'read_file', arguments: { path: 'hello.txt' } },
  headers: Record<string, string> = {}) {
  return fetch(handle.url, { method: 'POST', headers: { Authorization: `Bearer ${handle.capability}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
describe('native Claude tool broker', () => {
  it('keeps ambient auth, proxy and loader variables out of the native profile launcher', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
      vi.stubEnv(key, 'ambient-value');
    }
    const env = claudeBrokerNativeEnvironment();
    expect(Object.values(env)).not.toContain('ambient-value'); expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
  });
  it('selects only the exact native profile and no built-in tools, API credentials or prompt argv', () => {
    const command = claudeBrokerCommand({ provider: 'claude', seatId: 'claude-a', command: ['/opt/node', '/private/profile/launcher.mjs'],
      executable: '/opt/claude', nativeStatePath: '/private/profile' }, SCOPE, '/private/run/mcp.json');
    expect(command.bin).toBe('/opt/node'); expect(command.args[0]).toBe('/private/profile/launcher.mjs');
    expect(command.args).toContain('--restricted'); expect(command.args.slice(command.args.indexOf('--tools'), command.args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(command.args).toContain('--strict-mcp-config'); expect(command.args).toContain('--allowedTools=mcp__ashlr-fleet-broker');
    expect(command.args.join(' ')).not.toMatch(/token|api.key|bypass|dangerously/i);
    expect(() => claudeBrokerCommand({ provider: 'claude', seatId: 'claude-b', command: ['/opt/node', '/p/launcher.mjs'],
      executable: '/opt/claude', nativeStatePath: '/p' }, SCOPE, '/private/run/mcp.json')).toThrow();
  });
  it('performs a real MCP initialize/notification/list/call through loopback', async () => {
    const { handle, execute } = await setup();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const init = await call(handle, 'initialize', { protocolVersion: '2025-03-26' });
    expect((await init.json()).result.protocolVersion).toBe('2025-03-26');
    const notification = await fetch(handle.url, { method: 'POST', headers: { Authorization: `Bearer ${handle.capability}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(notification.status).toBe(202);
    expect((await (await call(handle, 'tools/list', {})).json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file', 'write_file']);
    expect((await (await call(handle)).json()).result.content[0].text).toBe('fixture content'); expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    { accountDigest: 'd'.repeat(64) }, { profileDigest: 'd'.repeat(64) }, { epochDigest: 'd'.repeat(64) },
    { model: 'other-model' }, { seatId: 'claude-b' }, { runId: 'other-run' }, { observedAtMs: TIME + 1 },
    { expiresAtMs: TIME }, { expiresAtMs: TIME + 100_000 }, { extraUsageEnabled: true }, { authMethod: 'api_key' },
    { extraUsageEnabled: null }, { extraUsageEnabled: 0 }, { extraUsageEnabled: 'false' },
  ])('holds changed/stale/credit-enabled native observations: %j', async patch => {
    const { handle, execute, setObserved } = await setup();
    setObserved({ ...OBSERVED, ...patch } as ClaudeBrokerObservation);
    expect((await call(handle)).status).toBe(403); expect(execute).not.toHaveBeenCalled();
  });
  it('correlates protocol errors and sanitizes recoverable tool failures', async () => {
    const {handle,execute}=await setup();
    const request=async(id:string,method:string,params:unknown={})=>(await fetch(handle.url,{method:'POST',
      headers:{Authorization:`Bearer ${handle.capability}`,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params})})).json();
    expect(await request('ping-id','ping')).toEqual({jsonrpc:'2.0',id:'ping-id',result:{}});
    expect(await request('unknown-id','unknown')).toMatchObject({id:'unknown-id',error:{code:-32601}});
    expect(await request('invalid-version','initialize',{protocolVersion:'invalid'})).toMatchObject({id:'invalid-version',error:{code:-32602}});
    execute.mockRejectedValueOnce(new Error('secret-host-path /private/credential token-private'));
    const failure=await request('missing-id','tools/call',{name:'read_file',arguments:{path:'missing'}});
    expect(failure).toEqual({jsonrpc:'2.0',id:'missing-id',result:{content:[{type:'text',text:'Tool request refused'}],isError:true}});
    expect(JSON.stringify(failure)).not.toMatch(/credential|token-private|secret-host/);
    expect(await request('recovery-id','tools/call',{name:'read_file',arguments:{path:'hello.txt'}})).toMatchObject({id:'recovery-id',result:{content:[{text:'fixture content'}]}});
  });
  it('supports actual current SDK negotiation, ping, listing and tool recovery', async () => {
    const {handle,execute}=await setup();
    const client=new Client({name:'offline-fixture',version:'1.0.0'});
    const errors:unknown[]=[];client.onerror=error=>{errors.push(error);};
    const transport=new StreamableHTTPClientTransport(new URL(handle.url),{requestInit:{headers:{Authorization:`Bearer ${handle.capability}`}}});
    try {
      await client.connect(transport);await client.ping();
      expect((await client.listTools()).tools.map(tool=>tool.name)).toEqual(['read_file','write_file']);
      expect((await fetch(handle.url,{headers:{Authorization:`Bearer ${handle.capability}`}})).status).toBe(405);
      expect((await fetch(handle.url)).status).toBe(403);
      expect((await call(handle,'ping',{}, {'mcp-protocol-version':'2025-11-25'})).status).toBe(400);
      execute.mockRejectedValueOnce(new Error('missing-file-secret'));
      expect(await client.callTool({name:'read_file',arguments:{path:'missing'}})).toMatchObject({isError:true});
      expect(await client.callTool({name:'write_file',arguments:{path:'hello',text:'fixture'}})).toMatchObject({content:[{text:'fixture content'}]});
    expect(errors).toEqual([]);
    } finally {await client.close();}
  });
  it('rechecks authority for each request and unknown observations never enroll', async () => {
    const { handle, execute, setAdmitted, setObserved } = await setup();
    expect((await call(handle)).status).toBe(200);
    setAdmitted(false); expect((await call(handle)).status).toBe(403);
    setAdmitted(true); setObserved(null); expect((await call(handle)).status).toBe(403);
    expect(execute).toHaveBeenCalledOnce();
  });
  it('refuses cross-run capabilities, provider auth headers, origins and arbitrary routes', async () => {
    const first = await setup(); const second = await setup();
    for (const headers of [{ Authorization: `Bearer ${second.handle.capability}` }, { 'x-api-key': 'provider-token' },
      { 'proxy-authorization': 'provider-token' }, { Origin: 'https://hostile.example' }]) {
      expect((await call(first.handle, 'tools/list', {}, headers)).status).toBe(403);
    }
    expect((await fetch(first.handle.url + '/other', { method: 'POST', headers: { Authorization: `Bearer ${first.handle.capability}` } })).status).toBe(403);
    expect(first.execute).not.toHaveBeenCalled();
  });
  it('refuses non-ASCII and malformed capabilities over real HTTP without taking down the host', async () => {
    const { handle, execute } = await setup();
    for (const value of ['é'.repeat(43), 'a'.repeat(42) + '=', 'a'.repeat(42) + '/', 'a'.repeat(42), 'a'.repeat(44)]) {
      expect((await call(handle, 'tools/list', {}, { Authorization: `Bearer ${value}` })).status).toBe(403);
    }
    expect(execute).not.toHaveBeenCalled();
    // A rejected malformed header must not prevent the next authenticated call.
    expect((await call(handle)).status).toBe(200); expect(execute).toHaveBeenCalledOnce();
  });
  it('refuses extra tool argument fields, arbitrary tools and malformed/oversize requests', async () => {
    const { handle, execute } = await setup();
    for (const params of [{ name: 'bash', arguments: { path: 'hello' } }, { name: 'read_file', arguments: { path: 'hello', accountDigest: 'fake' } }]) {
      expect(await (await call(handle, 'tools/call', params)).json()).toMatchObject({jsonrpc:'2.0',id:1,error:{code:-32602}});
    }
    const large = await fetch(handle.url, { method: 'POST', headers: { Authorization: `Bearer ${handle.capability}` }, body: 'a'.repeat(1024 * 1024 + 1) }).catch(() => null);
    expect(large === null || large.status === 400).toBe(true); expect(execute).not.toHaveBeenCalled();
  });
  it('does not publish a result after authority changes during awaited execution', async () => {
    let allowed = true; let gateAfterAwait = true;
    const handle = await startClaudeNativeBroker({ scope: SCOPE, now: () => TIME, observation: () => OBSERVED, admission: () => allowed,
      execute: async (_call, _signal, fence) => { await Promise.resolve(); allowed = false; gateAfterAwait = fence(); return 'private output'; } });
    handles.push(handle); const response = await call(handle);
    expect(response.status).toBe(403); expect(gateAfterAwait).toBe(false); expect(await response.text()).not.toContain('private output');
  });
  it('aborts an active executor and closes the listener on Stop', async () => {
    const stop = new AbortController(); let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; }); let cancelled = false;
    const handle = await startClaudeNativeBroker({ scope: SCOPE, now: () => TIME, observation: () => OBSERVED, admission: () => true, signal: stop.signal,
      execute: async (_call, signal) => { ready(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return ''; } });
    handles.push(handle); const response = call(handle).catch(() => null);
    await started; stop.abort(); await handle.close(); await response; expect(cancelled).toBe(true);
    await expect(call(handle)).rejects.toThrow();
  });
  it('client disconnect cancels execution and close waits for owned execution cleanup', async () => {
    const client = new AbortController(); let started!: () => void; let release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const cleaned = new Promise<void>(resolve => { release = resolve; }); let cancelled = false;
    const handle = await startClaudeNativeBroker({ scope: SCOPE, now: () => TIME, observation: () => OBSERVED, admission: () => true,
      execute: async (_call, signal) => { started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => {
        cancelled = true; resolve();
      }, { once: true })); await cleaned; return ''; } }); handles.push(handle);
    const response = fetch(handle.url, { method: 'POST', signal: client.signal, headers: { Authorization: `Bearer ${handle.capability}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'hello' } } }) }).catch(() => null);
    await began; client.abort(); await response;
    let closed = false; const close = handle.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cancelled).toBe(true); expect(closed).toBe(false);
    release(); await close; expect(closed).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('refuses to launch a fixed source worker located in the agent-writable worktree',async()=>{
    const worker=resolveClaudeBrokerToolInvocation();const source=worker.readOnlyPaths[0]!;
    const before=readFileSync(source);const execute=claudeBrokerToolExecutor({worktree:dirname(source),cfg:defaultConfig(),recordEvidence() {},retainCleanupFailure() {}});
    await expect(execute({name:'write_file',path:'must-not-create',text:'no'},new AbortController().signal,()=>true)).rejects.toThrow('source cannot be inside');
    expect(readFileSync(source)).toEqual(before);expect(worker.isCurrent()).toBe(true);
  });
  it.runIf(process.platform === 'darwin')('refuses tool contact when a confirmed watcher closes before the actual spawn fence',async()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-tool-watch-loss-')));dirs.push(root);
    let reads=0;
    setKernelEvidenceWatcherForTest(tag=>({tag,get ready(){return ++reads===1;},finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort() {}}));
    const execute=claudeBrokerToolExecutor({worktree:root,cfg:defaultConfig(),recordEvidence() {},retainCleanupFailure(){throw Error('unexpected retention');}});
    await expect(execute({name:'write_file',path:'not-created',text:'must not spawn'},new AbortController().signal,()=>true)).rejects.toThrow('tool request refused');
    expect(reads).toBeGreaterThan(1);
    expect(()=>readFileSync(join(root,'not-created'))).toThrow();
  });
  it.runIf(process.platform === 'darwin')('uses a real separately OS-jailed worker for read/write, rejecting path escapes and symlinks', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-broker-prototype-'))); dirs.push(root);
    writeFileSync(join(root, 'hello.txt'), 'first'); symlinkSync('/etc/passwd', join(root, 'escape'));
    writeFileSync(join(root, 'linked-source'), 'fixture'); linkSync(join(root, 'linked-source'), join(root, 'hardlink'));
    const evidence: AutonomousSpawnFinish[] = [];
    // A synthetic complete watcher isolates transport/OS jail tests from actual kernel-log permissions.
    setKernelEvidenceWatcherForTest(tag => ({tag,ready:true,finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort() {}}));
    const execute = claudeBrokerToolExecutor({ worktree: root, cfg: defaultConfig(), recordEvidence: value => {evidence.push(value);},retainCleanupFailure() {} });
    const handle = await startClaudeNativeBroker({ scope: SCOPE, now: () => TIME, observation: () => OBSERVED, admission: () => true, execute }); handles.push(handle);
    expect((await (await call(handle)).json()).result.content[0].text).toBe('first');
    expect((await call(handle, 'tools/call', { name: 'write_file', arguments: { path: 'hello.txt', text: 'second' } })).status).toBe(200);
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('second');
    for (const path of ['../outside.txt', '/etc/passwd', 'escape', 'hardlink']) expect(await (await call(handle, 'tools/call', { name: 'read_file', arguments: { path } })).json()).toMatchObject({jsonrpc:'2.0',id:1,result:{isError:true}});
    expect(evidence.length).toBe(6);
    expect(evidence.length).toBeGreaterThan(0);
    // The injected watch qualifies this seam, not live kernel logging.
    expect(evidence.every(value => value.violationsKnown === true)).toBe(true);
  });
});
