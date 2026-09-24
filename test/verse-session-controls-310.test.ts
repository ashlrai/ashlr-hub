/**
 * V3.10 session controls (SPEC-310C §7 C3) — the pure half:
 *
 *   - what each seat offers (model / effort / permission), unavailable
 *     choices listed WITH a reason, never hidden;
 *   - the ARGV SNAPSHOT for every engine × effort × permission mode — the
 *     default (accept-edits, no effort) is byte-identical to the 3.9 argv;
 *   - request parsing: unknown keys, bypass needs `confirmBypass`, defaults
 *     can never hold bypass;
 *   - the defaults file (0600) and what a new chat inherits;
 *   - attachments on disk (0700 dir, 0600 file, ≤ 8 MB, exact directory),
 *     the follow-up queue (max 3, hold/release, persisted 0600) and the `@`
 *     file finder's ranking.
 *
 * No subprocess, no network: HOME and every root are tmp dirs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adapterFor } from '../src/core/verse/adapters/index.js';
import {
  createAttachmentStore,
  expandHomeMentions,
  resolveAttachmentRefs,
  sanitizeAttachmentName,
  VERSE_ATTACHMENTS_PER_SESSION,
} from '../src/core/verse/attachments.js';
import { createFileIndex, fuzzyScore, rankFiles } from '../src/core/verse/file-index.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import {
  claudePermissionArgs,
  controlOptionsFor,
  effectiveControls,
  initialControlsFor,
  isVerseSessionControls,
  parseControlsUpdate,
  parseDefaultsUpdate,
  readControlDefaults,
  writeControlDefaults,
} from '../src/core/verse/session-controls.js';
import { createTurnQueue } from '../src/core/verse/turn-queue.js';
import {
  VERSE_EFFORTS,
  VERSE_PERMISSION_MODES,
  type VerseEffort,
  type VerseEngine,
  type VersePermissionMode,
  type VerseSeat,
  type VerseSession,
} from '../src/core/verse/types.js';
import { VERSE_ATTACHMENT_MAX_BYTES, VERSE_QUEUE_MAX } from '../src/core/verse/workbench-types.js';

let tmp: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-controls-310-'));
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTH = { state: 'unknown' as const, summary: null, windows: [], observedAt: null };

const SEATS: Record<VerseEngine, VerseSeat> = {
  claude: {
    id: 'claude-a', engine: 'claude', label: 'Claude Max', accountId: 'claude-a', contextWindow: 200_000, health: HEALTH,
    cliVersion: '2.1.280',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 200_000 },
      { id: 'claude-future', label: 'Future', contextWindow: 200_000, unavailableReason: 'needs Claude Code 2.1.300; this seat runs 2.1.280' },
    ],
  },
  codex: {
    id: 'codex-a', engine: 'codex', label: 'Codex', accountId: 'codex-a', contextWindow: 272_000, health: HEALTH,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }],
  },
  grok: {
    id: 'grok-a', engine: 'grok', label: 'Grok', accountId: 'grok-a', contextWindow: 500_000, health: HEALTH,
    models: [{ id: 'grok-4.6', label: 'Grok 4.6', contextWindow: 500_000 }],
  },
  local: {
    id: 'local:qwen', engine: 'local', label: 'Qwen (local)', accountId: 'local', contextWindow: 65_536, health: HEALTH,
    models: [{ id: 'qwen3:32b', label: 'Qwen3 32B', contextWindow: 65_536 }],
  },
};

function session(engine: VerseEngine, over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'sess-1',
    title: 'x',
    projectPath: '/tmp/proj',
    engine,
    accountId: SEATS[engine].accountId,
    seatId: SEATS[engine].id,
    model: SEATS[engine].models[0]!.id,
    nativeSessionId: engine === 'codex' ? null : '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000 },
    lastError: null,
    ...over,
  };
}

function launch(engine: VerseEngine, over: Partial<VerseSeatLaunch> & Record<string, unknown> = {}): VerseSeatLaunch {
  return {
    seat: SEATS[engine],
    launcher: engine === 'local' ? null : ['/usr/local/bin/node', `/nowhere/native-profiles/${engine}-a/launcher.mjs`],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    // Explicit, so no preference file is read.
    thinkingDisplay: false,
    ...over,
  } as VerseSeatLaunch;
}

function argvFor(engine: VerseEngine, controls: VerseSession['controls'], over: Partial<VerseSession> = {}, launchOver: Record<string, unknown> = {}): string[] {
  const s = session(engine, { ...(controls ? { controls } : {}), ...over });
  return adapterFor(engine).buildLaunch(s, 'hello', launch(engine, launchOver)).argv;
}

/** The value after `flag`, or null. */
function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('controlOptionsFor — what each seat offers', () => {
  it('lists every permission mode on every engine, with a reason on the ones it cannot honour', () => {
    const avail = (engine: VerseEngine) => Object.fromEntries(controlOptionsFor(SEATS[engine]).permissionModes.map((o) => [o.id, o.available]));
    expect(avail('claude')).toEqual({ plan: true, 'accept-edits': true, auto: true, bypass: true });
    expect(avail('grok')).toEqual({ plan: true, 'accept-edits': true, auto: true, bypass: true });
    expect(avail('codex')).toEqual({ plan: true, 'accept-edits': true, auto: false, bypass: true });
    expect(avail('local')).toEqual({ plan: true, 'accept-edits': true, auto: false, bypass: true });
    for (const engine of Object.keys(SEATS) as VerseEngine[]) {
      const options = controlOptionsFor(SEATS[engine]).permissionModes;
      expect(options.map((o) => o.id)).toEqual([...VERSE_PERMISSION_MODES]);
      for (const option of options) {
        if (!option.available) expect(option.reason, `${engine}/${option.id}`).toMatch(/\w{4,}/);
        expect(option.danger === true).toBe(option.id === 'bypass');
      }
    }
  });

  it('offers only the efforts each CLI accepts, and none on a claude build too old (or unknown) for --effort', () => {
    const avail = (engine: VerseEngine, v?: string | null) => controlOptionsFor(SEATS[engine], { claudeCliVersion: v ?? null })
      .efforts.filter((o) => o.available).map((o) => o.id);
    expect(avail('claude', '2.1.280')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(avail('claude', '2.1.243')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(avail('claude', '2.1.200')).toEqual([]);
    expect(avail('claude', null)).toEqual([]);
    expect(avail('codex')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(avail('grok')).toEqual(['low', 'medium', 'high']);
    expect(avail('local')).toEqual([]);
    const old = controlOptionsFor(SEATS.claude, { claudeCliVersion: '2.1.200' }).efforts[0]!;
    expect(old.reason).toContain('2.1.243');
  });

  it('shows an unavailable model disabled with its reason', () => {
    const models = controlOptionsFor(SEATS.claude).models;
    expect(models).toEqual([
      { id: 'claude-opus-5-5', label: 'Opus 5.5', available: true },
      { id: 'claude-future', label: 'Future', available: false, reason: 'needs Claude Code 2.1.300; this seat runs 2.1.280' },
    ]);
  });

  it('reports effective values: absent keys are the engine default', () => {
    expect(effectiveControls(session('claude'))).toEqual({ model: 'claude-opus-5-5', effort: null, permissionMode: 'accept-edits' });
    expect(effectiveControls(session('claude', { controls: { effort: 'high', permissionMode: 'plan' } })))
      .toEqual({ model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' });
  });
});

// ---------------------------------------------------------------------------
// Argv snapshot
// ---------------------------------------------------------------------------

describe('argv snapshot — every engine × effort × permission mode', () => {
  it('the DEFAULT is byte-identical to the 3.9 argv on every engine', () => {
    // claude
    const claude = argvFor('claude', undefined);
    expect(flagValue(claude, '--permission-mode')).toBe('acceptEdits');
    expect(claude).not.toContain('--effort');
    expect(argvFor('claude', {})).toEqual(claude);
    expect(argvFor('claude', { permissionMode: 'accept-edits' })).toEqual(claude);
    // codex, new thread and resume
    expect(argvFor('codex', undefined)).toEqual(['/usr/local/bin/node', '/nowhere/native-profiles/codex-a/launcher.mjs', 'exec',
      '--skip-git-repo-check', '--json', '--model', 'gpt-5.5', '--cd', '/tmp/proj', '--sandbox', 'workspace-write', '-']);
    expect(argvFor('codex', undefined, { nativeSessionId: 'thr-1', turnCount: 1 })).toEqual(['/usr/local/bin/node',
      '/nowhere/native-profiles/codex-a/launcher.mjs', 'exec', 'resume', 'thr-1', '--skip-git-repo-check', '--model', 'gpt-5.5', '--json', '-']);
    // grok
    const grok = argvFor('grok', undefined);
    expect(flagValue(grok, '--permission-mode')).toBe('dontAsk');
    expect(grok.some((a) => a.startsWith('--reasoning-effort'))).toBe(false);
    // local
    expect(flagValue(argvFor('local', undefined), '--permission-mode')).toBe('acceptEdits');
  });

  const CLAUDE_MODE: Record<VersePermissionMode, string> = { plan: 'plan', 'accept-edits': 'acceptEdits', auto: 'auto', bypass: 'bypassPermissions' };
  const GROK_MODE: Record<VersePermissionMode, string> = { plan: 'plan', 'accept-edits': 'dontAsk', auto: 'auto', bypass: 'bypassPermissions' };
  const CLAUDE_EFFORTS = new Set<VerseEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
  const CODEX_EFFORTS = new Set<VerseEffort>(['minimal', 'low', 'medium', 'high', 'xhigh']);
  const GROK_EFFORTS = new Set<VerseEffort>(['low', 'medium', 'high']);
  const efforts: Array<VerseEffort | null> = [null, ...VERSE_EFFORTS];

  for (const mode of VERSE_PERMISSION_MODES) {
    for (const effort of efforts) {
      const controls = { permissionMode: mode, ...(effort ? { effort } : {}) };
      const label = `${mode} × ${effort ?? 'default'}`;

      it(`claude: ${label}`, () => {
        const argv = argvFor('claude', controls);
        expect(flagValue(argv, '--permission-mode')).toBe(CLAUDE_MODE[mode]);
        expect(flagValue(argv, '--effort')).toBe(effort && CLAUDE_EFFORTS.has(effort) ? effort : null);
        // Every flag stays before the end-of-options marker; the prompt is last.
        expect(argv.indexOf('--permission-mode')).toBeLessThan(argv.indexOf('--'));
        expect(argv.at(-1)).toBe('hello');
        // Never the always-bypass flag: bypass is a mode, confirmed per chat.
        expect(argv).not.toContain('--dangerously-skip-permissions');
      });

      it(`local: ${label}`, () => {
        const argv = argvFor('local', controls);
        // Auto has no classifier on a local model: it falls back to the default.
        expect(flagValue(argv, '--permission-mode')).toBe(mode === 'auto' ? 'acceptEdits' : CLAUDE_MODE[mode]);
        expect(argv).not.toContain('--effort');
      });

      it(`codex: ${label}`, () => {
        const fresh = argvFor('codex', controls);
        const resumed = argvFor('codex', controls, { nativeSessionId: 'thr-1', turnCount: 1 });
        const effortArg = effort && CODEX_EFFORTS.has(effort) ? `model_reasoning_effort="${effort}"` : null;
        for (const argv of [fresh, resumed]) {
          const configs = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []));
          if (effortArg) expect(configs).toContain(effortArg);
          else expect(configs.some((c) => c?.startsWith('model_reasoning_effort'))).toBe(false);
          expect(argv.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(mode === 'bypass');
          expect(argv.at(-1)).toBe('-');
          expect(flagValue(argv, '--model')).toBe('gpt-5.5');
        }
        const sandbox = flagValue(fresh, '--sandbox');
        expect(sandbox).toBe(mode === 'plan' ? 'read-only' : mode === 'bypass' ? null : 'workspace-write');
        expect(resumed).not.toContain('--sandbox');
        const resumedConfigs = resumed.flatMap((a, i) => (a === '-c' ? [resumed[i + 1]] : []));
        expect(resumedConfigs.includes('sandbox_mode="read-only"')).toBe(mode === 'plan');
      });

      it(`grok: ${label}`, () => {
        const argv = argvFor('grok', controls);
        expect(flagValue(argv, '--permission-mode')).toBe(GROK_MODE[mode]);
        const effortFlag = argv.find((a) => a.startsWith('--reasoning-effort='));
        expect(effortFlag ?? null).toBe(effort && GROK_EFFORTS.has(effort) ? `--reasoning-effort=${effort}` : null);
        expect(argv.at(-1)).toBe('--single=hello');
      });
    }
  }

  it('claude --effort is withheld when the pinned build predates it', () => {
    const argv = adapterFor('claude').buildLaunch(
      session('claude', { controls: { effort: 'high' } }),
      'hello',
      launch('claude', { seat: { ...SEATS.claude, cliVersion: '2.1.200' } }),
    ).argv;
    expect(argv).not.toContain('--effort');
  });

  it('attachments: claude/local get exactly ONE --add-dir for the chat folder; codex gets --image per picture', () => {
    const dir = '/home/u/.ashlr/verse/attachments/sess-1';
    const extras = { attachmentDirs: [dir], attachmentImages: [`${dir}/0a0b0c0d-shot.png`] };
    const claude = argvFor('claude', undefined, {}, extras);
    expect(claude.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(flagValue(claude, '--add-dir')).toBe(dir);
    expect(argvFor('claude', undefined).includes('--add-dir')).toBe(false);
    const local = argvFor('local', undefined, {}, extras);
    expect(flagValue(local, '--add-dir')).toBe(dir);
    for (const argv of [argvFor('codex', undefined, {}, extras), argvFor('codex', undefined, { nativeSessionId: 'thr-1', turnCount: 1 }, extras)]) {
      const at = argv.indexOf(`--image=${dir}/0a0b0c0d-shot.png`);
      expect(at).toBeGreaterThan(0);
      // The variadic --image is always followed by a flag, never by the stdin marker.
      expect(argv[at + 1]!.startsWith('--')).toBe(true);
      expect(argv).not.toContain('--add-dir');
    }
  });

  it('a stored effort the engine does not take is dropped, not passed', () => {
    expect(argvFor('grok', { effort: 'max' }).some((a) => a.startsWith('--reasoning-effort'))).toBe(false);
    expect(argvFor('codex', { effort: 'max' }).some((a) => a.includes('model_reasoning_effort'))).toBe(false);
    expect(claudePermissionArgs({ engine: 'local', controls: { permissionMode: 'auto' } })).toEqual(['--permission-mode', 'acceptEdits']);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('request parsing', () => {
  it('refuses unknown keys, empty updates and malformed values', () => {
    expect(parseControlsUpdate({ modle: 'x' })).toEqual({ ok: false, error: 'unknown field(s): modle' });
    expect(parseControlsUpdate({})).toMatchObject({ ok: false });
    expect(parseControlsUpdate({ effort: 'extreme' })).toMatchObject({ ok: false });
    expect(parseControlsUpdate({ permissionMode: 'yolo' })).toMatchObject({ ok: false });
    expect(parseControlsUpdate({ model: '' })).toMatchObject({ ok: false });
    expect(parseControlsUpdate({ effort: null })).toEqual({ ok: true, update: { effort: null } });
    expect(parseControlsUpdate({ model: ' gpt-5.5 ', effort: 'high', permissionMode: 'plan' }))
      .toEqual({ ok: true, update: { model: 'gpt-5.5', effort: 'high', permissionMode: 'plan' } });
  });

  it('bypass needs confirmBypass: true', () => {
    expect(parseControlsUpdate({ permissionMode: 'bypass' })).toMatchObject({ ok: false, error: expect.stringContaining('confirm') });
    expect(parseControlsUpdate({ permissionMode: 'bypass', confirmBypass: 'yes' })).toMatchObject({ ok: false });
    expect(parseControlsUpdate({ permissionMode: 'bypass', confirmBypass: true }))
      .toEqual({ ok: true, update: { permissionMode: 'bypass', confirmBypass: true } });
  });

  it('defaults can never hold bypass', () => {
    expect(parseDefaultsUpdate({ permissionMode: 'bypass' })).toMatchObject({ ok: false, error: expect.stringContaining('per chat') });
    expect(parseDefaultsUpdate({ seatId: 'claude-a', permissionMode: 'plan' })).toEqual({ ok: true, update: { seatId: 'claude-a', permissionMode: 'plan' } });
    expect(parseDefaultsUpdate({ seatId: '../x', effort: 'low' })).toMatchObject({ ok: false });
  });

  it('the store accepts controls only absent-or-exact', () => {
    expect(isVerseSessionControls({})).toBe(true);
    expect(isVerseSessionControls({ effort: 'high', permissionMode: 'bypass' })).toBe(true);
    expect(isVerseSessionControls({ effort: 'huge' })).toBe(false);
    expect(isVerseSessionControls({ extra: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults for new chats', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmp, 'defaults-'));
  });

  it('writes 0600, merges seat over global, and drops what a seat cannot honour', () => {
    expect(readControlDefaults(root)).toEqual({ global: {}, seats: {} });
    writeControlDefaults(root, { effort: 'high', permissionMode: 'plan' });
    writeControlDefaults(root, { seatId: 'codex-a', effort: 'xhigh' });
    const file = join(root, 'control-defaults.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const defaults = readControlDefaults(root);
    expect(defaults).toEqual({ global: { effort: 'high', permissionMode: 'plan' }, seats: { 'codex-a': { effort: 'xhigh' } } });
    expect(initialControlsFor(defaults, SEATS.codex)).toEqual({ effort: 'xhigh', permissionMode: 'plan' });
    expect(initialControlsFor(defaults, SEATS.claude, { claudeCliVersion: '2.1.280' })).toEqual({ effort: 'high', permissionMode: 'plan' });
    // A local seat has no efforts: the global `high` is dropped, plan kept.
    expect(initialControlsFor(defaults, SEATS.local)).toEqual({ permissionMode: 'plan' });
    // Setting the default mode clears the key rather than storing it.
    writeControlDefaults(root, { permissionMode: 'accept-edits', effort: null });
    expect(readControlDefaults(root).global).toEqual({});
  });

  it('never reads bypass back out of a hand-edited file', () => {
    writeFileSync(join(root, 'control-defaults.json'), JSON.stringify({ global: { permissionMode: 'bypass', effort: 'low' }, seats: { x: { permissionMode: 'bypass' } } }));
    expect(readControlDefaults(root)).toEqual({ global: { effort: 'low' }, seats: {} });
  });

  it('a corrupt file means no defaults, never a failed chat', () => {
    writeFileSync(join(root, 'control-defaults.json'), '{nope');
    expect(readControlDefaults(root)).toEqual({ global: {}, seats: {} });
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('attachment store', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmp, 'attach-'));
  });

  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('stores one private file per upload: dir 0700, file 0600, safe name, @ref to the file', () => {
    const store = createAttachmentStore(root, { randomId: () => '0a0b0c0d' });
    const item = store.save('sess-1', { name: '../../etc/pass wd?.txt', mime: 'text/plain', dataBase64: b64('hello') });
    const dir = join(root, 'attachments', 'sess-1');
    expect(store.dirFor('sess-1')).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, '0a0b0c0d-pass_wd_.txt');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(item).toMatchObject({ id: '0a0b0c0d', sessionId: 'sess-1', name: 'pass_wd_.txt', mime: 'text/plain', bytes: 5, ref: `@${file}` });
    expect(store.list('sess-1').map((a) => a.id)).toEqual(['0a0b0c0d']);
    expect(store.remove('sess-1', '0a0b0c0d')).toBe(true);
    expect(existsSync(file)).toBe(false);
    store.drop('sess-1');
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts exactly 8 MB and refuses a byte more, an empty file, and bad base64', () => {
    const store = createAttachmentStore(root);
    const max = Buffer.alloc(VERSE_ATTACHMENT_MAX_BYTES, 1).toString('base64');
    expect(store.save('s', { name: 'big.bin', mime: 'application/octet-stream', dataBase64: max }).bytes).toBe(VERSE_ATTACHMENT_MAX_BYTES);
    const over = Buffer.alloc(VERSE_ATTACHMENT_MAX_BYTES + 1, 1).toString('base64');
    expect(() => store.save('t', { name: 'big.bin', mime: 'application/octet-stream', dataBase64: over })).toThrow(/8 MB/);
    expect(() => store.save('t', { name: 'e.txt', mime: 'text/plain', dataBase64: '' })).toThrow(/empty/);
    expect(() => store.save('t', { name: 'e.txt', mime: 'text/plain', dataBase64: '%%%%' })).toThrow(/base64/);
    expect(() => store.save('t', { name: 'e.txt', mime: 'not a mime', dataBase64: b64('x') })).toThrow(/media type/);
  });

  it('caps a chat at VERSE_ATTACHMENTS_PER_SESSION files and fixes an image extension', () => {
    const store = createAttachmentStore(root);
    const png = store.save('s', { name: 'Screen Shot', mime: 'image/png', dataBase64: b64('png') });
    expect(png.name).toBe('Screen_Shot.png');
    for (let i = 1; i < VERSE_ATTACHMENTS_PER_SESSION; i++) store.save('s', { name: `f${i}.txt`, mime: 'text/plain', dataBase64: b64('x') });
    expect(() => store.save('s', { name: 'one-more.txt', mime: 'text/plain', dataBase64: b64('x') })).toThrow(/at most/);
  });

  it('never lists (or grants) a symlink planted in the directory', () => {
    const store = createAttachmentStore(root);
    store.save('s', { name: 'a.txt', mime: 'text/plain', dataBase64: b64('x') });
    symlinkSync('/etc/hosts', join(store.dirFor('s'), 'deadbeef-hosts'));
    expect(store.list('s').map((a) => a.name)).toEqual(['a.txt']);
    const resolved = resolveAttachmentRefs(`see @${store.dirFor('s')}/deadbeef-hosts`, store.dirFor('s'));
    expect(resolved.files).toEqual([]);
    expect(resolved.dirs).toEqual([]);
  });

  it('resolves ~ and absolute tokens for THIS chat only, to absolute paths, with trailing punctuation kept', () => {
    const home = join(tmp, 'home');
    const store = createAttachmentStore(join(home, '.ashlr', 'verse'), { randomId: () => '11112222' });
    const item = store.save('sess-1', { name: 'notes.md', mime: 'text/markdown', dataBase64: b64('# hi') });
    const dir = store.dirFor('sess-1');
    const tilde = item.ref.replace(`@${home}`, '@~');
    const text = `Read ${tilde}. Then @${dir}/11112222-notes.md and @~/.ashlr/verse/attachments/other/11112222-notes.md`;
    const resolved = resolveAttachmentRefs(text, dir, home);
    expect(resolved.text).toBe(`Read @${dir}/11112222-notes.md. Then @${dir}/11112222-notes.md and @~/.ashlr/verse/attachments/other/11112222-notes.md`);
    expect(resolved.files).toEqual([join(dir, '11112222-notes.md')]);
    expect(resolved.dirs).toEqual([dir]);
    expect(resolveAttachmentRefs('no attachments here', dir, home)).toEqual({ text: 'no attachments here', files: [], dirs: [] });
  });

  it('expands `@~/…` mentions only when they land inside one of the chat’s roots', () => {
    const home = '/Users/u';
    const roots = ['/Users/u/dev/hub', '/Users/u/dev/shared'];
    expect(expandHomeMentions('see @~/dev/shared/lib/a.ts and @~/dev/hub/README.md', roots, home))
      .toBe('see @/Users/u/dev/shared/lib/a.ts and @/Users/u/dev/hub/README.md');
    expect(expandHomeMentions('@~/.ssh/id_rsa @~/dev/hub/../x', roots, home)).toBe('@~/.ssh/id_rsa @~/dev/hub/../x');
    expect(expandHomeMentions('no mentions', roots, home)).toBe('no mentions');
  });

  it('sanitizes names for every filesystem', () => {
    expect(sanitizeAttachmentName('')).toBe('attachment');
    expect(sanitizeAttachmentName('..hidden')).toBe('hidden');
    expect(sanitizeAttachmentName('a\u0000b\nc.png')).toBe('a_b_c.png');
    expect(sanitizeAttachmentName(`${'x'.repeat(300)}.jpeg`)).toMatch(/^x+\.jpeg$/);
    expect(sanitizeAttachmentName(`${'x'.repeat(300)}.jpeg`).length).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe('turn queue', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmp, 'queue-'));
  });

  it(`holds at most ${VERSE_QUEUE_MAX}, persists 0600, and forgets the file when empty`, () => {
    let n = 0;
    const q = createTurnQueue(root, { randomId: () => (++n).toString(16).padStart(12, '0') });
    q.enqueue('s', 'one');
    q.enqueue('s', 'two');
    q.enqueue('s', 'zero', { front: true });
    expect(() => q.enqueue('s', 'four')).toThrow(/up to 3/);
    expect(q.get('s').items.map((i) => i.text)).toEqual(['zero', 'one', 'two']);
    const file = join(root, 'queues', 's.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A fresh process reads the same queue back.
    expect(createTurnQueue(root).get('s').items.map((i) => i.text)).toEqual(['zero', 'one', 'two']);
    expect(q.take('s')?.text).toBe('zero');
    expect(q.remove('s', q.get('s').items[0]!.id)).toBe(true);
    expect(q.take('s')?.text).toBe('two');
    expect(existsSync(file)).toBe(false);
  });

  it('validates text like a turn: non-blank, ≤ 64 KB, no NUL', () => {
    const q = createTurnQueue(root);
    expect(() => q.enqueue('s', '   ')).toThrow(/required/);
    expect(() => q.enqueue('s', 'a\u0000b')).toThrow(/NUL/);
    expect(() => q.enqueue('s', 'x'.repeat(64 * 1024 + 1))).toThrow(/exceeds/);
  });

  it('holds with a reason, lists held chats for Needs you, and releases', () => {
    const q = createTurnQueue(root, { now: () => new Date('2026-09-24T10:00:00Z') });
    q.enqueue('s', 'follow-up');
    q.hold('s', 'The last turn failed.');
    expect(q.get('s')).toMatchObject({ held: true, heldReason: 'The last turn failed.' });
    expect(createTurnQueue(root).listHeld()).toEqual([
      expect.objectContaining({ sessionId: 's', held: true, heldAt: '2026-09-24T10:00:00.000Z' }),
    ]);
    q.release('s');
    expect(q.get('s')).toMatchObject({ held: false, heldReason: null });
    expect(q.listHeld()).toEqual([]);
  });

  it('a send-now mark is read once and never survives a restart', () => {
    const q = createTurnQueue(root);
    const item = q.enqueue('s', 'go');
    expect(q.markSendNow('s', item.id)).toBe(true);
    expect(createTurnQueue(root).takeSendNow('s')).toBeNull();
    expect(q.takeSendNow('s')).toBe(item.id);
    expect(q.takeSendNow('s')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File finder
// ---------------------------------------------------------------------------

describe('@ file finder', () => {
  const FILES = [
    'src/web-ui/routes/verse/Composer.tsx',
    'src/web-ui/routes/verse/Composer.module.css',
    'src/core/verse/session-engine.ts',
    'README.md',
    'docs/composer-notes.md',
    'package.json',
  ];

  it('ranks a basename hit above a scattered path match, and exact names first', () => {
    expect(fuzzyScore('src/core/verse/session-engine.ts', 'zzz')).toBeNull();
    const ranked = rankFiles(FILES.map((path) => ({ path, root: '/r' })), 'composer').files.map((f) => f.path);
    expect(ranked[0]).toBe('src/web-ui/routes/verse/Composer.tsx');
    expect(ranked).toContain('docs/composer-notes.md');
    expect(rankFiles(FILES.map((path) => ({ path, root: '/r' })), 'package.json').files[0]!.path).toBe('package.json');
    expect(rankFiles(FILES.map((path) => ({ path, root: '/r' })), 'sesseng').files[0]!.path).toBe('src/core/verse/session-engine.ts');
  });

  it('an empty query lists the shortest paths first', () => {
    const ranked = rankFiles(FILES.map((path) => ({ path, root: '/r' })), '', 3);
    expect(ranked.files.map((f) => f.path)).toEqual(['README.md', 'package.json', 'docs/composer-notes.md']);
    expect(ranked.truncated).toBe(true);
  });

  it('caches a root listing and searches every root of the chat', async () => {
    let calls = 0;
    let now = 0;
    const index = createFileIndex({ list: async (root) => { calls++; return root === '/a' ? ['one.ts'] : ['two.ts']; }, now: () => now });
    expect((await index.search(['/a', '/b'], 'ts')).files).toEqual([{ path: 'one.ts', root: '/a' }, { path: 'two.ts', root: '/b' }]);
    await index.search(['/a', '/b'], 'one');
    expect(calls).toBe(2);
    now = 31_000;
    await index.search(['/a'], 'one');
    expect(calls).toBe(3);
  });

  it('scores 20,000 paths inside the 20 ms handler budget', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({ path: `src/module-${i % 97}/deep/path/file-${i}.ts`, root: '/r' }));
    const started = performance.now();
    rankFiles(many, 'mod9file');
    expect(performance.now() - started).toBeLessThan(60); // 3× headroom for a loaded CI box
  });
});
