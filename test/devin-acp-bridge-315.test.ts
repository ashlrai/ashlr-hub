/**
 * 3.15 — the Devin CLI seat's ACP bridge against a FAKE `devin acp` (an
 * in-memory child whose stdio speaks ACP v1 JSON-RPC). No binary is run, no
 * session is paid for. Covers: new session, resume via session/load (history
 * replay not re-shown), streaming → transcript lines, tool calls, permission
 * answers by mode, auth failure → login hint, a lost conversation →
 * native-thread-missing, Stop → session/cancel, and that nothing from the
 * CLI's stderr is forwarded.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { choosePermission, devinAcpArgs, runDevinCliTurn } from '../src/core/devin/acp-bridge.js';
import type { DevinTurnIo } from '../src/core/devin/chat-runner.js';
import type { DevinTurnLine, DevinTurnPayload } from '../src/core/devin/turn-protocol.js';

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

interface AgentScript {
  loadSession?: boolean;
  /** Called for each client request; return a result, or `{ error }`; `null` = no answer (hang). */
  onRequest(msg: Msg, agent: FakeAgent): unknown;
}

class FakeAgent extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  received: Msg[] = [];
  answers: Msg[] = [];
  killed: string[] = [];
  stdin: Writable;
  pid = 4242;
  private buffer = '';

  constructor(private readonly script: AgentScript) {
    super();
    this.stdout.setEncoding('utf8');
    this.stdin = new Writable({
      write: (chunk, _enc, done) => {
        this.buffer += String(chunk);
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (line.trim()) this.handle(JSON.parse(line) as Msg);
        }
        done();
      },
    });
  }

  send(msg: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  update(sessionId: string, update: Record<string, unknown>): void {
    this.send({ method: 'session/update', params: { sessionId, update } });
  }

  private handle(msg: Msg): void {
    this.received.push(msg);
    if (msg.method === undefined) {
      this.answers.push(msg); // our answer to an agent→client request
      this.emit('answer', msg);
      return;
    }
    if (msg.id === undefined) return; // a notification (session/cancel)
    const out = this.script.onRequest(msg, this);
    if (out === null) return;
    if (out && typeof out === 'object' && 'error' in (out as object)) this.send({ id: msg.id, error: (out as { error: unknown }).error });
    else this.send({ id: msg.id, result: out });
  }

  kill(signal = 'SIGTERM'): boolean {
    this.killed.push(signal);
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function initResult(loadSession: boolean) {
  return { protocolVersion: 1, agentCapabilities: { loadSession }, authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }] };
}

function harness(script: AgentScript) {
  const agent = new FakeAgent(script);
  const calls: Array<{ bin: string; args: string[]; cwd: unknown }> = [];
  const fakeSpawn = ((bin: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ bin, args, cwd: opts.cwd });
    return agent;
  }) as unknown as typeof import('node:child_process').spawn;
  const lines: DevinTurnLine[] = [];
  const controller = new AbortController();
  const io: DevinTurnIo = {
    emit: (l) => { lines.push(l); },
    signal: controller.signal,
    sleep: async () => undefined,
    now: () => 1_000,
  };
  return { agent, calls, lines, controller, io, deps: { spawn: fakeSpawn, env: {}, requestTimeoutMs: 2_000, cancelGraceMs: 50 } };
}

function payload(patch: Partial<DevinTurnPayload> = {}): DevinTurnPayload {
  return {
    v: 1, lane: 'cli', verseSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nativeId: null, projectPath: '/tmp/proj',
    text: 'Rename the helper', permissionMode: 'accept-edits', cliPath: '/opt/homebrew/bin/devin', model: null, ...patch,
  };
}

const types = (lines: DevinTurnLine[]) => lines.map((l) => l.type);

describe('Devin CLI over ACP', () => {
  it('new session: streams text, tool calls and results, then ends the turn', async () => {
    const h = harness({
      onRequest(msg, agent) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/new') {
          expect(msg.params).toEqual({ cwd: '/tmp/proj', mcpServers: [] });
          return { sessionId: 'brisk-otter' };
        }
        if (msg.method === 'session/prompt') {
          expect(msg.params).toEqual({ sessionId: 'brisk-otter', prompt: [{ type: 'text', text: 'Rename the helper' }] });
          agent.stderr.write('INFO Starting stdio MCP server secret-wrapper --token cog_leakleakleakleak\n');
          agent.send({ method: '_cognition.ai/output', params: { channel: 'MCP', message: 'cog_leakleakleakleak' } });
          agent.update('brisk-otter', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Find the helper first.' } });
          agent.update('brisk-otter', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking ' } });
          agent.update('brisk-otter', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'now.' } });
          agent.update('brisk-otter', { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read src/helper.ts', kind: 'read', status: 'pending', rawInput: { path: 'src/helper.ts' } });
          agent.update('brisk-otter', { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'export function helper() {}' } }] });
          agent.update('brisk-otter', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Renamed it.' } });
          setImmediate(() => agent.send({ id: msg.id, result: { stopReason: 'end_turn' } }));
          return null;
        }
        return { error: { code: -32601, message: 'nope' } };
      },
    });
    const code = await runDevinCliTurn(payload(), h.io, h.deps);
    expect(code).toBe(0);
    expect(h.calls[0]).toEqual({ bin: '/opt/homebrew/bin/devin', args: ['--sandbox', '--permission-mode', 'accept-edits', 'acp'], cwd: '/tmp/proj' });
    expect(types(h.lines)).toEqual([
      'native-session', 'progress',
      'thinking-delta', 'thinking', 'text-delta', 'text-delta',
      'assistant-message', 'tool-use', 'progress', 'tool-result',
      'text-delta', 'assistant-message',
    ]);
    expect(h.lines[0]).toEqual({ type: 'native-session', id: 'brisk-otter' });
    expect(h.lines.filter((l) => l.type === 'assistant-message')).toEqual([
      { type: 'assistant-message', text: 'Looking now.' },
      { type: 'assistant-message', text: 'Renamed it.' },
    ]);
    expect(h.lines.find((l) => l.type === 'tool-use')).toEqual({ type: 'tool-use', toolUseId: 'call-1', name: 'Read src/helper.ts', input: { path: 'src/helper.ts' } });
    expect(h.lines.find((l) => l.type === 'tool-result')).toEqual({ type: 'tool-result', toolUseId: 'call-1', output: 'export function helper() {}', isError: false });
    // Nothing from the CLI's stderr or its output channel reaches the transcript.
    expect(JSON.stringify(h.lines)).not.toContain('leakleak');
  });

  it('resume: session/load, replayed history is not re-shown', async () => {
    const h = harness({
      onRequest(msg, agent) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/load') {
          expect(msg.params).toEqual({ sessionId: 'brisk-otter', cwd: '/tmp/proj', mcpServers: [] });
          agent.update('brisk-otter', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLY' } });
          setImmediate(() => agent.send({ id: msg.id, result: null }));
          return null;
        }
        if (msg.method === 'session/prompt') {
          agent.update('brisk-otter', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New reply.' } });
          setImmediate(() => agent.send({ id: msg.id, result: { stopReason: 'end_turn' } }));
          return null;
        }
        return { error: { code: -32601, message: 'nope' } };
      },
    });
    expect(await runDevinCliTurn(payload({ nativeId: 'brisk-otter' }), h.io, h.deps)).toBe(0);
    expect(h.agent.received.some((m) => m.method === 'session/new')).toBe(false);
    const text = h.lines.filter((l) => l.type === 'assistant-message');
    expect(text).toEqual([{ type: 'assistant-message', text: 'New reply.' }]);
  });

  it('a conversation the CLI no longer has → native-thread-missing (the engine retries with a handoff note)', async () => {
    const h = harness({
      onRequest(msg) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/load') return { error: { code: -32602, message: 'session not found' } };
        return { error: { code: -32601, message: 'nope' } };
      },
    });
    expect(await runDevinCliTurn(payload({ nativeId: 'gone-session' }), h.io, h.deps)).toBe(1);
    expect(h.lines.at(-1)).toMatchObject({ type: 'error', code: 'native-thread-missing' });
  });

  it('not logged in → the login command, never a raw protocol error', async () => {
    const h = harness({
      onRequest(msg) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/new') return { error: { code: -32000, message: 'Authentication required' } };
        return null;
      },
    });
    expect(await runDevinCliTurn(payload(), h.io, h.deps)).toBe(1);
    expect(h.lines.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/devin auth login/) });
  });

  it('answers permission requests by the chat’s mode', async () => {
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    expect(choosePermission('accept-edits', { toolCall: { kind: 'execute' }, options })).toBe('yes');
    expect(choosePermission('bypass', { toolCall: { kind: 'edit' }, options })).toBe('yes');
    expect(choosePermission('plan', { toolCall: { kind: 'read' }, options })).toBe('yes');
    expect(choosePermission('plan', { toolCall: { kind: 'edit' }, options })).toBe('no');
    expect(choosePermission('plan', { toolCall: { kind: 'execute' }, options: options.filter((o) => o.kind !== 'reject_once') })).toBeNull();
    expect(devinAcpArgs({ permissionMode: 'plan', model: 'opus' })).toEqual(['--permission-mode', 'auto', 'acp', '--model', 'opus']);
    expect(devinAcpArgs({ permissionMode: 'bypass', model: null })).toEqual(['--permission-mode', 'dangerous', 'acp']);

    // End to end: the agent asks, the bridge answers "reject" in Plan mode.
    const h = harness({
      onRequest(msg, agent) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/new') return { sessionId: 's1' };
        if (msg.method === 'session/prompt') {
          agent.send({ id: 900, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c', kind: 'edit' }, options } });
          agent.once('answer', () => agent.send({ id: msg.id, result: { stopReason: 'end_turn' } }));
          return null;
        }
        return null;
      },
    });
    expect(await runDevinCliTurn(payload({ permissionMode: 'plan' }), h.io, h.deps)).toBe(0);
    expect(h.agent.answers).toEqual([{ jsonrpc: '2.0', id: 900, result: { outcome: { outcome: 'selected', optionId: 'no' } } }]);
  });

  it('refuses fs/terminal requests it never advertised', async () => {
    const h = harness({
      onRequest(msg, agent) {
        if (msg.method === 'initialize') {
          expect(msg.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
          return initResult(true);
        }
        if (msg.method === 'session/new') return { sessionId: 's1' };
        if (msg.method === 'session/prompt') {
          agent.send({ id: 901, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
          agent.once('answer', () => agent.send({ id: msg.id, result: { stopReason: 'end_turn' } }));
          return null;
        }
        return null;
      },
    });
    expect(await runDevinCliTurn(payload(), h.io, h.deps)).toBe(0);
    expect(h.agent.answers[0]).toMatchObject({ id: 901, error: { code: -32601 } });
  });

  it('Stop sends session/cancel, then ends the process (exit 130)', async () => {
    const h = harness({
      onRequest(msg, agent) {
        if (msg.method === 'initialize') return initResult(true);
        if (msg.method === 'session/new') return { sessionId: 's1' };
        if (msg.method === 'session/prompt') {
          agent.update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it' } });
          setImmediate(() => h.controller.abort());
          return null; // never answers on its own
        }
        return null;
      },
    });
    expect(await runDevinCliTurn(payload(), h.io, h.deps)).toBe(130);
    expect(h.agent.received.some((m) => m.method === 'session/cancel' && (m.params as { sessionId?: string }).sessionId === 's1')).toBe(true);
    expect(h.agent.killed.length).toBeGreaterThan(0);
    // What streamed before the Stop is kept.
    expect(h.lines.find((l) => l.type === 'assistant-message')).toEqual({ type: 'assistant-message', text: 'Working on it' });
  });
});
