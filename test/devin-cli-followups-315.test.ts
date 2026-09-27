/**
 * 3.15 follow-ups for the Devin (CLI) chat seat:
 *
 *   - the readiness probe (cli-probe.ts): binary present + logged in, async,
 *     briefly cached, the fixing command in the refusal — and the engine's
 *     synchronous gate reading the same answer;
 *   - PR URLs a CLI turn prints become the chat's PR card and a Needs-you
 *     item shaped exactly like a Devin cloud chat's PR (owner-lane-pr naming
 *     the chat), with Dismiss;
 *   - the overview says the CLI's usage is not reported (not counted).
 *
 * No `devin` binary is run and no session is paid for: the binary is a temp
 * file, the ACP agent an in-memory fake. HOME is the worker's isolated one.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDevinCliTurn } from '../src/core/devin/acp-bridge.js';
import type { DevinTurnIo } from '../src/core/devin/chat-runner.js';
import { DEVIN_CLI_PR_WINDOW_MS, dismissDevinCliPr, findGithubPrUrls, listDevinCliPrs, readDismissedDevinCliPrs, recordDevinCliPrs } from '../src/core/devin/cli-prs.js';
import { DEVIN_CLI_PROBE_TTL_MS, peekDevinCliProbe, probeDevinCli, resetDevinCliProbeForTest } from '../src/core/devin/cli-probe.js';
import { devinCliNeedsYouItems } from '../src/core/devin/devin-api.js';
import { devinOverview } from '../src/core/devin/service.js';
import { devinHome } from '../src/core/devin/store.js';
import type { DevinTurnLine, DevinTurnPayload } from '../src/core/devin/turn-protocol.js';
import { devinCliTurnReadiness, devinSeatReadiness, discoverDevinSeats } from '../src/core/verse/devin-seats.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';

const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let dir: string;
let bin: string;
let creds: string;

beforeEach(() => {
  resetDevinCliProbeForTest();
  rmSync(devinHome(), { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'devin-cli-probe-'));
  bin = join(dir, 'devin');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  creds = join(dir, 'credentials.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Readiness probe
// ---------------------------------------------------------------------------

describe('the Devin CLI readiness probe', () => {
  it('ready / logged out / missing — each refusal names the command that fixes it', async () => {
    writeFileSync(creds, 'x');
    expect(await probeDevinCli({ cliCandidates: [bin], cliCredentialsPath: creds, maxAgeMs: 0 })).toMatchObject({ state: 'ready', cliPath: bin, reason: null });

    rmSync(creds);
    const out = await probeDevinCli({ cliCandidates: [bin], cliCredentialsPath: creds, maxAgeMs: 0 });
    expect(out).toMatchObject({ state: 'logged-out', cliPath: bin });
    expect(out.reason).toMatch(/`devin auth login`/);

    const missing = await probeDevinCli({ cliCandidates: [join(dir, 'nope'), 'relative/devin'], cliCredentialsPath: creds, maxAgeMs: 0 });
    expect(missing).toMatchObject({ state: 'missing', cliPath: null });
    expect(missing.reason).toMatch(/`brew install --cask devin-cli`.*`devin auth login`/);
  });

  it('reuses an answer for a few seconds, and one probe serves concurrent callers', async () => {
    let t = 1_000_000;
    const now = () => t;
    const opts = { cliCandidates: [bin], cliCredentialsPath: creds, now };
    const [a, b] = await Promise.all([probeDevinCli(opts), probeDevinCli(opts)]);
    expect(a).toBe(b);
    expect(a.state).toBe('logged-out');
    writeFileSync(creds, 'x');
    expect((await probeDevinCli(opts)).state).toBe('logged-out'); // cached
    t += DEVIN_CLI_PROBE_TTL_MS + 1;
    expect((await probeDevinCli(opts)).state).toBe('ready');
  });

  it('the seat picker and the turn gate read the same answer', async () => {
    const opts = { cliCandidates: [bin], cliCredentialsPath: creds };
    const status = async () => ({ state: 'not-connected' as const, reason: '' });
    // No answer yet: the synchronous gate admits (the route always probes first).
    expect(devinSeatReadiness('devin-cli')).toMatchObject({ ready: true });

    const seats = await discoverDevinSeats({ ...opts, status });
    const cli = seats.seats.find((s) => s.id === 'devin-cli')!;
    expect(cli.health.state).toBe('unavailable');
    expect(cli.models[0]!.unavailableReason).toMatch(/devin auth login/);
    // Discovery's probe is what the engine gate now answers with.
    expect(devinSeatReadiness('devin-cli')).toMatchObject({ ready: false, reason: expect.stringMatching(/`devin auth login`/) });

    writeFileSync(creds, 'x');
    resetDevinCliProbeForTest();
    expect(await devinCliTurnReadiness(opts)).toMatchObject({ seatId: 'devin-cli', ready: true, reason: null });
    expect(devinSeatReadiness('devin-cli')).toMatchObject({ ready: true });
  });

  it('a stale answer is not trusted by the gate', async () => {
    let t = 5_000_000;
    await probeDevinCli({ cliCandidates: [bin], cliCredentialsPath: creds, now: () => t });
    expect(peekDevinCliProbe(60_000, () => t)?.state).toBe('logged-out');
    t += 60_001;
    expect(peekDevinCliProbe(60_000, () => t)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PRs from a CLI turn
// ---------------------------------------------------------------------------

describe('PR URLs in Devin CLI output', () => {
  it('finds GitHub PR URLs once each, in order, and nothing else', () => {
    expect(findGithubPrUrls([
      'Opened https://github.com/ashlrai/demo/pull/12 — see https://github.com/ashlrai/demo/pull/12/files.',
      'Also https://github.com/other/repo/pull/3, not https://github.com/ashlrai/demo/issues/4',
      'nor http://github.com/a/b/pull/5 or https://gitlab.com/a/b/pull/6',
    ].join('\n'))).toEqual([
      { url: 'https://github.com/ashlrai/demo/pull/12', repo: 'ashlrai/demo', number: 12 },
      { url: 'https://github.com/other/repo/pull/3', repo: 'other/repo', number: 3 },
    ]);
  });

  class FakeAgent extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin: Writable;
    private buffer = '';
    constructor(private readonly onPrompt: (agent: FakeAgent) => void) {
      super();
      this.stdout.setEncoding('utf8');
      this.stdin = new Writable({
        write: (chunk, _enc, done) => {
          this.buffer += String(chunk);
          let nl: number;
          while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            if (line.trim()) this.handle(JSON.parse(line) as { id?: number; method?: string });
          }
          done();
        },
      });
    }
    send(msg: Record<string, unknown>): void {
      this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    }
    update(update: Record<string, unknown>): void {
      this.send({ method: 'session/update', params: { sessionId: 'otter', update } });
    }
    private handle(msg: { id?: number; method?: string }): void {
      if (msg.id === undefined || msg.method === undefined) return;
      if (msg.method === 'initialize') this.send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (msg.method === 'session/new' || msg.method === 'session/load') this.send({ id: msg.id, result: { sessionId: 'otter' } });
      else if (msg.method === 'session/prompt') {
        this.onPrompt(this);
        this.send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
    }
    kill(): boolean {
      setImmediate(() => this.emit('close', 0));
      return true;
    }
  }

  async function turn(text: string, onPrompt: (agent: FakeAgent) => void, recordPrs?: Parameters<typeof runDevinCliTurn>[2]['recordPrs']): Promise<DevinTurnLine[]> {
    const agent = new FakeAgent(onPrompt);
    const lines: DevinTurnLine[] = [];
    const io: DevinTurnIo = { emit: (l) => { lines.push(l); }, signal: new AbortController().signal, sleep: async () => undefined, now: () => 1_000 };
    const payload: DevinTurnPayload = {
      v: 1, lane: 'cli', verseSessionId: CHAT, nativeId: null, projectPath: '/tmp/proj', text,
      permissionMode: 'accept-edits', cliPath: '/opt/homebrew/bin/devin', model: null,
    };
    const spawn = (() => agent) as unknown as typeof import('node:child_process').spawn;
    expect(await runDevinCliTurn(payload, io, { spawn, env: {}, requestTimeoutMs: 2_000, cancelGraceMs: 50, ...(recordPrs ? { recordPrs } : {}) })).toBe(0);
    return lines;
  }

  const opened = (agent: FakeAgent) => {
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'gh pr create', kind: 'execute' });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'https://github.com/ashlrai/demo/pull/12\n' } }] });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Opened https://github.com/ashlrai/demo/pull/12 as asked (see also https://github.com/ashlrai/demo/pull/7).' } });
  };

  it('records the PRs for the chat and cards each one the first time the chat sees it', async () => {
    // pull/7 is in the operator's own message: theirs, not this turn's.
    const lines = await turn('fix it like https://github.com/ashlrai/demo/pull/7 did', opened);
    expect(lines.filter((l) => l.type === 'remote-pr')).toEqual([{ type: 'remote-pr', url: 'https://github.com/ashlrai/demo/pull/12', state: null }]);
    expect(listDevinCliPrs()).toEqual([{ sessionId: CHAT, prs: [expect.objectContaining({ url: 'https://github.com/ashlrai/demo/pull/12', repo: 'ashlrai/demo', number: 12 })] }]);

    // A later turn that mentions it again: no second card, no second record.
    const again = await turn('status?', (agent) => agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still https://github.com/ashlrai/demo/pull/12.' } }));
    expect(again.filter((l) => l.type === 'remote-pr')).toEqual([]);
    expect(listDevinCliPrs()[0]!.prs).toHaveLength(1);
  });

  it('a recorder that fails never fails the turn', async () => {
    const lines = await turn('go', opened, () => { throw new Error('disk full'); });
    expect(lines.filter((l) => l.type === 'remote-pr')).toEqual([]);
    expect(lines.some((l) => l.type === 'assistant-message')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Needs-you
// ---------------------------------------------------------------------------

describe('a Devin CLI chat’s PR in Needs-you', () => {
  it('is the same owner-lane-pr a cloud chat’s PR is, naming the chat, with Dismiss', () => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    recordDevinCliPrs(CHAT, findGithubPrUrls('https://github.com/ashlrai/demo/pull/12'), new Date('2026-09-27T11:00:00.000Z'));
    const items = devinCliNeedsYouItems(listDevinCliPrs(), readDismissedDevinCliPrs(), now);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(isNeedsYouItem(item)).toBe(true);
    expect(item).toMatchObject({
      source: 'fleet',
      kind: 'owner-lane-pr',
      title: 'Devin (CLI) pull request: ashlrai/demo#12',
      subject: { repo: 'ashlrai/demo', pr: 12, seatId: 'devin-cli', sessionId: CHAT, engine: null },
      target: { kind: 'url', url: 'https://github.com/ashlrai/demo/pull/12' },
      expiresAt: new Date(Date.parse('2026-09-27T11:00:00.000Z') + DEVIN_CLI_PR_WINDOW_MS).toISOString(),
    });
    expect(item.actions).toEqual([expect.objectContaining({ label: 'Dismiss', request: { method: 'POST', path: `/api/verse/devin/cli-prs/${CHAT}/12/dismiss`, body: {} } })]);

    // Dismissed: gone. Unknown PR: 404.
    expect(dismissDevinCliPr(CHAT, 99)).toMatchObject({ ok: false, status: 404 });
    expect(dismissDevinCliPr(CHAT, 12)).toEqual({ ok: true });
    expect(devinCliNeedsYouItems(listDevinCliPrs(), readDismissedDevinCliPrs(), now)).toEqual([]);
  });

  it('leaves on its own once the window passes (nothing tracks a CLI PR to its merge)', () => {
    recordDevinCliPrs(CHAT, findGithubPrUrls('https://github.com/ashlrai/demo/pull/12'), new Date('2026-09-01T00:00:00.000Z'));
    expect(devinCliNeedsYouItems(listDevinCliPrs(), new Set(), new Date('2026-09-27T00:00:00.000Z'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('Devin CLI usage in the overview', () => {
  it('says the CLI reports no usage (so it is not counted), with the CLI’s state', async () => {
    // No connection on disk, so no Keychain read; config pinned.
    const overview = await devinOverview({ config: () => undefined, cliProbe: async () => ({ state: 'logged-out' }) });
    expect(overview.cli).toEqual({ state: 'logged-out', usage: 'not-reported' });
  });
});
